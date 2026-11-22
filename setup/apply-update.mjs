// Puts a staged update in place (contracts: app/core/contracts/UPDATES.md). The start scripts run this before the desk
// starts, every time. With nothing staged it does nothing and prints nothing. It always exits 0: the desk then starts,
// on the new version or, if anything went wrong, on the old one. Only Node's own modules are used here.
//   node setup/apply-update.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
/** Never replaced: the owner's data, his backups, a private Node the installer may have put there. */
const NEVER = new Set(['data', 'backups', 'runtime', '.git']);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const versionOf = (root) => readJson(path.join(root, 'app', 'version.json'))?.version || readJson(path.join(root, 'package.json'))?.version || 'the version you had';
/** modules/shipped.json: the top-level entries of the modules folder as a release shipped them. A folder in the old
 *  modules that is in neither the old record nor the new release was added by hand, and is carried over. */
const SHIPPED = 'shipped.json';
const shippedOf = (modulesDir) => { const r = readJson(path.join(modulesDir, SHIPPED)); return Array.isArray(r?.entries) ? new Set(r.entries.map(String)) : null; };
const plainName = (n) => typeof n === 'string' && n && !/[\\/]/.test(n) && n !== '.' && n !== '..';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The same hash as app/core/update.js treeHash: "path, size, sha256" lines of every file, sorted. */
export function treeHash(root, names) {
  const lines = [];
  const add = (abs, rel) => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`a link is in the update (${rel})`);
    if (st.isDirectory()) { for (const n of fs.readdirSync(abs).sort()) add(path.join(abs, n), rel + '/' + n); return; }
    lines.push(`${rel}\0${st.size}\0${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
  };
  for (const n of [...names].sort()) add(path.join(root, n), n);
  lines.sort();
  return { hash: crypto.createHash('sha256').update(lines.join('\n')).digest('hex'), files: lines.length };
}

/** Rename, or copy and remove when the data folder is on another drive. */
function rename(from, to) {
  try { fs.renameSync(from, to); }
  catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(from, to, { recursive: true, force: true, verbatimSymlinks: true }); fs.rmSync(from, { recursive: true, force: true }); }
}
/** Windows: a file another program has open for a moment (a virus scanner, an Explorer window) is tried again. */
export function retrying(move) {
  return (from, to) => {
    for (let i = 0; ; i++) {
      try { return move(from, to); }
      catch (e) { if (i < 4 && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) { sleep(400 * (i + 1)); continue; } throw e; }
    }
  };
}
const plainError = (e) => ({ EBUSY: 'a file is in use by another program', EPERM: 'Windows did not allow a file to be moved (is a program or folder window using it?)', EACCES: 'a file could not be moved (no permission)', ENOSPC: 'the disk is full', ENOENT: 'a file was missing' })[e?.code] || String(e?.message || e);

/**
 * cmd.exe reads a running .bat file line by line from where it left off, so start.bat cannot be swapped while it runs.
 * On Windows a changed start.bat is put beside it as start.bat.new and swapped by a small helper once that window closes.
 */
function swapBatLater(root, waitPid) {
  const code = `const fs=require('fs'),p=require('path');const r=process.argv[1],pid=Number(process.argv[2]);const alive=()=>{try{process.kill(pid,0);return true}catch{return false}};let n=0;const t=setInterval(()=>{if(alive()&&++n<604800)return;clearInterval(t);try{fs.renameSync(p.join(r,'start.bat.new'),p.join(r,'start.bat'))}catch{}},1000);`;
  try { spawn(process.execPath, ['-e', code, root, String(waitPid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch { return false; }
}

/**
 * Apply data/update-staged/ready.json to the install folder. Every step is undone if a later one fails.
 * Returns { ok, line } (nothing staged: { ok: true, line: null }). move is for tests.
 */
export function applyStaged({ root, data, say = (l) => console.log(l), move = rename, platform = process.platform, waitPid = null } = {}) {
  const mv = retrying(move);
  const dir = path.join(data, 'update-staged');
  const readyFile = path.join(dir, 'ready.json');
  if (!fs.existsSync(readyFile)) return putBackIfNeverStarted({ root, dir, say, mv });
  const ready = readJson(readyFile);
  const from = versionOf(root);
  const prev = path.join(dir, 'previous');
  const done = [];
  const undo = () => {
    for (const s of [...done].reverse()) {
      if (s.undo) { try { s.undo(); } catch {} continue; }
      try { if (s.newAt) { if (fs.existsSync(s.newAt)) fs.rmSync(s.newAt, { recursive: true, force: true }); } } catch {}
      try { if (s.oldMoved) mv(path.join(prev, s.name), path.join(root, s.name)); } catch {}
    }
  };
  const fail = (why) => {
    undo();
    const line = `The update to ${ready?.version || 'a new version'} could not be applied: ${why}. You are still on ${from}.`;
    try { fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: false, line, at: new Date().toISOString() }, null, 1)); } catch {}
    for (const f of [readyFile, path.join(dir, 'next'), prev]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch {} }
    say(line);
    return { ok: false, line };
  };
  // what ready.json may name: plain top-level names, never the owner's folders, a staged folder inside update-staged
  const names = Array.isArray(ready?.replace) ? ready.replace : [];
  const staged = ready?.staged ? path.resolve(dir, String(ready.staged)) : null;
  if (!ready || !/^\d+(\.\d+){0,3}$/.test(String(ready.version)) || !names.length || names.some(n => typeof n !== 'string' || !n || n.includes('/') || n.includes('\\') || n === '.' || n === '..' || NEVER.has(n.toLowerCase())) || !staged || (!staged.startsWith(path.join(dir, 'next') + path.sep) && staged !== path.join(dir, 'next'))) return fail('the update notes cannot be read');
  say(`Putting AP Desk ${ready.version} in place...`);
  try {
    if (!fs.existsSync(staged)) return fail('the downloaded files are missing');
    if (treeHash(staged, names).hash !== ready.tree) return fail('the downloaded files changed after they were checked');
  } catch (e) { return fail('the downloaded files could not be checked (' + plainError(e) + ')'); }
  fs.rmSync(prev, { recursive: true, force: true }); fs.mkdirSync(prev, { recursive: true });
  const order = [...names.filter(n => n !== 'setup'), ...names.filter(n => n === 'setup')];   // setup, where this script lives, last
  let batLater = false; const kept = [];
  // added by hand: in the old modules folder, not in its release's record (no record: not known to be from it), not in the new release
  const oldMods = path.join(root, 'modules'); const newMods = path.join(staged, 'modules');
  const oldRecord = fs.existsSync(oldMods) ? shippedOf(oldMods) : null;
  const handAdded = names.includes('modules') && fs.existsSync(newMods) && fs.existsSync(oldMods) ? (() => {
    const shipped = oldRecord || new Set(); const incoming = new Set(fs.readdirSync(newMods));
    return fs.readdirSync(oldMods, { withFileTypes: true }).filter(e => e.isDirectory() && !shipped.has(e.name) && !incoming.has(e.name) && e.name !== SHIPPED).map(e => e.name).sort();
  })() : [];
  try {
    for (const name of order) {
      const target = path.join(root, name); const src = path.join(staged, name);
      if (platform === 'win32' && name.toLowerCase() === 'start.bat' && fs.existsSync(target) && !fs.readFileSync(target).equals(fs.readFileSync(src))) {
        const later = path.join(root, 'start.bat.new');
        const s = { name: 'start.bat.new', oldMoved: false, newAt: null }; done.push(s);
        fs.rmSync(later, { force: true }); mv(src, later); s.newAt = later; batLater = true;
        continue;
      }
      const s = { name, oldMoved: false, newAt: null }; done.push(s);
      if (fs.existsSync(target)) { mv(target, path.join(prev, name)); s.oldMoved = true; }
      mv(src, target); s.newAt = target;
      if (name === 'modules') {
        fs.writeFileSync(path.join(target, SHIPPED), JSON.stringify({ version: ready.version, entries: [...new Set([...fs.readdirSync(target), SHIPPED])].sort() }));
        for (const k of handAdded) {
          const at = path.join(target, k), was = path.join(prev, 'modules', k);
          mv(was, at); kept.push(k);
          done.push({ name: 'modules/' + k, undo: () => mv(at, was) });
        }
      }
    }
  } catch (e) { return fail(plainError(e)); }
  fs.writeFileSync(path.join(dir, 'applied.json'), JSON.stringify({ from, to: ready.version, at: new Date().toISOString(), notes: ready.notes || [], replaced: done.filter(s => !s.undo).map(s => ({ name: s.name, hadOld: s.oldMoved })), keptModules: kept, confirmed: false }, null, 1));
  for (const f of [readyFile, path.join(dir, 'result.json'), path.join(dir, 'next')]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch {} }
  say(`AP Desk was updated from ${from} to ${ready.version}.`);
  // with no record of the old release's modules, a folder the new one does not include may be the owner's or one the
  // release dropped: it is kept, and the line says only what is known
  if (kept.length && oldRecord) say(`Kept the module folder${kept.length === 1 ? '' : 's'} you added: ${kept.join(', ')}.`);
  else if (kept.length) say(`Kept ${kept.length === 1 ? 'a module folder' : kept.length + ' module folders'} that ${ready.version} does not include: ${kept.join(', ')}. This copy had no list of the modules ${from} came with, so none were removed.`);
  if (batLater) say(swapBatLater(root, waitPid || process.ppid) ? 'The new start.bat is put in place when this window closes.' : 'The new start.bat is saved as start.bat.new. Rename it to start.bat after the desk has stopped.');
  return { ok: true, line: `AP Desk was updated from ${from} to ${ready.version}.` };
}

/** The new version was put in place but never started (it would have said so): the previous files go back. */
function putBackIfNeverStarted({ root, dir, say, mv }) {
  const f = path.join(dir, 'applied.json'); const a = readJson(f); const prev = path.join(dir, 'previous');
  if (!a || a.confirmed || !fs.existsSync(prev) || versionOf(root) !== a.to) return { ok: true, line: null };
  const failed = path.join(dir, 'did-not-start'); fs.rmSync(failed, { recursive: true, force: true }); fs.mkdirSync(failed, { recursive: true });
  try {
    // the module folders the owner added go back into the old modules folder first, so they stay through the rollback
    if (fs.existsSync(path.join(prev, 'modules'))) for (const k of Array.isArray(a.keptModules) ? a.keptModules : []) {
      if (!plainName(k) || !fs.existsSync(path.join(root, 'modules', k)) || fs.existsSync(path.join(prev, 'modules', k))) continue;
      mv(path.join(root, 'modules', k), path.join(prev, 'modules', k));
    }
    for (const r of [...(a.replaced || [])].reverse()) {
      if (typeof r?.name !== 'string' || !r.name || /[\\/]/.test(r.name) || r.name === '..' || NEVER.has(r.name.toLowerCase())) continue;
      const target = path.join(root, r.name);
      if (fs.existsSync(target)) mv(target, path.join(failed, r.name));
      if (r.hadOld && fs.existsSync(path.join(prev, r.name))) mv(path.join(prev, r.name), target);
    }
  } catch (e) { const line = `The new version ${a.to} did not start, and the previous files could not all be put back: ${plainError(e)}. They are in ${prev}.`; say(line); try { fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: false, line }, null, 1)); } catch {} return { ok: false, line }; }
  const line = `The new version ${a.to} did not start. The desk is back on ${a.from}.`;
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: false, line, at: new Date().toISOString() }, null, 1));
  for (const x of [f, prev, failed]) { try { fs.rmSync(x, { recursive: true, force: true }); } catch {} }
  say(line);
  return { ok: false, line };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    const args = process.argv.slice(2);
    const fromCopy = args[0] === '--root';
    const root = fromCopy ? path.resolve(args[1]) : path.dirname(path.dirname(SELF));
    const data = process.env.APD_DATA || path.join(root, 'data');
    const dir = path.join(data, 'update-staged');
    const a = readJson(path.join(dir, 'applied.json'));
    const work = fs.existsSync(path.join(dir, 'ready.json')) || (a && !a.confirmed && fs.existsSync(path.join(dir, 'previous')));
    if (work && !fromCopy) {
      // this file is inside setup/, which the update may replace: run from a copy in the staging folder instead
      const copy = path.join(dir, 'apply-update.mjs');
      let r = null;
      try { fs.copyFileSync(SELF, copy); r = spawnSync(process.execPath, [copy, '--root', root, '--wait', String(process.ppid)], { stdio: 'inherit', env: { ...process.env, APD_DATA: data }, windowsHide: true }); } catch {}
      if (!r || r.error || r.status !== 0) applyStaged({ root, data });
      try { fs.rmSync(copy, { force: true }); } catch {}
    } else if (work) applyStaged({ root, data, waitPid: Number(args[args.indexOf('--wait') + 1]) || null });
  } catch (e) { console.log(`The update step could not run (${e?.message || e}). The desk starts as it is.`); }
  process.exit(0);
}
