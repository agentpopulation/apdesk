// The Network page shell: view switch, remembered choice, Split layout and the link between both sides. Runs the real
// page code on a small stand-in page (no browser, no desk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const DESK = {
  at: 'x',
  states: [{ id: 'a', name: 'Scout', role: '', state: 'working', doing: 'Find venues' }],
  deps: {
    agents: [{ id: 'a', name: 'Scout', calls: 2, affected: false }],
    providers: [{ provider: 'groq', label: 'Groq', calls: 2, health: null, down: false }],
    edges: [{ agentId: 'a', provider: 'groq', count: 2 }],
    table: [{ agent: 'Scout', provider: 'Groq', calls: 2, down: false, health: null }],
    visits: [],
  },
};

async function mount(stored) {
  const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  const store = new Map(stored ? [['apd-network-view', stored]] : []);
  const set = { document, requestAnimationFrame: (f) => f(), localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) } };
  for (const [k, v] of Object.entries(set)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'onclick') e.addEventListener('click', v); else e.setAttribute(k, v === true ? '' : String(v)); }
    e.append(...kids.flat(5).filter(x => x != null && x !== false).map(x => (typeof x === 'object' ? x : document.createTextNode(String(x)))));
    return e;
  };
  const ui = {
    h, state: { settings: {} }, go() {}, on: () => () => {},
    api: async (p) => { if (p === 'm/network/desk') return DESK; throw new Error('stand-in: ' + p); },
    card: (...c) => h('section', { class: 'card' }, ...c),
    btn: (t, o = {}) => h('button', { type: 'button', onclick: o.onClick }, t),
    pill: (t) => h('span', null, t), toast() {}, fmt: { time: String, date: String }, empty: () => h('p'), line: () => h('div'),
    table: (cols, rows) => h('table', null, h('thead', null, h('tr', null, cols.map(c => h('th', null, c.label)))), h('tbody', null, rows.map(r => h('tr', null, cols.map(c => h('td', null, c.render ? c.render(r) : r[c.key])))))),
  };
  const { pages } = await import('./ui.js');
  const el = document.getElementById('root');
  await pages.network.render(el, ui, { parts: [] });
  await new Promise(r => setTimeout(r, 20));
  return { el, store, document, window };
}
const pressed = (el) => [...el.querySelectorAll('.netp-views button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent);

test('view: with nothing remembered the page opens on Link and shows no Desk side', async () => {
  const { el } = await mount();
  assert.deepEqual(pressed(el), ['Link']);
  assert.ok(el.querySelector('.netp-main.link')); assert.equal(el.querySelector('.netp-desk'), null);
});

test('view: a bad stored value falls back to Link', async () => {
  const { el } = await mount('sideways');
  assert.deepEqual(pressed(el), ['Link']);
});

test('view: choosing a view stores it under apd-network-view and the page redraws in it', async () => {
  const { el, store, window } = await mount();
  [...el.querySelectorAll('.netp-views button')].find(b => b.textContent === 'Split').dispatchEvent(new window.Event('click'));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(store.get('apd-network-view'), 'split');
  assert.deepEqual(pressed(el), ['Split']);
});

test('view: a remembered Desk view shows only the Desk side; Split shows both', async () => {
  const d = await mount('desk');
  assert.ok(d.el.querySelector('.netp-desk')); assert.equal(d.el.querySelector('.netp'), null);
  assert.ok(d.el.querySelector('[data-agent="a"]'), 'the agent is drawn');
  const s = await mount('split');
  assert.ok(s.el.querySelector('.netp-main.split .netp-desk')); assert.ok(s.el.querySelector('.netp-main.split .netp'));
});

test('desk table: a provider never checked reads Not checked, not Not failed', async () => {
  const { el } = await mount('desk');
  const rows = [...el.querySelectorAll('tbody tr')].map(r => r.textContent);
  assert.ok(rows.some(t => t.includes('Scout') && t.includes('Groq') && t.includes('Not checked')), rows.join('|'));
  assert.ok(!rows.some(t => t.includes('Not failed')));
});

test('split: clicking a Link row that names a provider marks the Desk side and the matching rows; a row with no match changes nothing', async () => {
  const { el, window } = await mount('split');
  const body = el.querySelector('.netp-body');
  body.append(Object.assign(document.createElement('table'), { innerHTML: '<thead><tr><th>Speed</th></tr></thead><tbody><tr id="g"><td>Groq answered in 90 ms</td></tr><tr id="o"><td>Download 94.3 Mbit/s</td></tr></tbody>' }));
  const click = (n) => { const ev = new window.Event('click', { bubbles: true }); n.dispatchEvent(ev); };
  click(body.querySelector('#g td'));
  assert.match(el.querySelector('.netp-desk').textContent, /Marked: Groq/);
  assert.ok(el.querySelector('.netp-desk [data-agent="a"]').getAttribute('class')?.includes('hl-agent') || [...el.querySelectorAll('.netp-desk [data-agent]')].some(n => (n.getAttribute('class') || '').includes('hl-agent')), 'caller agent marked');
  assert.ok((body.querySelector('#g').getAttribute('class') || '').includes('hl'));
  click(body.querySelector('#o td'));
  assert.match(el.querySelector('.netp-desk').textContent, /Marked: Groq/, 'a row with a number only keeps the mark');
  click(body.querySelector('thead th'));
  assert.match(el.querySelector('.netp-desk').textContent, /Marked: Groq/, 'a header row keeps the mark');
  click(body.querySelector('#g td'));
  assert.doesNotMatch(el.querySelector('.netp-desk').textContent, /Marked:/, 'the same row again clears it');
});
