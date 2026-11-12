// v1.15.0 (Nov 10, 2026): self-serve Discord/Slack alerts, Phase 1 pilot.
// Visitors give a webhook and pick services; we post ONE confirmation message
// there; nothing else is sent until a person presses Confirm on our page (a
// POST, so link-preview bots that open links can never confirm or
// unsubscribe). The 5-minute run only records events; an every-minute run
// sends them in batches. Webhooks are encrypted at rest; duplicates are found
// by a keyed hash. No IPs, emails or cookies are stored.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, memoryKV, json, statuspage, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx, runOnce,
} from "./helpers.js";
import { sqliteD1 } from "./sqlite-d1.js";

const SITE = "https://liveoutageradar.com";
const ENC = Buffer.alloc(32, 7).toString("base64");
const SIGN = "test-signing-secret-0123456789-abcdefghij";
const D1 = "https://discord.com/api/webhooks/1111/tok-one_A";
const D2 = "https://discord.com/api/webhooks/2222/tok-two_B";
const SL = "https://hooks.slack.com/services/T0001/B0001/abcDEF123";

let clk, net, logs, db, env, slackPosts, discordReply;
function setup(extra = {}) {
  // Keep the message log across route changes so counts cover the whole test.
  const earlier = net ? net.discord.slice() : [];
  if (net) net.restore();
  net = installFetch({
    ...healthyRoutes(),
    __discord: (url, body) => (discordReply ? discordReply(url, body) : undefined),
    [SL]: async (url, init) => { slackPosts.push({ url, body: JSON.parse(init.body) }); return slackReply ? slackReply() : new Response("ok", { status: 200 }); },
    ...extra,
  });
  net.discord.push(...earlier);
}
let slackReply = null;
beforeEach(() => {
  clk = clock("2026-11-12T14:00:00Z");
  logs = captureLogs();
  slackPosts = [];
  discordReply = null;
  slackReply = null;
  setup();
  db = sqliteD1();
  env = makeEnv(memoryKV(), { DB: db, ALERTS_ENC_KEY: ENC, ALERTS_SIGN_KEY: SIGN, APPROVED_MAPPINGS: ALL_IDS.join(",") });
});
afterEach(() => { net.restore(); net = null; clk.restore(); logs.restore(); });

function post(action, body, origin = SITE) {
  const headers = { "content-type": "text/plain;charset=UTF-8" };
  if (origin) headers.origin = origin;
  return worker.fetch(new Request("https://data.liveoutageradar.com/alerts/" + action, {
    method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
  }), env, ctx);
}
const sendOnce = () => worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env, ctx);
const rows = () => db.raw.prepare("SELECT * FROM alert_subs ORDER BY id").all();
const to = (url) => net.discord.filter((d) => d.url === url).map((d) => d.body);
const tokenIn = (text, page) => (text.match(new RegExp(SITE.replace(/\./g, "\\.") + "/alerts/" + page + "/#([A-Za-z0-9._-]+)")) || [])[1];

async function subscribe(webhook, services, extra = {}) {
  const res = await post("subscribe", { webhook, services, minor: false, company_name: "", ...extra });
  return { res, body: await res.json() };
}
async function subscribeAndConfirm(webhook, services, extra = {}) {
  await subscribe(webhook, services, extra);
  const msgs = webhook.startsWith("https://hooks.slack.com") ? slackPosts.map((p) => p.body.text) : to(webhook).map((b) => b.content);
  const token = tokenIn(msgs[msgs.length - 1], "confirm");
  const res = await post("confirm", { token });
  assert.equal(res.status, 200, "confirm ok");
}
async function claudeOutage() {
  setup({ [URLS.claude.feed]: () => json(statuspage("critical")) });
  await runOnce(worker, env);
}
async function claudeRecovers() {
  setup();
  clk.advance(5); await runOnce(worker, env);
  clk.advance(5); await runOnce(worker, env);
}

test("this release is v1.17.0", async () => {
  await runOnce(worker, env);
  assert.ok(env.KV.store.has("samples:v1.17.0"));
});

// ---------- not set up ----------

