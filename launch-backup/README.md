# Launch backup (not public)

Launched Nov 5, 2026: the status board became the homepage (site/index.html,
site/board.js), search engines were allowed in (site/robots.txt), and
site/sitemap.xml was added.

To roll back to the coming-soon page:
1. Copy coming-soon-index.html to site/index.html
2. Copy coming-soon-robots.txt to site/robots.txt
3. Push to GitHub (Render redeploys on its own)
The board itself stays in site/board.js; nothing else needs to change.
