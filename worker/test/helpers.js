// Test helpers: in-memory KV, a fake fetch router, a clock, and log capture.
// Nothing here ships to Cloudflare.

export const URLS = {
  openai: {
    feed: "https://status.openai.com/api/v2/summary.json",
    probe: "https://chatgpt.com/",
  },
  mistral: {
    feed: "https://status.mistral.ai/api/v2/status.json",
    probe: "https://chat.mistral.ai/",
  },
  perplexity: {
    feed: "https://status.perplexity.com/v2/components.json",
    probe: "https://www.perplexity.ai/",
  },
  groq: {
    feed: "https://groqstatus.com/api/v2/components.json",
    probe: "https://console.groq.com/",
  },
};

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

// Default healthy world. Tests override single URLs via `routes`.
export function healthyRoutes() {
  return {
    [URLS.openai.feed]: () => json(statuspage("none")),
    [URLS.mistral.feed]: () => json(statuspage("none")),
    [URLS.perplexity.feed]: () =>
      json(components([{ name: "Website", status: "OPERATIONAL" }, { name: "API", status: "OPERATIONAL" }])),
    [URLS.groq.feed]: () =>
      json(components([{ name: "API", status: "operational" }, { name: "Website", status: "operational" }])),
    [URLS.openai.probe]: () => html("<html><title>ChatGPT</title></html>"),
    [URLS.mistral.probe]: () => html("<html><title>Le Chat</title></html>"),
    [URLS.perplexity.probe]: () => html("<html><title>Perplexity</title></html>"),
    [URLS.groq.probe]: () => html("<html><title>GroqCloud</title></html>"),
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
