// The Files explorer's server logic (isInside, freeName, moveAcross, sizeOf and the Bin) on the desk's contracts:
// roots are the workspace (Home), each agent's folder under it, Downloads/Documents/Desktop and drives; grants come
// from the approval door (file.read.outside); meta lives in m_files_meta; the Bin is ctx.dataDir/bin.
//
// Every path the client sends is (root id, relative path). The server resolves it, checks it sits inside the root,
// then checks the real path (symlinks followed) is still inside the root's real path. The data folder (database,
// profiles, bin payloads) is never shown, even under a granted drive. Delete never deletes: it moves into
// <data>/bin/payloads and writes a Bin item, so Restore puts it back.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import nodePath from 'node:path';
import os from 'node:os';

export const PLACES = Object.freeze([
  Object.freeze({ id: 'downloads', label: 'Downloads', dir: 'Downloads' }),
  Object.freeze({ id: 'documents', label: 'Documents', dir: 'Documents' }),
  Object.freeze({ id: 'desktop', label: 'Desktop', dir: 'Desktop' }),
]);

const MAX_LIST = 5000;
const MAX_SEARCH_VISIT = 4000;
const MAX_SEARCH_DEPTH = 6;
const MAX_SEARCH_HITS = 500;
const MAX_NAME = 200;
const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export const MIME = {
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8', htm: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export class ExplorerError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => new ExplorerError(status, code, message);

export function extOf(name) { const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }

// ---- path safety (pure; `P` is node:path or path.win32 so Windows paths are tested on any OS) -------

/** True when target is parent or inside it. On Windows the comparison ignores case. */
export function isInside(parent, target, P = nodePath) {
  let root = P.resolve(parent); let abs = P.resolve(target);
  if (P.sep === '\\') { root = root.toLowerCase(); abs = abs.toLowerCase(); }
  const base = root.endsWith(P.sep) ? root : root + P.sep;
  return abs === root || abs.startsWith(base);
}

/** Splits a client path into clean segments; refuses absolute, drive, dot-dot and NUL paths. */
export function cleanRel(rel) {
  const raw = rel == null ? '' : String(rel);
  if (raw.length > 4096) throw fail(400, 'bad_path', 'That path is too long.');
  if (raw.includes('\0')) throw fail(400, 'bad_path', 'That path is not allowed.');
  if (/^[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('~')) throw fail(400, 'bad_path', 'Paths are relative to the folder you opened.');
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw fail(400, 'bad_path', 'That path leaves the folder.');
  return parts;
}

/** A single new file or folder name (rename, New folder, upload). */
export function validName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n || n === '.' || n === '..') throw fail(400, 'bad_name', 'Type a name.');
  if (n.length > MAX_NAME) throw fail(400, 'bad_name', 'That name is too long.');
  if (/[\\/:*?"<>|\0]/.test(n) || /[\u0000-\u001f]/.test(n)) throw fail(400, 'bad_name', 'A name cannot contain \\ / : * ? " < > |');
  if (/[. ]$/.test(n)) throw fail(400, 'bad_name', 'A name cannot end with a dot or a space.');
  if (RESERVED_WIN.test(n)) throw fail(400, 'bad_name', 'Windows keeps that name for itself.');
  return n;
}

/** The lexical half of resolveInside: (root, rel) -> absolute path, or a refusal. Pure. */
export function joinInside(rootAbs, rel, P = nodePath) {
  const parts = cleanRel(rel);
  const root = P.resolve(rootAbs);
  const abs = P.resolve(root, ...parts);
  if (!isInside(root, abs, P)) throw fail(400, 'bad_path', 'That path leaves the folder.');
  return { root, abs, parts };
}

/** True for anything inside the data folder that is not the workspace: apd.sqlite, profiles, bin. With several people
 *  (env.deskDir, the desk's whole data folder), also every other person's space and the house's own files, and the
 *  keeper's backups folder (env.houseBackups), which lives outside the data folder. */
export function isBlocked(env, abs, P = nodePath) {
  return (isInside(env.dataDir, abs, P) || (!!env.deskDir && isInside(env.deskDir, abs, P)) || (!!env.houseBackups && isInside(env.houseBackups, abs, P))) && !isInside(env.workspace, abs, P);
}

/** Is an absolute path inside one of the folders the owner opened? */
export function insideGranted(abs, grants, P = nodePath) {
  return (grants || []).some((g) => isInside(g, abs, P));
}

async function realOrNull(p) { try { return await fs.realpath(p); } catch { return null; } }

/** Resolve (root, rel) to an absolute path inside the root, also after symlinks. */
export async function resolveInside(rootAbs, rel, { mustExist = true } = {}) {
  const { root, abs, parts } = joinInside(rootAbs, rel);
  const realRoot = await realOrNull(root);
  if (!realRoot) throw fail(404, 'root_missing', 'That folder is not on this PC.');
  let real = await realOrNull(abs);
  if (!real) {
    if (mustExist) throw fail(404, 'not_found', 'Nothing is there. It may have moved.');
    const parentReal = await realOrNull(nodePath.dirname(abs));
    if (!parentReal) throw fail(404, 'not_found', 'The folder it goes in is not there.');
    real = nodePath.join(parentReal, nodePath.basename(abs));
  }
  if (!isInside(realRoot, real)) throw fail(403, 'symlink_escape', 'That link points outside the folder, so it stays closed.');
  return { abs, real, parts, rel: parts.join('/') };
}

// ---- roots and grants ----------------------------------------------------------------------------

export function listDrives(platform = process.platform, letters = null) {
  if (platform !== 'win32') return [{ id: 'drive:root', label: 'This PC (/)', dir: '/' }];
  const list = letters || 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  return list.map((l) => ({ id: `drive:${l}`, label: `Local Disk (${l}:)`, dir: `${l}:\\` }));
}

/**
 * env: { workspace, dataDir, homeDir, platform, driveLetters, agents(): [{id,name}], grants(): [abs dir], db }
 */
export function explorerEnv(opts) {
  return { homeDir: opts.homeDir || process.env.APD_EXPLORER_HOME || os.homedir(), platform: opts.platform || process.platform, driveLetters: opts.driveLetters || null, binDir: nodePath.join(opts.dataDir, 'bin'), ...opts };
}

async function dirExists(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }
const agentOk = (id) => /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(String(id || ''));
export const agentDir = (env, id) => nodePath.join(env.workspace, 'agents', id);

/** The absolute folder behind a place or drive id, or null. */
export function outsideDir(env, id) {
  const place = PLACES.find((p) => p.id === id);
  if (place) return { dir: nodePath.join(env.homeDir, place.dir), label: place.label, group: 'places' };
  const d = listDrives(env.platform, env.driveLetters).find((row) => row.id === id);
  return d ? { dir: d.dir, label: d.label, group: 'pc' } : null;
}

/** Every root for the tree, with granted:true|false. Ungranted roots carry no listing. */
export async function listRoots(env) {
  const grants = env.grants();
  const out = [{ id: 'home', label: 'Home', group: 'home', granted: true }];
  for (const agent of env.agents()) {
    if (!agent || !agentOk(agent.id)) continue;
    out.push({ id: `agent:${agent.id}`, label: agent.name || agent.id, group: 'agents', granted: true, agentId: agent.id });
  }
  for (const place of PLACES) {
    const { dir } = outsideDir(env, place.id);
    out.push({ id: place.id, label: place.label, group: 'places', granted: grants.includes(dir), present: await dirExists(dir) });
  }
  for (const d of listDrives(env.platform, env.driveLetters)) {
    const present = env.platform === 'win32' ? await dirExists(d.dir) : true;
    if (!present) continue;
    out.push({ id: d.id, label: d.label, group: 'pc', granted: grants.includes(d.dir), present });
  }
  out.push({ id: 'bin', label: 'Bin', group: 'bin', granted: true });
  return out;
}

/** Absolute folder for a root id, or a 403 when the owner has not opened it. */
export async function rootDir(env, rootId) {
  const id = String(rootId || '');
  if (id === 'home') return { id, dir: env.workspace, kind: 'home', agentId: null, label: 'Home' };
  if (id.startsWith('agent:')) {
    const agentId = id.slice(6);
    const agent = env.agents().find((a) => a.id === agentId);
    if (!agentOk(agentId) || !agent) throw fail(400, 'bad_root', 'Unknown folder.');
    const dir = agentDir(env, agentId);
    await fs.mkdir(dir, { recursive: true });
    return { id, dir, kind: 'agent', agentId, label: agent.name || agentId };
  }
  const o = outsideDir(env, id);
  if (!o) throw fail(400, 'bad_root', 'Unknown folder.');
  if (!env.grants().includes(o.dir)) throw fail(403, 'not_granted', `${o.label} is locked. Allow access first.`);
  if (!(await dirExists(o.dir))) throw fail(404, 'root_missing', `${o.label} is not on this PC.`);
  return { id, dir: o.dir, kind: o.group === 'pc' ? 'drive' : 'place', agentId: null, label: o.label };
}

function hiddenEntry(_root, _relParts, name) { return name.startsWith('.'); }

/** Resolve + the hidden/data-folder checks every route shares. */
export async function locate(env, rootId, rel, opts = {}) {
  const root = await rootDir(env, rootId);
  const hit = await resolveInside(root.dir, rel, opts);
  if (hit.parts.some((part, i) => hiddenEntry(root, hit.parts.slice(0, i), part))) throw fail(403, 'protected', 'The desk keeps its own records there.');
  if (isBlocked(env, hit.abs) || isBlocked(env, hit.real)) throw fail(403, 'protected', 'The desk keeps its own records there.');
  return { root, ...hit };
}

// ---- meta (star, who made it, which chat) ----------------------------------------------------------
// One key per file: workspace files are keyed by their workspace path whichever root shows them.
export function metaKey(env, rootId, rel) {
  if (rootId === 'home') return 'home|' + rel;
  if (String(rootId).startsWith('agent:')) return 'home|' + ['agents', rootId.slice(6), rel].filter(Boolean).join('/');
  return rootId + '|' + rel;
}
function metaGet(env, key) { return env.db.get('SELECT * FROM m_files_meta WHERE key = ?', key) || null; }
export function metaSet(env, key, patch) {
  const cur = metaGet(env, key) || {};
  const row = { starred: cur.starred || 0, agent_id: cur.agent_id || null, chat_id: cur.chat_id || null, job_id: cur.job_id || null, ...patch };
  env.db.run('INSERT INTO m_files_meta (key, starred, agent_id, chat_id, job_id, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET starred = excluded.starred, agent_id = excluded.agent_id, chat_id = excluded.chat_id, job_id = excluded.job_id, at = excluded.at',
    key, row.starred ? 1 : 0, row.agent_id, row.chat_id, row.job_id, new Date().toISOString());
}
function moveMeta(env, fromKey, toKey, { copy = false } = {}) {
  const rows = env.db.all('SELECT * FROM m_files_meta WHERE key = ? OR key LIKE ?', fromKey, fromKey + '/%');
  for (const r of rows) {
    const nk = toKey + r.key.slice(fromKey.length);
    env.db.run('INSERT OR REPLACE INTO m_files_meta (key, starred, agent_id, chat_id, job_id, at) VALUES (?, ?, ?, ?, ?, ?)', nk, r.starred, r.agent_id, r.chat_id, r.job_id, r.at);
    if (!copy) env.db.run('DELETE FROM m_files_meta WHERE key = ?', r.key);
  }
}

function rowFor(name, rel, st, kind) {
  const folder = kind === 'folder';
  return { name, path: rel, kind, ext: folder ? '' : extOf(name), bytes: folder ? null : st.size, mtime: st.mtime.toISOString() };
}

async function entryRow(env, root, dirAbs, relParts, dirent) {
  const name = dirent.name;
  if (hiddenEntry(root, relParts, name)) return null;
  const abs = nodePath.join(dirAbs, name);
  if (isBlocked(env, abs)) return null;
  const rel = [...relParts, name].join('/');
  let st;
  try { st = await fs.lstat(abs); } catch { return null; }
  if (st.isSymbolicLink()) {
    // A link is shown only when it lands inside the same root; otherwise it is not listed at all.
    const real = await realOrNull(abs); const realRoot = await realOrNull(root.dir);
    if (!real || !realRoot || !isInside(realRoot, real) || isBlocked(env, real)) return null;
    try { st = await fs.stat(abs); } catch { return null; }
  }
  if (st.isDirectory()) return rowFor(name, rel, st, 'folder');
  if (st.isFile()) return rowFor(name, rel, st, 'file');
  return null;
}

function agentNames(env) { return new Map(env.agents().filter((a) => a && a.id).map((a) => [a.id, String(a.name || a.id)])); }

function decorate(env, rootId, rows, rootAgentId = null) {
  const names = agentNames(env);
  for (const row of rows) {
    const m = metaGet(env, metaKey(env, row.root || rootId, row.path));
    row.starred = Boolean(m?.starred);
    const id = m?.agent_id || rootAgentId || null;
    row.agentId = id; row.madeBy = id ? names.get(id) || id : null;
  }
  return rows;
}

function crumbsFor(root, parts) {
  const out = [{ label: root.label, path: '' }];
  parts.forEach((part, i) => out.push({ label: part, path: parts.slice(0, i + 1).join('/') }));
  return out;
}

async function searchUnder(env, root, startAbs, startParts, q, out, state, depth = 0) {
  if (depth > MAX_SEARCH_DEPTH || out.length >= MAX_SEARCH_HITS || state.visited >= MAX_SEARCH_VISIT) return;
  let entries;
  try { entries = await fs.readdir(startAbs, { withFileTypes: true }); } catch { return; }
  for (const d of entries) {
    state.visited += 1;
    if (state.visited >= MAX_SEARCH_VISIT || out.length >= MAX_SEARCH_HITS) return;
    if (d.isSymbolicLink()) continue;
    const row = await entryRow(env, root, startAbs, startParts, d);
    if (!row) continue;
    if (row.name.toLowerCase().includes(q)) out.push(row);
    if (row.kind === 'folder') await searchUnder(env, root, nodePath.join(startAbs, d.name), [...startParts, d.name], q, out, state, depth + 1);
  }
}

// ---- the Bin ---------------------------------------------------------------------------------------
async function readJson(f) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return null; } }

