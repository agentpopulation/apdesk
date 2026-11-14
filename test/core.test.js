// Contract tests for the shell and the four doors. The model here is the fake (plumbing only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { testDesk } from './helpers/desk.js';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'modules');

test('model door: answers, names the model, falls back, and reports attempts', async () => {
  const t = await testDesk({ script: (b, n) => n === 1 ? { status: 500, text: 'boom' } : 'hello from fake' });
  try {
    // first target fails (router), no other provider -> all_failed with attempts
    await assert.rejects(() => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }] }), (e) => e.code === 'all_failed' && e.attempts.length >= 1 && e.attempts[0].provider === 'router');
    const r = await t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.text, 'hello from fake'); assert.equal(r.provider, 'router'); assert.match(r.label, /Agent Population Router · fake-model/);
    // per-agent model: an explicit keyed provider with a custom base URL
    t.core.model.addKey('custom', 'sk-test-12345678', 'test', { baseUrl: t.fake.baseUrl, model: 'agent-model' });
    t.core.agents.update('scout', { model: { main: { provider: 'custom', model: 'agent-model' } } });
    const r2 = await t.core.model.chat({ agentId: 'scout', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r2.model, 'agent-model'); assert.equal(r2.provider, 'custom');
    // keys never come back in the clear
    assert.ok(!JSON.stringify(t.core.model.listKeys()).includes('sk-test-12345678'));
  } finally { await t.close(); }
});

test('model door: offline uses only local models', async () => {
  const t = await testDesk();
  try {
    t.core.settings.set('online', false);
    await assert.rejects(() => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }] }), (e) => e.code === 'all_failed' || e.code === 'offline');
    t.core.settings.set('ollama.baseUrl', t.fake.ollamaUrl); t.core.model.cache.clear();
    const r = await t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.provider, 'ollama'); assert.match(r.label, /^Ollama · fake-local/);
  } finally { await t.close(); }
});

test('Panic stops a streaming reply, a running job and a waiting approval, and blocks new work until Resume', async () => {
  const t = await testDesk({ script: () => ({ text: 'word '.repeat(400), chunkDelayMs: 10 }) });
  try {
    let got = '';
    const reply = t.core.model.chat({ messages: [{ role: 'user', content: 'long' }], onDelta: (d) => { got += d; } }).then(() => 'finished', (e) => e.code);
    let jobSawAbort = false;
    const job = await t.core.jobs.start({ kind: 'test', title: 'Long job', run: async (j) => { await new Promise((res) => j.signal.addEventListener('abort', () => { jobSawAbort = true; res(); })); } });
    t.core.settings.set('security.level', 'strict');
    const waiting = t.core.approval.request({ action: 'file.write', title: 'x', agentId: 'coder' });
    let hook = false; t.core.panic.onStop(() => { hook = true; });
    await new Promise(r => setTimeout(r, 150));
    const res = await t.call('/api/panic', { body: {} });
    assert.equal(res.json.halted, true);
    assert.equal(await reply, 'aborted'); assert.ok(got.length > 0 && got.length < 2000, 'reply was cut mid-stream');
    assert.equal(jobSawAbort, true); assert.equal(hook, true);
    assert.equal((await t.core.jobs.wait(job.id, 2000)).status, 'stopped');
    assert.deepEqual((await waiting).reason, 'halted');
    await assert.rejects(() => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }] }), (e) => e.code === 'halted');
    await assert.rejects(() => t.core.jobs.start({ kind: 'test', title: 'no', run: async () => {} }), (e) => e.code === 'halted');
    assert.equal((await t.core.approval.request({ action: 'file.write', title: 'y' })).reason, 'halted');
    assert.equal((await t.call('/api/panic/resume', { method: 'POST', session: false })).status, 403, 'resume needs the owner');
    await t.call('/api/panic/resume', { method: 'POST' });
    const again = await t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(again.text.length > 0);
  } finally { await t.close(); }
});

