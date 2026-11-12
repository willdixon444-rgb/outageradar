// v1.17.0 (Nov 12, 2026): Bluesky integration (site v1.19.0 plan).
// - Reply assist: mentions/replies that ask whether a tracked service is down
//   get one automated reply built only from the board's data (Lane A);
//   common questions get a suggested answer in Discord (Lane B); everything
//   else is a Discord heads-up (Lane C). Quotes never get auto replies.
// - Incident posts: one post when a confirmed major incident starts and one
//   when it ends (no minor, no "worse", no signals-disagree).
// - BSKY_MODE: off (default) | pilot (Discord only, "would post") | live.
// - One login, saved encrypted in D1, refreshed on ExpiredToken; never more
//   than one login per run; 30-minute wait after a failed login.
// - Runs inside the every-minute cron, at most every 5 minutes, only when the
//   alert sender left room in the request budget. Discord: one digest per run.
// API shapes from the official lexicons (bluesky-social/bsky and
// bluesky-social/atproto, read Nov 12, 2026); limits from docs.bsky.app.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker from "../checker.js";
import {
  ALL_IDS, URLS, HEALTH_HOOK, memoryKV, json, html, statuspage, betterstack, healthyRoutes, installFetch, clock, captureLogs, makeEnv, ctx, runOnce,
} from "./helpers.js";
import { sqliteD1 } from "./sqlite-d1.js";

const PDS = "https://bsky.social/xrpc/";
const HANDLE = "liveoutageradar.com";
const DID = "did:plc:kfkr3oadtua575zamwwxokvs";
const PASS = "abcd-efgh-ijkl-mnop";
const ENC = Buffer.alloc(32, 7).toString("base64");
const SIGN = "test-signing-secret-0123456789-abcdefghij";
const SOCIAL_HOOK = "https://discord.com/api/webhooks/333/SOCIAL-SECRET-qrs";
const SITE_LINK = "liveoutageradar.com/status/";

let clk, net, logs, db, env, bs, extraRoutes;

function fakeBsky() {
  const s = {
    notes: [], created: [], puts: [], logins: 0, refreshes: 0, lists: 0, gets: 0, listUrls: [],
    access: null, refresh: null, n: 0, loginFails: false, refreshFails: false, expireNext: false,
    putFails: false,
    profile: {
      $type: "app.bsky.actor.profile", displayName: "OutageRadar", description: "Live status for AI APIs",
      avatar: { $type: "blob", ref: { $link: "bafyavatar" }, mimeType: "image/png", size: 1234 },
    },
    profileCid: "cidP1",
  };
  const auth = (init) => (init && init.headers && init.headers.authorization) || "";
  const tokens = () => { s.n += 1; s.access = "acc-" + s.n; s.refresh = "ref-" + s.n; return { accessJwt: s.access, refreshJwt: s.refresh, handle: HANDLE, did: DID }; };
  s.routes = {
    [PDS + "com.atproto.server.createSession"]: async (url, init) => {
      s.logins += 1;
      const b = JSON.parse(init.body);
      if (s.loginFails || b.identifier !== HANDLE || b.password !== PASS) return json({ error: "AuthenticationRequired", message: "Invalid identifier or password" }, 401);
      return json(tokens());
    },
    [PDS + "com.atproto.server.refreshSession"]: async (url, init) => {
      s.refreshes += 1;
      if (s.refreshFails || auth(init) !== "Bearer " + s.refresh) return json({ error: "ExpiredToken", message: "Token has expired" }, 400);
      return json(tokens());
    },
    [PDS + "app.bsky.notification.listNotifications"]: async (url, init) => {
      s.lists += 1;
      s.listUrls.push(url);
      if (s.expireNext) { s.expireNext = false; return json({ error: "ExpiredToken", message: "Token has expired" }, 400); }
      if (auth(init) !== "Bearer " + s.access) return json({ error: "InvalidToken", message: "Bad token" }, 400);
      return json({ notifications: s.notes.slice().reverse() }); // newest first, like the real API
    },
    [PDS + "com.atproto.repo.createRecord"]: async (url, init) => {
      if (auth(init) !== "Bearer " + s.access) return json({ error: "InvalidToken" }, 400);
      const b = JSON.parse(init.body);
      s.created.push(b);
      return json({ uri: "at://" + DID + "/app.bsky.feed.post/r" + s.created.length, cid: "cidR" + s.created.length });
    },
    [PDS + "com.atproto.repo.getRecord"]: async (url) => {
      s.gets += 1;
      return json({ uri: "at://" + DID + "/app.bsky.actor.profile/self", cid: s.profileCid, value: s.profile });
    },
    [PDS + "com.atproto.repo.putRecord"]: async (url, init) => {
      if (auth(init) !== "Bearer " + s.access) return json({ error: "InvalidToken" }, 400);
      const b = JSON.parse(init.body);
      s.puts.push(b);
      if (s.putFails) return json({ error: "InternalServerError" }, 500);
      s.profile = b.record;
      s.profileCid = "cidP2";
      return json({ uri: "at://" + DID + "/app.bsky.actor.profile/self", cid: s.profileCid });
    },
  };
  return s;
}