export async function listBin(env) {
  const dir = nodePath.join(env.binDir, 'items');
  let names = []; try { names = await fs.readdir(dir); } catch {}
  const out = [];
  for (const n of names) { if (!n.endsWith('.json')) continue; const it = await readJson(nodePath.join(dir, n)); if (it) out.push(it); }
  return out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}
async function listBinRows(env) {
  return (await listBin(env)).map((item) => ({
    name: String(item.name || item.id), path: String(item.id), kind: item.kind === 'folder' ? 'folder' : 'file', ext: extOf(item.name),
    bytes: Number(item.bytes) || 0, mtime: item.deletedAt || null, binId: String(item.id), from: item.fromLabel || '', restorable: true,
  }));
}

/** One folder's contents (or a search under it). */
export async function listFolder(env, rootId, rel = '', { q = '' } = {}) {
  if (rootId === 'bin') {
    let rows = await listBinRows(env);
    const needle = String(q || '').trim().toLowerCase();
    if (needle) rows = rows.filter((r) => r.name.toLowerCase().includes(needle));
    return { root: 'bin', path: '', crumbs: [{ label: 'Bin', path: '' }], items: rows, total: rows.length, totalBytes: rows.reduce((s, r) => s + (r.bytes || 0), 0), readOnly: true };
  }
  const hit = await locate(env, rootId, rel);
  const st = await fs.stat(hit.abs);
  if (!st.isDirectory()) throw fail(400, 'not_folder', 'That is a file, not a folder.');
  const needle = String(q || '').trim().toLowerCase().slice(0, 120);
  let rows = [];
  if (needle) await searchUnder(env, hit.root, hit.abs, hit.parts, needle, rows, { visited: 0 });
  else {
    let entries = [];
    try { entries = await fs.readdir(hit.abs, { withFileTypes: true }); } catch (err) { throw fail(403, 'unreadable', `This PC did not let the desk read this folder (${err.code || 'error'}).`); }
    for (const d of entries.slice(0, MAX_LIST)) { const row = await entryRow(env, hit.root, hit.abs, hit.parts, d); if (row) rows.push(row); }
  }
  rows = decorate(env, rootId, rows, hit.root.agentId);
  return { root: rootId, path: hit.rel, crumbs: crumbsFor(hit.root, hit.parts), items: rows, total: rows.length, totalBytes: rows.reduce((s, r) => s + (r.bytes || 0), 0), search: needle || null, agentId: hit.root.agentId };
}

