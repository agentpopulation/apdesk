// Sections D, F, G, L, M and the schedules, on a throwaway desk (no outside service is called here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

const on = async (mods = ['search', 'browser', 'network']) => { const t = await testDesk({ modules: mods }); await t.call('/api/modules/network/on', { method: 'POST' }); return t; };

test('M: the summary answers from stored state; with the module off the route answers 404', async () => {
  const t = await testDesk({ modules: ['network'] });
  try {
    const off = await t.call('/api/m/network/summary');
    assert.equal(off.status, 404); assert.match(off.json.error, /module is off/);
    await t.call('/api/modules/network/on', { method: 'POST' });
    const s = (await t.call('/api/m/network/summary')).json;
    assert.deepEqual(Object.keys(s).sort(), ['down', 'latencyMs', 'note', 'online', 'viaLastCheckAt']);
    assert.equal(s.online, null); assert.equal(s.note, 'Not checked yet.'); assert.equal(s.down, 0);
    t.core.settings.set('online', false);
    const o = (await t.call('/api/m/network/summary')).json; assert.equal(o.online, false); assert.match(o.note, /Offline/);
  } finally { await t.close(); }
});

test('D: agents’ reads are logged with who asked; search by site, CSV export, clear and retention need the owner', async () => {
  const t = await on();
  try {
    await t.core.modules.runTool('web_read', { url: 'http://192.168.1.50/admin' }, { agentId: 'scout', chatId: 'c9' });
    const net = t.core.modules.api('network');
    net.logVisit({ url: 'https://example.com/a', via: 'browser', who: { agentId: 'operator', jobId: null } });
    net.logVisit({ url: 'https://owner.example/', via: 'read', who: { owner: true } });
    const v = (await t.call('/api/m/network/visits')).json;
    assert.equal(v.total, 2, 'the owner’s own reads are not in the agents’ log');
    const lan = v.visits.find(x => x.host === '192.168.1.50'); assert.equal(lan.result, 'blocked'); assert.equal(lan.via, 'Page read'); assert.ok(lan.who.length > 0);
    assert.equal(v.visits.find(x => x.host === 'example.com').result, 'opened');
    assert.equal((await t.call('/api/m/network/visits?q=EXAMPLE')).json.visits.length, 1);
    assert.equal((await t.call('/api/m/network/visits.csv', { session: false })).status, 403);
    const csv = await t.call('/api/m/network/visits.csv');
    assert.match(csv.text.replace(/^\uFEFF/, ''), /^time \([^)]+\),site,address,how,agent or job,result,note\r\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,/); assert.equal(csv.text.trim().split('\r\n').length, 3);
    net.logVisit({ url: 'https://x.example/=cmd', via: 'read', who: { agentId: 'scout' }, error: Object.assign(new Error('=HYPERLINK("x")'), { code: 'http' }) });
    assert.match((await t.call('/api/m/network/visits.csv')).text, /'=HYPERLINK/, 'a cell that starts like a formula is defused');
    assert.equal((await t.call('/api/m/network/visits/clear', { body: {}, session: false })).status, 403);
    assert.equal((await t.call('/api/m/network/visits/settings', { body: { retentionDays: 7 } })).json.retentionDays, 7);
    await t.call('/api/m/network/visits/clear', { body: {} });
    assert.equal((await t.call('/api/m/network/visits')).json.total, 0);
  } finally { await t.close(); }
});

