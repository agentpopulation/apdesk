// The Bench settings card on a real desk, in a small fake page: a cap or limit box saves only a number it can keep.
// An empty box or a typo is refused beside the box, the old value stays, and "Saved." shows only after the desk saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { testDesk } from '../../test/helpers/desk.js';

const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="toasts"></div><div id="modal" hidden></div></body></html>');
globalThis.document = document; globalThis.Node = window.Node; globalThis.Event = window.Event;
const kit = await import('../../app/ui/kit.js');
const { settings } = await import('./ui.js');
const tick = () => new Promise((r) => setTimeout(r, 20));

async function page() {
  const t = await testDesk({ modules: ['bench', 'chat', 'search', 'memory', 'agents'] });
  await t.core.modules.set('bench', true);
  const fetch0 = globalThis.fetch;
  globalThis.fetch = (u, o) => fetch0(String(u).startsWith('/') ? t.base + u : u, o);
  kit.setSession(t.desk.session);
  await t.call('/api/m/bench/spendgate', { body: { option: 'paid' } });
  await t.call('/api/m/bench/spendgate', { body: { capDayMinor: 50000 } });
  const el = document.createElement('div'); document.body.append(el);
  const toasts = [];
  const ui = { ...kit, toast: (x, k) => { toasts.push([kit.plainError(x), k]); } };
  await settings.bench.render(el, ui);
  const box = (label) => el.querySelector(`input[aria-label^="${label}"]`);
  const change = async (f, v) => { f.value = v; f.dispatchEvent(new window.Event('change')); await tick(); await tick(); };
  const gate = async () => (await t.call('/api/m/bench/state')).json.gate;
  return { t, el, ui, toasts, box, change, gate, async close() { globalThis.fetch = fetch0; el.remove(); await t.close(); } };
}

test('Bench cap: a cleared box keeps the cap, says why beside the box, and never says Saved', async () => {
  const p = await page();
  try {
    const day = p.box('Per day cap');
    assert.equal(day.value, '500');
    for (const typed of ['', '  ', '-3']) {
      await p.change(day, typed);
      assert.equal((await p.gate()).capDayMinor, 50000, `"${typed}" did not turn the cap off`);
      assert.equal(day.value, '500', 'the old value is back in the box');
      assert.match(day.nextSibling?.textContent || '', /0 or more/, 'the reason is beside the box');
      assert.equal(p.toasts.filter(([w]) => w === 'Saved.').length, 0);
    }
    await p.change(p.box('Per day cap'), '20');
    assert.equal((await p.gate()).capDayMinor, 2000);
    assert.deepEqual(p.toasts.at(-1), ['Saved.', 'ok'], 'a real save says so');
    await p.change(p.box('Steps limit'), '0');
    assert.equal((await p.gate()).limits.steps, 140, 'a limit below 1 is refused');
    assert.match(p.box('Steps limit').nextSibling?.textContent || '', /1 or more/);
  } finally { await p.close(); }
});
