import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  URLS, ALL_IDS, ALERTS_HOOK, HEALTH_HOOK, memoryKV, failingKV, json, html, statuspage,
  components, betterstack, rss, xaiSummary, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx,
  runOnce, getStatus, svc,
} from "./helpers.js";

const ALL = ALL_IDS.join(",");
let clk, net, logs;

function setup(overrides = {}) {
  net = installFetch({ ...healthyRoutes(), ...overrides });
}

beforeEach(() => { clk = clock(); logs = captureLogs(); });
afterEach(() => { if (net) net.restore(); net = null; clk.restore(); logs.restore(); });

const alerts = () => net.discord.filter((d) => d.url === ALERTS_HOOK).map((d) => d.body.content);
const health = () => net.discord.filter((d) => d.url === HEALTH_HOOK).map((d) => d.body.content);

// ---------- Sample mode (the default) ----------

test("without approved mappings every service is published as unknown", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { res, body } = await getStatus(worker, env);
  assert.equal(res.status, 200);
  assert.equal(body.services.length, 10);
  for (const s of body.services) {
    assert.equal(s.overall, "unknown", s.id);
    assert.equal(s.official.status, "unknown", s.id);
  }
});

test("probe result is still shown in sample mode", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").probe.status, "reachable");
  assert.equal(svc(body, "openai").probe.label, "API server answering (our check)");
  assert.equal(svc(body, "groq").probe.status, "reachable");
  assert.equal(svc(body, "groq").probe.label, "Site reachable (HTTP 200)");
});

test("raw samples are saved once and announced once in the health channel", async () => {
  setup();
  const kv = memoryKV();
  const env = makeEnv(kv);
  await runOnce(worker, env);
  const key = [...kv.store.keys()].find((k) => k.startsWith("samples:"));
  assert.ok(key, "a samples key was saved");
  const saved = JSON.parse(kv.store.get(key));
  assert.ok(saved.feeds.length >= 4);
  assert.ok(saved.feeds.some((f) => f.url === URLS.openai.feed && f.body.includes("indicator")));
  assert.ok(saved.probes.some((p) => p.service === "groq"));
  assert.equal(health().filter((m) => m.includes("Samples saved")).length, 1);
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(health().filter((m) => m.includes("Samples saved")).length, 1);
});

test("no outage alerts are sent for services in sample mode", async () => {
  setup({ [URLS.openai.feed]: () => json(statuspage("critical")) });
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  assert.deepEqual(alerts(), []);
});

// ---------- Official feed mapping ----------

test("statuspage indicators map to our status words", async () => {
  const cases = { none: "operational", minor: "degraded", major: "partial_outage",
    critical: "major_outage", maintenance: "maintenance" };
  for (const [indicator, expected] of Object.entries(cases)) {
    if (net) net.restore();
    setup({ [URLS.openai.feed]: () => json(statuspage(indicator)) });
    const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
    await runOnce(worker, env);
    const { body } = await getStatus(worker, env);
    assert.equal(svc(body, "openai").official.status, expected, indicator);
  }
});

test("components feeds use the worst listed component", async () => {
  setup({
    [URLS.groq.feed]: () => json(components([
      { name: "API", status: "partial_outage" }, { name: "Website", status: "operational" }])),
  });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "groq").official.status, "partial_outage");
});

test("components feeds accept uppercase Instatus spellings", async () => {
  setup({
    [URLS.groq.feed]: () => json(components([
      { name: "API", status: "MAJOROUTAGE" }, { name: "Website", status: "OPERATIONAL" }])),
  });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "groq").official.status, "major_outage");
});

test("perplexity reads the page-wide indicator from its summary feed", async () => {
  setup({ [URLS.perplexity.feed]: () => json(statuspage("major")) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "perplexity").official.status, "partial_outage");
});

test("mistral is named for what its feed covers", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "mistral").name, "Mistral");
});

test("an API probe answering 401 counts as the server answering", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  for (const id of ["openai", "mistral", "perplexity"]) {
    assert.equal(svc(body, id).probe.status, "reachable", id);
    assert.equal(svc(body, id).probe.http_status, 401, id);
  }
});

