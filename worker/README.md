# OutageRadar checker (Cloudflare Worker)

`checker.js` is the whole checker. It runs on Cloudflare's free Workers plan,
every 5 minutes, and serves the board data at `data.liveoutageradar.com`.
This folder is NOT public: Render only publishes `site/`.

## What it does

- Reads each service's official status feed and runs our own check against each
  service's API server (since v1.6 Groq too: `api.groq.com/openai/v1/models`,
  expected 401 without a key; UNVERIFIED until the v1.6 sample confirms it.
  An unexpected answer shows Unknown, never Down).
- Saves everything in one KV key (`state:v1`), about 288 writes a day
  (free cap: 1,000 a day; going over fails, it does not bill).
- Serves `/status.json` (board data, CORS limited to liveoutageradar.com; since
  v1.4 it includes `served_at_utc` and `age_seconds` from the server clock so the
  board never trusts a visitor's clock) and
  `/health` (`ok` if the last run saved within 15 minutes, else HTTP 503).
- Posts to Discord only when something changes.

## Bluesky: incident posts and reply assist (v1.17.0, Nov 12, 2026)

Off unless every setting below is present. Facts verified Nov 12, 2026 from
Bluesky's official lexicons (github.com/bluesky-social/bsky and
bluesky-social/atproto) and docs.bsky.app (rate limits, bot guidance).

- Settings: `BSKY_MODE` (plain text: `pilot` or `live`; anything else = off),
  `BSKY_HANDLE` (plain text, `liveoutageradar.com`), `BSKY_APP_PASSWORD`
  (secret: an app password, never the main password), optional
  `DISCORD_SOCIAL_WEBHOOK` (secret; default is the health channel). Also needs
  `DB` and both alert keys (the saved login is encrypted with `ALERTS_ENC_KEY`).
- `pilot`: reads mentions and incidents, writes nothing to Bluesky; Discord
  shows "PILOT would reply / would post". `live`: first adds the "bot"
  self-label to the profile (keeps every other field; `swapRecord`), then posts.
- Runs from the every-minute cron at most every 5 minutes, and only when the
  alert sender sent 30 or fewer messages that minute. Hard cap 12 outside
  requests a run. Discord gets one digest message a run.
- Login: once, saved encrypted in D1 (`social_state`), refreshed on
  ExpiredToken; at most one login per run; 30-minute wait after a failed login
  (Bluesky allows 30 logins per 5 minutes, 300 per day).
- Lane A (automatic reply): only mentions/replies to us that name a listed
  service and a status word; built only from board data no older than 15
  minutes; ASCII, at most 300 characters, ends "(automated)", link tagged
  `utm_source=bsky_reply`. Limits: 3 a run, 20 an hour, 3 per person a day.
  Never answers itself or accounts labeled "bot". Each post answered once.
- Lane B (common questions: alerts, free, add a service, how it works) and
  Lane C (everything else) go to Discord with the post link. Quotes are never
  auto-answered.
- Incident posts: confirmed major starts (not signals-disagree) and their
  ends; not posted if the service is already healthy at posting time or the
  event is over 30 minutes old; a recovery only if its start was posted.
  At most 2 a run, 6 an hour. Links tagged `utm_source=bsky_post`.
- Kept: post addresses and author account IDs, 8 days (`social_seen`,
  `social_log`), deleted hourly by the 5-minute run even when Bluesky is off.
  The privacy page says so.

## Alerts Phase 2: public (v1.16.0, Nov 11, 2026)

- Pilot passed on the live system (Nov 10-11): sign-up, confirm, a real
  Together AI major-outage start and recovered alert (10 min, once each),
  unsubscribe by button.
- Sign-up answers `status`: `check_channel` (new, message sent), `pending`
  (not confirmed; a message went out in the last 24 h; choices updated) or
  `updated` (confirmed; choices updated). The honeypot answer stays
  `check_channel`.
