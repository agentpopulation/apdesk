// The CRM corrections of release two: an import over the row limit is refused with both numbers; taking one file back
// keeps rows another file also has; a Save that changes nothing leaves a field the list's; phones compare with their
// country code; agent tools ask back "the same one?" and "which one?", show plain words on the card, and a no is a clear
// refused result; other modules read and note through the Sales door; outreach drafts never save an offer or move a lead.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
import { phoneKey, samePhone, IMPORT_ROWS } from './crm.js';
const ExcelJS = createRequire(import.meta.url)('exceljs');

const view = async (t) => (await t.call('/api/m/sales/crm')).json;
const waitPending = async (core, not = new Set()) => { for (let i = 0; i < 150; i++) { const p = core.approval.listPending().filter(a => !not.has(a.id)); if (p.length) return p[0]; await new Promise(r => setTimeout(r, 20)); } throw new Error('no approval was asked'); };
const call = { agentId: 'closer', chatId: 'chat-join' };
const ID = /\b(?:ct|co|dl|nt|im)_[a-z0-9]{6,}/;

test('import: a file over the row limit is refused with the limit and its count, and nothing is saved', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    t.core.settings.set('locale', 'en-IN');
    const rows = (n) => 'Company,Contact,Email\n' + Array.from({ length: n }, (_, i) => `Firm ${i},Person ${i},p${i}@firm${i}.example`).join('\n') + '\n';
    const big = rows(IMPORT_ROWS + 200);
    const pre = await t.call('/api/m/sales/crm/import/preview', { body: { csv: big, fileName: 'big.csv' } });
    assert.equal(pre.status, 413);
    assert.match(pre.json.error, /This file has 5,200 rows\. One import takes at most 5,000 rows\./);
    const save = await t.call('/api/m/sales/crm/import', { body: { csv: big, fileName: 'big.csv', start: 0, end: 250 } });
    assert.equal(save.status, 413); assert.equal((await view(t)).contacts.length, 0, 'not one row of it is saved');
    const ok = (await t.call('/api/m/sales/crm/import/preview', { body: { csv: rows(IMPORT_ROWS), fileName: 'ok.csv' } })).json;
    assert.equal(ok.total, IMPORT_ROWS, 'a file at the limit is read whole'); assert.equal(ok.counts.added, IMPORT_ROWS);
  } finally { await t.close(); }
});

test('import: taking back one of two files keeps the people the other file also had, with what it gave', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const A = 'Company,Contact,Email,Role,City\nAlpha Mills,Anita Rao,anita@alphamills.example.in,Buyer,Pune\nBeta Agro,Bala Krishnan,bala@betaagro.example.in,Owner,Salem\nGamma Tools,Gopal Shah,gopal@gammatools.example.in,Manager,Rajkot\n';
    const B = 'Company,Contact,Email,Phone,Role\nBeta Agro,Bala Krishnan,bala@betaagro.example.in,+91 94430 11111,Director\nGamma Tools,Gopal Shah,gopal@gammatools.example.in,+91 98250 22222,Manager\nDelta Paints,Dev Mehra,dev@deltapaints.example.in,+91 98110 33333,Owner\n';
    const a = (await t.call('/api/m/sales/crm/import', { body: { csv: A, fileName: 'a.csv' } })).json;
    await t.call('/api/m/sales/crm/import', { body: { csv: B, fileName: 'b.csv' } });
    const r = (await t.call(`/api/m/sales/crm/imports/${a.importId}`, { method: 'DELETE' })).json;
    assert.deepEqual(r.removed, { companies: 1, contacts: 1 }, 'only Anita and her company came from a.csv alone');
    assert.deepEqual(r.shared, { companies: 2, contacts: 2 });
    assert.equal(r.line, '1 contact and 1 company removed; 4 kept because another file, list or you also have them');
    const v = await view(t);
    assert.deepEqual(v.contacts.map(c => c.name).sort(), ['Bala Krishnan', 'Dev Mehra', 'Gopal Shah']);
    const bala = v.contacts.find(c => c.name === 'Bala Krishnan');
    assert.equal(bala.phone, '+91 94430 11111', 'what b.csv gave stays');
    assert.ok(!bala.sources.some(s => s.from === 'a.csv'), 'a.csv is no longer named as a source');
    // b.csv is still one set that can be taken back: now nothing else has them, so they go
    const b = v.imports.find(x => x.file === 'b.csv');
    const r2 = (await t.call(`/api/m/sales/crm/imports/${b.id}`, { method: 'DELETE' })).json;
    assert.deepEqual(r2.removed, { companies: 3, contacts: 3 });
    assert.equal((await view(t)).contacts.length, 0);
  } finally { await t.close(); }
});

