// A group chat: the owner's message goes to every agent, each answers from its own role or passes, then the Coordinator sums up.
// Plumbing tests against the fake model; never proof that the replies are good (see real-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { recordLine } from './ui-text.js';

const kvSet = (t, k, v) => t.core.storage.kvScope('m:chat').set(k, v);
const whoIs = (b) => (String(b.messages?.[0]?.content || '').match(/^You are (\w+), an agent/) || [])[1] || null;
const isSummary = (b) => /You sum up a group chat turn/.test(String(b.messages?.[0]?.content || ''));
const isPlan = (b) => /You plan how the desk answers/.test(String(b.messages?.[0]?.content || ''));
const settle = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    if (!r.json.chat.running && !r.json.messages.some(m => m.status === 'streaming')) return r.json.messages;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the group did not finish');
};
async function groupDesk(answers = {}, extra = {}) {
  const seen = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    if (isPlan(b)) { seen.push('plan'); return extra.plan ? JSON.stringify(extra.plan) : '{"needsFacts": false, "parts": []}'; }
    if (isSummary(b)) { seen.push('summary'); return 'Scout says check the facts; Coder says make a sheet. Next: start with the sheet.'; }
    const who = whoIs(b); seen.push(who);
    const a = answers[who];
    return typeof a === 'function' ? a(b) : a ?? `${who} answer from my role.`;
  } });
  return { t, seen };
}

test('in a group every agent answers in its own reply, one passes in a quiet line, then the Coordinator sums up', async () => {
  const { t, seen } = await groupDesk({ Closer: 'PASS' });
  try {
    const r = await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello' } });
    assert.equal(r.status, 200);
    const msgs = await settle(t, 'everyone');
    const replies = msgs.filter(m => m.role === 'assistant');
    const by = (id) => replies.filter(m => m.agentId === id);
    for (const id of ['scout', 'operator', 'coder']) { assert.equal(by(id).length, 1, id); assert.match(by(id)[0].text, /answer from my role/); assert.ok(by(id)[0].meta.groupOf); }
    assert.equal(by('closer')[0].text, 'Closer had nothing to add'); assert.equal(by('closer')[0].meta.passed, true);
    const sum = replies.find(m => m.meta?.groupSummary);
    assert.equal(sum.agentId, 'coordinator'); assert.ok(sum.meta.groupSummary); assert.match(sum.text, /Next: start with the sheet/);
    assert.equal(replies.filter(m => m.agentId === 'coordinator').length, 1, 'the Coordinator sums up and does not answer twice');
    assert.equal(seen.filter(x => x === 'summary').length, 1);
    assert.ok(!msgs.some(m => m.meta?.groupLine), 'the "still writing" line goes when the run ends');
    assert.equal(msgs.filter(m => m.role === 'user').length, 1, 'one owner message');
    // the member prompt asks for its own role and says how to pass
    const sys = t.fake.calls.find(b => whoIs(b) === 'Scout').messages[0].content;
    assert.match(sys, /answers in its own reply, from its own role/); assert.match(sys, /reply with exactly PASS/);
    // naming an agent does not decide who answers: everyone still does
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: '@Closer what do you think?' } });
    const msgs2 = await settle(t, 'everyone');
    assert.ok(msgs2.filter(m => m.role === 'assistant' && m.agentId === 'scout').length >= 2);
  } finally { await t.close(); }
});

test('one answer: no summary; "The Coordinator" setting: one reply as before; a direct chat is unchanged', async () => {
  const { t, seen } = await groupDesk({ Closer: 'PASS', Operator: 'PASS', Coder: 'PASS' });
  try {
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello' } });
    let msgs = await settle(t, 'everyone');
    assert.ok(!seen.includes('summary')); assert.ok(!msgs.some(m => m.meta?.groupSummary));
    const p = await t.call('/api/m/chat/chats/everyone', { method: 'PATCH', body: { settings: { whoAnswers: 'coordinator' } } });
    assert.equal(p.json.settings.whoAnswers, 'coordinator');
    seen.length = 0;
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello again' } });
    msgs = await settle(t, 'everyone');
    const lastR = msgs.filter(m => m.role === 'assistant').at(-1); assert.deepEqual(seen, ['Coordinator']); assert.equal(lastR.agentId, 'coordinator'); assert.ok(!lastR.meta.groupOf);
    seen.length = 0;
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: 'Hello' } });
    await settle(t, 'dm-scout'); assert.deepEqual(seen, ['Scout']);
  } finally { await t.close(); }
});

test('the overall time limit: an agent not done shows "did not answer in time" and the summary goes ahead', async () => {
  const { t } = await groupDesk({ Operator: () => ({ text: 'too slow', delayMs: 4000 }) });
  try {
    kvSet(t, 'groupTurnMs', 1500); kvSet(t, 'groupParallel', 4);
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello' } });
    const msgs = await settle(t, 'everyone');
    const op = msgs.find(m => m.agentId === 'operator');
    assert.equal(op.text, 'Operator did not answer in time.'); assert.equal(op.meta.late, true);
    assert.ok(msgs.some(m => m.meta?.groupSummary), 'the summary still came');
  } finally { await t.close(); }
});

