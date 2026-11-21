// Answer ratings live in Chat, so they work whether Bench is on or not; and the counts Chat offers to other modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testDesk } from '../../test/helpers/desk.js';

test('answer ratings: stored by Chat with Bench off, owner-only, cleaned, offered through ratingsSince', async () => {
  const t = await testDesk({ modules: ['chat'] });
  try {
    const chat = t.core.modules.api('chat');
    const { messageId } = chat.postMessage('everyone', { text: 'An answer.' });
    const notOwner = await t.call('/api/m/chat/ratings', { body: { messageId, thumb: 'up' }, session: false });
    assert.equal(notOwner.status, 403);
    assert.equal((await t.call('/api/m/chat/ratings', { body: { messageId: 999999, thumb: 'up' } })).status, 404, 'no such answer');
    const r = await t.call('/api/m/chat/ratings', { body: { messageId, thumb: 'down', research: 'bad', reasons: ['wrong facts', 'nonsense', 'too long'], comment: 'missed my city' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ ...r.json.rating, ratedAt: undefined }, { targetType: 'answer', targetId: String(messageId), thumb: 'down', research: 'bad', reasons: ['wrong facts', 'too long'], comment: 'missed my city', ratedAt: undefined });
    assert.equal((await t.call(`/api/m/chat/ratings/${messageId}`)).json.rating.thumb, 'down');
    assert.equal((await t.call(`/api/m/chat/ratings/${messageId}`, { session: false })).status, 403);
    const since = chat.ratingsSince(new Date(Date.now() - 60000).toISOString());
    assert.equal(since.length, 1); assert.equal(since[0].comment, 'missed my city');
    assert.equal(chat.ratingsSince(new Date(Date.now() + 60000).toISOString()).length, 0);
    await t.call('/api/m/chat/ratings', { body: { messageId } });
    assert.equal((await t.call(`/api/m/chat/ratings/${messageId}`)).json.rating, null, 'an empty rating clears it');
    // the chat page uses Chat's own routes and shows the controls without Bench
    const ui = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
    assert.doesNotMatch(ui, /m\/bench\/(ratings|state)/); assert.match(ui, /'m\/chat\/ratings'/);
  } finally { await t.close(); }
});

test('answer ratings Bench stored before are copied into Chat once', async () => {
  const t = await testDesk({ modules: ['chat', 'bench'] });
  try {
    await t.core.modules.set('bench', true);
    const chat = t.core.modules.api('chat'); const bench = t.core.modules.api('bench');
    const a = chat.postMessage('everyone', { text: 'First.' }).messageId; const b = chat.postMessage('everyone', { text: 'Second.' }).messageId;
    bench.setRating('answer', String(a), { thumb: 'up' });
    bench.setRating('bench_item', 'it_1', { thumb: 'down' });
    const got = chat.ratingsSince('');
    assert.deepEqual(got.map(r => [r.targetId, r.thumb]), [[String(a), 'up']], 'only answer ratings come over');
    bench.setRating('answer', String(b), { thumb: 'down' });
    assert.equal(chat.ratingsSince('').length, 1, 'copied once, not on every read');
  } finally { await t.close(); }
});

test('messagesSince offers how many messages came since a time (the Network status strip counts it)', async () => {
  const t = await testDesk({ modules: ['chat'] });
  try {
    const chat = t.core.modules.api('chat');
    const before = chat.messagesSince(new Date(Date.now() - 60000).toISOString()).length;
    chat.postMessage('everyone', { text: 'One.' }); chat.postMessage('everyone', { text: 'Two.' });
    assert.equal(chat.messagesSince(new Date(Date.now() - 60000).toISOString()).length, before + 2);
    assert.equal(chat.messagesSince(new Date(Date.now() + 60000).toISOString()).length, 0);
  } finally { await t.close(); }
});