test('G: a device not seen before raises one notice; the first read only remembers; other ranges are ignored', async () => {
  const t = await on(['network']);
  try {
    const net = t.core.modules.api('network');
    const ifaces = [{ family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', private: true }];
    assert.equal(net.rememberDevices([{ ip: '192.168.1.1', mac: 'aa:aa:aa:aa:aa:01' }], { ifaces }).first, true);
    assert.equal((await t.call('/api/m/network/notices')).json.notices.length, 0);
    const r = net.rememberDevices([{ ip: '192.168.1.1', mac: 'aa:aa:aa:aa:aa:01' }, { ip: '192.168.1.77', mac: 'aa:aa:aa:aa:aa:02' }, { ip: '10.0.0.9', mac: 'aa:aa:aa:aa:aa:03' }], { ifaces });
    assert.equal(r.added, 1);
    net.rememberDevices([{ ip: '192.168.1.77', mac: 'aa:aa:aa:aa:aa:02' }], { ifaces });
    const n = (await t.call('/api/m/network/notices')).json.notices;
    assert.equal(n.length, 1, 'once'); assert.match(n[0].title, /^A new device joined your network: 192\.168\.1\.77/);
    const d = (await t.call('/api/m/network/devices')).json.devices; assert.equal(d.length, 2, 'the 10.0.0.9 device is not on this PC’s own subnet');
    assert.equal((await t.call('/api/m/network/devices/aa:aa:aa:aa:aa:02', { method: 'PATCH', body: { name: 'Printer', known: true }, session: false })).status, 403);
    const named = (await t.call('/api/m/network/devices/aa:aa:aa:aa:aa:02', { method: 'PATCH', body: { name: ' Printer<b> ', known: true } })).json.devices.find(x => x.mac === 'aa:aa:aa:aa:aa:02');
    assert.equal(named.name, 'Printer<b>', 'stored as plain text; the page shows it as text'); assert.equal(named.known, true);
  } finally { await t.close(); }
});

test('F: the provider board reads what the model door recorded, without calling a model', async () => {
  const t = await on(['network']);
  try {
    const at = new Date(Date.now() - 10 * 60_000).toISOString(), old = new Date(Date.now() - 5 * 3600_000).toISOString();
    for (const [p, ms, ok, when] of [['gemini', 900, 1, at], ['gemini', 1100, 1, old], ['groq', 300, 1, at], ['groq', 0, 0, at]]) t.core.storage.run('INSERT INTO calls (at, provider, model, ok, ms) VALUES (?, ?, ?, ?, ?)', when, p, 'm', ok, ms);
    const before = t.core.storage.get('SELECT COUNT(*) AS n FROM calls').n;
    const b = (await t.call('/api/m/network/providers')).json;
    assert.equal(b.providers[0].provider, 'groq'); assert.equal(b.providers[0].failed, 1); assert.equal(b.providers[0].lastHourMs, 300);
    assert.equal(b.providers.find(p => p.provider === 'gemini').medianMs, 1000);
    assert.equal(t.core.storage.get('SELECT COUNT(*) AS n FROM calls').n, before, 'no model was called');
    assert.equal((await t.call('/api/m/network/providers/test', { body: {}, session: false })).status, 403);
  } finally { await t.close(); }
});

test('schedules: off by default, nothing outbound while Panic is on or Offline; a cap stops a scheduled test', async () => {
  const t = await on(['network']);
  try {
    const net = t.core.modules.api('network');
    const sent = []; const real = globalThis.fetch;
    globalThis.fetch = async (u, i) => { if (String(u).startsWith(t.base)) return real(u, i); sent.push(String(u)); throw Object.assign(new Error('no network in tests'), { code: 'ENETUNREACH' }); };
    try {
      const r0 = await net.tick(Date.now() + 365 * 86400_000);
      assert.deepEqual(sent, [], 'a fresh desk calls nothing by itself: ' + sent.join(', '));
      assert.ok(!r0.did.includes('speed'));
      assert.equal((await t.call('/api/m/network/speed/settings', { body: { every: '6h', kind: 'full', capMb: 10 } })).json.capMb, 10);
      await t.core.panic.stopAll('test');
      assert.equal((await net.tick(Date.now() + 400 * 86400_000)).halted, true); assert.deepEqual(sent, []);
      t.core.panic.resume();
      t.core.settings.set('online', false);
      assert.equal((await net.tick(Date.now() + 401 * 86400_000)).offline, true); assert.deepEqual(sent, []);
      t.core.settings.set('online', true);
      await net.tick(Date.now() + 402 * 86400_000);
      assert.deepEqual(sent, [], 'a full test (26 MB) over a 10 MB cap is skipped, not run');
      assert.match((await t.call('/api/m/network/speed')).json.skipped.why, /monthly cap of 10 MB/);
      const manual = await t.call('/api/m/network/speed', { body: { kind: 'full' } });
      assert.equal(manual.status, 409); assert.equal(manual.json.code, 'over_cap');
    } finally { globalThis.fetch = real; }
  } finally { await t.close(); }
});

test('L: data use counts through the outbound door; counts are stored per day and host', async () => {
  const t = await on(['network']);
  try {
    const d = (await t.call('/api/m/network/data-use')).json;
    assert.equal(d.counting, true, 'the outbound door has its counter'); assert.equal(d.note, null);
    const net = t.core.modules.api('network');
    net.recordBytes('Example.com', 100, 2000); net.recordBytes('example.com', 50, 1000);
    const d2 = (await t.call('/api/m/network/data-use')).json;
    assert.deepEqual(d2.hosts[0], { host: 'example.com', sent: 150, received: 3000 });
  } finally { await t.close(); }
});

test('owner-only: every route that calls out or changes something refuses without the desk’s session', async () => {
  const t = await on(['search', 'network']);
  try {
    for (const [m, p, body] of [['POST', '/public', {}], ['POST', '/public/schedule', { every: 'daily' }], ['POST', '/speed', {}], ['POST', '/speed/settings', {}], ['POST', '/sites', { url: 'example.com' }], ['POST', '/diagnose', {}], ['POST', '/devices/read', {}], ['POST', '/domains', { domain: 'example.com', mine: true }], ['POST', '/osint/subdomains', { q: 'example.com' }], ['POST', '/osint/keys', { service: 'shodan', key: 'x' }], ['POST', '/lan', {}], ['POST', '/model-test', {}]]) {
      const r = await t.call('/api/m/network' + p, { method: m, body, session: false });
      assert.ok(r.status === 403 || r.status === 401, `${m} ${p} answered ${r.status}`);
    }
    assert.equal((await t.call('/api/m/network/domains', { body: { domain: 'example.com' } })).status, 400, 'the owner ticks that the domain is his');
    const k = await t.call('/api/m/network/osint/keys', { body: { service: 'shodan', key: 'abcdefghijklmnopqrstuvwxyz123456' } });
    assert.deepEqual(k.json, { shodan: true }); assert.ok(!JSON.stringify((await t.call('/api/m/network/osint/keys')).json).includes('abcdefgh'), 'the key never comes back');
  } finally { await t.close(); }
});

test('V: the desk view route answers agent states and the 24-hour provider calls, and marks a provider whose last check failed', async () => {
  const t = await on(['network']);
  try {
    t.core.storage.run("INSERT INTO calls (at, agent_id, purpose, provider, model, ok, ms) VALUES (?, 'operator', 'chat', 'gemini', 'm', 1, 5)", new Date().toISOString());
    t.core.storage.run("INSERT INTO calls (at, agent_id, purpose, provider, model, ok, ms) VALUES (?, 'operator', 'chat', 'gemini', 'm', 1, 5)", new Date(Date.now() - 3 * 86400_000).toISOString());
    const v = (await t.call('/api/m/network/desk')).json;
    assert.ok(Array.isArray(v.states)); assert.ok(v.states.every(s => ['idle', 'working', 'waiting', 'failed'].includes(s.state)));
    const g = v.deps.providers.find(p => p.provider === 'gemini'); assert.equal(g.calls, 1, 'only the last 24 hours');
    assert.equal(g.down, false); assert.equal(g.health, null);
    t.core.storage.run("INSERT INTO m_network_api (at, provider, label, url, ok, status, ms) VALUES (?, 'gemini', 'Gemini', 'x', 0, 500, 9)", new Date().toISOString());
    const d = (await t.call('/api/m/network/desk')).json;
    assert.equal(d.deps.providers.find(p => p.provider === 'gemini').down, true);
    assert.deepEqual(d.deps.agents.filter(a => a.affected).map(a => a.id), ['operator']);
  } finally { await t.close(); }
});

test('V: a provider whose last check failed more than a day ago is still marked', async () => {
  const t = await on(['network']);
  try {
    t.core.storage.run("INSERT INTO calls (at, agent_id, purpose, provider, model, ok, ms) VALUES (?, 'operator', 'chat', 'gemini', 'm', 1, 5)", new Date().toISOString());
    t.core.storage.run("INSERT INTO m_network_api (at, provider, label, url, ok, status, ms) VALUES (?, 'gemini', 'Gemini', 'x', 1, 200, 9)", new Date(Date.now() - 60 * 3600_000).toISOString());
    t.core.storage.run("INSERT INTO m_network_api (at, provider, label, url, ok, status, ms) VALUES (?, 'gemini', 'Gemini', 'x', 0, 500, 9)", new Date(Date.now() - 30 * 3600_000).toISOString());
    const d = (await t.call('/api/m/network/desk')).json;
    const g = d.deps.providers.find(p => p.provider === 'gemini');
    assert.equal(g.down, true); assert.equal(g.health, 'down');
    assert.deepEqual(d.deps.agents.filter(a => a.affected).map(a => a.id), ['operator']);
  } finally { await t.close(); }
});
