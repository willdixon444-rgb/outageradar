// OutageRadar checker - Cloudflare Worker (free plan).
//
// What it does every 5 minutes (Cron Trigger "*/5 * * * *"):
//   1. Reads each service's official status feed.
//   2. Checks whether each service's own website answers ("site reachable").
//   3. Combines the two signals with the rules below and saves one KV key.
//   4. Posts to Discord only when something changes.
//
// What it serves (Custom Domain data.liveoutageradar.com):
//   GET /status.json  public board data (CORS: our site only)
//   GET /health       "ok" if the last run saved within 15 minutes, else 503
//
// Safety rules built in:
//   - A service shows "unknown" until its mapping is approved
//     (env APPROVED_MAPPINGS, e.g. "openai,groq"). Until then it only
//     collects samples. This is "sample mode".
//   - Never "operational" when we do not actually know.
//   - Probe 403/429 or a challenge page = unknown, never down.
//   - Data older than 15 minutes is served as unknown.
//   - Webhook URLs are secrets: never logged, stored or published.
//
// Bindings and settings (Cloudflare dashboard):
//   KV                      KV namespace binding (required)
//   DISCORD_ALERTS_WEBHOOK  secret, outage channel
//   DISCORD_HEALTH_WEBHOOK  secret, health channel
//   APPROVED_MAPPINGS       plain text variable, optional, comma list
//
// Source of truth: GitHub repo willdixon444-rgb/outageradar, worker/checker.js.
// This file must stay ASCII-only.

const VERSION = "1.1.0";

const STATE_KEY = "state:v1";
const SAMPLES_KEY = "samples:v1";

const MIN = 60 * 1000;
const STALE_AFTER_MS = 15 * MIN;
const ALERT_COOLDOWN_MS = 30 * MIN;
const PROBE_FAILS_TO_CONFIRM = 2;
const FEED_FAILS_TO_ALERT = 3;
const FETCH_TIMEOUT_MS = 10000;
const DISCORD_TIMEOUT_MS = 8000;
const SAMPLE_BODY_LIMIT = 100000;
const PROBE_PEEK_CHARS = 600;
const READ_CACHE_MS = 30 * 1000;

const USER_AGENT = "OutageRadarBot/" + VERSION + " (+https://liveoutageradar.com)";

const ALLOWED_ORIGINS = [
  "https://liveoutageradar.com",
  "https://www.liveoutageradar.com",
];

// Feed URLs were opened by hand on Nov 3, 2026 and confirmed by the first
// live samples (v1.0). "samples" lists extra URLs saved once for review; only
// "feed" is polled each run. "parser" and "components" are the mapping, used
// for the public board only when the service id is in APPROVED_MAPPINGS.
//
// Probes: chatgpt.com, chat.mistral.ai and www.perplexity.ai answer automated
// checks with a Cloudflare challenge (HTTP 403), so those services are probed
// at their API servers instead. Without a key an API server answers 401 (or
// 405 for a GET on a POST-only endpoint): that proves the server is up and
// answering, not that the AI works. The label says so.
// "probe_ok" lists the extra status codes that count as answering; any 2xx
// always counts.
const SITE_LABEL = "Site reachable (HTTP 200)";
const API_LABEL = "API server answering (our check)";

const SERVICES = [
  {
    id: "openai",
    name: "ChatGPT / OpenAI",
    status_page: "https://status.openai.com",
    feed: "https://status.openai.com/api/v2/status.json",
    samples: [],
    parser: "statuspage_indicator",
    probe: "https://api.openai.com/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    id: "mistral",
    name: "Mistral",
    status_page: "https://status.mistral.ai",
    feed: "https://status.mistral.ai/api/v2/status.json",
    samples: [],
    parser: "statuspage_indicator",
    probe: "https://api.mistral.ai/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    status_page: "https://status.perplexity.com",
    feed: "https://status.perplexity.com/api/v2/summary.json",
    samples: [],
    parser: "statuspage_indicator",
    probe: "https://api.perplexity.ai/chat/completions",
    probe_ok: [401, 405],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    id: "groq",
    name: "Groq",
    status_page: "https://groqstatus.com",
    feed: "https://groqstatus.com/api/v2/components.json",
    samples: ["https://groqstatus.com/api/v2/status.json"],
    parser: "components",
    components: ["API", "Website"],
    probe: "https://console.groq.com/",
    probe_ok: [],
    probe_label: SITE_LABEL,
    probe_words: "site",
  },
];