/** Details pane: size, dates, who made it, the chat it came from, star. */
export async function statEntry(env, rootId, rel) {
  const hit = await locate(env, rootId, rel);
  const st = await fs.stat(hit.abs);
  const name = hit.parts.length ? hit.parts[hit.parts.length - 1] : hit.root.label;
  const kind = st.isDirectory() ? 'folder' : 'file';
  const row = rowFor(name, hit.rel, st, kind);
  const meta = metaGet(env, metaKey(env, rootId, hit.rel)) || {};
  const agentId = meta.agent_id || hit.root.agentId || null;
  let children = null;
  if (kind === 'folder') { try { children = (await fs.readdir(hit.abs)).filter((n) => !hiddenEntry(hit.root, hit.parts, n)).length; } catch {} }
  return { ...row, root: rootId, created: (st.birthtime || st.ctime).toISOString(), agentId, agentName: agentId ? agentNames(env).get(agentId) || 'An agent' : null, chatId: meta.chat_id || null, starred: Boolean(meta.starred), children, location: crumbsFor(hit.root, hit.parts.slice(0, -1)).map((c) => c.label).join(' › ') };
}

export async function setEntryMeta(env, rootId, rel, patch = {}) {
  const hit = await locate(env, rootId, rel);
  if (typeof patch.starred === 'boolean') metaSet(env, metaKey(env, rootId, hit.rel), { starred: patch.starred ? 1 : 0 });
  return { root: rootId, path: hit.rel, starred: Boolean(patch.starred) };
}

