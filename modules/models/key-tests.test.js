// A key tests itself when it is saved; Test all says how it went; service keys (search, reading, voice) work like model
// providers. Plumbing only, against stand-ins (the fake model, a stand-in service). Never evidence that a real one works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
test('a key saved while Offline or after Panic is not tested: the reason shows on its row and no call is made', async () => {
  const t = await testDesk({ modules: ['models'], script: () => 'ready' });
  const m = (p, o) => t.call('/api/m/models' + p, o);
  try {
    const k = (await m('/keys', { body: { provider: 'custom', value: 'sk-secret-abcdefgh', label: 'Fake', baseUrl: t.fake.baseUrl, model: 'agent-model' } })).json;
    t.core.settings.set('online', false);
    const before = t.fake.calls?.length ?? 0;
    const off = (await m('/test', { body: { provider: 'custom', keyId: k.id, auto: true } })).json;
    assert.equal(off.ok, false); assert.equal(off.skipped, true); assert.match(off.error, /offline/i);
    assert.equal(t.fake.calls?.length ?? 0, before, 'no call was made');
    const row = (await m('/providers')).json.providers.find(p => p.id === 'custom').keys.find(x => x.id === k.id);
    assert.equal(row.test.skipped, true, 'the reason shows on the key row');
    t.core.settings.set('online', true);
    await t.core.panic.stopAll('test');
    const halted = (await m('/test', { body: { provider: 'custom', keyId: k.id, auto: true } })).json;
    assert.equal(halted.skipped, true); assert.match(halted.error, /stopped/i);
    t.core.panic.resume();
    const ok = (await m('/test', { body: { provider: 'custom', keyId: k.id, auto: true } })).json;
    assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally { await t.close(); }
});

test('a new OpenRouter key is tested on a free model while Paid models is off, even when a paid default was chosen', async () => {
  const t = await testDesk({ modules: ['models'] });
  try {
    const sent = []; const real = t.core.model.fetch;
    t.core.model.fetch = async (url, init) => {
      if (String(url).startsWith('https://openrouter.ai/api/v1/chat')) { const b = JSON.parse(init.body); sent.push(b.model); return new Response(JSON.stringify({ model: b.model, choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }); }
      return real(url, init);
    };
    t.core.settings.set('provider.openrouter.model', 'openai/gpt-5.5');
    const k = (await t.call('/api/m/models/keys', { body: { provider: 'openrouter', value: 'sk-or-stand-in-12345678', label: 'Work key' } })).json;
    const r = (await t.call('/api/m/models/test', { body: { provider: 'openrouter', keyId: k.id, auto: true } })).json;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(sent.length >= 1 && sent.every(x => /:free$/.test(x) || x === 'openrouter/free'), `free only: ${sent}`);
  } finally { await t.close(); }
});

test('Test all keeps how it went: none before any test, then how many answered and when', async () => {
  const t = await testDesk({ modules: ['models'], script: () => 'ready' });
  try {
    assert.equal((await t.call('/api/m/models/overview')).json.testAll, null);
    const r = (await t.call('/api/m/models/test-all', { method: 'POST' })).json;
    assert.ok(r.results.length >= 1);
    const s = (await t.call('/api/m/models/overview')).json.testAll;
    assert.equal(s.total, r.results.length); assert.equal(s.ok, r.results.filter(x => x.ok).length); assert.match(s.at, /^\d{4}-/);
  } finally { await t.close(); }
});

test('service keys on the Models page: several labelled keys, owner only, each tested with one call of that service', async () => {
  const t = await testDesk({ modules: ['models'] });
  const realFetch = globalThis.fetch; const seen = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://google.serper.dev/')) { seen.push(init.headers['X-API-KEY']); return new Response('{}', { status: init.headers['X-API-KEY'] === 'serper-good-key-123456' ? 200 : 403 }); }
    return realFetch(url, init);
  };
  const m = (p, o) => t.call('/api/m/models' + p, o);
  try {
    assert.equal((await m('/services')).json.many, true);
    assert.equal((await m('/services/serper/keys', { body: { value: 'serper-good-key-123456', label: 'Work' }, session: false })).status, 403, 'only from the desk');
    const a = (await m('/services/serper/keys', { body: { value: 'serper-good-key-123456', label: 'Work' } })).json;
    const b = (await m('/services/serper/keys', { body: { value: 'serper-bad-key-0000000', label: 'Old plan' } })).json;
    assert.ok(a.id && b.id); assert.doesNotMatch(JSON.stringify(a), /serper-good/);
    const good = (await m(`/services/serper/keys/${a.id}/test`, { method: 'POST' })).json;
    assert.equal(good.ok, true); assert.ok(good.ms >= 0);
    const bad = (await m(`/services/serper/keys/${b.id}/test`, { method: 'POST' })).json;
    assert.equal(bad.ok, false); assert.match(bad.error, /refused the key/);
    assert.deepEqual(seen, ['serper-good-key-123456', 'serper-bad-key-0000000'], 'one call per test');
    const list = (await m('/services')).json.services.find(s => s.id === 'serper');
    assert.deepEqual(list.keys.map(k => [k.label, k.test.ok]), [['Work', true], ['Old plan', false]]);
    assert.match(list.spends, /one search/);
    assert.doesNotMatch(JSON.stringify(list), /serper-good-key|serper-bad-key/);
    assert.equal(t.core.services.get('serper'), 'serper-good-key-123456', 'the Page reading card and search read the same store');
    t.core.settings.set('online', false);
    const off = (await m(`/services/serper/keys/${a.id}/test`, { method: 'POST' })).json;
    assert.equal(off.skipped, true); assert.equal(seen.length, 2, 'offline: no call');
    t.core.settings.set('online', true);
    assert.equal((await m(`/services/keys/${b.id}`, { method: 'DELETE', session: false })).status, 403);
    assert.equal((await m(`/services/keys/${b.id}/toggle`, { body: { on: false } })).json.ok, true);
    assert.equal((await m(`/services/keys/${b.id}`, { method: 'DELETE' })).json.ok, true);
    assert.equal((await m('/services')).json.services.find(s => s.id === 'serper').keys.length, 1);
  } finally { globalThis.fetch = realFetch; await t.close(); }
});

test('only the models module gets the key work; every module can say its key was refused, and the next key is handed out', async () => {
  const t = await testDesk({ modules: ['models', 'search'] });
  try {
    const ctxOf = (id) => t.core.modules.context({ id, dir: '.' }, {});
    assert.deepEqual(Object.keys(ctxOf('search').services), ['list'], 'another module sees the list only');
    assert.equal(ctxOf('search').services.forModule, undefined);
    assert.deepEqual(Object.keys(ctxOf('models').services).sort(), ['add', 'keys', 'list', 'removeKey', 'report', 'test', 'toggleKey']);
    t.core.services.add('serper', 'serper-first-key-1234', 'First'); t.core.services.add('serper', 'serper-second-key-123', 'Second');
    const search = ctxOf('search');
    assert.equal(search.serviceKey('serper'), 'serper-first-key-1234');
    search.serviceKeyRefused('serper', 'refused');
    assert.equal(search.serviceKey('serper'), 'serper-second-key-123', 'a refused key rests; the next one is used');
    search.serviceKeyRefused('serper', 'anything else');   // only 'allowance' is read as allowance; anything else is a refusal
    assert.deepEqual(t.core.services.keys('serper').map(k => k.resting), ['refused', 'refused']);
    assert.equal(search.serviceKeyRefused('nope', 'refused'), false);
  } finally { await t.close(); }
});

test('no route answer carries a key value: every module page and the core key routes, with keys saved', async () => {
  const t = await testDesk({ modules: ['models', 'search', 'voice'] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(String(u)) ? realFetch(u, i) : new Response('{}', { status: 401 });   // nothing leaves this PC
  const values = ['serper-secret-value-1234', 'jina-secret-value-12345', 'eleven-secret-value-123'];
  try {
    t.core.services.add('serper', values[0], 'Work'); t.core.services.set('jina', values[1]); t.core.services.add('elevenlabs', values[2], 'Voice');
    const gets = t.core.modules.routes.filter(r => r.method === 'GET' && !r.parts.some(x => x.startsWith(':') || x === '*')).map(r => r.parts.join('/'));
    assert.ok(gets.length > 10);
    const kid = t.core.services.keys('serper')[0].id;
    const answers = await Promise.all([...gets, '/api/keys/services'].map(p => t.call(p)));
    answers.push(await t.call(`/api/m/models/services/serper/keys/${kid}/test`, { method: 'POST' }));
    answers.push(await t.call('/api/m/models/services/exa/keys', { body: { value: 'exa-secret-value-123456', label: 'New' } }));
    for (const [i, a] of answers.entries()) for (const v of [...values, 'exa-secret-value-123456']) assert.ok(!a.text.includes(v), `${gets[i] || 'a key route'} shows a key value`);
  } finally { globalThis.fetch = realFetch; await t.close(); }
});
