// CRM inside Sales: contacts, companies, deals, customers, CSV in and out. Local stand-ins only, no network.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { parseCsv, toCsv, siteHost, todayIn } from './crm.js';

test('csv: quoted fields, commas, new lines, and formula-looking cells are made safe on export', () => {
  assert.deepEqual(parseCsv('name,site\n"Acme, Ltd","acme.in"\r\n"Say ""hi""",x.com\n\n'), [['name', 'site'], ['Acme, Ltd', 'acme.in'], ['Say "hi"', 'x.com']]);
  assert.deepEqual(parseCsv('a\n"two\nlines"'), [['a'], ['two\nlines']]);
  assert.equal(toCsv([['Name', 'Note'], ['A, B', '=1+1'], ['say "x"', '@sum']]), 'Name,Note\r\n"A, B",\'=1+1\r\n"say ""x""",\'@sum\r\n');
  assert.equal(siteHost('https://www.Acme.in/about'), 'acme.in');
  assert.equal(siteHost('acme.in'), 'acme.in');
  assert.equal(siteHost('not a site'), '');
  assert.equal(todayIn('Asia/Kolkata', new Date('2026-11-20T20:00:00Z')), '2026-11-21', 'today is the owner\'s day, not the UTC day');
  assert.equal(todayIn('America/New_York', new Date('2026-11-21T02:00:00Z')), '2026-11-20');
});

test('crm: lead to CRM in one press, merge rules keep both sources, owner only', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const lead = (await t.call('/api/m/sales/leads', { body: { company: 'Orbit Components', email: 'v.rao@orbit.example', contactName: 'V Rao', website: 'https://www.orbit.example/', sources: [{ title: 'Makers list', url: 'https://list.example/makers' }] } })).json.lead;
    assert.equal((await t.call(`/api/m/sales/crm/from-lead/${lead.id}`, { method: 'POST', session: false })).status, 403, 'only the owner adds to the CRM');
    const r = (await t.call(`/api/m/sales/crm/from-lead/${lead.id}`, { method: 'POST' })).json;
    assert.equal(r.company.name, 'Orbit Components'); assert.equal(r.company.host, 'orbit.example');
    assert.equal(r.contact.email, 'v.rao@orbit.example'); assert.equal(r.contact.companyId, r.company.id);
    assert.equal(r.company.sources[0].from, 'https://list.example/makers'); assert.ok(r.company.sources[0].at);
    assert.ok(r.contact.notChecked.includes('Role'), 'a field no record gave is "not checked"');
    const st = (await t.call('/api/m/sales/state')).json;
    assert.ok(st.crmLeads.includes(lead.id), 'the lead shows as already in the CRM');
    const again = (await t.call(`/api/m/sales/crm/from-lead/${lead.id}`, { method: 'POST' })).json;
    assert.equal(again.already, true); assert.equal(again.company.id, r.company.id);

    // a company typed by the owner with the same site host but another name: he is asked, then it merges keeping both sources
    const ask = await t.call('/api/m/sales/crm/companies', { body: { name: 'Orbit Components Pvt Ltd', site: 'orbit.example' } });
    assert.equal(ask.status, 409); assert.equal(ask.json.same.id, r.company.id);
    const typed = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Orbit Components Pvt Ltd', site: 'orbit.example', merge: r.company.id, pick: { name: 'theirs' } } })).json.company;
    assert.equal(typed.id, r.company.id); assert.equal(typed.merged, true); assert.equal(typed.name, 'Orbit Components');
    assert.deepEqual(typed.sources.map(s => s.from), ['https://list.example/makers', 'typed by you']);
    // exact name with no site merges; a different host with the same name does not
    assert.equal((await t.call('/api/m/sales/crm/companies', { body: { name: 'orbit components' } })).json.company.id, r.company.id);
    assert.notEqual((await t.call('/api/m/sales/crm/companies', { body: { name: 'Orbit Components', site: 'orbit-two.example' } })).json.company.id, r.company.id);
    // contacts: by email, then name plus company
    assert.equal((await t.call('/api/m/sales/crm/contacts', { body: { name: 'Vik Rao', email: 'V.Rao@orbit.example' } })).status, 409, 'another name for the same address: the owner picks');
    const c1 = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'Vik Rao', email: 'V.Rao@orbit.example', merge: r.contact.id, pick: { name: 'theirs' } } })).json.contact;
    assert.equal(c1.id, r.contact.id); assert.equal(c1.merged, true);
    const c2 = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'v rao', companyId: r.company.id, role: 'Buyer' } })).json.contact;
    assert.equal(c2.id, r.contact.id); assert.equal(c2.role, 'Buyer'); assert.ok(!c2.notChecked.includes('Role'));
    assert.equal((await t.call('/api/m/sales/crm/contacts', { body: { name: 'V Rao' } })).status, 409, 'the same name with no company: "the same?"');
    assert.notEqual((await t.call('/api/m/sales/crm/contacts', { body: { name: 'V Rao', separate: true } })).json.contact.id, r.contact.id, 'the owner said it is a different person');
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.equal(crm.companies.length, 2); assert.equal(crm.contacts.length, 2);
    assert.match(crm.lawful, /responsible for contacting people lawfully/);
    assert.equal((await t.call('/api/m/sales/crm', { session: false })).status, 403);
    assert.equal(t.core.approval.listPending().length, 0, 'the CRM asks to send nothing');
  } finally { await t.close(); }
});

