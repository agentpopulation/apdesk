// A reply may say a record was added, changed or removed (a contact, a company, a deal, a lead, a task, a note, a customer)
// only when a tool step in that turn did it and succeeded. Checks on the desk's own output, with the fake model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { claimWithoutWork, recordClaim } from './coordinator.js';

const done = (tool, extra = {}) => ({ tool, status: 'done', result: { ok: true }, ...extra });
const failed = (tool) => ({ tool, status: 'failed', error: 'did not work' });

test('a claim that a record was saved needs a successful write step for that kind of record', () => {
  const claims = [
    'Added Sunita Rao and her deal to the CRM.',
    'I have added Sunita Rao as a contact.',
    'Both agree the contact and deal were created correctly.',
    'The deal "Rao Exports annual order" has been saved.',
    'Contact added: Sunita Rao.',
    'I created a new company, Rao Exports.',
    'I updated the customer record with her phone.',
    'I removed the old task.',
    'Sunita Rao is now in your CRM.',
  ];
  for (const c of claims) assert.ok(claimWithoutWork(c, []), c);
  // a lead tool backs a lead, never a contact or a deal
  assert.equal(claimWithoutWork('I added Rao Exports as a lead.', [done('lead_add')]), null);
  assert.equal(claimWithoutWork('Added Sunita Rao and her deal.', [done('lead_add')]), 'a deal');
  assert.equal(claimWithoutWork('I have added Sunita Rao as a contact.', [done('lead_add')]), 'a contact');
  // the tool that does it, and succeeded
  assert.equal(claimWithoutWork('I have added Sunita Rao as a contact.', [done('crm_contact_add')]), null);
  assert.equal(claimWithoutWork('The deal has been saved.', [done('deal_add')]), null);
  assert.equal(claimWithoutWork('The deal has been saved.', [failed('deal_add')]), 'a deal');
  assert.equal(claimWithoutWork('I created the task.', [done('task_create')]), null);
  // a CRM tool for one kind of record backs that kind only; one that names no kind backs any
  assert.equal(claimWithoutWork('I added the contact.', [done('crm_company_save')]), 'a contact');
  assert.equal(claimWithoutWork('I added the contact and the deal.', [done('crm_contact_save'), done('crm_deal_save')]), null);
  assert.equal(claimWithoutWork('I added a note about her.', [done('crm_note_add')]), null);
  assert.equal(claimWithoutWork('I saved the contact.', [done('crm_save')]), null);
  assert.equal(claimWithoutWork('I added the contact.', [done('crm_find')]), 'a contact');
  // a read is not a write; a tool that made nothing made nothing
  assert.equal(claimWithoutWork('I added the contact.', [done('contact_list')]), 'a contact');
  assert.equal(claimWithoutWork('I added the contact.', [done('contact_add', { made: 0 })]), 'a contact');
  // reporting records a read step gave is not a claim of this turn's work
  assert.equal(claimWithoutWork('Three contacts were added this week.', [done('contact_list')]), null);
});

test('plain answers about records are not claims', () => {
  for (const t of [
    'I could not add the contact: there is no tool for it here.',
    'I did not save the deal.',
    'To add a contact, open the CRM and press Add.',
    'Would you like me to add a deal for Rao Exports?',
    'Your deals: Rao Exports annual order, closing 28 November.',
    'The company sells spices.',
    'I saved your changes to notes.md.',
    'I wrote the list to crm/contacts-export.csv.',
  ]) assert.equal(claimWithoutWork(t, []), null, t);
});

test('recordClaim says which record a claim is about and why it was not done', () => {
  assert.deepEqual(recordClaim('I added the deal and the contact.', []), { noun: 'deal', nouns: ['deal'], what: 'a deal' });
  assert.deepEqual(recordClaim('The contact and the deal were created.', []).nouns, ['contact', 'deal']);
  assert.equal(recordClaim('Nothing here.', []), null);
});

const addTool = (t, name, run) => t.core.modules.tools.set(name, { module: 'sales', name, description: `Test tool ${name}`, parameters: { type: 'object', properties: { name: { type: 'string' } } }, run });
const waitReply = async (t, chatId, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    const last = r.json.messages.filter(m => m.role === 'assistant').at(-1);
    if (last && last.status !== 'streaming' && !r.json.chat.running) return { last, all: r.json.messages };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no reply');
};
const ASK = "Add a contact to my CRM: Sunita Rao, sunita@raoexports.example.in, +91 98450 12345, Rao Exports. Then add a deal 'Rao Exports annual order' worth 350000 rupees, closing 28 November 2026, linked to her.";

