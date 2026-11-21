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
