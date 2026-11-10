// Writes site/status/<id>/index.html for every service on the board, from one
// template, so all pages stay identical in structure. Styles are copied from
// site/index.html so the pages always match the board.
//   Run after changing the service list, the board's styles or this file:
//     node tools/status-pages.mjs
// web-tests/pages.test.js fails if a committed page differs from this output.
// Output must stay ASCII-only (names use HTML entities where needed).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHELL } from "../site/board.js";
import { backupsFor, pythonSnippet, jsSnippet } from "./backups.mjs";
import { ERRORS, errorsFor, renderErrorPage, renderErrorsHub } from "./errors.mjs";

export const SITE_URL = "https://liveoutageradar.com";
// The day the incident log started (checker v1.6.0 deploy). The page script
// replaces this with the exact date from the data when it loads.
export const PAGE_LOG_START = "Nov 8, 2026";

// Search-friendly names: people search "is ChatGPT down", not "is ChatGPT / OpenAI down".
const SEARCH_NAMES = {
  openai: { short: "ChatGPT", company: "OpenAI" },
  xai: { short: "Grok", company: "xAI" },
};

export function pageNames(s) {
  const extra = SEARCH_NAMES[s.id] || {};
  return { short: extra.short || s.name, full: s.name, company: extra.company || "" };
}

export function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Code blocks only need & < > escaped; quotes stay readable in the source.
export function escCode(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function boardStyles() {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!m) throw new Error("no <style> in site/index.html");
  return m[1].trim();
}

export const PAGE_STYLES = `
.crumbs{margin:1rem 0 0;font-size:.9rem;color:var(--muted)}
.crumbs a{color:var(--muted)}
.brand a{text-decoration:none}
.page-h1{margin:1rem 0 .4rem;font-size:clamp(1.5rem,5vw,2.1rem);line-height:1.2}
.lede{margin:0 0 1.25rem}
.now{margin:0 0 1.75rem}
.now .row{border-top:1px solid var(--line)}
.sec{margin-top:1.75rem}
.sec h2{margin:0 0 .4rem;font-size:1.15rem}
.since{margin:0 0 .75rem;color:var(--muted);font-size:.92rem}
.history{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.history li{display:grid;grid-template-columns:minmax(0,10rem) minmax(0,1fr) auto;gap:.15rem 1rem;padding:.7rem 0;border-bottom:1px solid var(--line)}
.history li.empty{display:block;color:var(--muted)}
.history .when{color:var(--muted)}
.history .len{text-align:right;color:var(--muted)}
.history .inote{grid-column:1 / -1;font-size:.85rem;color:var(--dis)}
.others ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.4rem .9rem}
.others a{color:var(--muted)}
.backup .intro{margin:0 0 .75rem}
.backups{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.backups li{border-bottom:1px solid var(--line)}
.backups li.is-bad summary .bn{text-decoration:line-through;color:var(--muted)}
.backups summary{cursor:pointer;padding:.7rem 0;display:flex;flex-wrap:wrap;gap:.25rem .75rem;align-items:baseline}
.backups summary:focus-visible{outline:3px solid var(--teal);outline-offset:2px}
.backups .bn{font-weight:600}
.bs{font-size:.88rem;color:var(--muted)}
.bs-ok{color:var(--op)}
.bs-bad{color:var(--dis)}
.bnote,.blinks{margin:0 0 .5rem;font-size:.9rem;color:var(--muted)}
.lang{margin:.6rem 0 .25rem;font-size:.85rem;color:var(--muted)}
.code{position:relative;margin:0 0 .75rem}
.code pre{margin:0;padding:.75rem;padding-right:4.5rem;background:#04100b;border:1px solid var(--line);border-radius:8px;overflow-x:auto;font-size:.82rem;line-height:1.5}
.code button.copy{position:absolute;top:.4rem;right:.4rem;font:inherit;font-size:.8rem;padding:.25rem .6rem;border-radius:6px;border:1px solid var(--line);background:#0f241a;color:var(--text);cursor:pointer}
.code button.copy:focus-visible{outline:3px solid var(--teal);outline-offset:2px}
@media (max-width:40rem){.history li{grid-template-columns:minmax(0,1fr) auto}.history .when{grid-column:1 / -1;order:3}}
`;