test("perplexity API probe also accepts 405 for a GET on a POST endpoint", async () => {
  setup({ [URLS.perplexity.probe]: () => json({ error: "method not allowed" }, 405) });
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "perplexity").probe.status, "reachable");
});

test("an unexpected 4xx on an API probe is unknown, not answering", async () => {
  setup({ [URLS.openai.probe]: () => json({ error: "gone" }, 404) });
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").probe.status, "unknown");
});

test("a site probe does not treat 401 as reachable", async () => {
  setup({ [URLS.groq.probe]: () => html("login", 401) });
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "groq").probe.status, "unknown");
});

test("a challenge on an API probe is unknown even with an expected code", async () => {
  setup({ [URLS.openai.probe]: () => json({}, 401, { "cf-mitigated": "challenge" }) });
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").probe.status, "unknown");
});

test("alert wording names an API check correctly", async () => {
  setup({ [URLS.openai.feed]: () => json(statuspage("critical")) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  assert.match(alerts()[0], /API server answering/);
});

test("components outside the approved list are ignored", async () => {
  setup({
    [URLS.groq.feed]: () => json(components([
      { name: "API", status: "operational" }, { name: "Website", status: "operational" },
      { name: "some-preview-model", status: "major_outage" }])),
  });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "groq").official.status, "operational");
});

test("an HTML page served with HTTP 200 is a feed failure, not operational", async () => {
  setup({ [URLS.mistral.feed]: () => html("<html>Page not found</html>") });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "mistral").official.status, "unknown");
  assert.equal(svc(body, "mistral").overall, "unknown");
});

