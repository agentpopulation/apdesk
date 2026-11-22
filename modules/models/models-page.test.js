// Models page: the Free API name, why a test failed, the whole model list, and the paid switch. Plumbing only, against
// stand-ins (the fake model, a stand-in Ollama, a stand-in model list). Never evidence that a real provider works.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testDesk } from '../../test/helpers/desk.js';
import { ROUTER_NAME } from '../../app/core/model-door.js';

test('the built-in free models are named "Free API by Agent Population Desk", short "Free API"; ids stay', async () => {
  const t = await testDesk({ modules: ['models'], script: () => 'ready' });
  try {
    assert.deepEqual(ROUTER_NAME, { full: 'Free API by Agent Population Desk', short: 'Free API' });
    assert.equal(t.core.model.label('router', 'Qwen3.8-27B', 'OVHcloud AI Endpoints'), 'Free API · Qwen3.8-27B (OVHcloud AI Endpoints)');
    const r = await t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'small' });
    assert.equal(r.provider, 'router'); assert.match(r.label, /^Free API · fake-model$/);
    const act = (await t.core.model.active()).find(a => a.provider === 'router');
    assert.equal(act.label, 'Free API by Agent Population Desk'); assert.equal(act.shortLabel, 'Free API');
    assert.equal(t.core.model.resolve().chain[0].name, 'Free API', 'the line under the message box reads the short name from the door');
    const o = (await t.call('/api/m/models/overview')).json;
    assert.equal(o.router.name, 'Free API by Agent Population Desk');
    assert.doesNotMatch(JSON.stringify(o), /Agent Population Router|Free LLM Router|the owner's/);
    const g = (await t.call('/api/m/models/available')).json.groups.find(x => x.provider === 'router');
    assert.equal(g.label, 'Free API by Agent Population Desk');
  } finally { await t.close(); }
});

// A stand-in that speaks Ollama's API: /api/tags, /api/ps and the OpenAI-compatible /v1/chat/completions.
async function standInOllama(reply) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url === '/api/tags') return send(200, { models: [{ name: 'llama3.2:1b', size: 1300000000, details: { family: 'llama', parameter_size: '1.2B' } }] });
    if (req.url === '/api/ps') return send(200, { models: [] });
    for await (const c of req) void c;
    calls.push(req.url);
    const out = await reply(calls.length);
    if (out.delayMs) await new Promise(r => setTimeout(r, out.delayMs));
    if (res.destroyed) return;
    if (out.status) return send(out.status, { error: out.text || 'error' });
    send(200, { model: 'llama3.2:1b', choices: [{ message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }] });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

test('a local model: a slow first call (loading) passes within the local limit; any short reply from the model counts, shown with what it said', async () => {
  const o = await standInOllama((n) => ({ delayMs: n === 1 ? 600 : 0, text: 'Hello! How can I help?' }));
  const t = await testDesk({ modules: ['models'] });
  try {
    t.core.settings.set('ollama.baseUrl', o.url); t.core.model.cache.clear();
    t.core.storage.kvScope('m:models').set('testLimits', { hosted: 300, localFirst: 2000, localRetry: 1000 });
    const r = (await t.call('/api/m/models/test', { body: { provider: 'ollama' } })).json;
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.local, true);
    assert.equal(r.said, 'Hello! How can I help?');
    assert.match(r.at, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await t.call('/api/m/models/ollama/loaded?model=llama3.2:1b')).json.loaded, false, 'not in memory yet: the page shows "Loading the model…"');
  } finally { await t.close(); await o.close(); }
});

test('a local model that times out on its first call gets one second try; both timing out says why in plain words', async () => {
  const o = await standInOllama((n) => ({ delayMs: n === 1 ? 1500 : 0, text: 'ready' }));
  const t = await testDesk({ modules: ['models'] });
  try {
    t.core.settings.set('ollama.baseUrl', o.url); t.core.model.cache.clear();
    t.core.storage.kvScope('m:models').set('testLimits', { hosted: 300, localFirst: 500, localRetry: 1000 });
    const r = (await t.call('/api/m/models/test', { body: { provider: 'ollama' } })).json;
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.tries, 2);
    const o2 = await standInOllama(() => ({ delayMs: 2000, text: 'ready' }));
    t.core.settings.set('ollama.baseUrl', o2.url); t.core.model.cache.clear();
    const r2 = (await t.call('/api/m/models/test', { body: { provider: 'ollama' } })).json;
    await o2.close();
    assert.equal(r2.ok, false); assert.equal(r2.tries, 2);
    assert.match(r2.error, /^No answer within 1 second/); assert.match(r2.error, /may still be loading/);
    const empty = await standInOllama(() => ({ text: '' }));
    t.core.settings.set('ollama.baseUrl', empty.url); t.core.model.cache.clear();
    const r3 = (await t.call('/api/m/models/test', { body: { provider: 'ollama' } })).json;
    await empty.close();
    assert.equal(r3.ok, false); assert.equal(r3.error, 'It answered with nothing.');
  } finally { await t.close(); await o.close(); }
});

