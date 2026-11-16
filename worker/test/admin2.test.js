// v1.22.0 (Nov 16, 2026): /admin upgrade.
// - A traffic-source donut (top 5 sources plus "Everything else"), worked out
//   on the server from the counts we already keep.
// - An iPhone home-screen app for /admin (manifest plus a radar icon).
// - "Remember on this phone": the key is kept in this browser only after it
//   worked, ticked by default, wiped on a wrong key or by "Forget this phone".
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import { memoryKV, makeEnv, ctx, clock, captureLogs } from "./helpers.js";
import { memoryD1 } from "./d1.js";
import { fakeBrowser, runApp, settle } from "./fakedom.js";

const KEY = "test-admin-key-0123456789-abcdefghij";
const STORE = "outageradar_admin_key";
const SITE = "https://liveoutageradar.com";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1";

let clk, logs, db, env;
beforeEach(() => {
  clk = clock("2026-11-16T12:00:00Z");
  logs = captureLogs();
  db = memoryD1();
  env = makeEnv(memoryKV(), { DB: db, ADMIN_KEY: KEY });
});
afterEach(() => { clk.restore(); logs.restore(); });

async function get(path, key = null) {
  const headers = key === null ? {} : { authorization: "Bearer " + key };
  return worker.fetch(new Request("https://data.liveoutageradar.com" + path, { headers }), env, ctx);
}
async function adminData(days = 30) {
  const res = await get("/admin/data?days=" + days, KEY);
  return res.json();
}
async function views(n, fields) {
  for (let i = 0; i < n; i += 1) {
    const req = new Request("https://data.liveoutageradar.com/v", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": BROWSER, origin: SITE },
      body: new URLSearchParams(fields).toString(),
    });
    Object.defineProperty(req, "cf", { value: { country: "US" } });
    await worker.fetch(req, env, ctx);
  }
}

// ---------- donut data ----------

test("source slices: no visits gives no slices", async () => {
  const body = await adminData();
  assert.deepEqual(body.source_slices, []);
});

test("source slices: five or fewer sources are shown as they are, with no 'Everything else'", async () => {
  await views(3, { p: "/", r: "" });
  await views(1, { p: "/", r: "bing.com" });
  const body = await adminData();
  assert.deepEqual(body.source_slices, [
    { source: "direct", n: 3, pct: 75 },
    { source: "bing.com", n: 1, pct: 25 },
  ]);
});

test("source slices: top five, then everything else in one slice, adding up to all visits", async () => {
  await views(6, { p: "/", r: "" });
  await views(5, { p: "/", r: "www.google.com" });
  await views(4, { p: "/", s: "bluesky" });
  await views(3, { p: "/", r: "bing.com" });
  await views(2, { p: "/", r: "duckduckgo.com" });
  await views(1, { p: "/", r: "reddit.com" });
  await views(1, { p: "/", r: "news.ycombinator.com" });
  const body = await adminData();
  const s = body.source_slices;
  assert.equal(s.length, 6);
  assert.deepEqual(s.map((x) => x.source), ["direct", "google.com", "utm:bluesky", "bing.com", "duckduckgo.com", "rest"]);
  assert.deepEqual(s[5], { source: "rest", n: 2, pct: 9.1 });
  assert.equal(s.reduce((t, x) => t + x.n, 0), body.totals.human);
  assert.deepEqual(s[0], { source: "direct", n: 6, pct: 27.3 });
});

test("source slices: bots are left out, as in the sources list", async () => {
  await views(2, { p: "/", r: "" });
  const req = new Request("https://data.liveoutageradar.com/v", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": "Googlebot/2.1", origin: SITE },
    body: new URLSearchParams({ p: "/", r: "" }).toString(),
  });
  await worker.fetch(req, env, ctx);
  const body = await adminData();
  assert.deepEqual(body.source_slices, [{ source: "direct", n: 2, pct: 100 }]);
});

// ---------- home-screen app ----------

test("the dashboard page links the manifest and the home-screen icon", async () => {
  const html = await (await get("/admin")).text();
  assert.match(html, /<link rel="manifest" href="\/admin\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/admin\/icon-180\.png">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="[^"]{1,14}">/);
  assert.match(html, /<meta name="theme-color" content="#06110d">/);
});

