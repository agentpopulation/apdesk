// First use of the chat: the two starters before the desk's first exchange, side-panel buttons that never send a bare
// prefix, work that just finished is not started again by itself, the hand-off follows the kind of work, and times and
// money follow the owner's settings. Fake model: plumbing only, never proof that a real model behaves this way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

const waitReply = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    const last = r.json.messages.filter(m => m.role === 'assistant').at(-1);
    if (last && last.status !== 'streaming' && !r.json.chat.running) return { last, all: r.json.messages };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no reply');
};
const started = async (t) => (await t.call('/api/m/chat/chats')).json.started;

// ---------- 1. the first chat on a new desk
test('a new desk has had no exchange; the first finished one starts it, in any chat, and one code-written line follows it once', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: () => 'Hello! Good to meet you.' });
  try {
    assert.equal(await started(t), false);
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello' } });
    const { last, all } = await waitReply(t, 'everyone');
    assert.equal(last.text, 'Hello! Good to meet you.'); assert.ok(last.label, 'the reply keeps its model label');
    assert.equal(await started(t), true);
    const after = all.slice(all.findIndex(m => m.id === last.id) + 1);
    assert.equal(after.length, 1); assert.equal(after[0].role, 'system');
    assert.match(after[0].text, /suggestions above the message box/); assert.equal(after[0].text.split(/(?<=[.!?])\s+/).length, 1, 'one sentence');
    // the second exchange, in another chat: no second line
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: 'Hi again' } });
    const r2 = await waitReply(t, 'dm-scout');
    assert.ok(!r2.all.some(m => m.role === 'system'));
    // cleared messages do not make the desk new again
    await t.call('/api/m/chat/chats/everyone', { method: 'DELETE' });
    assert.equal(await started(t), true);
  } finally { await t.close(); }
});

test('a first hello that gets no answer leaves the desk not started; the next answered exchange starts it', async () => {
  let fail = true;
  const t = await testDesk({ modules: ['chat', 'agents'], script: () => fail ? { status: 503, text: 'busy' } : 'Hello there.' });
  try {
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello' } });
    const { last, all } = await waitReply(t, 'everyone');
    assert.equal(last.status, 'error');
    assert.equal(await started(t), false);
    assert.ok(!all.some(m => m.role === 'system'));
    fail = false;
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Hello' } });
    const r2 = await waitReply(t, 'everyone');
    assert.equal(r2.last.status, 'done'); assert.equal(await started(t), true);
    assert.equal(r2.all.filter(m => m.role === 'system').length, 1);
  } finally { await t.close(); }
});

test('a desk with an exchange from before (no flag stored) counts as started', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'] });
  try {
    t.core.storage.run("INSERT INTO m_chat_messages (chat_id, role, text, status, at, updated) VALUES ('everyone', 'user', 'hi', 'done', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')");
    assert.equal(await started(t), false, 'an owner message alone is not an exchange');
    t.core.storage.run("INSERT INTO m_chat_messages (chat_id, role, agent_id, text, status, at, updated) VALUES ('everyone', 'assistant', 'coordinator', 'hello', 'done', '2026-11-01T00:00:01Z', '2026-11-01T00:00:01Z')");
    assert.equal(await started(t), true);
  } finally { await t.close(); }
});

// ---------- 2. a side-panel prefix with nothing after it
test('a message that is only a side-panel prefix is refused with a plain line and no model call', async () => {
  let calls = 0;
  const t = await testDesk({ modules: ['chat', 'agents'], script: () => { calls++; return 'ok'; } });
  try {
    for (const [text, line] of [['Make this a background task:', /Tell me what to run in the background\./], ['Make this a background task: ', /in the background/], ['make this a background task', /in the background/], ['Every morning at 8,', /Tell me what to run every morning at 8\./]]) {
      const r = await t.call('/api/m/chat/chats/everyone/send', { body: { text } });
      assert.equal(r.status, 400, text); assert.match(r.json.error, line, text);
    }
    assert.equal(calls, 0);
    assert.equal((await t.call('/api/m/chat/chats/everyone/messages')).json.messages.length, 0);
    const { bareStart, PANEL_PREFIXES } = await import('./ui-text.js');
    assert.equal(bareStart('Make this a background task: find 20 leads'), null);
    assert.equal(bareStart(PANEL_PREFIXES.task), 'task'); assert.equal(bareStart(PANEL_PREFIXES.routine), 'routine');
  } finally { await t.close(); }
});

