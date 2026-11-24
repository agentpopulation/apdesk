// The Doctor: the checks as plain functions with stand-ins, then "Check my desk" on a throwaway desk where the fake model
// is the free route and the internet check page is a stand-in. Nothing goes out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import * as C from './checks.js';
import { testHooks } from './server.js';

const when = () => '10 Mar, 5:30 pm';

test('the model check is skipped with a reason while Offline or after Panic, and never calls a model then', async () => {
  let called = 0; const chat = async () => { called++; return { label: 'x', ms: 1 }; };
  const off = await C.modelCheck({ halted: false, online: false, routes: ['router'], chat });
  assert.equal(off.state, 'skipped'); assert.match(off.line, /Offline/);
  const stop = await C.modelCheck({ halted: true, online: true, routes: ['router'], chat });
  assert.equal(stop.state, 'skipped'); assert.match(stop.line, /stopped/);
  assert.equal(called, 0);
  const bad = await C.modelCheck({ halted: false, online: true, routes: ['router', 'ollama'], chat: async () => { throw new Error('No model answered. x'); } });
  assert.equal(bad.state, 'problem'); assert.ok(bad.todo); assert.deepEqual(bad.place, { page: 'models' });
});

test('keys: which providers have one and whether the last call worked; never a key, not even masked', () => {
  const keys = { groq: [{ id: 'k1', enabled: true, value: 'gsk_••••abcd' }], gemini: [{ id: 'k2', enabled: true, value: 'AIza••••wxyz' }], openai: [] };
  const r = C.keysCheck({ keys, lastCalls: { groq: { ok: false, at: 'x', error: 'HTTP 401 Invalid API Key' }, gemini: { ok: true, at: 'x' } }, names: { groq: 'Groq', gemini: 'Google Gemini' }, when });
  assert.equal(r.state, 'problem'); assert.match(r.line, /1 provider failed/);
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /gsk_|AIza|••••|abcd|wxyz/);
  assert.match(text, /Groq: 1 of 1 key on\. The provider refused the key \(10 Mar, 5:30 pm\)\./);
  assert.match(text, /Google Gemini: 1 of 1 key on\. The last call worked/);
  assert.equal(C.keysCheck({ keys: {}, lastCalls: {}, names: {}, when }).state, 'fine');
});

test('keys: a refused key, a busy provider, no connection and other errors read apart; only a refused key says replace', () => {
  const keys = { openrouter: [{ id: 'k1', enabled: true }] };
  const names = { openrouter: 'OpenRouter' };
  const run = (error) => C.keysCheck({ keys, lastCalls: { openrouter: { ok: false, at: 'x', error } }, names, when });
  const busy = run('HTTP 429 Rate limit exceeded: free-models-per-min.');
  assert.equal(busy.state, 'fine', 'a rate limit is not a key problem');
  assert.match(busy.details.join(' '), /OpenRouter: 1 of 1 key on\. Busy right now \(10 Mar, 5:30 pm\): the provider is limiting requests; nothing to change, try again later\./);
  assert.doesNotMatch(JSON.stringify(busy), /replace|re-enter/i);
  for (const e of ['HTTP 401 Invalid API Key.', 'HTTP 403 Forbidden']) {
    const r = run(e);
    assert.equal(r.state, 'problem'); assert.match(r.details.join(' '), /refused the key/); assert.match(r.todo, /replace or re-enter the key/);
  }
  for (const e of ['No answer within 30 seconds', 'fetch failed', 'The operation was aborted due to timeout']) {
    const r = run(e);
    assert.equal(r.state, 'fine', e); assert.match(r.details.join(' '), /did not reach the provider .*The internet line/); assert.doesNotMatch(JSON.stringify(r), /replace|re-enter/i);
  }
  const other = run('HTTP 400 This model does not support tools.');
  assert.equal(other.state, 'problem'); assert.match(other.details.join(' '), /did not work \(10 Mar, 5:30 pm\): HTTP 400 This model does not support tools\./);
  assert.doesNotMatch(JSON.stringify(other), /replace|re-enter|\.\./i);
});

