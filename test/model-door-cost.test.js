// What a call cost, as the desk can know it: 0 for a free route, a free model or a key on a free tier; a list-price
// estimate for a paid route; unknown (NULL) where the desk cannot know whether the call was charged. An unknown cost
// still counts against the owner's spend limit at the list price. The fake model stands in for the provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';

const ask = (t, extra = {}) => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'chat', ...extra });
const lastCall = (t) => t.core.storage.get('SELECT * FROM calls ORDER BY id DESC LIMIT 1');
async function geminiDesk(meta = {}, script) {
  const t = await testDesk({ script });
  t.core.settings.set('currency', 'INR');
  t.core.settings.set('router.enabled', false);
  t.core.model.addKey('gemini', 'test-key-12345678', 'Mine', { baseUrl: t.fake.baseUrl, model: 'gemini-3.5-flash-lite', ...meta });
  t.core.settings.set('model.defaultChain', ['gemini']);
  return t;
}

test('a call on a sign-up key whose tier the desk cannot know is recorded with its tokens and an unknown cost', async () => {
  const t = await geminiDesk();
  try {
    const r = await ask(t);
    assert.equal(r.provider, 'gemini');
    const c = lastCall(t);
    assert.equal(c.cost_minor, null, 'not zero, not a number');
    assert.equal(c.input_tokens, 10); assert.equal(c.output_tokens, 5);
    const u = t.core.model.usage().today.find(x => x.provider === 'gemini');
    assert.equal(u.unknown, 1); assert.equal(u.cost, 0, 'no known cost');
  } finally { await t.close(); }
});

test('a key the owner marked free tier is recorded with no cost', async () => {
  const t = await geminiDesk({ tier: 'free' });
  try {
    await ask(t);
    assert.equal(lastCall(t).cost_minor, 0);
    assert.equal(t.core.model.usage().today.find(x => x.provider === 'gemini').unknown, 0);
  } finally { await t.close(); }
});

test('the owner can mark a key free or paid later; a key the provider reports as free tier is free from then on', async () => {
  const quota = 'You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20';
  let n = 0;
  const t = await geminiDesk({}, () => (++n === 1 ? { status: 429, text: quota } : 'ok'));
  try {
    const id = t.core.model.keysFor('gemini')[0].id;
    const r = await ask(t);   // the first model answers 429 with Google's free-tier quota; the next model answers
    assert.equal(r.attempts.length, 2);
    assert.equal(lastCall(t).cost_minor, 0, 'Google said the key is on its free tier');
    t.core.model.setKeyTier(id, 'paid');
    assert.equal(t.core.model.keysFor('gemini')[0].meta.tier, 'paid');
    t.core.model.cooldown.clear(); await ask(t);
    assert.equal(typeof lastCall(t).cost_minor, 'number', 'marked paid: the list price');
    assert.throws(() => t.core.model.setKeyTier(id, 'cheap'));
  } finally { await t.close(); }
});

test('free routes and models a provider lists as free cost nothing; paid routes are priced; failed calls cost nothing', async () => {
  const t = await testDesk({});
  try {
    t.core.settings.set('currency', 'INR');
    const m = t.core.model; const big = { input: 1e6, output: 1e6 };
    assert.equal(m.estimate('router', 'gpt-oss-120b', big), 0);
    assert.equal(m.estimate('ollama', 'llama3', big), 0);
    assert.equal(m.estimate('openrouter', 'deepseek/deepseek-r1:free', big), 0, 'a :free id is free even when its name is on the price list');
    assert.equal(m.estimate('openrouter', 'openrouter/free', big), 0);
    assert.equal(m.estimate('openai', 'gpt-4.1-mini', big), Math.round(2 * 88 * 100));
    assert.equal(m.estimate('gemini', 'gemini-3.5-flash-lite', big), null);
    assert.equal(m.estimate('custom', 'anything', big), null);
    assert.equal(m.estimate('openai', 'gpt-4.1-mini', null), null, 'charged, but no token count came back');
    assert.equal(m.estimate('openai', 'gpt-4.1-mini', big, null, false), 0, 'a failed call is not charged');
    assert.ok(m.atList('openai', 'a-model-not-on-the-list', big) >= m.atList('openai', 'gpt-4.1', big), 'an unlisted model counts at the highest list price');
  } finally { await t.close(); }
});

test('an unknown cost counts against the spend limit at the list price, so a limit is never passed by "unknown"', async () => {
  const t = await geminiDesk();
  try {
    t.core.settings.set('spend.perDay', 100); t.core.settings.set('spend.perMonth', 100000);
    // earlier today: an unknown-cost call whose list price is about 4,400 paise
    t.core.storage.run('INSERT INTO calls (at, purpose, provider, model, ok, ms, input_tokens, output_tokens, cost_minor, currency) VALUES (?, ?, ?, ?, 1, 10, ?, ?, NULL, ?)', new Date().toISOString(), 'chat', 'gemini', 'gemini-3.5-flash-lite', 1e6, 1e6, 'INR');
    assert.ok(t.core.model.unknownAtList(new Date(Date.now() - 3600000).toISOString()) >= 100);
    const u = t.core.model.usage().today.find(x => x.provider === 'gemini');
    assert.equal(u.unknown, 1); assert.ok(u.atList >= 100, 'the list price of the unknown calls is given for the screen');
    await assert.rejects(ask(t), /daily spend limit/);
    assert.equal(t.fake.calls.length, 0, 'the provider was not called');
  } finally { await t.close(); }
});

