// Agents in Chat are shown by role, with the owner's own name when he gave one; the old code names never reach the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { parts, displayLine, promptName, who, selfLine } from './ui-names.js';

test('the display rule: role alone, own name and role, never an old code name', () => {
  assert.equal(displayLine({ id: 'coordinator', name: 'Coordinator', role: 'Routes every ask to the right agent and answers simple questions itself' }), 'Manager');
  assert.equal(displayLine({ id: 'scout', name: 'Scout', role: 'Research and reports' }), 'Researcher');
  assert.equal(displayLine({ id: 'closer', name: 'Closer' }), 'Sales expert');
  assert.equal(displayLine({ id: 'operator', name: 'Operator' }), 'Operations expert');
  assert.equal(displayLine({ id: 'coder', name: 'Coder' }), 'Coder');
  assert.equal(displayLine({ id: 'scout', name: 'Kent' }), 'Kent · Researcher');
  assert.equal(displayLine({ id: 'scout', name: '' }), 'Researcher');
  assert.equal(displayLine({ id: 'secretary-2', name: 'Kent', role: 'Secretary' }), 'Kent · Secretary');
  assert.equal(displayLine({ id: 'secretary', name: '', role: 'Secretary' }), 'Secretary');
  assert.equal(displayLine({ id: 'meera', name: 'Meera', role: 'Handles my bookings, invoices and reminders' }), 'Meera');
  assert.equal(displayLine({ id: 'ai-officer', name: 'AI officer' }), 'AI expert');
  assert.equal(displayLine(null), 'Agent');
  assert.equal(promptName({ id: 'scout', name: 'Kent' }), 'Kent (Researcher)');
  assert.equal(promptName({ id: 'scout', name: 'Scout' }), 'Researcher');
  assert.deepEqual(parts({ id: 'coder', name: 'Hugo' }), { role: 'Coder', name: 'Hugo', line: 'Hugo · Coder' });
  assert.match(selfLine({ id: 'scout', name: 'Scout' }), /your role is Researcher\. You have no own name/);
  assert.match(selfLine({ id: 'scout', name: 'Kent' }), /named you Kent/);
});

test('the agents module\'s helper decides when it is there, as a line or as parts; a broken helper falls back', () => {
  const get = (id) => ({ id, name: id === 'scout' ? 'Kent' : 'Scout' });
  assert.equal(who(get).line('scout'), 'Kent · Researcher');
  assert.equal(who(get, { display: () => 'Kent · Head of research' }).line('scout'), 'Kent · Head of research');
  assert.deepEqual(who(get, { display: () => ({ role: 'Head of research', name: 'Kent', line: 'Kent · Head of research' }) }).parts('scout'), { role: 'Head of research', name: 'Kent', line: 'Kent · Head of research' });
  assert.equal(who(get, { display: () => { throw new Error('x'); } }).line('scout'), 'Kent · Researcher');
  assert.equal(who(get, { display: () => ({ role: 'Head of research', name: 'Kent', line: 'Kent · Head of research' }) }).prompt('scout'), 'Kent (Head of research)');
});

const OLD = /\b(?:Coordinator|Scout|Closer|Operator)\b/;
const waitReply = async (t, chatId, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    const last = r.json.messages.filter(m => m.role === 'assistant').at(-1);
    if (last && last.status !== 'streaming' && !r.json.chat.running) return { last, all: r.json.messages };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no reply');
};

test('in a group turn every prompt names agents by role (and own name), each agent is told its own, and no line on screen carries an old name', async () => {
  const prompts = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    const sys = b.messages[0].content; prompts.push(sys);
    if (/GO or PASS/.test(sys)) return /your role is (?:Researcher|Sales expert)\b/.test(sys) ? 'GO' : 'PASS';
    if (/You sum up a group chat turn/.test(sys)) return 'Kent (Researcher) says check two sources. The Sales expert says call the buyer. Next: call the buyer.';
    return 'From my role: one short point.';
  } });
  try {
    t.core.agents.update('scout', { name: 'Kent' });
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'How should I price my new tea blend?' } });
    const { all } = await waitReply(t, 'everyone');
    const shown = all.filter(m => m.role !== 'user').map(m => m.text).join('\n');
    assert.doesNotMatch(shown, OLD, shown);
    assert.match(shown, /Nothing to add from|had nothing to add|Kent|Sales expert/);
    const choice = prompts.filter(p => /GO or PASS/.test(p));
    assert.ok(choice.some(p => /your role is Researcher, and the owner named you Kent/.test(p)), 'Kent is told its role and name');
    assert.ok(choice.some(p => /your role is Sales expert\. You have no own name/.test(p)));
    for (const p of choice) assert.match(p, /In this group: Manager[^;]*; Kent \(Researcher\)/);
    // the group's line for a member: role, with the own name where set; never "Scout"
    for (const p of prompts.filter(p => /In this group/.test(p))) assert.doesNotMatch(p.split('In this group')[1].split('.')[0], /\bScout\b|\bCloser\b|\bCoordinator\b/);
  } finally { await t.close(); }
});

test('the chat list, members line and a hello note use roles; a hello note of an agent with no own name offers "Give me a name"', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: () => 'ok' });
  try {
    const r = await t.call('/api/m/chat/chats/build-room/members', { method: 'PUT', body: { members: ['coordinator', 'coder', 'operator'] } });
    assert.equal(r.status, 200);
    const msgs = (await t.call('/api/m/chat/chats/build-room/messages')).json.messages;
    assert.match(msgs.at(-1).text, /^Now in this chat: Manager, Coder, Operations expert\./);
    const chat = t.core.modules.api('chat');
    chat.postMessage('dm-scout', { agentId: 'scout', text: 'Glad to join your team.', welcome: true });
    let m = (await t.call('/api/m/chat/chats/dm-scout/messages')).json.messages.at(-1);
    assert.deepEqual(m.cards.find(c => c.kind === 'actions')?.actions, [{ label: 'Give me a name', nameAgent: 'scout' }]);
    t.core.agents.update('closer', { name: 'Asha' });
    chat.postMessage('dm-closer', { agentId: 'closer', text: 'Glad to join your team.', welcome: true });
    m = (await t.call('/api/m/chat/chats/dm-closer/messages')).json.messages.at(-1);
    assert.ok(!m.cards.some(c => c.kind === 'actions'), 'an agent with its own name gets no button');
    const recent = chat.recent(10).map(c => c.title).join('|');
    assert.doesNotMatch(recent, OLD);
  } finally { await t.close(); }
});

test('a hired role\'s chat starts with that role\'s own three starters; built-in agents keep theirs', async () => {
  const { startersFor, STARTERS } = await import('./ui-text.js');
  const { hireRole } = await import('../agents/ui-roles.js');
  const roleStarters = (id) => hireRole(id === 'sec-1' ? 'secretary' : null)?.starters || null;
  assert.deepEqual(startersFor({ members: ['sec-1'] }, [], { roleStarters }), hireRole('secretary').starters);
  assert.deepEqual(startersFor({ members: ['scout'] }, [], { roleStarters }), STARTERS.scout);
  assert.deepEqual(startersFor({ members: ['sec-1'] }, [{ role: 'user' }], { roleStarters }), [], 'gone once the owner wrote');
});
