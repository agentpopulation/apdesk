// TOTP against the RFC 6238 test vectors, and the lock routes (no model involved).
import test from 'node:test';
import assert from 'node:assert/strict';
import { totp, verifyTotp, base32Encode, base32Decode, otpauthUri } from './totp.js';
import { testDesk } from '../../test/helpers/desk.js';

test('TOTP matches RFC 6238 (SHA-1, 8 digits) and base32 round-trips', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (const [t, want] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']]) assert.equal(totp(secret, { time: t * 1000, digits: 8 }), want, `T=${t}`);
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  const now = Date.now(); const c = totp(secret, { time: now });
  assert.ok(verifyTotp(secret, c, { time: now + 25000 })); assert.ok(!verifyTotp(secret, c, { time: now + 120000 })); assert.ok(!verifyTotp(secret, '12345'));
  assert.match(otpauthUri(secret), /^otpauth:\/\/totp\/AP%20Desk:Owner\?secret=GEZD/);
});

test('lock routes: PIN, wrong PIN refused, routes report locked, TOTP needed when on', async () => {
  const t = await testDesk({ modules: ['accounts'] });
  try {
    await t.call('/api/modules/accounts/on', { method: 'POST' });
    assert.equal((await t.call('/api/m/accounts/pin', { body: { pin: '12' } })).status, 400);
    assert.equal((await t.call('/api/m/accounts/pin', { body: { pin: '4826' } })).json.hasPin, true);
    assert.ok(!JSON.stringify(t.core.storage.all("SELECT value FROM secrets")).includes('4826'), 'only a hash is stored');
    assert.equal((await t.call('/api/m/accounts/lock', { method: 'POST' })).json.locked, true);
    assert.equal((await t.call('/api/m/accounts/options', { body: { idleMinutes: 5 } })).status, 423);
    assert.equal((await t.call('/api/m/accounts/unlock', { body: { pin: '0000' } })).status, 403);
    assert.equal((await t.call('/api/m/accounts/unlock', { body: { pin: '4826' } })).json.locked, false);
    const s = (await t.call('/api/m/accounts/totp/setup', { method: 'POST' })).json;
    const secret = s.secret.replace(/\s/g, '');
    assert.equal((await t.call('/api/m/accounts/totp/confirm', { body: { code: totp(secret) } })).json.totp, true);
    await t.call('/api/m/accounts/lock', { method: 'POST' });
    assert.equal((await t.call('/api/m/accounts/unlock', { body: { pin: '4826' } })).status, 403, 'a code is needed');
    assert.equal((await t.call('/api/m/accounts/unlock', { body: { pin: '4826', code: totp(secret) } })).json.locked, false);
  } finally { await t.close(); }
});
