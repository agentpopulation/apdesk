// How long answers should be: the one card that asks after a few finished exchanges, the stored choice, its line in every
// turn's system prompt, and the owner-only setter. Fake model: plumbing only, never proof that a real model follows the line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { LENGTH_LINES } from './coordinator.js';
import { LENGTH_ASK } from './ui-text.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const msgs = async (t, chatId) => (await t.call(`/api/m/chat/chats/${chatId}/messages`)).json;
const waitReply = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await msgs(t, chatId);
    const last = r.messages.filter(m => m.role === 'assistant').at(-1);
    if (last && last.status !== 'streaming' && !r.chat.running) { await sleep(60); return (await msgs(t, chatId)).messages; }
    await sleep(50);
  }
  throw new Error('no reply');
};
const say = async (t, chatId, text) => { const r = await t.call(`/api/m/chat/chats/${chatId}/send`, { body: { text } }); assert.equal(r.status, 200, r.text); return waitReply(t, chatId); };
const cardsIn = (all) => all.flatMap(m => (m.cards || []).filter(c => c.kind === 'answer-length').map(c => ({ ...c, messageId: m.id })));
const openCards = async (t) => { const out = []; for (const id of ['everyone', 'dm-scout', 'dm-coordinator']) out.push(...cardsIn((await msgs(t, id)).messages).filter(c => c.state === 'ask')); return out; };
// finished exchanges written straight into the store (an owner message, then a reply that finished)
const pastExchanges = (t, n, chatId = 'dm-coordinator') => { for (let i = 0; i < n; i++) { t.core.storage.run("INSERT INTO m_chat_messages (chat_id, role, text, status, meta, at, updated) VALUES (?, 'user', 'hi', 'done', '{}', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')", chatId); t.core.storage.run("INSERT INTO m_chat_messages (chat_id, role, agent_id, text, status, meta, at, updated) VALUES (?, 'assistant', 'coordinator', 'hello', 'done', '{}', '2026-11-01T00:00:01Z', '2026-11-01T00:00:01Z')", chatId); } };
const prompts = [];
const script = (b) => { prompts.push(b.messages.find(m => m.role === 'system')?.content || ''); return 'Here you go.'; };
const hasLengthLine = (p) => p.includes(LENGTH_LINES.short) || p.includes(LENGTH_LINES.detailed) || /How long answers should be/.test(p);

test('the card shows under the reply that finished the third exchange, in any chat, and not before', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script });
  try {
    await say(t, 'everyone', 'Hello');
    await say(t, 'dm-scout', 'What can you do?');
    assert.equal((await openCards(t)).length, 0, 'not after two');
    const all = await say(t, 'everyone', 'Thanks');
    const last = all.filter(m => m.role === 'assistant').at(-1);
    const cards = cardsIn(all);
    assert.equal(cards.length, 1); assert.equal(cards[0].messageId, last.id, 'under the latest reply'); assert.equal(cards[0].state, 'ask');
    assert.equal((await openCards(t)).length, 1, 'one card at a time');
    await say(t, 'everyone', 'One more');
    assert.equal((await openCards(t)).length, 1, 'not shown again while one is open');
    // the card's words are written by code: the same question for both samples, no emoji
    for (const s of [LENGTH_ASK.title, LENGTH_ASK.question, ...LENGTH_ASK.a, LENGTH_ASK.b, LENGTH_ASK.saved]) assert.doesNotMatch(s, /\p{Extended_Pictographic}/u);
    assert.equal(LENGTH_ASK.title, 'How do you like your answers?');
    assert.ok(LENGTH_ASK.a.length >= 2 && LENGTH_ASK.a.length <= 3); assert.ok(LENGTH_ASK.b.length > LENGTH_ASK.a.join(' ').length * 1.5);
  } finally { await t.close(); }
});

test('a background or scheduled turn never shows the card and is not counted as an exchange', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script });
  try {
    await say(t, 'everyone', 'Hello'); await say(t, 'everyone', 'Hi again');
    const chat = t.core.modules.api('chat');
    await chat.ask({ chatId: 'everyone', text: 'Write a short note on tea', jobId: 'job_bg1' });
    await chat.ask({ chatId: 'everyone', text: 'Morning brief', quiet: true, note: 'Scheduled: Morning brief' });
    await sleep(100);
    assert.equal((await openCards(t)).length, 0);
    await say(t, 'everyone', 'Third');
    assert.equal((await openCards(t)).length, 1, 'the third typed exchange shows it');
  } finally { await t.close(); }
});

