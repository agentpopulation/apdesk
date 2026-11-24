// ask() for other modules: a list of tools for one turn (offered and run only from that list), and what the turn cost.
// Plumbing tests against the fake model; never evidence that a real model keeps to the list (see real-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

const addTool = (t, name, ran) => t.core.modules.tools.set(name, { module: 'search', name, description: `Test tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } }, async run(args) { ran.push(name); return { ok: true, text: `${name} ran` }; } });
const offeredIn = (b) => (b.tools || []).map(x => x.function?.name || x.name);

test('chat says it takes a list of tools and gives back the cost: askTakes and supports name them', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: () => 'ok' });
  try {
    const chat = t.core.modules.api('chat');
    assert.ok(chat.askTakes.includes('tools'));
    for (const s of ['ask.tools', 'ask.cost', 'commands']) assert.ok(chat.supports.includes(s), s);
  } finally { await t.close(); }
});

test('a tool outside the list cannot be called: it is not offered, and when the model names it anyway it does not run', async () => {
  const ran = []; const offered = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    offered.push(offeredIn(b));
    if (b.messages.some(m => m.role === 'tool')) return 'Finished with what I had.';
    return { toolCalls: [{ name: 'tl_third', args: { x: '1' } }, { name: 'tl_one', args: { x: '2' } }] };
  } });
  try {
    for (const n of ['tl_one', 'tl_two', 'tl_third']) addTool(t, n, ran);
    const out = await t.core.modules.api('chat').ask({ agentId: 'coordinator', text: 'Use your tools on this.', tools: ['tl_one', 'tl_two'] });
    assert.ok(offered.length >= 1);
    for (const list of offered) assert.ok(list.every(n => n === 'tl_one' || n === 'tl_two'), `offered only the list: ${list}`);
    assert.ok(offered[0].includes('tl_one') && offered[0].includes('tl_two'));
    assert.deepEqual(ran, ['tl_one'], 'the third tool never ran');
    const m = t.core.modules.api('chat').messagesSince('', 50).find(x => x.id === out.messageId);
    assert.ok(!(m.meta.steps || []).some(st => st.tool === 'tl_third' && st.status === 'done'));
    // the same turn without a list is offered every tool, as before
    offered.length = 0;
    await t.core.modules.api('chat').ask({ agentId: 'coordinator', text: 'Again, any tool.' });
    assert.ok(offered[0].includes('tl_third'));
  } finally { await t.close(); }
});

test('an empty list means no tools at all for that turn; a name that is no tool is left out', async () => {
  const ran = []; const offered = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => { offered.push(offeredIn(b)); return b.tools?.length ? { toolCalls: [{ name: 'tl_one', args: {} }] } : 'Words only.'; } });
  try {
    addTool(t, 'tl_one', ran);
    const out = await t.core.modules.api('chat').ask({ agentId: 'coordinator', text: 'Do it.', tools: [] });
    assert.equal(out.text, 'Words only.'); assert.deepEqual(ran, []);
    assert.ok(offered.every(l => l.length === 0));
    offered.length = 0;
    await t.core.modules.api('chat').ask({ agentId: 'coordinator', text: 'Do it.', tools: ['no_such_tool'] });
    assert.ok(offered.every(l => l.length === 0));
  } finally { await t.close(); }
});

test('ask() gives back what the turn cost and the ids of its model calls, from the call log', async () => {
  const ran = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => b.messages.some(m => m.role === 'tool') ? 'Done with it.' : (b.tools?.length ? { toolCalls: [{ name: 'tl_one', args: {} }] } : 'Done with it.') });
  try {
    addTool(t, 'tl_one', ran);
    t.core.settings.set('currency', 'INR');
    const out = await t.core.modules.api('chat').ask({ agentId: 'closer', text: 'Run it.', tools: ['tl_one'] });
    assert.ok(Array.isArray(out.callIds) && out.callIds.length >= 2, `two model calls: ${out.callIds}`);
    const rows = t.core.storage.all(`SELECT id, agent_id, cost_minor FROM calls WHERE id IN (${out.callIds.map(() => '?').join(',')})`, ...out.callIds);
    assert.equal(rows.length, out.callIds.length);
    assert.ok(rows.every(r => r.agent_id === 'closer'));
    assert.deepEqual(out.cost, { minor: 0, currency: 'INR', known: true });   // the free router costs nothing
    // a call whose cost the log does not know makes the whole cost not known
    t.core.storage.run('UPDATE calls SET cost_minor = NULL WHERE id = ?', out.callIds[0]);
    const again = t.core.modules.api('chat').costOf(out.callIds);
    assert.deepEqual(again, { minor: 0, currency: 'INR', known: false });   // the known part, and a plain 'not all known'
  } finally { await t.close(); }
});

test('a tool registered with an agents list is offered only to those agents', async () => {
  const seen = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => { if (/You plan how the desk answers/.test(String(b.messages[0].content))) return '{"needsFacts": false, "parts": []}'; seen.push((b.tools || []).map(x => x.function?.name || x.name)); return 'ok'; } });
  try {
    t.core.modules.tools.set('closer_only', { module: 'helper', name: 'closer_only', description: 'x', parameters: { type: 'object', properties: {} }, agents: ['closer'], async run() { return { ok: true }; } });
    t.core.modules.tools.set('for_all', { module: 'helper', name: 'for_all', description: 'y', parameters: { type: 'object', properties: {} }, agents: null, async run() { return { ok: true }; } });
    for (const id of ['closer', 'scout']) {
      await t.call(`/api/m/chat/chats/dm-${id}/send`, { body: { text: 'hello' } });
      const t0 = Date.now(); while (Date.now() - t0 < 5000 && (await t.call(`/api/m/chat/chats/dm-${id}/messages`)).json.chat.running) await new Promise(r => setTimeout(r, 30));
    }
    const [closer, scout] = seen.filter(x => x.includes('for_all'));
    assert.ok(closer.includes('closer_only')); assert.ok(!scout.includes('closer_only'));
  } finally { await t.close(); }
});
