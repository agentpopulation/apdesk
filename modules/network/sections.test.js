// Sections A, B, E, G, H, J, K: the pure parts, with stand-in servers on loopback for every outside service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localConnection, publicAddress } from './conn.js';
import { runLatency } from './speed.js';
import { verdict, knock } from './diagnose.js';
import { listening } from './ports.js';
import { mailHealth, remindersDue, expiryLine, daysUntil } from './domain.js';
import { certSubdomains, siteProfile, waybackClosest, waybackList, shodanDomain } from './osint.js';
import { inOwnSubnet } from './lan.js';
import { standIn } from './standin.js';
import net from 'node:net';

test('A: the connection in use, from this PC only (Wi-Fi with signal, cable without)', async () => {
  const si = {
    networkInterfaces: async () => [{ iface: 'lo', internal: true, ip4: '127.0.0.1' }, { iface: 'wlan0', ifaceName: 'Wi-Fi', ip4: '192.168.1.20', ip4subnet: '255.255.255.0', type: 'wireless', speed: 866, default: true, operstate: 'up', mac: 'aa:bb:cc:dd:ee:ff' }, { iface: 'eth1', ifaceName: 'Ethernet 2', ip4: '10.0.0.5', type: 'wired', operstate: 'up' }],
    networkGatewayDefault: async () => '192.168.1.1',
    wifiConnections: async () => [{ iface: 'wlan0', ssid: 'Home', signalLevel: -58, quality: 84, txRate: 433 }],
  };
  const c = await localConnection(si, { servers: () => ['192.168.1.1', '1.1.1.1'] });
  assert.equal(c.kind, 'wifi'); assert.equal(c.adapter, 'Wi-Fi'); assert.equal(c.linkMbps, 866); assert.equal(c.signal.dBm, -58); assert.equal(c.signal.ssid, 'Home');
  assert.equal(c.gateway, '192.168.1.1'); assert.deepEqual(c.dnsServers, ['192.168.1.1', '1.1.1.1']); assert.equal(c.others[0].adapter, 'Ethernet 2');
  const wired = await localConnection({ networkInterfaces: async () => [{ iface: 'eth0', ip4: '192.168.0.9', type: 'wired', speed: -1, default: true, operstate: 'up' }], networkGatewayDefault: async () => { throw new Error('no'); }, wifiConnections: async () => [] }, { servers: () => [] });
  assert.equal(wired.kind, 'cable'); assert.equal(wired.linkMbps, null, 'no made-up link speed'); assert.equal(wired.signal, null); assert.equal(wired.gateway, null);
  const none = await localConnection({ networkInterfaces: async () => [], networkGatewayDefault: async () => '', wifiConnections: async () => [] }, { servers: () => [] });
  assert.equal(none.connected, false);
});

test('A: public address, AS number and operator from three ordinary requests (stand-in services)', async () => {
  const s = await standIn(({ host, path, res }) => {
    if (host === 'www.cloudflare.com') return res.end('fl=1\nip=203.0.113.7\nloc=IN\ncolo=BOM\n');
    if (path.includes('network-info')) { assert.match(path, /resource=203\.0\.113\.7/); return res.end(JSON.stringify({ data: { asns: ['64500'], prefix: '203.0.113.0/24' } })); }
    if (path.includes('as-overview')) { assert.match(path, /resource=AS64500/); return res.end(JSON.stringify({ data: { holder: 'EXAMPLE-NET - Example Networks' } })); }
    res.writeHead(404); res.end();
  });
  try {
    const r = await publicAddress(s.fetch);
    assert.equal(r.ip, '203.0.113.7'); assert.equal(r.asn, 64500); assert.equal(r.operator, 'EXAMPLE-NET - Example Networks'); assert.equal(r.country, 'IN'); assert.equal(r.prefix, '203.0.113.0/24');
    assert.deepEqual(s.seen.map(x => x.host), ['www.cloudflare.com', 'stat.ripe.net', 'stat.ripe.net']);
  } finally { await s.close(); }
});

test('B: latency, jitter and loss from several tiny requests; a lost request counts as loss', async () => {
  let n = 0;
  const s = await standIn(async ({ res }) => { n++; if (n === 4) { await new Promise(r => setTimeout(r, 400)); } res.end(''); });
  try {
    const r = await runLatency(s.fetch, { rounds: 5, timeoutMs: 200, pauseMs: 0 });
    assert.equal(s.seen.length, 6, 'one warm-up plus five'); assert.equal(r.lost, 1); assert.equal(r.lossPct, 20); assert.ok(r.pingMs >= 0); assert.ok(r.jitterMs >= 0);
  } finally { await s.close(); }
});

