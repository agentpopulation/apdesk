// Vault crypto: scrypt key derivation and
// AES-256-GCM sealing of one login value, with the id as additional data so values cannot be swapped between logins.
import crypto from 'node:crypto';

const KEY_LEN = 32, IV_LEN = 12;
export const DEFAULT_KDF = Object.freeze({ alg: 'scrypt', N: 2 ** 15, r: 8, p: 1 });
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (t) => Buffer.from(String(t || ''), 'base64');

export function newKdf() { return { ...DEFAULT_KDF, salt: b64(crypto.randomBytes(16)) }; }

/** scrypt with the stored parameters. Async so it never blocks the event loop. */
export function deriveKey(passphrase, kdf) {
  if (kdf?.alg !== 'scrypt') return Promise.reject(new Error('unsupported kdf'));
  const N = Number(kdf.N), r = Number(kdf.r), p = Number(kdf.p);
  return new Promise((resolve, reject) => crypto.scrypt(String(passphrase), unb64(kdf.salt), KEY_LEN, { N, r, p, maxmem: 128 * N * r * 2 }, (e, k) => (e ? reject(e) : resolve(k))));
}

export function seal(key, aad, plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(String(plain), 'utf8')), c.final()]);
  return 'enc:v1:' + JSON.stringify({ iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) });
}
export const isSealed = (v) => typeof v === 'string' && v.startsWith('enc:v1:');
/** Throws on a wrong key or tampered bytes. */
export function open(key, aad, sealed) {
  const r = JSON.parse(String(sealed).slice(7));
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(r.iv)); d.setAAD(Buffer.from(aad)); d.setAuthTag(unb64(r.tag));
  return Buffer.concat([d.update(unb64(r.ct)), d.final()]).toString('utf8');
}
export function wipe(buf) { if (Buffer.isBuffer(buf)) buf.fill(0); }
