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
