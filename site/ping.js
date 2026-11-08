// OutageRadar page-view and link-click counts.
//
// Sends one small ping per page load and one per outbound link click to our
// own Worker (data.liveoutageradar.com), which keeps daily totals only.
// Sent: the page path, the referring site's domain (not the full address),
// a utm_source tag if the link had one, and whether the browser says it is
// automated. Not sent or stored: IP address, cookies, IDs, screen or device
// details. Nothing is stored in the browser. A failed ping changes nothing
// on the page. The privacy page describes this (tested in web-tests/).
// This file must stay ASCII-only.

export const COUNT_URL = "https://data.liveoutageradar.com";
const OWN_SITE = /(^|\.)liveoutageradar\.com$/;

export function cleanPath(pathname) {
  let p = String(pathname || "/").toLowerCase();
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  return p || "/";
}

export function referrerHost(referrer) {
  if (!referrer) return "";
  try {
    return new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch (err) {
    return "";
  }
}

export function utmSource(search) {
  try {
    const tag = (new URLSearchParams(search || "").get("utm_source") || "").toLowerCase();
    return /^[a-z0-9_-]{1,30}$/.test(tag) ? tag : "";
  } catch (err) {
    return "";
  }
}

export function viewBody({ pathname, referrer, search, webdriver }) {
  const form = new URLSearchParams();
  form.set("p", cleanPath(pathname));
  form.set("r", referrerHost(referrer));
  const tag = utmSource(search);
  if (tag) form.set("s", tag);
  if (webdriver) form.set("w", "1");
  return form.toString();
}

export function linkFor(href, ownHost) {
  if (typeof href !== "string") return null;
  if (/^mailto:/i.test(href)) return "email";
  if (!/^https?:\/\//i.test(href)) return null;
  try {
    const host = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || OWN_SITE.test(host) || host === ownHost) return null;
    return host;
  } catch (err) {
    return null;
  }
}

function send(path, body) {
  try {
    const url = COUNT_URL + path;
    const sent = typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }));
    if (!sent && typeof fetch === "function") {
      fetch(url, { method: "POST", body, keepalive: true, mode: "no-cors", credentials: "omit" })
        .catch(() => {});
    }
  } catch (err) {
    // counting must never affect the page
  }
}

function startCounting() {
  const page = cleanPath(location.pathname);
  send("/v", viewBody({
    pathname: location.pathname,
    referrer: document.referrer,
    search: location.search,
    webdriver: navigator.webdriver === true,
  }));
  const onClick = (event) => {
    try {
      const a = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!a) return;
      const link = linkFor(a.getAttribute("href"), location.hostname.toLowerCase().replace(/^www\./, ""));
      if (!link) return;
      const form = new URLSearchParams();
      form.set("l", link);
      form.set("p", page);
      send("/c", form.toString());
    } catch (err) {
      // ignore
    }
  };
  document.addEventListener("click", onClick, { capture: true, passive: true });
  document.addEventListener("auxclick", onClick, { capture: true, passive: true });
}

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof location !== "undefined") {
  startCounting();
}
