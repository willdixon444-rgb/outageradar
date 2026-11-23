// v1.18.0 (Nov 15, 2026): Cursor, Claude Code, Codex, Windsurf, ElevenLabs and
// Runway are checked in hidden sample mode (never public, never alerted; the
// general hidden-mode guards are in newservices.test.js). This file pins their
// addresses and the shared requests: one download of a feed or one API check
// per run serves every service that uses it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  xaiSummary, ALL_IDS, URLS, memoryKV, json, html, healthyRoutes, installFetch, clock, captureLogs, makeEnv, runOnce, getStatus,
} from "./helpers.js";
import { NEW_SERVICES, newRoutes } from "./wave1.fixtures.js";

const NEW_IDS = Object.keys(NEW_SERVICES);
let clk, net, logs, kv, env;

function start(extra = {}) {
  if (net) net.restore();
  net = installFetch({ ...healthyRoutes(), ...newRoutes(), ...extra });
}
beforeEach(() => {
  clk = clock("2026-11-15T23:00:00Z");
  logs = captureLogs();
  net = null;
  start();
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: [...ALL_IDS, ...NEW_IDS].join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

function samples() {
  const key = [...kv.store.keys()].find((k) => k.startsWith("samples:"));
  return JSON.parse(kv.store.get(key));
}
const callsTo = (url) => net.calls.filter((c) => c.url === url).length;

test("each new service is checked at its verified feed and its API check address", async () => {
  await runOnce(worker, env);
  const s = samples();
  for (const [id, want] of Object.entries(NEW_SERVICES)) {
    const feed = s.feeds.find((f) => f.service === id);
    const probe = s.probes.find((p) => p.service === id);
    assert.ok(feed, id + " feed sample");
    assert.equal(feed.url, want.feed, id + " feed address");
    assert.ok(probe, id + " check sample");
    assert.equal(probe.url, want.probe, id + " check address");
  }
});

test("Windsurf stays hidden (v1.19.0): status.json lists exactly the 20 public ones", async () => {
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  assert.deepEqual(body.services.map((x) => x.id).sort(), [...ALL_IDS].sort());
  assert.equal(ALL_IDS.length, 20);
  assert.ok(!ALL_IDS.includes("windsurf"));
});

test("shared feeds are downloaded once a run: Cursor with Grok, Claude Code with Claude", async () => {
  await runOnce(worker, env);
  assert.equal(callsTo(URLS.xai.feed), 1);
  assert.equal(callsTo(URLS.claude.feed), 1);
  net.calls.length = 0;
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(callsTo(URLS.xai.feed), 1);
  assert.equal(callsTo(URLS.claude.feed), 1);
});

test("shared API checks run once a run: Claude Code with Claude, Codex with OpenAI", async () => {
  await runOnce(worker, env);
  assert.equal(callsTo(URLS.claude.probe), 1);
  assert.equal(callsTo(URLS.openai.probe), 1);
});

test("a shared feed still answers for each service: Grok and Claude stay correct", async () => {
  start({ [URLS.xai.feed]: () => json(xaiSummary({ "cursor-com": "major_outage", "cursor-desktop": "major_outage" })) });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  const xai = body.services.find((x) => x.id === "xai");
  assert.equal(xai.official.status, "operational", "Cursor parts never count for Grok");
});

test("a shared check answer is the same for both services in the samples", async () => {
  await runOnce(worker, env);
  const s = samples();
  const pick = (id) => s.probes.find((p) => p.service === id);
  assert.equal(pick("claude-code").http_status, pick("claude").http_status);
  assert.equal(pick("codex").http_status, pick("openai").http_status);
});

test("a shared feed that fails is one download, read by both services", async () => {
  start({ [URLS.xai.feed]: () => html("<html>bad gateway</html>", 502) });
  await runOnce(worker, env);
  assert.equal(callsTo(URLS.xai.feed), 1);
  const { body } = await getStatus(worker, env);
  for (const id of ["xai", "cursor"]) assert.equal(body.services.find((x) => x.id === id).official.status, "unknown", id);
});

test("Windsurf's unverified check keeps the first characters of its answer for review", async () => {
  await runOnce(worker, env);
  const s = samples();
  for (const id of ["windsurf"]) {
    const p = s.probes.find((x) => x.service === id);
    assert.ok(p.first_chars && p.first_chars.length > 0, id + " keeps a peek of its answer");
  }
});
