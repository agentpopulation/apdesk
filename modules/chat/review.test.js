// Corrections from the 22 Nov review on the chat side: a card action honours the agent's tool switches, failures read as one
// plain line, the business name and plain-remark line reach the prompt, group roles, the footer's running events, the plan retry.
// Plumbing tests against the fake model; never proof that the replies are good (see real-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { failLine } from './ui-text.js';

const kvSet = (t, k, v) => t.core.storage.kvScope('m:chat').set(k, v);
const waitIdle = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    if (!r.json.chat.running && !r.json.messages.some(m => m.status === 'streaming')) return r.json.messages;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the chat did not settle');
};
const isPlan = (b) => /You plan how the desk answers/.test(String(b.messages?.[0]?.content || ''));
const isChoice = (b) => /Reply with one word: GO or PASS/.test(String(b.messages?.[0]?.content || ''));
const whoIs = (b) => (String(b.messages?.[0]?.content || '').match(/^You are ([\w-]+), an agent/) || [])[1] || null;

test('5: a card action for a tool switched off for that agent is refused in plain words and never runs', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    const ran = [];
    t.core.modules.tools.set('file_list', { module: 'files', name: 'file_list', description: 'List files', parameters: { type: 'object', properties: {} }, async run(a, call) { ran.push(call.agentId); return { files: [] }; } });
    const off = await t.call('/api/m/agents/agents/coordinator/tools', { method: 'PUT', body: { off: ['file_list'] } });
    assert.equal(off.status, 200);
    const r = await t.call('/api/m/chat/chats/dm-coordinator/action', { body: { tool: 'file_list', label: 'List files' } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /^Coordinator may not use this tool\. Switch it on in Agents/);
    assert.deepEqual(ran, [], 'the tool did not run');
    const msgs = (await t.call('/api/m/chat/chats/dm-coordinator/messages')).json.messages;
    assert.ok(!msgs.some(m => /Done: List files/.test(m.text || '')), 'no "Done" line for work that did not happen');
    // switched back on, the same button runs it
    await t.call('/api/m/agents/agents/coordinator/tools', { method: 'PUT', body: { off: [] } });
    const ok = await t.call('/api/m/chat/chats/dm-coordinator/action', { body: { tool: 'file_list', label: 'List files' } });
    assert.equal(ok.status, 200); assert.deepEqual(ran, ['coordinator']);
  } finally { await t.close(); }
});

test('35: a failed card action shows one plain line, never the raw message', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    t.core.modules.tools.set('web_read', { module: 'search', name: 'web_read', description: 'r', parameters: { type: 'object', properties: {} }, async run() { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND example.com'), { code: 'ENOTFOUND' }) }); } });
    t.core.modules.tools.set('web_search', { module: 'search', name: 'web_search', description: 's', parameters: { type: 'object', properties: {} }, async run() { const e = new Error('HTTP 429 [{ "error": { "code": 429, "message": "You exceeded your current quota' ); e.status = 429; throw e; } });
    let r = await t.call('/api/m/chat/chats/dm-scout/action', { body: { tool: 'web_read', label: 'Read it' } });
    let m = (await t.call('/api/m/chat/chats/dm-scout/messages')).json.messages.at(-1);
    assert.equal(m.text, 'This PC is not online. Local models still work.', 'the door\'s own line, with no prefix');
    assert.doesNotMatch(JSON.stringify(r.json), /fetch failed|ENOTFOUND/);
    r = await t.call('/api/m/chat/chats/dm-scout/action', { body: { tool: 'web_search', label: 'Search' } });
    m = (await t.call('/api/m/chat/chats/dm-scout/messages')).json.messages.at(-1);
    assert.equal(m.text, 'The provider is busy right now. Try again in a minute.');
    assert.doesNotMatch(m.text + ' ' + r.json.error, /HTTP 429|\{|quota/);
  } finally { await t.close(); }
});

test('35: failLine keeps the desk\'s own plain sentences and turns everything else into one plain line by its kind', () => {
  assert.equal(failLine(new Error('Say what to research.')), 'Say what to research.');
  assert.equal(failLine(Object.assign(new Error('x'), { code: 'timeout' })), 'No answer in time. Try again in a minute.');
  assert.equal(failLine(Object.assign(new Error('Request failed with 401'), { status: 401 })), 'The service refused it. If it needs a key, check it in Models.');
  assert.equal(failLine(Object.assign(new Error('No model answered. Free API · x: fetch failed; Gemini: HTTP 429 [{'), { code: 'all_failed', attempts: [] })), 'No model answered. Try again in a minute, or check your keys in Models.');
  // the model door's own line (it carries the kind) stands as the door wrote it
  assert.equal(failLine(Object.assign(new Error('No model answered: the providers are busy. Try again in a minute.'), { code: 'all_failed', why: 'busy' })), 'No model answered: the providers are busy. Try again in a minute.');
  assert.equal(failLine(new TypeError('Cannot read properties of undefined (reading \'x\')')), 'Something went wrong. Try again in a minute.');
  assert.equal(failLine(Object.assign(new Error('Stopped'), { code: 'halted' })), 'Everything is stopped. Press Resume first.');
});

test('35: a chat turn whose model call fails with raw text shows the plain line', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: () => ({ status: 500, text: 'upstream exploded {"trace": 1}' }) });
  try {
    await t.call('/api/m/chat/chats/dm-coder/send', { body: { text: 'Hello' } });
    const m = (await waitIdle(t, 'dm-coder')).filter(x => x.role === 'assistant').at(-1);
    assert.equal(m.status, 'error');
    assert.doesNotMatch(m.text, /exploded|trace|\{|HTTP \d/);
    assert.match(m.text, /^No model/);
  } finally { await t.close(); }
});

