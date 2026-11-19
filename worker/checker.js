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
//   GET /feed.xml, /feed/<id>.xml  RSS 2.0 feeds of incidents (v1.14.0)
//                     (v1.7.0, for the /status/<id>/ history pages)
//   POST /v, /c       page-view / link-click pings from our site (daily totals
//                     in D1; no IP, user agent, cookie or ID stored)
//   GET /admin        private traffic dashboard (data needs ADMIN_KEY)
//   GET /admin/manifest.webmanifest, /admin/icon-180.png
//                     v1.22.0: add /admin to an iPhone home screen (no data)
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
//   BSKY_MODE, BSKY_HANDLE, BSKY_APP_PASSWORD, DISCORD_SOCIAL_WEBHOOK
//                           v1.17.0 Bluesky posts and reply assist; off unless
//                           all are set (see the Bluesky section below).
//
// Source of truth: GitHub repo willdixon444-rgb/outageradar, worker/checker.js.
// This file must stay ASCII-only.

const VERSION = "1.22.1";

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
    // v1.20.0: the parts feed (shared with Codex), counting the API parts only
    // (read from the live feed on Nov 15, 2026; "Login" is left out because
    // the ChatGPT group has a part with the same name). ChatGPT itself is the
    // app line. Before, the page-wide word made ChatGPT problems look like API
    // problems.
    feed: "https://status.openai.com/api/v2/components.json",
    samples: [],
    parser: "components",
    components: ["Chat Completions", "Responses", "Agents", "Decisions", "Fine-tuning", "Embeddings", "Images",
      "Batch", "Audio", "Moderations", "Realtime", "Files", "Live"],
    app: { label: "ChatGPT app", components: ["Conversations"] },
    // v1.21.0: uptime counts from the API-only change (v1.20.0); older
    // incidents were recorded under the page-wide word, ChatGPT included.
    uptime_from: Date.UTC(2026, 10, 16, 1, 15),
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
    samples: [], // v1.6 samples reviewed; cleared in v1.10.0 to save requests
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
    // v1.20.0: the API part only; claude.ai is the app line. On Nov 15, 2026
    // claude.ai was degraded while the API was operational, and the page-wide
    // word showed the whole row as degraded.
    parser: "components",
    components: ["Claude API (api.anthropic.com)"],
    app: { label: "claude.ai app", components: ["claude.ai"] },
    uptime_from: Date.UTC(2026, 10, 16, 1, 15), // v1.21.0: as for OpenAI

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
    samples: [], // reviewed; cleared in v1.10.0
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
    samples: [], // reviewed; cleared in v1.10.0
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
  // ---- Listed in v1.11.0 from the v1.10.0 samples (Nov 9, 2026). ----
  {
    // status.together.ai is Better Stack: index.json has the same layout as
    // Hugging Face's (sampled: aggregate_state "operational", about 190 KB).
    id: "together",
    name: "Together AI",
    status_page: "https://status.together.ai",
    feed: "https://status.together.ai/index.json",
    samples: [],
    parser: "betterstack",
    // Sampled: HTTP 401 (text/plain) without a key.
    probe: "https://api.together.xyz/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // status.fireworks.ai serves a Statuspage-format summary.json (sampled:
    // indicator "none"). It is not hosted by Atlassian, but the format matches.
    // Its components are single models, so only the overall indicator is read.
    id: "fireworks",
    name: "Fireworks AI",
    status_page: "https://status.fireworks.ai",
    feed: "https://status.fireworks.ai/api/v2/summary.json",
    samples: [],
    parser: "statuspage_indicator",
    // Sampled: HTTP 401 (JSON) without a key.
    probe: "https://api.fireworks.ai/inference/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  // ---- Added in v1.10.0 in hidden sample mode. ----
  // A service with listed: false is checked every run, but never appears in
  // status.json, /incidents.json or Discord (neither channel), and never
  // counts as approved, until a release reviews its real samples and lists
  // it. v1.12.0: OpenRouter and GitHub Copilot listed. v1.13.0: DeepInfra
  // listed; no service is hidden now.
  // Parked in v1.11.0: Microsoft Copilot. status.cloud.microsoft is a script
  // app with no documented public feed, and copilot.microsoft.com answers
  // with a sign-in page, which says little about whether Copilot works. It is
  // no longer checked; re-add it only with a documented official feed.
  {
    // status.openrouter.ai runs on Datadog Status Pages (owner confirmed the
    // "Powered by Datadog" footer, Nov 9, 2026). Datadog's documented status
    // page API needs the page owner's keys; no public reader feed is
    // documented, and /api/v2/summary.json answered 403. So: no official feed,
    // shown like Gemini and DeepSeek. Listed in v1.12.0.
    // Check: GET /api/v1/key, documented by OpenRouter as needing a key.
    // Sampled Nov 10, 2026: HTTP 401 (JSON, OpenRouter's own error). The
    // public model list (the v1.10 check) answered in 11-22 ms, possibly from
    // an edge cache that could stay up while OpenRouter is down.
    id: "openrouter",
    name: "OpenRouter",
    status_page: "https://status.openrouter.ai",
    feed: null,
    samples: [],
    parser: "none",
    probe: "https://openrouter.ai/api/v1/key",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // status.deepinfra.com is DeepInfra's own site. Its /api page documents a
    // keyless JSON API (schemaVersion 1; fields only added within a version).
    // /api/v1/status (sampled Nov 10, 2026, about 32 KB) has overallStatus,
    // isStale, two core services ("api", "website") and ~171 single models.
    // Only the core "api" service counts: overallStatus may include single
    // models. Listed in v1.13.0.
    id: "deepinfra",
    name: "DeepInfra",
    status_page: "https://status.deepinfra.com",
    feed: "https://status.deepinfra.com/api/v1/status",
    samples: [],
    parser: "deepinfra_api",
    probe: "https://api.deepinfra.com/v1/openai/models",
    probe_ok: [],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // githubstatus.com (Statuspage, sampled): "Copilot" and "Copilot AI Model
    // Providers" components. The worse of the two counts; the rest of GitHub
    // (Git, Actions...) is ignored. Feed mapped in v1.11.0.
    // Check: api.githubcopilot.com answered HTTP 400, text/plain "bad request:
    // missing required Authorization header" (sampled Nov 10, 2026): GitHub's
    // own server refusing a request without a key, so 400 counts as
    // answering here (this service only). Listed in v1.12.0.
    id: "github-copilot",
    name: "GitHub Copilot",
    status_page: "https://www.githubstatus.com",
    feed: "https://www.githubstatus.com/api/v2/summary.json",
    samples: [],
    parser: "components",
    components: ["Copilot", "Copilot AI Model Providers"],
    probe: "https://api.githubcopilot.com/models",
    probe_ok: [400],
    // AG review (v1.13.0): a 400 counts only when it is GitHub's own reply,
    // shown by the text of the real reply. Any other 400 (for example a
    // generic page from something in front of GitHub) is odd: Unknown.
    probe_ok_text: { 400: /missing required Authorization header/i },
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  // ---- v1.18.0 (Nov 15, 2026): added in hidden sample mode. ----
  // v1.19.0: Cursor, Claude Code, Codex, ElevenLabs and Runway listed from the
  // v1.18.0 samples. Windsurf stays hidden: its check answered HTTP 404 "fault
  // filter abort", a generic network reply that proves nothing about Windsurf.
  // Feeds and part names were read from the live official feeds on Nov 15,
  // 2026. Claude Code and Codex use the same API servers as Claude and OpenAI,
  // so they share those checks. The checks for Cursor, Windsurf, ElevenLabs
  // and Runway are UNVERIFIED candidates with no expected codes yet (any
  // answer but 2xx is kept as "odd" with its first characters), so the
  // samples show who answers before anything is counted as up or down.
  {
    // Cursor's status moved to xAI's page; the feed Grok already uses lists
    // Cursor's parts (ids "cursor-com", "cursor-desktop", "cursor-cli").
    id: "cursor",
    name: "Cursor",
    status_page: "https://status.cursor.com",
    feed: "https://data.x.ai/status/summary.json",
    samples: [],
    parser: "components",
    components: ["cursor.com", "Cursor IDE (Desktop)", "CLI"],
    probe: "https://api2.cursor.sh",
    // v1.19.0: the sample answered HTTP 200 "Welcome to Cursor. From <build>".
    // Counted only with that text, so a parked or generic page never counts.
    probe_ok: [200],
    probe_ok_text: { 200: /^\s*Welcome to Cursor\./ },
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    status_page: "https://status.claude.com",
    feed: "https://status.claude.com/api/v2/summary.json",
    samples: [],
    parser: "components",
    components: ["Claude Code"],
    probe: "https://api.anthropic.com/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // components.json, not summary.json: summary.json stops at 25 parts and
    // leaves the Codex group out.
    id: "codex",
    name: "OpenAI Codex",
    status_page: "https://status.openai.com",
    feed: "https://status.openai.com/api/v2/components.json",
    samples: [],
    parser: "components",
    components: ["Codex Web", "Codex API", "CLI", "VS Code extension"],
    probe: "https://api.openai.com/v1/models",
    probe_ok: [401],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // Atlassian Statuspage; the page also lists Netlify parts, not counted.
    id: "windsurf",
    name: "Windsurf",
    listed: false,
    status_page: "https://status.windsurf.com",
    feed: "https://status.windsurf.com/api/v2/summary.json",
    samples: [],
    parser: "components",
    components: ["Cascade", "Windsurf Tab"],
    probe: "https://server.codeium.com",
    probe_ok: [],
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    // incident.io: the feed gives a page-wide status and no parts.
    id: "elevenlabs",
    name: "ElevenLabs",
    status_page: "https://status.elevenlabs.io",
    feed: "https://status.elevenlabs.io/api/v2/summary.json",
    samples: [],
    parser: "statuspage_indicator",
    probe: "https://api.elevenlabs.io/v1/models",
    // v1.19.0: without a key the API answered HTTP 404 in its own error format
    // ({"detail":{"code":"workspace_not_found",...,"request_id":...}}). Counted
    // only in that format.
    probe_ok: [404],
    probe_ok_text: { 404: /"detail"\s*:\s*\{[\s\S]*"request_id"/ },
    probe_label: API_LABEL,
    probe_words: "API server",
  },
  {
    id: "runway",
    name: "Runway",
    status_page: "https://status.runwayml.com",
    feed: "https://status.runwayml.com/api/v2/summary.json",
    samples: [],
    parser: "components",
    components: ["Public API"],
    probe: "https://api.dev.runwayml.com/v1/organization",
    // v1.19.0: without a key the API answered HTTP 401 "No API key was
    // provided..." with a link to docs.dev.runwayml.com. Counted only with it.
    probe_ok: [401],
    probe_ok_text: { 401: /docs\.dev\.runwayml\.com/ },
    probe_label: API_LABEL,
    probe_words: "API server",
  },
];

// Services shown publicly (the board, status.json, /incidents.json, alerts).
function isListed(service) {
  return service.listed !== false;
}
const PUBLIC_IDS = new Set(SERVICES.filter(isListed).map((s) => s.id));

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

  if (service.parser === "deepinfra_api") {
    // v1.13.0. Status words seen in the sample: OPERATIONAL. The others are
    // matched by the same spelling rules as Statuspage words (UNVERIFIED for
    // DeepInfra); anything unrecognised is Unknown, never operational.
    if (!Array.isArray(data.services)) return { ok: false, status: "unknown", reason: "no services list" };
    const api = data.services.find((x) => x && x.publicId === "api");
    if (!api) return { ok: false, status: "unknown", reason: "expected components missing" };
    if (data.isStale === true) return { ok: true, status: "unknown", reason: "provider marks its data stale" };
    const key = typeof api.status === "string" ? api.status.toLowerCase().replace(/[\s_-]/g, "") : "";
    const mapped = COMPONENT_MAP[key];
    // COMPONENT_MAP also holds xAI's "available"; DeepInfra never uses it.
    if (!mapped || key === "available") return { ok: true, status: "unknown", reason: "unrecognised component status" };
    return { ok: true, status: mapped, reason: "" };
  }

  return { ok: false, status: "unknown", reason: "no parser" };
}

// v1.18.0: downloading is separate from reading, so one download of a feed
// address serves every service that uses it (Cursor shares Grok's feed,
// Claude Code shares Claude's). Never throws.
async function downloadFeed(url) {
  const checkedAt = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    }, FETCH_TIMEOUT_MS);
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      discardBody(res);
      return { checkedAt, ok: false, code: res.status, contentType, text: "" };
    }
    return { checkedAt, ok: true, code: res.status, contentType, text: await res.text() };
  } catch (err) {
    return { checkedAt, ok: false, code: 0, error: describeError(err), contentType: "", text: "" };
  }
}

