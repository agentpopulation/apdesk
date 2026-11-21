// The three new sections of the Network page render from stand-in answers (no browser, no desk): registrar
// history, the route with operators and the change, and the places table without map dots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const ANSWERS = {
  'm/network/status': { agents: { online: 0, midTask: 0, idle: 0, error: 0 }, messagesPerMin: 3, queue: 0, openIssues: 0, newDevices: 0, heartbeat: null },
  'm/network/registrar': { every: 'off', source: 'RDAP', domains: [{ domain: 'mine.example', readings: 2, unavailableAt: null, latest: { at: 'x', registrar: 'New Registrar', nameservers: ['ns1.b.example'], status: ['active'], created: 'c', expires: 'e' }, timeline: [{ at: 'y', changes: [{ field: 'registrar', label: 'Registrar', old: 'Old Registrar', new: 'New Registrar' }] }] }] },
  'm/network/route': { targets: [{ target: 'mine.example', runs: [{ at: 'x', target: 'mine.example', address: '203.0.113.5', tool: 'traceroute', timedOut: false, diff: { changed: true, lines: [{ hop: 2, old: '198.51.100.1', new: '198.51.100.2' }] },
    hops: [{ hop: 1, ip: '192.168.1.1', ms: 0.5, public: false }, { hop: 2, ip: '198.51.100.2', ms: 9, public: true, operator: 'EXAMPLE-NET', asn: 64500 }, { hop: 3, ip: null, ms: null, public: false }] }] }] },
  'm/network/places': { dots: false, note: 'No map: test.', rows: [{ kind: 'Your public address', name: '203.0.113.7', address: '203.0.113.7', operator: 'EXAMPLE-NET', asn: 64500, country: 'IN' }, { kind: 'Your domain', name: 'mine.example', address: null, operator: null, country: null }] },
};
async function show(section) {
  const { document } = parseHTML('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  for (const [k, v] of Object.entries({ document, requestAnimationFrame: (f) => f(), localStorage: { getItem: () => null, setItem() {} } })) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false || typeof v === 'function' || typeof v === 'object') continue; e.setAttribute(k, v === true ? '' : String(v)); } e.append(...kids.flat(5).filter(x => x != null && x !== false).map(x => (typeof x === 'object' ? x : document.createTextNode(String(x))))); return e; };
  const ui = { h, state: { settings: {} }, go() {}, on: () => () => {}, moduleOn: () => false,
    api: async (p) => { if (p in ANSWERS) return ANSWERS[p]; throw new Error('stand-in: ' + p); },
    card: (...c) => h('section', { class: 'card' }, ...c), btn: (t) => h('button', { type: 'button' }, t), pill: (t) => h('span', null, t), toast() {},
    fmt: { time: String, date: String, when: String }, empty: (t) => h('p', null, t), line: (a, b) => h('div', null, a, ' ', b),
    table: (cols, rows, o = {}) => rows.length ? h('table', null, h('tbody', null, rows.map(r => h('tr', null, cols.map(c => h('td', null, c.render ? c.render(r) : r[c.key])))))) : h('p', null, o.empty || '') };
  const { pages } = await import('./ui.js');
  const el = document.getElementById('root');
  await pages.network.render(el, ui, { parts: [section] });
  await new Promise(r => setTimeout(r, 20));
  return el;
}

test('registrar history shows the latest reading and what changed', async () => {
  const t = (await show('registrar')).querySelector('.netp-body').textContent;
  assert.match(t, /Registrar history/); assert.match(t, /New Registrar/); assert.match(t, /What changed/); assert.match(t, /Old Registrar/);
});

test('route shows each hop with time and operator, the own network, a silent hop and the change', async () => {
  const el = await show('route');
  const rows = [...el.querySelectorAll('.netp-body tr')].map(r => r.textContent);
  assert.ok(rows.some(r => r.includes('192.168.1.1') && r.includes('Your own network')));
  assert.ok(rows.some(r => r.includes('198.51.100.2') && r.includes('9 ms') && r.includes('EXAMPLE-NET (AS64500)')));
  assert.ok(rows.some(r => r.includes('No answer')));
  assert.match(el.textContent, /hop 2 198\.51\.100\.1 → 198\.51\.100\.2/);
});

test('places is a plain table with no map dots; an unknown country says so; the strip shows the message count', async () => {
  const el = await show('places');
  assert.equal(el.querySelector('.netp-body svg'), null, 'no map without a fitting location source');
  const rows = [...el.querySelectorAll('.netp-body tr')].map(r => r.textContent);
  assert.ok(rows[0].includes('Country: IN')); assert.ok(rows[1].includes('Country not known'));
  assert.match(el.querySelector('.netp-strip').textContent, /3msgs\/min/);
});
