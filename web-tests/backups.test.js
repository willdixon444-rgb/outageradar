// "Switch to a backup" (v1.9.0): verified backup list, the section on every
// history page, the board's link during problems, and live status labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SHELL, buildView, TROUBLE_KEYS } from "../site/board.js";
import { backupState } from "../site/service.js";
import { BACKUPS, backupsFor } from "../tools/backups.mjs";

const page = (id) => readFileSync(new URL("../site/status/" + id + "/index.html", import.meta.url), "utf8");

// Addresses checked against each provider's own docs on Nov 8, 2026.
const VERIFIED = {
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openai: "https://api.openai.com/v1",
  claude: "https://api.anthropic.com/v1/",
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com",
};

test("every backup address is exactly the one in the provider's docs", () => {
  assert.deepEqual(Object.fromEntries(BACKUPS.map((b) => [b.id, b.base_url])), VERIFIED);
});

test("every backup has a key variable, an official docs link and a model list link", () => {
  for (const b of BACKUPS) {
    assert.match(b.env, /^[A-Z]+_API_KEY$/, b.id);
    for (const u of [b.docs, b.models]) assert.match(u, /^https:\/\/[a-z.-]+\//, b.id + " " + u);
  }
});

test("a service never lists itself, and gets four backups", () => {
  for (const s of SHELL) {
    const list = backupsFor(s.id);
    assert.equal(list.length, 4, s.id);
    assert.ok(list.every((b) => b.id !== s.id), s.id);
  }
});

test("every history page has the backup section with working code for each backup", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    assert.match(html, /<section class="sec backup" id="backup"/, s.id);
    for (const b of backupsFor(s.id)) {
      assert.ok(html.includes(b.base_url), s.id + " missing " + b.id);
      assert.ok(html.includes('os.environ["' + b.env + '"]'), s.id + " python key " + b.id);
      assert.ok(html.includes("process.env." + b.env), s.id + " js key " + b.id);
      assert.ok(html.includes('data-backup="' + b.id + '"'), s.id);
    }
    assert.ok(html.includes("PICK_FROM_LIST"), s.id);
  }
});

test("code never contains a real-looking key and never asks for one on the page", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    assert.doesNotMatch(html, /\b(sk-|gsk_|xai-)[A-Za-z0-9]{8,}/, s.id);
    assert.doesNotMatch(html, /<input[^>]*(key|token)/i, s.id);
  }
});

test("the safety notes are there: test first, different company, Claude's testing caveat", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    assert.match(html, /Test a backup in development before routing production traffic/, s.id);
    assert.match(html, /different company/, s.id);
    if (backupsFor(s.id).some((b) => b.id === "claude")) assert.match(html, /mainly for testing/, s.id);
  }
});

test("no referral or sponsored links yet; TokenMargin linked plainly for full setups", () => {
  for (const s of SHELL) {
    const html = page(s.id);
    assert.doesNotMatch(html, /sponsored|utm_|[?&]ref=|\baffiliate\b/i, s.id); // "not affiliated" in the footer is fine
    assert.match(html, /<a href="https:\/\/tokenmargin\.dev" target="_blank" rel="noopener">TokenMargin<\/a>/, s.id);
  }
});

test("the page still loads only our own script", () => {
  for (const s of SHELL) {
    const srcs = [...page(s.id).matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ["/service.js"], s.id);
  }
});

// ---------- live status of each backup ----------

test("a backup's live label: up, having problems, or unknown", () => {
  assert.deepEqual(backupState({ badge: { key: "operational", label: "Operational" } }), { cls: "ok", text: "Operational right now" });
  assert.deepEqual(backupState({ badge: { key: "check_ok", label: "Up (our check only)" } }), { cls: "ok", text: "Up right now (our check only)" });
  assert.deepEqual(backupState({ badge: { key: "major_outage", label: "Major outage" } }), { cls: "bad", text: "Also having problems (Major outage). Try another." });
  assert.deepEqual(backupState({ badge: { key: "unknown", label: "Unknown" } }), { cls: "unk", text: "Status unknown right now" });
  assert.deepEqual(backupState(null), { cls: "unk", text: "Not tracked on OutageRadar yet" });
});

// ---------- the board's link during problems ----------

function viewWith(overall) {
  const now = "2026-11-08T21:00:00Z";
  const services = SHELL.map((s) => ({
    id: s.id, name: s.name, status_page: s.status_page, overall: s.id === "claude" ? overall : "operational",
    official: { label: "Official status", status: "operational", checked_at_utc: now, note: "" },
    probe: { label: "API server answering (our check)", status: "reachable", checked_at_utc: now, http_status: 401, note: "" },
  }));
  return buildView({ schema: 1, generated_at_utc: now, served_at_utc: now, age_seconds: 10, stale: false, services }, { elapsedSec: 5 });
}

test("the board offers a backup link only while a service has problems", () => {
  for (const key of ["degraded", "partial_outage", "major_outage", "signals_disagree", "check_failed"]) {
    assert.ok(TROUBLE_KEYS.includes(key));
    assert.equal(viewWith(key).services.find((s) => s.id === "claude").troubled, true, key);
  }
  for (const key of ["operational", "maintenance", "unknown", "check_ok"]) {
    assert.equal(viewWith(key).services.find((s) => s.id === "claude").troubled, false, key);
  }
  assert.ok(buildView(null, { state: "loading" }).services.every((s) => s.troubled === false));
});

test("the board's link goes to the backup section of that service's page", () => {
  assert.match(readFileSync(new URL("../site/board.js", import.meta.url), "utf8"), /"\/status\/" \+ encodeURIComponent\(m\.id\) \+ "\/#backup"/);
});
