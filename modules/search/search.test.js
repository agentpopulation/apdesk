// Plumbing tests for Search (no network). Real behaviour is in real-check.mjs.
import test from 'node:test'; import assert from 'node:assert/strict';
import { parseDdgHtml, isDdgChallenge, decodeEntities, normUrl, runChain } from './providers.js';
import { publicUrl, htmlToDoc, readPage } from './reader.js';
import { checkUrl, checkUrlDeep } from './guard.js';
import { testDesk } from '../../test/helpers/desk.js';
import http from 'node:http';

test('DuckDuckGo: results parsed, challenge recognised', () => {
  const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Ex &amp; ample</a> <a class="result__snippet" href="x">Snip &#8217;s</a>';
  assert.deepEqual(parseDdgHtml(html, 5), [{ title: 'Ex & ample', url: 'https://example.com/a', snippet: 'Snip ’s' }]);
  assert.equal(isDdgChallenge(202, ''), true);
  assert.equal(isDdgChallenge(200, '<div class="anomaly-modal">'), true);
  assert.equal(isDdgChallenge(200, html), false);
  assert.equal(decodeEntities('a &amp;#x27; b'), "a ' b");
});
test('chain merges, dedups and falls through on a challenge', async () => {
  const fetch = async (u) => {
    const s = String(u);
    if (s.includes('duckduckgo.com/html')) return new Response('<html>Unfortunately, bots use DuckDuckGo too</html>', { status: 200 });
    if (s.includes('wikipedia.org')) return Response.json({ pages: [{ key: 'A', title: 'A', excerpt: 'x' }, { key: 'B', title: 'B' }, { key: 'C', title: 'C' }, { key: 'D', title: 'D' }] });
    if (s.includes('hn.algolia')) return Response.json({ hits: [{ title: 'h', url: 'https://www.en.wikipedia.org/wiki/A' }, { title: 'h2', url: 'https://news.example/x' }] });
    if (s.includes('api.duckduckgo')) return Response.json({});
    throw new Error('unexpected ' + s);
  };
  const r = await runChain({ fetch, secret: () => null, searxngUrl: null }, 'q', { count: 8 });
  assert.equal(r.attempts.find((a) => a.provider === 'duckduckgo').ok, false);
  assert.match(r.attempts.find((a) => a.provider === 'duckduckgo').note, /bot check/);
  assert.equal(r.results.filter((x) => x.source === 'Wikipedia').length, 3, 'Wikipedia capped at 3');
  assert.ok(r.results.some((x) => x.url === 'https://news.example/x'));
  assert.equal(new Set(r.results.map((x) => normUrl(x.url))).size, r.results.length);
});
test('reader refuses local and LAN addresses', () => {
  for (const u of ['http://localhost:3445/', 'http://127.0.0.1/', 'http://192.168.1.5/', 'http://10.0.0.1/', 'http://[::1]/', 'file:///etc/passwd']) assert.throws(() => publicUrl(u));
  assert.equal(publicUrl('https://example.com/x').hostname, 'example.com');
});
test('Readability extracts the article and drops scripts', () => {
  const body = '<p>' + 'Heat pumps move heat from a cold place to a warm place using a refrigerant cycle. '.repeat(12) + '</p>';
  const d = htmlToDoc(`<html><head><title>T</title><script>evil()</script></head><body><nav>menu</nav><article><h1>Heat</h1>${body}</article></body></html>`, 'https://e.com/');
  assert.match(d.text, /refrigerant cycle/); assert.doesNotMatch(d.text, /evil/);
});

