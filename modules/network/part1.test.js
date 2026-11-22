// Part 1 of the Network page on a throwaway desk: the status strip, API connection health, IP and ASN tracking, the
// DNS and issues routes, the active-connection detail, and the owner guard on the new routes. No outside service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

const on = async (mods = ['network']) => { const t = await testDesk({ modules: mods }); await t.call('/api/modules/network/on', { method: 'POST' }); return t; };
const iso = (ms = Date.now()) => new Date(ms).toISOString();

test('N: the status strip counts agents, the task queue and new devices; a source that is not there stays a dash', async () => {
  const t = await on();
  try {
    const now = iso();
    t.core.storage.run('INSERT INTO jobs (id, kind, title, agent_id, status, progress, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', 'job_run', 'k', 'A job', 'scout', 'running', now, now);
    t.core.storage.run('INSERT INTO jobs (id, kind, title, agent_id, status, progress, created, updated, finished) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)', 'job_fail', 'k', 'Bad', 'closer', 'failed', now, now, now);
    const net = t.core.modules.api('network');
    net.rememberDevices([{ ip: '192.168.1.9', mac: 'aa:aa:aa:aa:aa:09' }], { ifaces: [{ family: 'IPv4', address: '192.168.1.2', netmask: '255.255.255.0', private: true }] }); // baseline (known)
    t.core.storage.run("INSERT INTO m_network_devices (mac, ip, known, first_seen, last_seen, told) VALUES ('bb:bb:bb:bb:bb:01', '192.168.1.55', 0, ?, ?, 1)", now, now);
    const s = (await t.call('/api/m/network/status')).json;
    assert.equal(s.agents.online, 5, 'the five seeded agents are enabled');
    assert.equal(s.agents.midTask, 1, 'Scout has a running job'); assert.equal(s.agents.error, 1, 'Closer has a failed job'); assert.equal(s.agents.idle, 3);
    assert.ok(s.queue >= 1, 'a running job is in the queue'); assert.equal(s.newDevices, 1, 'one device is not marked known');
    assert.equal(s.messagesPerMin, null, 'Chat is off, so messages per minute has no source and is a dash');
    assert.equal(s.heartbeat, null, 'nothing checked yet, so the heartbeat is a dash, not a made-up value');
  } finally { await t.close(); }
});

test('O: API connection health folds the stored checks; the cadence is off by default and the check needs the owner', async () => {
  const t = await on();
  try {
    const now = Date.now();
    for (const [p, ok, st, ms, at] of [['gemini', 1, 200, 180, iso(now - 60_000)], ['gemini', 0, 503, null, iso(now - 2 * 3600_000)], ['groq', 1, 401, 1800, iso(now - 30_000)]])
      t.core.storage.run('INSERT INTO m_network_api (at, provider, label, url, ok, status, ms) VALUES (?, ?, ?, ?, ?, ?, ?)', at, p, p, 'https://x/v1/models', ok, st, ms);
    const h = (await t.call('/api/m/network/api-health')).json;
    assert.equal(h.every, 'off', 'nothing pings by itself'); assert.equal(h.online, true);
    const g = h.providers.find(x => x.provider === 'gemini');
    assert.equal(g.status, 'up'); assert.equal(g.lastMs, 180); assert.equal(g.errorRate24h, 0.5);
    assert.equal(h.providers.find(x => x.provider === 'groq').status, 'slow');
    assert.equal((await t.call('/api/m/network/api-health/check', { body: {}, session: false })).status, 403, 'pinging needs the owner');
    assert.equal((await t.call('/api/m/network/api-health/settings', { body: { every: '60s' } })).json.every, '60s');
  } finally { await t.close(); }
});

