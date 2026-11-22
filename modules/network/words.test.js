// Plain words on the Network page: no loopback address in a sentence, a plural that reads right, the phone box tells the truth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

test('the Desk and models rows say "on this PC", never a raw loopback address', async () => {
  const t = await testDesk({ modules: ['network'] });
  try {
    await t.call('/api/modules/network/on', { method: 'POST' });
    t.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:9');
    const rows = (await t.call('/api/m/network/connection')).json.rows;
    const text = rows.map(r => `${r.name}: ${r.detail}`).join('\n');
    assert.doesNotMatch(text, /127\.0\.0\.1|localhost|:11434|:8787|:9\b/);
    assert.match(rows.find(r => r.name === 'Ollama').detail, /Not running on this PC/);
  } finally { await t.close(); }
});

import { parseHTML } from 'linkedom';
const { phoneOption, todayIn } = await import('./ui.js');
const mk = (moduleOn) => {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  const h = (tag, attrs, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'onchange') e.addEventListener('change', v); else if (typeof v !== 'object') e.setAttribute(k, v === true ? '' : String(v)); } e.append(...kids.flat(5).filter(x => x != null && x !== false).map(x => typeof x === 'object' ? x : document.createTextNode(String(x)))); return e; };
  return { h, moduleOn: () => moduleOn };
};

test('"Also tell my phone" is not offered as working while phone pushes are off: switched off, with where to turn them on', () => {
  const off = phoneOption(mk(true), { pushOn: false, onChange() {} });
  assert.ok(off.querySelector('input[disabled]'), 'the box is switched off');
  assert.match(off.textContent, /switched off/); assert.match(off.textContent, /Settings, under Channels and mail/);
  assert.equal(phoneOption(mk(false), { pushOn: true, onChange() {} }), null, 'Channels off: not offered at all');
  const on = phoneOption(mk(true), { pushOn: true, onChange() {} });
  assert.equal(on.querySelector('input[disabled]'), null); assert.match(on.textContent, /Also tell my phone/); assert.doesNotMatch(on.textContent, /switched off/);
});

test('today is read in the owner\'s zone, not UTC', () => {
  const now = Date.now();
  assert.equal(todayIn('Pacific/Kiritimati'), new Date(now + 14 * 3600e3).toISOString().slice(0, 10));
  assert.equal(todayIn('Not/AZone'), new Date().toLocaleDateString('en-CA'));
});