async function checkFeed(service, download) {
  if (!service.feed) {
    // Nothing to fetch. Not a broken feed, so no feed alerts.
    return { ok: true, status: "unknown", reason: NO_FEED_NOTE, checkedAt: Date.now() };
  }
  const d = await (download || downloadFeed)(service.feed);
  const checkedAt = d.checkedAt;
  if (d.error) {
    return {
      ok: false, status: "unknown", reason: d.error, checkedAt,
      raw: { http_status: 0, error: d.error, bytes: 0, body: "" },
    };
  }
  if (!d.ok) {
    return {
      ok: false, status: "unknown", reason: "HTTP " + d.code, checkedAt,
      raw: { http_status: d.code, content_type: d.contentType, bytes: 0, body: "" },
    };
  }
  const parsed = parseFeed(service, d.text, d.contentType);
  // v1.20.0: the app line, read from the same download. Never a feed problem:
  // anything it cannot read is just Unknown.
  if (service.app) {
    const a = parseFeed({ parser: "components", components: service.app.components }, d.text, d.contentType);
    parsed.app = a.ok ? a.status : "unknown";
  }
  // v1.10.0: keep a raw copy so a sample run never downloads the feed twice.
  return {
    ...parsed, checkedAt,
    raw: { http_status: d.code, content_type: d.contentType, bytes: d.text.length, body: d.text.slice(0, SAMPLE_BODY_LIMIT) },
  };
}

// v1.18.0: two services share one API check only when everything that decides
// the answer is the same: the address, the codes that count, and any text the
// reply must contain. Otherwise each runs its own.
function probeKey(service) {
  const ok = (service.probe_ok || []).slice().sort((a, b) => a - b).join(",");
  const text = Object.entries(service.probe_ok_text || {})
    .map(([code, re]) => code + "=" + String(re)).sort().join(";");
  return service.probe + "|" + ok + "|" + text;
}

// Runs make(key) once per key; later callers share the same promise.
function onceBy(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}

// ---------- Site reachable probe ----------

const CHALLENGE_MARKERS = [/just a moment/i, /challenge-platform/i, /cf-chl/i, /attention required/i];