test('import: the same file twice stays until its last import is taken back', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const A = 'Company,Contact,Email\nAlpha Mills,Anita Rao,anita@alphamills.example.in\n';
    const one = (await t.call('/api/m/sales/crm/import', { body: { csv: A, fileName: 'a.csv' } })).json;
    const two = (await t.call('/api/m/sales/crm/import', { body: { csv: A, fileName: 'a.csv' } })).json;
    const r = (await t.call(`/api/m/sales/crm/imports/${one.importId}`, { method: 'DELETE' })).json;
    assert.deepEqual(r.removed, { companies: 0, contacts: 0 }); assert.equal((await view(t)).contacts.length, 1);
    const r2 = (await t.call(`/api/m/sales/crm/imports/${two.importId}`, { method: 'DELETE' })).json;
    assert.deepEqual(r2.removed, { companies: 0, contacts: 0 }, 'the second import made nothing of its own');
    assert.equal((await view(t)).imports.length, 0);
  } finally { await t.close(); }
});

test('a Save that changes only the notes leaves every other field the list\'s: the list may still update it', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const sales = t.core.modules.api('sales'); const from = 'https://fair.example/exhibitors';
    const co = sales.addCompany({ name: 'Shah Plastics' }, { from });
    const b = sales.addContact({ name: 'Bhavna Shah', email: 'bhavna@shahplastics.example.in', role: 'CEO', companyId: co.id }, { from });
    const c = (await view(t)).contacts.find(x => x.id === b.id);
    // the dialog sends every field; only Notes is new
    const save = await t.call(`/api/m/sales/crm/contacts/${b.id}`, { method: 'PATCH', body: { name: c.name, email: c.email, phone: c.phone, role: c.role, city: c.city, notes: 'Prefers WhatsApp', companyId: c.companyId } });
    assert.equal(save.status, 200); assert.equal(save.json.contact.notes, 'Prefers WhatsApp');
    const again = sales.addContact({ name: 'Bhavna Shah', email: 'bhavna@shahplastics.example.in', role: 'Chairperson', companyId: co.id }, { from });
    assert.deepEqual(again.synced, ['role']); assert.deepEqual(again.left, []);
    assert.equal((await view(t)).contacts.find(x => x.id === b.id).role, 'Chairperson');
    // a real hand edit of the role is still the owner's
    await t.call(`/api/m/sales/crm/contacts/${b.id}`, { method: 'PATCH', body: { role: 'Chair' } });
    const third = sales.addContact({ name: 'Bhavna Shah', email: 'bhavna@shahplastics.example.in', role: 'President', companyId: co.id }, { from });
    assert.deepEqual(third.left, ['role']); assert.equal((await view(t)).contacts.find(x => x.id === b.id).role, 'Chair');
    // the same for a company: a Save with nothing changed changes nothing
    const before = (await view(t)).companies.find(x => x.id === co.id);
    await t.call(`/api/m/sales/crm/companies/${co.id}`, { method: 'PATCH', body: { name: before.name, site: before.site, phone: before.phone, city: before.city, notes: before.notes, customer: before.customer } });
    assert.equal((await view(t)).companies.find(x => x.id === co.id).edited, before.edited, 'no change, no hand edit');
  } finally { await t.close(); }
});

