// Test helpers: in-memory KV, a fake fetch router, a clock, and log capture.
// Nothing here ships to Cloudflare.

export const URLS = {
  openai: {
    feed: "https://status.openai.com/api/v2/status.json",
    probe: "https://api.openai.com/v1/models",
  },
  mistral: {
    feed: "https://status.mistral.ai/api/v2/status.json",
    probe: "https://api.mistral.ai/v1/models",
  },
  perplexity: {
    feed: "https://status.perplexity.com/api/v2/summary.json",
    probe: "https://api.perplexity.ai/chat/completions",
  },
  groq: {
    feed: "https://groqstatus.com/api/v2/components.json",
    probe: "https://api.groq.com/openai/v1/models",
    site: "https://console.groq.com/",
  },
  claude: {
    feed: "https://status.claude.com/api/v2/summary.json",
    probe: "https://api.anthropic.com/v1/models",
  },
  cohere: {
    feed: "https://status.cohere.com/api/v2/summary.json",
    probe: "https://api.cohere.com/v1/models",
  },
  huggingface: {
    feed: "https://status.huggingface.co/index.json",
    probe: "https://huggingface.co/api/whoami-v2",
  },
  xai: {
    feed: "https://data.x.ai/status/summary.json",
    probe: "https://api.x.ai/v1/models",
  },
  gemini: {
    feed: null,
    page: "https://aistudio.google.com/status",
    probe: "https://generativelanguage.googleapis.com/v1beta/models",
  },
  deepseek: {
    feed: null,
    page: "https://status.deepseek.com",
    probe: "https://api.deepseek.com/models",
  },
  // v1.11.0: listed from the v1.10.0 samples (Nov 9, 2026).
  together: {
    feed: "https://status.together.ai/index.json",
    probe: "https://api.together.xyz/v1/models",
  },
  fireworks: {
    feed: "https://status.fireworks.ai/api/v2/summary.json",
    probe: "https://api.fireworks.ai/inference/v1/models",
  },
  // v1.12.0: listed from the v1.11.0 samples (Nov 10, 2026).
  openrouter: {
    feed: null,
    page: "https://status.openrouter.ai",
    probe: "https://openrouter.ai/api/v1/key",
  },
  "github-copilot": {
    feed: "https://www.githubstatus.com/api/v2/summary.json",
    probe: "https://api.githubcopilot.com/models",
  },
};

export const ALL_IDS = Object.keys(URLS);

export const ALERTS_HOOK = "https://discord.com/api/webhooks/111/ALERTS-SECRET-abc";
export const HEALTH_HOOK = "https://discord.com/api/webhooks/222/HEALTH-SECRET-xyz";

