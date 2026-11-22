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
const isChoice = (b) => /Reply with one word: GO or PASS/.test(String(b.messages?.[0]?.content || ''));
/** A summary that names exactly the agents the prompt says answered, one line each. */
const goodSummary = (b) => { const m = String(b.messages[0].content).match(/Exactly these agents answered: (.*?)(?:;|\. Write)/); const names = m ? m[1].split(/, | and /) : []; return names.map(n => `${n}: a point from its reply.`).join('\n') + '\nNext: start with the sheet.'; };
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
    if (isChoice(b)) { const who = whoIs(b); seen.push('choice:' + who); return extra.go && who in extra.go ? extra.go[who] : 'GO'; }
    if (isSummary(b)) { seen.push('summary'); return typeof extra.summary === 'function' ? extra.summary(b) : extra.summary ?? goodSummary(b); }
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
    assert.deepEqual(sum.meta.of, ['scout', 'operator', 'coder'], 'the line under it lists exactly the agents summed up');
    assert.equal(replies.filter(m => m.agentId === 'coordinator').length, 1, 'the Coordinator sums up and does not answer twice');
    assert.equal(seen.filter(x => x === 'summary').length, 1);
    assert.ok(!msgs.some(m => m.meta?.groupLine), 'the "still writing" line goes when the run ends');
    assert.equal(msgs.filter(m => m.role === 'user').length, 1, 'one owner message');
    // the member prompt asks for its own role and says how to pass
    const sys = t.fake.calls.find(b => whoIs(b) === 'Scout' && !isChoice(b)).messages[0].content;
    assert.match(sys, /You chose to answer because your role adds something/); assert.match(sys, /reply with exactly PASS/); assert.match(sys, /Do not repeat or cover what belongs to another role/);
    // each agent first made its own short choice, told who else is in the group and that small talk is the Coordinator's
    const choice = t.fake.calls.find(b => whoIs(b) === 'Closer' && isChoice(b)).messages[0].content;
    assert.match(choice, /Scout: /); assert.match(choice, /Coordinator: answers greetings and small talk itself/); assert.match(choice, /greeting, thanks or small talk is the Coordinator's to answer/);
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
    const coderSys = t.fake.calls.find(b => whoIs(b) === 'Coder' && !isChoice(b)).messages[0].content;
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

test('a greeting in a group: every agent passes from its own choice, and the Coordinator answers alone, with no summary', async () => {
  const { t, seen } = await groupDesk({ Coordinator: 'Hello! What would you like to work on today?' }, { go: { Scout: 'PASS', Closer: 'PASS', Operator: 'PASS', Coder: 'PASS' } });
  try {
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello' } });
    const msgs = await settle(t, 'everyone');
    const replies = msgs.filter(m => m.role === 'assistant');
    assert.equal(replies.length, 1); assert.equal(replies[0].agentId, 'coordinator'); assert.equal(replies[0].text, 'Hello! What would you like to work on today?');
    assert.ok(!seen.includes('summary')); assert.deepEqual(seen.filter(x => !x.startsWith('choice:')), ['Coordinator'], 'only the Coordinator wrote');
    assert.equal(seen.filter(x => x.startsWith('choice:')).length, 4, 'each agent made its own one small choice');
    assert.ok(!msgs.some(m => m.role === 'system' && /nothing to add/i.test(m.text)), 'no pass lines when nobody went');
  } finally { await t.close(); }
});

test('only the agents that go write; the others are one quiet line; an agent is offered only the tools its role owns', async () => {
  const { t, seen } = await groupDesk({}, { go: { Scout: 'PASS', Operator: 'pass' } });
  try {
    t.core.modules.tools.set('web_search', { module: 'search', name: 'web_search', description: 's', parameters: { type: 'object', properties: {} }, async run() { return { results: [] }; } });
    t.core.modules.tools.set('file_list', { module: 'files', name: 'file_list', description: 'l', parameters: { type: 'object', properties: {} }, async run() { return { files: [] }; } });
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'What should a small bakery do this week to get three new office customers?' } });
    const msgs = await settle(t, 'everyone');
    assert.deepEqual(msgs.filter(m => m.role === 'assistant' && m.meta?.groupOf).map(m => m.agentId).sort(), ['closer', 'coder']);
    const line = msgs.find(m => m.role === 'system' && m.meta?.passedOf); assert.equal(line.text, 'Nothing to add from Scout and Operator');
    const coder = t.fake.calls.find(b => whoIs(b) === 'Coder' && !isChoice(b));
    assert.deepEqual((coder.tools || []).map(x => x.function.name), ['file_list'], 'the Coder is not offered a web search');
    assert.match(coder.messages[0].content, /your tools are only these: file_list\. No other tool exists here/);
    const sum = msgs.find(m => m.meta?.groupSummary); assert.deepEqual(sum.meta.of, ['closer', 'coder']);
    assert.ok(msgs.filter(m => m.role === 'assistant').at(-1).meta.groupMs > 0, 'the run is timed');
    void seen;
  } finally { await t.close(); }
});