- `/admin/data` adds `alerts`: `{enabled, confirmed, pending, queued}` (counts
  only), shown in a dashboard card. `{enabled: false}` when the secrets are
  missing.
- Site v1.18.0: the sign-up page is public (canonical, sitemap, llms.txt),
  linked from the homepage and every history page (`/alerts/?service=<id>`
  pre-ticks that service), with Select all and a screenshot warning. Confirm
  and unsubscribe pages stay noindex.

## Self-serve Discord/Slack alerts, Phase 1 pilot (v1.15.0, Nov 10, 2026)

- Off unless both secrets exist: `ALERTS_ENC_KEY` (base64 of 32 random bytes,
  AES-GCM key for stored webhooks) and `ALERTS_SIGN_KEY` (32+ characters, HMAC
  key for confirm/unsubscribe links and the duplicate-lookup hash). Uses the
  existing D1 binding `DB`; tables `alert_subs` and `alert_events` create
  themselves on first use.
- `POST /alerts/subscribe | confirm | unsubscribe` (plain-text JSON body,
  2 KB max, our site's origin only). GET never confirms or unsubscribes, so
  Discord/Slack link-preview bots can't. Confirm/unsubscribe pages on the site
  have a button that sends the POST. Honeypot field `company_name`.
- Limits: one confirmation message per webhook per 24 h; at most 30
  confirmation messages an hour in total; unconfirmed sign-ups deleted after
  24 h; alerts older than 6 h dropped.
- Webhooks: Discord or Slack addresses only (host and path shape). Encrypted
  with a fresh random IV each time; duplicates found by a keyed hash.
- Events: the 5-minute run records start / worse / recovered at the same
  moments as the private alerts channel (same cool-down), plus degraded
  start/end for subscribers who opted in. One D1 batch, only when there are
  events and the feature is on.
- Sending: a second cron trigger, `* * * * *`, on this Worker. It only sends:
  up to 40 messages a run from a cursor. Discord 401/403/404 and Slack
  no_service / channel_not_found / channel_is_archived (or 404/410) delete
  the sign-up at once (Discord temporarily blocks addresses that keep making
  invalid requests: 10,000 per 10 minutes, per its docs). 429 or 5xx: stop
  and retry next minute, never treated as dead. Discord messages suppress
  link previews and mentions; Slack messages turn link previews off.
- Measured: decrypting 40 webhooks and signing their unsubscribe links takes
  about 2 ms of CPU (free plan: 10 ms per run).
- Pilot: the site pages are noindex and unlinked. Phase 2 (public) links them.

## RSS feeds of incidents (v1.14.0, Nov 10, 2026)

- `GET /feed.xml` (all services, newest first, at most 50 items) and
  `GET /feed/<id>.xml` (one service; unknown or unlisted ids are 404). RSS 2.0
  with an atom self link, built on request from the incident log in
  `state:v1`: no change to the 5-minute run or its request budget.
- One item per incident, guid `outageradar:<id>:<start>`, dated by its start,
  updated in place when it ends ("(ongoing)" becomes "42 min (resolved)").
  Says whether the provider confirmed it or only our check saw it, and when
  the end is not confirmed. Everything is XML-escaped; odd saved data can't
  break the feed.
- `cache-control: public, max-age=300`. KV free plan: 100,000 reads a day
  (Cloudflare docs, checked Nov 10, 2026); feed reads go through the same
  30-second in-memory cache as status.json. If saved data can't be read the
  feed answers 503 (no-store) instead of an empty feed.
- Nothing about readers is stored. Site v1.16.0 links the feeds from the
  homepage footer and every history page, with `rel="alternate"` tags.

## Step B3: DeepInfra listed, AG review (v1.13.0, Nov 10, 2026)

- DeepInfra: official signal from its documented keyless JSON API,
  `/api/v1/status`, core service `publicId: "api"` only (not overallStatus,
  which may include ~171 single models; not the website). `isStale: true` or
  a missing API entry means Unknown. Status words: OPERATIONAL seen in the
  sample; others matched by Statuspage spelling rules (UNVERIFIED); anything
  unrecognised is Unknown, never green. Check unchanged (model list, ~300 ms).
- GitHub Copilot (AG review): a 400 counts only if the reply says the
  Authorization header is missing; any other 400 is Unknown and its first
  characters are kept in the samples. Probe samples now note whether GitHub's
  `x-github-request-id` header came back (presence only, never the id).
- Public responses (status.json and incidents.json) are filtered to listed
  services at the last step too (AG review). No service is hidden now.
- Site fix: the homepage rows for Together AI and Fireworks AI (v1.11.0) had
  wrong static links (status.together.co, status.fireworks.co); a test now
  checks every row's link against the service list.
- Add `deepinfra` to APPROVED_MAPPINGS after deploying. Normal run: 27 fetches.

## Step B2: OpenRouter and GitHub Copilot listed (v1.12.0, Nov 10, 2026)

- From the v1.11.0 samples. GitHub Copilot's check (api.githubcopilot.com)
  answered HTTP 400 "bad request: missing required Authorization header":
  GitHub's server refusing a request without a key, so 400 counts as
  answering for this service only. Official signal: the worse of githubstatus
  "Copilot" and "Copilot AI Model Providers". The board shows "HTTP 400, needs
  a key". Its history page has no backup code (no drop-in API); the board
  shows no backup link for it.
- OpenRouter: no official feed (Datadog status page, owner-only API), shown
  like Gemini and DeepSeek. Check moved to `/api/v1/key` (documented as
  needing a key; sampled 401) so a cached copy cannot answer for it. Its
  status is now live in every backup box that offers OpenRouter.
- DeepInfra stays hidden. Its /api page documents a keyless JSON API with a
  schemaVersion; `/api/v1/status` and the `/api/v1` index are sampled once.
- Add `openrouter,github-copilot` to APPROVED_MAPPINGS after deploying.
- Normal run: 26 fetches (11 feeds + 15 checks), unchanged.

## Step B1: two services listed, samples round 2 (v1.11.0, Nov 9, 2026)

- From the v1.10.0 samples: Together AI (Better Stack `index.json`, parser
  `betterstack`) and Fireworks AI (Statuspage-format `summary.json`, overall
  indicator only; its components are single models) are listed. Both API
  servers answer 401 without a key. They show Unknown until their ids are in
  `APPROVED_MAPPINGS`.
- GitHub Copilot: feed mapped (githubstatus.com, the worse of the "Copilot"
  and "Copilot AI Model Providers" components; the rest of GitHub ignored).
  Still hidden: its check answered HTTP 400, and odd replies now keep their
  first 600 characters in the samples so the next review can see who answered.
- OpenRouter: status page is Datadog Status Pages; no documented public feed
  (Datadog's API needs the page owner's keys), so it will be shown like Gemini
  and DeepSeek. One-time sample: `GET /api/v1/key` (documented by OpenRouter
  as needing a key) as a candidate check that a cached copy cannot answer.
- DeepInfra: its own status site. One-time samples of its `/api` page and its
  Atom feed (`/status.atom`) to find a documented feed.
- Microsoft Copilot: parked (removed). No documented public feed; the website
  check only reached a sign-in page. Re-add only with a documented feed.
- Fixes: stale or missing data no longer lists hidden services in status.json
  (the board adds rows for any id it receives, so this leaked); hidden
  services never post feed-problem messages to the health channel either.
- Budget measured in tests: sample run 34, normal run 29 (of 50).

## Hidden sample mode for new services (v1.10.0, Nov 9, 2026)

- Six services are checked quietly with `listed: false`: OpenRouter, Together
  AI, Fireworks AI, DeepInfra, GitHub Copilot, Microsoft Copilot. They never
  appear in status.json, /incidents.json or Discord, and never count as
  approved even if added to APPROVED_MAPPINGS by mistake.
- The first run of v1.10.0 saves samples: each one's status page (to see the
  platform), one candidate feed, and what its API/site check answered.
  Download them from the dashboard (data.liveoutageradar.com/admin, button
  "Download checker samples"; needs ADMIN_KEY) instead of digging in KV.
