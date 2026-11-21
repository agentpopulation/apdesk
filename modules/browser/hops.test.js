// Real Chromium: every request the agent's browser makes, at every hop, passes the guard. Stand-in sites on loopback:
// a stand-in DNS (testNet.lookup) gives the names, and testNet.publicAddr lets one loopback port play a public site.
// The other loopback port plays this PC or the home network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Computer } from './computer.js';
import { launchChoice } from './launch.js';
import { PRIVATE_LINE, startHopGuard } from './hop-guard.js';
import { OFFLINE_LINE } from './guard.js';
import { setRules, setAsker, clearRules } from '../network/rules.js';

const noBrowser = !launchChoice({ agentId: 'x', dataDir: os.tmpdir() }).ok && 'no browser here';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const upgraded = [];
const wsAccept = (req, sock) => { upgraded.push(sock); sock.on('error', () => {}); const k = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${k}\r\n\r\n`); };

const pubHits = [], privHits = [];
let PUB, PP;
const priv = http.createServer((req, res) => { privHits.push(req.headers.host + req.url); res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' }); res.end('PRIVATE'); });
priv.on('upgrade', (req, sock) => { privHits.push('ws ' + req.url); wsAccept(req, sock); });
priv.on('clientError', (e, sock) => { privHits.push('raw bytes'); sock.destroy(); });   // a TURN relay speaks no HTTP
priv.on('connect', (req, sock) => { privHits.push('connect ' + req.url); sock.destroy(); });
const KIND = {
  frame: (u) => `<iframe src="${u}/frame"></iframe>`,
  img: (u) => `<img src="${u}/img.png">`,
  script: (u) => `<script src="${u}/s.js"></script>`,
  css: (u) => `<link rel="stylesheet" href="${u}/s.css">`,
  fetch: (u) => `<script>fetch('${u}/fetch').catch(() => {})</script>`,
  xhr: (u) => `<script>const x = new XMLHttpRequest(); x.open('GET', '${u}/xhr'); x.send();</script>`,
  ws: (u) => `<script>new WebSocket('${u.replace(/^http/, 'ws')}/ws')</script>`,
  beacon: (u) => `<script>navigator.sendBeacon('${u}/beacon', 'x')</script>`,
  turn: (u) => `<script>(async () => { const h = new URL('${u}').host; const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:' + h + '?transport=tcp', username: 'a', credential: 'b' }] }); pc.createDataChannel('d'); await pc.setLocalDescription(await pc.createOffer()); })().catch(() => {})</script>`,
};
const pub = http.createServer((req, res) => {
  pubHits.push(req.headers.host + req.url);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/r') { res.writeHead(302, { location: u.searchParams.get('to') }); return res.end(); }
  if (u.pathname.startsWith('/k/')) { const [, , kind, ...rest] = u.pathname.split('/'); res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<html><body><p>kind ${kind}</p>${KIND[kind]('http://' + rest.join('/'))}</body></html>`); }
  if (u.pathname === '/full') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<html><head><link rel="stylesheet" href="http://cdn.example:${PUB}/a.css"></head><body><h1 id="h">Shop</h1>
      <img id="i" src="http://cdn.example:${PUB}/a.png"><iframe id="f" src="http://shop.example:${PUB}/inner"></iframe>
      <script src="http://cdn.example:${PUB}/a.js"></script>
      <script>window.got = {}; fetch('http://cdn.example:${PUB}/api').then(r => r.text()).then(t => { got.fetch = t; });
        const w = new WebSocket('ws://shop.example:${PUB}/live'); w.onopen = () => { got.ws = 'open'; };</script>
      ${Array.from({ length: 30 }, (_, n) => `<img src="http://cdn.example:${PUB}/p${n}.png">`).join('')}
      <a id="link" href="/inner" style="display:block;width:100vw;height:100vh">next</a></body></html>`);
  }
  if (u.pathname === '/inner') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p id="inner">INNER PAGE</p>'); }
  if (u.pathname === '/link') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<a href="${u.searchParams.get('to')}" style="display:block;width:100vw;height:100vh">go</a>`); }
  if (u.pathname.endsWith('.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  if (u.pathname.endsWith('.css')) { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('#h { color: rgb(1, 2, 3); }'); }
  if (u.pathname.endsWith('.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.scriptRan = true;'); }
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end('API OK');
});
pub.on('upgrade', (req, sock) => { pubHits.push('ws ' + req.url); wsAccept(req, sock); });

const lookups = [];
const NAMES = ['shop.example', 'cdn.example', 'rebind.example', 'blocked.example', 'www.blocked.example', 'careful.example'];
const lookup = async (host) => { lookups.push(host); if (NAMES.includes(host)) return [{ address: '127.0.0.1', family: 4 }]; throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); };
let c, opts = {}, refusals = [], dataDir;
const shop = (p) => `http://shop.example:${PUB}${p}`;
const settle = () => c.page.waitForTimeout(1200);

test('hops', { skip: noBrowser }, async (t) => {
  await new Promise(r => priv.listen(0, '127.0.0.1', r)); await new Promise(r => pub.listen(0, '127.0.0.1', r));
  PP = priv.address().port; PUB = pub.address().port;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-hops-'));
  c = new Computer({ agentId: 'hops', dataDir, guardOpts: () => ({ deskPort: 3960, ...opts }), testNet: { lookup, publicAddr: (a, port) => port === PUB, upstream: null } });
  const onRefused = c.onHopRefused.bind(c); c.onHopRefused = (r) => { refusals.push(`${r.host}:${r.port}`); onRefused(r); };
  t.after(async () => { clearRules(); await c.close(); for (const u of upgraded) u.destroy(); priv.closeAllConnections(); pub.closeAllConnections(); priv.close(); pub.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await c.start();
  const fresh = () => { privHits.length = 0; pubHits.length = 0; refusals.length = 0; opts = {}; c.driving = 'agent'; c.jobId = null; };

  await t.test('a redirect to a private address is stopped before it is requested, with a plain reason', async () => {
    for (const to of [`http://127.0.0.1:${PP}/hop`, `http://localhost:${PP}/hop`, `http://sub.thing.localhost.:${PP}/hop`, `http://rebind.example:${PP}/hop`, `http://[::ffff:127.0.0.1]:${PP}/hop`]) {
      fresh();
      await assert.rejects(c.goto(shop('/r?to=' + encodeURIComponent(to))), (e) => e.code === 'refused' && e.message === PRIVATE_LINE, to);
      assert.deepEqual(privHits, [], 'never requested: ' + to);
      assert.deepEqual(pubHits, [`shop.example:${PUB}/r?to=${encodeURIComponent(to)}`]);
      assert.equal(c.blocked.at(-1).why, PRIVATE_LINE);
      assert.equal(c.page.url(), 'about:blank');
    }
  });

  await t.test('a frame, image, script, style sheet, fetch, XHR, beacon, WebSocket and TURN relay to a private address are each stopped', async () => {
    const reached = [], unseen = [];
    for (const kind of Object.keys(KIND)) for (const target of [`rebind.example:${PP}`, `127.0.0.1:${PP}`]) {
      fresh();
      await c.goto(shop(`/k/${kind}/${target}`)); await settle();
      assert.equal(await c.page.textContent('p'), 'kind ' + kind, 'the page itself loads');
      if (privHits.length) reached.push(`${kind} to ${target}`);
      if (target.startsWith('rebind') && !refusals.includes(`rebind.example:${PP}`)) unseen.push(kind);
    }
    assert.deepEqual(reached, [], 'these reached the private site');
    assert.deepEqual(unseen, [], 'the guard saw and stopped each of these');
  });

  await t.test('WebRTC sends no UDP of its own (STUN to this PC); service workers are off for these profiles', async () => {
    fresh();
    const udp = dgram.createSocket('udp4'); const got = []; udp.on('message', () => got.push(1)); await new Promise(r => udp.bind(0, '127.0.0.1', r));
    await c.goto(shop('/inner'));
    await c.page.evaluate(async (port) => { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:' + port }] }); pc.createDataChannel('d'); await pc.setLocalDescription(await pc.createOffer()); }, udp.address().port);
    await c.page.waitForTimeout(2000); udp.close();
    assert.deepEqual(got, []);
    assert.equal(launchChoice({ agentId: 'x', dataDir: os.tmpdir() }).options.serviceWorkers, 'block');
  });

  await t.test('a public name that resolves to a private address is stopped (the guard connects only to the address it checked)', async () => {
    fresh();
    await assert.rejects(c.goto(`http://rebind.example:${PP}/direct`), (e) => e.code === 'refused');
    assert.deepEqual(privHits, []);
    assert.ok(refusals.includes(`rebind.example:${PP}`));
  });

  await t.test('an ordinary public page with many resources loads fully; one DNS look-up per name, not per image', async () => {
    fresh(); lookups.length = 0; await c.close(); await c.start();   // a fresh guard: an empty look-up cache
    await c.goto(shop('/full'));
    await c.page.waitForFunction(() => window.got?.fetch && window.got?.ws && [...document.images].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
    const got = await c.page.evaluate(() => ({ ...window.got, script: window.scriptRan, color: getComputedStyle(document.getElementById('h')).color, imgs: document.images.length }));
    assert.deepEqual(got, { fetch: 'API OK', ws: 'open', script: true, color: 'rgb(1, 2, 3)', imgs: 31 });
    assert.equal(await c.page.frames()[1].textContent('#inner'), 'INNER PAGE');
    assert.deepEqual(refusals, []);
    assert.ok(pubHits.includes('ws /live'));
    assert.equal(lookups.filter(h => h === 'cdn.example').length, 1, lookups.join(', '));
    assert.equal(lookups.filter(h => h === 'shop.example').length, 1, lookups.join(', '));
  });

  await t.test('website rules hold on redirects: never (for the owner too, as before) and ask first', async () => {
    setRules({ never: ['blocked.example'], ask: ['careful.example'] });
    fresh();
    await assert.rejects(c.goto(shop('/r?to=' + encodeURIComponent(`http://www.blocked.example:${PUB}/x`))), (e) => /never open blocked\.example/.test(e.message));
    assert.ok(!pubHits.some(h => h.startsWith('www.blocked')), pubHits.join(', '));
    fresh(); c.driving = 'owner';
    await assert.rejects(c.goto(shop('/r?to=' + encodeURIComponent(`http://blocked.example:${PUB}/x`))), (e) => /never open/.test(e.message));
    assert.ok(!pubHits.some(h => h.startsWith('blocked')));
    fresh(); c.jobId = 'job-a';
    await assert.rejects(c.goto(shop('/r?to=' + encodeURIComponent(`http://careful.example:${PUB}/x`))), (e) => /asked to be asked before agents open careful\.example/.test(e.message));
    assert.ok(!pubHits.some(h => h.startsWith('careful')), 'not without a yes');
    setAsker(async () => true);
    await c.goto(`http://careful.example:${PUB}/inner`);   // the agent opens it directly: the owner is asked, says yes
    await c.goto(shop('/r?to=' + encodeURIComponent(`http://careful.example:${PUB}/inner`)));
    assert.equal(await c.page.textContent('#inner'), 'INNER PAGE', 'after a yes for this job the redirect goes through');
    clearRules();
  });

  await t.test('take over: the owner clicking a link into the home network is stopped too; ordinary links work', async () => {
    fresh(); c.goal = null;
    await c.goto(shop('/link?to=' + encodeURIComponent(`http://rebind.example:${PP}/owner`)));
    c.takeOver();
    await c.input({ type: 'click', fx: 0.5, fy: 0.5 });
    assert.deepEqual(privHits, []);
    assert.equal(c.steps.at(-1).text, PRIVATE_LINE);
    assert.equal(c.page.url(), 'about:blank');
    await c.goto(shop('/link?to=' + encodeURIComponent(shop('/inner'))));
    const r = await c.input({ type: 'click', fx: 0.5, fy: 0.5 });
    assert.equal(r.url, shop('/inner'));
    c.handBack();
  });

  await t.test('Offline: a redirect out of a page on this PC is stopped without even a name look-up', async () => {
    fresh(); opts = { offline: true, allowHosts: ['localhost'] }; lookups.length = 0;
    await assert.rejects(c.goto(`http://localhost:${PUB}/r?to=` + encodeURIComponent(`http://cdn.example:${PUB}/x`)), (e) => e.message === OFFLINE_LINE);
    assert.deepEqual(lookups, []);
    assert.ok(!pubHits.some(h => h.startsWith('cdn.')));
    await c.goto(`http://localhost:${PUB}/inner`);
    assert.equal(await c.page.textContent('#inner'), 'INNER PAGE', 'a page on this PC the owner allowed still opens');
  });
});

test('the test hooks cannot be set from a request or a tool: the module never passes them', () => {
  const src = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /testNet|publicAddr|lookup\s*:/);
});

test('behind the proxy this PC already uses: names are passed on, but a name that resolves here to a private address is not', async () => {
  const seen = [];
  const up = net.createServer((sock) => sock.once('data', (b) => { seen.push(String(b).split('\r\n')[0]); sock.end('HTTP/1.1 200 OK\r\n\r\n'); }));
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const refused = [];
  const lookup = async (h) => { if (h === 'evil.example') return [{ address: '10.0.0.7', family: 4 }]; throw new Error('no local DNS'); };
  const g = await startHopGuard({ opts: () => ({ deskPort: 3960 }), lookup, onRefuse: (r) => refused.push(r.host), upstream: { host: '127.0.0.1', port: up.address().port, auth: null } });
  const connect = (target) => new Promise((resolve) => { const s = net.connect(g.port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)); s.once('data', (b) => { resolve(String(b).split('\r\n')[0]); s.destroy(); }); s.on('error', () => resolve('error')); });
  try {
    assert.equal(await connect('en.wikipedia.org:443'), 'HTTP/1.1 200 Connection Established');
    assert.deepEqual(seen, ['CONNECT en.wikipedia.org:443 HTTP/1.1']);
    assert.equal(await connect('evil.example:443'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await connect('192.168.1.1:80'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await connect('127.0.0.1:3960'), 'HTTP/1.1 403 Forbidden');
    assert.equal(seen.length, 1, 'the refused ones never reached the upstream');
    assert.deepEqual(refused, ['evil.example', '192.168.1.1', '127.0.0.1']);
  } finally { await g.close(); up.close(); }
});
