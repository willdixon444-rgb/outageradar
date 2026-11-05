// Display-logic tests for the board. Nothing here ships to the site.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHELL, badgeFor, buildView, sortServices, pollDecision, contrastRatio,
  COLORS, describeOfficial, describeProbe, summaryLine, blipFor, liveState,
} from "../site/board.js";

function svc(id, overall, extra = {}) {
  const feedless = id === "gemini" || id === "deepseek";
  return {
    id, name: id, status_page: "https://status.example/" + id, overall,
    official: { label: "Official status", status: feedless ? "unknown" : overall === "check_ok" ? "unknown" : overall,
      checked_at_utc: "2026-11-05T01:30:15Z", note: feedless ? "No official public feed" : "" },
    probe: { label: "API server answering (our check)", status: "reachable", checked_at_utc: "2026-11-05T01:30:16Z",
      http_status: 401, note: "" },
    ...extra,
  };
}
const fresh = (services, more = {}) => ({
  schema: 1, generated_at_utc: "2026-11-05T01:30:18Z", served_at_utc: "2026-11-05T01:31:00Z",
  age_seconds: 42, stale: false, services, ...more,
});
const all = () => SHELL.map((s) => svc(s.id, s.id === "gemini" || s.id === "deepseek" ? "check_ok" : "operational"));
const find = (view, id) => view.services.find((s) => s.id === id);

// ---------- never green by default ----------

test("the shell lists all ten services", () => {
  assert.equal(SHELL.length, 10);
});

test("no data yet means every service is checking, none green", () => {
  const view = buildView(null, { elapsedSec: 0, state: "loading" });
  for (const s of view.services) {
    assert.notEqual(s.badge.key, "operational");
    assert.equal(s.badge.key, "checking");
  }
});