let noteN = 0;
function note(text, over = {}) {
  noteN += 1;
  const author = over.author || { did: "did:plc:alice" + (over.who || ""), handle: (over.who || "alice") + ".test", labels: [] };
  return {
    uri: "at://" + author.did + "/app.bsky.feed.post/p" + noteN,
    cid: "cidN" + noteN,
    author,
    reason: over.reason || "mention",
    record: { $type: "app.bsky.feed.post", text, createdAt: new Date(Date.now()).toISOString(), ...(over.reply ? { reply: over.reply } : {}) },
    isRead: false,
    indexedAt: new Date(Date.now()).toISOString(),
  };
}

function setup(extra = {}) {
  const earlier = net ? net.discord.slice() : [];
  const earlierCalls = net ? net.calls.slice() : [];
  if (net) net.restore();
  extraRoutes = extra;
  net = installFetch({ ...healthyRoutes(), ...bs.routes, ...extra });
  net.discord.push(...earlier);
  net.calls.push(...earlierCalls);
}

beforeEach(() => {
  clk = clock("2026-11-12T14:00:00Z");
  logs = captureLogs();
  bs = fakeBsky();
  net = null;
  setup();
  db = sqliteD1();
  env = makeEnv(memoryKV(), {
    DB: db, ALERTS_ENC_KEY: ENC, ALERTS_SIGN_KEY: SIGN, APPROVED_MAPPINGS: ALL_IDS.join(","),
    BSKY_MODE: "live", BSKY_HANDLE: HANDLE, BSKY_APP_PASSWORD: PASS,
  });
});
afterEach(() => {
  const crashed = logs.lines.some((l) => /social run failed/.test(String(l)));
  net.restore(); net = null; clk.restore(); logs.restore();
  assert.ok(!crashed, "a social run crashed (see the logs)");
});

const minute = () => worker.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env, ctx);
async function board() { await runOnce(worker, env); }            // a 5-minute check run
async function socialRun() { clk.advance(5); await minute(); }    // the next due social run
const digests = (hook = HEALTH_HOOK) => net.discord.filter((d) => d.url === hook && /BLUESKY/.test(d.body.content)).map((d) => d.body.content);
const allDigest = (hook) => digests(hook).join("\n");
const posts = () => bs.created.filter((c) => c.collection === "app.bsky.feed.post").map((c) => c.record);
const replies = () => posts().filter((r) => r.reply);
const topPosts = () => posts().filter((r) => !r.reply);
const bskyCalls = () => net.calls.filter((c) => c.url.startsWith(PDS));
const isAscii = (t) => /^[\x00-\x7f]*$/.test(t);
const bytes = (t) => new TextEncoder().encode(t);
function linkFacets(rec) {
  return (rec.facets || []).map((f) => ({
    text: new TextDecoder().decode(bytes(rec.text).slice(f.index.byteStart, f.index.byteEnd)),
    uri: f.features[0].uri, type: f.features[0].$type,
  }));
}
async function claudeOutage() {
  setup({ [URLS.claude.feed]: () => json(statuspage("critical")) });
  await board();
}
async function claudeRecovers() {
  setup();
  clk.advance(5); await board();
  clk.advance(5); await board();
}

