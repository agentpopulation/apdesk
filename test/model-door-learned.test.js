// The model door learns from its own call log: among the free and local candidates it would try anyway, the one with the
// better record for that kind of ask goes first. A fake clock and seeded calls; the fake model stands in for every host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';
import { LEARN } from '../app/core/model-door.js';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const DAY = 86400000;
const OFF = [{ id: 'ovh', enabled: false }, { id: 'pollinations', enabled: false }];

async function freeDesk() {
  const t = await testDesk({ script: (b) => 'ok from ' + b.model });
  t.core.settings.set('router.baseUrl', 'http://127.0.0.1:1/v1'); t.core.settings.set('router.builtin', true);
  t.core.settings.set('router.upstreams', [...OFF, { id: 'hostA', name: 'Host A', baseUrl: t.fake.baseUrl, models: ['a1', 'a2'] }]);
  t.core.model.cache.clear();
  t.core.model.clock = () => NOW;
  return t;
}
/** n calls of one model, `ok` of them answered, each taking ms, `ago` before the fake clock. */
function seed(t, { purpose = 'research', provider = 'router', model, n, ok = n, ms = 3000, ago = DAY }) {
  for (let i = 0; i < n; i++) t.core.storage.run('INSERT INTO calls (at, purpose, provider, model, ok, ms) VALUES (?, ?, ?, ?, ?, ?)', new Date(NOW - ago - i * 1000).toISOString(), purpose, provider, model, i < ok ? 1 : 0, ms);
  t.core.model.learnCache = null;
}
const ask = (t, extra = {}) => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'research', ...extra });
const firstAsked = (t) => t.fake.calls[0]?.model;

test('the free model with the better record for that kind of ask is tried first; other kinds keep the usual order', async () => {
  const t = await freeDesk();
  try {
    seed(t, { model: 'a1', n: 6, ok: 2 }); seed(t, { model: 'a2', n: 6, ok: 6 });
    const r = await ask(t);
    assert.equal(firstAsked(t), 'a2'); assert.equal(r.model, 'a2'); assert.equal(r.attempts.length, 1);
    t.fake.calls.length = 0; t.core.model.lastPick.clear();
    await ask(t, { purpose: 'chat' });
    assert.equal(firstAsked(t), 'a1', 'no record for chat: the usual order');
  } finally { await t.close(); }
});

test('too few calls, or calls older than 7 days: the usual order', async () => {
  const t = await freeDesk();
  try {
    assert.equal(LEARN.minCalls, 5); assert.equal(LEARN.days, 7);
    seed(t, { model: 'a1', n: 5, ok: 1 }); seed(t, { model: 'a2', n: 4, ok: 4 });
    await ask(t); assert.equal(firstAsked(t), 'a1', 'a2 has only 4 calls');
    t.fake.calls.length = 0; t.core.model.lastPick.clear();
    seed(t, { model: 'a2', n: 6, ok: 6, ago: 8 * DAY });
    await ask(t); assert.equal(firstAsked(t), 'a1', 'calls from 8 days ago do not count');
  } finally { await t.close(); }
});

test('the same share answered: the faster median time goes first', async () => {
  const t = await freeDesk();
  try {
    seed(t, { model: 'a1', n: 5, ms: 9000 }); seed(t, { model: 'a2', n: 5, ms: 2000 });
    await ask(t); assert.equal(firstAsked(t), 'a2');
    const row = t.core.model.forModule().learned().rows.find(x => x.purpose === 'research' && x.model === 'a2');
    assert.deepEqual({ calls: row.calls, ok: row.ok, medianMs: row.medianMs, provider: row.provider }, { calls: 5, ok: 5, medianMs: 2000, provider: 'router' });
    assert.match(row.label, /a2/);
  } finally { await t.close(); }
});

test('a model the owner picked for an agent, or an explicit pick, is never overridden', async () => {
  const t = await freeDesk();
  try {
    seed(t, { model: 'a1', n: 6, ok: 1 }); seed(t, { model: 'a2', n: 6, ok: 6 });
    t.core.agents.update('scout', { model: { main: { provider: 'router', model: 'a1' }, fallback: null } });
    const r = await ask(t, { agentId: 'scout' });
    assert.equal(firstAsked(t), 'a1'); assert.equal(r.model, 'a1');
    t.fake.calls.length = 0;
    await ask(t, { model: { provider: 'router', model: 'a1' } });
    assert.equal(firstAsked(t), 'a1');
  } finally { await t.close(); }
});