test("without the two secrets, sign-up is closed and nothing is recorded or sent", async () => {
  env = makeEnv(memoryKV(), { DB: db, APPROVED_MAPPINGS: ALL_IDS.join(",") });
  const { res } = await subscribe(D1, ["claude"]);
  assert.equal(res.status, 503);
  await claudeOutage();
  await sendOnce();
  assert.equal(to(D1).length, 0);
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'alert_%'").all();
  assert.equal(tables.length, 0, "no alert tables touched");
});

// ---------- sign-up ----------

test("signing up posts one confirmation message with a confirm link, and sends nothing else", async () => {
  const { res, body } = await subscribe(D1, ["claude", "openai"]);
  assert.equal(res.status, 200);
  assert.equal(body.status, "check_channel");
  const msgs = to(D1);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, /Claude/);
  assert.match(msgs[0].content, /ChatGPT \/ OpenAI/);
  assert.ok(tokenIn(msgs[0].content, "confirm"), "confirm link with token in the #fragment");
  assert.equal(msgs[0].flags, 4, "Discord link previews suppressed");
  assert.deepEqual(msgs[0].allowed_mentions, { parse: [] });
  const [row] = rows();
  assert.equal(row.confirmed, 0);
  assert.equal(row.platform, "discord");
  assert.equal(row.services, ",openai,claude,", "stored in board order");
  assert.equal(row.minor, 0);
});