test('the side panel offers the last owner ask, without its prefix', async () => {
  const { lastAsk } = await import('./ui-text.js');
  const m = (id, text, meta = {}) => ({ id, role: 'user', text, meta });
  assert.equal(lastAsk([]), null);
  assert.equal(lastAsk([m(1, 'Find 20 leads with sources for my product'), { id: 2, role: 'assistant', text: 'Done' }]), 'Find 20 leads with sources for my product');
  assert.equal(lastAsk([m(1, 'Find 20 leads'), m(2, 'Find more', { action: 'leads_find' })]), 'Find 20 leads', 'a button press is not an ask');
  assert.equal(lastAsk([m(1, 'Find 20 leads'), m(2, 'Make this a background task:')]), 'Find 20 leads', 'a bare prefix is not an ask');
  assert.equal(lastAsk([m(1, 'Make this a background task: Find 20 leads')]), 'Find 20 leads');
  assert.equal(lastAsk([m(1, 'Bakeries in Pune', { aboutAnswer: true })]), null, 'his answer about his business is not an ask');
});

// ---------- 3. work that has just finished is not started again by itself
const leadsFake = (t, runs) => t.core.modules.tools.set('leads_find', { module: 'sales', name: 'leads_find', description: 'find leads', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer' } } }, async run(a, call) {
  runs.push(a);
  const j = await t.core.jobs.start({ kind: 'sales.find', title: `Find ${a.count || 20} leads: ${a.query}`, agentId: 'closer', chatId: call.chatId, input: { query: a.query, count: a.count || 20 }, run: async () => ({ text: '20 leads found.' }) });
  await t.core.jobs.wait(j.id);
  return { ok: true, jobId: j.id };
} });
const callsLeads = (b) => (b.tools || []).some(x => x.function.name === 'leads_find') && !b.messages.some(m => m.role === 'tool') ? { toolCalls: [{ name: 'leads_find', args: { query: 'bakeries in Pune', count: 20 } }] } : 'The lead search has started.';
const ASK = 'Find 20 leads: bakeries in Pune';

test('the same ask in the same chat within the hour: one code-written line with Open the result and Run it again; Run it again starts it', async () => {
  const runs = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: callsLeads });
  try {
    t.core.settings.set('timeZone', 'Asia/Kolkata'); t.core.settings.set('locale', 'en-IN');
    leadsFake(t, runs);
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: ASK } });
    await waitReply(t, 'sales-room'); await new Promise(r => setTimeout(r, 100));
    assert.equal(runs.length, 1);
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: '  find 20 LEADS: bakeries in Pune ' } });
    const { last } = await waitReply(t, 'sales-room');
    assert.equal(runs.length, 1, 'not started again by itself');
    assert.equal(last.status, 'done');
    assert.match(last.text, /^This is already done in this chat: "Find 20 leads: bakeries in Pune" finished (?:just now|\d+ min(?:ute)?s? ago), at \d{1,2}:\d{2}\s?(?:am|pm)\. The result is in the table above and in Sales\.$/i);
    assert.equal(last.text.split('\n').length, 1);
    const acts = last.cards.find(c => c.kind === 'actions').actions;
    assert.deepEqual(acts.map(a => a.label), ['Open the result', 'Run it again']);
    assert.equal(acts[0].go, '#/sales'); assert.equal(acts[1].tool, 'leads_find');
    // Run it again starts it
    const r = await t.call('/api/m/chat/chats/sales-room/action', { body: { tool: acts[1].tool, args: acts[1].args, label: acts[1].label } });
    assert.equal(r.json.ok, true); assert.equal(runs.length, 2);
  } finally { await t.close(); }
});

