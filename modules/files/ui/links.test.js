// The Markdown preview on the Files page shows where each link goes, beside its words and as its hover text.
import test from 'node:test'; import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { showWhereLinksGo } from './links.js';

test('a link whose words say one thing shows the address it really goes to', () => {
  const { document } = parseHTML('<html><body><div class="md"><p><a href="https://pay.elsewhere.example/x?d=1">Your bank</a> and <a href="https://harlow.example">https://harlow.example</a></p></div></body></html>');
  const el = showWhereLinksGo(document.querySelector('.md'));
  assert.equal(el.textContent, 'Your bank (pay.elsewhere.example/x?d=1) and https://harlow.example');
  const [a, b] = el.querySelectorAll('a');
  assert.equal(a.getAttribute('title'), 'https://pay.elsewhere.example/x?d=1'); assert.equal(b.getAttribute('title'), 'https://harlow.example');
  assert.equal(el.querySelectorAll('.link-where').length, 1, 'an address shown as its own words is not said twice');
});
