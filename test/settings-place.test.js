// Where you are, spend limits and the plain settings route: only values the computer can use are stored, a bad one
// already stored is replaced at start, a role pick never switches a desk to another country, the spend limits fit the
// currency, and the keys that Offline lets through are the keeper's alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Settings, systemPlace, checkPlace, spendDefaults } from '../app/core/settings.js';
import { settingsRoutes } from '../app/core/settings-routes.js';
import { offlineAllowList, isLocalAddress, hostKey } from '../app/core/offline.js';
import { openStorage } from '../app/core/storage.js';
import { testDesk } from './helpers/desk.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apd-place-'));
const store = (dir, name) => openStorage(path.join(dir, name), path.join(dir, name + '-b'));
const US = { timeZone: 'America/New_York', locale: 'en-US' };

test('place: a mistyped zone, style, currency or country is refused with a plain reason, and nothing in that save is kept', async () => {
  const t = await testDesk();
  try {
    const before = (await t.call('/api/settings')).json;
    for (const [k, v] of [['timeZone', 'Pune'], ['timeZone', 'Mars/Base'], ['locale', 'xx_bad'], ['locale', 'en_GB'], ['currency', 'ZZZ'], ['currency', 'rupees'], ['country', 'India'], ['country', 'QQ']]) {
      const r = await t.call('/api/settings', { body: { ownerName: 'Changed', [k]: v } });
      assert.equal(r.status, 400, `${k}=${v} is refused`);
      assert.match(r.json.error, /not a (time zone|number and date style|currency|country) this computer knows\. Pick one from the list\./);
    }
    const after = (await t.call('/api/settings')).json;
    for (const k of ['timeZone', 'locale', 'currency', 'country', 'ownerName']) assert.equal(after[k], before[k], k + ' is unchanged');
    // good values are kept, in their usual spelling
    const ok = await t.call('/api/settings', { body: { timeZone: 'Europe/London', locale: 'en-gb', currency: 'gbp', country: 'gb' } });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.settings.timeZone, ok.json.settings.locale, ok.json.settings.currency, ok.json.settings.country], ['Europe/London', 'en-GB', 'GBP', 'GB']);
  } finally { await t.close(); }
});

