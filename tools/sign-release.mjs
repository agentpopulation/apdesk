// Signs a release on the owner's own PC (contracts: app/core/contracts/UPDATES.md).
//   node tools/sign-release.mjs --version 0.1.1 --key <private key file> --note "One plain line" [--note "Another"] [--min-from 0.1.0]
// The key may instead be named by the environment variable APD_UPDATE_KEY (a file path). There is no default key path.
// Reads dist/agent-population-desk.zip (and dist/apdesk-source.zip if it is there), writes dist/apdesk-update.json and
// dist/apdesk-update.json.sig, checks its own output against app/core/update-keys.json, and prints what to attach.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { verifyManifest, readManifest, parseVersion, compareVersions } from '../app/core/update.js';

const args = process.argv.slice(2);
const stop = (line) => { console.error(line); process.exit(1); };
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const all = (name) => args.flatMap((a, i) => a === name && args[i + 1] != null ? [args[i + 1]] : []);
const ROOT = path.resolve(opt('--repo') || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DIST = path.join(ROOT, 'dist');
const KINDS = [['agent-population-desk.zip', 'windows-zip'], ['apdesk-source.zip', 'source-zip']];

const version = opt('--version');
if (!parseVersion(version)) stop('Say the version, for example: --version 0.1.1');
const keyFile = opt('--key') || process.env.APD_UPDATE_KEY;
if (!keyFile) stop('Say where the private key is: --key <file>, or set APD_UPDATE_KEY to its path.');
const notes = all('--note').map(n => n.trim()).filter(Boolean);
if (!notes.length) stop('Give at least one release note: --note "What changed, in one plain line"');
const minFrom = opt('--min-from') || '0.1.0';
if (!parseVersion(minFrom)) stop('--min-from must be a version such as 0.1.0');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.version !== version) stop(`package.json says ${pkg.version}, not ${version}. Bump the version, build the zip again, then sign.`);
if (compareVersions(minFrom, version) >= 0) stop('--min-from must be older than the version being released.');

let priv;
try { priv = crypto.createPrivateKey(fs.readFileSync(path.resolve(keyFile))); } catch (e) { stop(`The private key could not be read (${e.code || e.message}).`); }
if (priv.asymmetricKeyType !== 'ed25519') stop('That is not an Ed25519 key. Use the key tools/make-update-keys.mjs made.');
const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).toString('base64');
const keysFile = path.join(ROOT, 'app', 'core', 'update-keys.json');
const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8')).keys || [];
const mine = keys.find(k => k.publicKey === pub);
if (!mine) stop('This private key does not match any key in app/core/update-keys.json. Paste the entry tools/make-update-keys.mjs printed into that file, build the zip again, then sign.');

const files = [];
for (const [name, kind] of KINDS) {
  const f = path.join(DIST, name);
  if (!fs.existsSync(f)) continue;
  const zip = new AdmZip(f);
  const names = zip.getEntries().map(e => e.entryName);
  const server = names.find(n => /^([^/]+\/)?app\/server\.js$/.test(n));
  if (!server) stop(`${name} does not look like AP Desk (no app/server.js).`);
  const base = server.slice(0, -'app/server.js'.length);
  const read = (rel) => { try { return JSON.parse(zip.readAsText(base + rel)); } catch { return null; } };
  const inZip = read('app/version.json')?.version || read('package.json')?.version;
  if (inZip !== version) stop(`${name} holds version ${inZip || 'unknown'}, not ${version}. Build it again after bumping the version.`);
  if (!(read('app/core/update-keys.json')?.keys || []).some(k => k.publicKey === pub)) stop(`${name} does not list this key in app/core/update-keys.json. Desks that install it could not check the next update. Build it again.`);
  const bytes = fs.readFileSync(f);
  files.push({ name, kind, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
if (!files.length) stop(`No release zip in ${DIST}. Build it first: npm run zip`);

const manifest = { product: 'apdesk', version, date: new Date().toISOString(), key: mine.id, minFrom, notes, files };
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const sig = crypto.sign(null, bytes, priv).toString('base64') + '\n';
const out = path.join(DIST, 'apdesk-update.json');
fs.writeFileSync(out, bytes); fs.writeFileSync(out + '.sig', sig);

// check what was written, the way a desk will
const check = verifyManifest(fs.readFileSync(out), fs.readFileSync(out + '.sig', 'utf8'), keys);
if (!check.ok) { fs.rmSync(out, { force: true }); fs.rmSync(out + '.sig', { force: true }); stop('The signature did not verify: ' + check.reason); }
readManifest(fs.readFileSync(out));

const mb = (n) => (n / 1e6).toFixed(1) + ' MB';
console.log(`Signed AP Desk ${version} with the key ${mine.id}.

Create the release on GitHub (https://github.com/agentpopulation/apdesk/releases/new):
  Tag:   v${version}
  Title: AP Desk ${version}
Attach these ${files.length + 2} files:
${[...files.map(f => `  ${path.join(DIST, f.name)}  (${mb(f.size)})`), `  ${out}`, `  ${out}.sig`].join('\n')}
Publish it, then press "Check for updates" on a desk.`);
