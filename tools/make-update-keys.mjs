// Makes the key pair that signs AP Desk releases. Run it once, on your own PC (contracts: app/core/contracts/UPDATES.md).
//   node tools/make-update-keys.mjs <file to save the private key in> [--id <name>]
// The private key goes into that file (never inside this folder, never over an existing file). The public key is
// printed as the entry to paste into app/core/update-keys.json.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const stop = (line) => { console.error(line); process.exit(1); };
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--id');
if (!target) stop('Say where to save the private key, outside this folder. For example:\n  node tools/make-update-keys.mjs D:\\keys\\apdesk-release.key');

const file = path.resolve(target);
const parent = path.dirname(file);
if (!fs.existsSync(parent)) stop(`The folder ${parent} does not exist. Make it first, or choose another place.`);
const same = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const real = same(fs.realpathSync(parent)), repo = same(fs.realpathSync(ROOT));
if (real === repo || real.startsWith(repo + path.sep)) stop(`Refused: ${file} is inside the AP Desk folder. A private key must never be kept beside the code, where it could be zipped or committed. Choose a place outside it, for example a USB stick.`);
if (fs.existsSync(file)) stop(`Refused: ${file} already exists. Nothing was overwritten. Choose a new file name.`);

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pad = (n) => String(n).padStart(2, '0'); const d = new Date();
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;   // this PC's own date
const id = opt('--id') || `apdesk-${today}`;
if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) stop('The --id may use letters, digits, dots, dashes and underscores only.');
try { fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 }); }
catch (e) { stop(`The private key could not be saved: ${e.message}. Nothing was written.`); }
const entry = { id, added: today, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };

console.log(`The private key is saved in ${file}

Keep it safe:
- Anyone who has this file can ship updates to every desk. Keep it off the internet: not in e-mail, chat, cloud folders or GitHub.
- Keep a second copy on a USB stick or another offline place. If you lose it, desks cannot get signed updates until you ship a new key by hand.
- Never put it inside the AP Desk folder.

Paste this entry into the "keys" list in app/core/update-keys.json, then commit that file:

${JSON.stringify(entry, null, 1)}

Then build the next release with that file in it. Desks trust this key once they run a version that lists it.`);