// ---------- version and switches ----------

test("this release is v1.17.1", async () => {
  await board();
  assert.ok(env.KV.store.has("samples:v1.17.1"));
});

test("off by default: without BSKY_MODE nothing touches Bluesky or the social tables", async () => {
  delete env.BSKY_MODE;
  bs.notes.push(note("is claude down?"));
  await claudeOutage();
  await minute(); await socialRun();
  assert.equal(bskyCalls().length, 0);
  assert.equal(digests().length, 0);
  const t = db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'social_events'").get();
  if (t) assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM social_events").get().n, 0);
});

test("an unknown mode value is treated as off", async () => {
  env.BSKY_MODE = "yes please";
  bs.notes.push(note("is claude down?"));
  await board(); await minute();
  assert.equal(bskyCalls().length, 0);
});

test("missing handle, app password or alert keys: off, nothing fetched", async () => {
  for (const drop of ["BSKY_HANDLE", "BSKY_APP_PASSWORD", "ALERTS_ENC_KEY"]) {
    const saved = env[drop];
    delete env[drop];
    await board(); await socialRun();
    assert.equal(bskyCalls().length, 0, "nothing fetched without " + drop);
    env[drop] = saved;
  }
});

// ---------- login ----------

test("logs in once and keeps the session encrypted in D1 (no tokens or password in plain text)", async () => {
  await board(); await minute();
  assert.equal(bs.logins, 1);
  await socialRun(); await socialRun();
  assert.equal(bs.logins, 1, "the saved session is reused");
  const dump = JSON.stringify(db.raw.prepare("SELECT * FROM social_state").all());
  for (const secret of [PASS, bs.access, bs.refresh, "acc-1", "ref-1"]) assert.ok(!dump.includes(secret), "D1 must not hold " + secret);
});

test("an expired session is refreshed with the refresh token, and the new tokens are saved", async () => {
  await board(); await minute();
  bs.expireNext = true;
  await socialRun();
  assert.equal(bs.refreshes, 1);
  assert.equal(bs.logins, 1, "refresh, not a new login");
  assert.equal(bs.lists, 3, "the list is retried once after the refresh");
  await socialRun();
  assert.equal(bs.refreshes, 1, "the new access token works: no second refresh");
  assert.equal(bs.logins, 1);
});

test("if the refresh fails, it logs in again in the same run (once)", async () => {
  await board(); await minute();
  bs.expireNext = true; bs.refreshFails = true;
  await socialRun();
  assert.equal(bs.logins, 2);
  assert.equal(bs.lists, 3);
});

test("a failed login waits 30 minutes before trying again, and says so once", async () => {
  bs.loginFails = true;
  await board(); await minute();
  assert.equal(bs.logins, 1, "at most one login per run");
  for (let i = 0; i < 5; i++) await socialRun(); // 25 minutes
  assert.equal(bs.logins, 1, "no retries during the wait");
  await socialRun(); // 30 minutes
  assert.equal(bs.logins, 2);
  assert.equal(digests().filter((d) => /login failed/i.test(d)).length, 1, "one warning, not one per run");
});

test("the app password, tokens and webhook never appear in logs or Discord", async () => {
  bs.notes.push(note("is claude down?"));
  await board(); await minute();
  bs.expireNext = true; await socialRun();
  const text = logs.lines.join("\n") + JSON.stringify(net.discord.map((d) => d.body));
  for (const secret of [PASS, "acc-1", "ref-1", "acc-2", "ref-2", "SOCIAL-SECRET", "HEALTH-SECRET"]) assert.ok(!text.includes(secret), secret);
});

// ---------- schedule and budget ----------