test("an unrecognised indicator is unknown, never operational", async () => {
  setup({ [URLS.openai.feed]: () => json(statuspage("something-new")) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").official.status, "unknown");
});

test("one feed throwing does not stop the other services updating", async () => {
  setup({ [URLS.openai.feed]: () => { throw new Error("boom"); } });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").official.status, "unknown");
  assert.equal(svc(body, "groq").official.status, "operational");
  assert.equal(svc(body, "groq").overall, "operational");
});

// ---------- Combining the two signals ----------

test("official outage shows immediately even when the site is reachable", async () => {
  setup({ [URLS.openai.feed]: () => json(statuspage("critical")) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").overall, "major_outage");
  assert.equal(svc(body, "openai").probe.status, "reachable");
});

test("a single probe failure is unknown; two in a row is unreachable", async () => {
  setup({ [URLS.groq.probe]: () => html("bad gateway", 502) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  let { body } = await getStatus(worker, env);
  assert.equal(svc(body, "groq").probe.status, "unknown");
  assert.equal(svc(body, "groq").overall, "operational");
  clk.advance(5);
  await runOnce(worker, env);
  ({ body } = await getStatus(worker, env));
  assert.equal(svc(body, "groq").probe.status, "unreachable");
  assert.equal(svc(body, "groq").overall, "signals_disagree");
});

test("probe 403 and 429 are unknown, never unreachable", async () => {
  for (const code of [403, 429]) {
    if (net) net.restore();
    setup({ [URLS.perplexity.probe]: () => html("blocked", code) });
    const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
    for (let i = 0; i < 4; i++) { await runOnce(worker, env); clk.advance(5); }
    const { body } = await getStatus(worker, env);
    assert.equal(svc(body, "perplexity").probe.status, "unknown", String(code));
    assert.equal(svc(body, "perplexity").overall, "operational", String(code));
  }
});

test("a Cloudflare challenge page with HTTP 200 is unknown, not reachable", async () => {
  setup({
    [URLS.openai.probe]: () => html("<html><title>Just a moment...</title></html>"),
    [URLS.mistral.probe]: () => html("<html>ok</html>", 200, { "cf-mitigated": "challenge" }),
  });
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").probe.status, "unknown");
  assert.equal(svc(body, "mistral").probe.status, "unknown");
});

test("official unknown plus site reachable is unknown overall", async () => {
  setup({ [URLS.openai.feed]: () => json({ nope: true }) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").probe.status, "reachable");
  assert.equal(svc(body, "openai").overall, "unknown");
});

// ---------- Outage alerts ----------

test("an outage alerts once at start and once on recovery", async () => {
  let indicator = "major";
  setup({ [URLS.openai.feed]: () => json(statuspage(indicator)) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /OUTAGE/);
  assert.match(alerts()[0], /OpenAI/);
  assert.match(alerts()[0], /UTC/);
  indicator = "none";
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1], /RECOVERED/);
});

test("degraded alone does not alert", async () => {
  setup({ [URLS.openai.feed]: () => json(statuspage("minor")) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  assert.deepEqual(alerts(), []);
});

test("escalating from partial to major outage sends an update", async () => {
  let indicator = "major";
  setup({ [URLS.openai.feed]: () => json(statuspage(indicator)) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  indicator = "critical";
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1], /WORSE/);
});

test("a new outage within 30 minutes of the last alert waits for the cooldown", async () => {
  let indicator = "major";
  setup({ [URLS.openai.feed]: () => json(statuspage(indicator)) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);            // start alert
  indicator = "none"; clk.advance(5);
  await runOnce(worker, env);            // recovery alert
  indicator = "major"; clk.advance(5);
  await runOnce(worker, env);            // suppressed: 5 min after last alert
  assert.equal(alerts().length, 2);
  clk.advance(30);
  await runOnce(worker, env);            // cooldown over, still down
  assert.equal(alerts().length, 3);
  assert.match(alerts()[2], /OUTAGE/);
});

test("no recovery message while the official status is unknown", async () => {
  let mode = "major";
  setup({ [URLS.openai.feed]: () => (mode === "major" ? json(statuspage("major")) : html("oops", 500)) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  mode = "broken"; clk.advance(5);
  await runOnce(worker, env);
  assert.equal(alerts().length, 1);
  assert.doesNotMatch(alerts().join("\n"), /RECOVERED/);
});

test("probe-only problem alerts as a signals check, not an outage", async () => {
  setup({ [URLS.groq.probe]: () => { throw new Error("connect timeout"); } });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env); clk.advance(5);
  await runOnce(worker, env);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /CHECK/);
  assert.match(alerts()[0], /Groq/);
  assert.doesNotMatch(alerts()[0], /OUTAGE/);
});

test("discord messages cannot ping anyone", async () => {
  setup({ [URLS.openai.feed]: () => json(statuspage("critical")) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  assert.ok(net.discord.length > 0);
  for (const d of net.discord) assert.deepEqual(d.body.allowed_mentions, { parse: [] });
});

test("a failed discord post is retried on the next run and never crashes the run", async () => {
  let discordUp = false;
  setup({
    [URLS.openai.feed]: () => json(statuspage("critical")),
    __discord: () => (discordUp ? new Response(null, { status: 204 }) : new Response("no", { status: 500 })),
  });
  const kv = memoryKV();
  const env = makeEnv(kv, { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  assert.equal(alerts().length, 0);
  assert.ok(kv.store.has("state:v1"));
  discordUp = true; clk.advance(5);
  await runOnce(worker, env);
  assert.equal(alerts().length, 1);
});

test("missing webhook secrets do not crash the run", async () => {
  setup({ [URLS.openai.feed]: () => json(statuspage("critical")) });
  const kv = memoryKV();
  await runOnce(worker, { KV: kv, APPROVED_MAPPINGS: ALL });
  assert.ok(kv.store.has("state:v1"));
});

// ---------- Feed health alerts ----------

test("a feed failing 3 runs in a row posts one feed problem, then one recovery", async () => {
  let broken = true;
  setup({ [URLS.mistral.feed]: () => (broken ? html("<html>nope</html>") : json(statuspage("none"))) });
  const env = makeEnv(memoryKV());
  for (let i = 0; i < 2; i++) { await runOnce(worker, env); clk.advance(5); }
  assert.equal(health().filter((m) => m.includes("FEED PROBLEM")).length, 0);
  await runOnce(worker, env); clk.advance(5);
  await runOnce(worker, env); clk.advance(5);
  const problems = health().filter((m) => m.includes("FEED PROBLEM"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Mistral/);
  broken = false;
  await runOnce(worker, env);
  assert.equal(health().filter((m) => m.includes("FEED OK")).length, 1);
});

// ---------- Storage ----------

test("each run writes the state key once", async () => {
  setup();
  const kv = memoryKV();
  const env = makeEnv(kv);
  await runOnce(worker, env);          // first run also saves samples
  const afterFirst = kv.writes;
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(kv.writes - afterFirst, 1);
});

test("a KV write failure does not throw and alerts health at the top of the hour", async () => {
  setup();
  clk.set("2026-11-04T13:02:00Z");
  const env = makeEnv(failingKV({ failPut: true }));
  await runOnce(worker, env);
  assert.ok(health().some((m) => m.includes("could not save")));
});

test("a KV write failure stays quiet outside the top of the hour", async () => {
  setup();
  clk.set("2026-11-04T13:22:00Z");
  const env = makeEnv(failingKV({ failPut: true }));
  await runOnce(worker, env);
  assert.equal(health().filter((m) => m.includes("could not save")).length, 0);
});

test("a KV read failure skips the run without overwriting state", async () => {
  setup();
  const kv = failingKV({ failGet: true });
  await runOnce(worker, makeEnv(kv));
  assert.equal(kv.store.has("state:v1"), false);
});

// ---------- Public endpoints ----------

test("status.json goes all-unknown and stale when data is older than 15 minutes", async () => {
  setup();
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  clk.advance(16);
  const { body } = await getStatus(worker, env);
  assert.equal(body.stale, true);
  for (const s of body.services) {
    assert.equal(s.overall, "unknown");
    assert.equal(s.official.status, "unknown");
    assert.equal(s.probe.status, "unknown");
  }
});

test("status.json before any run says unknown, not an error page", async () => {
  setup();
  const { res, body } = await getStatus(worker, makeEnv(memoryKV()));
  assert.equal(res.status, 200);
  assert.equal(body.stale, true);
  assert.ok(body.services.every((s) => s.overall === "unknown"));
});

test("status.json carries UTC times, labels and official links", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.match(body.generated_at_utc, /Z$/);
  const o = svc(body, "openai");
  assert.equal(o.status_page, "https://status.openai.com");
  assert.equal(o.official.label, "Official status");
  assert.match(o.probe.checked_at_utc, /Z$/);
});

test("health is ok right after a run and 503 when the last run is too old", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  let res = await worker.fetch(new Request("https://data.liveoutageradar.com/health"), env, ctx);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^ok/);
  clk.advance(16);
  res = await worker.fetch(new Request("https://data.liveoutageradar.com/health"), env, ctx);
  assert.equal(res.status, 503);
});

test("health is 503 before the first run", async () => {
  setup();
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/health"), makeEnv(memoryKV()), ctx);
  assert.equal(res.status, 503);
});

test("CORS allows only our own site", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  let { res } = await getStatus(worker, env, "https://liveoutageradar.com");
  assert.equal(res.headers.get("access-control-allow-origin"), "https://liveoutageradar.com");
  ({ res } = await getStatus(worker, env, "https://evil.example"));
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("CORS preflight answers 204", async () => {
  setup();
  const req = new Request("https://data.liveoutageradar.com/status.json", {
    method: "OPTIONS", headers: { Origin: "https://www.liveoutageradar.com" } });
  const res = await worker.fetch(req, makeEnv(memoryKV()), ctx);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://www.liveoutageradar.com");
});

test("unknown paths are 404 and data responses are noindex", async () => {
  setup();
  const env = makeEnv(memoryKV());
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/admin"), env, ctx);
  assert.equal(res.status, 404);
  const { res: s } = await getStatus(worker, env);
  assert.equal(s.headers.get("x-robots-tag"), "noindex");
});

test("webhook secrets never appear in public output, stored data or logs", async () => {
  setup({ [URLS.openai.feed]: () => json(statuspage("critical")),
    __discord: () => new Response("no", { status: 500 }) });
  const kv = memoryKV();
  const env = makeEnv(kv, { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/status.json"), env, ctx);
  const health = await worker.fetch(new Request("https://data.liveoutageradar.com/health"), env, ctx);
  const everything = [await res.text(), await health.text(), ...kv.store.values(), ...logs.lines].join("\n");
  assert.doesNotMatch(everything, /SECRET/);
  assert.doesNotMatch(everything, /discord\.com\/api\/webhooks/);
});


// ---------- v1.2: more services, versioned samples, test alert ----------

test("samples are saved under a versioned key even if an older sample exists", async () => {
  setup();
  const kv = memoryKV();
  kv.store.set("samples:v1", JSON.stringify({ version: "1.1.0" }));
  await runOnce(worker, makeEnv(kv));
  const keys = [...kv.store.keys()].filter((k) => k.startsWith("samples:") && k !== "samples:v1");
  assert.equal(keys.length, 1);
  const saved = JSON.parse(kv.store.get(keys[0]));
  assert.ok(saved.feeds.some((f) => f.service === "claude"));
  assert.ok(saved.probes.some((p) => p.service === "gemini"));
});

test("new services stay unknown until approved", async () => {
  setup();
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: "openai,mistral,perplexity,groq" });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  for (const id of ["claude", "cohere", "huggingface", "xai", "gemini", "deepseek"]) {
    assert.equal(svc(body, id).overall, "unknown", id);
  }
  assert.equal(svc(body, "openai").overall, "operational");
});

test("claude reads the statuspage indicator once approved", async () => {
  setup({ [URLS.claude.feed]: () => json(statuspage("critical")) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "claude").name, "Claude");
  assert.equal(svc(body, "claude").official.status, "major_outage");
});

test("hugging face reads the Better Stack aggregate state", async () => {
  const cases = { operational: "operational", degraded: "degraded", downtime: "major_outage",
    maintenance: "maintenance", "something-new": "unknown" };
  for (const [state, expected] of Object.entries(cases)) {
    if (net) net.restore();
    setup({ [URLS.huggingface.feed]: () => json(betterstack(state)) });
    const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
    await runOnce(worker, env);
    const { body } = await getStatus(worker, env);
    assert.equal(svc(body, "huggingface").official.status, expected, state);
  }
});

test("services without a public feed never fetch one and say so", async () => {
  setup();
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  for (let i = 0; i < 4; i++) { await runOnce(worker, env); clk.advance(5); }
  assert.ok(!net.calls.some((c) => c.url.includes("aistudio.google.com") || c.url.includes("status.deepseek.com")));
  const { body } = await getStatus(worker, env);
  for (const id of ["gemini", "deepseek"]) {
    assert.equal(svc(body, id).official.status, "unknown", id);
    assert.equal(svc(body, id).official.note, "No official public feed", id);
    assert.equal(svc(body, id).overall, "check_ok", id);
  }
  assert.equal(svc(body, "gemini").status_page, "https://aistudio.google.com/status");
  assert.equal(health().filter((m) => m.includes("FEED PROBLEM")).length, 0);
});

test("gemini's API answering 403 counts as answering", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "gemini").probe.status, "reachable");
  assert.equal(svc(body, "gemini").probe.http_status, 403);
});

test("a 403 is still unknown for services that do not list it", async () => {
  setup({ [URLS.claude.probe]: () => json({ error: "forbidden" }, 403) });
  const env = makeEnv(memoryKV());
  for (let i = 0; i < 3; i++) { await runOnce(worker, env); clk.advance(5); }
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "claude").probe.status, "unknown");
});

test("a challenge page is unknown even when its code is listed as answering", async () => {
  setup({ [URLS.gemini.probe]: () => html("challenge", 403, { "cf-mitigated": "challenge" }) });
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "gemini").probe.status, "unknown");
});

test("xai reads only the Grok components of its JSON summary once approved", async () => {
  setup({ [URLS.xai.feed]: () => json(xaiSummary({ "cursor.com": "major_outage" })) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "xai").official.status, "operational");
  assert.equal(svc(body, "xai").overall, "operational");
});

test("xai status words we have not seen yet are unknown, never a guess", async () => {
  setup({ [URLS.xai.feed]: () => json(xaiSummary({ "grok.com": "degraded" })) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "xai").official.status, "unknown");
  assert.equal(svc(body, "xai").overall, "unknown");
});

test("xai stays unknown until approved", async () => {
  setup();
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: "openai" });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "xai").overall, "unknown");
});

test("xai feed returning a web page instead of JSON is a feed problem", async () => {
  setup({ [URLS.xai.feed]: () => html("<html>nope</html>") });
  const env = makeEnv(memoryKV());
  for (let i = 0; i < 3; i++) { await runOnce(worker, env); clk.advance(5); }
  assert.equal(health().filter((m) => m.includes("FEED PROBLEM") && m.includes("xAI")).length, 1);
});

test("no-feed services are check-only up when approved and answering", async () => {
  setup();
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "gemini").overall, "check_ok");
  assert.equal(svc(body, "deepseek").overall, "check_ok");
});

