// API error pages (site v1.14.0): /errors/<slug>/ and the /errors/ hub.
// Written by `node tools/status-pages.mjs` together with the history pages.
// Every fact below was checked against the provider's own docs on Nov 10, 2026
// (links in `docs` / `more`). Re-check before changing a fact; keep wording our
// own (only short error names are quoted) and never add limits or prices that
// change (requests per minute, tiers, dollar amounts): link to the docs instead.
// Buckets (from the AG review): server = provider capacity, backup box shown;
// rate = the account's request limits; account = billing/quota, not an outage.

import { SHELL } from "../site/board.js";
import { SITE_URL, OG_IMAGE, esc, escCode, pageNames, boardStyles, PAGE_STYLES, backupSection } from "./status-pages.mjs";

export const LAST_CHECKED = "Nov 10, 2026";

const DOCS = {
  claude: { url: "https://platform.claude.com/docs/en/api/errors", label: "Claude API errors (Anthropic docs)" },
  claudeLimits: { url: "https://platform.claude.com/docs/en/api/rate-limits", label: "Claude API rate limits (Anthropic docs)" },
  openai: { url: "https://developers.openai.com/api/docs/guides/error-codes", label: "Error codes (OpenAI docs)" },
  openaiLimits: { url: "https://developers.openai.com/api/docs/guides/rate-limits", label: "Rate limits (OpenAI docs)" },
  gemini: { url: "https://ai.google.dev/gemini-api/docs/api-errors", label: "Gemini API errors (Google docs)" },
  geminiRetry: { url: "https://ai.google.dev/gemini-api/docs/troubleshooting", label: "Gemini API troubleshooting: retry strategy (Google docs)" },
  geminiLimits: { url: "https://ai.google.dev/gemini-api/docs/rate-limits", label: "Gemini API rate limits (Google docs)" },
  deepseek: { url: "https://api-docs.deepseek.com/quick_start/error_codes", label: "Error codes (DeepSeek API docs)" },
};

// Error body shapes, only where the provider's docs show one. Message text varies.
const SHAPE_CLAUDE = (type) => JSON.stringify({
  type: "error", error: { type, message: "..." }, request_id: "req_...",
}, null, 2);
const SHAPE_GEMINI = (code, status) => JSON.stringify({
  error: { code, message: "...", status, details: ["..."] },
}, null, 2);