test("the stored webhook is encrypted, and its lookup hash is keyed", async () => {
  await subscribe(D1, ["claude"]);
  const [row] = rows();
  assert.ok(!row.hook_enc.includes("discord") && !row.hook_enc.includes("tok-one_A"), "no plain webhook stored");
  assert.match(row.hook_enc, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  const plainSha = require_sha256(D1);
  assert.notEqual(row.hook_hash, plainSha, "not a plain hash anyone could recompute");
  // A second sign-up of the same webhook encrypts differently (fresh random IV) but is the same row.
  clk.advance(60 * 25);
  await subscribe(D1, ["claude"]);
  assert.equal(rows().length, 1);
});

import { createHash } from "node:crypto";
function require_sha256(text) { return createHash("sha256").update(text).digest("hex"); }

test("Slack webhooks work the same way, with link previews off", async () => {
  const { res } = await subscribe(SL, ["gemini"]);
  assert.equal(res.status, 200);
  assert.equal(slackPosts.length, 1);
  assert.ok(tokenIn(slackPosts[0].body.text, "confirm"));
  assert.equal(slackPosts[0].body.unfurl_links, false);
  assert.equal(slackPosts[0].body.unfurl_media, false);
  assert.equal(rows()[0].platform, "slack");
});

test("the hidden honeypot field silently drops the sign-up", async () => {
  const { res, body } = await subscribe(D1, ["claude"], { company_name: "Acme Bots" });
  assert.equal(res.status, 200);
  assert.equal(body.status, "check_channel", "a bot can't tell it was dropped");
  assert.equal(to(D1).length, 0);
  assert.equal(rows().length, 0);
});

test("only real Discord or Slack webhook addresses are accepted, and nothing is fetched otherwise", async () => {
  for (const bad of [
    "http://discord.com/api/webhooks/1/abc",
    "https://discord.com.evil.example/api/webhooks/1/abc",
    "https://evil.example/https://discord.com/api/webhooks/1/abc",
    "https://discord.com/api/webhooks/1/abc?wait=true",
    "https://discord.com/api/webhooks/abc/def",
    "https://discord.com/api/v10/channels/1/messages",
    "https://hooks.slack.com/workflows/T1/A1/1/abc",
    "https://hooks.slack.com.evil.example/services/T1/B1/abc",
    "https://discord.com/api/webhooks/1/" + "a".repeat(400),
    "", 42, null,
  ]) {
    const before = net.calls.length;
    const { res, body } = await subscribe(bad, ["claude"]);
    assert.equal(res.status, 400, String(bad));
    assert.equal(body.error, "webhook_invalid", String(bad));
    assert.equal(net.calls.length, before, "no request made for " + String(bad));
  }
  assert.equal(rows().length, 0);
});

test("services must be real board ids", async () => {
  for (const bad of [[], ["nope"], ["claude", "nope"], "claude", null]) {
    const { res, body } = await subscribe(D1, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(body.error, "services_invalid");
  }
});

test("sign-ups from other websites are refused; ours get CORS headers", async () => {
  const other = await post("subscribe", { webhook: D1, services: ["claude"] }, "https://evil.example");
  assert.equal(other.status, 403);
  const ours = await post("subscribe", { webhook: D1, services: ["claude"] });
  assert.equal(ours.headers.get("access-control-allow-origin"), SITE);
});

test("broken or oversized request bodies are refused", async () => {
  assert.equal((await post("subscribe", "{not json")).status, 400);
  assert.equal((await post("subscribe", JSON.stringify({ webhook: D1, services: ["claude"], pad: "x".repeat(5000) }))).status, 413);
});

// ---------- v1.16.0 (Phase 2): the page can tell a new sign-up from an update ----------

test("a new sign-up, a repeat within 24 hours, and an update to a confirmed one answer differently", async () => {
  assert.equal((await subscribe(D1, ["claude"])).body.status, "check_channel", "new: message sent");
  assert.equal((await subscribe(D1, ["claude", "groq"])).body.status, "pending", "not confirmed yet, message already sent");
  assert.equal(rows()[0].services, ",groq,claude,", "choices still updated (board order)");
  const token = tokenIn(to(D1)[0].content, "confirm");
  await post("confirm", { token });
  const r = await subscribe(D1, ALL_IDS, { minor: true });
  assert.equal(r.body.status, "updated", "confirmed: choices updated");
  assert.equal(rows()[0].minor, 1);
  assert.equal(rows()[0].confirmed, 1, "stays confirmed");
  assert.equal(to(D1).length, 1, "no new message for either");
});

test("the honeypot answer still looks like a new sign-up", async () => {
  assert.equal((await subscribe(D1, ["claude"], { company_name: "bot" })).body.status, "check_channel");
});

const ADMIN = "test-admin-key-0123456789-abcdefghij";
async function adminData() {
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/admin/data", { headers: { authorization: "Bearer " + ADMIN } }), env, ctx);
  return { res, text: await res.text() };
}

test("the private dashboard shows alert counts only, never webhooks", async () => {
  env.ADMIN_KEY = ADMIN;
  await subscribeAndConfirm(D1, ["claude"]);
  await subscribe(D2, ["openai"]);
  await claudeOutage();
  const { res, text } = await adminData();
  assert.equal(res.status, 200);
  const data = JSON.parse(text);
  assert.deepEqual(data.alerts, { enabled: true, confirmed: 1, pending: 1, queued: 1 });
  assert.ok(!text.includes("discord.com") && !text.includes("tok-one_A") && !text.includes("hook_enc"));
  await sendOnce();
  assert.equal(JSON.parse((await adminData()).text).alerts.queued, 0);
});

test("with alerts off, the dashboard says so and still works", async () => {
  env = makeEnv(memoryKV(), { DB: db, ADMIN_KEY: ADMIN });
  const { res, text } = await adminData();
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text).alerts, { enabled: false });
});

test("the dashboard page has an alerts card", async () => {
  const res = await worker.fetch(new Request("https://data.liveoutageradar.com/admin"), env, ctx);
  const html = await res.text();
  assert.match(html, /<h2>Outage alerts \(Discord and Slack\)<\/h2>/);
  assert.match(html, /id="alerts"/);
});

test("the same webhook gets at most one confirmation message per 24 hours", async () => {
  await subscribe(D1, ["claude"]);
  await subscribe(D1, ["claude", "groq"]);
  clk.advance(60 * 23);
  await subscribe(D1, ["claude"]);
  assert.equal(to(D1).length, 1);
});

