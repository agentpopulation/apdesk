// AP Desk installer for one Windows user. install.bat runs it with AP Desk's own Node.js copy.
//   node setup/install.mjs                     asks where to install, copies, makes shortcuts, lists the app
//   node setup/install.mjs --folder "D:\Apps\AP Desk"   answers the folder question
//   node setup/install.mjs --yes               takes the default answer to every other question
//   node setup/install.mjs --dry-run           says what it would do, and changes nothing
//   node setup/install.mjs --autostart on|off  only adds or removes the "start when you sign in" shortcut
// Everything it does is allowed to a standard user: files in a folder this user can write to, shortcuts in this
// user's own Start menu, Desktop and Startup folders, and an entry in this user's own list of apps (HKCU).
// The commands it runs are listed in plan() and the tests check them with a fake runner.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { spawnSync, spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { DEFAULT_PORT } from './check.mjs';

export const APP = 'AP Desk';
export const PUBLISHER = 'AgentPopulation';
export const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\APDesk';
export const KEEP = ['data', 'backups', 'runtime'];              // never replaced or removed by the installer
const NOT_COPIED = new Set([...KEEP, '.git', '.github', 'dist', 'INTERNAL']);
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The program's top-level files and folders in a download: everything except data, backups, runtime and dot files.
export function programEntries(src) {
  return fs.readdirSync(src).filter(n => !NOT_COPIED.has(n) && !n.startsWith('.')).sort();
}

