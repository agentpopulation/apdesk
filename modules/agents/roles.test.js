// Roles are the identity, the name is the owner's choice: the one display line, hires with and without a name, the
// "Give me a name" button in the hello note, desks that still carry the old default names, and a role whose module is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testDesk } from '../../test/helpers/desk.js';
import { agentLine, roleOf, ownName, HIRE_ROLES, suggestName, BUILT_IN_ROLES } from './ui-roles.js';
import { roleWelcome } from './advisors.js';

test('the display line: own name and role, the role alone, never an old default name', () => {
  assert.equal(agentLine({ id: 'scout', name: 'Scout' }), 'Researcher');
  assert.equal(agentLine({ id: 'coordinator', name: 'Coordinator' }), 'Manager');
  assert.equal(agentLine({ id: 'closer', name: 'Closer' }), 'Sales expert');
  assert.equal(agentLine({ id: 'operator', name: 'operator' }), 'Operations expert');
  assert.equal(agentLine({ id: 'coder', name: 'Coder' }), 'Coder');
  assert.equal(agentLine({ id: 'coder', name: 'Hugo' }), 'Hugo · Coder');
  assert.equal(agentLine({ id: 'secretary', name: 'Kent', meta: { roleId: 'secretary' } }), 'Kent · Secretary');
  assert.equal(agentLine({ id: 'secretary-2', name: 'Secretary', meta: { roleId: 'secretary' } }), 'Secretary');
  assert.equal(agentLine({ id: 'co-founder', name: 'Co-founder' }), 'AI Co-founder');
  assert.equal(agentLine({ id: 'sales-lead', name: 'Sales lead' }), 'Sales expert');
  assert.equal(agentLine({ id: 'mira', name: 'Mira', meta: { pack: 'writer' } }), 'Mira · Writer');
  assert.equal(agentLine({ id: 'mira', name: 'Mira', meta: {} }), 'Mira', 'his own agent with his own role words shows its name');
  assert.equal(agentLine(null), 'An agent'); assert.equal(agentLine({ id: 'x' }), 'An agent');
  assert.equal(ownName({ id: 'scout', name: 'Scout' }), ''); assert.equal(roleOf({ id: 'scout' }), 'Researcher');
  for (const v of Object.values(BUILT_IN_ROLES)) assert.doesNotMatch(v, /Coordinator|Scout|Closer|Operator/);
});

test('every hire role has a role line, three skills it is good at, three starters, tools, a look and its own note', () => {
  const skills = JSON.parse(fs.readFileSync(new URL('./skills.json', import.meta.url), 'utf8')).skills;
  const titles = Object.fromEntries(skills.map(s => [s.id, s.title]));
  const labels = HIRE_ROLES.map(r => r.label);
  for (const want of ['AI Co-founder', 'Finance expert', 'Marketing expert', 'Product expert', 'AI expert', 'Secretary', 'Writer', 'Customer care expert', 'Recruiter', 'Data analyst']) assert.ok(labels.includes(want), want);
  const notes = new Set();
  for (const r of HIRE_ROLES) {
    assert.ok(r.line && r.line.length < 70, r.id);
    assert.equal(r.skills.length, 3, r.id); for (const s of r.skills) assert.ok(titles[s], `${r.id}: skill ${s} exists`);
    assert.equal(r.starters.length, 3, r.id); assert.ok(r.tools.length >= 2, r.id);
    assert.ok(r.avatar?.look && r.avatar?.colour, r.id);
    const n = roleWelcome(r.id, titles) || null;
    if (n) { assert.match(n, /^Glad to join your team/); for (const s of r.skills) assert.ok(n.includes(titles[s]), `${r.id} note names ${titles[s]}`); notes.add(n); }
  }
  assert.equal(notes.size, HIRE_ROLES.length - 3, 'the three advisor roles keep their own notes; the rest each have one');
  assert.equal(suggestName(['Asha', 'leo']), 'Mina');
});

