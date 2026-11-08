# OutageRadar badge and link kit

Not published on the website (only the `site/` folder is). Kept here as the
master copy for any site that links to OutageRadar.

Files:
- `outageradar-badge@2x.png`: use this one (736 x 144, shown at 368 x 72, sharp on phones)
- `outageradar-badge.png`: normal size (368 x 72)
- `outageradar-badge.svg`: original, any size

## How to give it to another site

1. Send them the PNG (or this whole folder) and ask them to upload it to
   their own site. Loading it from ours is not needed.
2. Give them the link with a tag naming THEIR site, so the dashboard shows
   where visitors came from ("Tag: <name>"). Lowercase letters, numbers,
   - or _ only, up to 30 characters:

   https://liveoutageradar.com/?utm_source=SITENAME

   Examples: utm_source=tokenmargin, utm_source=reddit, utm_source=bluesky

3. Paste-ready code (replace SITENAME):

   <a href="https://liveoutageradar.com/?utm_source=SITENAME" target="_blank" rel="noopener">
     <img src="/images/outageradar-badge@2x.png" width="368" height="72"
          alt="OutageRadar: know when to switch. Live status of 10 AI APIs">
   </a>

   Text-only version:

   <a href="https://liveoutageradar.com/?utm_source=SITENAME" target="_blank" rel="noopener">Know when to switch: live outage radar for ChatGPT, Claude, Gemini and 7 more</a>

## Tags in use
- tokenmargin: TokenMargin (Charlie), Nov 2026
- boss: Will's own visits (bookmark), so they can be told apart

## Rules
- Keep it one natural link per site (Google warns against link swaps at scale).
- If money or referrals ever change hands for a link, it must be marked
  rel="sponsored" and disclosed.
