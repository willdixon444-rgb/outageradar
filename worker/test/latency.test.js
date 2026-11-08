// Latency (v1.8.0): how long each API check took to get an answer, shown on
// the board, plus a 30-day daily summary kept for a future baseline.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  URLS, ALL_IDS, memoryKV, json, healthyRoutes, installFetch, clock, captureLogs, makeEnv, runOnce, getStatus, svc,
} from "./helpers.js";

const unauthorized = () => json({ error: { message: "missing api key" } }, 401);
let clk, net, logs, kv, env;
let claudeMs;      // how long Claude's API takes to answer
let claudeAnswer;  // what it answers with
beforeEach(() => {
  clk = clock("2026-11-08T12:00:00Z");
  logs = captureLogs();
  claudeMs = 312;
  claudeAnswer = () => unauthorized();
  net = installFetch({
    ...healthyRoutes(),
    [URLS.claude.probe]: () => { clk.advance(claudeMs / 60000); return claudeAnswer(); },
  });
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); clk.restore(); logs.restore(); });

async function step() {
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  clk.set(new Date(Math.ceil((clk.now + 1) / 300000) * 300000).toISOString()); // next 5-minute mark
  return body;
}
const stats = () => JSON.parse(kv.store.get("state:v1")).latency;

test("a check that answers shows how long it took", async () => {
  const body = await step();
  assert.equal(svc(body, "claude").probe.latency_ms, 312);
});

test("no time is shown when the check got no normal answer", async () => {
  claudeAnswer = () => { throw new Error("connect timeout"); };
  let body = await step();
  assert.equal(svc(body, "claude").probe.latency_ms, null);
  claudeAnswer = () => json({ error: "busy" }, 429);
  body = await step();
  assert.equal(svc(body, "claude").probe.latency_ms, null);
  claudeAnswer = () => json({ error: "down" }, 503);
  body = await step();
  assert.equal(svc(body, "claude").probe.latency_ms, null);
});

test("every service's probe carries a latency field", async () => {
  const body = await step();
  for (const id of ALL_IDS) assert.ok("latency_ms" in svc(body, id).probe, id);
});

test("a daily summary is kept: count, total, fastest, slowest and a spread", async () => {
  await step();
  claudeMs = 1500;
  await step();
  claudeMs = 80;
  await step();
  const [day] = stats().claude;
  assert.deepEqual(day, { day: "2026-11-08", n: 3, sum: 1892, min: 80, max: 1500, b: [1, 1, 0, 1, 0, 0] });
});

test("failed checks are not counted in the summary", async () => {
  claudeAnswer = () => { throw new Error("timeout"); };
  await step();
  assert.equal((stats().claude || []).length, 0);
});

test("a new UTC day starts a new summary, and only 30 days are kept", async () => {
  for (let d = 0; d < 32; d++) {
    clk.set("2026-11-" + String(8 + Math.min(d, 22)).padStart(2, "0") + "T12:00:00Z");
    if (d > 22) clk.set(new Date(Date.parse("2026-11-30T12:00:00Z") + (d - 22) * 86400000).toISOString());
    await runOnce(worker, env);
  }
  const list = stats().claude;
  assert.equal(list.length, 30);
  assert.equal(new Set(list.map((x) => x.day)).size, 30);
  assert.equal(list[list.length - 1].day, "2026-12-09");
});

test("the summary stays out of status.json", async () => {
  const body = await step();
  assert.doesNotMatch(JSON.stringify(body), /"sum"|"b":\[/);
});

test("a damaged saved summary is reset instead of breaking the run", async () => {
  await step();
  const state = JSON.parse(kv.store.get("state:v1"));
  state.latency = { claude: "garbage", openai: [{ day: 5 }] };
  kv.store.set("state:v1", JSON.stringify(state));
  const body = await step();
  assert.equal(body.stale, false);
  assert.equal(stats().claude.length, 1);
  assert.equal(stats().claude[0].n, 1);
});

test("timing adds no extra storage writes", async () => {
  await step();
  const before = kv.writes;
  await step();
  await step();
  assert.equal(kv.writes - before, 2);
});