export const ERRORS = [
  {
    slug: "claude-529-overloaded",
    note: "Anthropic&rsquo;s servers are overloaded. It&rsquo;s on their side.", service: "claude", provider: "Anthropic", api: "Claude API",
    code: 529, name: "overloaded_error", bucket: "server",
    title: "Claude API 529 overloaded_error: what it means and what to do",
    h1: "Claude API error 529: overloaded_error",
    description: "Claude API 529 overloaded_error means Anthropic's API is temporarily overloaded. Live Claude status, our own check, and what to do now.",
    meaning: [
      "Anthropic&rsquo;s docs describe a 529 <code>overloaded_error</code> as the API being temporarily overloaded. It can happen when the API has high traffic across all users, so it is not caused by your request or your API key.",
      "It is different from a 429 <code>rate_limit_error</code>, which is about your own organization&rsquo;s limits.",
    ],
    shape: SHAPE_CLAUDE("overloaded_error"),
    fix: [
      "Retry with exponential backoff. Anthropic&rsquo;s official SDK already retries server errors like this one automatically and honors the <code>retry-after</code> header; its <code>max_retries</code> setting controls how many times.",
      "If it keeps failing, check Claude&rsquo;s status above and the official status page.",
      "If you need answers now, switch to a backup (below) until it clears.",
    ],
    retryRule: "Treat 529 and other 5xx errors as retryable; never retry 400, 401, 402 or 403 errors.",
    docs: DOCS.claude,
  },
  {
    slug: "claude-429-rate-limit",
    note: "You hit a rate limit or your tier&rsquo;s monthly spend cap.", service: "claude", provider: "Anthropic", api: "Claude API",
    code: 429, name: "rate_limit_error", bucket: "rate",
    title: "Claude API 429 rate_limit_error: what it means and what to do",
    h1: "Claude API error 429: rate_limit_error",
    description: "Claude API 429 rate_limit_error: a rate limit, your tier's monthly spend cap, or a Claude Code workspace limit. How to tell them apart.",
    meaning: [
      "Anthropic&rsquo;s docs give three causes for a 429 <code>rate_limit_error</code>: your organization hit a rate limit, reached its usage tier&rsquo;s monthly spend cap, or reached a spend limit on the Claude Code workspace.",
      "Anthropic also notes that a sharp increase in usage can trigger 429 errors from acceleration limits, and recommends increasing traffic gradually.",
      "A spend-cap 429 has no <code>retry-after</code> header and keeps failing until access resumes, so retrying does not help in that case.",
    ],
    shape: SHAPE_CLAUDE("rate_limit_error"),
    fix: [
      "If the response has a <code>retry-after</code> header, wait at least that long before retrying. Anthropic&rsquo;s official SDK does this automatically.",
      "If there is no <code>retry-after</code> header and every retry fails, you have probably reached your tier&rsquo;s spend cap: see Anthropic&rsquo;s rate limits page, linked below.",
      "Increase traffic gradually and keep usage steady to avoid acceleration limits.",
    ],
    retryRule: "Treat this 429 as retryable only while a <code>retry-after</code> header comes back; stop when it does not.",
    docs: DOCS.claude,
    more: [DOCS.claudeLimits],
  },
  {
    slug: "openai-503-overloaded",
    note: "The model is out of capacity right now. It&rsquo;s on their side.", service: "openai", provider: "OpenAI", api: "OpenAI API",
    code: 503, name: "server_is_overloaded", bucket: "server",
    title: "OpenAI API 503 server_is_overloaded: what it means and what to do",
    h1: "OpenAI API error 503: server_is_overloaded",
    description: "OpenAI API 503 server_is_overloaded means the model is out of capacity right now. Live OpenAI status, our own check, and what to do.",
    meaning: [
      "OpenAI&rsquo;s docs describe a 503 with type <code>service_unavailable_error</code> and code <code>server_is_overloaded</code> as the requested model not having enough capacity to process your request at the moment.",
      "It is about the model&rsquo;s capacity, not your account. OpenAI&rsquo;s Python library raises it as <code>InternalServerError</code>, not <code>RateLimitError</code>, so handle both.",
    ],
    fix: [
      "If a <code>Retry-After</code> header is present, wait at least that long before retrying. If it is missing, increase the delay between retries.",
      "If it continues, check OpenAI&rsquo;s status above and the official status page for an active incident.",
      "If you need answers now, switch to a backup (below) until it clears.",
    ],
    retryRule: "Treat this 503 as retryable; never retry billing or quota errors.",
    docs: DOCS.openai,
  },
  {
    slug: "openai-429-rate-limit",
    note: "You hit your rate limit, or your traffic grew too fast.", service: "openai", provider: "OpenAI", api: "OpenAI API",
    code: 429, name: "rate limit / slow_down", bucket: "rate",
    title: "OpenAI API 429 rate limit and slow_down: what they mean and what to do",
    h1: "OpenAI API error 429: rate limit reached or slow_down",
    description: "OpenAI API 429: you hit your rate limit, or your traffic grew too fast (slow_down). How to tell them apart from quota errors, and what to do.",
    meaning: [
      "OpenAI returns a 429 when you send too many requests or tokens in a short time (&ldquo;Rate limit reached for requests&rdquo;).",
      "It also returns a 429 with type <code>rate_limit_error</code> and code <code>slow_down</code> when your request rate rises faster than the service can safely handle. OpenAI notes this can happen even when you are within your per-minute limits.",
      "Billing and quota problems use status 429 too, but they are different: check <code>error.code</code>. See the <a href=\"/errors/openai-insufficient-quota/\">OpenAI quota page</a>.",
    ],
    fix: [
      "If a <code>Retry-After</code> header is present, wait at least that long. If it is missing, use exponential backoff with jitter and limit the number of retries.",
      "For <code>slow_down</code>: reduce your request rate, then increase it gradually, and keep your traffic steady.",
      "Limits apply per organization, not per user, so check what the rest of your team is sending.",
      "OpenAI&rsquo;s Python library retries some errors itself. If you also retry in your own code, respect the original delay and account for the library&rsquo;s retries.",
    ],
    retryRule: "Treat <code>rate_limit_error</code> (including <code>slow_down</code>) as retryable; never retry billing or quota codes.",
    docs: DOCS.openai,
    more: [DOCS.openaiLimits],
  },
  {
    slug: "openai-insufficient-quota",
    note: "Billing or quota on your account. Not an outage.", service: "openai", provider: "OpenAI", api: "OpenAI API",
    code: 429, name: "insufficient_quota", bucket: "account",
    title: "OpenAI insufficient_quota: \"You exceeded your current quota\" explained",
    h1: "OpenAI API: You exceeded your current quota (insufficient_quota)",
    description: "OpenAI insufficient_quota or \"You exceeded your current quota\": which of the four billing and limit causes you have, and how to fix it.",
    meaning: [
      "Many developers still see the message &ldquo;You exceeded your current quota&rdquo; or the type <code>insufficient_quota</code>. OpenAI&rsquo;s current docs split this into specific causes, all with status 429. Check <code>error.code</code> to see which one you have; the broader <code>error.type</code> can still be <code>insufficient_quota</code>.",
    ],
    causes: [
      ["credit_balance_exhausted", "Your organization has no prepaid credits left.", "Add credits in your <a href=\"https://platform.openai.com/settings/organization/billing\">billing settings</a>."],
      ["organization_spend_limit_exceeded", "Your organization reached the monthly spend limit it set. It applies to every project in the organization.", "Raise or remove it in your <a href=\"https://platform.openai.com/settings/organization/limits\">organization limits</a>, or wait for the monthly reset."],
      ["project_spend_limit_exceeded", "One project reached its own monthly spend limit. Other projects can keep working.", "Raise or remove it in the project&rsquo;s settings, or wait for the monthly reset."],
      ["organization_usage_limit_exceeded", "Your organization reached the monthly usage limit OpenAI assigned to it, which is separate from the limits you set.", "Request a higher approved usage limit in your <a href=\"https://platform.openai.com/settings/organization/limits\">organization limits</a>, or contact OpenAI support."],
    ],
    fix: [
      "Find <code>error.code</code> in the response and follow the matching fix above.",
      "Retrying will not restore access. OpenAI says to update the credits or limits first, then send the request again.",
    ],
    docs: DOCS.openai,
  },
  {
    slug: "gemini-429-resource-exhausted",
    note: "You went over one of your Gemini rate limits.", service: "gemini", provider: "Google", api: "Gemini API",
    code: 429, name: "RESOURCE_EXHAUSTED", bucket: "rate",
    title: "Gemini API 429 RESOURCE_EXHAUSTED: what it means and what to do",
    h1: "Gemini API error 429: RESOURCE_EXHAUSTED",
    description: "Gemini API 429 RESOURCE_EXHAUSTED means you went over one of your rate limits. What counts, how to retry it safely, with live Gemini status.",
    meaning: [
      "Google&rsquo;s docs describe a 429 <code>RESOURCE_EXHAUSTED</code> as going over one of the Gemini API&rsquo;s rate limits: requests, tokens, daily requests, or spend-based limits that depend on your account&rsquo;s billing history and tier.",
      "Google lists it as an error to retry, with exponential backoff.",
    ],
    shape: SHAPE_GEMINI(429, "RESOURCE_EXHAUSTED"),
    fix: [
      "Check that you are within your model&rsquo;s limits on Google&rsquo;s rate limits page, linked below.",
      "Retry with exponential backoff and random jitter, with a maximum number of retries. The official Gemini SDKs already retry 429 errors automatically with backoff.",
    ],
    retryRule: "Google&rsquo;s rule: retry 429, 408 and 5xx errors; never retry 400, 402 or 403.",
    docs: DOCS.gemini,
    more: [DOCS.geminiLimits, DOCS.geminiRetry],
  },
  {
    slug: "gemini-503-unavailable",
    note: "Google&rsquo;s service is overloaded or down. It&rsquo;s on their side.", service: "gemini", provider: "Google", api: "Gemini API",
    code: 503, name: "UNAVAILABLE", bucket: "server",
    title: "Gemini API 503 UNAVAILABLE: what it means and what to do",
    h1: "Gemini API error 503: UNAVAILABLE",
    description: "Gemini API 503 UNAVAILABLE means the service is overloaded or down for now. Live Gemini status, our own check, and what to do right now.",
    meaning: [
      "Google&rsquo;s docs describe a 503 <code>UNAVAILABLE</code> as the service being temporarily overloaded or down, because it is temporarily running out of capacity.",
      "It is a server-side error: your API key and request are not the cause.",
    ],
    shape: SHAPE_GEMINI(503, "UNAVAILABLE"),
    fix: [
      "Wait a little and retry with exponential backoff and jitter. The official Gemini SDKs already retry 5xx errors automatically.",
      "Check Gemini&rsquo;s status above and Google&rsquo;s status page for an ongoing incident.",
      "Google suggests temporarily switching to another Gemini model to see if it works.",
      "Or switch to a backup provider (below) until it clears.",
    ],
    retryRule: "Google&rsquo;s rule: retry 429, 408 and 5xx errors; never retry 400, 402 or 403.",
    docs: DOCS.gemini,
    more: [DOCS.geminiRetry],
  },
  {
    slug: "deepseek-503-server-overloaded",
    note: "DeepSeek&rsquo;s servers are busy with high traffic. It&rsquo;s on their side.", service: "deepseek", provider: "DeepSeek", api: "DeepSeek API",
    code: 503, name: "Server Overloaded", bucket: "server",
    title: "DeepSeek API 503 Server Overloaded: what it means and what to do",
    h1: "DeepSeek API error 503: Server Overloaded",
    description: "DeepSeek API 503 Server Overloaded means DeepSeek's servers are busy with high traffic. Live DeepSeek check and what to do right now.",
    meaning: [
      "DeepSeek&rsquo;s docs say a 503 Server Overloaded means its server is overloaded because of high traffic.",
      "It is not caused by your API key or your request. A 429 is different: that one is about your own request pace.",
    ],
    fix: [
      "DeepSeek&rsquo;s docs say to retry your request after a brief wait.",
      "Check DeepSeek&rsquo;s live check above.",
      "If it keeps failing, switch to a backup (below) until it clears.",
    ],
    retryRule: "Treat this 503 as retryable; never retry 401 or 402 errors (key or balance problems).",
    docs: DOCS.deepseek,
  },
];

