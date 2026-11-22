// AP Desk installer for one Windows user. install.bat runs it with AP Desk's own Node.js copy.
//   node setup/install.mjs                     opens the installer page in the browser (setup/installer-page/);
//                                              the console questions below when no browser can be opened
//   node setup/install.mjs /console            asks its questions here in the console instead
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
// The picker is owned by a small topmost form, so it opens in front of the browser or console that asked for it.
const BROWSE = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Where should AP Desk be installed?'; if ($d.ShowDialog($f) -eq 'OK') { $d.SelectedPath }";
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
// quiet: npm's whole output goes to the install log, and only its error lines come back to be shown.
export function cmdPackages(dir, log) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const repo = fs.existsSync(path.join(dir, 'package.json'));
  const args = [npmCli, repo ? 'install' : 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  return { cmd: process.execPath, args, cwd: repo ? dir : path.join(dir, 'setup'), what: 'install the packages AP Desk needs (needs the internet once)', moveUp: !repo, quiet: true, log };
}
// The Node.js the shortcuts and the start run: AP Desk's own copy in the folder, else the one running this installer.
export const nodeExe = (dir) => { const own = path.join(dir, 'runtime', 'node', 'node.exe'); return fs.existsSync(own) ? own : process.execPath; };
// The cause of the console window that stayed open after an install: "start" runs a .bat file with "cmd /k", so
// the window start.bat ran in stayed at a prompt. The desk is started by the hidden runner (setup\background.mjs) instead.
export const cmdStart = (dir, node = nodeExe(dir)) => ({ cmd: node, args: [path.join(dir, 'setup', 'background.mjs'), 'open'], what: 'start AP Desk', detached: true });

// The shortcuts for an install in dir. folders = { programs, desktop, startup } from cmdFolders.
export function shortcuts(dir, folders, node = path.join(dir, 'runtime', 'node', 'node.exe')) {
  const icon = path.join(dir, 'setup', 'assets', 'apdesk.ico'); const menu = path.join(folders.programs, APP);
  // Node.js runs setup\background.mjs, which hands the start to a hidden copy of itself at once: the window Windows
  // gives the shortcut (style 7, minimised) closes within a moment, and no console window stays behind.
  const bg = `"${path.join(dir, 'setup', 'background.mjs')}"`;
  const start = { target: node, args: `${bg} open`, dir, icon, style: 7, desc: 'Start AP Desk, your desk of AI agents on this PC' };
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
    startup: { ...start, args: `${bg} open nowindow`, desc: 'Start AP Desk when you sign in', lnk: path.join(folders.startup, 'AP Desk.lnk') },
  };
}

