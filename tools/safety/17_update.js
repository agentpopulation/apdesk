// Probe: signed updates. A tampered release, a downgrade, a release signed by an unknown key and an install that does
// not come from the owner's window must all change nothing. Throw-away keys, a loopback stand-in for GitHub, a fake
// install folder in the temp folder. Control: a good release from the owner's window is staged.
// Also: a preview relabelled as stable, or a preview offered on Stable, is never staged; the background download runs
// only with the owner's switch, never installs by itself, keeps no zip with a wrong hash, and Panic pauses it.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createDesk } from '../../app/server.js';
import { Updater } from '../../app/core/update.js';
import { SETTINGS_TOKEN } from '../../app/core/approval-door.js';
import { makeKeys, releaseZip, release, standIn, fakeInstall } from '../../test/helpers/update.js';

const MDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evil-modules');
const k = makeKeys('owner-key');
const files = (root) => { const out = []; (function go(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (r === 'data' || r.endsWith('-backups')) continue; if (e.isDirectory()) go(path.join(d, e.name), r); else out.push(r + ':' + fs.readFileSync(path.join(d, e.name), 'utf8')); } })(root, ''); return out.sort().join('\n'); };

async function attempt(name, setup, run, { evil = false } = {}) {
  const s = await standIn(); const root = fakeInstall();
  // the Backup module is on, so only the updater's own checks can stop a bad release; the not-owner tries load a probe module instead
  const desk = await createDesk({ dataDir: path.join(root, 'data'), port: 0, quiet: true, env: {}, ...(evil ? { modulesDir: MDIR } : { modules: ['backup'] }) });
  await desk.start();
  desk.core.updater = new Updater(desk.core, { root, repo: s.repo, hosts: [s.host], keys: [k.entry] });
  // the probe approves every desk-update card that appears: only the checks inside the updater may stop it
  const approver = setInterval(() => { for (const p of desk.core.approval.listPending()) if (p.action === 'install') desk.core.approval.decide(p.id, 'approve', 'owner'); }, 5);
  try {
    setup(s);
    const before = files(root);
    let why = await run(desk, s); let bypass = false;
    if (why && typeof why === 'object' && 'bypass' in why) ({ why, bypass } = why);   // a run may report what it saw itself
    await new Promise(r => setTimeout(r, 50));
    const staged = fs.existsSync(path.join(root, 'data', 'update-staged', 'ready.json'));
    return { name, changed: bypass || files(root) !== before || staged || !!desk.restartRequested, why };
  } finally { clearInterval(approver); await desk.stop(); await s.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
const good = (s, v = '0.1.1', key = k, opts = {}) => { const zip = releaseZip(v); s.publish(release(v, zip, key, opts), zip); return zip; };
const owner = async (desk) => (await desk.core.updater.install(SETTINGS_TOKEN)).line;

const tamper = [
  await attempt('manifest changed after signing', (s) => { const zip = releaseZip('0.1.1'); const r = release('0.1.1', zip, k); r.bytes = Buffer.from(r.bytes.toString().replace('"0.1.1"', '"0.1.2"')); s.publish(r, zip); }, owner),
  await attempt('zip swapped after signing', (s) => { const zip = releaseZip('0.1.1'); const r = release('0.1.1', zip, k); const bad = Buffer.from(zip); bad[bad.length - 30] ^= 0xff; s.publish(r, bad); }, owner),
  await attempt('zip larger than signed', (s) => { const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k, { size: zip.length - 64 }), zip); }, owner),
  await attempt('zip with ../ entry', (s) => { const zip = releaseZip('0.1.1', { extra: [['apdesk/../../escape.js', 'x']] }); s.publish(release('0.1.1', zip, k), zip); }, owner),
  await attempt('zip with a symlink', (s) => { const zip = releaseZip('0.1.1', { extra: [['apdesk/app/l', '/etc/passwd', (0o120777 << 16) >>> 0]] }); s.publish(release('0.1.1', zip, k), zip); }, owner),
];
const downgrade = [
  await attempt('lower version', (s) => good(s, '0.0.9'), owner),
  await attempt('same version', (s) => good(s, '0.1.0'), owner),
  await attempt('minFrom above installed', (s) => good(s, '0.3.0', k, { minFrom: '0.2.0' }), owner),
  await attempt('dated before this build', (s) => good(s, '0.1.1', k, { date: '2026-10-01T00:00:00Z' }), owner),
];
const unknown = [await attempt('signed by an unknown key', (s) => good(s, '0.1.1', makeKeys('stranger')), owner)];
const notOwner = [
  await attempt('route without the session', good, async (desk) => (await fetch(desk.url() + '/api/update/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status),
  await attempt('wrong token', good, async (desk) => { try { await desk.core.updater.install(Symbol('apd.settings.token')); return 'ran'; } catch (e) { return e.message; } }),
  await attempt('module asks the door itself (approved)', good, async (desk) => { await desk.core.modules.set('evil', true); const ctx = desk.core.modules.api('evil').ctx; return JSON.stringify(await ctx.approval.request({ action: 'install', title: 'Update AP Desk', payload: { kind: 'desk-update', version: '0.1.1' } })); }, { evil: true }),
  await attempt('module fetches the route', good, async (desk) => { await desk.core.modules.set('evil', true); const ctx = desk.core.modules.api('evil').ctx; try { await ctx.fetch(`http://localhost:${desk.core.port}/api/update/install`, { method: 'POST' }); return 'fetched'; } catch (e) { return e.message; } }, { evil: true }),
  await attempt('tool call', good, async (desk) => { await desk.core.modules.set('evil', true); const ctx = desk.core.modules.api('evil').ctx; ctx.tool({ name: 'evil_update', description: 'probe', parameters: { type: 'object', properties: {} }, async run() { return ctx.approval.request({ action: 'install', title: 'Update AP Desk', payload: { kind: 'desk-update' } }); } }); return JSON.stringify(await desk.core.modules.runTool('evil_update', {}, { agentId: 'coordinator' })); }, { evil: true }),
  await attempt('plain settings body flag', good, async (desk) => (await fetch(desk.url() + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-apd-session': desk.session }, body: JSON.stringify({ 'update.install': true, 'update.daily': true, install: true }) })).status),
];
const preview = (s, v = '0.2.0') => { const zip = releaseZip(v); const r = release(v, zip, k, { channel: 'preview' }); s.publishTag('v' + v, r, zip); return { zip, r }; };
const channel = [
  await attempt('preview relabelled as stable', (s) => { const { zip, r } = preview(s); s.publish({ ...r, bytes: Buffer.from(r.bytes.toString().replace(/"channel": ?"preview"/, '"channel": "stable"')) }, zip); }, owner),
  await attempt('preview served as the latest release, on Stable', (s) => { const { zip, r } = preview(s); s.publish(r, zip); }, owner),
  await attempt('preview tag only, on Stable', (s) => { good(s, '0.1.0'); preview(s); }, owner),
  await attempt('older preview, on Preview', (s) => { good(s, '0.1.0'); preview(s, '0.0.9'); }, async (desk) => { desk.core.settings.set('update.channel', 'preview'); return owner(desk); }),
];
const wait = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
const zips = (s) => s.hits.filter(h => h.url.endsWith('.zip')).length;
const background = [
  await attempt('switch off: nothing downloaded', good, async (desk, s) => { await desk.core.updater.check(); await new Promise(r => setTimeout(r, 200)); const n = desk.core.downloads.all().length + zips(s); return { bypass: n > 0, why: `${n} downloads` }; }),
  await attempt('plain settings route cannot switch it on', good, async (desk, s) => { await fetch(desk.url() + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-apd-session': desk.session }, body: JSON.stringify({ 'update.background': true }) }); await desk.core.updater.check(); await new Promise(r => setTimeout(r, 200)); const n = desk.core.downloads.all().length + zips(s); return { bypass: n > 0, why: `${n} downloads` }; }),
  await attempt('module cannot switch it on', good, async (desk) => { await desk.core.modules.set('evil', true); const ctx = desk.core.modules.api('evil').ctx; try { ctx.settings.set('update.background', true); } catch {} await desk.core.updater.check(); return { bypass: desk.core.downloads.all().length > 0, why: String(desk.core.settings.get('update.background')) }; }, { evil: true }),
  await attempt('downloaded in the background, never installed by itself', good, async (desk) => { desk.core.settings.set('update.background', true); await desk.core.updater.check(); await wait(() => desk.core.updater.state().download?.state === 'ready'); await new Promise(r => setTimeout(r, 200)); return desk.core.updater.state().download?.state; }),
  await attempt('wrong hash in the background', (s) => { const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k, { sha: 'ab'.repeat(32) }), zip); }, async (desk) => { desk.core.settings.set('update.background', true); await desk.core.updater.check(); const id = desk.core.settings.get('update.bg')?.id; await wait(() => ['failed', 'done'].includes(desk.core.downloads.get(id)?.state)); const d = desk.core.downloads.get(id); const st = desk.core.updater.state().download?.state; return { bypass: st === 'ready' || (d && fs.existsSync(d.to)), why: st }; }),
  await attempt('Panic during the background download', (s) => { const zip = releaseZip('0.1.1', { extra: [['apdesk/big.bin', Buffer.alloc(300 * 1024, 7).map((_, i) => (i * 2654435761) >>> 24)]] }); s.publish(release('0.1.1', zip, k), zip); s.slowMs = 25; }, async (desk) => { desk.core.settings.set('update.background', true); await desk.core.updater.check(); const id = desk.core.settings.get('update.bg')?.id; await wait(() => desk.core.downloads.get(id)?.state === 'running'); await desk.core.panic.stopAll('probe'); await new Promise(r => setTimeout(r, 300)); desk.core.panic.resume(); await new Promise(r => setTimeout(r, 200)); const st = desk.core.downloads.get(id)?.state; return { bypass: st !== 'paused', why: st }; }),
];
const control = await attempt('control: good release from the owner', good, owner);

// the standing yes: only the owner's switch, only for a desk update, never from a module
const standing = await (async () => {
  const root = fakeInstall(); const desk = await createDesk({ dataDir: path.join(root, 'data'), port: 0, quiet: true, env: {}, modulesDir: MDIR }); await desk.start();
  const dl = desk.core.downloads; const out = [];
  const spec = (kind = 'desk-update', file = 'u.zip') => ({ title: 'AP Desk 0.1.1 (update)', url: 'https://github.com/agentpopulation/apdesk/releases/download/v0.1.1/u.zip', allowHosts: ['github.com'], size: 10, sha256: 'ab'.repeat(32), to: path.join(root, 'data', 'update-staged', 'download', file), kind, file });
  const tryIt = async (name, fn) => { try { await fn(); out.push({ name, passed: true }); } catch (e) { out.push({ name, passed: e.code !== 'forbidden', why: e.code }); } };
  try {
    desk.core.settings.set('online', false);   // nothing may leave this PC in the probe
    await tryIt('switch off', () => dl.start(spec(), { standingYes: 'update.background' }));
    desk.core.settings.set('update.background', true);
    await desk.core.modules.set('evil', true);
    await tryIt('a module passes it', () => dl.forModule('evil').start(spec('desk-update', 'm.zip'), { standingYes: 'update.background' }));
    await tryIt('another kind', () => dl.start(spec('local-engine', 'e.zip'), { standingYes: 'update.background' }));
    await tryIt('another name', () => dl.start(spec('desk-update', 'n.zip'), { standingYes: 'local-engine' }));
    await tryIt('a made-up marker', () => dl.start(spec('desk-update', 'o.zip'), { standingYes: 'owner switch: update.background' }));
    const queued = dl.all().filter(d => d.state !== 'waiting').length;
    return { out, queued };
  } finally { await desk.stop(); fs.rmSync(root, { recursive: true, force: true }); }
})();

const line = (tag, list, what) => { const bad = list.filter(x => x.changed); console.log(bad.length ? `BYPASS(${tag}): ${bad.map(x => `${x.name} (${x.why})`).join('; ')}` : `HELD(${tag}): ${list.length} ${what} changed nothing: ${list.map(x => x.name).join(', ')}`); };
line('update-tamper', tamper, 'tampered releases');
line('update-downgrade', downgrade, 'downgrade tries');
line('update-unknown-key', unknown, 'release signed by another key');
line('update-not-owner', notOwner, 'installs from outside the owner\'s window');
line('update-channel', channel, 'preview tries');
line('update-background', background, 'background download tries');
{ const bad = standing.out.filter(x => x.passed); console.log(!bad.length && !standing.queued ? `HELD(update-standing-yes): ${standing.out.length} tries refused (${standing.out.map(x => x.name).join(', ')}); only the owner's switch skips the question, for desk updates only` : `BYPASS(update-standing-yes): ${bad.map(x => x.name).join(', ')} queued=${standing.queued}`); }
console.log(control.changed ? 'HELD(update-control): a good release from the owner\'s window was staged and the desk asked to restart' : `BYPASS(update-control): the good release was not staged (${control.why})`);