test('a turn whose model says a contact and a deal were saved, when only a lead tool ran, ends saying plainly what was not saved and why', async () => {
  const ran = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    if (b.messages.some(m => m.role === 'tool')) return 'Added Sunita Rao and her deal. The contact and the deal were created correctly.';
    if (/ONE JSON object/.test(b.messages[0].content)) return JSON.stringify({ answer: 'Done: the contact and the deal were created and saved.' });
    return (b.tools || []).some(x => x.function.name === 'lead_add') ? { toolCalls: [{ name: 'lead_add', args: { name: 'Rao Exports' } }] } : 'Added it.';
  } });
  try {
    addTool(t, 'lead_add', async (a) => { ran.push(a); return { ok: true, text: 'Lead added: Rao Exports' }; });
    await t.call('/api/m/chat/chats/dm-closer/send', { body: { text: ASK } });
    const { last } = await waitReply(t, 'dm-closer');
    assert.equal(ran.length, 1);
    assert.doesNotMatch(last.text, /were created|Added Sunita/);
    assert.match(last.text, /not saved/i);
    assert.match(last.text, /no tool/i);
    assert.match(last.text, /lead/i, 'what did happen is said');
    assert.match(last.text, /The contact was not saved/); assert.match(last.text, /The deal was not saved/);
    assert.ok(last.meta.blocked);
  } finally { await t.close(); }
});

test('a failed record tool: the reply says the tool did not work, never that the record was saved', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    if (b.messages.some(m => m.role === 'tool') || /ONE JSON object/.test(b.messages[0].content)) return /ONE JSON object/.test(b.messages[0].content) ? JSON.stringify({ answer: 'The contact has been saved.' }) : 'The contact has been saved.';
    return { toolCalls: [{ name: 'contact_add', args: { name: 'Sunita Rao' } }] };
  } });
  try {
    addTool(t, 'contact_add', async () => ({ ok: false, error: 'The CRM is switched off.' }));
    await t.call('/api/m/chat/chats/dm-closer/send', { body: { text: ASK } });
    const { last } = await waitReply(t, 'dm-closer');
    assert.doesNotMatch(last.text, /has been saved/);
    assert.match(last.text, /contact was not saved/i);
    assert.match(last.text, /did not work|failed/i);
  } finally { await t.close(); }
});

test('in a group, the summary may not confirm work that no agent\'s step did', async () => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    const sys = b.messages[0].content;
    if (/GO or PASS/.test(sys)) return /^You are the (?:Sales expert|Coder|Researcher) on/.test(sys) ? 'GO' : 'PASS';
    if (/You sum up a group chat turn/.test(sys)) return 'Scout, Closer and Coder: all three agree the contact and deal were created correctly. Check the CRM next.';
    return 'From my side: the CRM needs her mail address and the amount.';
  } });
  try {
    await t.call('/api/m/chat/chats/everyone/send', { body: { text: ASK } });
    const { last } = await waitReply(t, 'everyone', 30000);
    assert.ok(last.meta.groupSummary || last.meta.plainList, 'the summary');
    assert.doesNotMatch(last.text, /were created/);
  } finally { await t.close(); }
});

test('a save the owner denied is never claimed: a later verb in the sentence, or the record named without its kind', () => {
  const denied = (tool, args) => ({ tool, args, status: 'failed', error: 'The owner said no', result: { ok: false, saved: false, refused: true } });
  const steps = [done('crm_contact_save', { args: { name: 'Sunita Rao' } }), denied('crm_deal_save', { title: 'Rao Exports annual order', contact: 'Sunita Rao' })];
  assert.equal(claimWithoutWork('Done. I added Sunita Rao to your CRM and saved the deal Rao Exports annual order.', steps), 'a deal');
  assert.equal(claimWithoutWork('I added Sunita Rao to your CRM. The deal was not saved: you said no.', steps), null, 'saying it was not saved is true');
  assert.equal(claimWithoutWork('Done: updated Rao Exports with the new city.', [denied('crm_company_save', { company: 'Rao Exports', city: 'Pune' })]), 'a company');
  assert.equal(claimWithoutWork('I did not update Rao Exports.', [denied('crm_company_save', { company: 'Rao Exports', city: 'Pune' })]), null);
  // tried twice, the second time saved: the claim stands
  assert.equal(claimWithoutWork('Updated Rao Exports.', [denied('crm_company_save', { company: 'Rao Exports' }), done('crm_company_save', { args: { company: 'Rao Exports' } })]), null);
});
