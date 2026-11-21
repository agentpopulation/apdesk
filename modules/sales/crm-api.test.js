// The CRM offered to other modules: addCompany, addContact and removeSource keep the CRM's own merge rules and sources.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

test('crm api: other modules add companies and contacts through the merge rules, with the source and the date read', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const crm = t.core.modules.api('sales');
    const A = 'https://events.example/attendees', B = 'https://other.example/list';
    const c1 = crm.addCompany({ name: 'Orbit Components', site: 'orbit.example' }, { from: A, at: '2026-11-01T10:00:00.000Z' });
    const c2 = crm.addCompany({ name: 'Orbit Components Ltd', site: 'https://www.orbit.example/' }, { from: B, at: '2026-11-02T10:00:00.000Z' });
    assert.equal(c2.id, c1.id, 'the same site host merges');
    assert.deepEqual(c2.sources.map(s => s.from), [A, B]);
    const again = crm.addCompany({ name: 'Orbit Components' }, { from: A, at: '2026-11-05T10:00:00.000Z' });
    assert.equal(again.sources.find(s => s.from === A).at, '2026-11-05T10:00:00.000Z', 'a later read moves the date read forward');
    assert.equal(again.sources.length, 2, 'a source is kept once');
    const p = crm.addContact({ name: 'V Rao', email: 'v.rao@orbit.example', role: 'Buyer', companyId: c1.id }, { from: A, at: '2026-11-01T10:00:00.000Z' });
    const p2 = crm.addContact({ name: 'Vik Rao', email: 'V.RAO@orbit.example' }, { from: A, at: '2026-11-03T10:00:00.000Z' });
    assert.equal(p2.id, p.id, 'the same mail address merges'); assert.equal(p2.name, 'V Rao', 'a merge fills empty fields only');
    assert.throws(() => crm.addCompany({ name: 'X' }, {}), /source/);
    assert.throws(() => crm.addCompany({ name: 'X' }, { from: 'typed by you' }), /source/, 'another module cannot pass for the owner');
    assert.equal(t.core.approval.listPending().length, 0, 'nothing asks to send');
  } finally { await t.close(); }
});

test('crm api: removeSource takes one source mark off; rows with another source stay', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const crm = t.core.modules.api('sales');
    const A = 'https://events.example/attendees', B = 'https://other.example/list';
    const only = crm.addCompany({ name: 'Only A', site: 'only-a.example' }, { from: A });
    crm.addContact({ name: 'Asha N', email: 'asha@only-a.example', companyId: only.id }, { from: A });
    const both = crm.addCompany({ name: 'Both', site: 'both.example' }, { from: A });
    crm.addCompany({ name: 'Both', site: 'both.example' }, { from: B });
    const typed = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Typed Co', site: 'typed.example' } })).json.company;
    crm.addCompany({ name: 'Typed Co', site: 'typed.example' }, { from: A });
    const r = crm.removeSource(A);
    assert.deepEqual(r, { companies: 1, contacts: 1, kept: 2 });
    const view = (await t.call('/api/m/sales/crm')).json;
    assert.deepEqual(view.companies.map(c => c.name).sort(), ['Both', 'Typed Co']);
    assert.deepEqual(view.companies.find(c => c.id === both.id).sources.map(s => s.from), [B]);
    assert.deepEqual(view.companies.find(c => c.id === typed.id).sources.map(s => s.from), ['typed by you']);
    assert.equal(view.contacts.length, 0);
    assert.throws(() => crm.removeSource('typed by you'), /source/, 'the owner\'s own marks are not removed this way');
  } finally { await t.close(); }
});

test('crm api: removeSource takes back what the source filled in; another source that gave the same value keeps it', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const crm = t.core.modules.api('sales');
    const A = 'https://events.example/attendees', B = 'https://other.example/list';
    const co = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Harlow' } })).json.company;
    const ct = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'Asha N', companyId: co.id } })).json.contact;
    crm.addCompany({ name: 'Harlow', notes: 'Country: India.' }, { from: A });
    const m = crm.addContact({ name: 'Asha N', email: 'asha@harlow.example', role: 'Buyer', companyId: co.id }, { from: A });
    assert.equal(m.id, ct.id); assert.equal(m.email, 'asha@harlow.example');
    crm.addCompany({ name: 'Kestrel' }, { from: A });
    crm.addContact({ name: 'Li W', email: 'li@kestrel.example', role: 'Founder' }, { from: A });
    crm.addContact({ name: 'Li W', email: 'li@kestrel.example' }, { from: B });
    const r = crm.removeSource(A);
    assert.equal(r.kept, 3);
    const view = (await t.call('/api/m/sales/crm')).json;
    const asha = view.contacts.find(c => c.id === ct.id);
    assert.equal(asha.email, '', 'the mail address the list filled in is taken out'); assert.equal(asha.role, '');
    assert.deepEqual(asha.sources.map(s => s.from), ['typed by you']);
    assert.equal(view.companies.find(c => c.id === co.id).notes, '', 'the notes the list filled in are taken out');
    const li = view.contacts.find(c => c.name === 'Li W');
    assert.equal(li.email, 'li@kestrel.example', 'the other source gave the same mail address'); assert.equal(li.role, '', 'only the removed source gave the role');
    assert.deepEqual(li.sources.map(s => s.from), [B]);
    crm.removeSource(B);
    assert.equal((await t.call('/api/m/sales/crm')).json.contacts.length, 1, 'then it goes');
  } finally { await t.close(); }
});

test('crm api: removeSource keeps a company and a contact that are on a deal, without the data the source gave', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const crm = t.core.modules.api('sales');
    const A = 'https://events.example/attendees';
    const co = crm.addCompany({ name: 'Harlow', site: 'harlow.example', notes: 'Country: India.' }, { from: A });
    const ct = crm.addContact({ name: 'Asha N', email: 'asha@harlow.example', role: 'Buyer', companyId: co.id }, { from: A });
    const deal = (await t.call('/api/m/sales/crm/deals', { body: { title: 'Big', companyId: co.id, contactId: ct.id } })).json.deal;
    const r = crm.removeSource(A);
    assert.deepEqual(r, { companies: 0, contacts: 0, kept: 2 });
    const view = (await t.call('/api/m/sales/crm')).json;
    const c = view.contacts.find(x => x.id === ct.id);
    assert.ok(c, 'the contact on a deal stays'); assert.equal(c.name, 'Asha N'); assert.equal(c.email, ''); assert.equal(c.role, '');
    const k = view.companies.find(x => x.id === co.id);
    assert.equal(k.name, 'Harlow'); assert.equal(k.site, ''); assert.equal(k.notes, '');
    assert.equal(view.deals.find(d => d.id === deal.id).contactId, ct.id, 'the deal keeps its contact');
  } finally { await t.close(); }
});

test('crm api: a field the owner types after a source filled it stays when the source is removed', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const crm = t.core.modules.api('sales');
    const A = 'https://events.example/attendees';
    const co = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Harlow' } })).json.company;
    crm.addCompany({ name: 'Harlow', site: 'harlow.example' }, { from: A });
    await t.call(`/api/m/sales/crm/companies/${co.id}`, { method: 'PATCH', body: { site: 'harlow-penn.example' } });
    crm.removeSource(A);
    assert.equal((await t.call('/api/m/sales/crm')).json.companies[0].site, 'harlow-penn.example');
  } finally { await t.close(); }
});
