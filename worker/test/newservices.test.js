// v1.10.0: new services collected quietly in hidden sample mode, a request
// budget for sample runs, and a samples download for review.
// v1.11.0: Together and Fireworks are listed (see listing.test.js); three stay
// hidden; Microsoft Copilot is parked (removed, never contacted).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, memoryKV, json, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx, runOnce, getStatus,
} from "./helpers.js";

const HIDDEN = ["openrouter", "deepinfra", "github-copilot"];
const NEW_URLS = {
  "https://openrouter.ai/api/v1/models": () => json({ data: [] }, 200),
  "https://api.deepinfra.com/v1/openai/models": () => json({ object: "list", data: [] }, 200),
  "https://api.githubcopilot.com/models": () => new Response("bad request: missing header", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } }),
  "https://www.githubstatus.com/api/v2/summary.json": () => json({
    status: { indicator: "none" },
    components: [{ name: "Copilot", status: "operational" }, { name: "Copilot AI Model Providers", status: "operational" }],
  }),
  // One-time samples in v1.11.0.
  "https://status.deepinfra.com/api": () => new Response("<html>DeepInfra status API</html>", { status: 200, headers: { "content-type": "text/html" } }),
  "https://status.deepinfra.com/status.atom": () => new Response("<feed></feed>", { status: 200, headers: { "content-type": "application/atom+xml" } }),
  "https://openrouter.ai/api/v1/key": () => json({ error: { code: 401, message: "Missing Authentication header" } }, 401),
};

// Counts KV reads and writes, which Cloudflare also counts as subrequests.
function countingKV(inner) {
  const c = { ops: 0 };
  return {
    counter: c,
    store: inner.store,
    get writes() { return inner.writes; },
    async get(...a) { c.ops += 1; return inner.get(...a); },
    async put(...a) { c.ops += 1; return inner.put(...a); },
    async delete(...a) { c.ops += 1; return inner.delete ? inner.delete(...a) : undefined; },
  };
}
const KEY = "test-admin-key-0123456789-abcdefghij";

let clk, net, logs, kv, env;
beforeEach(() => {
  clk = clock("2026-11-09T12:00:00Z");
  logs = captureLogs();
  net = installFetch({ ...healthyRoutes(), ...NEW_URLS });
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: [...ALL_IDS, ...HIDDEN].join(","), ADMIN_KEY: KEY });
});
afterEach(() => { net.restore(); clk.restore(); logs.restore(); });

test("hidden services never reach status.json, even if approved by mistake", async () => {
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  const ids = body.services.map((s) => s.id);
  assert.deepEqual(ids.sort(), [...ALL_IDS].sort());
  for (const id of HIDDEN) assert.ok(!ids.includes(id), id);
});

test("hidden services never reach the history feed", async () => {
  await runOnce(worker, env);
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/incidents.json"), env, ctx);
  const ids = (await res.json()).services.map((s) => s.id);
  for (const id of HIDDEN) assert.ok(!ids.includes(id), id);
});

test("hidden services never send Discord alerts, even if their check fails", async () => {
  net.restore();
  const failing = Object.fromEntries(Object.keys(NEW_URLS).filter((u) => /models$|summary\.json$/.test(u)).map((u) => [u, () => json({ e: 1 }, 503)]));
  net = installFetch({ ...healthyRoutes(), ...NEW_URLS, ...failing });
  for (let i = 0; i < 4; i++) { await runOnce(worker, env); clk.advance(5); }
  const text = net.discord.map((d) => d.body.content).join("\n");
  // Covers both channels: no outage alert and no feed-problem health message.
  for (const name of ["OpenRouter", "DeepInfra", "GitHub Copilot", "githubstatus"]) assert.doesNotMatch(text, new RegExp(name), name);
});