test("runs at most once every 5 minutes", async () => {
  await board();
  await minute(); clk.advance(1); await minute(); clk.advance(1); await minute();
  assert.equal(bs.lists, 1);
  clk.advance(3); await minute();
  assert.equal(bs.lists, 2);
});

test("asks only for mentions, replies and quotes, 50 at a time", async () => {
  await board(); await minute();
  const u = new URL(bs.listUrls[0]);
  assert.deepEqual(u.searchParams.getAll("reasons").sort(), ["mention", "quote", "reply"]);
  assert.equal(u.searchParams.get("limit"), "50");
});

async function sealed(url) {
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(ENC, "base64"), "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(url)));
  return Buffer.from(iv).toString("base64") + ":" + Buffer.from(ct).toString("base64");
}

test("waits a minute when the alert sender used most of the request budget", async () => {
  await board();
  await minute(); // creates the tables (and runs social once)
  const ran = bs.lists;
  const ins = db.raw.prepare("INSERT INTO alert_subs (id, hook_hash, hook_enc, platform, services, minor, confirmed, created_ms, confirm_sent_ms) VALUES (?, ?, ?, 'discord', ',claude,', 0, 1, ?, ?)");
  for (let i = 0; i < 31; i++) {
    const id = (i + 1).toString(16).padStart(32, "0");
    ins.run(id, "h" + i, await sealed("https://discord.com/api/webhooks/9" + i + "/t" + i), Date.now(), Date.now());
  }
  await claudeOutage();
  clk.advance(5); await minute(); // sends 31 alerts: social must wait
  assert.equal(bs.lists, ran, "no Bluesky calls in a busy alert minute");
  clk.advance(1); await minute();
  assert.equal(bs.lists, ran + 1, "runs the next minute");
});

test("a busy run stays within 12 outside requests", async () => {
  await board(); await minute();
  for (let i = 0; i < 10; i++) bs.notes.push(note("is claude down?", { who: "u" + i }));
  bs.expireNext = true; bs.refreshFails = true;
  await claudeOutage();
  const before = net.calls.length;
  clk.advance(5); await minute();
  const outside = net.calls.slice(before).filter((c) => c.url.startsWith(PDS) || c.url.startsWith("https://discord.com/"));
  assert.ok(outside.length <= 12, "used " + outside.length);
});

// ---------- the bot label ----------

test("live mode self-labels the account as a bot once, keeping every profile field", async () => {
  await board(); await minute();
  assert.equal(bs.puts.length, 1);
  const p = bs.puts[0];
  assert.equal(p.repo, DID); assert.equal(p.collection, "app.bsky.actor.profile"); assert.equal(p.rkey, "self");
  assert.equal(p.swapRecord, "cidP1", "only replaces the profile it read");
  assert.equal(p.record.displayName, "OutageRadar");
  assert.equal(p.record.description, "Live status for AI APIs");
  assert.deepEqual(p.record.avatar, bs.profile.avatar);
  assert.deepEqual(p.record.labels, { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "bot" }] });
  await socialRun(); await socialRun();
  assert.equal(bs.puts.length, 1, "only once");
});

test("an account that already has the bot label is left alone", async () => {
  bs.profile.labels = { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "bot" }] };
  await board(); await minute();
  assert.equal(bs.puts.length, 0);
});

test("if the bot label can't be set, nothing is posted in live mode", async () => {
  bs.putFails = true;
  bs.notes.push(note("is claude down?"));
  await board(); await minute();
  assert.equal(posts().length, 0);
  assert.match(allDigest(), /bot label/i);
});

test("pilot mode never writes to Bluesky (no posts, no replies, no profile change)", async () => {
  env.BSKY_MODE = "pilot";
  bs.notes.push(note("is claude down?"));
  await claudeOutage(); await minute();
  assert.equal(bs.created.length, 0);
  assert.equal(bs.puts.length, 0);
  assert.match(allDigest(), /PILOT would reply/);
  assert.match(allDigest(), /PILOT would post/);
});

