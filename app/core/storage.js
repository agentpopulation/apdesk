// Contract 4: one SQLite file and one workspace folder. See contracts/STORAGE.md.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openStorage(dataDir, backupsDir, { memory = false } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (backupsDir) fs.mkdirSync(backupsDir, { recursive: true });
  for (const d of ['workspace', 'workspace/reports', 'workspace/tables', 'workspace/drafts', 'workspace/inbox', 'profiles', 'bin']) {
    fs.mkdirSync(path.join(dataDir, d), { recursive: true });
  }
  // Incognito (contracts/PEOPLE.md): the database is held in RAM only; the workspace, profiles and bin are a scratch
  // folder (dataDir) that the desk deletes on leaving. Nothing of it reaches apd.sqlite or any durable file.
  const file = memory ? ':memory:' : path.join(dataDir, 'apd.sqlite');
  const db = new DatabaseSync(file);
  if (!memory) db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (module TEXT NOT NULL, version INTEGER NOT NULL, applied TEXT NOT NULL, PRIMARY KEY (module, version));
    CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (ns, key));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT, label TEXT, value TEXT NOT NULL, created TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, meta TEXT);
    CREATE TABLE IF NOT EXISTS modules (id TEXT PRIMARY KEY, on_ INTEGER NOT NULL, changed TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, personality TEXT, instructions TEXT, model_main TEXT, model_fallback TEXT, tools TEXT, enabled INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, updated TEXT NOT NULL, meta TEXT);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, agent_id TEXT, chat_id TEXT, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, detail TEXT, input TEXT, output TEXT, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, finished TEXT);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, agent_id TEXT, chat_id TEXT, job_id TEXT, action TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, payload TEXT, amount INTEGER, currency TEXT, status TEXT NOT NULL, how TEXT, created TEXT NOT NULL, decided TEXT);
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agent_id TEXT, action TEXT NOT NULL, title TEXT, how TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, agent_id TEXT, purpose TEXT, provider TEXT, model TEXT, ok INTEGER, ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost_minor INTEGER, currency TEXT, error TEXT);
  `);
  return new Storage(db, dataDir, file, backupsDir || path.join(dataDir, 'backups'));
}

export class Storage {
  constructor(db, dataDir, file, backupsDir) {
    this.db = db; this.dataDir = dataDir; this.file = file; this.backupsDir = backupsDir;
    this.workspace = path.join(dataDir, 'workspace');
    this._stmts = new Map();
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  _s(sql) { let s = this._stmts.get(sql); if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); } return s; }
  run(sql, ...p) { return this._s(sql).run(...p); }
  get(sql, ...p) { return this._s(sql).get(...p); }
  all(sql, ...p) { return this._s(sql).all(...p); }
  transaction(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  migrate(module, version, sqlOrFn) {
    const done = this.get('SELECT 1 AS x FROM migrations WHERE module = ? AND version = ?', module, version);
    if (done) return false;
    this.transaction(() => {
      if (typeof sqlOrFn === 'function') sqlOrFn(this); else this.db.exec(sqlOrFn);
      this.run('INSERT INTO migrations (module, version, applied) VALUES (?, ?, ?)', module, version, new Date().toISOString());
    });
    return true;
  }
  kvGet(ns, key, fallback) {
    const r = this.get('SELECT value FROM kv WHERE ns = ? AND key = ?', ns, key);
    if (!r) return fallback;
    try { return JSON.parse(r.value); } catch { return fallback; }
  }
  kvSet(ns, key, value) { this.run('INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value', ns, key, JSON.stringify(value ?? null)); }
  kvDel(ns, key) { this.run('DELETE FROM kv WHERE ns = ? AND key = ?', ns, key); }
  kvAll(ns) { const out = {}; for (const r of this.all('SELECT key, value FROM kv WHERE ns = ?', ns)) { try { out[r.key] = JSON.parse(r.value); } catch {} } return out; }
  /**
   * A scoped door for one module: same file, migrations keyed by module id. Ordinary modules cannot name the core's
   * tables in SQL: secrets, settings, approvals, activity, kv, migrations and modules are refused outright, and agents,
   * jobs and calls are read-only. That keeps a module bug or an injected string away from keys, the security level
   * and the approval records. Only the modules the core names as privileged (Backup, Vault) get the plain door.
   */
  scope(moduleId, { privileged = false } = {}) {
    const s = this;
    const seen = new Set();   // statements already checked (the schema of core tables does not change under a running desk)
    const guard = privileged ? (sql) => sql : (sql) => { checkModuleSql(sql, moduleId, s.db, seen); return sql; };
    return {
      // a script runs one statement at a time, each checked just before it runs, so a later statement cannot hide behind an earlier one
      exec: privileged ? (sql) => s.exec(sql) : (sql) => { for (const stmt of splitSql(sql)) { checkModuleStatement(stmt, moduleId, s.db); s.db.exec(stmt); } },
      prepare: (sql) => s.prepare(guard(sql)),
      run: (sql, ...p) => s.run(guard(sql), ...p), get: (sql, ...p) => s.get(guard(sql), ...p), all: (sql, ...p) => s.all(guard(sql), ...p),
      transaction: (fn) => s.transaction(fn),
      migrate: (version, x) => { const door = this.scope(moduleId, { privileged }); return s.migrate(moduleId, version, typeof x === 'function' ? () => x(door) : () => door.exec(x)); },
    };
  }
  kvScope(ns) {
    const s = this;
    return { get: (k, f) => s.kvGet(ns, k, f), set: (k, v) => s.kvSet(ns, k, v), del: (k) => s.kvDel(ns, k), all: () => s.kvAll(ns) };
  }
  workspacePath(...parts) { return safeJoin(this.workspace, ...parts); }
  /** A consistent copy of the database for backups. */
  snapshotTo(file) { fs.rmSync(file, { force: true }); this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); return file; }
  close() { try { this.db.close(); } catch {} }
}

const SQL_FORBIDDEN = new Set(['secrets', 'settings', 'approvals', 'activity', 'kv', 'migrations', 'modules']);
const SQL_READ_ONLY = new Set(['agents', 'jobs', 'calls']);
/** Another module's tables (m_<id>_...): never written by a module that is not their own. Read only where a shipped module
 *  depends on it today, until the owner of the table offers the same through its exposed API. */
const OTHER_MODULE_READS = {};   // none: a module asks another for its data through ctx.modules.api(id)
const othersTable = (table, moduleId) => table.startsWith('m_') && !table.startsWith('m_' + String(moduleId).toLowerCase() + '_');
const stripSql = (sql) => String(sql).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/["`\[\]]/g, ' ').toLowerCase();
/** Split a script into its statements at top-level semicolons (quotes and comments respected). */
export function splitSql(sql) {
  const out = []; let cur = ''; let q = null; const s = String(sql);
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (q) { cur += c; if (c === q) { if (n === q && q !== ']') { cur += n; i++; } else q = null; } continue; }
    if (c === '-' && n === '-') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; cur += ' '; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; cur += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '[') { q = ']'; cur += c; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/**
 * Refuses one module SQL statement that touches a core table it may not touch. Two checks:
 *  1. by position: a core table named where a table goes (FROM secrets, UPDATE OR REPLACE settings, INSERT INTO approvals ...),
 *     plus ATTACH, VACUUM, unsafe PRAGMAs, and CREATE TRIGGER or CREATE VIEW (stored SQL the guard could not see run later).
 *     A column that merely shares a name (a module's own "settings" column) is fine.
 *  2. by asking SQLite: EXPLAIN lists the tables the statement really opens (through subqueries, comma joins,
 *     CREATE TABLE ... AS SELECT and existing views); those are matched against the core tables.
 * A script is split and each statement is checked on its own, just before it runs (see Storage.scope).
 */
export function checkModuleStatement(stmt, moduleId = 'module', db = null) {
  const bare = stripSql(stmt);
  const refuse = (why) => { throw Object.assign(new Error(`${moduleId}: this SQL is not allowed for a module (${why}). Use the ctx helpers for core data.`), { code: 'sql_forbidden' }); };
  if (/^\s*(attach|detach)\b/.test(bare)) refuse('attach');
  if (/^\s*vacuum\b/.test(bare)) refuse('vacuum');
  if (/^\s*pragma\b/.test(bare) && !/^\s*pragma\s+(table_info|table_xinfo|index_list|index_info|foreign_key_list|user_version|page_count|page_size|freelist_count)\b/.test(bare)) refuse('pragma');
  if (/^\s*create\s+(temp\s+|temporary\s+)?(trigger|view)\b/.test(bare)) refuse('triggers and views are not available to modules');
  const at = /\b(?:from|join|into|update(?:\s+or\s+[a-z]+)?|table|on|references)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:(?:main|temp)\s*\.\s*)?([a-z_][a-z0-9_]*)/g; let m;
  const reads = /^\s*(select|with|explain)\b/.test(bare);
  const otherTable = (name, writes) => {
    if (!othersTable(name, moduleId)) return;
    if (writes) refuse(`table ${name} belongs to another module`);
    if (!OTHER_MODULE_READS[moduleId]?.has(name)) refuse(`table ${name} belongs to another module`);
  };
  while ((m = at.exec(bare))) {
    if (SQL_FORBIDDEN.has(m[1])) refuse(`table ${m[1]}`);
    if (SQL_READ_ONLY.has(m[1]) && !reads) refuse(`table ${m[1]} is read-only`);
    otherTable(m[1], !reads);
  }
  if (db) {
    let ops = null; try { ops = db.prepare('EXPLAIN ' + stmt).all(); } catch { ops = null; }   // a syntax error surfaces on the real call
    if (ops) {
      const roots = new Map(); for (const r of db.prepare("SELECT tbl_name, rootpage FROM sqlite_master WHERE rootpage > 0").all()) roots.set(r.rootpage, String(r.tbl_name).toLowerCase());
      for (const op of ops) {
        const isOpen = op.opcode === 'OpenRead' || op.opcode === 'OpenWrite' || op.opcode === 'ReopenIdx';
        const root = isOpen && op.p3 === 0 ? op.p2 : (op.opcode === 'Clear' || op.opcode === 'Destroy') ? op.p1 : null;
        const name = root != null ? roots.get(root) : null; if (!name) continue;
        if (SQL_FORBIDDEN.has(name)) refuse(`table ${name}`);
        if (SQL_READ_ONLY.has(name) && op.opcode !== 'OpenRead' && op.opcode !== 'ReopenIdx') refuse(`table ${name} is read-only`);
        otherTable(name, op.opcode !== 'OpenRead' && op.opcode !== 'ReopenIdx');
      }
    }
  }
  return true;
}
/** One statement only (prepare, run, get, all). */
export function checkModuleSql(sql, moduleId = 'module', db = null, cache = null) {
  if (cache?.has(sql)) return true;
  const parts = splitSql(sql);
  if (parts.length > 1) throw Object.assign(new Error(`${moduleId}: one statement at a time here; use db.exec for a script.`), { code: 'sql_forbidden' });
  if (parts.length) checkModuleStatement(parts[0], moduleId, db);
  cache?.add(sql);
  return true;
}

export function safeJoin(root, ...parts) {
  const rel = path.normalize(path.join(...(parts.length ? parts.map(String) : ['.'])));
  if (path.isAbsolute(rel)) {
    const abs = path.resolve(rel);
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
    throw Object.assign(new Error('Path escapes the workspace'), { code: 'escape' });
  }
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw Object.assign(new Error('Path escapes the workspace'), { code: 'escape' });
  return abs;
}

export const now = () => new Date().toISOString();
export const id = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