test('10 and a: the business name is one short line of every chat agent\'s instructions; a remark or greeting is answered with no tool', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    t.core.settings.set('companyName', 'Sunrise Bakes');
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: 'Hello' } });
    await waitIdle(t, 'dm-scout');
    const sys = t.fake.calls.filter(b => !isPlan(b)).at(-1).messages[0].content;
    assert.match(sys, /\nThe owner's business is called "Sunrise Bakes"\.\n/);
    assert.match(sys, /A greeting, thanks, small talk, or the owner telling you about himself or his business is answered in words, with no tool/);
    assert.match(sys, /follow a skill's steps only when the owner asks for that piece of work; a greeting, thanks or a remark about himself or his business is not such an ask/);
  } finally { await t.close(); }
});

test('c: in a group turn the agent who owns lead search is not offered it unless the ask is for leads; in its own chat it is', async () => {
  const offered = new Map();
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    if (isPlan(b)) return '{"needsFacts": false, "parts": []}';
    if (isChoice(b)) return whoIs(b) === 'Closer' ? 'GO' : 'PASS';
    if (whoIs(b) === 'Closer') offered.set(String(b.messages.at(-1).content), (b.tools || []).map(x => x.function?.name || x.name));
    return 'A short answer.';
  } });
  try {
    t.core.modules.tools.set('leads_find', { module: 'sales', name: 'leads_find', description: 'Find leads', parameters: { type: 'object', properties: { query: { type: 'string' } } }, async run() { return { ok: true }; } });
    t.core.modules.tools.set('sales_note', { module: 'sales', name: 'sales_note', description: 'A note', parameters: { type: 'object', properties: {} }, async run() { return { ok: true }; } });
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: 'My bakery wants corporate tea-time orders. What do you think?' } });
    await waitIdle(t, 'sales-room');
    assert.deepEqual(offered.get('My bakery wants corporate tea-time orders. What do you think?'), ['sales_note'], 'a group turn: no lead search the owner did not ask for');
    await t.call('/api/m/chat/chats/dm-closer/send', { body: { text: 'Corporate tea-time orders: what do you think?' } });
    await waitIdle(t, 'dm-closer');
    assert.ok(offered.get('Corporate tea-time orders: what do you think?').includes('leads_find'), 'its own chat keeps its own work');
  } finally { await t.close(); }
});