// ---- running commands
export function realRunner(c) {
  if (c.detached) { const p = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: true }); p.unref(); return { code: 0, stdout: '' }; }
  if (c.quiet) return quietRun(c);
  const r = spawnSync(c.cmd, c.args, { cwd: c.cwd, env: { ...process.env, ...(c.env || {}) }, encoding: 'utf8', stdio: c.cwd ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { code: r.error ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

// Runs a command without blocking (the installer page keeps answering meanwhile). Every line goes to c.log;
// lines that start with "npm error" or "npm ERR!" come back in errors, so the user sees errors, never warnings.
export function quietRun(c) {
  return new Promise((resolve) => {
    if (c.log) fs.mkdirSync(path.dirname(c.log), { recursive: true });
    const keep = (d) => { if (c.log) try { fs.appendFileSync(c.log, d); } catch {} };
    const errors = []; let rest = '';
    const scan = (d) => { keep(d); const lines = (rest + d).split(/\r?\n/); rest = lines.pop(); for (const l of lines) if (/^npm (error|ERR!)/.test(l) && errors.length < 20) errors.push(l.trim()); };
    let p; try { p = spawn(c.cmd, c.args, { cwd: c.cwd, env: { ...process.env, ...(c.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { resolve({ code: -1, stdout: '', errors: [], stderr: e.message }); return; }
    p.stdout.on('data', scan); p.stderr.on('data', scan);
    p.on('error', (e) => { keep(`Could not start: ${e.message}\n`); resolve({ code: -1, stdout: '', errors, stderr: e.message }); });
    p.on('close', (code) => { if (rest) scan('\n'); resolve({ code: code ?? -1, stdout: '', errors }); });
  });
}

export async function consoleAsk(q) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

const yes = (a, def) => a === '' ? def : /^(y|yes)$/i.test(a);

// The console banner: plain ASCII, so it shows the same in every console font.
export const BANNER = [
  '     _    ____    ____            _    ',
  '    / \\  |  _ \\  |  _ \\  ___  ___| | __',
  '   / _ \\ | |_) | | | | |/ _ \\/ __| |/ /',
  '  / ___ \\|  __/  | |_| |  __/\\__ \\   < ',
  ' /_/   \\_\\_|     |____/ \\___||___/_|\\_\\',
];

// One install. Every outside effect goes through run (commands), say (lines for the user) and ask (questions).
// The installer page passes answers (desktop, apps, autostart, start, anyway) instead of asking, and step, which
// hears each named step as it starts: copy, packages, shortcuts, done.
export async function install({ argv = [], env = process.env, source = HERE, run = realRunner, ask = consoleAsk, say = console.log, isRunning = deskAnswers, answers = null, step = () => {}, banner = true, tick = (t = '.') => { if (process.stdout.isTTY) process.stdout.write(t); } } = {}) {
  const opt = parseArgs(argv); const ver = version(source); const dry = opt.dryRun;
  const exec = async (c) => { if (dry) { say(`  would ${c.what}: ${c.cmd} ${c.args.join(' ')}`); return { code: 0, stdout: '' }; } return await run(c); };
  const q = async (text, def, key) => opt.yes ? def : answers && key in answers ? !!answers[key] : yes(await ask(`${text} ${def ? '[Y/n]' : '[y/N]'} `), def);

  if (opt.autostart) return autostart(opt.autostart === 'on', { dir: source, run, say });

  if (banner) {
    say('');
    for (const l of BANNER) say(l);
    say('');
    say(`  ${APP} ${ver}  (Agent Population Desk)`);
    say('  Your own desk of AI agents. It runs on this PC and answers only on this PC.');
    say('');
    say('  This installs AP Desk for you only. It copies the program into a folder you choose, adds');
    say('  AP Desk to your Start menu (and, if you like, your Desktop and your list of apps), and can');
    say('  start it at the end. It changes nothing for other users and needs no administrator rights.');
    say('');
  }

  // 1. the folder
  const def = defaultFolder(env, source);
  let dir = opt.folder; let check;
  for (;;) {
    if (!dir) {
      const a = await ask(`  Install folder (press Enter for ${def}, B to browse): `);
      if (/^b$/i.test(a)) { const r = await run(cmdBrowse()); dir = (r.stdout || '').trim(); if (!dir) { say('  No folder was picked.'); continue; } say(`  Picked: ${dir}`); }
      else dir = a ? a.replace(/^"|"$/g, '') : def;
    }
    dir = path.resolve(dir);
    check = checkFolder(dir, { env, source });
    if (check.problem) { say('  ' + check.problem); if (opt.folder) return fail('The folder given with --folder cannot be used.', say); dir = null; continue; }
    if (check.warn) { say('  ' + check.warn); if (!(await q('  Install there anyway?', false, 'anyway'))) { if (opt.folder) return fail('Install stopped.', say); dir = null; continue; } }
    break;
  }
  if (check.installed && !same(dir, source)) say('  AP Desk is already in this folder. Only the program files are replaced; data, backups and runtime are not touched.');
  if (check.installed && await isRunning(dir)) return fail('AP Desk is running from this folder. Stop it (Stop AP Desk in the Start menu, or stop.bat), then run install.bat again.', say);

  // 2. the questions, all before anything changes
  const wantDesktop = await q('  Put an AP Desk icon on your Desktop?', true, 'desktop');
  const wantApps = await q('  List AP Desk in Settings > Apps, so you can remove it from there?', true, 'apps');
  const wantAutostart = await q('  Start AP Desk when you sign in to Windows?', false, 'autostart');
  const wantStart = await q('  Start AP Desk when the install is done?', true, 'start');
  say('');

  // From here on every line also goes to data\install.log in the folder, with npm's whole output.
  const log = dry ? null : path.join(dir, 'data', 'install.log');
  const tell = (l) => { say(l); if (log) try { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, String(l) + '\r\n'); } catch {} };
  const failed = (msg) => { const r = fail(msg + (log && fs.existsSync(log) ? ` The install log is ${log}.` : ''), tell); r.log = log; return r; };
  tell(`  ${APP} ${ver} install, ${localStamp()}, into ${dir}`);

  // 3. the program files
  step('copy'); tell('  Copying the program ...');
  const copied = copyProgram(source, dir, { dry, say });
  // 4. the packages
  step('packages');
  if (!packagesOk(dry ? source : dir)) {
    tell('  Getting the packages AP Desk needs. This needs the internet once and takes a minute or two ...');
    const c = cmdPackages(dir, log);
    let dots = 0; const timer = setInterval(() => { dots++; tick(); }, 2000);
    const r = await exec(c); clearInterval(timer); if (dots) tick('\n');
    for (const e of (r.errors || []).slice(0, 8)) tell('  ' + e);
    if (r.code !== 0) return failed('The packages could not be installed. Check your internet connection and run install.bat again.');
    if (c.moveUp && !dry) { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); fs.renameSync(path.join(dir, 'setup', 'node_modules'), path.join(dir, 'node_modules')); }
    tell('  The packages are in place.');
  }
  // 5. shortcuts
  step('shortcuts'); tell('  Making the shortcuts ...');
  const folders = dry ? { programs: path.join('%APPDATA%', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), desktop: path.join('%USERPROFILE%', 'Desktop'), startup: path.join('%APPDATA%', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') } : await askFolders(run);
  if (!folders) return failed('Windows did not say where your Start menu is, so no shortcuts were made. The program is in ' + dir + '; start it with start.bat there.');
  const node = nodeExe(dir);
  const s = shortcuts(dir, folders, node); const problems = [];
  if (!dry) fs.mkdirSync(s.menuFolder, { recursive: true });
  for (const sc of s.menu) if (!(await makeShortcut(sc, exec, dry))) problems.push(sc.lnk);
  if (wantDesktop) { if (!(await makeShortcut(s.desktop, exec, dry))) problems.push(s.desktop.lnk); } else removeFile(s.desktop.lnk, dry, say);
  if (wantAutostart) { if (!(await makeShortcut(s.startup, exec, dry))) problems.push(s.startup.lnk); } else removeFile(s.startup.lnk, dry, say);
  for (const p of problems) tell(`  Could not make the shortcut ${p}.`);
  // 6. the list of apps
  if (wantApps) { for (const c of cmdAppsEntry(dir, ver)) if ((await exec(c)).code !== 0) { problems.push('apps'); tell('  Could not add AP Desk to your list of apps. Remove it later with uninstall.bat in its folder.'); await exec(cmdAppsRemove()); break; } }
  else await exec(cmdAppsRemove());

  step('done');
  tell('');
  tell(dry ? '  Dry run: nothing was copied, made or started.' : problems.length ? '  AP Desk is installed, but some steps did not work (see above). Run install.bat again to retry them.' : '  AP Desk is installed.');
  say(`  Folder: ${dir}`);
  if (!copied.length && same(dir, source)) say('  (The program was already in that folder; nothing was copied.)');
  say('  Start it from the Start menu: AP Desk. It runs in the background; closing its window does not stop it.');
  say('  Stop it with Stop AP Desk. AP Desk log shows what it is doing.');
  if (wantStart) { tell('  Starting AP Desk. It opens in its own window in a moment.'); await exec(cmdStart(dir, node)); }
  return { ok: true, dir, copied, problems, folders, log, started: wantStart && !dry };
}

export const defaultFolder = (env = process.env, source = HERE) => env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', APP) : path.join(source, '..', APP);
const localStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };   // this PC's own time

function fail(msg, say) { say(''); say('  ' + msg); return { ok: false, message: msg }; }

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--folder') o.folder = argv[++i];
    else if (a === '--yes') o.yes = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--autostart') o.autostart = String(argv[++i] || '').toLowerCase();
    else if (/^(\/|--)console$/i.test(a)) o.console = true;
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

export const userFolders = (run) => foldersFrom(run(cmdFolders()));
// install() and autostart() wait for the answer, so a runner that does not block (the installer page's) works too
const askFolders = async (run) => foldersFrom(await run(cmdFolders()));
function foldersFrom(r) {
  const [programs, desktop, startup] = String(r.stdout || '').split(/\r?\n/).map(s => s.trim());
  return r.code === 0 && programs && desktop && startup ? { programs, desktop, startup, windows: process.env.SystemRoot || 'C:\\Windows' } : null;
}

// A shortcut is made whole or not at all: when Windows reports a failure, a file it may have left is removed.
async function makeShortcut(sc, exec, dry) {
  if (!dry) fs.mkdirSync(path.dirname(sc.lnk), { recursive: true });
  const r = await exec(cmdShortcut(sc));
  if (dry) return true;
  if (r.code === 0 && fs.existsSync(sc.lnk)) return true;
  try { fs.rmSync(sc.lnk, { force: true }); } catch {}
  return false;
}
function removeFile(f, dry, say) { if (!fs.existsSync(f)) return; if (dry) say(`  would remove ${f}`); else fs.rmSync(f, { force: true }); }

// setup\autostart.bat on|off
export async function autostart(on, { dir = HERE, run = realRunner, say = console.log } = {}) {
  const folders = await askFolders(run); if (!folders) { say('Windows did not say where your Startup folder is. Nothing was changed.'); return { ok: false }; }
  const sc = shortcuts(dir, folders, nodeExe(dir)).startup;
  if (!on) { fs.rmSync(sc.lnk, { force: true }); say('AP Desk will no longer start when you sign in to Windows.'); return { ok: true }; }
  if (!(await makeShortcut(sc, run, false))) { say('Could not make the Startup shortcut. Nothing was changed.'); return { ok: false }; }
  say('AP Desk will start when you sign in to Windows. Switch it off with: setup\\autostart.bat off'); return { ok: true };
}

// Does the desk answer from this folder's port? (data\port.txt, else the default port)
export async function deskAnswers(dir) {
  let port = DEFAULT_PORT; try { port = Number(fs.readFileSync(path.join(dir, 'data', 'port.txt'), 'utf8').trim()) || port; } catch {}
  try { const r = await fetch(`http://127.0.0.1:${port}/api/panic`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

// The installer page, unless the console was asked for or answers came with the command. When no browser can be
// opened, the same questions are asked here in the console.
export async function main(argv, { page = null, ...deps } = {}) {
  const o = parseArgs(argv);
  if (!o.console && !o.folder && !o.yes && !o.dryRun && !o.autostart) {
    const pageInstall = page || (await import('./installer-page/server.mjs')).pageInstall;
    const r = await pageInstall(deps);
    if (r) return r;
    (deps.say || console.log)('  The installer page could not be opened in a browser, so the questions are asked here.');
  }
  const r = await install({ argv, ...deps });
  if (r && r.ok && !o.autostart && !o.yes && !deps.ask) await consoleAsk('\n  Press Enter to close this window. ');
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await main(process.argv.slice(2));
  process.exit(r && r.ok ? 0 : 1);
}