- After review, a later release sets each feed mapping, lists the services,
  and adds them to the board and history pages.
- Subrequest budget (free plan: 50 per run, counting fetches, each redirect,
  KV reads/writes and D1 calls): sample run measured at 39, normal run at 27.
  Sample URLs only use the room left after reserves for KV (4), D1 (2),
  Discord (6) and redirects (4). Old samples for long-approved services
  (Groq, Cohere, Hugging Face) were retired to make room.

## Latency (v1.8.0, Nov 8, 2026)

- Each API check is timed from sending the request to the reply's first
  bytes (in Workers the clock advances across network waits). `status.json`
  probe field `latency_ms`: a whole number of ms when the check got a normal
  answer, otherwise `null`. The board shows "API server responding in 312 ms"
  (1 s and over in seconds). It is the round trip from Cloudflare to the API
  server, not the speed of AI replies.
- Baseline: `state:v1` key `latency` keeps, per service and UTC day, the
  count, total, fastest, slowest and a spread (under 250 / 500 / 1000 / 2000 /
  5000 ms / slower) for 30 days. No extra writes. Not public yet. Nothing is
  labelled "slow" until a normal range per service has been measured.

## History pages and /incidents.json (v1.7.0, Nov 8, 2026)

- `GET /incidents.json`: every approved service's incident log, newest first:
  `{ schema, served_at_utc, services: [{ id, name, status_page, since_utc,
  incidents: [{ started_utc, ended_utc, worst, kind, minutes, end_confirmed }] }] }`.
  Read-only, same 60-second cache and CORS as status.json. Internal fields
  never leave the checker.
