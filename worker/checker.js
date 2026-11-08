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
//                     (v1.6: each service also carries "incidents": when the
//                     log started and the last incident, see incident log)
//   GET /incidents.json  each approved service's incident log, newest first
//                     (v1.7.0, for the /status/<id>/ history pages)
//   POST /v, /c       page-view / link-click pings from our site (daily totals
//                     in D1; no IP, user agent, cookie or ID stored)
//   GET /admin        private traffic dashboard (data needs ADMIN_KEY)
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
//   DB                      D1 database binding, optional (traffic counts)
//   ADMIN_KEY               secret, 24+ characters, unlocks /admin data
//   SEND_TEST_ALERT         plain text variable, optional. Any value sends one
//                           TEST message to the alerts channel; change the
//                           value to send another. Remove it when done.
//
// Source of truth: GitHub repo willdixon444-rgb/outageradar, worker/checker.js.
// This file must stay ASCII-only.

const VERSION = "1.7.0";

const STATE_KEY = "state:v1";
// Versioned so every release collects fresh samples on its first run.
const SAMPLES_KEY = "samples:v" + VERSION;

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
    // v1.6: probe moved from the website (console.groq.com) to the API
    // server, like the others. Groq documents GET /openai/v1/models with a
    // Bearer key; the no-key answer (expected 401) is confirmed by the
    // v1.6 sample. The old website address is kept as a one-time sample.
    samples: ["https://groqstatus.com/api/v2/status.json", "https://console.groq.com/"],
    parser: "components",
    components: ["API", "Website"],
    probe: "https://api.groq.com/openai/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  // ---- Added in v1.2. Sample mode until reviewed (not in APPROVED_MAPPINGS). ----
  {
    // Feed documented on status.claude.com/api (Statuspage format).
    id: "claude",
    name: "Claude",
    status_page: "https://status.claude.com",
    feed: "https://status.claude.com/api/v2/summary.json",
    samples: [],
    parser: "statuspage_indicator",
    probe: "https://api.anthropic.com/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // UNVERIFIED feed URL: assumed Statuspage format; the first sample decides.
    id: "cohere",
    name: "Cohere",
    status_page: "https://status.cohere.com",
    feed: "https://status.cohere.com/api/v2/summary.json",
    samples: ["https://status.cohere.com/api/v2/status.json"],
    parser: "statuspage_indicator",
    probe: "https://api.cohere.com/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // UNVERIFIED: the page offers "the entire status page as JSON"
    // (Better Stack style); the first sample decides.
    id: "huggingface",
    name: "Hugging Face",
    status_page: "https://status.huggingface.co",
    feed: "https://status.huggingface.co/index.json",
    samples: ["https://status.huggingface.co/api/v2/summary.json"],
    parser: "betterstack",
    probe: "https://huggingface.co/api/whoami-v2",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // v1.3: JSON summary on xAI's own data.x.ai domain (sampled Nov 4, 2026;
    // not in xAI's docs). It also lists Cursor products, so only the Grok
    // components below count. The RSS feed (status.x.ai/feed.xml) was 340 KB
    // of mostly Cursor history and could not give a current status.
    id: "xai",
    name: "Grok / xAI",
    status_page: "https://status.x.ai",
    feed: "https://data.x.ai/status/summary.json",
    samples: [],
    parser: "components",
    components: ["Global (api.x.ai)", "grok.com"],
    probe: "https://api.x.ai/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // No public machine-readable feed for AI Studio / Gemini API.
    // Google's API may answer 403 (not 401) without a key; the sample decides.
    id: "gemini",
    name: "Gemini",
    status_page: "https://aistudio.google.com/status",
    feed: null,
    samples: [],
    parser: "none",
    probe: "https://generativelanguage.googleapis.com/v1beta/models",
    probe_ok: [401, 403],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // Status page runs on a provider with no standard public feed.
    id: "deepseek",
    name: "DeepSeek",
    status_page: "https://status.deepseek.com",
    feed: null,
    samples: [],
    parser: "none",
    probe: "https://api.deepseek.com/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
];

const NO_FEED_NOTE = "No official public feed";

// ---------- Status words ----------
// Official: operational, degraded, partial_outage, major_outage,
//           maintenance, unknown
// Probe:    reachable, unreachable, unknown
// Overall:  official word, or signals_disagree, or unknown.
//           Services with no official feed (Gemini, DeepSeek) use our check
//           only: check_ok / check_failed / unknown. The board must label
//           these as "our check only"; they never show as Operational.

const SEVERITY = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
};

const ALERT_STATES = ["partial_outage", "major_outage", "signals_disagree", "check_failed"];
const GOOD_STATES = ["operational", "check_ok"];

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
  available: "operational", // xAI's word for up; any other xAI word stays unknown
  degradedperformance: "degraded",
  partialoutage: "partial_outage",
  majoroutage: "major_outage",
  undermaintenance: "maintenance",
  maintenance: "maintenance",
};

const BETTERSTACK_MAP = {
  operational: "operational",
  degraded: "degraded",
  downtime: "major_outage",
  maintenance: "maintenance",
};

const LABELS = {
  operational: "Operational",
  degraded: "Degraded",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  maintenance: "Maintenance",
  signals_disagree: "Signals disagree",
  check_ok: "Up (our check only)",
  check_failed: "Not answering (our check only)",
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

  if (service.parser === "betterstack") {
    const attrs = data.data && data.data.attributes;
    const state = attrs && attrs.aggregate_state;
    if (typeof state !== "string") return { ok: false, status: "unknown", reason: "no aggregate state" };
    const mapped = BETTERSTACK_MAP[state.toLowerCase()];
    return { ok: true, status: mapped || "unknown", reason: mapped ? "" : "unrecognised state" };
  }

  return { ok: false, status: "unknown", reason: "no parser" };
}