// ---------- Status words ----------
// Official: operational, degraded, partial_outage, major_outage,
//           maintenance, unknown
// Probe:    reachable, unreachable, unknown
// Overall:  official word, or signals_disagree, or unknown

const SEVERITY = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
};

const ALERT_STATES = ["partial_outage", "major_outage", "signals_disagree"];

const INDICATOR_MAP = {
  none: "operational",
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
  maintenance: "maintenance",
};

// Lowercased, with spaces/underscores/dashes removed, so both Statuspage
// ("partial_outage") and Instatus ("PARTIALOUTAGE") spellings match.
const COMPONENT_MAP = {
  operational: "operational",
  degradedperformance: "degraded",
  partialoutage: "partial_outage",
  majoroutage: "major_outage",
  undermaintenance: "maintenance",
  maintenance: "maintenance",
};

const LABELS = {
  operational: "Operational",
  degraded: "Degraded",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  maintenance: "Maintenance",
  signals_disagree: "Signals disagree",
  unknown: "Unknown",
  reachable: "Reachable",
  unreachable: "Unreachable",
};

// ---------- Small helpers ----------

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function humanTime(ms) {
  return iso(ms).replace("T", " ").replace(/:\d\dZ$/, " UTC");
}

function minutesBetween(a, b) {
  return Math.max(0, Math.round((b - a) / MIN));
}

function approvedSet(env) {
  const raw = (env && env.APPROVED_MAPPINGS) || "";
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function discardBody(res) {
  try {
    if (res && res.body) res.body.cancel();
  } catch (e) {
    // ignore
  }
}

async function peekBody(res, chars) {
  // Read only the first chunk(s) so a large homepage costs little CPU.
  if (!res.body || typeof res.body.getReader !== "function") return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < chars) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (e) {
    // ignore: a broken stream just means a shorter peek
  } finally {
    try { reader.cancel(); } catch (e) { /* ignore */ }
  }
  return text.slice(0, chars);
}

function describeError(err) {
  if (err && err.name === "AbortError") return "timed out";
  return "network error";
}

// ---------- Official feed ----------

function parseFeed(service, text, contentType) {
  // Returns { ok, status, reason }. ok=false means the feed is broken.
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const isHtml = /html/i.test(contentType || "") || /^\s*</.test(text);
    return { ok: false, status: "unknown", reason: isHtml ? "returned HTML, not JSON" : "not valid JSON" };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, status: "unknown", reason: "unexpected format" };
  }

  if (service.parser === "statuspage_indicator") {
    const ind = data.status && data.status.indicator;
    if (typeof ind !== "string") return { ok: false, status: "unknown", reason: "no status indicator" };
    const mapped = INDICATOR_MAP[ind.toLowerCase()];
    // An indicator we do not recognise is a working feed with an unknown answer.
    return { ok: true, status: mapped || "unknown", reason: mapped ? "" : "unrecognised indicator" };
  }

  if (service.parser === "components") {
    if (!Array.isArray(data.components)) return { ok: false, status: "unknown", reason: "no components list" };
    const wanted = new Set((service.components || []).map((n) => n.toLowerCase()));
    let worst = null;
    let matched = 0;
    for (const c of data.components) {
      if (!c || typeof c.name !== "string" || !wanted.has(c.name.toLowerCase())) continue;
      matched += 1;
      const key = String(c.status || "").toLowerCase().replace(/[\s_-]/g, "");
      const mapped = COMPONENT_MAP[key];
      if (!mapped) return { ok: true, status: "unknown", reason: "unrecognised component status" };
      if (worst === null || SEVERITY[mapped] > SEVERITY[worst]) worst = mapped;
    }
    if (matched === 0) return { ok: false, status: "unknown", reason: "expected components missing" };
    return { ok: true, status: worst, reason: "" };
  }

  return { ok: false, status: "unknown", reason: "no parser" };
}

