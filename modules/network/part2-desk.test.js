// Part 2 of the Network page on a throwaway desk: registrar history, route tracing, where things are, and messages a
// minute. No outside service: route runs use a stand-in tool on PATH with recorded output, and hop operators come
// from the module's own cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { testDesk } from '../../test/helpers/desk.js';

const on = async (mods = ['network']) => { const t = await testDesk({ modules: mods }); await t.call('/api/modules/network/on', { method: 'POST' }); return t; };
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DAY = 86400_000;
const waitJob = async (t, id) => { for (let i = 0; i < 200; i++) { const j = (await t.call('/api/jobs/' + id)).json; if (j && !['running', 'waiting'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 25)); } throw new Error('job did not finish'); };
const reading = (t, domain, at, registrar, ns, expires) => t.core.storage.run('INSERT INTO m_network_reg (at, domain, registrar, nameservers, status, created, expires, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', at, domain, registrar, JSON.stringify(ns), '["active"]', '2019-01-01T00:00:00Z', expires, 'RDAP (test)');

test('W: registrar history is off by default, needs the owner, keeps each reading and shows what changed', async () => {
  const t = await on();
  try {
    await t.call('/api/m/network/domains', { body: { domain: 'mine.example', mine: true } });
    const v0 = (await t.call('/api/m/network/registrar')).json;
    assert.equal(v0.every, 'off', 'nothing looks up by itself'); assert.equal(v0.domains[0].latest, null);
    assert.equal((await t.call('/api/m/network/registrar/mine.example/check', { body: {}, session: false })).status, 403, 'Check now needs the owner');
    assert.equal((await t.call('/api/m/network/registrar/settings', { body: { every: 'daily' }, session: false })).status, 403);
    assert.equal((await t.call('/api/m/network/registrar/settings', { body: { every: 'daily' } })).json.every, 'daily');
    const far = iso(Date.now() + 400 * DAY), soon = iso(Date.now() + 20 * DAY);
    reading(t, 'mine.example', iso(Date.now() - 3 * DAY), 'Old Registrar', ['ns1.a.example'], far);
    reading(t, 'mine.example', iso(Date.now() - 2 * DAY), 'Old Registrar', ['ns1.a.example'], far);
    reading(t, 'mine.example', iso(Date.now() - DAY), 'New Registrar', ['ns1.b.example'], soon);
    const v = (await t.call('/api/m/network/registrar')).json.domains[0];
    assert.equal(v.readings, 3); assert.equal(v.latest.registrar, 'New Registrar');
    assert.equal(v.timeline.length, 1, 'the unchanged reading adds no line');
    assert.deepEqual(v.timeline[0].changes.map(c => c.field), ['registrar', 'nameservers', 'expires']);
    const iss = (await t.call('/api/m/network/issues')).json.issues.map(i => i.key);
    assert.ok(iss.includes('reg|mine.example'), 'expiry within 30 days is an issue'); assert.ok(iss.includes('regchange|mine.example'), 'a change seen is an issue');
    t.core.settings.set('online', false);
    const off = await t.call('/api/m/network/registrar/mine.example/check', { body: {} });
    assert.equal(off.status, 409); assert.match(off.json.error, /offline/);
  } finally { await t.close(); }
});

test('X: routes go only to the owner’s own domains and watched sites, never to this PC or the home network', async () => {
  const t = await on();
  try {
    await t.call('/api/m/network/sites', { body: { url: 'http://192.168.1.10/' } });
    await t.call('/api/m/network/domains', { body: { domain: 'mine.example', mine: true } });
    const v = (await t.call('/api/m/network/route')).json;
    assert.deepEqual(v.targets.map(x => x.target), ['mine.example', '192.168.1.10']);
    assert.equal((await t.call('/api/m/network/route/trace', { body: { target: 'mine.example' }, session: false })).status, 403, 'only the owner traces');
    const other = await t.call('/api/m/network/route/trace', { body: { target: 'someone-else.example' } });
    assert.equal(other.status, 400); assert.match(other.json.error, /your own domains or watched sites/);
    const { jobId } = (await t.call('/api/m/network/route/trace', { body: { target: '192.168.1.10' } })).json;
    const jx = await waitJob(t, jobId);
    assert.equal(jx.status, 'failed'); assert.match(jx.error, /this PC or your home network/, 'the address guard refuses it');
    assert.equal((await t.call('/api/m/network/route')).json.targets[1].runs.length, 0);
  } finally { await t.close(); }
});