test("no-feed services stay unknown when not approved", async () => {
  setup();
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: "openai" });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "gemini").overall, "unknown");
});

test("a single failed check on a no-feed service is unknown, not down", async () => {
  setup({ [URLS.deepseek.probe]: () => html("bad gateway", 502) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "deepseek").overall, "unknown");
  assert.equal(alerts().filter((m) => m.includes("DeepSeek")).length, 0);
});

test("a no-feed service failing two checks alerts once and recovers once", async () => {
  let down = true;
  setup({ [URLS.deepseek.probe]: () => (down ? html("bad gateway", 502) : json({}, 401)) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env); clk.advance(5);
  await runOnce(worker, env); clk.advance(5);
  await runOnce(worker, env); clk.advance(5);
  let { body } = await getStatus(worker, env);
  assert.equal(svc(body, "deepseek").overall, "check_failed");
  const starts = alerts().filter((m) => m.includes("DeepSeek"));
  assert.equal(starts.length, 1);
  assert.match(starts[0], /CHECK/);
  assert.match(starts[0], /no official status feed/i);
  assert.doesNotMatch(starts[0], /OUTAGE/);
  down = false;
  await runOnce(worker, env);
  clk.advance(1);   // past the 30-second read cache on /status.json
  ({ body } = await getStatus(worker, env));
  assert.equal(svc(body, "deepseek").overall, "check_ok");
  const rec = alerts().filter((m) => m.includes("DeepSeek") && m.includes("RECOVERED"));
  assert.equal(rec.length, 1);
  assert.match(rec[0], /answering again/);
});

test("a blocked check on a no-feed service never alerts", async () => {
  setup({ [URLS.deepseek.probe]: () => html("blocked", 403) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  for (let i = 0; i < 4; i++) { await runOnce(worker, env); clk.advance(5); }
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "deepseek").overall, "unknown");
  assert.equal(alerts().filter((m) => m.includes("DeepSeek")).length, 0);
});

test("services with a feed never use the check-only states", async () => {
  setup({ [URLS.openai.feed]: () => html("<html>nope</html>") });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "openai").overall, "unknown");
});