async function checkFeed(service) {
  const checkedAt = Date.now();
  try {
    const res = await fetchWithTimeout(service.feed, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    }, FETCH_TIMEOUT_MS);
    if (!res.ok) {
      discardBody(res);
      return { ok: false, status: "unknown", reason: "HTTP " + res.status, checkedAt };
    }
    const text = await res.text();
    const parsed = parseFeed(service, text, res.headers.get("content-type"));
    return { ...parsed, checkedAt };
  } catch (err) {
    return { ok: false, status: "unknown", reason: describeError(err), checkedAt };
  }
}

// ---------- Site reachable probe ----------

const CHALLENGE_MARKERS = [/just a moment/i, /challenge-platform/i, /cf-chl/i, /attention required/i];

async function checkProbe(service) {
  const checkedAt = Date.now();
  try {
    const res = await fetchWithTimeout(service.probe, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      redirect: "follow",
    }, FETCH_TIMEOUT_MS);
    const code = res.status;
    const headers = {
      server: res.headers.get("server") || "",
      "content-type": res.headers.get("content-type") || "",
      "cf-mitigated": res.headers.get("cf-mitigated") || "",
    };
    if (headers["cf-mitigated"]) {
      discardBody(res);
      return { result: "blocked", code, reason: "challenge page", checkedAt, headers, peek: "" };
    }
    if (code === 403 || code === 429) {
      discardBody(res);
      return { result: "blocked", code, reason: "blocked (HTTP " + code + ")", checkedAt, headers, peek: "" };
    }
    if (code >= 500) {
      discardBody(res);
      return { result: "fail", code, reason: "HTTP " + code, checkedAt, headers, peek: "" };
    }
    if ((service.probe_ok || []).includes(code)) {
      discardBody(res);
      return { result: "ok", code, reason: "", checkedAt, headers, peek: "" };
    }
    if (code >= 200 && code < 300) {
      const peek = await peekBody(res, PROBE_PEEK_CHARS);
      if (CHALLENGE_MARKERS.some((re) => re.test(peek))) {
        return { result: "blocked", code, reason: "challenge page", checkedAt, headers, peek };
      }
      return { result: "ok", code, reason: "", checkedAt, headers, peek };
    }
    discardBody(res);
    return { result: "odd", code, reason: "unexpected HTTP " + code, checkedAt, headers, peek: "" };
  } catch (err) {
    return { result: "fail", code: 0, reason: describeError(err), checkedAt, headers: {}, peek: "" };
  }
}

// ---------- Combining signals ----------

function combine(official, probe) {
  if (official === "unknown") return "unknown";
  if (official !== "operational") return official;
  return probe === "unreachable" ? "signals_disagree" : "operational";
}

function freshServiceState() {
  return {
    probe_fails: 0,
    feed_fails: 0,
    feed_alert_open: false,
    alert_open: false,
    alert_state: null,
    alert_opened_ms: null,
    last_alert_ms: null,
  };
}

// ---------- Discord ----------

const EMOJI = {
  red: "\u{1F534}",
  orange: "\u{1F7E0}",
  green: "\u{1F7E2}",
  tool: "\u{1F6E0}\u{FE0F}",
  sample: "\u{1F9EA}",
};

async function postDiscord(webhook, content) {
  // Returns true only if Discord accepted it. Never throws, never logs the URL.
  if (!webhook) return false;
  try {
    const res = await fetchWithTimeout(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "OutageRadar", content, allowed_mentions: { parse: [] } }),
    }, DISCORD_TIMEOUT_MS);
    discardBody(res);
    if (!res.ok) console.warn("discord post rejected, HTTP " + res.status);
    return res.ok;
  } catch (err) {
    console.warn("discord post failed: " + describeError(err));
    return false;
  }
}

function probeWords(service, probe) {
  const what = service.probe_words || "site";
  if (probe === "reachable") return what === "site" ? "site reachable" : "API server answering";
  if (probe === "unreachable") return what === "site" ? "site unreachable" : "API server not answering";
  return what + " check unknown";
}