// ---------- Lane A: automated replies ----------

test("a mention asking if a service is down gets one reply from board data, with a tagged link", async () => {
  await board();
  const n = note("@liveoutageradar.com is Claude down right now?");
  bs.notes.push(n);
  await minute();
  assert.equal(replies().length, 1);
  const r = replies()[0];
  assert.deepEqual(r.reply, { root: { uri: n.uri, cid: n.cid }, parent: { uri: n.uri, cid: n.cid } });
  assert.match(r.text, /^Claude: Operational\./);
  assert.match(r.text, /Official status: Operational; our API check: answering\./);
  assert.match(r.text, /As of \d\d:\d\d UTC\./);
  assert.match(r.text, /\(automated\)$/);
  assert.ok(isAscii(r.text) && r.text.length <= 300);
  assert.equal(r.$type, "app.bsky.feed.post");
  assert.ok(r.createdAt);
  assert.deepEqual(linkFacets(r), [{ text: SITE_LINK + "claude/", uri: "https://" + SITE_LINK + "claude/?utm_source=bsky_reply", type: "app.bsky.richtext.facet#link" }]);
  assert.match(allDigest(), /Replied to @alice\.test \(Claude\)/);
});

test("a reply deeper in a thread keeps the thread's root", async () => {
  await board();
  const root = { uri: "at://did:plc:zed/app.bsky.feed.post/root1", cid: "cidRoot" };
  const n = note("is openai down?", { reason: "reply", reply: { root, parent: { uri: "at://" + DID + "/app.bsky.feed.post/x", cid: "cidX" } } });
  bs.notes.push(n);
  await minute();
  assert.deepEqual(replies()[0].reply, { root, parent: { uri: n.uri, cid: n.cid } });
  assert.match(replies()[0].text, /^ChatGPT \/ OpenAI:/);
});

test("service names: Grok and Groq are told apart; two services in one question both answered", async () => {
  await board();
  bs.notes.push(note("is grok down?", { who: "g1" }), note("is groq down?", { who: "g2" }), note("are claude and gemini down?", { who: "g3" }));
  await minute();
  const t = replies().map((r) => r.text);
  assert.match(t[0], /^Grok \/ xAI:/);
  assert.match(t[1], /^Groq:/);
  assert.match(t[2], /^Claude: .*Gemini: /);
  assert.deepEqual(linkFacets(replies()[2]).map((f) => f.text), [SITE_LINK + "claude/", SITE_LINK + "gemini/"]);
  for (const r of replies()) assert.ok(r.text.length <= 300);
});

test("a feedless service says so instead of inventing an official status", async () => {
  await board();
  bs.notes.push(note("is deepseek down?"));
  await minute();
  assert.match(replies()[0].text, /Official status: no official feed; our API check: answering\./);
});

test("facet byte ranges stay right even when the person writes emoji", async () => {
  await board();
  bs.notes.push(note("\u{1F62D} is claude down?? \u00e9\u00e8"));
  await minute();
  const r = replies()[0];
  assert.ok(isAscii(r.text), "our reply is ASCII only");
  assert.equal(linkFacets(r)[0].text, SITE_LINK + "claude/");
});

test("each post is answered once, even when it shows up again", async () => {
  await board();
  bs.notes.push(note("is claude down?"));
  await minute(); await socialRun(); await socialRun();
  assert.equal(replies().length, 1);
});

test("never answers itself or accounts labeled as bots", async () => {
  await board();
  bs.notes.push(note("is claude down?", { author: { did: DID, handle: HANDLE, labels: [] } }));
  bs.notes.push(note("is claude down?", { author: { did: "did:plc:robo", handle: "robo.test", labels: [{ src: "did:plc:robo", uri: "at://did:plc:robo/app.bsky.actor.profile/self", val: "bot", cts: "2026-01-01T00:00:00Z" }] } }));
  await minute(); await socialRun();
  assert.equal(replies().length, 0);
});