test('a different ask, the same ask in another chat, or the same ask after an hour starts normally', async () => {
  const runs = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: callsLeads });
  try {
    leadsFake(t, runs);
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: ASK } }); await waitReply(t, 'sales-room');
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: 'Find 20 leads: bakeries in Mumbai' } }); await waitReply(t, 'sales-room');
    assert.equal(runs.length, 2, 'a different ask');
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: ASK } }); await waitReply(t, 'everyone');
    assert.equal(runs.length, 3, 'another chat');
    // the first job finished more than an hour ago
    for (const j of t.core.jobs.list({ limit: 10 })) if (j.chatId === 'sales-room') t.core.storage.run('UPDATE jobs SET finished = ? WHERE id = ?', new Date(Date.now() - 61 * 60000).toISOString(), j.id);
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: ASK } }); await waitReply(t, 'sales-room');
    assert.equal(runs.length, 4, 'after an hour');
  } finally { await t.close(); }
});

test('a finished task for the same ask is not started again; a failed one is', async () => {
  const runs = [];
  const T = 'As a background task, write a short brief on the history of the bicycle.';
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => (b.tools || []).some(x => x.function.name === 'task_create') && !b.messages.some(m => m.role === 'tool') ? { toolCalls: [{ name: 'task_create', args: { prompt: 'Write a short brief on the history of the bicycle.' } }] } : 'Started.' });
  try {
    let fail = true;
    t.core.modules.tools.set('task_create', { module: 'tasks', name: 'task_create', description: 'background task', parameters: { type: 'object', properties: { prompt: { type: 'string' } } }, async run(a, call) {
      runs.push(a); const f = fail;
      const j = await t.core.jobs.start({ kind: 'tasks.run', title: 'Bicycle brief', agentId: 'coordinator', chatId: call.chatId, input: { prompt: a.prompt }, run: async () => { if (f) throw new Error('No model answered'); return { answer: 'brief' }; } });
      await t.core.jobs.wait(j.id); return { ok: true, started: 'Bicycle brief' };
    } });
    await t.call('/api/m/chat/chats/dm-coordinator/send', { body: { text: T } }); await waitReply(t, 'dm-coordinator');
    fail = false;
    await t.call('/api/m/chat/chats/dm-coordinator/send', { body: { text: T } }); await waitReply(t, 'dm-coordinator');
    assert.equal(runs.length, 2, 'the first one failed: it runs');
    await t.call('/api/m/chat/chats/dm-coordinator/send', { body: { text: T } });
    const { last } = await waitReply(t, 'dm-coordinator');
    assert.equal(runs.length, 2, 'the second one finished: not again');
    assert.match(last.text, /^This is already done in this chat: "Bicycle brief" finished .+ The result is above in this chat and in Tasks\.$/);
  } finally { await t.close(); }
});

// ---------- 4. the hand-off follows the kind of work
test('a background task for a leads ask goes to the agent whose role is leads, not to research; with that agent retired, the Coordinator does it and says so', async () => {
  const runs = [];
  const LEADS = 'Make this a background task: Find 20 leads with sources for my product';
  const script = (b) => (b.tools || []).some(x => x.function.name === 'task_create') && !b.messages.some(m => m.role === 'tool') ? { toolCalls: [{ name: 'task_create', args: { prompt: 'Find 20 leads with sources for my product', agentId: 'scout' } }] } : 'Started.';
  const t = await testDesk({ modules: ['chat', 'agents'], script });
  try {
    t.core.modules.tools.set('task_create', { module: 'tasks', name: 'task_create', description: 'background task', parameters: { type: 'object', properties: { prompt: { type: 'string' }, agentId: { type: 'string' } } }, async run(a) { runs.push(a); return { ok: true, started: 'Leads' }; } });
    leadsFake(t, []);
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: LEADS } }); await waitReply(t, 'sales-room');
    assert.equal(runs[0].agentId, 'closer');
    await t.call('/api/m/agents/agents/closer', { method: 'DELETE' });
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: LEADS } });
    const { last } = await waitReply(t, 'everyone');
    assert.equal(runs[1].agentId, 'coordinator');
    assert.match(last.text, /Closer is not on your team, so I did this myself\./);
  } finally { await t.close(); }
});