test('crm: deals pipeline with renamed stages, owner currency and owner-zone dates', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    t.core.settings.set('currency', 'INR'); t.core.settings.set('timeZone', 'Asia/Kolkata');
    const co = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Kestrel Labs', site: 'kestrel.example' } })).json.company;
    const d = (await t.call('/api/m/sales/crm/deals', { body: { companyId: co.id, valueMinor: 5000000, nextStep: 'Call back', nextDate: '2020-01-02', notes: 'Wants a quote' } })).json.deal;
    assert.equal(d.title, 'Kestrel Labs'); assert.equal(d.stage, 'new'); assert.equal(d.currency, 'INR'); assert.equal(d.value, 5000000);
    assert.equal(d.due, 'overdue');
    assert.equal((await t.call(`/api/m/sales/crm/deals/${d.id}`, { method: 'PATCH', body: { stage: 'nowhere' } })).status, 400);
    const moved = (await t.call(`/api/m/sales/crm/deals/${d.id}`, { method: 'PATCH', body: { stage: 'meeting', nextDate: 'bad' } }));
    assert.equal(moved.status, 400, 'a date is YYYY-MM-DD');
    assert.equal((await t.call(`/api/m/sales/crm/deals/${d.id}`, { method: 'PATCH', body: { stage: 'meeting' } })).json.deal.stage, 'meeting');
    const s = (await t.call('/api/m/sales/crm/stages', { method: 'PUT', body: { labels: { meeting: 'Call booked', won: '' } } })).json.stages;
    assert.deepEqual(s.map(x => x.label), ['New', 'Contacted', 'Replied', 'Call booked', 'Won', 'Lost'], 'an empty name keeps the old one');
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.equal(crm.deals[0].stageLabel, 'Call booked'); assert.equal(crm.deals[0].companyName, 'Kestrel Labs');
    assert.equal((await t.call('/api/m/sales/crm/stages', { method: 'PUT', session: false, body: { labels: { new: 'x' } } })).status, 403);
  } finally { await t.close(); }
});

test('crm: customers by CSV with a preview first, export, and the customers route for other modules', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    await t.call('/api/m/sales/crm/companies', { body: { name: 'Harlow and Penn', site: 'https://harlow.example' } });
    const csv = 'Company,Website,Contact,Email\nHarlow & Penn,www.harlow.example,Asha N,asha@harlow.example\n"Marlow, Automation",marlow.example,,\n,,Nobody,\nMarlow Automation,marlow.example,,\n';
    const pre = (await t.call('/api/m/sales/crm/import/preview', { body: { csv, fileName: 'C:\\Users\\me\\customers.csv' } })).json;
    // row 1 adds a new contact to a company you have; row 3 is only a name; row 4 is the company of row 2 again
    assert.deepEqual(pre.rows.map(r => r.action), ['new', 'new', 'skip', 'same']);
    assert.match(pre.rows[2].why, /only a name/);
    assert.equal((await t.call('/api/m/sales/crm')).json.companies.length, 1, 'the preview saves nothing');
    assert.equal((await t.call('/api/m/sales/crm/import', { session: false, body: { csv } })).status, 403);
    const done = (await t.call('/api/m/sales/crm/import', { body: { csv, fileName: 'C:\\Users\\me\\customers.csv' } })).json;
    assert.equal(done.added, 2); assert.equal(done.already, 1); assert.equal(done.skipped.length, 1);
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.equal(crm.companies.length, 2); assert.ok(crm.companies.every(c => c.customer));
    const harlow = crm.companies.find(c => c.host === 'harlow.example');
    assert.deepEqual(harlow.sources.map(s => s.from), ['typed by you', 'customers.csv'], 'the file name only, never the folder');
    assert.equal(crm.contacts[0].email, 'asha@harlow.example'); assert.equal(crm.contacts[0].companyId, harlow.id);
    const cu = await t.call('/api/m/sales/customers');
    assert.deepEqual(cu.json.customers.map(c => c.host).sort(), ['harlow.example', 'marlow.example']);
    assert.ok(cu.json.customers.every(c => Object.keys(c).sort().join() === 'host,name'));
    assert.equal((await t.call('/api/m/sales/customers', { session: false })).status, 403, 'owner session only');
    const ex = (await t.call('/api/m/sales/crm/export/companies')).json;
    assert.equal(ex.fileName, 'companies.csv'); assert.match(ex.csv, /^\uFEFFName,Site,Phone,City,Customer,Notes,Sources,Not checked,Added\r\n/); assert.match(ex.csv, /"Marlow, Automation"/);
    assert.match((await t.call('/api/m/sales/crm/export/contacts')).json.csv, /asha@harlow\.example/);
    assert.match((await t.call('/api/m/sales/crm/export/deals')).json.csv, /^\uFEFFTitle,Company,Contact,Stage,Value,Currency,Close date,Next step,Next date,Notes,Added\r\n/);
    assert.equal((await t.call('/api/m/sales/crm/export/companies', { session: false })).status, 403);
    // a company can be marked and unmarked as a customer by hand
    const un = (await t.call(`/api/m/sales/crm/companies/${harlow.id}`, { method: 'PATCH', body: { customer: false } })).json.company;
    assert.equal(un.customer, false);
    assert.equal((await t.call('/api/m/sales/customers')).json.customers.length, 1);
  } finally { await t.close(); }
});

