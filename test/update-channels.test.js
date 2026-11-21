// Signed updates, part two (contracts/UPDATES.md): the daily check, Stable and Preview, release notes as text, and the
// background download through the downloads service. Throw-away keys, a loopback stand-in for GitHub, a fake install
// folder in the temp folder: the repository itself is never changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';
import { makeKeys, releaseZip, release, standIn, fakeInstall, sign } from './helpers/update.js';
import { createDesk } from '../app/server.js';
import { Updater } from '../app/core/update.js';
import { SETTINGS_TOKEN } from '../app/core/approval-door.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function deskFor(root, s, keys) {
  const desk = await createDesk({ dataDir: path.join(root, 'data'), port: 0, quiet: true, env: {}, modules: ['backup'] });
  await desk.start();
  const make = () => new Updater(desk.core, { root, repo: s?.repo, hosts: s ? [s.host] : undefined, keys: keys.map(k => k.entry) });
  desk.core.updater = make();
  const call = async (p, { body, session = true } = {}) => {
    const r = await fetch(desk.url() + p, { method: body !== undefined ? 'POST' : 'GET', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session ? { 'x-apd-session': desk.session } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
  };
  return { desk, core: desk.core, call, make, async close() { await desk.stop(); } };
}
function snapshot(root) {
  const out = {};
  (function go(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (r === 'data' || r.endsWith('-backups')) continue; const p = path.join(d, e.name); if (e.isDirectory()) go(p, r); else out[r] = fs.readFileSync(p, 'utf8'); } })(root, '');
  return out;
}
const pendingUpdate = (core) => core.approval.listPending().find(a => a.action === 'install' && a.payload?.kind === 'desk-update');
async function decideWhenAsked(core, decision) {
  for (let i = 0; i < 300; i++) { const p = pendingUpdate(core); if (p) return core.approval.decide(p.id, decision, 'owner'); await sleep(10); }
  throw new Error('the update never asked');
}
async function until(fn, what, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(20); } throw new Error('timed out waiting: ' + what); }
const cleanup = async (d, s, root) => { await d.close(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); };
const zipHits = (s) => s.hits.filter(h => h.url.endsWith('.zip')).length;

// ---------- 1. the daily check
test('daily check: finds a signed newer release, stores when and what, and tells the page with an update event', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const d = await deskFor(root, s, [k]);
  const seen = []; const off = d.core.events.on((type, data) => { if (type === 'update') seen.push(data); });
  try {
    await d.core.updater.tick();
    const st = (await d.call('/api/update')).json;
    assert.match(st.line, /^Version 0\.1\.1 is ready/); assert.equal(st.release.version, '0.1.1'); assert.ok(st.checkedAt);
    assert.equal(st.canInstall, true); assert.equal(st.release.channel, 'stable', 'a manifest without a channel counts as stable');
    assert.ok(seen.some(x => x.release?.version === '0.1.1'), 'an update event carries the result');
    assert.equal(d.core.settings.get('update.last').release.version, '0.1.1', 'the result is stored');
    // a restart: the stored result is shown without asking GitHub again
    const n = s.hits.length; d.core.updater = d.make();
    const again = (await d.call('/api/update')).json;
    assert.equal(again.release.version, '0.1.1'); assert.equal(again.checkedAt, st.checkedAt); assert.equal(s.hits.length, n);
    assert.equal(zipHits(s), 0, 'a check downloads nothing');
  } finally { off(); await cleanup(d, s, root); }
});

test('daily check: an unsigned release and a wrongly signed one are not offered', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); const r = release('0.1.1', zip, k);
  const d = await deskFor(root, s, [k]);
  try {
    s.publish({ ...r, sig: '' }, zip);
    await d.core.updater.tick();
    let st = d.core.updater.state();
    assert.equal(st.canInstall, false); assert.equal(st.release, null); assert.match(st.line, /changed after it was signed/);
    d.core.settings.set('update.lastDailyCheck', null);
    s.publish(release('0.1.1', zip, makeKeys('stranger')), zip);
    await d.core.updater.tick();
    st = d.core.updater.state();
    assert.equal(st.canInstall, false); assert.match(st.line, /key this desk does not know/);
    assert.equal(zipHits(s), 0);
  } finally { await cleanup(d, s, root); }
});

