// "Pages on your own network" on a real desk, in a small fake page: the tick says Allowed only when the address was kept,
// the address kept is the one the browser guard reads, and a refusal says why beside the box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { testDesk } from '../../test/helpers/desk.js';
import { checkUrl } from './guard.js';

const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="toasts"></div><div id="modal" hidden></div></body></html>');
globalThis.document = document; globalThis.Node = window.Node;
const kit = await import('../../app/ui/kit.js');
const { allowedAddresses } = await import('./ui.js');
const tick = () => new Promise((r) => setTimeout(r, 20));

test('Allow keeps only an address the guard can use, and the tick tells the truth', async () => {
  const t = await testDesk({ modules: ['browser'] });
  await t.core.modules.set('browser', true);
  const fetch0 = globalThis.fetch;
  globalThis.fetch = (u, o) => fetch0(String(u).startsWith('/') ? t.base + u : u, o);
  kit.setSession(t.desk.session);
  try {
    const box = allowedAddresses({ ...kit }); document.body.append(box); await tick();
    const input = box.querySelector('input'); const allow = [...box.querySelectorAll('button')].find(b => b.textContent === 'Allow');
    const mark = box.querySelector('.saved');
    const press = async (v) => { input.value = v; allow.click(); await tick(); await tick(); };
    const listed = () => [...box.querySelectorAll('[data-allowed]')].map(r => r.dataset.allowed);

    await press('http://');
    assert.deepEqual(listed(), []);
    assert.notEqual(mark.dataset.saved, 'ok', 'no tick for an address that saved nothing');
    assert.match(mark.textContent, /Not saved: Type an address/);
    assert.equal(input.value, 'http://', 'what was typed stays to be corrected');

    await press('[fd00::1]:80');
    assert.deepEqual(listed(), ['fd00::1']);
    assert.equal(mark.dataset.saved, 'ok'); assert.equal(mark.title, 'Allowed');
    assert.equal(checkUrl('http://[fd00::1]:80/', { allowHosts: listed() }), null, 'the guard now lets that page through');

    await press('example.com');
    assert.deepEqual(listed(), ['fd00::1']);
    assert.match(mark.textContent, /not on this PC or your home network/);

    input.value = ''; allow.click(); await tick();
    assert.equal(input.nextSibling?.textContent, 'Type the address first.', 'an empty box is answered beside the box');

    // Remove takes out what is listed, and says so only when something was there
    const kv = await t.call('/api/m/browser/allow-host', { body: { host: 'fd00::1', allow: false } });
    assert.deepEqual(kv.json.allowHosts, []);
    const gone = await t.call('/api/m/browser/allow-host', { body: { host: 'printer.local', allow: false } });
    assert.equal(gone.status, 404, 'removing what is not there is not "Removed"');
  } finally { globalThis.fetch = fetch0; await t.close(); }
});
