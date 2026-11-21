// The private library on an in-memory SQLite: kept, searched with FTS5, size limit, never keep, clear.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createLibrary } from './library.js';
import { memoryDoor } from './standin.js';

const page = (url, text, at = '2026-01-01T00:00:00.000Z') => ({ url, finalUrl: url, title: 'T ' + url, text, kind: 'html', fetchedAt: at });
const long = (fact) => 'Opening words of the page that say nothing much at all about the subject here. '.repeat(3) + '\n\n' + fact + '\n\n' + 'Closing words about other things, the weather and the market. '.repeat(3);

test('a kept page is found by its passage, quoted word for word, with address and read time', () => {
  const { db, kv } = memoryDoor(); const lib = createLibrary(db, kv);
  lib.keep(page('https://a.example/water', long('Water boils at 100 degrees Celsius at sea level.')));
  lib.keep(page('https://b.example/iron', long('Iron melts at 1538 degrees Celsius.')));
  const r = lib.search('At what temperature does water boil?');
  assert.ok(r.length >= 1);
  assert.match(r[0].text, /Water boils at 100 degrees Celsius/);
  assert.equal(r[0].url, 'https://a.example/water'); assert.equal(r[0].readAt, '2026-01-01T00:00:00.000Z'); assert.equal(r[0].from, 'library');
  assert.ok(lib.get('https://a.example/water').text.includes(r[0].text), 'word for word');
  assert.equal(lib.search('water', { allowed: (h) => h !== 'a.example' }).filter((x) => x.host === 'a.example').length, 0, 'a site the rules hide is left out');
  assert.deepEqual(lib.search('the of and'), []);
});

test('reading the same page again replaces it; the size limit removes oldest first', () => {
  const { db, kv } = memoryDoor(); const lib = createLibrary(db, kv);
  lib.keep(page('https://a.example/x?utm_source=z', long('First copy.'), '2026-01-01T00:00:00.000Z'));
  lib.keep(page('https://a.example/x', long('Second copy.'), '2026-01-02T00:00:00.000Z'));
  assert.equal(lib.stats().pages, 1); assert.match(lib.get('https://a.example/x').text, /Second copy/);
  kv.set('limitMb', 5);
  const big = 'word '.repeat(450_000);                                  // about 2.2 MB each
  lib.keep(page('https://old.example/', big, '2026-02-01T00:00:00.000Z'));
  lib.keep(page('https://mid.example/', big, '2026-02-02T00:00:00.000Z'));
  lib.keep(page('https://new.example/', big, '2026-02-03T00:00:00.000Z'));
  assert.equal(lib.get('https://old.example/'), null, 'oldest removed');
  assert.ok(lib.get('https://new.example/'));
  assert.ok(lib.stats().bytes <= 5 * 1024 * 1024);
  assert.throws(() => lib.setLimitMb(1), /5 MB/);
});

test('never keep: not stored, and what was kept from the site is dropped; Clear empties it all', () => {
  const { db, kv } = memoryDoor(); const lib = createLibrary(db, kv);
  lib.keep(page('https://news.private.example/a', long('Kept before the rule.')));
  lib.addNeverKeep('https://www.private.example/');
  assert.deepEqual(lib.neverKeep(), ['private.example']);
  assert.equal(lib.stats().pages, 0);
  assert.equal(lib.keep(page('https://private.example/b', long('Not kept.'))), null);
  lib.keep(page('https://ok.example/', long('Kept.')));
  assert.equal(lib.clear(), 1); assert.equal(lib.stats().pages, 0); assert.deepEqual(lib.search('kept'), []);
  assert.deepEqual(lib.dropNeverKeep('private.example'), []);
});

test('a page kept through a redirect is hidden when the site first asked for is hidden', () => {
  const { db, kv } = memoryDoor(); const lib = createLibrary(db, kv);
  lib.keep({ url: 'https://ask.example/water', finalUrl: 'https://cdn.other.example/water', title: 'W', text: long('Water boils at 100 degrees Celsius at sea level.'), kind: 'html', fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(lib.search('water boil').length >= 1, true);
  assert.deepEqual(lib.search('water boil', { allowed: (h) => h !== 'ask.example' }), []);
});

test('the size shown counts what is stored; removing pages stays quick on a big library', () => {
  const { db, kv } = memoryDoor(); const lib = createLibrary(db, kv);
  const para = (i) => `Paragraph ${i} about rivers, hills, towns ${i} and roads near the sea in many different words. `.repeat(6);
  const text = Array.from({ length: 120 }, (_, i) => para(i)).join('\n\n');            // about 80 KB, 120 passages
  for (let i = 0; i < 300; i++) lib.keep(page(`https://s${i}.example/p`, text, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
  const pageSize = db.get('PRAGMA page_size').page_size; const used = (db.get('PRAGMA page_count').page_count - db.get('PRAGMA freelist_count').freelist_count) * pageSize;
  const shown = lib.stats().bytes;
  assert.ok(used <= shown * 1.05 && shown <= used * 1.6, `stored ${(used / 1e6).toFixed(1)} MB, shown ${(shown / 1e6).toFixed(1)} MB`);
  const t0 = Date.now(); const { removed } = lib.setLimitMb(5);
  assert.ok(removed > 200); assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.ok(lib.stats().bytes <= 5 * 1024 * 1024);
  assert.match(lib.search('rivers hills towns')[0]?.text || '', /rivers, hills/, 'what is left still searches');
});

test('a library kept before the index change is indexed again on start and still searches', () => {
  const { db, kv } = memoryDoor();
  db.migrate(1, `CREATE TABLE IF NOT EXISTS m_finder_pages (id INTEGER PRIMARY KEY AUTOINCREMENT, norm TEXT NOT NULL UNIQUE, url TEXT NOT NULL, host TEXT, title TEXT, kind TEXT, text TEXT, bytes INTEGER, read_at TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS m_finder_passages USING fts5(body, page_id UNINDEXED, pos UNINDEXED, tokenize = 'porter unicode61');`);
  db.run('INSERT INTO m_finder_pages (norm, url, host, title, kind, text, bytes, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'https://a.example/w', 'https://a.example/w', 'a.example', 'W', 'html', long('Water boils at 100 degrees Celsius at sea level.'), 10, '2026-01-01T00:00:00.000Z');
  const lib = createLibrary(db, kv);
  assert.match(lib.search('water boil')[0]?.text || '', /Water boils at 100/);
});
