// Finding lists in HTML: pure functions, no network.
import test from 'node:test'; import assert from 'node:assert/strict';
import { candidates, guessMeaning, findBySignature, nextPage, similarity } from './extract.js';
import { rowKey, checkColumns } from './store.js';

test('extract: a plain table with a header row, mail links read as addresses, layout tables skipped', () => {
  const html = `<table><tr><td><table><tr><td>menu</td><td>x</td></tr><tr><td>a</td><td>b</td></tr></table></td></tr></table>
    <table><thead><tr><th>Name</th><th>Company</th><th>E-mail</th></tr></thead><tbody>
    <tr><td>Asha N</td><td>Harlow</td><td><a href="mailto:asha@harlow.example">Write</a></td></tr><tr><td>Ravi K</td><td>Marlow</td><td>ravi@marlow.example</td></tr></tbody></table>`;
  const c = candidates(html);
  const t = c.find(x => x.kind === 'table' && x.headings[0] === 'Name');
  assert.ok(t); assert.deepEqual(t.rows, [['Asha N', 'Harlow', 'asha@harlow.example'], ['Ravi K', 'Marlow', 'ravi@marlow.example']]);
  assert.equal(c.filter(x => x.kind === 'table').length, 2, 'the inner table is a list; the one holding it is layout');
});

test('extract: repeated blocks with the same shape become a list; "Label: value" gives the heading', () => {
  const card = (n, co, c) => `<div class="person"><h3 class="name">${n}</h3><p>Company: ${co}</p><p>Country: ${c}</p></div>`;
  const html = `<nav><a href="/">Home</a><a href="/a">A</a><a href="/b">B</a></nav><div class="grid">${card('Asha N', 'Harlow', 'India')}${card('Ravi K', 'Marlow', 'Kenya')}${card('Li W', 'Kestrel', 'Chile')}</div>`;
  const b = candidates(html).filter(x => x.kind === 'blocks');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0].headings, ['name', 'Company', 'Country']);
  assert.deepEqual(b[0].rows[1], ['Ravi K', 'Marlow', 'Kenya']);
});

test('extract: column guesses come from the heading words alone', () => {
  const g = (h) => guessMeaning(h);
  assert.deepEqual(['Full name', 'Company name', 'Job title', 'Email address', 'Country', 'Mobile network operator', 'Website', 'Booth'].map(g),
    ['name', 'company', 'title', 'email', 'country', 'operator', 'site', 'other']);
});

test('extract: a signature finds its table again; changed headings match by similarity and say what is new or gone', () => {
  const sig = { kind: 'table', headings: ['Name', 'Company', 'Email'], position: 1 };
  const same = [{ kind: 'table', position: 0, headings: ['Day', 'Talk'], rows: [] }, { kind: 'table', position: 1, headings: ['Name', 'Company', 'Email'], rows: [] }];
  assert.equal(findBySignature(same, sig).exact, true);
  const changed = [{ kind: 'table', position: 0, headings: ['Name', 'Company', 'Country', 'Email'], rows: [] }];
  const m = findBySignature(changed, sig);
  assert.equal(m.exact, false); assert.deepEqual(m.added, ['Country']); assert.deepEqual(m.gone, []);
  assert.equal(findBySignature([{ kind: 'table', position: 0, headings: ['Day', 'Talk', 'Room'], rows: [] }], sig), null, 'nothing alike: no guess');
  assert.ok(similarity(['A', 'B'], ['a', 'b']) === 1);
});

test('extract: a plain next link on the same site only', () => {
  assert.equal(nextPage('<a href="?page=2">Next</a>', 'https://ev.example/list'), 'https://ev.example/list?page=2');
  assert.equal(nextPage('<link rel="next" href="/list/2">', 'https://ev.example/list'), 'https://ev.example/list/2');
  assert.equal(nextPage('<a href="https://other.example/2">Next</a>', 'https://ev.example/list'), null, 'another site is not followed');
  assert.equal(nextPage('<a href="/about">About us</a>', 'https://ev.example/list'), null);
});

test('store: row keys and the owner\'s column choice', () => {
  const cols = ['name', 'company', 'email'];
  assert.equal(rowKey(['Asha', 'Harlow', 'Asha@Harlow.example'], cols), 'm:asha@harlow.example');
  assert.equal(rowKey(['Asha', 'Harlow', ''], cols), 'n:asha|harlow|');
  assert.throws(() => checkColumns(['email', 'email'], 2), /Only one column/);
  assert.throws(() => checkColumns(['other', 'other'], 2), /at least one/);
  assert.throws(() => checkColumns(['name'], 2), /each column/);
  assert.deepEqual(checkColumns(['name', 'name', 'company'], 3), ['name', 'name', 'company'], 'first and last name');
});

test('extract: page furniture is not offered as a list (edit links, footers, link-only menus, one repeated text)', () => {
  const head = (t, n) => `<div class="mw-heading mw-heading2"><h2 id="h${n}">${t}</h2><span class="mw-editsection"><span class="mw-editsection-bracket">[</span><a href="/w/index.php?action=edit&section=${n}"><span>edit</span></a><span class="mw-editsection-bracket">]</span></span></div>`;
  const row = (r, n, hq) => `<tr><td>${r}</td><td><a href="/wiki/${n}">${n}</a></td><td>${hq}</td></tr>`;
  const html = `<html class="vector-toc-available"><body class="skin-vector mw-footer-sticky"><div class="mw-content-ltr"><div class="mw-parser-output">${head('2025 list', 1)}${head('2024 list', 2)}${head('2023 list', 3)}${head('See also', 4)}
    <table class="wikitable"><tr><th>Rank</th><th>Name</th><th>Headquarters</th></tr>${row(1, 'Reliance', 'Mumbai')}${row(2, 'SBI', 'Mumbai')}${row(3, 'TCS', 'Mumbai')}</table></div></div>
    <div class="links"><div class="item"><a href="/a">About</a><a href="/a/more">More</a></div><div class="item"><a href="/b">Jobs</a><a href="/b/more">More</a></div><div class="item"><a href="/c">Press</a><a href="/c/more">More</a></div></div>
    <div class="site-footer-info"><div class="li"><span class="k">Terms</span><span class="v">x</span></div><div class="li"><span class="k">Privacy</span><span class="v">y</span></div><div class="li"><span class="k">Help</span><span class="v">z</span></div></div>
    <div class="rows"><div class="r"><span class="a">More</span><span class="b">›</span></div><div class="r"><span class="a">More</span><span class="b">›</span></div><div class="r"><span class="a">More</span><span class="b">›</span></div></div>
    <div class="people"><div class="p"><a class="n" href="/asha">Asha N</a><span class="co">Harlow</span></div><div class="p"><a class="n" href="/ravi">Ravi K</a><span class="co">Marlow</span></div><div class="p"><a class="n" href="/li">Li W</a><span class="co">Kestrel</span></div></div></body></html>`;
  const c = candidates(html);
  assert.deepEqual(c.map(x => [x.kind, x.headings[0]]), [['table', 'Rank'], ['blocks', 'n']], 'only the company table and the people cards');
  assert.deepEqual(c[1].rows[0], ['Asha N', 'Harlow'], 'a list whose names are links is still a list');
});