test("the test alert is sent once to the alerts channel", async () => {
  setup();
  const env = makeEnv(memoryKV(), { SEND_TEST_ALERT: "1" });
  await runOnce(worker, env); clk.advance(5);
  await runOnce(worker, env);
  const tests = alerts().filter((m) => m.includes("TEST"));
  assert.equal(tests.length, 1);
  assert.match(tests[0], /alerts channel is working/);
});

test("changing the test alert value sends one more", async () => {
  setup();
  const kv = memoryKV();
  await runOnce(worker, makeEnv(kv, { SEND_TEST_ALERT: "1" })); clk.advance(5);
  await runOnce(worker, makeEnv(kv, { SEND_TEST_ALERT: "2" })); clk.advance(5);
  await runOnce(worker, makeEnv(kv, { SEND_TEST_ALERT: "2" }));
  assert.equal(alerts().filter((m) => m.includes("TEST")).length, 2);
});

test("no test alert without the switch", async () => {
  setup();
  const env = makeEnv(memoryKV());
  await runOnce(worker, env);
  assert.equal(alerts().filter((m) => m.includes("TEST")).length, 0);
});

test("a failed test alert is retried next run", async () => {
  let up = false;
  setup({ __discord: () => (up ? new Response(null, { status: 204 }) : new Response("no", { status: 500 })) });
  const env = makeEnv(memoryKV(), { SEND_TEST_ALERT: "1" });
  await runOnce(worker, env); clk.advance(5);
  up = true;
  await runOnce(worker, env);
  assert.equal(alerts().filter((m) => m.includes("TEST")).length, 1);
});

test("a full run stays under the free-plan subrequest limit", async () => {
  setup({ __discord: () => new Response(null, { status: 204 }) });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL, SEND_TEST_ALERT: "1" });
  await runOnce(worker, env);           // first run: also collects every sample
  assert.ok(net.calls.length < 50, "subrequests: " + net.calls.length);
});
