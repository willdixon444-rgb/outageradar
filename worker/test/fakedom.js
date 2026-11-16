// A tiny fake browser for running the /admin dashboard script (adminApp) in
// Node: just enough DOM, localStorage, fetch and timers for behaviour tests.
// Nothing here ships to Cloudflare.

class FakeEl {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this.style = {};
    this.listeners = {};
    this.hidden = "hidden" in attrs;
    this.checked = "checked" in attrs;
    this.value = attrs.value || "";
    this.className = attrs.class || "";
    this.clientWidth = 640;
    this._text = "";
  }
  get id() { return this.attrs.id || ""; }
  get firstChild() { return this.children[0] || null; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this._text = String(v);
  }
  appendChild(c) {
    if (c.parent) c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, extra = {}) {
    const ev = { type, target: this, preventDefault() {}, ...extra };
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  focus() {}
  click() { this.dispatch("click"); }
  // Every descendant, depth first.
  all() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

// Builds a fake page from the dashboard HTML: one element per id="..." (with
// its type/checked/hidden attributes) plus the data-days range buttons.
export function fakeBrowser(html, { storage = {}, routes } = {}) {
  const byId = new Map();
  const tagRe = /<([a-z]+)\b([^>]*)>/g;
  let m;
  const ranges = [];
  while ((m = tagRe.exec(html))) {
    const attrs = {};
    const attrRe = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) attrs[a[1]] = a[2] === undefined ? "" : a[2];
    const el = new FakeEl(m[1], attrs);
    if (attrs.id) byId.set(attrs.id, el);
    if ("data-days" in attrs) ranges.push(el);
  }
  // The meter's inner bar.
  const meter = byId.get("meter");
  if (meter) meter.appendChild(new FakeEl("i"));

  const store = new Map(Object.entries(storage));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const docListeners = {};
  const document = {
    hidden: false,
    body: new FakeEl("body"),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (ns, tag) => new FakeEl(tag),
    querySelectorAll: (sel) => (sel === "[data-days]" ? ranges.slice() : []),
    addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
  };
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const auth = (opts.headers && opts.headers.authorization) || "";
    calls.push({ url, auth });
    const res = await routes(url, auth);
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: { get: () => null },
      json: async () => res.body,
      blob: async () => ({}),
    };
  };
  const timers = [];
  const window = {
    localStorage,
    addEventListener() {},
  };
  return {
    window, document, fetch, localStorage, store, calls, timers, byId, ranges,
    $: (id) => byId.get(id),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
  };
}

// Runs the served /admin/app.js source inside the fake browser.
export function runApp(source, b) {
  const fn = new Function("window", "document", "fetch", "setInterval", "clearInterval", "localStorage", source);
  fn(b.window, b.document, b.fetch, b.setInterval, b.clearInterval, b.localStorage);
}

// Lets pending promise chains (fetch -> json -> render) finish.
export async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}