function outageMessage(service, overall, probe, now) {
  return EMOJI.red + " **OUTAGE** " + service.name + ": official status says " +
    LABELS[overall] + ". Our check: " + probeWords(service, probe) + ". " + humanTime(now) +
    ". Official page: <" + service.status_page + ">";
}

function worseMessage(service, overall, probe, now) {
  return EMOJI.red + " **WORSE** " + service.name + ": now " + LABELS[overall] +
    ". Our check: " + probeWords(service, probe) + ". " + humanTime(now) + ". <" + service.status_page + ">";
}

function checkMessage(service, now) {
  return EMOJI.orange + " **CHECK** " + service.name + ": our " + (service.probe_words || "site") + " check failed " +
    PROBE_FAILS_TO_CONFIRM + " times in a row, but the official status says Operational. " +
    humanTime(now) + ". <" + service.status_page + ">";
}

function recoveredMessage(service, openedMs, now) {
  const mins = openedMs ? minutesBetween(openedMs, now) : null;
  return EMOJI.green + " **RECOVERED** " + service.name + ": back to Operational" +
    (mins !== null ? " after about " + mins + " min" : "") + ". " + humanTime(now) +
    ". <" + service.status_page + ">";
}

// ---------- The scheduled run ----------

async function readState(kv) {
  const state = await kv.get(STATE_KEY, { type: "json" });
  if (!state || typeof state !== "object") return { services: {} };
  if (!state.services || typeof state.services !== "object") state.services = {};
  return state;
}

function isTopOfHour(ms) {
  return new Date(ms).getUTCMinutes() < 5;
}

async function collectSamples(probes) {
  const urls = [];
  for (const s of SERVICES) {
    urls.push({ service: s.id, url: s.feed });
    for (const u of s.samples || []) urls.push({ service: s.id, url: u });
  }
  const feeds = await Promise.all(urls.map(async (item) => {
    try {
      const res = await fetchWithTimeout(item.url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
      }, FETCH_TIMEOUT_MS);
      const text = await res.text();
      return {
        ...item,
        http_status: res.status,
        content_type: res.headers.get("content-type") || "",
        bytes: text.length,
        body: text.slice(0, SAMPLE_BODY_LIMIT),
      };
    } catch (err) {
      return { ...item, http_status: 0, error: describeError(err), bytes: 0, body: "" };
    }
  }));
  const probeSamples = SERVICES.map((s, i) => ({
    service: s.id,
    url: s.probe,
    http_status: probes[i].code,
    result: probes[i].result,
    reason: probes[i].reason,
    headers: probes[i].headers,
    first_chars: probes[i].peek,
  }));
  return { saved_at_utc: iso(Date.now()), version: VERSION, feeds, probes: probeSamples };
}

