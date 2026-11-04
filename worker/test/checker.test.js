import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  URLS, ALERTS_HOOK, HEALTH_HOOK, memoryKV, failingKV, json, html, statuspage,
  components, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx,
  runOnce, getStatus, svc,
} from "./helpers.js";

const ALL = "openai,mistral,perplexity,groq";
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
  assert.equal(body.services.length, 4);
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
  assert.equal(svc(body, "openai").probe.label, "Site reachable (HTTP 200)");
});

test("raw samples are saved once and announced once in the health channel", async () => {
  setup();
  const kv = memoryKV();
  const env = makeEnv(kv);
  await runOnce(worker, env);
  const saved = JSON.parse(kv.store.get("samples:v1"));
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

test("components feeds use the worst listed component, including uppercase names", async () => {
  setup({
    [URLS.perplexity.feed]: () => json(components([
      { name: "Website", status: "OPERATIONAL" }, { name: "API", status: "MAJOROUTAGE" }])),
    [URLS.groq.feed]: () => json(components([
      { name: "API", status: "partial_outage" }, { name: "Website", status: "operational" }])),
  });
  const env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.equal(svc(body, "perplexity").official.status, "major_outage");
  assert.equal(svc(body, "groq").official.status, "partial_outage");
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