test('daily check: no check at all with no key, while Offline, or after Panic', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const none = await deskFor(root, s, []);
  try {
    await none.core.updater.tick(); assert.equal(s.hits.length, 0, 'no key: GitHub is never asked');
    assert.equal(none.core.updater.state().line, 'Updates are not set up in this build.');
  } finally { await none.close(); }
  const d = await deskFor(root, s, [k]);
  try {
    d.core.settings.set('online', false); await d.core.updater.tick(); assert.equal(s.hits.length, 0, 'Offline');
    d.core.settings.set('online', true); await d.core.panic.stopAll('test');
    await d.core.updater.tick(); assert.equal(s.hits.length, 0, 'halted by Panic');
    assert.match((await d.core.updater.check()).line, /Everything is stopped/); assert.equal(s.hits.length, 0);
  } finally { await cleanup(d, s, root); }
});

// ---------- 2. Stable and Preview
test('channels: a preview is not offered on Stable and is offered on Preview; the owner-only route switches it', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const cur = releaseZip('0.1.0'); s.publish(release('0.1.0', cur, k), cur);                 // the latest full release is this desk's version
  const pre = releaseZip('0.2.0'); s.publishTag('v0.2.0', release('0.2.0', pre, k, { channel: 'preview', notes: ['A test version.'] }), pre);
  const d = await deskFor(root, s, [k]);
  try {
    let st = (await d.call('/api/update/check', { body: {} })).json;
    assert.equal(st.channel, 'stable', 'Stable by default');
    assert.match(st.line, /newest version \(0\.1\.0\)/); assert.equal(st.canInstall, false);
    assert.ok(!s.hits.some(h => h.url.endsWith('releases.atom')), 'Stable does not even look at pre-releases');
    assert.equal((await d.call('/api/update/channel', { body: { channel: 'preview' }, session: false })).status, 403);
    assert.equal((await d.call('/api/settings', { body: { 'update.channel': 'preview' } })).json.changed['update.channel'], undefined);
    assert.equal((await d.call('/api/update/channel', { body: { channel: 'beta' } })).status, 400);
    st = (await d.call('/api/update/channel', { body: { channel: 'preview' } })).json;
    assert.equal(st.channel, 'preview'); assert.equal(st.release, null, 'switching forgets the old result');
    st = (await d.call('/api/update/check', { body: {} })).json;
    assert.match(st.line, /^Preview version 0\.2\.0 is ready/); assert.equal(st.release.channel, 'preview'); assert.deepEqual(st.release.notes, ['A test version.']);
    // installing the preview takes the file under its own tag, and still asks
    const run = d.core.updater.install(SETTINGS_TOKEN);
    const row = await decideWhenAsked(d.core, 'approve'); assert.equal(row.payload.version, '0.2.0');
    const out = await run; assert.equal(out.ok, true, out.line);
    assert.ok(s.hits.some(h => h.url === '/agentpopulation/apdesk/releases/download/v0.2.0/agent-population-desk.zip'));
    // a preview served as the latest full release is still a preview: Stable never takes it
    const s2 = await standIn(); const root2 = fakeInstall();
    s2.publish(release('0.2.0', pre, k, { channel: 'preview' }), pre);
    const d2 = await deskFor(root2, s2, [k]);
    try {
      st = (await d2.call('/api/update/check', { body: {} })).json;
      assert.match(st.line, /0\.2\.0 is a preview\. You get stable versions only/); assert.equal(st.canInstall, false);
    } finally { await cleanup(d2, s2, root2); }
  } finally { await cleanup(d, s, root); }
});

