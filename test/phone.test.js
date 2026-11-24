// Approve from your phone: off by default; when on, a second listener on the home address serves only the phone page and
// its routes; a one-time code links a phone; Yes and No decide that one approval once, as that person; Panic, the lock,
// removal and the Admin's choice for installs are honoured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';
import { homeAddress } from '../app/core/phone/phone.js';

const ENV = { APD_PHONE_HOST: '127.0.0.2', APD_PHONE_PORT: '0' };   // 127.0.0.2: "another address" on this PC
const PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const tick = () => new Promise(r => setTimeout(r, 20));
const waitPending = async (core, n = 1) => { for (let i = 0; i < 100; i++) { const p = core.approval.listPending(); if (p.length >= n) return p; await tick(); } return core.approval.listPending(); };

async function phoneDesk() {
  const t = await testDesk({ env: ENV });
  const at = (p, { token, body, method, headers = {} } = {}) => fetch(t.desk.phone.state().address + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null), text: '' }));
  const code = async () => (await t.call('/api/phone/code', { method: 'POST', headers: PAGE })).json;
  const link = async (name = 'Shop phone') => (await at('/link', { body: { code: (await code()).code, name } })).json.token;
  return { t, at, code, link };
}

test('the home address is a private IPv4 address, never loopback or a public one', () => {
  assert.equal(homeAddress({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], eth0: [{ address: '192.0.2.2', family: 'IPv4', internal: false }] }), null);
  assert.equal(homeAddress({ wlan: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.20', family: 'IPv4', internal: false }] }), '192.168.1.20');
  assert.equal(homeAddress({ e: [{ address: '172.20.0.5', family: 'IPv4', internal: false }] }), '172.20.0.5');
  assert.equal(homeAddress({ e: [{ address: '172.32.0.5', family: 'IPv4', internal: false }] }), null);
});

test('off by default: nothing listens, and no code is made', async () => {
  const { t } = await phoneDesk();
  try {
    const s = (await t.call('/api/phone')).json;
    assert.equal(s.on, false); assert.equal(s.listening, false); assert.equal(s.address, null);
    assert.equal((await t.call('/api/phone/code', { method: 'POST', headers: PAGE })).status, 409);
    assert.equal(t.desk.phone.listening, null);
  } finally { await t.close(); }
});

test('switched on, the phone listener serves the phone page and nothing of the desk', async () => {
  const { t, at } = await phoneDesk();
  try {
    const on = await t.call('/api/phone/switch', { body: { on: true } });
    assert.equal(on.status, 200); assert.match(on.json.address, /^http:\/\/127\.0\.0\.2:\d+$/);
    const base = on.json.address;
    const page = await fetch(base + '/'); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await page.text(); assert.match(html, /plain http/); assert.match(html, /works while the desk is Offline/);
    const DESK = ['/api/state', '/api/approvals', '/api/m/chat/chats', '/ui/shell.js', '/index.html', '/api/panic', '/router/v1/models', '/api/phone', '/api/events'];
    for (const p of DESK) { const r = await at(p); assert.equal(r.status, 401, p); assert.equal(r.json.code, 'not_linked', p); }
    for (const p of ['/api/panic', '/api/approvals/x/approve', '/api/settings/security']) assert.notEqual((await at(p, { body: {} })).status, 200, p);
    // the desk's own port answers on loopback only: not on the other address
    await assert.rejects(fetch(`http://127.0.0.2:${t.core.port}/api/state`));
    // a foreign Host header (DNS rebinding) gets nothing
    const http = await import('node:http');
    const status = await new Promise((res) => { const u = new URL(base); http.get({ host: u.hostname, port: u.port, path: '/', headers: { host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode); }); });
    assert.equal(status, 403);
    const off = await t.call('/api/phone/switch', { body: { on: false } });
    assert.equal(off.json.listening, false);
    await assert.rejects(fetch(base + '/'));
    assert.ok(t.core.approval.activityList(20).some(a => a.action === 'phone.switch'));
  } finally { await t.close(); }
});

test('the code is for the desk\'s own page only, lives a short time, and five wrong tries lock linking', async () => {
  const { t, at, code } = await phoneDesk();
  try {
    await t.call('/api/phone/switch', { body: { on: true } });
    assert.equal((await t.call('/api/phone/code', { method: 'POST' })).status, 403, 'not a plain program: a page fetch only');
    const c = await code(); assert.match(c.code, /^\d{6}$/); assert.equal(c.seconds, 300);
    t.desk.phone.limits.lockMs = 300;   // (a short wait for the test; five minutes on a real desk)
    for (let i = 0; i < 5; i++) assert.equal((await at('/link', { body: { code: String((Number(c.code) + 1 + i) % 1000000).padStart(6, '0') } })).status, 403);
    const locked = await at('/link', { body: { code: c.code } });
    assert.equal(locked.status, 429, 'locked, even for the right code');
    await new Promise(r => setTimeout(r, 350));
    assert.equal((await at('/link', { body: { code: c.code } })).status, 403, 'the lock ended every live code');
    t.desk.phone.limits.codeMs = 1; const old = await code(); await new Promise(r => setTimeout(r, 5));
    assert.equal((await at('/link', { body: { code: old.code } })).status, 403, 'a code too old does not link');
    t.desk.phone.limits.codeMs = 300000;
    const good = await code(); const r = await at('/link', { body: { code: good.code, name: 'Shop phone' } });
    assert.equal(r.status, 200); assert.ok(r.json.token.length >= 40);
    assert.equal((await at('/link', { body: { code: good.code } })).status, 403, 'a code links once');
    const dev = (await t.call('/api/phone')).json.devices;
    assert.equal(dev.length, 1); assert.equal(dev[0].name, 'Shop phone'); assert.ok(dev[0].lastUsed);
    assert.ok(!JSON.stringify(dev).includes(r.json.token), 'the token is never shown back');
  } finally { await t.close(); }
});

test('yes on the phone decides that one approval once, as that person, and the activity log names the phone', async () => {
  const { t, at, link } = await phoneDesk();
  try {
    await t.call('/api/phone/switch', { body: { on: true } });
    const token = await link('Shop phone');
    const asked = t.core.approval.request({ agentId: 'coordinator', action: 'send.person', title: 'Send the quote to a buyer', detail: 'Mail', payload: { to: 'buyer@shop.example', body: 'The quote is attached.', api_key: 'sk-not-to-show' } });
    const [p] = await waitPending(t.core);
    const list = await at('/list', { token });
    assert.equal(list.status, 200); assert.equal(list.json.items.length, 1);
    const it = list.json.items[0];
    assert.equal(it.title, 'Send the quote to a buyer'); assert.match(it.who, /asks$/); assert.equal(it.detail, 'Mail'); assert.equal(it.more, true); assert.equal(it.atDesk, false);
    assert.ok(!JSON.stringify(list.json).includes('The quote is attached.'), 'the text shows only on "show"');
    const shown = await at('/show/' + p.id, { token });
    assert.ok(shown.json.rows.some(([k, v]) => k === 'Text' && v === 'The quote is attached.'));
    assert.ok(!JSON.stringify(shown.json).includes('sk-not-to-show'), 'a secret field never shows on the phone');
    const yes = await at('/decide/' + p.id, { token, body: { decision: 'approve' } });
    assert.equal(yes.status, 200); assert.equal(yes.json.said, 'Approved.');
    assert.equal((await asked).ok, true);
    const again = await at('/decide/' + p.id, { token, body: { decision: 'deny' } });
    assert.equal(again.status, 409); assert.equal(again.json.already, true); assert.equal(t.core.approval.forModule().get(p.id).status, 'approved');
    const lines = t.core.approval.activityList(30).filter(a => a.title === 'Send the quote to a buyer');
    assert.equal(lines.length, 1); assert.match(lines[0].detail, /Decided on the phone "Shop phone"/);
    // decided at the desk first: the phone shows it as made
    const second = t.core.approval.request({ agentId: 'coordinator', action: 'shell.run', title: 'Run a check', payload: { cmd: 'echo hi' } });
    const [q] = await waitPending(t.core); t.core.approval.decide(q.id, 'deny'); await second;
    const late = await at('/decide/' + q.id, { token, body: { decision: 'approve' } });
    assert.equal(late.status, 409); assert.equal(late.json.error, 'This was already declined.');
  } finally { await t.close(); }
});

test('installs are decided at the desk unless the Admin chooses so; Panic and a removed phone stop everything', async () => {
  const { t, at, link } = await phoneDesk();
  try {
    await t.call('/api/phone/switch', { body: { on: true } });
    const token = await link();
    const inst = t.core.approval.request({ agentId: null, action: 'install', title: 'Install a module', from: 'shop.example', payload: { url: 'https://shop.example/m.zip' } });
    const [p] = await waitPending(t.core);
    assert.equal((await at('/list', { token })).json.items[0].atDesk, true);
    const no = await at('/decide/' + p.id, { token, body: { decision: 'approve' } });
    assert.equal(no.status, 403); assert.equal(no.json.error, 'Decide this at the desk.');
    assert.equal(t.core.approval.forModule().get(p.id).status, 'pending');
    await t.call('/api/phone/admin-decides', { body: { on: true } });
    assert.equal((await at('/list', { token })).json.items[0].atDesk, false);
    assert.equal((await at('/decide/' + p.id, { token, body: { decision: 'deny' } })).status, 200);
    assert.equal((await inst).ok, false);

    // Panic: nothing is listed or decided
    const waiting = t.core.approval.request({ agentId: 'coordinator', action: 'shell.run', title: 'Run', payload: { cmd: 'x' } });
    const [r] = await waitPending(t.core);
    await t.call('/api/panic', { body: {} });
    const l = await at('/list', { token });
    assert.equal(l.json.items.length, 0); assert.match(l.json.stopped, /Panic/);
    assert.equal((await at('/decide/' + r.id, { token, body: { decision: 'approve' } })).status, 409);
    await waiting; await t.call('/api/panic/resume', { body: {} });

    // removed in Settings: the token is refused from then on
    const dev = (await t.call('/api/phone')).json.devices[0];
    assert.equal((await t.call(`/api/phone/devices/${dev.id}/remove`, { body: {} })).status, 200);
    assert.equal((await at('/list', { token })).status, 401);
  } finally { await t.close(); }
});

test('each phone sees and decides only its own person\'s approvals; only the Admin switches it on; Incognito shows nothing', async () => {
  const { t, at } = await phoneDesk();
  try {
    const as = (token) => (p, o = {}) => t.call(p, { ...o, session: false, headers: { 'x-apd-session': token, ...(o.headers || {}) } });
    const k = as(t.desk.session);
    await k('/api/people/me/pin', { body: { pin: '2468' } });
    const id = (await k('/api/people', { body: { name: 'Person B', pin: '4821' } })).json.person.id;
    const tokB = (await t.call('/api/people/enter', { session: false, body: { id, pin: '4821' } })).json.token;
    const b = as(tokB);
    assert.equal((await b('/api/phone/switch', { body: { on: true } })).status, 403, 'only the Admin switches it on');
    assert.equal((await k('/api/phone/switch', { body: { on: true } })).status, 200);
    const codeB = (await b('/api/phone/code', { method: 'POST', headers: PAGE })).json.code;
    const phoneB = (await at('/link', { body: { code: codeB, name: 'B phone' } })).json.token;
    const codeA = (await k('/api/phone/code', { method: 'POST', headers: PAGE })).json.code;
    const phoneA = (await at('/link', { body: { code: codeA, name: 'A phone' } })).json.token;
    // B sees only their own phone in Settings; the Admin sees both
    assert.deepEqual((await b('/api/phone')).json.devices.map(d => d.name), ['B phone']);
    assert.deepEqual((await k('/api/phone')).json.devices.map(d => d.name).sort(), ['A phone', 'B phone']);
    assert.equal((await b(`/api/phone/devices/${(await k('/api/phone')).json.devices.find(d => d.name === 'A phone').id}/remove`, { body: {} })).status, 404, 'B cannot remove the Admin\'s phone');

    const keeperAsk = t.core.approval.request({ agentId: 'coordinator', action: 'shell.run', title: 'Keeper thing', payload: { cmd: 'a' } });
    const [ka] = await waitPending(t.core);
    const coreB = t.desk.spaceOf(id).core;
    const bAsk = coreB.approval.request({ agentId: 'coordinator', action: 'shell.run', title: 'B thing', payload: { cmd: 'b' } });
    await waitPending(coreB);
    assert.deepEqual((await at('/list', { token: phoneB })).json.items.map(i => i.title), ['B thing']);
    assert.deepEqual((await at('/list', { token: phoneA })).json.items.map(i => i.title), ['Keeper thing']);
    assert.equal((await at('/decide/' + ka.id, { token: phoneB, body: { decision: 'approve' } })).status, 404, 'B\'s phone cannot decide the Admin\'s approval');
    assert.equal(t.core.approval.forModule().get(ka.id).status, 'pending');

    // B goes Incognito: what waits there never shows on a phone, and no phone is linked from there
    const inc = (await b('/api/people/incognito', { body: {} })).json.token;
    const incCore = t.desk.spaceForToken(inc).core;
    const incAsk = incCore.approval.request({ agentId: 'coordinator', action: 'shell.run', title: 'Incognito thing', payload: { cmd: 'c' } });
    await waitPending(incCore);
    assert.deepEqual((await at('/list', { token: phoneB })).json.items.map(i => i.title), ['B thing']);
    assert.equal((await as(inc)('/api/phone/code', { method: 'POST', headers: PAGE })).status, 403);
    // a person taken off the desk: their phone stops working
    await k(`/api/people/${id}/remove`, { body: { pin: '2468' } });
    assert.equal((await at('/list', { token: phoneB })).status, 401);
    t.core.approval.decide(ka.id, 'deny'); await keeperAsk; await Promise.race([bAsk, tick()]); void incAsk;
  } finally { await t.close(); }
});

test('while the desk is locked, the phone lists and decides nothing', async () => {
  const t = await testDesk({ modules: ['accounts'], env: ENV });
  try {
    await t.call('/api/modules/accounts/on', { method: 'POST' });
    await t.call('/api/m/accounts/pin', { body: { pin: '4826' } });
    const base = (await t.call('/api/phone/switch', { body: { on: true } })).json.address;
    const code = (await t.call('/api/phone/code', { method: 'POST', headers: PAGE })).json.code;
    const post = (p, body, token) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
    const token = (await post('/link', { code, name: 'P' })).json.token;
    const ask = t.core.approval.request({ action: 'send.person', title: 'Mail the supplier', payload: { to: 'x@shop.example', body: 'PRIVATE' } });
    const [p] = await waitPending(t.core);
    await t.call('/api/m/accounts/lock', { method: 'POST' });
    const l = await fetch(base + '/list', { headers: { authorization: 'Bearer ' + token } }).then(r => r.json());
    assert.deepEqual(l.items, []); assert.match(l.stopped, /locked/);
    assert.equal((await post('/decide/' + p.id, { decision: 'approve' }, token)).status, 409);
    assert.equal(t.core.approval.forModule().get(p.id).status, 'pending');
    t.core.approval.decide(p.id, 'deny'); await ask;
  } finally { await t.close(); }
});

test('an install shown on the phone names its host in the detail line, never the raw address', async () => {
  const { t, at, link } = await phoneDesk();
  try {
    await t.call('/api/phone/switch', { body: { on: true } });
    const token = await link();
    const ask = t.core.approval.request({ action: 'install', title: 'Get the model (2.0 GB)', from: 'models.example', payload: { file: 'm.gguf', size: '2.0 GB', url: 'https://models.example/a/b/m.gguf?sig=abc' } });
    const [p] = await waitPending(t.core);
    const it = (await at('/list', { token })).json.items[0];
    assert.match(it.detail, /^From models\.example\./);
    const shown = (await at('/show/' + p.id, { token })).json.rows;
    assert.deepEqual(shown.map(r => r[0]), ['Saved as', 'Size']);
    assert.ok(!JSON.stringify(shown).includes('sig=abc'));
    t.core.approval.decide(p.id, 'deny'); await ask;
  } finally { await t.close(); }
});

test('the phone names the agent by its role and shows money in the currency\'s own units', async () => {
  const { t, at, link } = await phoneDesk();
  try {
    await t.call('/api/phone/switch', { body: { on: true } });
    const token = await link('Shop phone');
    t.core.settings.set('currency', 'JPY');
    const asked = t.core.approval.request({ agentId: 'scout', action: 'spend', title: 'Buy a cable', amount: 5050, currency: 'JPY', payload: { what: 'cable' } });
    await waitPending(t.core);
    const it = (await at('/list', { token })).json.items[0];
    assert.equal(it.who, 'Researcher asks');
    assert.doesNotMatch(it.amount, /\.\d/, 'yen has no small unit: ' + it.amount);
    t.core.approval.cancelAll('aborted'); await asked;
    t.core.agents.update('scout', { name: 'Kent' });
    t.core.approval.request({ agentId: 'scout', action: 'shell.run', title: 'Run a check', payload: { cmd: 'echo hi' } });
    await waitPending(t.core);
    assert.equal((await at('/list', { token })).json.items[0].who, 'Kent · Researcher asks');
    t.core.approval.cancelAll('aborted');
  } finally { await t.close(); }
});
