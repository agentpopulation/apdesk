// Several people on one PC (contracts/PEOPLE.md): people, PINs, one token per window, and the keeper's gates.
// Person 1 is the keeper (the existing desk). Person A and Person B below are test people. The model is the fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { testDesk } from './helpers/desk.js';
import { createDesk } from '../app/server.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KEEPER_NO = 'Only the keeper of this PC can do that.';
const MODS = ['chat', 'memory', 'sales', 'search', 'network', 'bench', 'finder', 'tables', 'models'];

/** A call with a given token (or none). */
const as = (t, token) => (p, o = {}) => t.call(p, { ...o, session: false, headers: { ...(o.headers || {}), ...(token ? { 'x-apd-session': token } : {}) } });
/** The keeper sets a PIN and adds Person B. Returns B's id and token. */
async function withB(t, { keeperPin = '2468', pin = '4821' } = {}) {
  const k = as(t, t.desk.session);
  assert.equal((await k('/api/people/me/pin', { body: { pin: keeperPin } })).status, 200);
  const add = await k('/api/people', { body: { name: 'Person B', emoji: '🙂', colour: '#336699', pin } });
  assert.equal(add.status, 200, add.text);
  const id = add.json.person.id;
  const e = await as(t, null)('/api/people/enter', { body: { id, pin } });
  assert.equal(e.status, 200, e.text); assert.match(e.json.token, /^[0-9a-f]{48}$/);
  return { id, token: e.json.token, keeperPin, pin };
}
/** An event stream opened with a token, as a window's EventSource would. */
async function stream(t, token) {
  const ac = new AbortController(); let text = ''; let ended = false;
  const r = await fetch(t.base + '/api/events' + (token ? '?session=' + token : ''), { signal: ac.signal });
  const done = (async () => { try { const rd = r.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; text += Buffer.from(value).toString(); } } catch {} ended = true; })();
  return { status: r.status, get text() { return text; }, get ended() { return ended; }, close: async () => { ac.abort(); await done; } };
}
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

test('one person and no PIN: the desk works as before, with the same token flow and the same data files', async () => {
  const t = await testDesk({ modules: ['chat'] });
  try {
    const before = fs.readdirSync(t.dataDir).sort();
    assert.ok(before.includes('apd.sqlite') && before.includes('desk.sqlite'), before.join(', '));
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'people')), 'no folder is made for anyone else');
    const who = await as(t, null)('/api/people');
    assert.equal(who.status, 200);
    assert.deepEqual(who.json.people.map(p => [p.keeper, p.hasPin]), [[true, false]]);
    const page = await t.call('/', { session: false });
    assert.ok(page.text.includes(`content="${t.desk.session}"`), 'the page gets its token as today');
    assert.equal((await as(t, null)('/api/state')).status, 200, 'a read without a token answers as today');
    assert.equal((await as(t, null)('/api/agents', { body: { name: 'x' } })).status, 403, 'a change still needs the token');
    assert.equal((await t.call('/api/m/chat/chats', { body: { title: 'as before' } })).status, 200);
    assert.ok(t.core.storage.get("SELECT 1 AS x FROM m_chat_chats WHERE title = 'as before'"), 'person 1 is the existing data folder as it is');
  } finally { await t.close(); }
});