async function checkProbe(service) {
  const checkedAt = Date.now();
  try {
    // v1.8.0: time from sending the request to the reply's first bytes. In
    // Workers the clock moves forward across network waits, so this measures
    // the round trip from Cloudflare to the provider's API server.
    const t0 = Date.now();
    const res = await fetchWithTimeout(service.probe, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
      redirect: "follow",
    }, FETCH_TIMEOUT_MS);
    const ms = Math.max(0, Date.now() - t0);
    const code = res.status;
    const headers = {
      server: res.headers.get("server") || "",
      "content-type": res.headers.get("content-type") || "",
      "cf-mitigated": res.headers.get("cf-mitigated") || "",
      // v1.13.0 (AG review): whether GitHub's own request-id header came back.
      // Presence only; the id itself is never stored.
      "x-github-request-id": res.headers.has("x-github-request-id") ? "present" : "",
    };
    if (headers["cf-mitigated"]) {
      discardBody(res);
      return { result: "blocked", ms, code, reason: "challenge page", checkedAt, headers, peek: "" };
    }
    if ((service.probe_ok || []).includes(code)) {
      const mustSay = service.probe_ok_text && service.probe_ok_text[code];
      if (mustSay) {
        const peek = await peekBody(res, PROBE_PEEK_CHARS);
        if (!mustSay.test(peek)) {
          return { result: "odd", ms, code, reason: "unexpected HTTP " + code + " reply", checkedAt, headers, peek };
        }
        return { result: "ok", ms, code, reason: "", checkedAt, headers, peek: "" };
      }
      discardBody(res);
      return { result: "ok", ms, code, reason: "", checkedAt, headers, peek: "" };
    }
    if (code === 403 || code === 429) {
      discardBody(res);
      return { result: "blocked", ms, code, reason: "blocked (HTTP " + code + ")", checkedAt, headers, peek: "" };
    }
    if (code >= 500) {
      discardBody(res);
      return { result: "fail", ms, code, reason: "HTTP " + code, checkedAt, headers, peek: "" };
    }
    if (code >= 200 && code < 300) {
      const peek = await peekBody(res, PROBE_PEEK_CHARS);
      if (CHALLENGE_MARKERS.some((re) => re.test(peek))) {
        return { result: "blocked", ms, code, reason: "challenge page", checkedAt, headers, peek };
      }
      return { result: "ok", ms, code, reason: "", checkedAt, headers, peek };
    }
    // v1.11.0: keep the first characters of an unexpected reply so the samples
    // show who answered (the provider's server, or something in between).
    // Still "odd": never counted as up or down.
    const peek = await peekBody(res, PROBE_PEEK_CHARS);
    return { result: "odd", ms, code, reason: "unexpected HTTP " + code, checkedAt, headers, peek };
  } catch (err) {
    return { result: "fail", ms: null, code: 0, reason: describeError(err), checkedAt, headers: {}, peek: "" };
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
    // v1.15.0: degraded episodes, for subscribers who opted in.
    minor_open: false,
    last_minor_ms: null,
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

async function postDiscord(webhook, content, flags) {
  // Returns true only if Discord accepted it. Never throws, never logs the URL.
  // flags: optional Discord message flags (v1.17.1: 4 = no link preview cards).
  if (!webhook) return false;
  const message = { username: "OutageRadar", content, allowed_mentions: { parse: [] } };
  if (flags) message.flags = flags;
  try {
    const res = await fetchWithTimeout(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
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

// Free plan: 50 subrequests per run. Cloudflare counts every fetch (each
// redirect step too) AND every KV read/write and D1 call. Sample runs only
// fetch extra sample URLs into the room left after everything else.
const SUBREQUEST_LIMIT = 50;
const KV_RESERVE = 4;        // read state, read samples key, write samples, write state
const D1_RESERVE = 3;        // count cleanup, alert/social events (v1.17.0), margin
const DISCORD_RESERVE = 6;   // alerts + health messages in one run
const REDIRECT_RESERVE = 4;  // redirects count as extra subrequests
const FIXED_RESERVE = KV_RESERVE + D1_RESERVE + DISCORD_RESERVE + REDIRECT_RESERVE;

async function collectSamples(feeds, probes) {
  // Official feeds were already downloaded this run: reuse those copies.
  const out = [];
  SERVICES.forEach((s, i) => {
    if (s.feed) out.push({ service: s.id, url: s.feed, ...(feeds[i] && feeds[i].raw ? feeds[i].raw : { http_status: 0, bytes: 0, body: "" }) });
  });
  // v1.18.0: shared feeds and checks are one request each.
  const used = new Set(SERVICES.filter((s) => s.feed).map((s) => s.feed)).size +
    new Set(SERVICES.map(probeKey)).size + FIXED_RESERVE;
  const room = Math.max(0, SUBREQUEST_LIMIT - used);
  const extra = [];
  for (const s of SERVICES) for (const u of s.samples || []) extra.push({ service: s.id, url: u });
  const fetched = await Promise.all(extra.map(async (item, n) => {
    if (n >= room) return { ...item, http_status: 0, skipped: "request budget", bytes: 0, body: "" };
    try {
      const res = await fetchWithTimeout(item.url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json, text/html;q=0.8" },
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
  if (extra.length > room) console.warn("samples: " + (extra.length - room) + " skipped to stay within the request budget");
  const probeSamples = SERVICES.map((s, i) => ({
    service: s.id,
    url: s.probe,
    http_status: probes[i].code,
    result: probes[i].result,
    reason: probes[i].reason,
    latency_ms: Number.isFinite(probes[i].ms) ? Math.round(probes[i].ms) : null,
    headers: probes[i].headers,
    first_chars: probes[i].peek,
  }));
  return { saved_at_utc: iso(Date.now()), version: VERSION, feeds: out.concat(fetched), probes: probeSamples };
}

// ---------- latency summary (v1.8.0) ----------
//
// Per service and UTC day: number of answered checks, total, fastest, slowest
// and a spread across LATENCY_BUCKETS (under 250 ms, 500, 1000, 2000, 5000,
// and slower). Kept 30 days inside state:v1 (no extra writes) so a normal
// range can be measured before anything is ever labelled "slow".

const LATENCY_BUCKETS = [250, 500, 1000, 2000, 5000];
const LATENCY_KEEP_DAYS = 30;

function validLatencyDay(x) {
  return x && typeof x === "object" && typeof x.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.day) &&
    [x.n, x.sum, x.min, x.max].every((v) => typeof v === "number" && Number.isFinite(v)) &&
    Array.isArray(x.b) && x.b.length === LATENCY_BUCKETS.length + 1 && x.b.every((v) => typeof v === "number");
}

function cleanLatency(state) {
  const raw = state.latency && typeof state.latency === "object" ? state.latency : {};
  const out = {};
  for (const s of SERVICES) out[s.id] = Array.isArray(raw[s.id]) ? raw[s.id].filter(validLatencyDay) : [];
  return out;
}

function addLatency(list, ms, now) {
  if (!Number.isFinite(ms)) return list;
  const day = new Date(now).toISOString().slice(0, 10);
  let today = list.length && list[list.length - 1].day === day ? list[list.length - 1] : null;
  if (!today) {
    today = { day, n: 0, sum: 0, min: ms, max: ms, b: new Array(LATENCY_BUCKETS.length + 1).fill(0) };
    list.push(today);
  }
  today.n += 1;
  today.sum += ms;
  today.min = Math.min(today.min, ms);
  today.max = Math.max(today.max, ms);
  let i = LATENCY_BUCKETS.findIndex((limit) => ms < limit);
  if (i === -1) i = LATENCY_BUCKETS.length;
  today.b[i] += 1;
  return list.slice(-LATENCY_KEEP_DAYS);
}

// ---------- uptime (v1.21.0) ----------
//
// From data already kept in state:v1 (no extra requests or writes):
// - official: share of time with no official incident (degraded or worse);
// - check: share of our checks that got a real answer, from per-day counts of
//   answered ("ok") and failed checks. Blocked and odd replies say nothing
//   about the provider, so they are not counted. Counting began in v1.21.0.
// Never overstated: windows under a day show nothing, figures round down, a
// full incident log starts the window at its oldest kept incident.
const UPTIME_WINDOW_MS = 30 * 24 * 60 * MIN;
const UPTIME_MIN_WINDOW_MS = 24 * 60 * MIN;
const UPTIME_MIN_CHECKS = 288; // one day of 5-minute checks
const CHECKS_KEEP_DAYS = 31;

function validCheckDay(x) {
  return x && typeof x === "object" && typeof x.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.day) &&
    Number.isInteger(x.ok) && x.ok >= 0 && Number.isInteger(x.fail) && x.fail >= 0;
}
function cleanChecks(state) {
  const raw = state && state.checks && typeof state.checks === "object" ? state.checks : {};
  const out = {};
  for (const s of SERVICES) out[s.id] = Array.isArray(raw[s.id]) ? raw[s.id].filter(validCheckDay).slice(-CHECKS_KEEP_DAYS) : [];
  return out;
}
function addCheck(list, result, now) {
  if (result !== "ok" && result !== "fail") return list;
  const day = new Date(now).toISOString().slice(0, 10);
  let today = list.length && list[list.length - 1].day === day ? list[list.length - 1] : null;
  if (!today) {
    today = { day, ok: 0, fail: 0 };
    list.push(today);
  }
  if (result === "ok") today.ok += 1;
  else today.fail += 1;
  return list.slice(-CHECKS_KEEP_DAYS);
}
// One decimal, rounded down (the small margin absorbs float error).
function floorPct(x) {
  return Math.floor(x * 10 + 1e-6) / 10;
}
function officialUptime(service, list, sinceMs, now) {
  if (!service.feed || typeof sinceMs !== "number") return null;
  let start = Math.max(sinceMs, now - UPTIME_WINDOW_MS, service.uptime_from || 0);
  if (list.length >= INCIDENT_KEEP) start = Math.max(start, list[0].start_ms);
  if (now - start < UPTIME_MIN_WINDOW_MS) return null;
  const spans = list
    .filter((x) => x.kind === "official")
    .map((x) => [Math.max(x.start_ms, start), Math.min(x.end_ms === null ? now : x.end_ms, now)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let down = 0;
  let from = null;
  let to = null;
  for (const [a, b] of spans) {
    if (to === null || a > to) {
      if (to !== null) down += to - from;
      from = a;
      to = b;
    } else if (b > to) {
      to = b;
    }
  }
  if (to !== null) down += to - from;
  return { pct: down <= 0 ? 100 : floorPct(100 * (1 - down / (now - start))), since_utc: iso(start) };
}
function checkUptime(list, now) {
  const cutoff = new Date(now - UPTIME_WINDOW_MS).toISOString().slice(0, 10);
  const days = list.filter((d) => d.day >= cutoff);
  let ok = 0;
  let fail = 0;
  for (const d of days) { ok += d.ok; fail += d.fail; }
  const total = ok + fail;
  if (total < UPTIME_MIN_CHECKS) return null;
  return { pct: fail === 0 ? 100 : floorPct((100 * ok) / total), checks: total, since_utc: days[0].day + "T00:00:00Z" };
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
    const checks = cleanChecks(state);
    for (const s of SERVICES) {
      if (!isListed(s) || typeof log.since[s.id] !== "number") continue;
      services.push({
        id: s.id,
        name: s.name,
        status_page: s.status_page,
        since_utc: iso(log.since[s.id]),
        incidents: log.incidents[s.id].slice().reverse().map((x) => publicIncident(x, now)),
        // v1.21.0
        uptime: {
          official: officialUptime(s, log.incidents[s.id], log.since[s.id], now),
          check: checkUptime(checks[s.id], now),
        },
      });
    }
  }
  return { schema: 1, served_at_utc: iso(now), services };
}

// ---------- Self-serve alerts (v1.15.0, Phase 1 pilot) ----------
//
// Visitors give a Discord or Slack webhook and pick services. We post ONE
// confirmation message there; nothing else is sent until a person presses
// Confirm on our page, which POSTs here. Link-preview bots open links with
// GET, so a GET never confirms or unsubscribes. Every alert carries an
// unsubscribe link (also a page with a button).
// Secrets: ALERTS_ENC_KEY (base64 of 32 random bytes, AES-GCM key for the
// stored webhooks) and ALERTS_SIGN_KEY (32+ characters, HMAC key for links
// and the duplicate-lookup hash). Without both, the feature is off.
// The 5-minute run only records events (one D1 batch). The every-minute
// cron ("* * * * *") sends them, at most 40 messages a run, from a cursor.
// Stored per sign-up: encrypted webhook, platform, services, the degraded
// opt-in, confirmed flag, two timestamps. No IPs, emails or cookies.

const ALERT_SEND_CRON = "* * * * *";
const SUB_BATCH = 40;
const CONFIRM_CAP_PER_HOUR = 30;
const CONFIRM_REPEAT_MS = 24 * 60 * MIN;
const PENDING_TTL_MS = 24 * 60 * MIN;
const EVENT_MAX_AGE_MS = 6 * 60 * MIN;
const ALERT_BODY_MAX = 2048;
const HOOK_TIMEOUT_MS = 8000;

const SUBS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS alert_subs (id TEXT PRIMARY KEY, hook_hash TEXT NOT NULL UNIQUE, hook_enc TEXT NOT NULL, platform TEXT NOT NULL, services TEXT NOT NULL, minor INTEGER NOT NULL DEFAULT 0, confirmed INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL, confirm_sent_ms INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS alert_subs_sent ON alert_subs (confirm_sent_ms)",
  "CREATE TABLE IF NOT EXISTS alert_events (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, state TEXT NOT NULL, created_ms INTEGER NOT NULL, cursor TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0)",
];

let subsSchemaFor = null; // the D1 binding the tables were last ensured on (per isolate)
async function ensureSubsSchema(db) {
  if (subsSchemaFor === db) return;
  await db.batch(SUBS_SCHEMA.map((sql) => db.prepare(sql)));
  subsSchemaFor = db;
}

const UTF8 = new TextEncoder();
function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let alertKeyCache = null;
async function alertKeys(env) {
  const enc = env && env.ALERTS_ENC_KEY;
  const sign = env && env.ALERTS_SIGN_KEY;
  if (typeof enc !== "string" || typeof sign !== "string" || sign.length < 32) return null;
  if (alertKeyCache && alertKeyCache.enc === enc && alertKeyCache.sign === sign) return alertKeyCache.keys;
  let raw;
  try { raw = unb64(enc.trim()); } catch (err) { raw = null; }
  if (!raw || raw.length !== 32) {
    console.warn("ALERTS_ENC_KEY must be base64 of 32 bytes; alerts are off");
    return null;
  }
  const keys = {
    aes: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
    hmac: await crypto.subtle.importKey("raw", UTF8.encode(sign), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  };
  alertKeyCache = { enc, sign, keys };
  return keys;
}

async function sealHook(keys, url) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh for every encryption
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keys.aes, UTF8.encode(url)));
  return b64(iv) + ":" + b64(ct);
}
async function openHook(keys, sealed) {
  try {
    const [iv, ct] = String(sealed).split(":");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, keys.aes, unb64(ct));
    return new TextDecoder().decode(pt);
  } catch (err) {
    return null;
  }
}
async function mac(keys, text) {
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", keys.hmac, UTF8.encode(text))));
}
async function linkToken(keys, purpose, id) {
  return id + "." + await mac(keys, purpose + ":" + id);
}
async function readToken(keys, purpose, token) {
  if (typeof token !== "string" || token.length > 200) return null;
  const m = token.match(/^([a-f0-9]{32})\.([A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const want = await mac(keys, purpose + ":" + m[1]);
  if (want.length !== m[2].length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0 ? m[1] : null;
}

// Real webhook addresses only (host and path shape). The confirmation
// message proves the webhook works, so lengths are not guessed.
const DISCORD_HOOK = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/(\d{1,25})\/([A-Za-z0-9_-]{1,200})$/;
const SLACK_HOOK = /^https:\/\/hooks\.slack\.com\/services\/([A-Z0-9]{1,40})\/([A-Z0-9]{1,40})\/([A-Za-z0-9]{1,100})$/;
function parseHook(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length > 300) return null;
  let m = text.match(DISCORD_HOOK);
  if (m) return { platform: "discord", url: "https://discord.com/api/webhooks/" + m[1] + "/" + m[2] };
  m = text.match(SLACK_HOOK);
  if (m) return { platform: "slack", url: text };
  return null;
}

const SLACK_GONE = ["no_service", "channel_not_found", "channel_is_archived"];
// Posts one message. Never throws, never logs the address.
// gone: the platform says the webhook no longer exists (delete it).
// later: rate limited or a server problem (try again next minute).
async function postHook(platform, url, text) {
  const body = platform === "discord"
    ? { content: text, flags: 4, allowed_mentions: { parse: [] } } // 4 = no link previews
    : { text, unfurl_links: false, unfurl_media: false };
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, HOOK_TIMEOUT_MS);
    const status = res.status;
    let reply = "";
    if (platform === "slack" && !res.ok) reply = (await res.text()).trim().slice(0, 60);
    else discardBody(res);
    const gone = platform === "discord"
      ? status === 401 || status === 403 || status === 404
      : SLACK_GONE.includes(reply) || status === 404 || status === 410;
    return { ok: res.ok, gone: !res.ok && gone, later: status === 429 || status >= 500 };
  } catch (err) {
    return { ok: false, gone: false, later: true };
  }
}

function bold(platform, text) {
  return platform === "discord" ? "**" + text + "**" : "*" + text + "*";
}

function alertLine(platform, ev, name) {
  const who = bold(platform, name);
  if (ev.kind === "end") return who.replace(name, name + ": recovered") + " (back to normal).";
  const label = Object.prototype.hasOwnProperty.call(LABELS, ev.state) ? LABELS[ev.state] : "Problem";
  if (ev.kind === "worse") return who.replace(name, name + ": now " + label) + ".";
  return who.replace(name, name + ": " + label) + (ev.severity === "minor" ? " (minor)." : ".");
}

async function alertText(keys, platform, ev, subId) {
  const service = SERVICES.find((s) => s.id === ev.service);
  const name = service ? service.name : ev.service;
  return "OutageRadar alert: " + alertLine(platform, ev, name) + "\n" +
    "Details: " + SITE_ORIGIN + "/status/" + ev.service + "/\n" +
    "Unsubscribe: " + SITE_ORIGIN + "/alerts/unsubscribe/#" + await linkToken(keys, "u", subId);
}

// Called by the 5-minute run with the events it saw (approved services only).
async function recordAlertEvents(env, events, now) {
  if (!events.length || !env || !env.DB) return;
  try {
    if (!(await alertKeys(env))) return;
    await ensureSubsSchema(env.DB);
    const writes = events.map((e) => env.DB.prepare(
      "INSERT INTO alert_events (service, kind, severity, state, created_ms) VALUES (?, ?, ?, ?, ?)",
    ).bind(e.service, e.kind, e.severity, e.state, now));
    // v1.17.0: confirmed major incidents also queue for Bluesky, same batch.
    const social = socialMode(env) ? events.filter(isSocialEvent) : [];
    if (social.length) {
      await ensureSocialSchema(env.DB);
      for (const e of social) writes.push(env.DB.prepare(
        "INSERT INTO social_events (service, kind, state, created_ms) VALUES (?, ?, ?, ?)",
      ).bind(e.service, e.kind, e.state, now));
    }
    await env.DB.batch(writes);
  } catch (err) {
    console.warn("alert events not recorded");
  }
}

// The every-minute run: housekeeping, then send in batches.
// Returns how many messages it sent (v1.17.0: the social run needs the room).
async function sendAlerts(env, now) {
  const keys = await alertKeys(env);
  if (!keys || !env.DB) return 0;
  const db = env.DB;
  await ensureSubsSchema(db);
  await db.batch([
    db.prepare("DELETE FROM alert_subs WHERE confirmed = 0 AND created_ms < ?").bind(now - PENDING_TTL_MS),
    db.prepare("UPDATE alert_events SET done = 1 WHERE done = 0 AND created_ms < ?").bind(now - EVENT_MAX_AGE_MS),
  ]);
  let sent = 0;
  while (sent < SUB_BATCH) {
    const ev = await db.prepare("SELECT id, service, kind, severity, state, cursor FROM alert_events WHERE done = 0 ORDER BY id LIMIT 1").first();
    if (!ev) return sent;
    const want = SUB_BATCH - sent;
    const minorOnly = ev.severity === "minor" ? " AND minor = 1" : "";
    const { results } = await db.prepare(
      "SELECT id, hook_enc, platform FROM alert_subs WHERE confirmed = 1 AND id > ? AND services LIKE ?" + minorOnly + " ORDER BY id LIMIT ?",
    ).bind(ev.cursor, "%," + ev.service + ",%", want).all();
    let cursor = ev.cursor;
    for (const sub of results) {
      const url = await openHook(keys, sub.hook_enc);
      if (!url) { cursor = sub.id; continue; } // unreadable row: skip it
      sent += 1;
      const r = await postHook(sub.platform, url, await alertText(keys, sub.platform, ev, sub.id));
      if (r.later) {
        // Rate limited or their server is down: stop here, retry this one next minute.
        await db.prepare("UPDATE alert_events SET cursor = ? WHERE id = ?").bind(cursor, ev.id).run();
        return sent;
      }
      if (r.gone) await db.prepare("DELETE FROM alert_subs WHERE id = ?").bind(sub.id).run();
      cursor = sub.id;
    }
    const finished = results.length < want;
    await db.prepare("UPDATE alert_events SET cursor = ?, done = ? WHERE id = ?").bind(cursor, finished ? 1 : 0, ev.id).run();
    if (!finished) return sent; // batch full; continue next minute
  }
  return sent;
}

// v1.16.0: counts for the private dashboard. Never webhooks or ids.
async function alertCounts(env) {
  if (!env || !env.DB || !(await alertKeys(env))) return { enabled: false };
  await ensureSubsSchema(env.DB);
  const row = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM alert_subs WHERE confirmed = 1) AS confirmed, " +
    "(SELECT COUNT(*) FROM alert_subs WHERE confirmed = 0) AS pending, " +
    "(SELECT COUNT(*) FROM alert_events WHERE done = 0) AS queued",
  ).first();
  return { enabled: true, confirmed: Number(row.confirmed) || 0, pending: Number(row.pending) || 0, queued: Number(row.queued) || 0 };
}

function alertCors(request) {
  const origin = request.headers.get("origin");
  const h = { vary: "Origin", "cache-control": "no-store" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-methods"] = "POST, OPTIONS";
    h["access-control-max-age"] = "86400";
  }
  return h;
}

async function readAlertBody(request) {
  const text = await request.text();
  if (text.length > ALERT_BODY_MAX) return { error: 413 };
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" ? { body } : { error: 400 };
  } catch (err) {
    return { error: 400 };
  }
}

async function handleAlerts(request, env, action) {
  const cors = alertCors(request);
  const out = (obj, status = 200) => respond(JSON.stringify(obj), status, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "x-robots-tag": "noindex" } });
  if (request.method !== "POST") return out({ error: "method_not_allowed" }, 405);
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return out({ error: "forbidden" }, 403);
  const keys = await alertKeys(env);
  if (!keys || !env.DB) return out({ error: "alerts_unavailable" }, 503);
  const { body, error } = await readAlertBody(request);
  if (error) return out({ error: error === 413 ? "too_large" : "bad_request" }, error);
  const db = env.DB;
  await ensureSubsSchema(db);
  const now = Date.now();

  if (action === "confirm" || action === "unsubscribe") {
    const id = await readToken(keys, action === "confirm" ? "c" : "u", body.token);
    if (!id) return out({ error: "link_invalid" }, 400);
    if (action === "unsubscribe") {
      await db.prepare("DELETE FROM alert_subs WHERE id = ?").bind(id).run();
      return out({ ok: true }); // same answer whether or not it existed
    }
    const r = await db.prepare("UPDATE alert_subs SET confirmed = 1 WHERE id = ?").bind(id).run();
    return r.meta && r.meta.changes ? out({ ok: true }) : out({ error: "link_expired" }, 404);
  }

  // subscribe
  if (typeof body.company_name === "string" && body.company_name !== "") return out({ ok: true, status: "check_channel" }); // honeypot
  const hook = parseHook(body.webhook);
  if (!hook) return out({ error: "webhook_invalid" }, 400);
  const picked = Array.isArray(body.services) ? [...new Set(body.services)] : null;
  if (!picked || !picked.length || !picked.every((id) => typeof id === "string" && PUBLIC_IDS.has(id))) {
    return out({ error: "services_invalid" }, 400);
  }
  const services = "," + SERVICES.filter((s) => picked.includes(s.id)).map((s) => s.id).join(",") + ",";
  const minor = body.minor === true ? 1 : 0;
  const hash = await mac(keys, "hook:" + hook.url);
  const existing = await db.prepare("SELECT id, confirmed, confirm_sent_ms FROM alert_subs WHERE hook_hash = ?").bind(hash).first();
  if (existing && (existing.confirmed || now - existing.confirm_sent_ms < CONFIRM_REPEAT_MS)) {
    // Already confirmed, or a confirmation went out in the last 24 hours: update choices, send nothing.
    // v1.16.0: say which, so the page can explain that no new message was sent.
    await db.prepare("UPDATE alert_subs SET services = ?, minor = ? WHERE id = ?").bind(services, minor, existing.id).run();
    return out({ ok: true, status: existing.confirmed ? "updated" : "pending" });
  }
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM alert_subs WHERE confirm_sent_ms > ?").bind(now - 60 * MIN).first();
  if (recent && recent.n >= CONFIRM_CAP_PER_HOUR) return out({ error: "busy" }, 429);
  const id = existing ? existing.id : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sealed = await sealHook(keys, hook.url);
  if (existing) {
    await db.prepare("UPDATE alert_subs SET hook_enc = ?, services = ?, minor = ?, confirm_sent_ms = ? WHERE id = ?")
      .bind(sealed, services, minor, now, id).run();
  } else {
    try {
      await db.prepare("INSERT INTO alert_subs (id, hook_hash, hook_enc, platform, services, minor, confirmed, created_ms, confirm_sent_ms) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
        .bind(id, hash, sealed, hook.platform, services, minor, now, now).run();
    } catch (err) {
      return out({ ok: true, status: "check_channel" }); // a parallel sign-up of the same webhook won
    }
  }
  const names = SERVICES.filter((s) => services.includes("," + s.id + ",")).map((s) => s.name).join(", ");
  const text = "Someone asked OutageRadar to post outage alerts in this channel for: " + names +
    (minor ? " (including degraded performance)" : "") + ".\n" +
    "To start them, open this page and press Confirm: " + SITE_ORIGIN + "/alerts/confirm/#" + await linkToken(keys, "c", id) + "\n" +
    "If this wasn't you, ignore this message; nothing else will be sent.";
  const r = await postHook(hook.platform, hook.url, text);
  if (!r.ok) {
    if (!existing) await db.prepare("DELETE FROM alert_subs WHERE id = ?").bind(id).run();
    return r.later ? out({ error: "try_later" }, 503) : out({ error: "webhook_rejected" }, 400);
  }
  return out({ ok: true, status: "check_channel" });
}

// ---------- RSS feeds (v1.14.0) ----------
//
// GET /feed.xml (all services) and /feed/<id>.xml (one service): RSS 2.0,
// built on request from the incident log, newest first. One item per
// incident, keyed by service and start time, and updated in place when it
// ends (owner's choice "A"). Only listed services with a log appear. Nothing
// about readers is stored. Readers may cache for 5 minutes (the data changes
// at most every 5 minutes); this keeps KV reads (free plan: 100,000 a day,
// per Cloudflare's docs) low.

const SITE_ORIGIN = "https://liveoutageradar.com";
const DATA_ORIGIN = "https://data.liveoutageradar.com";
const FEED_MAX_ITEMS = 50;
const FEED_CACHE = "public, max-age=300";

function xmlText(value) {
  return String(value)
    .replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function utcMinute(ms) {
  return iso(ms).slice(0, 16).replace("T", " ") + " UTC";
}

function lengthText(minutes) {
  if (minutes < 60) return minutes + " min";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h + " h" + (m ? " " + m + " min" : "");
}

function feedItem(service, x) {
  const label = Object.prototype.hasOwnProperty.call(LABELS, x.worst) ? LABELS[x.worst] : "Incident";
  const open = x.end_ms === null;
  const about = x.end_confirmed === false ? "about " : "";
  const length = open ? "" : about + lengthText(Math.max(0, Math.round((x.end_ms - x.start_ms) / MIN)));
  const title = service.name + ": " + label + (open ? " (ongoing)" : ", " + length + " (resolved)");
  const parts = ["Started " + utcMinute(x.start_ms) + "."];
  parts.push(open ? "Still ongoing." : "Ended " + utcMinute(x.end_ms) + " (" + length + ").");
  parts.push(x.kind === "official"
    ? "Confirmed by the provider's official status."
    : "Seen by our own check only; not confirmed by the provider.");
  if (x.end_confirmed === false) parts.push("End not confirmed: no clear signal for 2 hours.");
  parts.push("Times are when OutageRadar's checker saw the change, within 5 minutes.");
  const link = SITE_ORIGIN + "/status/" + service.id + "/";
  return "    <item>\n" +
    "      <title>" + xmlText(title) + "</title>\n" +
    "      <link>" + link + "</link>\n" +
    "      <guid isPermaLink=\"false\">outageradar:" + service.id + ":" + iso(x.start_ms) + "</guid>\n" +
    "      <pubDate>" + new Date(x.start_ms).toUTCString() + "</pubDate>\n" +
    "      <category>" + xmlText(service.name) + "</category>\n" +
    "      <description>" + xmlText(parts.join(" ")) + "</description>\n" +
    "    </item>\n";
}

function buildFeed(state, now, onlyId) {
  const log = state && typeof state === "object" ? cleanIncidentLog(state) : { incidents: {}, since: {} };
  const rows = [];
  for (const s of SERVICES) {
    if (!isListed(s) || (onlyId && s.id !== onlyId) || typeof log.since[s.id] !== "number") continue;
    for (const x of log.incidents[s.id]) rows.push({ s, x });
  }
  rows.sort((a, b) => b.x.start_ms - a.x.start_ms);
  const one = onlyId ? SERVICES.find((s) => s.id === onlyId) : null;
  const title = one ? "OutageRadar: " + one.name + " incidents" : "OutageRadar: AI service incidents";
  const link = one ? SITE_ORIGIN + "/status/" + one.id + "/" : SITE_ORIGIN + "/";
  const self = DATA_ORIGIN + (one ? "/feed/" + one.id + ".xml" : "/feed.xml");
  const about = (one ? one.name : "AI service") + " outages and problems seen by OutageRadar: the provider's official status plus our own API check, every 5 minutes.";
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    "  <channel>\n" +
    "    <title>" + xmlText(title) + "</title>\n" +
    "    <link>" + link + "</link>\n" +
    "    <description>" + xmlText(about) + "</description>\n" +
    '    <atom:link href="' + self + '" rel="self" type="application/rss+xml"/>\n' +
    "    <language>en</language>\n" +
    "    <lastBuildDate>" + new Date(now).toUTCString() + "</lastBuildDate>\n" +
    "    <ttl>5</ttl>\n" +
    rows.slice(0, FEED_MAX_ITEMS).map((r) => feedItem(r.s, r.x)).join("") +
    "  </channel>\n" +
    "</rss>\n";
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
  // v1.18.0: one download per feed address and one run per distinct check.
  const downloads = new Map();
  const download = (url) => onceBy(downloads, url, () => downloadFeed(url));
  const feeds = await Promise.all(SERVICES.map((s) => checkFeed(s, download)));
  const probeRuns = new Map();
  const probes = await Promise.all(SERVICES.map((s) =>
    onceBy(probeRuns, probeKey(s), () => checkProbe(s)).then((r) => ({ ...r, headers: { ...r.headers } }))));

  // One-time raw samples for mapping review.
  try {
    const existing = await kv.get(SAMPLES_KEY);
    if (existing === null) {
      const samples = await collectSamples(feeds, probes);
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
  const latency = cleanLatency(state);
  const checks = cleanChecks(state); // v1.21.0

  const alertEvents = []; // v1.15.0: for subscribers; saved after the loop
  for (let i = 0; i < SERVICES.length; i++) {
    const service = SERVICES[i];
    const feed = feeds[i];
    const probe = probes[i];
    const st = { ...freshServiceState(), ...(state.services[service.id] || {}) };
    // Hidden services never count as approved, even if listed in APPROVED_MAPPINGS.
    const isApproved = isListed(service) && approved.has(service.id);

    // Official signal.
    const official = isApproved && feed.ok ? feed.status : "unknown";
    let officialNote = "";
    if (!service.feed) officialNote = NO_FEED_NOTE;
    else if (!isApproved) officialNote = "Mapping not approved yet";
    else if (!feed.ok) officialNote = "Feed problem: " + feed.reason;
    else if (feed.reason) officialNote = feed.reason;

    // Feed health counters and alerts (health channel). Hidden services count
    // but never post (v1.11.0: GitHub Copilot is the first hidden one with a feed).
    if (feed.ok) {
      if (st.feed_alert_open && isListed(service)) {
        const sent = await postDiscord(env.DISCORD_HEALTH_WEBHOOK, EMOJI.tool + " **FEED OK** " +
          service.name + " official feed is working again. " + humanTime(now));
        if (sent) st.feed_alert_open = false;
      }
      st.feed_fails = 0;
    } else {
      st.feed_fails += 1;
      if (st.feed_fails >= FEED_FAILS_TO_ALERT && !st.feed_alert_open && isListed(service)) {
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
          alertEvents.push({ service: service.id, kind: "start", severity: "major", state: overall });
        }
      } else if (bad && st.alert_open && overall in SEVERITY && st.alert_state in SEVERITY &&
                 SEVERITY[overall] > SEVERITY[st.alert_state]) {
        if (await postDiscord(env.DISCORD_ALERTS_WEBHOOK, worseMessage(service, overall, probeStatus, now))) {
          st.alert_state = overall;
          st.last_alert_ms = now;
          alertEvents.push({ service: service.id, kind: "worse", severity: "major", state: overall });
        }
      } else if (GOOD_STATES.includes(overall) && st.alert_open) {
        if (await postDiscord(env.DISCORD_ALERTS_WEBHOOK, recoveredMessage(service, st.alert_opened_ms, now))) {
          st.alert_open = false;
          st.alert_state = null;
          st.alert_opened_ms = null;
          st.last_alert_ms = now;
          st.minor_open = false; // one "recovered" message covers both
          alertEvents.push({ service: service.id, kind: "end", severity: "major", state: overall });
        }
      }
      // Unknown while an alert is open: say nothing. We do not claim recovery we cannot see.

      // v1.15.0: degraded (minor) episodes, only for subscribers who opted in.
      const minorCooling = typeof st.last_minor_ms === "number" && now - st.last_minor_ms < ALERT_COOLDOWN_MS;
      if (overall === "degraded" && !st.alert_open && !st.minor_open && !minorCooling) {
        st.minor_open = true;
        st.last_minor_ms = now;
        alertEvents.push({ service: service.id, kind: "start", severity: "minor", state: overall });
      } else if (GOOD_STATES.includes(overall) && st.minor_open) {
        st.minor_open = false;
        st.last_minor_ms = now;
        alertEvents.push({ service: service.id, kind: "end", severity: "minor", state: overall });
      }
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

    if (probe.result === "ok") latency[service.id] = addLatency(latency[service.id], Math.round(probe.ms), now);
    checks[service.id] = addCheck(checks[service.id], probe.result, now);

    st.last_official = official;
    st.last_probe = probeStatus;
    st.feed_preview = feed.status;
    st.feed_reason = feed.reason;
    state.services[service.id] = st;

    if (isListed(service)) publicServices.push({
      id: service.id,
      name: service.name,
      status_page: service.status_page,
      overall,
      official: {
        label: "Official status",
        status: official,
        checked_at_utc: iso(feed.checkedAt),
        note: officialNote,
        // v1.20.0: rows that count the API only say so, and carry the app line.
        ...(service.app ? {
          scope: "api",
          app: { label: service.app.label, status: isApproved && feed.ok && feed.app ? feed.app : "unknown" },
        } : {}),
      },
      probe: {
        label: service.probe_label || SITE_LABEL,
        status: probeStatus,
        checked_at_utc: iso(probe.checkedAt),
        http_status: probe.code || null,
        latency_ms: probe.result === "ok" && Number.isFinite(probe.ms) ? Math.round(probe.ms) : null,
        note: probe.reason,
      },
      incidents,
    });
  }
  await recordAlertEvents(env, alertEvents, now);

  state.incidents = log.incidents;
  state.incident_since = log.since;
  state.latency = latency;
  state.checks = checks;

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
    // v1.13.0 (AG review): filter again at the last step, so saved data can
    // never carry an unlisted service out to the public.
    const services = Array.isArray(rest.services) ? rest.services.filter((x) => x && PUBLIC_IDS.has(x.id)) : [];
    return { ...rest, services, served_at_utc: iso(now), age_seconds: ageSeconds };
  }
  // Too old or missing: everything unknown, with the last real time if we have one.
  const note = pub ? "Data is stale" : "No data yet";
  return {
    schema: 1,
    generated_at_utc: pub ? pub.generated_at_utc : null,
    served_at_utc: iso(now),
    age_seconds: ageSeconds,
    stale: true,
    // v1.11.0: only public services (stale data had listed hidden ones).
    services: SERVICES.filter(isListed).map((s) => unknownService(s, note)),
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

// v1.17.0: the privacy page promises Bluesky post addresses and account IDs
// are kept at most 8 days. Hourly, from the 5-minute run, so the promise holds
// even when Bluesky is switched off (the social run then never happens).
async function pruneSocial(env, now) {
  if (!env || !env.DB || new Date(now).getUTCMinutes() >= 5) return;
  const cutoff = now - SOCIAL_KEEP_MS;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM social_seen WHERE created_ms < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM social_log WHERE created_ms < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM social_events WHERE created_ms < ?").bind(cutoff),
    ]);
  } catch (err) {
    if (!isMissingTable(err)) console.warn("social cleanup failed");
  }
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
    source_slices: sourceSlices(sources, totals.human),
    engines,
    links: rows(5).map((r) => ({ link: String(r.link), n: num(r.n) })),
    quota: {
      writes_today_est: writes,
      limit: D1_FREE_WRITES_PER_DAY,
      pct: Math.round((writes / D1_FREE_WRITES_PER_DAY) * 1000) / 10,
    },
  };
}

// v1.22.0: the traffic-source donut. The top SOURCE_SLICES sources (people
// only, as in the sources list), then one "rest" slice for everything else,
// sized from the range's total so the slices always add up to all visits
// (the sources list itself stops at 100 rows). pct has one decimal.
const SOURCE_SLICES = 5;
function sourceSlices(sources, total) {
  const ranked = sources.filter((s) => s.n > 0)
    .sort((a, b) => b.n - a.n || a.source.localeCompare(b.source));
  const top = ranked.slice(0, SOURCE_SLICES);
  const shown = top.reduce((t, s) => t + s.n, 0);
  const all = Math.max(total, shown);
  if (all <= 0) return [];
  const pct = (n) => Math.round((n / all) * 1000) / 10;
  const slices = top.map((s) => ({ source: s.source, n: s.n, pct: pct(s.n) }));
  if (all - shown > 0) slices.push({ source: "rest", n: all - shown, pct: pct(all - shown) });
  return slices;
}

// Returns null when the key is right, otherwise the error response to send.
async function adminAuthError(request, env) {
  const expected = env && typeof env.ADMIN_KEY === "string" ? env.ADMIN_KEY : "";
  if (expected.length < ADMIN_KEY_MIN_LENGTH) return adminJson({ error: "admin_key_missing" }, 503);
  const auth = request.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!given || !(await adminKeyMatches(given, expected))) return adminJson({ error: "wrong_key" }, 401);
  return null;
}

// v1.10.0: the latest raw samples as a file, for reviewing new services.
async function handleAdminSamples(request, env) {
  const denied = await adminAuthError(request, env);
  if (denied) return denied;
  let text = null;
  try {
    text = env.KV ? await env.KV.get(SAMPLES_KEY) : null;
  } catch (err) {
    console.warn("samples read failed");
    return adminJson({ error: "kv_error" }, 503);
  }
  if (!text) return adminJson({ error: "no_samples_yet" }, 404);
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="outageradar-samples-v' + VERSION + '.json"',
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handleAdminData(request, env, url) {
  const denied = await adminAuthError(request, env);
  if (denied) return denied;
  if (!env.DB) return adminJson({ error: "db_missing" }, 503);

  const asked = Number(url.searchParams.get("days"));
  const rangeDays = ADMIN_RANGES.includes(asked) ? asked : ADMIN_DEFAULT_RANGE;
  const now = Date.now();
  try {
    const results = await queryCounts(env.DB, dayString(now - (rangeDays - 1) * DAY_MS), dayString(now));
    const data = buildAdminData(results, rangeDays, now);
    try {
      data.alerts = await alertCounts(env);
    } catch (err) {
      data.alerts = { enabled: true, error: "db_error" };
    }
    return adminJson(data, 200);
  } catch (err) {
    console.warn("dashboard read failed");
    return adminJson({ error: "db_error" }, 503);
  }
}

const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

// v1.22.0: the home-screen app. The manifest and icon hold no data, so they
// need no key (the icon is the radar avatar, made by tools/admin_icon.py).
const ADMIN_MANIFEST = JSON.stringify({
  name: "OutageRadar traffic",
  short_name: "OR traffic",
  start_url: "/admin",
  scope: "/admin",
  display: "standalone",
  background_color: "#06110d",
  theme_color: "#06110d",
  icons: [{ src: "/admin/icon-180.png", sizes: "180x180", type: "image/png" }],
});
const ADMIN_ICON_180_B64 = "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";
let adminIconBytes = null;
function adminIcon() {
  if (!adminIconBytes) adminIconBytes = Uint8Array.from(atob(ADMIN_ICON_180_B64), (c) => c.charCodeAt(0));
  return new Response(adminIconBytes, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
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
<meta name="theme-color" content="#06110d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="OR traffic">
<link rel="manifest" href="/admin/manifest.webmanifest">
<link rel="apple-touch-icon" href="/admin/icon-180.png">
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
.check{display:flex;align-items:center;gap:.5rem;margin:.7rem 0 0;color:var(--text)}
.check input{width:1.15rem;height:1.15rem;margin:0;accent-color:var(--op)}
.donutwrap{display:flex;flex-wrap:wrap;align-items:center;gap:1rem 1.25rem;margin-bottom:.9rem}
#donut{flex:0 0 9.5rem;width:9.5rem}
#donut svg{display:block;width:100%;height:auto}
.dleg{list-style:none;margin:0;padding:0;flex:1 1 11rem;min-width:0;font-size:.9rem}
.dleg li{display:grid;grid-template-columns:.8rem minmax(0,1fr) auto;gap:.5rem;align-items:center;padding:.2rem 0}
.dleg .sw{margin:0}
.dleg .k{overflow-wrap:anywhere}
.dleg .v{font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
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
  <label class="check" for="remember"><input id="remember" type="checkbox" checked> Remember on this phone</label>
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
    <section class="card"><h2>Where visitors came from</h2><div class="donutwrap"><div id="donut"></div><ul class="dleg" id="donutLegend"></ul></div><ul class="list" id="sources"></ul></section>
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
    <h2>Outage alerts (Discord and Slack)</h2>
    <p class="empty" id="alerts"></p>
  </section>

  <section class="card">
    <h2>Free database allowance today</h2>
    <div class="meter" id="meter"><i></i></div>
    <p class="empty" id="quota"></p>
  </section>

  <footer>
    <p><button type="button" id="forget">Forget this phone</button><br>Locks the dashboard and removes the saved key from this device.</p>
    <p><button type="button" id="samplesBtn">Download checker samples</button> <span id="samplesMsg"></span><br>For reviewing new services: saves the latest raw feed and check samples as a file.</p>
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
  // v1.22.0: "Remember on this phone". The key is saved in this browser only
  // after it worked and only when the box is ticked; a wrong key wipes it.
  // Any storage error (private mode, blocked storage) just means no saving.
  var STORE = "outageradar_admin_key";
  var keep = false;
  function savedKey() {
    try { return window.localStorage.getItem(STORE) || ""; } catch (e) { return ""; }
  }
  function saveKey(k) {
    try { window.localStorage.setItem(STORE, k); } catch (e) { /* not saved */ }
  }
  function wipeKey() {
    try { window.localStorage.removeItem(STORE); } catch (e) { /* nothing saved */ }
  }
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

  // v1.22.0: the source donut. Five checked colors (validated for color
  // blindness on this background) plus gray for "Everything else". A source
  // keeps its color while the page is open, even when the range changes.
  var SLICE_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
  var REST_COLOR = "#5b7a69";
  var colorOf = {};
  function sliceLabel(s) { return s === "rest" ? "Everything else" : sourceLabel(s); }
  function assignColors(slices) {
    var used = {};
    var out = {};
    slices.forEach(function (sl) {
      var c = colorOf[sl.source];
      if (sl.source !== "rest" && c && !used[c]) { out[sl.source] = c; used[c] = true; }
    });
    slices.forEach(function (sl) {
      if (sl.source === "rest") { out.rest = REST_COLOR; return; }
      if (out[sl.source]) return;
      for (var i = 0; i < SLICE_COLORS.length; i += 1) {
        if (!used[SLICE_COLORS[i]]) { out[sl.source] = SLICE_COLORS[i]; used[SLICE_COLORS[i]] = true; break; }
      }
      colorOf[sl.source] = out[sl.source];
    });
    return out;
  }

  function donut(slices) {
    var NS = "http://www.w3.org/2000/svg";
    var box = $("donut");
    var leg = $("donutLegend");
    box.textContent = "";
    leg.textContent = "";
    if (!slices || !slices.length) {
      var none = document.createElement("li");
      none.className = "empty";
      none.textContent = "No visits yet.";
      leg.appendChild(none);
      return;
    }
    var colors = assignColors(slices);
    var total = 0;
    slices.forEach(function (sl) { total += sl.n; });
    var R = 40, C = 2 * Math.PI * R, GAP = slices.length > 1 ? 1.4 : 0;
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Where visitors came from: " + slices.map(function (sl) {
      return sliceLabel(sl.source) + " " + sl.pct + "%";
    }).join(", "));
    var start = 0;
    slices.forEach(function (sl) {
      var len = (sl.n / total) * C;
      var c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", 50); c.setAttribute("cy", 50); c.setAttribute("r", R);
      c.setAttribute("fill", "none");
      c.setAttribute("stroke", colors[sl.source]);
      c.setAttribute("stroke-width", 16);
      c.setAttribute("stroke-dasharray", Math.max(0.6, len - GAP) + " " + C);
      c.setAttribute("stroke-dashoffset", -start);
      c.setAttribute("transform", "rotate(-90 50 50)");
      c.setAttribute("data-source", sl.source);
      var tip = document.createElementNS(NS, "title");
      tip.textContent = sliceLabel(sl.source) + ": " + fmt(sl.n) + " (" + sl.pct + "%)";
      c.appendChild(tip);
      svg.appendChild(c);
      start += len;
    });
    var mid = document.createElementNS(NS, "text");
    mid.setAttribute("x", 50); mid.setAttribute("y", 51);
    mid.setAttribute("text-anchor", "middle"); mid.setAttribute("dominant-baseline", "middle");
    mid.setAttribute("fill", "#e8fff1"); mid.setAttribute("font-size", "15"); mid.setAttribute("font-weight", "600");
    mid.textContent = fmt(total);
    svg.appendChild(mid);
    var sub = document.createElementNS(NS, "text");
    sub.setAttribute("x", 50); sub.setAttribute("y", 64);
    sub.setAttribute("text-anchor", "middle");
    sub.setAttribute("fill", "#9cc9ad"); sub.setAttribute("font-size", "7.5");
    sub.textContent = "visits";
    svg.appendChild(sub);
    box.appendChild(svg);
    slices.forEach(function (sl) {
      var li = document.createElement("li");
      var sw = document.createElement("i");
      sw.className = "sw";
      sw.style.background = colors[sl.source];
      var k = document.createElement("span");
      k.className = "k";
      k.textContent = sliceLabel(sl.source);
      var v = document.createElement("span");
      v.className = "v";
      v.textContent = fmt(sl.n) + " \u00b7 " + sl.pct + "%";
      li.appendChild(sw);
      li.appendChild(k);
      li.appendChild(v);
      leg.appendChild(li);
    });
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
    donut(data.source_slices);
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
    var al = data.alerts || { enabled: false };
    $("alerts").textContent = !al.enabled ? "Alerts are off: the two alert secrets are not set."
      : al.error ? "Couldn't read the alert counts right now."
      : fmt(al.confirmed) + " confirmed sign-ups, " + fmt(al.pending) + " waiting for confirmation, " + fmt(al.queued) + " alerts waiting to be sent.";
    $("status").textContent = "Updated " + data.generated_at_utc.slice(11, 16) + " UTC. Refreshes every minute while open.";
    Array.prototype.forEach.call(document.querySelectorAll("[data-days]"), function (b) {
      b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-days")) === data.range_days));
    });
  }

  function lock(message) {
    key = "";
    keep = false;
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
        if (r.status === 401) { wipeKey(); return lock("That key is not right."); }
        if (r.body.error === "admin_key_missing") return lock("The ADMIN_KEY secret is not set on the Worker (it needs at least 24 characters).");
        if (r.body.error === "db_missing") { setError("dashErr", "No database is connected. Add the D1 binding named DB to the Worker."); return; }
        if (r.status !== 200) { setError("dashErr", "Could not load the numbers (HTTP " + r.status + "). Try Refresh."); return; }
        setError("dashErr", "");
        show($("login"), false);
        show($("dash"), true);
        if (keep) saveKey(key);
        render(r.body);
      })
      .catch(function () { setError("dashErr", "Network error. Try Refresh."); })
      .then(function () { busy = false; });
  }

  // Shows the dashboard at once (so a network error is visible there) and
  // loads it; a wrong key sends it back to the lock screen.
  function start(k, remember) {
    key = k;
    keep = remember;
    setError("loginErr", "");
    show($("login"), false);
    show($("dash"), true);
    load();
    if (!timer) timer = setInterval(function () { if (!document.hidden) load(); }, 60000);
  }
  $("login").addEventListener("submit", function (e) {
    e.preventDefault();
    var typed = $("key").value.trim();
    if (!$("remember").checked) wipeKey();
    start(typed, !!$("remember").checked);
  });
  $("forget").addEventListener("click", function () {
    wipeKey();
    $("key").value = "";
    lock("Key forgotten on this device.");
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-days]"), function (b) {
    b.addEventListener("click", function () { days = Number(b.getAttribute("data-days")); load(); });
  });
  $("refresh").addEventListener("click", load);
  $("samplesBtn").addEventListener("click", function () {
    if (!key) return;
    $("samplesMsg").textContent = "Downloading\u2026";
    fetch("/admin/samples", { headers: { authorization: "Bearer " + key }, cache: "no-store" })
      .then(function (res) {
        if (res.status === 404) throw new Error("No samples saved yet. They are saved on the first run after a new version is deployed.");
        if (!res.ok) throw new Error("Download failed (HTTP " + res.status + ").");
        var name = "outageradar-samples.json";
        var cd = res.headers.get("content-disposition") || "";
        var m = cd.match(/filename="([^"]+)"/);
        if (m) name = m[1];
        return res.blob().then(function (blob) { return { blob: blob, name: name }; });
      })
      .then(function (r) {
        var url = URL.createObjectURL(r.blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = r.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        $("samplesMsg").textContent = "Saved as " + r.name;
      })
      .catch(function (err) { $("samplesMsg").textContent = err.message; });
  });
  var lastSeries = null;
  window.addEventListener("resize", function () { if (lastSeries) chart(lastSeries); });
  var saved = savedKey();
  if (saved) {
    $("status").textContent = "Unlocking\u2026";
    start(saved, true);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
}

