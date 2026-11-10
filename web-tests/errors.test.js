// API error pages (site v1.14.0, Nov 10, 2026): /errors/<slug>/ and the /errors/ hub.
// Facts come only from each provider's official docs (checked Nov 10, 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SHELL } from "../site/board.js";
import { ERRORS, LAST_CHECKED, RETRY_PY, RETRY_JS, renderErrorPage, renderErrorsHub, errorsFor } from "../tools/errors.mjs";

const SITE = (f) => readFileSync(new URL("../site/" + f, import.meta.url), "utf8");
const page = (slug) => SITE("errors/" + slug + "/index.html");
const URL_FOR = (slug) => "https://liveoutageradar.com/errors/" + slug + "/";
const DOCS_DOMAIN = {
  claude: "https://platform.claude.com/docs/",
  openai: "https://developers.openai.com/api/docs/",
  gemini: "https://ai.google.dev/gemini-api/docs/",
  deepseek: "https://api-docs.deepseek.com/",
};

test("the first batch is exactly these eight pages", () => {
  assert.deepEqual(ERRORS.map((e) => e.slug), [
    "claude-529-overloaded", "claude-429-rate-limit",
    "openai-503-overloaded", "openai-429-rate-limit", "openai-insufficient-quota",
    "gemini-429-resource-exhausted", "gemini-503-unavailable",
    "deepseek-503-server-overloaded",
  ]);
  for (const e of ERRORS) {
    assert.ok(SHELL.some((s) => s.id === e.service), e.slug + " service is on the board");
    assert.ok(["server", "rate", "account"].includes(e.bucket), e.slug);
  }
});

test("every page and the hub match what the generator makes", () => {
  for (const e of ERRORS) {
    assert.ok(existsSync(new URL("../site/errors/" + e.slug + "/index.html", import.meta.url)), e.slug);
    assert.equal(page(e.slug), renderErrorPage(e), e.slug + " is out of date: run node tools/status-pages.mjs");
  }
  assert.equal(SITE("errors/index.html"), renderErrorsHub());
});

test("every page links its provider's own official docs and says when it was checked", () => {
  for (const e of ERRORS) {
    assert.ok(e.docs.url.startsWith(DOCS_DOMAIN[e.service]), e.slug + ": " + e.docs.url);
    assert.ok(page(e.slug).includes('href="' + e.docs.url + '"'), e.slug);
    assert.ok(page(e.slug).includes("Last checked against official docs: " + LAST_CHECKED), e.slug);
  }
  assert.equal(LAST_CHECKED, "Nov 10, 2026");
});

test("titles, headings and descriptions are unique and searchable", () => {
  const titles = new Set();
  for (const e of ERRORS) {
    const html = page(e.slug);
    const title = html.match(/<title>([^<]+)<\/title>/)[1];
    titles.add(title);
    assert.ok(title.includes(String(e.code)) || e.slug === "openai-insufficient-quota", e.slug);
    assert.ok(html.includes('<link rel="canonical" href="' + URL_FOR(e.slug) + '">'), e.slug);
    const desc = html.match(/<meta name="description" content="([^"]+)">/)[1];
    assert.ok(desc.length >= 60 && desc.length <= 165, e.slug + ": " + desc.length);
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, e.slug);
  }
  assert.equal(titles.size, ERRORS.length);
});

test("pages carry WebPage and breadcrumb data, no FAQ markup", () => {
  for (const e of ERRORS) {
    const html = page(e.slug);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1, e.slug);
    const types = JSON.parse(blocks[0][1])["@graph"].map((x) => x["@type"]).sort();
    assert.deepEqual(types, ["BreadcrumbList", "WebPage"], e.slug);
    assert.doesNotMatch(html, /FAQPage/);
  }
});

test("pages show that provider's live status and history, never green before data", () => {
  for (const e of ERRORS) {
    const html = page(e.slug);
    assert.match(html, new RegExp('<body data-service="' + e.service + '">'), e.slug);
    const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ["/service.js"], e.slug);
    for (const id of ['id="row"', 'id="history"', 'id="since"', 'id="live"', 'id="updated"', 'id="banner"']) assert.ok(html.includes(id), e.slug + " " + id);
    const body = html.split("</head>")[1];
    assert.match(body, /class="row s-checking"/);
    assert.doesNotMatch(body, /s-operational/);
    assert.ok(html.includes('href="/status/' + e.service + '/"'), e.slug + " links the history page");
  }
});

