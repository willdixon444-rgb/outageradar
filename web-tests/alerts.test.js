// Site v1.17.0: self-serve alert pages, Phase 1 pilot. The pages exist but are
// hidden: noindex, not in the sitemap or llms.txt, not linked from any page.
// Confirm and unsubscribe need a button press (a POST): link-preview bots
// that open the link can never confirm or unsubscribe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { SHELL } from "../site/board.js";
import { renderAlertsPage, renderTokenPage } from "../tools/alerts.mjs";
import { API, subscribePayload, bindTokenPage, MESSAGES, statusMessage, preselect, allState, setAll } from "../site/alerts.js";

const SITE = (f) => readFileSync(new URL("../site/" + f, import.meta.url), "utf8");
const PAGES = { "alerts/index.html": () => renderAlertsPage(), "alerts/confirm/index.html": () => renderTokenPage("confirm"), "alerts/unsubscribe/index.html": () => renderTokenPage("unsubscribe") };

test("the three alert pages exist and match the generator", () => {
  for (const [path, make] of Object.entries(PAGES)) {
    assert.ok(existsSync(new URL("../site/" + path, import.meta.url)), path);
    assert.equal(SITE(path), make(), path + " is out of date: run node tools/status-pages.mjs");
  }
});

test("Phase 2: the sign-up page is public; confirm and unsubscribe pages stay hidden", () => {
  const signup = SITE("alerts/index.html");
  assert.doesNotMatch(signup, /noindex/);
  assert.match(signup, /<link rel="canonical" href="https:\/\/liveoutageradar\.com\/alerts\/">/);
  assert.match(signup, /<meta name="description" content="[^"]{60,165}">/);
  assert.match(SITE("sitemap.xml"), /<loc>https:\/\/liveoutageradar\.com\/alerts\/<\/loc>/);
  assert.match(SITE("llms.txt"), /https:\/\/liveoutageradar\.com\/alerts\//);
  for (const path of ["alerts/confirm/index.html", "alerts/unsubscribe/index.html"]) {
    assert.match(SITE(path), /<meta name="robots" content="noindex, nofollow">/, path);
    assert.doesNotMatch(SITE("sitemap.xml"), new RegExp(path.replace("index.html", "")), path);
  }
});

test("the homepage and every history page link to alerts; history pages pre-pick their service", () => {
  assert.ok(SITE("index.html").includes('<a class="errlink" href="/alerts/">Get outage alerts in Discord or Slack &rarr;</a>'));
  for (const s of SHELL) {
    const html = SITE("status/" + s.id + "/index.html");
    assert.ok(html.includes('<a href="/alerts/?service=' + s.id + '">'), s.id);
  }
});

test("pages load only our own alerts script, and are ASCII", () => {
  for (const path of Object.keys(PAGES)) {
    const html = SITE(path);
    const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ["/alerts.js"], path);
    assert.ok([...Buffer.from(html)].every((b) => b < 128), path);
  }
  assert.ok([...Buffer.from(SITE("alerts.js"))].every((b) => b < 128));
});

test("the sign-up form: webhook, every service, degraded off by default, hidden honeypot", () => {
  const html = SITE("alerts/index.html");
  assert.match(html, /<body data-alerts="subscribe">/);
  assert.match(html, /<input type="url" id="webhook" name="webhook" required/);
  for (const s of SHELL) assert.ok(html.includes('<input type="checkbox" name="service" value="' + s.id + '"'), s.id);
  assert.match(html, /<input type="checkbox" name="minor" value="1">/);
  assert.doesNotMatch(html, /name="minor"[^>]*checked/);
  assert.match(html, /<div class="hp" aria-hidden="true"><label>Company <input type="text" name="company_name" tabindex="-1" autocomplete="off"><\/label><\/div>/);
  assert.match(html, /\.hp\{position:absolute;left:-10000px/);
  assert.match(html, /href="\/privacy\.html"/);
  assert.match(html, /<label class="all"><input type="checkbox" id="all"> Select all<\/label>/);
  assert.match(html, /don&rsquo;t share screenshots of your alerts publicly/);
});

test("confirm and unsubscribe pages show a button and explain what it does", () => {
  const c = SITE("alerts/confirm/index.html");
  assert.match(c, /<body data-alerts="confirm">/);
  assert.match(c, /<button type="button" id="go" hidden>Confirm alerts<\/button>/);
  const u = SITE("alerts/unsubscribe/index.html");
  assert.match(u, /<body data-alerts="unsubscribe">/);
  assert.match(u, /<button type="button" id="go" hidden>Unsubscribe<\/button>/);
});

// ---------- the page script ----------

function stub() {
  const handlers = {};
  return { hidden: true, disabled: false, textContent: "", addEventListener(t, fn) { handlers[t] = fn; }, fire: (t) => handlers[t] && handlers[t]() };
}
const TOKEN = "a".repeat(32) + "." + "B".repeat(43);

test("the script only talks to our data address, as plain text (no pre-flight)", async () => {
  assert.equal(API, "https://data.liveoutageradar.com/alerts/");
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true })); };
  const button = stub(); const status = stub();
  bindTokenPage({ button, status, hash: "#" + TOKEN, fetchFn, action: "confirm" });
  await button.fire("click");
  assert.equal(calls[0].url, "https://data.liveoutageradar.com/alerts/confirm");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "text/plain;charset=UTF-8");
  assert.deepEqual(JSON.parse(calls[0].init.body), { token: TOKEN });
  assert.equal(status.textContent, MESSAGES.confirmed);
});

