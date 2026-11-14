// The cell check for files made from web facts (deterministic; no model).
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTable, pagesFrom } from './verify.js';

test('a price for iPhone 15 near "iPhone" does not confirm iPhone 16; the iPhone 16 page does, with URL and passage', () => {
  const pages = [{ url: 'https://example.com/iphone-15', text: 'The iPhone 15 launched at $799 with 128 GB. Some say the iPhone 16 may follow.' }];
  let r = verifyTable({ columns: ['Phone', 'Price (USD)'], rows: [['Apple iPhone 16', '799']] }, pages);
  assert.deepEqual(r.rows, [['Apple iPhone 16', 'not checked']]);
  r = verifyTable({ columns: ['Phone', 'Price (USD)'], rows: [['Apple iPhone 16', '799']] }, [{ url: 'https://example.com/iphone-15', text: 'iPhone 15 ... 16 GB of storage, price 799' }]);
  assert.equal(r.rows[0][1], 'not checked', '"iPhone 15 ... 16 GB" is not iPhone 16');
  pages.push({ url: 'https://www.apple.com/iphone-16/specs/', text: 'iPhone 16. Price from $799. Weight: 170 grams. Battery 3,561 mAh.' });
  r = verifyTable({ columns: ['Phone', 'Price (USD)', 'Weight (g)', 'Battery'], rows: [['Apple iPhone 16', '799', '170', '3561'], ['Apple iPhone 16e', '599', '', '']] }, pages);
  assert.deepEqual(r.rows[0], ['Apple iPhone 16', '799', '170', '3561']);
  assert.deepEqual(r.rows[1], ['Apple iPhone 16e', 'not checked', 'not checked', 'not checked']);
  for (const c of r.cells.filter(x => x.ok)) { assert.equal(c.url, 'https://www.apple.com/iphone-16/specs/'); assert.ok(pages[1].text.includes(c.quote.slice(0, 20))); assert.ok(c.quote.replace(/,/g, '').includes(c.value)); }
  assert.deepEqual(r.sources, ['apple.com']);
});

test('a value present only in a search snippet is "not checked": search results are not pages', () => {
  const searchOut = { results: [{ title: 'Pixel 9', url: 'https://example.org/pixel-9', snippet: 'Google Pixel 9 costs $799' }] };
  assert.deepEqual(pagesFrom('web_search', {}, searchOut), []);   // snippets have no page text
  const r = verifyTable({ columns: ['Phone', 'Price'], rows: [['Google Pixel 9', '799']] }, pagesFrom('web_search', {}, searchOut));
  assert.equal(r.rows[0][1], 'not checked');
  const read = pagesFrom('web_read', { url: 'https://example.org/pixel-9' }, { url: 'https://example.org/pixel-9', title: 'Pixel 9', text: 'Google Pixel 9 launched at $799.' });
  assert.equal(verifyTable({ columns: ['Phone', 'Price'], rows: [['Google Pixel 9', '799']] }, read).rows[0][1], '799');
});

test('a number confirms a cell only with the column\'s own word or unit: "(170 mm)" is not a weight, "Weight: 170 g" is', () => {
  const plus = [{ url: 'https://example.com/iphone-16', text: 'iPhone 16 Plus display 6.7 inches (170 mm) diagonal. iPhone 16 storage 170 GB free, price $170 off.' }];
  let r = verifyTable({ columns: ['Phone', 'Weight (g)'], rows: [['Apple iPhone 16', '170']] }, plus);
  assert.equal(r.rows[0][1], 'not checked', '170 mm, 170 GB and $170 are not a weight');
  const page = [{ url: 'https://example.com/iphone-16', text: 'iPhone 16 Plus display 6.7 inches (170 mm) diagonal. Size and weight. iPhone 16 Weight: 170 g. Battery 3561 mAh. Display 6.1-inch. From $799.' }];
  r = verifyTable({ columns: ['Phone', 'Weight (g)', 'Battery Capacity (mAh)', 'Screen Size (inches)', 'Launch Price (USD)'], rows: [['Apple iPhone 16', '170', '3561', '6.1', '799']] }, page);
  assert.deepEqual(r.rows[0], ['Apple iPhone 16', '170', '3561', '6.1', '799']);
  const w = r.cells.find(c => c.column === 'Weight (g)');
  assert.match(w.quote, /Weight: 170 g/); assert.doesNotMatch(w.quote, /170 mm/);
  // a wrong value that only appears with another unit is never confirmed
  r = verifyTable({ columns: ['Phone', 'Battery Capacity (mAh)'], rows: [['Apple iPhone 16', '170']] }, page);
  assert.equal(r.rows[0][1], 'not checked');
  // a header with nothing to go on keeps the earlier rule
  r = verifyTable({ columns: ['Phone', 'Founded'], rows: [['Acme Corp', '1999']] }, [{ url: null, text: 'Acme Corp began in 1999 in Pune.' }]);
  assert.equal(r.rows[0][1], '1999');
});
