// Passage splitting and ranking, no network.
import test from 'node:test'; import assert from 'node:assert/strict';
import { tokens, splitPassages, rankPassages } from './rank.js';

test('tokens: lower case, no stop words, plural folded', () => {
  assert.deepEqual(tokens('What is the boiling point of Water?'), ['boil', 'point', 'water']);
  assert.deepEqual(tokens('Planets and moons'), ['planet', 'moon']);
});

test('passages are word for word slices of the page, none too long', () => {
  const text = ['Intro line about nothing in particular.', '', 'A '.repeat(400) + 'end.', '', 'Short.', 'Another short one here.'].join('\n');
  const ps = splitPassages(text);
  assert.ok(ps.length >= 3);
  for (const p of ps) { assert.ok(text.includes(p.text), 'slice of the page'); assert.ok(p.text.split(/\s+/).length <= 90, 'not too long'); }
  assert.deepEqual(ps.map((p) => p.pos), ps.map((_, i) => i));
});

test('BM25 puts the passage that answers first', () => {
  const ps = [
    { text: 'The city has many parks and a river.' },
    { text: 'The boiling point of water at sea level is 100 degrees Celsius.' },
    { text: 'Water is used for drinking and farming in the region.' },
  ];
  const r = rankPassages('boiling point of water', ps);
  assert.match(r[0].text, /100 degrees/);
  assert.ok(r[0].score > r[1].score);
  assert.equal(rankPassages('', ps).length, 0);
  assert.equal(rankPassages('zebra', ps).length, 0, 'no shared word: nothing is returned as an answer');
});

test('paragraphs joined with no space are still split at the sentence end', () => {
  const ps = splitPassages('word '.repeat(70) + 'ends here.Second part starts ' + 'more '.repeat(70) + 'end.');
  assert.ok(ps.some((p) => p.text.startsWith('Second part')), ps.map((p) => p.text.slice(0, 20)).join(' | '));
});
