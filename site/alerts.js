// OutageRadar alert pages (site v1.17.0 pilot; v1.18.0 public). First-party only: it talks to
// data.liveoutageradar.com and nothing else, stores nothing in the browser.
// Confirm and unsubscribe send nothing until the button is pressed, so a
// link-preview bot that opens the link can't confirm or unsubscribe.

export const API = "https://data.liveoutageradar.com/alerts/";

export const MESSAGES = {
  check_channel: "Done. Check that channel: we posted one message with a confirm link. Nothing else is sent until someone confirms.",
  updated: "Updated your choices. No new message was sent: this channel is already confirmed.",
  pending: "Updated your choices. A confirm message was already sent to that channel in the last 24 hours: use its link.",
  confirmed: "Confirmed. Alerts will now arrive in that channel. Every alert has an unsubscribe link.",
  unsubscribed: "Unsubscribed. No more alerts will be sent to that channel.",
  webhook_invalid: "That doesn't look like a Discord or Slack webhook address. Copy the full address from the webhook settings.",
  services_invalid: "Pick at least one service.",
  webhook_rejected: "That webhook didn't accept our message. Check that it still exists and try again.",
  busy: "Lots of sign-ups right now. Please try again in an hour.",
  try_later: "Discord or Slack didn't answer. Please try again in a few minutes.",
  alerts_unavailable: "Alerts are not available right now.",
  link_invalid: "This link is incomplete or broken. Use the full link from the message in your channel.",
  link_expired: "This link has expired. Sign up again to get a new one.",
  network: "Couldn't reach OutageRadar. Check your connection and try again.",
  default: "Something went wrong. Please try again in a few minutes.",
};

const TOKEN = /^[a-f0-9]{32}\.[A-Za-z0-9_-]{20,}$/;

// v1.18.0: the right message for each answer from the server.
export function statusMessage(r) {
  if (r && r.ok) return Object.prototype.hasOwnProperty.call(MESSAGES, r.status) ? MESSAGES[r.status] : MESSAGES.check_channel;
  const key = r && r.error;
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, key) ? MESSAGES[key] : MESSAGES.default;
}

// v1.18.0: history pages link here with ?service=<id>; only real ids count.
export function preselect(search, ids) {
  let params;
  try { params = new URLSearchParams(search || ""); } catch (err) { return []; }
  return params.getAll("service").filter((id, i, all) => ids.includes(id) && all.indexOf(id) === i);
}

export function allState(boxes) {
  const on = boxes.filter((b) => b.checked).length;
  return on === 0 ? false : on === boxes.length ? true : "mixed";
}

export function setAll(boxes, checked) {
  for (const b of boxes) b.checked = checked;
}

export function subscribePayload(values) {
  return {
    webhook: String(values.webhook || "").trim(),
    services: Array.isArray(values.services) ? values.services : [],
    minor: values.minor === true,
    company_name: String(values.company_name || ""),
  };
}

export async function send(fetchFn, action, body) {
  try {
    const res = await fetchFn(API + action, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
    });
    try { return await res.json(); } catch (err) { return { error: "default" }; }
  } catch (err) {
    return { error: "network" };
  }
}

export function bindTokenPage({ button, status, hash, fetchFn, action }) {
  const token = String(hash || "").replace(/^#/, "");
  if (!TOKEN.test(token)) {
    button.hidden = true;
    status.textContent = MESSAGES.link_invalid;
    return;
  }
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Working...";
    const r = await send(fetchFn, action, { token });
    if (r && r.ok) {
      button.hidden = true;
      status.textContent = action === "confirm" ? MESSAGES.confirmed : MESSAGES.unsubscribed;
    } else {
      button.disabled = false;
      status.textContent = MESSAGES[r && r.error] || MESSAGES.default;
    }
  });
}

function bindSubscribe(form, status, fetchFn) {
  const boxes = [...form.querySelectorAll('input[name="service"]')];
  const all = document.getElementById("all");
  const syncAll = () => {
    const state = allState(boxes);
    all.checked = state === true;
    all.indeterminate = state === "mixed";
  };
  const picked = preselect(location.search, boxes.map((b) => b.value));
  for (const b of boxes) if (picked.includes(b.value)) b.checked = true;
  all.addEventListener("change", () => { setAll(boxes, all.checked); syncAll(); });
  for (const b of boxes) b.addEventListener("change", syncAll);
  syncAll();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {
      webhook: form.elements.webhook.value,
      services: [...form.querySelectorAll('input[name="service"]:checked')].map((i) => i.value),
      minor: form.elements.minor.checked,
      company_name: form.elements.company_name.value,
    };
    if (!values.services.length) { status.textContent = MESSAGES.services_invalid; return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = "Sending...";
    const r = await send(fetchFn, "subscribe", subscribePayload(values));
    button.disabled = false;
    status.textContent = statusMessage(r);
  });
}

if (typeof document !== "undefined" && document.body) {
  const page = document.body.dataset.alerts;
  const status = document.getElementById("status");
  if (page === "subscribe") {
    bindSubscribe(document.getElementById("signup"), status, fetch.bind(globalThis));
  } else if (page === "confirm" || page === "unsubscribe") {
    bindTokenPage({ button: document.getElementById("go"), status, hash: location.hash, fetchFn: fetch.bind(globalThis), action: page });
  }
}
