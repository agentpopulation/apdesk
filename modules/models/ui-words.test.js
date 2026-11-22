// What the Models page says when a provider cannot be reached, and where Ollama sits when it is not running.
// Runs the real page code on a small stand-in page (no browser, no desk).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { failKind, keyChipWords } from './ui.js';

test('only a real refusal is called refused; an unreachable provider says so', () => {
  const key = (error, extra = {}) => ({ enabled: true, test: { ok: false, error }, ...extra });
  assert.deepEqual(keyChipWords([key('Nothing answers at this address.')]), ['Could not be reached', 'wait']);
  assert.deepEqual(keyChipWords([key('No answer within 8.0 seconds.')]), ['Could not be reached', 'wait']);
  assert.deepEqual(keyChipWords([key('fetch failed')]), ['Could not be reached', 'wait']);
  assert.deepEqual(keyChipWords([key('connect ECONNREFUSED 1.2.3.4:443')]), ['Could not be reached', 'wait']);
  assert.deepEqual(keyChipWords([key('Groq refused the key (not valid or not allowed).')]), ['Key refused', 'stop']);
  assert.deepEqual(keyChipWords([key('The key was refused (not valid or not allowed).')]), ['Key refused', 'stop']);
  assert.deepEqual(keyChipWords([key('Too many requests right now. Try again in a minute.')]), ['1 key', '']);
  assert.deepEqual(keyChipWords([key('Nothing answers at this address.'), key('refused the key')]), ['2 keys', '']);
  assert.deepEqual(keyChipWords([{ enabled: true, test: { ok: false, skipped: true, error: 'Not tested: the desk is offline.' } }]), ['1 key', '']);
  assert.deepEqual(keyChipWords([]), ['No key', '']);
  assert.equal(failKind({ ok: true }), null);
});

test('the desk\'s own failure kind decides: not online and a broken connection are could-not-reach; a cooling key is not refused', () => {
  assert.equal(failKind({ ok: false, error: 'This PC is not online. Local models still work.' }), 'unreached');
  assert.equal(failKind({ ok: false, error: 'The connection broke. Try again.' }), 'unreached');
  assert.equal(failKind({ ok: false, error: 'Not available: no working key, or the key was refused recently and is cooling down.' }), 'other');
  assert.equal(failKind({ ok: false, error: 'Some line the page does not know.', why: 'not_online' }), 'unreached');
  assert.equal(failKind({ ok: false, error: 'Some line the page does not know.', code: 'offline' }), 'unreached');
  assert.equal(failKind({ ok: false, error: 'Some line the page does not know.', why: 'refused' }), 'refused');
  assert.equal(failKind({ ok: false, error: 'The provider refused the request. Check the key in Models.', why: 'busy' }), 'other', 'the kind wins over the words');
});

const ACTIVE = (ollama) => [
  { provider: 'router', kind: 'router', label: 'Free API', ok: true, builtin: true, models: ['m'] },
  { provider: 'groq', kind: 'keyed', label: 'Groq', ok: true, keys: 1, model: 'm', test: { ok: false, error: 'Nothing answers at this address.' } },
  { provider: 'ollama', kind: 'local', label: 'Ollama', ok: ollama, models: ollama ? ['qwen3:8b'] : [], model: ollama ? 'qwen3:8b' : null },
];
async function page(ollamaUp, extra = {}) {
  const { document, window } = parseHTML('<!doctype html><html><head></head><body><div id="root"></div><div id="toasts"></div><div id="modal" hidden></div></body></html>');
  Object.assign(globalThis, { document, Node: window.Node });
  Object.defineProperty(globalThis, 'window', { value: { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} }, configurable: true, writable: true });
  const kit = await import('../../app/ui/kit.js');
  const router = { enabled: true, mode: 'builtin', shortName: 'Free API', name: 'Free API', models: ['m'], upstreams: [{ id: 'a', enabled: true }], line: '' };
  const answers = {
    'm/models/overview': { online: true, active: ACTIVE(ollamaUp), router, providers: [{ id: 'groq', name: 'Groq', tier: 'free-signup', keys: [{ id: 'k1', enabled: true, test: { ok: false, error: 'Nothing answers at this address.' } }] }], testAll: null },
    'm/models/services': { services: [], many: false },
    'm/models/ollama': { ok: ollamaUp, line: 'Not running.', models: [] },
    ...extra,
  };
  const ui = { ...kit, state: { settings: {}, agents: [], modules: [] }, on() {}, moduleOn: () => false, announce: () => () => {},
    api: async (p) => { if (p in answers) return structuredClone(answers[p]); if (p === 'm/models/available') return { groups: [] }; if (p.startsWith('m/models/catalog')) return { models: [] }; throw new Error('stand-in: ' + p); } };
  const { pages } = await import('./ui.js');
  const el = document.getElementById('root');
  await pages.models.render(el, ui);
  await new Promise(r => setTimeout(r, 30));
  return el;
}