async function checkFeed(service) {
  const checkedAt = Date.now();
  if (!service.feed) {
    // Nothing to fetch. Not a broken feed, so no feed alerts.
    return { ok: true, status: "unknown", reason: NO_FEED_NOTE, checkedAt };
  }
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
    if ((service.probe_ok || []).includes(code)) {
      discardBody(res);
      return { result: "ok", code, reason: "", checkedAt, headers, peek: "" };
    }
    if (code === 403 || code === 429) {
      discardBody(res);
      return { result: "blocked", code, reason: "blocked (HTTP " + code + ")", checkedAt, headers, peek: "" };
    }
    if (code >= 500) {
      discardBody(res);
      return { result: "fail", code, reason: "HTTP " + code, checkedAt, headers, peek: "" };
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

function combine(official, probe, hasFeed) {
  if (!hasFeed) {
    // No official feed exists: report our own check, clearly marked as such.
    if (probe === "reachable") return "check_ok";
    if (probe === "unreachable") return "check_failed";
    return "unknown";
  }
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
  bell: "\u{1F514}",
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

function checkOnlyMessage(service, now) {
  return EMOJI.orange + " **CHECK** " + service.name + ": our " + (service.probe_words || "site") +
    " check failed " + PROBE_FAILS_TO_CONFIRM + " times in a row. " + service.name +
    " has no official status feed to confirm. " + humanTime(now) + ". <" + service.status_page + ">";
}

function recoveredMessage(service, openedMs, now) {
  const mins = openedMs ? minutesBetween(openedMs, now) : null;
  const back = service.feed ? "back to Operational" : "our check is answering again";
  return EMOJI.green + " **RECOVERED** " + service.name + ": " + back +
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
    if (s.feed) urls.push({ service: s.id, url: s.feed });
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

// ---------- incident log (v1.6) ----------
//
// For each approved service: when a problem started and ended, the worst
// state seen, and whether the provider confirmed it ("official") or only our
// check saw it ("our_check"). Kept inside state:v1 (already written every
// run), so it costs no extra KV writes. Times are when our checker first saw
// the change (runs are 5 minutes apart).
// v1.6.1 (AG review): an incident closes only after TWO healthy checks in a
// row (end = the first one), so a flapping service stays one incident. If an
// open incident sees only Unknown or maintenance for 2 hours, it is closed at
// the last time we saw the problem and flagged end_confirmed: false (one
// health message), so a dead feed can't leave it "ongoing" for weeks.

const INCIDENT_KEEP = 20;
const INCIDENT_KEEP_MS = 90 * 24 * 60 * MIN;
const INCIDENT_STALL_MS = 2 * 60 * MIN;
const OFFICIAL_INCIDENT_STATES = ["degraded", "partial_outage", "major_outage"];
const CHECK_INCIDENT_STATES = ["signals_disagree", "check_failed"];
const INCIDENT_RANK = {
  signals_disagree: 1, check_failed: 2, degraded: 1, partial_outage: 2, major_outage: 3,
};

function validIncident(x) {
  return x && typeof x === "object" && typeof x.start_ms === "number" &&
    (x.end_ms === null || typeof x.end_ms === "number") &&
    typeof x.worst === "string" && (x.kind === "official" || x.kind === "our_check");
}

// Returns a clean copy: anything damaged is dropped instead of breaking the run.
function cleanIncidentLog(state) {
  const raw = state.incidents && typeof state.incidents === "object" ? state.incidents : {};
  const since = state.incident_since && typeof state.incident_since === "object" ? state.incident_since : {};
  const incidents = {};
  const sinceOut = {};
  for (const s of SERVICES) {
    incidents[s.id] = Array.isArray(raw[s.id]) ? raw[s.id].filter(validIncident) : [];
    if (typeof since[s.id] === "number") sinceOut[s.id] = since[s.id];
  }
  return { incidents, since: sinceOut };
}

function closeIncident(x, endMs, confirmed) {
  x.end_ms = endMs;
  x.end_confirmed = confirmed;
  delete x.good_since_ms;
  delete x.unknown_since_ms;
  delete x.last_bad_ms;
}

// Returns { list, stalled }: stalled is the incident closed as "end not
// confirmed" on this run (for the one health message), else null.
function updateIncidents(list, overall, now) {
  const open = list.length && list[list.length - 1].end_ms === null ? list[list.length - 1] : null;
  const official = OFFICIAL_INCIDENT_STATES.includes(overall);
  const ours = CHECK_INCIDENT_STATES.includes(overall);
  let stalled = null;
  if (official || ours) {
    if (!open) {
      list.push({
        start_ms: now, end_ms: null, worst: overall, kind: official ? "official" : "our_check",
        last_bad_ms: now, good_since_ms: null, unknown_since_ms: null,
      });
    } else {
      if (official && open.kind !== "official") {
        // The provider has now confirmed it: from here on the official worst counts.
        open.kind = "official";
        open.worst = overall;
      } else if (official || open.kind === "our_check") {
        if ((INCIDENT_RANK[overall] || 0) > (INCIDENT_RANK[open.worst] || 0)) open.worst = overall;
      }
      open.last_bad_ms = now;
      open.good_since_ms = null;
      open.unknown_since_ms = null;
    }
  } else if (open && GOOD_STATES.includes(overall)) {
    open.unknown_since_ms = null;
    if (typeof open.good_since_ms === "number") closeIncident(open, open.good_since_ms, true);
    else open.good_since_ms = now;
  } else if (open) {
    // Unknown or maintenance: never proof of recovery, and it breaks a healthy streak.
    open.good_since_ms = null;
    if (typeof open.unknown_since_ms !== "number") {
      open.unknown_since_ms = now;
    } else if (now - open.unknown_since_ms >= INCIDENT_STALL_MS) {
      closeIncident(open, typeof open.last_bad_ms === "number" ? open.last_bad_ms : open.start_ms, false);
      stalled = open;
    }
  }
  const kept = list.filter((x) => x.end_ms === null || now - x.end_ms <= INCIDENT_KEEP_MS);
  return { list: kept.slice(-INCIDENT_KEEP), stalled };
}

function publicIncident(x, now) {
  return {
    started_utc: iso(x.start_ms),
    ended_utc: x.end_ms === null ? null : iso(x.end_ms),
    worst: x.worst,
    kind: x.kind,
    minutes: Math.max(0, Math.round(((x.end_ms === null ? now : x.end_ms) - x.start_ms) / MIN)),
    end_confirmed: x.end_confirmed !== false,
  };
}

function publicIncidents(list, sinceMs, now) {
  if (typeof sinceMs !== "number") return null;
  const last = list.length ? list[list.length - 1] : null;
  return { since_utc: iso(sinceMs), last: last ? publicIncident(last, now) : null };
}

// /incidents.json (v1.7.0): every approved service's log, newest first, for
// the per-service history pages. Read-only.
function buildIncidentsPublic(state, now) {
  const services = [];
  if (state && typeof state === "object") {
    const log = cleanIncidentLog(state);
    for (const s of SERVICES) {
      if (typeof log.since[s.id] !== "number") continue;
      services.push({
        id: s.id,
        name: s.name,
        status_page: s.status_page,
        since_utc: iso(log.since[s.id]),
        incidents: log.incidents[s.id].slice().reverse().map((x) => publicIncident(x, now)),
      });
    }
  }
  return { schema: 1, served_at_utc: iso(now), services };
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

  // Optional one-time test of the alerts channel.
  const testToken = env.SEND_TEST_ALERT ? String(env.SEND_TEST_ALERT) : "";
  if (testToken && state.test_alert_token !== testToken) {
    const sent = await postDiscord(env.DISCORD_ALERTS_WEBHOOK, EMOJI.bell + " **TEST** OutageRadar " +
      "alerts channel is working. No action needed. " + humanTime(Date.now()));
    if (sent) state.test_alert_token = testToken;
  }

  const now = Date.now();
  const publicServices = [];
  const log = cleanIncidentLog(state);

  for (let i = 0; i < SERVICES.length; i++) {
    const service = SERVICES[i];
    const feed = feeds[i];
    const probe = probes[i];
    const st = { ...freshServiceState(), ...(state.services[service.id] || {}) };
    const isApproved = approved.has(service.id);

    // Official signal.
    const official = isApproved && feed.ok ? feed.status : "unknown";
    let officialNote = "";
    if (!service.feed) officialNote = NO_FEED_NOTE;
    else if (!isApproved) officialNote = "Mapping not approved yet";
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

    // Check-only states need the service approved like everything else.
    const overall = isApproved || service.feed ? combine(official, probeStatus, !!service.feed) : "unknown";

    // Outage alerts (alerts channel). Only approved services can alert.
    if (isApproved) {
      const bad = ALERT_STATES.includes(overall);
      const coolingDown = st.last_alert_ms !== null && now - st.last_alert_ms < ALERT_COOLDOWN_MS;
      if (bad && !st.alert_open && !coolingDown) {
        const msg = overall === "signals_disagree" ? checkMessage(service, now)
          : overall === "check_failed" ? checkOnlyMessage(service, now)
          : outageMessage(service, overall, probeStatus, now);
        if (await postDiscord(env.DISCORD_ALERTS_WEBHOOK, msg)) {
          st.alert_open = true;
          st.alert_state = overall;
          st.alert_opened_ms = now;
          st.last_alert_ms = now;
        }
      } else if (bad && st.alert_open && overall in SEVERITY && st.alert_state in SEVERITY &&
                 SEVERITY[overall] > SEVERITY[st.alert_state]) {
        if (await postDiscord(env.DISCORD_ALERTS_WEBHOOK, worseMessage(service, overall, probeStatus, now))) {
          st.alert_state = overall;
          st.last_alert_ms = now;
        }
      } else if (GOOD_STATES.includes(overall) && st.alert_open) {
        if (await postDiscord(env.DISCORD_ALERTS_WEBHOOK, recoveredMessage(service, st.alert_opened_ms, now))) {
          st.alert_open = false;
          st.alert_state = null;
          st.alert_opened_ms = null;
          st.last_alert_ms = now;
        }
      }
      // Unknown while an alert is open: say nothing. We do not claim recovery we cannot see.
    }

    // Incident log: approved services only, like alerts.
    let incidents = null;
    if (isApproved) {
      if (typeof log.since[service.id] !== "number") log.since[service.id] = now;
      const result = updateIncidents(log.incidents[service.id], overall, now);
      log.incidents[service.id] = result.list;
      if (result.stalled) {
        await postDiscord(env.DISCORD_HEALTH_WEBHOOK, EMOJI.tool + " **INCIDENT LOG** " + service.name +
          ": no clear status for 2 hours, so the incident that started " + humanTime(result.stalled.start_ms) +
          " (worst: " + (LABELS[result.stalled.worst] || result.stalled.worst) +
          ") is closed as end not confirmed. A new incident opens if the problem shows again. " + humanTime(now));
      }
      incidents = publicIncidents(log.incidents[service.id], log.since[service.id], now);
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
      incidents,
    });
  }

  state.incidents = log.incidents;
  state.incident_since = log.since;

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
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
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
  // served_at_utc and age_seconds come from the server's clock, so the board
  // can judge freshness without trusting the visitor's computer clock.
  const ageSeconds = pub && typeof pub.generated_at_ms === "number"
    ? Math.max(0, Math.round((now - pub.generated_at_ms) / 1000)) : null;
  if (fresh) {
    const { generated_at_ms, ...rest } = pub;
    return { ...rest, served_at_utc: iso(now), age_seconds: ageSeconds };
  }
  // Too old or missing: everything unknown, with the last real time if we have one.
  const note = pub ? "Data is stale" : "No data yet";
  return {
    schema: 1,
    generated_at_utc: pub ? pub.generated_at_utc : null,
    served_at_utc: iso(now),
    age_seconds: ageSeconds,
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

// ---------- page-view and link-click counts (v1.5, D1) ----------
//
// The board and privacy page send one small ping per page load (POST /v) and
// one per outbound link click (POST /c). We keep DAILY TOTALS ONLY:
//   views  (day, page, country, source, bot) -> n
//   clicks (day, link, page)                 -> n
// No IP address, user agent, cookie or ID is ever stored. Country comes from
// Cloudflare. Totals older than COUNT_RETENTION_DAYS are deleted daily.
// Free D1 limit: 100,000 rows written per day; going over makes writes fail
// (the board is unaffected: it reads KV, not D1).

const COUNT_RETENTION_DAYS = 400;
const PING_MAX_BYTES = 512;
const ADMIN_KEY_MIN_LENGTH = 24;
const D1_FREE_WRITES_PER_DAY = 100000;
const ADMIN_RANGES = [7, 30, 90, 365];
const ADMIN_DEFAULT_RANGE = 30;
const DAY_MS = 24 * 60 * MIN;

const COUNT_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS views (day TEXT NOT NULL, page TEXT NOT NULL, country TEXT NOT NULL, " +
    "source TEXT NOT NULL, bot INTEGER NOT NULL, n INTEGER NOT NULL, " +
    "PRIMARY KEY (day, page, country, source, bot)) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS clicks (day TEXT NOT NULL, link TEXT NOT NULL, page TEXT NOT NULL, " +
    "n INTEGER NOT NULL, PRIMARY KEY (day, link, page)) WITHOUT ROWID",
];
const VIEW_UPSERT = "INSERT INTO views (day, page, country, source, bot, n) VALUES (?, ?, ?, ?, ?, 1) " +
  "ON CONFLICT (day, page, country, source, bot) DO UPDATE SET n = n + 1";
const CLICK_UPSERT = "INSERT INTO clicks (day, link, page, n) VALUES (?, ?, ?, 1) " +
  "ON CONFLICT (day, link, page) DO UPDATE SET n = n + 1";

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|scanner|monitor|python|curl|wget|httpclient|java\/|go-http|node-fetch|axios|okhttp|uptime|phantom|puppeteer|playwright|selenium/i;
const OWN_DOMAIN = /(^|\.)liveoutageradar\.com$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PAGE_RE = /^\/[a-z0-9\/._-]{0,80}$/;
const TAG_RE = /^[a-z0-9_-]{1,30}$/;

const SEARCH_ENGINES = [
  [/(^|\.)google\.[a-z.]{2,6}$/, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)yahoo\.[a-z.]{2,6}$/, "Yahoo"],
  [/(^|\.)yandex\.[a-z.]{2,6}$/, "Yandex"],
  [/(^|\.)baidu\.com$/, "Baidu"],
  [/(^|\.)ecosia\.org$/, "Ecosia"],
  [/^search\.brave\.com$/, "Brave"],
];

function dayString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function cleanPage(value) {
  if (typeof value !== "string") return null;
  let p = value.toLowerCase().split(/[?#]/)[0];
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  if (!PAGE_RE.test(p) || p.includes("..")) return null;
  return p;
}

function cleanHost(value) {
  if (typeof value !== "string") return null;
  const h = value.trim().toLowerCase().replace(/^www\./, "");
  return h.length <= 80 && HOST_RE.test(h) ? h : null;
}

function viewSource(ref, tag) {
  if (typeof tag === "string" && tag !== "") {
    const t = tag.toLowerCase();
    return TAG_RE.test(t) ? "utm:" + t : "other";
  }
  if (typeof ref !== "string" || ref === "") return "direct";
  const host = cleanHost(ref);
  if (!host) return "other";
  return OWN_DOMAIN.test(host) ? "internal" : host;
}

function countryOf(request) {
  const c = request.cf && typeof request.cf.country === "string" ? request.cf.country.toUpperCase() : "";
  return /^[A-Z0-9]{2}$/.test(c) ? c : "XX";
}

function isBot(request, form) {
  const ua = request.headers.get("user-agent") || "";
  return ua === "" || BOT_UA.test(ua) || form.get("w") === "1";
}

function engineFor(source) {
  for (const [re, name] of SEARCH_ENGINES) if (re.test(source)) return name;
  return null;
}

function isMissingTable(err) {
  return /no such table/i.test(String(err && err.message));
}

async function ensureCountTables(db) {
  await db.batch(COUNT_SCHEMA.map((sql) => db.prepare(sql)));
}

async function bumpCount(db, sql, args) {
  try {
    await db.prepare(sql).bind(...args).run();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    await ensureCountTables(db);
    await db.prepare(sql).bind(...args).run();
  }
}

function pingHeaders(request) {
  return { ...corsHeaders(request), "cache-control": "no-store" };
}

async function readPing(request) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > PING_MAX_BYTES) return { tooBig: true };
  const text = await request.text();
  if (text.length > PING_MAX_BYTES) return { tooBig: true };
  return { form: new URLSearchParams(text) };
}

async function handlePing(request, env, kind) {
  const headers = pingHeaders(request);
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, { status: 403, headers });
  }
  const { tooBig, form } = await readPing(request);
  if (tooBig) return new Response(null, { status: 413, headers });

  const page = cleanPage(form.get("p"));
  if (!page) return new Response(null, { status: 400, headers });
  const day = dayString(Date.now());
  const bot = isBot(request, form);

  let sql;
  let args;
  if (kind === "view") {
    sql = VIEW_UPSERT;
    args = [day, page, countryOf(request), viewSource(form.get("r"), form.get("s")), bot ? 1 : 0];
  } else {
    const raw = (form.get("l") || "").toLowerCase();
    const link = raw === "email" ? "email" : cleanHost(raw);
    if (!link) return new Response(null, { status: 400, headers });
    if (bot) return new Response(null, { status: 204, headers });
    sql = CLICK_UPSERT;
    args = [day, link, page];
  }

  if (env && env.DB) {
    try {
      await bumpCount(env.DB, sql, args);
    } catch (err) {
      console.warn("count write failed");
    }
  }
  return new Response(null, { status: 204, headers });
}

async function pruneCounts(env, now) {
  if (!env || !env.DB) return;
  const d = new Date(now);
  if (d.getUTCHours() !== 3 || d.getUTCMinutes() >= 5) return;
  const cutoff = dayString(now - COUNT_RETENTION_DAYS * DAY_MS);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM views WHERE day < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM clicks WHERE day < ?").bind(cutoff),
    ]);
  } catch (err) {
    if (!isMissingTable(err)) console.warn("count cleanup failed");
  }
}