- Site: `site/status/<id>/index.html` ("Is Claude down?" pages), one per
  service, generated by `node tools/status-pages.mjs` from one template (styles
  copied from site/index.html). Do not edit them by hand; a test fails if a
  committed page differs from the generator. `site/service.js` shows live
  status (same safety rules as the board) and the history list.
- The board links each row to its page; the sitemap lists all pages;
  `site/llms.txt` describes the site and data for AI tools.

## Incident log (v1.6, Nov 8, 2026)

- For each approved service the checker records each problem: start, end,
  worst state, and kind (`official` = provider's feed showed degraded, partial
  or major outage; `our_check` = only our check failed twice in a row). An
  our-check incident becomes `official` if the provider confirms it.
- Stored inside `state:v1` (keys `incidents` and `incident_since`), which is
  written every run anyway: no extra KV writes. Last 20 per service; finished
  incidents older than 90 days are dropped. Damaged entries are discarded.
- Opens on the first run that sees the problem. Closes after TWO healthy runs
  in a row (v1.6.1), with the end time set to the first healthy run, so a
  flapping service stays one incident. Unknown or maintenance never closes it
  and restarts the healthy count. Times are when our checker saw the change
  (runs are 5 minutes apart).
- Stall limit (v1.6.1): an open incident that sees only Unknown/maintenance
  for 2 hours is closed at the last time we saw the problem, flagged
  `end_confirmed: false`, with one "INCIDENT LOG" message in outage-health.
  The board says "about N min (end not confirmed)". If the problem shows
  again, a new incident opens.
- `status.json`: each service has `incidents: { since_utc, last }` (`null`
  for services not approved). `last` = `{ started_utc, ended_utc (null while
  ongoing), worst, kind, minutes, end_confirmed }`. The board shows "Last incident ...",
  "Current incident since ..." or "No incidents logged since <date>".

