// The model door for research and tool turns: the owner's real chain (Free API on auto, then a small local model as the
// agent's fallback, then his free keys). Stand-in hosts on loopback; plumbing only, never proof that a model answers well.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testDesk } from './helpers/desk.js';
import { smallModel } from '../app/core/model-door.js';

/** An Ollama stand-in: /api/tags names the models with their size, /api/show says what each can do, /v1 answers. */
async function fakeOllama(models, answer = (b) => 'local answer from ' + b.model) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/tags') return json({ models: models.map(m => ({ name: m.name, size: 1, details: { parameter_size: m.params } })) });
    if (req.url === '/api/show') { const m = models.find(x => x.name === (body.model || body.name)); return json({ capabilities: m?.tools ? ['completion', 'tools'] : ['completion'] }); }
    calls.push(body);
    json({ model: body.model, choices: [{ message: { role: 'assistant', content: answer(body) }, finish_reason: 'stop' }] });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
/** The owner's chain: Free API (six free models, all busy) on auto, then llama3.2:1b on Ollama as Scout's fallback, then a Gemini key. */
async function ownerDesk({ routerAnswers = false, tools = true } = {}) {
  const t = await testDesk({ script: (b) => b.model === 'gemini-test' ? 'keyed answer' : routerAnswers ? 'free answer' : { status: 429, text: 'rate limit exceeded' } });
  const ol = await fakeOllama([{ name: 'llama3.2:1b', params: '1.2B', tools }]);
  t.core.settings.set('router.baseUrl', 'http://127.0.0.1:1/v1'); t.core.settings.set('router.builtin', true);
  t.core.settings.set('router.upstreams', [{ id: 'ovh', enabled: false }, { id: 'pollinations', enabled: false }, { id: 'llm7', enabled: false }, { id: 'hostA', name: 'Host A', baseUrl: t.fake.baseUrl, models: ['r1', 'r2', 'r3'] }, { id: 'hostB', name: 'Host B', baseUrl: t.fake.baseUrl, models: ['r4', 'r5', 'r6'] }]);
  t.core.settings.set('ollama.baseUrl', ol.url);
  t.core.settings.set('model.defaultChain', ['router', 'ollama', 'keyed']);
  t.core.model.addKey('gemini', 'gm-test-12345678', 'test', { baseUrl: t.fake.baseUrl, model: 'gemini-test' });
  t.core.agents.update('scout', { model: { main: { provider: 'router', model: 'auto' }, fallback: { provider: 'ollama', model: 'llama3.2:1b' } } });
  t.core.model.cache.clear();
  return { t, ol, async close() { await t.close(); await ol.close(); } };
}
const msg = [{ role: 'user', content: 'find more details about VR200' }];
const TOOL = [{ name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } }];

test('small: by the size Ollama reports, the engine figure, or the name', () => {
  assert.equal(smallModel({ params: '1.2B' }), true); assert.equal(smallModel({ params: '3.2B' }), true);
  assert.equal(smallModel({ params: '8.0B' }), false); assert.equal(smallModel({ params: '14B' }), false);
  assert.equal(smallModel({ name: 'llama3.2:1b' }), true); assert.equal(smallModel({ name: 'qwen2.5:1.5b' }), true);
  assert.equal(smallModel({ name: 'qwen2.5:14b' }), false); assert.equal(smallModel({ name: 'mistral' }), false);
  assert.equal(smallModel({ bytes: 1.3e9 }), true); assert.equal(smallModel({ bytes: 5e9 }), false);
});

test('router on auto and the default router step are one step; six busy free models still reach the key', async () => {
  const d = await ownerDesk();
  try {
    const chain = d.t.core.model.resolve('scout').chain.map(c => c.provider);
    assert.equal(chain.filter(p => p === 'router').length, 1, JSON.stringify(chain));
    const r = await d.t.core.model.chat({ agentId: 'scout', messages: msg, purpose: 'research' });
    assert.equal(r.provider, 'gemini', 'the keyed model answered: ' + JSON.stringify(r.attempts));
    assert.equal(d.ol.calls.length, 0, 'the 1B model was not asked before the key');
    assert.ok(!r.small);
  } finally { await d.close(); }
});