test('Ollama not running is not under Active now; it is offered with the ways to add a model, with how to get it', async () => {
  const el = await page(false);
  const active = el.querySelector('[data-apd=active-cards]').textContent;
  assert.doesNotMatch(active, /Ollama/); assert.doesNotMatch(active, /Start Ollama/);
  const offer = el.querySelector('[data-apd=ollama-offer]');
  assert.ok(offer, 'offered with the other ways to add a model');
  assert.match(offer.textContent, /Optional/); assert.match(offer.textContent, /How to get it/);
});

test('Ollama that answers is under Active now and not offered again', async () => {
  const el = await page(true);
  assert.match(el.querySelector('[data-apd=active-cards]').textContent, /Ollama/);
  assert.equal(el.querySelector('[data-apd=ollama-offer]'), null);
});

test('a key whose test could not reach the provider reads "Could not be reached" on its row', async () => {
  const el = await page(false);
  const row = el.querySelector('[data-apd=provider-row]');
  assert.match(row.textContent, /Could not be reached/); assert.doesNotMatch(row.textContent, /Key refused/);
});

test('the Active now card and the provider detail say "Could not be reached" too, so one key has one story', async () => {
  const el = await page(false);
  assert.match(el.querySelector('[data-apd=active-card][data-provider=groq]')?.textContent || '', /Could not be reached/);
});

test('a free model skipped because this PC is not online says so, not busy', async () => {
  const router = { enabled: true, mode: 'builtin', shortName: 'Free API', name: 'Free API', models: ['m'], line: '', builtin: true,
    upstreams: [{ id: 'a', name: 'Host A', enabled: true, models: ['m1'], limit: 'small', terms: 'kept a day' }], cooling: { a: { m1: { why: 'not_online', until: '2026-11-22T10:00:00Z' } } } };
  const el = await page(true, { 'm/models/router': { ...router, baseUrl: 'http://127.0.0.1:8787/v1', raw: router.upstreams, ownerAnswers: false, tests: {} } });
  [...el.querySelectorAll('button')].find(b => b.textContent.trim() === 'Router')?.click();
  await new Promise(r => setTimeout(r, 30));
  assert.match(el.textContent, /m1 \(not reached: this PC is not online\)/);
  assert.doesNotMatch(el.textContent, /m1 \(busy/);
});

test('a key box is offered only for a service this version uses, unless a key is already saved', async () => {
  const svc = (id, built, hasKey) => ({ id, kind: 'audio', name: id, built, hasKey, keys: hasKey ? [{ id: id + '-k', enabled: true, label: 'k', created: '2026-11-20T10:00:00Z' }] : [], enabled: hasKey });
  const el = await page(true, { 'm/models/services': { services: [svc('elevenlabs', true, false), svc('deepgram', false, false), svc('cartesia', false, true)], many: false } });
  const names = [...el.querySelectorAll('[data-apd=provider-row]')].map(r => r.textContent);
  assert.ok(names.some(n => /elevenlabs/.test(n)));
  assert.ok(!names.some(n => /deepgram/.test(n)), 'no box for a service nothing uses');
  assert.ok(names.some(n => /cartesia/.test(n)), 'a saved key can still be seen and removed');
});
