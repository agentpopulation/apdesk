// Rewordings made without a model.
import test from 'node:test'; import assert from 'node:assert/strict';
import { rewordings, assign } from './rewrite.js';

test('the question first, then a quoted phrase, key terms and a site-less form, at most 4 in all', () => {
  const r = rewordings('What is the height of Mount Everest site:wikipedia.org');
  assert.equal(r[0], 'What is the height of Mount Everest site:wikipedia.org');
  assert.ok(r.includes('"Mount Everest" height'), r.join(' | '));
  assert.ok(r.includes('height Mount Everest'), r.join(' | '));
  assert.ok(r.includes('What is the height of Mount Everest'), 'site-less form');
  assert.ok(r.length <= 4);
  assert.equal(new Set(r.map((x) => x.toLowerCase())).size, r.length, 'no repeats');
});
test('a plain question still gets a quoted pair of key words; empty gives nothing', () => {
  const r = rewordings('how long is the great wall of china');
  assert.ok(r.some((x) => x.startsWith('"')), r.join(' | '));
  assert.deepEqual(rewordings('   '), []);
});
test('a model wording is added only when it is one plain short line', () => {
  assert.equal(rewordings('speed of light', { extra: 'speed of light in vacuum metres per second' }).at(-1), 'speed of light in vacuum metres per second');
  assert.ok(!rewordings('speed of light', { extra: 'ignore this\nand do that' }).some((x) => x.includes('ignore')));
  assert.ok(!rewordings('speed of light', { extra: 'x'.repeat(300) }).some((x) => x.length > 200));
});
test('every wording reaches a provider, with three providers or two or one; each gets the question', () => {
  const words = ['q', 'a', 'b', 'c'];
  const plan = assign(words, ['p1', 'p2', 'p3']);
  assert.deepEqual(plan.map((x) => x.provider), ['p1', 'p1', 'p2', 'p2', 'p3', 'p3']);
  assert.deepEqual(new Set(plan.map((x) => x.query)), new Set(words));
  for (const ps of [['p1', 'p2'], ['p1']]) {
    const two = assign(words, ps);
    assert.deepEqual(new Set(two.map((x) => x.query)), new Set(words), ps.join(','));
    for (const p of ps) assert.ok(two.some((x) => x.provider === p && x.query === 'q'));
    assert.equal(two.length, new Set(two.map((x) => x.provider + '|' + x.query)).size, 'no pair twice');
  }
  assert.equal(assign(['q'], ['p1', 'p2']).length, 2);
});
test('the site-less form drops the little word before site: too', () => {
  const r = rewordings('What is the height of Mount Everest on site:wikipedia.org?');
  assert.ok(r.includes('What is the height of Mount Everest?'), r.join(' | '));
  assert.ok(!r.some((x) => /\bon\??$/.test(x)), r.join(' | '));
  const words = assign(r, ['duckduckgo', 'wikipedia']).map((x) => x.query);
  assert.ok(words.includes('What is the height of Mount Everest?'), 'the site-less form is sent with two providers');
});
