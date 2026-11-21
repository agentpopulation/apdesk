// Part 2 of the Network page, the pure parts: registrar readings and their timeline, route tracing with recorded
// output from each system's tool, and the route diff. No outside service and no real tool is run here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readingFrom, readingChanges, timeline, registrarIssues, changeText } from './registrar.js';
import { parseTrace, toolArgs, toolsFor, trace, diffRoutes, systemRunner } from './route.js';
import { lookupRdap } from './lookup.js';
import { standIn } from './standin.js';

const DAY = 86400_000;

test('registrar: a reading keeps registrar, name servers, status, created and expiry from RDAP (stand-in registry)', async () => {
  const s = await standIn(({ host, path, res }) => {
    if (host === 'data.iana.org') return res.end(JSON.stringify({ services: [[['example'], ['https://rdap.registry.example/']]] }));
    if (host === 'rdap.registry.example' && path === '/domain/mine.example') return res.end(JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2019-03-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-01T00:00:00Z' }],
      entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar Ltd']]] }], status: ['client transfer prohibited', 'active'], nameservers: [{ ldhName: 'NS2.HOST.EXAMPLE' }, { ldhName: 'ns1.host.example' }] }));
    res.writeHead(404); res.end();
  });
  try {
    const r = readingFrom(await lookupRdap(s.fetch, 'mine.example'), '2026-11-21T00:00:00Z');
    assert.equal(r.registrar, 'Example Registrar Ltd'); assert.deepEqual(r.nameservers, ['ns1.host.example', 'ns2.host.example']);
    assert.deepEqual(r.status, ['active', 'client transfer prohibited']); assert.equal(r.created, '2019-03-01T00:00:00Z'); assert.equal(r.expires, '2027-03-01T00:00:00Z');
  } finally { await s.close(); }
});

test('registrar: the timeline shows only what changed (registrar, name servers, expiry), newest first', () => {
  const a = { at: '1', registrar: 'A', nameservers: ['ns1.a'], status: ['active'], expires: '2027-01-01' };
  const b = { ...a, at: '2', status: ['active', 'locked'] };                       // status alone is not a timeline change
  const c = { ...b, at: '3', nameservers: ['ns1.b'], expires: '2028-01-01' };
  const d = { ...c, at: '4', registrar: 'B' };
  assert.deepEqual(readingChanges(a, b), []);
  assert.deepEqual(readingChanges(b, c).map(x => x.field), ['nameservers', 'expires']);
  const t = timeline([a, b, c, d]);
  assert.deepEqual(t.map(x => x.at), ['4', '3']); assert.deepEqual(t[0].changes[0], { field: 'registrar', label: 'Registrar', old: 'A', new: 'B' });
});

test('registrar: expiry within 30 days and a recent change become issues', () => {
  const now = Date.UTC(2026, 10, 21);
  const iss = registrarIssues([
    { domain: 'soon.example', expires: new Date(now + 20 * DAY).toISOString() },
    { domain: 'urgent.example', expires: new Date(now + 3 * DAY).toISOString() },
    { domain: 'far.example', expires: new Date(now + 200 * DAY).toISOString(), lastChange: { at: new Date(now - 2 * DAY).toISOString(), changes: [{ label: 'Registrar', old: 'A', new: 'B' }] } },
    { domain: 'old.example', expires: null, lastChange: { at: new Date(now - 30 * DAY).toISOString(), changes: [{ label: 'Registrar', old: 'A', new: 'B' }] } },
  ], now);
  assert.deepEqual(iss.map(i => [i.key, i.severity]), [['reg|soon.example', 'warn'], ['reg|urgent.example', 'critical'], ['regchange|far.example', 'warn']]);
  assert.match(iss[2].detail, /Registrar: A → B/);
});

// recorded output, one per system
const TRACERT = `
Tracing route to 93.184.216.34 over a maximum of 20 hops

  1    <1 ms    <1 ms    <1 ms  192.168.1.1
  2     8 ms     7 ms     9 ms  100.64.0.1
  3     *        *        *     Request timed out.
  4    14 ms    12 ms    13 ms  203.0.113.9
  5    21 ms    20 ms    22 ms  93.184.216.34

Trace complete.
`;
const TRACEROUTE_LINUX = `traceroute to 93.184.216.34 (93.184.216.34), 20 hops max, 60 byte packets
 1  192.168.1.1  0.512 ms
 2  *
 3  203.0.113.9  12.840 ms
 4  93.184.216.34  20.113 ms
`;
const TRACEROUTE_MAC = `traceroute to 93.184.216.34 (93.184.216.34), 20 hops max, 52 byte packets
 1  192.168.0.1  2.345 ms
 2  198.51.100.1  9.876 ms
 3  93.184.216.34  19.004 ms
`;
const TRACEPATH = ` 1?: [LOCALHOST]                      pmtu 1500
 1:  192.168.1.1                                           0.402ms
 1:  192.168.1.1                                           0.388ms
 2:  no reply
 3:  203.0.113.9                                          13.112ms
 4:  93.184.216.34                                        20.500ms reached
     Resume: pmtu 1500 hops 4 back 4
`;

test('route: each system’s output is read into hops with time per hop; a silent hop has no address', () => {
  assert.deepEqual(parseTrace('tracert', TRACERT), [{ hop: 1, ip: '192.168.1.1', ms: 1 }, { hop: 2, ip: '100.64.0.1', ms: 7 }, { hop: 3, ip: null, ms: null }, { hop: 4, ip: '203.0.113.9', ms: 12 }, { hop: 5, ip: '93.184.216.34', ms: 20 }]);
  assert.deepEqual(parseTrace('traceroute', TRACEROUTE_LINUX), [{ hop: 1, ip: '192.168.1.1', ms: 0.5 }, { hop: 2, ip: null, ms: null }, { hop: 3, ip: '203.0.113.9', ms: 12.8 }, { hop: 4, ip: '93.184.216.34', ms: 20.1 }]);
  assert.deepEqual(parseTrace('traceroute', TRACEROUTE_MAC).map(h => h.ip), ['192.168.0.1', '198.51.100.1', '93.184.216.34']);
  assert.deepEqual(parseTrace('tracepath', TRACEPATH), [{ hop: 1, ip: '192.168.1.1', ms: 0.4 }, { hop: 2, ip: null, ms: null }, { hop: 3, ip: '203.0.113.9', ms: 13.1 }, { hop: 4, ip: '93.184.216.34', ms: 20.5 }]);
});

test('route: the hop and time limits are passed; numbers only; the tool per system', () => {
  assert.deepEqual(toolsFor('win32'), ['tracert']); assert.deepEqual(toolsFor('linux'), ['traceroute', 'tracepath']); assert.deepEqual(toolsFor('darwin'), ['traceroute', 'tracepath']);
  assert.deepEqual(toolArgs('tracert', '1.2.3.4'), ['-d', '-h', '20', '-w', '1500', '1.2.3.4']);
  assert.deepEqual(toolArgs('traceroute', '1.2.3.4', { maxHops: 99 }), ['-n', '-m', '30', '-w', '2', '-q', '1', '1.2.3.4']);
  assert.deepEqual(toolArgs('tracepath', '1.2.3.4'), ['-n', '-m', '20', '1.2.3.4']);
});

test('route: the first installed tool runs with a time limit; with none installed its name is said and nothing else runs', async () => {
  const calls = [];
  const missing = (name) => Object.assign(new Error('spawn ' + name + ' ENOENT'), { code: 'ENOENT' });
  const run = async (tool, args, o) => { calls.push([tool, o.timeoutMs]); if (tool === 'traceroute') throw missing(tool); return { stdout: TRACEPATH }; };
  const r = await trace('93.184.216.34', { platform: 'linux', run, timeoutMs: 5000 });
  assert.equal(r.tool, 'tracepath'); assert.equal(r.hops.length, 4); assert.deepEqual(calls, [['traceroute', 5000], ['tracepath', 5000]]);
  assert.deepEqual(await trace('93.184.216.34', { platform: 'win32', run: async (t) => { throw missing(t); } }), { missing: 'tracert' });
  assert.deepEqual(await trace('93.184.216.34', { platform: 'darwin', run: async (t) => { throw missing(t); } }), { missing: 'traceroute or tracepath' });
  await assert.rejects(trace('example.com', { run }), /IPv4 address/, 'a name never reaches the tool');
});

test('route: the change against the previous run names each hop that moved', () => {
  const a = { hops: parseTrace('traceroute', TRACEROUTE_LINUX) };
  const b = { hops: parseTrace('traceroute', TRACEROUTE_LINUX.replace('203.0.113.9', '203.0.113.77')) };
  assert.equal(diffRoutes(null, a), null);
  assert.deepEqual(diffRoutes(a, a), { changed: false, hopsBefore: 4, hopsAfter: 4, lines: [] });
  assert.deepEqual(diffRoutes(a, b).lines, [{ hop: 3, old: '203.0.113.9', new: '203.0.113.77' }]);
});

test('registrar: a changed expiry date is written in the owner’s zone, never as a raw UTC time', () => {
  const now = Date.UTC(2026, 10, 21);
  const changes = [{ field: 'expires', label: 'Expiry date', old: '2030-01-01T00:00:00Z', new: '2026-12-01T00:00:00Z' }, { field: 'registrar', label: 'Registrar', old: 'A', new: null }];
  const zone = { timeZone: 'America/Los_Angeles', locale: 'en-GB' };
  assert.equal(changeText(changes, zone), 'Expiry date: 31 Dec 2029 → 30 Nov 2026; Registrar: A → none', 'the owner’s zone decides the day');
  const iss = registrarIssues([{ domain: 'mine.example', expires: null, lastChange: { at: new Date(now - DAY).toISOString(), changes } }], now, zone);
  assert.equal(iss[0].detail, 'Expiry date: 31 Dec 2029 → 30 Nov 2026; Registrar: A → none');
  assert.doesNotMatch(iss[0].detail, /T\d\d:\d\d|Z\b/);
});

test('route: a tool that ends with an error is not a run; the next tool is tried; when none works the source is unavailable', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(systemRunner('sh', ['-c', 'echo bad >&2; exit 2']), (e) => e.code === 'tool_failed');
  const failing = (t, a, o) => systemRunner('sh', ['-c', 'echo bad >&2; exit 2'], o);
  await assert.rejects(trace('8.8.8.8', { platform: 'linux', run: failing }), (e) => e.code === 'tool_failed' && /Source unavailable/.test(e.message) && /traceroute/.test(e.message));
  const calls = [];
  const r = await trace('93.184.216.34', { platform: 'linux', run: async (tool, args, o) => { calls.push(tool); if (tool === 'traceroute') return failing(tool, args, o); return { stdout: TRACEPATH }; } });
  assert.deepEqual(calls, ['traceroute', 'tracepath']); assert.equal(r.tool, 'tracepath'); assert.equal(r.hops.length, 4);
  const partial = await trace('93.184.216.34', { platform: 'linux', run: async () => { throw Object.assign(new Error('exit 1'), { code: 'tool_failed', stdout: TRACEROUTE_LINUX }); } });
  assert.equal(partial.tool, 'traceroute'); assert.equal(partial.hops.length, 4, 'an error exit with hops printed keeps the hops');
});
