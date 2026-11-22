// The starting team on a fresh desk: unticked agents are retired the Agents page's way, the rooms follow, hiring brings
// a room back; work meant for a retired agent is done by the Coordinator with one plain line. Fake model, plumbing only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
/** These tests are about the Coordinator's own turn: their group chats are set to "Who answers: The Coordinator". */
const coordinatorAnswers = async (t) => { for (const id of ['everyone', 'sales-room', 'build-room']) await t.call(`/api/m/chat/chats/${id}`, { method: 'PATCH', body: { settings: { whoAnswers: 'coordinator' } } }); };

const chatIds = async (t) => (await t.call('/api/m/chat/chats')).json.chats.map(c => c.id);
const settle = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    const last = r.json.messages.filter(m => m.role === 'assistant').at(-1);
    if (last && last.status !== 'streaming' && !r.json.chat.running) return last;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no reply');
};

test('fresh desk, Sales person with the ticked team: three agents, Everyone and Sales room, no Build room; hiring brings it back', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    await chatIds(t);   // the chat page was open behind the first-start step: own chats exist already
    for (const id of ['operator', 'coder']) assert.equal((await t.call(`/api/m/agents/agents/${id}`, { method: 'DELETE' })).status, 200);
    const fit = (await t.call('/api/m/chat/rooms/fit', { method: 'POST' })).json;
    assert.deepEqual(fit.rooms.sort(), ['everyone', 'sales-room']);
    assert.deepEqual(t.core.agents.list().map(a => a.id), ['coordinator', 'scout', 'closer']);
    let ids = await chatIds(t);
    assert.ok(ids.includes('everyone') && ids.includes('sales-room') && !ids.includes('build-room'), ids.join());
    assert.ok(!ids.includes('dm-coder') && !ids.includes('dm-operator'), ids.join());
    const everyone = (await t.call('/api/m/chat/chats/everyone')).json; assert.deepEqual(everyone.members, ['coordinator', 'scout', 'closer']);
    assert.equal((await t.call('/api/m/chat/rooms/fit', { method: 'POST', session: false })).status, 403);
    // one builder hired back: Coder is on, the Build room still needs a second of its agents
    await t.call('/api/m/agents/hire', { body: { name: 'Coder' } });
    ids = await chatIds(t); assert.ok(t.core.agents.get('coder') && ids.includes('dm-coder') && !ids.includes('build-room'), ids.join());
    await t.call('/api/m/agents/hire', { body: { name: 'Operator' } });
    ids = await chatIds(t); assert.ok(ids.includes('build-room'), ids.join());
  } finally { await t.close(); }
});

test('Skip, and a desk that is already set up: five agents and three groups, untouched', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    t.core.settings.set('onboarded', true);   // nothing calls rooms/fit on Skip or on a set-up desk
    const ids = await chatIds(t);
    for (const id of ['everyone', 'sales-room', 'build-room']) assert.ok(ids.includes(id), id);
    assert.equal(t.core.agents.list().length, 5);
    // a set-up desk whose owner retired one agent by hand keeps its rooms: only the first-start step leaves rooms out
    await t.call('/api/m/agents/agents/coder', { method: 'DELETE' });
    assert.ok((await chatIds(t)).includes('build-room'));
  } finally { await t.close(); }
});

test('work meant for a retired agent: the Coordinator does it and says so in one plain line, no error', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => b.messages.at(-1).role === 'tool' ? 'The research has started.' : ((b.tools || []).some(x => x.function.name === 'fx_research') ? { toolCalls: [{ name: 'fx_research', args: { q: 'edge data centres' } }] } : 'no tool') });
  try {
    await coordinatorAnswers(t);
    const ran = [];
    t.core.modules.tools.set('fx_research', { module: 'research', name: 'fx_research', description: 'research for tests', parameters: { type: 'object', properties: { q: { type: 'string' } } }, async run(args, call) { ran.push(call.agentId); return { ok: true, text: 'started' }; } });
    await t.call('/api/m/agents/agents/scout', { method: 'DELETE' });
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Look into edge data centres' } });
    const last = await settle(t, 'everyone');
    assert.equal(last.status, 'done'); assert.deepEqual(ran, ['coordinator']);
    assert.match(last.text, /Scout is not on your team, so I did this myself\. Hire Scout on the Agents page to hand this work over\.$/);
  } finally { await t.close(); }
});
