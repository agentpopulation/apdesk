// The refusal for an address on this PC or the home network points at a control that exists, and the control works.
import test from 'node:test'; import assert from 'node:assert/strict';
import { checkUrl } from './guard.js';

class El {
  constructor(tag, attrs = {}, kids = []) { this.tag = tag; this.attrs = {}; this.kids = []; this.value = ''; this.listeners = {}; for (const [k, v] of Object.entries(attrs || {})) if (v != null) this.attrs[k] = v; this.append(kids); }
  append(...k) { for (const c of k.flat(Infinity)) if (c != null && c !== false && c !== '') this.kids.push(c); }
  replaceChildren(...k) { this.kids = []; this.append(...k); }
  addEventListener(t, f) { this.listeners[t] = f; }
}
const text = (n) => (typeof n === 'string' ? n : n instanceof El ? n.kids.map(text).join(' ') : '');
const all = (n, f, out = []) => { if (n instanceof El) { if (f(n)) out.push(n); n.kids.forEach((k) => all(k, f, out)); } return out; };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  const calls = []; const toasts = []; let hosts = ['router.local'];
  const api = async (url, o = {}) => {
    calls.push({ url, method: o.method, body: o.body });
    if (url.endsWith('/info')) return { allowHosts: hosts };
    if (url.endsWith('/allow-host')) { hosts = o.body.allow === false ? hosts.filter(x => x !== o.body.host) : [...hosts, o.body.host]; return { allowHosts: hosts }; }
    return {};
  };
  const h = (tag, attrs, ...kids) => { if (attrs instanceof El || typeof attrs === 'string' || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; } return new El(tag, attrs, kids); };
  const ui = { h, api, toast: (t) => toasts.push(t), btn: (t, { onClick, ...rest } = {}) => Object.assign(new El('button', rest, [t]), { onClick }) };
  const { allowedAddresses } = await import('./ui.js');
  const box = allowedAddresses(ui); await tick();
  return { box, calls, toasts };
}

test('the refusal names a place that exists, and that place is on the Computer tab', async () => {
  const msg = checkUrl('http://192.168.1.20/', { allowHosts: [] });
  assert.match(msg, /Pages on your own network/);
  const { box } = await setup();
  assert.match(text(box), /Pages on your own network/);
});

test('the list shows what is allowed; Allow sends the address; Remove takes it back', async () => {
  const { box, calls } = await setup();
  assert.match(text(box), /router\.local/);
  const input = all(box, n => n.tag === 'input')[0]; input.value = 'printer.local';
  all(box, n => n.tag === 'button' && text(n) === 'Allow')[0].onClick(); await tick(); await tick();
  assert.deepEqual(calls.at(-1).body, { host: 'printer.local', allow: true });
  assert.match(text(box), /printer\.local/); assert.equal(input.value, '');
  all(box, n => n.tag === 'button' && n.attrs['aria-label'] === 'Stop allowing router.local')[0].onClick(); await tick(); await tick();
  assert.deepEqual(calls.at(-1).body, { host: 'router.local', allow: false });
  assert.doesNotMatch(text(box), /router\.local/);
});

test('an empty box answers with a plain reason and sends nothing', async () => {
  const { box, calls, toasts } = await setup();
  const before = calls.length;
  await all(box, n => n.tag === 'button' && text(n) === 'Allow')[0].onClick();
  assert.equal(calls.length, before); assert.deepEqual(toasts, ['Type the address first.']);
});
