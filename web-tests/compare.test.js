// Site v1.24.0 (Nov 16, 2026): the free-alerts pitch and /compare/, a fair
// comparison with IsDown and StatusGator. Every price is dated and linked to
// the company's own pricing page (both read on Nov 16, 2026); re-check them
// before changing this page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SHELL } from "../site/board.js";
import { COMPARE, renderComparePage } from "../tools/compare.mjs";

const SITE = (f) => readFileSync(new URL("../site/" + f, import.meta.url), "utf8");
const PAGE = SITE("compare/index.html");

test("the page is generated and up to date", () => {
  assert.equal(PAGE, renderComparePage());
});

test("it is a real, indexable page: title, canonical, description, sitemap, llms.txt", () => {
  assert.match(PAGE, /<title>Free AI API outage alerts: OutageRadar vs IsDown vs StatusGator<\/title>/);
  assert.match(PAGE, /<link rel="canonical" href="https:\/\/liveoutageradar\.com\/compare\/">/);
  assert.match(PAGE, /<meta name="description" content="[^"]{60,}">/);
  assert.doesNotMatch(PAGE, /noindex/);
  assert.match(SITE("sitemap.xml"), /<loc>https:\/\/liveoutageradar\.com\/compare\/<\/loc>/);
  assert.match(SITE("llms.txt"), /https:\/\/liveoutageradar\.com\/compare\//);
});

test("every price is dated and links to the company's own pricing page", () => {
  assert.equal(COMPARE.checked, "November 16, 2026");
  assert.match(PAGE, /Prices checked November 16, 2026/);
  assert.match(PAGE, /<a href="https:\/\/isdown\.app\/pricing">/);
  assert.match(PAGE, /<a href="https:\/\/statusgator\.com\/plans">/);
});

test("the facts match the pricing pages as read on Nov 16, 2026", () => {
  const { isdown, statusgator } = COMPARE;
  assert.deepEqual([isdown.free, isdown.trialDays, isdown.cheapest, isdown.cheapestMonitors, isdown.services],
    [null, 14, 22, 15, "6,320+"]);
  assert.deepEqual([statusgator.free.monitors, statusgator.free.notificationsPerMonth, statusgator.cheapest, statusgator.cheapestMonitors],
    [3, 10, 72, 25]);
  assert.match(statusgator.cheapestNote, /paid annually/);
  for (const t of ["$22", "$72", "10 notifications a month", "14-day", "6,320+"]) assert.ok(PAGE.includes(t), t);
});

test("it is fair: it says where the others do more", () => {
  assert.match(PAGE, /<h2[^>]*>When IsDown or StatusGator is the better choice<\/h2>/);
  for (const t of [/email/i, /SMS/, /Microsoft Teams/, /AWS/]) assert.match(PAGE, t);
});

test("our own facts come from the board, so the count can't go stale", () => {
  assert.ok(PAGE.includes(SHELL.length + " AI services"), "says " + SHELL.length);
  assert.match(PAGE, /no account/i);
  assert.match(PAGE, /Discord and Slack only/);
  assert.match(PAGE, /<a href="\/alerts\/">/);
});

test("the alerts page carries the pitch, links the comparison, and counts services right", () => {
  const p = SITE("alerts/index.html");
  assert.match(p, /Free outage alerts for all \d+ AI services\. No account, no card, no monthly cap\./);
  assert.ok(p.includes("all " + SHELL.length + " AI services"));
  assert.match(p, /<a href="\/compare\/">/);
  assert.doesNotMatch(p, /and 12 more/);
  assert.ok(p.includes("and " + (SHELL.length - 3) + " more AI services"));
});

test("the homepage links the comparison next to the alerts link", () => {
  const home = SITE("index.html");
  const alerts = home.indexOf('<a class="errlink" href="/alerts/">');
  const compare = home.indexOf('<a class="errlink" href="/compare/">');
  assert.ok(alerts > 0 && compare > alerts, "compare link follows the alerts link");
});