test('Panic: the approvals it cancels are kept as stopped by Panic, shown until dismissed, and counted once on Resume', async () => {
  const t = await testDesk({ modules: ['safety'] });
  try {
    const toasts = []; t.core.events.on((type, data) => { if (type === 'toast') toasts.push(data); });
    t.core.settings.set('security.level', 'strict');
    const a = t.core.approval.request({ action: 'file.write', title: 'Write a.txt', agentId: 'coder' });
    // a request made inside a job carries a child of the Panic signal; Panic must still record it as stopped by Panic
    const b = t.core.approval.request({ action: 'send.person', title: 'Mail the supplier', agentId: 'seller', payload: { to: 'x@example.com' }, signal: t.core.panic.child() });
    await new Promise(r => setTimeout(r, 50));
    await t.call('/api/panic', { body: {} });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, false); assert.equal(ra.reason, 'halted'); assert.equal(rb.ok, false); assert.equal(rb.reason, 'halted');
    // nothing was approved, nothing can be sent
    assert.equal(t.core.approval.forModule().get(rb.id).status, 'halted');
    assert.throws(() => t.core.approval.assertGranted(rb.id, 'send.person', { to: 'x@example.com' }), (e) => e.code === 'not_granted');
    let list = (await t.call('/api/m/safety/stopped')).json.items;
    assert.deepEqual(list.map(x => x.title).sort(), ['Mail the supplier', 'Write a.txt']);
    const mail = list.find(x => x.title === 'Mail the supplier');
    assert.equal(mail.agentId, 'seller'); assert.equal(mail.action, 'send.person'); assert.ok(mail.decided);
    assert.equal(toasts.length, 0, 'no notice while still stopped');
    await t.call('/api/panic/resume', { method: 'POST' });
    assert.equal(toasts.length, 1); assert.match(toasts[0].text, /2 requests/);
    // a second Panic with nothing waiting gives no notice on Resume
    await t.call('/api/panic', { body: {} }); await t.call('/api/panic/resume', { method: 'POST' });
    assert.equal(toasts.length, 1);
    // approving a stopped item does nothing: it stays cancelled
    await t.call(`/api/approvals/${ra.id}/approve`, { method: 'POST' });
    assert.equal(t.core.approval.forModule().get(ra.id).status, 'halted');
    // only the owner dismisses; dismissing keeps the record, it only leaves the list
    assert.equal((await t.call('/api/m/safety/stopped/dismiss', { body: { id: ra.id }, session: false })).status, 403);
    await t.call('/api/m/safety/stopped/dismiss', { body: { id: ra.id } });
    list = (await t.call('/api/m/safety/stopped')).json.items;
    assert.deepEqual(list.map(x => x.title), ['Mail the supplier']);
    await t.call('/api/m/safety/stopped/dismiss', { body: { all: true } });
    assert.equal((await t.call('/api/m/safety/stopped')).json.items.length, 0);
    assert.equal(t.core.approval.forModule().get(ra.id).status, 'halted');
    assert.equal(t.core.approval.listPending().length, 0);
  } finally { await t.close(); }
});

test('approval door: Open allows a file write, Careful asks once per job, send to a person always asks', async () => {
  const t = await testDesk({ modulesDir: FIX });
  try {
    await t.core.modules.set('demo', true);
    // Open: no question
    let r = await t.call('/api/m/demo/write', { body: { text: 'a' } });
    assert.equal(r.json.ok, true); assert.equal(r.json.how, 'level'); assert.equal(fs.readFileSync(path.join(t.dataDir, 'workspace', 'note.txt'), 'utf8'), 'a');
    // Careful: asks, the owner approves, the second write in the same job does not ask again
    assert.equal((await t.call('/api/settings/security', { body: { level: 'careful' } })).json.level, 'careful');
    const p = t.call('/api/m/demo/write', { body: { text: 'b', jobId: 'j2' } });
    await new Promise(r => setTimeout(r, 100));
    const pend = (await t.call('/api/approvals')).json.pending;
    assert.equal(pend.length, 1); assert.equal(pend[0].action, 'file.write');
    assert.equal((await t.call(`/api/approvals/${pend[0].id}/approve`, { method: 'POST', session: false })).status, 403, 'only the owner decides');
    await t.call(`/api/approvals/${pend[0].id}/approve`, { method: 'POST' });
    assert.equal((await p).json.how, 'owner');
    r = await t.call('/api/m/demo/write', { body: { text: 'c', jobId: 'j2' } });
    assert.equal(r.json.how, 'level', 'asked once for this job');
    // send.person asks at Open and inside an auto-approve window; the card shows everything that would be sent
    await t.call('/api/settings/security', { body: { level: 'open' } });
    await t.call('/api/settings/auto-approve', { body: { window: 60 } });
    const s = t.call('/api/m/demo/send', { body: {} });
    await new Promise(r => setTimeout(r, 100));
    const pend2 = (await t.call('/api/approvals')).json.pending;
    assert.equal(pend2.length, 1); assert.equal(pend2[0].action, 'send.person'); assert.equal(pend2[0].payload.password, 'hunter2', 'what is sent to a person is shown to the owner in full, never hidden');
    await t.call(`/api/approvals/${pend2[0].id}/deny`, { method: 'POST' });
    assert.equal((await s).json.reason, 'denied');
  } finally { await t.close(); }
});