for (const [button, value] of [['A', 'short'], ['B', 'detailed']]) {
  test(`choosing ${button} stores ${value}, replaces the card with one saved line, and the next turn's prompt carries the ${value} line`, async () => {
    prompts.length = 0;
    const t = await testDesk({ modules: ['chat', 'agents'], script });
    try {
      assert.deepEqual((await t.call('/api/m/chat/answer-length')).json, { value: null });
      pastExchanges(t, 2);
      await say(t, 'everyone', 'Hello');
      assert.equal((await openCards(t)).length, 1);
      assert.ok(!prompts.some(hasLengthLine), 'no line while nothing is chosen');
      const r = await t.call('/api/m/chat/answer-length', { method: 'PUT', body: { value } });
      assert.equal(r.status, 200); assert.equal(r.json.value, value);
      assert.deepEqual((await t.call('/api/m/chat/answer-length')).json, { value });
      const cards = cardsIn((await msgs(t, 'everyone')).messages);
      assert.equal(cards.length, 1); assert.equal(cards[0].state, 'saved');
      prompts.length = 0;
      await say(t, 'dm-scout', 'How do I price a new service?');
      assert.equal(prompts.length, 1);
      assert.ok(prompts[0].includes(LENGTH_LINES[value]), prompts[0].slice(-600));
      assert.ok(!prompts[0].includes(LENGTH_LINES[value === 'short' ? 'detailed' : 'short']));
      assert.doesNotMatch(LENGTH_LINES[value], /emoji/i);
      // a background turn gets it too
      prompts.length = 0;
      await t.core.modules.api('chat').ask({ chatId: 'everyone', text: 'Write a note', jobId: 'job_bg2' });
      assert.ok(prompts[0].includes(LENGTH_LINES[value]));
      // chosen: the card never comes back
      pastExchanges(t, 30); await say(t, 'everyone', 'Again');
      assert.equal((await openCards(t)).length, 0);
    } finally { await t.close(); }
  });
}

test('"Ask me later" hides the card; it comes back once after ten more exchanges, and after a second "later" never', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script });
  try {
    pastExchanges(t, 2); await say(t, 'everyone', 'Hello');
    assert.equal((await openCards(t)).length, 1);
    assert.equal((await t.call('/api/m/chat/answer-length/later', { method: 'POST', body: {} })).status, 200);
    assert.equal(cardsIn((await msgs(t, 'everyone')).messages).length, 0, 'the card is gone');
    pastExchanges(t, 8); await say(t, 'everyone', 'Ninth after');
    assert.equal((await openCards(t)).length, 0, 'not after nine more');
    await say(t, 'everyone', 'Tenth after');
    assert.equal((await openCards(t)).length, 1, 'back after ten more');
    assert.equal((await t.call('/api/m/chat/answer-length/later', { method: 'POST', body: {} })).status, 200);
    pastExchanges(t, 40); await say(t, 'everyone', 'Much later'); await say(t, 'dm-scout', 'And again');
    assert.equal((await openCards(t)).length, 0, 'never again by itself');
    assert.deepEqual((await t.call('/api/m/chat/answer-length')).json, { value: null });
  } finally { await t.close(); }
});

test('the setter needs the owner and takes only short or detailed (or null to clear)', async () => {
  prompts.length = 0;
  const t = await testDesk({ modules: ['chat', 'agents'], script });
  try {
    assert.equal((await t.call('/api/m/chat/answer-length', { method: 'PUT', body: { value: 'short' }, session: false })).status, 403);
    assert.equal((await t.call('/api/m/chat/answer-length/later', { method: 'POST', body: {}, session: false })).status, 403);
    for (const v of ['long', '', 'SHORT', 5, true, { v: 'short' }, ['short']]) assert.equal((await t.call('/api/m/chat/answer-length', { method: 'PUT', body: { value: v } })).status, 400, JSON.stringify(v));
    assert.equal((await t.call('/api/m/chat/answer-length', { method: 'PUT', body: {} })).status, 400, 'no value at all');
    assert.deepEqual((await t.call('/api/m/chat/answer-length')).json, { value: null });
    await say(t, 'everyone', 'Hello');
    assert.ok(prompts.length && !prompts.some(hasLengthLine), 'no choice: no line');
    assert.equal((await t.call('/api/m/chat/answer-length', { method: 'PUT', body: { value: 'detailed' } })).json.value, 'detailed');
    assert.equal((await t.call('/api/m/chat/answer-length', { method: 'PUT', body: { value: null } })).json.value, null);
    prompts.length = 0; await say(t, 'everyone', 'Hi');
    assert.ok(!prompts.some(hasLengthLine), 'cleared: no line');
  } finally { await t.close(); }
});