test('X: a run with the system tool keeps hops, time per hop, the cached operator and the change from the last run; at most 20 runs', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-trace-')); const out = path.join(bin, 'out.txt');
  fs.writeFileSync(path.join(bin, 'traceroute'), `#!/bin/sh\ncat "${out}"\n`, { mode: 0o755 });
  const write = (mid) => fs.writeFileSync(out, `traceroute to 203.0.113.5 (203.0.113.5), 20 hops max\n 1  192.168.1.1  0.5 ms\n 2  ${mid}  9.1 ms\n 3  203.0.113.5  20.2 ms\n`);
  const oldPath = process.env.PATH; process.env.PATH = bin + path.delimiter + oldPath;
  const t = await on();
  try {
    await t.call('/api/m/network/sites', { body: { url: 'https://203.0.113.5/' } });
    for (const ip of ['198.51.100.1', '198.51.100.2', '203.0.113.5']) t.core.storage.run('INSERT INTO m_network_cache (k, at, value) VALUES (?, ?, ?)', 'asn|' + ip, Date.now(), JSON.stringify({ asn: 64500, operator: 'EXAMPLE-NET' }));
    write('198.51.100.1');
    let jx = await waitJob(t, (await t.call('/api/m/network/route/trace', { body: { target: '203.0.113.5' } })).json.jobId);
    assert.equal(jx.status, 'done', jx.error);
    let run = (await t.call('/api/m/network/route')).json.targets[0].runs[0];
    assert.equal(run.tool, 'traceroute'); assert.deepEqual(run.hops.map(h => [h.ip, h.ms, h.public, h.operator]), [['192.168.1.1', 0.5, false, null], ['198.51.100.1', 9.1, true, 'EXAMPLE-NET'], ['203.0.113.5', 20.2, true, 'EXAMPLE-NET']]);
    assert.equal(run.diff, null, 'the first run has nothing to compare');
    write('198.51.100.2');
    jx = await waitJob(t, (await t.call('/api/m/network/route/trace', { body: { target: '203.0.113.5' } })).json.jobId);
    run = (await t.call('/api/m/network/route')).json.targets[0].runs[0];
    assert.deepEqual(run.diff.lines, [{ hop: 2, old: '198.51.100.1', new: '198.51.100.2' }]);
    const places = (await t.call('/api/m/network/places')).json;
    assert.equal(places.dots, false); assert.ok(places.rows.some(r => r.kind === 'Hop 2 to 203.0.113.5' && r.operator === 'EXAMPLE-NET'));
    assert.ok(places.rows.some(r => r.kind === 'Watched site' && r.address === '203.0.113.5'));
    for (let i = 0; i < 21; i++) t.core.storage.run('INSERT INTO m_network_trace (at, target, address, tool, hops) VALUES (?, ?, ?, ?, ?)', iso(), '203.0.113.5', '203.0.113.5', 'traceroute', '[]');
    jx = await waitJob(t, (await t.call('/api/m/network/route/trace', { body: { target: '203.0.113.5' } })).json.jobId);
    assert.equal(t.core.storage.get('SELECT COUNT(*) AS n FROM m_network_trace WHERE target = ?', '203.0.113.5').n, 20, 'the last 20 runs are kept');
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-empty-'));
    jx = await waitJob(t, (await t.call('/api/m/network/route/trace', { body: { target: '203.0.113.5' } })).json.jobId);
    assert.equal(jx.status, 'done'); assert.match(jx.output.note, /No route tool is installed on this PC \(traceroute or tracepath\)\. Nothing was installed\./);
  } finally { process.env.PATH = oldPath; await t.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('Y: where things are lists the public address, the domains and watched sites; no map dots without a fitting source', async () => {
  const t = await on();
  try {
    const net = t.core.modules.api('network');
    net.recordPublicIp({ ip: '203.0.113.7', asn: 64500, operator: 'EXAMPLE-NET' }, 'owner');
    await t.call('/api/m/network/domains', { body: { domain: 'mine.example', mine: true } });
    const p = (await t.call('/api/m/network/places')).json;
    assert.equal(p.dots, false); assert.match(p.note, /No map/);
    assert.deepEqual(p.rows.map(r => [r.kind, r.name]), [['Your public address', '203.0.113.7'], ['Your domain', 'mine.example']]);
    assert.equal(p.rows[0].operator, 'EXAMPLE-NET'); assert.equal(p.rows[1].country, null, 'no country is made up');
  } finally { await t.close(); }
});

test('N: with Chat on, the strip counts the messages of the last minute', async () => {
  const t = await on(['chat', 'network']);
  try {
    const chat = t.core.modules.api('chat');
    assert.equal(typeof chat?.messagesSince, 'function');
    const c = chat.createChat({ title: 'Test', members: ['scout'] });
    chat.postMessage(c.id, { text: 'one' }); chat.postMessage(c.id, { text: 'two' });
    const s = (await t.call('/api/m/network/status')).json;
    assert.equal(s.messagesPerMin, 2);
  } finally { await t.close(); }
});

// A stand-in for the registry on this process's fetch, and a DNS that answers nothing to the address guard (a failed
// look-up passes it), so no request leaves the machine.
async function withRegistry(answer, fn) {
  const dns = (await import('node:dns')).default;
  const realFetch = globalThis.fetch, realLookup = dns.promises.lookup;
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (u.hostname === 'data.iana.org') return new Response(JSON.stringify({ services: [] }), { headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'rdap.org') { seen.push(u.pathname); return answer(seen.length); }
    return realFetch(input, init);
  };
  dns.promises.lookup = async () => { throw Object.assign(new Error('no dns in tests'), { code: 'ENOTFOUND' }); };
  try { return await fn(seen); } finally { globalThis.fetch = realFetch; dns.promises.lookup = realLookup; }
}
const rdapJson = (expires) => new Response(JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2019-03-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: expires }],
  entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar Ltd']]] }], status: ['active'], nameservers: [{ ldhName: 'ns1.host.example' }] }), { headers: { 'content-type': 'application/rdap+json' } });

test('W: Check now looks the domain up, keeps the reading, tells of a change with dates in the owner’s zone, keeps at most 1000, and says Source unavailable on failure', async () => {
  const t = await on();
  try {
    t.core.settings.set('timeZone', 'America/Los_Angeles'); t.core.settings.set('locale', 'en-GB');
    await t.call('/api/m/network/domains', { body: { domain: 'mine.example', mine: true } });
    await withRegistry((n) => (n === 3 ? new Response('busy', { status: 500 }) : rdapJson(n === 1 ? '2030-01-01T00:00:00Z' : '2026-12-01T00:00:00Z')), async (seen) => {
      const a = (await t.call('/api/m/network/registrar/mine.example/check', { body: {} })).json;
      assert.equal(a.reading.registrar, 'Example Registrar Ltd'); assert.deepEqual(a.changes, []);
      const b = (await t.call('/api/m/network/registrar/mine.example/check', { body: {} })).json;
      assert.deepEqual(b.changes.map(c => c.field), ['expires']);
      assert.deepEqual(seen, ['/domain/mine.example', '/domain/mine.example']);
      const want = 'Expiry date: 31 Dec 2029 → 30 Nov 2026';
      const iss = (await t.call('/api/m/network/issues')).json.issues.find(i => i.key === 'regchange|mine.example');
      assert.equal(iss.detail, want, 'the issue shows dates in the owner’s zone');
      const n = (await t.call('/api/m/network/notices')).json.notices.find(x => x.kind === 'registrar.change');
      assert.equal(n.detail, want, 'the notice (and the activity line and phone) carry the same words');
      const v = (await t.call('/api/m/network/registrar')).json.domains[0];
      assert.equal(v.readings, 2); assert.equal(v.timeline.length, 1);
      const c = (await t.call('/api/m/network/registrar/mine.example/check', { body: {} })).json;
      assert.equal(c.unavailable, true); assert.equal(c.note, 'Source unavailable.');
      assert.equal((await t.call('/api/m/network/registrar')).json.domains[0].readings, 2, 'a failed look-up keeps no reading');
      for (let i = 0; i < 1000; i++) reading(t, 'mine.example', iso(), 'Example Registrar Ltd', ['ns1.host.example'], '2026-12-01T00:00:00Z');
      await t.call('/api/m/network/registrar/mine.example/check', { body: {} });
      assert.equal(t.core.storage.get('SELECT COUNT(*) AS n FROM m_network_reg WHERE domain = ?', 'mine.example').n, 1000, 'the newest 1000 readings are kept');
    });
  } finally { await t.close(); }
});

const fakeTool = (script) => { const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-trace-')); fs.writeFileSync(path.join(bin, 'traceroute'), `#!/bin/sh\n${script}\n`, { mode: 0o755 }); return bin; };

test('X: no route is traced while Offline', async () => {
  const t = await on();
  try {
    await t.call('/api/m/network/sites', { body: { url: 'https://203.0.113.5/' } });
    t.core.settings.set('online', false);
    const r = await t.call('/api/m/network/route/trace', { body: { target: '203.0.113.5' } });
    assert.equal(r.status, 409); assert.match(r.json.error, /offline/);
    assert.equal((await t.call('/api/m/network/route')).json.targets[0].runs.length, 0);
  } finally { await t.close(); }
});

test('X: Panic stops a running trace and keeps no run', { skip: process.platform === 'win32' }, async () => {
  const bin = fakeTool('sleep 20'); const oldPath = process.env.PATH; process.env.PATH = bin + path.delimiter + oldPath;
  const t = await on();
  try {
    await t.call('/api/m/network/sites', { body: { url: 'https://203.0.113.5/' } });
    const { jobId } = (await t.call('/api/m/network/route/trace', { body: { target: '203.0.113.5' } })).json;
    await new Promise(r => setTimeout(r, 300));
    const t0 = Date.now(); await t.core.panic.stopAll('test');
    const jx = await waitJob(t, jobId);
    assert.notEqual(jx.status, 'done'); assert.ok(Date.now() - t0 < 3000, 'the tool is stopped at once, not at its time limit');
    assert.equal((await t.call('/api/m/network/route')).json.targets[0].runs.length, 0);
    t.core.panic.resume();
  } finally { process.env.PATH = oldPath; await t.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});

test('X: a domain whose name points at the home network is refused after the look-up, and the tool never runs', { skip: process.platform === 'win32' }, async () => {
  const bin = fakeTool(`touch "${'$'}(dirname "$0")/ran"`); const oldPath = process.env.PATH; process.env.PATH = bin + path.delimiter + oldPath;
  const dns = (await import('node:dns')).default; const realLookup = dns.promises.lookup;
  dns.promises.lookup = async (host, o = {}) => { if (o.all) throw Object.assign(new Error('no answer'), { code: 'ENOTFOUND' }); return { address: '192.168.1.20', family: 4 }; };
  const t = await on();
  try {
    await t.call('/api/m/network/domains', { body: { domain: 'mine.example', mine: true } });
    const jx = await waitJob(t, (await t.call('/api/m/network/route/trace', { body: { target: 'mine.example' } })).json.jobId);
    assert.equal(jx.status, 'failed'); assert.match(jx.error, /this PC or your home network/);
    assert.equal(fs.existsSync(path.join(bin, 'ran')), false, 'the tool was not run');
    assert.equal((await t.call('/api/m/network/route')).json.targets[0].runs.length, 0);
  } finally { dns.promises.lookup = realLookup; process.env.PATH = oldPath; await t.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
