// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite
// (node:sqlite), so the tests run the real SQL. Nothing here ships.
// Only the D1 calls the checker uses: prepare().bind().run() / .all(), batch().
import { DatabaseSync } from "node:sqlite";

export function memoryD1() {
  const db = new DatabaseSync(":memory:");
  const log = [];
  function statement(sql, args = []) {
    return {
      sql,
      args,
      bind(...values) { return statement(sql, values); },
      async run() {
        log.push(sql);
        const info = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      async all() {
        log.push(sql);
        const rows = db.prepare(sql).all(...args).map((r) => ({ ...r }));
        return { success: true, results: rows, meta: {} };
      },
    };
  }
  return {
    log,
    raw: db,
    prepare(sql) { return statement(sql); },
    async batch(list) {
      const out = [];
      for (const s of list) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run());
      return out;
    },
    rows(table) {
      return db.prepare("SELECT * FROM " + table).all().map((r) => ({ ...r }));
    },
  };
}

// A D1 that throws on every call (binding present but broken).
export function brokenD1() {
  const fail = async () => { throw new Error("D1_ERROR: internal error"); };
  const stmt = { bind() { return stmt; }, run: fail, all: fail };
  return { prepare() { return stmt; }, batch: fail };
}
