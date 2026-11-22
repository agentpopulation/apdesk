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
    assert.match(h.json.message, /^Mira is hired\. (Model: .+|Choose a model in Models)\.$/);
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
    await t.call('/api/agents/coder', { method: 'PATCH', body: { personality: 'Terse.', model: { main: { provider: 'router', model: 'x' } }, avatar: { look: 'owl', colour: 'teal' } } });
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
    assert.deepEqual(r.find(a => a.id === 'coder').avatar, { look: 'owl', colour: 'teal' });   // off the team, it keeps its look
    assert.equal(r.find(a => a.id === 'operator').avatar, null);
    assert.equal((await t.call('/api/m/agents/retired/coder/hire', { body: {}, session: false })).status, 403);
    assert.equal((await t.call('/api/m/agents/retired/mira/hire', { body: {} })).status, 404);
    const back = await t.call('/api/m/agents/retired/coder/hire', { body: {} });
    assert.equal(back.status, 200); assert.equal(back.json.id, 'coder');
    const now = t.core.agents.get('coder');
    for (const k of ['name', 'role', 'personality', 'instructions', 'model', 'tools', 'created', 'avatar']) assert.deepEqual(now[k], before[k], k);
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

test('a first hire says the agent joined the team; a hire after retiring says it is back', async () => {
  const t = await testDesk({ modules: ['agents'] });
  try {
    const first = await t.call('/api/m/agents/retired/ai-officer/hire', { body: {} });
    assert.equal(first.status, 200); assert.match(first.json.message, /^AI officer joined\. Model: /);
    assert.equal((await t.call('/api/m/agents/agents/ai-officer', { method: 'DELETE' })).status, 200);
    const again = await t.call('/api/m/agents/retired/ai-officer/hire', { body: {} });
    assert.match(again.json.message, /^AI officer is back\. Model: /);
  } finally { await t.close(); }
});

test('a hire names the model the agent answers with, from the desk default route', async () => {
  const t = await testDesk({ modules: ['agents', 'chat'] });
  try {
    t.core.settings.set('router.enabled', true); t.core.settings.set('router.model', 'auto');
    const r = await t.call('/api/m/agents/retired/co-founder/hire', { body: {} });
    assert.equal(r.status, 200);
    const first = t.core.model.resolve('co-founder').chain[0];
    assert.equal(first.provider, 'router', 'the desk default route answers first');
    assert.equal(r.json.message, 'Co-founder joined. Model: Free API (auto).');
    assert.equal(r.json.detail, 'Co-founder joined your team. It will answer with the Free API (auto) until you choose another model. It left you a note in its chat.');
    assert.equal(r.json.uses, undefined, 'no internal field in the answer');
    assert.equal(r.json.model, 'Free API (auto)');
    // a re-hire keeps the model it had, and says so
    await t.call('/api/agents/co-founder', { method: 'PATCH', body: { model: { main: { provider: 'ollama', model: 'qwen3:4b' } } } });
    await t.call('/api/m/agents/agents/co-founder', { method: 'DELETE' });
    const back = await t.call('/api/m/agents/retired/co-founder/hire', { body: {} });
    assert.equal(back.json.message, 'Co-founder is back. Model: Ollama (qwen3:4b).');
  } finally { await t.close(); }
});

test('every hire message fits the one-line toast (about 56 characters at 390 px), model name included', async () => {
  const t = await testDesk({ modules: ['agents', 'chat'] });
  try {
    t.core.settings.set('router.enabled', true); t.core.settings.set('router.model', 'auto');
    for (const id of [...ADVISOR_IDS, 'scout', 'closer', 'operator', 'coder']) {
      if (!t.core.agents.get(id)) { const r = await t.call(`/api/m/agents/retired/${id}/hire`, { body: {} }); assert.ok(r.json.message.length <= 52, r.json.message); assert.match(r.json.message, /Free API \(auto\)/); }
      await t.call('/api/m/agents/agents/' + id, { method: 'DELETE' });
      const back = await t.call(`/api/m/agents/retired/${id}/hire`, { body: {} });
      assert.ok(back.json.message.length <= 52, back.json.message); assert.match(back.json.message, /Free API \(auto\)/);
    }
    const h = await t.call('/api/m/agents/hire', { body: { name: 'Mira', pack: 'writer' } });
    assert.ok(h.json.message.length <= 52, h.json.message); assert.match(h.json.message, /Free API \(auto\)/);
  } finally { await t.close(); }
});

