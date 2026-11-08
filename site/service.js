// OutageRadar history page (/status/<id>/): live status for one service plus
// its incident log. Same safety rules as the board (board.js): starts as
// "Checking", never green by default; data older than 15 minutes (by the
// server's clock) shows Unknown; polling pauses in background tabs and after
// 20 idle minutes. History comes from data.liveoutageradar.com/incidents.json.
// Page-view counts: ./ping.js (loaded through board.js). ASCII-only file.

import {
  DATA_URL, SHELL, POLL_MS, FETCH_TIMEOUT_MS, buildView, liveState, pollDecision, durationText, utcDate,
} from "./board.js";

export const HISTORY_URL = "https://data.liveoutageradar.com/incidents.json";
const HISTORY_EVERY_MS = 10 * 60 * 1000;
const TICK_MS = 30 * 1000;

const WHAT = {
  degraded: "Degraded",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  signals_disagree: "Our check failed",
  check_failed: "Our check failed",
};

function two(n) {
  return (n < 10 ? "0" : "") + n;
}

function hhmm(ms) {
  const d = new Date(ms);
  return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes());
}

function sameUtcDay(a, b) {
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

function whenText(startMs, endMs) {
  const start = utcDate(startMs) + ", " + hhmm(startMs);
  if (endMs === null) return start + " UTC - ongoing";
  if (sameUtcDay(startMs, endMs)) return start + " - " + hhmm(endMs) + " UTC";
  return start + " UTC - " + utcDate(endMs) + ", " + hhmm(endMs) + " UTC";
}

// entry: one service from incidents.json. service: { name, nofeed }.
// Returns { since, items } or null when the entry is missing or damaged.
export function historyItems(entry, service) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.incidents)) return null;
  const sinceMs = Date.parse(entry.since_utc);
  if (!Number.isFinite(sinceMs)) return null;
  const name = (service && service.name) || String(entry.name || "");
  const items = [];
  for (const x of entry.incidents) {
    try {
      if (!x || typeof x !== "object" || !WHAT[x.worst]) continue;
      const start = Date.parse(x.started_utc);
      if (!Number.isFinite(start)) continue;
      const end = x.ended_utc === null ? null : Date.parse(x.ended_utc);
      if (end !== null && !Number.isFinite(end)) continue;
      let length = durationText(Number(x.minutes) || 0);
      const notes = [];
      if (end === null) length += " so far";
      else if (x.end_confirmed === false) {
        if (!length.startsWith("under")) length = "about " + length;
        notes.push("End not confirmed: no clear signal for 2 hours");
      }
      if (x.kind === "our_check") {
        notes.unshift(service && service.nofeed
          ? "Seen by our check only (" + name + " publishes no status feed)"
          : "Seen by our check only; not confirmed on " + name + "'s status page");
      }
      items.push({ when: whenText(start, end), what: WHAT[x.worst], length, notes });
    } catch (err) {
      // skip a damaged entry, keep the rest
    }
  }
  return {
    since: "History logged by OutageRadar since " + utcDate(sinceMs) + ", " + new Date(sinceMs).getUTCFullYear() + ".",
    items,
  };
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function startPage(id) {
  const $ = (sel) => document.querySelector(sel);
  const service = SHELL.find((s) => s.id === id) || { id, name: id };
  const row = $("#row");
  const banner = $("#banner");
  const updatedEl = $("#updated");
  const liveEl = $("#live");
  const listEl = $("#history");
  const sinceEl = $("#since");

  let lastData = null;
  let receivedAt = 0;
  let refreshFailed = false;
  let everFailed = false;
  let inFlight = false;
  let lastActivity = performance.now();
  let lastFetch = 0;
  let paused = false;

  function paint(view) {
    const ls = liveState(view, { paused });
    liveEl.className = "live live-" + ls.key + (ls.pulse ? " pulse" : "");
    liveEl.querySelector(".ll").textContent = ls.label;
    updatedEl.textContent = view.updated;
    banner.textContent = view.banner;
    banner.hidden = !view.banner;
    const m = view.services.find((s) => s.id === id);
    if (!m) return;
    row.className = "row " + m.badge.cls;
    row.querySelector(".pi").textContent = m.badge.icon;
    row.querySelector(".pl").textContent = m.badge.label;
    row.querySelector(".official").textContent = m.official || "Official status: checking\u2026";
    row.querySelector(".pt").textContent = m.probe.text || "Our check: checking\u2026";
    row.querySelector(".pc").textContent = m.probe.code ? "(" + m.probe.code + ")" : "";
    const note = row.querySelector(".note");
    note.textContent = m.note;
    note.hidden = !m.note;
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
    try {
      const data = await getJson(DATA_URL);
      if (!data || !Array.isArray(data.services)) throw new Error("bad data");
      lastData = data;
      receivedAt = performance.now();
      refreshFailed = false;
    } catch (err) {
      everFailed = true;
      refreshFailed = !!lastData;
    } finally {
      inFlight = false;
      render();
    }
  }

  function paintHistory(out) {
    listEl.textContent = "";
    if (!out) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No history recorded for this service yet.";
      listEl.appendChild(li);
      return;
    }
    sinceEl.textContent = out.since;
    if (!out.items.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No incidents logged yet. That is good news.";
      listEl.appendChild(li);
      return;
    }
    for (const it of out.items) {
      const li = document.createElement("li");
      const what = document.createElement("strong");
      what.textContent = it.what;
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = it.when;
      const len = document.createElement("span");
      len.className = "len";
      len.textContent = it.length;
      li.append(what, when, len);
      for (const n of it.notes) {
        const p = document.createElement("span");
        p.className = "inote";
        p.textContent = n;
        li.appendChild(p);
      }
      listEl.appendChild(li);
    }
  }

  async function loadHistory() {
    try {
      const data = await getJson(HISTORY_URL);
      const entry = data && Array.isArray(data.services) ? data.services.find((s) => s && s.id === id) : null;
      paintHistory(historyItems(entry, service));
    } catch (err) {
      if (!listEl.querySelector("li:not(.empty)")) {
        listEl.textContent = "";
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "Couldn't load the history right now. It will retry.";
        listEl.appendChild(li);
      }
    }
  }

  function poll() {
    const decision = pollDecision({ hidden: document.hidden, idleMs: performance.now() - lastActivity });
    paused = decision === "pause-idle";
    if (decision === "poll") refresh();
    else render();
  }

  ["pointerdown", "keydown", "scroll", "touchstart", "mousemove"].forEach((ev) =>
    window.addEventListener(ev, () => {
      const wasPaused = paused;
      lastActivity = performance.now();
      if (wasPaused) { paused = false; refresh(); }
    }, { passive: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && performance.now() - lastFetch > 60 * 1000) { refresh(); loadHistory(); }
  });

  render();
  refresh();
  loadHistory();
  setInterval(poll, POLL_MS);
  setInterval(() => { if (!document.hidden) loadHistory(); }, HISTORY_EVERY_MS);
  setInterval(render, TICK_MS);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const go = () => {
    const id = document.body && document.body.dataset.service;
    if (id) startPage(id);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
}
