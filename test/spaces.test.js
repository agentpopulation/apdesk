// House and spaces (contracts/PEOPLE.md): one process, two spaces on two empty data folders. What is made in one space
// is not seen in the other; Panic and Offline belong to the house and hold for both. The model is the fake (plumbing only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { testDesk } from './helpers/desk.js';
import { ruleFor } from '../modules/network/rules.js';
import { checkUrl } from '../modules/browser/guard.js';

const MODS = ['chat', 'memory', 'sales', 'search', 'browser', 'network', 'bench'];

// A module route of a space without HTTP: the same handler the house server would call, inside that space.
async function inSpace(space, method, p, body, owner = true) {
  const u = new URL(p, 'http://x');
  const hit = space.core.modules.match(method, u.pathname); assert.ok(hit, 'no route ' + method + ' ' + p);
  let status = 200, out = '';
  const res = { headersSent: false, writableEnded: false, setHeader() {}, writeHead(s) { status = s; this.headersSent = true; }, write(c) { out += c; }, end(c) { if (c) out += c; this.writableEnded = true; }, on() {} };
  await space.run(() => hit.route.handler({ headers: {}, method, url: p, on() {} }, res, { query: Object.fromEntries(u.searchParams), params: hit.params, body, owner }));
  let json = null; try { json = JSON.parse(out); } catch {}
  return { status, json };
}
const listen = async () => { const s = http.createServer((q, r) => r.end('ok')); await new Promise(r => s.listen(0, '127.0.0.1', r)); return { port: s.address().port, close: () => new Promise(r => { s.closeAllConnections?.(); s.close(() => r()); }) }; };

test('a second space can be built only under node --test, and no route reaches it', async () => {
  const t = await testDesk();
  try {
    assert.equal(typeof t.desk.openTestSpace, 'function');
    const keep = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
    try { await assert.rejects(() => t.desk.openTestSpace({ dataDir: path.join(os.tmpdir(), 'apd-never') }), /node --test/); } finally { process.env.NODE_TEST_CONTEXT = keep; }
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'apd-never')), 'nothing was made');
    assert.ok(!('openTestSpace' in t.core) && !Object.values(t.core).some(v => v && typeof v === 'object' && 'openTestSpace' in v), 'the core a module sees holds no way to a second space');
  } finally { await t.close(); }
});

