// /incidents.json (v1.7.0): the full incident list per service, for the
// per-service history pages. Read-only; nothing new is written.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  URLS, ALL_IDS, memoryKV, json, statuspage, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx, runOnce,
} from "./helpers.js";

let clk, net, logs, kv, env, openai;
beforeEach(() => {
  clk = clock("2026-11-08T12:00:00Z");
  logs = captureLogs();
  openai = "none";
  net = installFetch({ ...healthyRoutes(), [URLS.openai.feed]: () => json(statuspage(openai)) });
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); clk.restore(); logs.restore(); });

async function step() { await runOnce(worker, env); clk.advance(5); }
async function history(init = {}) {
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/incidents.json", {
    headers: { origin: "https://liveoutageradar.com" }, ...init,
  }), env, ctx);
  return { res, body: res.status === 200 ? await res.json() : null };
}

test("before any run the history is empty, not an error", async () => {
  const { res, body } = await history();
  assert.equal(res.status, 200);
  assert.deepEqual(body.services, []);
});

test("every approved service is listed with its log start, even with no incidents", async () => {
  await step();
  const { body } = await history();
  assert.deepEqual(body.services.map((s) => s.id).sort(), [...ALL_IDS].sort());
  const claude = body.services.find((s) => s.id === "claude");
  assert.equal(claude.since_utc, "2026-11-08T12:00:00Z");
  assert.equal(claude.name, "Claude");
  assert.deepEqual(claude.incidents, []);
});

test("services not approved are left out", async () => {
  env = makeEnv(kv, { APPROVED_MAPPINGS: "openai" });
  await step();
  const { body } = await history();
  assert.deepEqual(body.services.map((s) => s.id), ["openai"]);
});

test("incidents are listed newest first with only public fields", async () => {
  openai = "minor"; await step();            // 12:00 opens
  openai = "none"; await step(); await step(); // closes at 12:05
  openai = "critical"; await step();         // 12:15 opens again
  const { body } = await history();
  const list = body.services.find((s) => s.id === "openai").incidents;
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    started_utc: "2026-11-08T12:15:00Z", ended_utc: null, worst: "major_outage", kind: "official",
    minutes: 5, end_confirmed: true, // ongoing: measured when asked (5 min after the run)
  });
  assert.deepEqual(list[1], {
    started_utc: "2026-11-08T12:00:00Z", ended_utc: "2026-11-08T12:05:00Z", worst: "degraded", kind: "official",
    minutes: 5, end_confirmed: true,
  });
});

test("internal bookkeeping never leaves the checker", async () => {
  openai = "critical"; await step(); openai = "none"; await step();
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/incidents.json"), env, ctx);
  const text = await res.text();
  assert.match(text, /started_utc/);
  assert.doesNotMatch(text, /good_since|unknown_since|last_bad|start_ms|end_ms/);
});

test("history answers with CORS for our site and a short public cache", async () => {
  await step();
  const { res } = await history();
  assert.equal(res.headers.get("access-control-allow-origin"), "https://liveoutageradar.com");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  assert.match(res.headers.get("x-robots-tag"), /noindex/);
});

test("history is read-only", async () => {
  const { res } = await history({ method: "POST", body: "x" });
  assert.equal(res.status, 405);
});

test("a storage read failure gives an empty history, not a crash", async () => {
  await step();
  env = makeEnv({ get: async () => { throw new Error("KV down"); }, put: async () => {} }, {});
  const { res, body } = await history();
  assert.equal(res.status, 200);
  assert.deepEqual(body.services, []);
});