/** Starred across every open root. */
export async function listStarred(env) {
  const out = [];
  for (const row of env.db.all('SELECT key FROM m_files_meta WHERE starred = 1')) {
    const bar = row.key.indexOf('|'); const rootId = row.key.slice(0, bar); const rel = row.key.slice(bar + 1);
    try { const s = await statEntry(env, rootId, rel); out.push({ ...s, path: rel, root: rootId, madeBy: s.agentName || null }); } catch { /* gone or locked */ }
  }
  return out;
}

/** Recent: files changed in the last 7 days in the workspace and the open places. */
export async function listRecent(env, { days = 7, limit = 200, now = Date.now() } = {}) {
  const roots = (await listRoots(env)).filter((r) => r.granted && (r.group === 'home' || r.group === 'places'));
  const from = now - days * 24 * 60 * 60 * 1000;
  const out = [];
  for (const r of roots) {
    let root; try { root = await rootDir(env, r.id); } catch { continue; }
    const state = { visited: 0 };
    async function walk(abs, parts, depth) {
      if (depth > 4 || state.visited > 2000) return;
      let entries; try { entries = await fs.readdir(abs, { withFileTypes: true }); } catch { return; }
      for (const d of entries) {
        state.visited += 1;
        if (d.isSymbolicLink()) continue;
        const row = await entryRow(env, root, abs, parts, d);
        if (!row) continue;
        if (row.kind === 'folder') await walk(nodePath.join(abs, d.name), [...parts, d.name], depth + 1);
        else if (Date.parse(row.mtime) >= from) out.push({ ...row, root: r.id, rootLabel: r.label });
      }
    }
    await walk(root.dir, [], 0);
  }
  out.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  return decorate(env, 'home', out.slice(0, limit));
}