const ADMIN_APP_JS = "(" + adminApp.toString() + ")();\n";

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request);

  // v1.15.0: alert sign-up, confirm and unsubscribe (POST only; own CORS).
  const alertAction = url.pathname.match(/^\/alerts\/(subscribe|confirm|unsubscribe)$/);
  if (alertAction) return handleAlerts(request, env, alertAction[1]);

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
  if (url.pathname === "/admin/manifest.webmanifest") {
    return adminPage(ADMIN_MANIFEST, "application/manifest+json; charset=utf-8");
  }
  if (url.pathname === "/admin/icon-180.png") return adminIcon();
  if (url.pathname === "/admin/data") return handleAdminData(request, env, url);
  if (url.pathname === "/admin/samples") return handleAdminSamples(request, env);

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

  if (url.pathname === "/feed.xml" || url.pathname.startsWith("/feed/")) {
    let only = null;
    if (url.pathname !== "/feed.xml") {
      const m = url.pathname.match(/^\/feed\/([a-z0-9-]+)\.xml$/);
      if (!m || !PUBLIC_IDS.has(m[1])) return respond(JSON.stringify({ error: "not found" }), 404, cors);
      only = m[1];
    }
    let state = null;
    try {
      if (!env || !env.KV) throw new Error("no KV");
      state = await cachedState(env.KV);
    } catch (err) {
      console.warn("feed read failed");
      return respond("Feed temporarily unavailable.", 503, { "cache-control": "no-store" }, "text/plain; charset=utf-8");
    }
    return respond(buildFeed(state, Date.now(), only), 200, { "cache-control": FEED_CACHE }, "application/rss+xml; charset=utf-8");
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

// ---------- v1.17.0: Bluesky (incident posts and reply assist) ----------
// Settings (Cloudflare dashboard):
//   BSKY_MODE           plain text: "pilot" (Discord only) or "live". Anything
//                       else, or unset, is off.
//   BSKY_HANDLE         plain text, e.g. liveoutageradar.com
//   BSKY_APP_PASSWORD   secret: a Bluesky APP password (made in Bluesky's
//                       settings under App passwords), never the main password
//   DISCORD_SOCIAL_WEBHOOK  optional secret; defaults to the health channel
// Also needs DB and the two alert keys: the saved login is encrypted with
// ALERTS_ENC_KEY. Bluesky's guidance (docs.bsky.app, atproto.com, Nov 2026):
// reply only to people who tagged the account, log in once and refresh the
// session (logins: 30 per 5 minutes, 300 per day), self-label bots "bot".
// Runs from the every-minute cron, at most every 5 minutes, and only when the
// alert sender left room in the request budget. Discord gets one digest a run,
// without link preview cards (v1.17.1).
const BSKY_XRPC = "https://bsky.social/xrpc/";
const SOCIAL_EVERY_MS = 5 * MIN;
const SOCIAL_SLACK_MS = 20 * 1000;       // a cron tick can fire a little early
const SOCIAL_MAX_REQUESTS = 12;          // outside requests per run, hard cap
const SOCIAL_ALERT_ROOM = 30;            // alerts sent this minute; more = wait
const SOCIAL_REPLIES_PER_RUN = 3;
const SOCIAL_REPLIES_PER_HOUR = 20;
const SOCIAL_REPLIES_PER_PERSON_DAY = 3;
const SOCIAL_POSTS_PER_RUN = 2;
const SOCIAL_POSTS_PER_HOUR = 6;
const SOCIAL_EVENT_MAX_AGE_MS = 30 * MIN; // older news is dropped, not posted late
const SOCIAL_BOARD_MAX_AGE_MS = 15 * MIN; // never answer from older board data
const SOCIAL_LOGIN_WAIT_MS = 30 * MIN;
const SOCIAL_KEEP_MS = 8 * 24 * 60 * MIN;
const BSKY_TIMEOUT_MS = 8000;
const POST_MAX = 300;                    // app.bsky.feed.post text maxGraphemes
const DIGEST_MAX = 1900;                 // Discord allows 2000 characters
const SITE_HOST = "liveoutageradar.com";

const SOCIAL_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS social_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS social_seen (uri TEXT PRIMARY KEY, created_ms INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS social_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', created_ms INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS social_log_time ON social_log (kind, created_ms)",
  "CREATE TABLE IF NOT EXISTS social_events (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, created_ms INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)",
];
let socialSchemaFor = null;
async function ensureSocialSchema(db) {
  if (socialSchemaFor === db) return;
  await db.batch(SOCIAL_SCHEMA.map((sql) => db.prepare(sql)));
  socialSchemaFor = db;
}

// "pilot", "live" or null (off). Needs every setting; never guesses.
function socialMode(env) {
  if (!env || !env.DB) return null;
  const mode = typeof env.BSKY_MODE === "string" ? env.BSKY_MODE.trim().toLowerCase() : "";
  if (mode !== "pilot" && mode !== "live") return null;
  const filled = (v) => typeof v === "string" && v.trim() !== "";
  if (!filled(env.BSKY_HANDLE) || !filled(env.BSKY_APP_PASSWORD)) return null;
  if (!filled(env.ALERTS_ENC_KEY) || !filled(env.ALERTS_SIGN_KEY)) return null;
  return mode;
}

// Only confirmed major incidents: the start (not "signals disagree") and the end.
function isSocialEvent(e) {
  if (e.severity !== "major") return false;
  if (e.kind === "start") return e.state !== "signals_disagree";
  return e.kind === "end";
}

function hhmm(ms) {
  return iso(ms).slice(11, 16);
}

// Builds post text plus link facets. Facet offsets count UTF-8 bytes, as the
// lexicon requires (JavaScript string indexes are UTF-16, so never use them).
function buildPost(parts) {
  let text = "";
  const facets = [];
  for (const part of parts) {
    if (typeof part === "string") { text += part; continue; }
    const byteStart = UTF8.encode(text).length;
    text += part.show;
    facets.push({
      index: { byteStart, byteEnd: byteStart + UTF8.encode(part.show).length },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: part.uri }],
    });
  }
  return { text, facets };
}
function statusLink(id, tag) {
  return { show: SITE_HOST + "/status/" + id + "/", uri: SITE_ORIGIN + "/status/" + id + "/?utm_source=" + tag };
}
const PROBE_WORDS = { reachable: "answering", unreachable: "not answering" };
function serviceFacts(svc) {
  const def = SERVICES.find((s) => s.id === svc.id);
  const official = def && !def.feed ? "no official feed"
    : (svc.official && Object.prototype.hasOwnProperty.call(LABELS, svc.official.status) ? LABELS[svc.official.status] : "Unknown");
  const probe = svc.probe && Object.prototype.hasOwnProperty.call(PROBE_WORDS, svc.probe.status) ? PROBE_WORDS[svc.probe.status] : "unknown";
  // v1.20.0: rows that count the API only say so, and mention the app when
  // its official status shows a problem (never when it is fine or unknown).
  const api = svc.official && svc.official.scope === "api";
  const app = api && svc.official.app;
  const appBad = app && typeof app.label === "string" && Object.prototype.hasOwnProperty.call(LABELS, app.status) &&
    app.status !== "operational" && app.status !== "unknown";
  return "Official " + (api ? "API " : "") + "status: " + official + "; our API check: " + probe + "." +
    (appBad ? " " + app.label + ": " + LABELS[app.status] + "." : "");
}
function overallLabel(state) {
  return Object.prototype.hasOwnProperty.call(LABELS, state) ? LABELS[state] : "Unknown";
}
function replyPost(list, boardAt) {
  for (let n = Math.min(list.length, 2); n >= 1; n--) {
    const parts = [];
    list.slice(0, n).forEach((svc, i) => parts.push((i ? " " : "") + svc.name + ": " + overallLabel(svc.overall) + ". " + serviceFacts(svc)));
    parts.push(" As of " + hhmm(boardAt) + " UTC. Live: ");
    list.slice(0, n).forEach((svc, i) => { if (i) parts.push(" "); parts.push(statusLink(svc.id, "bsky_reply")); });
    parts.push(" (automated)");
    const post = buildPost(parts);
    if (post.text.length <= POST_MAX) return post;
  }
  return null;
}
function startPost(svc, ev) {
  return buildPost([svc.name + ": " + overallLabel(ev.state) + " since " + hhmm(ev.created_ms) + " UTC. " + serviceFacts(svc) + " Live: ",
    statusLink(svc.id, "bsky_post"), " (automated)"]);
}
function endPost(svc, ev, startMs) {
  return buildPost([svc.name + ": back to normal at " + hhmm(ev.created_ms) + " UTC (problem started " + hhmm(startMs) + " UTC). Live: ",
    statusLink(svc.id, "bsky_post"), " (automated)"]);
}

