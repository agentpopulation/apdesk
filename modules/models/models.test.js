// Plumbing tests for the Models module against the fake model. Never evidence that a real model works.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testDesk } from '../../test/helpers/desk.js';
import { recommend } from './hardware.js';
import { safeFirst } from './catalog.js';
import { lanUrl, plainError } from './server.js';

test('usage shows "not known" for a cost that cannot be known, with the tokens; a key is marked free/paid/not sure (owner only)', async () => {
  const t = await testDesk({ modules: ['models'] });
  const m = (p, o) => t.call('/api/m/models' + p, o);
  try {
    t.core.settings.set('currency', 'INR');
    const k = (await m('/keys', { body: { provider: 'gemini', value: 'test-key-12345678', label: 'Mine', model: 'gemini-3.5-flash-lite' } })).json;
    // a sign-up key whose tier the desk cannot know: its call is recorded with a NULL cost
    t.core.storage.run("INSERT INTO calls (at, purpose, provider, model, ok, ms, input_tokens, output_tokens, cost_minor, currency) VALUES (?, 'chat', 'gemini', 'gemini-3.5-flash-lite', 1, 10, 1000000, 1000000, NULL, 'INR')", new Date().toISOString());
    const row = (await m('/usage')).json.today.find(x => x.provider === 'gemini');
    assert.equal(row.unknown, 1); assert.equal(row.cost, 0, 'no known cost, never shown as a number'); assert.ok(row.atList >= 1, 'its list price is given for the screen'); assert.ok(row.tokens >= 2000000, 'the tokens are shown');
    // the owner marks the key: another program (no session) cannot; the owner's word is kept and shown
    assert.equal((await m(`/keys/${k.id}/tier`, { body: { tier: 'free' }, session: false })).status, 403, 'only the owner marks a key');
    assert.equal((await m(`/keys/${k.id}/tier`, { body: { tier: 'free' } })).json.tier, 'free');
    assert.equal((await m('/providers')).json.providers.find(p => p.id === 'gemini').keys.find(x => x.id === k.id).tier, 'free');
    assert.equal(t.core.model.keysFor('gemini').find(x => x.id === k.id).meta.tier, 'free');
    assert.equal((await m(`/keys/${k.id}/tier`, { body: { tier: null } })).json.tier, null, 'back to not sure');
    const src = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
    assert.match(src, /'not known'/, 'the usage table shows "not known", never ₹0, for an unknown cost');
    assert.match(src, /keys\/\$\{encodeURIComponent\(k\.id\)\}\/tier/, 'each key has the Free tier / Paid / Not sure choice');
  } finally { await t.close(); }
});

test('routes: overview, test through the door, keys never come back, pickers, usage', async () => {
  const t = await testDesk({ modules: ['models'], script: (b) => b.messages?.some(m => /ready/.test(m.content)) ? 'ready' : 'hello' });
  const m = (p, o) => t.call('/api/m/models' + p, o);
  try {
    const o = (await m('/overview')).json;
    assert.ok(o.active.some(a => a.provider === 'router')); assert.equal(o.router.mode, 'owner');
    const r = (await m('/test', { body: { provider: 'router' } })).json;
    assert.equal(r.ok, true); assert.match(r.label, /^Free API · fake-model$/);
    const k = (await m('/keys', { body: { provider: 'custom', value: 'sk-secret-abcdefgh', label: 'Fake', baseUrl: t.fake.baseUrl, model: 'agent-model' } })).json;
    assert.ok(!JSON.stringify((await m('/providers')).json).includes('sk-secret-abcdefgh'));
    assert.equal((await m('/test', { body: { provider: 'custom', keyId: k.id } })).json.ok, true);
    // the other key stays switched as it was after an isolated test
    assert.equal((await m('/providers')).json.providers.find(p => p.id === 'custom').keys.find(x => x.id === k.id).enabled, true);
    const av = (await m('/available')).json; const g = av.groups;
    t.core.settings.set('model.defaultChain', ['gemini', 'router', 'ollama']);
    assert.equal((await m('/available')).json.defaultLabel, 'Desk default (Gemini, then Free API, then Ollama)');
    assert.ok(g.some(x => x.provider === 'router')); assert.ok(g.some(x => x.provider === 'custom'));
    assert.ok(!g.some(x => x.provider === 'ollama'), 'Ollama is not running, so it is not offered');
    assert.equal((await m('/keys/' + k.id, { method: 'DELETE', session: false })).status, 403, 'only the owner removes keys');
    const u = (await m('/usage')).json; assert.ok(u.today.length >= 1);
    const tool = await t.core.modules.runTool('model_test', { provider: 'router' }); assert.equal(tool.results[0].answers, true);
    assert.ok(t.core.modules.api('models').routerStatus);
  } finally { await t.close(); }
});