test('hire by role with a name and without one; the hello note offers "Give me a name" only when it has none', async () => {
  const t = await testDesk({ modules: ['agents', 'chat'], script: () => { throw new Error('no model call for a hire'); } });
  try {
    t.core.settings.set('router.enabled', true); t.core.settings.set('router.model', 'auto');
    assert.equal((await t.call('/api/m/agents/hire', { body: { roleId: 'writer', name: 'Kent' }, session: false })).status, 403);
    const named = await t.call('/api/m/agents/hire', { body: { roleId: 'writer', name: 'Kent' } });
    assert.equal(named.status, 200); assert.equal(named.json.id, 'writer'); assert.equal(named.json.name, 'Kent'); assert.equal(named.json.line, 'Kent · Writer');
    assert.equal(named.json.meta.roleId, 'writer'); assert.deepEqual(named.json.meta.skills, HIRE_ROLES.find(r => r.id === 'writer').skills);
    assert.deepEqual(named.json.avatar, HIRE_ROLES.find(r => r.id === 'writer').avatar);
    assert.match(named.json.message, /^Kent joined\. Model: Free API \(auto\)\.$/); assert.match(named.json.detail, /^Kent · Writer joined your team\./);
    const long = await t.call('/api/m/agents/hire', { body: { roleId: 'customer-care', name: 'Kristina-Maria' } }); assert.ok(long.json.message.length <= 52, long.json.message); assert.ok(named.json.message.length <= 52);
    let msgs = (await t.call('/api/m/chat/chats/dm-writer/messages')).json.messages;
    assert.equal(msgs.length, 1); assert.match(msgs[0].text, /^Glad to join your team\. As your Writer/); assert.deepEqual(msgs[0].cards, [], 'a named agent gets no name button');
    const plain = await t.call('/api/m/agents/hire', { body: { roleId: 'writer' } });
    assert.equal(plain.json.id, 'writer-2'); assert.equal(plain.json.name, 'Writer', 'the name column holds the role'); assert.equal(plain.json.line, 'Writer');
    msgs = (await t.call('/api/m/chat/chats/dm-writer-2/messages')).json.messages;
    assert.equal(msgs[0].cards[0].actions[0].label, 'Give me a name'); assert.equal(msgs[0].cards[0].actions[0].nameAgent, 'writer-2');
    // the button saves a name the usual way; from then on both show
    await t.call('/api/agents/writer-2', { method: 'PATCH', body: { name: 'Hugo' } });
    assert.equal(t.core.modules.api('agents').agentLine('writer-2'), 'Hugo · Writer');
    // an advisor role from the hire box takes its own id and its own note
    const cf = await t.call('/api/m/agents/hire', { body: { roleId: 'co-founder', name: '' } });
    assert.equal(cf.json.id, 'co-founder'); assert.equal(cf.json.line, 'AI Co-founder'); assert.equal(cf.json.noted, true);
    assert.equal((await t.call('/api/m/agents/hire', { body: { roleId: 'nope' } })).status, 400);
    assert.doesNotMatch(JSON.stringify([named.json.message, plain.json.message, cf.json.message]), /null|undefined|NaN/);
  } finally { await t.close(); }
});

test('a role whose module is off says which module to switch on, and is hired once it is on', async () => {
  const t = await testDesk({ modules: ['agents', 'chat', 'calendar'] });
  try {
    const cat = (await t.call('/api/m/agents/catalog')).json.roles;
    const sec = cat.find(r => r.id === 'secretary');
    assert.equal(sec.module, 'calendar'); assert.match(sec.blocked, /^Switch on Calendar in Settings › Modules first\./);
    assert.equal(cat.find(r => r.id === 'writer').blocked, null);
    const r = await t.call('/api/m/agents/hire', { body: { roleId: 'secretary', name: 'Kent' } });
    assert.equal(r.status, 409); assert.match(r.json.error, /Switch on Calendar/); assert.equal(t.core.agents.get('secretary'), null);
    await t.core.modules.set('calendar', true);
    const ok = await t.call('/api/m/agents/hire', { body: { roleId: 'secretary', name: 'Kent' } });
    assert.equal(ok.status, 200); assert.equal(ok.json.line, 'Kent · Secretary');
  } finally { await t.close(); }
});

