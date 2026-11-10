// v1.10.0: new services collected quietly in hidden sample mode, a request
// budget for sample runs, and a samples download for review.
// v1.11.0: Together and Fireworks are listed (see listing.test.js); Microsoft
// Copilot is parked (removed, never contacted).
// v1.12.0: OpenRouter and GitHub Copilot are listed (see b2.test.js); only
// DeepInfra stays hidden.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, memoryKV, json, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx, runOnce, getStatus,
} from "./helpers.js";

// v1.13.0: DeepInfra listed; no service is hidden now. The hidden-mode tests
// stay as a guard for the next service added this way.
const HIDDEN = [];
const NEW_URLS = {};

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
  const failing = Object.fromEntries(Object.keys(NEW_URLS).map((u) => [u, () => json({ e: 1 }, 503)]));
  net = installFetch({ ...healthyRoutes(), ...NEW_URLS, ...failing });
  for (let i = 0; i < 4; i++) { await runOnce(worker, env); clk.advance(5); }
  const text = net.discord.map((d) => d.body.content).join("\n");
  // Covers both channels: no outage alert and no feed-problem health message.
  for (const id of HIDDEN) assert.doesNotMatch(text, new RegExp(id, "i"), id);
});

test("hidden services are still checked, and their answers saved in the samples", async () => {
  await runOnce(worker, env);
  const key = [...kv.store.keys()].find((k) => k.startsWith("samples:"));
  const saved = JSON.parse(kv.store.get(key));
  for (const id of HIDDEN) {
    assert.ok(saved.probes.some((p) => p.service === id), id + " probe sample");
    assert.ok(saved.feeds.some((f) => f.service === id), id + " feed or page sample");
  }
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
  // v1.13.0: 12 feeds + 15 checks = 27.
  assert.equal(net.calls.length, 27, "every feed and check runs once");
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