export function errorsFor(serviceId) {
  return ERRORS.filter((e) => e.service === serviceId);
}

// ---------- retry helper (tested in web-tests/errors.test.js) ----------

export const RETRY_PY = `import random
import time


def with_retries(call, is_retryable, retry_after=lambda err: None, attempts=5):
    """Run call(). On a retryable error, wait and try again, up to attempts tries.
    retry_after(err) returns the server's requested wait in seconds, or None."""
    for attempt in range(attempts):
        try:
            return call()
        except Exception as err:
            if attempt == attempts - 1 or not is_retryable(err):
                raise
            wait = retry_after(err)
            if wait is None:
                wait = min(60, 2 ** attempt) + random.random()  # backoff + jitter
            time.sleep(wait)
`;

export const RETRY_JS = `async function withRetries(call, isRetryable, retryAfter = () => null, attempts = 5) {
  // retryAfter(err) returns the server's requested wait in seconds, or null.
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= attempts - 1 || !isRetryable(err)) throw err;
      let wait = retryAfter(err);
      if (wait == null) wait = Math.min(60, 2 ** attempt) + Math.random(); // backoff + jitter
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }
}
`;

// ---------- rendering ----------

const ERROR_STYLES = `
.bucket{margin:0 0 .35rem;font-weight:600}
.shape{margin:.25rem 0 1rem;padding:.75rem;background:#04100b;border:1px solid var(--line);border-radius:8px;overflow-x:auto;font-size:.82rem;line-height:1.5}
.steps{margin:0 0 .75rem;padding-left:1.25rem}
.steps li{margin:.3rem 0}
.causes{list-style:none;margin:0 0 1rem;padding:0;border-top:1px solid var(--line)}
.causes li{padding:.6rem 0;border-bottom:1px solid var(--line)}
.causes code{font-weight:600}
.src{margin-top:1.75rem;font-size:.9rem;color:var(--muted)}
`;

