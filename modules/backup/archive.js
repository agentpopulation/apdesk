// Backup and restore of one SQLite file and one workspace folder (contracts/STORAGE.md).
// Secrets are left out unless asked, each restore is staged in a temp folder, and archives that are not ours are refused.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';

export const APP_ID = 'agent-population-desk';
export const FORMAT = 1;
export const NAME_RE = /^apd-[A-Za-z0-9-]+\.zip$/;
const KEEP_SETTINGS = ["security.%", "spend.%", "openrouter.allowPaid"];      // only the shell's guarded routes change these; a restore never does
const MAX_WORKSPACE_BYTES = 1.5 * 1024 ** 3;            // adm-zip builds the zip in memory

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const qs = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** apd-2026-11-13-180601.zip in the owner's time zone. */
export function backupName(date = new Date(), timeZone = 'UTC', suffix = '') {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date); }
  catch { parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date); }
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `apd-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}${suffix}.zip`;
}

export function walk(root) {
  const out = [];
  const go = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      const abs = path.join(dir, e.name); const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) go(abs, r);
      else if (e.isFile()) out.push({ abs, rel: r, size: fs.statSync(abs).size });
    }
  };
  go(root, '');
  return out;
}

/** Keys kept outside the secrets table, in plain settings: the router's key, and a key per LAN model node. A backup
 *  without keys leaves them out too (the VACUUM after this leaves no old page behind). */
const SETTING_SECRETS = ['router.apiKey'];
function dropSettingSecrets(copy) {
  for (const k of SETTING_SECRETS) copy.prepare('DELETE FROM settings WHERE key = ?').run(k);
  const row = copy.prepare("SELECT value FROM settings WHERE key = 'network.lanNodes'").get();
  let nodes = null; try { nodes = row ? JSON.parse(row.value) : null; } catch { nodes = null; }
  if (Array.isArray(nodes)) copy.prepare("UPDATE settings SET value = ? WHERE key = 'network.lanNodes'").run(JSON.stringify(nodes.map(n => (n && typeof n === 'object' ? Object.fromEntries(Object.entries(n).filter(([f]) => f !== 'apiKey')) : n))));
}

/** The keys this desk holds in plain settings now, to put back after a restore from a backup without keys: the router's
 *  key, and each LAN node's key by the node's id. */
function liveSettingSecrets(db) {
  const get = (k) => { const r = db.prepare('SELECT value FROM main.settings WHERE key = ?').get(k); return r ? r.value : undefined; };
  const plain = Object.fromEntries(SETTING_SECRETS.map(k => [k, get(k)]).filter(([, v]) => v !== undefined));
  let nodes = []; try { nodes = JSON.parse(get('network.lanNodes') ?? '[]'); } catch {}
  const nodeKeys = new Map((Array.isArray(nodes) ? nodes : []).filter(n => n && n.id != null && n.apiKey).map(n => [String(n.id), n.apiKey]));
  return { plain, nodeKeys };
}
function putBackSettingSecrets(db, { plain, nodeKeys }) {
  for (const [k, v] of Object.entries(plain)) db.prepare('INSERT OR REPLACE INTO main.settings (key, value) VALUES (?, ?)').run(k, v);
  if (!nodeKeys.size) return;
  const row = db.prepare("SELECT value FROM main.settings WHERE key = 'network.lanNodes'").get();
  let nodes = null; try { nodes = row ? JSON.parse(row.value) : null; } catch { nodes = null; }
  if (!Array.isArray(nodes)) return;
  const back = nodes.map(n => (n && typeof n === 'object' && !n.apiKey && nodeKeys.has(String(n.id)) ? { ...n, apiKey: nodeKeys.get(String(n.id)) } : n));
  db.prepare("UPDATE main.settings SET value = ? WHERE key = 'network.lanNodes'").run(JSON.stringify(back));
}

