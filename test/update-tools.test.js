// The owner's release tools, run here only with throw-away keys in the temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseZip } from './helpers/update.js';
import { verifyManifest, readManifest } from '../app/core/update.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const node = (script, args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...args], { encoding: 'utf8', env: { ...process.env, APD_UPDATE_KEY: '', ...env } });

test('make-update-keys: refuses no path, a path inside the repository and an existing file; prints the public entry', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-keys-'));
  try {
    assert.equal(node('make-update-keys.mjs', []).status, 1);
    const inside = node('make-update-keys.mjs', [path.join(ROOT, 'tools', 'release.key')]);
    assert.equal(inside.status, 1); assert.match(inside.stderr, /inside the AP Desk folder/);
    assert.ok(!fs.existsSync(path.join(ROOT, 'tools', 'release.key')));
    const file = path.join(tmp, 'release.key');
    const r = node('make-update-keys.mjs', [file, '--id', 'test-2026']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Anyone who has this file can ship updates to every desk/);
    const entry = JSON.parse(/\{[\s\S]*?\}/.exec(r.stdout)[0]);
    assert.equal(entry.id, 'test-2026');
    assert.ok(!r.stdout.includes('PRIVATE KEY'), 'the private key is never printed');
    const priv = crypto.createPrivateKey(fs.readFileSync(file));
    assert.equal(crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64'), entry.publicKey);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const before = fs.readFileSync(file);
    const again = node('make-update-keys.mjs', [file]);
    assert.equal(again.status, 1); assert.match(again.stderr, /already exists/);
    assert.deepEqual(fs.readFileSync(file), before, 'nothing overwritten');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('sign-release: signs the zip in dist, checks itself against the listed keys, and refuses a key that is not listed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-sign-'));
  try {
    const keyFile = path.join(tmp, 'release.key');
    const k = node('make-update-keys.mjs', [keyFile, '--id', 'k1']); assert.equal(k.status, 0, k.stderr);
    const entry = JSON.parse(/\{[\s\S]*?\}/.exec(k.stdout)[0]);
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, 'app', 'core'), { recursive: true }); fs.mkdirSync(path.join(repo, 'dist'));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '0.1.1' }));
    fs.writeFileSync(path.join(repo, 'app', 'core', 'update-keys.json'), JSON.stringify({ keys: [entry] }));
    const zip = releaseZip('0.1.1', { extra: [['apdesk/app/core/update-keys.json', JSON.stringify({ keys: [entry] })]] });
    fs.writeFileSync(path.join(repo, 'dist', 'agent-population-desk.zip'), zip);

    assert.match(node('sign-release.mjs', ['--repo', repo, '--version', '0.1.1', '--note', 'x']).stderr, /Say where the private key is/, 'no default key path');
    assert.match(node('sign-release.mjs', ['--repo', repo, '--version', '0.1.2', '--key', keyFile, '--note', 'x']).stderr, /package\.json says 0\.1\.1/);
    const r = node('sign-release.mjs', ['--repo', repo, '--version', '0.1.1', '--note', 'Signed updates.', '--note', 'Fixes.'], { APD_UPDATE_KEY: keyFile });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Tag: {3}v0\.1\.1/); assert.match(r.stdout, /apdesk-update\.json\.sig/);
    const bytes = fs.readFileSync(path.join(repo, 'dist', 'apdesk-update.json'));
    const v = verifyManifest(bytes, fs.readFileSync(path.join(repo, 'dist', 'apdesk-update.json.sig'), 'utf8'), [entry]);
    assert.equal(v.ok, true); assert.equal(v.keyId, 'k1');
    const m = readManifest(bytes);
    assert.equal(m.version, '0.1.1'); assert.deepEqual(m.notes, ['Signed updates.', 'Fixes.']);
    assert.equal(m.files[0].sha256, crypto.createHash('sha256').update(zip).digest('hex')); assert.equal(m.files[0].size, zip.length);

    // a key that is not in the list: stops, writes nothing
    fs.rmSync(path.join(repo, 'dist', 'apdesk-update.json')); fs.rmSync(path.join(repo, 'dist', 'apdesk-update.json.sig'));
    const other = path.join(tmp, 'other.key'); assert.equal(node('make-update-keys.mjs', [other]).status, 0);
    const bad = node('sign-release.mjs', ['--repo', repo, '--version', '0.1.1', '--key', other, '--note', 'x']);
    assert.equal(bad.status, 1); assert.match(bad.stderr, /does not match any key/);
    assert.ok(!fs.existsSync(path.join(repo, 'dist', 'apdesk-update.json')));
    // a zip that does not carry the key: desks could not check the next update
    fs.writeFileSync(path.join(repo, 'dist', 'agent-population-desk.zip'), releaseZip('0.1.1'));
    assert.match(node('sign-release.mjs', ['--repo', repo, '--version', '0.1.1', '--key', keyFile, '--note', 'x']).stderr, /does not list this key/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('sign-release: --notes reads a plain text file, --channel is signed in (stable by default), and too much or odd input is refused', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-sign-'));
  try {
    const keyFile = path.join(tmp, 'release.key');
    const k = node('make-update-keys.mjs', [keyFile, '--id', 'k1']); assert.equal(k.status, 0, k.stderr);
    const entry = JSON.parse(/\{[\s\S]*?\}/.exec(k.stdout)[0]);
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, 'app', 'core'), { recursive: true }); fs.mkdirSync(path.join(repo, 'dist'));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    fs.writeFileSync(path.join(repo, 'app', 'core', 'update-keys.json'), JSON.stringify({ keys: [entry] }));
    fs.writeFileSync(path.join(repo, 'dist', 'agent-population-desk.zip'), releaseZip('0.2.0', { extra: [['apdesk/app/core/update-keys.json', JSON.stringify({ keys: [entry] })]] }));
    const notes = path.join(tmp, 'notes.txt');
    const sign = (...extra) => node('sign-release.mjs', ['--repo', repo, '--version', '0.2.0', '--key', keyFile, ...extra]);
    const read = () => { const b = fs.readFileSync(path.join(repo, 'dist', 'apdesk-update.json')); assert.equal(verifyManifest(b, fs.readFileSync(path.join(repo, 'dist', 'apdesk-update.json.sig'), 'utf8'), [entry]).ok, true); return { raw: JSON.parse(b), m: readManifest(b) }; };

    fs.writeFileSync(notes, 'Faster start.\r\n\r\n  <b>Not markup</b>  \nOne more.\n');
    let r = sign('--notes', notes); assert.equal(r.status, 0, r.stderr);
    let { raw, m } = read();
    assert.equal(raw.channel, 'stable'); assert.deepEqual(m.notes, ['Faster start.', '<b>Not markup</b>', 'One more.']);
    assert.doesNotMatch(r.stdout, /pre-release/);
    r = sign('--notes', notes, '--channel', 'preview'); assert.equal(r.status, 0, r.stderr);
    ({ raw, m } = read()); assert.equal(raw.channel, 'preview'); assert.equal(m.channel, 'preview');
    assert.match(r.stdout, /Set as a pre-release/);

    assert.match(sign('--notes', notes, '--channel', 'nightly').stderr, /stable or preview/);
    fs.writeFileSync(notes, 'x'.repeat(301)); assert.match(sign('--notes', notes).stderr, /at most 300 characters/);
    fs.writeFileSync(notes, Array.from({ length: 31 }, (_, i) => `line ${i}`).join('\n')); assert.match(sign('--notes', notes).stderr, /At most 30 notes/);
    fs.writeFileSync(notes, 'bell\u0007'); assert.match(sign('--notes', notes).stderr, /control characters/);
    assert.match(sign('--notes', path.join(tmp, 'missing.txt')).stderr, /could not be read/);
    fs.writeFileSync(notes, '\n\n'); assert.match(sign('--notes', notes).stderr, /Give the release notes/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
