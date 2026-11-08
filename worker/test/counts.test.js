// Page-view and link-click counts (v1.5) and the private /admin dashboard.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import { memoryKV, makeEnv, ctx, clock, captureLogs, getStatus, installFetch, healthyRoutes, runOnce } from "./helpers.js";
import { memoryD1, brokenD1 } from "./d1.js";

const KEY = "test-admin-key-0123456789-abcdefghij";
const SITE = "https://liveoutageradar.com";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1";
const FAKE_IP = "203.0.113.77";

let clk, logs, db, env;
beforeEach(() => {
  clk = clock("2026-11-07T12:00:00Z");
  logs = captureLogs();
  db = memoryD1();
  env = makeEnv(memoryKV(), { DB: db, ADMIN_KEY: KEY });
});
afterEach(() => { clk.restore(); logs.restore(); });

function beacon(path, fields, { origin = SITE, ua = BROWSER, country = "US", body } = {}) {
  const req = new Request("https://data.liveoutageradar.com" + path, {
    method: "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      "user-agent": ua,
      "cf-connecting-ip": FAKE_IP,
      ...(origin ? { origin } : {}),
    },
    body: body !== undefined ? body : new URLSearchParams(fields).toString(),
  });
  if (country !== null) Object.defineProperty(req, "cf", { value: { country } });
  return worker.fetch(req, env, ctx);
}
const view = (fields, opts) => beacon("/v", fields, opts);
const click = (fields, opts) => beacon("/c", fields, opts);

async function admin(path = "/admin/data", key = KEY) {
  const headers = key === null ? {} : { authorization: "Bearer " + key };
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com" + path, { headers }), env, ctx);
  return { res, body: (res.headers.get("content-type") || "").includes("json") ? await res.json() : await res.text() };
}

// ---------- counting page views ----------

test("a page view from our site is counted as one human view", async () => {
  const res = await view({ p: "/", r: "" });
  assert.equal(res.status, 204);
  assert.deepEqual(db.rows("views"), [{ day: "2026-11-07", page: "/", country: "US", source: "direct", bot: 0, n: 1 }]);
});

test("the same kind of view adds to one daily total instead of a new row", async () => {
  await view({ p: "/", r: "" });
  await view({ p: "/", r: "" });
  const rows = db.rows("views");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 2);
});

test("only counts are stored: no IP address, user agent or ID anywhere", async () => {
  await view({ p: "/", r: "google.com" });
  await click({ l: "tokenmargin.dev", p: "/" });
  const all = JSON.stringify([db.rows("views"), db.rows("clicks")]);
  assert.doesNotMatch(all, new RegExp(FAKE_IP.replace(/\./g, "\\.")));
  assert.doesNotMatch(all, /Mozilla|iPhone/);
  assert.deepEqual(Object.keys(db.rows("views")[0]).sort(), ["bot", "country", "day", "n", "page", "source"]);
  assert.deepEqual(Object.keys(db.rows("clicks")[0]).sort(), ["day", "link", "n", "page"]);
});

test("the referring site is stored as its domain, without www", async () => {
  await view({ p: "/", r: "www.google.com" });
  await view({ p: "/", r: "reddit.com" });
  const sources = db.rows("views").map((r) => r.source).sort();
  assert.deepEqual(sources, ["google.com", "reddit.com"]);
});

test("visits from our own pages count as internal, not as a referrer", async () => {
  await view({ p: "/", r: "liveoutageradar.com" });
  await view({ p: "/", r: "data.liveoutageradar.com" });
  assert.deepEqual(db.rows("views").map((r) => r.source), ["internal"]);
  assert.equal(db.rows("views")[0].n, 2);
});

test("a utm_source tag wins over the referrer, so social posts show as their own source", async () => {
  await view({ p: "/", r: "t.co", s: "bluesky" });
  assert.equal(db.rows("views")[0].source, "utm:bluesky");
});

test("a malformed referrer or tag is stored as 'other', never as raw text", async () => {
  await view({ p: "/", r: "<script>alert(1)</script>" });
  await view({ p: "/", r: "", s: "DROP TABLE views;" });
  assert.deepEqual(db.rows("views").map((r) => [r.source, r.n]), [["other", 2]]);
});

test("query strings and index.html are folded into the clean page path", async () => {
  await view({ p: "/index.html" });
  await view({ p: "/privacy.html?x=1#top" });
  const pages = db.rows("views").map((r) => r.page).sort();
  assert.deepEqual(pages, ["/", "/privacy.html"]);
});

test("junk page paths are rejected and nothing is written", async () => {
  for (const p of ["", "x", "/../etc", "/<b>", "/" + "a".repeat(200)]) {
    const res = await view({ p });
    assert.equal(res.status, 400, p);
  }
  const res = await view({ p: "/" }).then(() => db.rows("views"));
  assert.equal(res.length, 1);
});

