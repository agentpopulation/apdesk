// The CRM records: column matching on import, duplicates, typed data never dropped, close dates, a page per contact
// and company, export for spreadsheets.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { guessColumns, rowValues } from './columns.js';
import { parseCsv } from './crm.js';

const MESSY = '﻿Company Name,Contact Person,E-mail,Mobile,Website,Notes\r\n"Sharma, Gupta & Co",Rakesh Sharma,rakesh@sharmagupta.example,98100 11111,sharmagupta.example,"Pays late, but pays"\r\nOm Sai Enterprises,Sai Prasad,sai@omsai.example,+91 90000 22222,www.omsai.example,\r\nOm Sai Enterprises,Sai Prasad,sai@omsai.example,+91 90000 22222,www.omsai.example,\r\nBalaji Stores,,,,,\r\nGanesh Hardware,Ganesh,ganesh@hardware,99999 00000,,\r\n';
const CLEAN = 'Company,Website,Contact,Email,Phone,City\nMehta Traders Pune,mehtatraders.example,Arjun Mehta,arjun@mehtatraders.example,+91 9800000000,Pune\nDas Textiles,dastextiles.example,Kavya Das,kavya@dastextiles.example,+91 9801234567,Coimbatore\n';
const pre = (t, csv, extra = {}) => t.call('/api/m/sales/crm/import/preview', { body: { csv, fileName: 'messy.csv', ...extra } });
const save = (t, csv, extra = {}) => t.call('/api/m/sales/crm/import', { body: { csv, fileName: 'messy.csv', ...extra } });
const view = async (t) => (await t.call('/api/m/sales/crm')).json;

test('columns: any header is matched, guessed from the header and the first rows; nothing unknown is dropped', () => {
  const g = guessColumns(parseCsv(MESSY));
  assert.equal(g.header, true);
  assert.deepEqual(g.columns, ['company', 'name', 'email', 'phone', 'site', 'notes']);
  const n = guessColumns(parseCsv('Delta Foods,deltafoods.example,Kiran,kiran@deltafoods.example\nEcho Steel,echosteel.example,,\n'));
  assert.equal(n.header, false, 'a first row with a site and a mail address is data');
  assert.deepEqual(n.columns, ['company', 'site', 'name', 'email']);
  const c = guessColumns(parseCsv(CLEAN));
  assert.deepEqual(c.columns, ['company', 'site', 'name', 'email', 'phone', 'city']);
  const odd = guessColumns(parseCsv('Name,Email,Phone,GST number,Alt phone\nAsha,asha@x.example,98450 12345,29ABCDE,98450 99999\n'));
  assert.deepEqual(odd.columns, ['name', 'email', 'phone', 'notes', 'notes'], 'an unknown heading and a second phone go to the notes');
  assert.equal(rowValues(['Asha', 'a@x.example', '1', '29ABCDE', '2'], odd.columns, odd.headings).notes, 'GST number: 29ABCDE\nAlt phone: 2');
});

test('import: the column match is used; phones, notes and contact names are kept; counts split added, merged, already there and skipped', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const p = (await pre(t, MESSY)).json;
    assert.deepEqual(p.columns.map(c => c.field), ['company', 'name', 'email', 'phone', 'site', 'notes']);
    assert.deepEqual(p.columns.map(c => c.heading), ['Company Name', 'Contact Person', 'E-mail', 'Mobile', 'Website', 'Notes']);
    assert.deepEqual(p.rows.map(r => r.action), ['new', 'new', 'same', 'skip', 'new']);
    assert.equal(p.rows[0].name, 'Rakesh Sharma');
    assert.match(p.rows[3].why, /only a company name/);
    assert.match(p.rows[4].warn.join(' '), /ganesh@hardware.*does not look right.*notes/, 'a bad mail address is said, and kept in the notes');
    assert.equal((await view(t)).companies.length, 0, 'the preview saves nothing');
    const r = (await save(t, MESSY)).json;
    assert.deepEqual({ added: r.added, merged: r.merged, already: r.already, skipped: r.skipped.length }, { added: 3, merged: 0, already: 1, skipped: 1 });
    assert.equal(r.skipped[0].line, 5); assert.match(r.skipped[0].why, /only a company name/);
    const v = await view(t);
    const rakesh = v.contacts.find(c => c.name === 'Rakesh Sharma');
    assert.ok(rakesh, 'the contact person is saved with the name');
    assert.equal(rakesh.phone, '98100 11111'); assert.equal(rakesh.notes, 'Pays late, but pays');
    const ganesh = v.contacts.find(c => c.name === 'Ganesh');
    assert.equal(ganesh.email, ''); assert.match(ganesh.notes, /ganesh@hardware/);
    // the same file again: nothing new, and it says so
    const again = (await save(t, MESSY)).json;
    assert.equal(again.added, 0); assert.equal(again.already, 4); assert.equal(again.skipped.length, 1);
    // the owner changes the match: Mobile left out
    const left = (await pre(t, CLEAN, { columns: ['company', 'site', 'name', 'email', 'skip', 'city'] })).json;
    assert.equal(left.rows[0].phone, ''); assert.equal(left.rows[0].city, 'Pune');
    assert.equal((await pre(t, CLEAN, { columns: ['company', 'company', 'name', 'email', 'phone', 'city'] })).status, 400, 'one company column');
  } finally { await t.close(); }
});

