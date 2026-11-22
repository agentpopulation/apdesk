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

// ---- the agent tracker's lists (app/ui/tracker-data.js): plain functions, fed by the desk's 'job' events
import { mergeJob, todoLists, runningCount, timeLeft, agentsNow, needsYou, updateReady, jobWho, popShowsDownloads, deskNow, whoAsks } from '../app/ui/tracker-data.js';
const NOW = Date.parse('2026-11-21T10:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const JOBS = [
  { id: 'a', title: 'Deep research', status: 'running', progress: 0.4, agentId: 'scout', created: ago(5), updated: ago(1) },
  { id: 'b', title: 'Lead list', status: 'waiting', agentId: 'closer', detail: 'Waiting for your approval: Send', created: ago(9), updated: ago(2) },
  { id: 'c', title: 'Old report', status: 'done', created: ago(200), finished: ago(120) },
  { id: 'd', title: 'Brief', status: 'done', created: ago(30), finished: ago(20) },
  { id: 'e', title: 'Tidy', status: 'running', quiet: true, created: ago(3) },
  { id: 'f', title: 'Upkeep failed', status: 'failed', quiet: true, created: ago(3), finished: ago(2) },
  { id: 'g', title: 'Next up', status: 'queued', created: ago(1) },
  { id: 'h', title: 'Stopped one', status: 'stopped', created: ago(10), finished: ago(8) },
];

test('tracker: the to-do list is queued, running, waiting for you and ended in the last hour; the desk\'s quiet upkeep only when it failed', () => {
  const l = todoLists(JOBS, NOW);
  assert.deepEqual(l.queued.map(j => j.id), ['g']);
  assert.deepEqual(l.running.map(j => j.id), ['a']);
  assert.deepEqual(l.waiting.map(j => j.id), ['b']);
  assert.deepEqual(l.done.map(j => j.id), ['f', 'h', 'd'], 'newest first, nothing older than an hour');
  assert.equal(runningCount(JOBS), 1);
});

test('tracker: a job event replaces the stored job; the map keeps the latest', () => {
  const m = new Map(); mergeJob(m, JOBS[0]); mergeJob(m, { ...JOBS[0], status: 'done', finished: ago(0) }); mergeJob(m, null); mergeJob(m, {});
  assert.equal(m.size, 1); assert.equal(m.get('a').status, 'done');
});

test('tracker: time left only where the job says it, a dash otherwise', () => {
  assert.equal(timeLeft({ status: 'running' }), '–');
  assert.equal(timeLeft({ status: 'running', secondsLeft: 30 }), 'under a minute left');
  assert.equal(timeLeft({ status: 'running', secondsLeft: 600 }), 'about 10 min left');
  assert.equal(timeLeft({ status: 'done', secondsLeft: 600 }), '–');
});

test('tracker: each agent says what it is doing now', () => {
  const a = agentsNow([{ id: 'scout', name: 'Scout' }, { id: 'closer', name: 'Closer' }, { id: 'coder', name: 'Coder' }], JOBS);
  assert.deepEqual(a.map(x => [x.name, x.busy, x.text]), [['Scout', true, 'Deep research'], ['Closer', true, 'Waiting for you: Lead list'], ['Coder', false, 'Not working on anything']]);
});

test('tracker: each agent line shows its own avatar, drawn by the Agents page\'s helper', () => {
  const a = agentsNow([{ id: 'scout', name: 'Scout', avatar: { look: 'owl', colour: 'teal' } }, { id: 'coder', name: 'Coder' }], []);
  assert.deepEqual(a.map(x => x.avatar), [{ look: 'owl', colour: 'teal' }, null]);
  const page = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'pages', 'tracker.js'), 'utf8');
  assert.match(page, /import\('\/modules\/agents\/ui\.js'\)/, 'the helper is loaded, and a desk without it keeps the plain line');
  assert.match(page, /avatarEl\?\.\(a, 's'[,)]|avatarEl \? avatarEl\(a, 's'[,)]/);
});

test('tracker: a running job with no agent is the desk\'s own work and is said so; quiet upkeep and agents\' jobs are not', () => {
  assert.equal(deskNow(JOBS).busy, false, 'only an agent\'s job and quiet upkeep run');
  const more = [...JOBS, { id: 'i', title: 'Get the maps pack', status: 'running', created: ago(2) }, { id: 'j', title: 'Older desk job', status: 'running', created: ago(4) }, { id: 'k', title: 'Asks first', status: 'waiting', created: ago(1) }];
  assert.deepEqual(deskNow(more), { busy: true, job: more[8], more: 1, text: 'The desk is working: Get the maps pack' });
  const src = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'pages', 'tracker.js'), 'utf8');
  assert.match(src, /deskNow\(/, 'the Tracker pop-up and page say what the desk itself is doing');
});

