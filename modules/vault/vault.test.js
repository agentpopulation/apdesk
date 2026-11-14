// Vault sealing: a login value opens only with the right key and only under its own id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newKdf, deriveKey, seal, open, isSealed } from './crypto.js';

test('seal and open a login value; wrong key, wrong id or tampering fail', async () => {
  const kdf = newKdf(); const k = await deriveKey('a long passphrase', kdf); const k2 = await deriveKey('another passphrase', kdf);
  const s = seal(k, 'apd-vault/login/v1|lg_1', '{"username":"u","password":"p"}');
  assert.ok(isSealed(s) && !s.includes('"p"'));
  assert.equal(open(k, 'apd-vault/login/v1|lg_1', s), '{"username":"u","password":"p"}');
  assert.throws(() => open(k2, 'apd-vault/login/v1|lg_1', s));
  assert.throws(() => open(k, 'apd-vault/login/v1|lg_2', s));
  const r = JSON.parse(s.slice(7)); r.ct = Buffer.from('x' + Buffer.from(r.ct, 'base64').toString('latin1').slice(1), 'latin1').toString('base64');
  assert.throws(() => open(k, 'apd-vault/login/v1|lg_1', 'enc:v1:' + JSON.stringify(r)));
});
