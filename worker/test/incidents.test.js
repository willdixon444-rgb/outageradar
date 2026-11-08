// Incident log (v1.6): start/end of each problem per service, kept inside
// state:v1 and summarised in status.json for the board's "Last incident" line.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  URLS, ALL_IDS, memoryKV, json, statuspage, healthyRoutes, installFetch, clock, captureLogs, makeEnv,
  runOnce, getStatus, svc,
} from "./helpers.js";

const ALL = ALL_IDS.join(",");
let clk, net, logs, kv, env;
let openai;      // statuspage indicator served for OpenAI
let groqProbe;   // HTTP code served by Groq's API probe
let geminiProbe; // HTTP code served by Gemini's API probe

beforeEach(() => {
  clk = clock("2026-11-08T12:00:00Z");
  logs = captureLogs();
  openai = "none";
  groqProbe = 401;
  geminiProbe = 403;
  net = installFetch({
    ...healthyRoutes(),
    [URLS.openai.feed]: () => (openai === "broken" ? new Response("<html>oops</html>", { status: 200 }) : json(statuspage(openai))),
    [URLS.groq.probe]: () => json({ error: "x" }, groqProbe),
    [URLS.gemini.probe]: () => json({ error: "x" }, geminiProbe),
  });
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL });
});
afterEach(() => { net.restore(); clk.restore(); logs.restore(); });

async function step(minutes = 5) {
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  clk.advance(minutes);
  return body;
}
const inc = (body, id) => svc(body, id).incidents;
const saved = () => JSON.parse(kv.store.get("state:v1")).incidents;

test("a calm service has no incident and says when the log started", async () => {
  const body = await step();
  assert.deepEqual(inc(body, "openai"), { since_utc: "2026-11-08T12:00:00Z", last: null });
});

test("the log start date does not move on later runs", async () => {
  await step();
  await step();
  const body = await step();
  assert.equal(inc(body, "openai").since_utc, "2026-11-08T12:00:00Z");
});

test("services not yet approved have no incident log", async () => {
  env = makeEnv(kv, { APPROVED_MAPPINGS: "openai" });
  const body = await step();
  assert.equal(inc(body, "claude"), null);
  assert.ok(inc(body, "openai"));
});

test("an official outage opens an incident at once and shows it as ongoing", async () => {
  await step();
  openai = "critical";
  const body = await step();
  assert.deepEqual(inc(body, "openai").last, {
    started_utc: "2026-11-08T12:05:00Z", ended_utc: null, worst: "major_outage", kind: "official", minutes: 0,
  });
});

test("recovery closes the incident with its length", async () => {
  await step();
  openai = "major";
  await step();
  await step();
  await step();
  openai = "none";
  const body = await step();
  const last = inc(body, "openai").last;
  assert.equal(last.started_utc, "2026-11-08T12:05:00Z");
  assert.equal(last.ended_utc, "2026-11-08T12:20:00Z");
  assert.equal(last.minutes, 15);
  assert.equal(last.worst, "partial_outage");
});

test("the worst state is kept even after things improve", async () => {
  openai = "minor";
  await step();
  openai = "critical";
  await step();
  openai = "minor";
  const body = await step();
  assert.equal(inc(body, "openai").last.worst, "major_outage");
  assert.equal(inc(body, "openai").last.ended_utc, null);
});

test("degraded counts as an incident; maintenance does not", async () => {
  openai = "maintenance";
  let body = await step();
  assert.equal(inc(body, "openai").last, null);
  openai = "minor";
  body = await step();
  assert.equal(inc(body, "openai").last.worst, "degraded");
});

test("unknown in the middle keeps the incident open: no recovery we cannot see", async () => {
  openai = "critical";
  await step();
  openai = "broken";
  let body = await step();
  body = await step();
  assert.equal(inc(body, "openai").last.ended_utc, null);
  openai = "none";
  body = await step();
  assert.equal(inc(body, "openai").last.ended_utc, "2026-11-08T12:15:00Z");
});

test("one failed check is not an incident; two in a row is, marked as our check", async () => {
  groqProbe = 503;
  let body = await step();
  assert.equal(inc(body, "groq").last, null);
  body = await step();
  assert.deepEqual(
    { worst: inc(body, "groq").last.worst, kind: inc(body, "groq").last.kind, started: inc(body, "groq").last.started_utc },
    { worst: "signals_disagree", kind: "our_check", started: "2026-11-08T12:05:00Z" },
  );
});

test("an our-check incident becomes official once the provider confirms it", async () => {
  net.restore();
  let openaiProbe = 503;
  net = installFetch({
    ...healthyRoutes(),
    [URLS.openai.feed]: () => json(statuspage(openai)),
    [URLS.openai.probe]: () => json({ error: "x" }, openaiProbe),
  });
  await step();
  let body = await step();
  assert.equal(inc(body, "openai").last.kind, "our_check");
  openai = "major";
  body = await step();
  assert.equal(inc(body, "openai").last.kind, "official");
  assert.equal(inc(body, "openai").last.worst, "partial_outage");
  assert.equal(inc(body, "openai").last.started_utc, "2026-11-08T12:05:00Z");
});

test("a service with no official feed logs a failed check as our check", async () => {
  geminiProbe = 502;
  await step();
  const body = await step();
  assert.equal(inc(body, "gemini").last.worst, "check_failed");
  assert.equal(inc(body, "gemini").last.kind, "our_check");
});

test("the log keeps the 20 newest incidents per service", async () => {
  for (let i = 0; i < 25; i++) {
    openai = "minor";
    await step();
    openai = "none";
    await step();
  }
  const list = saved().openai;
  assert.equal(list.length, 20);
  assert.ok(list[0].start_ms > Date.parse("2026-11-08T12:00:00Z"));
});

test("finished incidents older than 90 days are dropped", async () => {
  openai = "minor";
  await step();
  openai = "none";
  await step();
  assert.equal(saved().openai.length, 1);
  clk.advance(91 * 24 * 60);
  const body = await step();
  assert.equal(saved().openai.length, 0);
  assert.equal(inc(body, "openai").last, null);
});

test("an incident still open after 90 days is kept", async () => {
  openai = "critical";
  await step();
  clk.advance(91 * 24 * 60);
  await step();
  assert.equal(saved().openai.length, 1);
  assert.equal(saved().openai[0].end_ms, null);
});

test("the log adds no extra storage writes", async () => {
  await step(); // first run also saves samples
  const before = kv.writes;
  openai = "critical";
  await step();
  openai = "none";
  await step();
  assert.equal(kv.writes - before, 2, "one state write per run, nothing more");
});

test("a damaged saved log is reset instead of breaking the run", async () => {
  await step();
  const state = JSON.parse(kv.store.get("state:v1"));
  state.incidents = { openai: "garbage", claude: [{ nonsense: true }] };
  state.incident_since = 42;
  kv.store.set("state:v1", JSON.stringify(state));
  openai = "critical";
  const body = await step();
  assert.equal(inc(body, "openai").last.worst, "major_outage");
  assert.equal(inc(body, "claude").last, null);
  assert.equal(body.stale, false);
});