async function sha256Bytes(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

// Compares hashes so the time taken does not depend on where the keys differ.
async function adminKeyMatches(given, expected) {
  const a = await sha256Bytes(given);
  const b = await sha256Bytes(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function adminJson(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}

async function queryCounts(db, sinceDay, today) {
  const q = (sql, ...args) => db.prepare(sql).bind(...args);
  const run = () => db.batch([
    q("SELECT day, bot, SUM(n) AS n FROM views WHERE day >= ? GROUP BY day, bot", sinceDay),
    q("SELECT page, SUM(n) AS n FROM views WHERE day >= ? AND bot = 0 GROUP BY page ORDER BY n DESC, page LIMIT 50", sinceDay),
    q("SELECT country, SUM(n) AS n FROM views WHERE day >= ? AND bot = 0 GROUP BY country ORDER BY n DESC, country LIMIT 80", sinceDay),
    q("SELECT source, SUM(n) AS n FROM views WHERE day >= ? AND bot = 0 GROUP BY source ORDER BY n DESC, source LIMIT 100", sinceDay),
    q("SELECT day, SUM(n) AS n FROM clicks WHERE day >= ? GROUP BY day", sinceDay),
    q("SELECT link, SUM(n) AS n FROM clicks WHERE day >= ? GROUP BY link ORDER BY n DESC, link LIMIT 50", sinceDay),
    q("SELECT (SELECT COALESCE(SUM(n), 0) FROM views WHERE day = ?) + " +
      "(SELECT COALESCE(SUM(n), 0) FROM clicks WHERE day = ?) AS n", today, today),
    q("SELECT MIN(day) AS first FROM views"),
  ]);
  try {
    return await run();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    await ensureCountTables(db);
    return run();
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function buildAdminData(results, rangeDays, now) {
  const rows = (i) => (results[i] && Array.isArray(results[i].results) ? results[i].results : []);
  const today = dayString(now);
  const byDay = new Map();
  for (let i = rangeDays - 1; i >= 0; i -= 1) {
    byDay.set(dayString(now - i * DAY_MS), { human: 0, bot: 0, clicks: 0 });
  }
  for (const r of rows(0)) {
    const d = byDay.get(r.day);
    if (d) d[num(r.bot) ? "bot" : "human"] += num(r.n);
  }
  for (const r of rows(4)) {
    const d = byDay.get(r.day);
    if (d) d.clicks += num(r.n);
  }
  const series = [];
  let prev = null;
  for (const [day, d] of byDay) {
    // No change % for today: a part-day against a full day would mislead.
    const dod = day !== today && prev && prev.human > 0
      ? Math.round(((d.human - prev.human) / prev.human) * 100) : null;
    series.push({ day, human: d.human, bot: d.bot, clicks: d.clicks, dod_pct: dod });
    prev = d;
  }
  const totals = series.reduce((t, d) => ({
    human: t.human + d.human, bot: t.bot + d.bot, clicks: t.clicks + d.clicks,
  }), { human: 0, bot: 0, clicks: 0 });

  const sources = rows(3).map((r) => ({ source: String(r.source), n: num(r.n) }));
  const engineTotals = new Map();
  for (const s of sources) {
    const e = engineFor(s.source);
    if (e) engineTotals.set(e, (engineTotals.get(e) || 0) + s.n);
  }
  const engines = [...engineTotals].map(([engine, n]) => ({ engine, n }))
    .sort((a, b) => b.n - a.n || a.engine.localeCompare(b.engine));

  const todayRow = series[series.length - 1];
  const hours = (now - Date.parse(today + "T00:00:00Z")) / (60 * MIN);
  const writes = num(rows(6)[0] && rows(6)[0].n);
  return {
    generated_at_utc: iso(now),
    range_days: rangeDays,
    first_day: rows(7)[0] && rows(7)[0].first ? String(rows(7)[0].first) : null,
    series,
    totals,
    today: {
      day: today,
      human: todayRow.human,
      bot: todayRow.bot,
      clicks: todayRow.clicks,
      hours_elapsed: Math.round(hours * 10) / 10,
      run_rate: hours >= 1 ? Math.round((todayRow.human / hours) * 24) : null,
    },
    pages: rows(1).map((r) => ({ page: String(r.page), n: num(r.n) })),
    countries: rows(2).map((r) => ({ country: String(r.country), n: num(r.n) })),
    sources,
    engines,
    links: rows(5).map((r) => ({ link: String(r.link), n: num(r.n) })),
    quota: {
      writes_today_est: writes,
      limit: D1_FREE_WRITES_PER_DAY,
      pct: Math.round((writes / D1_FREE_WRITES_PER_DAY) * 1000) / 10,
    },
  };
}

async function handleAdminData(request, env, url) {
  const expected = env && typeof env.ADMIN_KEY === "string" ? env.ADMIN_KEY : "";
  if (expected.length < ADMIN_KEY_MIN_LENGTH) return adminJson({ error: "admin_key_missing" }, 503);
  const auth = request.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!given || !(await adminKeyMatches(given, expected))) return adminJson({ error: "wrong_key" }, 401);
  if (!env.DB) return adminJson({ error: "db_missing" }, 503);

  const asked = Number(url.searchParams.get("days"));
  const rangeDays = ADMIN_RANGES.includes(asked) ? asked : ADMIN_DEFAULT_RANGE;
  const now = Date.now();
  try {
    const results = await queryCounts(env.DB, dayString(now - (rangeDays - 1) * DAY_MS), dayString(now));
    return adminJson(buildAdminData(results, rangeDays, now), 200);
  } catch (err) {
    console.warn("dashboard read failed");
    return adminJson({ error: "db_error" }, 503);
  }
}

const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function adminPage(body, contentType) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": ADMIN_CSP,
    },
  });
}