test('a reply that is not the asked word (a host answering its own error) does not pass', async () => {
  const t = await testDesk({ modules: ['models'], script: () => 'The API key used for this request has reached its budget.' });
  try { const r = (await t.call('/api/m/models/test', { body: { provider: 'router' } })).json; assert.equal(r.ok, false); assert.match(r.error, /something else/); }
  finally { await t.close(); }
});

test('offline: only local and LAN models are offered and answer (stand-in endpoint)', async () => {
  const t = await testDesk({ modules: ['models'] });
  try {
    t.core.settings.set('ollama.baseUrl', t.fake.ollamaUrl); t.core.settings.set('online', false); t.core.model.cache.clear();
    const g = (await t.call('/api/m/models/available')).json.groups;
    assert.deepEqual(g.map(x => x.provider), ['ollama']);
    const r = (await t.call('/api/m/models/test', { body: { provider: 'router' } })).json; assert.equal(r.ok, false);
  } finally { await t.close(); }
});

test('hardware rules: a 32 GB card fits 32B, never an uncensored pick first', () => {
  const r = recommend({ ramGb: 64, gpu: { name: 'NVIDIA GeForce RTX 5090', vramGb: 31.8 } });
  assert.equal(r.maxParamsB, 32); assert.ok(r.picks.find(p => p.tag === 'qwen3:32b').fits); assert.ok(!r.picks.find(p => p.tag === 'llama3.3:70b').fits);
  assert.deepEqual(safeFirst(['dolphin-uncensored:8b', 'qwen3:8b', 'x-abliterated']), ['qwen3:8b', 'dolphin-uncensored:8b', 'x-abliterated']);
  assert.equal(lanUrl('192.168.1.20:11434'), 'http://192.168.1.20:11434/v1');
  assert.match(plainError(new Error('No model answered. Groq · x: HTTP 401 bad')), /refused/);
});

test('a keyed provider over quota keeps its group: list call throws, every model failed, key Test failed on quota', async () => {
  const t = await testDesk({ modules: ['models'] });
  try {
    t.core.model.addKey('gemini', 'AIza-fake-key-123456', 'Test key');
    t.core.model.listModels = async () => { throw Object.assign(new Error('HTTP 429 quota'), { status: 429 }); };
    const models = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
    for (const model of models) t.core.model.record({ provider: 'gemini', model, ok: false, ms: 5, error: 'HTTP 429 You exceeded your current quota' });
    const key = t.core.model.keysFor('gemini').find(k => k.label === 'Test key');
    t.core.storage.kvScope('m:models').set('tests', { ['gemini||' + key.id]: { ok: false, provider: 'gemini', model: 'gemini-3.6-flash', at: new Date().toISOString(), error: 'Rate limited right now. Try again in a minute.' } });
    const gem = (await t.call('/api/m/models/available')).json.groups.find(x => x.provider === 'gemini');
    assert.ok(gem, 'the Gemini group is still offered');
    assert.ok(models.every(m => gem.models.includes(m)), 'catalog models are offered: ' + gem.models.join(', '));
    assert.ok(models.every(m => gem.failing[m] === 'out of quota now'));
    assert.match(gem.note, /Google Gemini is over its free quota right now; it will be tried again automatically/);
  } finally { await t.close(); }
});
