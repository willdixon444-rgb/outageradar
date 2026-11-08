// The board's "Last incident" line (v1.6). Nothing here ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeIncidents, buildView, SHELL } from "../site/board.js";

const NOW = Date.parse("2026-11-11T14:00:00Z"); // 72 h after the incident ended
const ended = (over = {}) => ({
  since_utc: "2026-11-08T12:00:00Z",
  last: { started_utc: "2026-11-08T13:00:00Z", ended_utc: "2026-11-08T13:42:00Z", worst: "major_outage",
    kind: "official", minutes: 42, ...over },
});

test("no incident yet says when the log started, never 'no incidents ever'", () => {
  assert.equal(describeIncidents({ since_utc: "2026-11-08T12:00:00Z", last: null }, NOW), "No incidents logged since Nov 8");
});

test("a finished incident says how long ago, how bad and how long", () => {
  assert.equal(describeIncidents(ended(), NOW), "Last incident 3 days ago: major outage, 42 min");
});

test("recent incidents use minutes or hours", () => {
  const t = Date.parse("2026-11-08T13:42:00Z");
  assert.match(describeIncidents(ended(), t + 25 * 60000), /25 min ago/);
  assert.match(describeIncidents(ended(), t + 5 * 3600000), /5 h ago/);
  assert.match(describeIncidents(ended(), t + 10 * 1000), /just now/);
});

test("long incidents show hours and minutes", () => {
  assert.match(describeIncidents(ended({ minutes: 135 }), NOW), /, 2 h 15 min$/);
  assert.match(describeIncidents(ended({ minutes: 120 }), NOW), /, 2 h$/);
});

test("an incident only our check saw says so", () => {
  const d = describeIncidents(ended({ worst: "signals_disagree", kind: "our_check", minutes: 10 }), NOW);
  assert.equal(d, "Last incident 3 days ago: our check failed (not confirmed by the provider), 10 min");
});

test("an ongoing incident says since when, in UTC", () => {
  const d = describeIncidents(ended({ ended_utc: null, minutes: 0 }), Date.parse("2026-11-08T13:30:00Z"));
  assert.equal(d, "Current incident since 13:00 UTC (30 min so far)");
});

test("without a server time the line falls back to the date, not the visitor's clock", () => {
  assert.equal(describeIncidents(ended(), NaN), "Last incident Nov 8: major outage, 42 min");
});

test("missing or damaged incident data shows nothing instead of breaking", () => {
  for (const bad of [null, undefined, "x", {}, { since_utc: "nope", last: null }, { since_utc: "2026-11-08T12:00:00Z", last: { worst: 5 } }]) {
    assert.equal(describeIncidents(bad, NOW), "", JSON.stringify(bad));
  }
});

test("the view carries the line, timed by the server clock plus time since the data arrived", () => {
  const services = SHELL.map((s) => ({
    id: s.id, name: s.name, status_page: s.status_page, overall: "operational",
    official: { label: "Official status", status: "operational", checked_at_utc: "2026-11-11T11:59:00Z", note: "" },
    probe: { label: "API server answering (our check)", status: "reachable", checked_at_utc: "2026-11-11T11:59:00Z", http_status: 401, note: "" },
    incidents: ended({ ended_utc: "2026-11-11T10:00:00Z" }),
  }));
  const data = { schema: 1, generated_at_utc: "2026-11-11T11:59:30Z", served_at_utc: "2026-11-11T12:00:00Z",
    age_seconds: 30, stale: false, services };
  const view = buildView(data, { elapsedSec: 10 * 60 }); // still fresh: 30 s + 10 min
  assert.match(view.services.find((s) => s.id === "claude").history, /^Last incident 2 h ago/);
});

test("stale or missing data shows no incident line", () => {
  const view = buildView(null, { state: "loading" });
  assert.ok(view.services.every((s) => s.history === ""));
});
