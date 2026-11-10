// Per-service history pages (v1.7.0): /status/<id>/ for every service, the
// board's links to them, the sitemap and llms.txt. Nothing here ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { SHELL } from "../site/board.js";
import { historyItems } from "../site/service.js";
import { renderServicePage, pageNames, PAGE_LOG_START } from "../tools/status-pages.mjs";

const SITE = (f) => readFileSync(new URL("../site/" + f, import.meta.url), "utf8");
const page = (id) => SITE("status/" + id + "/index.html");
const URL_FOR = (id) => "https://liveoutageradar.com/status/" + id + "/";

// ---------- history wording ----------

const entry = (incidents, extra = {}) => ({ id: "claude", name: "Claude", since_utc: "2026-11-08T20:00:00Z", incidents, ...extra });
const inc = (over = {}) => ({
  started_utc: "2026-11-12T14:05:00Z", ended_utc: "2026-11-12T14:47:00Z", worst: "major_outage",
  kind: "official", minutes: 42, end_confirmed: true, ...over,
});

test("history says when logging started, with the year", () => {
  assert.equal(historyItems(entry([]), { name: "Claude" }).since, "History logged by OutageRadar since Nov 8, 2026.");
  assert.deepEqual(historyItems(entry([]), { name: "Claude" }).items, []);
});

test("a finished incident reads as a time range, a label and a length", () => {
  const [it] = historyItems(entry([inc()]), { name: "Claude" }).items;
  assert.deepEqual(it, { when: "Nov 12, 14:05 - 14:47 UTC", what: "Major outage", length: "42 min", notes: [] });
});

test("an incident crossing midnight shows both dates", () => {
  const [it] = historyItems(entry([inc({ started_utc: "2026-11-12T23:50:00Z", ended_utc: "2026-11-13T00:20:00Z", minutes: 30 })]), { name: "Claude" }).items;
  assert.equal(it.when, "Nov 12, 23:50 UTC - Nov 13, 00:20 UTC");
});

test("an ongoing incident says so", () => {
  const [it] = historyItems(entry([inc({ ended_utc: null, minutes: 12 })]), { name: "Claude" }).items;
  assert.equal(it.when, "Nov 12, 14:05 UTC - ongoing");
  assert.equal(it.length, "12 min so far");
});

test("our-check-only incidents are labelled, differently when there is no official feed", () => {
  const ours = inc({ worst: "signals_disagree", kind: "our_check", minutes: 10 });
  let [it] = historyItems(entry([ours]), { name: "Claude" }).items;
  assert.equal(it.what, "Our check failed");
  assert.deepEqual(it.notes, ["Seen by our check only; not confirmed on Claude's status page"]);
  [it] = historyItems(entry([inc({ worst: "check_failed", kind: "our_check" })]), { name: "Gemini", nofeed: true }).items;
  assert.deepEqual(it.notes, ["Seen by our check only (Gemini publishes no status feed)"]);
});

test("an unconfirmed end is shown as approximate with a note", () => {
  const [it] = historyItems(entry([inc({ end_confirmed: false, minutes: 40 })]), { name: "Claude" }).items;
  assert.equal(it.length, "about 40 min");
  assert.deepEqual(it.notes, ["End not confirmed: no clear signal for 2 hours"]);
});

test("damaged entries are skipped, a damaged log gives nothing", () => {
  const out = historyItems(entry([inc(), { worst: 3 }, null, inc({ started_utc: "nope" })]), { name: "Claude" });
  assert.equal(out.items.length, 1);
  assert.equal(historyItems(null, { name: "Claude" }), null);
  assert.equal(historyItems({ since_utc: "x", incidents: [] }, { name: "Claude" }), null);
});

// ---------- the pages ----------

test("every service on the board has a page, identical to what the generator makes", () => {
  for (const s of SHELL) {
    assert.ok(existsSync(new URL("../site/status/" + s.id + "/index.html", import.meta.url)), s.id);
    assert.equal(page(s.id), renderServicePage(s, SHELL), s.id + " is out of date: run node tools/status-pages.mjs");
  }
});

test("each page has its own search title, description, heading and canonical address", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    const n = pageNames(s);
    assert.match(html, new RegExp("<title>Is " + n.short.replace(/[/]/g, "\\/") + " down\\?"), s.id);
    assert.match(html, new RegExp("<h1[^>]*>Is " + n.short.replace(/[/]/g, "\\/") + " down\\?</h1>"), s.id);
    assert.ok(html.includes('<link rel="canonical" href="' + URL_FOR(s.id) + '">'), s.id);
    const desc = html.match(/<meta name="description" content="([^"]+)">/)[1];
    assert.ok(desc.startsWith("Is ") && desc.length >= 60 && desc.length <= 165, s.id + ": " + desc.length);
  }
  const titles = new Set(SHELL.map((s) => page(s.id).match(/<title>([^<]+)<\/title>/)[1]));
  assert.equal(titles.size, SHELL.length, "titles are unique");
});