test('two spaces in one process: chats, memory, leads, jobs, ratings, website rules, keys, approvals and events stay in their space; Panic and Offline hold for both', async () => {
  const t = await testDesk({ modules: MODS });
  const bDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-test-b-'));
  const local = await listen();
  let b = null;
  try {
    b = await t.desk.openTestSpace({ dataDir: bDir });
    const A = t.core, B = b.core;
    for (const sp of [A, B]) { await sp.modules.set('network', true); await sp.modules.set('bench', true); }
    for (const id of MODS) { assert.ok(A.modules.isOn(id), 'A ' + id); assert.ok(B.modules.isOn(id), 'B ' + id); }
    assert.notEqual(A.storage.file, B.storage.file); assert.equal(B.storage.dataDir, bDir);
    assert.notEqual(A.modules.api('chat'), B.modules.api('chat'));

    const seenA = [], seenB = [];
    A.events.on((type, data) => seenA.push({ type, data })); B.events.on((type, data) => seenB.push({ type, data }));

    // chat
    A.modules.api('chat').createChat({ title: 'Only in A' });
    await b.run(() => B.modules.api('chat').createChat({ title: 'Only in B' }));
    const chatsA = (await t.call('/api/m/chat/chats')).json.chats.map(c => c.title);
    const chatsB = (await inSpace(b, 'GET', '/api/m/chat/chats')).json.chats.map(c => c.title);
    assert.ok(chatsA.includes('Only in A') && !chatsA.includes('Only in B'), 'A chats: ' + chatsA);
    assert.ok(chatsB.includes('Only in B') && !chatsB.includes('Only in A'), 'B chats: ' + chatsB);

    // memory
    await A.modules.api('memory').remember({ text: 'The office opens at nine in A', wait: false });
    assert.equal(A.modules.api('memory').list().length, 1);
    assert.equal(B.modules.api('memory').list().length, 0);

    // a lead
    A.modules.api('sales').addLead({ company: 'Acme Lead A', site: 'acme-a.example' });
    assert.ok(A.modules.api('sales').listLeads().some(l => l.company === 'Acme Lead A'));
    assert.ok(!(await inSpace(b, 'GET', '/api/m/sales/leads')).json.leads.some(l => l.company === 'Acme Lead A'));

    // a job
    const jobA = await A.jobs.start({ kind: 'test.a', title: 'Job in A', run: async () => ({ ok: 1 }) });
    await A.jobs.wait(jobA.id);
    assert.equal(A.jobs.get(jobA.id).status, 'done');
    assert.equal(B.jobs.get(jobA.id), null); assert.equal(B.jobs.list().length, 0);

    // a rating
    assert.equal((await t.call('/api/m/bench/ratings', { body: { targetType: 'answer', targetId: '7', thumb: 'up' } })).status, 200);
    assert.equal((await t.call('/api/m/bench/ratings/answer/7')).json.rating.thumb, 'up');
    assert.equal((await inSpace(b, 'GET', '/api/m/bench/ratings/answer/7')).json.rating, null);

    // a website rule: A's "never" binds A's agents only; B's own rule binds B only
    assert.equal((await t.call('/api/m/network/rules', { body: { kind: 'never', entry: 'blocked-a.example' } })).status, 200);
    assert.equal((await inSpace(b, 'POST', '/api/m/network/rules', { kind: 'never', entry: 'blocked-b.example' })).status, 200);
    assert.equal(ruleFor('blocked-a.example')?.kind, 'never', 'A (the main space) keeps its rule');
    assert.equal(ruleFor('blocked-b.example'), null, 'B\'s rule is not seen in A');
    assert.equal(await b.run(() => ruleFor('blocked-a.example')), null, 'A\'s rule is not seen in B');
    assert.equal((await b.run(() => ruleFor('blocked-b.example')))?.kind, 'never');
    assert.match(String(checkUrl('https://www.blocked-a.example/', { who: { agentId: 'scout' } })), /never open blocked-a\.example/);
    assert.equal(await b.run(() => checkUrl('https://www.blocked-a.example/', { who: { agentId: 'scout' } })), null);
    const ruleA = (await t.call('/api/m/network/rules')).json, ruleB = (await inSpace(b, 'GET', '/api/m/network/rules')).json;
    assert.deepEqual(ruleA.never.map(r => r.domain), ['blocked-a.example']); assert.deepEqual(ruleB.never.map(r => r.domain), ['blocked-b.example']);
    const out = await A.modules.runTool('web_read', { url: 'https://news.blocked-a.example/' }, { agentId: 'scout', chatId: 'c1' });
    assert.match(out.error, /never open blocked-a\.example/);
    assert.ok((await t.call('/api/m/network/visits')).json.visits.some(v => v.host === 'news.blocked-a.example'));
    assert.ok(!(await inSpace(b, 'GET', '/api/m/network/visits')).json.visits.some(v => v.host === 'news.blocked-a.example'), 'A\'s visit log is not in B');

    // data use: a call made in a space is counted in that space only
    await fetch(`http://127.0.0.1:${local.port}/a`).then(r => r.text());
    await b.run(() => fetch(`http://localhost:${local.port}/b`).then(r => r.text()));
    await new Promise(r => setTimeout(r, 50));
    const hosts = async (r) => (r.json.hosts || []).map(h => h.host);
    const hostsA = await hosts(await t.call('/api/m/network/data-use')), hostsB = await hosts(await inSpace(b, 'GET', '/api/m/network/data-use'));
    assert.ok(hostsA.includes('127.0.0.1') && !hostsA.includes('localhost'), 'A data use: ' + hostsA);
    assert.ok(hostsB.includes('localhost') && !hostsB.includes('127.0.0.1'), 'B data use: ' + hostsB);

    // a key
    assert.equal((await t.call('/api/keys/services/serper', { body: { value: 'serper-key-for-a-12345' } })).status, 200);
    assert.ok(A.services.list().find(s => s.id === 'serper').hasKey);
    assert.ok(!B.services.list().find(s => s.id === 'serper').hasKey);
    assert.equal(B.services.get('serper'), null);
    assert.ok(!JSON.stringify(B.storage.all('SELECT value FROM secrets')).includes('serper-key-for-a'));

    // an approval
    const asking = A.approval.request({ action: 'send.person', title: 'Send the offer to Acme', agentId: 'closer', payload: { to: 'a@acme-a.example', text: 'hello' } });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(A.approval.listPending().length, 1);
    assert.equal(B.approval.listPending().length, 0);
    assert.equal((await t.call('/api/approvals')).json.pending.length, 1);
    A.approval.decide(A.approval.listPending()[0].id, 'deny', 'owner'); assert.equal((await asking).ok, false);

    // an event
    seenA.length = 0; seenB.length = 0;
    A.events.emit('toast', { text: 'for A only' });
    await b.run(() => B.events.emit('toast', { text: 'for B only' }));
    assert.deepEqual(seenA.map(e => e.data.text), ['for A only']);
    assert.deepEqual(seenB.map(e => e.data.text), ['for B only']);

    // Panic: one stop stops both spaces; Resume resumes both
    let stoppedB = false;
    const jobB = await b.run(() => B.jobs.start({ kind: 'test.b', title: 'Long job in B', run: (j) => new Promise((res, rej) => { j.signal.addEventListener('abort', () => { stoppedB = true; rej(Object.assign(new Error('stopped'), { code: 'aborted' })); }); }) }));
    seenA.length = 0; seenB.length = 0;
    const p = await t.call('/api/panic', { body: { reason: 'test' }, session: false });
    assert.equal(p.status, 200); assert.equal(p.json.halted, true);
    assert.ok(A.panic.halted && B.panic.halted, 'both halted');
    await B.jobs.wait(jobB.id, 3000);
    assert.ok(stoppedB); assert.equal(B.jobs.get(jobB.id).status, 'stopped');
    await assert.rejects(() => B.jobs.start({ kind: 'x', title: 'x', run: async () => 1 }), (e) => e.code === 'halted');
    assert.equal((await B.approval.request({ action: 'send.person', title: 'x' })).reason, 'halted');
    assert.ok(seenA.some(e => e.type === 'panic') && seenB.some(e => e.type === 'panic'), 'both windows hear Panic');
    assert.ok(A.approval.activityList(20).some(r => r.action === 'panic') && B.approval.activityList(20).some(r => r.action === 'panic'), 'both activity logs keep it');
    assert.equal((await t.call('/api/panic/resume', { method: 'POST' })).status, 200);
    assert.ok(!A.panic.halted && !B.panic.halted, 'both resumed');

    // Offline: the house holds it for both spaces
    assert.equal((await t.call('/api/settings', { body: { online: false } })).status, 200);
    assert.equal(A.settings.get('online'), false); assert.equal(B.settings.get('online'), false);
    assert.equal(B.modules.api('search').isOffline(), true, 'a module in B reads Offline');
    assert.throws(() => B.settings.set('online', true), /whole desk/);
    await assert.rejects(() => b.run(() => fetch(`http://127.0.0.1:${local.port}/off`)), (e) => e.code === 'offline');
    await assert.rejects(() => fetch(`http://127.0.0.1:${local.port}/off`), (e) => e.code === 'offline');
    assert.equal((await t.call('/api/settings', { body: { online: true } })).status, 200);
    assert.equal(B.settings.get('online'), true);
    assert.equal(await b.run(() => fetch(`http://127.0.0.1:${local.port}/on`).then(r => r.text())), 'ok');

    // B closes alone: its own stop hooks run once, A keeps working, and B's hooks are gone from the house's Panic
    let hookB = 0; B.panic.onStop(() => { hookB++; });
    await b.close(); b = null;
    assert.equal(hookB, 1, 'closing B ran B\'s stop hooks');
    assert.ok(!A.panic.halted, 'closing B did not stop A');
    await t.call('/api/panic', { body: { reason: 'again' }, session: false }); await t.call('/api/panic/resume', { method: 'POST' });
    assert.equal(hookB, 1, 'a later Panic no longer reaches the closed space');
    const after = await A.jobs.start({ kind: 'test.a2', title: 'Still works', run: async () => 2 });
    assert.equal((await A.jobs.wait(after.id)).status, 'done');
    assert.equal((await t.call('/api/state')).status, 200);
  } finally {
    await b?.close(); await local.close(); await t.close(); fs.rmSync(bDir, { recursive: true, force: true });
  }
});

