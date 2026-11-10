// v1.13.0 (Nov 10, 2026): Step B3 from the v1.12.0 samples, plus AG review.
// - DeepInfra is listed. Official signal: the core "API" service in its
//   documented keyless /api/v1/status (not overallStatus, which may include
//   171 single models). isStale or a missing API entry means Unknown; any
//   status word we don't recognise means Unknown, never green.
// - GitHub Copilot's 400 counts only when the reply says the Authorization
//   header is missing (the real reply); any other 400 is Unknown.
// - Probe samples record whether GitHub's x-github-request-id header came back.
// - Public responses carry only listed services, checked at the last step.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, memoryKV, json, deepinfraStatus, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx,
  runOnce, getStatus, svc,
} from "./helpers.js";

let clk, net, logs, kv, env;
function setup(extra = {}) {
  if (net) net.restore();
  net = installFetch({ ...healthyRoutes(), ...extra });
}
beforeEach(() => {
  clk = clock("2026-11-10T12:00:00Z");
  logs = captureLogs();
  setup();
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

const DI = URLS.deepinfra;
const deep = async (over) => {
  setup({ [DI.feed]: () => json(deepinfraStatus(over)) });
  await runOnce(worker, env);
  clk.advance(5);
  return svc((await getStatus(worker, env)).body, "deepinfra");
};
const savedSamples = () => JSON.parse(kv.store.get([...kv.store.keys()].find((k) => k.startsWith("samples:"))));

test("this release is v1.13.0 and fifteen services are public", async () => {
  await runOnce(worker, env);
  assert.ok(kv.store.has("samples:v1.13.0"));
  const { body } = await getStatus(worker, env);
  assert.equal(body.services.length, 15);
});

// ---------- DeepInfra ----------

test("DeepInfra is on the board with both signals", async () => {
  const s = await deep({});
  assert.equal(s.name, "DeepInfra");
  assert.equal(s.status_page, "https://status.deepinfra.com");
  assert.equal(s.official.status, "operational");
  assert.equal(s.probe.status, "reachable");
  assert.equal(s.probe.http_status, 200);
  assert.equal(s.overall, "operational");
});

test("DeepInfra follows its API service, not the website or single models", async () => {
  assert.equal((await deep({ website: "MAJOR_OUTAGE" })).official.status, "operational");
  assert.equal((await deep({ overallStatus: "DEGRADED_PERFORMANCE" })).official.status, "operational");
  const models = [{ publicId: "x", status: "MAJOR_OUTAGE", checksFailingNow: true }];
  assert.equal((await deep({ models })).official.status, "operational");
});

test("DeepInfra's API status words map like other status pages", async () => {
  for (const [word, want] of [
    ["OPERATIONAL", "operational"], ["DEGRADED_PERFORMANCE", "degraded"], ["PARTIAL_OUTAGE", "partial_outage"],
    ["MAJOR_OUTAGE", "major_outage"], ["UNDER_MAINTENANCE", "maintenance"],
  ]) assert.equal((await deep({ api: word })).official.status, want, word);
});

test("a DeepInfra word we don't recognise is Unknown, never green", async () => {
  for (const word of ["NO_DATA", "SOMETHING_NEW", "", 5, null]) {
    const s = await deep({ services: [{ publicId: "api", status: word }] });
    assert.equal(s.official.status, "unknown", String(word));
    assert.notEqual(s.overall, "operational", String(word));
  }
});

test("DeepInfra marking its own data stale means Unknown", async () => {
  const s = await deep({ isStale: true });
  assert.equal(s.official.status, "unknown");
  assert.equal(s.overall, "unknown");
  assert.match(s.official.note, /stale/i);
});

test("a missing API entry or a broken feed means Unknown", async () => {
  assert.equal((await deep({ api: null })).official.status, "unknown");
  assert.equal((await deep({ services: "nope" })).official.status, "unknown");
  setup({ [DI.feed]: () => new Response("<html>down</html>", { status: 200, headers: { "content-type": "text/html" } }) });
  await runOnce(worker, env);
  assert.equal(svc((await getStatus(worker, env)).body, "deepinfra").official.status, "unknown");
});

// ---------- GitHub Copilot: the 400 must be GitHub's own reply ----------

test("Copilot's 400 counts only when it says the Authorization header is missing", async () => {
  await runOnce(worker, env);
  assert.equal(svc((await getStatus(worker, env)).body, "github-copilot").probe.status, "reachable");
  for (const body of ["Bad Request", "<html><h1>400 Bad Request</h1>cloudflare</html>", ""]) {
    setup({ [URLS["github-copilot"].probe]: () => new Response(body, { status: 400, headers: { "content-type": "text/html" } }) });
    clk.advance(5);
    await runOnce(worker, env);
    const s = svc((await getStatus(worker, env)).body, "github-copilot");
    assert.equal(s.probe.status, "unknown", JSON.stringify(body));
  }
});

test("a generic 400 for Copilot is saved with its text for review", async () => {
  setup({ [URLS["github-copilot"].probe]: () => new Response("Bad Request", { status: 400 }) });
  await runOnce(worker, env);
  const p = savedSamples().probes.find((x) => x.service === "github-copilot");
  assert.equal(p.result, "odd");
  assert.match(p.first_chars, /Bad Request/);
});

test("probe samples record whether GitHub's request-id header came back", async () => {
  setup({
    [URLS["github-copilot"].probe]: () => new Response("bad request: missing required Authorization header\n",
      { status: 400, headers: { "content-type": "text/plain", "x-github-request-id": "ABCD:1234" } }),
  });
  await runOnce(worker, env);
  const probes = savedSamples().probes;
  assert.equal(probes.find((x) => x.service === "github-copilot").headers["x-github-request-id"], "present");
  assert.equal(probes.find((x) => x.service === "openai").headers["x-github-request-id"], "");
  // Presence only: the id itself is never stored.
  assert.doesNotMatch(JSON.stringify(probes), /ABCD:1234/);
});

// ---------- public responses: listed services only, at the last step ----------

test("status.json drops any unlisted service, even from saved data", async () => {
  await runOnce(worker, env);
  const state = JSON.parse(kv.store.get("state:v1"));
  state.public.services.push({ ...state.public.services[0], id: "microsoft-copilot", name: "Microsoft Copilot" });
  kv.store.set("state:v1", JSON.stringify(state));
  const { body } = await getStatus(worker, env);
  assert.ok(!body.services.some((s) => s.id === "microsoft-copilot"));
  assert.equal(body.services.length, 15);
});

test("incidents.json drops any unlisted service, even from saved data", async () => {
  await runOnce(worker, env);
  const state = JSON.parse(kv.store.get("state:v1"));
  state.incidents["microsoft-copilot"] = [];
  state.incident_since["microsoft-copilot"] = Date.now();
  kv.store.set("state:v1", JSON.stringify(state));
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/incidents.json"), env, ctx);
  const ids = (await res.json()).services.map((s) => s.id);
  assert.ok(!ids.includes("microsoft-copilot"));
});
