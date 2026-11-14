// RFC 4226 (HOTP) and RFC 6238 (TOTP) with node:crypto, plus base32 (RFC 4648) and the otpauth:// URI authenticator apps read.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  const s = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of s) { const i = B32.indexOf(c); if (i < 0) throw new Error('Not base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function hotp(key, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
export const totp = (secretB32, { time = Date.now(), step = 30, digits = 6, algorithm = 'sha1' } = {}) => hotp(base32Decode(secretB32), Math.floor(time / 1000 / step), { digits, algorithm });
/** True when the code matches this 30-second step or the one before or after (clock drift). */
export function verifyTotp(secretB32, code, { time = Date.now(), window = 1, step = 30, digits = 6 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d+$/.test(c) || c.length !== digits) return false;
  const key = base32Decode(secretB32); const n = Math.floor(time / 1000 / step);
  for (let w = -window; w <= window; w++) { const want = Buffer.from(hotp(key, n + w, { digits })); if (crypto.timingSafeEqual(want, Buffer.from(c))) return true; }
  return false;
}
export const newSecret = () => base32Encode(crypto.randomBytes(20));
export const otpauthUri = (secret, { issuer = 'AP Desk', account = 'Owner' } = {}) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
