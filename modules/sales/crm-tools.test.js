// The CRM tools agents use: reading answers from the CRM only; adding or changing asks the owner first with the exact
// record, saves exactly that, and returns what was saved. The owner's no saves nothing.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { todayIn } from './crm.js';

const waitPending = async (core, n = 1) => { for (let i = 0; i < 100; i++) { const p = core.approval.listPending(); if (p.length >= n) return p; await new Promise(r => setTimeout(r, 20)); } throw new Error('no approval was asked'); };
const call = { agentId: 'closer', chatId: 'chat-crm' };

test('crm tools: add Sunita Rao and her deal; each asks with the exact record, and the reply text is what was saved', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    t.core.settings.set('currency', 'INR'); t.core.settings.set('timeZone', 'Asia/Kolkata'); t.core.settings.set('locale', 'en-IN');
    // the desk starts at Open, where most actions run without asking: a change to the CRM still asks
    const run = (name, args) => t.core.modules.runTool(name, args, call);
    const p1 = run('crm_contact_save', { name: 'Sunita Rao', email: 'sunita@raoexports.example', phone: '+91 98450 12345', company: 'Rao Exports' });
    const [ask] = await waitPending(t.core);
    assert.equal(ask.action, 'record.change', 'filed under the door\'s name for a change to a customer record'); assert.match(ask.title, /Add the contact Sunita Rao to your CRM/);
    assert.deepEqual(ask.payload, { Name: 'Sunita Rao', 'Mail address': 'sunita@raoexports.example', Phone: '+91 98450 12345', Company: 'Rao Exports (new company)' }, 'the card shows the record in plain words, nothing internal');
    assert.equal((await t.call('/api/m/sales/crm')).json.contacts.length, 0, 'nothing is saved before the owner says yes');
    t.core.approval.decide(ask.id, 'approve');
    const r1 = await p1;
    assert.equal(r1.ok, true); assert.match(r1.text, /^Saved in the CRM: added the contact Sunita Rao, sunita@raoexports\.example, \+91 98450 12345, Rao Exports \(new company\)\.$/);
    const p2 = run('crm_deal_save', { title: 'Rao Exports annual order', value: 350000, closeDate: '2026-11-28', contact: 'Sunita Rao' });
    const [ask2] = (await waitPending(t.core)).filter(a => a.id !== ask.id);
    assert.deepEqual(ask2.payload, { Deal: 'Rao Exports annual order', Value: '₹3,50,000', Closes: '28 Nov 2026', Stage: 'New', Contact: 'Sunita Rao', Company: 'Rao Exports' });
    t.core.approval.decide(ask2.id, 'approve');
    const r2 = await p2;
    assert.equal(r2.ok, true, r2.error); assert.match(r2.text, /added the deal Rao Exports annual order \(₹3,50,000, closes 28 Nov 2026, New, contact Sunita Rao, company Rao Exports\)/);
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.equal(crm.contacts[0].name, 'Sunita Rao'); assert.equal(crm.contacts[0].phone, '+91 98450 12345');
    assert.equal(crm.deals[0].value, 35000000); assert.equal(crm.deals[0].closeDate, '2026-11-28'); assert.equal(crm.deals[0].contactName, 'Sunita Rao');
    // a contact that is not there is said, not invented
    const nope = await run('crm_deal_save', { title: 'X', contact: 'Nobody Here' });
    assert.equal(nope.ok, false); assert.match(nope.error, /no contact called Nobody Here/);
    // a bad date is refused before anything is asked
    const bad = await run('crm_deal_save', { title: 'Y', closeDate: '28 November 2026' });
    assert.equal(bad.ok, false); assert.match(bad.error, /YYYY-MM-DD/);
    assert.equal(t.core.approval.listPending().length, 0);
  } finally { await t.close(); }
});

test('crm tools: the owner says no, nothing is saved; a change of the same mail address is a change, not a second contact', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const run = (name, args) => t.core.modules.runTool(name, args, call);
    const p = run('crm_contact_save', { name: 'Asha N', email: 'asha@harlow.example' });
    const [a] = await waitPending(t.core); t.core.approval.decide(a.id, 'deny');
    const r = await p; assert.equal(r.ok, false); assert.match(r.error, /said no\. Nothing was saved/);
    assert.equal((await t.call('/api/m/sales/crm')).json.contacts.length, 0);
    const c = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'Asha N', email: 'asha@harlow.example' } })).json.contact;
    const p2 = run('crm_contact_save', { email: 'ASHA@harlow.example', role: 'Buyer' });
    const [b] = await waitPending(t.core); assert.match(b.title, /Change the contact Asha N/);
    t.core.approval.decide(b.id, 'approve');
    const r2 = await p2; assert.equal(r2.ok, true); assert.equal(r2.saved.id, c.id); assert.equal(r2.saved.role, 'Buyer');
    assert.equal((await t.call('/api/m/sales/crm')).json.contacts.length, 1);
  } finally { await t.close(); }
});