// The dashboard page holds no data: it asks for the key, then loads
// /admin/data with the key in a request header (never in the URL).
const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>OutageRadar traffic (private)</title>
<style>
:root{--bg:#06110d;--panel:#0a1912;--line:#173325;--text:#e8fff1;--muted:#9cc9ad;--op:#4be08a;--bot:#5b7a69;--teal:#5fd4d0;--amber:#ffb547;--bad:#ff8a80;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.45;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.wrap{max-width:62rem;margin:0 auto;padding:1rem 1rem 3rem}
header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1rem;padding-bottom:.75rem;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:1.35rem}
h1 span{color:var(--op)}
.meta{color:var(--muted);font-size:.85rem;margin:0}
h2{font-size:1rem;margin:0 0 .6rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1rem;margin-top:1rem}
label{display:block;margin-bottom:.4rem;color:var(--muted)}
input[type=password]{width:100%;max-width:26rem;font:inherit;padding:.6rem .7rem;border-radius:8px;border:1px solid var(--line);background:#04100b;color:var(--text)}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:#0f241a;color:var(--text);padding:.5rem .9rem}
button.primary{background:var(--op);color:#05200f;border-color:var(--op);font-weight:600;margin-top:.6rem}
button[aria-pressed=true]{border-color:var(--op);color:var(--op)}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--teal);outline-offset:2px}
.hide{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.err{color:var(--bad);margin:.6rem 0 0}
.ranges{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:1rem}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem;margin-top:1rem}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.8rem}
.stat b{display:block;font-size:1.9rem;line-height:1.1;font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:.85rem}
.stat.lead b{color:var(--op)}
#chart svg{display:block;width:100%;height:auto}
.legend{display:flex;gap:1rem;color:var(--muted);font-size:.8rem;margin-top:.4rem;flex-wrap:wrap}
.sw{display:inline-block;width:.8rem;height:.8rem;border-radius:2px;vertical-align:-1px;margin-right:.3rem}
.grid2{display:grid;gap:0 1rem}
.list{list-style:none;margin:0;padding:0}
.list li{display:grid;grid-template-columns:1fr auto;gap:.2rem .6rem;padding:.35rem 0;border-bottom:1px solid var(--line);font-size:.92rem}
.list li:last-child{border-bottom:0}
.list .k{overflow-wrap:anywhere}
.list .v{font-variant-numeric:tabular-nums;color:var(--muted)}
.bar{grid-column:1/-1;height:4px;border-radius:2px;background:var(--line)}
.bar i{display:block;height:100%;border-radius:2px;background:var(--op)}
.empty{color:var(--muted);margin:0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:.35rem .5rem;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{color:var(--muted);font-weight:500}
.up{color:var(--op)}.down{color:var(--bad)}
.meter{height:8px;border-radius:4px;background:var(--line);margin:.5rem 0}
.meter i{display:block;height:100%;border-radius:4px;background:var(--teal)}
.meter.warn i{background:var(--amber)}
footer{color:var(--muted);font-size:.85rem;margin-top:1.5rem}
a{color:var(--op)}
@media (min-width:44rem){.stats{grid-template-columns:repeat(4,minmax(0,1fr))}.grid2{grid-template-columns:1fr 1fr}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Outage<span>Radar</span> traffic</h1>
  <p class="meta" id="status">Private. Not linked from the site.</p>
</header>

<form class="card" id="login" autocomplete="on">
  <input class="hide" type="text" name="username" autocomplete="username" value="outageradar-admin" tabindex="-1" aria-hidden="true">
  <label for="key">Admin key</label>
  <input id="key" name="password" type="password" autocomplete="current-password" required>
  <div><button class="primary" type="submit">Unlock</button></div>
  <p class="err" id="loginErr" hidden></p>
</form>

<main id="dash" hidden>
  <div class="ranges" role="group" aria-label="Date range">
    <button type="button" data-days="7">7 days</button>
    <button type="button" data-days="30">30 days</button>
    <button type="button" data-days="90">90 days</button>
    <button type="button" data-days="365">1 year</button>
    <button type="button" id="refresh">Refresh</button>
  </div>
  <p class="err" id="dashErr" hidden></p>

  <div class="stats">
    <div class="stat lead"><span>Page views</span><b id="sViews">-</b><span id="sViewsSub"></span></div>
    <div class="stat"><span>Today so far (UTC)</span><b id="sToday">-</b><span id="sTodaySub"></span></div>
    <div class="stat"><span>Outbound clicks</span><b id="sClicks">-</b><span id="sClicksSub"></span></div>
    <div class="stat"><span>Bot views (ran our script)</span><b id="sBots">-</b><span id="sBotsSub"></span></div>
  </div>

  <section class="card">
    <h2>Page views per day (UTC)</h2>
    <div id="chart"></div>
    <div class="legend"><span><i class="sw" style="background:var(--op)"></i>People</span><span><i class="sw" style="background:var(--bot)"></i>Bots</span><span><i class="sw" style="background:var(--amber)"></i>Today, in progress</span></div>
  </section>

  <div class="grid2">
    <section class="card"><h2>Where visitors came from</h2><ul class="list" id="sources"></ul></section>
    <section class="card"><h2>Search engines</h2><ul class="list" id="engines"></ul></section>
    <section class="card"><h2>Pages</h2><ul class="list" id="pages"></ul></section>
    <section class="card"><h2>Outbound clicks by site</h2><ul class="list" id="links"></ul></section>
  </div>

  <section class="card"><h2>Countries</h2><ul class="list" id="countries"></ul></section>

  <section class="card">
    <h2>Day by day</h2>
    <div class="scroll"><table><thead><tr><th>Date</th><th>People</th><th>vs day before</th><th>Bots</th><th>Clicks</th></tr></thead><tbody id="days"></tbody></table></div>
  </section>

  <section class="card">
    <h2>Free database allowance today</h2>
    <div class="meter" id="meter"><i></i></div>
    <p class="empty" id="quota"></p>
  </section>

  <footer>
    <p>Counts only: no IP addresses, cookies or IDs are stored. "Bots" means automated browsers that ran the page script; most crawlers never do. For Google search impressions, clicks and crawling, use <a href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer">Search Console</a>.</p>
  </footer>
</main>
</div>
<script src="/admin/app.js"></script>
</body>
</html>`;

// Runs in the browser only. Served as /admin/app.js by stringifying this
// function, so it must not use anything from the Worker's scope.
function adminApp() {
  "use strict";
  var key = "";
  var days = 30;
  var timer = null;
  var busy = false;
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Number(n || 0).toLocaleString("en-US"); };

  function show(el, on) { el.hidden = !on; }

  function setError(id, text) {
    var el = $(id);
    el.textContent = text || "";
    show(el, !!text);
  }

  // Full country names read on every device (Windows can't draw flag emoji).
  var regionNames = null;
  try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch (e) { regionNames = null; }
  function countryLabel(cc) {
    if (cc === "XX") return "Unknown";
    if (cc === "T1") return "Tor network (T1)";
    var name = "";
    try { name = regionNames && /^[A-Z]{2}$/.test(cc) ? regionNames.of(cc) : ""; } catch (e) { name = ""; }
    return name && name !== cc ? name + " (" + cc + ")" : cc;
  }

  // Top of the chart: the next of 1, 2, 4, 6, 8, 10 (x10^n) at or above the
  // highest bar, so the halfway line is always a whole number.
  function chartTop(max) {
    if (max <= 1) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(max)));
    var steps = [1, 2, 4, 6, 8, 10];
    for (var i = 0; i < steps.length; i += 1) if (steps[i] * p >= max) return steps[i] * p;
    return 10 * p;
  }

  function sourceLabel(s) {
    if (s === "direct") return "Direct (typed, bookmark or app)";
    if (s === "internal") return "Our own pages";
    if (s === "other") return "Other (unreadable)";
    if (s.indexOf("utm:") === 0) return "Tag: " + s.slice(4);
    return s;
  }

  function fillList(id, items, labelFn, emptyText) {
    var ul = $(id);
    ul.textContent = "";
    if (!items.length) {
      var li0 = document.createElement("li");
      li0.className = "empty";
      li0.textContent = emptyText;
      ul.appendChild(li0);
      return;
    }
    var max = items[0].n || 1;
    items.forEach(function (it) {
      var li = document.createElement("li");
      var k = document.createElement("span");
      k.className = "k";
      k.textContent = labelFn(it);
      var v = document.createElement("span");
      v.className = "v";
      v.textContent = fmt(it.n);
      var bar = document.createElement("span");
      bar.className = "bar";
      var fill = document.createElement("i");
      fill.style.width = Math.max(2, Math.round((it.n / max) * 100)) + "%";
      bar.appendChild(fill);
      li.appendChild(k);
      li.appendChild(v);
      li.appendChild(bar);
      ul.appendChild(li);
    });
  }

  function chart(series) {
    var NS = "http://www.w3.org/2000/svg";
    var box = $("chart");
    var W = Math.max(280, Math.round(box.clientWidth || 640)), H = 200, padL = 34, padB = 22, padT = 8;
    var max = 1;
    series.forEach(function (d) { max = Math.max(max, d.human + d.bot); });
    var top = chartTop(max);
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Page views per day");
    var plotH = H - padB - padT;
    var y = function (v) { return padT + plotH - (v / top) * plotH; };
    (top === 1 ? [0, 1] : [0, 0.5, 1]).forEach(function (f) {
      var gy = y(top * f);
      var line = document.createElementNS(NS, "line");
      line.setAttribute("x1", padL); line.setAttribute("x2", W);
      line.setAttribute("y1", gy); line.setAttribute("y2", gy);
      line.setAttribute("stroke", "#173325");
      svg.appendChild(line);
      var t = document.createElementNS(NS, "text");
      t.setAttribute("x", padL - 6); t.setAttribute("y", gy + 4);
      t.setAttribute("text-anchor", "end"); t.setAttribute("fill", "#9cc9ad"); t.setAttribute("font-size", "11");
      t.textContent = fmt(Math.round(top * f));
      svg.appendChild(t);
    });
    var slot = (W - padL) / series.length;
    var bw = Math.max(1, Math.min(28, slot * 0.7));
    var labelEvery = Math.ceil(series.length / Math.max(3, Math.floor((W - padL) / 60)));
    series.forEach(function (d, i) {
      var x = padL + i * slot + (slot - bw) / 2;
      var last = i === series.length - 1;
      var hb = y(0) - y(d.human);
      var bb = y(0) - y(d.bot);
      var r1 = document.createElementNS(NS, "rect");
      r1.setAttribute("x", x); r1.setAttribute("width", bw);
      r1.setAttribute("y", y(d.human)); r1.setAttribute("height", Math.max(0, hb));
      r1.setAttribute("fill", last ? "#ffb547" : "#4be08a");
      var tip = document.createElementNS(NS, "title");
      tip.textContent = d.day + ": " + fmt(d.human) + " people, " + fmt(d.bot) + " bots";
      r1.appendChild(tip);
      svg.appendChild(r1);
      if (d.bot > 0) {
        var r2 = document.createElementNS(NS, "rect");
        r2.setAttribute("x", x); r2.setAttribute("width", bw);
        r2.setAttribute("y", y(d.human + d.bot)); r2.setAttribute("height", Math.max(0, bb));
        r2.setAttribute("fill", "#5b7a69");
        svg.appendChild(r2);
      }
      if (i % labelEvery === 0 || last) {
        var lt = document.createElementNS(NS, "text");
        lt.setAttribute("x", x + bw / 2); lt.setAttribute("y", H - 6);
        lt.setAttribute("text-anchor", "middle"); lt.setAttribute("fill", "#9cc9ad"); lt.setAttribute("font-size", "11");
        lt.textContent = d.day.slice(5);
        svg.appendChild(lt);
      }
    });
    box.textContent = "";
    box.appendChild(svg);
  }

  function render(data) {
    var t = data.today;
    $("sViews").textContent = fmt(data.totals.human);
    $("sViewsSub").textContent = "last " + data.range_days + " days";
    $("sToday").textContent = fmt(t.human);
    $("sTodaySub").textContent = t.run_rate === null ? "pace shown after 01:00 UTC" : "on pace for about " + fmt(t.run_rate);
    $("sClicks").textContent = fmt(data.totals.clicks);
    $("sClicksSub").textContent = fmt(t.clicks) + " today";
    $("sBots").textContent = fmt(data.totals.bot);
    $("sBotsSub").textContent = fmt(t.bot) + " today";
    lastSeries = data.series;
    chart(data.series);
    fillList("sources", data.sources, function (s) { return sourceLabel(s.source); }, "No visits yet.");
    fillList("engines", data.engines, function (e) { return e.engine; }, "No search visits yet.");
    fillList("pages", data.pages, function (p) { return p.page; }, "No visits yet.");
    fillList("links", data.links, function (l) { return l.link === "email" ? "Email link" : l.link; }, "No clicks yet.");
    fillList("countries", data.countries, function (c) { return countryLabel(c.country); }, "No visits yet.");
    var tb = $("days");
    tb.textContent = "";
    data.series.slice().reverse().forEach(function (d, i) {
      var tr = document.createElement("tr");
      var dod = i === 0 ? "in progress" : d.dod_pct === null ? "-" : (d.dod_pct > 0 ? "+" : "") + d.dod_pct + "%";
      [d.day + (i === 0 ? " (today)" : ""), fmt(d.human), dod, fmt(d.bot), fmt(d.clicks)].forEach(function (v, j) {
        var td = document.createElement("td");
        td.textContent = v;
        if (j === 2 && d.dod_pct !== null) td.className = d.dod_pct >= 0 ? "up" : "down";
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    var q = data.quota;
    var m = $("meter");
    m.className = "meter" + (q.pct >= 50 ? " warn" : "");
    m.firstChild.style.width = Math.min(100, Math.max(0.5, q.pct)) + "%";
    var pctText = q.pct === 0 && q.writes_today_est > 0 ? "under 0.1%" : q.pct + "%";
    $("quota").textContent = "About " + fmt(q.writes_today_est) + " of " + fmt(q.limit) + " free writes used today (" + pctText + "). Resets at 00:00 UTC. If it runs out, counting pauses until reset; the board keeps working.";
    $("status").textContent = "Updated " + data.generated_at_utc.slice(11, 16) + " UTC. Refreshes every minute while open.";
    Array.prototype.forEach.call(document.querySelectorAll("[data-days]"), function (b) {
      b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-days")) === data.range_days));
    });
  }

  function lock(message) {
    key = "";
    if (timer) { clearInterval(timer); timer = null; }
    show($("dash"), false);
    show($("login"), true);
    setError("loginErr", message);
    $("key").focus();
  }

  function load() {
    if (!key || busy) return;
    busy = true;
    fetch("/admin/data?days=" + days, { headers: { authorization: "Bearer " + key }, cache: "no-store" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.status === 401) return lock("That key is not right.");
        if (r.body.error === "admin_key_missing") return lock("The ADMIN_KEY secret is not set on the Worker (it needs at least 24 characters).");
        if (r.body.error === "db_missing") { setError("dashErr", "No database is connected. Add the D1 binding named DB to the Worker."); return; }
        if (r.status !== 200) { setError("dashErr", "Could not load the numbers (HTTP " + r.status + "). Try Refresh."); return; }
        setError("dashErr", "");
        show($("login"), false);
        show($("dash"), true);
        render(r.body);
      })
      .catch(function () { setError("dashErr", "Network error. Try Refresh."); })
      .then(function () { busy = false; });
  }

  $("login").addEventListener("submit", function (e) {
    e.preventDefault();
    key = $("key").value.trim();
    setError("loginErr", "");
    load();
    if (!timer) timer = setInterval(function () { if (!document.hidden) load(); }, 60000);
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-days]"), function (b) {
    b.addEventListener("click", function () { days = Number(b.getAttribute("data-days")); load(); });
  });
  $("refresh").addEventListener("click", load);
  var lastSeries = null;
  window.addEventListener("resize", function () { if (lastSeries) chart(lastSeries); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
}

const ADMIN_APP_JS = "(" + adminApp.toString() + ")();\n";

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "x-robots-tag": "noindex" } });
  }
  if (request.method === "POST" && url.pathname === "/v") return handlePing(request, env, "view");
  if (request.method === "POST" && url.pathname === "/c") return handlePing(request, env, "click");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return respond(JSON.stringify({ error: "method not allowed" }), 405, cors);
  }

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return adminPage(ADMIN_HTML, "text/html; charset=utf-8");
  }
  if (url.pathname === "/admin/app.js") {
    return adminPage(ADMIN_APP_JS, "text/javascript; charset=utf-8");
  }
  if (url.pathname === "/admin/data") return handleAdminData(request, env, url);

  if (url.pathname === "/status.json") {
    let state = null;
    try {
      if (env && env.KV) state = await cachedState(env.KV);
    } catch (err) {
      console.warn("status read failed");
    }
    return respond(JSON.stringify(buildPublic(state, Date.now())), 200, cors);
  }

  if (url.pathname === "/incidents.json") {
    let state = null;
    try {
      if (env && env.KV) state = await cachedState(env.KV);
    } catch (err) {
      console.warn("history read failed");
    }
    return respond(JSON.stringify(buildIncidentsPublic(state, Date.now())), 200, cors);
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
    try {
      await pruneCounts(env, Date.now());
    } catch (err) {
      console.warn("count cleanup failed");
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
