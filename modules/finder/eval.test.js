// The measure itself: a fixed set, stand-in pages only, and Finder must not score below the old path on it.
import test from 'node:test'; import assert from 'node:assert/strict';
import { SET, corpus, standInFetch, score, absentScore, oldPath, finderPath } from './eval.mjs';

test('40 to 50 questions, each answer said by its own page and by no decoy', () => {
  assert.ok(SET.questions.length >= 40 && SET.questions.length <= 50);
  assert.match(SET.note, /stand-in/);
  const c = corpus();
  for (const x of SET.questions) {
    assert.ok(x.answers.some((a) => x.fact.toLowerCase().includes(a.toLowerCase())), `answer in the fact: ${x.id}`);
    const decoy = [...c.pages.entries()].find(([u]) => u.startsWith('https://index.example/'))?.[1] || '';
    assert.ok(decoy.length > 0);
  }
  for (const [u, html] of c.pages) if (u.startsWith('https://index.example/')) {
    const x = SET.questions.find((q) => html.includes(`<h1>${q.title}: index`));
    if (x) assert.ok(!x.answers.some((a) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(html.replace(/<[^>]+>/g, ' ').replaceAll(x.title, ''))), `decoy has no answer: ${x.id}`);
  }
});

test('both paths run without the network, and Finder scores at least as well as the old path', async () => {
  const f = standInFetch(corpus());
  await assert.rejects(standInFetch(corpus())('https://real.site.com/'), /never leaves this computer/);
  const old = await score(oldPath, SET, f);
  const fin = await score(finderPath, SET, f);
  assert.ok(f.calls.every((u) => /^https:\/\/(html\.duckduckgo\.com|en\.wikipedia\.org|hn\.algolia\.com|api\.duckduckgo\.com|notes\.example|index\.example)\//.test(u)), 'stand-in hosts only');
  assert.equal(old.n, SET.questions.length);
  assert.ok(fin.short >= old.short, `Finder ${fin.short} vs old ${old.short}`);
  assert.ok(fin.short >= Math.round(0.8 * fin.n), `Finder ${fin.short}/${fin.n} on stand-ins`);
});

test('messy pages: the answer is in the first two passages; the library says plainly when it holds no answer', async () => {
  const messy = SET.questions.filter((x) => x.page === 'messy');
  assert.ok(messy.length >= 3 && SET.absent.questions.length >= 2);
  const c = corpus();
  for (const x of messy) for (const [u, html] of c.pages) if (u.endsWith('/' + encodeURIComponent(x.title.replace(/ /g, '_'))) || u === `https://notes.example/${x.title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`) {
    assert.match(html, /<div id="toc">/); assert.match(html, /Retrieved/);
    assert.equal(html.split(x.answers[0]).length, 2, `the answer is said once, in its fact: ${x.id}`);
  }
  const f = standInFetch(c);
  const fin = await score(finderPath, SET, f);
  assert.equal(fin.messy.two, fin.messy.n, 'answer in the top two on every messy page');
  const a = await absentScore(SET, f);
  assert.equal(a.right, a.n, a.misses.join(' | '));
  assert.equal(a.held.two, a.held.n, `the library answers the questions it holds in the first two passages: misses ${a.held.misses}`);
});