export function version(src) {
  for (const f of ['app/version.json', 'setup/package.json', 'package.json']) { try { const v = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8')).version; if (v) return v; } catch {} }
  return '';
}

const inside = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Is this a good folder to install into? { problem } stops; { warn } asks first; { installed } means it already holds AP Desk.
export function checkFolder(folder, { env = process.env, source = HERE } = {}) {
  if (!folder || !path.isAbsolute(folder)) return { problem: 'Type the whole folder, starting with the drive, for example C:\\Users\\you\\AP Desk.' };
  if (/[&^%!();"<>|]/.test(folder)) return { problem: 'Pick a folder whose name has none of these characters: & ^ % ! ( ) ;' };
  if (inside(folder, source)) return { problem: 'Pick a folder outside the one you unpacked AP Desk into.' };
  try {
    fs.mkdirSync(folder, { recursive: true });
    const probe = path.join(folder, '.apdesk-write-test');
    fs.writeFileSync(probe, 'test'); fs.rmSync(probe);
  } catch { return { problem: 'You cannot write to this folder. Pick a folder inside your own user folder.' }; }
  const installed = fs.existsSync(path.join(folder, 'app', 'server.js'));
  if (!installed && !same(folder, source) && fs.readdirSync(folder).length) return { problem: 'This folder already has other files in it. Pick an empty folder or a new one, so that removing AP Desk later never touches your own files.' };
  const sync = ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'].map(k => env[k]).filter(Boolean).find(d => same(folder, d) || inside(folder, d));
  return { installed, warn: sync ? 'This folder is inside OneDrive. A folder that syncs can damage the desk\'s database while the desk is using it.' : null };
}

// ---- commands. Each is { cmd, args, env?, what } so a fake runner can check them and a dry run can print them.
const ps = (script, env, what) => ({ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], env, what });
export const cmdFolders = () => ps("[Environment]::GetFolderPath('Programs'); [Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Startup')", null, 'find your Start menu, Desktop and Startup folders');
const BROWSE = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Where should AP Desk be installed?'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";
export const cmdBrowse = () => ({ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', BROWSE], what: 'show the folder picker' });
// The values travel in environment variables, so no folder name is ever pasted into the command itself.
export const cmdShortcut = (s) => ps('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:APD_LNK); $s.TargetPath = $env:APD_TARGET; $s.Arguments = $env:APD_ARGS; $s.WorkingDirectory = $env:APD_DIR; $s.IconLocation = $env:APD_ICON; $s.Description = $env:APD_DESC; $s.WindowStyle = [int]$env:APD_STYLE; $s.Save()',
  { APD_LNK: s.lnk, APD_TARGET: s.target, APD_ARGS: s.args || '', APD_DIR: s.dir, APD_ICON: s.icon + ',0', APD_DESC: s.desc, APD_STYLE: String(s.style) }, `make the shortcut ${s.lnk}`);
const reg = (name, type, data) => ({ cmd: 'reg.exe', args: ['add', REG_KEY, '/v', name, '/t', type, '/d', data, '/f'], what: `write ${name} in your list of apps` });
export const cmdAppsEntry = (dir, ver) => [
  reg('DisplayName', 'REG_SZ', APP), reg('DisplayVersion', 'REG_SZ', ver || '0'), reg('Publisher', 'REG_SZ', PUBLISHER),
  reg('InstallLocation', 'REG_SZ', dir), reg('DisplayIcon', 'REG_SZ', path.join(dir, 'setup', 'assets', 'apdesk.ico')),
  reg('UninstallString', 'REG_SZ', `"${path.join(dir, 'uninstall.bat')}"`), reg('NoModify', 'REG_DWORD', '1'), reg('NoRepair', 'REG_DWORD', '1'),
];
export const cmdAppsRemove = () => ({ cmd: 'reg.exe', args: ['delete', REG_KEY, '/f'], what: 'remove AP Desk from your list of apps', mayFail: true });
export function cmdPackages(dir) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const repo = fs.existsSync(path.join(dir, 'package.json'));
  const args = [npmCli, repo ? 'install' : 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  return { cmd: process.execPath, args, cwd: repo ? dir : path.join(dir, 'setup'), what: 'install the packages AP Desk needs (needs the internet once)', moveUp: !repo };
}
export const cmdStart = (dir) => ({ cmd: 'cmd.exe', args: ['/d', '/c', 'start', '', '/min', path.join(dir, 'start.bat'), 'background'], what: 'start AP Desk', detached: true });

// The shortcuts for an install in dir. folders = { programs, desktop, startup } from cmdFolders.
export function shortcuts(dir, folders) {
  const icon = path.join(dir, 'setup', 'assets', 'apdesk.ico'); const menu = path.join(folders.programs, APP);
  // "background": start.bat starts the desk with no window of its own (setup\background.mjs) and closes its own
  // minimised window once the desk is open. Style 7 starts that short-lived window minimised.
  const start = { target: path.join(dir, 'start.bat'), args: 'background', dir, icon, style: 7, desc: 'Start AP Desk, your desk of AI agents on this PC' };
  const notepad = path.join(folders.windows || 'C:\\Windows', 'System32', 'notepad.exe');
  return {
    menu: [
      { ...start, lnk: path.join(menu, 'AP Desk.lnk') },
      { target: path.join(dir, 'stop.bat'), dir, icon, style: 1, desc: 'Stop AP Desk', lnk: path.join(menu, 'Stop AP Desk.lnk') },
      { target: notepad, args: `"${path.join(dir, 'data', 'desk.log')}"`, dir, icon, style: 1, desc: 'What AP Desk is doing, and what went wrong', lnk: path.join(menu, 'AP Desk log.lnk') },
      { target: path.join(dir, 'uninstall.bat'), dir, icon, style: 1, desc: 'Remove AP Desk from this PC', lnk: path.join(menu, 'Uninstall AP Desk.lnk') },
    ],
    menuFolder: menu,
    desktop: { ...start, lnk: path.join(folders.desktop, 'AP Desk.lnk') },
    // starts with Windows: in the background, without opening the desk's window
    startup: { ...start, args: 'background nowindow', desc: 'Start AP Desk when you sign in', lnk: path.join(folders.startup, 'AP Desk.lnk') },
  };
}

// ---- running commands
export function realRunner(c) {
  if (c.detached) { const p = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: false }); p.unref(); return { code: 0, stdout: '' }; }
  const r = spawnSync(c.cmd, c.args, { cwd: c.cwd, env: { ...process.env, ...(c.env || {}) }, encoding: 'utf8', stdio: c.cwd ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { code: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

export async function consoleAsk(q) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

const yes = (a, def) => a === '' ? def : /^(y|yes)$/i.test(a);

// One install. Every outside effect goes through run (commands), say (lines for the user) and ask (questions).
export async function install({ argv = [], env = process.env, source = HERE, run = realRunner, ask = consoleAsk, say = console.log, isRunning = deskAnswers } = {}) {
  const opt = parseArgs(argv); const ver = version(source); const dry = opt.dryRun;
  const exec = (c) => { if (dry) { say(`  would ${c.what}: ${c.cmd} ${c.args.join(' ')}`); return { code: 0, stdout: '' }; } return run(c); };
  const q = async (text, def) => opt.yes ? def : yes(await ask(`${text} ${def ? '[Y/n]' : '[y/N]'} `), def);

  if (opt.autostart) return autostart(opt.autostart === 'on', { dir: source, run, say });

  say('');
  say(`  ${APP} ${ver}  (Agent Population Desk)`);
  say('  Your own desk of AI agents. It runs on this PC and answers only on this PC.');
  say('');
  say('  This installs AP Desk for you only. It copies the program into a folder you choose, adds');
  say('  AP Desk to your Start menu (and, if you like, your Desktop and your list of apps), and can');
  say('  start it at the end. It changes nothing for other users and needs no administrator rights.');
  say('');

  // 1. the folder
  const def = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', APP) : path.join(source, '..', APP);
  let dir = opt.folder; let check;
  for (;;) {
    if (!dir) {
      const a = await ask(`  Install folder (press Enter for ${def}, B to browse): `);
      if (/^b$/i.test(a)) { const r = run(cmdBrowse()); dir = (r.stdout || '').trim(); if (!dir) { say('  No folder was picked.'); continue; } say(`  Picked: ${dir}`); }
      else dir = a ? a.replace(/^"|"$/g, '') : def;
    }
    dir = path.resolve(dir);
    check = checkFolder(dir, { env, source });
    if (check.problem) { say('  ' + check.problem); if (opt.folder) return fail('The folder given with --folder cannot be used.', say); dir = null; continue; }
    if (check.warn) { say('  ' + check.warn); if (!(await q('  Install there anyway?', false))) { if (opt.folder) return fail('Install stopped.', say); dir = null; continue; } }
    break;
  }
  if (check.installed && !same(dir, source)) say('  AP Desk is already in this folder. Only the program files are replaced; data, backups and runtime are not touched.');
  if (check.installed && await isRunning(dir)) return fail('AP Desk is running from this folder. Stop it (Stop AP Desk in the Start menu, or stop.bat), then run install.bat again.', say);

  // 2. the questions, all before anything changes
  const wantDesktop = await q('  Put an AP Desk icon on your Desktop?', true);
  const wantApps = await q('  List AP Desk in Settings > Apps, so you can remove it from there?', true);
  const wantAutostart = await q('  Start AP Desk when you sign in to Windows?', false);
  const wantStart = await q('  Start AP Desk when the install is done?', true);
  say('');

  // 3. the program files
  const copied = copyProgram(source, dir, { dry, say });
  // 4. the packages
  if (!packagesOk(dry ? source : dir)) {
    say('  Installing the packages AP Desk needs. This needs the internet once and takes a minute or two ...');
    const c = cmdPackages(dir); const r = exec(c);
    if (r.code !== 0) return fail('The packages could not be installed. Check your internet connection and run install.bat again.', say);
    if (c.moveUp && !dry) { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); fs.renameSync(path.join(dir, 'setup', 'node_modules'), path.join(dir, 'node_modules')); }
  }
  // 5. shortcuts
  const folders = dry ? { programs: path.join('%APPDATA%', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), desktop: path.join('%USERPROFILE%', 'Desktop'), startup: path.join('%APPDATA%', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') } : userFolders(run);
  if (!folders) return fail('Windows did not say where your Start menu is, so no shortcuts were made. The program is in ' + dir + '; start it with start.bat there.', say);
  const s = shortcuts(dir, folders); const problems = [];
  if (!dry) fs.mkdirSync(s.menuFolder, { recursive: true });
  for (const sc of s.menu) if (!makeShortcut(sc, exec, dry)) problems.push(sc.lnk);
  if (wantDesktop) { if (!makeShortcut(s.desktop, exec, dry)) problems.push(s.desktop.lnk); } else removeFile(s.desktop.lnk, dry, say);
  if (wantAutostart) { if (!makeShortcut(s.startup, exec, dry)) problems.push(s.startup.lnk); } else removeFile(s.startup.lnk, dry, say);
  for (const p of problems) say(`  Could not make the shortcut ${p}.`);
  // 6. the list of apps
  if (wantApps) { for (const c of cmdAppsEntry(dir, ver)) if (exec(c).code !== 0) { problems.push('apps'); say('  Could not add AP Desk to your list of apps. Remove it later with uninstall.bat in its folder.'); exec(cmdAppsRemove()); break; } }
  else exec(cmdAppsRemove());

  say('');
  say(dry ? '  Dry run: nothing was copied, made or started.' : problems.length ? '  AP Desk is installed, but some steps did not work (see above). Run install.bat again to retry them.' : '  AP Desk is installed.');
  say(`  Folder: ${dir}`);
  if (!copied.length && same(dir, source)) say('  (The program was already in that folder; nothing was copied.)');
  say('  Start it from the Start menu: AP Desk. It runs in the background; closing its window does not stop it.');
  say('  Stop it with Stop AP Desk. AP Desk log shows what it is doing.');
  if (wantStart) { say('  Starting AP Desk ...'); exec(cmdStart(dir)); }
  return { ok: true, dir, copied, problems, folders };
}

function fail(msg, say) { say(''); say('  ' + msg); return { ok: false, message: msg }; }

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--folder') o.folder = argv[++i];
    else if (a === '--yes') o.yes = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--autostart') o.autostart = String(argv[++i] || '').toLowerCase();
  }
  return o;
}

// Copies the program into dir (unless it is already there). data, backups and runtime in dir are never touched; a
// runtime\node that dir does not have yet is copied from the download, so it needs no second download.
// The names copied are kept in setup\installed.txt: the uninstaller removes those and nothing else.
export function copyProgram(source, dir, { dry = false, say = () => {} } = {}) {
  const names = programEntries(source);
  if (same(source, dir)) { if (!dry) writeList(dir, names); return []; }
  for (const n of names) {
    if (dry) { say(`  would copy ${n}`); continue; }
    fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    fs.cpSync(path.join(source, n), path.join(dir, n), { recursive: true, verbatimSymlinks: true });
  }
  if (fs.existsSync(path.join(source, 'runtime', 'node', 'node.exe')) && !fs.existsSync(path.join(dir, 'runtime', 'node'))) {
    if (dry) say('  would copy runtime\\node'); else fs.cpSync(path.join(source, 'runtime', 'node'), path.join(dir, 'runtime', 'node'), { recursive: true });
  }
  if (!dry) writeList(dir, names);
  return names;
}
const writeList = (dir, names) => { fs.mkdirSync(path.join(dir, 'setup'), { recursive: true }); fs.writeFileSync(path.join(dir, 'setup', 'installed.txt'), [...new Set([...names, 'node_modules'])].join('\r\n') + '\r\n'); };

function packagesOk(dir) {
  const f = [path.join(dir, 'package.json'), path.join(dir, 'setup', 'package.json')].find(x => fs.existsSync(x));
  try { return Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).dependencies || {}).every(n => fs.existsSync(path.join(dir, 'node_modules', n, 'package.json'))); } catch { return false; }
}

export function userFolders(run) {
  const r = run(cmdFolders()); const [programs, desktop, startup] = String(r.stdout || '').split(/\r?\n/).map(s => s.trim());
  return r.code === 0 && programs && desktop && startup ? { programs, desktop, startup, windows: process.env.SystemRoot || 'C:\\Windows' } : null;
}

// A shortcut is made whole or not at all: when Windows reports a failure, a file it may have left is removed.
function makeShortcut(sc, exec, dry) {
  if (!dry) fs.mkdirSync(path.dirname(sc.lnk), { recursive: true });
  const r = exec(cmdShortcut(sc));
  if (dry) return true;
  if (r.code === 0 && fs.existsSync(sc.lnk)) return true;
  try { fs.rmSync(sc.lnk, { force: true }); } catch {}
  return false;
}
function removeFile(f, dry, say) { if (!fs.existsSync(f)) return; if (dry) say(`  would remove ${f}`); else fs.rmSync(f, { force: true }); }

// setup\autostart.bat on|off
export async function autostart(on, { dir = HERE, run = realRunner, say = console.log } = {}) {
  const folders = userFolders(run); if (!folders) { say('Windows did not say where your Startup folder is. Nothing was changed.'); return { ok: false }; }
  const sc = shortcuts(dir, folders).startup;
  if (!on) { fs.rmSync(sc.lnk, { force: true }); say('AP Desk will no longer start when you sign in to Windows.'); return { ok: true }; }
  if (!makeShortcut(sc, run, false)) { say('Could not make the Startup shortcut. Nothing was changed.'); return { ok: false }; }
  say('AP Desk will start when you sign in to Windows. Switch it off with: setup\\autostart.bat off'); return { ok: true };
}

// Does the desk answer from this folder's port? (data\port.txt, else the default port)
export async function deskAnswers(dir) {
  let port = DEFAULT_PORT; try { port = Number(fs.readFileSync(path.join(dir, 'data', 'port.txt'), 'utf8').trim()) || port; } catch {}
  try { const r = await fetch(`http://127.0.0.1:${port}/api/panic`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await install({ argv: process.argv.slice(2) });
  if (r && r.ok && !process.argv.includes('--autostart') && !process.argv.includes('--yes')) await consoleAsk('\n  Press Enter to close this window. ');
  process.exit(r && r.ok ? 0 : 1);
}
