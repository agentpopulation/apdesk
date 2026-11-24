// Commands from modules: /name and text goes to the module that declares it, never to a model; an unknown /word is text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { commandsOf, commandIn, commandsFor, commandReply } from './ui-commands.js';

test('a manifest\'s commands: well made ones only; the typed message calls one only at its very start', () => {
  const list = commandsOf({ commands: [{ name: 'advisor', hint: 'Hand this work to your advisor' }, { name: 'Bad Name', hint: 'x' }, { name: 'advisor', hint: 'twice' }, { hint: 'no name' }, 'text'] });
  assert.deepEqual(list, [{ name: 'advisor', hint: 'Hand this work to your advisor' }]);
  assert.deepEqual(commandsOf({}), []);
  assert.deepEqual(commandIn('/advisor check my prices', list), { name: 'advisor', hint: 'Hand this work to your advisor', text: 'check my prices' });
  assert.deepEqual(commandIn('/Advisor', list), { name: 'advisor', hint: 'Hand this work to your advisor', text: '' });
  for (const t of ['/unknown hello', 'please /advisor this', 'advisor', '/advisors now', '//advisor']) assert.equal(commandIn(t, list), null, t);
  assert.deepEqual(commandsFor('/', list).map(c => c.name), ['advisor']);
  assert.deepEqual(commandsFor('/adv', list).map(c => c.name), ['advisor']);
  assert.deepEqual(commandsFor('/x', list), []); assert.deepEqual(commandsFor('/advisor more', list), []); assert.deepEqual(commandsFor('hello', list), []);
  assert.deepEqual(commandReply('Handed over.'), { text: 'Handed over.', cards: [] });
  assert.deepEqual(commandReply({ text: 'Done', card: { kind: 'text', text: 'A card' } }), { text: 'Done', cards: [{ kind: 'text', text: 'A card' }] });
  assert.equal(commandReply(null), null); assert.equal(commandReply({}), null); assert.equal(commandReply('  '), null);
});

/** A desk with one more module that declares /advisor and answers it (the module list and its door, as a module would have). */
async function deskWithCommand(command, { on = true } = {}) {
  const t = await testDesk({ modules: ['chat', 'agents'], script: () => 'A model answer.' });
  const mods = t.core.modules; const list = mods.list.bind(mods); const api = mods.api.bind(mods);
  const seen = [];
  mods.list = () => [...list(), { id: 'adviser-test', name: 'Adviser test', on, commands: [{ name: 'advisor', hint: 'Hand this work to your advisor' }] }];
  mods.api = (id) => id === 'adviser-test' ? (on ? { command: async (name, o) => { seen.push({ name, ...o, signal: !!o.signal }); return command(name, o); } } : null) : api(id);
  return { t, seen };
}
const waitDone = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    const last = r.json.messages.filter(m => m.role === 'assistant').at(-1);
    if (last && last.status !== 'streaming' && !r.json.chat.running) return { last, all: r.json.messages };
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('no reply');
};

test('/advisor and text goes to the module, its answer shows in the chat, and no model is asked', async () => {
  const { t, seen } = await deskWithCommand(() => ({ text: 'Your advisor has it.', card: { kind: 'text', text: 'Handed over: check my prices' } }));
  try {
    const cmds = await t.call('/api/m/chat/commands');
    assert.deepEqual(cmds.json.commands, [{ name: 'advisor', hint: 'Hand this work to your advisor' }]);
    const before = t.fake.calls.length;
    const r = await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: '/advisor check my prices' } });
    assert.equal(r.status, 200, r.text);
    const { last, all } = await waitDone(t, 'dm-scout');
    assert.equal(t.fake.calls.length, before, 'no model call');
    assert.deepEqual(seen, [{ name: 'advisor', text: 'check my prices', chatId: 'dm-scout', agentId: 'scout', signal: true }]);
    assert.equal(last.text, 'Your advisor has it.'); assert.equal(last.cards[0].text, 'Handed over: check my prices'); assert.equal(last.status, 'done');
    assert.ok(all.some(m => m.role === 'user' && m.text === '/advisor check my prices'));
    const { recordLine } = await import('./ui-text.js');
    assert.equal(recordLine(last, (id) => id), 'Adviser test answered /advisor', 'the line under it names the module, not an agent');
  } finally { await t.close(); }
});

test('a command that fails or gives nothing back says so plainly; an unknown /word goes to the model as ordinary text', async () => {
  let mode = 'fail';
  const { t } = await deskWithCommand(() => { if (mode === 'fail') throw new Error('ECONNREFUSED 127.0.0.1:9'); return null; });
  try {
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: '/advisor now' } });
    let { last } = await waitDone(t, 'dm-scout');
    assert.equal(last.status, 'error'); assert.doesNotMatch(last.text, /ECONNREFUSED|127\.0\.0\.1/); assert.ok(last.text.length > 5);
    mode = 'empty';
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: '/advisor again' } });
    ({ last } = await waitDone(t, 'dm-scout'));
    assert.match(last.text, /gave nothing back/);
    const before = t.fake.calls.length;
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: '/weather in Pune' } });
    ({ last } = await waitDone(t, 'dm-scout'));
    assert.ok(t.fake.calls.length > before, 'the model got it'); assert.equal(last.text, 'A model answer.');
  } finally { await t.close(); }
});

test('a module that is off offers no command, and its /name is ordinary text', async () => {
  const { t } = await deskWithCommand(() => 'never', { on: false });
  try {
    assert.deepEqual((await t.call('/api/m/chat/commands')).json.commands, []);
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: '/advisor hello' } });
    const { last } = await waitDone(t, 'dm-scout');
    assert.equal(last.text, 'A model answer.');
  } finally { await t.close(); }
});
