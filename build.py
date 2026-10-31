# Generates the static pages with a shared header and footer.
DOMAIN = "https://liveoutageradar.com"   # change if you buy a different domain
CHECKED = "October 26, 2026"

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{domain}/{path}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="site-header">
  <div class="wrap-wide">
    <a class="wordmark" href="/">OutageRadar</a>
    <nav class="site-nav" aria-label="Main">
      {nav}
    </nav>
  </div>
</header>
"""

FOOT = """<footer class="site-footer">
  <div class="wrap-wide">
    <p>Some links on this site are affiliate links. If you sign up through them, I may earn a commission at no extra cost to you. <a href="/disclosure.html">How that works</a>.</p>
    <nav aria-label="Footer">
      <a href="/about.html">About</a>
      <a href="/disclosure.html">Affiliate disclosure</a>
      <a href="/privacy.html">Privacy</a>
    </nav>
    <p class="meta" style="margin-top:1rem">&copy; 2026 OutageRadar. Nothing here is financial advice.</p>
  </div>
</footer>
</body>
</html>
"""

NAV = [("/stack.html", "My stack"), ("/about.html", "About"), ("/disclosure.html", "Disclosure")]

def page(filename, title, desc, body):
    nav = "\n      ".join(
        f'<a href="{href}"{" aria-current=\"page\"" if href == "/" + filename else ""}>{label}</a>'
        for href, label in NAV)
    path = "" if filename == "index.html" else filename
    html = HEAD.format(title=title, desc=desc, domain=DOMAIN, path=path, nav=nav) + body + FOOT
    with open(filename, "w", encoding="utf-8") as f:
        f.write(html)

# ---------- Home ----------
page("index.html",
 "OutageRadar \u2013 AI tools for building trading bots",
 "The tools, guides and dead ends from building trading bots with AI, by someone who isn\u2019t a professional coder.",
 """<main>
<section class="hero">
  <div class="wrap-wide">
    <div class="moon" aria-hidden="true"></div>
    <div class="hero-copy">
      <p class="clock">11:47 pm, another bot deploy</p>
      <h1>Trading bots, built after hours with AI.</h1>
      <p class="lede">I\u2019m not a professional coder. Every bot I run was built by prompting AI. This site is the toolkit I use, the guides I wish I\u2019d had, and the dead ends I hit along the way.</p>
      <a class="button" href="/stack.html">See my stack</a>
    </div>
  </div>
</section>

<div class="wrap">
  <h2>What\u2019s here</h2>
  <ul class="section-list">
    <li><h3><a href="/stack.html">My stack</a></h3><span class="status live">Live</span>
      <p>Every tool I use to build, host and monitor my bots, and what I actually think of each one.</p></li>
    <li><h3>Getting-started guides</h3><span class="status">Being written</span>
      <p>Step-by-step walkthroughs for non-coders, from your first deploy to running a bot around the clock.</p></li>
    <li><h3>Free credits and free tiers</h3><span class="status">Being written</span>
      <p>Which AI and cloud platforms give new users credits or a free tier, linked to each official offer page.</p></li>
    <li><h3>Comparisons</h3><span class="status">Being written</span>
      <p>Two established tools side by side: what each is good at and who it suits.</p></li>
    <li><h3>Lessons learned</h3><span class="status">Being written</span>
      <p>The mistakes and dead ends, written up so you can skip them.</p></li>
  </ul>

  <h2>House rules</h2>
  <ul class="rules">
    <li>No predictions, picks or performance claims. This site is about the tools, not about returns.</li>
    <li>Prices, credits and promo terms link to the official source, because they change often.</li>
    <li>Every page shows when it was last checked.</li>
    <li>I only cover tools I\u2019ve used or tested myself.</li>
  </ul>
