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
  assert.ok(!r[1] || r[0].score > r[1].score);
  assert.equal(rankPassages('', ps).length, 0);
  assert.equal(rankPassages('zebra', ps).length, 0, 'no shared word: nothing is returned as an answer');
});

test('paragraphs joined with no space are still split at the sentence end', () => {
  const ps = splitPassages('word '.repeat(70) + 'ends here.Second part starts ' + 'more '.repeat(70) + 'end.');
  assert.ok(ps.some((p) => p.text.startsWith('Second part')), ps.map((p) => p.text.slice(0, 20)).join(' | '));
});

test('page markup to plain text: each block on its own line, link lists dropped, no marks left', async () => {
  const { plainText } = await import('./rank.js');
  const md = ['# Mount Everest', '', '-   [History](#History)', '-   [Geography](#Geography)', '-   [See also](#See_also)', '',
    '**Mount Everest** is [Earth\'s](https://x.example/Earth "Earth (planet)") highest mountain.[\\[1\\]](#cite_note-1) Its height is 8,849 m\\.', '',
    '[![](//img.example/a.jpg)](https://x.example/File:a.jpg)', '', 'Elevation', '', '8,848.86 m (29,031.7 ft)'].join('\n');
  const t = plainText(md);
  assert.equal(t, "Mount Everest\n\nMount Everest is Earth's highest mountain.[1] Its height is 8,849 m.\n\nElevation\n\n8,848.86 m (29,031.7 ft)");
});

test('passages that are glued headings, link lists or citations rank below the sentence that answers, or go', async () => {
  const ps = [
    { text: 'ContentsHistoryGeographyEverest heightSee alsoReferencesMount Everest metres' },
    { text: '^ "Mount Everest height". Retrieved 3 May 2023. Archived from the original on 4 May 2023. ^ "Everest metres survey". Retrieved 5 May 2023.' },
    { text: 'Mount Everest\nEverest height\nEverest metres\nSee also' },
    { text: 'The current official height of Mount Everest is 8,849 metres, agreed by Nepal and China in 2020.' },
  ];
  const r = rankPassages('How high is Mount Everest in metres?', ps);
  assert.match(r[0].text, /8,849 metres/);
  assert.ok(r.length <= 2, r.map((p) => p.text.slice(0, 30)).join(' | '));
});

test('a passage must cover the key words of the question; one shared word is not an answer', () => {
  const ps = [
    { text: 'Australia reached the round of 16 at the 2022 World Cup and lost to Argentina.', title: '2022 FIFA World Cup' },
    { text: 'The final of the 2022 World Cup was played at Lusail Stadium in Qatar.', title: '2022 FIFA World Cup' },
    { text: 'The 2022 World Cup was the first held in the Arab world, in November and December.', title: '2022 FIFA World Cup' },
    { text: 'Thirty two teams took part in the 2022 World Cup, the last with that number of teams.', title: '2022 FIFA World Cup' },
  ];
  assert.equal(rankPassages('What is the capital of Australia?', ps, { strict: true }).length, 0, 'from the library');
  assert.equal(rankPassages('How high is Mount Kilimanjaro?', [{ text: 'Mount Everest is the highest mountain, high above the others.', title: 'Mount Everest' }], { strict: true }).length, 0);
  const w = rankPassages('Who won the 2022 FIFA World Cup final?', [...ps, { text: 'Argentina won the final on penalties after a 3 to 3 draw with France.', title: '2022 FIFA World Cup final' }]);
  assert.match(w[0].text, /Argentina won the final/);
});

test('"What is X?": the passage that says "X is" comes first', () => {
  const r = rankPassages('What is photosynthesis?', [
    { text: 'This index lists every note about photosynthesis.' },
    { text: 'Photosynthesis is the process by which plants turn light energy into chemical energy stored in sugar.' },
  ]);
  assert.match(r[0].text, /^Photosynthesis is the process/);
});