test("at most 30 confirmation messages an hour across everyone", async () => {
  for (let i = 0; i < 30; i++) {
    const { res } = await subscribe("https://discord.com/api/webhooks/" + (5000 + i) + "/t" + i, ["claude"]);
    assert.equal(res.status, 200, "sign-up " + i);
  }
  const { res, body } = await subscribe(D2, ["claude"]);
  assert.equal(res.status, 429);
  assert.equal(body.error, "busy");
  assert.equal(to(D2).length, 0);
  clk.advance(61);
  assert.equal((await subscribe(D2, ["claude"])).res.status, 200, "open again after an hour");
});

test("a webhook that refuses the confirmation message is not kept", async () => {
  discordReply = (url) => (url === D1 ? new Response(JSON.stringify({ code: 10015 }), { status: 404 }) : undefined);
  const { res, body } = await subscribe(D1, ["claude"]);
  assert.equal(res.status, 400);
  assert.equal(body.error, "webhook_rejected");
  assert.equal(rows().length, 0);
});

// ---------- confirm ----------

test("confirming needs the right signed token, sent by POST", async () => {
  await subscribe(D1, ["claude"]);
  const token = tokenIn(to(D1)[0].content, "confirm");
  const [id, sig] = token.split(".");
  for (const bad of ["", "nope", id, id + ".", id + "." + sig.slice(0, -2) + "zz", "f".repeat(32) + "." + sig]) {
    const res = await post("confirm", { token: bad });
    assert.ok(res.status === 400 || res.status === 404, "rejected: " + bad);
  }
  // A link-preview bot opens links with GET: that must never confirm.
  const crawl = await worker.fetch(new Request("https://data.liveoutageradar.com/alerts/confirm?token=" + token), env, ctx);
  assert.ok(crawl.status === 405 || crawl.status === 404);
  assert.equal(rows()[0].confirmed, 0);
  assert.equal((await post("confirm", { token })).status, 200);
  assert.equal(rows()[0].confirmed, 1);
});

test("an unsubscribe token can't confirm, and a confirm token can't unsubscribe", async () => {
  await subscribe(D1, ["claude"]);
  const confirm = tokenIn(to(D1)[0].content, "confirm");
  await post("unsubscribe", { token: confirm });
  assert.equal(rows().length, 1, "confirm token did not unsubscribe");
});

test("unconfirmed sign-ups are deleted after 24 hours", async () => {
  await subscribe(D1, ["claude"]);
  clk.advance(60 * 24 + 1);
  await sendOnce();
  assert.equal(rows().length, 0);
});

// ---------- alerts ----------

test("a confirmed subscriber gets a start and a recovered message, with links", async () => {
  await subscribeAndConfirm(D1, ["claude"]);
  await claudeOutage();
  assert.equal(to(D1).length, 1, "the 5-minute run only records; it sends nothing to subscribers");
  await sendOnce();
  const start = to(D1)[1];
  assert.match(start.content, /Claude/);
  assert.match(start.content, /Major outage/);
  assert.ok(start.content.includes(SITE + "/status/claude/"));
  assert.ok(tokenIn(start.content, "unsubscribe"), "unsubscribe link in every alert");
  assert.equal(start.flags, 4);
  await claudeRecovers();
  await sendOnce();
  assert.match(to(D1)[2].content, /Claude: recovered/);
  await sendOnce();
  assert.equal(to(D1).length, 3, "each message sent once");
});

test("subscribers only hear about the services they picked", async () => {
  await subscribeAndConfirm(D1, ["openai"]);
  await claudeOutage();
  await sendOnce();
  assert.equal(to(D1).length, 1, "only the confirmation");
});

test("unconfirmed sign-ups never get alerts", async () => {
  await subscribe(D1, ["claude"]);
  await claudeOutage();
  await sendOnce();
  assert.equal(to(D1).length, 1);
});

test("degraded alerts only go to people who opted in", async () => {
  await subscribeAndConfirm(D1, ["claude"]);
  await subscribeAndConfirm(D2, ["claude"], { minor: true });
  setup({ [URLS.claude.feed]: () => json(statuspage("minor")) });
  await runOnce(worker, env);
  await sendOnce();
  assert.equal(to(D1).length, 1, "major-only: nothing for degraded");
  assert.match(to(D2)[1].content, /Claude: Degraded/);
  await claudeRecovers();
  await sendOnce();
  assert.equal(to(D1).length, 1);
  assert.match(to(D2)[2].content, /Claude: recovered/);
});