test('chain order: a free or local step with the better record moves ahead only among its free neighbours; a keyed step and the owner\'s own order stay put', async () => {
  const t = await testDesk();
  try {
    const m = t.core.model; m.clock = () => NOW;
    t.core.settings.set('network.lanNodes', [{ id: 'n1', name: 'Box', baseUrl: t.fake.baseUrl }]);
    m.addKey('groq', 'gsk_test_key_123456');
    seed(t, { provider: 'router', model: 'fake-model', n: 6, ok: 1 });
    seed(t, { provider: 'ollama', model: 'fake-local', n: 6, ok: 6 });
    seed(t, { provider: 'lan:n1', model: 'fake-model', n: 6, ok: 6 });
    seed(t, { provider: 'groq', model: 'x', n: 9, ok: 9, ms: 10 });
    const plain = m.resolve().chain.map(c => c.provider);
    assert.deepEqual(plain, ['router', 'ollama', 'groq', 'lan:n1']);
    assert.deepEqual(m.learnedChain(m.resolve().chain, 'research').map(c => c.provider), ['ollama', 'router', 'groq', 'lan:n1'], 'no step crosses a keyed step');
    assert.deepEqual(m.learnedChain(m.resolve().chain, 'chat').map(c => c.provider), plain, 'no record for chat');
    t.core.settings.set('model.defaultChain', ['router', 'keyed', 'ollama']);
    assert.deepEqual(m.learnedChain(m.resolve().chain, 'research').map(c => c.provider), m.resolve().chain.map(c => c.provider), 'an order the owner set by hand is kept');
    t.core.settings.set('model.defaultChain', ['router', 'ollama', 'keyed']); t.core.settings.set('ollama.model', 'fake-local:latest');
    seed(t, { provider: 'ollama', model: 'fake-local:latest', n: 6, ok: 6, ms: 5 });
    assert.equal(m.learnedChain(m.resolve().chain, 'research')[1].provider, 'ollama', 'a model picked by hand as the default does not move');
  } finally { await t.close(); }
});

test('a free step never moves behind a paid keyed provider, even when a LAN node after it has the better record', async () => {
  const t = await testDesk();
  try {
    const m = t.core.model; m.clock = () => NOW;
    t.core.settings.set('network.lanNodes', [{ id: 'n1', name: 'Box', baseUrl: 'http://127.0.0.1:1/v1' }]);
    m.addKey('openai', 'sk-test_key_1234567890');
    seed(t, { provider: 'router', model: 'x', n: 6, ok: 4 });
    seed(t, { provider: 'lan:n1', model: 'y', n: 6, ok: 6 });
    const plain = m.resolve().chain.map(c => c.provider);
    assert.deepEqual(plain, ['router', 'ollama', 'openai', 'lan:n1']);
    assert.deepEqual(m.learnedChain(m.resolve().chain, 'research').map(c => c.provider), plain);
  } finally { await t.close(); }
});

test('a LAN node with a model named by the owner keeps its place; the others trade among themselves', async () => {
  const t = await testDesk();
  try {
    const m = t.core.model; m.clock = () => NOW;
    t.core.settings.set('network.lanNodes', [{ id: 'n1', name: 'A', baseUrl: 'http://127.0.0.1:1/v1', model: 'owner-picked' }, { id: 'n2', name: 'B', baseUrl: 'http://127.0.0.1:1/v1' }, { id: 'n3', name: 'C', baseUrl: 'http://127.0.0.1:1/v1' }]);
    seed(t, { provider: 'router', model: 'x', n: 6, ok: 1 });
    seed(t, { provider: 'lan:n1', model: 'owner-picked', n: 6, ok: 0 });
    seed(t, { provider: 'lan:n2', model: 'y', n: 6, ok: 2 });
    seed(t, { provider: 'lan:n3', model: 'y', n: 6, ok: 6 });
    const plain = m.resolve().chain.map(c => c.provider);
    assert.deepEqual(plain, ['router', 'ollama', 'lan:n1', 'lan:n2', 'lan:n3']);
    assert.deepEqual(m.learnedChain(m.resolve().chain, 'research').map(c => c.provider), ['router', 'ollama', 'lan:n1', 'lan:n3', 'lan:n2']);
  } finally { await t.close(); }
});

test('the learned table and the last call per provider are offered through the door, without keys', async () => {
  const t = await freeDesk();
  try {
    seed(t, { model: 'a1', n: 3, ok: 2, ms: 4000 });
    t.core.storage.run('INSERT INTO calls (at, purpose, provider, model, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)', new Date(NOW - 1000).toISOString(), 'chat', 'groq', 'llama-x', 0, 300, 'HTTP 401 Invalid API Key');
    t.core.model.learnCache = null;
    const L = t.core.model.forModule().learned();
    assert.equal(L.days, 7); assert.equal(L.minCalls, 5);
    const a1 = L.rows.find(x => x.model === 'a1');
    assert.equal(a1.calls, 3); assert.equal(a1.ok, 2); assert.equal(a1.enough, false);
    const last = t.core.model.forModule().lastCalls();
    assert.equal(last.groq.ok, false); assert.match(last.groq.error, /401/); assert.ok(last.groq.at);
    assert.equal(last.router.model, 'a1');
  } finally { await t.close(); }
});
