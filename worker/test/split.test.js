// v1.20.0 (Nov 15, 2026): the Claude and OpenAI rows count only their API
// parts. Their apps (claude.ai, ChatGPT) get a separate line from the same
// feed, so an app-only problem never makes the API look down. Part names were
// read from the live feeds on Nov 15, 2026 (claude.ai was degraded while the
// Claude API was operational).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, API_PARTS, memoryKV, json, claudeSummary, codexParts, healthyRoutes,
  installFetch, clock, captureLogs, makeEnv, runOnce, getStatus,
} from "./helpers.js";

let clk, net, logs, env;
function start(extra = {}) {
  if (net) net.restore();
  net = installFetch({ ...healthyRoutes(), ...extra });
}
beforeEach(() => {
  clk = clock("2026-11-16T01:30:00Z");
  logs = captureLogs();
  net = null;
  start();
  env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

async function row(id, runs = 1) {
  for (let i = 0; i < runs; i++) { clk.advance(5); await runOnce(worker, env); }
  const { body } = await getStatus(worker, env);
  return body.services.find((x) => x.id === id);
}

test("claude.ai degraded, Claude API fine: the Claude row is Operational, with the app on its own line", async () => {
  start({ [URLS.claude.feed]: () => json(claudeSummary("minor", "operational", "operational", "degraded_performance")) });
  const c = await row("claude");
  assert.equal(c.official.status, "operational");
  assert.equal(c.overall, "operational");
  assert.equal(c.official.scope, "api");
  assert.deepEqual(c.official.app, { label: "claude.ai app", status: "degraded" });
});

test("a Claude API problem is a Claude problem", async () => {
  start({ [URLS.claude.feed]: () => json(claudeSummary("critical", "operational", "major_outage", "operational")) });
  const c = await row("claude");
  assert.equal(c.official.status, "major_outage");
  assert.equal(c.official.app.status, "operational");
});

test("ChatGPT down, OpenAI API fine: the OpenAI row is Operational, with ChatGPT on its own line", async () => {
  start({ [URLS.openai.feed]: () => json(codexParts("operational", "operational", "major_outage")) });
  const o = await row("openai");
  assert.equal(o.official.status, "operational");
  assert.equal(o.official.scope, "api");
  assert.deepEqual(o.official.app, { label: "ChatGPT app", status: "major_outage" });
});

test("one OpenAI API part in trouble makes the OpenAI row show it; Codex is not affected", async () => {
  start({ [URLS.openai.feed]: () => json({ components: codexParts().components.map((c) =>
    c.name === "Responses" ? { ...c, status: "partial_outage" } : c) }) });
  const o = await row("openai");
  assert.equal(o.official.status, "partial_outage");
  const { body } = await getStatus(worker, env);
  assert.equal(body.services.find((x) => x.id === "codex").official.status, "operational");
});

test("the OpenAI row counts every API part and never Login (its name is shared with ChatGPT)", async () => {
  for (const name of API_PARTS.openai) {
    start({ [URLS.openai.feed]: () => json({ components: codexParts().components.map((c) =>
      c.name === name ? { ...c, status: "major_outage" } : c) }) });
    assert.equal((await row("openai")).official.status, "major_outage", name);
  }
  start({ [URLS.openai.feed]: () => json({ components: codexParts().components.map((c) =>
    c.name === "Login" ? { ...c, status: "major_outage" } : c) }) });
  assert.equal((await row("openai")).official.status, "operational");
});

test("the OpenAI and Codex rows share one download of OpenAI's parts feed", async () => {
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(net.calls.filter((c) => c.url === URLS.openai.feed).length, 1);
  assert.equal(net.calls.filter((c) => c.url.includes("status.openai.com")).length, 1, "status.json is no longer fetched");
});

test("a normal run is one request fewer (OpenAI's old status.json is gone)", async () => {
  clk.advance(5);
  await runOnce(worker, env);
  net.calls.length = 0;
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(net.calls.length, 34);
});

test("a missing app part leaves the app line Unknown and is not a feed problem", async () => {
  start({ [URLS.claude.feed]: () => json({ components: [
    { name: "Claude API (api.anthropic.com)", status: "operational" }, { name: "Claude Code", status: "operational" }] }) });
  const c = await row("claude", 4);
  assert.equal(c.official.status, "operational");
  assert.equal(c.official.app.status, "unknown");
  assert.doesNotMatch(net.discord.map((d) => d.body.content).join("\n"), /FEED PROBLEM/);
});

test("a missing API part is a broken feed, never a guess", async () => {
  start({ [URLS.claude.feed]: () => json({ components: [{ name: "claude.ai", status: "operational" }] }) });
  const c = await row("claude");
  assert.equal(c.official.status, "unknown");
});

test("an app-only outage sends no outage alert; an API outage does", async () => {
  start({ [URLS.claude.feed]: () => json(claudeSummary("critical", "operational", "operational", "major_outage")) });
  await row("claude", 3);
  assert.doesNotMatch(net.discord.map((d) => d.body.content).join("\n"), /\bClaude\b.*(Major outage|MAJOR)/i);
  start({ [URLS.claude.feed]: () => json(claudeSummary("critical", "operational", "major_outage", "operational")) });
  await row("claude", 3);
  assert.match(net.discord.map((d) => d.body.content).join("\n"), /Claude/);
});

test("services without an app line have no app field", async () => {
  const m = await row("mistral");
  assert.equal(m.official.app, undefined);
  assert.equal(m.official.scope, undefined);
});

test("before approval the app line is Unknown too, like the API status", async () => {
  env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL_IDS.filter((id) => id !== "claude").join(",") });
  start({ [URLS.claude.feed]: () => json(claudeSummary("minor", "operational", "operational", "degraded_performance")) });
  const c = await row("claude");
  assert.equal(c.official.status, "unknown");
  assert.equal(c.official.app.status, "unknown");
});
