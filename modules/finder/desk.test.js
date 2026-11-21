// Finder on a throwaway desk. The Search module's search and reader are swapped for stand-ins, so nothing goes out.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { setRules, clearRules } from '../network/rules.js';

const filler = 'An opening part about the site and the other pages it has, in general words only. '.repeat(3);
const PAGES = {
  'https://one.example/everest': filler + '\n\nMount Everest is 8849 metres high, as measured in 2020.\n\n' + filler,
  'https://blocked.example/everest': filler + '\n\nMount Everest height in metres is given on this page too.\n\n' + filler,
};
async function on() {
  const t = await testDesk({ modules: ['search', 'finder'] });
  const s = t.core.modules.api('search');
  const log = { asked: [], reads: [] };
  s.status = async () => ({ providers: [{ id: 'duckduckgo', label: 'DuckDuckGo', configured: true }, { id: 'wikipedia', label: 'Wikipedia', configured: true }, { id: 'hackernews', label: 'Hacker News', configured: true }, { id: 'serper', label: 'Serper', configured: false }] });
  s.searchDetailed = async (q, { only }) => { log.asked.push({ q, only }); return { results: Object.keys(PAGES).map((url) => ({ title: 'r', url, snippet: '' })), attempts: [{ provider: only[0], ok: true, n: 2 }] }; };
  s.read = async (url, { who } = {}) => { log.reads.push({ url, who }); if (!PAGES[url]) throw new Error('The page answered 404.'); return { url, finalUrl: url, title: 'Everest', text: PAGES[url], kind: 'html', fetchedAt: '2026-03-01T10:00:00.000Z' }; };
  t.core.settings.set('timeZone', 'Asia/Kolkata');
  return { t, log };
}

test('off: 404; on: find and library_search are tools; find quotes passages with source and read time', async () => {
  const t0 = await testDesk({ modules: ['search', 'finder'] });
  try { assert.equal((await t0.call('/api/m/finder/library')).status, 404); } finally { await t0.close(); }
  const { t, log } = await on();
  try {
    assert.equal((await t.call('/api/modules/finder/on', { method: 'POST' })).status, 200);
    const names = t.core.modules.tools ? [...t.core.modules.tools.keys()] : [];
    for (const n of ['find', 'library_search', 'web_search', 'web_read']) assert.ok(names.includes(n), n);
    const r = await t.core.modules.runTool('find', { question: 'How high is Mount Everest?' }, { agentId: 'scout', chatId: 'c1' });
    assert.match(r.passages[0].quote, /8849 metres/);
    assert.equal(r.passages[0].source, 'https://one.example/everest');
    assert.match(r.passages[0].read, /1 Mar 2026|Mar 1, 2026/); assert.doesNotMatch(r.passages[0].read, /Z$|T\d\d:/, 'owner zone, not UTC text');
    assert.match(r.note, /not instructions/);
    assert.deepEqual([...new Set(log.asked.map((a) => a.only[0]))].sort(), ['duckduckgo', 'wikipedia'], 'Hacker News is not asked; providers without a key are not asked');
    assert.ok(r.providers.every((x) => /^(DuckDuckGo|Wikipedia): /.test(x)), 'providers by their plain names');
    assert.ok(log.reads.every((x) => x.who?.agentId === 'scout'), 'reads go through the reader with who asked');
    const lib = (await t.call('/api/m/finder/library')).json;
    assert.equal(lib.pages, 2); assert.ok(lib.bytes > 0); assert.equal(lib.limitMb, 100);
  } finally { await t.close(); }
});

test('Offline: the library answers alone; library_search works; nothing is asked of the web', async () => {
  const { t, log } = await on();
  try {
    await t.call('/api/modules/finder/on', { method: 'POST' });
    await t.core.modules.runTool('find', { question: 'Mount Everest height' }, { agentId: 'scout' });
    log.asked.length = 0; log.reads.length = 0;
    t.core.settings.set('online', false);
    const r = await t.core.modules.runTool('find', { question: 'How many metres is Everest?' }, { agentId: 'scout' });
    assert.match(r.passages[0].quote, /8849/); assert.equal(r.passages[0].from, 'your library');
    assert.match(r.notes.join(' '), /offline/i);
    const l = await t.core.modules.runTool('library_search', { query: 'Everest metres' }, { agentId: 'scout' });
    assert.match(l.passages[0].quote, /8849/);
    const page = (await t.call('/api/m/finder/find?q=Everest%20metres&library=1')).json;
    assert.match(page.passages[0].text, /8849/);
    assert.equal(log.asked.length, 0); assert.equal(log.reads.length, 0);
  } finally { await t.close(); }
});