## Traffic counts and private dashboard (v1.5, Nov 7, 2026)

- The board and the privacy page load `site/ping.js`, which sends one ping per
  page load (`POST /v`) and one per outbound link click (`POST /c`). Only pings
  from liveoutageradar.com are accepted.
- Stored in D1 (binding `DB`) as **daily totals only**: `views` (day, page,
  country, source, bot) and `clicks` (day, link, page). No IP address, user
  agent, cookie or ID is stored. Tables are created automatically on first use.
  Totals older than 400 days are deleted in the 03:00 UTC run.
- Source = `utm:<tag>` if the link had `utm_source`, else the referring domain
  (without www), `direct`, `internal` (our own pages) or `other` (unreadable).
- Bots = user agent looks automated, or the browser reports `navigator.webdriver`.
  Most crawlers never run the script, so they are not counted at all; use Google
  Search Console's Crawl stats for Googlebot.
- Free D1 limit: 100,000 rows written per day (each ping = about one write).
  Over the limit, counting fails until 00:00 UTC; the board is unaffected (it
  reads KV). The dashboard shows today's estimate.
- Dashboard: `https://data.liveoutageradar.com/admin`. The page itself holds no
  data. Data comes from `/admin/data`, which needs the `ADMIN_KEY` secret
  (24+ characters) sent as a header, never in the URL. Wrong key = 401;
  missing or short secret = locked (503).
- Privacy page updated first (Nov 7, 2026) to describe exactly this.

## Sample mode (the default)

Every service shows **Unknown** until its feed mapping is approved. On the
first run of each new version the checker saves the raw feeds and check
headers to a versioned KV key (`samples:v1.4.0` for this version) and posts
"Samples saved" to the health channel. Old `samples:v...` keys can be deleted.

To approve after reviewing the samples, add a plain-text variable
`APPROVED_MAPPINGS` with the service ids, for example `openai,groq`.
Ids: `openai`, `mistral`, `perplexity`, `groq`, `claude`, `cohere`,
`huggingface`, `xai`, `gemini`, `deepseek`. Remove an id to send that service
back to Unknown. To collect fresh samples, delete the current `samples:v...` key.

Mappings (in `SERVICES` at the top of checker.js), checked against the first
live samples on Nov 4, 2026 (v1.1):
- OpenAI, Mistral, Perplexity: page-wide indicator from `status.json` /
  `summary.json`. none = Operational, minor = Degraded, major = Partial outage,
  critical = Major outage. Mistral's feed covers its API platform, not Le Chat,
  so the board calls it "Mistral".
- Groq: worst of components API and Website (per-model components ignored).

Added in v1.2 (sample mode until reviewed):
- Claude: page-wide indicator from `status.claude.com/api/v2/summary.json`.
- Cohere: assumed Statuspage indicator (UNVERIFIED until sampled).
- Hugging Face: Better Stack `aggregate_state` from `/index.json`
  (UNVERIFIED until sampled). downtime = Major outage.
- Grok / xAI (v1.3): JSON summary at `data.x.ai/status/summary.json` (on xAI's
  own domain, not in its docs). Only components "Global (api.x.ai)" and
  "grok.com" count; Cursor products in the same feed are ignored.
  "available" = Operational; any other word = Unknown until reviewed.
- Gemini, DeepSeek: no official public feed. Official status is always
  "No official public feed". Once approved, overall uses our check only:
  `check_ok` ("Up (our check only)") or `check_failed` ("Not answering (our
  check only)") after 2 failed checks; otherwise Unknown. These never show as
  Operational. Gemini's API answers 403 without a key, which counts as answering.

## Status rules

- Official Down shows immediately.
- Our site check must fail 2 runs in a row (10 minutes) before it says Unreachable.
- Site check 403, 429 or a challenge page = Unknown, never Down.
- API checks: no key is sent, so the server answers 401 (Perplexity may answer
  405). That counts as "API server answering". It proves the server is up,
  not that the AI works, and the board label says exactly that.