test('"Find 20 leads with sources" opens lead search and not deep research; a research ask with sources still opens research', async () => {
  const { heavyAsked } = await import('./coordinator.js');
  for (const s of ['Find 20 leads with sources', 'Find 20 leads with sources for my product', 'Make this a background task: Find 20 leads with sources for my product', 'Find 5 leads with sources: bakeries in Pune']) assert.deepEqual([...heavyAsked(s)], ['leads'], s);
  for (const s of ['Research this topic and cite sources', 'Give me a cited report', 'Write about solar cells with sources']) assert.deepEqual([...heavyAsked(s)], ['research'], s);
  const offered = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => { offered.push((b.tools || []).map(x => x.function.name)); return 'ok'; } });
  try {
    for (const [name, module] of [['leads_find', 'sales'], ['research_deep', 'research']]) t.core.modules.tools.set(name, { module, name, description: name, parameters: { type: 'object', properties: {} }, async run() { return { ok: false }; } });
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: 'Find 20 leads with sources' } }); await waitReply(t, 'sales-room');
    assert.ok(offered[0].includes('leads_find')); assert.ok(!offered[0].includes('research_deep'));
  } finally { await t.close(); }
});

// ---------- 5. times and money follow the owner's settings
test('a desk set to the US shows a chat reply\'s time and a lead\'s value in its zone and currency; a desk set to India as before', async () => {
  const at = '2026-11-20T15:30:00Z';
  for (const [place, wantTime, wantMoney, wantPrompt] of [
    [{ timeZone: 'America/New_York', locale: 'en-US', currency: 'USD' }, /10:30\s?AM/, '$1,234', /\(America\/New_York\)\. Currency: USD\./],
    [{ timeZone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR' }, /9:00\s?pm/i, '₹1,234', /\(Asia\/Kolkata\)\. Currency: INR\./]]) {
    const runs = []; const prompts = [];
    const t = await testDesk({ modules: ['chat', 'agents', 'sales'], script: (b) => { prompts.push(b.messages.map(m => m.content).join('\n')); return callsLeads(b); } });
    try {
      for (const [k, v] of Object.entries(place)) t.core.settings.set(k, v);
      leadsFake(t, runs);
      await t.call('/api/m/chat/chats/sales-room/send', { body: { text: ASK } }); await waitReply(t, 'sales-room');
      assert.match(prompts[0], wantPrompt, place.timeZone);
      for (const j of t.core.jobs.list({ limit: 10 })) t.core.storage.run('UPDATE jobs SET finished = ? WHERE id = ?', new Date(Math.max(Date.parse(at), Date.now() - 50 * 60000)).toISOString(), j.id);
      const fin = t.core.jobs.list({ limit: 10 })[0].finished;
      await t.call('/api/m/chat/chats/sales-room/send', { body: { text: ASK } });
      const { last } = await waitReply(t, 'sales-room');
      const shown = new Date(fin).toLocaleTimeString(place.locale, { hour: 'numeric', minute: '2-digit', timeZone: place.timeZone });
      assert.ok(last.text.includes(`at ${shown}.`), `${place.timeZone}: ${last.text} / ${shown}`);
      // a lead's value, as the Sales module writes it for the chat and the pipeline note
      await t.core.modules.runTool('lead_add', { company: 'Acme Bakery', value: 1234 }, { chatId: 'sales-room' });
      prompts.length = 0;
      await t.call('/api/m/sales/coach', { method: 'POST', body: {} });
      assert.ok(prompts.some(p => p.includes(`Acme Bakery · New · ${wantMoney}`)), place.currency + ': ' + prompts.at(-1)?.slice(-200));
    } finally { await t.close(); }
    // the screen's own formatting (the reply's time under a bubble, a lead's value on the Sales page)
    globalThis.document ??= { querySelector: () => null };
    const { fmt, setPrefs } = await import('../../app/ui/kit.js');
    setPrefs(place);
    assert.match(fmt.time(at), wantTime, place.timeZone); assert.equal(fmt.money(123400), wantMoney);
  }
});

test('money with no currency set is the plain number, with no symbol and no leading space', async () => {
  globalThis.document ??= { querySelector: () => null };
  const { fmt, setPrefs } = await import('../../app/ui/kit.js');
  setPrefs({ locale: 'en-US', currency: '' });
  assert.equal(fmt.money(123400), '1,234');
  setPrefs({ currency: 'INR', locale: 'en-IN' });
});
