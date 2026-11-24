// The owner's customer records are in this desk's CRM: every agent is told so, the agent with the CRM tools is offered them,
// and a group summary is told which work the tools did. Plumbing against the fake model: the model still chooses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { CRM_LINE } from './coordinator.js';

const settle = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const r = await t.call(`/api/m/chat/chats/${chatId}/messages`); if (!r.json.chat.running && !r.json.messages.some(m => m.status === 'streaming')) return r.json.messages; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('did not settle');
};
const crm = (t, ran) => {
  for (const name of ['crm_find', 'crm_contact_save']) t.core.modules.tools.set(name, { module: 'sales', name, description: name, parameters: { type: 'object', properties: {} }, async run() { ran.push(name); return { ok: true, text: name === 'crm_find' ? 'Found 2 deals.' : 'Saved the contact Sunita Rao.' }; } });
};

test('the agent with the CRM tools is offered them and told the records are in this desk', async () => {
  const seen = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    const sys = String(b.messages[0].content);
    if (/You plan how the desk answers/.test(sys)) return '{"needsFacts": false, "parts": []}';
    seen.push({ sys, tools: (b.tools || []).map(x => x.function?.name || x.name) }); return 'ok';
  } });
  try {
    const ran = []; crm(t, ran);
    await t.call('/api/m/chat/chats/dm-closer/send', { body: { text: 'Which deals in my CRM close this month?' } }); await settle(t, 'dm-closer');
    const c = seen.at(-1);
    assert.ok(c.tools.includes('crm_find')); assert.ok(c.sys.includes(CRM_LINE)); assert.match(c.sys, /only with your crm tools/);
    await t.call('/api/m/chat/chats/dm-coder/send', { body: { text: 'Add Sunita Rao to my CRM' } }); await settle(t, 'dm-coder');
    assert.ok(seen.at(-1).sys.includes(CRM_LINE), 'in its own chat the Coder is told too');
  } finally { await t.close(); }
});

test('in a group the agent without the CRM tools is told who has them; the summary is told what the tools did', async () => {
  let sumUser = ''; let coderSys = '';
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    const sys = String(b.messages[0].content);
    if (/You plan how the desk answers/.test(sys)) return '{"needsFacts": false, "parts": []}';
    if (/GO or PASS/.test(sys)) return /^You are the (?:Sales expert|Coder)/.test(sys) ? 'GO' : 'PASS';
    if (/^You are the Coder/.test(sys)) { coderSys = sys; return 'From my side: nothing to build.'; }
    if (/You sum up a group chat turn/.test(sys)) { sumUser = String(b.messages.at(-1).content); return 'Sales expert: saved her.\nNext: add her deal.'; }
    if (b.messages.at(-1).role === 'tool') return 'Saved Sunita Rao as a contact.';
    if (/^You are the Sales expert/.test(sys)) return { toolCalls: [{ name: 'crm_contact_save', args: {} }] };
    return 'Here is my part.';
  } });
  try {
    const ran = []; crm(t, ran);
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: 'Add Sunita Rao to my CRM' } }); await settle(t, 'everyone');
    assert.deepEqual(ran, ['crm_contact_save']);
    assert.ok(coderSys.includes(CRM_LINE)); assert.match(coderSys, /The Sales expert reads and changes them with its CRM tools; you do not make files for them or ask for a login/);
    assert.match(sumUser, /What the agents' tools did in this turn/); assert.match(sumUser, /Saved the contact Sunita Rao/);
  } finally { await t.close(); }
});
