// Tables on a throwaway desk. Pages are stand-ins on loopback, reached through the test hook (hook.js), which no
// request or tool can set. Nothing goes out to the network.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { standIn } from '../network/standin.js';
import { setRules, clearRules } from '../network/rules.js';
import { hook } from './hook.js';
import { testHooks as searchHooks } from '../search/server.js';

const filler = '<p>This page lists the people taking part in the meeting this year. It is kept up to date by the organisers of the event.</p>';
const page = (body, extra = '') => `<!doctype html><html><head><title>Who is coming</title>${extra}</head><body><h1>Who is coming</h1>${filler}${body}</body></html>`;
const table = (heads, rows) => `<table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const ROWS = [['Asha N', 'Harlow and Penn', 'Buyer', 'asha@harlow.example'], ['Ravi K', 'Marlow Automation', '', 'ravi@marlow.example'], ['Li W', 'Kestrel Labs', 'Founder', '']];
const HEADS = ['Name', 'Company', 'Job title', 'Email'];

async function on(pages) {
  const site = await standIn(({ host, path, res }) => {
    const p = typeof pages === 'function' ? pages(host, path) : pages[host + path];
    if (p == null) { res.writeHead(404, { 'content-type': 'text/html' }); res.end(page('<p>Not here</p>')); return; }
    if (p.redirect) { res.writeHead(301, { location: p.redirect }); res.end(); return; }
    res.writeHead(p.status || 200, { 'content-type': p.type || 'text/html; charset=utf-8' }); res.end(p.body ?? p);
  });
  hook.fetch = site.fetch; hook.lookup = async () => [{ address: '93.184.216.34', family: 4 }]; hook.pauseMs = 0; searchHooks.fetch = hook.fetch; searchHooks.lookup = hook.lookup;
  const t = await testDesk({ modules: ['search', 'sales', 'tables'] });
  t.core.settings.set('timeZone', 'Asia/Kolkata');
  assert.equal((await t.call('/api/modules/tables/on', { method: 'POST' })).status, 200);
  const close = async () => { await t.close(); await site.close(); hook.fetch = null; hook.lookup = null; hook.pauseMs = null; searchHooks.fetch = null; searchHooks.lookup = null; clearRules(); };
  return { t, site, close };
}
const add = async (t, url, { pick = 0, columns, pageLimit } = {}) => {
  const pre = await t.call('/api/m/tables/preview', { body: { url } });
  if (pre.status !== 200) return { pre };
  const c = pre.json.candidates[pick];
  const saved = await t.call('/api/m/tables/sources', { body: { token: pre.json.token, index: c.index, columns: columns || c.columns.map(x => x.guess), pageLimit } });
  return { pre, saved, source: saved.json?.source };
};

test('tables: off by default; on, a plain table is found, the columns are guessed and the rows go into the CRM', async () => {
  const t0 = await testDesk({ modules: ['search', 'sales', 'tables'] });
  try { assert.equal((await t0.call('/api/m/tables/sources')).status, 404, 'off until switched on'); } finally { await t0.close(); }
  const url = 'https://events.example/attendees';
  const { t, site, close } = await on({ 'events.example/attendees': page(table(['Day', 'Talk'], [['1', 'Opening'], ['2', 'Close']]) + table(HEADS, ROWS)) });
  try {
    assert.equal((await t.call('/api/m/tables/preview', { session: false, body: { url } })).status, 403, 'owner only');
    const { pre, saved, source } = await add(t, url, { pick: 1 });
    assert.equal(pre.status, 200);
    assert.equal(pre.json.candidates.length, 2);
    const c = pre.json.candidates[1];
    assert.deepEqual(c.columns.map(x => x.heading), HEADS);
    assert.deepEqual(c.columns.map(x => x.guess), ['name', 'company', 'title', 'email']);
    assert.deepEqual(c.sample[0], ROWS[0]); assert.equal(c.rowCount, 3);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(source.state, 'ok'); assert.equal(source.rows, 3); assert.ok(source.lastRead);
    assert.deepEqual(source.columns.map(x => x.meaning), ['name', 'company', 'title', 'email']);
    assert.equal(source.lastRun.added.length, 3);
    assert.ok(site.seen.some(s => s.path === '/robots.txt'), 'robots.txt is read first');
    assert.equal(site.seen.filter(s => s.path === '/attendees').length, 1, 'the page is read once: the preview copy is used to save');
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.deepEqual(crm.companies.map(x => x.name).sort(), ['Harlow and Penn', 'Kestrel Labs', 'Marlow Automation']);
    assert.ok(crm.companies.every(x => x.sources[0].from === url && x.sources[0].at), 'source address and date read on every row');
    assert.ok(crm.companies.every(x => x.notChecked.includes('Site')), 'a field the table does not give stays not checked');
    const li = crm.contacts.find(x => x.name === 'Li W');
    assert.ok(li.notChecked.includes('Mail address')); assert.equal(li.role, 'Founder');
    assert.equal(crm.contacts.find(x => x.email === 'ravi@marlow.example').companyId, crm.companies.find(x => x.name === 'Marlow Automation').id);
    const list = (await t.call('/api/m/tables/sources')).json;
    assert.match(list.lawful, /published by its site/); assert.match(list.lawful, /lawfully is your responsibility/);
    assert.match(list.phoneApps, /Import customers from a file/);
    assert.equal(t.core.approval.listPending().length, 0, 'nothing is sent or asked');
  } finally { await close(); }
});

test('tables: a list of repeated blocks is found and saved', async () => {
  const card = (n, co, c, op) => `<div class="delegate"><h3 class="delegate-name">${n}</h3><p>Country: ${c}</p><p>Operator: ${op}</p><p>Company: ${co}</p></div>`;
  const { t, close } = await on({ 'gsm.example/members': page(`<div class="list">${card('Asha N', 'Harlow', 'India', 'Tel One')}${card('Ravi K', 'Marlow', 'Kenya', 'Safari Net')}${card('Li W', 'Kestrel', 'Chile', 'Andes Mobile')}</div>`) });
  try {
    const { pre, source } = await add(t, 'https://gsm.example/members');
    const c = pre.json.candidates[0];
    assert.equal(c.kind, 'blocks');
    assert.deepEqual(c.columns.map(x => x.guess), ['name', 'country', 'operator', 'company']);
    assert.equal(source.rows, 3);
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.match(crm.companies.find(x => x.name === 'Marlow').notes, /Country: Kenya/);
  } finally { await close(); }
});

test('tables: headings changed: says which columns are new or gone, keeps the last copy, waits for the owner', async () => {
  let v = 1;
  const { t, close } = await on((host, path) => path === '/list' ? page(v === 1 ? table(HEADS, ROWS) : table(['Name', 'Company', 'Email', 'Country'], [['Asha N', 'Harlow and Penn', 'asha@harlow.example', 'India'], ['New P', 'Nimbus', 'new@nimbus.example', 'Peru']])) : null);
  try {
    const { source } = await add(t, 'https://ev.example/list');
    v = 2;
    const r = (await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' })).json.source;
    assert.equal(r.state, 'changed');
    assert.match(r.note, /The table changed/); assert.match(r.note, /New columns: Country/); assert.match(r.note, /Gone columns: Job title/);
    assert.equal(r.rows, 3, 'the last good copy is kept');
    assert.deepEqual(r.pending.columns.map(x => x.guess), ['name', 'company', 'email', 'country']);
    assert.equal((await t.call('/api/m/sales/crm')).json.companies.length, 3, 'nothing new goes to the CRM before the owner checks');
    const ok = (await t.call(`/api/m/tables/sources/${source.id}/columns`, { body: { columns: ['name', 'company', 'email', 'country'] } })).json.source;
    assert.equal(ok.state, 'ok'); assert.equal(ok.rows, 2);
    assert.equal(ok.lastRun.added.length, 1); assert.equal(ok.lastRun.gone.length, 2, 'two people are no longer on the list');
    assert.equal(ok.goneRows, 2);
  } finally { await close(); }
});

test('tables: a moved page and a gone page are said plainly; the last good copy is kept', async () => {
  let mode = 'ok';
  const { t, close } = await on((host, path) => {
    if (path !== '/list') return path === '/new-list' ? page(table(HEADS, ROWS)) : null;
    return mode === 'ok' ? page(table(HEADS, ROWS)) : mode === 'moved' ? { redirect: '/new-list' } : mode === 'notable' ? page('<p>The list is closed.</p>') : null;
  });
  try {
    const { source } = await add(t, 'https://ev.example/list');
    mode = 'moved';
    let r = (await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' })).json.source;
    assert.equal(r.state, 'moved'); assert.match(r.note, /The list moved/); assert.equal(r.movedTo, 'https://ev.example/new-list'); assert.equal(r.rows, 3);
    mode = '404';
    r = (await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' })).json.source;
    assert.equal(r.state, 'gone'); assert.match(r.note, /The list is gone: the page answered 404/); assert.equal(r.rows, 3);
    mode = 'notable';
    r = (await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' })).json.source;
    assert.equal(r.state, 'gone'); assert.match(r.note, /no longer has this list/); assert.equal(r.rows, 3);
    mode = 'moved';
    await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' });
    r = (await t.call(`/api/m/tables/sources/${source.id}/address`, { body: {} })).json.source;
    assert.equal(r.url, 'https://ev.example/new-list'); assert.equal(r.state, 'ok', 'the owner takes the new address');
  } finally { await close(); }
});

test('tables: robots.txt refusal and a never-open site are refused with the reason', async () => {
  const { t, site, close } = await on({ 'ev.example/robots.txt': { body: 'User-agent: *\nDisallow: /private\n', type: 'text/plain' }, 'ev.example/private/list': page(table(HEADS, ROWS)), 'blocked.example/list': page(table(HEADS, ROWS)) });
  try {
    const r = await t.call('/api/m/tables/preview', { body: { url: 'https://ev.example/private/list' } });
    assert.equal(r.status, 422); assert.match(r.json.error, /robots\.txt of ev\.example does not allow/);
    assert.ok(!site.seen.some(s => s.path === '/private/list'), 'the page itself is not asked for');
    setRules({ never: ['blocked.example'] });
    const b = await t.call('/api/m/tables/preview', { body: { url: 'https://blocked.example/list' } });
    assert.equal(b.status, 422); assert.match(b.json.error, /never open blocked\.example/);
    assert.ok(!site.seen.some(s => s.host === 'blocked.example'), 'nothing was sent to it');
  } finally { await close(); }
});

test('tables: two pages joined by "next" are read up to the page limit, one site at a time', async () => {
  const p1 = page(table(HEADS, ROWS.slice(0, 2)) + '<a href="/list?page=2">Next</a>');
  const p2 = page(table(HEADS, ROWS.slice(2)) + '<a href="/list?page=3">Next</a>');
  const p3 = page(table(HEADS, [['Zed Q', 'Zeta', '', 'zed@zeta.example']]));
  const { t, site, close } = await on({ 'ev.example/list': p1, 'ev.example/list?page=2': p2, 'ev.example/list?page=3': p3 });
  try {
    const { source } = await add(t, 'https://ev.example/list', { pageLimit: 2 });
    assert.equal(source.rows, 3); assert.equal(source.pagesRead, 2); assert.equal(source.pageLimit, 2);
    assert.match(source.note, /page limit/);
    assert.ok(!site.seen.some(s => s.path === '/list?page=3'), 'not past the limit');
    const more = (await t.call(`/api/m/tables/sources/${source.id}/settings`, { body: { pageLimit: 3 } })).json.source;
    assert.equal(more.pageLimit, 3);
    const r = (await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' })).json.source;
    assert.equal(r.rows, 4); assert.equal(r.lastRun.added.length, 1);
  } finally { await close(); }
});

test('tables: rows merged into the CRM without duplicates across refreshes and sources', async () => {
  const { t, close } = await on({ 'ev.example/list': page(table(HEADS, ROWS)), 'two.example/list': page(table(['Attendee', 'Organisation', 'Mail'], [['Asha N', 'Harlow and Penn', 'asha@harlow.example'], ['Mo T', 'Orbit', 'mo@orbit.example']])) });
  try {
    await t.call('/api/m/sales/crm/companies', { body: { name: 'Harlow and Penn', site: 'harlow.example' } });
    const { source } = await add(t, 'https://ev.example/list');
    await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' });
    const again = (await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' })).json.source;
    assert.equal(again.lastRun.added.length, 0); assert.equal(again.lastRun.changed.length, 0); assert.equal(again.lastRun.gone.length, 0);
    await add(t, 'https://two.example/list');
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.equal(crm.companies.filter(c => c.name === 'Harlow and Penn').length, 1);
    assert.equal(crm.contacts.filter(c => c.email === 'asha@harlow.example').length, 1);
    assert.equal(crm.companies.length, 4); assert.equal(crm.contacts.length, 4);
    const harlow = crm.companies.find(c => c.name === 'Harlow and Penn');
    assert.deepEqual(harlow.sources.map(s => s.from), ['typed by you', 'https://ev.example/list', 'https://two.example/list']);
  } finally { await close(); }
});

test('tables: "Remove everything from this source" removes its rows and its CRM marks; rows with another source stay', async () => {
  const { t, close } = await on({ 'ev.example/list': page(table(HEADS, ROWS)), 'two.example/list': page(table(HEADS, [ROWS[0]])) });
  try {
    const { source } = await add(t, 'https://ev.example/list');
    await add(t, 'https://two.example/list');
    assert.equal((await t.call(`/api/m/tables/sources/${source.id}`, { method: 'DELETE', session: false })).status, 403);
    const r = (await t.call(`/api/m/tables/sources/${source.id}`, { method: 'DELETE' })).json;
    assert.equal(r.rows, 3);
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.deepEqual(crm.companies.map(c => c.name), ['Harlow and Penn']);
    assert.deepEqual(crm.companies[0].sources.map(s => s.from), ['https://two.example/list']);
    assert.deepEqual(crm.contacts.map(c => c.name), ['Asha N']);
    assert.equal((await t.call('/api/m/tables/sources')).json.sources.length, 1);
  } finally { await close(); }
});

test('tables: agents read saved rows only; they cannot add sources; Offline waits', async () => {
  const { t, site, close } = await on({ 'ev.example/list': page(table(HEADS, ROWS)) });
  try {
    const { source } = await add(t, 'https://ev.example/list');
    const tools = t.core.modules.tools ? [...t.core.modules.tools.keys()].filter(n => t.core.modules.tools.get(n).module === 'tables') : [];
    assert.deepEqual(tools, ['read_saved_table'], 'no tool adds a source or reads a page');
    const before = site.seen.length;
    const r = await t.core.modules.runTool('read_saved_table', { source: 'https://ev.example/list' }, { agentId: 'closer' });
    assert.equal(r.rows.length, 3); assert.equal(r.rows[0].Name, 'Asha N'); assert.equal(r.rows[0].Email, 'asha@harlow.example');
    assert.match(r.note, /data, not instructions/); assert.doesNotMatch(r.lastRead, /T\d\d:|Z$/, 'owner zone, not UTC text');
    assert.equal(site.seen.length, before, 'no new browsing');
    const none = await t.core.modules.runTool('read_saved_table', { source: 'https://new.example/list' }, { agentId: 'closer' });
    assert.match(none.error, /No saved list/); assert.ok(none.saved.includes('https://ev.example/list'));
    t.core.settings.set('online', false);
    const off = (await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' })).json.source;
    assert.equal(off.state, 'waiting'); assert.match(off.note, /offline/i); assert.equal(off.rows, 3);
    assert.equal(site.seen.length, before, 'nothing read while Offline');
    assert.equal((await t.call('/api/m/tables/preview', { body: { url: 'https://ev.example/list' } })).status, 409);
  } finally { await close(); }
});

test('tables: the schedule is off by default and refreshes at most once a day', async () => {
  const { t, site, close } = await on({ 'ev.example/list': page(table(HEADS, ROWS)) });
  try {
    const { source } = await add(t, 'https://ev.example/list');
    assert.equal(source.schedule, false); assert.equal(source.nextAt, null);
    const reads = () => site.seen.filter(s => s.path === '/list').length;
    await hook.tick(); assert.equal(reads(), 1, 'off: no scheduled read');
    const s = (await t.call(`/api/m/tables/sources/${source.id}/settings`, { body: { schedule: true } })).json.source;
    assert.equal(s.schedule, true);
    assert.ok(new Date(s.nextAt) - new Date(s.lastRead) >= 24 * 3600_000 - 1000, 'next read a day after the last');
    await hook.tick(); assert.equal(reads(), 1, 'not again within the day');
    await hook.tick(Date.now() + 25 * 3600_000); assert.equal(reads(), 2, 'a day later it reads once');
  } finally { await close(); }
});

test('tables: a pause between pages of one site, and Panic stops a refresh with nothing changed', async () => {
  const p1 = page(table(HEADS, ROWS.slice(0, 2)) + '<a href="/list?page=2">Next</a>');
  const p2 = page(table(HEADS, ROWS.slice(2)));
  const { t, site, close } = await on({ 'ev.example/list': p1, 'ev.example/list?page=2': p2 });
  try {
    const times = []; const inner = hook.fetch;
    hook.fetch = (u, i) => { if (!String(u).includes('robots')) times.push(Date.now()); return inner(u, i); };
    searchHooks.fetch = hook.fetch;
    hook.pauseMs = 300;
    const { source } = await add(t, 'https://ev.example/list');
    assert.equal(source.rows, 3);
    assert.ok(times[1] - times[0] >= 290, `pause between pages (${times[1] - times[0]} ms)`);
    const before = site.seen.length;
    const run = t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' });
    setTimeout(() => t.core.panic.stopAll('test'), 150);
    const r = await run;
    assert.equal(r.status, 409); assert.match(r.json.error, /Stopped/);
    const after = (await t.call('/api/m/tables/sources')).json.sources[0];
    assert.equal(after.rows, 3); assert.equal(after.lastRun.added.length, 3, 'the stopped read saved nothing');
    assert.ok(site.seen.length - before <= 2, 'the second page was not read after Panic');
    assert.equal((await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' })).status, 503, 'while stopped, no new read');
    t.core.panic.resume();
  } finally { await close(); }
});

test('tables: robots.txt is read again for the page a redirect leads to, on the same site', async () => {
  const { t, site, close } = await on({ 'ev.example/robots.txt': { body: 'User-agent: *\nDisallow: /private\n', type: 'text/plain' }, 'ev.example/list': { redirect: '/private/list' }, 'ev.example/private/list': page(table(HEADS, ROWS)) });
  try {
    const r = await t.call('/api/m/tables/preview', { body: { url: 'https://ev.example/list' } });
    assert.equal(r.status, 422); assert.match(r.json.error, /robots\.txt of ev\.example does not allow/);
    assert.ok(!site.seen.some(s => s.path === '/private/list'), 'the page robots.txt forbids is not asked for');
  } finally { await close(); }
});

test('tables: a next page that leads to another site is not read; the rows stop at the last page on the site', async () => {
  const { t, site, close } = await on({ 'ev.example/list': page(table(HEADS, ROWS.slice(0, 2)) + '<a href="/list2">Next</a>'), 'ev.example/list2': { redirect: 'https://evil.example/list3' },
    'evil.example/robots.txt': { body: 'User-agent: *\nDisallow: /\n', type: 'text/plain' }, 'evil.example/list3': page(table(HEADS, [['Eve E', 'EvilCo', '', 'eve@evil.example']])) });
  try {
    const { source } = await add(t, 'https://ev.example/list');
    assert.ok(!site.seen.some(s => s.host === 'evil.example'), 'nothing was asked of the other site');
    assert.equal(source.state, 'ok'); assert.equal(source.rows, 2); assert.equal(source.pagesRead, 1);
    assert.match(source.note, /The next page leads to another site \(evil\.example\), so it was not read/);
    const crm = (await t.call('/api/m/sales/crm')).json;
    assert.ok(!crm.companies.some(c => c.name === 'EvilCo'));
  } finally { await close(); }
});

test('tables: new columns confirmed for the same people do not count them as new and gone', async () => {
  let v = 1;
  const { t, close } = await on((host, path) => path === '/list' ? page(v === 1 ? table(HEADS, ROWS) : table(['Name', 'Company', 'Job title', 'Country'], ROWS.map(r => [r[0], r[1], r[2], 'India']))) : null);
  try {
    const { source } = await add(t, 'https://ev.example/list');
    v = 2;
    await t.call(`/api/m/tables/sources/${source.id}/refresh`, { method: 'POST' });
    const ok = (await t.call(`/api/m/tables/sources/${source.id}/columns`, { body: { columns: ['name', 'company', 'title', 'country'] } })).json.source;
    assert.equal(ok.state, 'ok');
    assert.equal(ok.lastRun.added.length, 0); assert.equal(ok.lastRun.gone.length, 0);
    assert.equal(ok.rows, 3); assert.equal(ok.goneRows, 0);
    assert.match(ok.note, /0 new, 0 changed, 0 no longer on the list/);
    const del = (await t.call(`/api/m/tables/sources/${source.id}`, { method: 'DELETE' })).json;
    assert.equal(del.rows, 3); assert.equal(del.gone, 0);
  } finally { await close(); }
});

test('tables: a page read through Search\'s readHtml keeps robots.txt on every hop and the same-site rule', async () => {
  const { readHtml } = await import('./read.js');
  const { t, site, close } = await on({ 'ev.example/robots.txt': { body: 'User-agent: *\nDisallow: /private\n', type: 'text/plain' }, 'ev.example/list': page(table(HEADS, ROWS)),
    'ev.example/hop': { redirect: '/private/list' }, 'ev.example/private/list': page(table(HEADS, ROWS)), 'ev.example/away': { redirect: 'https://other.example/list' }, 'other.example/list': page(table(HEADS, ROWS)) });
  try {
    const real = t.core.modules.api('search'); const asked = [];
    const search = { ...real, readHtml: (u, o) => { asked.push(u); return real.readHtml(u, o); } };
    const opts = () => ({ search, robots: new Map(), site: 'ev.example' });
    const p = await readHtml(hook.fetch, 'https://ev.example/list', opts());
    assert.match(p.html, /<td>Asha N<\/td>/); assert.equal(p.title, 'Who is coming');
    assert.deepEqual(asked, ['https://ev.example/list'], 'the page is read through Search');
    await assert.rejects(readHtml(hook.fetch, 'https://ev.example/hop', opts()), (e) => e.code === 'robots');
    assert.ok(!site.seen.some(s => s.path === '/private/list'), 'the page robots.txt forbids is not asked for');
    await assert.rejects(readHtml(hook.fetch, 'https://ev.example/away', opts()), (e) => e.code === 'offsite');
    assert.ok(!site.seen.some(s => s.host === 'other.example'), 'nothing is sent to another site');
    t.core.settings.set('online', false);
    await assert.rejects(readHtml(hook.fetch, 'https://ev.example/list', opts()), (e) => e.code === 'offline', 'Search says Offline');
  } finally { await close(); }
});