test('website rules: a never site is not read, and its kept pages are not shown to agents', async () => {
  const { t, log } = await on();
  try {
    await t.call('/api/modules/finder/on', { method: 'POST' });
    await t.call('/api/m/finder/find?q=Mount%20Everest%20height');               // the owner's own search keeps both pages
    assert.ok(log.reads.some((x) => x.url.includes('blocked.example')));
    setRules({ never: ['blocked.example'], ask: ['one.example'] });
    log.reads.length = 0;
    const r = await t.core.modules.runTool('find', { question: 'Mount Everest height metres' }, { agentId: 'scout', chatId: 'c2' });
    assert.ok(!log.reads.some((x) => x.url.includes('blocked.example')), 'never fetched');
    assert.ok(!r.passages.some((p) => p.source.includes('blocked.example')), 'not shown from the library either');
    const l = await t.core.modules.runTool('library_search', { query: 'Everest metres' }, { agentId: 'scout' });
    assert.ok(!l.passages.some((p) => /blocked\.example|one\.example/.test(p.source)), 'never and ask-first sites stay out of the library answer');
  } finally { clearRules(); await t.close(); }
});

test('the owner alone clears the library, sets never keep and the size limit; search is the owner\'s only', async () => {
  const { t } = await on();
  try {
    await t.call('/api/modules/finder/on', { method: 'POST' });
    await t.core.modules.runTool('find', { question: 'Mount Everest height' }, { agentId: 'scout' });
    assert.equal((await t.call('/api/m/finder/find?q=x', { session: false })).status, 403);
    assert.equal((await t.call('/api/m/finder/library/clear', { body: {}, session: false })).status, 403);
    assert.equal((await t.call('/api/m/finder/library/never-keep', { body: { site: 'one.example' }, session: false })).status, 403);
    const nk = (await t.call('/api/m/finder/library/never-keep', { body: { site: 'https://www.one.example/a' } })).json;
    assert.deepEqual(nk.neverKeep, ['one.example']); assert.equal(nk.pages, 1, 'what was kept from it is gone');
    assert.equal((await t.call('/api/m/finder/library/never-keep', { body: { site: 'not a site' } })).status, 400);
    assert.equal((await t.call('/api/m/finder/library/limit', { body: { mb: 2 } })).status, 400);
    assert.equal((await t.call('/api/m/finder/library/limit', { body: { mb: 50 } })).json.limitMb, 50);
    const c = (await t.call('/api/m/finder/library/clear', { body: {} })).json;
    assert.equal(c.removed, 1); assert.equal(c.pages, 0);
    assert.deepEqual((await t.call('/api/m/finder/library/never-keep/remove', { body: { site: 'one.example' } })).json.neverKeep, []);
    assert.equal((await t.call('/api/m/finder/find?q=')).status, 400);
  } finally { await t.close(); }
});

test('the exposed find and librarySearch keep the website rules when no caller is named', async () => {
  const { t, log } = await on();
  try {
    await t.call('/api/modules/finder/on', { method: 'POST' });
    await t.call('/api/m/finder/find?q=Mount%20Everest%20height');               // the owner's own search keeps both pages
    setRules({ never: ['blocked.example'] });
    log.reads.length = 0;
    const api = t.core.modules.api('finder');
    const r = await api.find('How high is Mount Everest');
    assert.ok(!log.reads.some((x) => x.url.includes('blocked.example')), 'never fetched');
    assert.ok(log.reads.every((x) => x.who?.owner !== true), 'not read as the owner');
    assert.ok(!r.passages.some((p) => p.url.includes('blocked.example')));
    const l = api.librarySearch('Everest metres', { allowed: () => true });
    assert.ok(l.length >= 1); assert.ok(!l.some((p) => p.url.includes('blocked.example')), 'a caller cannot widen what it sees');
  } finally { clearRules(); await t.close(); }
});