test("a failed fetch shows every service unknown with a banner", () => {
  const view = buildView(null, { elapsedSec: 0, state: "error" });
  assert.match(view.banner, /can't reach/i);
  assert.ok(view.services.every((s) => s.badge.key === "unknown"));
});

test("fresh data is shown as reported", () => {
  const view = buildView(fresh(all()), { elapsedSec: 0 });
  assert.equal(view.banner, "");
  assert.equal(find(view, "openai").badge.key, "operational");
  assert.equal(find(view, "gemini").badge.key, "check_ok");
});

test("data flagged stale by the server is all unknown with a banner", () => {
  const view = buildView(fresh(all(), { stale: true, age_seconds: 1500 }), { elapsedSec: 0 });
  assert.match(view.banner, /stale/i);
  assert.ok(view.services.every((s) => s.badge.key === "unknown"));
});

test("data that ages past 15 minutes while the page is open goes unknown", () => {
  const view = buildView(fresh(all(), { age_seconds: 800 }), { elapsedSec: 120 });
  assert.match(view.banner, /stale/i);
  assert.ok(view.services.every((s) => s.badge.key === "unknown"));
});

test("staleness ignores the visitor's clock", () => {
  const realNow = Date.now;
  Date.now = () => Date.parse("2031-01-01T00:00:00Z"); // wildly wrong clock
  try {
    const view = buildView(fresh(all()), { elapsedSec: 0 });
    assert.equal(view.banner, "");
    assert.equal(find(view, "openai").badge.key, "operational");
  } finally { Date.now = realNow; }
});

test("missing age information is treated as stale, never as fresh", () => {
  const data = fresh(all()); delete data.age_seconds;
  const view = buildView(data, { elapsedSec: 0 });
  assert.ok(view.services.every((s) => s.badge.key === "unknown"));
});

test("a malformed service becomes unknown and the others still update", () => {
  const services = all();
  services[0] = { id: "openai", overall: "operational", official: null, probe: 42 };
  const view = buildView(fresh(services), { elapsedSec: 0 });
  assert.equal(find(view, "openai").badge.key, "unknown");
  assert.equal(find(view, "claude").badge.key, "operational");
});

test("a service missing from the data is unknown", () => {
  const view = buildView(fresh(all().filter((s) => s.id !== "cohere")), { elapsedSec: 0 });
  assert.equal(find(view, "cohere").badge.key, "unknown");
});

test("an unrecognised overall word is unknown", () => {
  const services = all(); services[0].overall = "totally_fine";
  const view = buildView(fresh(services), { elapsedSec: 0 });
  assert.equal(find(view, "openai").badge.key, "unknown");
});

test("a new service in the data appears even if the shell lacks it", () => {
  const view = buildView(fresh([...all(), svc("newco", "operational", { name: "NewCo" })]), { elapsedSec: 0 });
  assert.equal(find(view, "newco").badge.key, "operational");
});

// ---------- badges ----------

test("every badge has a word, an icon and a style", () => {
  for (const key of ["operational", "degraded", "partial_outage", "major_outage", "maintenance",
    "signals_disagree", "check_ok", "check_failed", "unknown", "checking"]) {
    const b = badgeFor(key);
    assert.ok(b.label && b.icon && b.cls, key);
  }
});

test("our-check-only up never looks like official operational", () => {
  const ok = badgeFor("check_ok"), op = badgeFor("operational");
  assert.notEqual(ok.cls, op.cls);
  assert.notEqual(ok.color, op.color);
  assert.match(ok.label, /our check only/i);
});

test("badge colours meet the 4.5:1 contrast minimum on their pill", () => {
  for (const [key, color] of Object.entries(COLORS.states)) {
    const r = contrastRatio(color, COLORS.pill);
    assert.ok(r >= 4.5, key + " ratio " + r.toFixed(2));
  }
  assert.ok(contrastRatio(COLORS.text, COLORS.bg) >= 4.5);
  assert.ok(contrastRatio(COLORS.muted, COLORS.bg) >= 4.5);
});

// ---------- plain-English lines ----------

test("no-feed services say so in plain words", () => {
  const line = describeOfficial(svc("gemini", "check_ok").official, false);
  assert.match(line, /no public status feed/i);
});

test("our check says 'server responding', not a raw error code", () => {
  const line = describeProbe(svc("openai", "operational").probe);
  assert.match(line.text, /responding/i);
  assert.doesNotMatch(line.text, /401/);
  assert.equal(line.code, "HTTP 401, needs a key");
});

test("signals disagree comes with an explanation", () => {
  const services = all(); services[0].overall = "signals_disagree";
  const view = buildView(fresh(services), { elapsedSec: 0 });
  assert.match(find(view, "openai").note, /our check could not reach/i);
});

test("times are shown in UTC", () => {
  const view = buildView(fresh(all()), { elapsedSec: 0 });
  assert.match(view.updated, /01:30 UTC/);
});

// ---------- order and summary ----------

test("problems sort to the top, worst first", () => {
  const services = all();
  services.find((s) => s.id === "groq").overall = "degraded";
  services.find((s) => s.id === "claude").overall = "major_outage";
  const view = buildView(fresh(services), { elapsedSec: 0 });
  const ids = sortServices(view.services).map((s) => s.id);
  assert.deepEqual(ids.slice(0, 2), ["claude", "groq"]);
});

test("summary counts confirmed problems and does not call unknown 'fine'", () => {
  const services = all();
  services.find((s) => s.id === "groq").overall = "major_outage";
  let view = buildView(fresh(services), { elapsedSec: 0 });
  assert.match(summaryLine(view), /1 service reporting problems/i);
  view = buildView(null, { elapsedSec: 0, state: "error" });
  assert.doesNotMatch(summaryLine(view), /no problems/i);
});

// ---------- polling budget ----------

test("polling pauses in background tabs and after 20 idle minutes", () => {
  assert.equal(pollDecision({ hidden: true, idleMs: 0 }), "pause-hidden");
  assert.equal(pollDecision({ hidden: false, idleMs: 21 * 60000 }), "pause-idle");
  assert.equal(pollDecision({ hidden: false, idleMs: 60000 }), "poll");
});

test("a failed refresh keeps still-fresh data but says so", () => {
  const view = buildView(fresh(all()), { elapsedSec: 60, refreshFailed: true });
  assert.match(view.banner, /couldn't refresh/i);
  assert.equal(find(view, "openai").badge.key, "operational");
});

test("a failed refresh never extends data past 15 minutes", () => {
  const view = buildView(fresh(all(), { age_seconds: 600 }), { elapsedSec: 400, refreshFailed: true });
  assert.match(view.banner, /stale/i);
  assert.ok(view.services.every((s) => s.badge.key === "unknown"));
});

test("unknown rows say unknown, not checking", () => {
  const view = buildView(null, { elapsedSec: 0, state: "error" });
  const openai = find(view, "openai");
  assert.match(openai.official, /unknown/i);
  assert.match(openai.probe.text, /unknown/i);
  assert.doesNotMatch(openai.official + openai.probe.text, /checking/i);
  assert.match(find(view, "gemini").official, /no public status feed/i);
});


// ---------- design tweaks (approved Nov 5) ----------

test("the 401/403 note says what it means, never 'OK'", () => {
  const api403 = describeProbe({ label: "API server answering (our check)", status: "reachable", http_status: 403 });
  assert.equal(api403.code, "HTTP 403, needs a key");
  const site = describeProbe({ label: "Site reachable (HTTP 200)", status: "reachable", http_status: 200 });
  assert.equal(site.code, "HTTP 200");
  assert.doesNotMatch(api403.code + site.code, /\bOK\b/);
});

test("problem dots on the radar are bigger and ringed; calm dots are not", () => {
  for (const k of ["major_outage", "partial_outage", "check_failed", "signals_disagree", "degraded"]) {
    const b = blipFor(k);
    assert.ok(b.halo, k);
    assert.ok(b.r > blipFor("operational").r, k);
  }
  for (const k of ["operational", "check_ok", "unknown", "checking", "maintenance"]) {
    assert.equal(blipFor(k).halo, false, k);
  }
});

test("'Live' shows only when data is fresh and updating", () => {
  assert.equal(liveState(buildView(fresh(all()), { elapsedSec: 0 }), { paused: false }).key, "live");
  assert.equal(liveState(buildView(fresh(all()), { elapsedSec: 0 }), { paused: true }).key, "paused");
  assert.equal(liveState(buildView(fresh(all()), { elapsedSec: 0, refreshFailed: true }), { paused: false }).key, "reconnecting");
  assert.equal(liveState(buildView(fresh(all(), { stale: true }), { elapsedSec: 0 }), { paused: false }).key, "stale");
  assert.equal(liveState(buildView(null, { state: "error" }), { paused: false }).key, "offline");
  assert.equal(liveState(buildView(null, { state: "loading" }), { paused: false }).key, "checking");
});

test("only the live state pulses", () => {
  for (const [view, paused] of [
    [buildView(fresh(all(), { stale: true }), { elapsedSec: 0 }), false],
    [buildView(null, { state: "error" }), false],
    [buildView(fresh(all()), { elapsedSec: 0 }), true],
  ]) {
    assert.equal(liveState(view, { paused }).pulse, false);
  }
  assert.equal(liveState(buildView(fresh(all()), { elapsedSec: 0 }), { paused: false }).pulse, true);
});

// ---------- page markup ----------
import { readFileSync } from "node:fs";
const PAGE = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

test("the TokenMargin partner link is on the page", () => {
  assert.match(PAGE, /href="https:\/\/tokenmargin\.dev\/?"/);
});

test("every link that opens a new tab is protected with rel=noopener", () => {
  const tags = PAGE.match(/<a\b[^>]*target="_blank"[^>]*>/g) || [];
  assert.ok(tags.length > 0);
  for (const t of tags) assert.match(t, /rel="[^"]*noopener[^"]*"/, t);
});

test("the launched homepage is open to search engines", () => {
  assert.doesNotMatch(PAGE, /noindex/);
  assert.match(PAGE, /<link rel="canonical" href="https:\/\/liveoutageradar\.com\/">/);
});

// ---------- privacy page (and the promises it makes) ----------
const PRIVACY_PATH = new URL("../site/privacy.html", import.meta.url);

test("the privacy page exists, is indexable, and names the contact address", () => {
  const p = readFileSync(PRIVACY_PATH, "utf8");
  assert.doesNotMatch(p, /noindex/);
  assert.match(p, /contact@liveoutageradar\.com/);
  assert.match(p, /no cookies/i);
  assert.match(p, /Render/);
  assert.match(p, /Cloudflare/);
  assert.match(p, /IP address/);
});

test("the board links to the privacy page", () => {
  assert.match(PAGE, /href="\/privacy\.html"/);
});

test("the board really stores nothing in the browser (the privacy page promises this)", () => {
  const js = readFileSync(new URL("../site/board.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|document\.cookie/);
});

test("the board loads no third-party scripts, fonts or images", () => {
  const external = (PAGE.match(/<(script|link|img)\b[^>]*(src|href)="https?:\/\/[^"]+"/g) || [])
    .filter((tag) => !/(src|href)="https:\/\/liveoutageradar\.com\//.test(tag));
  assert.deepEqual(external, []);
});


// ---------- launch (Nov 5, 2026) ----------
const SITE = (f) => readFileSync(new URL("../site/" + f, import.meta.url), "utf8");

test("robots.txt allows crawling and points to the sitemap", () => {
  const r = SITE("robots.txt");
  assert.doesNotMatch(r, /Disallow:\s*\/\s*$/m);
  assert.match(r, /Allow: \//);
  assert.match(r, /Sitemap: https:\/\/liveoutageradar\.com\/sitemap\.xml/);
});

test("the sitemap lists the homepage and the privacy page", () => {
  const m = SITE("sitemap.xml");
  assert.match(m, /<loc>https:\/\/liveoutageradar\.com\/<\/loc>/);
  assert.match(m, /<loc>https:\/\/liveoutageradar\.com\/privacy\.html<\/loc>/);
});

test("the homepage has a link-preview card for social sites", () => {
  assert.match(PAGE, /<meta property="og:title" content="[^"]+">/);
  assert.match(PAGE, /<meta property="og:image" content="https:\/\/liveoutageradar\.com\/og\.png">/);
  assert.match(PAGE, /<meta name="twitter:card" content="summary_large_image">/);
  const png = readFileSync(new URL("../site/og.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test("the old preview address forwards to the homepage and is not indexed", () => {
  const p = SITE("preview/index.html");
  assert.match(p, /http-equiv="refresh" content="0; url=\/"/);
  assert.match(p, /noindex/);
});

test("the homepage loads the board script from the site root", () => {
  assert.match(PAGE, /<script type="module" src="\/board\.js"><\/script>/);
});

test("the not-found page stays out of search results", () => {
  assert.match(SITE("404.html"), /noindex/);
});