async function runCheck(env) {
  const kv = env && env.KV;
  if (!kv) {
    console.error("KV binding missing; nothing checked");
    return;
  }
  const started = Date.now();
  const approved = approvedSet(env);

  let state;
  try {
    state = await readState(kv);
  } catch (err) {
    console.error("could not read state; run skipped so nothing is overwritten");
    if (isTopOfHour(started)) {
      await postDiscord(env.DISCORD_HEALTH_WEBHOOK, EMOJI.tool + " **CHECKER** could not read saved state (KV read failed). Board data is not updating. " + humanTime(started));
    }
    return;
  }

  // Each service is checked on its own, so one failure cannot stop the rest.
  const feeds = await Promise.all(SERVICES.map((s) => checkFeed(s)));
  const probes = await Promise.all(SERVICES.map((s) => checkProbe(s)));

  // One-time raw samples for mapping review.
  try {
    const existing = await kv.get(SAMPLES_KEY);
    if (existing === null) {
      const samples = await collectSamples(probes);
      await kv.put(SAMPLES_KEY, JSON.stringify(samples));
      await postDiscord(env.DISCORD_HEALTH_WEBHOOK, EMOJI.sample + " **Samples saved** for " +
        samples.feeds.length + " feed URLs and " + samples.probes.length +
        " site checks. Review them in Cloudflare KV, key " + SAMPLES_KEY + ". " + humanTime(Date.now()));
    }
  } catch (err) {
    console.warn("sample collection failed; will retry next run");
  }

  const now = Date.now();
  const publicServices = [];

  for (let i = 0; i < SERVICES.length; i++) {
    const service = SERVICES[i];
    const feed = feeds[i];
    const probe = probes[i];
    const st = { ...freshServiceState(), ...(state.services[service.id] || {}) };
    const isApproved = approved.has(service.id);

    // Official signal.
    const official = isApproved && feed.ok ? feed.status : "unknown";
    let officialNote = "";
    if (!isApproved) officialNote = "Mapping not approved yet";
    else if (!feed.ok) officialNote = "Feed problem: " + feed.reason;
    else if (feed.reason) officialNote = feed.reason;

    // Feed health counters and alerts (health channel).
    if (feed.ok) {
      if (st.feed_alert_open) {
        const sent = await postDiscord(env.DISCORD_HEALTH_WEBHOOK, EMOJI.tool + " **FEED OK** " +
          service.name + " official feed is working again. " + humanTime(now));
        if (sent) st.feed_alert_open = false;
      }
      st.feed_fails = 0;
    } else {
      st.feed_fails += 1;
      if (st.feed_fails >= FEED_FAILS_TO_ALERT && !st.feed_alert_open) {
        const sent = await postDiscord(env.DISCORD_HEALTH_WEBHOOK, EMOJI.tool + " **FEED PROBLEM** " +
          service.name + " official feed failed " + st.feed_fails + " checks in a row (" + feed.reason +
          "). Showing Unknown. " + humanTime(now) + ". <" + service.feed + ">");
        if (sent) st.feed_alert_open = true;
      }
    }

    // Probe signal. Blocked or odd answers are unknown and do not count as failures.
    let probeStatus;
    if (probe.result === "ok") {
      st.probe_fails = 0;
      probeStatus = "reachable";
    } else if (probe.result === "fail") {
      st.probe_fails += 1;
      probeStatus = st.probe_fails >= PROBE_FAILS_TO_CONFIRM ? "unreachable" : "unknown";
    } else {
      probeStatus = "unknown";
    }

    const overall = combine(official, probeStatus);

    // Outage alerts (alerts channel). Only approved services can alert.
    if (isApproved) {
      const bad = ALERT_STATES.includes(overall);
      const coolingDown = st.last_alert_ms !== null && now - st.last_alert_ms < ALERT_COOLDOWN_MS;
      if (bad && !st.alert_open && !coolingDown) {
        const msg = overall === "signals_disagree"
          ? checkMessage(service, now)
          : outageMessage(service, overall, probeStatus, now);
        if (await postDiscord(env.DISCORD_ALERTS_WEBHOOK, msg)) {
          st.alert_open = true;
          st.alert_state = overall;
          st.alert_opened_ms = now;
          st.last_alert_ms = now;
        }
      } else if (bad && st.alert_open && overall !== "signals_disagree" &&
                 (SEVERITY[overall] || 0) > (SEVERITY[st.alert_state] || 0)) {
        if (await postDiscord(env.DISCORD_ALERTS_WEBHOOK, worseMessage(service, overall, probeStatus, now))) {
          st.alert_state = overall;
          st.last_alert_ms = now;
        }
      } else if (overall === "operational" && st.alert_open) {
        if (await postDiscord(env.DISCORD_ALERTS_WEBHOOK, recoveredMessage(service, st.alert_opened_ms, now))) {
          st.alert_open = false;
          st.alert_state = null;
          st.alert_opened_ms = null;
          st.last_alert_ms = now;
        }
      }
      // Unknown while an alert is open: say nothing. We do not claim recovery we cannot see.
    }

    st.last_official = official;
    st.last_probe = probeStatus;
    st.feed_preview = feed.status;
    st.feed_reason = feed.reason;
    state.services[service.id] = st;

    publicServices.push({
      id: service.id,
      name: service.name,
      status_page: service.status_page,
      overall,
      official: {
        label: "Official status",
        status: official,
        checked_at_utc: iso(feed.checkedAt),
        note: officialNote,
      },
      probe: {
        label: service.probe_label || SITE_LABEL,
        status: probeStatus,
        checked_at_utc: iso(probe.checkedAt),
        http_status: probe.code || null,
        note: probe.reason,
      },
    });
  }

  state.schema = 1;
  state.version = VERSION;
  state.last_run_ok_ms = now;
  state.public = {
    schema: 1,
    generated_at_utc: iso(now),
    generated_at_ms: now,
    stale: false,
    services: publicServices,
  };

  try {
    await kv.put(STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error("could not save state (KV write failed)");
    if (isTopOfHour(started)) {
      await postDiscord(env.DISCORD_HEALTH_WEBHOOK, EMOJI.tool + " **CHECKER** could not save state (KV write failed). The board will go stale. " + humanTime(now));
    }
  }
}

// ---------- HTTP side ----------

const readCache = new WeakMap(); // per KV binding: { at, state }

async function cachedState(kv) {
  const hit = readCache.get(kv);
  const now = Date.now();
  if (hit && now - hit.at < READ_CACHE_MS && hit.at <= now) return hit.state;
  const state = await kv.get(STATE_KEY, { type: "json" });
  readCache.set(kv, { at: now, state });
  return state;
}

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  const h = { vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-methods"] = "GET, OPTIONS";
    h["access-control-max-age"] = "86400";
  }
  return h;
}