test("each page carries valid WebPage and breadcrumb data, and no FAQ markup", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1, s.id);
    const data = JSON.parse(blocks[0][1]);
    const types = data["@graph"].map((x) => x["@type"]);
    assert.deepEqual(types.sort(), ["BreadcrumbList", "WebPage"], s.id);
    assert.doesNotMatch(html, /FAQPage/);
  }
});

test("each page links to the official status page, the board and the other nine pages", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    assert.ok(html.includes('href="' + s.status_page + '"'), s.id);
    assert.ok(html.includes('href="/"'), s.id);
    for (const o of SHELL) if (o.id !== s.id) assert.ok(html.includes('href="/status/' + o.id + '/"'), s.id + " -> " + o.id);
  }
});

test("each history page offers that service's RSS feed", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    const url = "https://data.liveoutageradar.com/feed/" + s.id + ".xml";
    assert.ok(html.includes('<link rel="alternate" type="application/rss+xml" title="OutageRadar: ' + s.name.replace(/&/g, "&amp;") + ' incidents (RSS)" href="' + url + '">'), s.id);
    assert.ok(html.includes('<a href="' + url + '">RSS feed</a>'), s.id);
  }
});

test("each page says from when history is logged before any script runs", () => {
  for (const s of SHELL) assert.ok(page(s.id).includes("History logged by OutageRadar since " + PAGE_LOG_START), s.id);
});

test("pages load only our own scripts, set no cookies and store nothing", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ["/service.js"], s.id);
    assert.doesNotMatch(html, /<link[^>]+href="https?:\/\/(?!liveoutageradar\.com)[^"]*"[^>]*rel="stylesheet"|fonts\.googleapis/);
    assert.match(html, new RegExp('<body data-service="' + s.id + '">'), s.id);
  }
  const js = SITE("service.js");
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.match(js, /import \{[^}]*\} from "\.\/board\.js";/);
  for (const u of js.match(/https?:\/\/[^\s"'`)]+/g) || []) assert.match(u, /^https:\/\/data\.liveoutageradar\.com\//, u);
});

test("pages never show green before data arrives", () => {
  for (const s of SHELL) {
    const body = page(s.id).split("</head>")[1];
    assert.match(body, /class="row s-checking"/, s.id);
    assert.doesNotMatch(body, /s-operational/, s.id);
  }
});

// ---------- links, sitemap, llms.txt ----------

test("every board row links to its history page with descriptive text", () => {
  const html = SITE("index.html");
  for (const s of SHELL) {
    const full = pageNames(s).full.replace(/\//g, "\\/");
    assert.match(html, new RegExp('<a class="hl" href="/status/' + s.id + '/">' + full + " outage history</a>"), s.id);
  }
  assert.match(SITE("board.js"), /class="hl" href="\/status\//, "rows the script adds get the link too");
});

test("the board script only starts on the board page", () => {
  assert.match(SITE("board.js"), /getElementById\("services"\)/);
});

test("the sitemap lists every history page", () => {
  const xml = SITE("sitemap.xml");
  for (const s of SHELL) assert.ok(xml.includes("<loc>" + URL_FOR(s.id) + "</loc>"), s.id);
  assert.ok(xml.includes("<loc>https://liveoutageradar.com/</loc>"));
});

test("llms.txt describes the site, its pages and its data", () => {
  const txt = SITE("llms.txt");
  assert.match(txt, /^# OutageRadar\n/);
  assert.ok([...Buffer.from(txt)].every((b) => b < 128), "ASCII only");
  for (const s of SHELL) assert.ok(txt.includes(URL_FOR(s.id)), s.id);
  assert.match(txt, /https:\/\/data\.liveoutageradar\.com\/status\.json/);
  assert.match(txt, /https:\/\/data\.liveoutageradar\.com\/incidents\.json/);
  assert.match(txt, /https:\/\/data\.liveoutageradar\.com\/feed\.xml/);
  assert.match(txt, /https:\/\/data\.liveoutageradar\.com\/feed\/<id>\.xml/);
  assert.match(txt, /not affiliated/i);
  assert.doesNotMatch(txt, /\bten\b/i);
  assert.doesNotMatch(txt, /\b(twelve|fourteen)\b/i);
  assert.match(txt, /fifteen AI services/);
  assert.match(txt, /Gemini, DeepSeek and OpenRouter publish no status feed/);
});

test("the sitemap lists exactly the board, every history page and the privacy page", () => {
  const locs = [...SITE("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  // Board + history pages + privacy + the /errors/ hub + 8 error pages (v1.14.0).
  assert.equal(locs.length, SHELL.length + 2 + 1 + 8);
  assert.equal(new Set(locs).size, locs.length, "no duplicates");
});