// ---- changes (mkdir, rename, move, copy, recycle, restore, upload) ----------------------------------

async function exists(p) { try { await fs.lstat(p); return true; } catch { return false; } }

/** "report.md" -> "report (2).md" until the name is free in that folder. */
export async function freeName(dirAbs, name) {
  if (!(await exists(nodePath.join(dirAbs, name)))) return name;
  const ext = nodePath.extname(name); const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 1000; i += 1) { const next = `${stem} (${i})${ext}`; if (!(await exists(nodePath.join(dirAbs, next)))) return next; }
  throw fail(409, 'exists', 'Too many files with that name.');
}
function notRoot(hit) { if (!hit.parts.length) throw fail(400, 'is_root', 'That is the top of the folder; it cannot be changed here.'); }

export async function makeFolder(env, rootId, rel, name) {
  const parent = await locate(env, rootId, rel);
  if (!(await fs.stat(parent.abs)).isDirectory()) throw fail(400, 'not_folder', 'New folders go in a folder.');
  const clean = validName(name);
  if (hiddenEntry(parent.root, parent.parts, clean)) throw fail(403, 'protected', 'The desk keeps that name for its own records.');
  const final = await freeName(parent.abs, clean);
  await fs.mkdir(nodePath.join(parent.abs, final));
  return { root: rootId, path: [...parent.parts, final].join('/'), name: final };
}

