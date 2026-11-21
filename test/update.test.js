// Signed updates (contracts/UPDATES.md). Throw-away Ed25519 keys made here in memory, a loopback stand-in for GitHub,
// and a fake install folder in the temp folder: the repository itself is never changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeKeys, releaseZip, release, standIn, fakeInstall } from './helpers/update.js';
import { createDesk } from '../app/server.js';
import { Updater, compareVersions, verifyManifest, treeHash, entryProblem, layoutOf } from '../app/core/update.js';
import { SETTINGS_TOKEN } from '../app/core/approval-door.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APPLY = path.join(REPO_ROOT, 'setup', 'apply-update.mjs');

/** A desk whose data folder is <root>/data, with an Updater pointed at the stand-in and the throw-away keys. */
async function deskFor(root, s, keys) {
  const desk = await createDesk({ dataDir: path.join(root, 'data'), port: 0, quiet: true, env: {}, modules: ['backup'] });
  await desk.start();
  desk.core.updater = new Updater(desk.core, { root, repo: s?.repo, hosts: s ? [s.host] : undefined, keys: keys.map(k => k.entry) });
  const call = async (p, { body, session = true } = {}) => {
    const r = await fetch(desk.url() + p, { method: body !== undefined ? 'POST' : 'GET', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session ? { 'x-apd-session': desk.session } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
  };
  return { desk, core: desk.core, call, async close() { await desk.stop(); } };
}

/** Snapshot of every file under root except the data folder's database (which the desk itself writes). */
function snapshot(root) {
  const out = {};
  (function go(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (r === 'data' || r.endsWith('-backups')) continue; const p = path.join(d, e.name); if (e.isDirectory()) go(p, r); else out[r] = fs.readFileSync(p, 'utf8'); } })(root, '');
  return out;
}
const approveWhenAsked = async (core, { deny = false } = {}) => {
  for (let i = 0; i < 200; i++) {
    const p = core.approval.listPending().find(a => a.action === 'install' && a.payload?.kind === 'desk-update');
    if (p) return core.approval.decide(p.id, deny ? 'deny' : 'approve', 'owner');
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the update never asked');
};
const runApply = (root) => spawnSync(process.execPath, [path.join(root, 'setup', 'apply-update.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, APD_DATA: '' } });

test('versions compare as numbers by part, not as text', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.2', '0.1.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.throws(() => compareVersions('0.1.0-beta', '0.1.0'));
});

test('signature: a listed key verifies; an unknown key, a changed manifest and no key at all are refused', () => {
  const k = makeKeys('k1'), other = makeKeys('k2');
  const r = release('0.1.1', Buffer.from('zip'), k);
  assert.equal(verifyManifest(r.bytes, r.sig, [k.entry]).ok, true);
  assert.equal(verifyManifest(r.bytes, r.sig, [other.entry, k.entry]).ok, true, 'two keys may be listed while one is rotated out');
  assert.match(verifyManifest(r.bytes, r.sig, []).reason, /not set up/);
  const unknown = release('0.1.1', Buffer.from('zip'), other);
  assert.match(verifyManifest(unknown.bytes, unknown.sig, [k.entry]).reason, /key this desk does not know/);
  const changed = Buffer.from(r.bytes.toString().replace('Smaller fixes.', 'Smaller fixes!'));
  assert.match(verifyManifest(changed, r.sig, [k.entry]).reason, /changed after it was signed/);
  assert.match(verifyManifest(r.bytes, 'not base64 at all', [k.entry]).reason, /changed after it was signed|signature/);
});

test('zip entries: no absolute paths, no drive letters, no .., no symlinks', () => {
  assert.equal(entryProblem({ entryName: 'apdesk/app/server.js', header: { attr: 0 } }), null);
  assert.match(entryProblem({ entryName: '../evil.js', header: { attr: 0 } }), /outside/);
  assert.match(entryProblem({ entryName: 'apdesk/../../evil.js', header: { attr: 0 } }), /outside/);
  assert.match(entryProblem({ entryName: '/etc/evil', header: { attr: 0 } }), /absolute/);
  assert.match(entryProblem({ entryName: 'C:/Windows/evil', header: { attr: 0 } }), /absolute/);
  assert.match(entryProblem({ entryName: 'apdesk/link', header: { attr: (0o120777 << 16) >>> 0 } }), /link/);
});

test('layout: a Git checkout, a zip install and a source download are told apart', () => {
  const a = fakeInstall(), b = fakeInstall({ git: true, source: true }), c = fakeInstall({ source: true });
  try { assert.equal(layoutOf(a), 'zip'); assert.equal(layoutOf(b), 'git'); assert.equal(layoutOf(c), 'source'); assert.equal(layoutOf(REPO_ROOT), 'git'); }
  finally { for (const d of [a, b, c]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('no key in the app: "not set up", nothing is fetched, nothing installs', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const r = release('0.1.1', releaseZip('0.1.1'), k); s.publish(r, releaseZip('0.1.1'));
  const d = await deskFor(root, s, []);
  try {
    const st = (await d.call('/api/update/check', { body: {} })).json;
    assert.equal(st.line, 'Updates are not set up in this build.');
    assert.equal(st.canInstall, false);
    assert.equal(s.hits.length, 0, 'no key: GitHub is not even asked');
    const before = snapshot(root);
    const out = await d.core.updater.install(SETTINGS_TOKEN);
    assert.equal(out.ok, false); assert.match(out.line, /not set up/);
    assert.deepEqual(snapshot(root), before);
    // the shipped key list is empty today
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'app', 'core', 'update-keys.json'), 'utf8')).keys, []);
  } finally { await d.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a good release: checked, asked, downloaded, verified, backed up, applied; data untouched; then confirmed once', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  let d = await deskFor(root, s, [k]);
  try {
    assert.equal((await d.call('/api/update/check', { body: {}, session: false })).status, 403, 'a check needs the owner\'s window');
    const st = (await d.call('/api/update/check', { body: {} })).json;
    assert.match(st.line, /^Version 0\.1\.1 is ready, published (\d{1,2} Nov 2026|Nov \d{1,2}, 2026)\.$/, st.line);
    assert.deepEqual(st.release.notes, ['Updates are signed now.', 'Smaller fixes.']);
    assert.equal(st.canInstall, true);
    assert.ok(s.hits.every(h => /^AgentPopulationDesk\//.test(h.ua) && !h.cookie && !h.auth), 'a plain GET with the desk\'s User-Agent, nothing about the user');
    assert.ok(s.hits.some(h => h.url.startsWith('/assets/')), 'GitHub\'s redirect to its asset host was followed');

    const ownerData = fs.readFileSync(path.join(root, 'data', 'keep.txt'), 'utf8');
    const res = await d.call('/api/update/install', { body: {} });
    assert.equal(res.status, 200);
    await approveWhenAsked(d.core);
    let state; for (let i = 0; i < 300; i++) { state = d.core.updater.state(); if (state.busy === 'restarting' || state.note) break; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(state.note, null, state.note);
    assert.equal(d.desk.restartRequested, 'update', 'the desk asks to restart (exit code 75)');
    assert.match(state.backup, /^apd-.*\.zip$/, 'a backup is made first and named');
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'data', 'update-staged', 'ready.json'), 'utf8'));
    assert.equal(ready.version, '0.1.1'); assert.equal(ready.from, '0.1.0');
    assert.ok(!ready.replace.includes('data') && !ready.replace.includes('backups'), ready.replace.join(','));
    assert.equal(fs.readFileSync(path.join(root, 'app', 'server.js'), 'utf8'), '// old server\n', 'nothing changes before the restart');
    await d.close(); d = null;

    // the start script runs this before the server starts
    const out = runApply(root);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /AP Desk was updated from 0\.1\.0 to 0\.1\.1\./, out.stdout + out.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'server.js'), 'utf8'), '// new server 0.1.1\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app', 'version.json'), 'utf8')).version, '0.1.1');
    assert.equal(fs.readFileSync(path.join(root, 'start.bat'), 'utf8'), 'rem new 0.1.1\r\n');
    assert.ok(!fs.existsSync(path.join(root, 'modules', 'beta')), 'program folders are replaced whole');
    assert.equal(fs.readFileSync(path.join(root, 'data', 'keep.txt'), 'utf8'), ownerData, 'data untouched');
    assert.ok(!fs.existsSync(path.join(root, 'data', 'README.txt')), 'the release\'s data folder is never copied in');
    assert.equal(fs.readFileSync(path.join(root, 'runtime', 'node.txt'), 'utf8'), 'a private Node the installer put here\n', 'runtime untouched');
    assert.ok(fs.existsSync(path.join(root, 'data', 'update-staged', 'previous', 'app', 'server.js')), 'the old files are kept until the new desk has started');

    // the new desk starts: the card says so once, the previous files go
    d = await deskFor(root, s, [k]);
    const first = (await d.call('/api/update')).json;
    assert.match(first.justUpdated?.line || '', /^AP Desk was updated to 0\.1\.1\./);
    assert.deepEqual(first.justUpdated.notes, ['Updates are signed now.', 'Smaller fixes.']);
    assert.ok(!fs.existsSync(path.join(root, 'data', 'update-staged', 'previous')), 'previous files removed after a good start');
    assert.equal((await d.call('/api/update')).json.justUpdated, null, 'said once');
    assert.equal(first.installed.version, '0.1.1');
    assert.equal(runApply(root).stdout.trim(), '', 'after a good start the next run has nothing to do and says nothing');
    assert.equal(fs.readFileSync(path.join(root, 'app', 'server.js'), 'utf8'), '// new server 0.1.1\n');
  } finally { await d?.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Each bad release: refused with its own plain reason, and nothing in the install folder changes.
const BAD = [
  ['a manifest signed by an unknown key', (k) => { const other = makeKeys('stranger'); const zip = releaseZip('0.1.1'); return { r: release('0.1.1', zip, other), zip }; }, /key this desk does not know/],
  ['a manifest changed after signing', (k) => { const zip = releaseZip('0.1.1'); const r = release('0.1.1', zip, k); r.bytes = Buffer.from(r.bytes.toString().replace('0.1.1', '0.1.2')); return { r, zip }; }, /changed after it was signed/],
  ['a zip whose bytes do not match the hash', (k) => { const zip = releaseZip('0.1.1'); const r = release('0.1.1', zip, k); const bad = Buffer.from(zip); bad[bad.length - 30] ^= 0xff; return { r, zip: bad }; }, /does not match the signed release/],
  ['a zip larger than stated', (k) => { const zip = releaseZip('0.1.1'); const r = release('0.1.1', zip, k, { size: zip.length - 100 }); return { r, zip }; }, /larger than the release says/],
  ['an equal version', (k) => { const zip = releaseZip('0.1.0'); return { r: release('0.1.0', zip, k), zip }; }, /newest version \(0\.1\.0\)/],
  ['a lower version', (k) => { const zip = releaseZip('0.0.9'); return { r: release('0.0.9', zip, k), zip }; }, /older than this desk/],
  ['minFrom too high', (k) => { const zip = releaseZip('0.3.0'); return { r: release('0.3.0', zip, k, { minFrom: '0.2.0' }), zip }; }, /only be installed over version 0\.2\.0 or newer/],
  ['a release dated before this build', (k) => { const zip = releaseZip('0.1.1'); return { r: release('0.1.1', zip, k, { date: '2026-11-01T00:00:00Z' }), zip }; }, /dated before the version you have/],
  ['another product', (k) => { const zip = releaseZip('0.1.1'); return { r: release('0.1.1', zip, k, { product: 'other' }), zip }; }, /not an AP Desk release/],
  ['a zip with a ../ entry', (k) => { const zip = releaseZip('0.1.1', { extra: [['apdesk/../../escape.txt', 'x']] }); return { r: release('0.1.1', zip, k), zip }; }, /outside the update folder/],
  ['a zip with an absolute path', (k) => { const zip = releaseZip('0.1.1', { extra: [['/tmp/apd-abs-escape.txt', 'x']] }); return { r: release('0.1.1', zip, k), zip }; }, /absolute path/],
  ['a zip with a symlink', (k) => { const zip = releaseZip('0.1.1', { extra: [['apdesk/app/link', '/etc/passwd', (0o120777 << 16) >>> 0]] }); return { r: release('0.1.1', zip, k), zip }; }, /link/],
  ['a zip of another version', (k) => { const zip = releaseZip('0.1.2'); return { r: release('0.1.1', zip, k), zip }; }, /holds version 0\.1\.2, not 0\.1\.1/],
];
for (const [what, make, reason] of BAD) {
  test(`refused, nothing changed: ${what}`, async () => {
    const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
    const { r, zip } = make(k); s.publish(r, zip);
    const d = await deskFor(root, s, [k]);
    try {
      const before = snapshot(root);
      const run = d.core.updater.install(SETTINGS_TOKEN);
      const asked = await Promise.race([approveWhenAsked(d.core).then(() => true, () => false), run.then(() => false)]);
      const out = await run;
      assert.equal(out.ok, false, what);
      assert.match(out.line, reason, out.line);
      assert.deepEqual(snapshot(root), before, 'the install folder is unchanged');
      assert.ok(!fs.existsSync(path.join(root, 'data', 'update-staged', 'ready.json')), 'nothing staged');
      assert.ok(!fs.existsSync(path.join(root, 'data', 'update-staged', 'next')), 'the unpacked files are removed');
      const stage = path.join(root, 'data', 'update-staged');
      assert.ok(!(fs.existsSync(stage) ? fs.readdirSync(stage) : []).some(n => n.endsWith('.zip') || n.endsWith('.part')), 'a refused download is deleted');
      assert.ok(!fs.existsSync('/tmp/apd-abs-escape.txt') && !fs.existsSync(path.join(root, '..', 'escape.txt')));
      assert.equal(d.desk.restartRequested, null);
      if (/version|minFrom|dated|key|changed|product/.test(what) && !/zip/.test(what)) assert.equal(asked, false, 'refused before the owner is even asked');
    } finally { await d.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('a Git checkout is never changed: the card says git pull and offers no button', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall({ git: true, source: true });
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k, { kind: 'source-zip', name: 'apdesk-source.zip' }), zip, 'apdesk-source.zip');
  const d = await deskFor(root, s, [k]);
  try {
    const before = snapshot(root);
    const st = (await d.call('/api/update/check', { body: {} })).json;
    assert.equal(st.line, 'This copy is a Git checkout. Update it with git pull.');
    assert.equal(st.canInstall, false);
    const out = await d.core.updater.install(SETTINGS_TOKEN);
    assert.equal(out.ok, false); assert.match(out.line, /git pull/);
    assert.deepEqual(snapshot(root), before);
    assert.equal(d.core.approval.listPending().length, 0);
  } finally { await d.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the install is only the owner\'s: no session, a module, a tool call, a wrong token all fail; the door asks at every level and in an auto-approve window', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const desk = await createDesk({ dataDir: path.join(root, 'data'), port: 0, quiet: true, env: {}, modulesDir: path.join(REPO_ROOT, 'tools', 'safety', 'evil-modules') });
  await desk.start();
  const core = desk.core;
  core.updater = new Updater(core, { root, repo: s.repo, hosts: [s.host], keys: [k.entry] });
  const call = (p, { body, session = true } = {}) => fetch(desk.url() + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(session ? { 'x-apd-session': desk.session } : {}) }, body: JSON.stringify(body || {}) });
  try {
    const before = snapshot(root);
    assert.equal((await call('/api/update/install', { session: false })).status, 403, 'a route without the session');
    await assert.rejects(core.updater.install(Symbol('apd.settings.token')), /only from Settings/, 'a wrong token');
    await assert.rejects(core.updater.install(), /only from Settings/, 'no token');
    await core.modules.set('evil', true);
    const ctx = core.modules.api('evil').ctx;
    assert.equal(ctx.updater, undefined, 'a module has no updater');
    await assert.rejects(ctx.fetch(desk.url() + '/api/update/install', { method: 'POST' }), /desk itself/, 'a module cannot call the route');
    // a module (or a tool call) asks the door for a desk update itself and the owner even approves: nothing installs
    ctx.tool({ name: 'evil_update', description: 'probe', parameters: { type: 'object', properties: {} }, async run() { return ctx.approval.request({ action: 'install', title: 'Update AP Desk', payload: { kind: 'desk-update', version: '0.1.1' } }); } });
    const tool = core.modules.runTool('evil_update', {}, { agentId: 'coordinator' });
    await approveWhenAsked(core);
    assert.equal((await tool).ok, true);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(desk.restartRequested, null); assert.deepEqual(snapshot(root), before);
    assert.ok(!fs.existsSync(path.join(root, 'data', 'update-staged', 'ready.json')));

    // the owner's install asks at every level, also inside an auto-approve window, and a "no" changes nothing
    for (const [level, auto] of [['open', 0], ['careful', 0], ['strict', 0], ['open', 60]]) {
      await call('/api/settings/security', { body: { level } }); await call('/api/settings/auto-approve', { body: { window: auto } });
      const run = core.updater.install(SETTINGS_TOKEN);
      const row = await approveWhenAsked(core, { deny: true });
      assert.equal(row.status, 'denied', `${level}${auto ? ' + auto-approve' : ''} asks the owner`);
      const out = await run; assert.equal(out.ok, false); assert.match(out.line, /You said no/);
    }
    // the plain door outside updates is unchanged: an install request is still covered by the window
    const other = await core.approval.request({ action: 'install', title: 'Download a local model', payload: { model: 'x' } });
    assert.equal(other.how, 'auto');
    assert.deepEqual(snapshot(root), before);
  } finally { await desk.stop(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('Offline and Panic: no check leaves the desk, no install starts', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const d = await deskFor(root, s, [k]);
  try {
    d.core.settings.set('online', false);
    let st = (await d.call('/api/update/check', { body: {} })).json;
    assert.match(st.line, /Offline/); assert.equal(s.hits.length, 0);
    let out = await d.core.updater.install(SETTINGS_TOKEN); assert.match(out.line, /Offline/);
    d.core.settings.set('online', true);
    await d.core.panic.stopAll('test');
    out = await d.core.updater.install(SETTINGS_TOKEN); assert.match(out.line, /Everything is stopped/);
    st = await d.core.updater.check(); assert.match(st.line, /Everything is stopped/);
    assert.equal(s.hits.length, 0, 'nothing was fetched while Offline or halted');
    d.core.panic.resume();
    // Panic while the owner is being asked: the request is cancelled and nothing changes
    const before = snapshot(root);
    const run = d.core.updater.install(SETTINGS_TOKEN);
    for (let i = 0; i < 200 && !d.core.approval.listPending().length; i++) await new Promise(r => setTimeout(r, 10));
    await d.core.panic.stopAll('test');
    out = await run; assert.equal(out.ok, false); assert.match(out.line, /Panic/);
    assert.deepEqual(snapshot(root), before);
  } finally { await d.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the daily check: on unless the owner switches it off; one quiet check while Online and not halted', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const d = await deskFor(root, s, [k]);
  try {
    assert.equal((await d.call('/api/update')).json.daily, true, 'on by default');
    assert.equal((await d.call('/api/update/daily', { body: { on: false }, session: false })).status, 403);
    assert.equal((await d.call('/api/settings', { body: { 'update.daily': false } })).json.changed['update.daily'], undefined, 'the plain settings route cannot switch it');
    assert.equal((await d.call('/api/update/daily', { body: { on: false } })).json.daily, false);
    await d.core.updater.tick(); assert.equal(s.hits.length, 0, 'off: no check');
    assert.equal((await d.call('/api/update/daily', { body: { on: true } })).json.daily, true);
    d.core.settings.set('online', false); await d.core.updater.tick(); assert.equal(s.hits.length, 0, 'never while Offline');
    d.core.settings.set('online', true); await d.core.panic.stopAll('test'); await d.core.updater.tick(); assert.equal(s.hits.length, 0, 'never while halted');
    d.core.panic.resume(); await d.core.updater.tick();
    assert.ok(s.hits.length >= 2, 'one check'); const n = s.hits.length;
    await d.core.updater.tick(); assert.equal(s.hits.length, n, 'once a day');
    assert.match(d.core.updater.state().line, /0\.1\.1 is ready/);
  } finally { await d.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('apply: a half-applied update is rolled back and the reason is shown on the next start', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  let d = await deskFor(root, s, [k]);
  try {
    const run = d.core.updater.install(SETTINGS_TOKEN); await approveWhenAsked(d.core); assert.equal((await run).ok, true);
    await d.close(); d = null;
    const before = snapshot(root);
    const { applyStaged } = await import(pathToFileURL(path.join(root, 'setup', 'apply-update.mjs')).href + '?t=' + Date.now());
    const lines = [];
    // app is already swapped when modules cannot be moved in: the disk is full
    const r = applyStaged({ root, data: path.join(root, 'data'), say: (l) => lines.push(l), move: (from, to) => { if (to === path.join(root, 'modules') && from.includes(path.sep + 'next' + path.sep)) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); fs.renameSync(from, to); } });
    assert.equal(r.ok, false);
    assert.deepEqual(snapshot(root), before, 'everything is back as it was');
    assert.match(lines.join('\n'), /The update to 0\.1\.1 could not be applied: .*You are still on 0\.1\.0\./);
    assert.ok(!fs.existsSync(path.join(root, 'data', 'update-staged', 'ready.json')), 'not tried again on every start');
    d = await deskFor(root, s, [k]);
    const st = (await d.call('/api/update')).json;
    assert.match(st.failed || '', /could not be applied: .*You are still on 0\.1\.0\./);
    assert.equal((await d.call('/api/update')).json.failed, null, 'said once');
  } finally { await d?.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('apply: a staged tree that changed after it was checked is not applied', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const d = await deskFor(root, s, [k]);
  try {
    const run = d.core.updater.install(SETTINGS_TOKEN); await approveWhenAsked(d.core); assert.equal((await run).ok, true);
  } finally { await d.close(); }
  try {
    const ready = JSON.parse(fs.readFileSync(path.join(root, 'data', 'update-staged', 'ready.json'), 'utf8'));
    fs.appendFileSync(path.join(root, 'data', 'update-staged', ready.staged, 'app', 'server.js'), '// planted\n');
    const before = snapshot(root);
    const out = runApply(root);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /could not be applied: the downloaded files changed after they were checked/);
    assert.deepEqual(snapshot(root), before);
  } finally { await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('apply: a new version that never started is put back on the next start', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const d = await deskFor(root, s, [k]);
  try { const run = d.core.updater.install(SETTINGS_TOKEN); await approveWhenAsked(d.core); assert.equal((await run).ok, true); } finally { await d.close(); }
  try {
    const old = snapshot(root);
    assert.match(runApply(root).stdout, /updated from 0\.1\.0 to 0\.1\.1/);
    // the new desk crashed before it started: the next start puts the old files back
    const out = runApply(root);
    assert.match(out.stdout, /The new version 0\.1\.1 did not start\. The desk is back on 0\.1\.0\./, out.stdout + out.stderr);
    const now = snapshot(root);
    for (const f of Object.keys(old)) if (!f.startsWith('data/')) assert.equal(now[f], old[f], f);
  } finally { await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the tree hash in apply-update.mjs is the same as the desk\'s', async () => {
  const root = fakeInstall();
  try {
    const { treeHash: applyHash } = await import(pathToFileURL(APPLY).href);
    assert.deepEqual(applyHash(root, ['app', 'modules', 'setup', 'start.bat']), treeHash(root, ['app', 'modules', 'setup', 'start.bat']));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('apply-update.mjs with nothing staged exits 0 at once and prints nothing', () => {
  const root = fakeInstall();
  try {
    const t0 = Date.now(); const out = runApply(root);
    assert.equal(out.status, 0); assert.equal(out.stdout, ''); assert.equal(out.stderr, '');
    assert.ok(Date.now() - t0 < 3000);
    const broken = spawnSync(process.execPath, [path.join(root, 'setup', 'apply-update.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, APD_DATA: path.join(root, 'no', 'such', 'folder') } });
    assert.equal(broken.status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a source download takes the source zip; its own node_modules stay when the release carries none', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall({ source: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'installed');
  const zip = releaseZip('0.1.1', { extra: [['apdesk/package.json', JSON.stringify({ name: 'agent-population-desk', version: '0.1.1' })]] });
  const win = releaseZip('0.1.1', { marker: 'windows' });
  const r = release('0.1.1', zip, k, { kind: 'source-zip', name: 'apdesk-source.zip' });
  // the release lists both files; this install must pick the source zip
  const both = JSON.parse(r.bytes); both.files.unshift({ name: 'agent-population-desk.zip', kind: 'windows-zip', size: win.length, sha256: crypto.createHash('sha256').update(win).digest('hex') });
  const bytes = Buffer.from(JSON.stringify(both)); s.publish({ bytes, sig: crypto.sign(null, bytes, k.privateKey).toString('base64') }, zip, 'apdesk-source.zip'); s.files.set('agent-population-desk.zip', win);
  let d = await deskFor(root, s, [k]);
  try {
    const run = d.core.updater.install(SETTINGS_TOKEN); await approveWhenAsked(d.core); const out = await run;
    assert.equal(out.ok, true, out.line);
    await d.close(); d = null;
    assert.match(runApply(root).stdout, /updated from 0\.1\.0 to 0\.1\.1/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '0.1.1');
    assert.equal(fs.readFileSync(path.join(root, 'app', 'server.js'), 'utf8'), '// new server 0.1.1\n', 'the source zip, not the Windows zip');
    assert.equal(fs.readFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'utf8'), 'installed');
  } finally { await d?.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('apply on Windows: a changed start.bat is not swapped while it runs; a helper swaps it once that window is gone', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const d = await deskFor(root, s, [k]);
  try { const run = d.core.updater.install(SETTINGS_TOKEN); await approveWhenAsked(d.core); assert.equal((await run).ok, true); } finally { await d.close(); }
  try {
    const gone = spawnSync(process.execPath, ['-e', '0']).pid;   // a window that has already closed
    const { applyStaged } = await import(pathToFileURL(path.join(root, 'setup', 'apply-update.mjs')).href + '?w=' + Date.now());
    const lines = [];
    const r = applyStaged({ root, data: path.join(root, 'data'), say: (l) => lines.push(l), platform: 'win32', waitPid: gone });
    assert.equal(r.ok, true, lines.join('\n'));
    assert.match(lines.join('\n'), /new start\.bat is put in place when this window closes/);
    assert.equal(fs.readFileSync(path.join(root, 'app', 'server.js'), 'utf8'), '// new server 0.1.1\n');
    let bat = ''; for (let i = 0; i < 100; i++) { bat = fs.readFileSync(path.join(root, 'start.bat'), 'utf8'); if (bat.includes('new')) break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(bat, 'rem new 0.1.1\r\n', 'swapped by the helper');
    assert.ok(!fs.existsSync(path.join(root, 'start.bat.new')));
  } finally { await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