function unknownService(service, note) {
  return {
    id: service.id,
    name: service.name,
    status_page: service.status_page,
    overall: "unknown",
    official: { label: "Official status", status: "unknown", checked_at_utc: null, note },
    probe: { label: service.probe_label || SITE_LABEL, status: "unknown", checked_at_utc: null, http_status: null, note },
  };
}

function buildPublic(state, now) {
  const pub = state && state.public;
  const fresh = pub && typeof pub.generated_at_ms === "number" &&
    now - pub.generated_at_ms <= STALE_AFTER_MS && pub.generated_at_ms <= now + MIN;
  if (fresh) {
    const { generated_at_ms, ...rest } = pub;
    return rest;
  }
  // Too old or missing: everything unknown, with the last real time if we have one.
  const note = pub ? "Data is stale" : "No data yet";
  return {
    schema: 1,
    generated_at_utc: pub ? pub.generated_at_utc : null,
    stale: true,
    services: SERVICES.map((s) => unknownService(s, note)),
  };
}

function respond(body, status, extraHeaders, contentType) {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType || "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "x-robots-tag": "noindex" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return respond(JSON.stringify({ error: "method not allowed" }), 405, cors);
  }

  if (url.pathname === "/status.json") {
    let state = null;
    try {
      if (env && env.KV) state = await cachedState(env.KV);
    } catch (err) {
      console.warn("status read failed");
    }
    return respond(JSON.stringify(buildPublic(state, Date.now())), 200, cors);
  }

  if (url.pathname === "/health") {
    let state = null;
    try {
      if (env && env.KV) state = await env.KV.get(STATE_KEY, { type: "json" });
    } catch (err) {
      state = null;
    }
    const last = state && state.last_run_ok_ms;
    const now = Date.now();
    const ok = typeof last === "number" && now - last <= STALE_AFTER_MS;
    const text = (ok ? "ok" : "stale") + " last_run_utc=" + (typeof last === "number" ? iso(last) : "never");
    return respond(text, ok ? 200 : 503, { "cache-control": "no-store" }, "text/plain; charset=utf-8");
  }

  return respond(JSON.stringify({ error: "not found" }), 404, cors);
}

export default {
  async scheduled(event, env, ctx) {
    try {
      await runCheck(env);
    } catch (err) {
      // Last-resort guard: a bug must not leak details or secrets into logs.
      console.error("checker run failed: " + (err && err.name ? err.name : "error"));
    }
  },
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      return new Response(JSON.stringify({ error: "server error" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8", "x-robots-tag": "noindex" },
      });
    }
  },
};
