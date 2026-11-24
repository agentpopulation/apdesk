// The agents' core prompt names an agent by its role and, if the owner gave one, its own name; never by an old code name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';
import { CORE_ROLES } from '../app/core/agents.js';
import { BUILT_IN_ROLES, ADVISOR_ROLES, HIRE_ROLES, roleOf, ownName } from '../modules/agents/ui-roles.js';

test('a built-in agent with no own name is told its role only', async () => {
  const t = await testDesk();
  try {
    const p = t.core.agents.systemPrompt('scout');
    assert.match(p, /^You are the Researcher on the owner's team\./);
    assert.doesNotMatch(p, /\bScout\b/);
    const m = t.core.agents.systemPrompt('coordinator');
    assert.match(m, /^You are the Manager on the owner's team\./);
    assert.doesNotMatch(m, /Coordinator/, 'the old seed words are not given either');
  } finally { await t.close(); }
});

test('an own name is given beside the role; a hired role by its role words', async () => {
  const t = await testDesk();
  try {
    t.core.agents.update('scout', { name: 'Kent' });
    assert.match(t.core.agents.systemPrompt('scout'), /^You are the Researcher on the owner's team; he calls you Kent\./);
    t.core.agents.create({ id: 'sec-1', name: 'Secretary', role: 'Calendar and reminders', meta: { roleId: 'secretary' } });
    assert.match(t.core.agents.systemPrompt('sec-1'), /^You are the Secretary on the owner's team\.\nYour job: Calendar and reminders\./);
    t.core.agents.create({ id: 'mine', name: 'Hugo', role: 'Keeps my shelves in order' });
    assert.match(t.core.agents.systemPrompt('mine'), /^You are Hugo, an agent on the owner's team\./);
  } finally { await t.close(); }
});

test('the core copy of the role words matches the agents module', () => {
  for (const [id, role] of Object.entries({ ...BUILT_IN_ROLES, ...ADVISOR_ROLES })) assert.equal(CORE_ROLES.roleOf({ id }), role, id);
  for (const r of HIRE_ROLES) assert.equal(CORE_ROLES.roleOf({ id: 'x', meta: { roleId: r.id } }), r.label, r.id);
  for (const a of [{ id: 'scout', name: 'Scout' }, { id: 'scout', name: 'Kent' }, { id: 'x', meta: { pack: 'office' }, name: 'Secretary' }, { id: 'co-founder', name: 'Co-founder' }]) {
    assert.equal(CORE_ROLES.roleOf(a), roleOf(a)); assert.equal(CORE_ROLES.ownName(a), ownName(a));
  }
});
