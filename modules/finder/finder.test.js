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

test('blocks of the page become breaks: the reader markup is used, not its glued text', async () => {
  const { db, kv } = memoryDoor(); const library = createLibrary(db, kv);
  const md = '-   [Contents](#c)\n-   [History](#h)\n\nMount Everest\n\n' + filler + '\n\nMount Everest is 8849 metres high, as measured in 2020.\n\n' + filler;
  const glued = 'ContentsHistoryMount Everest' + filler + 'Mount Everest is 8849 metres high, as measured in 2020.' + filler;
  const f = createFinder({ library, budgetMs: 300, readBudgetMs: 300, providers: () => ['p1'],
    async searchOne() { return [{ title: 'r', url: 'https://one.example/everest', snippet: '' }]; },
    async read(url) { return { url, finalUrl: url, title: 'Mount Everest', text: glued, markdown: md, kind: 'html', fetchedAt: '2026-03-01T10:00:00.000Z' }; } });
  const r = await f.find('How high is Mount Everest in metres?');
  assert.equal(r.passages[0].text, 'Mount Everest is 8849 metres high, as measured in 2020.');
  assert.ok(!r.passages.some((p) => /ContentsHistory/.test(p.text)));
  assert.ok(!library.get('https://one.example/everest').text.includes('ContentsHistory'), 'the library keeps the text with its breaks');
});

test('nothing in the library: one plain line with the next step, and no unrelated passages', async () => {
  const s = setup();
  await s.finder.find('How high is Mount Everest?');
  for (const [opts, next] of [[{ libraryOnly: true }, /Switch off "Search my library only"/], [{ offline: true }, /online/]]) {
    const r = await s.finder.find('What is the capital of Australia?', opts);
    assert.equal(r.passages.length, 0);
    assert.match(r.nothing, /^Nothing in your library answers this\. /); assert.match(r.nothing, next);
    assert.deepEqual(r.notes, [r.nothing], 'one line');
  }
});

test('a page whose title answers is shown as a source with its title', async () => {
  const { db, kv } = memoryDoor(); const library = createLibrary(db, kv);
  const f = createFinder({ library, budgetMs: 300, readBudgetMs: 300, providers: () => ['p1'],
    async searchOne() { return [{ title: 'r', url: 'https://news.example/final', snippet: '' }]; },
    async read(url) { return { url, finalUrl: url, title: 'Argentina win the 2022 FIFA World Cup final on penalties', text: filler + '\n\nPhotos from the night in pictures.\n\n' + filler, kind: 'html', fetchedAt: '2026-03-01T10:00:00.000Z' }; } });
  const r = await f.find('Who won the 2022 FIFA World Cup final?');
  const src = r.sources.find((x) => x.url === 'https://news.example/final');
  assert.ok(src && src.byTitle, JSON.stringify(r.sources)); assert.match(src.title, /Argentina win/); assert.equal(src.readAt, '2026-03-01T10:00:00.000Z');
});

// Two long pages shaped like encyclopedia articles: a fact box, the opening that says the result in other words than the
// question's, background further down, a semi-final line deep in the page, and a reference list whose entries end with
// a full stop and quote the question's words. The opening answers; the deep lines and the references do not.
const fill = (n, w) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} on ${w} covers the stadiums, the travel, the tickets and the crowds in plain detail across the weeks.`).join('\n\n');
const CUP = {
  'https://wiki.example/2030_Ocean_Cup_final': { title: '2030 Ocean Cup final - Encyclopedia', text: [
    '2030 Ocean Cup final', 'Event', '1', '0', 'After extra time', 'Date', 'July 19, 2030',
    'The final match of the 2030 Ocean Cup was played at Harbour Stadium on July 19, 2030. It was contested by Portugal and the defending champion Brazil.',
    'Portugal held most of the ball, and the goalless deadlock carried into extra time, when a late header secured a 1–0 victory for Portugal.',
    "Portugal's win earned the country its third Ocean Cup title and its first since 2010.",
    fill(20, 'the tournament'),
    'Brazil had previously won the Ocean Cup in 1978 and 1986, and finished as runners-up in 1930 and 1990. Brazil were attempting to win a second final in a row.',
    fill(30, 'the knockout rounds'),
    'Brazil won 2–1 to reach their second consecutive Ocean Cup final.[83]',
    fill(20, 'the officials'),
    '"Portugal vs Brazil | Final | Ocean Cup 2030". Ocean Cup. Retrieved July 19, 2030.\n"Match Report – Final – Portugal v. Brazil". Ocean Cup. July 19, 2030. Retrieved July 19, 2030.\n"Post match summary report – Final – Portugal v. Brazil". Ocean Cup. July 20, 2030. Retrieved July 20, 2030.',
  ].join('\n\n') },
  'https://wiki.example/2030_Ocean_Cup': { title: '2030 Ocean Cup - Encyclopedia', text: [
    '2030 Ocean Cup', 'Champions', 'Portugal (3rd title)',
    'The 2030 Ocean Cup was the 12th Ocean Cup, contested by the national teams of the member nations. The tournament began on June 11, 2030, and ended on July 19 with Portugal winning the cup for the third time.',
    fill(25, 'the groups'),
    "Portugal's captain won the best player award, and the side's keeper won the award for the best goalkeeper of the Ocean Cup.",
    fill(10, 'the money'),
  ].join('\n\n') },
};
test('a long page: the opening that says who won comes before deep lines with the same words; references never come', async () => {
  const { db, kv } = memoryDoor(); const library = createLibrary(db, kv);
  const f = createFinder({ library, budgetMs: 300, readBudgetMs: 300, providers: () => ['p1'],
    async searchOne() { return Object.keys(CUP).map((url) => ({ title: 'r', url, snippet: '' })); },
    async read(url) { return { url, finalUrl: url, ...CUP[url], kind: 'html', fetchedAt: '2030-07-21T10:00:00.000Z' }; } });
  const q = 'Who won the 2030 Ocean Cup final?';
  for (const opts of [{}, { libraryOnly: true }, { offline: true }]) {
    const r = await f.find(q, opts);
    const two = r.passages.slice(0, 2).map((p) => p.text).join(' | ');
    assert.match(two, /Portugal (winning|won)|Portugal's win|victory for Portugal/, `${JSON.stringify(opts)}: ${two}`);
    assert.ok(!r.passages.some((p) => /Retrieved/.test(p.text)), 'a reference list is not an answer');
    for (const p of r.passages) assert.ok(CUP[p.url].text.includes(p.text), 'word for word');
    const titled = r.sources.filter((s) => s.byTitle).map((s) => s.title);
    assert.ok(titled.includes('2030 Ocean Cup final - Encyclopedia'), `title match shown even when the page gave passages: ${titled}`);
  }
});
