// Latency on the board and history pages (v1.8.0). Nothing here ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeProbe } from "../site/board.js";

const probe = (over = {}) => ({ label: "API server answering (our check)", status: "reachable", http_status: 401, latency_ms: 312, ...over });

test("an answered check says how fast", () => {
  assert.deepEqual(describeProbe(probe()), { text: "Our check: API server responding in 312 ms", code: "HTTP 401, needs a key" });
});

test("a second or more reads in seconds", () => {
  assert.equal(describeProbe(probe({ latency_ms: 1234 })).text, "Our check: API server responding in 1.2 s");
  assert.equal(describeProbe(probe({ latency_ms: 999 })).text, "Our check: API server responding in 999 ms");
});

test("no time, or a nonsense time, leaves the line as before", () => {
  for (const latency_ms of [null, undefined, -5, "300", Infinity, 120000]) {
    assert.equal(describeProbe(probe({ latency_ms })).text, "Our check: API server responding", String(latency_ms));
  }
});

test("a check that failed never shows a time", () => {
  assert.equal(describeProbe(probe({ status: "unreachable" })).text, "Our check: API server not responding");
  assert.equal(describeProbe(probe({ status: "unknown" })).text, "Our check: couldn't check right now");
});

test("the board and every history page explain what the time means", () => {
  const explain = /how long the API server took to answer our check/;
  assert.match(readFileSync(new URL("../site/index.html", import.meta.url), "utf8"), explain);
  for (const id of ["openai", "claude", "gemini", "deepseek"]) {
    assert.match(readFileSync(new URL("../site/status/" + id + "/index.html", import.meta.url), "utf8"), explain, id);
  }
});