test('import: a file that is not CSV is refused plainly; an import is removed as one set, keeping rows the owner changed', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const x = await pre(t, 'PK\u0003\u0004\u0014\u0000junk', { fileName: 'customers.xlsx' });
    assert.equal(x.status, 415); assert.match(x.json.error, /save it as CSV/i); assert.doesNotMatch(x.json.error, /\n/);
    const r = (await save(t, CLEAN, { fileName: 'clean.csv' })).json;
    assert.equal(r.added, 2); assert.ok(r.importId);
    const v = await view(t);
    assert.equal(v.imports.length, 1); assert.equal(v.imports[0].file, 'clean.csv'); assert.equal(v.imports[0].added, 2);
    const kavya = v.contacts.find(c => c.name === 'Kavya Das');
    await t.call(`/api/m/sales/crm/contacts/${kavya.id}`, { method: 'PATCH', body: { role: 'Owner' } });
    const gone = (await t.call(`/api/m/sales/crm/imports/${r.importId}`, { method: 'DELETE' })).json;
    assert.equal(gone.removed.contacts, 1); assert.equal(gone.kept.contacts, 1, 'the contact the owner changed stays');
    const after = await view(t);
    assert.deepEqual(after.contacts.map(c => c.name), ['Kavya Das']);
    assert.deepEqual(after.companies.map(c => c.name), ['Das Textiles'], 'its company stays with it');
    assert.equal(after.imports.length, 0);
  } finally { await t.close(); }
});

test('duplicates: the same mail on edit is refused; phones are compared after tidying; a second name-only contact asks first', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const add = (b) => t.call('/api/m/sales/crm/contacts', { body: b });
    const priya = (await add({ name: 'Priya Sharma', email: 'priya@kt.example', phone: '+91 98765 43210' })).json.contact;
    const amit = (await add({ name: 'Amit Verma', email: 'amit@kt.example' })).json.contact;
    const e = await t.call(`/api/m/sales/crm/contacts/${amit.id}`, { method: 'PATCH', body: { email: 'PRIYA@kt.example' } });
    assert.equal(e.status, 400); assert.equal(e.json.field, 'email'); assert.match(e.json.error, /Priya Sharma already has that mail address/);
    for (const ph of ['+919876543210', '98765 43210', '098765-43210']) {
      const s = await add({ name: 'P Sharma', phone: ph });
      assert.equal(s.status, 409, ph); assert.equal(s.json.same.id, priya.id); assert.match(s.json.why, /phone/);
    }
    // the same mail address on add: both names are shown and the owner picks; nothing typed is dropped
    const m = await add({ name: 'P. Sharma', email: 'priya@kt.example', role: 'Buyer' });
    assert.equal(m.status, 409); assert.deepEqual(m.json.differs.map(d => [d.field, d.mine, d.theirs]), [['name', 'P. Sharma', 'Priya Sharma']]);
    assert.equal(m.json.canSeparate, false, 'two contacts cannot share a mail address');
    const picked = (await add({ name: 'P. Sharma', email: 'priya@kt.example', role: 'Buyer', merge: priya.id, pick: { name: 'mine' } })).json.contact;
    assert.equal(picked.id, priya.id); assert.equal(picked.name, 'P. Sharma'); assert.equal(picked.role, 'Buyer');
    // a second plain "Ramesh"
    await add({ name: 'Ramesh' });
    const r2 = await add({ name: 'ramesh' });
    assert.equal(r2.status, 409); assert.equal(r2.json.canSeparate, true);
    assert.equal((await add({ name: 'ramesh', separate: true })).status, 200);
    assert.equal((await view(t)).contacts.filter(c => /ramesh/i.test(c.name)).length, 2);
  } finally { await t.close(); }
});