// Words people use for each service. Matched as whole words, lowercase.
const SOCIAL_ALIASES = {
  openai: ["openai", "open ai", "chatgpt", "gpt"],
  claude: ["claude", "anthropic"],
  gemini: ["gemini"],
  xai: ["grok", "xai", "x.ai"],
  mistral: ["mistral"],
  perplexity: ["perplexity"],
  deepseek: ["deepseek", "deep seek"],
  cohere: ["cohere"],
  groq: ["groq"],
  huggingface: ["hugging face", "huggingface"],
  together: ["together ai", "together.ai", "togetherai"],
  fireworks: ["fireworks"],
  openrouter: ["openrouter", "open router"],
  "github-copilot": ["copilot"],
  deepinfra: ["deepinfra", "deep infra"],
  // v1.19.0
  cursor: ["cursor"],
  "claude-code": ["claude code", "claude-code", "claudecode"],
  codex: ["openai codex", "codex"],
  elevenlabs: ["elevenlabs", "eleven labs", "11labs", "11 labs"],
  runway: ["runway", "runwayml", "runway ml"],
};
const SOCIAL_INTENT = /(^|[^a-z0-9])(down|up|status|outages?|working|works?|broken|issues?|problems?|errors?|slow|offline|online|dead|ok|okay|overloaded|5\d\d|429)(?=$|[^a-z0-9])/;
function aliasAt(text, alias) {
  const re = new RegExp("(^|[^a-z0-9])" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[^a-z0-9])");
  const m = re.exec(text);
  return m ? m.index + m[1].length : -1;
}
// Board services named in the text, in the order they appear.
function servicesNamed(text, boardServices) {
  const t = String(text).toLowerCase();
  const hits = [];
  for (const svc of boardServices) {
    const aliases = SOCIAL_ALIASES[svc.id] || [String(svc.name || "").toLowerCase()];
    let at = -1;
    let len = 0;
    for (const a of aliases) {
      const i = a ? aliasAt(t, a) : -1;
      if (i >= 0 && (at < 0 || i < at || (i === at && a.length > len))) { at = i; len = a.length; }
    }
    if (at >= 0) hits.push({ at, len, svc });
  }
  // v1.19.0: a longer name wins over a shorter one starting at the same word,
  // so "claude code" is Claude Code only and "openai codex" is Codex only.
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.at === h.at && o.len > h.len));
  return kept.sort((a, b) => a.at - b.at).map((h) => h.svc);
}