test('a hosted provider that fails says why: too many requests, its own notice, no answer in time', async () => {
  let mode = 'busy';
  const t = await testDesk({ modules: ['models'], script: () => mode === 'busy' ? { status: 429, text: 'slow down' } : mode === 'notice' ? 'Sorry, this service is unavailable in your region.' : { delayMs: 800, text: 'ready' } });
  try {
    t.core.storage.kvScope('m:models').set('testLimits', { hosted: 300, localFirst: 2000, localRetry: 1000 });
    const busy = (await t.call('/api/m/models/test', { body: { provider: 'router' } })).json;
    assert.equal(busy.ok, false); assert.equal(busy.error, 'Too many requests right now. Try again in a minute.');
    mode = 'notice'; t.core.model.cooldown.clear();
    const notice = (await t.call('/api/m/models/test', { body: { provider: 'router' } })).json;
    assert.equal(notice.ok, false); assert.match(notice.error, /^It answered with something else: "Sorry, this service/);
    mode = 'slow'; t.core.model.cooldown.clear();
    const slow = (await t.call('/api/m/models/test', { body: { provider: 'router' } })).json;
    assert.equal(slow.ok, false); assert.match(slow.error, /^No answer within 0\.3 seconds/);
  } finally { await t.close(); }
});

// OpenRouter's public model list, as it looks (shape only; a few entries).
const OR_LIST = { data: [
  { id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0', completion: '0' } },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', pricing: { prompt: '0', completion: '0' } },
  { id: 'openai/gpt-5.5', pricing: { prompt: '0.000002', completion: '0.000008' } },
  { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
  ...Array.from({ length: 300 }, (_, i) => ({ id: `vendor/model-${i}`, pricing: { prompt: '0.000001', completion: '0.000002' } })),
] };

test('OpenRouter: the whole public list before any key, read through the door (cached, refused offline), free only while paid is off', async () => {
  const t = await testDesk({ modules: ['models'] });
  try {
    const seen = []; const real = t.core.model.fetch;
    t.core.model.fetch = async (url, init) => { if (String(url).startsWith('https://openrouter.ai/')) { seen.push({ url: String(url), auth: init?.headers?.authorization || null }); return new Response(JSON.stringify(OR_LIST), { headers: { 'content-type': 'application/json' } }); } return real(url, init); };
    const c = (await t.call('/api/m/models/catalog/openrouter')).json;
    assert.equal(seen.length, 1); assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/models'); assert.equal(seen[0].auth, null, 'no key needed');
    assert.equal(c.source, 'live'); assert.match(c.at, /^\d{4}-/); assert.equal(c.needsKey, false);
    assert.deepEqual(c.models.map(m => m.id), ['google/gemma-4-31b-it:free', 'meta-llama/llama-3.3-70b-instruct:free'], 'paid off: free ones only');
    assert.ok(c.models.every(m => m.price === 'free')); assert.equal(c.total, 304); assert.equal(c.hiddenPaid, 302);
    await t.call('/api/m/models/catalog/openrouter'); assert.equal(seen.length, 1, 'cached for a few minutes');
    t.core.settings.set('openrouter.allowPaid', true);
    const all = (await t.call('/api/m/models/catalog/openrouter')).json;
    assert.equal(all.models.length, 304, 'no cap of 40');
    assert.equal(all.models.find(m => m.id === 'openai/gpt-5.5').price, 'paid');
    assert.equal(all.models.find(m => m.id === 'openrouter/auto').price, null, 'a price the provider does not state is not guessed');
    t.core.settings.set('openrouter.allowPaid', false);
    t.core.model.cache.clear(); t.core.settings.set('online', false);
    const off = (await t.call('/api/m/models/catalog/openrouter')).json;
    assert.equal(seen.length, 1, 'Offline: not read'); assert.equal(off.source, 'suggested'); assert.match(off.error, /offline/i);
  } finally { await t.close(); }
});

test('a provider that lists models only to a key holder: before a key, the suggested default and "Add a key to see every model"', async () => {
  const t = await testDesk({ modules: ['models'] });
  try {
    const c = (await t.call('/api/m/models/catalog/groq')).json;
    assert.equal(c.needsKey, true); assert.equal(c.source, 'suggested');
    assert.ok(c.models.some(m => m.id === 'llama-3.3-70b-versatile'));
    const p = (await t.call('/api/m/models/providers')).json.providers;
    assert.equal(p.find(x => x.id === 'openrouter').listsWithoutKey, true);
    assert.equal(p.find(x => x.id === 'groq').listsWithoutKey, false);
  } finally { await t.close(); }
});

test('the paid switch: off by default, one setting, changed only from the desk window; the door refuses it without the token', async () => {
  const t = await testDesk({ modules: ['models', 'payments'] });
  try {
    const prov = async () => (await t.call('/api/m/models/providers')).json.providers;
    const or = (await prov()).find(x => x.id === 'openrouter');
    assert.equal(or.paid, 'switch'); assert.equal(or.paidOn, false);
    assert.equal((await prov()).find(x => x.id === 'openai').paid, 'always');
    assert.equal((await prov()).find(x => x.id === 'gemini').paid, 'account');
    assert.equal((await t.call('/api/settings/paid-models', { body: { provider: 'openrouter', on: true }, session: false })).status, 403);
    await t.call('/api/settings', { body: { 'openrouter.allowPaid': true } });
    await t.call('/api/m/models/test', { body: { provider: 'openrouter', openrouterPaid: true, on: true } });
    assert.throws(() => t.core.model.setPaid('openrouter', true), /only from the desk/);
    assert.equal(typeof t.core.modules.api('models') && t.core.model.forModule().setPaid, undefined, 'modules do not get the switch');
    assert.equal(t.core.settings.get('openrouter.allowPaid'), false);
    const on = await t.call('/api/settings/paid-models', { body: { provider: 'openrouter', on: true } });
    assert.equal(on.status, 200); assert.equal(on.json.on, true);
    assert.equal(t.core.settings.get('openrouter.allowPaid'), true);
    assert.equal((await prov()).find(x => x.id === 'openrouter').paidOn, true, 'both places read the same setting');
    assert.match(t.core.approval.activityList(5).map(a => a.title).join(' | '), /Paid OpenRouter models switched on/);
    await t.call('/api/settings/paid-models', { body: { provider: 'openrouter', on: false } });
    assert.equal(t.core.settings.get('openrouter.allowPaid'), false);
    assert.equal((await t.call('/api/settings/paid-models', { body: { provider: 'openai', on: true } })).status, 400);
  } finally { await t.close(); }
});

test('the small-model note is shown: the engine card and the first-start box both show plan.note as a plain line', async () => {
  const fs = await import('node:fs');
  const ui = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  assert.match(ui, /plan\.note \? ui\.h\('p', \{ class: 'sub', 'data-apd': 'engine-note' \}, plan\.note\) : null/);
  const shell = fs.readFileSync(new URL('../../app/ui/shell.js', import.meta.url), 'utf8');
  const box = shell.slice(shell.indexOf('function localModelBox()'), shell.indexOf('async function firstStep('));
  assert.match(box, /note\.textContent = plan\.note \|\| ''; note\.hidden = !plan\.note;/);
  assert.match(box, /h\('span', \{ class: 'd', 'data-apd': 'local-model-note', hidden: true \}\)/);
});

test('the first-start box never leaves a low-memory PC with nothing to do: it offers Check again, which reads the memory afresh', async () => {
  const fs = await import('node:fs');
  const shell = fs.readFileSync(new URL('../../app/ui/shell.js', import.meta.url), 'utf8');
  const box = shell.slice(shell.indexOf('function localModelBox()'), shell.indexOf('async function firstStep('));
  assert.match(box, /'Check again'/);
  assert.match(box, /plan\.lowMemory/);
  assert.match(box, /fresh=1/);
  assert.match(box, /Close some programs/);
  const routes = fs.readFileSync(new URL('../../app/core/downloads-routes.js', import.meta.url), 'utf8');
  assert.match(routes, /fresh: query\.fresh === '1'/);
});

test('the first-start box: Check again keeps the owner\'s untick; only a model he picks ticks the box again', async () => {
  const fs = await import('node:fs');
  const shell = fs.readFileSync(new URL('../../app/ui/shell.js', import.meta.url), 'utf8');
  const box = shell.slice(shell.indexOf('function localModelBox()'), shell.indexOf('async function firstStep('));
  assert.match(box, /again\.onclick = [^\n]*read\(pick\.id, true\)/, 'Check again reads afresh for the same model');
  assert.match(box, /show\(plan, !!id && !fresh\)/, 'a fresh read is not a pick');
  assert.match(box, /cb\.onchange = \(\) => \{ unticked = !cb\.checked; \}/, 'the owner\'s untick is remembered');
  assert.match(box, /cb\.checked = picked \|\| !unticked;/, 'the box is ticked again only by a pick, or when he never unticked it');
});

test('an Ollama model card says where it comes from: the Ollama registry, or the host named in the model', async () => {
  const t = await testDesk({ modules: ['models'] });
  try {
    const card = async (model) => {
      const r = await t.call('/api/m/models/ollama/pull', { body: { model } }); assert.equal(r.status, 200, r.text);
      let c; for (let i = 0; i < 100 && !c; i++) { c = t.core.approval.listPending().find(a => a.action === 'install' && a.payload?.model === model); if (!c) await new Promise(r => setTimeout(r, 30)); }
      assert.ok(c, 'the owner is asked'); t.core.approval.decide(c.id, 'deny'); return c;
    };
    const plain = await card('qwen3:4b');
    assert.match(plain.detail, /From registry\.ollama\.ai\./); assert.match(plain.detail, /Ollama on this PC/);
    const hf = await card('hf.co/someone/some-model-GGUF:Q4_K_M');
    assert.match(hf.detail, /From hf\.co\./); assert.doesNotMatch(hf.detail, /registry\.ollama\.ai/);
  } finally { await t.close(); }
});