/** Upload: one file into the folder shown, never over an existing file. */
export async function uploadFile(env, rootId, rel, name, bytes) {
  const parent = await locate(env, rootId, rel);
  if (!(await fs.stat(parent.abs)).isDirectory()) throw fail(400, 'not_folder', 'Files go in a folder.');
  const clean = validName(name);
  if (hiddenEntry(parent.root, parent.parts, clean)) throw fail(403, 'protected', 'The desk keeps that name for its own records.');
  const final = await freeName(parent.abs, clean);
  await fs.writeFile(nodePath.join(parent.abs, final), bytes, { flag: 'wx' });
  return { root: rootId, path: [...parent.parts, final].join('/'), name: final, bytes: bytes.length };
}

export async function renameEntry(env, rootId, rel, name) {
  const hit = await locate(env, rootId, rel);
  notRoot(hit);
  const clean = validName(name);
  const parentParts = hit.parts.slice(0, -1);
  if (hiddenEntry(hit.root, parentParts, clean)) throw fail(403, 'protected', 'The desk keeps that name for its own records.');
  if (clean === hit.parts[hit.parts.length - 1]) return { root: rootId, path: hit.rel, name: clean };
  const dest = nodePath.join(nodePath.dirname(hit.abs), clean);
  // Case-only rename on Windows lands on the same file; anything else already there is a clash.
  if (await exists(dest)) {
    const [a, b] = await Promise.all([fs.lstat(hit.abs), fs.lstat(dest)]);
    if (a.ino !== b.ino || a.dev !== b.dev) throw fail(409, 'exists', `“${clean}” is already in this folder.`);
  }
  await fs.rename(hit.abs, dest);
  const to = [...parentParts, clean].join('/');
  moveMeta(env, metaKey(env, rootId, hit.rel), metaKey(env, rootId, to));
  return { root: rootId, path: to, name: clean, from: hit.rel };
}

async function moveAcross(src, dest) {
  try { await fs.rename(src, dest); } catch (err) {
    if (err && err.code === 'EXDEV') {
      // Another drive: copy it whole first, and remove the original only after the copy is done.
      await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      await fs.rm(src, { recursive: true, force: false });
      return;
    }
    throw err;
  }
}

