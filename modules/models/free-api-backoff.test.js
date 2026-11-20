// The door's back-off on the built-in Free API: free hosts that said no are skipped for a while, calls spread over the
// models, a host that is off by default is never called. Plumbing only, against the fake model as stand-in hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { retryAfterMs, firstSentence } from '../../app/core/model-door.js';

const ask = (t, extra = {}) => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'small', ...extra });
async function freeDesk(script) {
  const t = await testDesk({ script: (b) => script(b.model) });
  t.core.settings.set('router.baseUrl', 'http://127.0.0.1:1/v1'); t.core.settings.set('router.builtin', true);
  ups(t, [{ id: 'hostA', name: 'Host A', baseUrl: t.fake.baseUrl, models: ['a1', 'a2'] }]);
  t.core.model.cache.clear();
  Object.assign(t.core.model.backoff, { busyMs: 400, unavailableMs: 5000, timeoutMs: 1000, otherMs: 200 });
  return t;
}
// the catalog's own hosts are switched off here, so no test reaches a real host
const OFF = [{ id: 'ovh', enabled: false }, { id: 'pollinations', enabled: false }];
const ups = (t, list) => t.core.settings.set('router.upstreams', [...OFF, ...list]);
const until = (t, m) => (t.core.model.cooldown.get('router|builtin:hostA:' + m) || 0) - Date.now();

test('a 429 with "retry after" skips that model for the time the host named; without one, the default; the next model answers', async () => {
  let busy = 'a1'; let notice = 'API rate limit exceeded. Retry after 2s';
  const t = await freeDesk((m) => m === busy ? { status: 429, text: notice } : 'ok from ' + m);
  try {
    const r = await ask(t);
    assert.equal(r.model, 'a2'); assert.equal(r.text, 'ok from a2');
    const left = until(t, 'a1'); assert.ok(left > 1500 && left <= 2000, 'skipped for the 2 s the host named: ' + left);
    const r2 = await ask(t); assert.equal(r2.model, 'a2'); assert.equal(r2.attempts.length, 1, 'a skipped model is not an attempt');
    busy = 'a2'; notice = 'API rate limit exceeded'; t.core.model.cooldown.clear();
    ups(t, [{ id: 'hostA', name: 'Host A', baseUrl: t.fake.baseUrl, models: ['a2', 'a1'] }]);
    t.core.model.lastPick.clear();
    const r3 = await ask(t); assert.equal(r3.model, 'a1');
    const left2 = until(t, 'a2'); assert.ok(left2 > 200 && left2 <= 400, 'no time named: the default busy skip: ' + left2);
  } finally { await t.close(); }
});

test('"model unavailable" skips that model for the long time and the Router tab can show it', async () => {
  const t = await freeDesk((m) => m === 'a1' ? { status: 400, text: "Model 'a1' is currently unavailable." } : 'ok');
  try {
    const r = await ask(t); assert.equal(r.model, 'a2');
    assert.ok(until(t, 'a1') > 4000, 'the long skip');
    assert.equal(t.core.model.routerCooling().hostA.a1.why, 'unavailable');
  } finally { await t.close(); }
});

test('every free model cooling down: the call ends at once with a plain line and the earliest time', async () => {
  const t = await freeDesk(() => ({ status: 429, text: 'rate limit exceeded' }));
  try {
    await assert.rejects(ask(t));
    const t0 = Date.now();
    const e = await ask(t).catch(x => x);
    assert.ok(Date.now() - t0 < 100, 'no waiting');
    assert.equal(e.code, 'all_failed');
    assert.match(e.message, /^The free models are busy\. The next one may answer in about \d+ seconds\. A free key or a local model in Models avoids this\.$/);
    assert.ok(e.retryAt && Date.parse(e.retryAt) > Date.now());
    assert.equal(t.fake.calls.length, 2, 'only the first call reached the host');
  } finally { await t.close(); }
});

test('calls spread over the free models: the one tried longest ago goes first; tools still go only to tool models', async () => {
  const t = await freeDesk((m) => 'ok ' + m);
  try {
    ups(t, [{ id: 'hostA', name: 'Host A', baseUrl: t.fake.baseUrl, models: ['a1', 'a2', 'a3'], noTools: ['a3'] }]);
    const used = []; for (let i = 0; i < 6; i++) used.push((await ask(t)).model);
    assert.deepEqual(used.slice(0, 3).sort(), ['a1', 'a2', 'a3']); assert.deepEqual(used.slice(3), used.slice(0, 3));
    const tools = [{ name: 'x', description: 'x', parameters: { type: 'object', properties: {} } }];
    for (let i = 0; i < 3; i++) assert.notEqual((await ask(t, { tools })).model, 'a3');
  } finally { await t.close(); }
});

test('a host that is off by default is not called by a turn, even from a saved copy of the list with old model names', async () => {
  const t = await freeDesk(() => 'ok');
  try {
    const hit = []; const real = t.core.model.fetch;
    t.core.model.fetch = (url, init) => { if (String(url).includes('llm7')) hit.push(String(url)); return real(url, init); };
    ups(t, [{ id: 'llm7', name: 'LLM7.io', baseUrl: t.fake.baseUrl, models: ['GLM-5.3-Flash'] }, { id: 'hostA', name: 'Host A', baseUrl: t.fake.baseUrl, models: ['a1'] }]);
    for (let i = 0; i < 3; i++) assert.equal((await ask(t)).via, 'hostA');
    assert.deepEqual(hit, []);
    const up = t.core.model.forModule().freeRouter().upstreams.find(u => u.id === 'llm7');
    assert.equal(up.enabled, false); assert.equal(up.baseUrl, 'https://api.llm7.io/v1', 'definitions come from the catalog, not a saved copy');
  } finally { await t.close(); }
});

test('a host notice is cut at its first sentence, without links; retry times are read from the text', () => {
  assert.equal(firstSentence('The API key used for this request has reached its budget. Raise it at https://enter.pollinations.ai/edit-key?id=abc123 now.'), 'The API key used for this request has reached its budget.');
  assert.equal(firstSentence('See https://x.example/a?id=1 for more'), 'See for more');
  assert.equal(retryAfterMs('1 reply every 45 seconds per IP. Retry after 28s'), 28000);
  assert.equal(retryAfterMs('Please retry in 3600 seconds.'), 3600000);
  assert.equal(retryAfterMs('try again in 2 minutes'), 120000);
  assert.equal(retryAfterMs('rate limit exceeded'), 0);
});

test('a Test of one free host calls only that host, even while its model cools down', async () => {
  const t = await freeDesk((m) => m === 'b1' ? 'ready' : { status: 429, text: 'rate limit exceeded' });
  try {
    ups(t, [{ id: 'hostA', name: 'Host A', baseUrl: t.fake.baseUrl, models: ['a1'] }, { id: 'hostB', name: 'Host B', baseUrl: t.fake.baseUrl, models: ['b1'] }]);
    await ask(t, { model: { provider: 'router', model: 'a1', via: 'hostA' } }).catch(() => {});
    const before = t.fake.calls.length;
    const e = await ask(t, { model: { provider: 'router', model: 'a1', via: 'hostA' } }).catch(x => x);
    assert.equal(e.code, 'all_failed'); assert.equal(t.fake.calls.length, before + 1); assert.equal(t.fake.calls.at(-1).model, 'a1', 'not handed to Host B');
  } finally { await t.close(); }
});
