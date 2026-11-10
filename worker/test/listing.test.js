// v1.11.0 (Nov 9, 2026): Step B1 from the v1.10.0 samples.
// - Together AI (Better Stack feed) and Fireworks AI (Statuspage-format feed)
//   are listed; both API servers answer 401 without a key.
// - GitHub Copilot gets its feed mapping (two Copilot components on
//   githubstatus.com) but stays hidden until its probe reply is confirmed.
// - Microsoft Copilot is parked: removed, never contacted.
// - Sample guesses that failed are retired; new one-time samples are added.
// - Odd probe replies keep their first characters for review.
// - Stale data never lists hidden services.
// v1.12.0 moved the version check, the GitHub Copilot listing and the samples
// list to b2.test.js; what stays here still holds.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, memoryKV, json, betterstack, statuspage, healthyRoutes, installFetch, clock, captureLogs,
  makeEnv, runOnce, getStatus, svc,
} from "./helpers.js";

const HIDDEN_ROUTES = {
  "https://api.deepinfra.com/v1/openai/models": () => json({ object: "list", data: [] }, 200),
};

function github(over) {
  const base = {
    "Git Operations": "operational", Actions: "operational",
    Copilot: "operational", "Copilot AI Model Providers": "operational",
  };
  const merged = { ...base, ...over };
  return {
    status: { indicator: "none" },
    components: Object.entries(merged).map(([name, status]) => ({ id: name, name, status })),
    incidents: [],
  };
}

let clk, net, logs, kv, env;
function setup(extra = {}) {
  if (net) net.restore();
  net = installFetch({ ...healthyRoutes(), ...HIDDEN_ROUTES, ...extra });
}
beforeEach(() => {
  clk = clock("2026-11-09T12:00:00Z");
  logs = captureLogs();
  setup();
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

const savedSamples = () => JSON.parse(kv.store.get([...kv.store.keys()].find((k) => k.startsWith("samples:"))));
const savedState = () => JSON.parse(kv.store.get("state:v1"));

// ---------- Together AI and Fireworks AI on the board ----------

test("Together AI and Fireworks AI are on the board with both signals", async () => {
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  for (const [id, name, page] of [
    ["together", "Together AI", "https://status.together.ai"],
    ["fireworks", "Fireworks AI", "https://status.fireworks.ai"],
  ]) {
    const s = svc(body, id);
    assert.ok(s, id + " is listed");
    assert.equal(s.name, name);
    assert.equal(s.status_page, page);
    assert.equal(s.official.status, "operational", id);
    assert.equal(s.probe.status, "reachable", id + ": a 401 without a key means the API server answered");
    assert.equal(s.probe.http_status, 401);
    assert.equal(s.overall, "operational", id);
    assert.ok(Array.isArray(s.incidents.list) || s.incidents, id + " keeps an incident log");
  }
});

test("until approved, the new rows show Unknown, never green", async () => {
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL_IDS.filter((id) => id !== "together" && id !== "fireworks").join(",") });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  for (const id of ["together", "fireworks"]) {
    assert.equal(svc(body, id).overall, "unknown", id);
    assert.equal(svc(body, id).official.note, "Mapping not approved yet", id);
  }
});

test("Together reads the Better Stack state, like Hugging Face", async () => {
  setup({ [URLS.together.feed]: () => json(betterstack("degraded")) });
  await runOnce(worker, env);
  let s = svc((await getStatus(worker, env)).body, "together");
  assert.equal(s.official.status, "degraded");
  setup({ [URLS.together.feed]: () => json(betterstack("downtime")) });
  clk.advance(5);
  await runOnce(worker, env);
  s = svc((await getStatus(worker, env)).body, "together");
  assert.equal(s.official.status, "major_outage");
});

test("Fireworks reads the overall indicator, not its per-model components", async () => {
  const feed = { ...statuspage("minor"), components: [{ name: "Kimi K3", status: "operational" }] };
  setup({ [URLS.fireworks.feed]: () => json(feed) });
  await runOnce(worker, env);
  assert.equal(svc((await getStatus(worker, env)).body, "fireworks").official.status, "degraded");
  // An incident the provider rates as no impact keeps the indicator at none.
  const quiet = { ...statuspage("none"), components: [{ name: "Kimi K3", status: "degraded_performance" }],
    incidents: [{ name: "Service degradation", status: "monitoring", impact: "none" }] };
  setup({ [URLS.fireworks.feed]: () => json(quiet) });
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(svc((await getStatus(worker, env)).body, "fireworks").official.status, "operational");
});