/** Move or copy paths[] from one folder into another (same or another open root). */
export async function moveEntries(env, rootId, rels, toRoot, toRel, { copy = false } = {}) {
  const list = Array.isArray(rels) ? rels : [rels];
  if (!list.length || list.length > 500) throw fail(400, 'bad_paths', 'Pick between 1 and 500 items.');
  const target = await locate(env, toRoot || rootId, toRel);
  if (!(await fs.stat(target.abs)).isDirectory()) throw fail(400, 'not_folder', 'Pick a folder to move into.');
  const done = [];
  for (const rel of list) {
    const hit = await locate(env, rootId, rel);
    notRoot(hit);
    if (isInside(hit.real, target.real)) throw fail(400, 'into_itself', 'A folder cannot go inside itself.');
    const name = hit.parts[hit.parts.length - 1];
    const sameFolder = nodePath.dirname(hit.abs) === target.abs;
    if (sameFolder && !copy) { done.push({ from: hit.rel, path: hit.rel, name }); continue; }
    const final = await freeName(target.abs, name);
    const dest = nodePath.join(target.abs, final);
    const toPath = [...target.parts, final].join('/');
    if (copy) await fs.cp(hit.abs, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    else await moveAcross(hit.abs, dest);
    moveMeta(env, metaKey(env, rootId, hit.rel), metaKey(env, target.root.id, toPath), { copy });
    done.push({ from: hit.rel, path: toPath, name: final });
  }
  return { root: target.root.id, items: done, copied: Boolean(copy) };
}

async function sizeOf(abs) {
  const st = await fs.lstat(abs);
  if (st.isSymbolicLink()) return 0;
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const d of await fs.readdir(abs, { withFileTypes: true })) total += await sizeOf(nodePath.join(abs, d.name));
  return total;
}

/** Delete = move into the Bin. Nothing is ever removed for good here. */
export async function recycleEntries(env, rootId, rels) {
  const list = Array.isArray(rels) ? rels : [rels];
  if (!list.length || list.length > 500) throw fail(400, 'bad_paths', 'Pick between 1 and 500 items.');
  const out = [];
  for (const rel of list) {
    const hit = await locate(env, rootId, rel);
    notRoot(hit);
    const st = await fs.lstat(hit.abs);
    if (st.isSymbolicLink()) throw fail(400, 'symlink', 'Links are not moved to the Bin.');
    const id = `bin_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const payload = nodePath.join(env.binDir, 'payloads', id);
    await fs.mkdir(nodePath.dirname(payload), { recursive: true });
    const bytes = await sizeOf(hit.abs).catch(() => 0);
    await moveAcross(hit.abs, payload);
    const name = hit.parts[hit.parts.length - 1];
    const item = { id, kind: st.isDirectory() ? 'folder' : 'file', name, deletedAt: new Date().toISOString(), root: rootId, path: hit.rel, fromLabel: crumbsFor(hit.root, hit.parts.slice(0, -1)).map((c) => c.label).join(' › '), bytes };
    try {
      await fs.mkdir(nodePath.join(env.binDir, 'items'), { recursive: true });
      await fs.writeFile(nodePath.join(env.binDir, 'items', `${id}.json`), JSON.stringify(item, null, 2));
    } catch (err) { await moveAcross(payload, hit.abs).catch(() => {}); throw err; }
    out.push({ path: hit.rel, binId: id, name });
  }
  return { items: out };
}

/** Put a Bin item back where it was (inside its still-open root). */
export async function restoreEntry(env, binId) {
  const id = String(binId || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw fail(400, 'bad_id', 'Unknown Bin item.');
  const file = nodePath.join(env.binDir, 'items', `${id}.json`);
  const item = await readJson(file);
  if (!item) throw fail(404, 'not_found', 'That item is no longer in the Bin.');
  const payload = nodePath.join(env.binDir, 'payloads', id);
  const parts = cleanRel(item.path);
  const root = await rootDir(env, item.root);
  await fs.mkdir(nodePath.join(root.dir, ...parts.slice(0, -1)), { recursive: true });
  const dest = await locate(env, item.root, item.path, { mustExist: false });
  if (await exists(dest.abs)) throw fail(409, 'exists', 'Something with that name is already back there. It stayed in the Bin.');
  await moveAcross(payload, dest.abs);
  await fs.rm(file, { force: true });
  return { restored: true, name: item.name, root: item.root, path: item.path, parent: parts.slice(0, -1).join('/') };
}