test('a streamed call to a provider that can count tokens in a stream asks for the count; others are not sent the option', async () => {
  const t = await geminiDesk();
  try {
    await ask(t, { onDelta: () => {} });
    assert.deepEqual(t.fake.calls.at(-1).stream_options, { include_usage: true });
    await ask(t, { onDelta: () => {}, model: { provider: 'router', model: 'x' } }).catch(() => {});
    const routed = t.fake.calls.filter(c => c.model === 'x');
    assert.ok(routed.every(c => !c.stream_options), 'the Free API and local hosts get no new option');
  } finally { await t.close(); }
});

test('a free-tier report from the provider is kept when the desk restarts, until the owner marks the key', async () => {
  const { ModelDoor } = await import('../app/core/model-door.js');
  const quota = 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests';
  let n = 0;
  const t = await geminiDesk({}, () => (++n === 1 ? { status: 429, text: quota } : 'ok'));
  try {
    const id = t.core.model.keysFor('gemini')[0].id;
    await ask(t);
    const c = t.core;
    const again = () => new ModelDoor({ storage: c.storage, settings: c.settings, panic: c.panic, agents: c.agents, events: c.events });
    assert.equal(again().keyTier('gemini', id), 'free', 'a new door on the same data still knows the key is free tier');
    assert.equal(again().estimate('gemini', 'gemini-3.5-flash-lite', { input: 7, output: 7 }, id), 0);
    t.core.model.setKeyTier(id, null);
    assert.equal(again().keyTier('gemini', id), null, 'the owner\'s word replaces the report');
  } finally { await t.close(); }
});

test('today\'s spend window starts at midnight in the owner\'s zone, not on the server clock', async () => {
  const { dayStart, ModelDoor } = await import('../app/core/model-door.js');
  // 21 Nov 2026 03:00 in Kolkata is 20 Nov 21:30 UTC: the owner's day began at 20 Nov 18:30 UTC
  const at = Date.parse('2026-11-20T21:30:00Z');
  assert.equal(dayStart(at, 'Asia/Kolkata').toISOString(), '2026-11-20T18:30:00.000Z');
  assert.equal(dayStart(at, 'Asia/Kolkata', true).toISOString(), '2026-10-31T18:30:00.000Z', 'the month starts on the 1st in the owner\'s zone');
  assert.equal(dayStart(at, 'America/New_York').toISOString(), '2026-11-20T05:00:00.000Z');
  assert.equal(dayStart(Date.parse('2026-03-08T15:00:00Z'), 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z', 'a day the clocks change starts at its own midnight');
  const t = await geminiDesk();
  try {
    t.core.settings.set('timeZone', 'Asia/Kolkata');
    const start = dayStart(Date.now(), 'Asia/Kolkata').getTime();
    const put = (ms) => t.core.storage.run('INSERT INTO calls (at, purpose, provider, model, ok, ms, input_tokens, output_tokens, cost_minor, currency) VALUES (?, ?, ?, ?, 1, 10, 1, 1, 5, ?)', new Date(ms).toISOString(), 'chat', 'openai', 'gpt-4.1-mini', 'INR');
    put(start - 60000); put(Math.min(start + 60000, Date.now()));
    assert.equal(t.core.model.usage().today.find(x => x.provider === 'openai')?.calls, 1, 'only the call after the owner\'s midnight is today');
    t.core.settings.set('spend.perDay', 6);
    const c = t.core, door = new ModelDoor({ storage: c.storage, settings: c.settings, panic: c.panic, agents: c.agents, events: c.events });
    assert.equal(door.overLimit(), null, 'the door\'s own count: yesterday\'s call in the owner\'s zone does not count today');
  } finally { await t.close(); }
});

test('many small calls of unknown cost still add up against the limit: their list price is summed before it is rounded, and rounded up', async () => {
  const t = await geminiDesk();
  try {
    t.core.settings.set('timeZone', 'Asia/Kolkata');
    // 30 calls of 7 + 7 tokens: each a small part of one paisa at the list price, together almost one paisa
    for (let i = 0; i < 30; i++) t.core.storage.run('INSERT INTO calls (at, purpose, provider, model, ok, ms, input_tokens, output_tokens, cost_minor, currency) VALUES (?, ?, ?, ?, 1, 10, 7, 7, NULL, ?)', new Date().toISOString(), 'chat', 'gemini', 'gemini-3.5-flash-lite', 'INR');
    assert.ok(t.core.model.unknownAtList(new Date(Date.now() - 3600000).toISOString()) >= 1, 'not rounded away call by call');
    assert.ok(t.core.model.usage().today.find(x => x.provider === 'gemini').atList >= 1, 'the screen is never told 0 for calls that count');
    t.core.settings.set('spend.perDay', 1);
    assert.equal(t.core.model.overLimit(), 'daily spend limit');
  } finally { await t.close(); }
});
