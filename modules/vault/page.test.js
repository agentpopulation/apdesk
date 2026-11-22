// Settings > Keys and logins on a real desk, in a small fake page: a service no part of this version uses gets no key box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { testDesk } from '../../test/helpers/desk.js';

const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="toasts"></div><div id="modal" hidden></div></body></html>');
globalThis.document = document; globalThis.Node = window.Node;
const kit = await import('../../app/ui/kit.js');
const { settings } = await import('./ui.js');

test('no key box for Deepgram, Cartesia or AssemblyAI; ElevenLabs keeps its box', async () => {
  const t = await testDesk({ modules: ['vault'] });
  const fetch0 = globalThis.fetch;
  globalThis.fetch = (u, o) => fetch0(String(u).startsWith('/') ? t.base + u : u, o);
  kit.setSession(t.desk.session);
  try {
    await t.core.modules.set('vault', true);
    const listed = (await t.call('/api/keys/services')).json.services;
    assert.equal(listed.find(x => x.id === 'deepgram')?.built, false, 'the desk marks it as not used by this version');
    const el = document.createElement('div'); document.body.append(el);
    await settings.keys.render(el, { ...kit, state: { settings: {}, agents: [] }, on: () => {}, go: () => {} });
    await new Promise(r => setTimeout(r, 100));
    const words = el.textContent;
    assert.match(words, /ElevenLabs/);
    assert.doesNotMatch(words, /Deepgram|Cartesia|AssemblyAI/);
    el.remove();
  } finally { globalThis.fetch = fetch0; await t.close(); }
});