test('crm tools: inside an auto-approve window a change to the CRM still asks, and is saved only on the owner\'s yes', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    t.core.settings.set('security.autoApproveUntil', new Date(Date.now() + 15 * 60000).toISOString());
    const p = t.core.modules.runTool('crm_contact_save', { name: 'Window Person', email: 'window@harlow.example' }, call);
    const [a] = await waitPending(t.core);
    assert.equal((await t.call('/api/m/sales/crm')).json.contacts.length, 0, 'nothing saved while it waits');
    t.core.approval.decide(a.id, 'approve');
    const r = await p; assert.equal(r.ok, true, r.error);
    assert.equal((await t.call('/api/m/sales/crm')).json.contacts[0].name, 'Window Person');
  } finally { await t.close(); }
});

test('crm tools: deals closing this month come from the CRM in the owner\'s zone; reading asks nothing', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    t.core.settings.set('timeZone', 'Asia/Kolkata'); t.core.settings.set('currency', 'INR');
    const today = todayIn('Asia/Kolkata'); const month = today.slice(0, 7);
    const next = month.endsWith('-12') ? `${Number(month.slice(0, 4)) + 1}-01` : `${month.slice(0, 5)}${String(Number(month.slice(5)) + 1).padStart(2, '0')}`;
    await t.call('/api/m/sales/crm/deals', { body: { title: 'This month one', closeDate: `${month}-15`, valueMinor: 50 } });
    await t.call('/api/m/sales/crm/deals', { body: { title: 'Next month one', closeDate: `${next}-02` } });
    await t.call('/api/m/sales/crm/deals', { body: { title: 'No date' } });
    const r = await t.core.modules.runTool('crm_find', { what: 'deals', closing: 'this month' }, call);
    assert.equal(r.ok, true); assert.deepEqual(r.deals.map(d => d.title), ['This month one']);
    assert.match(r.text, /^1 deal in the CRM closing in /); assert.match(r.deals[0].value, /0\.50/, 'an amount under one unit keeps its part');
    const none = await t.core.modules.runTool('crm_find', { what: 'deals', closing: '2020-01' }, call);
    assert.equal(none.count, 0); assert.match(none.text, /No deal in the CRM closing in .*3 deals in all/);
    const blank = await t.core.modules.runTool('crm_find', { what: 'deals', query: 'No date' }, call);
    assert.equal(blank.deals[0].value, 'not set'); assert.equal(blank.deals[0].closeDate, 'not set');
    assert.equal(t.core.approval.listPending().length, 0, 'reading asks nothing');
    // the same for other modules
    const api = t.core.modules.api('sales');
    assert.equal(api.deals().length, 3); assert.deepEqual(api.deals({ closing: 'next month' }).map(d => d.title), ['Next month one']);
  } finally { await t.close(); }
});

test('crm api: Meeting notes attach a dated note with its source; contacts and companies are listed', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const api = t.core.modules.api('sales');
    const co = api.addCompany({ name: 'Harlow' }, { from: 'https://events.example/a' });
    const ct = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'Asha N', email: 'asha@harlow.example', companyId: co.id } })).json.contact;
    assert.deepEqual(api.listContacts(), [{ id: ct.id, name: 'Asha N', email: 'asha@harlow.example', companyId: co.id }]);
    assert.deepEqual(api.listCompanies(), [{ id: co.id, name: 'Harlow' }]);
    api.attachNote({ kind: 'contact', id: ct.id, text: 'Meeting on 20 Nov: wants a quote.', from: 'Meeting notes' });
    api.addNote('company', co.id, 'Pays on time.', 'Playbooks');
    const page = (await t.call(`/api/m/sales/crm/contacts/${ct.id}/page`)).json;
    assert.deepEqual(page.notes.map(n => [n.text, n.source]), [['Meeting on 20 Nov: wants a quote.', 'Meeting notes']]);
    assert.equal((await t.call(`/api/m/sales/crm/companies/${co.id}/page`)).json.notes[0].source, 'Playbooks');
    assert.throws(() => api.addNote('contact', ct.id, 'x', 'typed by you'), /source/, 'another module cannot pass for the owner');
    assert.throws(() => api.addNote('contact', 'ct_nope', 'x', 'Meeting notes'), /not in the CRM/);
  } finally { await t.close(); }
});
