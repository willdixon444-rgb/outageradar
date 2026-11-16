// v1.21.0 (Nov 16, 2026): uptime per service in /incidents.json, from data the
// checker already keeps (no extra requests):
// - official: share of time with no official incident, over the last 30 days
//   or since logging began, whichever is shorter;
// - check: share of our API checks that got a real answer, counted from this
//   release (failed checks were never counted before).
// Never overstated: a window shorter than one day shows nothing, percentages
// round down, and if the log is full (20 kept) the window starts at the oldest
// kept incident. Claude and OpenAI count from the API-only change (v1.20.0,
// Nov 16, 2026 01:15 UTC), because older incidents included app problems.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, memoryKV, json, healthyRoutes, installFetch, clock, captureLogs, makeEnv, runOnce, ctx,
} from "./helpers.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const H = 60 * 60 * 1000;
const D = 24 * H;
let clk, net, logs, kv, env;

beforeEach(() => {
  clk = clock("2026-11-20T12:00:00Z");
  logs = captureLogs();
  net = installFetch(healthyRoutes());
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); clk.restore(); logs.restore(); });

function seed({ incidents = {}, since = {}, checks = {} }) {
  kv.store.set("state:v1", JSON.stringify({ schema: 1, services: {}, incidents, incident_since: since, checks }));
}
const inc = (startMs, endMs, worst = "major_outage", kind = "official") =>
  ({ start_ms: startMs, end_ms: endMs, worst, kind, end_confirmed: true });
async function uptime(id) {
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/incidents.json"), env, ctx);
  const s = (await res.json()).services.find((x) => x.id === id);
  return s && s.uptime;
}

test("10 days logged with one 12-hour official outage: 95.0%, since the log start", async () => {
  seed({ since: { mistral: NOW - 10 * D }, incidents: { mistral: [inc(NOW - 5 * D, NOW - 5 * D + 12 * H)] } });
  const u = await uptime("mistral");
  assert.equal(u.official.pct, 95);
  assert.equal(u.official.since_utc, new Date(NOW - 10 * D).toISOString().replace(/\.\d{3}Z$/, "Z"));
});

test("no incidents: exactly 100", async () => {
  seed({ since: { mistral: NOW - 3 * D } });
  assert.equal((await uptime("mistral")).official.pct, 100);
});

test("percentages round down, so a short outage never shows as 100", async () => {
  seed({ since: { mistral: NOW - 10 * D }, incidents: { mistral: [inc(NOW - 2 * D, NOW - 2 * D + 5 * 60000)] } });
  const u = await uptime("mistral");
  assert.ok(u.official.pct < 100, String(u.official.pct));
  assert.equal(u.official.pct, 99.9);
});

test("an ongoing incident counts up to now", async () => {
  seed({ since: { mistral: NOW - 4 * D }, incidents: { mistral: [inc(NOW - D, null)] } });
  assert.equal((await uptime("mistral")).official.pct, 75);
});

test("only the last 30 days count", async () => {
  seed({ since: { mistral: NOW - 60 * D }, incidents: { mistral: [inc(NOW - 45 * D, NOW - 40 * D), inc(NOW - 3 * D, NOW - 3 * D + 18 * H)] } });
  const u = await uptime("mistral");
  assert.equal(u.official.pct, 97.5);
  assert.equal(Date.parse(u.official.since_utc), NOW - 30 * D);
});

test("an incident that began before the window counts only its part inside it", async () => {
  seed({ since: { mistral: NOW - 60 * D }, incidents: { mistral: [inc(NOW - 31 * D, NOW - 29 * D)] } });
  // 1 of 30 days inside the window.
  assert.equal((await uptime("mistral")).official.pct, 96.6);
});

test("our-check-only incidents do not count against the official figure", async () => {
  seed({ since: { mistral: NOW - 10 * D }, incidents: { mistral: [inc(NOW - 5 * D, NOW - 4 * D, "check_failed", "our_check")] } });
  assert.equal((await uptime("mistral")).official.pct, 100);
});