function bucketHtml(e, s) {
  const p = e.provider;
  if (e.bucket === "server") {
    const live = s.nofeed
      ? p + " publishes no machine-readable status feed, so the live signal below is our own check of its API server. " + p + "&rsquo;s own status page may not show it yet either."
      : "If the status below shows a problem, " + p + " has confirmed it. If it shows Operational, the problem may be short-lived, or the status page may not show it yet; our own check is a second opinion.";
    return '<p class="bucket">Server-side: ' + p + "&rsquo;s capacity</p>\n" +
      "    <p>This error comes from " + p + "&rsquo;s servers, not from your code. " + live + "</p>";
  }
  if (e.bucket === "rate") {
    return '<p class="bucket">Request limit: your account&rsquo;s pace</p>\n' +
      "    <p>This error is about your account&rsquo;s request limits. " + p + "&rsquo;s servers answered and turned the request away, which usually means they are up. The live status below helps rule out a wider problem.</p>";
  }
  return '<p class="bucket">Account: billing or quota</p>\n' +
    "    <p>This is not an outage. " + p + " answered your request and refused it because of your account&rsquo;s credits or limits. Retrying will not fix it. The live status below is here only to rule out a wider problem.</p>";
}

function retryHtml(e) {
  if (e.bucket === "account") return "";
  const id = "code-" + e.slug;
  return `<section class="sec" aria-labelledby="h-retry">
    <h2 id="h-retry">Retry it safely in your own code</h2>
    <p>You may not need this: the official SDKs retry on their own (see above). If you call the API directly, this helper waits and retries, using the server&rsquo;s requested delay when you pass one. ${e.retryRule}</p>
    <p class="lang">Python</p>
    <div class="code"><button class="copy" type="button" data-copy="${id}-py" hidden>Copy</button><pre><code id="${id}-py">${escCode(RETRY_PY)}</code></pre></div>
    <p class="lang">JavaScript</p>
    <div class="code"><button class="copy" type="button" data-copy="${id}-js" hidden>Copy</button><pre><code id="${id}-js">${escCode(RETRY_JS)}</code></pre></div>
  </section>`;
}