test('a call to a tool the turn does not offer is not a step and is not shown as tried', async () => {
  let n = 0;
  const t = await testDesk({ modules: ['chat', 'agents'], script: () => (n++ === 0 ? { toolCalls: [{ name: 'code_run', args: { code: '1' } }] } : 'Here is the plan.') });
  try {
    await t.call('/api/m/chat/chats/dm-coder/send', { body: { text: 'Plan my week.' } });
    const msgs = await settle(t, 'dm-coder');
    const last = msgs.filter(m => m.role === 'assistant').at(-1);
    assert.equal(last.text, 'Here is the plan.'); assert.deepEqual(last.meta.steps, []);
    assert.match(t.fake.calls[1].messages.find(m => m.role === 'tool').content, /There is no tool called code_run in this turn/);
  } finally { await t.close(); }
});

test('a summary that names someone wrongly is written once more, then replaced by a plain list of who said what', async () => {
  const { t, seen } = await groupDesk({ Scout: 'Visit ten offices with samples. Then call.', Closer: 'Send a sample box to each office manager.' }, { go: { Operator: 'PASS', Coder: 'PASS' }, summary: () => 'All three agree. Operator: visit offices. Next: start.' });
  try {
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'How do I get three office customers?' } });
    const msgs = await settle(t, 'everyone');
    assert.equal(seen.filter(x => x === 'summary').length, 2, 'rewritten once');
    const fix = t.fake.calls.filter(isSummary)[1].messages[1].content; assert.match(fix, /Your last summary was wrong: it names Operator, who did not answer/);
    const sum = msgs.find(m => m.meta?.groupSummary);
    assert.equal(sum.text, 'Scout: Visit ten offices with samples.\nCloser: Send a sample box to each office manager.'); assert.equal(sum.meta.plainList, true);
    const sys = t.fake.calls.find(isSummary).messages[0].content; assert.match(sys, /Exactly these agents answered: Scout and Closer; Operator and Coder did not answer/);
  } finally { await t.close(); }
});

test('"Still writing" names only the agents writing now, not those still waiting their turn', async () => {
  const lines = [];
  const { t } = await groupDesk({ Scout: () => ({ text: 'Scout words.', delayMs: 300 }), Closer: () => ({ text: 'Closer words.', delayMs: 300 }) }, { go: { Operator: 'PASS', Coder: 'PASS' } });
  try {
    kvSet(t, 'groupParallel', 1);
    t.core.events.on((type, d) => { if (type === 'chat' && d.type === 'message' && d.message?.meta?.groupLine) lines.push(d.message.text); });
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'How do I get office customers?' } });
    await settle(t, 'everyone');
    assert.ok(lines.includes('Still writing: Scout') && lines.includes('Still writing: Closer'), JSON.stringify(lines));
    assert.ok(!lines.some(l => /Scout, Closer|Closer, Scout/.test(l)), JSON.stringify(lines));
  } finally { await t.close(); }
});

test('a new group of the owner\'s choice: the Coordinator stays in it (it sums up), the group is named from its members until renamed', async () => {
  const { t } = await groupDesk();
  try {
    const c = (await t.call('/api/m/chat/chats', { body: { title: 'New chat', members: ['coordinator'] } })).json;
    let r = await t.call(`/api/m/chat/chats/${c.id}/members`, { method: 'PUT', body: { members: ['scout', 'closer'] } });
    assert.deepEqual(r.json.members, ['coordinator', 'scout', 'closer']); assert.equal(r.json.title, 'Scout and Closer'); assert.equal(r.json.kind, 'group');
    const line = (await t.call(`/api/m/chat/chats/${c.id}/messages`)).json.messages.at(-1); assert.equal(line.text, 'Now in this chat: Coordinator, Scout, Closer. The conversation above stays.');
    r = await t.call(`/api/m/chat/chats/${c.id}/members`, { method: 'PUT', body: { members: ['scout', 'closer', 'coder'] } });
    assert.equal(r.json.title, 'Scout, Closer and Coder');
    await t.call(`/api/m/chat/chats/${c.id}`, { method: 'PATCH', body: { title: 'Bakery team' } });
    r = await t.call(`/api/m/chat/chats/${c.id}/members`, { method: 'PUT', body: { members: ['scout'] } });
    assert.equal(r.json.title, 'Bakery team', 'the owner\'s own name stays');
  } finally { await t.close(); }
});

test('the plan call is given today\'s date, so a plan for next year is not filled in with an old one', async () => {
  const { t } = await groupDesk({}, { go: {} });
  try {
    t.core.modules.tools.set('web_search', { module: 'search', name: 'web_search', description: 's', parameters: { type: 'object', properties: {} }, async run() { return { results: [] }; } });
    t.core.modules.tools.set('web_read', { module: 'search', name: 'web_read', description: 'r', parameters: { type: 'object', properties: {} }, async run() { return { text: '' }; } });
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Plan our 2027 trade fairs' } });
    await settle(t, 'everyone');
    const plan = t.fake.calls.find(isPlan); const year = new Date().getFullYear();
    assert.match(plan.messages[1].content, new RegExp(`^Today is \\w+day, \\d{1,2} \\w+ ${year}\\.`));
  } finally { await t.close(); }
});
