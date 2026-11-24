// The desk's pages never load a picture from outside by themselves: a reply or a result holding an outside picture
// address would otherwise send what is on screen to that host the moment the page is drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';

test('the page header lets pictures come only from the desk itself, data: and blob:', async () => {
  const t = await testDesk();
  try {
    const r = await fetch(t.base + '/');
    const csp = r.headers.get('content-security-policy') || '';
    const img = csp.split(';').map(s => s.trim()).find(s => s.startsWith('img-src'));
    assert.equal(img, "img-src 'self' data: blob:");
    assert.doesNotMatch(csp, /https?:(?!\/\/)/, 'no scheme-wide source anywhere in the header');
  } finally { await t.close(); }
});