test("crawlers and automated browsers are counted separately as bots", async () => {
  await view({ p: "/" }, { ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });
  await view({ p: "/" }, { ua: "Mozilla/5.0 HeadlessChrome/120.0" });
  await view({ p: "/" }, { ua: "" });
  await view({ p: "/", w: "1" });
  await view({ p: "/" });
  const rows = db.rows("views");
  assert.equal(rows.find((r) => r.bot === 1).n, 4);
  assert.equal(rows.find((r) => r.bot === 0).n, 1);
});

test("an unknown or missing country is stored as XX", async () => {
  await view({ p: "/" }, { country: null });
  await view({ p: "/" }, { country: "not a country" });
  assert.deepEqual(db.rows("views").map((r) => [r.country, r.n]), [["XX", 2]]);
});

test("pings from other websites are refused and not counted", async () => {
  assert.equal((await view({ p: "/" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await view({ p: "/" }, { origin: null })).status, 403);
  assert.throws(() => db.rows("views"), /no such table/);
});

test("an oversized ping is refused", async () => {
  const res = await view(null, { body: "p=/&r=" + "a".repeat(2000) });
  assert.equal(res.status, 413);
});

test("the count tables are created automatically on first use", async () => {
  assert.throws(() => db.rows("views"), /no such table/);
  await view({ p: "/" });
  assert.equal(db.rows("views").length, 1);
});

test("without a database the ping still succeeds quietly and the board is unaffected", async () => {
  env = makeEnv(memoryKV(), { ADMIN_KEY: KEY });
  assert.equal((await view({ p: "/" })).status, 204);
  env = makeEnv(memoryKV(), { DB: brokenD1(), ADMIN_KEY: KEY });
  assert.equal((await view({ p: "/" })).status, 204);
  const { res } = await getStatus(worker, env);
  assert.equal(res.status, 200);
  assert.ok(logs.lines.every((l) => !l.includes(KEY)));
});

test("pings answer with CORS for our site only and are never cached", async () => {
  const res = await view({ p: "/" });
  assert.equal(res.headers.get("access-control-allow-origin"), SITE);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("status.json still refuses POST", async () => {
  const res = await beacon("/status.json", { p: "/" });
  assert.equal(res.status, 405);
});

// ---------- counting outbound link clicks ----------

test("an outbound click is counted by the linked site", async () => {
  assert.equal((await click({ l: "tokenmargin.dev", p: "/" })).status, 204);
  await click({ l: "tokenmargin.dev", p: "/" });
  await click({ l: "email", p: "/privacy.html" });
  const rows = db.rows("clicks").sort((a, b) => a.link.localeCompare(b.link));
  assert.deepEqual(rows, [
    { day: "2026-11-07", link: "email", page: "/privacy.html", n: 1 },
    { day: "2026-11-07", link: "tokenmargin.dev", page: "/", n: 2 },
  ]);
});

test("a click with a malformed link is rejected", async () => {
  assert.equal((await click({ l: "javascript:alert(1)", p: "/" })).status, 400);
  assert.equal((await click({ l: "", p: "/" })).status, 400);
});

test("clicks from bots are not counted", async () => {
  assert.equal((await click({ l: "tokenmargin.dev", p: "/" }, { ua: "curl/8.0" })).status, 204);
  assert.throws(() => db.rows("clicks"), /no such table/);
});

// ---------- the private dashboard ----------

test("the dashboard page loads without a key but contains no data", async () => {
  const { res, body } = await admin("/admin", null);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("x-robots-tag"), /noindex/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(body, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(body, /type="password"/);
  assert.match(body, /src="\/admin\/app\.js"/);
});

test("the dashboard script is served from the Worker itself", async () => {
  const { res, body } = await admin("/admin/app.js", null);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.match(body, /\/admin\/data/);
  assert.doesNotMatch(body, /localStorage|document\.cookie|indexedDB/);
});

test("dashboard data needs the right key", async () => {
  assert.equal((await admin("/admin/data", null)).res.status, 401);
  assert.equal((await admin("/admin/data", "wrong-key-wrong-key-wrong-key")).res.status, 401);
  const ok = await admin();
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.headers.get("cache-control"), "no-store");
});

test("the key in a URL is never accepted", async () => {
  const { res } = await admin("/admin/data?key=" + KEY, null);
  assert.equal(res.status, 401);
});

test("without an ADMIN_KEY secret, or with a short one, the dashboard stays locked", async () => {
  env = makeEnv(memoryKV(), { DB: db });
  let r = await admin();
  assert.equal(r.res.status, 503);
  assert.equal(r.body.error, "admin_key_missing");
  env = makeEnv(memoryKV(), { DB: db, ADMIN_KEY: "short" });
  r = await admin("/admin/data", "short");
  assert.equal(r.res.status, 503);
  assert.equal(r.body.error, "admin_key_missing");
});

test("without a database the dashboard says so instead of failing", async () => {
  env = makeEnv(memoryKV(), { ADMIN_KEY: KEY });
  const r = await admin();
  assert.equal(r.res.status, 503);
  assert.equal(r.body.error, "db_missing");
});

test("an empty database gives a zero-filled dashboard, not an error", async () => {
  const { res, body } = await admin("/admin/data?days=7");
  assert.equal(res.status, 200);
  assert.equal(body.range_days, 7);
  assert.equal(body.series.length, 7);
  assert.ok(body.series.every((d) => d.human === 0 && d.bot === 0 && d.clicks === 0));
  assert.equal(body.series[6].day, "2026-11-07");
  assert.deepEqual(body.pages, []);
});

test("dashboard totals, breakdowns and search engines add up", async () => {
  clk.set("2026-11-05T10:00:00Z");
  await view({ p: "/", r: "" });
  clk.set("2026-11-06T10:00:00Z");
  await view({ p: "/", r: "" });
  await view({ p: "/", r: "" });
  clk.set("2026-11-07T06:00:00Z");
  await view({ p: "/", r: "www.google.com" }, { country: "GB" });
  await view({ p: "/", r: "google.co.uk" }, { country: "GB" });
  await view({ p: "/privacy.html", r: "bing.com" });
  await view({ p: "/", s: "bluesky" });
  await view({ p: "/" }, { ua: "Googlebot/2.1" });
  await click({ l: "tokenmargin.dev", p: "/" });
  const { body } = await admin("/admin/data?days=7");
  const today = body.series.find((d) => d.day === "2026-11-07");
  const yesterday = body.series.find((d) => d.day === "2026-11-06");
  assert.equal(yesterday.human, 2);
  assert.equal(today.human, 4);
  assert.equal(today.bot, 1);
  assert.equal(today.clicks, 1);
  assert.equal(yesterday.dod_pct, 100);
  assert.equal(today.dod_pct, null, "no change % for a day still in progress");
  assert.deepEqual(body.totals, { human: 7, bot: 1, clicks: 1 });
  assert.deepEqual(body.pages[0], { page: "/", n: 6 });
  assert.deepEqual(body.countries.find((c) => c.country === "GB"), { country: "GB", n: 2 });
  assert.deepEqual(body.engines, [{ engine: "Google", n: 2 }, { engine: "Bing", n: 1 }]);
  assert.ok(body.sources.some((s) => s.source === "utm:bluesky" && s.n === 1));
  assert.deepEqual(body.links, [{ link: "tokenmargin.dev", n: 1 }]);
});

test("today's run-rate appears only after the first hour of the UTC day", async () => {
  clk.set("2026-11-07T00:30:00Z");
  await view({ p: "/" });
  let { body } = await admin();
  assert.equal(body.today.run_rate, null);
  clk.set("2026-11-07T06:00:00Z");
  await view({ p: "/" });
  ({ body } = await admin());
  assert.equal(body.today.human, 2);
  assert.equal(body.today.run_rate, 8);
});

test("the quota meter estimates today's database writes against the free 100,000", async () => {
  await view({ p: "/" });
  await view({ p: "/" });
  await click({ l: "tokenmargin.dev", p: "/" });
  const { body } = await admin();
  assert.equal(body.quota.writes_today_est, 3);
  assert.equal(body.quota.limit, 100000);
});

test("an unsupported range falls back to 30 days", async () => {
  const { body } = await admin("/admin/data?days=99999");
  assert.equal(body.range_days, 30);
  assert.equal(body.series.length, 30);
});

test("a wrong key is never written to the logs", async () => {
  await admin("/admin/data", "wrong-key-wrong-key-wrong-key");
  await admin();
  assert.ok(logs.lines.every((l) => !l.includes(KEY) && !l.includes("wrong-key")));
});

// ---------- retention ----------

test("counts older than 400 days are deleted once a day at 03:00 UTC", async () => {
  const net = installFetch(healthyRoutes());
  try {
    clk.set("2025-09-01T12:00:00Z");
    await view({ p: "/" });
    clk.set("2026-11-06T12:00:00Z");
    await view({ p: "/" });
    clk.set("2026-11-07T02:00:00Z");
    await runOnce(worker, env);
    assert.equal(db.rows("views").length, 2, "not at 03:00, nothing deleted");
    clk.set("2026-11-07T03:00:00Z");
    await runOnce(worker, env);
    assert.deepEqual(db.rows("views").map((r) => r.day), ["2026-11-06"]);
  } finally {
    net.restore();
  }
});

test("a broken database never stops the status check from running", async () => {
  const net = installFetch(healthyRoutes());
  try {
    env = makeEnv(memoryKV(), { DB: brokenD1() });
    clk.set("2026-11-07T03:00:00Z");
    await runOnce(worker, env);
    const { body } = await getStatus(worker, env);
    assert.equal(body.stale, false);
  } finally {
    net.restore();
  }
});
