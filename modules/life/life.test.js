import test from 'node:test';
import assert from 'node:assert/strict';
import { unreachableAnswer } from './server.js';

test('an unreachable outside service is told in plain words, with no program error text', () => {
  const a = unreachableAnswer('the exchange rate service (Frankfurter)');
  assert.equal(a.ok, false); assert.equal(a.unreachable, true);
  assert.equal(a.error, 'Could not reach the exchange rate service (Frankfurter) just now. Try again in a minute.');
  assert.doesNotMatch(a.error, /fetch failed|ECONN|undefined|null/);
});

test('the routes answer a failed outside call with the plain line, never the raw error', async () => {
  const { testDesk } = await import('../../test/helpers/desk.js');
  const t = await testDesk({ modules: ['life'] });
  const fetch0 = globalThis.fetch;
  globalThis.fetch = (u, o) => String(u).startsWith(t.base) ? fetch0(u, o) : Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.frankfurter.app'), { code: 'ENOTFOUND' }) }));
  try {
    await t.core.modules.set('life', true);
    await t.call('/api/m/life/place', { body: { place: { name: 'Pune', label: 'Pune, India', lat: 18.52, lon: 73.86, timezone: 'Asia/Kolkata' } } });
    for (const p of ['/api/m/life/rates?base=EUR', '/api/m/life/weather', '/api/m/life/places?q=Pune']) {
      const r = await t.call(p);
      assert.equal(r.json.ok, false, p);
      assert.match(r.json.error, /^Could not reach .+ just now\. Try again in a minute\.$/, p);
      assert.doesNotMatch(r.text, /fetch failed|ENOTFOUND|getaddrinfo|TypeError/, p);
    }
  } finally { globalThis.fetch = fetch0; await t.close(); }
});
