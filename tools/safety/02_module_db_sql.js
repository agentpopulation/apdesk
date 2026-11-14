// Probe: try to get around the module SQL guard (app/core/storage.js checkModuleSql).
// Each attempt prints BYPASS (the guard let it through AND it reached a core table) or HELD.
import { testDesk } from '../../test/helpers/desk.js';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const MDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evil-modules');
const t = await testDesk({ modulesDir: MDIR });
const lvl = () => t.core.approval.level;
const reset = () => t.core.settings.set('security.level', 'open');
try {
  t.core.model.addKey('openai', 'sk-REAL-PAID-KEY-123456', 'owner key');
  await t.core.modules.set('evil', true);
  const { sql } = t.core.modules.api('evil');
  sql('exec', 'CREATE TABLE IF NOT EXISTS m_evil_t (id INTEGER PRIMARY KEY, v TEXT)');
  sql('run', "INSERT INTO m_evil_t (v) VALUES ('x')");

  const readTries = {
    'plain FROM secrets': ['all', 'SELECT value FROM secrets'],
    'quoted "secrets"': ['all', 'SELECT value FROM "secrets"'],
    'schema main.secrets': ['all', 'SELECT value FROM main.secrets'],
    'comma join': ['all', 'SELECT s.value FROM m_evil_t, secrets s'],
    'comma join + 2nd stmt (skips EXPLAIN)': ['all', 'SELECT s.value FROM m_evil_t, secrets s; SELECT 1'],
    'CTE': ['all', 'WITH k AS (SELECT value FROM m_evil_t, secrets) SELECT * FROM k'],
    'sqlite_master sql text': ['all', "SELECT sql FROM sqlite_master WHERE name='secrets'"],
  };
  for (const [name, [m, q]] of Object.entries(readTries)) {
    const r = sql(m, q);
    const leaked = r.ok && JSON.stringify(r.r ?? '').includes('sk-REAL-PAID-KEY');
    console.log(leaked ? `BYPASS(read:${name}): key value returned` : `HELD(read:${name}): ${r.ok ? 'no key in result' : r.err.slice(0, 80)}`);
  }

  // copy secrets into a module table: CREATE ... AS SELECT is not EXPLAINed; comma join is not positional
  {
    const r = sql('exec', 'CREATE TABLE m_evil_loot AS SELECT s.value AS v FROM m_evil_t, secrets s');
    const got = r.ok ? sql('all', 'SELECT v FROM m_evil_loot') : null;
    const leaked = got?.ok && JSON.stringify(got.r).includes('sk-REAL-PAID-KEY');
    console.log(leaked ? `BYPASS(read:CREATE TABLE AS SELECT .. , secrets): provider key copied into m_evil_loot and read back` : `HELD(read:CREATE AS): ${r.ok ? 'no key' : r.err.slice(0, 80)}`);
  }
  // view created over a comma join, then read through the view in a 2-statement call
  {
    const r = sql('exec', 'CREATE VIEW m_evil_v AS SELECT s.value AS v FROM m_evil_t, secrets s');
    const got = r.ok ? sql('all', 'SELECT v FROM m_evil_v; SELECT 1') : null;
    const leaked = got?.ok && JSON.stringify(got.r).includes('sk-REAL-PAID-KEY');
    console.log(leaked ? `BYPASS(read:VIEW over comma join): key read through m_evil_v` : `HELD(read:view): ${r.ok ? (got?.ok ? 'no key' : got?.err?.slice(0, 80)) : r.err.slice(0, 80)}`);
  }

  const writeTries = {
    'UPDATE settings': ['run', `UPDATE settings SET value='"strict"' WHERE key='security.level'`],
    'UPDATE OR REPLACE settings (single stmt)': ['run', `UPDATE OR REPLACE settings SET value='"strict"' WHERE key='security.level'`],
    'UPDATE OR REPLACE settings (exec, 2 stmts)': ['exec', `SELECT 1; UPDATE OR REPLACE settings SET value='"strict"' WHERE key='security.level'`],
    'UPDATE OR IGNORE settings (exec, 2 stmts)': ['exec', `SELECT 1; UPDATE OR IGNORE settings SET value='"strict"' WHERE key='security.level'`],
  };
  for (const [name, [m, q]] of Object.entries(writeTries)) {
    reset(); const r = sql(m, q);
    console.log(lvl() === 'strict' ? `BYPASS(write:${name}): security.level is now '${lvl()}'` : `HELD(write:${name}): ${r.ok ? 'no change' : r.err.slice(0, 80)}`);
  }
  // trigger on the module's OWN table whose body writes a core table; fires later outside the guard
  {
    reset();
    const r = sql('exec', `CREATE TRIGGER m_evil_trg AFTER INSERT ON m_evil_t BEGIN UPDATE OR REPLACE settings SET value='"strict"' WHERE key='security.level'; END`);
    const r2 = r.ok ? sql('run', "INSERT INTO m_evil_t (v) VALUES ('fire')") : null;
    console.log(lvl() === 'strict' ? `BYPASS(write:TRIGGER on own table): a plain INSERT into m_evil_t rewrote security.level to '${lvl()}'` : `HELD(write:trigger): ${r.ok ? (r2?.ok ? 'no change' : r2?.err) : r.err.slice(0, 80)}`);
  }
  // auto-approve window and approvals via the same trick
  {
    const r = sql('exec', `SELECT 1; UPDATE OR REPLACE settings SET value='"2099-01-01T00:00:00.000Z"' WHERE key='security.level'`);
    t.core.settings.set('security.autoApproveUntil', null);
    const r2 = sql('exec', `SELECT 1; INSERT OR REPLACE INTO m_evil_t (v) VALUES ('a'); REPLACE  INTO m_evil_t (v) VALUES ('b')`);
    void r; void r2;
  }
  // temp table shadowing a core name
  {
    const r = sql('exec', 'CREATE TEMP TABLE settings (key TEXT, value TEXT)');
    console.log(r.ok ? `BYPASS?(temp shadow): CREATE TEMP TABLE settings accepted` : `HELD(temp shadow): ${r.err.slice(0, 80)}`);
  }
  // PRAGMA tricks
  for (const q of ['PRAGMA writable_schema=ON', 'PRAGMA main.writable_schema=ON', 'pragma/**/writable_schema=1']) {
    const r = sql('exec', q); console.log(r.ok ? `BYPASS(pragma): '${q}' accepted` : `HELD(pragma '${q}'): refused`);
  }
} finally { reset(); await t.close(); }
// (appended) trigger fired through a 2-statement exec, so EXPLAIN never sees the trigger program
{
  const t2 = await testDesk({ modulesDir: MDIR });
  try {
    await t2.core.modules.set('evil', true);
    const { sql } = t2.core.modules.api('evil');
    sql('exec', 'CREATE TABLE IF NOT EXISTS m_evil_t (id INTEGER PRIMARY KEY, v TEXT)');
    const c = sql('exec', `CREATE TRIGGER m_evil_trg AFTER INSERT ON m_evil_t BEGIN UPDATE OR REPLACE settings SET value='"2099-01-01T00:00:00.000Z"' WHERE key='security.autoApproveUntil'; END`);
    t2.core.settings.set('security.autoApproveUntil', '2000-01-01T00:00:00.000Z');
    const f = sql('exec', "SELECT 1; INSERT INTO m_evil_t (v) VALUES ('fire')");
    const auto = t2.core.approval.autoApproveUntil;
    console.log(auto ? `BYPASS(write:TRIGGER fired by 2-stmt exec): trigger created=${c.ok}; auto-approve window now open until ${auto}` : `HELD(trigger fire): created=${c.ok} fire=${f.ok ? 'ok' : f.err}`);
  } finally { await t2.close(); }
}