test('the model check lists the built-in Free API with its own last result', async () => {
  const chat = async () => ({ label: 'Ollama · q', ms: 900 });
  const busy = await C.modelCheck({ halted: false, online: true, routes: ['router', 'ollama'], chat, free: { name: 'Free API', on: true }, lastCalls: () => ({ router: { ok: false, at: 'x', error: 'HTTP 429 Too many requests.' } }), when });
  assert.equal(busy.state, 'fine');
  assert.match(busy.details.join(' '), /Free API: Busy right now \(10 Mar, 5:30 pm\): the provider is limiting requests/);
  const ok = await C.modelCheck({ halted: false, online: true, routes: ['router'], chat, free: { name: 'Free API', on: true }, lastCalls: () => ({ router: { ok: true, at: 'x' } }), when });
  assert.match(ok.details.join(' '), /Free API: The last call worked \(10 Mar, 5:30 pm\)\./);
  const off = await C.modelCheck({ halted: false, online: true, routes: [], chat, free: { name: 'Free API', on: false }, lastCalls: () => ({}), when });
  assert.match(off.details.join(' '), /Free API: switched off\./);
});

test('disk, port, updates, local model and switches read as plain lines', () => {
  const low = C.diskCheck({ free: 1024 ** 3, total: 100 * 1024 ** 3, dbBytes: 5 * 1024 ** 2, workspaceBytes: 0, workspaceMore: false });
  assert.equal(low.state, 'problem'); assert.match(low.line, /Only 1\.0 GB free/); assert.match(low.details.join(' '), /database: 5\.0 MB/);
  assert.equal(C.diskCheck({ free: 50 * 1024 ** 3, total: 100 * 1024 ** 3, dbBytes: 1, workspaceBytes: 1, workspaceMore: true }).state, 'fine');
  const taken = C.portCheck({ port: 3447, usual: 3445, usualTaken: true });
  assert.equal(taken.state, 'problem'); assert.match(taken.line, /Another program is using port 3445\. The desk uses port 3447\./);
  assert.equal(C.portCheck({ port: 3445, usual: 3445 }).state, 'fine');
  assert.equal(C.updatesCheck({ setUp: true, layout: 'zip', version: '0.1.0', last: { result: 'error', at: 'x', line: 'Could not reach GitHub.' }, daily: true, channel: 'stable', when }).state, 'problem');
  assert.match(C.updatesCheck({ setUp: false, layout: 'zip', version: '0.1.0', last: null, daily: true, channel: 'stable', when }).line, /not set up/);
  const loc = C.localCheck({ active: [{ provider: 'ollama', ok: true, models: ['q:1'] }], lastCalls: { ollama: { ok: false, at: 'x' } }, when });
  assert.equal(loc.state, 'problem'); assert.deepEqual(loc.place, { page: 'models' });
  assert.equal(C.localCheck({ active: [{ provider: 'ollama', ok: false }], lastCalls: {}, when }).state, 'fine');
  const sw = C.switchesCheck({ online: false, halted: false, benchOn: true, benchEnabled: false, networkOn: false });
  assert.match(sw.details.join(' '), /Online: off/); assert.match(sw.details.join(' '), /Bench: module on, Bench mode off/); assert.match(sw.details.join(' '), /Network: module off/);
});

test('the learned table in plain words', () => {
  const lines = C.learnedLines({ rows: [{ purpose: 'research', label: 'Free API · a2', calls: 20, ok: 19, medianMs: 4200, enough: true, free: true }, { purpose: 'small', label: 'Ollama · q', calls: 1, ok: 0, medianMs: null, enough: false }] });
  assert.equal(lines[0].line, 'For research, Free API · a2 answered 19 of 20 times, usually in 4 seconds.');
  assert.equal(lines[1].line, 'For quick checks, Ollama · q answered 0 of 1 time.');
});