test("a broken Together or Fireworks feed shows Unknown, never green", async () => {
  setup({
    [URLS.together.feed]: () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }),
    [URLS.fireworks.feed]: () => json({ error: "nope" }, 503),
  });
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  for (const id of ["together", "fireworks"]) {
    assert.equal(svc(body, id).official.status, "unknown", id);
    assert.equal(svc(body, id).overall, "unknown", id);
  }
});

// ---------- GitHub Copilot: mapped, still hidden ----------

test("GitHub Copilot's feed takes the worse of its two Copilot components", async () => {
  setup({ "https://www.githubstatus.com/api/v2/summary.json": () => json(github({ "Copilot AI Model Providers": "degraded_performance" })) });
  await runOnce(worker, env);
  assert.equal(savedState().services["github-copilot"].feed_preview, "degraded");
  setup({ "https://www.githubstatus.com/api/v2/summary.json": () => json(github({ Copilot: "major_outage", "Copilot AI Model Providers": "degraded_performance" })) });
  clk.advance(5);
  await runOnce(worker, env);
  assert.equal(savedState().services["github-copilot"].feed_preview, "major_outage");
});

test("GitHub Copilot ignores the rest of GitHub", async () => {
  setup({ "https://www.githubstatus.com/api/v2/summary.json": () => json(github({ Actions: "major_outage", "Git Operations": "partial_outage" })) });
  await runOnce(worker, env);
  assert.equal(savedState().services["github-copilot"].feed_preview, "operational");
});

// ---------- an odd probe reply is kept for review ----------

const TEAPOT = { [URLS.together.probe]: () => new Response("I'm a teapot", { status: 418, headers: { "content-type": "text/plain" } }) };

test("an unexpected probe reply keeps its first characters in the samples", async () => {
  setup(TEAPOT);
  await runOnce(worker, env);
  const p = savedSamples().probes.find((x) => x.service === "together");
  assert.equal(p.http_status, 418);
  assert.equal(p.result, "odd");
  assert.match(p.first_chars, /teapot/);
});

test("an odd probe reply still never counts as up", async () => {
  setup(TEAPOT);
  await runOnce(worker, env);
  assert.equal(svc((await getStatus(worker, env)).body, "together").probe.status, "unknown");
});

// ---------- Microsoft Copilot parked ----------

test("Microsoft Copilot is parked: never contacted and never saved", async () => {
  await runOnce(worker, env);
  const urls = net.calls.map((c) => c.url);
  assert.ok(!urls.some((u) => /microsoft/.test(u)), urls.filter((u) => /microsoft/.test(u)).join(" "));
  const s = savedSamples();
  assert.ok(!s.probes.concat(s.feeds).some((x) => x.service === "microsoft-copilot"));
});

// ---------- samples ----------

test("sample guesses that failed in v1.10.0 are not fetched again", async () => {
  await runOnce(worker, env);
  const urls = net.calls.map((c) => c.url);
  for (const u of [
    "https://status.openrouter.ai/",
    "https://status.openrouter.ai/api/v2/summary.json",
    "https://status.deepinfra.com/",
    "https://status.deepinfra.com/api/v2/summary.json",
    "https://status.together.ai/",
    "https://status.fireworks.ai/",
  ]) assert.ok(!urls.includes(u), u);
});

test("GitHub's feed is saved once in the samples, from the main run", async () => {
  await runOnce(worker, env);
  const gh = savedSamples().feeds.filter((f) => f.url === "https://www.githubstatus.com/api/v2/summary.json");
  assert.equal(gh.length, 1);
  assert.equal(gh[0].http_status, 200);
});

// ---------- stale data ----------

test("stale data lists only the public services, never hidden ones", async () => {
  await runOnce(worker, env);
  clk.advance(20); // no run for 20 minutes: data is stale
  const { body } = await getStatus(worker, env);
  assert.equal(body.stale, true);
  assert.deepEqual(body.services.map((s) => s.id).sort(), [...ALL_IDS].sort());
});

test("before any run, the placeholder lists only the public services", async () => {
  const { body } = await getStatus(worker, env);
  assert.deepEqual(body.services.map((s) => s.id).sort(), [...ALL_IDS].sort());
});