test('channels: a preview relabelled as stable fails the signature; an unknown channel is refused', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const pre = releaseZip('0.2.0'); const r = release('0.2.0', pre, k, { channel: 'preview' });
  const relabelled = Buffer.from(r.bytes.toString().replace(/"channel": ?"preview"/, '"channel": "stable"'));
  assert.notDeepEqual(relabelled, r.bytes);
  s.publish({ ...r, bytes: relabelled }, pre);
  const d = await deskFor(root, s, [k]);
  try {
    let st = (await d.call('/api/update/check', { body: {} })).json;
    assert.match(st.line, /changed after it was signed/); assert.equal(st.canInstall, false);
    const before = snapshot(root);
    const out = await d.core.updater.install(SETTINGS_TOKEN); assert.equal(out.ok, false); assert.match(out.line, /changed after it was signed/);
    assert.equal(pendingUpdate(d.core), undefined, 'refused before the owner is asked'); assert.deepEqual(snapshot(root), before);
    // signed, but a channel the desk does not know
    const odd = { product: 'apdesk', version: '0.2.0', date: '2026-11-21T10:00:00.000Z', key: k.id, channel: 'nightly', notes: [], minFrom: '0.1.0', files: [{ name: 'agent-population-desk.zip', kind: 'windows-zip', size: pre.length, sha256: crypto.createHash('sha256').update(pre).digest('hex') }] };
    const bytes = Buffer.from(JSON.stringify(odd)); s.publish({ bytes, sig: sign(bytes, k) }, pre);
    st = (await d.call('/api/update/check', { body: {} })).json;
    assert.match(st.line, /channel the desk does not know/); assert.equal(st.canInstall, false);
  } finally { await cleanup(d, s, root); }
});

test('channels: no downgrade and no same version, on Stable or on Preview', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const same = releaseZip('0.1.0'); s.publish(release('0.1.0', same, k), same);
  const low = releaseZip('0.0.9'); s.publishTag('v0.0.9', release('0.0.9', low, k, { channel: 'preview' }), low);
  s.publishTag('v0.1.0', release('0.1.0', same, k, { channel: 'preview' }), same);
  const d = await deskFor(root, s, [k]);
  try {
    for (const channel of ['stable', 'preview']) {
      await d.call('/api/update/channel', { body: { channel } });
      const st = (await d.call('/api/update/check', { body: {} })).json;
      assert.equal(st.canInstall, false, channel); assert.match(st.line, /newest version \(0\.1\.0\)/, channel);
      const out = await d.core.updater.install(SETTINGS_TOKEN); assert.equal(out.ok, false, channel);
    }
    assert.ok(s.hits.some(h => h.url.endsWith('/download/v0.0.9/apdesk-update.json')), 'the lower preview was looked at');
    assert.equal(zipHits(s), 0); assert.equal(pendingUpdate(d.core), undefined);
  } finally { await cleanup(d, s, root); }
});

// ---------- 3. what changed
test('notes: signed, size-limited, plain text; a <script> in the notes stays text on the Updates card', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const evil = '<script>window.ran = 1</script><img src=x onerror="window.ran = 2">';
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k, { notes: [evil, 'Plain line.', 'x'.repeat(900), ...Array.from({ length: 40 }, (_, i) => `n${i}`)] }), zip);
  const d = await deskFor(root, s, [k]);
  try {
    const st = (await d.call('/api/update/check', { body: {} })).json;
    assert.equal(st.release.notes[0], evil, 'kept as the text it is');
    assert.equal(st.release.notes.length, 30); assert.equal(st.release.notes[2].length, 300);
    // the card, rendered with the shell's own kit in a DOM without a browser
    const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="toasts"></div><main></main></body></html>');
    Object.assign(globalThis, { document, Node: window.Node, window });
    const kit = await import(pathToFileURL(path.join(REPO_ROOT, 'app', 'ui', 'kit.js')).href);
    const { updatesSection } = await import(pathToFileURL(path.join(REPO_ROOT, 'modules', 'backup', 'ui.js')).href);
    const el = document.querySelector('main');
    await updatesSection(el, { ...kit, api: async () => st, on: () => () => {} });
    const box = el.querySelector('[data-update-notes]');
    assert.ok(box, 'the notes are shown before Update now'); assert.ok(el.querySelector('#upd-install'));
    assert.equal(el.querySelectorAll('script').length, 0); assert.equal(el.querySelectorAll('img').length, 0);
    assert.equal(box.querySelector('li').textContent, evil);
    assert.equal(window.ran, undefined);
  } finally { await cleanup(d, s, root); }
});