- Any other unexpected 4xx = Unknown.
- Official Operational + site Unreachable = "Signals disagree".
- Official Unknown = Unknown overall, whatever the site check says.
- Data older than 15 minutes is served as Unknown, marked stale.

## Discord messages

Alerts channel (only for approved services; 30-minute cooldown between alerts):
- OUTAGE: official Partial or Major outage starts.
- WORSE: an open outage gets worse.
- CHECK: our site check failed twice but official says Operational, or (for
  Gemini/DeepSeek) our API check failed twice and there is no feed to confirm.
  RECOVERED for these says "our check is answering again".
- RECOVERED: back to Operational. Never sent while the status is Unknown.
- Degraded alone does not alert.

Test alert: add a plain-text variable `SEND_TEST_ALERT` (any value, e.g. `1`).
The next run posts one TEST message to the alerts channel. Change the value
to send another; remove the variable when done.

Health channel:
- Samples saved (once per version).
- FEED PROBLEM after 3 failed feed checks in a row; FEED OK when it works again.
- CHECKER could not read/save state (at most once an hour).

Example (generated from the real code):

```
OUTAGE ChatGPT / OpenAI: official status says Partial outage. Our check: site reachable. 2026-11-04 14:00 UTC. Official page: <https://status.openai.com>
RECOVERED ChatGPT / OpenAI: back to Operational after about 10 min. 2026-11-04 14:10 UTC. <https://status.openai.com>
CHECK Groq: our site check failed 2 times in a row, but the official status says Operational. 2026-11-04 14:15 UTC. <https://groqstatus.com>
FEED PROBLEM Mistral official feed failed 3 checks in a row (returned HTML, not JSON). Showing Unknown. 2026-11-04 14:20 UTC. <https://status.mistral.ai/api/v2/status.json>
```

## Deploy (Cloudflare dashboard, no installs needed)

Dashboard labels move around; if a name below differs slightly, look for the
closest match.

1. **Create the Worker.** Workers & Pages > Create > Worker > start from
   "Hello World". Name it `outageradar-checker`. Deploy.
2. **Paste the code.** Open the Worker > Edit code. Replace everything with
   the contents of `checker.js`. Deploy.
3. **Create KV.** Storage & Databases > KV > Create namespace, name
   `outageradar`.
4. **Bind KV.** Worker > Settings > Bindings > Add > KV Namespace.
   Variable name `KV` (exactly), namespace `outageradar`. Deploy.
5. **Secrets.** Worker > Settings > Variables and Secrets > Add, type
   **Secret**: `DISCORD_ALERTS_WEBHOOK` (outage channel URL) and
   `DISCORD_HEALTH_WEBHOOK` (health channel URL). Paste them yourself; never
   share them in chat or the repo.
6. **Schedule.** Worker > Settings > Trigger Events (older screens: Triggers >
   Cron Triggers) > Add > Cron Trigger, `*/5 * * * *`.
7. **Domain.** Worker > Settings > Domains & Routes > Add > Custom Domain,
   `data.liveoutageradar.com`. Check that the screen shows no charge.
8. **Check it** (wait about 10 minutes):
   - `https://data.liveoutageradar.com/health` shows `ok`.
   - `https://data.liveoutageradar.com/status.json` shows all services Unknown.
   - The health channel got one "Samples saved" message.
   - Worker > Metrics: CPU time per run is under 10 ms.

Rollback: remove the Cron Trigger (stops all checks) or delete the Worker.
Nothing here touches Render, the site, or the trading bots.

## Release checks (before every paste)

```
cd worker
node --check checker.js
LC_ALL=C grep -nP '[^\x00-\x7F]' checker.js   # must print nothing
npm test                                      # all tests must pass
```

Tests run locally with Node 18+ and use fake feeds; they never call the real
services or Discord.