// v1.13.0: where the official signal comes from when it is not the service's
// own status page. GitHub Copilot's comes from GitHub's page (the components
// named are the ones the checker reads; see worker/checker.js).
const OFFICIAL_SOURCE = {
  "github-copilot": {
    how: "GitHub publishes Copilot&rsquo;s status on <a href=\"https://www.githubstatus.com\">githubstatus.com</a>. OutageRadar reads its Copilot and Copilot AI Model Providers components every five minutes.",
    history: "GitHub&rsquo;s own explanations, see <a href=\"https://www.githubstatus.com\">GitHub&rsquo;s status page</a>",
  },
};

export function backupSection(s, n) {
  // v1.12.0: services used through their own apps (GitHub Copilot) have no
  // drop-in API to switch to; say so plainly instead of showing API code.
  if (s.nobackup) {
    return `<section class="sec backup" id="backup" aria-labelledby="h-backup">
    <h2 id="h-backup">If ${esc(n.short)} is down</h2>
    <p class="intro">${esc(n.full)} is used through its own apps and editor extensions, so there is no drop-in replacement you can switch to by changing an address and a key. Follow <a href="${esc(s.status_page)}">the official status page</a> for updates; the history above shows how long past incidents lasted.</p>
  </section>`;
  }
  const items = backupsFor(s.id).map((b, i) => {
    const py = "code-" + b.id + "-py";
    const js = "code-" + b.id + "-js";
    return '<li data-backup="' + b.id + '" data-status="' + (b.status || "") + '">\n' +
      "      <details" + (i === 0 ? " open" : "") + ">\n" +
      '        <summary><span class="bn">' + esc(b.name) + '</span> <span class="bs bs-unk">' +
      (b.status ? "Checking&hellip;" : "Not tracked on OutageRadar yet") + "</span></summary>\n" +
      (b.note ? '        <p class="bnote">' + esc(b.note) + "</p>\n" : "") +
      '        <p class="blinks"><a href="' + esc(b.models) + '">' + esc(b.name) + "&rsquo;s current model list</a> &middot; " +
      '<a href="' + esc(b.docs) + '">setup guide</a></p>\n' +
      '        <p class="lang">Python</p>\n' +
      '        <div class="code"><button class="copy" type="button" data-copy="' + py + '" hidden>Copy</button><pre><code id="' + py + '">' +
      escCode(pythonSnippet(b)) + "</code></pre></div>\n" +
      '        <p class="lang">JavaScript</p>\n' +
      '        <div class="code"><button class="copy" type="button" data-copy="' + js + '" hidden>Copy</button><pre><code id="' + js + '">' +
      escCode(jsSnippet(b)) + "</code></pre></div>\n" +
      "      </details>\n    </li>";
  }).join("\n    ");
  return `<section class="sec backup" id="backup" aria-labelledby="h-backup">
    <h2 id="h-backup">If ${esc(n.short)} is down: switch to a backup</h2>
    <p class="intro">These AI APIs work with the official OpenAI library. Change the address and the key, pick a model from that provider&rsquo;s list, and you&rsquo;re running again. Each shows its live status, so you don&rsquo;t switch to one that&rsquo;s also down.</p>
    <ul class="backups">
    ${items}
    </ul>
    <p class="since">Test a backup in development before routing production traffic. Pick a model from a different company than the one that&rsquo;s down. Your code talks to the provider directly; OutageRadar never sees your key. For a full automatic fallback setup, see <a href="https://tokenmargin.dev" target="_blank" rel="noopener">TokenMargin</a>.</p>
  </section>`;
}