test('a desk from before roles: old default names show as the new role, a name the owner gave stays beside it, nothing is lost', async () => {
  const t = await testDesk({ modules: ['agents'] });
  try {
    const api = t.core.modules.api('agents');
    // the seed still stores the old names (the released code's data): they read as no own name
    assert.equal(t.core.agents.get('scout').name, 'Scout');
    assert.deepEqual(['coordinator', 'scout', 'closer', 'operator', 'coder'].map(id => api.agentLine(id)), ['Manager', 'Researcher', 'Sales expert', 'Operations expert', 'Coder']);
    await t.call('/api/agents/closer', { method: 'PATCH', body: { name: 'Kent' } });
    assert.equal(api.agentLine('closer'), 'Kent · Sales expert');
    assert.deepEqual(api.display('closer'), { role: 'Sales expert', name: 'Kent', line: 'Kent · Sales expert' });
    assert.deepEqual(api.display('scout'), { role: 'Researcher', name: '', line: 'Researcher' });
    const before = t.core.agents.get('scout');
    assert.equal(api.agentLine('scout'), 'Researcher');
    assert.deepEqual(t.core.agents.get('scout'), before, 'reading the line changes no data');
    // a retired built-in is listed by its role
    await t.call('/api/m/agents/agents/operator', { method: 'DELETE' });
    const off = (await t.call('/api/m/agents/retired')).json.agents;
    assert.deepEqual(off.map(a => [a.id, a.line]), [['operator', 'Operations expert']]);
    assert.match((await t.call('/api/m/agents/agents/coordinator', { method: 'DELETE' })).json.error, /^The Manager stays/);
  } finally { await t.close(); }
});

test('the agent page shows every agent tab a module that is on declares, after the built-in tabs, in manifest order', async () => {
  const { tabsFor } = await import('./ui.js');
  const mods = [
    { id: 'agents', agentTabs: ['profile', 'tools'] }, { id: 'models', agentTabs: ['model'] }, { id: 'memory', agentTabs: ['memory'] },
    { id: 'scorecard', agentTabs: ['scorecard'] }, { id: 'browser', agentTabs: ['computer'] }, { id: 'extra', agentTabs: ['notes', 'scorecard'] },
  ];
  const on = new Set(['agents', 'models', 'memory', 'scorecard', 'browser', 'extra']);
  assert.deepEqual(tabsFor(mods, id => on.has(id)).map(t => t[0]), ['profile', 'model', 'tools', 'memory', 'computer', 'scorecard', 'notes']);
  on.delete('scorecard'); on.delete('browser');
  assert.deepEqual(tabsFor(mods, id => on.has(id)).map(t => t[0]), ['profile', 'model', 'tools', 'memory', 'notes', 'scorecard'], 'a tab shows only while its module is on; the next module that declares it then owns it');
  assert.equal(tabsFor(mods, id => on.has(id)).find(t => t[0] === 'notes')[2], 'extra');
});

test('POST /skills strips hidden characters on the server and refuses in Incognito; the display name is exposed to other modules', async () => {
  const t = await testDesk({ modules: ['agents'] });
  try {
    const hidden = 'Tidy​ up‮ the\u0007 list󠁁';
    const r = await t.call('/api/m/agents/skills', { body: { title: hidden, body: 'Step one​.\nStep two﻿.', description: 'Quiet⁢ words' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.title, 'Tidy up the list'); assert.equal(r.json.body, 'Step one.\nStep two.'); assert.equal(r.json.description, 'Quiet words');
    t.core.incognito = true;
    const no = await t.call('/api/m/agents/skills', { body: { title: 'Another', body: 'Steps.' } });
    t.core.incognito = false;
    assert.equal(no.status, 403); assert.match(no.json.error, /^Skills are not added in Incognito\./);
    const api = t.core.modules.api('agents');
    assert.equal(api.displayName('scout'), 'Researcher'); assert.equal(api.displayName('coordinator'), 'Manager'); assert.equal(api.roleOf('closer'), 'Sales expert');
    t.core.agents.update('scout', { name: 'Kent' });
    assert.equal(api.displayName('scout'), 'Kent · Researcher'); assert.deepEqual(api.display('scout'), { role: 'Researcher', name: 'Kent', line: 'Kent · Researcher' });
  } finally { await t.close(); }
});