test('a space reached from outside it: its exposed functions and doors run in it, Offline it may call only the keeper\'s model servers, and closing it stops its work', async () => {
  const t = await testDesk({ modules: ['chat', 'search', 'browser', 'network'] });
  const bDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-test-b-'));
  const tag = (s) => http.createServer((q, r) => r.end(s));
  const up = async (srv) => { await new Promise(r => srv.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${srv.address().port}/`; };
  const nodeA = tag('A-node'), nodeB = tag('B-node'), slow = http.createServer((q, r) => setTimeout(() => r.end('late'), 800));
  const [urlA, urlB, urlSlow] = [await up(nodeA), await up(nodeB), await up(slow)];
  let b = null;
  try {
    b = await t.desk.openTestSpace({ dataDir: bDir });
    const A = t.core, B = b.core;
    for (const sp of [A, B]) await sp.modules.set('network', true);
    assert.equal((await inSpace(b, 'POST', '/api/m/network/rules', { kind: 'never', entry: 'only-b.example' })).status, 200);
    assert.equal((await inSpace(b, 'POST', '/api/m/network/rules', { kind: 'ask', entry: 'ask-b.example' })).status, 200);
    assert.equal((await t.call('/api/m/network/rules', { body: { kind: 'ask', entry: 'ask-a.example' } })).status, 200);

    // a function B's module exposes, called with no space entered, keeps B's rules and asks B's owner
    const sB = B.modules.api('search');
    await assert.rejects(() => sB.checkUrl('https://www.only-b.example/'), /never open only-b\.example/);
    const pendA = A.approval.listPending().length;
    const asking = sB.checkUrl('https://ask-b.example/secret-path-of-b').then(() => 'open', (e) => e.code || e.message);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(A.approval.listPending().length, pendA, 'A\'s owner is not asked for B');
    const askB = B.approval.listPending(); assert.equal(askB.length, 1); assert.match(askB[0].detail || '', /ask-b\.example/);
    B.approval.decide(askB[0].id, 'deny', 'owner');
    assert.notEqual(await asking, 'open');
    assert.ok(!JSON.stringify(A.approval.activityList(200)).includes('secret-path-of-b'), 'A\'s activity log holds nothing of B');

    // a job started on B's door with no space entered runs in B
    const j = await B.jobs.start({ kind: 'test.b', title: 'B job', run: async () => ({ never: ruleFor('only-b.example')?.kind ?? null, ask: ruleFor('ask-a.example')?.kind ?? null }) });
    assert.deepEqual((await B.jobs.wait(j.id)).output, { never: 'never', ask: null });

    // Offline: the local model addresses are the keeper's for the whole PC: another space cannot set its own, it reads
    // the keeper's, and no space reaches an address the keeper did not set
    assert.throws(() => B.settings.set('ollama.baseUrl', urlB.slice(0, -1)), /keeper's own desk/);
    A.settings.set('ollama.baseUrl', urlA.slice(0, -1));
    assert.equal((await t.call('/api/settings', { body: { online: false } })).status, 200);
    try {
      const get = (u) => fetch(u).then(r => r.text(), (e) => 'refused:' + e.code);
      assert.equal(await b.run(() => get(urlA)), 'A-node', 'B reads the keeper\'s address');
      assert.equal(await b.run(() => get(urlB)), 'refused:offline');
      assert.equal(await get(urlA), 'A-node');
      assert.equal(await get(urlB), 'refused:offline');
      assert.equal(B.offlineAllows(new URL(urlA)), true); assert.equal(B.offlineAllows(new URL(urlB)), false);
    } finally { assert.equal((await t.call('/api/settings', { body: { online: true } })).status, 200); }

    // closing B aborts what B was handed: a fetch hung on B's Panic signal stops with it
    const sig = B.panic.child(), whole = B.panic.signal;
    const inflight = b.run(() => fetch(urlSlow, { signal: sig }).then(r => r.text()).then(() => 'completed', () => 'aborted'));
    await new Promise(r => setTimeout(r, 50));
    await b.close(); b = null;
    assert.ok(sig.aborted && whole.aborted, 'B\'s signals are aborted');
    assert.equal(await inflight, 'aborted');
    assert.ok(!A.panic.halted && !A.panic.signal.aborted && !A.panic.child().aborted, 'A goes on');
  } finally {
    await b?.close(); for (const s of [nodeA, nodeB, slow]) { s.closeAllConnections?.(); s.close(); }
    await t.close(); fs.rmSync(bDir, { recursive: true, force: true });
  }
});

test('a desk with one space never switches on async context tracking', () => {
  // Entering the main space would make every promise of the process pay for async hooks; its code reads no space anyway.
  const code = `
    import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
    import { createRequire } from 'node:module';
    const hooks = createRequire(import.meta.url)('internal/async_hooks');
    const { createDesk } = await import(${JSON.stringify(new URL('../app/server.js', import.meta.url).href)});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-test-one-'));
    const desk = await createDesk({ dataDir: dir, port: 0, quiet: true, env: {}, modules: ['chat', 'search', 'network'] });
    await desk.start();
    const r = await fetch(desk.url() + '/api/m/chat/chats', { headers: { 'x-apd-session': desk.session } }); await r.text();
    await desk.core.jobs.wait((await desk.core.jobs.start({ kind: 'x', title: 'x', run: async () => 1 })).id);
    desk.core.events.emit('toast', { text: 'x' });
    const on = hooks.initHooksExist();
    await desk.stop(); fs.rmSync(dir, { recursive: true, force: true });
    console.log(JSON.stringify({ on, route: r.status }));`;
  const out = spawnSync(process.execPath, ['--expose-internals', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim().split('\n').pop()), { on: false, route: 200 });
});