export function memoryKV() {
  const store = new Map();
  return {
    store,
    writes: 0,
    async get(key, opts) {
      const v = store.has(key) ? store.get(key) : null;
      if (v === null) return null;
      const type = typeof opts === "string" ? opts : opts && opts.type;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      this.writes += 1;
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
  };
}

export function failingKV({ failGet = false, failPut = false } = {}) {
  const kv = memoryKV();
  const get = kv.get.bind(kv);
  const put = kv.put.bind(kv);
  kv.get = async (k, o) => { if (failGet) throw new Error("KV get failed"); return get(k, o); };
  kv.put = async (k, v) => { if (failPut) throw new Error("KV put failed"); return put(k, v); };
  return kv;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

export const statuspage = (indicator) => ({
  page: { id: "x", name: "X", updated_at: "2026-10-01T00:00:00Z" },
  status: { indicator, description: "desc" },
  components: [],
});

export const components = (list) => ({ components: list });

export const betterstack = (state) => ({
  data: { id: "1", type: "status_page", attributes: { company_name: "X", aggregate_state: state } },
  included: [],
});

export function xaiSummary(over = {}) {
  const base = { "Global (api.x.ai)": "available", "grok.com": "available", "cursor.com": "available" };
  const merged = { ...base, ...over };
  return {
    status: { indicator: "none", description: "All systems operational" },
    components: Object.entries(merged).map(([name, status]) => ({ id: name, name, status })),
    incidents: [],
  };
}

export function rss(items = []) {
  return new Response(
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Status</title>' +
      items.map((t) => "<item><title>" + t + "</title></item>").join("") +
      "</channel></rss>",
    { status: 200, headers: { "content-type": "application/rss+xml" } },
  );
}

// Default healthy world. Tests override single URLs via `routes`.
export function healthyRoutes() {
  const unauthorized = () => json({ error: { message: "missing api key" } }, 401);
  return {
    [URLS.openai.feed]: () => json(statuspage("none")),
    [URLS.mistral.feed]: () => json(statuspage("none")),
    [URLS.perplexity.feed]: () => json(statuspage("none")),
    [URLS.groq.feed]: () =>
      json(components([{ name: "API", status: "operational" }, { name: "Website", status: "operational" }])),
    [URLS.openai.probe]: unauthorized,
    [URLS.mistral.probe]: unauthorized,
    [URLS.perplexity.probe]: unauthorized,
    [URLS.groq.probe]: unauthorized,
    [URLS.groq.site]: () => html("<html><title>GroqCloud</title></html>"),
    [URLS.claude.feed]: () => json(statuspage("none")),
    [URLS.cohere.feed]: () => json(statuspage("none")),
    [URLS.huggingface.feed]: () => json(betterstack("operational")),
    [URLS.xai.feed]: () => json(xaiSummary()),
    [URLS.claude.probe]: unauthorized,
    [URLS.cohere.probe]: unauthorized,
    [URLS.huggingface.probe]: unauthorized,
    [URLS.xai.probe]: unauthorized,
    [URLS.gemini.probe]: () => json({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403),
    [URLS.deepseek.probe]: unauthorized,
    [URLS.together.feed]: () => json(betterstack("operational")),
    [URLS.together.probe]: () => new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } }),
    [URLS.fireworks.feed]: () => json(statuspage("none")),
    [URLS.fireworks.probe]: unauthorized,
    [URLS.openrouter.probe]: () => json({ error: { message: "No cookie auth credentials found", code: 401 } }, 401),
    [URLS["github-copilot"].feed]: () =>
      json({ status: { indicator: "none" }, components: [{ name: "Copilot", status: "operational" }, { name: "Copilot AI Model Providers", status: "operational" }] }),
    [URLS["github-copilot"].probe]: () => new Response("bad request: missing required Authorization header\n", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } }),
  };
}

// Installs a fake global fetch. Unknown URLs get a 404 JSON so sample
// candidates that a test does not care about still resolve.
export function installFetch(routes) {
  const calls = [];
  const discord = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    if (url.startsWith("https://discord.com/api/webhooks/")) {
      const body = JSON.parse(init.body);
      const handler = routes.__discord;
      if (handler) {
        const r = await handler(url, body);
        if (r && r.ok === false) return r;
        if (r instanceof Response) { if (r.ok) discord.push({ url, body }); return r; }
      }
      discord.push({ url, body });
      return new Response(null, { status: 204 });
    }
    const base = url.split("?")[0];
    const handler = routes[base];
    if (!handler) return json({ error: "not found in test" }, 404);
    return handler(url, init);
  };
  return { calls, discord, restore: () => { globalThis.fetch = original; } };
}

export function clock(startIso = "2026-11-04T12:00:00Z") {
  const original = Date.now;
  let t = Date.parse(startIso);
  Date.now = () => t;
  return {
    advance(minutes) { t += minutes * 60 * 1000; },
    set(iso) { t = Date.parse(iso); },
    get now() { return t; },
    restore() { Date.now = original; },
  };
}

export function captureLogs() {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => lines.push(args.map(String).join(" "));
  }
  return { lines, restore: () => Object.assign(console, orig) };
}

export function makeEnv(kv, extra = {}) {
  return {
    KV: kv,
    DISCORD_ALERTS_WEBHOOK: ALERTS_HOOK,
    DISCORD_HEALTH_WEBHOOK: HEALTH_HOOK,
    ...extra,
  };
}

export const ctx = { waitUntil() {}, passThroughOnException() {} };

export async function runOnce(worker, env) {
  await worker.scheduled({ scheduledTime: Date.now(), cron: "*/5 * * * *" }, env, ctx);
}

export async function getStatus(worker, env, origin = "https://liveoutageradar.com") {
  const req = new Request("https://data.liveoutageradar.com/status.json", {
    headers: origin ? { Origin: origin } : {},
  });
  const res = await worker.fetch(req, env, ctx);
  return { res, body: res.status === 200 ? await res.json() : null };
}

export function svc(body, id) {
  return body.services.find((s) => s.id === id);
}