test('b: a group member is told its own part and to leave the other roles\' plans to them; the choice is GO only for work in its role', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => isPlan(b) ? '{"needsFacts": false, "parts": []}' : isChoice(b) ? 'GO' : 'A short answer.' });
  try {
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Plan my week.' } });
    await waitIdle(t, 'everyone');
    const choice = t.fake.calls.find(b => isChoice(b) && whoIs(b) === 'Coder').messages[0].content;
    assert.match(choice, /Answer GO only when the owner's message needs work in your own role \(Coder: [^)]+\)/);
    const member = t.fake.calls.find(b => !isChoice(b) && !isPlan(b) && whoIs(b) === 'Closer').messages[0].content;
    assert.match(member, /Your part is only Closer's role: /);
    assert.match(member, /Leave the other roles' parts to them: do not write steps, a plan or a schedule for their work/);
  } finally { await t.close(); }
});

test('e: every ended turn tells the footer it ended, and every streaming message carries its agent', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b, n) => n === 1 ? { status: 500, text: 'boom' } : 'Fine.' });
  const ev = []; t.core.events.on((type, d) => { if (type === 'chat') ev.push(d); });
  try {
    await t.call('/api/m/chat/chats/dm-coder/send', { body: { text: 'Hello' } });   // fails
    await waitIdle(t, 'dm-coder');
    await t.call('/api/m/chat/chats/dm-coder/send', { body: { text: 'Hello again' } });   // done
    await waitIdle(t, 'dm-coder');
    const offs = ev.filter(d => d.type === 'running' && d.chatId === 'dm-coder' && d.on === false).length;
    assert.ok(offs >= 2, 'one "running off" per ended turn: ' + offs);
    for (const d of ev.filter(d => d.type === 'message' && d.message?.status === 'streaming')) assert.ok(d.message.agentId, 'a streaming message names its agent');
    for (const d of ev.filter(d => d.type === 'delta')) assert.ok(d.agentId, 'a streamed piece names its agent');
  } finally { await t.close(); }
});

test('d: the plan is asked of another model when the first one does not answer in time', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    if (isPlan(b)) return b.model === 'gemini-test' ? JSON.stringify({ needsFacts: false, parts: [] }) : { text: '{"needsFacts": false, "parts": []}', delayMs: 2500 };
    return 'A plain answer.';
  } });
  try {
    t.core.model.addKey('gemini', 'gm-test-12345678', 'test', { baseUrl: t.fake.baseUrl, model: 'gemini-test' });
    kvSet(t, 'modelWaitMs', 800);
    t.core.modules.tools.set('web_search', { module: 'search', name: 'web_search', description: 's', parameters: { type: 'object', properties: {} }, async run() { return { results: [] }; } });
    t.core.modules.tools.set('web_read', { module: 'search', name: 'web_read', description: 'r', parameters: { type: 'object', properties: {} }, async run() { return { text: '' }; } });
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: 'What is the newest NVIDIA chip?' } });
    const last = (await waitIdle(t, 'dm-scout', 20000)).filter(m => m.role === 'assistant').at(-1);
    const plans = t.fake.calls.filter(isPlan).map(b => b.model);
    assert.equal(plans[0], 'fake-model'); assert.ok(plans.includes('gemini-test'), 'the plan went to another model: ' + plans);
    assert.equal(last.status, 'done'); assert.equal(last.meta.planNote, undefined, 'a plan came back, so no "could not plan" line');
  } finally { await t.close(); }
});

test('9: the swarm tool says how many work at once, as the code runs it', async () => {
  const t = await testDesk({ modules: ['chat', 'agents', 'search', 'research'] });
  try {
    const sw = t.core.modules.tools.get('research_swarm');
    assert.match(sw.description, /parts \(agents: 1 to 50\), read by agents up to 4 at a time/);
    assert.doesNotMatch(sw.description, /working in parallel \(1 to 50\)/);
  } finally { await t.close(); }
});

test('c: a group member whose reply has no words after only looking things up shows one quiet "nothing to add" line, never an empty row', async () => {
  let looked = 0;
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    if (isPlan(b)) return '{"needsFacts": false, "parts": []}';
    if (isChoice(b)) return whoIs(b) === 'Coder' ? 'GO' : 'PASS';
    if (whoIs(b) === 'Coder') return b.messages.some(m => m.role === 'tool') ? 'Done.' : { text: '', toolCalls: [{ name: 'file_list', args: {} }] };
    return 'A short answer.';
  } });
  try {
    t.core.modules.tools.set('file_list', { module: 'files', name: 'file_list', description: 'List files', parameters: { type: 'object', properties: {} }, async run() { looked++; return { files: [] }; } });
    await t.call('/api/m/chat/chats/build-room/send', { body: { text: 'Plan my week.' } });
    const msgs = await waitIdle(t, 'build-room');
    const coder = msgs.filter(m => m.role === 'assistant' && m.agentId === 'coder');
    assert.equal(looked, 1);
    assert.equal(coder.length, 1); assert.equal(coder[0].text, 'Coder had nothing to add'); assert.equal(coder[0].meta.passed, true);
  } finally { await t.close(); }
});