test("at most 3 replies a run; the rest wait for the next run", async () => {
  await board();
  for (let i = 0; i < 5; i++) bs.notes.push(note("is claude down?", { who: "r" + i }));
  await minute();
  assert.equal(replies().length, 3);
  await socialRun();
  assert.equal(replies().length, 5);
});

test("at most 3 automated replies per person per day; extra ones go to Discord", async () => {
  await board();
  bs.notes.push(note("is claude down?", { who: "same" }), note("is openai down?", { who: "same" }));
  await minute();
  bs.notes.push(note("is gemini down?", { who: "same" }), note("is groq down?", { who: "same" }));
  await socialRun();
  assert.equal(replies().length, 3);
  assert.match(allDigest(), /Not auto-answered \(reply limit\)/);
});

test("at most 20 automated replies an hour", async () => {
  await board();
  for (let i = 0; i < 24; i++) bs.notes.push(note("is claude down?", { who: "h" + i }));
  await minute();
  for (let i = 0; i < 8; i++) { clk.advance(5); await board(); await minute(); } // 40 minutes, board kept fresh
  assert.equal(replies().length, 20);
  assert.match(allDigest(), /Not auto-answered \(reply limit\)/);
});

test("old board data is never used for an answer", async () => {
  await board();
  bs.notes.push(note("is claude down?"));
  clk.advance(20); // no check runs for 20 minutes
  await minute();
  assert.equal(replies().length, 0);
  assert.match(allDigest(), /Not auto-answered \(board data is old\)/);
});

test("quotes are never auto-answered; they go to Discord", async () => {
  await board();
  bs.notes.push(note("is claude down? lol", { reason: "quote" }));
  await minute();
  assert.equal(replies().length, 0);
  assert.match(allDigest(), /Quote from @alice\.test/);
});

// ---------- Lanes B and C: Discord ----------

test("common questions get a suggested answer in Discord, never an automatic reply", async () => {
  await board();
  bs.notes.push(note("how do I get alerts in discord?", { who: "b1" }), note("is this free?", { who: "b2" }));
  await minute();
  assert.equal(replies().length, 0);
  const d = allDigest();
  assert.match(d, /Question from @b1\.test/);
  assert.match(d, /Suggested reply: .*liveoutageradar\.com\/alerts\//);
  assert.match(d, /Question from @b2\.test/);
  assert.match(d, /Suggested reply: Yes, it's free/);
});

test("everything else is a heads-up with a link to the post", async () => {
  await board();
  const n = note("love this site", { who: "c1" });
  bs.notes.push(n);
  await minute();
  assert.equal(replies().length, 0);
  assert.ok(allDigest().includes("Mention from @c1.test"));
  assert.ok(allDigest().includes("https://bsky.app/profile/" + n.author.did + "/post/" + n.uri.split("/").pop()));
});

test("Discord gets one digest message per run, quoting people's words safely", async () => {
  await board();
  for (let i = 0; i < 6; i++) bs.notes.push(note("@everyone hello " + i, { who: "d" + i }));
  await minute();
  const msgs = net.discord.filter((d) => d.url === HEALTH_HOOK && /BLUESKY/.test(d.body.content));
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].body.allowed_mentions, { parse: [] }, "no pings, even if someone writes @everyone");
  assert.equal(msgs[0].body.flags, 4, "v1.17.1: no link preview cards (Discord SUPPRESS_EMBEDS)");
  assert.ok(msgs[0].body.content.length <= 2000);
});

test("uses DISCORD_SOCIAL_WEBHOOK when set, otherwise the health channel", async () => {
  await board();
  bs.notes.push(note("love this site"));
  env.DISCORD_SOCIAL_WEBHOOK = SOCIAL_HOOK;
  await minute();
  assert.equal(digests(SOCIAL_HOOK).length, 1);
  assert.equal(digests(HEALTH_HOOK).length, 0);
});

// ---------- incident posts ----------