test('Check my desk on a desk: on by default, owner only, one real call counted, keys never shown, Offline and Panic skip', async () => {
  const t = await testDesk({ modules: ['doctor'], script: () => 'ok' });
  const PROXY = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']; const proxyWas = PROXY.map(k => process.env[k]); for (const k of PROXY) delete process.env[k];   // the PC's own proxy adds a row of its own
  const realFetch = globalThis.fetch; const out = [];
  globalThis.fetch = (u, init) => { if (String(u).includes('cloudflare.com')) { out.push(String(u)); return Promise.resolve(new Response('colo=BOM', { status: 200 })); } return realFetch(u, init); };
  Object.assign(testHooks, { statfs: () => ({ bavail: 10 * 1024 ** 2, bsize: 4096, blocks: 50 * 1024 ** 2 }), portTaken: async () => true, usualPort: 3445 });
  try {
    assert.ok(t.core.modules.isOn('doctor'), 'on from first run');
    assert.ok(t.core.modules.list().find(m => m.id === 'doctor').menu.some(x => x.label === 'Doctor'));
    assert.equal((await t.call('/api/m/doctor/check', { body: {}, session: false })).status, 403);
    t.core.model.addKey('groq', 'gsk_secret_value_987654');
    const before = t.core.storage.get('SELECT COUNT(*) AS n FROM calls').n;
    const r = (await t.call('/api/m/doctor/check', { body: {} })).json;
    const by = Object.fromEntries(r.checks.map(c => [c.id, c]));
    assert.deepEqual(Object.keys(by), ['model', 'keys', 'internet', 'disk', 'local', 'updates', 'port', 'switches']);
    assert.equal(by.model.state, 'fine', by.model.line); assert.match(by.model.line, /answered in/); assert.match(by.model.details.join(' '), /Free API: The last call worked/);
    assert.equal(t.core.storage.get('SELECT COUNT(*) AS n FROM calls').n, before + 1, 'counted as a real call');
    assert.equal(t.core.storage.get('SELECT purpose FROM calls ORDER BY id DESC LIMIT 1').purpose, 'small');
    assert.equal(by.internet.state, 'fine'); assert.equal(out.length, 1);
    assert.equal(by.disk.state, 'fine'); assert.equal(by.port.state, 'problem');
    assert.match(by.keys.details.join(' '), /Groq: 1 of 1 key on\. Not used yet\./);
    const text = JSON.stringify(r);
    assert.doesNotMatch(text, /gsk_|secret_value|987654/);
    const shown = r.checks.flatMap(c => [c.line, c.todo, ...(c.details || [])]).concat(r.atText).filter(Boolean).join(' ');
    assert.doesNotMatch(shown, /\d{4}-\d\d-\d\dT\d\d:\d\d/, 'no UTC times in what the owner reads');
    assert.ok(Array.isArray(r.learned.lines)); assert.match(r.learned.rule, /free and local/);
    assert.equal((await t.call('/api/m/doctor/learned')).status, 200);

    t.core.settings.set('online', false); out.length = 0; const calls = t.fake.calls.length;
    const off = Object.fromEntries((await t.call('/api/m/doctor/check', { body: {} })).json.checks.map(c => [c.id, c]));
    assert.equal(off.model.state, 'skipped'); assert.equal(off.internet.state, 'skipped');
    assert.equal(t.fake.calls.length, calls); assert.equal(out.length, 0);
    t.core.settings.set('online', true);
    await t.core.panic.stopAll('test');
    const stop = Object.fromEntries((await t.call('/api/m/doctor/check', { body: {} })).json.checks.map(c => [c.id, c]));
    assert.equal(stop.model.state, 'skipped'); assert.match(stop.model.line, /Resume/); assert.equal(t.fake.calls.length, calls);
    t.core.panic.resume();
    const settingsAfter = JSON.stringify(t.core.settings.all());
    await t.call('/api/m/doctor/check', { body: {} });
    assert.equal(JSON.stringify(t.core.settings.all()), settingsAfter, 'the Doctor changes no setting');
  } finally { PROXY.forEach((k, i) => { if (proxyWas[i] != null) process.env[k] = proxyWas[i]; }); globalThis.fetch = realFetch; for (const k of Object.keys(testHooks)) delete testHooks[k]; await t.close(); }
});

test('a proxy on this PC: shown by host and port only, with what the desk does about it; no row when none is set', () => {
  assert.equal(C.proxyCheck({ env: {} }), null);
  const used = C.proxyCheck({ env: { HTTPS_PROXY: 'http://alice:secret@proxy.example:8080', NODE_USE_ENV_PROXY: '1' } });
  assert.equal(used.state, 'fine'); assert.match(used.line, /go through proxy\.example:8080\. The desk itself, Ollama and the local engine never go through it\.$/);
  assert.doesNotMatch(JSON.stringify(used), /alice|secret/);
  const not = C.proxyCheck({ env: { http_proxy: 'proxy.example:3128' }, failing: true });
  assert.equal(not.state, 'problem'); assert.match(not.line, /the desk was not started with it, so its web calls go straight out\. Start the desk with start\.bat/);
});