test('b: when every agent that chose to answer passes after all, the Coordinator still answers the owner', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    if (isPlan(b)) return '{"needsFacts": false, "parts": []}';
    if (isChoice(b)) return whoIs(b) === 'Closer' ? 'GO' : 'PASS';
    if (whoIs(b) === 'Closer') return 'PASS';
    if (whoIs(b) === 'Coordinator') return 'Here is your week, in one plan.';
    return 'A short answer.';
  } });
  try {
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: 'Plan my week.' } });
    const msgs = await waitIdle(t, 'sales-room');
    const replies = msgs.filter(m => m.role === 'assistant');
    assert.equal(replies.find(m => m.agentId === 'closer')?.text, 'Closer had nothing to add');
    const co = replies.filter(m => m.agentId === 'coordinator');
    assert.equal(co.length, 1); assert.equal(co[0].text, 'Here is your week, in one plan.');
  } finally { await t.close(); }
});

test('a failed card action: a file-system fault or a key out of credit is one plain line, with no path and no "busy"', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    const fsp = await import('node:fs/promises');
    t.core.modules.tools.set('web_read', { module: 'search', name: 'web_read', description: 'r', parameters: { type: 'object', properties: {} }, async run() { await fsp.readFile('/nope/secret/path.txt'); } });
    t.core.modules.tools.set('web_search', { module: 'search', name: 'web_search', description: 's', parameters: { type: 'object', properties: {} }, async run() { throw Object.assign(new Error('Payment required: insufficient credits'), { status: 402 }); } });
    let r = await t.call('/api/m/chat/chats/dm-scout/action', { body: { tool: 'web_read', label: 'Read it' } });
    let m = (await t.call('/api/m/chat/chats/dm-scout/messages')).json.messages.at(-1);
    assert.equal(m.text, 'Something went wrong on this PC. The details are in the desk\'s log.');
    assert.doesNotMatch(JSON.stringify(r.json) + m.text, /ENOENT|nope|secret|That did not work/);
    r = await t.call('/api/m/chat/chats/dm-scout/action', { body: { tool: 'web_search', label: 'Search' } });
    m = (await t.call('/api/m/chat/chats/dm-scout/messages')).json.messages.at(-1);
    assert.match(m.text, /credit/); assert.doesNotMatch(m.text, /busy/i);
  } finally { await t.close(); }
});

test('a throw while a turn is being set up does not leave the chat marked as running', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    const resolve = t.core.model.resolve.bind(t.core.model); let once = true;
    t.core.model.resolve = (...a) => { if (once) { once = false; throw new Error('setup broke'); } return resolve(...a); };
    await t.call('/api/m/chat/chats/dm-coder/send', { body: { text: 'Hello' } });
    await new Promise(r => setTimeout(r, 300));
    const st = (await t.call('/api/m/chat/chats/dm-coder/messages')).json;
    assert.ok(!st.chat.running, 'the chat is free');
    assert.ok(!st.messages.some(x => x.status === 'streaming'), 'no reply is left streaming');
    const again = await t.call('/api/m/chat/chats/dm-coder/send', { body: { text: 'Hello again' } });
    assert.equal(again.status, 200, again.text);
    const m = (await waitIdle(t, 'dm-coder')).filter(x => x.role === 'assistant').at(-1);
    assert.equal(m.status, 'done');
  } finally { await t.close(); }
});

test('a throw while a group turn is being set up does not leave the room marked as running', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => (isPlan(b) ? '{"needsFacts": false, "parts": []}' : isChoice(b) ? 'PASS' : 'A short answer.') });
  try {
    const kvGet = t.core.storage.kvGet.bind(t.core.storage); let once = true;
    t.core.storage.kvGet = (ns, key, f) => { if (once && key === 'groupTurnMs') { once = false; throw new Error('setup broke'); } return kvGet(ns, key, f); };
    await t.call('/api/m/chat/chats/build-room/send', { body: { text: 'Plan my week.' } });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(once, false, 'the setup did throw');
    assert.ok(!(await t.call('/api/m/chat/chats/build-room/messages')).json.chat.running, 'the room is free');
    const again = await t.call('/api/m/chat/chats/build-room/send', { body: { text: 'Plan my week, please.' } });
    assert.equal(again.status, 200, again.text);
    await waitIdle(t, 'build-room');
  } finally { await t.close(); }
});