test('Stop stops every agent of the group run; no summary follows', async () => {
  const { t, seen } = await groupDesk({ Scout: () => ({ text: 'slow words '.repeat(40), chunkDelayMs: 60 }), Closer: () => ({ text: 'slow words '.repeat(40), chunkDelayMs: 60 }), Operator: () => ({ text: 'slow words '.repeat(40), chunkDelayMs: 60 }), Coder: () => ({ text: 'slow words '.repeat(40), chunkDelayMs: 60 }) });
  try {
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello' } });
    await new Promise(r => setTimeout(r, 600));
    const s = await t.call('/api/m/chat/chats/everyone/stop', { method: 'POST' });
    assert.equal(s.json.stopped, true);
    const msgs = await settle(t, 'everyone');
    await new Promise(r => setTimeout(r, 1500));
    const after = (await t.call('/api/m/chat/chats/everyone/messages')).json.messages;
    assert.ok(after.filter(m => m.role === 'assistant').every(m => m.status === 'stopped' || m.meta?.passed), JSON.stringify(after.map(m => [m.agentId, m.status])));
    assert.ok(!seen.includes('summary')); assert.ok(!msgs.some(m => m.meta?.groupLine));
  } finally { await t.close(); }
});

test('a research ask in a group is run once, by the research agent; the others reply to its result', async () => {
  const { t, seen } = await groupDesk({ Scout: 'Scout found it.', Closer: 'PASS', Operator: 'PASS' }, { plan: { needsFacts: true, parts: ['VR200'], compare: '' } });
  try {
    t.core.modules.tools.set('web_search', { module: 'search', name: 'web_search', description: 's', parameters: { type: 'object', properties: {} }, async run() { return { results: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }] }; } });
    t.core.modules.tools.set('web_read', { module: 'search', name: 'web_read', description: 'r', parameters: { type: 'object', properties: {} }, async run(a) { return { url: a.url, title: 'VR200', text: 'The VR200 rack. '.repeat(30) }; } });
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'find more details about VR200' } });
    const msgs = await settle(t, 'everyone');
    assert.equal(seen.filter(x => x === 'plan').length, 1, 'one plan for the group');
    const scout = msgs.find(m => m.agentId === 'scout');
    assert.ok(scout.meta.research, 'Scout ran the research turn'); assert.ok(scout.meta.steps.some(s => s.tool === 'web_read'));
    assert.ok(!msgs.some(m => m.agentId !== 'scout' && m.meta?.research), 'run once');
    const coderSys = t.fake.calls.find(b => whoIs(b) === 'Coder').messages[0].content;
    assert.match(coderSys, /Scout researched this ask for the group/);
    assert.equal(msgs.filter(m => m.meta?.passed).length, 2);
    assert.ok(msgs.some(m => m.meta?.groupSummary), 'Scout and Coder answered: a summary');
  } finally { await t.close(); }
});

test('Everyone holds every agent, follows a hire by itself, and cannot be edited', async () => {
  const { t } = await groupDesk();
  try {
    const r = await t.call('/api/m/chat/chats/everyone/members', { method: 'PUT', body: { members: ['coordinator', 'scout'] } });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'Everyone always holds all your agents. To talk to fewer, make a new group.');
    t.core.agents.create({ id: 'mira', name: 'Mira', role: 'Writer' });
    const c = (await t.call('/api/m/chat/chats/everyone')).json;
    assert.ok(c.members.includes('mira')); assert.equal(c.everyone, true);
    // an older desk that saved a fixed list in Everyone still gets every agent
    t.core.storage.run("UPDATE m_chat_chats SET members = ? WHERE id = 'everyone'", JSON.stringify(['coordinator', 'scout']));
    const c2 = (await t.call('/api/m/chat/chats/everyone')).json;
    assert.ok(c2.members.includes('coder') && c2.everyone);
  } finally { await t.close(); }
});

test('the record line under a reply is built from its steps, never from the model\'s words', () => {
  const name = (id) => id[0].toUpperCase() + id.slice(1);
  const steps = [{ tool: 'web_search', agentId: 'scout', status: 'done' }, { tool: 'web_read', agentId: 'scout', status: 'done' }, { tool: 'web_search', agentId: 'scout', status: 'done' }, { tool: 'web_read', agentId: 'scout', status: 'failed' }, { tool: 'web_search', agentId: 'scout', status: 'done' }];
  assert.equal(recordLine({ agentId: 'coordinator', status: 'done', text: 'I searched 20 sites.', meta: { steps } }, name), 'Coordinator answered · Scout searched the web 3 times, read a page; tried to read a page: did not work');
  assert.equal(recordLine({ agentId: 'coder', status: 'done', meta: { steps: [] } }, name), 'Coder answered');
  assert.equal(recordLine({ agentId: 'coordinator', status: 'done', meta: { groupSummary: 'g1', of: ['scout', 'coder'] } }, name), 'Coordinator summed up Scout and Coder');
  assert.equal(recordLine({ agentId: 'closer', meta: { passed: true } }, name), null);
});

test('a note a module posts (a new agent\'s welcome) is marked as posted, so it gets no rating controls', async () => {
  const { t } = await groupDesk();
  try {
    const r = t.core.modules.api('chat').postMessage('dm-scout', { agentId: 'scout', text: 'Glad to join your team.' });
    const m = (await t.call('/api/m/chat/chats/dm-scout/messages')).json.messages.find(x => x.id === r.messageId);
    assert.equal(m.meta.posted, true);
  } finally { await t.close(); }
});
