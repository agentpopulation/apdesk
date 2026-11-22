// Service keys (search, reading, voice): several labelled keys per service, the next one used when one is refused or out
// of allowance, and a Test per key that makes one small call of that service. Plumbing only, against a stand-in fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openStorage } from '../app/core/storage.js';
import { ServiceKeys } from '../app/core/service-keys.js';

function store(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-svk-'));
  const storage = openStorage(dir, null, { memory: true });
  const events = []; const keys = new ServiceKeys({ storage, events: { emit: (t, d) => events.push([t, d]) }, env });
  return { keys, events, close: () => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
/** A stand-in for the service: answers each call with the status the test gives for that key value. */
function standIn(byKey) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const h = init.headers || {}; calls.push({ url: String(url), method: init.method || 'GET', headers: h, body: init.body ? JSON.parse(init.body) : null });
    const value = Object.values(h).map(String).map(v => v.replace(/^(Bearer|Token) /, '')).find(v => v in byKey);
    const st = byKey[value] ?? 401;
    if (st === 'offline') throw Object.assign(new Error('The desk is offline.'), { code: 'offline' });
    return new Response(JSON.stringify({ ok: st === 200 }), { status: st, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

test('several labelled keys per service; values never listed; the old single key slot keeps working', () => {
  const s = store();
  try {
    const a = s.keys.add('serper', 'serper-work-key-123456', 'Work');
    const b = s.keys.add('serper', 'serper-home-key-654321', 'Home');
    assert.notEqual(a.id, b.id);
    const keys = s.keys.keys('serper');
    assert.deepEqual(keys.map(k => k.label), ['Work', 'Home']);
    assert.ok(keys.every(k => k.created && k.enabled && !('value' in k)));
    assert.doesNotMatch(JSON.stringify(s.keys.list()), /serper-work-key-123456|serper-home-key-654321/);
    assert.equal(s.keys.list().find(x => x.id === 'serper').keys.length, 2);
    assert.equal(s.keys.get('serper'), 'serper-work-key-123456', 'the first key is used first');
    assert.throws(() => s.keys.add('serper', 'serper-work-key-123456', 'Again'), /saved already/);
    assert.throws(() => s.keys.add('serper', 'short', 'x'), /too short/);
    // the single slot (Settings > Keys, the Page reading card) replaces only its own key, never the labelled ones
    s.keys.set('serper', 'serper-slot-key-000000'); s.keys.set('serper', 'serper-slot-key-111111');
    assert.equal(s.keys.keys('serper').length, 3);
    assert.equal(s.keys.get('serper'), 'serper-slot-key-111111', 'the slot key (Settings) is the one in use');
    s.keys.toggleKey(s.keys.keys('serper')[0].id, false);
    assert.equal(s.keys.get('serper'), 'serper-work-key-123456', 'a key switched off is skipped');
    s.keys.toggleKey(a.id, false);
    assert.equal(s.keys.get('serper'), 'serper-home-key-654321');
    s.keys.removeKey(b.id);
    assert.equal(s.keys.get('serper'), null, 'every key switched off or gone: none');
    s.keys.toggle('serper', false); assert.equal(s.keys.get('serper'), null, 'the service switch turns every key off');
    s.keys.remove('serper'); assert.equal(s.keys.keys('serper').length, 0);
  } finally { s.close(); }
});

test('a key that is refused or out of allowance is skipped: the next key is used; a passing test brings it back', async () => {
  const s = store();
  try {
    const a = s.keys.add('tavily', 'tvly-first-key-1234', 'First');
    s.keys.add('tavily', 'tvly-second-key-5678', 'Second');
    // the module that used a key can say it ran out: the next one is used
    assert.equal(s.keys.report('tavily', 'allowance'), true);
    assert.equal(s.keys.get('tavily'), 'tvly-second-key-5678');
    assert.equal(s.keys.keys('tavily')[0].resting, 'allowance');
    const svc = standIn({ 'tvly-first-key-1234': 401, 'tvly-second-key-5678': 200 });
    const r = await s.keys.test('tavily', a.id, { fetch: svc.fetch });
    assert.equal(r.ok, false); assert.match(r.error, /refused/);
    assert.equal(s.keys.get('tavily'), 'tvly-second-key-5678', 'the refused key is skipped');
    assert.equal(s.keys.keys('tavily')[0].test.ok, false, 'the result is kept on the key row');
    assert.equal(s.keys.keys('tavily')[0].resting, 'refused');
    assert.match(s.keys.keys('tavily')[0].test.at, /^\d{4}-/);
    const svc2 = standIn({ 'tvly-first-key-1234': 200 });
    const ok = await s.keys.test('tavily', a.id, { fetch: svc2.fetch });
    assert.equal(ok.ok, true); assert.ok(ok.ms >= 0);
    assert.equal(s.keys.get('tavily'), 'tvly-first-key-1234', 'a key that works again is used first again');
    const out = await s.keys.test('tavily', a.id, { fetch: standIn({ 'tvly-first-key-1234': 429 }).fetch });
    assert.match(out.error, /allowance|too many/i);
    assert.equal(s.keys.get('tavily'), 'tvly-second-key-5678');
  } finally { s.close(); }
});

test('each service is tested with one small real call of that service, sending the key the way the service reads it', async () => {
  const s = store();
  try {
    const cat = s.keys.catalog().services;
    for (const [id, def] of Object.entries(cat)) {
      assert.ok(def.test?.url?.startsWith('https://'), `${id} has a test call`);
      assert.ok(def.test.spends, `${id} says what a test spends`);
      const value = `${id}-stand-in-key-12345`;
      const k = s.keys.add(id, value, 'Mine');
      const svc = standIn({ [value]: 200 });
      const r = await s.keys.test(id, k.id, { fetch: svc.fetch });
      assert.equal(r.ok, true, id); assert.equal(svc.calls.length, 1, `${id}: one call`);
      const sent = Object.entries(svc.calls[0].headers).find(([, v]) => String(v).includes(value));
      assert.ok(sent, `${id}: the key goes in a header`); assert.equal(sent[0].toLowerCase(), def.header.toLowerCase());
    }
    const serper = standIn({ 'serper-stand-in-key-12345': 200 });
    await s.keys.test('serper', s.keys.keys('serper')[0].id, { fetch: serper.fetch });
    assert.equal(serper.calls[0].body.num, 1, 'a search test asks for one result only');
  } finally { s.close(); }
});

test('offline or after Panic, a test is skipped with the reason and the key is not marked bad', async () => {
  const s = store();
  try {
    const k = s.keys.add('exa', 'exa-key-abcdefgh12', 'Mine');
    const r = await s.keys.test('exa', k.id, { fetch: standIn({ 'exa-key-abcdefgh12': 'offline' }).fetch });
    assert.equal(r.ok, false); assert.equal(r.skipped, true); assert.match(r.error, /offline/i);
    assert.equal(s.keys.get('exa'), 'exa-key-abcdefgh12');
    await assert.rejects(() => s.keys.test('exa', 'svk_nope', { fetch: standIn({}).fetch }), /gone/);
  } finally { s.close(); }
});

test('a key from the environment still counts, and a module facade offers the key work without any value', () => {
  const s = store({ SERPER_API_KEY: 'env-serper-key-123456' });
  try {
    assert.equal(s.keys.get('serper'), 'env-serper-key-123456');
    const f = s.keys.forModule({ fetch: async () => new Response('{}') });
    assert.deepEqual(Object.keys(f).sort(), ['add', 'keys', 'list', 'removeKey', 'report', 'test', 'toggleKey']);
    assert.ok(f.list().find(x => x.id === 'serper').fromEnvironment);
    assert.doesNotMatch(JSON.stringify(f.list()), /env-serper-key-123456/);
  } finally { s.close(); }
});

test('the single key slot replaces the key in use: the new key is handed out first, and a value saved already is not stored twice', () => {
  const s = store();
  try {
    s.keys.add('tavily', 'tvly-old-bad-key-0001', 'Mine');
    s.keys.set('tavily', 'tvly-new-good-key-0002');
    assert.equal(s.keys.get('tavily'), 'tvly-new-good-key-0002', 'Replace the key in Settings: the new key is the one used');
    assert.deepEqual(s.keys.keys('tavily').map(k => k.label), ['Tavily', 'Mine'], 'the replacing key is listed first, the labelled one stays as the next key');
    s.keys.set('tavily', 'tvly-old-bad-key-0001');
    assert.equal(s.keys.keys('tavily').length, 1, 'saving a value that is saved already keeps one copy of it');
    assert.equal(s.keys.get('tavily'), 'tvly-old-bad-key-0001');
  } finally { s.close(); }
});