test('two people: a token of Person A reads and changes nothing of Person B, through core routes, module routes, events, jobs, approvals and downloads', async () => {
  const t = await testDesk({ modules: MODS });
  const streams = [];
  try {
    const B = await withB(t);
    const a = as(t, t.desk.session), b = as(t, B.token);
    const spB = t.desk.spaceOf(B.id); const cB = spB.core; const cA = t.core;
    for (const id of ['network', 'bench', 'finder', 'tables']) assert.equal((await a(`/api/modules/${id}/on`, { method: 'POST' })).status, 200, 'the keeper switches ' + id + ' on for everyone');
    assert.notEqual(cB.storage.file, cA.storage.file);
    assert.equal(cB.storage.dataDir, path.join(t.dataDir, 'people', B.id, 'work'), 'a new person\'s space lives in data/people/<id>/work');
    for (const id of MODS) assert.ok(cB.modules.isOn(id), 'the house\'s modules are on for B too: ' + id);

    // with two people, nothing answers without a token, and a token that is not one answers nothing
    assert.equal((await as(t, null)('/api/state')).status, 401);
    assert.equal((await as(t, 'ab'.repeat(24))('/api/m/chat/chats')).status, 401);
    assert.equal((await as(t, null)('/api/people')).status, 200, 'who is here still answers');

    // chats
    const chatA = (await a('/api/m/chat/chats', { body: { title: 'Only in A' } })).json;
    assert.equal((await b('/api/m/chat/chats', { body: { title: 'Only in B' } })).status, 200);
    const titles = async (c) => (await c('/api/m/chat/chats')).json.chats.map(x => x.title);
    assert.ok((await titles(a)).includes('Only in A') && !(await titles(a)).includes('Only in B'));
    assert.ok((await titles(b)).includes('Only in B') && !(await titles(b)).includes('Only in A'));
    assert.notEqual((await b('/api/m/chat/chats/' + chatA.id)).status, 200, 'B cannot open A\'s chat by its id');
    // memory
    assert.equal((await a('/api/m/memory/items', { body: { text: 'Person A keeps the office key' } })).status, 200);
    assert.ok(!JSON.stringify((await b('/api/m/memory/items')).json).includes('office key'));
    // leads
    const lead = (await a('/api/m/sales/leads', { body: { company: 'Acme Lead A' } })).json.lead;
    assert.ok(!(await b('/api/m/sales/leads')).json.leads.length);
    assert.equal((await b('/api/m/sales/leads/' + lead.id, { method: 'PATCH', body: { company: 'Changed by B' } })).status, 404);
    assert.equal((await b('/api/m/sales/leads/' + lead.id, { method: 'DELETE' })).status, 200);   // deletes nothing of A's
    assert.equal(cA.modules.api('sales').listLeads()[0].company, 'Acme Lead A');
    // a rating
    assert.equal((await a('/api/m/bench/ratings', { body: { targetType: 'answer', targetId: '7', thumb: 'up' } })).status, 200);
    assert.equal((await b('/api/m/bench/ratings/answer/7')).json.rating, null);
    // a website rule
    assert.equal((await a('/api/m/network/rules', { body: { kind: 'never', entry: 'blocked-a.example' } })).status, 200);
    assert.deepEqual((await b('/api/m/network/rules')).json.never, []);
    // Finder's library
    assert.equal((await a('/api/m/finder/library/never-keep', { body: { site: 'only-a.example' } })).status, 200);
    assert.ok(!JSON.stringify((await b('/api/m/finder/library')).json.neverKeep).includes('only-a'));
    // Tables
    cA.storage.run("INSERT INTO m_tables_sources (id, url, title, kind, headings, columns, created, updated) VALUES ('tsA', 'https://a.example/list', 'A list', 'table', '[]', '[]', 'x', 'x')");
    assert.equal((await b('/api/m/tables/sources')).json.sources.length, 0);
    assert.notEqual((await b('/api/m/tables/sources/tsA/rows')).status, 200);
    // keys
    assert.equal((await a('/api/keys/services/serper', { body: { value: 'serper-key-of-a-12345' } })).status, 200);
    assert.ok(!(await b('/api/keys/services')).json.services.find(s => s.id === 'serper').hasKey);
    assert.ok(!JSON.stringify(cB.storage.all('SELECT value FROM secrets')).includes('serper-key-of-a'));
    // events: each window hears its own person only
    const evA = await stream(t, t.desk.session), evB = await stream(t, B.token); streams.push(evA, evB);
    assert.equal(evA.status, 200); assert.equal(evB.status, 200);
    await settle();
    cA.events.emit('toast', { text: 'for-person-A-only' }); cB.events.emit('toast', { text: 'for-person-B-only' });
    await settle();
    assert.ok(evA.text.includes('for-person-A-only') && !evA.text.includes('for-person-B-only'));
    assert.ok(evB.text.includes('for-person-B-only') && !evB.text.includes('for-person-A-only'));
    // jobs: B's job keeps running while A is at the desk; A cannot see or stop it
    let ticks = 0;
    const jobB = await spB.run(() => cB.jobs.start({ kind: 'test.b', title: 'Long job of B', run: (j) => new Promise((res, rej) => { const iv = setInterval(() => { ticks++; if (ticks >= 8) { clearInterval(iv); res({ ticks }); } }, 25); j.signal.addEventListener('abort', () => { clearInterval(iv); rej(Object.assign(new Error('stopped'), { code: 'aborted' })); }); }) }));
    assert.ok(!(await a('/api/jobs')).json.jobs.some(j => j.id === jobB.id));
    assert.notEqual((await a('/api/jobs/' + jobB.id)).status, 200);
    await a('/api/jobs/' + jobB.id + '/stop', { method: 'POST' });
    for (let i = 0; i < 4; i++) await a('/api/m/chat/chats');
    assert.equal((await cB.jobs.wait(jobB.id, 3000)).status, 'done', 'B\'s job ran to the end while A used the desk');
    assert.ok((await b('/api/jobs')).json.jobs.some(j => j.id === jobB.id));
    // approvals
    const asking = cB.approval.request({ action: 'send.person', title: 'Send the offer of B', payload: { to: 'b@b.example', text: 'hi' } });
    await settle(30);
    const pend = (await b('/api/approvals')).json.pending; assert.equal(pend.length, 1);
    assert.equal((await a('/api/approvals')).json.pending.length, 0);
    assert.equal((await a('/api/approvals/' + pend[0].id + '/approve', { method: 'POST' })).status, 404, 'A cannot decide for B');
    assert.equal(cB.approval.listPending().length, 1);
    const who = (await a('/api/people')).json.people.find(p => p.id === B.id);
    assert.equal(who.waiting, 1, 'the chooser shows a count'); assert.ok(!JSON.stringify(who).includes('offer'), 'never titles');
    assert.equal((await b('/api/approvals/' + pend[0].id + '/deny', { method: 'POST' })).status, 200);
    assert.equal((await asking).ok, false);
    // downloads: the owner routes are the keeper's
    for (const p of ['/api/downloads/x/pause', '/api/downloads/x/resume', '/api/downloads/x/cancel']) {
      const r = await b(p, { method: 'POST' }); assert.equal(r.status, 403, p); assert.equal(r.json.error, KEEPER_NO);
    }
    // Panic from either person stops both; any person who entered may resume
    let stoppedA = false;
    const jobA = await cA.jobs.start({ kind: 'test.a', title: 'Long job of A', run: (j) => new Promise((res, rej) => { j.signal.addEventListener('abort', () => { stoppedA = true; rej(Object.assign(new Error('stopped'), { code: 'aborted' })); }); }) });
    assert.equal((await b('/api/panic', { body: { reason: 'from B' } })).status, 200);
    assert.ok(cA.panic.halted && cB.panic.halted);
    await cA.jobs.wait(jobA.id, 3000); assert.ok(stoppedA, 'B\'s Panic stopped A\'s job');
    assert.equal((await b('/api/panic/resume', { method: 'POST' })).status, 200);
    assert.ok(!cA.panic.halted && !cB.panic.halted);
    let stoppedB = false;
    const jobB2 = await spB.run(() => cB.jobs.start({ kind: 'test.b2', title: 'Second job of B', run: (j) => new Promise((res, rej) => { j.signal.addEventListener('abort', () => { stoppedB = true; rej(Object.assign(new Error('stopped'), { code: 'aborted' })); }); }) }));
    assert.equal((await a('/api/panic', { body: { reason: 'from A' } })).status, 200);
    await cB.jobs.wait(jobB2.id, 3000); assert.ok(stoppedB, 'A\'s Panic stopped B\'s job');
    assert.equal((await as(t, null)('/api/panic/resume', { method: 'POST' })).status, 403, 'no one who has not entered may resume');
    assert.equal((await a('/api/panic/resume', { method: 'POST' })).status, 200);
  } finally { for (const s of streams) await s.close(); await t.close(); }
});