test('phones: the full number with its country code; never across two codes; a number with no code is compared without it', () => {
  assert.equal(phoneKey('+1 (207) 946-0958'), '+12079460958');
  assert.equal(samePhone('+1 (207) 946-0958', '+44 20 7946 0958'), false, 'a US and a UK number are different');
  assert.equal(samePhone('+65 6123 4567', '6123 4567'), true);
  assert.equal(samePhone('+971 50 123 4567', '050 123 4567'), true);
  assert.equal(samePhone('+91 98765 43210', '098765-43210'), true);
  assert.equal(samePhone('+919876543210', '0091 98765 43210'), true);
  assert.equal(samePhone('+44 (0)20 7946 0958', '020 7946 0958'), true);
  assert.equal(samePhone('+91 98765 43210', '+1 98765 43210'), false);
  assert.equal(samePhone('98765 43210 ext 12', '98765 43210'), true, 'an extension is not compared');
});

test('phones on the page: a US and a UK number are two people; one Singapore number written twice asks "the same?"', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const add = (b) => t.call('/api/m/sales/crm/contacts', { body: b });
    assert.equal((await add({ name: 'US Maine Test', phone: '+1 (207) 946-0958' })).status, 200);
    assert.equal((await add({ name: 'UK London Test', phone: '+44 20 7946 0958' })).status, 200, 'no false match across codes');
    assert.equal((await add({ name: 'SG One', phone: '+65 6123 4567' })).status, 200);
    const sg = await add({ name: 'SG Two', phone: '6123 4567' });
    assert.equal(sg.status, 409); assert.equal(sg.json.same.name, 'SG One');
    assert.match(sg.json.why, /only one of the two has a country code, so the code was not compared/);
  } finally { await t.close(); }
});

test('agent tools: an add that already exists asks "the same one?"; a name that fits several asks which; nothing is picked', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    t.core.settings.set('currency', 'INR'); t.core.settings.set('locale', 'en-IN');
    const run = (name, args) => t.core.modules.runTool(name, args, call);
    await t.call('/api/m/sales/crm/deals', { body: { title: 'Rao Exports annual order', valueMinor: 35000000 } });
    const dup = await run('crm_deal_save', { title: 'Rao Exports annual order', value: 350000 });
    assert.equal(dup.ok, false); assert.equal(dup.ask, 'same'); assert.match(dup.text, /already has a deal called Rao Exports annual order: Rao Exports annual order: ₹3,50,000, New\. Nothing was saved\. Ask the owner: is it the same one\?/);
    assert.equal(t.core.approval.listPending().length, 0, 'nothing is asked or saved');
    await t.call('/api/m/sales/crm/deals', { body: { title: 'Rao Exports annual order', valueMinor: 100000 } });
    const two = await run('crm_deal_save', { deal: 'Rao Exports annual order', stage: 'Won' });
    assert.equal(two.ask, 'which'); assert.equal(two.choices.length, 2); assert.match(two.text, /2 deals in the CRM are called Rao Exports annual order/);
    assert.equal((await view(t)).deals.filter(d => d.stage === 'won').length, 0, 'never the first one by itself');
    // the owner said which: by its id from the choices
    const p = run('crm_deal_save', { deal: two.choices[1].id, stage: 'Won' });
    const a = await waitPending(t.core); t.core.approval.decide(a.id, 'approve');
    assert.equal((await p).ok, true); assert.equal((await view(t)).deals.find(d => d.id === two.choices[1].id).stage, 'won');
    // contacts: a second "Ramesh" by name asks; separate: true adds him
    await t.call('/api/m/sales/crm/contacts', { body: { name: 'Ramesh' } });
    const r = await run('crm_contact_save', { name: 'Ramesh', phone: '+91 90000 11111' });
    assert.equal(r.ask, 'same'); assert.match(r.text, /already has a contact called Ramesh/);
    const p2 = run('crm_contact_save', { name: 'Ramesh', phone: '+91 90000 11111', separate: true });
    const b = await waitPending(t.core, new Set([a.id])); t.core.approval.decide(b.id, 'approve');
    assert.equal((await p2).ok, true);
    const which = await run('crm_note_add', { kind: 'contact', to: 'Ramesh', text: 'Call back' });
    assert.equal(which.ask, 'which'); assert.equal(which.choices.length, 2);
  } finally { await t.close(); }
});