function tableCounts(db, schema = 'main') {
  const out = {};
  for (const { name } of db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()) {
    out[name] = db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.${qi(name)}`).get().n;
  }
  return out;
}

/**
 * Write one zip: apd.sqlite (VACUUM INTO copy, secrets removed unless includeKeys), workspace/, apd-backup.json.
 * `db` is the storage door (ctx.db). Never the browser profiles or the bin.
 */
export function createBackup({ db, workspace, backupsDir, includeKeys = false, version = '0.0.0', timeZone = 'UTC', suffix = '' }) {
  fs.mkdirSync(backupsDir, { recursive: true });
  const files = walk(workspace);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > MAX_WORKSPACE_BYTES) throw Object.assign(new Error('The workspace is larger than 1.5 GB. Move big files out of it before backing up.'), { status: 413 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-backup-'));
  try {
    const dbFile = path.join(tmp, 'apd.sqlite');
    db.exec(`VACUUM INTO ${qs(dbFile)}`);
    const copy = new DatabaseSync(dbFile);
    let tables;
    try {
      if (!includeKeys) { copy.exec('DELETE FROM secrets'); dropSettingSecrets(copy); copy.exec('VACUUM'); }
      tables = tableCounts(copy);
    } finally { copy.close(); }
    const created = new Date();
    const manifest = { app: APP_ID, format: FORMAT, version, created: created.toISOString(), includeKeys: !!includeKeys, tables, files: files.length, bytes };
    const zip = new AdmZip();
    zip.addLocalFile(dbFile, '', 'apd.sqlite');
    for (const f of files) zip.addLocalFile(f.abs, 'workspace/' + path.posix.dirname(f.rel).replace(/^\.$/, ''), path.posix.basename(f.rel));
    zip.addFile('apd-backup.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    let name = backupName(created, timeZone, suffix);
    for (let i = 2; fs.existsSync(path.join(backupsDir, name)); i++) name = backupName(created, timeZone, suffix + '-' + i);
    const out = path.join(backupsDir, name);
    zip.writeZip(out + '.part');
    fs.renameSync(out + '.part', out);
    return { name, path: out, size: fs.statSync(out).size, created: manifest.created, includeKeys: !!includeKeys, tables, files: files.length };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function listBackups(backupsDir) {
  let names = [];
  try { names = fs.readdirSync(backupsDir); } catch { return []; }
  return names.filter(n => NAME_RE.test(n)).map(n => { const st = fs.statSync(path.join(backupsDir, n)); return { name: n, size: st.size, at: st.mtime.toISOString() }; })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** A zip entry name we accept: no absolute paths, drive letters or '..' (zip slip), only our three kinds of entry. */
export function entryOk(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes('\0')) return false;
  if (n.split('/').some(p => p === '..')) return false;
  return n === 'apd.sqlite' || n === 'apd-backup.json' || n === 'workspace/' || n.startsWith('workspace/');
}

const refuse = (msg) => Object.assign(new Error(msg), { status: 400, code: 'bad_backup' });

/** Open and check a zip; extract it into a temp folder. Caller removes `dir`. */
export function openBackup(zipFile) {
  let zip;
  try { zip = new AdmZip(zipFile); } catch { throw refuse('This file is not a zip.'); }
  const entries = zip.getEntries();
  for (const e of entries) if (!entryOk(e.entryName)) throw refuse(`This zip is not a desk backup, or it tries to write outside its folder (${String(e.entryName).slice(0, 80)}).`);
  const man = entries.find(e => e.entryName === 'apd-backup.json');
  const dbe = entries.find(e => e.entryName === 'apd.sqlite');
  if (!man || !dbe) throw refuse('This zip is not a desk backup: it has no database or no backup label.');
  let manifest; try { manifest = JSON.parse(man.getData().toString('utf8')); } catch { throw refuse('The backup label in this zip cannot be read.'); }
  if (manifest?.app !== APP_ID) throw refuse('This zip was not made by AP Desk.');
  if (Number(manifest.format) > FORMAT) throw refuse('This backup was made by a newer version of the desk. Update the desk first.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-restore-'));
  try {
    for (const e of entries) {
      if (e.isDirectory) continue;
      const target = path.resolve(dir, e.entryName.replace(/\\/g, '/'));
      if (!target.startsWith(dir + path.sep)) throw refuse('This zip tries to write outside its folder.');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.getData());
    }
    const dbFile = path.join(dir, 'apd.sqlite');
    let tables;
    try {
      const c = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const ok = c.prepare('PRAGMA integrity_check').get();
        if (Object.values(ok || {})[0] !== 'ok') throw new Error('integrity');
        tables = tableCounts(c);
      } finally { c.close(); }
    } catch { throw refuse('The database in this backup does not open. The file may be damaged.'); }
    if (!('settings' in tables) || !('migrations' in tables)) throw refuse('The database in this backup is not a desk database.');
    return { dir, dbFile, workspaceDir: path.join(dir, 'workspace'), manifest, tables };
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}

/** What a restore would change, without changing anything. */
export function planRestore({ db, opened, workspace }) {
  const live = tableCounts(db);
  const tables = Object.keys(opened.tables).map(name => ({ name, backup: opened.tables[name], now: live[name] ?? null }));
  const inBackup = walk(opened.workspaceDir); const liveFiles = walk(workspace);
  const backupSet = new Set(inBackup.map(f => f.rel));
  const liveSet = new Set(liveFiles.map(f => f.rel));
  return {
    created: opened.manifest.created, version: opened.manifest.version, includeKeys: !!opened.manifest.includeKeys && (opened.tables.secrets || 0) > 0,
    tables, files: { inBackup: inBackup.length, replace: inBackup.filter(f => liveSet.has(f.rel)).length, extra: liveFiles.filter(f => !backupSet.has(f.rel)).map(f => f.rel) },
  };
}

// ---- what a backup from elsewhere may not bring in (safety review R2-5)
const SAFE_SETTINGS = new Set(['theme', 'role', 'onboarded', 'ownerName', 'country', 'currency', 'timeZone', 'locale', 'city']);
const safeSettingSql = `(key IN (${[...SAFE_SETTINGS].map(qs).join(', ')}) OR key LIKE 'ui.%')`;
const isConnection = (k) => /^(router\.|ollama\.|provider\.)/.test(k) || ['network.lanNodes', 'model.defaultChain', 'online'].includes(k);
/** Module tables that let something reach a person or the outside (accounts, allow-lists, servers, grants, logins). */
export const SENSITIVE_TABLE = /^m_[a-z0-9]+_(accounts|allowed|allow|allowlist|servers|grants|tokens|logins|keys|credentials|senders)$/;
const SENSITIVE_TABLE_WORDS = { m_mail_accounts: 'Mail accounts', m_mail_allowed: 'Mail allowed senders', m_connect_servers: 'Connected tool servers (MCP)' };
/** Module settings (kv) a backup from elsewhere may bring in: content, not connections or permissions. */
const KV_SAFE = { 'm:sales': null, 'm:life': ['place'], 'm:memory': ['lastDream'] };
const kvSafeSql = '(' + Object.entries(KV_SAFE).map(([ns, keys]) => keys ? `(ns = ${qs(ns)} AND key IN (${keys.map(qs).join(', ')}))` : `ns = ${qs(ns)}`).join(' OR ') + ')';
const SENSITIVE_KV = {
  'm:channels|telegram.allowed': 'Telegram chats allowed to talk to the desk', 'm:channels|telegram.deskChat': 'The Telegram chat the desk answers in', 'm:channels|telegram.apiBase': 'The Telegram server address',
  'm:channels|telegram.enabled': 'Telegram switched on', 'm:channels|telegram.agentId': 'The agent that answers on Telegram', 'm:channels|ntfy.server': 'The phone notification server', 'm:channels|ntfy.topic': 'The phone notification topic',
  'm:files|grants': 'Folders outside the workspace the Files module may open', 'm:browser|allowHosts': 'Sites the agents\' browser may open', 'm:search|searxngUrl': 'The search server address',
  'm:vault|logins': 'Saved site logins', 'm:vault|master': 'The vault passphrase', 'm:agents|customSkills': 'Agents\' custom skills', 'm:chat|jsonProviders': 'How chat talks to model providers', 'm:chat|handoff': 'Chat hand-off settings',
};
const AGENT_FIELDS = ['instructions', 'personality', 'model_main', 'model_fallback', 'tools'];

/** The ledger of backups this desk made, kept in the backups folder so it survives deleting the data folder. */
export const LEDGER = 'made-here.json';
export function sha256File(file) {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function readLedger(backupsDir) { try { const l = JSON.parse(fs.readFileSync(path.join(backupsDir, LEDGER), 'utf8')); return Array.isArray(l.items) ? l : { version: 1, items: [] }; } catch { return { version: 1, items: [] }; } }
export function recordMadeHere(backupsDir, file) {
  const l = readLedger(backupsDir);
  l.items.push({ name: path.basename(file), sha256: sha256File(file), at: new Date().toISOString() });
  const f = path.join(backupsDir, LEDGER); fs.writeFileSync(f + '.part', JSON.stringify(l, null, 1)); fs.renameSync(f + '.part', f);
}
export function madeHere(backupsDir, file) { const h = sha256File(file); return readLedger(backupsDir).items.some(x => x.sha256 === h); }

function withBackup(db, file, fn) { db.exec(`ATTACH DATABASE ${qs(file)} AS bk`); try { return fn(); } finally { db.exec('DETACH DATABASE bk'); } }
const hasTable = (db, schema, t) => !!db.prepare(`SELECT 1 AS x FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`).get(t);
const parse = (v) => { try { return JSON.parse(v); } catch { return v; } };
const show = (v) => { const x = parse(v); if (x == null || x === '') return 'nothing'; if (Array.isArray(x)) return x.length ? x.map(y => typeof y === 'object' ? (y.baseUrl || y.name || y.id || 'an entry') : String(y)).join(', ') : 'none'; return typeof x === 'object' ? 'set' : String(x); };

/**
 * What a restore of this backup would change that matters for safety: model connections, folder grants, allow-lists and
 * accounts, agents' instructions and model picks, schedules, module switches, keys. Plain lines for the preview.
 */
export function reviewRestore(db, backupDbFile) {
  return withBackup(db, backupDbFile, () => {
    const lines = []; const add = (what, detail) => lines.push({ what, detail });
    const setting = (schema, k) => db.prepare(`SELECT value FROM ${schema}.settings WHERE key = ?`).get(k)?.value ?? null;
    const keys = new Set([...db.prepare('SELECT key FROM main.settings').all(), ...db.prepare('SELECT key FROM bk.settings').all()].map(r => r.key));
    for (const k of [...keys].sort()) {
      if (!(isConnection(k) || k === 'files.allowedFolders')) continue;
      const a = setting('main', k), b = setting('bk', k);
      if (b == null || a === b) continue;
      if (/key|token|secret/i.test(k)) add(k === 'router.apiKey' ? 'The router key' : k, 'differs');
      else add(k === 'files.allowedFolders' ? 'Folders outside the workspace agents may open' : /^router\.baseUrl$/.test(k) ? 'The model router address' : k === 'ollama.baseUrl' ? 'The Ollama address' : k === 'network.lanNodes' ? 'Other PCs that run models' : k === 'model.defaultChain' ? 'The order models are tried in' : k, `now ${show(a)}; in the backup ${show(b)}`);
    }
    if (hasTable(db, 'bk', 'kv')) for (const [id, label] of Object.entries(SENSITIVE_KV)) {
      const [ns, key] = id.split('|');
      const a = db.prepare('SELECT value FROM main.kv WHERE ns = ? AND key = ?').get(ns, key)?.value ?? null;
      const b = db.prepare('SELECT value FROM bk.kv WHERE ns = ? AND key = ?').get(ns, key)?.value ?? null;
      if (b != null && a !== b) add(label, key === 'master' || ns === 'm:vault' ? 'differs' : `now ${show(a)}; in the backup ${show(b)}`);
    }
    for (const { name } of db.prepare("SELECT name FROM bk.sqlite_master WHERE type = 'table'").all()) {
      if (!SENSITIVE_TABLE.test(name)) continue;
      const n = db.prepare(`SELECT COUNT(*) AS n FROM bk.${qi(name)}`).get().n;
      const m = hasTable(db, 'main', name) ? db.prepare(`SELECT COUNT(*) AS n FROM main.${qi(name)}`).get().n : 0;
      if (n || m) add(SENSITIVE_TABLE_WORDS[name] || name.replace(/^m_/, '').replace(/_/g, ' '), `${m} here now, ${n} in the backup`);
    }
    if (hasTable(db, 'bk', 'agents')) {
      const live = new Map(db.prepare('SELECT * FROM main.agents').all().map(r => [r.id, r]));
      for (const b of db.prepare('SELECT * FROM bk.agents').all()) {
        const a = live.get(b.id);
        if (!a) add(`A new agent: ${b.name}`, 'only in the backup');
        else { const diff = AGENT_FIELDS.filter(f => (a[f] ?? '') !== (b[f] ?? '')); if (diff.length) add(`Agent ${a.name}${a.name !== b.name ? ' (' + b.name + ' in the backup)' : ''}`, `${diff.map(f => ({ instructions: 'instructions', personality: 'tone', model_main: 'main model', model_fallback: 'fallback model', tools: 'tools' })[f]).join(', ')} differ`); }
      }
    }
    if (hasTable(db, 'bk', 'm_flows_schedules')) { const n = db.prepare('SELECT COUNT(*) AS n FROM bk.m_flows_schedules WHERE enabled = 1').get().n; if (n) add('Schedules that run by themselves', `${n} switched on in the backup`); }
    if (hasTable(db, 'bk', 'modules')) {
      const live = new Map(db.prepare('SELECT id, on_ FROM main.modules').all().map(r => [r.id, r.on_]));
      const diff = db.prepare('SELECT id, on_ FROM bk.modules').all().filter(r => live.has(r.id) ? live.get(r.id) !== r.on_ : r.on_ === 1);
      if (diff.length) add('Module switches', diff.map(r => `${r.id} ${r.on_ ? 'on' : 'off'}`).join(', '));
    }
    const sec = hasTable(db, 'bk', 'secrets') ? db.prepare('SELECT COUNT(*) AS n FROM bk.secrets').get().n : 0;
    if (sec) add('Keys and logins', `${sec} in the backup`);
    return lines;
  });
}

/**
 * Restore into the open database without swapping the file: ATTACH the backup and, in one transaction, replace the rows of
 * every table both know. Tables only the backup knows are created from its schema. Migration rows are merged (never
 * removed). Security, spend and paid-model settings always stay as they are.
 * trusted = false (a backup from elsewhere): content comes back, but connections, folder grants, allow-lists and accounts,
 * module settings and switches, keys, and agents' instructions and model picks stay as they are here; schedules arrive paused.
 */
export function restoreDatabase(db, backupDbFile, { trusted = true, withKeys = null } = {}) {
  const report = { tables: {}, created: [], keptSecrets: false, heldBack: [], skipped: [] };
  const held = (x) => { if (!report.heldBack.includes(x)) report.heldBack.push(x); };
  withBackup(db, backupDbFile, () => {
    const names = (schema) => db.prepare(`SELECT name, sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all();
    const cols = (schema, t) => db.prepare(`PRAGMA ${schema}.table_info(${qi(t)})`).all().map(c => c.name);
    const isVirtual = (t) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql || '');
    // full-text (FTS) tables keep their index in shadow tables: never copy those; copy the text and let SQLite index it
    const shadowOf = (all) => { const out = new Set(); for (const v of all.filter(isVirtual)) for (const sfx of ['_config', '_content', '_data', '_docsize', '_idx', '_segments', '_segdir', '_stat']) out.add(v.name + sfx); return out; };
    const step = (table, rule, fn) => {
      try { return fn(); }
      catch (e) { throw Object.assign(new Error(`The restore stopped at the table ${table} (${rule}): ${e.message}. Nothing was changed.`), { status: 500, code: 'restore_failed', table, rule }); }
    };
    db.transaction(() => {
      db.exec('PRAGMA defer_foreign_keys = ON');        // foreign keys are checked once, at commit
      const liveAll = names('main'); const bkAll = names('bk');
      const shadow = shadowOf([...liveAll, ...bkAll]);
      const live = new Set(liveAll.map(t => t.name));
      const plain = bkAll.filter(t => !isVirtual(t) && !shadow.has(t.name));
      const virtual = bkAll.filter(isVirtual);
      for (const t of [...plain, ...virtual]) if (!live.has(t.name) && t.sql) step(t.name, 'create the table from the backup', () => {
        db.exec(t.sql);
        if (!isVirtual(t)) for (const ix of db.prepare("SELECT sql FROM bk.sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t.name)) db.exec(ix.sql);
        report.created.push(t.name);
      });
      const keep = KEEP_SETTINGS.map(p => `key NOT LIKE ${qs(p)}`).join(' AND ');
      // a backup made without keys leaves the keys on this desk as they are: the secrets table and the keys in settings
      const keysIn = withKeys ?? (bkAll.some(t => t.name === 'secrets') && db.prepare('SELECT COUNT(*) AS n FROM bk.secrets').get().n > 0);
      for (const t of plain) {
        const liveCols = new Set(cols('main', t.name));
        const common = cols('bk', t.name).filter(c => liveCols.has(c));
        if (!common.length) continue;
        const list = common.map(qi).join(', ');
        const T = qi(t.name);
        if (t.name === 'migrations') {
          step(t.name, 'merge database versions', () => db.exec(`INSERT OR IGNORE INTO main.migrations (${list}) SELECT ${list} FROM bk.migrations`));
        } else if (t.name === 'secrets' && (!trusted || !keysIn || db.prepare('SELECT COUNT(*) AS n FROM bk.secrets').get().n === 0)) {
          report.keptSecrets = true; if (!trusted) held('keys and logins'); continue;
        } else if (t.name === 'settings') {
          if (trusted) step(t.name, 'replace settings except security and spend', () => {
            const here = keysIn ? null : liveSettingSecrets(db);
            db.exec(`DELETE FROM main.settings WHERE ${keep}`);
            db.exec(`INSERT OR REPLACE INTO main.settings (${list}) SELECT ${list} FROM bk.settings WHERE ${keep}`);
            if (here) { putBackSettingSecrets(db, here); report.keptSecrets = true; }
          });
          else {
            step(t.name, 'bring in plain preferences only', () => db.exec(`INSERT OR REPLACE INTO main.settings (${list}) SELECT ${list} FROM bk.settings WHERE ${safeSettingSql} AND ${keep}`));
            held('model connections (router, Ollama, other PCs, model order)'); held('folders outside the workspace agents may open');
          }
        } else if (!trusted && t.name === 'modules') { held('which modules are on'); continue; }
        else if (!trusted && t.name === 'kv') {
          step(t.name, 'bring in safe module settings only', () => db.exec(`INSERT OR REPLACE INTO main.kv (${list}) SELECT ${list} FROM bk.kv WHERE ${kvSafeSql}`));
          held('module settings: Telegram and other allow-lists, folder grants, sites, servers, logins, skills');
        } else if (!trusted && SENSITIVE_TABLE.test(t.name)) { held((SENSITIVE_TABLE_WORDS[t.name] || t.name.replace(/^m_/, '').replace(/_/g, ' ')).toLowerCase()); continue; }
        else if (!trusted && t.name === 'agents') {
          // live agents stay exactly as they are; agents only in the backup come in without instructions, tone, models or tools
          const sel = common.map(c => ['instructions', 'personality'].includes(c) ? "''" : ['model_main', 'model_fallback'].includes(c) ? 'NULL' : c === 'tools' ? "'[]'" : c === 'meta' ? "'{}'" : qi(c)).join(', ');
          step(t.name, 'add agents only the backup has', () => db.exec(`INSERT INTO main.agents (${list}) SELECT ${sel} FROM bk.agents WHERE id NOT IN (SELECT id FROM main.agents)`));
          held('agents\' instructions, tone, models and tools');
        } else {
          step(t.name, 'replace the rows', () => {
            db.exec(`DELETE FROM main.${T}`);
            db.exec(`INSERT INTO main.${T} (${list}) SELECT ${list} FROM bk.${T}`);
          });
          if (!trusted && t.name === 'm_flows_schedules' && liveCols.has('enabled')) { db.exec('UPDATE main.m_flows_schedules SET enabled = 0'); held('schedules arrive paused'); }
        }
        report.tables[t.name] = db.prepare(`SELECT COUNT(*) AS n FROM main.${T}`).get().n;
      }
      for (const v of virtual) {
        const T = qi(v.name);
        const ext = /content\s*=\s*(['"]?)([^'",)\s]*)\1/i.exec(v.sql);
        if (ext && ext[2] === '') { report.skipped.push(v.name); continue; }                 // contentless index: nothing to copy
        if (ext) { step(v.name, 'rebuild the search index', () => db.exec(`INSERT INTO main.${T}(${T}) VALUES('rebuild')`)); }
        else step(v.name, 'copy the searchable text and index it again', () => {
          const liveCols = new Set(cols('main', v.name));
          const common = cols('bk', v.name).filter(c => liveCols.has(c));
          const list = ['rowid', ...common.map(qi)].join(', ');
          db.exec(`DELETE FROM main.${T}`);
          db.exec(`INSERT INTO main.${T} (${list}) SELECT ${list} FROM bk.${T}`);
        });
        report.tables[v.name] = db.prepare(`SELECT COUNT(*) AS n FROM main.${T}`).get().n;
      }
      const bad = db.prepare('PRAGMA main.foreign_key_check').all();
      if (bad.length) throw Object.assign(new Error(`The restore stopped at the table ${bad[0].table} (a link to ${bad[0].parent} that does not exist). Nothing was changed.`), { status: 500, code: 'restore_failed', table: bad[0].table, rule: 'foreign key' });
    });
  });
  return report;
}

/** Copy the backup's workspace over the live one; files of the same name are replaced. Extra files move to the bin when asked. */
export function restoreWorkspace({ fromDir, workspace, wipeExtra = false, binDir }) {
  const files = walk(fromDir);
  for (const f of files) {
    const target = path.resolve(workspace, f.rel);
    if (!target.startsWith(workspace + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f.abs, target);
  }
  let moved = 0;
  if (wipeExtra) {
    const keep = new Set(files.map(f => f.rel));
    const dest = path.join(binDir, 'before-restore-' + new Date().toISOString().replace(/[:.]/g, '-'));
    for (const f of walk(workspace)) if (!keep.has(f.rel)) {
      const target = path.join(dest, f.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(f.abs, target); moved++;
    }
  }
  return { copied: files.length, movedToBin: moved };
}