test('PIN: a wrong PIN gives no token; the wait grows and survives a restart; the hash is never sent to a page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-test-pin-'));
  const open = async () => { const d = await createDesk({ dataDir: dir, port: 0, quiet: true, env: {}, modules: [] }); await d.start(); return d; };
  const call = (d, p, body, token) => fetch(d.url() + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { 'x-apd-session': token } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, text: await r.text() })).then(r => ({ ...r, json: JSON.parse(r.text) }));
  let d = await open();
  try {
    assert.equal((await call(d, '/api/people/me/pin', { pin: '2468' }, d.session)).status, 200);
    const add = await call(d, '/api/people', { name: 'Person B', pin: '4821' }, d.session); assert.equal(add.status, 200);
    const id = add.json.person.id;
    const seen = [];
    for (let i = 1; i <= 5; i++) { const r = await call(d, '/api/people/enter', { id, pin: '0000' }); seen.push(r.text); assert.equal(r.status, 403); assert.equal(r.json.token, undefined); }
    assert.equal(JSON.parse(seen[4]).waitSeconds, 30, 'the fifth wrong try starts a 30 second wait');
    const duringWait = await call(d, '/api/people/enter', { id, pin: '0000' }); seen.push(duringWait.text);
    assert.equal(duringWait.status, 429, 'a wrong PIN during the wait is told to wait'); assert.equal(duringWait.json.token, undefined);
    assert.ok(cB(d, id).approval.activityList(50).filter(r => r.action === 'people.pin.wrong').length >= 5, 'each wrong try that was checked is in that person\'s activity log');
    await d.stop(); d = await open();
    const after = await call(d, '/api/people/enter', { id, pin: '0000' });
    assert.equal(after.status, 429, 'a restart does not reset the wait'); assert.ok(after.json.waitSeconds > 0 && after.json.waitSeconds <= 30);
    const right = await call(d, '/api/people/enter', { id, pin: '4821' });   // the holder is never locked out by another's wrong tries
    assert.equal(right.status, 200, 'the right PIN enters even while a wait runs: no permanent lock'); assert.match(right.json.token, /^[0-9a-f]{48}$/);
    // the hash and salt are in desk.sqlite and in no answer
    const row = new DatabaseSync(path.join(dir, 'desk.sqlite')).prepare('SELECT pin_hash, pin_salt FROM people WHERE id = ?').get(id);
    const k = await call(d, '/api/people/enter', { id: 'p1', pin: '2468' });
    assert.equal(k.status, 200);
    for (const p of ['/api/people', '/api/people/me', '/api/state', '/api/settings', '/api/activity']) seen.push((await call(d, p, null, k.json.token)).text);
    seen.push(k.text, add.text, after.text);
    for (const s of seen) assert.ok(!s.includes(row.pin_hash) && !s.includes(row.pin_salt), 'no hash in ' + s.slice(0, 80));
    // a person with a PIN may change it, with the old one
    assert.equal((await call(d, '/api/people/me/pin', { current: '1111', pin: '1357' }, k.json.token)).status, 403);
    assert.equal((await call(d, '/api/people/me/pin', { current: '2468', pin: '12' }, k.json.token)).status, 400);
    assert.equal((await call(d, '/api/people/me/pin', { current: '2468', pin: '1357' }, k.json.token)).status, 200);
    assert.equal((await call(d, '/api/people/enter', { id: 'p1', pin: '2468' })).status, 403);
    assert.equal((await call(d, '/api/people/enter', { id: 'p1', pin: '1357' })).status, 200);
  } finally { await d.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
const cB = (d, id) => d.spaceOf(id).core;

test('reset: by the keeper with the keeper\'s PIN (the person is told who and when), and by the tool at the PC with the desk stopped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-test-reset-'));
  const open = async () => { const d = await createDesk({ dataDir: dir, port: 0, quiet: true, env: {}, modules: [] }); await d.start(); return d; };
  let d = await open();
  try {
    const t = { call: (p, o = {}) => fetch(d.url() + p, { method: o.method || (o.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then(async r => { const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, text, json }; }), desk: d };
    const k = as(t, d.session);
    assert.equal((await k('/api/people/me/pin', { body: { pin: '2468' } })).status, 200);
    const B = (await k('/api/people', { body: { name: 'Person B', pin: '4821' } })).json.person;
    assert.equal((await k(`/api/people/${B.id}/reset-pin`, { body: { pin: '0000', newPin: '9999' } })).status, 403, 'the keeper\'s PIN is asked');
    assert.equal((await k(`/api/people/${B.id}/reset-pin`, { body: { pin: '2468', newPin: '9999' } })).status, 200);
    const e = await as(t, null)('/api/people/enter', { body: { id: B.id, pin: '9999' } });
    assert.equal(e.status, 200);
    assert.equal(e.json.notice.resetBy, 'Keeper'); assert.ok(e.json.notice.resetAt);
    assert.ok(cB(d, B.id).approval.activityList(20).some(r => r.action === 'people.pin.reset'), 'the reset is in B\'s activity log');
    // the tool refuses while the desk runs
    const tool = () => spawnSync(process.execPath, [path.join(ROOT, 'setup', 'reset-pin.mjs')], { encoding: 'utf8', env: { ...process.env, APD_DATA: dir } });
    const busy = tool(); assert.notEqual(busy.status, 0); assert.match(busy.stdout + busy.stderr, /Stop the desk first/);
    await d.stop();
    const r = tool(); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /no PIN/);
    d = await open();
    assert.equal(d.people.get('p1').hasPin, false);
    assert.ok(d.core.approval.activityList(20).some(x => x.action === 'people.pin.reset' && /at this PC/.test(x.title)), 'the tool wrote to the keeper\'s activity log');
    assert.equal((await as(t, null)('/api/people/enter', { body: { id: 'p1' } })).status, 200, 'the keeper enters with no PIN');
  } finally { await d.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the keeper\'s gates: each answers 403 with one plain sentence for anyone else, and works for the keeper', async () => {
  const t = await testDesk({ modules: ['chat', 'network', 'models'] });
  try {
    const B = await withB(t);
    const a = as(t, t.desk.session), b = as(t, B.token);
    assert.equal((await a('/api/modules/network/on', { method: 'POST' })).status, 200);
    const gated = [
      ['/api/update/check', {}], ['/api/update/install', {}], ['/api/update/daily', { on: false }], ['/api/update/channel', { channel: 'stable' }], ['/api/update/background', { on: false }],
      ['/api/modules/network/off', {}], ['/api/settings', { online: false }], ['/api/settings/paid-models', { provider: 'openrouter', on: true }],
      ['/api/local-engine/get', {}], ['/api/local-engine/choose', { model: 'x' }], ['/api/local-engine/stop', {}], ['/api/local-engine/remove', {}], ['/api/local-engine/switch', { on: false }], ['/api/local-engine/keep-loaded', { on: false }],
      ['/api/downloads/x/cancel', {}], ['/api/m/models/ollama/pull', { model: 'qwen3:0.6b' }], ['/api/m/models/ollama/delete', { model: 'qwen3:0.6b' }],
      ['/api/people', { name: 'Person C', pin: '1234' }], ['/api/people/' + B.id + '/reset-pin', { pin: B.keeperPin, newPin: '1111' }], ['/api/people/' + B.id + '/remove', { pin: B.keeperPin }],
    ];
    for (const [p, body] of gated) { const r = await b(p, { body }); assert.equal(r.status, 403, p); assert.equal(r.json.error, KEEPER_NO, p); }
    // the six-digit pairing code admits new browsers to the whole PC, so it is the keeper's alone
    assert.equal((await b('/api/security/pair-code', { method: 'POST' })).json.error, KEEPER_NO, 'another person cannot get the pairing code');
    assert.notEqual((await a('/api/security/pair-code', { method: 'POST' })).json.error, KEEPER_NO, 'the keeper passes the gate');
    assert.ok(t.core.modules.isOn('network') && t.desk.spaceOf(B.id).core.modules.isOn('network'));
    assert.equal(t.core.settings.get('online'), true);
    assert.equal(t.desk.people.count(), 2);
    // B's own settings still change
    assert.equal((await b('/api/settings', { body: { theme: 'dark' } })).status, 200);
    // the keeper: Offline first, so nothing leaves this PC
    assert.equal((await a('/api/settings', { body: { online: false } })).status, 200);
    assert.equal(t.desk.spaceOf(B.id).core.settings.get('online'), false, 'one switch for the whole desk');
    for (const [p, body] of gated) { const r = await a(p, { body }); assert.notEqual(r.json?.error, KEEPER_NO, p); assert.notEqual(r.status, 403, p + ' ' + r.text); if (p.endsWith(B.id + '/remove')) break; }
    assert.ok(!t.core.modules.isOn('network'), 'the keeper switched network off');
    assert.equal(t.desk.spaceOf(B.id), null, 'B was removed last');
    assert.ok(t.desk.people.list().some(p => p.name === 'Person C'));
    const C = t.desk.people.list().find(p => p.name === 'Person C');
    assert.ok(!t.desk.spaceOf(C.id).core.modules.isOn('network'), 'which modules are on is the house\'s choice, also for a new person');
  } finally { await t.close(); }
});

test('the looks route takes a name, an emoji, a colour and a theme, and refuses every other key', async () => {
  const t = await testDesk({ modules: [] });
  try {
    const B = await withB(t); const b = as(t, B.token);
    const cB = t.desk.spaceOf(B.id).core;
    const settingsBefore = JSON.stringify(cB.settings.all()), levelBefore = cB.approval.level, personBefore = JSON.stringify(t.desk.people.get(B.id));
    for (const key of ['security.level', 'security.autoApproveUntil', 'spend.perDay', 'spend.perMonth', 'openrouter.allowPaid', 'online', 'update.channel', 'ownerName', 'keeper', 'pin', 'id', 'hasPin', 'role', 'files.allowedFolders', 'router.baseUrl', '__proto__', 'constructor']) {
      const body = JSON.parse(`{"name":"Changed","${key}":${key === 'security.level' ? '"open"' : 'true'}}`);
      const r = await b('/api/people/me/look', { body });
      assert.equal(r.status, 400, key); assert.match(r.json.error, /Only/);
    }
    assert.equal(JSON.stringify(cB.settings.all()), settingsBefore); assert.equal(cB.approval.level, levelBefore);
    assert.equal(JSON.stringify(t.desk.people.get(B.id)), personBefore, 'nothing was changed, not even the name');
    assert.equal((await b('/api/people/me/look', { body: { theme: 'purple' } })).status, 400);
    const ok = await b('/api/people/me/look', { body: { name: 'Person B2', emoji: '🌻', colour: '#AA5500', theme: 'dark' } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json.person.name, ok.json.person.emoji, ok.json.person.colour, ok.json.theme], ['Person B2', '🌻', '#aa5500', 'dark']);
    assert.equal(cB.settings.get('theme'), 'dark'); assert.equal(t.core.settings.get('theme'), 'light', 'the keeper\'s theme stays');
  } finally { await t.close(); }
});

test('a token stops working on leave, on switch, and when its person is removed', async () => {
  const t = await testDesk({ modules: ['chat'] });
  try {
    const B = await withB(t);
    const enterB = async () => (await as(t, null)('/api/people/enter', { body: { id: B.id, pin: B.pin } })).json.token;
    // leave
    assert.equal((await as(t, B.token)('/api/state')).status, 200);
    assert.equal((await as(t, B.token)('/api/people/leave', { method: 'POST' })).status, 200);
    assert.equal((await as(t, B.token)('/api/state')).status, 401);
    assert.equal((await as(t, B.token)('/api/m/chat/chats', { body: { title: 'x' } })).status, 403);
    // switch
    const t2 = await enterB();
    assert.equal((await as(t, t2)('/api/people/switch', { body: { id: 'p1', pin: '0000' } })).status, 403);
    assert.equal((await as(t, t2)('/api/state')).status, 200, 'a failed switch leaves the window as it was');
    const sw = await as(t, t2)('/api/people/switch', { body: { id: 'p1', pin: B.keeperPin } });
    assert.equal(sw.status, 200); assert.equal(sw.json.person.id, 'p1');
    assert.equal((await as(t, t2)('/api/state')).status, 401, 'the old token stops on switch');
    assert.equal((await as(t, sw.json.token)('/api/people')).json.you, 'p1');
    // removed: the token and its event stream stop; the folder stays where it was
    const t3 = await enterB(); const ev = await stream(t, t3); await settle();
    const gone = await as(t, t.desk.session)(`/api/people/${B.id}/remove`, { body: { pin: B.keeperPin } });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.json.folder, path.join(t.dataDir, 'people', B.id)); assert.ok(fs.existsSync(path.join(gone.json.folder, 'work', 'apd.sqlite')), 'the folder is not deleted');
    assert.match(gone.json.message, /people/);
    assert.equal((await as(t, t3)('/api/state')).status, 401);
    await settle(); assert.ok(ev.ended, 'the window\'s event stream ended'); await ev.close();
    assert.equal((await as(t, null)('/api/people/enter', { body: { id: B.id, pin: B.pin } })).status, 404);
  } finally { await t.close(); }
});

