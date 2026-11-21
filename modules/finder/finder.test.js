// The Finder engine with stand-in providers and pages (no network).
import test from 'node:test'; import assert from 'node:assert/strict';
import { createFinder } from './finder.js';
import { createLibrary } from './library.js';
import { memoryDoor } from './standin.js';

const filler = 'This page has an opening part that talks about the site and its other pages in general terms. '.repeat(3);
const PAGES = {
  'https://one.example/everest': { title: 'Mount Everest', text: filler + '\n\nMount Everest is 8849 metres high, as measured in 2020.\n\n' + filler },
  'https://two.example/k2': { title: 'K2', text: filler + '\n\nK2 is the second highest mountain on Earth.\n\n' + filler },
  'https://blocked.example/everest': { title: 'Everest blocked', text: filler + '\n\nMount Everest height is listed here too.\n\n' + filler },
};
function setup({ delay = 0, hang = [], fail = [], results } = {}) {
  const { db, kv } = memoryDoor(); const library = createLibrary(db, kv);
  const asked = []; const reads = [];
  const lists = results || { p1: ['https://one.example/everest?utm_source=x', 'https://two.example/k2'], p2: ['https://one.example/everest', 'https://blocked.example/everest'] };
  const finder = createFinder({
    library, budgetMs: 300, readBudgetMs: 300, now: () => Date.parse('2026-03-01T12:00:00.000Z'),
    providers: () => Object.keys(lists),
    async searchOne(query, provider, signal) {
      asked.push({ query, provider });
      if (fail.includes(provider)) throw new Error('HTTP 500');
      await new Promise((r, no) => { const t = setTimeout(r, hang.includes(provider) ? 10_000 : delay); signal?.addEventListener('abort', () => { clearTimeout(t); no(new Error('no answer in time')); }); });
      return lists[provider].map((url) => ({ title: 'r', url, snippet: '' }));
    },
    async read(url) { reads.push(url); const k = url.replace(/\?.*$/, ''); const p = PAGES[k]; if (!p) throw new Error('The page answered 404.'); return { url, finalUrl: k, title: p.title, text: p.text, kind: 'html', fetchedAt: '2026-03-01T10:00:00.000Z' }; },
    canOpen: (url) => { if (url.includes('blocked.example')) throw Object.assign(new Error('You set a rule: agents never open blocked.example.'), { code: 'rule_never' }); return true; },
  });
  return { finder, library, asked, reads };
}

test('rewordings go to every provider at once, results are merged by address, the answer is the best passage', async () => {
  const s = setup({ delay: 120 });
  const t0 = Date.now();
  const r = await s.finder.find('How high is Mount Everest?');
  assert.ok(Date.now() - t0 < 400, 'providers asked in parallel, not one after another');
  assert.ok(new Set(s.asked.map((a) => a.query)).size >= 2, 'more than one wording');
  assert.deepEqual([...new Set(s.asked.map((a) => a.provider))].sort(), ['p1', 'p2']);
  assert.equal(s.reads.filter((u) => u.includes('one.example')).length, 1, 'the same page from two providers is read once');
  assert.ok(!s.reads.some((u) => u.includes('blocked.example')), 'a site under a website rule is never fetched');
  assert.ok(r.read.some((x) => /blocked\.example/.test(x.url) && /rule/.test(x.note)));
  assert.match(r.passages[0].text, /8849 metres/);
  assert.equal(r.passages[0].url, 'https://one.example/everest'); assert.equal(r.passages[0].readAt, '2026-03-01T10:00:00.000Z');
  for (const p of r.passages) assert.ok(PAGES[p.url].text.includes(p.text), 'quotes are word for word');
});

test('a provider that hangs is cut at the time budget and named; one that fails is named', async () => {
  const s = setup({ hang: ['p2'], fail: [], results: { p1: ['https://one.example/everest'], p2: ['https://two.example/k2'], p3: ['https://two.example/k2'] } });
  const s2 = setup({ fail: ['p3'], results: { p1: ['https://one.example/everest'], p3: [] } });
  const t0 = Date.now(); const r = await s.finder.find('Mount Everest height');
  assert.ok(Date.now() - t0 < 700, 'kept the budget');
  assert.ok(r.asked.some((a) => a.provider === 'p2' && !a.ok && /time/.test(a.note)));
  assert.match(r.passages[0].text, /8849/);
  const r2 = await s2.finder.find('Mount Everest height');
  assert.ok(r2.asked.some((a) => a.provider === 'p3' && !a.ok && /500/.test(a.note)));
});

test('pages read are kept; the library answers first and alone when asked or Offline', async () => {
  const s = setup();
  await s.finder.find('How high is Mount Everest?');
  assert.ok(s.library.stats().pages >= 1);
  s.asked.length = 0; s.reads.length = 0;
  for (const opts of [{ libraryOnly: true }, { offline: true }]) {
    const r = await s.finder.find('Everest metres', opts);
    assert.equal(s.asked.length, 0, 'nothing asked of the web'); assert.equal(s.reads.length, 0);
    assert.match(r.passages[0].text, /8849/); assert.equal(r.passages[0].from, 'library');
  }
  const again = await s.finder.find('How high is Mount Everest?');
  assert.ok(!s.reads.includes('https://one.example/everest'), 'a page kept a short while ago is not read again');
  assert.match(again.passages[0].text, /8849/);
});

test('nothing found says so; Stop ends the search', async () => {
  const s = setup({ results: { p1: [] } });
  const r = await s.finder.find('Mount Everest height');
  assert.equal(r.passages.length, 0); assert.match(r.notes.join(' '), /No page/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(setup().finder.find('Everest', { signal: ac.signal }), (e) => e.code === 'aborted');
});

test('a kept copy reached through a redirect does not stand in for a read of an ask-first site', async () => {
  const { db, kv } = memoryDoor(); const library = createLibrary(db, kv);
  const reads = [];
  const make = (allowedHost) => createFinder({
    library, budgetMs: 300, readBudgetMs: 300, now: () => Date.parse('2026-03-01T12:00:00.000Z'),
    providers: () => ['p1'],
    async searchOne() { return [{ title: 'r', url: 'https://ask.example/everest', snippet: '' }]; },
    async read(url) { reads.push(url); return { url, finalUrl: 'https://cdn.other.example/everest', title: 'Everest', text: PAGES['https://one.example/everest'].text, kind: 'html', fetchedAt: '2026-03-01T10:00:00.000Z' }; },
    canOpen: () => true, allowedHost,
  });
  await make(() => true).find('How high is Mount Everest?');                        // the owner's search keeps it
  assert.equal(reads.length, 1);
  const r = await make((h) => h !== 'ask.example').find('How high is Mount Everest?');   // an agent, ask.example now ask-first
  assert.equal(reads.length, 2, 'the read runs again, so the owner is asked');
  assert.ok(!r.passages.some((p) => p.from === 'library'), 'the kept copy is not handed over in its place');
});
