// OutageRadar board: display logic and live updates.
//
// Safety rules (tested in web-tests/board.test.js):
//   - Every service starts as "Checking", never green.
//   - No data, or data older than 15 minutes, means every service is Unknown,
//     with a banner. Age comes from the server (age_seconds), never from the
//     visitor's clock.
//   - "Up (our check only)" never looks like official Operational.
//   - One malformed service cannot stop the others from updating.
//   - Polling pauses in background tabs and after 20 idle minutes.
// Data source: the OutageRadar checker Worker (worker/checker.js in the repo).
// This file must stay ASCII-only.

export const DATA_URL = "https://data.liveoutageradar.com/status.json";
const STALE_AFTER_SEC = 15 * 60;
const POLL_MS = 2 * 60 * 1000;
const IDLE_PAUSE_MS = 20 * 60 * 1000;
const TICK_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 10000;

// The fixed list the page is built with (also written into index.html so
// search engines and link previews see real text before any script runs).
export const SHELL = [
  { id: "openai", name: "ChatGPT / OpenAI", status_page: "https://status.openai.com" },
  { id: "claude", name: "Claude", status_page: "https://status.claude.com" },
  { id: "gemini", name: "Gemini", status_page: "https://aistudio.google.com/status", nofeed: true },
  { id: "xai", name: "Grok / xAI", status_page: "https://status.x.ai" },
  { id: "mistral", name: "Mistral", status_page: "https://status.mistral.ai" },
  { id: "perplexity", name: "Perplexity", status_page: "https://status.perplexity.com" },
  { id: "deepseek", name: "DeepSeek", status_page: "https://status.deepseek.com", nofeed: true },
  { id: "cohere", name: "Cohere", status_page: "https://status.cohere.com" },
  { id: "groq", name: "Groq", status_page: "https://groqstatus.com" },
  { id: "huggingface", name: "Hugging Face", status_page: "https://status.huggingface.co" },
];

export const COLORS = {
  bg: "#06110d",
  text: "#e8fff1",
  muted: "#9cc9ad",
  pill: "#171c1a",
  states: {
    operational: "#4be08a",
    degraded: "#ffd166",
    partial_outage: "#ffa552",
    major_outage: "#ff8a80",
    maintenance: "#8ec5ff",
    signals_disagree: "#ffb547",
    check_ok: "#5fd4d0",
    check_failed: "#ff8a80",
    unknown: "#b5c2bb",
    checking: "#b5c2bb",
  },
};

const BADGES = {
  operational: { label: "Operational", icon: "\u2713" },
  degraded: { label: "Degraded", icon: "!" },
  partial_outage: { label: "Partial outage", icon: "\u25B2" },
  major_outage: { label: "Major outage", icon: "\u2715" },
  maintenance: { label: "Maintenance", icon: "\u25D1" },
  signals_disagree: { label: "Signals disagree", icon: "\u2260" },
  check_ok: { label: "Up (our check only)", icon: "\u25CB" },
  check_failed: { label: "Not answering (our check only)", icon: "\u2715" },
  unknown: { label: "Unknown", icon: "?" },
  checking: { label: "Checking\u2026", icon: "\u2026" },
};

const OFFICIAL_WORDS = {
  operational: "Operational",
  degraded: "Degraded",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  maintenance: "Maintenance",
};

const PROBLEM_RANK = {
  major_outage: 0,
  partial_outage: 1,
  check_failed: 2,
  signals_disagree: 3,
  degraded: 4,
  maintenance: 5,
};
const PROBLEMS = ["major_outage", "partial_outage", "check_failed", "signals_disagree", "degraded"];

const NOTES = {
  signals_disagree: "The provider reports operational, but our check could not reach the service. Watching.",
  check_failed: "Our check could not reach the API twice in a row. The provider publishes no status feed to confirm.",
};

// ---------- small helpers ----------

export function badgeFor(key) {
  const k = BADGES[key] ? key : "unknown";
  return { key: k, label: BADGES[k].label, icon: BADGES[k].icon, cls: "s-" + k, color: COLORS.states[k] };
}

