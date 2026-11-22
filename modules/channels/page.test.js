// Settings > Channels on a real desk, in a small fake page: every press answers back truthfully. Remove says
// "Token removed." only when the desk removed it; a refused address shows its reason beside the box and keeps the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { testDesk } from '../../test/helpers/desk.js';

const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="toasts"></div><div id="modal" hidden></div></body></html>');
globalThis.document = document; globalThis.Node = window.Node;
const kit = await import('../../app/ui/kit.js');
const { settings } = await import('./ui.js');
const tick = () => new Promise((r) => setTimeout(r, 30));

test('Telegram Remove and the address box tell the truth', async () => {
  const t = await testDesk({ modules: ['channels'] });
  const fetch0 = globalThis.fetch;
  globalThis.fetch = (u, o) => fetch0(String(u).startsWith('/') ? t.base + u : u, o);
  kit.setSession(t.desk.session);
  const warn = console.warn; console.warn = () => {};
  try {
    await t.call('/api/modules/channels/on', { method: 'POST' });
    await t.call('/api/m/channels/telegram/settings', { body: { apiBase: 'http://127.0.0.1:1' } });   // nothing leaves this PC
    await t.call('/api/m/channels/telegram/token', { body: { token: '123456789:not-a-real-token-for-this-test' } });
    const toasts = [];
    const ui = { ...kit, state: { agents: t.core.agents.list() }, on: () => {}, confirm: async () => true, openApprovals: () => {}, toast: (x, k) => toasts.push([kit.plainError(x), k]) };
    const el = document.createElement('div'); document.body.append(el);
    await settings.channels.render(el, ui);
    const remove = () => [...el.querySelectorAll('button')].find(b => b.textContent === 'Remove');

    kit.setSession('');   // a window that is not the owner's: the desk refuses
    remove().click(); await tick(); await tick();
    kit.setSession(t.desk.session);
    assert.equal(toasts.filter(([w]) => w === 'Token removed.').length, 0, 'no "removed" after a refusal');
    assert.equal(toasts.at(-1)?.[1], 'err');
    assert.equal((await t.call('/api/m/channels/status')).json.telegram.hasToken, true);

    remove().click(); await tick(); await tick();
    assert.deepEqual(toasts.at(-1), ['Token removed.', 'ok']);
    assert.equal((await t.call('/api/m/channels/status')).json.telegram.hasToken, false);

    const addr = [...el.querySelectorAll('input')].find(i => i.value === 'http://127.0.0.1:1');
    addr.value = 'http://evil.example'; addr.dispatchEvent(new window.Event('change')); await tick(); await tick();
    assert.equal(addr.value, 'http://127.0.0.1:1', 'the old address is back');
    assert.match(addr.nextSibling?.textContent || '', /^Not saved: Use https/);
    assert.equal((await t.call('/api/m/channels/status')).json.telegram.apiBase, 'http://127.0.0.1:1');

    const agent = await t.call('/api/m/channels/telegram/settings', { body: { agentId: 'nobody-here' } });
    assert.equal(agent.status, 400, 'an agent that is not on the desk is refused, not "Saved"');
    el.remove();
  } finally { console.warn = warn; globalThis.fetch = fetch0; await t.close(); }
});
