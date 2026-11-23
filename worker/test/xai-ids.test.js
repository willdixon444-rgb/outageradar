// v1.22.2 (Nov 22, 2026): xAI renamed the parts on its status feed on
// Nov 19 (17:35 UTC), e.g. "Global (api.x.ai)" became "Grok API: Chat
// (Global, api.x.ai)" and "cursor.com" became "Grok Build and Cursor:
// cursor.com". We matched by name, found none, and showed Grok and Cursor
// as Unknown (safe, but for 3.5 days). The ids did not change, so Grok and
// Cursor are now matched by id, and every part we track must be there.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, memoryKV, json, xaiSummary, healthyRoutes, installFetch, clock, captureLogs, makeEnv, runOnce, getStatus,
} from "./helpers.js";

let clk, net, logs, env;
function start(extra = {}) {
  if (net) net.restore();
  net = installFetch({ ...healthyRoutes(), ...extra });
}
beforeEach(() => {
  clk = clock("2026-11-22T12:00:00Z");
  logs = captureLogs();
  net = null;
  start();
  env = makeEnv(memoryKV(), { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

async function board(feed) {
  start({ [URLS.xai.feed]: () => json(feed) });
  clk.advance(5);
  await runOnce(worker, env);
  const { body } = await getStatus(worker, env);
  return (id) => body.services.find((x) => x.id === id);
}

test("today's xAI feed (new names): Grok and Cursor read as operational", async () => {
  const get = await board(xaiSummary());
  for (const id of ["xai", "cursor"]) {
    assert.equal(get(id).official.status, "operational", id);
    assert.equal(get(id).official.note || "", "", id + " has no feed-problem note");
  }
});

test("another rename with the same ids still works", async () => {
  const get = await board(xaiSummary({}, { rename: {
    "api-global": "API (global)", "grok-com": "Grok web", "cursor-com": "Cursor website",
    "cursor-desktop": "Cursor for desktop", "cursor-cli": "Cursor command line",
  } }));
  assert.equal(get("xai").official.status, "operational");
  assert.equal(get("cursor").official.status, "operational");
});

test("the old names alone, without our ids, are a feed problem", async () => {
  const feed = {
    status: { indicator: "none" },
    components: [
      { name: "Global (api.x.ai)", status: "available" }, { name: "grok.com", status: "available" },
      { name: "cursor.com", status: "available" }, { name: "Cursor IDE (Desktop)", status: "available" },
      { name: "CLI", status: "available" },
    ],
  };
  const get = await board(feed);
  assert.equal(get("xai").official.status, "unknown");
  assert.match(get("xai").official.note, /expected components missing/);
  assert.equal(get("cursor").official.status, "unknown");
});

test("one tracked part missing is a feed problem for that service only", async () => {
  const get = await board(xaiSummary({}, { drop: ["cursor-cli"] }));
  assert.equal(get("cursor").official.status, "unknown");
  assert.match(get("cursor").official.note, /expected components missing/);
  assert.equal(get("xai").official.status, "operational", "Grok's own parts are all there");
});

test("a missing Grok part flags Grok, not Cursor", async () => {
  const get = await board(xaiSummary({}, { drop: ["grok-com"] }));
  assert.equal(get("xai").official.status, "unknown");
  assert.equal(get("cursor").official.status, "operational");
});

test("a Cursor outage counts for Cursor only, and the worst part wins", async () => {
  const get = await board(xaiSummary({ "cursor-desktop": "partial_outage", "cursor-cli": "major_outage" }));
  assert.equal(get("cursor").official.status, "major_outage");
  assert.equal(get("xai").official.status, "operational");
});

test("a Grok API outage counts for Grok; other xAI parts never count", async () => {
  const get = await board(xaiSummary({ "api-global": "major_outage" }));
  assert.equal(get("xai").official.status, "major_outage");
  const get2 = await board(xaiSummary({ "api-us": "major_outage", "cloud-agents": "major_outage" }));
  assert.equal(get2("xai").official.status, "operational", "only api-global and grok-com count for Grok");
  assert.equal(get2("cursor").official.status, "operational", "Cloud Agents is not a part we track");
});

test("an unknown xAI status word is Unknown, never up", async () => {
  const get = await board(xaiSummary({ "grok-com": "something new" }));
  assert.equal(get("xai").official.status, "unknown");
});