function hhmmUtc(isoText) {
  const t = Date.parse(isoText || "");
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " UTC";
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function describeOfficial(official, hasFeed) {
  if (!hasFeed) return "No public status feed from the provider. Reachability checked by OutageRadar.";
  if (!official || typeof official !== "object") return "Official status: unknown";
  const note = String(official.note || "");
  if (/^Feed problem/i.test(note)) return "Official status: not available right now";
  if (/not approved/i.test(note)) return "Official status: not shown yet";
  const word = OFFICIAL_WORDS[official.status] || "Unknown";
  const when = hhmmUtc(official.checked_at_utc);
  return "Official status: " + word + (when ? " (checked " + when + ")" : "");
}

export function describeProbe(probe) {
  if (!probe || typeof probe !== "object") return { text: "Our check: couldn't check right now", code: "" };
  const api = /api/i.test(String(probe.label || ""));
  let text;
  if (probe.status === "reachable") text = api ? "API server responding" : "Website reachable";
  else if (probe.status === "unreachable") text = api ? "API server not responding" : "Website not reachable";
  else text = "couldn't check right now";
  let code = Number.isInteger(probe.http_status) ? "HTTP " + probe.http_status : "";
  // 401/403 from an API without a key means "up, but needs a key", not an error.
  if (api && (probe.http_status === 401 || probe.http_status === 403)) code += ", needs a key";
  return { text: "Our check: " + text, code };
}

function shellModel(entry, order, badgeKey) {
  const word = badgeKey === "checking" ? "checking\u2026" : "unknown";
  return {
    id: entry.id,
    name: entry.name,
    status_page: entry.status_page,
    order,
    badge: badgeFor(badgeKey),
    official: entry.nofeed ? describeOfficial(null, false) : "Official status: " + word,
    probe: { text: "Our check: " + word, code: "" },
    note: "",
  };
}

function serviceModel(raw, entry, order) {
  const hasFeed = !(raw.official && /no official public feed/i.test(String(raw.official.note || "")));
  const badge = badgeFor(BADGES[raw.overall] ? raw.overall : "unknown");
  if (typeof raw.official !== "object" || raw.official === null) throw new Error("bad official");
  if (typeof raw.probe !== "object" || raw.probe === null) throw new Error("bad probe");
  return {
    id: entry.id,
    name: (raw.name && String(raw.name)) || entry.name,
    status_page: entry.status_page || String(raw.status_page || ""),
    order,
    badge,
    official: describeOfficial(raw.official, hasFeed),
    probe: describeProbe(raw.probe),
    note: NOTES[badge.key] || "",
  };
}

// ---------- the view ----------

export function buildView(data, opts = {}) {
  const elapsedSec = Math.max(0, Number(opts.elapsedSec) || 0);
  const entries = SHELL.slice();
  const byId = new Map();
  if (data && Array.isArray(data.services)) {
    for (const raw of data.services) {
      if (!raw || typeof raw.id !== "string") continue;
      byId.set(raw.id, raw);
      if (!entries.some((e) => e.id === raw.id)) {
        entries.push({ id: raw.id, name: String(raw.name || raw.id), status_page: String(raw.status_page || "") });
      }
    }
  }

  if (!data) {
    const loading = opts.state === "loading";
    return {
      mode: loading ? "loading" : "error",
      banner: loading ? "" : "Can't reach our status data right now. Every service shows Unknown until it's back.",
      updated: loading ? "Checking services\u2026" : "No data",
      checking: loading,
      services: entries.map((e, i) => shellModel(e, i, loading ? "checking" : "unknown")),
    };
  }

  const age = typeof data.age_seconds === "number" ? data.age_seconds + elapsedSec : null;
  const stale = data.stale === true || age === null || age > STALE_AFTER_SEC;
  const updatedAt = hhmmUtc(data.generated_at_utc);
  const updated = updatedAt ? "Last updated " + updatedAt : "No update time";

  if (stale) {
    return {
      mode: "stale",
      banner: "This data is stale" + (updatedAt ? " (last update " + updatedAt + ")" : "") +
        ". Every service shows Unknown until fresh data arrives.",
      updated,
      checking: false,
      services: entries.map((e, i) => shellModel(e, i, "unknown")),
    };
  }

  const services = entries.map((e, i) => {
    const raw = byId.get(e.id);
    if (!raw) return shellModel(e, i, "unknown");
    try {
      return serviceModel(raw, e, i);
    } catch (err) {
      return shellModel(e, i, "unknown");
    }
  });
  return {
    mode: opts.refreshFailed ? "refresh-failed" : "fresh",
    banner: opts.refreshFailed ? "Couldn't refresh just now. Showing data from " + updatedAt + "." : "",
    updated,
    checking: false,
    services,
  };
}

export function sortServices(services) {
  return services.slice().sort((a, b) => {
    const ra = a.badge.key in PROBLEM_RANK ? PROBLEM_RANK[a.badge.key] : 9;
    const rb = b.badge.key in PROBLEM_RANK ? PROBLEM_RANK[b.badge.key] : 9;
    return ra - rb || a.order - b.order;
  });
}

export function summaryLine(view) {
  if (view.checking) return "Checking services\u2026";
  const keys = view.services.map((s) => s.badge.key);
  const problems = keys.filter((k) => PROBLEMS.includes(k)).length;
  const unknown = keys.filter((k) => k === "unknown").length;
  if (unknown === keys.length) return "Status unknown right now.";
  if (problems > 0) return problems + (problems === 1 ? " service" : " services") + " reporting problems.";
  if (unknown > 0) return "No problems reported. " + unknown + (unknown === 1 ? " service is" : " services are") + " unknown.";
  return "No problems reported right now.";
}

// Radar dots: problems are drawn bigger with a ring so they stand out,
// including in screenshots people share.
export function blipFor(key) {
  const problem = PROBLEMS.includes(key);
  return { r: problem ? 13 : 9, halo: problem };
}

// The header indicator. It says "Live" only while data is fresh and updating.
const LIVE_STATES = {
  live: { label: "Live", pulse: true },
  checking: { label: "Checking\u2026", pulse: false },
  paused: { label: "Paused", pulse: false },
  reconnecting: { label: "Reconnecting", pulse: false },
  stale: { label: "Stale", pulse: false },
  offline: { label: "Offline", pulse: false },
};

export function liveState(view, { paused }) {
  let key;
  if (view.mode === "loading") key = "checking";
  else if (view.mode === "error") key = "offline";
  else if (view.mode === "stale") key = "stale";
  else if (view.mode === "refresh-failed") key = "reconnecting";
  else if (paused) key = "paused";
  else if (view.mode === "fresh") key = "live";
  else key = "offline";
  return { key, label: LIVE_STATES[key].label, pulse: LIVE_STATES[key].pulse };
}

export function pollDecision({ hidden, idleMs }) {
  if (hidden) return "pause-hidden";
  if (idleMs >= IDLE_PAUSE_MS) return "pause-idle";
  return "poll";
}

// ---------- browser side ----------

function startBoard() {
  const $ = (sel) => document.querySelector(sel);
  const list = $("#services");
  const banner = $("#banner");
  const updatedEl = $("#updated");
  const summaryEl = $("#summary");
  const pausedBtn = $("#resume");
  const blips = $("#blips");
  const liveEl = $("#live");
  let lastView = null;

  let lastData = null;
  let receivedAt = 0;
  let refreshFailed = false;
  let everFailed = false;
  let lastActivity = performance.now();
  let lastFetch = 0;
  let paused = false;
  let inFlight = false;

  function rowFor(model) {
    let li = list.querySelector('li[data-id="' + CSS.escape(model.id) + '"]');
    if (!li) {
      li = document.createElement("li");
      li.dataset.id = model.id;
      li.innerHTML = '<span class="pill"><span class="pi" aria-hidden="true"></span><span class="pl"></span></span>' +
        '<h2 class="name"><a></a></h2><p class="official"></p><p class="probe"><span class="pt"></span> <span class="pc"></span></p>' +
        '<p class="note"></p>';
      list.appendChild(li);
    }
    return li;
  }

  function paintLive(view) {
    if (!liveEl || !view) return;
    const ls = liveState(view, { paused });
    liveEl.className = "live live-" + ls.key + (ls.pulse ? " pulse" : "");
    liveEl.querySelector(".ll").textContent = ls.label;
  }

  function paintBlip(m) {
    const dot = blips && blips.querySelector('circle.blip[data-id="' + CSS.escape(m.id) + '"]');
    if (!dot) return;
    const b = blipFor(m.badge.key);
    dot.setAttribute("class", "blip " + m.badge.cls);
    dot.setAttribute("r", String(b.r));
    let halo = blips.querySelector('circle.halo[data-for="' + CSS.escape(m.id) + '"]');
    if (b.halo && !halo) {
      halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      halo.setAttribute("data-for", m.id);
      halo.setAttribute("cx", dot.getAttribute("cx"));
      halo.setAttribute("cy", dot.getAttribute("cy"));
      halo.setAttribute("r", "13");
      blips.insertBefore(halo, blips.firstChild);
    }
    if (halo) {
      if (b.halo) halo.setAttribute("class", "halo " + m.badge.cls);
      else halo.remove();
    }
  }

  function paint(view) {
    lastView = view;
    paintLive(view);
    banner.textContent = view.banner;
    banner.hidden = !view.banner;
    updatedEl.textContent = view.updated;
    summaryEl.textContent = summaryLine(view);
    const sorted = sortServices(view.services);
    sorted.forEach((m, i) => {
      try {
        const li = rowFor(m);
        li.className = "row " + m.badge.cls;
        li.querySelector(".pi").textContent = m.badge.icon;
        li.querySelector(".pl").textContent = m.badge.label;
        const a = li.querySelector(".name a");
        a.textContent = m.name;
        if (m.status_page) a.href = m.status_page;
        li.querySelector(".official").textContent = m.official || "Official status: checking\u2026";
        li.querySelector(".pt").textContent = m.probe.text || "Our check: checking\u2026";
        li.querySelector(".pc").textContent = m.probe.code ? "(" + m.probe.code + ")" : "";
        const note = li.querySelector(".note");
        note.textContent = m.note;
        note.hidden = !m.note;
        if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
        paintBlip(m);
      } catch (err) {
        // one row failing must not stop the rest
      }
    });
  }

  function render() {
    if (!lastData) {
      paint(buildView(null, { state: everFailed ? "error" : "loading" }));
      return;
    }
    paint(buildView(lastData, { elapsedSec: (performance.now() - receivedAt) / 1000, refreshFailed }));
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    lastFetch = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(DATA_URL, { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data || !Array.isArray(data.services)) throw new Error("bad data");
      lastData = data;
      receivedAt = performance.now();
      refreshFailed = false;
    } catch (err) {
      everFailed = true;
      refreshFailed = !!lastData;
    } finally {
      clearTimeout(timer);
      inFlight = false;
      render();
    }
  }

  function setPaused(on) {
    paused = on;
    pausedBtn.hidden = !on;
    paintLive(lastView);
  }

  function poll() {
    const decision = pollDecision({ hidden: document.hidden, idleMs: performance.now() - lastActivity });
    if (decision === "poll") {
      setPaused(false);
      refresh();
    } else if (decision === "pause-idle") {
      setPaused(true);
    }
  }

  function activity() {
    lastActivity = performance.now();
  }

  ["pointerdown", "keydown", "scroll", "touchstart", "mousemove"].forEach((ev) =>
    window.addEventListener(ev, activity, { passive: true }));

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !paused && performance.now() - lastFetch > 60 * 1000) refresh();
  });

  pausedBtn.addEventListener("click", () => {
    activity();
    setPaused(false);
    refresh();
  });

  render();
  refresh();
  setInterval(poll, POLL_MS);
  setInterval(render, TICK_MS);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startBoard);
  else startBoard();
}