test('E: one plain sentence says where the fault is', () => {
  const all = { adapter: true, gateway: true, systemDns: true, publicDns: true, sites: [{ url: 'https://a.example/', ok: true }, { url: 'https://b.example/', ok: true }] };
  assert.match(verdict({ ...all, adapter: false }).line, /not connected to any network/);
  assert.equal(verdict({ ...all, gateway: false }).line, 'Your Wi-Fi or cable is connected but your router does not answer. Restart the router.');
  assert.equal(verdict({ ...all, systemDns: false, sites: all.sites.map(s => ({ ...s, ok: false })) }).line, 'DNS is failing; sites by address work. Change the DNS server on this PC or restart the router.');
  assert.match(verdict({ ...all, systemDns: false }).line, /^Websites answer, but this PC’s own DNS/, 'named sites that answer mean a proxy or VPN resolves them');
  assert.match(verdict({ ...all, systemDns: false, publicDns: false, sites: all.sites.map(s => ({ ...s, ok: false })) }).line, /nothing beyond it/);
  assert.match(verdict({ ...all, target: { url: 'https://shop.example/', ok: false, status: 503 } }).line, /^Everything here works; shop\.example is down or refusing \(it answered 503\)/);
  assert.equal(verdict(all).where, 'none');
});

test('E: the router knock counts a refusal as an answer', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r));
  const open = srv.address().port; srv.close(); await new Promise(r => setTimeout(r, 50));
  assert.equal((await knock('127.0.0.1', [open])).ok, true, 'a closed port answers with a refusal: the host is there');
});