test('tracker: a job or agent with no known name shows a plain word, never its id', () => {
  const agents = [{ id: 'scout', name: 'Scout' }, { id: 'k3x9f0ab1c2d' }];
  assert.equal(jobWho(agents, { agentId: 'scout' }), 'Scout');
  assert.equal(jobWho(agents, { agentId: 'zz8q2m4n7p1r' }), 'An agent');
  assert.equal(jobWho(agents, { agentId: 'k3x9f0ab1c2d' }), 'An agent');
  assert.equal(jobWho(agents, {}), 'The desk');
  const a = agentsNow(agents, []);
  assert.deepEqual(a.map(x => x.name), ['Scout', 'An agent']);
  const page = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'pages', 'tracker.js'), 'utf8');
  assert.doesNotMatch(page, /j\.agentId \? j\.agentId/, 'the Tracker row uses jobWho');
  assert.match(page, /jobWho\(/);
});

test('tracker: a downloads event repaints the open tracker pop-up as well as the downloads pop-up', () => {
  assert.equal(popShowsDownloads('downloads'), true);
  assert.equal(popShowsDownloads('tracker'), true);
  for (const k of [null, 'network', 'approvals']) assert.equal(popShowsDownloads(k), false);
  const src = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'shell.js'), 'utf8');
  const body = src.slice(src.indexOf('function paintDownloads()'), src.indexOf('function downloadRows()'));
  assert.doesNotMatch(body, /popKind\(\) === 'downloads'/, 'paintDownloads asks popShowsDownloads');
  assert.equal((body.match(/popShowsDownloads\(popKind\(\)\)/g) || []).length, 2);
});

test('tracker: "needs you" is told once per job, only when it goes to waiting, never for quiet upkeep', () => {
  const told = new Set();
  assert.equal(needsYou(JOBS[1], told), true); assert.equal(needsYou(JOBS[1], told), false);
  assert.equal(needsYou(JOBS[0], told), false); assert.equal(needsYou({ ...JOBS[4], status: 'waiting' }, told), false);
});

test('update notice: shown only when the update event says it can be installed', () => {
  assert.equal(updateReady({ canInstall: true, release: { version: '0.1.1' } }), true);
  for (const s of [null, {}, { canInstall: false, release: { version: '0.1.1' } }, { canInstall: true }]) assert.equal(updateReady(s), false);
});

test('shell files: the tracker and menu rules are served to the page; the top bar has the tracker and update icons', async () => {
  const t = await testDesk();
  try {
    for (const f of ['/ui/tracker-data.js', '/ui/menus.js', '/ui/pages/tracker.js']) assert.equal((await fetch(t.base + f)).status, 200, f);
    const html = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8');
    assert.match(html, /<button class="ico" id="upd" hidden><\/button><button class="ico" id="trk"><\/button>/);
    assert.match(html, /id="trk"[^]*id="dl"[^]*id="net"[^]*id="theme"[^]*id="panic"/);
  } finally { await t.close(); }
});

test('approvals: an ask with no agent is the desk asking (the owner\'s own Get), never "An agent" and never an id', () => {
  const agents = [{ id: 'scout', name: 'Scout' }];
  assert.equal(whoAsks(agents, { agentId: null, jobId: 'job_1', action: 'install' }), 'The desk asks');
  assert.equal(whoAsks(agents, {}), 'The desk asks');
  assert.equal(whoAsks(agents, { agentId: 'scout' }), 'Scout asks');
  assert.equal(whoAsks(agents, { agentId: 'zz8q2m4n7p1r' }), 'An agent asks');
  const shell = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'shell.js'), 'utf8'), home = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'pages', 'home.js'), 'utf8');
  const card = shell.slice(shell.indexOf('function approvalCard('), shell.indexOf('const ACTION_WORDS'));
  assert.match(card, /whoAsks\(state\.agents, a\)/, 'the approval card asks whoAsks');
  for (const [name, src] of [['shell', shell], ['home', home]]) assert.doesNotMatch(src, /\|\| 'An agent'/, name + ': no "An agent" fallback of its own');
  assert.doesNotMatch(shell, /a\.agentId \|\| 'An agent'/, 'no agent id on screen');
});
