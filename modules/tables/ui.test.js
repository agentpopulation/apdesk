// The Tables page on a small stand-in for the page kit: what the owner reads and what each button sends.
import test from 'node:test'; import assert from 'node:assert/strict';

class El {
  constructor(tag, attrs = {}, kids = []) { this.tag = tag; this.attrs = {}; this.kids = []; this.value = attrs?.value ?? ''; this.classList = { add() {} }; for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) this.attrs[k] = v; this.append(...kids); }
  append(...k) { for (const c of k.flat(Infinity)) if (c != null && c !== false && c !== '') this.kids.push(c); }
  replaceChildren(...k) { this.kids = []; this.append(...k); }
  get firstChild() { return this.kids[0] || null; }
  get textContent() { return text(this); } set textContent(v) { this.kids = [String(v)]; }
  getAttribute(k) { return this.attrs[k] ?? null; } setAttribute(k, v) { this.attrs[k] = v; } focus() {}
}
const text = (n) => (typeof n === 'string' ? n : n instanceof El ? n.kids.map(text).join(' ') : '');
const all = (n, f, out = []) => { if (n instanceof El) { if (f(n)) out.push(n); n.kids.forEach((k) => all(k, f, out)); } return out; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const MEANINGS = [['name', 'Name'], ['company', 'Company'], ['title', 'Title'], ['email', 'Mail address'], ['country', 'Country'], ['operator', 'Network operator'], ['site', 'Site'], ['other', 'Other']].map(([id, label]) => ({ id, label }));

async function page(sources = [], extra = {}) {
  const calls = []; const toasts = []; const confirms = [];
  const routes = {
    '/api/m/tables/sources': () => ({ sources, meanings: MEANINGS, lawful: 'This list was published by its site. Contacting the people on it lawfully is your responsibility.', phoneApps: 'A list that lives in a phone app can be brought in with "Import customers from a file" in Sales, if the app offers an export.', pageLimit: { min: 1, max: 20, default: 5 } }),
    '/api/m/tables/preview': () => ({ token: 't1', url: 'https://ev.example/list', candidates: [{ index: 0, kind: 'table', columns: [{ heading: 'Name', guess: 'name' }, { heading: 'Email', guess: 'email' }], sample: [['Asha N', 'asha@harlow.example']], rowCount: 1 }] }),
    '/api/m/tables/sources/POST': () => ({ source: {} }),
    ...extra,
  };
  const api = async (url, o = {}) => { calls.push({ url, body: o.body, method: o.method }); const k = url === '/api/m/tables/sources' && o.body ? url + '/POST' : url; return structuredClone(routes[k]?.(o.body) ?? {}); };
  const h = (tag, attrs, ...kids) => { if (attrs instanceof El || typeof attrs === 'string' || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; } return new El(tag, attrs, kids); };
  const ui = { h, api, sw: (on, label) => new El('button', { class: 'sw', 'aria-label': label }), card: (...k) => new El('div', { class: 'card' }, k),
    btn: (t, { onClick, ...rest } = {}) => Object.assign(new El('button', rest, [t]), { onClick }), pill: (t) => new El('span', { class: 'pill' }, [t]), empty: (t) => new El('div', { class: 'empty' }, [t]),
    toast: (t) => toasts.push(t), confirm: async (t) => { confirms.push(t); return true; }, fmt: { when: () => '1 Mar 2026, 3:30 pm' } };
  globalThis.document = { getElementById: () => true, head: { append() {} } };
  const { pages } = await import('./ui.js');
  const el = new El('div'); await pages.tables.render(el, ui); await tick();
  return { el, calls, toasts, confirms };
}

test('ui: the lawful line sits under the heading, the phone-app line is shown, and nothing offers to send', async () => {
  const { el } = await page();
  const t = text(el);
  assert.match(t, /Tables\s+This list was published by its site\. Contacting the people on it lawfully is your responsibility\./);
  assert.match(t, /Import customers from a file/);
  assert.match(t, /No lists yet/);
  assert.ok(!all(el, (n) => n.tag === 'button' && /send|mail|message/i.test(text(n))).length, 'no send button');
});

test('ui: find lists shows the headings and first rows; save sends the columns the owner set', async () => {
  const { el, calls } = await page();
  const box = all(el, (n) => n.tag === 'input' && n.attrs['aria-label'] === 'Page address')[0];
  box.value = 'ev.example/list';
  const form = all(el, (n) => n.tag === 'form')[0]; form.attrs.onsubmit({ preventDefault() {} }); await tick(); await tick();
  assert.match(text(el), /List 1: a table, 1 row/); assert.match(text(el), /Asha N/);
  const sels = all(el, (n) => n.tag === 'select'); assert.equal(sels.length, 2);
  sels[1].value = 'other';
  const save = all(el, (n) => n.tag === 'button' && text(n) === 'Save this list')[0]; await save.onClick(); await tick();
  const sent = calls.find((c) => c.url === '/api/m/tables/sources' && c.body);
  assert.deepEqual(sent.body, { token: 't1', index: 0, columns: ['name', 'other'], pageLimit: 5 });
});

test('ui: a changed table asks for the columns again; a moved list offers the new address; no internal ids on screen', async () => {
  const base = { url: 'https://ev.example/list', title: 'Who is coming', host: 'ev.example', columns: [], pageLimit: 5, schedule: false, rows: 3, lastRead: '2026-03-01T10:00:00Z', lastRun: null };
  const { el } = await page([
    { ...base, id: 'tb_abc123', state: 'changed', note: 'The table changed. New columns: Country. Gone columns: none.', pending: { columns: [{ heading: 'Name', guess: 'name' }, { heading: 'Country', guess: 'country' }], sample: [['Asha', 'India']] } },
    { ...base, id: 'tb_def456', url: 'https://ev.example/old', state: 'moved', movedTo: 'https://ev.example/new', note: 'The list moved.' },
  ]);
  const t = text(el);
  assert.match(t, /Table changed/); assert.match(t, /Use these columns/); assert.match(t, /Use the new address/); assert.match(t, /List moved/);
  assert.match(t, /Last read 1 Mar 2026, 3:30 pm/);
  assert.doesNotMatch(t, /tb_/); assert.doesNotMatch(t, /T\d\d:\d\d/);
});

test('ui: the address box takes an address without https:// (no browser URL field that blocks the form)', async () => {
  const { el, calls } = await page();
  const box = all(el, (n) => n.tag === 'input' && n.attrs['aria-label'] === 'Page address')[0];
  assert.notEqual(box.attrs.type, 'url'); assert.equal(box.attrs.inputmode, 'url');
  assert.match(box.attrs.placeholder, /events\.example\/attendees/);
  box.value = 'events.example/attendees';
  all(el, (n) => n.tag === 'form')[0].attrs.onsubmit({ preventDefault() {} }); await tick(); await tick();
  assert.equal(calls.find((c) => c.url === '/api/m/tables/preview').body.url, 'events.example/attendees');
});

test('ui: found lists replace the "No lists yet" line; empty cells read "not checked"', async () => {
  const base = { id: 'tb_a1', url: 'https://ev.example/list', title: 'Who is coming', host: 'ev.example', columns: [{ heading: 'Name', meaning: 'name' }, { heading: 'Email', meaning: 'email' }], pageLimit: 5, schedule: false, rows: 2, goneRows: 0, state: 'ok', lastRead: '2026-03-01T10:00:00Z', lastRun: null };
  const { el } = await page([], { '/api/m/tables/preview': () => ({ token: 't1', url: 'https://ev.example/list', candidates: [{ index: 0, kind: 'table', columns: [{ heading: 'Name', guess: 'name' }, { heading: 'Email', guess: 'email' }], sample: [['Li W', '']], rowCount: 1 }] }) });
  assert.match(text(el), /No lists yet/);
  all(el, (n) => n.tag === 'input' && n.attrs['aria-label'] === 'Page address')[0].value = 'ev.example/list';
  all(el, (n) => n.tag === 'form')[0].attrs.onsubmit({ preventDefault() {} }); await tick(); await tick();
  assert.match(text(el), /1 list found/); assert.doesNotMatch(text(el), /No lists yet/);
  const cells = all(el, (n) => n.tag === 'td').map(text);
  assert.deepEqual(cells, ['Li W', 'not checked']);
  const p2 = await page([base], { '/api/m/tables/sources/tb_a1/rows': () => ({ columns: base.columns, rows: [['Ravi K', ''], ['Li W', 'li@kestrel.example']] }) });
  await all(p2.el, (n) => n.tag === 'button' && text(n) === 'Show rows')[0].onClick(); await tick();
  assert.deepEqual(all(p2.el, (n) => n.tag === 'td').map(text), ['Ravi K', 'not checked', 'Li W', 'li@kestrel.example']);
});

test('ui: the card counts the rows no longer on the list, and removal says the same numbers', async () => {
  const s = { id: 'tb_a1', url: 'https://ev.example/list', title: 'Who is coming', host: 'ev.example', columns: [], pageLimit: 5, schedule: false, rows: 3, goneRows: 4, state: 'ok', lastRead: '2026-03-01T10:00:00Z', lastRun: null };
  const { el, toasts, confirms } = await page([s], { '/api/m/tables/sources/tb_a1': () => ({ rows: 7, gone: 4, crm: { companies: 4, contacts: 4, kept: 0 } }) });
  assert.match(text(el), /3 rows on the list/); assert.match(text(el), /4 no longer on it, still stored/);
  await all(el, (n) => n.tag === 'button' && text(n) === 'Remove everything from this source')[0].onClick(); await tick();
  assert.match(confirms[0], /7 stored rows: 3 on the list and 4 no longer on it/);
  assert.match(confirms[0], /on a deal/);
  assert.match(toasts[0], /Removed 7 rows \(3 on the list, 4 no longer on it\)/); assert.match(toasts[0], /4 companies and 4 contacts/);
});