function head({ title, description, url, ld, extraStyles }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='29' fill='%2307140e' stroke='%234be08a' stroke-width='4'/%3E%3Ccircle cx='32' cy='32' r='4' fill='%234be08a'/%3E%3Ccircle cx='44' cy='20' r='4' fill='%234be08a'/%3E%3Ccircle cx='20' cy='42' r='4' fill='%23ffb547'/%3E%3C/svg%3E">
<!-- Generated by tools/status-pages.mjs (data: tools/errors.mjs). Do not edit by hand. -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="OutageRadar">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>
${boardStyles()}
${PAGE_STYLES.trim()}
${extraStyles.trim()}
</style>
</head>`;
}

const FOOTER = `<footer class="about">
    <p class="legal">OutageRadar is independent and not affiliated with any service listed. <a href="/privacy.html">Privacy</a>. Questions or corrections: <a href="mailto:contact@liveoutageradar.com">contact@liveoutageradar.com</a>. &copy; 2026 OutageRadar</p>
  </footer>`;

export function renderErrorPage(e) {
  const s = SHELL.find((x) => x.id === e.service);
  const n = pageNames(s);
  const url = SITE_URL + "/errors/" + e.slug + "/";
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", "@id": url, url, name: e.title, description: e.description, isPartOf: { "@type": "WebSite", name: "OutageRadar", url: SITE_URL + "/" } },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "OutageRadar", item: SITE_URL + "/" },
        { "@type": "ListItem", position: 2, name: "API errors", item: SITE_URL + "/errors/" },
        { "@type": "ListItem", position: 3, name: e.h1, item: url },
      ] },
    ],
  };
  const officialLine = s.nofeed
    ? "No public status feed from the provider. Reachability checked by OutageRadar."
    : "Official status: checking&hellip;";
  const meaning = e.meaning.map((t) => "<p>" + t + "</p>").join("\n    ");
  const shape = e.shape
    ? "\n    <p>Shape of the error body, from " + e.provider + "&rsquo;s docs (the message text varies):</p>\n    <pre class=\"shape\"><code>" + escCode(e.shape) + "</code></pre>"
    : "";
  const causes = e.causes
    ? "\n    <ul class=\"causes\">\n      " + e.causes.map(([code, what, fix]) => "<li><code>" + code + "</code>: " + what + " " + fix + "</li>").join("\n      ") + "\n    </ul>"
    : "";
  const steps = e.fix.map((t) => "<li>" + t + "</li>").join("\n      ");
  const docs = [e.docs, ...(e.more || [])].map((d) => '<a href="' + esc(d.url) + '">' + esc(d.label) + "</a>").join(" &middot; ");
  const others = ERRORS.filter((x) => x.slug !== e.slug)
    .map((x) => '<li><a href="/errors/' + x.slug + '/">' + esc(x.h1) + "</a></li>").join("\n      ");
  return `${head({ title: e.title, description: e.description, url, ld, extraStyles: ERROR_STYLES })}
<body data-service="${s.id}">
<div class="wrap">
  <header class="top">
    <p class="brand"><a href="/">Outage<span>Radar</span></a></p>
    <p class="meta"><span class="live live-checking" id="live"><i aria-hidden="true"></i><span class="ll">Checking&hellip;</span></span>
      <span class="updated" id="updated" aria-live="polite">Checking&hellip;</span></p>
  </header>
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">All AI services</a> / <a href="/errors/">API errors</a> / ${esc(e.api)} ${e.code}</nav>
  <h1 class="page-h1">${esc(e.h1)}</h1>
  <p class="lede">What this ${esc(e.api)} error means, whether it is on ${esc(e.provider)}&rsquo;s side or yours, and what to do now. All times are UTC.</p>
  <p class="banner" id="banner" role="status" hidden></p>
  <section class="sec" aria-labelledby="h-who">
    <h2 id="h-who">Is it them or you?</h2>
    ${bucketHtml(e, s)}
  </section>
  <section class="now" aria-label="${esc(n.full)} status right now">
    <div class="row s-checking" id="row"><span class="pill"><span class="pi" aria-hidden="true">&hellip;</span><span class="pl">Checking&hellip;</span></span>
      <h2 class="name"><a href="${esc(s.status_page)}">${esc(n.full)}</a></h2>
      <p class="official">${officialLine}</p><p class="probe"><span class="pt">Our check: checking&hellip;</span> <span class="pc"></span></p><p class="note" hidden></p></div>
  </section>
  <section class="sec" aria-labelledby="h-means">
    <h2 id="h-means">What it means</h2>
    ${meaning}${shape}${causes}
  </section>
  <section class="sec" aria-labelledby="h-fix">
    <h2 id="h-fix">What to do</h2>
    <ol class="steps">
      ${steps}
    </ol>
  </section>
  ${retryHtml(e)}
  ${e.bucket === "server" ? backupSection(s, n) : ""}
  <section class="sec" aria-labelledby="h-history">
    <h2 id="h-history">Recent ${esc(n.short)} incidents</h2>
    <p class="since" id="since">History logged by OutageRadar.</p>
    <ul class="history" id="history"><li class="empty">Loading incident history&hellip;</li></ul>
    <noscript><p>The history list needs JavaScript.</p></noscript>
    <p class="since">Full history: <a href="/status/${s.id}/">Is ${esc(n.short)} down?</a></p>
  </section>
  <p class="src">Source: ${docs}. Last checked against official docs: ${LAST_CHECKED}. If the docs change, they win.</p>
  <nav class="sec others" aria-labelledby="h-others">
    <h2 id="h-others">Other API errors</h2>
    <ul>
      ${others}
    </ul>
    <p><a href="/errors/">All API errors</a> &middot; <a href="/">Live status of all services</a></p>
  </nav>
  ${FOOTER}
</div>
<script type="module" src="/service.js"></script>
</body>
</html>
`;
}

// v1.15.0: one error per line with a short note, not wrapping side-by-side links.
const HUB_STYLES = `
.hub h2{margin:1.5rem 0 .4rem;font-size:1.15rem}
.errlist{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.errlist li{padding:.65rem 0;border-bottom:1px solid var(--line)}
.errlist a{font-weight:600}
.errlist .en{display:block;margin-top:.15rem;color:var(--muted);font-size:.9rem}
`;

export function renderErrorsHub() {
  const url = SITE_URL + "/errors/";
  const title = "AI API errors explained: Claude, OpenAI, Gemini, DeepSeek";
  const description = "Common AI API errors, what they mean, whether it is the provider or you, and what to do. Each page shows that provider's live status.";
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", "@id": url, url, name: title, description, isPartOf: { "@type": "WebSite", name: "OutageRadar", url: SITE_URL + "/" } },
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "OutageRadar", item: SITE_URL + "/" },
        { "@type": "ListItem", position: 2, name: "API errors", item: url },
      ] },
    ],
  };
  const groups = [];
  for (const e of ERRORS) {
    let g = groups.find((x) => x.api === e.api);
    if (!g) groups.push(g = { api: e.api, items: [] });
    g.items.push('<li><a href="/errors/' + e.slug + '/">' + esc(e.h1) + '</a><span class="en">' + e.note + "</span></li>");
  }
  const lists = groups.map((g) => "<h2>" + esc(g.api) + '</h2>\n    <ul class="errlist">\n      ' + g.items.join("\n      ") + "\n    </ul>").join("\n    ");
  return `${head({ title, description, url, ld, extraStyles: HUB_STYLES })}
<body>
<div class="wrap">
  <header class="top">
    <p class="brand"><a href="/">Outage<span>Radar</span></a></p>
  </header>
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">All AI services</a> / API errors</nav>
  <h1 class="page-h1">AI API errors explained</h1>
  <p class="lede">What each error means, whether it is on the provider&rsquo;s side or yours, and what to do. Every page shows that provider&rsquo;s live status, and facts come from the provider&rsquo;s own docs (last checked ${LAST_CHECKED}).</p>
  <nav class="sec hub" aria-label="API errors">
    ${lists}
  </nav>
  ${FOOTER}
</div>
</body>
</html>
`;
}