// v1.14.0: links to this provider's API error pages, if any.
function errorLinks(s, n) {
  const list = errorsFor(s.id);
  if (!list.length) return "";
  return `<nav class="sec others" aria-labelledby="h-errors">
    <h2 id="h-errors">Common ${esc(n.short)} API errors</h2>
    <ul>
      ${list.map((e) => '<li><a href="/errors/' + e.slug + '/">' + esc(e.h1) + "</a></li>").join("\n      ")}
    </ul>
  </nav>
  `;
}

export function renderServicePage(s, all = SHELL) {
  const n = pageNames(s);
  const url = SITE_URL + "/status/" + s.id + "/";
  const title = n.company
    ? "Is " + n.short + " down? " + n.company + " status and outage history"
    : "Is " + n.short + " down? Live status and outage history";
  // Kept under ~160 characters so search results show it whole.
  const how = s.nofeed
    ? "our own API check (no official feed exists)"
    : "the official status feed plus our own API check";
  const description = "Is " + n.short + " down right now? Live " + n.short + " status from " + how +
    " every 5 minutes, and recent " + n.short + " outages.";
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": url,
        url,
        name: title,
        description,
        isPartOf: { "@type": "WebSite", name: "OutageRadar", url: SITE_URL + "/" },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "OutageRadar", item: SITE_URL + "/" },
          { "@type": "ListItem", position: 2, name: n.full + " status", item: url },
        ],
      },
    ],
  };
  const others = all.filter((o) => o.id !== s.id)
    .map((o) => '<li><a href="/status/' + o.id + '/">Is ' + esc(pageNames(o).short) + " down?</a></li>").join("\n      ");
  const officialLine = s.nofeed
    ? "No public status feed from the provider. Reachability checked by OutageRadar."
    : "Official status: checking&hellip;";
  const howParas = s.nofeed
    ? "<p>" + esc(n.full) + " publishes no public status feed. OutageRadar asks its API server for a reply every five minutes; a reply, even &ldquo;needs a key&rdquo;, shows the server is up. It does not prove the AI is answering questions. The time shown is how long the API server took to answer our check, from Cloudflare&rsquo;s network; it varies by moment and location and is not the speed of AI replies. This is shown as &ldquo;Up (our check only)&rdquo; with a dashed outline, never as an official all-clear.</p>"
    : (OFFICIAL_SOURCE[s.id]
      ? "<p><strong>Official status</strong>: " + OFFICIAL_SOURCE[s.id].how + "</p>"
      : "<p><strong>Official status</strong> is what " + esc(n.full) + " publishes on <a href=\"" + esc(s.status_page) + "\">its own status page</a>, read every five minutes.</p>") +
      "\n    <p><strong>Our check</strong> is OutageRadar asking " + esc(n.full) + "&rsquo;s API server for a reply at the same time. A reply, even &ldquo;needs a key&rdquo;, proves the server is up; it does not prove the AI is answering questions. The time shown is how long the API server took to answer our check, from Cloudflare&rsquo;s network; it varies by moment and location and is not the speed of AI replies.</p>";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='29' fill='%2307140e' stroke='%234be08a' stroke-width='4'/%3E%3Ccircle cx='32' cy='32' r='4' fill='%234be08a'/%3E%3Ccircle cx='44' cy='20' r='4' fill='%234be08a'/%3E%3Ccircle cx='20' cy='42' r='4' fill='%23ffb547'/%3E%3C/svg%3E">