test('Files: in a person\'s space the desk\'s whole data folder stays closed, except that person\'s own workspace', async () => {
  const { isBlocked } = await import('../modules/files/explorer.js');
  const data = path.join(os.tmpdir(), 'apd-x', 'data'); const mine = path.join(data, 'people', 'pb', 'work');
  const keeperBackups = path.join(data, '..', 'data-backups');   // the keeper's backups live outside the data folder
  const env = { dataDir: mine, workspace: path.join(mine, 'workspace'), deskDir: data, houseBackups: keeperBackups };
  for (const p of [path.join(data, 'apd.sqlite'), path.join(data, 'desk.sqlite'), path.join(data, 'workspace', 'a.md'), path.join(data, 'people', 'pc', 'work', 'workspace', 'x'), path.join(mine, 'apd.sqlite'), path.join(keeperBackups, 'apdesk-backup.zip')]) assert.equal(isBlocked(env, p), true, p);
  assert.equal(isBlocked(env, path.join(mine, 'workspace', 'notes.md')), false);
  assert.equal(isBlocked({ dataDir: data, workspace: path.join(data, 'workspace') }, path.join(data, 'people', 'pb', 'work', 'workspace', 'x')), true, 'the keeper\'s Files sees no other person\'s folder');
  assert.equal(isBlocked({ dataDir: data, workspace: path.join(data, 'workspace'), houseBackups: null }, path.join(keeperBackups, 'apdesk-backup.zip')), false, 'the keeper can still open their own backups (one-person desk unchanged)');
  const t = await testDesk({ modules: ['files'] });
  try {
    const B = await withB(t); assert.ok(t.desk.spaceOf(B.id).core.modules.isOn('files'));
    assert.equal(t.desk.spaceOf(B.id).core.houseDataDir, t.dataDir, 'B\'s Files is told the desk\'s whole data folder');
    assert.equal(t.desk.spaceOf(B.id).core.houseBackupsDir, t.core.storage.backupsDir, 'B\'s Files is told the keeper\'s backups folder, outside the data folder');
    assert.equal(t.core.houseBackupsDir ?? null, null, 'the keeper\'s own space shields no foreign backups');
  } finally { await t.close(); }
});