test('crm: a refused contact edit saves nothing', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    const c = (await t.call('/api/m/sales/crm/contacts', { body: { name: 'Asha N', email: 'asha@harlow.example' } })).json.contact;
    const r = await t.call(`/api/m/sales/crm/contacts/${c.id}`, { method: 'PATCH', body: { name: '', email: '' } });
    assert.equal(r.status, 400);
    const after = (await t.call('/api/m/sales/crm')).json.contacts.find(x => x.id === c.id);
    assert.equal(after.name, 'Asha N'); assert.equal(after.email, 'asha@harlow.example');
    assert.deepEqual(after.sources.map(s => s.from), ['typed by you']); assert.equal(after.updated, c.updated);
    // clearing one of the two is fine while the other stays
    assert.equal((await t.call(`/api/m/sales/crm/contacts/${c.id}`, { method: 'PATCH', body: { email: '' } })).json.contact.name, 'Asha N');
    assert.equal((await t.call(`/api/m/sales/crm/contacts/${c.id}`, { method: 'PATCH', body: { name: '' } })).status, 400, 'no name and no address left');
  } finally { await t.close(); }
});

test('crm: a next-step date must be a day that exists', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-01', '2026-00-10']) {
      const r = await t.call('/api/m/sales/crm/deals', { body: { title: 'Day ' + bad, nextDate: bad } });
      assert.equal(r.status, 400, `${bad} does not exist`);
    }
    assert.equal((await t.call('/api/m/sales/crm')).json.deals.length, 0, 'a refused deal is not kept');
    assert.equal((await t.call('/api/m/sales/crm/deals', { body: { title: 'Leap', nextDate: '2028-02-29' } })).json.deal.nextDate, '2028-02-29');
  } finally { await t.close(); }
});

test('crm: a company edit cannot take a site host another company has', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    await t.call('/api/m/sales/crm/companies', { body: { name: 'One', site: 'one.example' } });
    const two = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Two', site: 'two.example' } })).json.company;
    const r = await t.call(`/api/m/sales/crm/companies/${two.id}`, { method: 'PATCH', body: { site: 'https://www.one.example/about' } });
    assert.equal(r.status, 400); assert.match(r.json.error || r.json.message || '', /One/);
    const cos = (await t.call('/api/m/sales/crm')).json.companies;
    assert.equal(cos.find(c => c.id === two.id).host, 'two.example', 'the refused edit saved nothing');
    assert.equal(new Set(cos.map(c => c.host)).size, cos.length, 'no host twice');
    // its own host again, or a free one, is fine
    assert.equal((await t.call(`/api/m/sales/crm/companies/${two.id}`, { method: 'PATCH', body: { site: 'www.two.example' } })).status, 200);
    assert.equal((await t.call(`/api/m/sales/crm/companies/${two.id}`, { method: 'PATCH', body: { site: 'three.example' } })).json.company.host, 'three.example');
  } finally { await t.close(); }
});

test('crm: an import row with only a company name is not saved as a new customer', async () => {
  const t = await testDesk({ modules: ['sales'] });
  try {
    await t.call('/api/m/sales/crm/companies', { body: { name: 'Known Co' } });
    const csv = 'Company,Website,Contact,Email\nGood,good.example,,\nBad,,,\nKnown Co,,,\nNamed,,Ravi K,\n';
    const pre = (await t.call('/api/m/sales/crm/import/preview', { body: { csv } })).json;
    assert.deepEqual(pre.rows.map(r => r.action), ['new', 'skip', 'merge', 'new'], 'a bare name may still mark a company you already have');
    assert.match(pre.rows[1].why, /only a company name/);
    const done = (await t.call('/api/m/sales/crm/import', { body: { csv } })).json;
    assert.equal(done.added + done.merged + done.already, 3); assert.equal(done.skipped.length, 1);
    assert.ok(!(await t.call('/api/m/sales/crm')).json.companies.some(c => c.name === 'Bad'));
  } finally { await t.close(); }
});