test("Unknown never sends anything", async () => {
  await subscribeAndConfirm(D1, ["claude"]);
  setup({ [URLS.claude.feed]: () => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }) });
  for (let i = 0; i < 3; i++) { await runOnce(worker, env); clk.advance(5); await sendOnce(); }
  assert.equal(to(D1).length, 1);
});

test("unsubscribing (a POST from our page) deletes the row and stops alerts", async () => {
  await subscribeAndConfirm(D1, ["claude"]);
  await claudeOutage();
  await sendOnce();
  const token = tokenIn(to(D1)[1].content, "unsubscribe");
  const crawl = await worker.fetch(new Request("https://data.liveoutageradar.com/alerts/unsubscribe?token=" + token), env, ctx);
  assert.ok(crawl.status === 405 || crawl.status === 404, "GET never unsubscribes");
  assert.equal(rows().length, 1);
  assert.equal((await post("unsubscribe", { token })).status, 200);
  assert.equal(rows().length, 0);
  await claudeRecovers();
  await sendOnce();
  assert.equal(to(D1).length, 2);
});

test("a webhook Discord says is gone is deleted at once", async () => {
  await subscribeAndConfirm(D1, ["claude"]);
  discordReply = (url) => (url === D1 ? new Response(JSON.stringify({ message: "Unknown Webhook", code: 10015 }), { status: 404 }) : undefined);
  await claudeOutage();
  await sendOnce();
  assert.equal(rows().length, 0);
});

test("a Slack webhook that no longer exists is deleted at once", async () => {
  await subscribeAndConfirm(SL, ["claude"]);
  slackReply = () => new Response("no_service", { status: 404 });
  await claudeOutage();
  await sendOnce();
  assert.equal(rows().length, 0);
});

test("a 'slow down' reply is retried next minute, never treated as dead", async () => {
  await subscribeAndConfirm(D1, ["claude"]);
  let busy = true;
  discordReply = (url) => (url === D1 && busy ? new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }) : undefined);
  await claudeOutage();
  await sendOnce();
  assert.equal(to(D1).length, 1, "not delivered yet");
  assert.equal(rows().length, 1, "kept");
  busy = false;
  clk.advance(1);
  await sendOnce();
  assert.equal(to(D1).length, 2, "delivered on the next minute");
});

test("sending is spread out: at most 40 messages a minute, none twice", async () => {
  for (let i = 0; i < 45; i++) {
    const hook = "https://discord.com/api/webhooks/" + (7000 + i) + "/k" + i;
    await subscribeAndConfirm(hook, ["claude"]);
    if (i % 25 === 24) clk.advance(61); // stay under the hourly confirmation cap
  }
  const before = net.discord.length;
  await claudeOutage();
  const bossAlerts = net.discord.length - before;
  await sendOnce();
  assert.equal(net.discord.length - before - bossAlerts, 40);
  clk.advance(1);
  await sendOnce();
  assert.equal(net.discord.length - before - bossAlerts, 45);
  clk.advance(1);
  await sendOnce();
  assert.equal(net.discord.length - before - bossAlerts, 45, "nothing twice");
});

test("alerts older than 6 hours are dropped instead of sent late", async () => {
  await subscribeAndConfirm(D1, ["claude"]);
  await claudeOutage();
  clk.advance(6 * 60 + 1);
  await sendOnce();
  assert.equal(to(D1).length, 1);
});

test("the every-minute run only sends; it never runs the status checks", async () => {
  const before = net.calls.length;
  await sendOnce();
  assert.ok(!net.calls.slice(before).some((c) => /status|api\./.test(c.url)), "no feed or API checks");
});

test("webhook addresses never appear in logs", async () => {
  await subscribeAndConfirm(D1, ["claude"]);
  discordReply = (url) => (url === D1 ? new Response("boom", { status: 500 }) : undefined);
  await claudeOutage();
  await sendOnce();
  assert.ok(!logs.lines.join("\n").includes("tok-one_A"));
});