test('G: devices are counted only inside this PC’s own subnets, by its own netmask', () => {
  const ifaces = [{ family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', private: true }, { family: 'IPv4', address: '10.8.0.2', netmask: '255.255.0.0', private: true }, { family: 'IPv4', address: '8.8.4.4', netmask: '255.255.255.0', private: false }];
  for (const ip of ['192.168.1.1', '192.168.1.254', '10.8.200.3']) assert.equal(inOwnSubnet(ip, ifaces), true, ip);
  for (const ip of ['192.168.2.1', '10.9.0.1', '8.8.4.1', 'x']) assert.equal(inOwnSubnet(ip, ifaces), false, ip);
});

test('J: listening ports, local or network, with the desk and Ollama marked', () => {
  const rows = listening([
    { protocol: 'tcp', localAddress: '127.0.0.1', localPort: '3960', state: 'LISTEN', process: 'node', pid: 10 },
    { protocol: 'tcp6', localAddress: '::', localPort: '11434', state: 'LISTEN', process: 'ollama', pid: 11 },
    { protocol: 'tcp', localAddress: '0.0.0.0', localPort: '445', state: 'LISTEN', process: '', pid: 4 },
    { protocol: 'tcp', localAddress: '192.168.1.20', localPort: '51000', peerAddress: '1.2.3.4', state: 'ESTABLISHED' },
    { protocol: 'udp', localAddress: '0.0.0.0', localPort: '5353', peerAddress: '*', process: 'mdns' },
  ], { deskPort: 3960 });
  assert.equal(rows.length, 4, 'an outgoing connection is not a listening port');
  assert.deepEqual(rows.slice(0, 2).map(r => r.mark), ['Ollama', 'AP Desk']);
  assert.equal(rows.find(r => r.port === 3960).scope, 'this PC only'); assert.equal(rows.find(r => r.port === 445).scope, 'the network'); assert.equal(rows.find(r => r.port === 445).program, null);
});

test('H: mail set-up read from TXT records, each with what it means; reminders at 30 and 7 days, once each', () => {
  const m = mailHealth({ rootTxt: ['"v=spf1 include:_spf.google.com ~all"'], dmarcTxt: ['"v=DMARC1; p=none; rua=mailto:x@example.com"'], dkimTxt: { google: ['"v=DKIM1; k=rsa; p=MIIB"'], old: ['v=DKIM1; p='], none: [] } });
  assert.equal(m.spf.ok, true); assert.match(m.spf.means, /marked as suspect/);
  assert.equal(m.dmarc.policy, 'none'); assert.match(m.dmarc.means, /only watches/);
  assert.deepEqual(m.dkim.map(k => k.ok), [true, false, false]);
  assert.match(mailHealth({ rootTxt: ['v=spf1 +all'] }).spf.means, /every server in the world/);
  assert.equal(mailHealth({ rootTxt: ['v=spf1 -all', 'v=spf1 ~all'] }).spf.ok, false);
  const now = Date.UTC(2026, 10, 21);
  const certTo = new Date(now + 20 * 86400_000).toISOString();
  const d1 = remindersDue({ certTo }, {}, now); assert.equal(d1.length, 1); assert.equal(d1[0].at, 30);
  const said = Object.fromEntries(d1[0].keys.map(k => [k, 'x']));
  assert.equal(remindersDue({ certTo }, said, now + 86400_000).length, 0, 'said once');
  const d7 = remindersDue({ certTo }, said, now + 14 * 86400_000); assert.equal(d7.length, 1); assert.equal(d7[0].at, 7);
  assert.equal(remindersDue({ certTo: new Date(now + 3 * 86400_000).toISOString() }, {}, now)[0].keys.length, 2, 'a late first look says the 7-day one only');
  assert.equal(daysUntil(certTo, now), 20); assert.match(expiryLine('registration', 5), /Renew it now/); assert.match(expiryLine('cert', -2), /expired 2 days ago/);
});

test('K: certificate-log names, site profile, archive and Shodan from stand-in services', async () => {
  const s = await standIn(({ host, path, res }) => {
    if (host === 'crt.sh') { assert.match(path, /q=%25\.example\.com&output=json/); return res.end(JSON.stringify([{ name_value: '*.example.com\nexample.com', not_after: '2026-12-25T00:00:00', issuer_name: 'C=US, O=X, CN=Test CA' }, { name_value: 'mail.example.com\nevil.other.com', not_after: '2025-01-01T00:00:00', issuer_name: 'CN=Old' }])); }
    if (host === 'example.com') { res.writeHead(200, { 'content-type': 'text/html', 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', server: 'nginx/1.25.3' }); return res.end('<html><script src="https://www.googletagmanager.com/gtag/js?id=1"></script><link href="/wp-content/x.css"></html>'); }
    if (host === 'archive.org') { const ts = path.includes('timestamp=2015') ? '20150102000131' : '20240105101010'; return res.end(JSON.stringify({ archived_snapshots: { closest: { available: true, status: '200', timestamp: ts, url: `http://web.archive.org/web/${ts}/https://example.com/` } } })); }
    if (host === 'web.archive.org') return res.end(JSON.stringify([['timestamp', 'statuscode'], ['20150102000131', '200'], ['20150203000000', '200']]));
    if (host === 'api.shodan.io') { assert.match(path, /\/dns\/domain\/example\.com\?key=K/); return res.end(JSON.stringify({ subdomains: ['www'], tags: ['spf'], data: [{ subdomain: 'www', type: 'A', value: '93.184.216.34', last_seen: '2026-11-20T00:00:00' }] })); }
    res.writeHead(404); res.end();
  });
  try {
    const sub = await certSubdomains(s.fetch, 'example.com');
    assert.deepEqual(sub.subdomains.map(x => x.name), ['example.com', 'mail.example.com']); assert.equal(sub.subdomains[0].wildcard, true);
    const p = await siteProfile(s.fetch, 'https://example.com/');
    assert.ok(p.builtWith.includes('WordPress') && p.builtWith.includes('nginx')); assert.deepEqual(p.trackers, ['Google Analytics']);
    assert.equal(p.versionLeaks[0], 'server: nginx/1.25.3'); assert.ok(['C', 'D', 'E', 'F'].includes(p.grade));
    const a = await waybackClosest(s.fetch, 'example.com', '2015-01-01'); assert.equal(a.found, true); assert.equal(a.at, '2015-01-02T00:01:31Z'); assert.match(a.url, /^https:\/\/web\.archive\.org\/web\/20150102000131\//);
    await assert.rejects(waybackClosest(s.fetch, 'example.com', 'yesterday'), /Give a date/);
    assert.deepEqual((await waybackList(s.fetch, 'example.com')).captures, ['2015-01-02', '2015-02-03']);
    await assert.rejects(shodanDomain(s.fetch, 'example.com', null), /Add your Shodan key/);
    const before = s.seen.length;
    const sh = await shodanDomain(s.fetch, 'example.com', 'K'); assert.equal(sh.records[0].name, 'www.example.com'); assert.equal(s.seen.length, before + 1);
  } finally { await s.close(); }
});