// ---------- 4. the background download
test('background: off by default; on only through the owner\'s switch; then the zip is in the downloads list, checked, and install still asks', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
  const d = await deskFor(root, s, [k]);
  try {
    let st = (await d.call('/api/update/check', { body: {} })).json;
    assert.equal(st.background, false); assert.equal(st.download, null);
    await sleep(100); assert.equal(zipHits(s), 0, 'off: nothing is downloaded');
    assert.equal((await d.call('/api/downloads')).json.downloads.length, 0);
    assert.equal((await d.call('/api/update/background', { body: { on: true }, session: false })).status, 403);
    assert.equal((await d.call('/api/settings', { body: { 'update.background': true } })).json.changed['update.background'], undefined, 'the plain settings route cannot switch it');
    assert.notEqual(d.core.settings.get('update.background'), true);

    st = (await d.call('/api/update/background', { body: { on: true } })).json;
    assert.equal(st.background, true);
    const list = (await d.call('/api/downloads')).json.downloads;
    assert.equal(list.length, 1); assert.equal(list[0].kind, 'desk-update'); assert.match(list[0].title, /AP Desk 0\.1\.1/);
    assert.equal(d.core.approval.listPending().length, 0, 'the switch is the yes for the download: no card for it');
    await until(async () => (await d.call('/api/update')).json.download?.state === 'ready', 'the download is checked');
    st = (await d.call('/api/update')).json;
    assert.match(st.download.line, /downloaded and checked\. Installing it still asks you/);
    const act = d.core.approval.activityList(50).map(a => a.title).join('\n');
    assert.match(act, /Download updates in the background: on/); assert.match(act, /Downloading AP Desk 0\.1\.1 \(update\) in the background/);
    assert.equal(d.core.downloads.get(list[0].id).approvalId, 'owner switch: update.background', 'the switch is recorded in place of an approval');
    assert.ok(!fs.existsSync(path.join(root, 'data', 'update-staged', 'ready.json')), 'downloaded, never installed by itself');
    assert.equal(d.desk.restartRequested, null);

    // install asks even inside an auto-approve window; a no changes nothing and keeps the file
    await d.call('/api/settings/auto-approve', { body: { window: 60 } });
    const before = snapshot(root); const hits = zipHits(s);
    let run = d.core.updater.install(SETTINGS_TOKEN);
    assert.equal((await decideWhenAsked(d.core, 'deny')).status, 'denied');
    assert.match((await run).line, /You said no/); assert.deepEqual(snapshot(root), before);
    assert.equal((await d.call('/api/update')).json.download.state, 'ready');
    // a yes uses the file already downloaded (checked again), not a second download
    run = d.core.updater.install(SETTINGS_TOKEN);
    const row = await decideWhenAsked(d.core, 'approve'); assert.equal(row.how, 'owner'); assert.equal(row.status, 'approved');
    const out = await run; assert.equal(out.ok, true, out.line);
    assert.equal(zipHits(s), hits, 'no second download');
    assert.ok(fs.existsSync(path.join(root, 'data', 'update-staged', 'ready.json')));
  } finally { await cleanup(d, s, root); }
});