</div>
</main>
""")

# ---------- Stack ----------
TOOLS = [
 ("Claude", "AI coding assistant", "https://claude.ai",
  "Writing and debugging all of the code behind my bots. I describe what I want, review what comes back, and iterate.",
  "This is the reason I can build bots at all. I explain what I want in plain English and get working code back, along with an explanation of what it does. The catch is that AI can be confidently wrong, so I make it diagnose a problem and explain its plan before it writes any code, and I test everything on paper before it touches real money. If you\u2019re willing to test carefully, it\u2019s the best starting point for a non-coder."),
 ("GitHub", "Code storage and version history", "https://github.com",
  "Keeping every version of every bot so I can roll back when something breaks.",
  "Every bot lives in its own repo, and that history has saved me more than once after a bad change. The terminology (commits, branches, pushes) takes some getting used to, but you can start by uploading files through the website and learn the rest as you go. Essential for anyone building anything."),
 ("Render", "Hosting", "https://render.com",
  "Running my bots and web apps around the clock without managing a server myself.",
  "Connect a GitHub repo and Render redeploys every time you push a change, which is about as simple as hosting gets. The dashboard, logs and settings take a little learning, and it\u2019s worth keeping an eye on which services are free and which are paid. A good fit if you want your bot running 24/7 without becoming a server admin."),
 ("Supabase", "Database", "https://supabase.com",
  "Storing trades, signals and logs in a PostgreSQL database my bots read and write.",
  "Its web dashboard lets me look at my bots\u2019 data in tables without writing code, which makes checking what a bot actually did much easier. Databases have a learning curve, and planning your tables before you start saves headaches later. Worth it as soon as your bot needs to remember anything between runs."),
 ("Discord", "Alerts", "https://discord.com",
  "Sending my bots\u2019 alerts and status updates to my phone in real time.",
  "I run a private server where my bots post updates, so my phone tells me what\u2019s happening wherever I am. Setting up a webhook is free and simple. The trick is deciding what deserves an alert, because a noisy bot gets ignored fast. Great for anyone who wants free, real-time notifications."),
 ("Python and Flask", "Programming language and web framework", "https://flask.palletsprojects.com",
  "The language and framework my bots are written in. Free and open source.",
  "Python has a library for almost everything in trading, and AI assistants write it well, which matters when you\u2019re not a coder. Flask handles the small web pieces, like status pages and endpoints. The most common headaches are package versions that work on my machine but not on the server. A safe default for your first bot."),
]
entries = []
for name, kind, url, use, take in TOOLS:
    entries.append(f"""  <article class="tool">
    <h3>{name}</h3>
    <p class="kind">{kind}</p>
    <dl>
      <dt>What I use it for</dt>
      <dd>{use}</dd>
      <dt>My take</dt>
      <dd>{take}</dd>
    </dl>
    <a href="{url}" rel="noopener" data-affiliate="pending">Visit {name}</a>
  </article>""")

page("stack.html",
 "My stack \u2013 OutageRadar",
 "Every tool I use to build, host and monitor trading bots with AI, and what I think of each one.",
 f"""<main class="wrap">
  <h1 style="margin-top:3rem">My stack</h1>
  <p class="lede">The tools I use to build, host and monitor my trading bots. I\u2019m not a professional coder, so everything here has to work for someone learning as they go.</p>
  <p class="meta">Last checked {CHECKED}</p>
  <p class="meta">Some links below may be affiliate links. <a href="/disclosure.html">Read the disclosure</a>.</p>
{chr(10).join(entries)}
</main>
""")

# ---------- About ----------
page("about.html",
 "About \u2013 OutageRadar",
 "Who runs OutageRadar and why.",
 """<main class="wrap">
  <h1 style="margin-top:3rem">About</h1>
  <p class="lede">OutageRadar is run by Ghost Drive, a builder who runs several trading bots without being a professional programmer.</p>
  <p>Every line of code behind my bots was written with AI. I describe what I want, test what comes back, and keep going until it works. Along the way I\u2019ve tried a lot of tools, wasted money on some, and found a setup that works for me.</p>
  <p>This site shares that setup honestly. I don\u2019t sell signals, I don\u2019t make performance claims, and I only write about tools I\u2019ve used myself.</p>
  <p>I started with no programming background, just an interest in trading and a lot of late nights. Today I run several bots: a momentum scanner for day trading and bots that trade prediction markets on Kalshi, all hosted in the cloud with alerts sent straight to my phone. None of them is a finished success story. I\u2019m still testing, measuring and improving, and this site is where I share the tools and lessons along the way.</p>
</main>
""")

# ---------- Disclosure ----------
page("disclosure.html",
 "Affiliate disclosure \u2013 OutageRadar",
 "How OutageRadar earns money through affiliate links.",
 f"""<main class="wrap">
  <h1 style="margin-top:3rem">Affiliate disclosure</h1>
  <p class="meta">Last updated {CHECKED}</p>
  <p>Some links on this site are affiliate or referral links. If you click one and sign up or buy something, the company may pay me a commission. It costs you nothing extra, and some programs give you signup credits or a discount.</p>
  <p>Commissions never decide what I recommend. I only cover tools I\u2019ve used or tested, and I\u2019ll say so when something has downsides.</p>
  <p>Any placement a company has paid for is clearly labeled as sponsored.</p>
  <p>Nothing on this site is financial, investment or legal advice. Trading involves risk, including the loss of money.</p>
</main>
""")

# ---------- Privacy ----------
page("privacy.html",
 "Privacy \u2013 OutageRadar",
 "What data OutageRadar collects and how it is used.",
 f"""<main class="wrap">
  <h1 style="margin-top:3rem">Privacy</h1>
  <p class="meta">Last updated {CHECKED}</p>
  <p>This site doesn\u2019t have accounts or sign-ups, and it doesn\u2019t ask for personal information.</p>
  <p><strong>Analytics.</strong> This site doesn\u2019t currently use analytics or set cookies of its own. If that changes, this page will name the tool used and link to its privacy policy.</p>
  <p><strong>Affiliate links.</strong> When you click an affiliate link, the company you visit may set its own cookies to track the referral. Their privacy policies apply on their sites.</p>
  <p><strong>Ads.</strong> This site doesn\u2019t currently show ads. If ads are added later, this page will describe the ad network\u2019s cookies and link to its policy.</p>
</main>
""")

# ---------- 404 ----------
page("404.html",
 "Page not found \u2013 OutageRadar",
 "Page not found.",
 """<main class="wrap">
  <h1 style="margin-top:3rem">This page doesn\u2019t exist.</h1>
  <p>It may have moved, or the link may have a typo. <a href="/">Go to the homepage</a> or <a href="/stack.html">see my stack</a>.</p>
</main>
""")

# ---------- robots + sitemap ----------
with open("robots.txt", "w") as f:
    f.write(f"User-agent: *\nAllow: /\nSitemap: {DOMAIN}/sitemap.xml\n")
urls = ["", "stack.html", "about.html", "disclosure.html", "privacy.html"]
with open("sitemap.xml", "w") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
    for u in urls:
        f.write(f"  <url><loc>{DOMAIN}/{u}</loc><lastmod>2026-10-26</lastmod></url>\n")
    f.write("</urlset>\n")
print("built")
