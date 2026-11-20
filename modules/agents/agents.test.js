// Plumbing tests for Agents and Skills (no model involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

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
    assert.equal((await t.call('/api/m/agents/retired')).json.agents.length, 0);
    for (const id of ['coder', 'operator']) assert.equal((await t.call(`/api/m/agents/agents/${id}`, { method: 'DELETE' })).status, 200);
    await t.call('/api/m/chat/rooms/fit', { method: 'POST' });
    const roomIds = async () => (await t.call('/api/m/chat/chats')).json.chats.map(c => c.id);
    assert.ok(!(await roomIds()).includes('build-room'));
    const r = (await t.call('/api/m/agents/retired')).json.agents;
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
    assert.equal((await t.call('/api/m/agents/retired')).json.agents.length, 0);
    // the Coordinator can never be retired, nor offered back
    assert.equal((await t.call('/api/m/agents/agents/coordinator', { method: 'DELETE' })).status, 409);
    assert.equal((await t.call('/api/agents/coordinator', { method: 'DELETE' })).status, 409);
    assert.ok(t.core.agents.get('coordinator'));
    assert.equal((await t.call('/api/m/agents/retired/coordinator/hire', { body: {} })).status, 404);
  } finally { await t.close(); }
});
