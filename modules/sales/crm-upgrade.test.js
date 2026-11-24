// A desk with CRM data saved before these columns existed: the new columns and look-up keys are added and filled on the first
// start, so the same-mail check, the phone check and the import match work on the rows that were already there.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDesk } from '../../app/server.js';

async function desk(dataDir) {
  const d = await createDesk({ dataDir, port: 0, quiet: true, env: {}, modules: ['sales'], pairing: false }); await d.start();
  const call = async (p, { method, body } = {}) => { const r = await fetch(d.url() + p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-apd-session': d.session }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  return { d, call };
}
test('crm upgrade: rows saved before the new columns get their keys on the first start', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-crm-up-'));
  try {
    let { d, call } = await desk(dataDir);
    await d.stop();
    // the database as an older desk left it: no migration 5, no new columns or tables, two rows of its shape
    const db = new DatabaseSync(path.join(dataDir, 'apd.sqlite'));
    for (const t of ['m_sales_notes', 'm_sales_imports']) db.exec(`DROP TABLE ${t}`);
    for (const ix of ['m_sales_companies_name_key', 'm_sales_companies_co_key', 'm_sales_contacts_mail_key', 'm_sales_contacts_phone_key', 'm_sales_contacts_name_key']) db.exec(`DROP INDEX ${ix}`);
    for (const [t, c] of [['m_sales_deals', 'close_date'], ['m_sales_companies', 'city'], ['m_sales_companies', 'phone'], ['m_sales_companies', 'edited'], ['m_sales_companies', 'name_key'], ['m_sales_companies', 'co_key'], ['m_sales_contacts', 'city'], ['m_sales_contacts', 'edited'], ['m_sales_contacts', 'name_key'], ['m_sales_contacts', 'mail_key'], ['m_sales_contacts', 'phone_key']]) db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    db.prepare("DELETE FROM migrations WHERE module = 'sales' AND version = 5").run();
    const at = '2026-11-01T10:00:00.000Z'; const src = JSON.stringify([{ from: 'typed by you', at }]);
    db.prepare('INSERT INTO m_sales_companies (id, name, site, host, customer, sources, unchecked, created, updated) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)').run('co_old', 'KT Traders Pvt Ltd', 'kt.example', 'kt.example', src, '[]', at, at);
    db.prepare('INSERT INTO m_sales_contacts (id, name, email, phone, company_id, sources, unchecked, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('ct_old', 'Priya Sharma', 'priya@kt.example', '+91 98765 43210', 'co_old', src, '[]', at, at);
    db.close();
    ({ d, call } = await desk(dataDir));
    try {
      const amit = (await call('/api/m/sales/crm/contacts', { body: { name: 'Amit Verma', email: 'amit@kt.example' } })).json.contact;
      const e = await call(`/api/m/sales/crm/contacts/${amit.id}`, { method: 'PATCH', body: { email: 'priya@kt.example' } });
      assert.equal(e.status, 400, 'the old row\'s mail address is known');
      assert.equal((await call('/api/m/sales/crm/contacts', { body: { name: 'P', phone: '9876543210' } })).json.same?.id, 'ct_old', 'and its phone');
      assert.equal((await call('/api/m/sales/crm/companies', { body: { name: 'KT Traders Pvt. Ltd.' } })).json.same?.id, 'co_old', 'and its near-same name');
      const crm = (await call('/api/m/sales/crm')).json;
      assert.equal(crm.contacts.find(c => c.id === 'ct_old').notChecked.length, 0, 'typed fields stay "not set", never "not checked"');
      assert.deepEqual(crm.imports, []);
    } finally { await d.stop(); }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