test('agent tools: the card is the record in plain words (no ids, no small units, no raw dates); the asker is named once; a no is a refused result', async () => {
  const t = await testDesk({ modules: ['agents', 'sales'] });
  try {
    t.core.settings.set('currency', 'INR'); t.core.settings.set('locale', 'en-IN'); t.core.settings.set('timeZone', 'Asia/Kolkata');
    const run = (name, args) => t.core.modules.runTool(name, args, call);
    const ct = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'Sunita Rao', email: 'sunita@raoexports.example' } })).json.contact;
    const co = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Rao Exports' } })).json.company;
    await t.call(`/api/m/sales/crm/contacts/${ct.id}`, { method: 'PATCH', body: { companyId: co.id } });
    const p = run('crm_deal_save', { title: 'Annual order', value: 350000, closeDate: '2026-11-28', contact: 'Sunita Rao' });
    const a = await waitPending(t.core);
    const shown = JSON.stringify([a.title, a.detail, a.payload]);
    assert.doesNotMatch(shown, ID, 'no id'); assert.doesNotMatch(shown, /35000000|2026-11-28|minor/i, 'no small units, no raw date');
    assert.deepEqual(a.payload, { Deal: 'Annual order', Value: '₹3,50,000', Closes: '28 Nov 2026', Stage: 'New', Contact: 'Sunita Rao', Company: 'Rao Exports' });
    assert.doesNotMatch(String(a.detail || ''), /Asked by/, 'who asks is the card\'s own line, said once');
    t.core.approval.decide(a.id, 'deny');
    const r = await p;
    assert.equal(r.ok, false); assert.equal(r.refused, true); assert.equal(r.saved, false); assert.equal(r.decision, 'no'); assert.equal(r.notDone, 'Add the deal Annual order to your CRM');
    assert.match(r.text, /^The owner said no\. Nothing was saved in the CRM: do not say it was added or changed\.$/);
    assert.equal((await view(t)).deals.length, 0);
    // a change card names the record by what it is, not by an id
    const p2 = run('crm_contact_save', { contact: 'Sunita Rao', role: 'Buyer' });
    const b = await waitPending(t.core, new Set([a.id]));
    assert.doesNotMatch(JSON.stringify(b.payload), ID); assert.equal(b.payload.Contact, 'Sunita Rao: Rao Exports, sunita@raoexports.example'); assert.equal(b.payload.Role, 'Buyer');
    t.core.approval.decide(b.id, 'approve'); assert.equal((await p2).ok, true);
    // a note's source is the agent as the screen names it
    const p3 = run('crm_note_add', { kind: 'contact', to: 'Sunita Rao', text: 'Wants a quote.' });
    const c = await waitPending(t.core, new Set([a.id, b.id])); assert.doesNotMatch(JSON.stringify(c.payload), ID);
    t.core.approval.decide(c.id, 'approve'); await p3;
    const page = (await t.call(`/api/m/sales/crm/contacts/${ct.id}/page`)).json;
    const line = t.core.modules.api('agents').agentLine('closer');
    assert.ok(line && line !== 'Closer', line); assert.equal(page.notes[0].source, `${line} in chat`);
  } finally { await t.close(); }
});

test('agent tools: CRM figures come back marked as the owner\'s own records, with the plain amount; yen has no smaller unit', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    t.core.settings.set('currency', 'INR'); t.core.settings.set('locale', 'en-IN');
    await t.call('/api/m/sales/crm/deals', { body: { title: 'Big order', valueMinor: 12500000 } });
    const r = await t.core.modules.runTool('crm_find', { what: 'deals' }, call);
    assert.equal(r.records, true); assert.match(r.source, /owner's own records in this desk's CRM/);
    assert.equal(r.deals[0].value, '₹1,25,000'); assert.equal(r.deals[0].amount, 125000); assert.doesNotMatch(JSON.stringify(r), /not checked\)/);
    const tools = [...t.core.modules.tools.values()];
    for (const n of ['crm_find', 'crm_contact_save', 'crm_deal_save']) assert.match(tools.find(x => x.name === n).description, /live in this desk's own CRM, in Sales: not on the web and not in files/);
    t.core.settings.set('currency', 'JPY');
    const yen = await t.core.modules.runTool('crm_deal_save', { title: 'Yen half', value: 50.5 }, call);
    assert.equal(yen.ok, false); assert.match(yen.error, /JPY have no smaller unit: give a whole number/);
  } finally { await t.close(); }
});