test("opening a confirm or unsubscribe page sends nothing until the button is pressed", async () => {
  for (const action of ["confirm", "unsubscribe"]) {
    let called = 0;
    const button = stub(); const status = stub();
    bindTokenPage({ button, status, hash: "#" + TOKEN, fetchFn: async () => { called += 1; return new Response("{}"); }, action });
    assert.equal(called, 0, action + ": loading the page sends nothing");
    assert.equal(button.hidden, false, action + ": the button is shown");
  }
});

test("a missing or broken link shows a message and no button", () => {
  for (const hash of ["", "#", "#nope", "#" + TOKEN + "<script>"]) {
    const button = stub(); const status = stub();
    bindTokenPage({ button, status, hash, fetchFn: async () => { throw new Error("must not fetch"); }, action: "confirm" });
    assert.equal(button.hidden, true, hash);
    assert.equal(status.textContent, MESSAGES.link_invalid, hash);
  }
});

test("the sign-up payload is trimmed and keeps the honeypot for the server to judge", () => {
  assert.deepEqual(subscribePayload({ webhook: "  https://discord.com/api/webhooks/1/x  ", services: ["claude"], minor: true, company_name: "" }),
    { webhook: "https://discord.com/api/webhooks/1/x", services: ["claude"], minor: true, company_name: "" });
  assert.equal(subscribePayload({ webhook: "x", services: [], minor: "yes", company_name: "bot" }).minor, false);
});

test("the page tells a new sign-up, a repeat and an update apart", () => {
  assert.equal(statusMessage({ ok: true, status: "check_channel" }), MESSAGES.check_channel);
  assert.equal(statusMessage({ ok: true, status: "updated" }), MESSAGES.updated);
  assert.equal(statusMessage({ ok: true, status: "pending" }), MESSAGES.pending);
  assert.match(MESSAGES.updated, /Updated your choices\. No new message was sent/);
  assert.match(MESSAGES.pending, /already sent/);
  assert.equal(statusMessage({ error: "busy" }), MESSAGES.busy);
  assert.equal(statusMessage({ error: "<weird>" }), MESSAGES.default);
  assert.equal(statusMessage(null), MESSAGES.default);
});

test("?service= from a history page pre-ticks only real services", () => {
  const ids = SHELL.map((s) => s.id);
  assert.deepEqual(preselect("?service=claude", ids), ["claude"]);
  assert.deepEqual(preselect("?service=claude&service=groq", ids), ["claude", "groq"]);
  assert.deepEqual(preselect("?service=nope&service=claude", ids), ["claude"]);
  assert.deepEqual(preselect("", ids), []);
  assert.deepEqual(preselect("?service=%3Cscript%3E", ids), []);
});

test("Select all ticks or clears every service and shows a mixed state", () => {
  const boxes = [{ checked: false }, { checked: true }, { checked: false }];
  assert.equal(allState(boxes), "mixed");
  setAll(boxes, true);
  assert.ok(boxes.every((b) => b.checked));
  assert.equal(allState(boxes), true);
  setAll(boxes, false);
  assert.equal(allState(boxes), false);
});

// ---------- privacy page ----------

test("the privacy page explains alerts before they go public", () => {
  const p = SITE("privacy.html");
  assert.match(p, /Last updated: November 10, 2026/);
  assert.match(p, /<h2>Outage alerts \(Discord and Slack\)<\/h2>/);
  for (const promise of [/encrypted/, /unsubscribe link in every alert/i, /24 hours/, /no email address/i, /not your IP address/i, /link previews/i]) {
    assert.match(p, promise, String(promise));
  }
});