test("hidden services are still checked, and their answers saved in the samples", async () => {
  await runOnce(worker, env);
  const key = [...kv.store.keys()].find((k) => k.startsWith("samples:"));
  const saved = JSON.parse(kv.store.get(key));
  for (const id of HIDDEN) {
    assert.ok(saved.probes.some((p) => p.service === id), id + " probe sample");
    assert.ok(saved.feeds.some((f) => f.service === id), id + " feed or page sample");
  }
  const or = saved.probes.find((p) => p.service === "openrouter");
  assert.equal(or.http_status, 200);
});

test("a sample run downloads each official feed only once", async () => {
  await runOnce(worker, env);
  const counts = {};
  for (const c of net.calls) counts[c.url] = (counts[c.url] || 0) + 1;
  const repeated = Object.entries(counts).filter(([u, n]) => n > 1 && !u.startsWith("https://discord.com/"));
  assert.deepEqual(repeated, []);
});

test("a sample run stays under the free plan's 50 subrequests, counting fetches AND storage calls", async () => {
  const ckv = countingKV(kv);
  env = makeEnv(ckv, { APPROVED_MAPPINGS: [...ALL_IDS, ...HIDDEN].join(","), ADMIN_KEY: KEY });
  await runOnce(worker, env);
  const total = net.calls.length + ckv.counter.ops;
  // Room still kept for: the daily database cleanup (2), redirects (4) and
  // more Discord messages than this quiet test run sends.
  assert.ok(total + 2 + 4 <= 50, "fetches " + net.calls.length + " + storage " + ckv.counter.ops + " = " + total);
});

test("every sample address fits in the budget: none skipped", async () => {
  await runOnce(worker, env);
  const key = [...kv.store.keys()].find((k) => k.startsWith("samples:"));
  const saved = JSON.parse(kv.store.get(key));
  const skipped = saved.feeds.filter((f) => f.skipped);
  assert.deepEqual(skipped.map((f) => f.url), []);
  for (const id of HIDDEN) assert.ok(saved.feeds.some((f) => f.service === id), "no page sample for " + id);
});

test("a normal run stays well inside the budget", async () => {
  await runOnce(worker, env);
  net.calls.length = 0;
  clk.advance(5);
  await runOnce(worker, env);
  // v1.11.0: 11 feeds (8 + Together, Fireworks, GitHub) + 15 checks = 26.
  assert.ok(net.calls.length <= 30, "made " + net.calls.length + " outgoing requests");
  assert.ok(net.calls.length >= 26, "every feed and check still runs: " + net.calls.length);
});

test("saved feed samples from the main run keep their status and body", async () => {
  await runOnce(worker, env);
  const key = [...kv.store.keys()].find((k) => k.startsWith("samples:"));
  const saved = JSON.parse(kv.store.get(key));
  const openaiFeed = saved.feeds.find((f) => f.service === "openai");
  assert.equal(openaiFeed.http_status, 200);
  assert.ok(openaiFeed.body.length > 0);
  assert.ok(openaiFeed.bytes > 0);
});

// ---------- samples download for review ----------

async function getSamples(key) {
  const headers = key ? { authorization: "Bearer " + key } : {};
  return worker.fetch(new Request("https://data.liveoutageradar.com/admin/samples", { headers }), env, ctx);
}

test("the samples download needs the admin key", async () => {
  await runOnce(worker, env);
  assert.equal((await getSamples(null)).status, 401);
  assert.equal((await getSamples("wrong-key-wrong-key-wrong-key")).status, 401);
  const res = await getSamples(KEY);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="outageradar-samples-v[0-9.]+\.json"/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.ok(Array.isArray(body.feeds) && Array.isArray(body.probes));
});

test("before any samples exist, the download says so instead of failing", async () => {
  const res = await getSamples(KEY);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "no_samples_yet");
});

test("the dashboard offers the samples download", async () => {
  const page = await (await worker.fetch(new Request("https://data.liveoutageradar.com/admin"), env, ctx)).text();
  assert.match(page, /id="samplesBtn"/);
  const app = await (await worker.fetch(new Request("https://data.liveoutageradar.com/admin/app.js"), env, ctx)).text();
  assert.match(app, /\/admin\/samples/);
});