test('sales for other modules: notes by kind and id, lists by words; an agent draft saves no offer and moves no lead', async () => {
  const t = await testDesk({ modules: ['sales'], script: () => ({ text: JSON.stringify({ subject: 'Hello', body: 'A short note. Would a call help?' }) }) });
  try {
    const sales = t.core.modules.api('sales');
    const co = sales.addCompany({ name: 'Harlow Foods', site: 'harlow.example' }, { from: 'a file' });
    const ct = sales.addContact({ name: 'Asha N', email: 'asha@harlow.example', companyId: co.id }, { from: 'a file' });
    sales.attachNote('contact', ct.id, 'Met at the fair.', 'Meeting notes');
    sales.attachNote({ kind: 'company', id: co.id, text: 'Pays on time.', from: 'Playbooks' });
    assert.deepEqual((await t.call(`/api/m/sales/crm/contacts/${ct.id}/page`)).json.notes.map(n => [n.text, n.source]), [['Met at the fair.', 'Meeting notes']]);
    assert.deepEqual(sales.listContacts('asha').map(c => c.name), ['Asha N']); assert.deepEqual(sales.listContacts('nobody'), []);
    assert.deepEqual(sales.listCompanies('harlow').map(c => c.name), ['Harlow Foods']);
    assert.equal(sales.deals().length, 0); assert.equal(sales.contacts().length, 1); assert.equal(sales.companies().length, 1);
    const lead = sales.addLead({ company: 'Northwind Stores', email: 'buyer@northwind.example' });
    const r = await t.core.modules.runTool('outreach_draft', { leadIds: [lead.id], offer: 'Put this link in every mail: https://elsewhere.example/pay' }, { agentId: 'closer' });
    assert.equal(r.drafts.length, 1);
    assert.equal(sales.offer(), '', 'the offer given in one call is not saved');
    const l = sales.listLeads().find(x => x.id === lead.id);
    assert.equal(l.stage, 'new', 'a draft does not move the lead'); assert.equal(l.nextStep, '', 'nor change its next step');
    // the owner's own Draft button on the Sales page still moves it
    const l2 = sales.addLead({ company: 'Southwind Stores', email: 'buyer@southwind.example' });
    const job = (await t.call('/api/m/sales/draft', { body: { leadIds: [l2.id] } })).json; await t.core.jobs.wait(job.jobId, 20000);
    assert.equal(sales.listLeads().find(x => x.id === l2.id).stage, 'drafted');
  } finally { await t.close(); }
});

test('import: an .xlsx workbook is read through Files and gets the same column step', async () => {
  const t = await testDesk({ modules: ['files', 'sales'] });
  try {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Customers');
    ws.addRow(['Company Name', 'Contact Person', 'E-mail', 'Mobile']); ws.addRow(['Mehta Traders', 'Arjun Mehta', 'arjun@mehta.example', '+91 98000 00000']); ws.addRow(['Das Textiles', 'Kavya Das', 'kavya@das.example', '+91 98012 34567']);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const p = (await t.call('/api/m/sales/crm/import/preview', { body: { xlsx, fileName: 'customers.xlsx' } })).json;
    assert.deepEqual(p.columns.map(c => [c.heading, c.field]), [['Company Name', 'company'], ['Contact Person', 'name'], ['E-mail', 'email'], ['Mobile', 'phone']]);
    assert.equal(p.total, 2); assert.equal(p.counts.added, 2);
    const s = (await t.call('/api/m/sales/crm/import', { body: { xlsx, fileName: 'customers.xlsx' } })).json;
    assert.equal(s.added, 2); assert.equal((await view(t)).contacts.find(c => c.name === 'Kavya Das').phone, '+91 98012 34567');
    const bad = await t.call('/api/m/sales/crm/import/preview', { body: { xlsx: Buffer.from('not a zip').toString('base64'), fileName: 'x.xlsx' } });
    assert.equal(bad.status, 415); assert.match(bad.json.error, /could not be read/);
  } finally { await t.close(); }
});
