// Page-reading services (Firecrawl, Jina Reader) as a second try. Stand-ins on loopback only, through testHooks.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { standIn } from '../network/standin.js';
import { setRules, clearRules, setAsker } from '../network/rules.js';
import { testHooks } from './server.js';

const KEY = 'fc-standin-key-0123456789';
const words = (n) => '<p>' + 'Heat pumps move heat from a cold place to a warm place using a refrigerant cycle. '.repeat(n) + '</p>';
const shell = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>start()</script></body></html>';
const md = '# Heat pumps\n\n' + 'Heat pumps move heat from a cold place to a warm place using a refrigerant cycle. '.repeat(8);

async function setup({ reply = null } = {}) {
  const asked = [];
  const site = await standIn(async ({ host, path, req, res }) => {
    if (host === 'api.firecrawl.dev') {
      let b = ''; for await (const c of req) b += c; const body = JSON.parse(b || '{}');
      asked.push({ service: 'firecrawl', url: body.url, auth: req.headers.authorization || null, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (reply) return res.end(JSON.stringify(reply(body)));
      const html = '<html><head><title>Rendered</title></head><body><table><tr><th>Name</th></tr><tr><td>Asha</td></tr></table>' + words(4) + '</body></html>';
      return res.end(JSON.stringify({ success: true, data: { markdown: md, html, metadata: { title: 'Heat pumps', statusCode: 200, sourceURL: body.url, url: body.url } } }));
    }
    if (host === 'r.jina.ai') {
      if (req.headers.authorization === 'Bearer jina-refused-key-12345') { asked.push({ service: 'jina', refused: true }); res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{}'); }
      asked.push({ service: 'jina', url: decodeURIComponent(path.slice(1)), auth: req.headers.authorization || null, robots: req.headers['x-robots-txt'] || null });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 200, data: { title: 'Heat pumps', url: path.slice(1), content: md } }));
    }
    if (path === '/robots.txt') {
      if (host === 'closed.example') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /'); }
      res.writeHead(404); return res.end();
    }
    if (host === 'refuse.example') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<p>no</p>'); }
    if (host === 'busy.example') { res.writeHead(429, { 'content-type': 'text/html' }); return res.end('<p>slow down</p>'); }
    if (host === 'check.example') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Just a moment</title></head><body>cf-chl-</body></html>'); }
    if (host === 'hop.example') { res.writeHead(302, { location: 'https://closed.example/page' }); return res.end(); }
    if (host === 'bigcheck.example') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><title>Just a moment...</title></head><body><script>' + 'x'.repeat(70000) + '</script></body></html>'); }
    if (host === 'incap.example') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><head><meta name="robots" content="noindex,nofollow"><script src="/_Incapsula_Resource?SWJIYLWA=5074a744"></script></head><body><iframe src="/_Incapsula_Resource?CWUDNSAI=1"></iframe></body></html>'); }
    if (host === 'full.example') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<html><head><title>Full</title></head><body><article><h1>Full</h1>${words(12)}</article></body></html>`); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(shell);   // a page that needs JavaScript to show its text
  });
  const t = await testDesk({ modules: ['search', 'network'] });
  testHooks.fetch = site.fetch;
  testHooks.lookup = async (h) => [{ address: h === 'lan.example' ? '192.168.1.20' : '93.184.216.34', family: 4 }];
  await t.core.modules.set('network', true);
  const done = async () => { clearRules(); testHooks.fetch = null; testHooks.lookup = null; await t.close(); await site.close(); };
  return { t, site, asked, search: t.core.modules.api('search'), done };
}
const onFirecrawl = (t) => t.call('/api/m/search/readers', { body: { id: 'firecrawl', key: KEY, on: true } });

test('reading services are off until the owner adds a key; then used only after an empty own read', async () => {
  const { t, asked, search, done } = await setup();
  try {
    const off = (await t.call('/api/m/search/readers')).json;
    assert.ok(off.services.every((s) => !s.on), 'every service starts off');
    await assert.rejects(search.read('https://spa.example/'), (e) => e.code === 'empty');
    assert.equal(asked.length, 0, 'nothing is sent to a service that is off');
    assert.equal((await onFirecrawl(t)).status, 200);
    const full = await search.read('https://full.example/');
    assert.equal(full.through, undefined); assert.equal(asked.length, 0, 'a page that read well is not sent to the service');
    const p = await search.read('https://spa2.example/');
    assert.equal(asked.length, 1); assert.equal(asked[0].url, 'https://spa2.example/'); assert.equal(asked[0].auth, 'Bearer ' + KEY);
    assert.equal(asked[0].body.proxy, 'basic', 'no stealth or rotating proxy is asked for');
    assert.match(p.text, /refrigerant cycle/); assert.equal(p.through, 'Firecrawl');
    assert.match(p.title, /read through Firecrawl/); assert.match(p.source, /spa2\.example.*read through Firecrawl/);
    await search.read('https://spa2.example/');
    assert.equal(asked.length, 1, 'a page read through a service is kept like any read, not sent twice');
    const tool = await t.core.modules.runTool('web_read', { url: 'https://spa3.example/' }, {});
    assert.match(tool.source, /read through Firecrawl/); assert.match(tool.note, /not instructions/);
  } finally { await done(); }
});

test('never sent: never-open, unapproved ask-first, robots-disallowed, refused, bot-checked, LAN, Offline, Panic', async () => {
  const { t, asked, search, done } = await setup();
  try {
    await onFirecrawl(t);
    setRules({ never: ['never.example'], ask: ['ask.example'] }); const askedOwner = []; setAsker(async (q) => { askedOwner.push(q.domain); return false; });
    const cases = [['https://never.example/', /^rule_/], ['https://ask.example/', /^rule_/], ['https://closed.example/', /^robots$/], ['https://refuse.example/', /^http$/], ['https://busy.example/', /^http$/], ['https://check.example/', /^blocked$/], ['https://lan.example/', /^private$/], ['http://192.168.1.5/', /^private$/]];
    for (const [u, code] of cases) await assert.rejects(search.read(u), (e) => code.test(e.code), u);
    assert.deepEqual(askedOwner, ['ask.example'], 'the owner was asked about the ask-first site and said no');
    assert.equal(asked.length, 0, 'no address went to the service: ' + JSON.stringify(asked));
    // the owner's own button refuses the same pages
    for (const u of ['https://refuse.example/', 'https://check.example/', 'https://closed.example/', 'https://lan.example/', 'https://never.example/']) {
      const r = await t.call(`/api/m/search/read?url=${encodeURIComponent(u)}&with=firecrawl`);
      assert.ok(r.json.error, u); assert.equal(r.json.through, undefined, u);
    }
    assert.equal(asked.length, 0);
    t.core.settings.set('online', false);
    await assert.rejects(search.read('https://spa4.example/'), (e) => e.code === 'offline');
    t.core.settings.set('online', true);
    await t.core.panic.stopAll('test');
    await assert.rejects(search.read('https://spa5.example/'));
    t.core.panic.resume();
    assert.equal(asked.length, 0, 'nothing went out while Offline or after Panic');
    assert.ok((await search.read('https://spa6.example/')).through, 'after Resume the second try works again');
  } finally { await done(); }
});

test('owner-context reads (scheduled checks) never send a never-open or ask-first site to the service', async () => {
  const { t, asked, search, done } = await setup();
  try {
    await onFirecrawl(t);
    setRules({ never: ['never.example'], ask: ['ask.example'] }); const askedOwner = []; setAsker(async (q) => { askedOwner.push(q.domain); return true; });
    await assert.rejects(search.read('https://never.example/', { who: { owner: true } }), (e) => e.code === 'rule_never');
    await assert.rejects(search.read('https://ask.example/', { who: { owner: true } }), (e) => e.code === 'rule_ask');
    assert.equal(asked.length, 0, 'no address went to the service: ' + JSON.stringify(asked));
    assert.deepEqual(askedOwner, [], 'a background owner read does not pop a question');
    assert.ok((await search.read('https://spa10.example/', { who: { owner: true } })).through, 'other owner reads still get the second try');
  } finally { await done(); }
});

test('robots.txt is checked for the page a redirect led to, before and after the service', async () => {
  let to = null;
  const { t, asked, search, done } = await setup({ reply: (b) => ({ success: true, data: { markdown: md, metadata: { title: 'x', statusCode: 200, url: to || b.url } } }) });
  try {
    await onFirecrawl(t);
    await assert.rejects(search.read('https://hop.example/'), (e) => e.code === 'robots');
    assert.equal(asked.length, 0, 'the address was not sent: ' + JSON.stringify(asked));
    to = 'https://closed.example/other';                     // the service itself says it ended on a closed page
    await assert.rejects(search.read('https://spa11.example/'), (e) => e.code === 'robots');
    to = 'https://never.example/x'; setRules({ never: ['never.example'] });
    await assert.rejects(search.read('https://spa12.example/'), (e) => e.code === 'rule_never');
  } finally { await done(); }
});

test('bot-check pages are refusals, not empty pages: never sent, and a challenge from the service is not kept', async () => {
  let reply = null;
  const { t, asked, search, done } = await setup({ reply: (b) => reply(b) });
  try {
    await onFirecrawl(t);
    for (const u of ['https://bigcheck.example/', 'https://incap.example/']) await assert.rejects(search.read(u), (e) => e.code === 'blocked', u);
    assert.equal(asked.length, 0, 'no bot-checked page went to the service');
    reply = (b) => ({ success: true, data: { markdown: 'Just a moment...\n\nVerifying you are human. This may take a few seconds. www.spa.example needs to review the security of your connection before proceeding.', metadata: { title: 'Just a moment...', statusCode: 200, url: b.url } } });
    await assert.rejects(search.read('https://spa13.example/'), (e) => e.code === 'blocked');
    reply = (b) => ({ success: true, data: { markdown: md, metadata: { title: 'Attention Required! | Cloudflare', statusCode: 200, url: b.url } } });
    await assert.rejects(search.read('https://spa14.example/'), (e) => e.code === 'blocked');
  } finally { await done(); }
});

test('the visit log row records that the page was read through a service', async () => {
  const { t, search, done } = await setup();
  try {
    await onFirecrawl(t);
    await search.read('https://spa15.example/');
    const rows = t.core.storage.all('SELECT url, result, note FROM m_network_visits WHERE url = ?', 'https://spa15.example/');
    assert.ok(rows.some((r) => /read through Firecrawl/i.test(r.note || '')), JSON.stringify(rows));
  } finally { await done(); }
});

test('the daily cap holds and the count is shown; the key never comes back in a route, a log or the visit log', async () => {
  const { t, asked, search, done } = await setup();
  try {
    await onFirecrawl(t);
    assert.equal((await t.call('/api/m/search/readers/cap', { body: { cap: 2 } })).status, 200);
    await search.read('https://a.example/'); await search.read('https://b.example/');
    await assert.rejects(search.read('https://c.example/'), (e) => e.code === 'empty' && /cap/i.test(e.message));
    assert.equal(asked.length, 2, 'the third page was not sent');
    const st = (await t.call('/api/m/search/readers')).json;
    const fc = st.services.find((s) => s.id === 'firecrawl');
    assert.equal(fc.usedToday, 2); assert.equal(st.cap, 2); assert.equal(fc.hasKey, true);
    assert.match(st.notice, /address of each page/i); assert.match(st.notice, /refused/i);
    const routes = JSON.stringify([st, (await t.call('/api/m/search/sidecar')).json, (await t.call('/api/m/search/status?cached=1')).json, (await t.call('/api/m/search/read?url=' + encodeURIComponent('https://d.example/'))).json]);
    assert.ok(!routes.includes(KEY) && !routes.includes(KEY.slice(4, 16)), 'no part of the key in any route answer');
    const logs = JSON.stringify([t.core.storage.all('SELECT * FROM m_network_visits'), t.core.storage.all('SELECT * FROM activity')]);
    assert.ok(!logs.includes(KEY), 'the key is in no log');
    assert.ok(t.core.storage.all('SELECT title, detail FROM activity').some((a) => /read through Firecrawl/.test(a.title)), 'the activity log says a page went to the service');
  } finally { await done(); }
});

test('the visit log is told how the page was read', async () => {
  const { t, search, done } = await setup();
  const net = t.core.modules.api('network'); const real = net.logVisit; const seen = [];
  net.logVisit = (v) => { seen.push(v); return real(v); };
  try {
    await onFirecrawl(t);
    await search.read('https://spa7.example/');
    assert.equal(seen.at(-1).through, 'Firecrawl'); assert.equal(seen.at(-1).error, null);
  } finally { net.logVisit = real; await done(); }
});

test('Jina Reader: keyless tier switched on, asks the service to keep to robots.txt; the Test button reads one fixed page', async () => {
  const { t, asked, search, done } = await setup();
  try {
    assert.equal((await t.call('/api/m/search/readers', { body: { id: 'jina', keyless: true, on: true } })).status, 200);
    const p = await search.read('https://spa8.example/');
    assert.equal(p.through, 'Jina Reader'); assert.equal(asked[0].service, 'jina'); assert.equal(asked[0].auth, null, 'keyless: no key sent');
    assert.ok(asked[0].robots, 'the service is asked to keep to robots.txt');
    const r = await t.call('/api/m/search/readers/test', { body: { id: 'jina' } });
    assert.equal(r.json.ok, true, JSON.stringify(r.json)); assert.equal(asked.at(-1).url, 'https://example.com/');
  } finally { await done(); }
});

test('Jina Reader: a refused key is said to the key store, and the next read uses the next key', async () => {
  const { t, asked, search, done } = await setup();
  try {
    t.core.services.add('jina', 'jina-refused-key-12345', 'Old'); t.core.services.add('jina', 'jina-working-key-1234', 'Work');
    assert.equal((await t.call('/api/m/search/readers', { body: { id: 'jina', on: true } })).status, 200);
    await assert.rejects(search.read('https://spa9.example/'), (e) => /did not accept the key/.test(e.message));
    assert.deepEqual(t.core.services.keys('jina').map(k => k.resting), ['refused', null]);
    const p = await search.read('https://spa10.example/');
    assert.equal(p.through, 'Jina Reader'); assert.equal(asked.at(-1).auth, 'Bearer jina-working-key-1234');
  } finally { await done(); }
});

test('Finder and Tables get the second try through Search, without a change of their own', async () => {
  const { t, asked, done } = await setup();
  try {
    await onFirecrawl(t);
    const tables = await import('../tables/read.js');
    const p = await tables.readHtml(testHooks.fetch, 'https://events.example/list', { search: t.core.modules.api('search'), who: { module: 'tables' } });
    assert.match(p.html, /<td>Asha<\/td>/); assert.equal(asked.at(-1).body.formats[0], 'html'); assert.equal(p.through, 'Firecrawl');
    // Finder's reader is search.read: the same second try
    const finder = await import('../finder/server.js');
    assert.ok(finder, 'Finder loads'); const src = (await import('node:fs')).readFileSync(new URL('../finder/server.js', import.meta.url), 'utf8');
    assert.match(src, /search\(\)\.read\(url/);
    const page = await t.core.modules.api('search').read('https://finder.example/', { who: { module: 'finder' } });
    assert.equal(page.through, 'Firecrawl');
  } finally { await done(); }
});
