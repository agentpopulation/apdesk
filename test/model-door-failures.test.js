// A failure that reaches a person is one plain line with a short code; the raw text goes to the log only.
// No internet is said as such, never as "the free models are busy". No real model or network is used: the door's
// fetch is a stand-in that fails the way Node's fetch fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testDesk } from './helpers/desk.js';
import { plainFailure, failureKind, FAILURE_LINES } from '../app/core/model-door.js';

const netErr = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ' + code), { code }) });
const loop = (u) => /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(u));
const ask = (t) => t.core.model.chat({ messages: [{ role: 'user', content: 'Hello there' }], purpose: 'chat' });
const RAW = /fetch failed|HTTP \d|ENOTFOUND|EAI_AGAIN|\{|·/;

async function offlineDesk(fail) {
  const t = await testDesk({ withFake: false });
  t.core.settings.set('router.enabled', true); t.core.settings.set('router.builtin', true);
  t.core.settings.set('router.baseUrl', 'http://router.example.invalid/v1'); t.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1');
  t.core.model.backoff = { ...t.core.model.backoff, otherMs: 60000, busyMs: 60000 };
  const logs = []; t.core.model.log = (...a) => logs.push(a.join(' '));
  t.core.model.fetch = async (u, init) => { if (loop(u)) return globalThis.fetch(u, init); return fail(u); };
  return { t, logs };
}

test('plainFailure: one line and a code per kind; the desk\'s own sentences keep their words', () => {
  assert.deepEqual(plainFailure(netErr('ENOTFOUND')), { code: 'not_online', line: 'This PC is not online. Local models still work.' });
  assert.equal(plainFailure(netErr('EAI_AGAIN')).code, 'not_online');
  assert.equal(plainFailure(Object.assign(new Error('HTTP 401 bad key'), { status: 401 })).code, 'refused');
  assert.equal(plainFailure(Object.assign(new Error('HTTP 429 [{ "error"'), { status: 429 })).line, FAILURE_LINES.busy);
  assert.equal(plainFailure(Object.assign(new Error('x'), { name: 'TimeoutError' })).code, 'timeout');
  assert.equal(plainFailure(netErr('ECONNREFUSED')).code, 'no_answer');
  assert.equal(plainFailure(Object.assign(new Error('no such table: m_x'), { code: 'ERR_SQLITE_ERROR' })).line, FAILURE_LINES.failed, 'a database message is not shown');
  assert.equal(plainFailure(new TypeError("Cannot read properties of undefined (reading 'x')")).line, FAILURE_LINES.failed);
  assert.equal(plainFailure(new Error('That schedule needs a time.')).line, 'That schedule needs a time.', 'a hand-written sentence stays');
  assert.equal(failureKind(Object.assign(new Error('Stopped'), { code: 'halted' })), 'halted');
  for (const l of Object.values(FAILURE_LINES)) assert.doesNotMatch(l, /null|undefined|object Object|fetch|HTTP|\d{3}/);
});

test('plainFailure: a file-system fault, a system code, a path or program text never reaches the page', async () => {
  const fsp = await import('node:fs/promises');
  for (const go of [() => fsp.readFile('/nope/secret/path.txt'), () => fsp.mkdir('/proc/x/y'), () => fsp.readdir('/etc/passwd')]) {
    const e = await go().then(() => null, (x) => x);
    assert.ok(e, 'it failed');
    const f = plainFailure(e);
    assert.deepEqual(f, { code: 'failed', line: 'Something went wrong on this PC. The details are in the desk\'s log.' }, e.message);
  }
  for (const e of [Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }), Object.assign(new Error('could not save'), { errno: -28 }),
    new Error('could not open C:\\Users\\me\\file.txt'), new Error('could not open /home/me/file.txt'), new Error('value was undefined'), new Error('{"error":"x"}')]) {
    assert.equal(plainFailure(e).line, FAILURE_LINES.failed, e.message);
  }
  assert.equal(plainFailure(Object.assign(new Error('That chat is already running.'), { code: 'busy_chat' })).line, 'That chat is already running.', 'a desk code keeps the sentence');
});

test('out of credit or payment needed is its own plain line, never busy', async () => {
  const f = plainFailure(Object.assign(new Error('Payment required: insufficient credits'), { status: 402 }));
  assert.equal(f.code, 'no_credit');
  assert.doesNotMatch(f.line, /busy|minute/i);
  assert.match(f.line, /credit|payment/i);
  const paid = await offlineDesk(() => new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 }));
  try {
    const e = await ask(paid.t).catch(x => x);
    assert.equal(plainFailure(e).code, 'no_credit', e.message);
    assert.doesNotMatch(e.message, /busy/i); assert.doesNotMatch(e.message, RAW);
  } finally { await paid.t.close(); }
});

test('no internet: chat says the PC is not online, in plain words, the first time and again while the free hosts cool down', async () => {
  const { t, logs } = await offlineDesk(() => { throw netErr('ENOTFOUND'); });
  try {
    for (const round of [1, 2]) {
      const e = await ask(t).then(() => null, (x) => x);
      assert.ok(e, 'it failed');
      assert.equal(e.message, 'This PC is not online. Local models still work.', `round ${round}: ${e.message}`);
      assert.equal(plainFailure(e).code, 'not_online');
      assert.doesNotMatch(e.message, /busy/i);
      assert.doesNotMatch(e.message, RAW);
    }
    assert.ok(logs.some(l => /fetch failed/.test(l)), 'the raw attempt list is in the log');
  } finally { await t.close(); }
});