test("the manifest opens /admin full-screen, with the radar icon", async () => {
  const res = await get("/admin/manifest.webmanifest");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/manifest\+json/);
  assert.match(res.headers.get("x-robots-tag"), /noindex/);
  const m = await res.json();
  assert.equal(m.start_url, "/admin");
  assert.equal(m.scope, "/admin");
  assert.equal(m.display, "standalone");
  assert.ok(m.name && m.short_name && m.short_name.length <= 12);
  assert.deepEqual(m.icons, [{ src: "/admin/icon-180.png", sizes: "180x180", type: "image/png" }]);
});

test("the icon is a real 180x180 PNG served by the Worker", async () => {
  const res = await get("/admin/icon-180.png");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(dv.getUint32(16), 180, "width");
  assert.equal(dv.getUint32(20), 180, "height");
  assert.ok(bytes.length < 40000, "small enough to paste: " + bytes.length + " bytes");
});

test("the security policy allows our own manifest and still blocks everything else", async () => {
  const csp = (await get("/admin")).headers.get("content-security-policy");
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("the manifest and icon need no key, and the data still does", async () => {
  assert.equal((await get("/admin/manifest.webmanifest")).status, 200);
  assert.equal((await get("/admin/icon-180.png")).status, 200);
  assert.equal((await get("/admin/data")).status, 401);
});

// ---------- the dashboard in a (fake) browser ----------

async function page({ storage = {}, keyOk = KEY } = {}) {
  const html = await (await get("/admin")).text();
  const app = await (await get("/admin/app.js")).text();
  const data = await adminData();
  const b = fakeBrowser(html, {
    storage,
    routes: async (url, auth) => (auth === "Bearer " + keyOk ? { status: 200, body: data } : { status: 401, body: { error: "wrong_key" } }),
  });
  runApp(app, b);
  await settle();
  return b;
}
async function typeKey(b, k, { remember } = {}) {
  b.$("key").value = k;
  if (remember !== undefined) b.$("remember").checked = remember;
  b.$("login").dispatch("submit");
  await settle();
}

test("'Remember on this phone' is ticked by default", async () => {
  const b = await page();
  assert.equal(b.$("remember").getAttribute("type"), "checkbox");
  assert.equal(b.$("remember").checked, true);
});

test("a right key, with the box ticked, is remembered after it works", async () => {
  const b = await page();
  await typeKey(b, KEY);
  assert.equal(b.$("dash").hidden, false);
  assert.equal(b.store.get(STORE), KEY);
});

test("with the box unticked nothing is kept on the phone", async () => {
  const b = await page();
  await typeKey(b, KEY, { remember: false });
  assert.equal(b.$("dash").hidden, false);
  assert.equal(b.store.has(STORE), false);
});

test("a wrong key is never remembered", async () => {
  const b = await page();
  await typeKey(b, "wrong-key-wrong-key-wrong-key");
  assert.equal(b.$("login").hidden, false);
  assert.equal(b.store.has(STORE), false);
});

test("a typed key is not saved until the server has said it is right (network drop)", async () => {
  const html = await (await get("/admin")).text();
  const app = await (await get("/admin/app.js")).text();
  const b = fakeBrowser(html, { routes: async () => { throw new TypeError("Failed to fetch"); } });
  runApp(app, b);
  await settle();
  await typeKey(b, "typo-key-typo-key-typo-key");
  assert.equal(b.store.has(STORE), false);
  assert.match(b.$("dashErr").textContent, /Network error/);
  assert.equal(b.$("dashErr").hidden, false);
});

test("a remembered key opens the dashboard straight away, with no typing", async () => {
  const b = await page({ storage: { [STORE]: KEY } });
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].auth, "Bearer " + KEY);
  assert.equal(b.$("dash").hidden, false);
  assert.equal(b.$("login").hidden, true);
});

test("a remembered key that stopped working (key changed) is wiped and the lock screen shows", async () => {
  const b = await page({ storage: { [STORE]: "old-key-old-key-old-key-old" } });
  assert.equal(b.store.has(STORE), false);
  assert.equal(b.$("login").hidden, false);
  assert.equal(b.$("dash").hidden, true);
});

test("'Forget this phone' wipes the key and locks the dashboard", async () => {
  const b = await page({ storage: { [STORE]: KEY } });
  b.$("forget").click();
  assert.equal(b.store.has(STORE), false);
  assert.equal(b.$("login").hidden, false);
  assert.equal(b.$("dash").hidden, true);
  assert.equal(b.$("key").value, "");
});

