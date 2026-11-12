// Tests for site/ping.js (page-view and link-click counts) and the privacy
// promises around it. Nothing here ships to the site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COUNT_URL, cleanPath, referrerHost, utmSource, viewBody, linkFor } from "../site/ping.js";

const SITE = (f) => readFileSync(new URL("../site/" + f, import.meta.url), "utf8");

test("counts go only to our own data address", () => {
  assert.equal(COUNT_URL, "https://data.liveoutageradar.com");
  const urls = SITE("ping.js").match(/https?:\/\/[^\s"'`)]+/g) || [];
  for (const u of urls) assert.match(u, /^https:\/\/data\.liveoutageradar\.com/, u);
});

test("the page path is cleaned before sending", () => {
  assert.equal(cleanPath("/"), "/");
  assert.equal(cleanPath("/index.html"), "/");
  assert.equal(cleanPath("/Privacy.html"), "/privacy.html");
  assert.equal(cleanPath(""), "/");
});

test("only the referring site's domain is sent, never the full address", () => {
  assert.equal(referrerHost("https://www.google.com/search?q=is+claude+down"), "google.com");
  assert.equal(referrerHost("https://old.reddit.com/r/ClaudeAI/comments/abc/secret"), "old.reddit.com");
  assert.equal(referrerHost(""), "");
  assert.equal(referrerHost("not a url"), "");
});

test("a utm_source tag is read and cleaned, anything odd is dropped", () => {
  assert.equal(utmSource("?utm_source=Bluesky&utm_medium=social"), "bluesky");
  assert.equal(utmSource("?ref=x"), "");
  assert.equal(utmSource("?utm_source=" + encodeURIComponent("<b>bad</b>")), "");
  assert.equal(utmSource("?utm_source=" + "a".repeat(40)), "");
});

test("a view ping carries only page, referrer domain, tag and the automation flag", () => {
  const body = viewBody({
    pathname: "/", referrer: "https://www.google.com/search?q=x", search: "?utm_source=x", webdriver: false,
  });
  const form = new URLSearchParams(body);
  assert.deepEqual([...form.keys()].sort(), ["p", "r", "s"]);
  assert.equal(form.get("r"), "google.com");
  const auto = new URLSearchParams(viewBody({ pathname: "/", referrer: "", search: "", webdriver: true }));
  assert.equal(auto.get("w"), "1");
});

test("outbound links are named by their site; our own links are not counted", () => {
  const own = "liveoutageradar.com";
  assert.equal(linkFor("https://tokenmargin.dev/", own), "tokenmargin.dev");
  // v1.18.3: the partner box's ?ref= tag and guide paths still count as tokenmargin.dev.
  assert.equal(linkFor("https://tokenmargin.dev/?ref=liveoutageradar", own), "tokenmargin.dev");
  assert.equal(linkFor("https://tokenmargin.dev/guides/a.html?ref=liveoutageradar", own), "tokenmargin.dev");
  assert.equal(linkFor("https://www.example.com/x?y=1", own), "example.com");
  assert.equal(linkFor("mailto:contact@liveoutageradar.com", own), "email");
  assert.equal(linkFor("https://liveoutageradar.com/privacy.html", own), null);
  assert.equal(linkFor("/privacy.html", own), null);
  assert.equal(linkFor("javascript:void(0)", own), null);
});

test("ping.js stores nothing in the browser and sets no cookies", () => {
  assert.doesNotMatch(SITE("ping.js"), /localStorage|sessionStorage|indexedDB|document\.cookie/);
});

test("ping.js sends no visitor IDs, screen sizes or fingerprints", () => {
  assert.doesNotMatch(SITE("ping.js"), /userAgent|screen\.|platform|language|crypto|random|uuid/i);
});

test("the board loads the counter, and so does the privacy page", () => {
  assert.match(SITE("board.js"), /import "\.\/ping\.js";/);
  assert.match(SITE("privacy.html"), /<script type="module" src="\/ping\.js"><\/script>/);
});

test("the privacy page describes the counts before they ship", () => {
  const p = SITE("privacy.html");
  assert.doesNotMatch(p, /no analytics/i);
  assert.match(p, /page views/i);
  assert.match(p, /link clicks/i);
  assert.match(p, /no cookies/i);
  assert.match(p, /do not store (your )?IP address/i);
  assert.match(p, /Last updated: [A-Z][a-z]+ \d{1,2}, 20\d\d/); // the newest date is pinned by the Bluesky privacy test
});