test('a heading of up to twelve words stays with the paragraph under it', () => {
  const ps = splitPassages('An opening paragraph that talks about the final and the awards in general words.\n\nWho won the 2026 FIFA World Cup Final?\n\nSpain. They beat Argentina 1-0 after extra time.');
  assert.ok(ps.some((p) => p.text === 'Who won the 2026 FIFA World Cup Final?\n\nSpain. They beat Argentina 1-0 after extra time.'), ps.map((p) => p.text).join(' | '));
});

test('a heading alone, a question alone or a reference list is not an answer; the line with the figure is', () => {
  const r = rankPassages('How high is Mount Everest in metres?', [
    { text: 'How Tall Is Mount Everest in Feet and Metres?', title: 'How tall is Mount Everest' },
    { text: 'How Everest Was Measured in Metres by Survey Teams' },
    { text: 'The official Mount Everest height in feet is 29,031.7 ft, which equals 8,848.86 meters.', title: 'How tall is Mount Everest' },
    { text: 'Mount Everest hosts weather stations; the highest is at about 8,430 metres above sea level, high on the mountain.', title: 'Mount Everest' },
    { text: 'July 20, 2026. Archived from the original on July 20, 2026. Retrieved July 20, 2026.\n↑ Mays, J. (2026). "Mount Everest metres". The Times. Retrieved August 3, 2026.\n↑ Dunbar, G. (2026). "How high is Everest". Retrieved 2026.', title: 'Mount Everest' },
  ]);
  assert.match(r[0].text, /8,848\.86 meters/);
  assert.ok(!r.some((p) => /^How Tall|^How Everest|Archived/.test(p.text)), r.map((p) => p.text.slice(0, 25)).join(' | '));
  const d = rankPassages('What is photosynthesis?', [{ text: 'Photosynthesis in plants releases oxygen, and photosynthesis in algae does too.' }, { text: 'Photosynthesis[note 1] is a system of biological processes by which organisms turn light into chemical energy.' }]);
  assert.match(d[0].text, /^Photosynthesis\[note 1\] is a system/);
});

test('a reference list whose entries end like sentences is not an answer, from the web or the library', () => {
  const refs = '"Spain vs Argentina | Final | Ocean Cup 2030". Ocean Cup. Retrieved July 19, 2030.\n"Match Report – Final – Spain v. Argentina". Ocean Cup. July 19, 2030. Retrieved July 19, 2030.\n"Post match summary report – Final – Spain v. Argentina". Ocean Cup. July 20, 2030. Retrieved July 20, 2030.';
  const ps = [{ text: refs, title: '2030 Ocean Cup final' }, { text: 'The 2030 Ocean Cup ended with Spain winning the final for the second time.', title: '2030 Ocean Cup' }];
  for (const strict of [false, true]) {
    const r = rankPassages('Who won the 2030 Ocean Cup final?', ps, { strict });
    assert.ok(!r.some((p) => /Retrieved/.test(p.text)), `strict ${strict}: ${r.map((p) => p.text.slice(0, 30)).join(' | ')}`);
  }
});

test('"won" finds "winning" and "win"; "how high" wants a figure, not the word "high"', () => {
  assert.deepEqual(tokens('Who won? Spain winning, a win'), ['win', 'spain', 'win', 'win']);
  const r = rankPassages('How high is Mount Talven in metres?', [
    { text: 'Mount Talven hosts several weather stations that record high-altitude winds. The highest of them sits at about 5,900 metres, just below the summit.', title: 'Mount Talven', start: 28000 },
    { text: 'Mount Talven rises 6,214 metres above sea level, by the survey of its summit snow.', title: 'How tall is Mount Talven', start: 0 },
    { text: 'Mount Talven height in metres is given on this page too.', title: 'Mount Talven', start: 900 },
  ]);
  assert.match(r[0].text, /6,214 metres/);
  assert.ok(!r.some((p) => /given on this page/.test(p.text)), 'asked for an amount, it gives none');
});
