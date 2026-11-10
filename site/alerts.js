// OutageRadar alert pages (site v1.17.0, pilot). First-party only: it talks to
// data.liveoutageradar.com and nothing else, stores nothing in the browser.
// Confirm and unsubscribe send nothing until the button is pressed, so a
// link-preview bot that opens the link can't confirm or unsubscribe.

export const API = "https://data.liveoutageradar.com/alerts/";

export const MESSAGES = {
  check_channel: "Done. Check that channel: we posted one message with a confirm link. Nothing else is sent until someone confirms.",
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
    status.textContent = r && r.ok ? MESSAGES[r.status] || MESSAGES.check_channel : MESSAGES[r && r.error] || MESSAGES.default;
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