test('typed data is never dropped without a word: a bad site, a long name, a phone that is not one', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const s = await t.call('/api/m/sales/crm/companies', { body: { name: 'Site Test Co', site: 'not a site' } });
    assert.equal(s.status, 400); assert.equal(s.json.field, 'site'); assert.match(s.json.error, /site address does not look right/);
    const long = 'A'.repeat(230);
    const l = await t.call('/api/m/sales/crm/contacts', { body: { name: long } });
    assert.equal(l.status, 400); assert.equal(l.json.field, 'name'); assert.match(l.json.error, /at most 200 characters.*230/);
    const p = await t.call('/api/m/sales/crm/contacts', { body: { name: 'Maybe', phone: 'call me maybe' } });
    assert.equal(p.status, 400); assert.equal(p.json.field, 'phone');
    assert.equal((await view(t)).contacts.length + (await view(t)).companies.length, 0, 'a refused add saves nothing');
    const ok = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'B'.repeat(150), phone: '+91 (80) 4123-4567 ext 12' } })).json.contact;
    assert.equal(ok.name.length, 150, '150 characters are kept whole');
  } finally { await t.close(); }
});

test('near-same company names are offered as "the same?" and never merged silently; a same-site merge keeps the typed name on a pick', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const kt = (await t.call('/api/m/sales/crm/companies', { body: { name: 'KT Traders Pvt Ltd', site: 'kt.example' } })).json.company;
    const n = await t.call('/api/m/sales/crm/companies', { body: { name: 'KT Traders Pvt. Ltd.' } });
    assert.equal(n.status, 409); assert.equal(n.json.same.id, kt.id); assert.equal(n.json.canSeparate, true);
    assert.equal((await view(t)).companies.length, 1);
    const w = await t.call('/api/m/sales/crm/companies', { body: { name: 'KT Wholesale', site: 'https://kt.example/' } });
    assert.equal(w.status, 409); assert.deepEqual(w.json.differs.map(d => d.mine), ['KT Wholesale']);
    const m = (await t.call('/api/m/sales/crm/companies', { body: { name: 'KT Wholesale', site: 'kt.example', merge: kt.id, pick: { name: 'mine' } } })).json.company;
    assert.equal(m.id, kt.id); assert.equal(m.name, 'KT Wholesale');
    // an import never merges a near-same name: it says so on the row
    const p = (await pre(t, 'Company,City\nKT Wholesale Pvt Ltd,Pune\n')).json;
    assert.equal(p.rows[0].action, 'new'); assert.match(p.rows[0].near?.name || '', /KT Wholesale/);
  } finally { await t.close(); }
});

test('deals: a close date in the owner\'s zone, the contact on the deal, and a contact page with its deals and notes', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    t.core.settings.set('timeZone', 'Asia/Kolkata'); t.core.settings.set('currency', 'INR');
    const co = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Rao Exports' } })).json.company;
    const ct = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'Sunita Rao', companyId: co.id } })).json.contact;
    assert.equal((await t.call('/api/m/sales/crm/deals', { body: { title: 'Bad', closeDate: '2026-02-30' } })).status, 400);
    const d = (await t.call('/api/m/sales/crm/deals', { body: { title: 'Rao Exports annual order', companyId: co.id, contactId: ct.id, valueMinor: 35000000, closeDate: '2026-11-28' } })).json.deal;
    assert.equal(d.closeDate, '2026-11-28'); assert.equal(d.contactName, 'Sunita Rao'); assert.equal(d.companyName, 'Rao Exports');
    assert.equal((await t.call(`/api/m/sales/crm/notes`, { body: { kind: 'contact', id: ct.id, text: 'Prefers calls after 4.' } })).status, 200);
    const page = (await t.call(`/api/m/sales/crm/contacts/${ct.id}/page`)).json;
    assert.deepEqual(page.deals.map(x => x.id), [d.id]); assert.equal(page.notes[0].text, 'Prefers calls after 4.');
    assert.equal(page.notes[0].source, 'typed by you'); assert.ok(page.history.length >= 1);
    const cp = (await t.call(`/api/m/sales/crm/companies/${co.id}/page`)).json;
    assert.deepEqual(cp.deals.map(x => x.id), [d.id]); assert.deepEqual(cp.contacts.map(x => x.id), [ct.id]);
    const csv = (await t.call('/api/m/sales/crm/export/deals')).json.csv;
    assert.ok(csv.startsWith('﻿'), 'a byte-order mark so spreadsheets read the letters right');
    assert.match(csv, /Close date/); assert.match(csv, /2026-11-28/); assert.match(csv, /Sunita Rao/);
    const cc = (await t.call('/api/m/sales/crm/export/contacts')).json.csv;
    assert.match(cc.split('\r\n')[0], /Phone.*City.*Notes/);
  } finally { await t.close(); }
});