test('security level and auto-approve change only through the Settings routes with the session', async () => {
  const t = await testDesk({ modulesDir: FIX });
  try {
    await t.core.modules.set('demo', true);
    assert.equal((await t.call('/api/settings/security', { body: { level: 'strict' }, session: false })).status, 403);
    assert.equal((await t.call('/api/settings/auto-approve', { body: { window: 'today' }, session: false })).status, 403);
    // the plain settings route ignores security.* and spend.* keys
    await t.call('/api/settings', { body: { 'security.level': 'strict', 'security.autoApproveUntil': '2099-01-01T00:00:00Z', 'spend.perItem': 1 } });
    const sec = (await t.call('/api/security')).json;
    assert.equal(sec.level, 'open'); assert.equal(sec.autoApproveUntil, null); assert.notEqual(sec.limits.perItem, 1);
    // a module has no setter
    const tr = (await t.call('/api/m/demo/try-level', { body: {} })).json;
    assert.equal(tr.hasSetLevel, 'undefined'); assert.equal(tr.hasSettingsSet, 'undefined');
    assert.throws(() => t.core.approval.setLevel('strict', Symbol('fake')), /only in Settings/);
    // cross-site and foreign-host requests are refused
    assert.equal((await t.call('/api/panic', { body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
    const foreign = await new Promise((resolve, reject) => { const u = new URL(t.base); http.get({ host: u.hostname, port: u.port, path: '/api/state', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject); });
    assert.equal(foreign, 403, 'a foreign Host header is refused');
  } finally { await t.close(); }
});

test('spend: over the limit always asks, even in an auto-approve window', async () => {
  const t = await testDesk();
  try {
    await t.call('/api/settings/spend', { body: { perItem: 1000, perDay: 5000, perMonth: 10000 } });
    await t.call('/api/settings/auto-approve', { body: { window: 60 } });
    const p = t.core.approval.request({ action: 'spend', title: 'Buy a thing', amount: 5000, agentId: 'operator' });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(t.core.approval.listPending().length, 1);
    t.core.approval.decide(t.core.approval.listPending()[0].id, 'deny');
    assert.equal((await p).ok, false);
    // a sender cannot send without a granted approval id
    assert.throws(() => t.core.approval.assertGranted('ap_nope', 'send.person'), /No approval/);
  } finally { await t.close(); }
});

test('modules: switch on, route and tool appear; switch off, they go; state survives a restart', async () => {
  const t = await testDesk({ modulesDir: FIX });
  try {
    assert.equal((await t.call('/api/m/demo/hello')).status, 404);
    assert.equal((await t.call('/api/modules/demo/on', { method: 'POST', session: false })).status, 403);
    const on = await t.call('/api/modules/demo/on', { method: 'POST' });
    assert.equal(on.json.on, true);
    assert.equal((await t.call('/api/m/demo/hello')).json.hello, 'demo');
    assert.ok((await t.call('/api/state')).json.tools.some(x => x.name === 'demo.write'));
    assert.equal(t.core.modules.api('demo').ping(), 'pong');
    assert.equal((await t.core.modules.runTool('demo.write', { text: 'z' })).wrote, 'z');
    await t.call('/api/modules/demo/off', { method: 'POST' });
    assert.equal((await t.call('/api/m/demo/hello')).status, 404);
    assert.equal(t.core.modules.api('demo'), null);
    assert.ok(!(await t.call('/api/state')).json.tools.some(x => x.name === 'demo.write'));
  } finally { await t.close(); }
});

test('jobs keep running without a browser and their result waits; agents can be renamed', async () => {
  const t = await testDesk();
  try {
    const job = await t.core.jobs.start({ kind: 'test', title: 'Background', run: async (j) => { j.progress(0.5, 'half'); await new Promise(r => setTimeout(r, 80)); return { answer: 42 }; } });
    const done = await t.core.jobs.wait(job.id, 3000);
    assert.equal(done.status, 'done'); assert.equal(done.output.answer, 42);
    assert.equal((await t.call('/api/jobs/' + job.id)).json.output.answer, 42);
    const a = (await t.call('/api/agents/scout', { method: 'PATCH', body: { name: 'Sherlock', personality: 'Dry wit.' } })).json;
    assert.equal(a.name, 'Sherlock'); assert.match(t.core.agents.systemPrompt('scout'), /Sherlock[\s\S]*Dry wit/);
  } finally { await t.close(); }
});

test('the shell page carries the session, and static files are served only from ui/', async () => {
  const t = await testDesk();
  try {
    const page = await t.call('/');
    assert.ok(page.text.includes(t.desk.session)); assert.ok(page.text.includes('id="panic"'));
    assert.equal((await t.call('/ui/shell.js')).status, 200);
    assert.equal((await t.call('/ui/..%2Fserver.js')).status, 404);
    assert.equal((await t.call('/modules/demo/ui.js')).status, 404);
  } finally { await t.close(); }
});

test('OpenRouter: paid model ids are refused at the door; free ids pass', async () => {
  const t = await testDesk({ script: () => 'ok' });
  try {
    t.core.model.addKey('openrouter', 'sk-or-test-12345678', 'test', { baseUrl: t.fake.baseUrl });
    await assert.rejects(() => t.core.model.chat({ model: { provider: 'openrouter', model: 'openai/gpt-4o' }, messages: [{ role: 'user', content: 'hi' }] }), (e) => e.code === 'all_failed' && t.fake.calls.length === 0);
    const r = await t.core.model.chat({ model: { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' }, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.text, 'ok'); assert.equal(t.fake.calls.length, 1);
    await t.call('/api/settings', { body: { 'openrouter.allowPaid': true } });
    assert.notEqual(t.core.settings.get('openrouter.allowPaid'), true, 'the plain settings route cannot switch paid models on');
  } finally { await t.close(); }
});

test('service keys: owner adds a search or audio key, modules read it, the value never comes back', async () => {
  const t = await testDesk({ modulesDir: FIX, env: { SERPER_API_KEY: 'env-serper-key-123456' } });
  try {
    let list = (await t.call('/api/keys/services')).json.services;
    assert.ok(list.find(s => s.id === 'serper').fromEnvironment); assert.equal(t.core.services.get('serper'), 'env-serper-key-123456');
    assert.equal((await t.call('/api/keys/services/elevenlabs', { body: { value: 'el-secret-key-abcdef123456' }, session: false })).status, 403);
    const r = await t.call('/api/keys/services/elevenlabs', { body: { value: 'el-secret-key-abcdef123456' } });
    assert.ok(!r.text.includes('el-secret-key-abcdef123456')); assert.equal(r.json.services.find(s => s.id === 'elevenlabs').hasKey, true);
    assert.equal(t.core.services.get('elevenlabs'), 'el-secret-key-abcdef123456');
    assert.ok(!(await t.call('/api/state')).text.includes('el-secret-key'));
    await t.call('/api/keys/services/elevenlabs', { method: 'DELETE' });
    assert.equal(t.core.services.get('elevenlabs'), null);
    const prov = t.core.model.forModule().providers();
    assert.equal(prov.gemini.tier, 'free-signup'); assert.equal(prov.openai.tier, 'paid'); assert.ok(t.core.model.forModule().freeRouter().upstreams.length >= 2);
  } finally { await t.close(); }
});

test('safety: a module cannot approve itself, reach core tables with SQL, or fake Panic and level events', async () => {
  const t = await testDesk({ modulesDir: FIX });
  try {
    await t.core.modules.set('demo', true);
    t.core.model.addKey('groq', 'gsk_secret_value_1234567890', 'k');
    const p = (await t.call('/api/m/demo/probe', { body: {} })).json;
    assert.equal(p.hasDecide, 'undefined');
    for (const k of ['readSecrets', 'readSecretsQuoted', 'writeLevel', 'approveSql', 'attach', 'writeAgents', 'emitPanic', 'commaJoin', 'subquery', 'viewOnSecrets', 'twoStatements', 'updateOrReplace', 'trigger', 'tableAsSelect', 'twoInRun', 'emitForged']) assert.match(String(p[k]), /^refused/, k + ' must be refused, got ' + p[k]);
    assert.equal(p.ownColumnNamedSettings, '{}', 'a module column that shares a core table name is fine');
    assert.equal(p.scriptOfOwn, 'semi;colon in a string', 'a module script on its own tables runs, statement by statement');
    assert.equal(p.readAgents, 5); assert.equal(p.ownTable, 1); assert.equal(p.emitOwn, 'ok');
    assert.equal(t.core.approval.level, 'open');
  } finally { await t.close(); }
});

test('safety: an approval is for one item; another recipient, a missing payload or a second use is refused', async () => {
  const t = await testDesk({ modulesDir: FIX });
  try {
    await t.core.modules.set('demo', true);
    const run = t.call('/api/m/demo/send-other', { body: {} });
    await new Promise(r => setTimeout(r, 100));
    await t.call(`/api/approvals/${t.core.approval.listPending()[0].id}/approve`, { method: 'POST' });
    assert.deepEqual((await run).json, { granted: true, otherRecipient: 'refused', noPayload: 'refused', same: 'passed', sameAgain: 'refused' });
  } finally { await t.close(); }
});

test('safety: folder allow-list resolves paths; odd spend amounts ask; writes need the session; Panic does not', async () => {
  const t = await testDesk();
  try {
    const { insideFolder } = await import('../app/core/approval-door.js');
    assert.equal(insideFolder('/home/me/public/a.txt', '/home/me/public'), true);
    assert.equal(insideFolder('/home/me/public/../private/secret.txt', '/home/me/public'), false);
    assert.equal(insideFolder('/home/me/public-secret/a', '/home/me/public'), false);
    assert.equal(insideFolder('D:\\Docs\\Sub\\x.txt', 'd:\\docs'), true);
    assert.equal(insideFolder('D:\\Docs\\..\\Windows\\x', 'D:\\Docs'), false);
    for (const amount of [-5, NaN, 'abc', 0, undefined]) {
      const pr = t.core.approval.request({ action: 'spend', title: 'odd', amount });
      await new Promise(r => setTimeout(r, 20));
      const pend = t.core.approval.listPending(); assert.equal(pend.length, 1, 'amount ' + amount + ' must ask');
      t.core.approval.decide(pend[0].id, 'deny'); await pr;
    }
    const ac = new AbortController(); ac.abort();
    assert.equal((await t.core.approval.request({ action: 'shell.run', title: 'x', signal: ac.signal })).reason, 'aborted');
    assert.equal((await t.call('/api/model/ask', { body: { prompt: 'hi' }, session: false })).status, 403);
    assert.equal((await t.call('/api/agents', { body: { name: 'X' }, session: false })).status, 403);
    assert.equal((await t.call('/api/panic', { body: {}, session: false })).json.halted, true, 'anything on this PC can stop the desk');
    assert.equal((await t.call('/router/v1/models', { session: false })).status, 200);
  } finally { await t.close(); }
});

test('safety: the approval card shows exactly what runs; cross-site reads are refused', async () => {
  const t = await testDesk();
  try {
    // a long command is stored and shown in full: no hidden tail
    const code = 'console.log("2+2=4")' + ' '.repeat(2100) + ';require("fs").readFileSync("secret")';
    const p = t.core.approval.request({ action: 'shell.run', title: 'Run a program', payload: { code, shipping_note: 'leave at the door' } });
    await new Promise(r => setTimeout(r, 30));
    const card = (await t.call('/api/approvals')).json.pending[0];
    assert.equal(card.payload.code, code, 'the whole program is on the card'); assert.equal(card.payload.shipping_note, 'leave at the door', 'a field is not hidden because its name contains "pin"');
    t.core.approval.decide(card.id, 'deny'); await p;
    // too large to show is refused, not cut
    assert.equal((await t.core.approval.request({ action: 'shell.run', title: 'Huge', payload: { code: 'x'.repeat(300 * 1024) } })).reason, 'too_large');
    // a sign-in still hides the password on the card
    const l = t.core.approval.request({ action: 'login', title: 'Sign in', payload: { site: 'shop.example', password: 'hunter2' } });
    await new Promise(r => setTimeout(r, 30));
    const lc = t.core.approval.listPending()[0]; assert.equal(lc.payload.password, '••••'); t.core.approval.decide(lc.id, 'deny'); await l;
    // a page on another site cannot read from the desk either
    assert.equal((await t.call('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await t.call('/api/state', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await t.call('/api/state')).status, 200);
  } finally { await t.close(); }
});

test('pairing: only a paired browser gets the page, the session and the data; Panic stays open', async () => {
  const t = await testDesk({ pairing: true });
  try {
    const get = (p, cookie, extra = {}) => fetch(t.base + p, { headers: { ...(cookie ? { cookie } : {}), ...extra }, redirect: 'manual' });
    // the first browser on a fresh desk is remembered
    const first = await get('/'); const cookie = (first.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^apd_owner=/); assert.ok((await first.text()).includes(t.desk.session));
    // another program on this PC: no session in the page, no data, no writes even with a guessed header
    const other = await get('/'); const body = await other.text();
    assert.ok(!body.includes(t.desk.session) && /six-digit code/.test(body)); assert.equal(other.headers.get('set-cookie'), null);
    assert.equal((await get('/api/state')).status, 401);
    assert.equal((await fetch(t.base + '/api/settings/security', { method: 'POST', headers: { 'content-type': 'application/json', 'x-apd-session': t.desk.session }, body: '{"level":"strict"}' })).status, 401);
    assert.equal((await get('/api/state', cookie)).status, 200);
    // Panic is open to anything on this PC; the free router endpoint too
    assert.equal((await fetch(t.base + '/api/panic', { method: 'POST' })).status, 200);
    assert.equal((await get('/router/v1/models')).status, 200);
    // a second browser pairs with the code from the desk's window; wrong codes lock for a minute
    const post = (code) => fetch(t.base + '/pair', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=' + code, redirect: 'manual' });
    assert.equal((await post('000000' === t.desk.pairCode ? '111111' : '000000')).status, 403);
    const ok = await post(t.desk.pairCode); assert.equal(ok.status, 303);
    const cookie2 = (ok.headers.get('set-cookie') || '').split(';')[0];
    assert.equal((await get('/api/state', cookie2)).status, 200);
    for (let i = 0; i < 5; i++) await post('999999' === t.desk.pairCode ? '888888' : '999999');
    assert.equal((await post(t.desk.pairCode)).status, 429, 'locked after five wrong codes, even for the right one');
    assert.ok(!JSON.stringify((await (await get('/api/settings', cookie)).json())).includes('security.browsers'));
  } finally { await t.close(); }
});

test('model door: parallel tool calls streamed without an index stay separate calls', async () => {
  const calls = [{ name: 'file_write', args: { path: 'a.txt', content: 'one' } }, { name: 'file_write', args: { path: 'b.txt', content: 'two' } }, { name: 'web_search', args: { query: 'x' } }];
  for (const noIndex of [true, false]) {
    const t = await testDesk({ script: () => ({ text: '', toolCalls: calls, noIndex }) });
    try {
      const r = await t.core.model.chat({ messages: [{ role: 'user', content: 'write two files' }], tools: [{ name: 'file_write' }, { name: 'web_search' }], onDelta: () => {} });
      assert.deepEqual(r.toolCalls.map(x => x.name), ['file_write', 'file_write', 'web_search'], 'noIndex=' + noIndex);
      assert.deepEqual(r.toolCalls.map(x => x.args.path || x.args.query), ['a.txt', 'b.txt', 'x']);
    } finally { await t.close(); }
  }
});

test('a job that asks the owner shows waiting with the reason, then runs on after the decision', async () => {
  const t = await testDesk();
  try {
    let ask = null;
    const job = await t.core.jobs.start({ kind: 'test', title: 'Needs a yes', run: async (j) => { ask = t.core.approval.request({ action: 'send.person', title: 'Send the note', jobId: j.id, signal: j.signal, payload: { to: 'someone' } }); const d = await ask; return { ok: d.ok }; } });
    for (let i = 0; i < 50 && !t.core.approval.listPending().length; i++) await new Promise(r => setTimeout(r, 20));
    const w = t.core.jobs.get(job.id);
    assert.equal(w.status, 'waiting'); assert.match(w.detail, /Waiting for your approval: Send the note/);
    t.core.approval.decide(t.core.approval.listPending()[0].id, 'deny');
    const done = await t.core.jobs.wait(job.id, 3000);
    assert.equal(done.status, 'done'); assert.equal(done.output.ok, false);
  } finally { await t.close(); }
});

test('ask once ends with the chat turn and with the job', async () => {
  const t = await testDesk();
  try {
    t.core.settings.set('security.level', 'careful');
    const ask = async (extra) => { const p = t.core.approval.request({ action: 'file.write', title: 'Write a file', agentId: 'coder', payload: { path: 'a.txt' }, ...extra }); await new Promise(r => setTimeout(r, 30)); const pend = t.core.approval.listPending(); if (pend.length) t.core.approval.decide(pend[0].id, 'approve'); const d = await p; return { asked: pend.length === 1, ok: d.ok }; };
    assert.deepEqual(await ask({ chatId: 'c1' }), { asked: true, ok: true });
    assert.deepEqual(await ask({ chatId: 'c1' }), { asked: false, ok: true }, 'the same turn is not asked twice');
    assert.equal(t.core.approval.forModule().endScope('c1'), 1);
    assert.deepEqual(await ask({ chatId: 'c1' }), { asked: true, ok: true }, 'the next turn asks again');
    let inJob = null;
    const job = await t.core.jobs.start({ kind: 'test', title: 'Writes', run: async (j) => { inJob = t.core.approval.request({ action: 'file.write', title: 'Write in a job', agentId: 'coder', jobId: j.id, payload: { path: 'b.txt' } }); return (await inJob).ok; } });
    for (let i = 0; i < 50 && !t.core.approval.listPending().length; i++) await new Promise(r => setTimeout(r, 20));
    t.core.approval.decide(t.core.approval.listPending()[0].id, 'approve');
    await t.core.jobs.wait(job.id, 3000);
    assert.deepEqual(await ask({ jobId: job.id }), { asked: true, ok: true }, 'a finished job no longer carries its grant');
  } finally { await t.close(); }
});

test('model door says when a reply was cut off at its length limit', async () => {
  for (const stream of [false, true]) {
    const t = await testDesk({ script: (body) => { const first = JSON.stringify(body.messages).includes('one'); return { text: first ? 'A whole answer.' : 'An answer that stops in the', finish: first ? 'stop' : 'length' }; } });
    try {
      const whole = await t.core.model.chat({ messages: [{ role: 'user', content: 'one' }], ...(stream ? { onDelta: () => {} } : {}) });
      const cut = await t.core.model.chat({ messages: [{ role: 'user', content: 'two' }], ...(stream ? { onDelta: () => {} } : {}) });
      assert.equal(whole.cutOff, false, 'stream=' + stream); assert.equal(cut.cutOff, true, 'stream=' + stream); assert.equal(cut.finish, 'length');
    } finally { await t.close(); }
  }
});

test('Offline: localhost and 127.0.0.1 are one host; only the local model address is allowed', async () => {
  const t = await testDesk();
  try {
    t.core.settings.set('ollama.baseUrl', 'http://localhost:11434');
    t.core.settings.set('online', false);
    assert.equal(t.core.offlineAllows('http://127.0.0.1:11434/api/tags'), true);
    assert.equal(t.core.offlineAllows('http://127.0.0.1:8787/v1/models'), false, 'a router on this PC forwards online');
    assert.equal(t.core.offlineAllows('https://example.com/'), false);
    await assert.rejects(() => fetch('http://127.0.0.1:8787/v1/models'), (e) => e.code === 'offline');
  } finally { await t.close(); }
});

// A desk whose router is the fake and whose next target is a keyed custom model on the same fake: the script tells them
// apart by model id (router 'fake-model', keyed 'next-model').
async function twoTargets(script) {
  const t = await testDesk({ script });
  t.core.model.addKey('custom', 'sk-test-12345678', 'test', { baseUrl: t.fake.baseUrl, model: 'next-model' });
  return t;
}

test('model door: a stream that stalls after its headers or mid-reply is dropped after the gap, and the next target answers', async () => {
  for (const stallAfter of [0, 3]) {
    const t = await twoTargets((b) => b.model === 'next-model' ? 'from the next model' : { text: 'the first model starts and then stops', stallAfter });
    try {
      let got = ''; let resets = 0; const t0 = Date.now();
      const r = await t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], onDelta: (d) => { got += d; }, onReset: () => { resets++; got = ''; }, streamGapMs: 300 });
      assert.ok(Date.now() - t0 < 3000, 'dropped at the gap, stallAfter=' + stallAfter);
      assert.equal(r.text, 'from the next model'); assert.equal(r.provider, 'custom'); assert.equal(got, 'from the next model');
      assert.equal(resets, stallAfter ? 1 : 0, 'the shown text is cleared only when the dropped hop had shown some');
      assert.equal(r.attempts[0].provider, 'router'); assert.equal(r.attempts[0].ok, false); assert.match(r.attempts[0].error, /stopped coming/);
    } finally { await t.close(); }
  }
});

test('model door: a stream that keeps sending is never cut by the gap timer, however long it takes', async () => {
  const t = await twoTargets((b) => b.model === 'next-model' ? 'wrong target' : { text: 'one two three four five six seven eight', chunkDelayMs: 120 });
  try {
    const t0 = Date.now();
    const r = await t.core.model.chat({ messages: [{ role: 'user', content: 'count' }], onDelta: () => {}, streamGapMs: 400 });
    assert.ok(Date.now() - t0 > 1000, 'took longer than the gap in total');
    assert.equal(r.text, 'one two three four five six seven eight'); assert.equal(r.provider, 'router'); assert.equal(r.attempts.length, 1);
  } finally { await t.close(); }
});

test('model door: after the total deadline no new hop starts and the call ends all_failed with the attempts', async () => {
  const t = await twoTargets((b) => b.model === 'next-model' ? 'should not be asked' : { status: 500, text: 'slow and broken', delayMs: 500 });
  try {
    await assert.rejects(() => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], deadlineMs: 300 }), (e) => {
      assert.equal(e.code, 'all_failed'); assert.equal(e.attempts[0].provider, 'router'); assert.match(e.message, /within 0\.3 seconds|No model answered/);
      return true;
    });
    assert.ok(!t.fake.calls.some(c => c.model === 'next-model'), 'the keyed target was never called');
    // a deadline that is long enough lets the chain move on
    const r = await t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], deadlineMs: 5000 });
    assert.equal(r.text, 'should not be asked'); assert.equal(r.provider, 'custom');
    // the first-byte wait of a hop never runs past the deadline
    const t2 = await twoTargets(() => ({ text: 'late', delayMs: 3000 }));
    try { const t0 = Date.now(); await assert.rejects(() => t2.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], deadlineMs: 400 }), (e) => e.code === 'all_failed'); assert.ok(Date.now() - t0 < 1500, 'ended near the deadline'); }
    finally { await t2.close(); }
  } finally { await t.close(); }
});

test('model door: Stop or Panic during a stalled stream ends the call as aborted, not as a provider error', async () => {
  const t = await twoTargets((b) => b.model === 'next-model' ? 'should not be asked' : { text: 'starts and then stops', stallAfter: 2 });
  try {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
    await assert.rejects(() => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], onDelta: () => {}, signal: ac.signal, streamGapMs: 5000 }), (e) => e.code === 'aborted');
    setTimeout(() => t.call('/api/panic', { body: {} }), 200);
    await assert.rejects(() => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], onDelta: () => {}, streamGapMs: 5000 }), (e) => e.code === 'aborted');
    assert.ok(!t.fake.calls.some(c => c.model === 'next-model'), 'no fallback after a stop');
  } finally { await t.close(); }
});

test('model door: the stop-after-attempts number in the contract matches the code', async () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'core', 'model-door.js'), 'utf8');
  const doc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'core', 'contracts', 'MODEL-DOOR.md'), 'utf8');
  const n = Number(src.match(/const MAX_ATTEMPTS = (\d+)/)[1]);
  assert.match(doc, new RegExp(`attempts\\.length >= ${n}\\b`));
});