test("a confirmed major outage gets one post, and its recovery one more", async () => {
  await board(); await minute();
  await claudeOutage(); clk.advance(5); await minute();
  assert.equal(topPosts().length, 1);
  const start = topPosts()[0];
  assert.match(start.text, /^Claude: Major outage since \d\d:\d\d UTC\. Official status: Major outage; our API check: answering\./);
  assert.match(start.text, /\(automated\)$/);
  assert.ok(isAscii(start.text) && start.text.length <= 300);
  assert.deepEqual(linkFacets(start), [{ text: SITE_LINK + "claude/", uri: "https://" + SITE_LINK + "claude/?utm_source=bsky_post", type: "app.bsky.richtext.facet#link" }]);
  await claudeRecovers(); clk.advance(5); await minute();
  assert.equal(topPosts().length, 2);
  assert.match(topPosts()[1].text, /^Claude: back to normal at \d\d:\d\d UTC \(problem started \d\d:\d\d UTC\)\./);
  for (let i = 0; i < 3; i++) await socialRun();
  assert.equal(topPosts().length, 2, "each posted once");
});

test("minor (degraded) episodes are not posted", async () => {
  await board(); await minute();
  setup({ [URLS.claude.feed]: () => json(statuspage("minor")) });
  await board(); clk.advance(5); await minute();
  assert.equal(topPosts().length, 0);
});

test("an old incident event (over 30 minutes) is dropped, not posted late", async () => {
  await board(); await minute();
  await claudeOutage();
  clk.advance(31); await board(); await minute();
  assert.equal(topPosts().length, 0);
});

test("a recovery is only posted if its start was posted", async () => {
  delete env.BSKY_MODE;
  await claudeOutage();
  env.BSKY_MODE = "live";
  await claudeRecovers(); clk.advance(5); await minute();
  assert.equal(topPosts().length, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM social_events WHERE done = 0").get().n, 0, "the end event is handled, not stuck");
});

test("a signals-disagree incident is never posted", async () => {
  await board(); await minute();
  setup({ [URLS.groq.probe]: () => html("bad gateway", 502) });
  await board(); clk.advance(5); await board(); // two failed checks: signals disagree
  await minute();
  assert.equal(topPosts().length, 0);
});

test("at most 2 incident posts a run and 6 an hour", async () => {
  await board(); await minute();
  // Eight real outages (statuspage and Better Stack feeds), so the 6-an-hour cap is what stops the 7th.
  const sp = ["openai", "mistral", "claude", "cohere", "fireworks", "perplexity"];
  setup({
    ...Object.fromEntries(sp.map((id) => [URLS[id].feed, () => json(statuspage("critical"))])),
    [URLS.together.feed]: () => json(betterstack("downtime")),
    [URLS.huggingface.feed]: () => json(betterstack("downtime")),
  });
  await board();
  clk.advance(5); await minute();
  assert.equal(topPosts().length, 2);
  for (let i = 0; i < 3; i++) { clk.advance(5); await board(); await minute(); }
  assert.equal(topPosts().length, 6);
});

test("an outage that is already over at posting time is not posted", async () => {
  await board(); await minute();
  await claudeOutage();
  setup(); clk.advance(5); await board(); // healthy again before the social run
  await minute();
  assert.equal(topPosts().length, 0);
});

// ---------- privacy promise: social records are kept at most 8 days ----------

test("records about people's posts are deleted after 8 days, even with Bluesky switched off", async () => {
  bs.notes.push(note("love this site"));
  await board(); await minute();
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM social_seen").get().n, 1);
  delete env.BSKY_MODE; // switched off: the social run no longer happens
  clk.set("2026-11-20T15:00:00Z"); // 8 days and an hour later, at the top of an hour
  await board();
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM social_seen").get().n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM social_log").get().n, 0);
});

test("other health and outage messages keep their link previews (only the digest turns them off)", async () => {
  await claudeOutage();
  const outage = net.discord.filter((d) => d.url !== HEALTH_HOOK || !/BLUESKY/.test(d.body.content));
  assert.ok(outage.length > 0);
  for (const d of outage) assert.equal(d.body.flags, undefined);
});
