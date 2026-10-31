# OutageRadar - starter site

Static site: plain HTML + one stylesheet. No build step, no database, no accounts.

## Files
- index.html - homepage
- stack.html - "My stack" page (fill in the highlighted "My take" notes)
- about.html, disclosure.html, privacy.html, 404.html
- styles.css - all styling
- robots.txt, sitemap.xml - for search engines
- build.py - regenerates every page from one script (edit text there, then run: python3 build.py)

## Before going live
1. Fill in every highlighted note (search the files for "Will:" and "add a").
2. If your domain isn't liveoutageradar.com, change DOMAIN at the top of build.py and run it again.
3. Swap links marked data-affiliate="pending" for your tracking links once programs approve you.

## Deploy on Render (free static site)
1. Create a new GitHub repo (e.g. outageradar) and upload these files to it.
2. In Render: New > Static Site > connect the repo.
3. Leave Build Command empty. Set Publish Directory to .
4. Deploy. You'll get a free onrender.com address to test on.
5. When you buy the domain, add it in the site's Custom Domains settings in Render and follow its DNS steps.
