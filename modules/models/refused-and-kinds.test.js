// A refused key does not make a provider active; the model lists offer only models that can chat. Plumbing only,
// against stand-in hosts (never a real provider).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

test('a provider whose only key was refused is not active: it is listed as not answering, and the count follows', async () => {
  const t = await testDesk({ modules: ['models'], script: () => 'ready' });
  const m = (p, o) => t.call('/api/m/models' + p, o);
  try {
    const real = t.core.model.fetch;
    t.core.model.fetch = async (url, init) => String(url).startsWith('https://api.groq.com/') ? new Response('{"error":"bad key"}', { status: 401 }) : real(url, init);
    const k = (await m('/keys', { body: { provider: 'groq', value: 'sk-test-wrong', label: 'Wrong' } })).json;
    const first = (await m('/overview')).json.active.find(a => a.provider === 'groq');
    assert.equal(first.ok, true, 'before any test the key is not known to be refused');
    const r = (await m('/test', { body: { provider: 'groq', keyId: k.id, auto: true } })).json;
    assert.equal(r.ok, false); assert.match(r.error, /refused/i);
    const g = (await m('/overview')).json.active.find(a => a.provider === 'groq');
    assert.equal(g.ok, false); assert.equal(g.refused, true);
    assert.match(g.test.error, /refused/i, 'the card shows the refusal, not "Not tested yet"');
    // a second key that works brings it back
    t.core.model.fetch = async (url, init) => String(url).startsWith('https://api.groq.com/')
      ? (JSON.parse(init.body || '{}').model ? new Response(JSON.stringify({ model: 'llama', choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 200 }))
      : real(url, init);
    const k2 = (await m('/keys', { body: { provider: 'groq', value: 'sk-test-right', label: 'Right' } })).json;
    await m('/test', { body: { provider: 'groq', keyId: k2.id, auto: true } });
    const back = (await m('/overview')).json.active.find(a => a.provider === 'groq');
    assert.notEqual(back.refused, true, 'one key that is not refused keeps the provider active');
  } finally { await t.close(); }
});

test('model lists: only models the provider says can chat (methods, kind, endpoints), no list of names', async () => {
  const t = await testDesk({ modules: ['models'] });
  try {
    const real = t.core.model.fetch;
    const GEM = ['gemini-3.6-flash', 'lyria-3', 'genie-4', 'nano-banana-2', 'robotics-er-2', 'gemini-embedding-2'];
    t.core.model.fetch = async (url, init) => {
      const u = String(url);
      const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
      if (u === 'https://generativelanguage.googleapis.com/v1beta/openai/models') return json({ data: GEM.map(id => ({ id: 'models/' + id, object: 'model' })) });
      if (u.startsWith('https://generativelanguage.googleapis.com/v1beta/models')) return json({ models: GEM.map(id => ({ name: 'models/' + id, supportedGenerationMethods: id === 'gemini-3.6-flash' ? ['generateContent', 'countTokens'] : id === 'gemini-embedding-2' ? ['embedContent'] : ['predict'] })) });
      if (u === 'https://api.mistral.ai/v1/models') return json({ data: [{ id: 'mistral-small-latest', capabilities: { completion_chat: true } }, { id: 'mistral-ocr-latest', capabilities: { completion_chat: false } }] });
      return real(url, init);
    };
    t.core.model.addKey('gemini', 'AIza-fake-key-123456', 'Stand-in');
    t.core.model.addKey('mistral', 'mistral-fake-key-123456', 'Stand-in');
    const g = (await t.call('/api/m/models/available')).json.groups;
    const gem = g.find(x => x.provider === 'gemini');
    assert.ok(gem.models.includes('gemini-3.6-flash'));
    for (const bad of ['lyria-3', 'genie-4', 'nano-banana-2', 'robotics-er-2', 'gemini-embedding-2']) assert.ok(!gem.models.includes(bad), `${bad} cannot chat and is not offered`);
    const mis = g.find(x => x.provider === 'mistral');
    assert.ok(mis.models.includes('mistral-small-latest') && !mis.models.includes('mistral-ocr-latest'));
  } finally { await t.close(); }
});