<!-- Generated by tools/status-pages.mjs. Do not edit by hand. -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="OutageRadar">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
${boardStyles()}
${PAGE_STYLES.trim()}
</style>
</head>
<body data-service="${s.id}">
<div class="wrap">
  <header class="top">
    <p class="brand"><a href="/">Outage<span>Radar</span></a></p>
    <p class="meta"><span class="live live-checking" id="live"><i aria-hidden="true"></i><span class="ll">Checking&hellip;</span></span>
      <span class="updated" id="updated" aria-live="polite">Checking&hellip;</span></p>
  </header>

  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">All AI services</a> / ${esc(n.full)}</nav>
  <h1 class="page-h1">Is ${esc(n.short)} down?</h1>
  <p class="lede">Live ${esc(n.full)} status, checked every five minutes, and a log of recent ${esc(n.short)} outages. All times are UTC.</p>

  <p class="banner" id="banner" role="status" hidden></p>
  <section class="now" aria-label="${esc(n.full)} status right now">
    <div class="row s-checking" id="row"><span class="pill"><span class="pi" aria-hidden="true">&hellip;</span><span class="pl">Checking&hellip;</span></span>
      <h2 class="name"><a href="${esc(s.status_page)}">${esc(n.full)}</a></h2>
      <p class="official">${officialLine}</p><p class="probe"><span class="pt">Our check: checking&hellip;</span> <span class="pc"></span></p><p class="note" hidden></p></div>
  </section>

  <section class="sec" aria-labelledby="h-history">
    <h2 id="h-history">${esc(n.short)} outage history</h2>
    <p class="since" id="since">History logged by OutageRadar since ${PAGE_LOG_START}.</p>
    <ul class="history" id="history"><li class="empty">Loading incident history&hellip;</li></ul>
    <noscript><p>The history list needs JavaScript.</p></noscript>
    <p class="since">For incidents before that, and for ${OFFICIAL_SOURCE[s.id] ? OFFICIAL_SOURCE[s.id].history : esc(n.full) + "&rsquo;s own explanations, see the <a href=\"" + esc(s.status_page) + "\">official " + esc(n.full) + " status page</a>"}.</p>
  </section>

  ${backupSection(s, n)}

  <section class="sec about" aria-labelledby="h-how">
    <h2 id="h-how">How OutageRadar checks ${esc(n.full)}</h2>
    ${howParas}
    <p>An incident is logged when the official status shows degraded performance or an outage, or when our check fails twice in a row. It ends after two healthy checks in a row. Times are when our checker saw the change, within five minutes.</p>
  </section>

  ${errorLinks(s, n)}<nav class="sec others" aria-labelledby="h-others">
    <h2 id="h-others">Other AI services</h2>
    <ul>
      ${others}
    </ul>
    <p><a href="/">See all services on the live board</a></p>
  </nav>

  <footer class="about">
    <p class="legal">OutageRadar is independent and not affiliated with ${esc(n.full)} or any service listed. <a href="/privacy.html">Privacy</a>. Questions or corrections: <a href="mailto:contact@liveoutageradar.com">contact@liveoutageradar.com</a>. &copy; 2026 OutageRadar</p>
  </footer>
</div>
<script type="module" src="/service.js"></script>
</body>
</html>
`;
}

function main() {
  for (const s of SHELL) {
    const dir = new URL("../site/status/" + s.id + "/", import.meta.url);
    mkdirSync(dir, { recursive: true });
    const html = renderServicePage(s, SHELL);
    if ([...Buffer.from(html)].some((b) => b > 127)) throw new Error("non-ASCII output for " + s.id);
    writeFileSync(new URL("index.html", dir), html);
    console.log("wrote site/status/" + s.id + "/index.html");
  }
  // v1.14.0: API error pages and their hub.
  const pages = ERRORS.map((e) => ["errors/" + e.slug + "/", renderErrorPage(e)]).concat([["errors/", renderErrorsHub()]]);
  for (const [path, html] of pages) {
    const dir = new URL("../site/" + path, import.meta.url);
    mkdirSync(dir, { recursive: true });
    if ([...Buffer.from(html)].some((b) => b > 127)) throw new Error("non-ASCII output for " + path);
    writeFileSync(new URL("index.html", dir), html);
    console.log("wrote site/" + path + "index.html");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