test("the key is only ever stored under its one name, never in a cookie, and never put in a URL", async () => {
  const app = await (await get("/admin/app.js")).text();
  assert.doesNotMatch(app, /document\.cookie|indexedDB|sessionStorage/);
  assert.match(app, new RegExp('"' + STORE + '"'));
  const b = await page({ storage: { [STORE]: KEY } });
  assert.ok(b.calls.every((c) => !c.url.includes(KEY)));
  assert.deepEqual([...b.store.keys()], [STORE]);
});

test("if this browser blocks storage, the dashboard still unlocks with a typed key", async () => {
  const html = await (await get("/admin")).text();
  const app = await (await get("/admin/app.js")).text();
  const data = await adminData();
  const b = fakeBrowser(html, { routes: async () => ({ status: 200, body: data }) });
  const boom = () => { throw new Error("SecurityError"); };
  b.window.localStorage = { getItem: boom, setItem: boom, removeItem: boom };
  b.localStorage = b.window.localStorage;
  runApp(app, b);
  await settle();
  await typeKey(b, KEY);
  assert.equal(b.$("dash").hidden, false);
});

// ---------- the donut in the page ----------

function sliceColors(b) {
  const out = {};
  for (const el of b.$("donut").all()) {
    if (el.tagName === "CIRCLE" && el.getAttribute("data-source")) out[el.getAttribute("data-source")] = el.getAttribute("stroke");
  }
  return out;
}

test("the donut draws one slice per source, each with a hover label, and a legend with counts", async () => {
  await views(3, { p: "/", r: "" });
  await views(1, { p: "/", r: "bing.com" });
  const b = await page({ storage: { [STORE]: KEY } });
  const colors = sliceColors(b);
  assert.deepEqual(Object.keys(colors).sort(), ["bing.com", "direct"]);
  assert.notEqual(colors.direct, colors["bing.com"]);
  const tips = b.$("donut").all().filter((e) => e.tagName === "TITLE").map((e) => e.textContent);
  assert.ok(tips.includes("Direct (typed, bookmark or app): 3 (75%)"), tips.join(" | "));
  const legend = b.$("donutLegend").textContent;
  assert.match(legend, /Direct \(typed, bookmark or app\).*3.*75%/);
  assert.match(legend, /bing\.com.*1.*25%/);
});

test("'Everything else' is gray, and a source keeps its color when the range changes", async () => {
  // Today: bing leads. Earlier in the month: direct leads. Six sources in all.
  clk.set("2026-11-01T12:00:00Z");
  await views(20, { p: "/", r: "" });
  clk.set("2026-11-16T12:00:00Z");
  await views(6, { p: "/", r: "bing.com" });
  await views(5, { p: "/", r: "" });
  await views(4, { p: "/", r: "duckduckgo.com" });
  await views(3, { p: "/", r: "reddit.com" });
  await views(2, { p: "/", r: "news.ycombinator.com" });
  await views(1, { p: "/", r: "lobste.rs" });
  const html = await (await get("/admin")).text();
  const app = await (await get("/admin/app.js")).text();
  const d30 = await adminData(30);
  const d7 = await adminData(7);
  assert.equal(d30.source_slices[0].source, "direct");
  assert.equal(d7.source_slices[0].source, "bing.com");
  const b = fakeBrowser(html, {
    storage: { [STORE]: KEY },
    routes: async (url) => ({ status: 200, body: url.includes("days=7") ? d7 : d30 }),
  });
  runApp(app, b);
  await settle();
  const first = sliceColors(b);
  assert.equal(first.rest, "#5b7a69");
  b.ranges.find((r) => r.getAttribute("data-days") === "7").click();
  await settle();
  const second = sliceColors(b);
  for (const s of ["direct", "bing.com", "duckduckgo.com", "reddit.com"]) {
    assert.equal(second[s], first[s], s + " kept its color");
  }
});

test("the sources list stays under the donut, so exact numbers are always there", async () => {
  const html = await (await get("/admin")).text();
  const iDonut = html.indexOf('id="donut"');
  const iList = html.indexOf('id="sources"');
  assert.ok(iDonut > 0 && iList > iDonut);
});
