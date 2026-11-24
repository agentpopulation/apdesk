// A watched list keeps the CRM true: a changed row updates the CRM fields that list
// filled, never a field the owner changed by hand since (and says which were left); a row no longer on the list is
// marked with the date; the refresh line says what the CRM now shows. Pages are stand-ins on loopback (hook.js).
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { standIn } from '../network/standin.js';
import { clearRules } from '../network/rules.js';
import { hook } from './hook.js';
import { testHooks as searchHooks } from '../search/server.js';

const filler = '<p>This page lists the people taking part in the fair this year. It is kept up to date by the organisers of the event.</p>';
const page = (rows) => `<!doctype html><html><head><title>Exhibitors</title></head><body><h1>Exhibitors</h1>${filler}<table><thead><tr><th>Name</th><th>Company</th><th>Job title</th><th>Email</th></tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;

test('tables sync: a changed title updates the role the list filled; one the owner typed is left and named; a removed row is marked', async () => {
  let rows = [['Chetan Rao', 'Rao Fabrics', 'Manager', 'chetan@raofab.example'], ['Farid Khan', 'Khan Metals', 'Buyer', 'farid@khanmetals.example'], ['Mira Das', 'Das Prints', 'Owner', 'mira@dasprints.example']];
  const site = await standIn(({ path, res }) => { if (path !== '/exhibitors') { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page(rows)); });
  hook.fetch = site.fetch; hook.lookup = async () => [{ address: '93.184.216.34', family: 4 }]; hook.pauseMs = 0; searchHooks.fetch = hook.fetch; searchHooks.lookup = hook.lookup;
  const t = await testDesk({ modules: ['search', 'sales', 'tables'] });
  try {
    t.core.settings.set('timeZone', 'Asia/Kolkata');
    await t.call('/api/modules/tables/on', { method: 'POST' });
    const url = 'https://fair.example/exhibitors';
    const pre = (await t.call('/api/m/tables/preview', { body: { url } })).json;
    const c = pre.candidates[0];
    const src = (await t.call('/api/m/tables/sources', { body: { token: pre.token, index: c.index, columns: c.columns.map(x => x.guess) } })).json.source;
    let crm = (await t.call('/api/m/sales/crm')).json;
    const mira = crm.contacts.find(x => x.name === 'Mira Das');
    await t.call(`/api/m/sales/crm/contacts/${mira.id}`, { method: 'PATCH', body: { role: 'Founder' } });   // the owner's own change
    rows = [['Chetan Rao', 'Rao Fabrics', 'General Manager', 'chetan@raofab.example'], ['Mira Das', 'Das Prints', 'Director', 'mira@dasprints.example'], ['Nina P', 'P Tools', 'Buyer', 'nina@ptools.example']];
    const r = (await t.call(`/api/m/tables/sources/${src.id}/refresh`, { method: 'POST' })).json.source;
    assert.match(r.note, /1 new, 2 changed, 1 no longer on the list/);
    crm = (await t.call('/api/m/sales/crm')).json;
    assert.equal(crm.contacts.find(x => x.name === 'Chetan Rao').role, 'General Manager', 'the role the list filled follows the list');
    assert.equal(crm.contacts.find(x => x.name === 'Mira Das').role, 'Founder', 'the owner\'s own change is never overwritten');
    const farid = crm.contacts.find(x => x.name === 'Farid Khan');
    assert.ok(farid, 'a person no longer on the list stays in the CRM');
    assert.ok(farid.sources.find(s => s.from === url).goneAt, 'and is marked no longer on the list, with the date');
    assert.match(r.note, /In the CRM: 1 contact updated \(Chetan Rao: role\)/);
    assert.match(r.note, /left as you changed them: Mira Das: role/);
    assert.match(r.note, /1 marked no longer on the list/);
    // back on the list: the mark goes
    rows.push(['Farid Khan', 'Khan Metals', 'Buyer', 'farid@khanmetals.example']);
    const r2 = (await t.call(`/api/m/tables/sources/${src.id}/refresh`, { method: 'POST' })).json.source;
    assert.ok(!(await t.call('/api/m/sales/crm')).json.contacts.find(x => x.name === 'Farid Khan').sources.find(s => s.from === url).goneAt);
    assert.doesNotMatch(r2.note, /Mira Das/, 'a field left as the owner changed it is said once, when the list changed it, not on every refresh');
  } finally { await t.close(); await site.close(); hook.fetch = null; hook.lookup = null; hook.pauseMs = null; searchHooks.fetch = null; searchHooks.lookup = null; clearRules(); }
});