test('a first hire posts a welcome note for its role in its own chat, written by code; a re-hire posts none', async () => {
  const t = await testDesk({ modules: ['agents', 'chat'], script: () => { throw new Error('no model call for a welcome note'); } });
  try {
    t.core.settings.set('router.enabled', true); t.core.settings.set('router.model', 'auto');
    const { WELCOME } = await import('./advisors.js');
    const defaults = JSON.parse((await import('node:fs')).readFileSync(new URL('./skills.json', import.meta.url), 'utf8'));
    const notes = [];
    for (const id of ADVISOR_IDS) {
      const r = await t.call(`/api/m/agents/retired/${id}/hire`, { body: {} });
      assert.equal(r.json.noted, true, id);
      const msgs = (await t.call(`/api/m/chat/chats/dm-${id}/messages`)).json.messages;
      assert.equal(msgs.length, 1, id); assert.equal(msgs[0].agentId, id); assert.equal(msgs[0].role, 'assistant');
      const text = msgs[0].text; notes.push(text);
      // the cause of the model name never reaching the owner: the toast is one line, so the full model sentence lives in the note
      const [open, ...rest] = WELCOME[id].split('\n\n');
      assert.equal(text, [open, `I will answer with the Free API (auto) until you choose another model on my page.`, ...rest].join('\n\n'));
      assert.match(text, /^Glad to join your team/);
      for (const sid of defaults.defaults[id]) { const title = defaults.skills.find(s => s.id === sid).title; assert.ok(text.includes(title), `${id} names its skill ${title}`); }
      assert.match(text, /Attach/); assert.match(text, /just tell me here\.$/);
      assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}]|\*\*/u, 'no emoji, no bold');
    }
    assert.equal(new Set(notes).size, notes.length, 'not the same note for every role');
    assert.match(WELCOME['co-founder'], /spreadsheet/); assert.match(WELCOME['co-founder'], /deck/); assert.match(WELCOME['co-founder'], /competition/);
    // every built-in role has its own note
    for (const id of ['scout', 'closer', 'operator', 'coder']) {
      assert.ok(WELCOME[id] && WELCOME[id].startsWith('Glad to join your team'), id);
      for (const sid of defaults.defaults[id]) { const title = defaults.skills.find(s => s.id === sid).title; assert.ok(WELCOME[id].includes(title), `${id} names its skill ${title}`); }
    }
    assert.equal(new Set(Object.values(WELCOME)).size, Object.keys(WELCOME).length);
    await t.call('/api/m/agents/agents/co-founder', { method: 'DELETE' });
    const back = await t.call('/api/m/agents/retired/co-founder/hire', { body: {} });
    assert.equal(back.json.noted, false);
    assert.equal((await t.call('/api/m/chat/chats/dm-co-founder/messages')).json.messages.length, 1, 'no second note');
  } finally { await t.close(); }
});

test('every drawn avatar has eyes that can blink, or a motion hook; states are a closed set', async () => {
  const { AVATARS, STATES } = await import('./ui-avatars.js');
  for (const a of AVATARS) {
    const eyed = a.art.includes('class="ey"');
    assert.ok(eyed ? a.art.includes('class="pu"') : true, a.id + ': a blinking eye can also move its pupil');
    assert.ok(!/<script|on\w+=|href|<text|<animate|<set /i.test(a.art), a.id + ' has no script and no SMIL timers');
  }
  assert.deepEqual([...STATES].sort(), ['failed', 'idle', 'waiting', 'working']);
  assert.ok(AVATARS.filter(a => !a.art.includes('class="ey"')).every(a => /class="(tw|nd)"/.test(a.art) || ['planet', 'rocket', 'leaf'].includes(a.id)), 'eyeless drawings sway or twinkle');
});
