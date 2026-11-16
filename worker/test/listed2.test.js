// v1.19.0 (Nov 15, 2026): Cursor, Claude Code, Codex, ElevenLabs and Runway
// listed from the v1.18.0 samples. Their own checks count only when the reply
// carries the provider's own words (seen in the samples): any other reply is
// odd, so a generic page from something in between is never counted as up.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, memoryKV, json, html, statuspage, xaiSummary, claudeSummary, codexParts, healthyRoutes,
  installFetch, clock, captureLogs, makeEnv, runOnce, getStatus,
} from "./helpers.js";

const FIVE = ["cursor", "claude-code", "codex", "elevenlabs", "runway"];
let clk, net, logs, env;

function start(extra = {}) {
  if (net) net.restore();
  net = installFetch({ ...healthyRoutes(), ...extra });
}
beforeEach(() => {
  clk = clock("2026-11-16T01:00:00Z");
  logs = captureLogs();
  net = null;
  start();
  env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

async function board(runs = 1) {
  // Each run is 5 minutes after the last (status.json is cached 30 seconds).
  for (let i = 0; i < runs; i++) { clk.advance(5); await runOnce(worker, env); }
  const { body } = await getStatus(worker, env);
  return (id) => body.services.find((x) => x.id === id);
}

test("the five are public, with their names and status pages", async () => {
  const get = await board();
  const want = {
    cursor: ["Cursor", "https://status.cursor.com"],
    "claude-code": ["Claude Code", "https://status.claude.com"],
    codex: ["OpenAI Codex", "https://status.openai.com"],
    elevenlabs: ["ElevenLabs", "https://status.elevenlabs.io"],
    runway: ["Runway", "https://status.runwayml.com"],
  };
  for (const [id, [name, page]] of Object.entries(want)) {
    const s = get(id);
    assert.ok(s, id);
    assert.equal(s.name, name);
    assert.equal(s.status_page, page);
  }
});

test("healthy world: all five operational, with our check answering", async () => {
  const get = await board();
  for (const id of FIVE) {
    assert.equal(get(id).official.status, "operational", id + " official");
    assert.equal(get(id).probe.status, "reachable", id + " check");
    assert.equal(get(id).overall, "operational", id + " overall");
  }
});

test("not approved yet: the five show Unknown until listed in APPROVED_MAPPINGS", async () => {
  env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL_IDS.filter((id) => !FIVE.includes(id)).join(",") });
  const get = await board();
  for (const id of FIVE) assert.equal(get(id).overall, "unknown", id);
});

// ---------- strict check rules ----------

test("Cursor's check counts only Cursor's own welcome text", async () => {
  start({ [URLS.cursor.probe]: () => html("<html><title>Parked domain</title></html>") });
  const get = await board(2);
  assert.notEqual(get("cursor").probe.status, "reachable");
});

test("ElevenLabs's 404 counts only in ElevenLabs's own error format", async () => {
  start({ [URLS.elevenlabs.probe]: () => new Response("Not Found", { status: 404 }) });
  const get = await board(2);
  assert.notEqual(get("elevenlabs").probe.status, "reachable");
});

test("Runway's 401 counts only with Runway's own message", async () => {
  start({ [URLS.runway.probe]: () => json({ error: "unauthorized" }, 401) });
  const get = await board(2);
  assert.notEqual(get("runway").probe.status, "reachable");
});

test("a 5xx from a new service's check is a failure, as for every service", async () => {
  start({ [URLS.runway.probe]: () => json({ e: 1 }, 503) });
  const get = await board(2);
  assert.equal(get("runway").probe.status, "unreachable");
});

// ---------- official feeds ----------

test("Cursor reads only Cursor's parts of the shared feed", async () => {
  start({ [URLS.xai.feed]: () => json(xaiSummary({ "Global (api.x.ai)": "major_outage" })) });
  const get = await board();
  assert.equal(get("cursor").official.status, "operational", "a Grok problem is not a Cursor problem");
  start({ [URLS.xai.feed]: () => json(xaiSummary({ "cursor.com": "something new" })) });
  const get2 = await board();
  assert.equal(get2("cursor").official.status, "unknown", "an unknown xAI word is Unknown, never up");
  assert.equal(get2("xai").official.status, "operational");
});

test("Claude Code reads its own part; a claude.ai-only problem does not touch it", async () => {
  start({ [URLS.claude.feed]: () => json(claudeSummary("minor", "operational")) });
  let get = await board();
  assert.equal(get("claude-code").official.status, "operational");
  start({ [URLS.claude.feed]: () => json(claudeSummary("major", "major_outage")) });
  get = await board();
  assert.equal(get("claude-code").official.status, "major_outage");
});

test("Codex reads the Codex parts only", async () => {
  start({ [URLS.codex.feed]: () => json({ components: codexParts().components.map((c) =>
    c.name === "Chat Completions" ? { ...c, status: "major_outage" } : c) }) });
  let get = await board();
  assert.equal(get("codex").official.status, "operational", "an API problem elsewhere is not a Codex problem");
  start({ [URLS.codex.feed]: () => json(codexParts("partial_outage")) });
  get = await board();
  assert.equal(get("codex").official.status, "partial_outage");
});

test("ElevenLabs reads the page-wide status; Runway reads its Public API part", async () => {
  start({
    [URLS.elevenlabs.feed]: () => json(statuspage("critical")),
    [URLS.runway.feed]: () => json({ ...statuspage("minor"), components: [
      { name: "App", status: "degraded_performance" }, { name: "Public API", status: "operational" }] }),
  });
  const get = await board();
  assert.equal(get("elevenlabs").official.status, "major_outage");
  assert.equal(get("runway").official.status, "operational", "an App problem is not an API problem");
});

test("missing parts mean a broken feed, never a guess", async () => {
  start({ [URLS.codex.feed]: () => json({ components: [{ name: "Chat Completions", status: "operational" }] }) });
  const get = await board();
  assert.equal(get("codex").official.status, "unknown");
});

test("the five each get their own RSS feed", async () => {
  await runOnce(worker, env);
  for (const id of FIVE) {
    const res = await worker.fetch(new Request("https://data.liveoutageradar.com/feed/" + id + ".xml"), env, {});
    assert.equal(res.status, 200, id);
  }
});