test('a research call or a tool call puts a small local model behind the keys; a plain chat keeps the owner\'s order', async () => {
  const d = await ownerDesk();
  try {
    const order = (o) => d.t.core.model.chainFor('scout', o).then(c => c.map(x => x.provider));
    const research = await order({ purpose: 'research' });
    assert.ok(research.indexOf('gemini') < research.indexOf('ollama'), JSON.stringify(research));
    const tools = await order({ purpose: 'chat', tools: TOOL });
    assert.ok(tools.indexOf('gemini') < tools.indexOf('ollama'), JSON.stringify(tools));
    const plain = await order({ purpose: 'chat' });
    assert.ok(plain.indexOf('ollama') < plain.indexOf('gemini'), 'plain chat: the fallback stays where the owner put it');
    // the owner can turn the rule off
    d.t.core.settings.set('model.smallLocalLast', false);
    const off = await order({ purpose: 'research' });
    assert.ok(off.indexOf('ollama') < off.indexOf('gemini'));
  } finally { await d.close(); }
});

test('when only the small local model is left, it answers a research call and the result says it is small', async () => {
  const d = await ownerDesk();
  try {
    for (const k of d.t.core.model.keysFor('gemini')) d.t.core.model.toggleKey(k.id, false);
    const r = await d.t.core.model.chat({ agentId: 'scout', messages: msg, purpose: 'research' });
    assert.equal(r.provider, 'ollama'); assert.equal(r.small, true);
    assert.match(r.text, /local answer/);
  } finally { await d.close(); }
});

test('an Ollama model that cannot call tools is skipped for a turn with tools, and the skip is no attempt', async () => {
  const d = await ownerDesk({ tools: false });
  try {
    for (const k of d.t.core.model.keysFor('gemini')) d.t.core.model.toggleKey(k.id, false);
    await assert.rejects(() => d.t.core.model.chat({ agentId: 'scout', messages: msg, tools: TOOL, purpose: 'chat' }), (e) => {
      const o = e.attempts.find(a => a.provider === 'ollama');
      return e.code === 'all_failed' && o && /cannot use tools/.test(o.error) && o.skipped === true;
    });
    assert.equal(d.ol.calls.length, 0);
    // without tools the same model answers
    const r = await d.t.core.model.chat({ agentId: 'scout', messages: msg, purpose: 'chat' });
    assert.equal(r.provider, 'ollama');
  } finally { await d.close(); }
});

test('"not available" steps do not use up the six attempts', async () => {
  const d = await ownerDesk();
  try {
    d.t.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1');   // Ollama not running: not available
    d.t.core.model.cache.clear();
    d.t.core.settings.set('model.defaultChain', ['router', 'ollama', 'ollama', 'keyed']);
    const r = await d.t.core.model.chat({ agentId: 'scout', messages: msg, purpose: 'chat' });
    assert.equal(r.provider, 'gemini', JSON.stringify(r.attempts));
  } finally { await d.close(); }
});

test('the plan of a research turn also puts the small model behind the keys; the same Ollama model is one step', async () => {
  const d = await ownerDesk();
  try {
    const plan = (await d.t.core.model.chainFor('scout', { purpose: 'plan' })).map(x => x.provider + '/' + (x.model || '-'));
    assert.ok(plan.indexOf('gemini/-') < plan.findIndex(x => x.startsWith('ollama')), JSON.stringify(plan));
    assert.equal(plan.filter(x => x.startsWith('ollama')).length, 1, 'llama3.2:1b as the fallback and as Ollama\'s default is tried once: ' + JSON.stringify(plan));
  } finally { await d.close(); }
});
