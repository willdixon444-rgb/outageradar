// v1.14.0 (Nov 10, 2026): RSS 2.0 feeds of incidents, built on request from
// the incident log (no change to the 5-minute run, nothing stored about
// readers). One item per incident, updated in place when it ends (Will: "A").
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, memoryKV, failingKV, json, statuspage, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx, runOnce,
} from "./helpers.js";

let clk, net, logs, kv, env;
function setup(extra = {}) {
  if (net) net.restore();
  net = installFetch({ ...healthyRoutes(), ...extra });
}
beforeEach(() => {
  clk = clock("2026-11-12T14:00:00Z");
  logs = captureLogs();
  setup();
  kv = memoryKV();
  env = makeEnv(kv, { APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

const get = (path) => worker.fetch(new Request("https://data.liveoutageradar.com" + path), env, ctx);
async function feed(path) {
  const res = await get(path);
  return { res, xml: res.status === 200 ? await res.text() : "" };
}
function parses(xml) {
  const out = spawnSync("python3", ["-c", "import sys,xml.etree.ElementTree as ET; ET.fromstring(sys.stdin.read()); print('XML_OK')"], { input: xml, encoding: "utf8" });
  return out.status === 0 && /XML_OK/.test(out.stdout) ? true : out.stderr;
}
const items = (xml) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
const tag = (block, name) => { const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">")); return m ? m[1] : null; };

// A Claude major outage that starts now and ends after `minutes`.
async function claudeOutage(minutes) {
  setup({ [URLS.claude.feed]: () => json(statuspage("critical")) });
  await runOnce(worker, env);
  if (minutes === null) return;
  clk.advance(minutes);
  setup();
  await runOnce(worker, env);
  clk.advance(5);
  await runOnce(worker, env);
}

test("the all-services feed is valid RSS 2.0 with a self link", async () => {
  await claudeOutage(null);
  const { res, xml } = await feed("/feed.xml");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/rss+xml; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(parses(xml), true);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0" xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(xml, /<atom:link href="https:\/\/data\.liveoutageradar\.com\/feed\.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(tag(xml, "title"), /OutageRadar/);
  assert.equal(tag(xml, "link"), "https://liveoutageradar.com/");
});

test("an ongoing incident is one item that links to the history page", async () => {
  await claudeOutage(null);
  const [it] = items((await feed("/feed.xml")).xml);
  assert.equal(tag(it, "title"), "Claude: Major outage (ongoing)");
  assert.equal(tag(it, "link"), "https://liveoutageradar.com/status/claude/");
  assert.equal(tag(it, "pubDate"), "Thu, 12 Nov 2026 14:00:00 GMT");
  assert.match(tag(it, "description"), /Started 2026-11-12 14:00 UTC/);
  assert.match(tag(it, "description"), /official status/i);
  assert.match(it, /<guid isPermaLink="false">outageradar:claude:2026-11-12T14:00:00Z<\/guid>/);
});

test("when it ends, the same item is updated, not a second one (choice A)", async () => {
  await claudeOutage(null);
  const before = items((await feed("/feed.xml")).xml);
  clk.advance(42);
  setup();
  await runOnce(worker, env);
  clk.advance(5);
  await runOnce(worker, env);
  const after = items((await feed("/feed.xml")).xml);
  assert.equal(after.length, before.length, "no extra item");
  assert.equal(tag(after[0], "guid"), tag(before[0], "guid"), "same id");
  assert.equal(tag(after[0], "title"), "Claude: Major outage, 42 min (resolved)");
  assert.match(tag(after[0], "description"), /Ended 2026-11-12 14:42 UTC/);
  assert.equal(tag(after[0], "pubDate"), "Thu, 12 Nov 2026 14:00:00 GMT", "dated by its start");
});

test("a per-service feed has only that service; unknown ids are 404", async () => {
  await claudeOutage(30);
  const claude = (await feed("/feed/claude.xml")).xml;
  assert.equal(parses(claude), true);
  assert.equal(items(claude).length, 1);
  assert.match(claude, /<atom:link href="https:\/\/data\.liveoutageradar\.com\/feed\/claude\.xml"/);
  assert.equal(tag(claude, "link"), "https://liveoutageradar.com/status/claude/");
  const openai = (await feed("/feed/openai.xml")).xml;
  assert.equal(parses(openai), true);
  assert.equal(items(openai).length, 0, "an empty feed is still valid");
  for (const bad of ["/feed/microsoft-copilot.xml", "/feed/CLAUDE.xml", "/feed/claude/extra.xml", "/feed/claude.json", "/feed/.xml"]) {
    assert.equal((await get(bad)).status, 404, bad);
  }
});

test("our-check-only and end-not-confirmed incidents say so", async () => {
  await runOnce(worker, env);
  const state = JSON.parse(kv.store.get("state:v1"));
  const t = Date.parse("2026-11-11T09:00:00Z");
  state.incidents.deepseek = [{ start_ms: t, end_ms: t + 10 * 60000, worst: "check_failed", kind: "our_check", end_confirmed: true }];
  state.incidents.groq = [{ start_ms: t + 60000, end_ms: t + 40 * 60000, worst: "degraded", kind: "official", end_confirmed: false }];
  kv.store.set("state:v1", JSON.stringify(state));
  clk.advance(1);
  const xml = (await feed("/feed.xml")).xml;
  const ds = items(xml).find((i) => /DeepSeek/.test(tag(i, "title")));
  assert.match(tag(ds, "description"), /our own check only; not confirmed by the provider/i);
  const gq = items(xml).find((i) => /Groq/.test(tag(i, "title")));
  assert.equal(tag(gq, "title"), "Groq: Degraded, about 39 min (resolved)");
  assert.match(tag(gq, "description"), /End not confirmed/);
});

test("newest first, at most 50 items in the all-services feed", async () => {
  await runOnce(worker, env);
  const state = JSON.parse(kv.store.get("state:v1"));
  const base = Date.parse("2026-11-01T00:00:00Z");
  for (const [n, id] of ALL_IDS.entries()) {
    state.incidents[id] = Array.from({ length: 5 }, (_, k) => ({ start_ms: base + (n * 5 + k) * 3600000, end_ms: base + (n * 5 + k) * 3600000 + 600000, worst: "degraded", kind: "official", end_confirmed: true }));
  }
  kv.store.set("state:v1", JSON.stringify(state));
  clk.advance(1);
  const its = items((await feed("/feed.xml")).xml);
  assert.equal(its.length, 50);
  const dates = its.map((i) => Date.parse(tag(i, "pubDate")));
  assert.deepEqual(dates, dates.slice().sort((a, b) => b - a));
});

test("odd saved data cannot break the XML, and unlisted services never appear", async () => {
  await runOnce(worker, env);
  const state = JSON.parse(kv.store.get("state:v1"));
  const t = Date.parse("2026-11-11T09:00:00Z");
  state.incidents.claude = [{ start_ms: t, end_ms: null, worst: "<script>&\"'\u0001]]>", kind: "official", end_confirmed: true }];
  state.incidents["microsoft-copilot"] = [{ start_ms: t, end_ms: null, worst: "major_outage", kind: "official", end_confirmed: true }];
  state.incident_since["microsoft-copilot"] = t;
  kv.store.set("state:v1", JSON.stringify(state));
  clk.advance(1);
  const xml = (await feed("/feed.xml")).xml;
  assert.equal(parses(xml), true);
  assert.doesNotMatch(xml, /<script>|Microsoft/);
  assert.equal(tag(items(xml)[0], "title"), "Claude: Incident (ongoing)");
});

test("if saved data can't be read, the feed says so instead of looking empty", async () => {
  env = makeEnv(failingKV({ failGet: true }), {});
  const res = await get("/feed.xml");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
});
