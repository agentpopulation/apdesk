// For tests and the measure only: a storage door and settings over a throwaway in-memory SQLite, shaped like ctx.db and ctx.kv.
import { DatabaseSync } from 'node:sqlite';
export function memoryDoor() {
  const d = new DatabaseSync(':memory:'); const done = new Set();
  const db = {
    exec: (s) => d.exec(s), prepare: (s) => d.prepare(s),
    run: (s, ...p) => d.prepare(s).run(...p), get: (s, ...p) => d.prepare(s).get(...p), all: (s, ...p) => d.prepare(s).all(...p),
    transaction: (fn) => { d.exec('BEGIN'); try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; } },
    migrate: (v, x) => { if (done.has(v)) return; done.add(v); typeof x === 'function' ? x(db) : d.exec(x); },
  };
  const store = new Map();
  const kv = { get: (k, f) => (store.has(k) ? structuredClone(store.get(k)) : f), set: (k, v) => store.set(k, structuredClone(v)), del: (k) => store.delete(k) };
  return { db, kv, close: () => d.close() };
}
