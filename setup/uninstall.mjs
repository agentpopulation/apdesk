// AP Desk uninstaller for one Windows user. uninstall.bat stops the desk, runs this, and then removes what Node.js
// itself cannot while it runs: runtime\ and uninstall.bat.
// It removes this user's shortcuts and Apps entry, then the program files named in setup\installed.txt (only
// names inside this folder). data\ and backups\ go only when the user answers Yes and then types DELETE.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { shortcuts, userFolders, cmdAppsRemove, realRunner, consoleAsk } from './install.mjs';
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// what an AP Desk folder can hold when setup\installed.txt is missing (a folder that was unpacked, not installed)
const KNOWN = ['app', 'modules', 'vendor', 'node_modules', 'setup', 'start.bat', 'stop.bat', 'install.bat', 'start.sh', 'start.command', 'README.md', 'LICENSE', 'NOTICE', 'ATTRIBUTION.md', 'CHANGELOG.md', 'package.json', 'package-lock.json'];
const LAST = new Set(['runtime', 'uninstall.bat', 'data', 'backups']);   // removed by uninstall.bat, or only on DELETE

export function programList(dir) {
  let names = KNOWN;
  try { names = fs.readFileSync(path.join(dir, 'setup', 'installed.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean); } catch {}
  // a name is one entry directly in this folder: nothing with a slash, nothing that climbs out
  return names.filter(n => !/[\\/:]/.test(n) && n !== '.' && n !== '..' && !LAST.has(n));
}

export async function uninstall({ dir = HERE, run = realRunner, ask = consoleAsk, say = console.log } = {}) {
  if (!fs.existsSync(path.join(dir, 'app', 'server.js'))) { say('This folder does not look like AP Desk (there is no app\\server.js). Nothing was removed.'); return { ok: false }; }
  say(''); say(`  Removing AP Desk from ${dir}`); say('');
  // 1. shortcuts and the Apps entry
  const folders = userFolders(run);
  if (folders) {
    const s = shortcuts(dir, folders);
    for (const sc of [...s.menu, s.desktop, s.startup]) fs.rmSync(sc.lnk, { force: true });
    try { fs.rmdirSync(s.menuFolder); } catch {}                     // only when it is empty
    say('  Removed the shortcuts.');
  } else say('  Windows did not say where your Start menu is. Remove any AP Desk shortcuts yourself.');
  run(cmdAppsRemove()); say('  Removed AP Desk from your list of apps.');
  // 2. data
  const a = await ask('  Delete your data too? This removes your chats, files, settings and backups. [y/N] ');
  let delData = false;
  if (/^(y|yes)$/i.test(a)) {
    delData = (await ask('  Type DELETE to delete your data, or press Enter to keep it: ')) === 'DELETE';
    if (!delData) say('  Your data is kept.');
  }
  // 3. program files (runtime\ and uninstall.bat are removed by uninstall.bat once this Node.js has stopped)
  const removed = [];
  for (const n of [...programList(dir), ...(delData ? ['data', 'backups'] : [])]) {
    const p = path.join(dir, n);
    if (!fs.existsSync(p)) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); removed.push(n); } catch { say(`  Could not remove ${p}. Remove it yourself.`); }
  }
  say(delData ? '  Removed the program and your data.' : `  Removed the program. Your data is kept in ${path.join(dir, 'data')} and your backups in ${path.join(dir, 'backups')}.`);
  return { ok: true, removed, delData };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await uninstall();
  process.exit(r.ok ? 0 : 1);
}
