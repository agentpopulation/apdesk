// The CRM tabs on the real page kit in a small fake page: an empty list or a short import preview never prints "null";
// a deal moved with the keyboard keeps the focus through the repaint the change event brings; a long name is not cut by
// the input; a lane total never leaves out a deal in another currency; the import says its row limit up front.
import test from 'node:test'; import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<!doctype html><html><body><div id="toasts"></div><div id="modal" hidden></div><main id="pane"></main></body></html>');
globalThis.document = document; globalThis.Node = window.Node; globalThis.Event = window.Event; globalThis.location = { hash: '#/sales' };
// the small fake page has no focus: a focused element is kept here, and lost when it leaves the page, as in a browser
let focused = null;
window.HTMLElement.prototype.focus = function () { focused = this; };
Object.defineProperty(document, 'activeElement', { get: () => (focused && focused.isConnected ? focused : document.body) });
const kit = await import('../../app/ui/kit.js');
const { mountCrm } = await import('./ui-crm.js');
const tick = () => new Promise(r => setTimeout(r, 5));

function page(data, routes = {}) {
  const pane = document.createElement('div'); document.body.append(pane);
  const calls = [];
  const api = async (p, o = {}) => { calls.push({ p, o }); if (routes[p]) return structuredClone(await routes[p](o)); if (p === 'm/sales/crm') return structuredClone(data()); return {}; };
  kit.setPrefs({ locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata' });
  const ui = { ...kit, api, toast: () => {}, state: { settings: { locale: 'en-IN' } }, plainError: (e) => e.message };
  return { pane, calls, crm: mountCrm(pane, ui) };
}
const base = (over = {}) => ({ companies: [], contacts: [], deals: [], stages: ['new', 'contacted', 'replied', 'meeting', 'won', 'lost'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })), imports: [], currency: 'INR', lawful: 'You are responsible for contacting people lawfully.', ...over });

test('an empty Contacts or Companies tab shows its words and never the word "null"', async () => {
  const { pane, crm } = page(() => base());
  crm.show('contacts'); await tick();
  assert.match(pane.textContent, /No contacts yet/); assert.doesNotMatch(pane.textContent, /\bnull\b|undefined/);
  crm.show('companies'); await tick();
  assert.match(pane.textContent, /No companies yet/); assert.doesNotMatch(pane.textContent, /\bnull\b|undefined/);
});

test('a deal moved with the right arrow keeps the focus after the change event repaints the board, so a second press moves it again', async () => {
  let stage = 'new';
  const deal = () => ({ id: 'd1', title: 'Big order', stage, stageLabel: stage, value: 100000, currency: 'INR', closeDate: '', nextStep: '', nextDate: '', companyName: '', contactName: '' });
  const { pane, crm, calls } = page(() => base({ deals: [deal()] }), { 'm/sales/crm/deals/d1': (o) => { stage = o.body.stage; return { deal: deal() }; } });
  crm.show('deals'); await tick();
  const key = (el) => el.dispatchEvent(Object.assign(new window.Event('keydown'), { key: 'ArrowRight' }));
  let card = pane.querySelector('[data-deal="d1"]'); card.focus(); key(card); await tick();
  await crm.refresh(); await tick();   // the 'sales' change event repaints once more
  card = pane.querySelector('[data-deal="d1"]');
  assert.equal(document.activeElement, card, 'the moved card has the focus');
  key(document.activeElement); await tick(); await crm.refresh(); await tick();
  assert.deepEqual(calls.filter(c => c.p === 'm/sales/crm/deals/d1').map(c => c.o.body.stage), ['contacted', 'replied']);
});

test('a lane total covers every deal: one sum per currency, the owner\'s first', async () => {
  const d = (id, value, currency) => ({ id, title: id, stage: 'new', stageLabel: 'New', value, currency, closeDate: '', nextStep: '', nextDate: '', companyName: '', contactName: '' });
  const { pane, crm } = page(() => base({ deals: [d('a', 100000, 'INR'), d('b', 155100, 'JPY'), d('c', 50000, 'INR')] }));
  crm.show('deals'); await tick();
  const head = pane.querySelector('.lane header').textContent;
  assert.match(head, /3 · ₹1,500 \+ (JP)?¥1,551/);
});

test('a currency with no smaller unit shows whole units: a yen deal of 50.5 reads ¥51 on the card and in the lane, never 50.50', async () => {
  const d = { id: 'y', title: 'Yen half', stage: 'new', stageLabel: 'New', value: 5050, currency: 'JPY', closeDate: '', nextStep: '', nextDate: '', companyName: '', contactName: '' };
  const { pane, crm } = page(() => base({ deals: [d] }));
  crm.show('deals'); await tick();
  const card = pane.querySelector('[data-deal="y"]').textContent; const head = pane.querySelector('.lane header').textContent;
  assert.match(card, /¥51/); assert.match(head, /¥51/);
  assert.doesNotMatch(card + head, /50\.5/);
});

test('the name boxes do not cut a long name: the desk refuses it with the reason instead', async () => {
  const { pane, crm } = page(() => base());
  crm.show('contacts'); await tick();
  [...pane.querySelectorAll('button')].find(b => b.textContent === 'Add contact').click(); await tick();
  const inputs = [...document.querySelectorAll('#modal input')];
  assert.ok(inputs.length > 2); assert.ok(inputs.every(i => !i.hasAttribute('maxlength')), 'no box cuts what is typed');
  document.querySelector('#modal').hidden = true;
});

test('the import box says its limit, and a short preview ends with no stray "null"', async () => {
  const preview = { header: true, columns: [{ heading: 'Company', field: 'company', example: 'Mehta' }], fields: [{ id: 'company', label: 'Company' }], total: 1, rows: [{ line: 2, company: 'Mehta', name: '', email: '', phone: '', action: 'new', with: '', warn: [] }], counts: { added: 1, merged: 0, already: 0, skipped: [] } };
  const { pane, crm } = page(() => base({ companies: [] }), { 'm/sales/crm/import/preview': () => preview });
  crm.show('companies'); await tick();
  [...pane.querySelectorAll('button')].find(b => b.textContent === 'Import customers').click(); await tick();
  const modal = document.querySelector('#modal');
  assert.match(modal.textContent, /A CSV file or an \.xlsx workbook \(its first sheet\), up to 5,000 rows and 4 MB/);
  const file = modal.querySelector('input[type=file]');
  Object.defineProperty(file, 'files', { value: [{ name: 'a.csv', size: 20, text: async () => 'Company\nMehta\n' }] });
  file.dispatchEvent(new window.Event('change')); await tick(); await tick();
  assert.match(modal.textContent, /1 row: 1 new/); assert.doesNotMatch(modal.textContent, /\bnull\b/);
});
