// A D1 stand-in backed by a real SQL engine (Node's built-in SQLite), so the
// alert tests run the same SQL that D1 (also SQLite) runs in production.
// Supports what checker.js uses: prepare().bind().run()/all()/first(), batch().
import { DatabaseSync } from "node:sqlite";

export function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  let calls = 0;
  const statement = (sql) => {
    let args = [];
    const st = {
      bind(...a) {
        args = a.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
        return st;
      },
      async run() {
        calls += 1;
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
      async all() {
        calls += 1;
        return { success: true, results: db.prepare(sql).all(...args).map((row) => ({ ...row })) };
      },
      async first(column) {
        calls += 1;
        const row = db.prepare(sql).get(...args);
        if (!row) return null;
        return column ? row[column] : { ...row };
      },
      _sync() { return db.prepare(sql).run(...args); },
    };
    return st;
  };
  return {
    raw: db,
    get calls() { return calls; },
    prepare: statement,
    async batch(list) {
      calls += 1;
      const out = [];
      db.exec("BEGIN");
      try {
        for (const st of list) {
          const r = st._sync();
          out.push({ success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } });
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return out;
    },
  };
}
