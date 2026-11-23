// v1.22.3 (Nov 22, 2026): a short grace period for official feeds.
// DeepInfra's feed sometimes times out from Cloudflare for a run or two while
// it answers fast elsewhere (Nov 17, Nov 20, Nov 23 02:10 UTC). One missed
// read used to blank the row to Unknown at once, while the Discord feed
// alert waits for 3 misses. Now, for up to 2 missed reads in a row, the board
// keeps the last real reading (with its real "checked" time); on the 3rd it
// shows Unknown, the same run the FEED PROBLEM alert goes out.
// The carried reading is for the board only: alerts, subscriber events, the
// incident log and uptime still use real readings.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, ALERTS_HOOK, HEALTH_HOOK, memoryKV, json, html, statuspage, deepinfraStatus, claudeSummary,
  healthyRoutes, installFetch, clock, captureLogs, makeEnv, runOnce, getStatus,
} from "./helpers.js";

let clk, net, logs, env, feed, probe;
const timeout = () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; };
function start() {
  if (net) net.restore();
  net = installFetch({
    ...healthyRoutes(),
    [URLS.deepinfra.feed]: (...a) => feed(...a),
    [URLS.deepinfra.probe]: (...a) => probe(...a),
  });
}
beforeEach(() => {
  clk = clock("2026-11-22T12:00:00Z");
  logs = captureLogs();
  feed = () => json(deepinfraStatus());
  probe = () => json({ error: "unauthorized" }, 401);
  net = null;
  start();
  env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

const discord = (hook) => net.discord.filter((d) => d.url === hook).map((d) => d.body.content);
async function run() {
  clk.advance(5);
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  return (id) => body.services.find((x) => x.id === id);
}

test("the probe answers 401 here, so DeepInfra's own check counts as answering", async () => {
  const get = await run();
  assert.equal(get("deepinfra").official.status, "operational");
  assert.equal(get("deepinfra").overall, "operational");
});

test("one timed-out read keeps the last real reading, with its real checked time", async () => {
  const first = await run();
  const goodAt = first("deepinfra").official.checked_at_utc;
  feed = timeout;
  const get = await run();
  const d = get("deepinfra");
  assert.equal(d.official.status, "operational");
  assert.equal(d.overall, "operational");
  assert.equal(d.official.checked_at_utc, goodAt, "the time of the real reading, not now");
  assert.doesNotMatch(d.official.note, /^Feed problem/, "the board shows the reading, not 'not available'");
  assert.match(d.official.note, /last confirmed/i);
});

test("two misses still show the last reading; the third shows Unknown with the Discord alert", async () => {
  await run();
  feed = timeout;
  let get = await run();
  get = await run();
  assert.equal(get("deepinfra").official.status, "operational", "2nd miss");
  assert.equal(discord(HEALTH_HOOK).filter((m) => m.includes("FEED PROBLEM")).length, 0);
  get = await run();
  assert.equal(get("deepinfra").official.status, "unknown", "3rd miss");
  assert.equal(get("deepinfra").official.note, "Feed problem: timed out");
  assert.equal(discord(HEALTH_HOOK).filter((m) => m.includes("FEED PROBLEM") && m.includes("DeepInfra")).length, 1);
});

test("after a real reading comes back, the grace starts again from zero", async () => {
  await run();
  feed = timeout; await run(); await run();
  feed = () => json(deepinfraStatus()); await run();
  feed = timeout;
  const get = await run();
  assert.equal(get("deepinfra").official.status, "operational");
});

test("no earlier real reading: a miss is Unknown at once", async () => {
  feed = timeout;
  const get = await run();
  assert.equal(get("deepinfra").official.status, "unknown");
  assert.match(get("deepinfra").official.note, /^Feed problem/);
});

test("an old reading is never carried (the checker did not run for 20 minutes)", async () => {
  await run();
  clk.advance(20);
  feed = timeout;
  const get = await run();
  assert.equal(get("deepinfra").official.status, "unknown");
});

test("an outage reading is carried too, so the row does not flicker to Unknown", async () => {
  feed = () => json(deepinfraStatus({ api: "MAJOR_OUTAGE" }));
  await run();
  feed = timeout;
  const get = await run();
  assert.equal(get("deepinfra").official.status, "major_outage");
});

test("alerts use real readings only: a carried 'operational' plus a failing check never claims the signals disagree", async () => {
  await run();
  feed = timeout;
  probe = () => html("bad gateway", 502);
  await run(); await run();
  const alerts = discord(ALERTS_HOOK).filter((m) => /DeepInfra/.test(m));
  assert.deepEqual(alerts, [], "no alert built on a carried reading");
});

test("a broken feed (not just slow) is carried the same way, for 2 misses", async () => {
  await run();
  feed = () => html("<html>bad gateway</html>", 502);
  const get = await run();
  assert.equal(get("deepinfra").official.status, "operational");
});

test("the app line (claude.ai) is carried with the reading", async () => {
  net.restore();
  let claudeFeed = () => json(claudeSummary("minor", "operational", "operational", "partial_outage"));
  net = installFetch({ ...healthyRoutes(), [URLS.claude.feed]: (...a) => claudeFeed(...a) });
  let get = await run();
  assert.equal(get("claude").official.app.status, "partial_outage");
  claudeFeed = timeout;
  get = await run();
  assert.equal(get("claude").official.status, "operational");
  assert.equal(get("claude").official.app.status, "partial_outage");
});

test("the third miss is Unknown even when runs come closer together (count, not just age)", async () => {
  await run();
  feed = timeout;
  for (let i = 0; i < 3; i++) { clk.advance(3); await runOnce(worker, env); }
  const { body } = await getStatus(worker, env);
  const d = body.services.find((x) => x.id === "deepinfra");
  assert.equal(d.official.status, "unknown");
  assert.equal(d.official.note, "Feed problem: timed out");
});
