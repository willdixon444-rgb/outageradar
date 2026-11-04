# OutageRadar checker (Cloudflare Worker)

`checker.js` is the whole checker. It runs on Cloudflare's free Workers plan,
every 5 minutes, and serves the board data at `data.liveoutageradar.com`.
This folder is NOT public: Render only publishes `site/`.

## What it does

- Reads each service's official status feed and runs our own check: the website for
  Groq, the API server for OpenAI, Mistral and Perplexity (their websites block
  automated checks with a Cloudflare challenge).
- Saves everything in one KV key (`state:v1`), about 288 writes a day
  (free cap: 1,000 a day; going over fails, it does not bill).
- Serves `/status.json` (board data, CORS limited to liveoutageradar.com) and
  `/health` (`ok` if the last run saved within 15 minutes, else HTTP 503).
- Posts to Discord only when something changes.

## Sample mode (the default)

Every service shows **Unknown** until its feed mapping is approved. On its
first run the checker saves the raw feeds and site-check headers to the KV key
`samples:v1` and posts "Samples saved" to the health channel.

To approve after reviewing the samples, add a plain-text variable
`APPROVED_MAPPINGS` with the service ids, for example `openai,groq`.
Ids: `openai`, `mistral`, `perplexity`, `groq`. Remove an id to send that
service back to Unknown. To collect fresh samples, delete the `samples:v1` key.

Mappings (in `SERVICES` at the top of checker.js), checked against the first
live samples on Nov 4, 2026 (v1.1):
- OpenAI, Mistral, Perplexity: page-wide indicator from `status.json` /
  `summary.json`. none = Operational, minor = Degraded, major = Partial outage,
  critical = Major outage. Mistral's feed covers its API platform, not Le Chat,
  so the board calls it "Mistral".
- Groq: worst of components API and Website (per-model components ignored).

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
- CHECK: our site check failed twice but official says Operational.
- RECOVERED: back to Operational. Never sent while the status is Unknown.
- Degraded alone does not alert.

Health channel:
- Samples saved (once).
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