// Lane B: common questions, with a suggested answer for a human to send.
const SOCIAL_FAQ = [
  { re: /(^|[^a-z])(alerts?|notify|notifications?|webhooks?|discord|slack)(?=$|[^a-z])/, reply: "Free Discord or Slack alerts: liveoutageradar.com/alerts/ - pick the services, confirm from the message we post in your channel, and every alert has an unsubscribe link." },
  { re: /(^|[^a-z])(free|cost|costs|price|pricing|paid|pay)(?=$|[^a-z])/, reply: "Yes, it's free: the board, the history pages, RSS feeds and alerts. liveoutageradar.com" },
  { re: /(^|[^a-z])(add|track|monitor|support|cover)(?=$|[^a-z])/, reply: "Thanks! Which service? We add services when we can check them reliably for free. Current list: liveoutageradar.com" },
  { re: /(^|[^a-z])(how|works?|checks?|measure)(?=$|[^a-z])/, reply: "Every 5 minutes we read each service's official status feed and check that its API server answers. Both are shown side by side: liveoutageradar.com" },
];
function faqFor(text) {
  const t = String(text).toLowerCase();
  const hit = SOCIAL_FAQ.find((f) => f.re.test(t));
  return hit ? hit.reply : null;
}

// People's words, made safe for one Discord line (pings are off anyway).
function quoteText(text) {
  const t = String(text).replace(/[\u0000-\u001f\u007f`]+/g, " ").replace(/\s+/g, " ").trim();
  return "\"" + (t.length > 140 ? t.slice(0, 137) + "..." : t) + "\"";
}
function who(author) {
  const h = typeof author.handle === "string" && /^[a-z0-9.-]{1,100}$/i.test(author.handle) ? author.handle : author.did;
  return "@" + h;
}
function postLink(n) {
  return "https://bsky.app/profile/" + n.author.did + "/post/" + n.uri.split("/").pop();
}
function validNote(n) {
  return n && typeof n.uri === "string" && n.uri.startsWith("at://") && typeof n.cid === "string" &&
    n.author && typeof n.author.did === "string" && typeof n.reason === "string" &&
    n.record && typeof n.record.text === "string";
}
function isBotAuthor(author) {
  return Array.isArray(author.labels) && author.labels.some((l) => l && l.val === "bot");
}

async function socialSet(db, k, v) {
  await db.prepare("INSERT INTO social_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, String(v)).run();
}
async function socialDel(db, k) {
  await db.prepare("DELETE FROM social_state WHERE k = ?").bind(k).run();
}

// One Bluesky request. Never throws, never logs tokens or the password.
async function bskyCall(run, method, name, opts = {}) {
  if (run.left <= 1) return { ok: false, status: 0, data: null, error: "budget" }; // one is kept for the digest
  run.left -= 1;
  const headers = { accept: "application/json", "user-agent": USER_AGENT };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.auth) headers.authorization = "Bearer " + opts.auth;
  const url = BSKY_XRPC + name + (opts.query ? "?" + opts.query.toString() : "");
  try {
    const res = await fetchWithTimeout(url, {
      method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }, BSKY_TIMEOUT_MS);
    let data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    return { ok: res.ok, status: res.status, data, error: data && typeof data.error === "string" ? data.error : "" };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: "network" };
  }
}
function isAuthError(r) {
  return r.status === 401 || (r.status === 400 && ["ExpiredToken", "InvalidToken", "AuthenticationRequired"].includes(r.error));
}
function goodSession(d) {
  return d && typeof d.accessJwt === "string" && typeof d.refreshJwt === "string" && typeof d.did === "string";
}
async function saveSession(run, d) {
  run.session = { a: d.accessJwt, r: d.refreshJwt, did: d.did };
  await socialSet(run.db, "session", await sealHook(run.keys, JSON.stringify(run.session)));
}
// At most one login per run, and none for 30 minutes after a failed one.
async function bskyLogin(run) {
  if (run.triedLogin) return null;
  run.triedLogin = true;
  if (run.now < (Number(run.state.login_wait_until) || 0)) return null;
  const r = await bskyCall(run, "POST", "com.atproto.server.createSession", {
    body: { identifier: run.env.BSKY_HANDLE.trim(), password: run.env.BSKY_APP_PASSWORD.trim() },
  });
  if (r.ok && goodSession(r.data)) {
    await saveSession(run, r.data);
    if (run.state.login_warned) { await socialDel(run.db, "login_warned"); delete run.state.login_warned; }
    return run.session;
  }
  if (r.error === "budget") return null;
  await socialSet(run.db, "login_wait_until", run.now + SOCIAL_LOGIN_WAIT_MS);
  if (!run.state.login_warned) {
    run.lines.push("Bluesky login failed (" + bskyWhy(r) + "). Trying again in 30 minutes. Check BSKY_HANDLE and BSKY_APP_PASSWORD.");
    await socialSet(run.db, "login_warned", "1");
    run.state.login_warned = "1";
  }
  return null;
}
async function bskySession(run) {
  if (run.session) return run.session;
  if (run.state.session && !run.droppedSession) {
    const text = await openHook(run.keys, run.state.session);
    try {
      const s = text ? JSON.parse(text) : null;
      if (s && typeof s.a === "string" && typeof s.r === "string" && typeof s.did === "string") run.session = s;
    } catch (err) {
      run.session = null;
    }
    if (run.session) return run.session;
  }
  return bskyLogin(run);
}
async function bskyRefresh(run) {
  if (!run.session || run.triedRefresh) return null;
  run.triedRefresh = true;
  const r = await bskyCall(run, "POST", "com.atproto.server.refreshSession", { auth: run.session.r });
  if (r.ok && goodSession(r.data)) {
    await saveSession(run, r.data);
    return run.session;
  }
  if (r.error === "budget") return null;
  run.session = null;
  run.droppedSession = true;
  await socialDel(run.db, "session");
  return bskyLogin(run);
}
// Signed-in request: on an auth error, refresh (or log in) once and retry once.
async function bskyAuthed(run, method, name, opts = {}) {
  let s = await bskySession(run);
  if (!s) return { ok: false, status: 0, data: null, error: "no session" };
  let r = await bskyCall(run, method, name, { ...opts, auth: s.a });
  if (!r.ok && isAuthError(r)) {
    s = await bskyRefresh(run);
    if (!s) return r;
    r = await bskyCall(run, method, name, { ...opts, auth: s.a });
  }
  return r;
}

// Live mode posts only after the profile carries the "bot" self-label.
async function ensureBotLabel(run) {
  if (run.state.labeled === "1") return true;
  const s = await bskySession(run);
  if (!s) return false;
  const q = new URLSearchParams({ repo: s.did, collection: "app.bsky.actor.profile", rkey: "self" });
  const got = await bskyAuthed(run, "GET", "com.atproto.repo.getRecord", { query: q });
  const rec = got.ok && got.data && got.data.value && typeof got.data.value === "object" ? got.data.value : null;
  let ok = false;
  if (rec) {
    const values = rec.labels && Array.isArray(rec.labels.values) ? rec.labels.values.filter((v) => v && typeof v.val === "string") : [];
    if (values.some((v) => v.val === "bot")) {
      ok = true;
    } else {
      const body = {
        repo: run.session.did, collection: "app.bsky.actor.profile", rkey: "self",
        record: { ...rec, labels: { $type: "com.atproto.label.defs#selfLabels", values: values.concat([{ val: "bot" }]).slice(-10) } },
      };
      if (typeof got.data.cid === "string") body.swapRecord = got.data.cid; // only replace the profile we read
      const put = await bskyAuthed(run, "POST", "com.atproto.repo.putRecord", { body });
      ok = put.ok;
      if (ok) run.lines.push("Bluesky profile now carries the \"bot\" self-label (Bluesky's guidance for automated accounts).");
    }
  }
  if (ok) {
    await socialSet(run.db, "labeled", "1");
    run.state.labeled = "1";
    return true;
  }
  if (!run.state.label_warned) {
    run.lines.push("Could not add the bot label to the Bluesky profile, so nothing is posted yet. Retrying next run.");
    await socialSet(run.db, "label_warned", "1");
    run.state.label_warned = "1";
  }
  return false;
}

async function socialBoard(env, now) {
  let state = null;
  try { state = await cachedState(env.KV); } catch (err) { state = null; }
  const pub = state && state.public;
  if (!pub || typeof pub.generated_at_ms !== "number" || !Array.isArray(pub.services) ||
      now - pub.generated_at_ms > SOCIAL_BOARD_MAX_AGE_MS || pub.generated_at_ms > now + MIN) {
    return { fresh: false, services: [], at: null };
  }
  return { fresh: true, services: pub.services, at: pub.generated_at_ms };
}

// v1.22.1: load the sign-in first, then name our account (repo). Before, the
// account was read before the sign-in was loaded, so a run's first post went
// out with a blank account and Bluesky refused it (HTTP 400).
async function createPost(run, record) {
  const s = await bskySession(run);
  if (!s) return { ok: false, status: 0, data: null, error: "no session" };
  return bskyAuthed(run, "POST", "com.atproto.repo.createRecord", {
    body: { repo: s.did, collection: "app.bsky.feed.post", record },
  });
}
// v1.22.1: "HTTP 400 InvalidRequest" in Discord, so a failure says why.
// Only Bluesky's short error name, never its message.
function bskyWhy(r) {
  if (!r.status) return "no answer";
  const name = /^[A-Za-z]{1,40}$/.test(r.error || "") ? " " + r.error : "";
  return "HTTP " + r.status + name;
}
function postRecord(post, now, reply) {
  const r = { $type: "app.bsky.feed.post", text: post.text, facets: post.facets, createdAt: iso(now), langs: ["en"] };
  if (reply) r.reply = reply;
  return r;
}

async function socialIncidents(run, board, canPost) {
  const db = run.db;
  await db.prepare("UPDATE social_events SET done = 1 WHERE done = 0 AND created_ms < ?").bind(run.now - SOCIAL_EVENT_MAX_AGE_MS).run();
  if (!board.fresh) return;
  const hour = await db.prepare("SELECT COUNT(*) AS n FROM social_log WHERE kind = 'post' AND created_ms > ?").bind(run.now - 60 * MIN).first("n");
  let made = 0;
  const { results } = await db.prepare("SELECT id, service, kind, state, created_ms FROM social_events WHERE done = 0 ORDER BY id LIMIT 20").all();
  for (const ev of results) {
    if (made >= SOCIAL_POSTS_PER_RUN || Number(hour) + made >= SOCIAL_POSTS_PER_HOUR || run.left <= 1) break;
    const done = () => db.prepare("UPDATE social_events SET done = 1 WHERE id = ?").bind(ev.id).run();
    const svc = board.services.find((s) => s.id === ev.service);
    const openKey = "open:" + ev.service;
    let post = null;
    if (svc && ev.kind === "start" && !GOOD_STATES.includes(svc.overall)) post = startPost(svc, ev);
    if (svc && ev.kind === "end" && run.state[openKey]) post = endPost(svc, ev, Number(run.state[openKey]));
    if (!post || post.text.length > POST_MAX) { await done(); continue; }
    if (canPost) {
      const r = await createPost(run, postRecord(post, run.now));
      if (!r.ok && (r.error === "budget" || r.error === "no session")) break; // try again next run
      if (!r.ok) {
        run.lines.push("Post failed (" + bskyWhy(r) + "): " + post.text);
        await done();
        continue;
      }
      run.lines.push("Posted: " + post.text);
    } else {
      run.lines.push("PILOT would post: " + post.text);
    }
    made += 1;
    await db.prepare("INSERT INTO social_log (kind, author, created_ms) VALUES ('post', '', ?)").bind(run.now).run();
    if (ev.kind === "start") { await socialSet(db, openKey, ev.created_ms); run.state[openKey] = String(ev.created_ms); }
    else { await socialDel(db, openKey); delete run.state[openKey]; }
    await done();
  }
}

async function socialMentions(run, board, canPost) {
  const db = run.db;
  const q = new URLSearchParams();
  for (const reason of ["mention", "reply", "quote"]) q.append("reasons", reason);
  q.set("limit", "50");
  const res = await bskyAuthed(run, "GET", "app.bsky.notification.listNotifications", { query: q });
  if (!res.ok || !res.data || !Array.isArray(res.data.notifications)) return;
  const list = res.data.notifications.filter(validNote).slice(0, 50).reverse(); // oldest first
  if (!list.length) return;
  const marks = list.map(() => "?").join(",");
  const seenRows = (await db.prepare("SELECT uri FROM social_seen WHERE uri IN (" + marks + ")").bind(...list.map((n) => n.uri)).all()).results || [];
  const seen = new Set(seenRows.map((r) => r.uri));
  let hour = Number(await db.prepare("SELECT COUNT(*) AS n FROM social_log WHERE kind = 'reply' AND created_ms > ?").bind(run.now - 60 * MIN).first("n")) || 0;
  const perPerson = new Map();
  const myDid = run.session ? run.session.did : "";
  let thisRun = 0;
  const newlySeen = [];
  const mark = (n) => newlySeen.push(n.uri);
  for (const n of list) {
    if (seen.has(n.uri)) continue;
    if (run.left <= 1) break;
    if (n.author.did === myDid || isBotAuthor(n.author)) { mark(n); continue; }
    const from = (n.reason === "quote" ? "Quote" : n.reason === "reply" ? "Reply" : "Mention") + " from " + who(n.author) + ": " + quoteText(n.record.text) + " " + postLink(n);
    if (n.reason === "quote") { run.lines.push(from); mark(n); continue; }
    const text = String(n.record.text).toLowerCase();
    const named = board.fresh ? servicesNamed(text, board.services) : servicesNamed(text, SERVICES.filter(isListed));
    if (named.length && SOCIAL_INTENT.test(text)) {
      if (!board.fresh) { run.lines.push("Not auto-answered (board data is old): " + from); mark(n); continue; }
      if (!perPerson.has(n.author.did)) {
        perPerson.set(n.author.did, Number(await db.prepare("SELECT COUNT(*) AS n FROM social_log WHERE kind = 'reply' AND author = ? AND created_ms > ?").bind(n.author.did, run.now - 24 * 60 * MIN).first("n")) || 0);
      }
      if (hour >= SOCIAL_REPLIES_PER_HOUR || perPerson.get(n.author.did) >= SOCIAL_REPLIES_PER_PERSON_DAY) {
        run.lines.push("Not auto-answered (reply limit): " + from);
        mark(n);
        continue;
      }
      if (thisRun >= SOCIAL_REPLIES_PER_RUN) continue; // left for the next run
      const post = replyPost(named, board.at);
      if (!post) { run.lines.push(from); mark(n); continue; }
      const parent = { uri: n.uri, cid: n.cid };
      const rr = n.record.reply;
      const root = rr && rr.root && typeof rr.root.uri === "string" && typeof rr.root.cid === "string" ? { uri: rr.root.uri, cid: rr.root.cid } : parent;
      if (canPost) {
        const r = await createPost(run, postRecord(post, run.now, { root, parent }));
        if (!r.ok && (r.error === "budget" || r.error === "no session")) break;
        if (!r.ok) { run.lines.push("Reply failed (" + bskyWhy(r) + "): " + from); mark(n); continue; }
        run.lines.push("Replied to " + who(n.author) + " (" + named.slice(0, 2).map((s) => s.name).join(", ") + "): " + postLink(n));
      } else {
        run.lines.push("PILOT would reply to " + who(n.author) + ": \"" + post.text + "\" " + postLink(n));
      }
      thisRun += 1;
      hour += 1;
      perPerson.set(n.author.did, perPerson.get(n.author.did) + 1);
      await db.prepare("INSERT INTO social_log (kind, author, created_ms) VALUES ('reply', ?, ?)").bind(n.author.did, run.now).run();
      mark(n);
      continue;
    }
    const faq = faqFor(text);
    if (faq) run.lines.push("Question from " + who(n.author) + ": " + quoteText(n.record.text) + " Suggested reply: " + faq + " " + postLink(n));
    else run.lines.push(from);
    mark(n);
  }
  if (newlySeen.length) {
    await db.batch(newlySeen.map((uri) => db.prepare("INSERT OR IGNORE INTO social_seen (uri, created_ms) VALUES (?, ?)").bind(uri, run.now)));
  }
}

async function sendSocialDigest(run) {
  if (!run.lines.length || run.digestSent) return;
  run.digestSent = true;
  const hook = run.env.DISCORD_SOCIAL_WEBHOOK || run.env.DISCORD_HEALTH_WEBHOOK;
  if (!hook) return;
  let body = "**BLUESKY** (" + run.mode + ")";
  let n = 0;
  for (const line of run.lines) {
    if (body.length + 1 + line.length > DIGEST_MAX) break;
    body += "\n" + line;
    n += 1;
  }
  if (n < run.lines.length) body += "\n...and " + (run.lines.length - n) + " more (see the Bluesky notifications)";
  await postDiscord(hook, body, 4); // v1.17.1: no preview cards for the post links
}

// The every-minute cron calls this after sending alerts.
async function runSocial(env, now, alertsSent) {
  const mode = socialMode(env);
  if (!mode || alertsSent > SOCIAL_ALERT_ROOM) return;
  const keys = await alertKeys(env);
  if (!keys) return;
  const db = env.DB;
  await ensureSocialSchema(db);
  const rows = (await db.prepare("SELECT k, v FROM social_state").all()).results || [];
  const state = {};
  for (const r of rows) state[r.k] = r.v;
  const last = Number(state.last_run_ms) || 0;
  if (last && now - last < SOCIAL_EVERY_MS - SOCIAL_SLACK_MS) return;
  await db.batch([
    db.prepare("INSERT INTO social_state (k, v) VALUES ('last_run_ms', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(String(now)),
    db.prepare("DELETE FROM social_seen WHERE created_ms < ?").bind(now - SOCIAL_KEEP_MS),
    db.prepare("DELETE FROM social_log WHERE created_ms < ?").bind(now - SOCIAL_KEEP_MS),
    db.prepare("DELETE FROM social_events WHERE done = 1 OR created_ms < ?").bind(now - SOCIAL_KEEP_MS),
  ]);
  const run = { env, db, keys, now, mode, state, left: SOCIAL_MAX_REQUESTS, lines: [], session: null };
  try {
    const board = await socialBoard(env, now);
    let canPost = false;
    if (mode === "live") {
      canPost = await ensureBotLabel(run);
      if (!canPost) return;
    }
    await socialIncidents(run, board, canPost);
    await socialMentions(run, board, canPost);
  } finally {
    await sendSocialDigest(run);
  }
}

export default {
  async scheduled(event, env, ctx) {
    // v1.15.0: the every-minute trigger only sends subscriber alerts.
    if (event && event.cron === ALERT_SEND_CRON) {
      let sent = SUB_BATCH; // if sending fails, assume the budget is used
      try {
        sent = await sendAlerts(env, Date.now());
      } catch (err) {
        console.error("alert sending failed: " + (err && err.name ? err.name : "error"));
      }
      // v1.17.0: Bluesky, every 5 minutes, in the room the alerts left.
      try {
        await runSocial(env, Date.now(), sent);
      } catch (err) {
        console.error("social run failed: " + (err && err.name ? err.name : "error"));
      }
      return;
    }
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
    try {
      await pruneSocial(env, Date.now());
    } catch (err) {
      console.warn("social cleanup failed");
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
