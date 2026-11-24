// Signing and checking a module or skill folder. Same key format as AP Desk's own updates (app/core/update.js,
// tools/make-update-keys.mjs, tools/sign-release.mjs in the desk): an Ed25519 private key in a PKCS#8 PEM file, kept
// outside the folder; a public key as { id, publicKey: base64 of the SPKI DER }; the signature is base64 of the raw
// Ed25519 signature over the exact bytes signed. So the owner's update key can also sign his modules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles } from './files.mjs';

export const SIG_FILE = 'module.sig.json';
export const SKILL_SIG_FILE = 'skill.sig.json';
export const FORMAT = 'apdesk-folder-sig/1';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** A short fingerprint of a public key (base64 SPKI DER): the first 32 hex digits of its SHA-256, in groups of four.
 *  Read it out to the publisher by another way (phone, in person) to know the key is his. */
export const fingerprint = (b64) => sha256(Buffer.from(String(b64), 'base64')).slice(0, 32).match(/.{4}/g).join(' ');

/** The exact bytes that are signed: the record without its signature, keys in a fixed order, files sorted by path. */
export function signedBytes(rec) {
  const files = [...rec.files].map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Buffer.from(JSON.stringify({ format: rec.format, name: rec.name, publisher: rec.publisher, keyId: rec.keyId, signed: rec.signed, files }));
}

/** Every file of the folder with its hash, except the signature file itself. Paths use '/'. */
export function hashFolder(dir, sigName = SIG_FILE) {
  return listFiles(dir).filter((f) => f.rel !== sigName).map((f) => ({ path: f.rel, sha256: sha256(fs.readFileSync(f.abs)) }));
}

export function readPrivateKey(file) {
  const key = crypto.createPrivateKey(fs.readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('That is not an Ed25519 key. Use a key made by tools/make-module-keys.mjs or the desk\'s tools/make-update-keys.mjs.');
  return key;
}
export const publicOf = (priv) => crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');

/** Make the signature record for a folder. */
export function signFolder(dir, { keyFile, publisher, keyId, name, sigName = SIG_FILE, date = new Date() }) {
  const priv = readPrivateKey(keyFile);
  const rec = { format: FORMAT, name, publisher, keyId, signed: date.toISOString().slice(0, 10), files: hashFolder(dir, sigName) };
  rec.publicKey = publicOf(priv);
  rec.signature = crypto.sign(null, signedBytes(rec), priv).toString('base64');
  return rec;
}

/** Public keys from a file: a list like the desk's update-keys.json ({ keys: [...] }), one entry ({ id, publicKey }), or a PEM public key. */
export function loadKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/-----BEGIN PUBLIC KEY-----/.test(text)) {
    const k = crypto.createPublicKey(text);
    return [{ id: path.basename(file), publicKey: k.export({ type: 'spki', format: 'der' }).toString('base64') }];
  }
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : Array.isArray(j.keys) ? j.keys : [j];
  return list.filter((k) => k && typeof k.publicKey === 'string');
}

/**
 * Check a folder against its signature file. -> { state, line, file? }
 *   state 'signed'    every hash and the signature check out, by a key you trust
 *   state 'untrusted' the signature checks out but the key is not one you said you trust (yellow)
 *   state 'changed'   a file changed, went missing or was added after signing, or the signature is wrong (red)
 *   state 'unsigned'  no signature file (yellow)
 */
export function verifyFolder(dir, trusted = [], sigName = SIG_FILE) {
  const f = path.join(dir, sigName);
  if (!fs.existsSync(f)) return { state: 'unsigned', line: 'Not signed: you are trusting these files as they are.' };
  let rec; try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { state: 'changed', line: `The signature file ${sigName} cannot be read.` }; }
  if (rec.format !== FORMAT || !Array.isArray(rec.files) || typeof rec.signature !== 'string') return { state: 'changed', line: `The signature file ${sigName} is not in the expected form.` };
  const now = new Map(hashFolder(dir, sigName).map((x) => [x.path, x.sha256]));
  for (const x of rec.files) {
    if (!now.has(x.path)) return { state: 'changed', line: `A file listed in the signature is missing: ${x.path}`, file: x.path };
    if (now.get(x.path) !== x.sha256) return { state: 'changed', line: `A file changed after signing: ${x.path}`, file: x.path };
    now.delete(x.path);
  }
  if (now.size) { const extra = [...now.keys()][0]; return { state: 'changed', line: `A file was added after signing: ${extra}`, file: extra }; }
  const sig = Buffer.from(rec.signature, 'base64');
  const tryKey = (b64) => { try { return crypto.verify(null, signedBytes(rec), crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' }), sig); } catch { return false; } };
  const good = trusted.find((k) => tryKey(k.publicKey));
  if (good) return { state: 'signed', line: `Signed with the key you gave (fingerprint ${fingerprint(good.publicKey)}), files unchanged since signing. The name in the signature, "${rec.publisher || 'unnamed'}", is what the signer typed; the key is what counts, and only if you got it from the publisher by another way.`, publisher: rec.publisher };
  if (rec.publicKey && tryKey(rec.publicKey)) return { state: 'untrusted', line: `Signed with a key you have not said you trust (fingerprint ${fingerprint(rec.publicKey)}; the signer typed the name "${rec.publisher || 'unnamed'}"). Files unchanged since signing. A key that came in the same zip or message proves nothing: get the publisher's key from him by another way, then pass it with --key.` };
  return { state: 'changed', line: 'The signature does not match the files: they may have been changed after signing.' };
}