test('a host that is busy is said to be busy; a refused key is said to be refused', async () => {
  const busy = await offlineDesk(() => new Response(JSON.stringify({ error: { message: 'You exceeded your current quota' } }), { status: 429 }));
  try {
    const e = await ask(busy.t).catch(x => x);
    assert.equal(plainFailure(e).code, 'busy'); assert.match(e.message, /busy/); assert.doesNotMatch(e.message, RAW);
  } finally { await busy.t.close(); }
  const refused = await offlineDesk(() => new Response('{"error":"bad key"}', { status: 401 }));
  try {
    const e = await ask(refused.t).catch(x => x);
    assert.equal(plainFailure(e).code, 'refused'); assert.match(e.message, /refused/); assert.doesNotMatch(e.message, RAW);
  } finally { await refused.t.close(); }
});

test('a fault in a route reaches the page as one plain line and a short code; the raw text stays in the log', async () => {
  const t = await testDesk({ withFake: false });
  try {
    t.core.settings.set('router.enabled', true); t.core.settings.set('router.builtin', true); t.core.settings.set('router.baseUrl', 'http://router.example.invalid/v1');
    t.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1');
    t.core.model.fetch = async (u, init) => { if (loop(u)) return globalThis.fetch(u, init); throw netErr('ENOTFOUND'); };
    const r = await t.call('/api/model/ask', { body: { prompt: 'hi', stream: false } });
    const last = JSON.parse(r.text.trim().split('\n').at(-1));
    assert.equal(last.error, 'This PC is not online. Local models still work.'); assert.equal(last.why, 'not_online');
  } finally { await t.close(); }
});

test('the model door uses the fetch of the moment, so the Offline guard and its data count see the keeper\'s calls', async () => {
  const t = await testDesk({ withFake: false });
  const real = globalThis.fetch; const seen = [];
  try {
    globalThis.fetch = async (u, init) => { seen.push(String(u)); return real(u, init); };
    t.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1');
    await t.core.model.ollamaModels();
    assert.ok(seen.some(u => u.startsWith('http://127.0.0.1:1/api/tags')), 'the call went through the global fetch installed after the door was made');
  } finally { globalThis.fetch = real; await t.close(); }
});

test('embeddings: a paid key is not called past the spend limit; every embedding call is in the call log', async () => {
  const hits = [];
  const host = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } })); });
  await new Promise(r => host.listen(0, '127.0.0.1', r));
  const t = await testDesk({ withFake: false });
  try {
    t.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1');
    t.core.model.addKey('openai', 'sk-embed-test-12345678', 'Mine', { baseUrl: `http://127.0.0.1:${host.address().port}/v1` });
    t.core.settings.set('spend.perDay', 0); t.core.settings.set('spend.perMonth', 0);
    assert.ok(t.core.model.overLimit());
    await assert.rejects(t.core.model.embed({ texts: ['hello'] }), (e) => e.code === 'unavailable');
    assert.equal(hits.length, 0, 'the paid key was not called past the limit');
    t.core.settings.set('spend.perDay', 1e9); t.core.settings.set('spend.perMonth', 1e9);
    const r = await t.core.model.embed({ texts: ['hello'] });
    assert.equal(r.provider, 'openai'); assert.equal(hits.length, 1);
    const row = t.core.storage.get("SELECT * FROM calls WHERE purpose = 'embed' ORDER BY id DESC LIMIT 1");
    assert.equal(row.provider, 'openai'); assert.equal(row.ok, 1); assert.equal(row.input_tokens, 3);
    // Panic cuts an embedding like any other call
    await t.core.panic.stopAll('test');
    await assert.rejects(t.core.model.embed({ texts: ['hello'] }), (e) => e.code === 'halted');
    t.core.panic.resume();
  } finally { await t.close(); host.close(); }
});

test('an embedding call counts in the call log but does not become the latest call of its provider', async () => {
  const t = await testDesk({ withFake: false });
  try {
    t.core.model.record({ purpose: 'chat', provider: 'ollama', model: 'small:1b', ok: true, ms: 10 });
    // what embedOn writes when the embedding model was removed from Ollama
    t.core.model.record({ purpose: 'embed', provider: 'ollama', model: 'nomic-embed-text', ok: false, ms: 5, error: 'HTTP 404' });
    assert.ok(t.core.storage.get("SELECT COUNT(*) AS n FROM calls WHERE purpose = 'embed' AND provider = 'ollama' AND ok = 0").n >= 1, 'the embed is in the log');
    const last = t.core.model.lastCalls().ollama;
    assert.equal(last.ok, true, 'the latest chat call is what the provider shows');
    assert.equal(last.model, 'small:1b');
  } finally { await t.close(); }
});

test('a file-system fault through a route: one plain line on the page, no path and no system code; the detail is in the log', async () => {
  const t = await testDesk({ withFake: false });
  try {
    const fsp = await import('node:fs/promises');
    let fsErr = null; try { await fsp.readFile('/nope/secret/path.txt'); } catch (e) { fsErr = e; }
    t.core.model.chat = async () => { throw fsErr; };
    const r = await t.call('/api/model/ask', { body: { prompt: 'hi', stream: false } });
    const last = JSON.parse(r.text.trim().split('\n').at(-1));
    assert.equal(last.error, 'Something went wrong on this PC. The details are in the desk\'s log.');
    assert.equal(last.code, 'error'); assert.equal(last.why, 'failed');
    assert.doesNotMatch(r.text, /ENOENT|nope|secret/);
  } finally { await t.close(); }
});
