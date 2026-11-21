// The shell's own routes and start-up lines: the pairing code shown only in the owner's window, the app manifest,
// Home's Finished count, and the code kept out of the log when the desk runs hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testDesk } from './helpers/desk.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };   // what a browser sends for the page's own fetch

test('pairing code: only the paired owner window gets it; no session, an unpaired browser, a cross-site page and a module fetch are refused', async () => {
  const t = await testDesk({ pairing: true });
  try {
    const first = await fetch(t.base + '/', { redirect: 'manual' }); const cookie = (first.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^apd_owner=/);
    const ask = (headers) => fetch(t.base + '/api/security/pair-code', { method: 'POST', headers });
    // the owner's window: session, paired cookie, a same-origin browser fetch
    const ok = await ask({ 'x-apd-session': t.desk.session, cookie, ...PAGE });
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
    const j = await ok.json();
    assert.equal(j.code, t.desk.pairCode); assert.equal(j.address, t.base); assert.equal(j.seconds, 60);
    // no session (another program, or a page that guessed the cookie)
    assert.equal((await ask({ cookie, ...PAGE })).status, 403, 'no session');
    // a browser that is not paired, even with the session
    assert.equal((await ask({ 'x-apd-session': t.desk.session, ...PAGE })).status, 401, 'not paired');
    // a cross-site request
    assert.equal((await ask({ 'x-apd-session': t.desk.session, cookie, ...PAGE, 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site');
    assert.equal((await ask({ 'x-apd-session': t.desk.session, cookie, ...PAGE, 'sec-fetch-site': 'same-site' })).status, 403, 'same-site, another port');
    // a module's fetch (server side: no browser fetch metadata), even holding the session and the cookie
    const mod = await ask({ 'x-apd-session': t.desk.session, cookie });
    assert.equal(mod.status, 403, 'a fetch that is not the page'); assert.ok(!(await mod.text()).includes(t.desk.pairCode));
    // a navigation or a frame is not the page's own fetch either
    assert.equal((await ask({ 'x-apd-session': t.desk.session, cookie, ...PAGE, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status, 403, 'navigation');
    // a GET is not a route
    assert.equal((await fetch(t.base + '/api/security/pair-code', { headers: { 'x-apd-session': t.desk.session, cookie, ...PAGE } })).status, 404);
    // the activity log says it was shown, never the code
    const act = JSON.stringify((await (await fetch(t.base + '/api/activity', { headers: { 'x-apd-session': t.desk.session, cookie } })).json()));
    assert.match(act, /code to pair another browser was shown/i); assert.ok(!act.includes(t.desk.pairCode));
    // pairing itself is unchanged: the code still pairs a second browser
    const post = await fetch(t.base + '/pair', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=' + j.code, redirect: 'manual' });
    assert.equal(post.status, 303);
  } finally { await t.close(); }
});

test('pairing code: a desk without pairing has no code to show', async () => {
  const t = await testDesk();
  try { assert.equal((await t.call('/api/security/pair-code', { method: 'POST', headers: PAGE })).status, 409); } finally { await t.close(); }
});

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function startLines(extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-lines-')); const port = await freePort();
  const p = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'app', 'server.js')], { cwd: ROOT, env: { ...process.env, APD_DATA: dataDir, APD_PORT: String(port), APD_BACKGROUND: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('the desk did not start: ' + out)), 30000);
      const on = (d) => { out += d; if (/browser/.test(out) && /AP Desk .* on http/.test(out)) { clearTimeout(to); setTimeout(resolve, 200); } };
      p.stdout.on('data', on); p.stderr.on('data', on); p.on('exit', () => { clearTimeout(to); resolve(); });
    });
  } finally { p.kill(); await new Promise(r => p.exitCode != null ? r() : p.on('exit', r)); fs.rmSync(dataDir, { recursive: true, force: true }); }
  return out;
}

test('start lines: in a window the code is printed; run hidden (APD_BACKGROUND=1) it stays out of the log', async () => {
  const shown = await startLines({});
  assert.match(shown, /type this code there: \d{3} \d{3}/);
  const hidden = await startLines({ APD_BACKGROUND: '1' });
  assert.match(hidden, /To open the desk in another browser, use Show code in Settings › Security\./);
  assert.doesNotMatch(hidden, /\b\d{3} \d{3}\b/, 'no code in the hidden desk\'s lines');
});

test('background runner: the desk it starts is marked as hidden', () => {
  const src = fs.readFileSync(path.join(ROOT, 'setup', 'background.mjs'), 'utf8');
  assert.match(src, /runOnce\(\['--no-warnings', path\.join\(ROOT, 'app', 'server\.js'\)\], log, \{ APD_BACKGROUND: '1' \}\)/, 'the mark goes to the server run only');
});

test('install as app: the manifest and its icons need no session or paired browser; the page links the manifest', async () => {
  const t = await testDesk({ pairing: true });
  try {
    await fetch(t.base + '/');   // the owner's browser is paired; what follows comes from a browser with no cookie
    const m = await fetch(t.base + '/manifest.webmanifest');
    assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
    const j = await m.json();
    assert.equal(j.name, 'AP Desk'); assert.equal(j.start_url, '/'); assert.equal(j.scope, '/'); assert.equal(j.display, 'standalone');
    assert.ok(j.icons.some(i => i.type === 'image/png' && /256x256/.test(i.sizes)) && j.icons.some(i => i.type === 'image/svg+xml'));
    for (const i of j.icons) { const r = await fetch(t.base + i.src); assert.equal(r.status, 200, i.src); assert.equal(r.headers.get('content-type'), i.type); }
    assert.ok(!JSON.stringify(j).includes(t.desk.session));
    assert.equal((await fetch(t.base + '/icons/../server.js')).status, 404);
    const page = await fetch(t.base + '/', { headers: { cookie: 'x=1' } });   // the pairing page: no manifest needed there
    assert.equal(page.status, 200);
    assert.match(fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8'), /<link rel="manifest" href="\/manifest\.webmanifest">/);
  } finally { await t.close(); }
});

test('Home: Finished counts only work the owner asked for, not the desk\'s quiet jobs', async () => {
  const t = await testDesk();
  try {
    for (let i = 0; i < 3; i++) { const j = await t.core.jobs.start({ kind: 'upkeep', title: 'Quiet ' + i, quiet: true, run: async () => ({}) }); await t.core.jobs.wait(j.id, 3000); }
    const mine = await t.core.jobs.start({ kind: 'research.deep', title: 'Mine', run: async () => ({}) }); await t.core.jobs.wait(mine.id, 3000);
    const home = (await t.call('/api/home')).json;
    assert.equal(home.jobs.summary.done, 1);
    assert.equal(t.core.jobs.summary().done, 4, 'the core summary is unchanged');
    assert.equal(home.jobs.summary.running, t.core.jobs.summary().running);
  } finally { await t.close(); }
});