test('place: a bad value already stored is replaced by the computer\'s own at start, and the owner is told once', () => {
  const dir = tmp();
  try {
    const st = store(dir, 'a');
    for (const [k, v] of [['timeZone', 'Pune'], ['locale', 'xx_bad'], ['currency', 'GBP']]) st.run('INSERT INTO settings (key, value) VALUES (?, ?)', k, JSON.stringify(v));
    const s = new Settings(st, { system: US });
    assert.equal(s.get('timeZone'), 'America/New_York'); assert.equal(s.get('locale'), 'en-US');
    assert.equal(s.get('currency'), 'GBP', 'a good stored value stays');
    assert.equal(s.stored('timeZone'), false);
    assert.match(s.get('ui.placeNotice'), /^Your time zone and number and date style were not one this computer knows, so the desk uses this computer's own: America\/New_York, en-US\. You can change it in Settings › General\.$/);
    // every value the desk now hands the screen works with Intl
    for (const k of ['timeZone', 'locale', 'currency', 'country']) assert.equal(checkPlace(k, s.get(k)).ok, true, k);
    assert.doesNotThrow(() => new Date().toLocaleTimeString(s.get('locale'), { timeZone: s.get('timeZone') }));
    // a desk with nothing wrong says nothing
    assert.equal(new Settings(store(dir, 'b'), { system: US }).get('ui.placeNotice'), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('place: a role pick and a restart keep the computer\'s country, currency and zone; only a desk made before keeps India', () => {
  const dir = tmp();
  const place = (s) => [s.get('country'), s.get('currency'), s.get('timeZone'), s.get('locale')];
  const put = (st, k, v) => st.run('INSERT INTO settings (key, value) VALUES (?, ?)', k, JSON.stringify(v));
  const INDIA = ['IN', 'INR', 'Asia/Kolkata', 'en-IN'];
  try {
    // a fresh desk on a US computer: the role picker stores onboarded, then the desk starts again
    const st = store(dir, 'fresh');
    const first = new Settings(st, { system: US });
    assert.deepEqual(place(first), ['US', 'USD', 'America/New_York', 'en-US']);
    first.set('role', 'sales'); first.set('onboarded', true);
    assert.deepEqual(place(new Settings(st, { system: US })), ['US', 'USD', 'America/New_York', 'en-US'], 'no switch to IN, INR, Kolkata');
    // a desk made by the released version: a role picked, step two never finished, first start of this version
    const rel = store(dir, 'rel'); put(rel, 'role', 'sales'); put(rel, 'onboarded', true);
    assert.deepEqual(place(new Settings(rel, { system: US })), ['US', 'USD', 'America/New_York', 'en-US']);
    // a released desk its own one-time step already switched to India (the four written at once): undone, and said once
    const hit = store(dir, 'hit'); put(hit, 'role', 'sales'); put(hit, 'onboarded', true);
    for (const [i, k] of ['country', 'currency', 'timeZone', 'locale'].entries()) put(hit, k, INDIA[i]);
    const h = new Settings(hit, { system: US });
    assert.deepEqual(place(h), ['US', 'USD', 'America/New_York', 'en-US']);
    assert.match(h.get('ui.placeNotice'), /^Your country, currency and time zone follow this computer again: United States, USD, America\/New_York\./);
    // ... on a computer in India the same desk stays in India
    const hitIn = store(dir, 'hit-in'); put(hitIn, 'onboarded', true);
    for (const [i, k] of ['country', 'currency', 'timeZone', 'locale'].entries()) put(hitIn, k, INDIA[i]);
    assert.deepEqual(place(new Settings(hitIn, { system: { timeZone: 'Asia/Kolkata', locale: 'en-US' } })), INDIA);
    // a desk the owner set to India by hand (one at a time, between other changes) stays in India
    const own = store(dir, 'own'); put(own, 'onboarded', true);
    put(own, 'country', 'IN'); put(own, 'ownerName', 'Asha'); put(own, 'currency', 'INR'); put(own, 'theme', 'dark'); put(own, 'timeZone', 'Asia/Kolkata'); put(own, 'locale', 'en-IN');
    const o2 = new Settings(own, { system: US });
    assert.deepEqual(place(o2), INDIA); assert.equal(o2.get('ui.placeNotice'), undefined);
    // a desk made before the place came from the computer (its first agents are older) showed India, and keeps it
    const old = store(dir, 'old'); put(old, 'onboarded', true);
    old.run("INSERT INTO agents (id, name, created, updated) VALUES ('a1', 'Ada', '2026-11-14T10:00:00.000Z', '2026-11-14T10:00:00.000Z')");
    assert.deepEqual(place(new Settings(old, { system: US })), INDIA);
    // the step runs once: an India the owner picks later, all at once, is his
    const later = new Settings(rel, { system: US });
    for (const [i, k] of ['country', 'currency', 'timeZone', 'locale'].entries()) later.set(k, INDIA[i]);
    assert.deepEqual(place(new Settings(rel, { system: US })), INDIA);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('place: the computer\'s country gives its own currency for the countries the review found on USD', () => {
  const want = { 'ko-KR': 'KRW', 'tr-TR': 'TRY', 'ar-EG': 'EGP', 'vi-VN': 'VND', 'th-TH': 'THB', 'ru-RU': 'RUB', 'uk-UA': 'UAH', 'he-IL': 'ILS', 'es-AR': 'ARS' };
  for (const [locale, cur] of Object.entries(want)) assert.equal(systemPlace({ locale, timeZone: 'UTC' }).currency, cur, locale);
  // a zone or locale the computer cannot use is never handed on
  assert.equal(systemPlace({ locale: 'en-US', timeZone: 'Not/AZone' }).timeZone, 'UTC');
});

test('spend: the usual limits fit the currency; a currency with no usual amounts asks for every spend', () => {
  assert.deepEqual(spendDefaults('INR'), { 'spend.perItem': 200000, 'spend.perDay': 500000, 'spend.perMonth': 2000000 }, 'rupees as before: 2,000, 5,000, 20,000');
  assert.deepEqual(spendDefaults('USD'), { 'spend.perItem': 2500, 'spend.perDay': 5000, 'spend.perMonth': 20000 }, 'dollars: 25, 50, 200');
  assert.equal(spendDefaults('JPY')['spend.perItem'], 300000, 'yen: 3,000 an item');
  assert.deepEqual(spendDefaults('XOF'), { 'spend.perItem': 0, 'spend.perDay': 0, 'spend.perMonth': 0 }, 'no usual amounts: every spend asks');
  const dir = tmp();
  try {
    const s = new Settings(store(dir, 'a'), { system: US });
    assert.equal(s.get('spend.perItem'), 2500); assert.equal(s.all()['spend.perMonth'], 20000);
    s.set('currency', 'INR'); assert.equal(s.get('spend.perItem'), 200000, 'limits never set follow the currency');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spend: a new currency clears limits set in the old one, and says so', async () => {
  const t = await testDesk();
  try {
    await t.call('/api/settings', { body: { currency: 'INR' } });
    assert.equal((await t.call('/api/settings/spend', { body: { perItem: 100000 } })).status, 200);
    const r = await t.call('/api/settings', { body: { currency: 'USD' } });
    assert.match(r.json.notice, /^Your spend limits were set in INR, so they are cleared for USD: paid model calls are off/);
    const l = (await t.call('/api/security')).json.limits;
    assert.deepEqual([l.perItem, l.perDay, l.perMonth, l.currency], [0, 0, 0, 'USD']);
    assert.equal((await t.call('/api/settings', { body: { currency: 'USD' } })).json.notice, undefined, 'the same currency again: nothing changes');
  } finally { await t.close(); }
});

test('spend route: a bad amount is refused and logs nothing; the same amounts log nothing; a real change is logged once', async () => {
  const t = await testDesk();
  try {
    const log = async () => (await t.call('/api/activity')).json.items.filter(x => x.action === 'spend.limits').length;
    const bad = await t.call('/api/settings/spend', { body: { perItem: -5, perDay: 'abc' } });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /amount of 0 or more\. Nothing was changed\./);
    assert.equal(await log(), 0);
    const now = (await t.call('/api/security')).json.limits;
    assert.equal((await t.call('/api/settings/spend', { body: { perItem: now.perItem, perDay: now.perDay } })).status, 200);
    assert.equal(await log(), 0, 'nothing moved: no "Spend limits changed"');
    await t.call('/api/settings/spend', { body: { perItem: now.perItem + 100 } });
    assert.equal(await log(), 1);
  } finally { await t.close(); }
});

test('settings route: keys nothing reads are refused with a plain reason and are not stored', async () => {
  const t = await testDesk();
  try {
    for (const k of ['router.freeOnly', 'menuPosition', 'textSize', 'motion', 'countries', 'startWithWindows', 'anything']) {
      const r = await t.call('/api/settings', { body: { theme: 'dark', [k]: true } });
      assert.equal(r.status, 400, k); assert.equal(r.json.error, `"${k}" is not a setting on this desk, so nothing was saved.`);
    }
    const all = (await t.call('/api/settings')).json;
    for (const k of ['router.freeOnly', 'menuPosition', 'textSize', 'motion', 'countries', 'startWithWindows']) assert.equal(k in all, false, k + ' is not listed');
    // the keys the desk does read still save, the guarded ones are still left to their own routes
    assert.equal((await t.call('/api/settings', { body: { theme: 'dark', 'ui.menu': null, city: 'Leeds', 'provider.groq.model': 'x' } })).status, 200);
    const g = await t.call('/api/settings', { body: { 'security.level': 'strict' } });
    assert.equal(g.status, 200); assert.equal(g.json.changed['security.level'], undefined);
  } finally { await t.close(); }
});

test('offline: the local model addresses are the keeper\'s alone, and an outside address never counts as local', () => {
  const dir = tmp();
  try {
    const house = new Settings(store(dir, 'house'), { system: US });
    const other = new Settings(store(dir, 'b'), { system: US, house });
    for (const [k, v] of [['ollama.baseUrl', 'https://example.org'], ['network.lanNodes', [{ id: 'x', baseUrl: 'https://example.com' }]]]) {
      assert.throws(() => other.set(k, v), /keeper's own desk/);
      assert.equal(other.isHouseKey(k), true);
    }
    house.set('network.lanNodes', [{ id: 'n1', baseUrl: 'http://192.168.1.20:11434' }, { id: 'n2', baseUrl: 'https://example.com/v1' }]);
    house.set('ollama.baseUrl', 'https://example.org');
    assert.deepEqual(other.get('network.lanNodes'), house.get('network.lanNodes'), 'another space reads the keeper\'s');
    const list = offlineAllowList({ settings: other, port: () => 3460 });
    assert.equal(list.has(hostKey('http://192.168.1.20:11434')), true, 'a box on the owner\'s network');
    assert.equal(list.has(hostKey('https://example.com')), false, 'an outside node does not open Offline');
    assert.equal(list.has(hostKey('https://example.org')), false, 'an outside Ollama does not open Offline');
    for (const u of ['http://127.0.0.1:11434', 'http://localhost:1', 'http://10.0.0.2:1', 'http://172.20.1.1', 'http://box.local', 'http://mybox:8080', 'http://[fd00::1]:1']) assert.equal(isLocalAddress(u), true, u);
    for (const u of ['https://example.com', 'http://8.8.8.8', 'http://172.32.0.1', 'http://[2001:db8::1]']) assert.equal(isLocalAddress(u), false, u);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings route: another person\'s space is refused the keeper\'s keys with a plain reason', () => {
  const dir = tmp();
  try {
    const house = new Settings(store(dir, 'house'), { system: US });
    const other = new Settings(store(dir, 'b'), { system: US, house });
    const routes = settingsRoutes({ settings: other, approval: { activity() {} }, events: { emit() {} } }, () => true);
    const res = { writableEnded: false, writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); this.writableEnded = true; } };
    routes['POST /api/settings']({}, res, { body: { 'ollama.baseUrl': 'https://example.org' } });
    assert.equal(res.status, 403); assert.match(res.body.error, /keeper's own desk\. Nothing was saved\./);
    assert.equal(house.stored('ollama.baseUrl'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('offline: a model box on the owner\'s own network or mesh VPN counts as local; an outside host does not, and the desk says why', async () => {
  for (const u of ['http://100.101.5.6:11434', 'http://100.64.0.1', 'http://box.tail1234.ts.net:11434', 'http://nas.fritz.box:11434', 'http://ollama.home:1', 'http://pc.lan', 'http://pc.localdomain', 'http://[::ffff:192.168.1.5]:11434', 'http://[fe80::1]:1'])
    assert.equal(isLocalAddress(u), true, u);
  for (const u of ['http://100.128.0.1', 'http://100.63.255.1', 'http://[::ffff:8.8.8.8]', 'http://box.example.net', 'https://ts.net.example.com'])
    assert.equal(isLocalAddress(u), false, u);
  const t = await testDesk();
  try {
    // a box on the mesh VPN: saved with nothing to say, and Offline still reaches it
    const ok = await t.call('/api/settings', { body: { 'network.lanNodes': [{ id: 'n1', name: 'Box', baseUrl: 'http://box.tail1234.ts.net:11434' }] } });
    assert.equal(ok.status, 200); assert.equal(ok.json.notice, undefined);
    assert.equal(t.core.offlineAllows(new URL('http://box.tail1234.ts.net:11434/api/tags')), true);
    // an outside address: saved, and the answer says Offline does not call it and what counts as local
    const out = await t.call('/api/settings', { body: { 'ollama.baseUrl': 'https://models.example.com' } });
    assert.equal(out.status, 200);
    assert.match(out.json.notice, /^Saved\. While the desk is offline, models\.example\.com is not called, because it is not on this PC or your own network\. Local means this PC/);
    assert.match(out.json.notice, /100\.64 to 100\.127/);
    // and a call to it while Offline is refused with the same reason
    t.core.settings.set('online', false);
    const why = await fetch('https://models.example.com/api/tags').then(() => 'called', (e) => e.message);
    assert.equal(why, 'The desk is offline, so models.example.com was not called. It is not on this PC or your own network.');
  } finally { t.core.settings.set('online', true); await t.close(); }
});

test('spend: once the limits are cleared, a later change of currency says nothing and logs nothing', async () => {
  const t = await testDesk();
  try {
    const log = async () => (await t.call('/api/activity')).json.items.filter(x => x.title === 'Spend limits cleared: the currency changed').length;
    await t.call('/api/settings', { body: { currency: 'TRY' } });
    await t.call('/api/settings/spend', { body: { perItem: 100000, perDay: 200000, perMonth: 500000 } });
    const first = await t.call('/api/settings', { body: { currency: 'USD' } });
    assert.match(first.json.notice, /^Your spend limits were set in TRY,/);
    for (const c of ['EUR', 'USD']) assert.equal((await t.call('/api/settings', { body: { currency: c } })).json.notice, undefined, c);
    assert.equal(await log(), 1, 'logged once');
    const l = (await t.call('/api/security')).json.limits; assert.deepEqual([l.perItem, l.perDay, l.perMonth], [0, 0, 0]);
  } finally { await t.close(); }
});

// A limit of 0 means: a payment asks every time, and paid model calls are off until the owner sets limits. The refusal
// says so in plain words (not "limit reached" with nothing spent); a key known to be free, and free routes, still answer.
test('spend: limits of 0 turn paid model calls off with a plain reason; a key known to be free still answers', async () => {
  const t = await testDesk();
  try {
    await t.call('/api/settings', { body: { currency: 'TRY' } });
    assert.equal(t.core.settings.get('spend.perDay'), 0);
    assert.equal(t.core.approval.overLimit(1), 'per item limit', 'a payment asks');
    assert.equal(t.core.model.overLimit(), 'no limits', 'not "daily spend limit": nothing is spent');
    t.core.settings.set('router.enabled', false);
    const key = t.core.model.addKey('gemini', 'test-key-12345678', 'Mine', { baseUrl: t.fake.baseUrl, model: 'gemini-3.5-flash-lite' });
    t.core.settings.set('model.defaultChain', ['gemini']);
    const ask = () => t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'chat' });
    await assert.rejects(ask(), (e) => {
      assert.equal(e.message, 'No model answered: paid model calls are off until you set limits in Settings › Payments and spend. Free and local models work.');
      assert.equal(e.attempts[0].error, 'not called: paid model calls are off until you set spend limits');
      return true;
    });
    t.core.model.setKeyTier(key.id || t.core.model.keysFor('gemini')[0].id, 'free');
    assert.equal((await ask()).provider, 'gemini', 'a key marked free tier costs nothing, so it is called');
  } finally { await t.close(); }
});

test('spend: the words for limits of 0 are the same on first start, after a currency change and in the call refusal', async () => {
  const tail = 'paid model calls are off until you set limits in Settings › Payments and spend. Free and local models work.';
  const shell = fs.readFileSync(new URL('../app/ui/shell.js', import.meta.url), 'utf8');
  assert.ok(shell.includes('the desk has no usual limits for ${lim.currency}: ' + tail), 'first start, step two');
  const t = await testDesk();
  try {
    t.core.settings.set('currency', 'INR'); t.core.settings.set('spend.perDay', 100000);
    const r = await t.call('/api/settings', { body: { currency: 'USD' } });
    assert.equal(r.json.notice, 'Your spend limits were set in INR, so they are cleared for USD: ' + tail);
  } finally { await t.close(); }
});