test('P + R: a change of public address is logged old -> new, and its network operator (ASN) is tracked and flagged', async () => {
  const t = await on();
  try {
    const net = t.core.modules.api('network');
    net.recordPublicIp({ ip: '203.0.113.7', asn: 64500, operator: 'EXAMPLE-NET' }, 'owner');
    net.recordPublicIp({ ip: '203.0.113.8', asn: 64500, operator: 'EXAMPLE-NET' }, 'owner');   // address changed, operator the same
    const ip = (await t.call('/api/m/network/ip')).json;
    assert.equal(ip.public.IPv4, '203.0.113.8');
    assert.ok(ip.local.length >= 0); assert.equal(ip.history.length, 2);
    assert.deepEqual(ip.history[0], { at: ip.history[0].at, scope: 'public', family: 'IPv4', old: '203.0.113.7', new: '203.0.113.8', trigger: 'owner' });
    assert.equal(ip.history[1].old, null, 'the first address has no previous value');
    const asn = (await t.call('/api/m/network/asn')).json;
    assert.equal(asn.public.asn, 64500); assert.equal(asn.public.operator, 'EXAMPLE-NET'); assert.equal(asn.history.length, 1, 'the operator did not change, so one row');
    net.recordPublicIp({ ip: '203.0.113.8', asn: 64999, operator: 'OTHER-NET' }, 'owner');   // operator changed
    const asn2 = (await t.call('/api/m/network/asn')).json;
    assert.equal(asn2.public.asn, 64999); assert.equal(asn2.history.length, 2); assert.equal(asn2.history[0].oldAsn, 64500);
  } finally { await t.close(); }
});

test('Q: the DNS view lists the owner’s domains; the cadence is off by default', async () => {
  const t = await on();
  try {
    await t.call('/api/m/network/domains', { body: { domain: 'example.com', mine: true } });
    const d = (await t.call('/api/m/network/dns')).json;
    assert.equal(d.every, 'off'); assert.equal(d.domains.length, 1); assert.equal(d.domains[0].domain, 'example.com'); assert.equal(d.domains[0].records, null);
    assert.equal((await t.call('/api/m/network/dns/settings', { body: { every: '15m' } })).json.every, '15m');
    assert.equal((await t.call('/api/m/network/dns/example.com/check', { body: {}, session: false })).status, 403, 'resolving needs the owner');
  } finally { await t.close(); }
});

test('S: a cert near expiry becomes an issue with a severity, gathered from stored facts, and can be muted', async () => {
  const t = await on();
  try {
    const soon = iso(Date.now() + 2 * 86400_000);   // 2 days: critical
    await t.call('/api/m/network/domains', { body: { domain: 'mine.example', mine: true } });
    t.core.storage.run('UPDATE m_network_domains SET cert_to = ? WHERE domain = ?', soon, 'mine.example');
    const r = (await t.call('/api/m/network/issues')).json;
    const i = r.issues.find(x => x.key === 'cert|mine.example');
    assert.ok(i, 'the expiring certificate is an issue'); assert.equal(i.severity, 'critical'); assert.equal(i.kind, 'ssl');
    assert.equal((await t.call('/api/m/network/issues/cert|mine.example/mute', { body: { muted: true }, session: false })).status, 403, 'mute needs the owner');
    const after = (await t.call('/api/m/network/issues/' + encodeURIComponent('cert|mine.example') + '/mute', { body: { muted: true } })).json;
    assert.ok(after.muted.some(x => x.key === 'cert|mine.example'), 'the muted issue moves to the muted list');
    assert.equal((await t.call('/api/m/network/issues/' + encodeURIComponent('no|such') + '/mute', { body: { muted: true } })).status, 404);
  } finally { await t.close(); }
});

test('T: the active-connection detail answers from this PC and names the fields it cannot report', async () => {
  const t = await on();
  try {
    const a = (await t.call('/api/m/network/active')).json;
    assert.ok('connected' in a && 'gateway' in a && 'dnsServers' in a && 'mtu' in a, 'the detail fields are present');
    assert.equal(a.leaseEnd, null); assert.equal(a.linkUpAt, null);
    assert.match(a.note, /DHCP lease end and the link-up time are not reported/);
  } finally { await t.close(); }
});

test('N: a schedule choice that is not offered is refused with a reason, and the one in use stays', async () => {
  const t = await on();
  try {
    assert.equal((await t.call('/api/m/network/dns/settings', { body: { every: '15m' } })).json.every, '15m');
    for (const [p, body] of [['dns/settings', { every: 'sometimes' }], ['api-health/settings', { every: '' }], ['asn/settings', {}], ['registrar/settings', { every: 'weekly' }], ['devices/settings', { every: 'often' }], ['visits/settings', { retentionDays: 'lots' }]]) {
      const r = await t.call('/api/m/network/' + p, { body });
      assert.equal(r.status, 400, p); assert.match(r.json.error, /Choose|days/);
    }
  } finally { await t.close(); }
});