test("degraded counts as a problem; overlapping incidents are not counted twice", async () => {
  seed({ since: { mistral: NOW - 10 * D }, incidents: { mistral: [
    inc(NOW - 5 * D, NOW - 5 * D + 12 * H, "degraded"), inc(NOW - 5 * D + 6 * H, NOW - 5 * D + 12 * H)] } });
  assert.equal((await uptime("mistral")).official.pct, 95);
});

test("less than a day logged: no figure yet", async () => {
  seed({ since: { mistral: NOW - 20 * H } });
  assert.equal((await uptime("mistral")).official, null);
});

test("a full log (20 kept) starts the window at the oldest kept incident", async () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(inc(NOW - (20 - i) * D, NOW - (20 - i) * D + H));
  seed({ since: { mistral: NOW - 29 * D }, incidents: { mistral: list } });
  const u = await uptime("mistral");
  assert.equal(Date.parse(u.official.since_utc), NOW - 20 * D);
});

test("feedless services have no official figure", async () => {
  seed({ since: { gemini: NOW - 10 * D } });
  assert.equal((await uptime("gemini")).official, null);
});

test("Claude and OpenAI count only from the API-only change (Nov 16, 2026 01:15 UTC)", async () => {
  const split = Date.parse("2026-11-16T01:15:00Z");
  seed({ since: { claude: NOW - 15 * D, openai: NOW - 15 * D }, incidents: {
    claude: [inc(NOW - 10 * D, NOW - 8 * D, "degraded")], openai: [] } });
  for (const id of ["claude", "openai"]) {
    const u = await uptime(id);
    assert.equal(Date.parse(u.official.since_utc), split, id);
    assert.equal(u.official.pct, 100, id + ": the old app-wide incident is outside the window");
  }
});

// ---------- our check ----------

test("check figure: answered checks over answered plus failed, once a day's worth exists", async () => {
  seed({ since: { mistral: NOW - 3 * D }, checks: { mistral: [
    { day: "2026-11-18", ok: 288, fail: 0 }, { day: "2026-11-19", ok: 280, fail: 8 }, { day: "2026-11-20", ok: 144, fail: 0 }] } });
  const u = await uptime("mistral");
  assert.equal(u.check.pct, 98.8);
  assert.equal(u.check.checks, 720);
  assert.equal(u.check.since_utc, "2026-11-18T00:00:00Z");
});

test("fewer than 288 counted checks: no check figure yet", async () => {
  seed({ since: { mistral: NOW - 3 * D }, checks: { mistral: [{ day: "2026-11-20", ok: 200, fail: 0 }] } });
  assert.equal((await uptime("mistral")).check, null);
});

test("check counts older than 30 days are ignored, and damaged ones dropped", async () => {
  seed({ since: { mistral: NOW - 3 * D }, checks: { mistral: [
    { day: "2026-10-01", ok: 0, fail: 9999 }, { day: "bad", ok: 1, fail: 0 }, { day: "2026-11-19", ok: -5, fail: 0 },
    { day: "2026-11-20", ok: 300, fail: 0 }] } });
  const u = await uptime("mistral");
  assert.equal(u.check.pct, 100);
  assert.equal(u.check.checks, 300);
});

test("each run counts each check once: answered, failed, and nothing for blocked or odd replies", async () => {
  net.restore();
  net = installFetch({ ...healthyRoutes(), [URLS.mistral.probe]: () => json({ e: 1 }, 503),
    [URLS.groq.probe]: () => json({ e: 1 }, 403) });
  await runOnce(worker, env);
  clk.advance(5);
  await runOnce(worker, env);
  const st = JSON.parse(kv.store.get("state:v1"));
  // A service with only blocked or odd replies has no count at all yet.
  const today = (id) => st.checks[id][st.checks[id].length - 1] || { ok: 0, fail: 0 };
  assert.deepEqual([today("openai").ok, today("openai").fail], [2, 0]);
  assert.deepEqual([today("mistral").ok, today("mistral").fail], [0, 2]);
  assert.deepEqual([today("groq").ok, today("groq").fail], [0, 0]);
});

test("uptime costs no extra requests", async () => {
  await runOnce(worker, env);
  net.calls.length = 0;
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(net.calls.length, 34);
});
