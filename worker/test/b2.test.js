// v1.12.0 (Nov 10, 2026): Step B2 from the v1.11.0 samples.
// - GitHub Copilot is listed. Its API server answered HTTP 400 "bad request:
//   missing required Authorization header" (text/plain): GitHub's own server
//   refusing a request without a key, so 400 counts as answering (Copilot only).
// - OpenRouter is listed with no official feed (Datadog status page, no
//   documented public reader feed). Its check moves to /api/v1/key, which
//   needs a key (sampled: 401), so a cached copy cannot answer for it.
// - DeepInfra stays hidden; its documented keyless JSON API is sampled once.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, memoryKV, json, healthyRoutes, installFetch, clock, captureLogs, makeEnv, runOnce, getStatus, svc,
} from "./helpers.js";

const DEEPINFRA = {
  "https://api.deepinfra.com/v1/openai/models": () => json({ object: "list", data: [] }, 200),
  "https://status.deepinfra.com/api/v1/status": () => json({ schemaVersion: 1, overall: "operational" }),
  "https://status.deepinfra.com/api/v1": () => json({ schemaVersion: 1 }),
};
const GH = URLS["github-copilot"];
const github = (over = {}) => {
  const merged = { Actions: "operational", Copilot: "operational", "Copilot AI Model Providers": "operational", ...over };
  return { status: { indicator: "none" }, components: Object.entries(merged).map(([name, status]) => ({ name, status })) };
};

let clk, net, logs, kv, env;
function setup(extra = {}) {
  if (net) net.restore();
  net = installFetch({ ...healthyRoutes(), ...DEEPINFRA, ...extra });
}
beforeEach(() => {
  clk = clock("2026-11-10T12:00:00Z");
  logs = captureLogs();
  setup();
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

const savedSamples = () => JSON.parse(kv.store.get([...kv.store.keys()].find((k) => k.startsWith("samples:"))));
const alerts = () => net.discord.map((d) => d.body.content);

test("OpenRouter and GitHub Copilot are public", async () => {
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  for (const id of ["openrouter", "github-copilot"]) assert.ok(body.services.some((s) => s.id === id), id);
});

// ---------- GitHub Copilot ----------

test("GitHub Copilot is on the board with both signals", async () => {
  await runOnce(worker, env);
  const s = svc((await getStatus(worker, env)).body, "github-copilot");
  assert.ok(s);
  assert.equal(s.name, "GitHub Copilot");
  assert.equal(s.status_page, "https://www.githubstatus.com");
  assert.equal(s.official.status, "operational");
  assert.equal(s.probe.status, "reachable", "GitHub's 400 'missing Authorization header' means its server answered");
  assert.equal(s.probe.http_status, 400);
  assert.equal(s.overall, "operational");
});

test("GitHub Copilot's official status follows the Copilot components only", async () => {
  setup({ [GH.feed]: () => json(github({ Copilot: "partial_outage" })) });
  await runOnce(worker, env);
  assert.equal(svc((await getStatus(worker, env)).body, "github-copilot").official.status, "partial_outage");
  setup({ [GH.feed]: () => json(github({ Actions: "major_outage" })) });
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(svc((await getStatus(worker, env)).body, "github-copilot").official.status, "operational");
});

test("a 400 counts as answering for GitHub Copilot only", async () => {
  setup({ [URLS.openai.probe]: () => new Response("bad request", { status: 400 }) });
  await runOnce(worker, env);
  const body = (await getStatus(worker, env)).body;
  assert.equal(svc(body, "openai").probe.status, "unknown", "OpenAI's check never sends 400; treat it as odd");
  assert.equal(svc(body, "github-copilot").probe.status, "reachable");
});

test("GitHub Copilot's server failing twice while GitHub says fine is flagged", async () => {
  setup({ [GH.probe]: () => json({ e: 1 }, 503) });
  for (let i = 0; i < 2; i++) { await runOnce(worker, env); clk.advance(5); }
  assert.equal(svc((await getStatus(worker, env)).body, "github-copilot").overall, "signals_disagree");
  assert.ok(alerts().some((m) => /GitHub Copilot/.test(m)), "alerts channel told");
});

test("GitHub Copilot's feed failing shows Unknown, never green", async () => {
  setup({ [GH.feed]: () => json({ error: "nope" }, 404) });
  await runOnce(worker, env);
  const s = svc((await getStatus(worker, env)).body, "github-copilot");
  assert.equal(s.official.status, "unknown");
  assert.equal(s.overall, "unknown");
});

// ---------- OpenRouter ----------

test("OpenRouter is on the board as our check only, with its status page linked", async () => {
  await runOnce(worker, env);
  const s = svc((await getStatus(worker, env)).body, "openrouter");
  assert.ok(s);
  assert.equal(s.name, "OpenRouter");
  assert.equal(s.status_page, "https://status.openrouter.ai");
  assert.equal(s.official.status, "unknown");
  assert.equal(s.official.note, "No official public feed");
  assert.equal(s.probe.status, "reachable");
  assert.equal(s.probe.http_status, 401);
  assert.equal(s.overall, "check_ok");
});

test("OpenRouter's check asks the key endpoint, never the cacheable model list", async () => {
  await runOnce(worker, env);
  const urls = net.calls.map((c) => c.url);
  assert.ok(urls.includes("https://openrouter.ai/api/v1/key"));
  assert.ok(!urls.includes("https://openrouter.ai/api/v1/models"));
  assert.ok(!urls.some((u) => u.startsWith("https://status.openrouter.ai")), "no feed to fetch");
});

test("OpenRouter failing twice is reported as our check failing", async () => {
  setup({ [URLS.openrouter.probe]: () => json({ e: 1 }, 502) });
  for (let i = 0; i < 2; i++) { await runOnce(worker, env); clk.advance(5); }
  assert.equal(svc((await getStatus(worker, env)).body, "openrouter").overall, "check_failed");
  assert.ok(alerts().some((m) => /OpenRouter/.test(m)));
});

// ---------- DeepInfra (hidden) and samples ----------

test("samples already reviewed are not fetched again", async () => {
  await runOnce(worker, env);
  const urls = net.calls.map((c) => c.url);
  for (const u of ["https://status.deepinfra.com/api", "https://status.deepinfra.com/status.atom"]) {
    assert.ok(!urls.includes(u), u);
  }
  assert.equal(urls.filter((u) => u === "https://openrouter.ai/api/v1/key").length, 1, "the key endpoint is now the check, fetched once");
});

test("a normal run makes the same number of requests as before", async () => {
  await runOnce(worker, env);
  net.calls.length = 0;
  clk.advance(5);
  await runOnce(worker, env);
  // v1.13.0: 12 feeds + 15 checks (DeepInfra's feed added).
  assert.equal(net.calls.length, 27);
});