test("server-side errors: provider's servers, backup box, honest about the status page", () => {
  for (const e of ERRORS.filter((x) => x.bucket === "server")) {
    const html = page(e.slug);
    assert.match(html, /comes from [^<]+&rsquo;s servers, not from your code/, e.slug);
    assert.match(html, /status page may not show it yet/, e.slug);
    assert.match(html, /<section class="sec backup" id="backup"/, e.slug);
    assert.match(html, /data-backup="/, e.slug);
  }
});

test("rate limits: your limit, no backup box; account errors: not an outage, no retry code", () => {
  for (const e of ERRORS.filter((x) => x.bucket === "rate")) {
    const html = page(e.slug);
    assert.match(html, /Request limit/, e.slug);
    assert.doesNotMatch(html, /data-backup="/, e.slug);
    assert.ok(html.includes("def with_retries"), e.slug);
  }
  const quota = page("openai-insufficient-quota");
  assert.match(quota, /not an outage/);
  assert.match(quota, /Retrying will not/);
  assert.doesNotMatch(quota, /data-backup="|def with_retries/);
  for (const code of ["credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]) {
    assert.ok(quota.includes(code), code);
  }
  assert.match(quota, /You exceeded your current quota/);
});

test("OpenAI's slow_down is a 429 on the rate-limit page", () => {
  const html = page("openai-429-rate-limit");
  assert.match(html, /slow_down/);
  assert.match(html, /rate_limit_error/);
  // The 503 page's own content (the link list to other pages may name slow_down).
  assert.doesNotMatch(page("openai-503-overloaded").split('id="h-others"')[0], /slow_down/);
  assert.match(page("openai-503-overloaded"), /server_is_overloaded/);
});

test("an error's JSON shape is shown only where the official docs show one", () => {
  for (const e of ERRORS) {
    const has = page(e.slug).includes('<pre class="shape">');
    assert.equal(has, e.service === "claude" || e.service === "gemini", e.slug);
  }
});

test("no limits or prices that change (RPM, TPM, dollar amounts)", () => {
  for (const e of ERRORS) {
    const text = page(e.slug).split("</head>")[1];
    assert.doesNotMatch(text, /\d[\d,.]*\s*(RPM|TPM|RPD|requests per (minute|day)|tokens per minute)/i, e.slug);
    assert.doesNotMatch(text, /\$\s?\d/, e.slug);
  }
});

test("pages are ASCII and set nothing in the browser", () => {
  for (const e of ERRORS) assert.ok([...Buffer.from(page(e.slug))].every((b) => b < 128), e.slug);
  assert.ok([...Buffer.from(SITE("errors/index.html"))].every((b) => b < 128));
  assert.doesNotMatch(SITE("errors/index.html"), /<script[^>]*src=/);
});

// ---------- the retry helper really works ----------

test("the JavaScript retry helper retries, honors a server delay, and stops", async () => {
  const withRetries = new Function("setTimeout", RETRY_JS + "\nreturn withRetries;")((fn) => fn());
  let n = 0;
  const flaky = async () => { n += 1; if (n < 3) throw Object.assign(new Error("busy"), { status: 529 }); return "ok"; };
  assert.equal(await withRetries(flaky, (e) => e.status === 529, () => 0), "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRetries(async () => { n += 1; throw new Error("bad key"); }, () => false), /bad key/);
  assert.equal(n, 1, "never retries an error that isn't retryable");
  n = 0;
  await assert.rejects(withRetries(async () => { n += 1; throw new Error("busy"); }, () => true, () => 0, 4), /busy/);
  assert.equal(n, 4, "gives up after the attempt limit");
});

test("the Python retry helper retries, honors a server delay, and backs off without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "retry-"));
  const file = join(dir, "t.py");
  writeFileSync(file, RETRY_PY + `
import time as _t
waits = []
_t.sleep = waits.append
calls = {"n": 0}
def flaky():
    calls["n"] += 1
    if calls["n"] < 3:
        raise RuntimeError("busy")
    return "ok"
assert with_retries(flaky, lambda e: True, retry_after=lambda e: 7) == "ok"
assert calls["n"] == 3 and waits == [7, 7], waits
waits.clear(); calls["n"] = 0
assert with_retries(flaky, lambda e: True) == "ok"
assert len(waits) == 2 and 1 <= waits[0] < 2 and 2 <= waits[1] < 3, waits
calls["n"] = 0
try:
    with_retries(lambda: (_ for _ in ()).throw(ValueError("bad key")), lambda e: False)
    raise SystemExit("should have raised")
except ValueError:
    pass
print("PY_OK")
`);
  const out = spawnSync("python3", [file], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /PY_OK/);
});

// ---------- links, sitemap, llms.txt ----------

test("the hub lists one error per line, each with a short plain note", () => {
  const hub = SITE("errors/index.html");
  assert.doesNotMatch(hub, /class="sec others"/, "no wrapping side-by-side links");
  for (const e of ERRORS) {
    assert.ok(typeof e.note === "string" && e.note.length >= 20 && e.note.length <= 90, e.slug);
    assert.ok(hub.includes('<li><a href="/errors/' + e.slug + '/">' + e.h1 + '</a><span class="en">' + e.note + "</span></li>"), e.slug);
  }
});

test("the hub lists every error page; history pages list their provider's errors", () => {
  const hub = SITE("errors/index.html");
  for (const e of ERRORS) assert.ok(hub.includes('href="/errors/' + e.slug + '/"'), e.slug);
  for (const s of SHELL) {
    const html = SITE("status/" + s.id + "/index.html");
    const mine = errorsFor(s.id);
    for (const e of mine) assert.ok(html.includes('href="/errors/' + e.slug + '/"'), s.id + " -> " + e.slug);
    assert.equal(html.includes('id="h-errors"'), mine.length > 0, s.id);
  }
});

test("the sitemap and llms.txt list the hub and every error page", () => {
  const xml = SITE("sitemap.xml");
  const txt = SITE("llms.txt");
  assert.ok(xml.includes("<loc>https://liveoutageradar.com/errors/</loc>"));
  assert.ok(txt.includes("https://liveoutageradar.com/errors/"));
  for (const e of ERRORS) {
    assert.ok(xml.includes("<loc>" + URL_FOR(e.slug) + "</loc>"), e.slug);
    assert.ok(txt.includes(URL_FOR(e.slug)), e.slug);
  }
});
