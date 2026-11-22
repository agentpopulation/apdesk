// The agent record's avatar: a drawn look or letters, on a colour, both checked against the set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';
import { AVATARS, COLOURS, avatarValue, defaultAvatar } from '../modules/agents/ui-avatars.js';

test('the avatar set: about two dozen drawings, colours, and a checked value', () => {
  assert.ok(AVATARS.length >= 24, `${AVATARS.length} drawings`);
  assert.equal(new Set(AVATARS.map(a => a.id)).size, AVATARS.length);
  for (const a of AVATARS) assert.ok(!/<script|on\w+=|href|<text/i.test(a.art), a.id + ' is shapes only');
  assert.ok(COLOURS.length >= 6);
  assert.deepEqual(avatarValue({ look: 'owl', colour: 'teal' }), { look: 'owl', colour: 'teal' });
  assert.deepEqual(avatarValue({ look: 'letter', colour: 'pink' }), { look: 'letter', colour: 'pink' });
  for (const bad of [null, 'owl', { look: 'owl' }, { look: 'unicorn', colour: 'teal' }, { look: 'owl', colour: '#f00' }]) assert.equal(avatarValue(bad), null);
  assert.deepEqual(defaultAvatar('scout'), defaultAvatar('scout'));
  assert.equal(defaultAvatar('scout').look, 'letter');
});

test('an agent keeps its avatar; a choice outside the set is refused with a plain reason', async () => {
  const t = await testDesk();
  try {
    assert.equal(t.core.agents.get('scout').avatar, null, 'no choice yet');
    const r = await t.call('/api/agents/scout', { method: 'PATCH', body: { avatar: { look: 'owl', colour: 'teal' } } });
    assert.equal(r.status, 200); assert.deepEqual(r.json.avatar, { look: 'owl', colour: 'teal' });
    assert.deepEqual(t.core.agents.get('scout').avatar, { look: 'owl', colour: 'teal' });
    assert.equal(t.core.agents.get('scout').name, 'Scout', 'nothing else changed');
    const bad = await t.call('/api/agents/scout', { method: 'PATCH', body: { avatar: { look: 'unicorn', colour: 'teal' } } });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /avatar/i);
    assert.deepEqual(t.core.agents.get('scout').avatar, { look: 'owl', colour: 'teal' });
    t.core.agents.update('scout', { meta: { skills: ['cited-brief'] } });
    assert.deepEqual(t.core.agents.get('scout').avatar, { look: 'owl', colour: 'teal' }, 'other meta changes keep it');
    assert.equal((await t.call('/api/agents/scout', { method: 'PATCH', body: { avatar: null } })).json.avatar, null, 'null goes back to letters');
  } finally { await t.close(); }
});