test('background: Panic pauses the download, and it stays paused until the owner resumes it', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1', { extra: [['apdesk/big.bin', crypto.randomBytes(400 * 1024)]] }); s.publish(release('0.1.1', zip, k), zip);
  s.slowMs = 25;
  const d = await deskFor(root, s, [k]);
  try {
    await d.call('/api/update/background', { body: { on: true } });
    await d.call('/api/update/check', { body: {} });
    const dl = d.core.downloads;
    const id = d.core.settings.get('update.bg').id;
    await until(() => dl.get(id)?.state === 'running' && dl.get(id).done > 0, 'running');
    await d.core.panic.stopAll('test');
    await until(() => dl.get(id)?.state === 'paused', 'paused');
    assert.match(dl.get(id).reason, /Panic/);
    assert.equal((await d.call('/api/update')).json.download.state, 'paused');
    d.core.panic.resume(); await sleep(200);
    assert.equal(dl.get(id).state, 'paused', 'Resume after Panic does not restart it by itself');
    s.slowMs = 0;
    assert.equal((await d.call(`/api/downloads/${id}/resume`, { body: {} })).status, 200);
    assert.equal(d.core.approval.listPending().length, 0, 'the owner\'s Resume goes on without a new card');
    await until(async () => (await d.call('/api/update')).json.download?.state === 'ready', 'done after resume', 15000);
    // switching it off cancels and forgets the download and its file
    const file = dl.get(id).to;
    await d.call('/api/update/background', { body: { on: false } });
    assert.equal(dl.get(id), null); assert.ok(!fs.existsSync(file)); assert.equal((await d.call('/api/update')).json.download, null);
  } finally { await cleanup(d, s, root); }
});

test('background: a zip with the wrong hash is deleted and never offered; installing refuses it too', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1'); const other = releaseZip('0.1.1', { marker: 'other' });
  s.publish(release('0.1.1', zip, k, { sha: crypto.createHash('sha256').update(other).digest('hex') }), zip);
  const d = await deskFor(root, s, [k]);
  try {
    await d.call('/api/update/background', { body: { on: true } });
    await d.call('/api/update/check', { body: {} });
    const id = d.core.settings.get('update.bg').id;
    await until(() => ['failed', 'done'].includes(d.core.downloads.get(id)?.state), 'finished');
    assert.equal(d.core.downloads.get(id).state, 'failed'); assert.match(d.core.downloads.get(id).reason, /SHA-256/);
    const st = (await d.call('/api/update')).json;
    assert.notEqual(st.download.state, 'ready'); assert.match(st.download.line, /could not be downloaded/);
    assert.ok(!fs.existsSync(d.core.downloads.get(id).to)); assert.ok(!fs.existsSync(d.core.downloads.get(id).to + '.part'));
    const before = snapshot(root);
    const run = d.core.updater.install(SETTINGS_TOKEN); await decideWhenAsked(d.core, 'approve');
    const out = await run; assert.equal(out.ok, false); assert.match(out.line, /does not match the signed release/);
    assert.deepEqual(snapshot(root), before); assert.ok(!fs.existsSync(path.join(root, 'data', 'update-staged', 'ready.json')));
  } finally { await cleanup(d, s, root); }
});

test('background: a download the owner cancels in the downloads list is not fetched again for that version', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const zip = releaseZip('0.1.1', { extra: [['apdesk/big.bin', crypto.randomBytes(200 * 1024)]] }); s.publish(release('0.1.1', zip, k), zip);
  s.slowMs = 25;
  const d = await deskFor(root, s, [k]);
  try {
    await d.call('/api/update/background', { body: { on: true } });
    await d.call('/api/update/check', { body: {} });
    const id = d.core.settings.get('update.bg').id;
    assert.equal((await d.call(`/api/downloads/${id}/cancel`, { body: {} })).status, 200);
    assert.equal(d.core.downloads.get(id).state, 'cancelled');
    await d.call('/api/update/check', { body: {} });
    assert.equal(d.core.downloads.get(id).state, 'cancelled', 'not started again');
    assert.match((await d.call('/api/update')).json.download.line, /was cancelled/);
  } finally { await cleanup(d, s, root); }
});
