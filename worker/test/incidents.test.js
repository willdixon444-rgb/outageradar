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
    end_confirmed: true,
  });
});

test("recovery closes the incident after two healthy checks, ended at the first (v1.6.1)", async () => {
  await step();
  openai = "major";
  await step();
  await step();
  await step();
  openai = "none";
  let body = await step();
  assert.equal(inc(body, "openai").last.ended_utc, null, "one healthy check is not enough");
  body = await step();
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
  await step();
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
  await step();
  assert.equal(kv.writes - before, 3, "one state write per run, nothing more");
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

// ---------- v1.6.1: AG review fixes ----------

test("flapping stays one incident: a healthy blip between failures does not close it", async () => {
  openai = "minor";
  await step();            // 12:00 opens
  openai = "none";
  await step();            // 12:05 healthy once
  openai = "minor";
  await step();            // 12:10 bad again
  openai = "none";
  await step();            // 12:15 healthy once
  let body = await step(); // 12:20 healthy twice: closes at 12:15
  const list = saved().openai;
  assert.equal(list.length, 1, "one incident, not three blips");
  body = inc(body, "openai").last;
  assert.equal(body.started_utc, "2026-11-08T12:00:00Z");
  assert.equal(body.ended_utc, "2026-11-08T12:15:00Z");
  assert.equal(body.minutes, 15);
});

test("unknown between two healthy checks restarts the healthy count", async () => {
  openai = "critical";
  await step();            // 12:00 opens
  openai = "none";
  await step();            // 12:05 healthy once
  openai = "broken";
  await step();            // 12:10 unknown
  openai = "none";
  let body = await step(); // 12:15 healthy once again
  assert.equal(inc(body, "openai").last.ended_utc, null);
  body = await step();     // 12:20 healthy twice
  assert.equal(inc(body, "openai").last.ended_utc, "2026-11-08T12:15:00Z");
});

test("an incident stuck on unknown for 2 hours closes as end not confirmed, with one health message", async () => {
  openai = "critical";
  await step();            // 12:00 opens
  await step();            // 12:05 still bad (last bad seen)
  openai = "broken";
  let body;
  for (let i = 0; i < 24; i++) body = await step(); // 12:10 .. 14:05 unknown
  assert.equal(inc(body, "openai").last.ended_utc, null, "not yet 2 hours");
  body = await step();     // 14:10: unknown since 12:10 = 2 hours
  const last = inc(body, "openai").last;
  assert.equal(last.ended_utc, "2026-11-08T12:05:00Z", "ends at the last time we saw the problem");
  assert.equal(last.end_confirmed, false);
  assert.equal(last.minutes, 5);
  const msgs = net.discord.filter((p) => p.url === env.DISCORD_HEALTH_WEBHOOK && /INCIDENT LOG/.test(p.body.content));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body.content, /ChatGPT \/ OpenAI|OpenAI/);
  assert.match(msgs[0].body.content, /end not confirmed/);
  await step();
  await step();
  assert.equal(net.discord.filter((p) => p.url === env.DISCORD_HEALTH_WEBHOOK && /INCIDENT LOG/.test(p.body.content)).length, 1,
    "said once, not every run");
});

test("after a stalled close, the problem coming back opens a new incident", async () => {
  openai = "critical";
  await step();
  openai = "broken";
  for (let i = 0; i < 26; i++) await step();
  openai = "critical";
  const body = await step();
  assert.equal(saved().openai.length, 2);
  assert.equal(inc(body, "openai").last.ended_utc, null);
  assert.equal(inc(body, "openai").last.end_confirmed, true);
});

test("maintenance during an incident counts toward the 2-hour limit like unknown", async () => {
  openai = "critical";
  await step();
  openai = "maintenance";
  let body;
  for (let i = 0; i < 25; i++) body = await step();
  assert.equal(inc(body, "openai").last.end_confirmed, false);
});

test("logs saved by v1.6.0 (without the new fields) keep working", async () => {
  await step();
  const state = JSON.parse(kv.store.get("state:v1"));
  state.incidents.openai = [{ start_ms: Date.parse("2026-11-08T11:00:00Z"), end_ms: null, worst: "degraded", kind: "official" }];
  kv.store.set("state:v1", JSON.stringify(state));
  openai = "none";
  await step();
  const body = await step();
  assert.equal(inc(body, "openai").last.ended_utc, "2026-11-08T12:05:00Z");
  assert.equal(inc(body, "openai").last.end_confirmed, true);
});
