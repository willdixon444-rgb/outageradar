# OutageRadar badge and link kit

Not published on the website (only the `site/` folder is). Kept here as the
master copy for any site that links to OutageRadar.

Files:
- `outageradar-badge@2x.png`: 736 x 144, shown at 368 x 72, sharp on phones. Same file as
  https://liveoutageradar.com/badge.png (the permanent public address)
- `outageradar-badge.png`: normal size (368 x 72)
- `outageradar-badge.svg`: the design, any size
- All three are made by `python3 tools/badge_image.py` (writes site/badge.png too).
  The badge names no service count, so it never goes stale on other sites.
- `outageradar-x-header.png`: X/Bluesky banner (1500 x 500), as uploaded Nov 11, 2026
- `outageradar-x-profile.png`: X/Bluesky avatar (400 x 400), as uploaded Nov 11, 2026

## How to give it to another site

1. Easiest: they paste the code below, which loads the badge from
   https://liveoutageradar.com/badge.png. (Or send them the PNG to host
   themselves; then they change the img src to their own copy.)
2. Give them the link with a tag naming THEIR site, so the dashboard shows
   where visitors came from ("Tag: <name>"). Lowercase letters, numbers,
   - or _ only, up to 30 characters:

   https://liveoutageradar.com/?utm_source=SITENAME

   Examples: utm_source=tokenmargin, utm_source=reddit, utm_source=bluesky

3. Paste-ready code (replace SITENAME):

   <a href="https://liveoutageradar.com/?utm_source=SITENAME" target="_blank" rel="noopener">
     <img src="https://liveoutageradar.com/badge.png" width="368" height="72"
          alt="OutageRadar: know when to switch. Live status of AI APIs">
   </a>

   Text-only version:

   <a href="https://liveoutageradar.com/?utm_source=SITENAME" target="_blank" rel="noopener">Know when to switch: live status for ChatGPT, Claude, Gemini and other AI APIs</a>

## Tags in use
- tokenmargin: TokenMargin (Charlie), Nov 2026
- boss: Will's own visits (bookmark), so they can be told apart
- x: the pinned intro post on X (@OutageRadarX)
- bluesky: the pinned intro post on Bluesky (@liveoutageradar.com)

## Rules
- Keep it one natural link per site (Google warns against link swaps at scale).
- If money or referrals ever change hands for a link, it must be marked
  rel="sponsored" and disclosed.