test('guard refuses every private form, credentials, other schemes and the desk', async () => {
  const bad = ['http://localhost/', 'http://LOCALHOST./', 'http://127.0.0.1/', 'http://127.1.2.3/', 'http://0.0.0.0/', 'http://10.1.2.3/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://100.64.0.1/',
    'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]:11434/', 'http://[::ffff:7f00:1]/', 'http://[0:0:0:0:0:ffff:127.0.0.1]/', 'http://[::ffff:192.168.0.1]/', 'http://[fc00::1]/', 'http://[fd12::1]/', 'http://[fe80::1]/',
    'http://router.local/', 'http://printer.lan/', 'http://x.internal/', 'ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://2130706433/', 'http://0x7f000001/'];
  for (const u of bad) assert.throws(() => checkUrl(u), undefined, u);
  assert.throws(() => checkUrl('http://127.0.0.1:3445/api', { deskPort: 3445 }), (e) => e.code === 'desk');
  assert.equal(checkUrl('https://example.com/x').hostname, 'example.com');
  const lookup = async (h) => (h === 'mypc' ? [{ address: '127.0.0.1', family: 4 }] : h === 'nas.example' ? [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.20', family: 4 }] : h === 'v6.example' ? [{ address: '::ffff:10.0.0.5', family: 6 }] : [{ address: '93.184.216.34', family: 4 }]);
  for (const h of ['mypc', 'nas.example', 'v6.example']) await assert.rejects(checkUrlDeep(`http://${h}/`, { lookup }), (e) => e.code === 'private', h);
  assert.equal((await checkUrlDeep('http://public.example/', { lookup })).hostname, 'public.example');
  assert.equal((await checkUrlDeep('http://unresolvable.example/', { lookup: async () => { throw new Error('ENOTFOUND'); } })).hostname, 'unresolvable.example', 'a failed look-up passes (proxy resolves)');
});
test('redirects are checked before they are followed', async () => {
  const sent = [];
  const fetchFn = async (u) => { sent.push(String(u)); if (String(u).includes('/go')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/reboot' } }); return new Response('<html><body><p>' + 'ok text '.repeat(40) + '</p></body></html>', { headers: { 'content-type': 'text/html' } }); };
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  await assert.rejects(readPage(fetchFn, 'https://public.example/go', { lookup }), (e) => e.code === 'private');
  assert.deepEqual(sent, ['https://public.example/go'], 'the private hop was never requested');
  let n = 0; const loop = async () => { n++; return new Response(null, { status: 301, headers: { location: `https://public.example/${n}` } }); };
  await assert.rejects(readPage(loop, 'https://public.example/0', { lookup }), /too many/); assert.equal(n, 5);
});
test('read and search routes need the session; web_read keeps the checks', async () => {
  const inner = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>' + 'SECRET '.repeat(100) + '</p>'); });
  await new Promise((r) => inner.listen(0, '127.0.0.1', r));
  const t = await testDesk({ modules: ['search'] });
  try {
    for (const p of ['/api/m/search/read?url=https%3A%2F%2Fexample.com', '/api/m/search/search?q=x', '/api/m/search/status?cached=1']) assert.equal((await t.call(p, { session: false })).status, 403, p);
    const r = await t.call(`/api/m/search/read?url=${encodeURIComponent(`http://localhost:${inner.address().port}/`)}`);
    assert.equal(r.json.code, 'private');
    const tool = await t.core.modules.runTool('web_read', { url: `http://localhost:${inner.address().port}/` }, {});
    assert.ok(tool.error && !JSON.stringify(tool).includes('SECRET'));
  } finally { await t.close(); inner.close(); }
});

// a fetch that never answers until its signal fires, like a dead network
const hang = (calls) => (u, init) => { calls.push(String(u)); return new Promise((_, no) => { const s = init?.signal; const go = () => no(s.reason); if (s?.aborted) go(); else s?.addEventListener('abort', go, { once: true }); }); };
const env0 = (fetch) => ({ fetch, secret: () => null, searxngUrl: null });

test('search: a timeout is never retried and one search stops at its time budget, naming the providers not tried', async () => {
  const calls = []; const t0 = Date.now();
  const r = await runChain(env0(hang(calls)), 'q', { count: 8, timeoutMs: 120, budgetMs: 300, minSliceMs: 50, retryWaitMs: 10 });
  const ms = Date.now() - t0;
  assert.ok(ms < 600, `took ${ms} ms`);
  assert.equal(new Set(calls).size, calls.length, 'no provider was asked twice after a timeout');
  const tried = r.attempts.filter((a) => !a.notTried);
  assert.ok(tried.length >= 2 && tried.every((a) => !a.ok && a.note === 'no answer in time'), JSON.stringify(r.attempts));
  assert.ok(r.notTried.length >= 1, 'some providers were left for lack of time');
  assert.ok(r.notTried.includes('DuckDuckGo instant answers'));
  assert.equal(calls.length, tried.length);
});
test('search: the default budget caps a dead-network search at about 25 seconds, not minutes', async () => {
  const { SEARCH_BUDGET_MS, PROVIDER_TIMEOUT_MS } = await import('./providers.js');
  assert.ok(SEARCH_BUDGET_MS <= 25000 && PROVIDER_TIMEOUT_MS <= 15000);
});
test('search: retried once after a fast curable failure (reset, 5xx, short 429), never after a bot check or a long 429; full error kept', async () => {
  const run = async (first) => {
    let n = 0; const fetch = async (u) => {
      const s = String(u); if (!s.includes('wikipedia.org')) return new Response('', { status: 404 });
      n++; if (n === 1) return first();
      return Response.json({ pages: [{ key: 'A', title: 'A' }] });
    };
    const r = await runChain(env0(fetch), 'q', { count: 8, only: ['wikipedia'], retryWaitMs: 5 });
    return { n, r };
  };
  const reset = () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); };
  for (const first of [reset, () => new Response('', { status: 503 }), () => new Response('', { status: 429, headers: { 'retry-after': '0' } })]) {
    const { n, r } = await run(first); assert.equal(n, 2); assert.equal(r.attempts[0].ok, true);
  }
  const long = await run(() => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  assert.equal(long.n, 1); assert.equal(long.r.attempts[0].note, 'HTTP 429');
  const notFound = await run(() => new Response('', { status: 404 }));
  assert.equal(notFound.n, 1, 'a 404 is not retried');
  // a bot check is never retried
  let d = 0; const ddg = async (u) => { if (String(u).includes('duckduckgo.com/html')) { d++; return new Response('', { status: 202 }); } return new Response('', { status: 404 }); };
  const b = await runChain(env0(ddg), 'q', { count: 8, only: ['duckduckgo'], retryWaitMs: 5 });
  assert.equal(d, 1); assert.match(b.attempts[0].note, /bot check/);
  // the full message is kept beside the plain note
  const twice = async (u) => { if (String(u).includes('wikipedia.org')) reset(); return new Response('', { status: 404 }); };
  const f = await runChain(env0(twice), 'q', { count: 8, only: ['wikipedia'], retryWaitMs: 5 });
  assert.equal(f.attempts[0].note, 'connection reset'); assert.match(f.attempts[0].error, /fetch failed.*read ECONNRESET/);
});

test('search: a refused or used-up key is said to the key store and the next key answers in the same search', async () => {
  const t = await testDesk({ modules: ['search'] });
  const realFetch = globalThis.fetch; const sent = [];
  const answer = { 'serper-bad-key-0000000': 401, 'serper-spent-key-12345': 429, 'serper-good-key-123456': 200 };
  globalThis.fetch = async (u, i) => {
    if (!String(u).startsWith('https://google.serper.dev/')) return realFetch(u, i);
    const k = i.headers['X-API-KEY']; sent.push(k);
    return answer[k] === 200 ? Response.json({ organic: [{ title: 'A', link: 'https://a.example/', snippet: 's' }] }) : new Response('{}', { status: answer[k] || 401 });
  };
  try {
    for (const [v, l] of [['serper-bad-key-0000000', 'Old'], ['serper-spent-key-12345', 'Spent'], ['serper-good-key-123456', 'Work']]) t.core.services.add('serper', v, l);
    const r = await t.core.modules.api('search').searchDetailed('heat pumps', { only: ['serper'] });
    assert.equal(r.results.length, 1, JSON.stringify(r.attempts));
    assert.deepEqual(sent, ['serper-bad-key-0000000', 'serper-spent-key-12345', 'serper-good-key-123456'], 'each key once, in order');
    assert.deepEqual(t.core.services.keys('serper').map(k => k.resting), ['refused', 'allowance', null]);
    const again = await t.core.modules.api('search').searchDetailed('solar', { only: ['serper'] });
    assert.equal(again.results.length, 1); assert.equal(sent.at(-1), 'serper-good-key-123456'); assert.equal(sent.length, 4, 'the next search starts with the key that works');
  } finally { globalThis.fetch = realFetch; await t.close(); }
});
test('search chain: one key refused and no other key: said once, not tried again with the same key', async () => {
  let n = 0; const said = [];
  const env = { fetch: async () => { n++; return new Response('{}', { status: 403 }); }, secret: () => 'only-key-12345678', refused: (id, why) => said.push([id, why]), searxngUrl: null };
  const r = await runChain(env, 'q', { count: 8, only: ['brave'], retryWaitMs: 5 });
  assert.equal(n, 1); assert.deepEqual(said, [['brave', 'refused']]); assert.equal(r.attempts[0].ok, false);
  said.length = 0; const kw = await runChain({ ...env, fetch: async () => new Response('{}', { status: 432 }) }, 'q', { only: ['tavily'], retryWaitMs: 5 });
  assert.deepEqual(said, [['tavily', 'allowance']]); assert.equal(kw.attempts[0].ok, false);
});

test('readHtml: the page itself through the same path as read (guard on every hop, rules, Offline, visit log, bot check)', async () => {
  const { standIn } = await import('../network/standin.js');
  const { setRules, clearRules } = await import('../network/rules.js');
  const body = '<!doctype html><html><head><title>List</title></head><body><table><tr><th>Name</th></tr><tr><td>Asha</td></tr></table>' + '<p>Words about the people on this list, kept here for the reader. </p>'.repeat(4) + '</body></html>';
  const site = await standIn(({ host, path, res }) => {
    if (path === '/move') { res.writeHead(301, { location: 'https://other.example/list' }); return res.end(); }
    if (path === '/home') { res.writeHead(302, { location: 'http://127.0.0.1/admin' }); return res.end(); }
    if (path === '/check') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Just a moment</title></head><body>cf-chl-</body></html>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body);
  });
  const t = await testDesk({ modules: ['search', 'network'] });
  const { testHooks } = await import('./server.js');
  testHooks.fetch = site.fetch; testHooks.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  try {
    await t.core.modules.set('network', true);
    const search = t.core.modules.api('search');
    const hops = [];
    const p = await search.readHtml('https://events.example/move', { hop: (u) => hops.push(u.href), who: { module: 'tables' } });
    assert.match(p.html, /<td>Asha<\/td>/); assert.equal(p.title, 'List'); assert.equal(p.finalUrl, 'https://other.example/list');
    assert.deepEqual(hops, ['https://events.example/move', 'https://other.example/list'], 'the caller sees every hop before it is sent');
    // a hop the caller refuses is refused as itself, and nothing is sent to it
    const sent = site.seen.length;
    await assert.rejects(search.readHtml('https://events.example/move', { hop: (u) => { if (u.hostname === 'other.example') throw Object.assign(new Error('another site'), { code: 'offsite' }); } }), (e) => e.code === 'offsite');
    assert.equal(site.seen.length, sent + 1);
    await assert.rejects(search.readHtml('https://events.example/home'), (e) => e.code === 'private', 'a redirect to this PC is refused');
    await assert.rejects(search.readHtml('https://events.example/check'), (e) => e.code === 'blocked', 'a bot check is not read');
    setRules({ never: ['events.example'] });
    await assert.rejects(search.readHtml('https://events.example/list'), (e) => /^rule_/.test(e.code));
    clearRules();
    t.core.settings.set('online', false);
    await assert.rejects(search.readHtml('https://events.example/list'), (e) => e.code === 'offline');
    t.core.settings.set('online', true);
    const log = t.core.storage.all('SELECT host, result FROM m_network_visits');
    assert.ok(log.some((v) => v.host === 'events.example'), 'each read is a line in the visit log');
  } finally { clearRules(); testHooks.fetch = null; testHooks.lookup = null; await t.close(); await site.close(); }
});

test('readHtml and checkUrl take no stand-ins from a caller: the address guard and the desk\'s own fetch stay in place', async () => {
  const t = await testDesk({ modules: ['search'] });
  const { testHooks } = await import('./server.js');
  const sent = []; testHooks.fetch = async (u) => { sent.push(String(u)); return new Response('<html><head><title>x</title></head><body>' + 'words '.repeat(40) + '</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }); };
  testHooks.lookup = async () => [{ address: '10.0.0.5', family: 4 }];   // the name really points at the LAN
  const pub = async () => [{ address: '93.184.216.34', family: 4 }]; const theirs = [];
  try {
    const search = t.core.modules.api('search');
    await assert.rejects(search.readHtml('http://intranet.example/', { lookup: pub, fetch: async (u) => { theirs.push(u); return new Response('x'); } }), (e) => e.code === 'private');
    assert.deepEqual(theirs, [], 'a caller\'s fetch is never used'); assert.deepEqual(sent, [], 'nothing is sent to a LAN address');
    await assert.rejects(search.checkUrl('http://intranet.example/', { lookup: pub }), (e) => e.code === 'private', 'a caller\'s look-up cannot make a LAN name pass');
  } finally { testHooks.fetch = null; testHooks.lookup = null; await t.close(); }
});
