// Plumbing tests for Agents and Skills (no model involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

const ADVISOR_IDS = ['ai-officer', 'product-lead', 'sales-lead', 'co-founder'];
const offTeam = async (t) => (await t.call('/api/m/agents/retired')).json.agents.filter(a => !ADVISOR_IDS.includes(a.id));

test('hire with a pack, skills and tools per agent, retire; owner only', async () => {
  const t = await testDesk({ modules: ['agents'] });
  try {
    const api = t.core.modules.api('agents');
    assert.ok(api.skillsFor('scout').some(s => s.id === 'cited-brief'));
    assert.ok(api.toolsFor('scout').includes('agent_update'));
    assert.equal((await t.call('/api/m/agents/hire', { body: { name: 'Mira' }, session: false })).status, 403);
    const h = await t.call('/api/m/agents/hire', { body: { name: 'Mira', pack: 'writer' } });
    assert.equal(h.json.id, 'mira'); assert.equal(h.json.role, 'Letters, replies and posts');
    assert.deepEqual(api.skillsFor('mira').map(s => s.id).sort(), ['customer-reply', 'email-reply-draft', 'meeting-notes']);
    await t.call('/api/m/agents/agents/mira/skills', { method: 'PUT', body: { on: ['explain-simply', 'nope'] } });
    assert.deepEqual(api.skillsFor('mira').map(s => s.id), ['explain-simply']);
    await t.call('/api/m/agents/agents/mira/tools', { method: 'PUT', body: { off: ['agent_update'] } });
    assert.ok(!api.toolsFor('mira').includes('agent_update'));
    const s = await t.call('/api/m/agents/skills', { body: { title: 'Supplier check', body: '1. Ask for three quotes.' } });
    assert.ok(s.json.id.startsWith('own-'));
    const d = await t.call('/api/m/agents/agents/mira');
    assert.ok(d.json.skills.some(x => x.id === s.json.id && !x.on)); assert.ok(d.json.tools.some(x => x.name === 'agent_update' && !x.on));
    assert.equal((await t.call('/api/m/agents/agents/coordinator', { method: 'DELETE' })).status, 409);
    assert.equal((await t.call('/api/m/agents/agents/mira', { method: 'DELETE' })).status, 200);
    assert.equal(t.core.agents.get('mira'), null);
  } finally { await t.close(); }
});

test('a retired built-in agent comes back in one click with its own settings, id, order and room', async () => {
  const t = await testDesk({ modules: ['agents', 'chat'] });
  try {
    const order = t.core.agents.list().map(a => a.id);
    await t.call('/api/agents/coder', { method: 'PATCH', body: { personality: 'Terse.', model: { main: { provider: 'router', model: 'x' } } } });
    await t.call('/api/m/agents/agents/coder/tools', { method: 'PUT', body: { off: ['agent_update'] } });
    const before = t.core.agents.get('coder');
    assert.equal((await offTeam(t)).length, 0);
    for (const id of ['coder', 'operator']) assert.equal((await t.call(`/api/m/agents/agents/${id}`, { method: 'DELETE' })).status, 200);
    await t.call('/api/m/chat/rooms/fit', { method: 'POST' });
    const roomIds = async () => (await t.call('/api/m/chat/chats')).json.chats.map(c => c.id);
    assert.ok(!(await roomIds()).includes('build-room'));
    const r = await offTeam(t);
    assert.deepEqual(r.map(a => a.id).sort(), ['coder', 'operator']);
    assert.equal(r.find(a => a.id === 'operator').role, 'Browser and long jobs');
    assert.equal((await t.call('/api/m/agents/retired/coder/hire', { body: {}, session: false })).status, 403);
    assert.equal((await t.call('/api/m/agents/retired/mira/hire', { body: {} })).status, 404);
    const back = await t.call('/api/m/agents/retired/coder/hire', { body: {} });
    assert.equal(back.status, 200); assert.equal(back.json.id, 'coder');
    const now = t.core.agents.get('coder');
    for (const k of ['name', 'role', 'personality', 'instructions', 'model', 'tools', 'created']) assert.deepEqual(now[k], before[k], k);
    assert.deepEqual(now.meta.toolsOff, ['agent_update']);
    assert.equal((await t.call('/api/m/agents/retired/operator/hire', { body: {} })).json.role, 'Browser and long jobs');
    assert.equal((await t.call('/api/m/agents/retired/operator/hire', { body: {} })).status, 409);
    await t.call('/api/m/chat/rooms/fit', { method: 'POST' });
    assert.ok((await roomIds()).includes('build-room'));
    assert.deepEqual(t.core.agents.list().map(a => a.id), order);
    assert.equal((await offTeam(t)).length, 0);
    // the Coordinator can never be retired, nor offered back
    assert.equal((await t.call('/api/m/agents/agents/coordinator', { method: 'DELETE' })).status, 409);
    assert.equal((await t.call('/api/agents/coordinator', { method: 'DELETE' })).status, 409);
    assert.ok(t.core.agents.get('coordinator'));
    assert.equal((await t.call('/api/m/agents/retired/coordinator/hire', { body: {} })).status, 404);
  } finally { await t.close(); }
});

test('four advisor roles wait under "Not on your team"; one click hires one, with its steps; nothing runs', async () => {
  const t = await testDesk({ modules: ['agents'] });
  try {
    const ids = ['ai-officer', 'product-lead', 'sales-lead', 'co-founder'];
    const off = (await t.call('/api/m/agents/retired')).json.agents;
    assert.deepEqual(off.map(a => a.id).sort(), [...ids].sort());
    assert.deepEqual(off.map(a => a.name).sort(), ['AI officer', 'Co-founder', 'Product lead', 'Sales lead']);
    for (const id of ids) assert.equal(t.core.agents.get(id), null, id + ' is not hired by default');
    assert.ok(off.every(a => a.role && a.role.length < 80));
    const cat = t.core.modules.api('agents').catalog();
    const defaults = JSON.parse((await import('node:fs')).readFileSync(new URL('./skills.json', import.meta.url), 'utf8')).defaults;
    for (const id of ids) {
      assert.ok(defaults[id].length >= 2 && defaults[id].length <= 4, id);
      for (const sid of defaults[id]) { const s = cat.skills.find(x => x.id === sid); assert.ok(s, sid); assert.match(s.body, /## Steps/); assert.doesNotMatch(s.body, /\b(run|execute|install)\b.*\b(script|command)\b/i); }
    }
    assert.equal((await t.call('/api/m/agents/retired/sales-lead/hire', { body: {}, session: false })).status, 403);
    const h = await t.call('/api/m/agents/retired/sales-lead/hire', { body: {} });
    assert.equal(h.status, 200); assert.equal(h.json.id, 'sales-lead');
    assert.deepEqual(t.core.modules.api('agents').skillsFor('sales-lead').map(s => s.id), defaults['sales-lead']);
    assert.equal((await t.call('/api/m/agents/retired')).json.agents.length, 3);
    assert.equal((await t.call('/api/m/agents/agents/sales-lead', { method: 'DELETE' })).status, 200);
    assert.ok((await t.call('/api/m/agents/retired')).json.agents.some(a => a.id === 'sales-lead'), 'retired advisors come back to the list');
  } finally { await t.close(); }
});
