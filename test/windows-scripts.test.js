// The Windows start files must work when the repository is downloaded as a ZIP: Windows line endings,
// every block closed, and every label that is called or jumped to present in the same file.
// The installer, the uninstaller, the port choice and the background log are tested here on Linux with a fake
// Windows environment and a fake command runner: no command in these tests reaches Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { choosePort, DEFAULT_PORT, SPARE_PORTS } from '../setup/check.mjs';
import { install, checkFolder, programEntries, shortcuts, autostart, REG_KEY, KEEP, quietRun, main, BANNER } from '../setup/install.mjs';
import { uninstall, programList } from '../setup/uninstall.mjs';
import { rollingLog, launch } from '../setup/background.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BATS = [...fs.readdirSync(ROOT).filter(f => /\.(bat|cmd)$/i.test(f)), ...fs.readdirSync(path.join(ROOT, 'setup')).filter(f => /\.(bat|cmd)$/i.test(f)).map(f => 'setup/' + f)];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'latin1');
const codeLines = (raw) => raw.split('\r\n').map(l => l.trim()).filter(l => l && !/^(rem\b|::)/i.test(l));

test('Windows scripts: CRLF line endings, closed blocks, and every called label exists', () => {
  for (const f of ['start.bat', 'stop.bat', 'install.bat', 'uninstall.bat', 'setup/setup.bat', 'setup/open.bat', 'setup/reinstall.bat', 'setup/get-node.bat', 'setup/autostart.bat']) assert.ok(BATS.includes(f), `${f} is checked`);
  for (const rel of BATS) {
    const raw = read(rel);
    assert.equal(/[^\r]\n/.test(raw) || raw.startsWith('\n'), false, `${rel}: every line ends with CRLF`);
    assert.ok(raw.endsWith('\r\n'), `${rel}: the last line ends with CRLF`);
    assert.equal(/[^\x09\x0a\x0d\x20-\x7e]/.test(raw), false, `${rel}: plain ASCII only`);
    const lines = codeLines(raw);
    // blocks: a line that ends with "(" opens one; a line that starts with ")" closes one ("    ) else (" does both)
    let depth = 0;
    for (const l of lines) {
      if (l.startsWith(')')) depth--;
      assert.ok(depth >= 0, `${rel}: a ")" closes a block that was never opened, at "${l}"`);
      // inside a block, a folder name with ")" in it (a second download unpacks to "apdesk-main (1)") ends the
      // block early unless it is in quotes
      if (depth > 0) { const bare = l.replace(/"[^"]*"/g, '""'); assert.equal(/%~[a-z]*\d|%cd%/i.test(bare), false, `${rel}: a folder outside quotes inside a block, at "${l}"`); }
      if (l.endsWith('(')) depth++;
    }
    assert.equal(depth, 0, `${rel}: ${depth} block(s) opened with "(" are never closed`);
    const labels = new Set(lines.filter(l => /^:[A-Za-z_]/.test(l)).map(l => l.slice(1).split(/\s/)[0].toLowerCase()));
    for (const l of lines) for (const m of l.matchAll(/\b(?:goto|call)\s+:([A-Za-z_][\w-]*)/gi)) {
      if (m[1].toLowerCase() === 'eof') continue;
      assert.ok(labels.has(m[1].toLowerCase()), `${rel}: "${m[0]}" has no ":${m[1]}" label in the file`);
    }
    // every file a script calls or runs exists (apply-update.mjs is written elsewhere and is always guarded)
    const base = path.dirname(path.join(ROOT, rel));
    for (const m of raw.matchAll(/"%~dp0([^"%]+\.(?:bat|mjs|js))"/gi)) {
      const target = path.join(base, m[1].replace(/\\/g, '/'));
      if (/apply-update\.mjs$/.test(m[1])) { assert.ok(raw.includes(`if exist "%~dp0${m[1]}"`), `${rel}: apply-update.mjs is run only when it exists`); continue; }
      assert.ok(fs.existsSync(target), `${rel}: "${m[1]}" does not exist`);
    }
    // a script that runs node puts AP Desk's own Node.js copy first
    if (/^node\b|\bnode "/m.test(raw.split('\r\n').filter(l => !/^\s*rem\b/i.test(l)).join('\n'))) assert.match(raw, /set "PATH=%~dp0(\.\.\\)?runtime\\node;%PATH%/, `${rel}: runtime\\node comes first in PATH`);
  }
});

test('Unix start files keep Unix line endings', () => {
  for (const rel of ['start.sh', 'start.command']) assert.equal(fs.readFileSync(path.join(ROOT, rel), 'latin1').includes('\r'), false, `${rel}: no CR`);
});

test('start files: the port comes from check.mjs, the update runs only when present, and 75 restarts', () => {
  const bat = read('start.bat'); const sh = read('start.sh');
  assert.match(bat, /for \/f %%p in \('node "%~dp0setup\\check\.mjs" port'\) do set "APD_PORT=%%p"/);
  assert.match(sh, /PORT="\$\(node setup\/check\.mjs port\)" \|\| exit 1/);
  assert.match(sh, /\[ -f setup\/apply-update\.mjs \] && node (--no-warnings )?setup\/apply-update\.mjs/);
  assert.match(bat, /if "%RC%"=="75" goto :run/); assert.match(sh, /\[ "\$code" = 75 \]/);
  for (const rel of ['start.bat', 'stop.bat', 'setup/open.bat', 'start.sh', 'setup/check.mjs', 'setup/install.mjs', 'setup/assets/starting.html', 'install.bat', 'uninstall.bat']) assert.equal(read(rel).includes('3960'), false, `${rel}: the old port is gone`);
  assert.match(read('setup/assets/starting.html'), new RegExp(`\\|\\| ${DEFAULT_PORT};`), 'the start page has the same default port as check.mjs');
});

test('Node.js copy: one pinned Node 22 version, both checksums, and an ARM64 check that sees through emulation', () => {
  const g = read('setup/get-node.bat');
  const ver = /set "VER=(22)\.(\d+)\.(\d+)"/.exec(g); assert.ok(ver && Number(ver[2]) >= 13, 'Node 22.13 or newer');
  assert.match(g, /set "SUM_X64=[0-9a-f]{64}"/); assert.match(g, /set "SUM_ARM64=[0-9a-f]{64}"/);
  assert.match(g, /curl -fL .*"https:\/\/nodejs\.org\/dist\/v%VER%\/%NAME%\.zip"/);
  assert.match(g, /certutil -hashfile "%ZIP%" SHA256 \| findstr \/i "%SUM%"/);
  const sumAt = g.indexOf('certutil'); const tarAt = g.indexOf('tar -xf'); assert.ok(sumAt > 0 && tarAt > sumAt, 'the checksum is checked before unpacking');
  for (const v of ['PROCESSOR_ARCHITECTURE%"=="ARM64"', 'PROCESSOR_ARCHITEW6432%"=="ARM64"', 'PROCESSOR_IDENTIFIER:~0,3%"=="ARM"']) assert.ok(g.includes(v), v);
  for (const bad of [/winget/i, /powershell/i, /bypass/i, /\|\s*(cmd|node|powershell|sh)\b/i]) assert.equal(bad.test(g.replace(/^rem.*$/gim, '')), false, `${bad} is not used`);
});

test('no script turns off or works around a Windows safety feature', () => {
  const files = [...BATS, 'setup/install.mjs', 'setup/uninstall.mjs', 'setup/background.mjs'];
  for (const rel of files) {
    const t = read(rel);
    for (const bad of [/ExecutionPolicy/i, /\bbypass\b/i, /runas/i, /Unblock-File/i, /Zone\.Identifier/i, /\bHKLM\b/i, /Set-MpPreference|netsh|EnableLUA|SmartScreen/i, /\.vbs\b|wscript\.exe|cscript/i, /iex\b|Invoke-Expression|DownloadString/i]) assert.equal(bad.test(t), false, `${rel}: ${bad}`);
  }
});

// ---- the installer, with a fake Windows
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apd-win-'));
function fakeDownload({ zip = false } = {}) {
  const src = tmp(); const w = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), text); };
  w('app/server.js', '// desk'); w('app/version.json', JSON.stringify({ version: '9.8.7' })); w('modules/chat/module.json', '{}'); w('start.bat'); w('stop.bat'); w('install.bat'); w('uninstall.bat'); w('README.md');
  w('setup/check.mjs'); w('setup/assets/apdesk.ico'); w('.git/HEAD'); w('data/desk.sqlite', 'theirs'); w('backups/old.zip');
  if (zip) w('setup/package.json', JSON.stringify({ dependencies: { marked: '1' } }));
  else { w('package.json', JSON.stringify({ version: '9.8.7', dependencies: { marked: '1' } })); w('node_modules/marked/package.json', '{}'); }
  return src;
}
function fakeWindows() {
  const home = tmp(); const env = { LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'), USERPROFILE: home, OneDrive: path.join(home, 'OneDrive') };
  const folders = { programs: path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), desktop: path.join(home, 'Desktop'), startup: path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), windows: 'C:\\Windows' };
  const ran = []; const fail = new Set();
  // the fake runner answers like Windows: the folder lookup prints three folders, a shortcut command writes the .lnk
  const run = (c) => {
    ran.push(c);
    if (c.cmd === 'powershell.exe' && c.args.at(-1).includes('GetFolderPath')) return { code: 0, stdout: `${folders.programs}\r\n${folders.desktop}\r\n${folders.startup}\r\n` };
    if (c.cwd && c.args.includes('--omit=dev')) { fs.mkdirSync(path.join(c.cwd, 'node_modules', 'marked'), { recursive: true }); fs.writeFileSync(path.join(c.cwd, 'node_modules', 'marked', 'package.json'), '{}'); return { code: 0, stdout: '' }; }
    if (c.env?.APD_LNK) { fs.writeFileSync(c.env.APD_LNK, 'lnk'); return { code: fail.has(path.basename(c.env.APD_LNK)) ? 1 : 0, stdout: '' }; }
    return { code: 0, stdout: '' };
  };
  return { home, env, folders, ran, run, fail };
}
const quiet = () => { const lines = []; const say = (l) => lines.push(l); say.lines = lines; return say; };
const answers = (...a) => async () => a.length ? a.shift() : '';

test('install: folder checks (whole path, characters, writable, other files, inside the download, OneDrive)', () => {
  const src = fakeDownload(); const { env, home } = fakeWindows();
  assert.match(checkFolder('relative\\folder', { env, source: src }).problem, /whole folder/);
  assert.match(checkFolder(path.join(home, 'A & B'), { env, source: src }).problem, /none of these characters/);
  fs.writeFileSync(path.join(home, 'afile'), 'x');
  assert.equal(checkFolder(path.join(home, 'afile', 'AP Desk'), { env, source: src }).problem, 'You cannot write to this folder. Pick a folder inside your own user folder.');
  fs.mkdirSync(path.join(home, 'Docs')); fs.writeFileSync(path.join(home, 'Docs', 'mine.txt'), 'mine');
  assert.match(checkFolder(path.join(home, 'Docs'), { env, source: src }).problem, /other files/);
  assert.match(checkFolder(path.join(src, 'sub'), { env, source: src }).problem, /outside the one you unpacked/);
  const ok = checkFolder(path.join(home, 'Apps', 'AP Desk'), { env, source: src });
  assert.equal(ok.problem, undefined); assert.equal(ok.warn, null); assert.equal(ok.installed, false);
  assert.equal(fs.readdirSync(path.join(home, 'Apps', 'AP Desk')).length, 0, 'the write test leaves nothing behind');
  assert.match(checkFolder(path.join(env.OneDrive, 'AP Desk'), { env, source: src }).warn, /inside OneDrive/);
});

test('install: copies the program, makes the shortcuts and the Apps entry, starts the desk', async () => {
  const src = fakeDownload(); const w = fakeWindows(); const say = quiet(); const dir = path.join(w.env.LOCALAPPDATA, 'Programs', 'AP Desk');
  const r = await install({ argv: [], env: w.env, source: src, run: w.run, ask: answers('', '', '', '', ''), say, isRunning: async () => false });
  assert.equal(r.ok, true); assert.equal(r.dir, dir, 'Enter takes %LOCALAPPDATA%\\Programs\\AP Desk');
  assert.deepEqual(r.copied, ['README.md', 'app', 'install.bat', 'modules', 'node_modules', 'package.json', 'setup', 'start.bat', 'stop.bat', 'uninstall.bat']);
  for (const n of ['backups', 'runtime', '.git']) assert.equal(fs.existsSync(path.join(dir, n)), false, `${n} is not copied`);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'data')), ['install.log'], 'data is not copied; it holds only the install log');
  assert.ok(KEEP.includes('data'));
  const log = fs.readFileSync(path.join(dir, 'data', 'install.log'), 'utf8'); assert.match(log, /AP Desk 9\.8\.7 install, \d{4}-\d\d-\d\d \d\d:\d\d, into /); assert.match(log, /AP Desk is installed\./);
  assert.match(fs.readFileSync(path.join(dir, 'setup', 'installed.txt'), 'utf8'), /^README\.md\r\napp\r\n/);
  const lnks = w.ran.filter(c => c.env?.APD_LNK).map(c => c.env);
  const menu = path.join(w.folders.programs, 'AP Desk');
  assert.deepEqual(lnks.map(e => e.APD_LNK), [path.join(menu, 'AP Desk.lnk'), path.join(menu, 'Stop AP Desk.lnk'), path.join(menu, 'AP Desk log.lnk'), path.join(menu, 'Uninstall AP Desk.lnk'), path.join(w.folders.desktop, 'AP Desk.lnk')], 'no Startup shortcut by default');
  const main = lnks[0];
  // no runtime\node in this fake folder: the Node.js that runs the installer is the one the shortcuts use
  assert.deepEqual({ ...main }, { APD_LNK: path.join(menu, 'AP Desk.lnk'), APD_TARGET: process.execPath, APD_ARGS: `"${path.join(dir, 'setup', 'background.mjs')}" open`, APD_DIR: dir, APD_ICON: path.join(dir, 'setup', 'assets', 'apdesk.ico') + ',0', APD_DESC: 'Start AP Desk, your desk of AI agents on this PC', APD_STYLE: '7' });
  assert.equal(lnks[2].APD_TARGET, path.join('C:\\Windows', 'System32', 'notepad.exe')); assert.equal(lnks[2].APD_ARGS, `"${path.join(dir, 'data', 'desk.log')}"`);
  const sc = w.ran.find(c => c.env?.APD_LNK);
  assert.deepEqual(sc.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(sc.args[3], '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:APD_LNK); $s.TargetPath = $env:APD_TARGET; $s.Arguments = $env:APD_ARGS; $s.WorkingDirectory = $env:APD_DIR; $s.IconLocation = $env:APD_ICON; $s.Description = $env:APD_DESC; $s.WindowStyle = [int]$env:APD_STYLE; $s.Save()');
  const regs = w.ran.filter(c => c.cmd === 'reg.exe').map(c => c.args);
  assert.deepEqual(regs, [
    ['add', REG_KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'AP Desk', '/f'],
    ['add', REG_KEY, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', '9.8.7', '/f'],
    ['add', REG_KEY, '/v', 'Publisher', '/t', 'REG_SZ', '/d', 'AgentPopulation', '/f'],
    ['add', REG_KEY, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', dir, '/f'],
    ['add', REG_KEY, '/v', 'DisplayIcon', '/t', 'REG_SZ', '/d', path.join(dir, 'setup', 'assets', 'apdesk.ico'), '/f'],
    ['add', REG_KEY, '/v', 'UninstallString', '/t', 'REG_SZ', '/d', `"${path.join(dir, 'uninstall.bat')}"`, '/f'],
    ['add', REG_KEY, '/v', 'NoModify', '/t', 'REG_DWORD', '/d', '1', '/f'],
    ['add', REG_KEY, '/v', 'NoRepair', '/t', 'REG_DWORD', '/d', '1', '/f'],
  ]);
  assert.equal(REG_KEY, 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\APDesk');
  // the desk starts through the hidden runner: no "start" of a .bat file, which would leave a console window open
  assert.equal(w.ran.at(-1).cmd, process.execPath); assert.deepEqual(w.ran.at(-1).args, [path.join(dir, 'setup', 'background.mjs'), 'open']); assert.equal(w.ran.at(-1).detached, true);
  assert.equal(w.ran.some(c => c.cmd === 'cmd.exe' || c.args.some(a => /start\.bat/i.test(a))), false, 'no command runs start.bat');
  assert.equal(w.ran.some(c => c.args.includes('ci') || c.args.includes('install')), false, 'packages were already there: no npm');
  assert.match(say.lines.join('\n'), /AP Desk 9\.8\.7/);
});

test('install: answers No, then yes to start with Windows; packages are installed when missing', async () => {
  const src = fakeDownload({ zip: true }); const w = fakeWindows(); const dir = path.join(w.home, 'Apps', 'AP Desk');
  fs.mkdirSync(w.folders.desktop, { recursive: true }); fs.writeFileSync(path.join(w.folders.desktop, 'AP Desk.lnk'), 'old');
  const r = await install({ argv: ['--folder', dir], env: w.env, source: src, run: w.run, ask: answers('n', 'n', 'y', 'n'), say: quiet(), isRunning: async () => false });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(w.folders.desktop, 'AP Desk.lnk')), false, 'No to the Desktop icon removes an old one');
  const st = w.ran.find(c => c.env?.APD_LNK === path.join(w.folders.startup, 'AP Desk.lnk'));
  assert.equal(st.env.APD_ARGS, `"${path.join(dir, 'setup', 'background.mjs')}" open nowindow`); assert.equal(st.env.APD_STYLE, '7');
  assert.deepEqual(w.ran.filter(c => c.cmd === 'reg.exe').map(c => c.args), [['delete', REG_KEY, '/f']], 'No to the Apps list writes nothing and removes an old entry');
  const npm = w.ran.find(c => c.args.includes('ci'));
  assert.ok(npm, 'npm ci runs for the zip layout'); assert.equal(npm.cwd, path.join(dir, 'setup'));
  assert.deepEqual(npm.args.slice(1), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules', 'marked', 'package.json')), true, 'the packages are moved up beside app');
  assert.equal(w.ran.some(c => c.what === 'start AP Desk'), false);
});

test('install: an existing install keeps data, backups and runtime, and replaces only the program', async () => {
  const src = fakeDownload(); const w = fakeWindows(); const dir = path.join(w.home, 'AP Desk');
  const put = (rel, t) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), t); };
  put('app/server.js', 'old'); put('app/gone.js', 'old'); put('data/desk.sqlite', 'mine'); put('data/port.txt', '3447'); put('backups/b.zip', 'mine'); put('runtime/node/node.exe', 'mine');
  const say = quiet();
  const r = await install({ argv: ['--folder', dir, '--yes'], env: w.env, source: src, run: w.run, say, isRunning: async () => false });
  assert.equal(r.ok, true); assert.match(say.lines.join('\n'), /already in this folder/);
  assert.equal(fs.readFileSync(path.join(dir, 'app', 'server.js'), 'utf8'), '// desk'); assert.equal(fs.existsSync(path.join(dir, 'app', 'gone.js')), false);
  for (const [rel, t] of [['data/desk.sqlite', 'mine'], ['data/port.txt', '3447'], ['backups/b.zip', 'mine'], ['runtime/node/node.exe', 'mine']]) assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), t, `${rel} is not touched`);
  // while that desk runs, nothing is replaced
  const w2 = fakeWindows(); const r2 = await install({ argv: ['--folder', dir, '--yes'], env: w2.env, source: src, run: w2.run, say: quiet(), isRunning: async () => true });
  assert.equal(r2.ok, false); assert.match(r2.message, /running from this folder/); assert.equal(w2.ran.length, 0);
});

test('install: a shortcut Windows fails to save is not left half-made; a dry run changes nothing', async () => {
  const src = fakeDownload(); const w = fakeWindows(); w.fail.add('Stop AP Desk.lnk'); const dir = path.join(w.home, 'AP Desk');
  const say = quiet(); const r = await install({ argv: ['--folder', dir, '--yes'], env: w.env, source: src, run: w.run, say, isRunning: async () => false });
  assert.deepEqual(r.problems, [path.join(w.folders.programs, 'AP Desk', 'Stop AP Desk.lnk')]);
  assert.equal(fs.existsSync(r.problems[0]), false); assert.equal(fs.existsSync(path.join(w.folders.programs, 'AP Desk', 'AP Desk.lnk')), true);
  assert.match(say.lines.join('\n'), /Could not make the shortcut .*Stop AP Desk\.lnk/);

  const w2 = fakeWindows(); const dir2 = path.join(w2.home, 'Dry'); const say2 = quiet();
  const d = await install({ argv: ['--folder', dir2, '--yes', '--dry-run'], env: w2.env, source: src, run: w2.run, say: say2, isRunning: async () => false });
  assert.equal(d.ok, true); assert.equal(w2.ran.length, 0, 'no command runs'); assert.deepEqual(fs.readdirSync(dir2), [], 'nothing is copied');
  assert.match(say2.lines.join('\n'), /would make the shortcut/); assert.match(say2.lines.join('\n'), /would write DisplayName/);
});

test('install: the start-with-Windows switch adds and removes only the Startup shortcut', async () => {
  const w = fakeWindows(); const dir = path.join(w.home, 'AP Desk'); fs.mkdirSync(w.folders.startup, { recursive: true });
  const lnk = path.join(w.folders.startup, 'AP Desk.lnk');
  assert.equal((await autostart(true, { dir, run: w.run, say: quiet() })).ok, true); assert.equal(fs.existsSync(lnk), true);
  assert.equal(w.ran.at(-1).env.APD_ARGS, `"${path.join(dir, 'setup', 'background.mjs')}" open nowindow`);
  assert.equal((await autostart(false, { dir, run: w.run, say: quiet() })).ok, true); assert.equal(fs.existsSync(lnk), false);
  assert.match(read('setup/autostart.bat'), /node "%~dp0install\.mjs" --autostart %1/);
});

test('uninstall: removes the shortcuts, the Apps entry and the program; keeps data unless DELETE is typed', async () => {
  for (const [ans, dataGone] of [[['', ''], false], [['y', 'delete'], false], [['y', 'DELETE'], true]]) {
    const src = fakeDownload(); const w = fakeWindows(); const dir = path.join(w.home, 'AP Desk');
    await install({ argv: ['--folder', dir, '--yes'], env: w.env, source: src, run: w.run, say: quiet(), isRunning: async () => false });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); fs.writeFileSync(path.join(dir, 'data', 'desk.sqlite'), 'mine');
    fs.mkdirSync(path.join(dir, 'runtime', 'node'), { recursive: true });
    const outside = path.join(w.home, 'keep-me.txt'); fs.writeFileSync(outside, 'mine');
    fs.appendFileSync(path.join(dir, 'setup', 'installed.txt'), '..\r\n../keep-me.txt\r\n');
    const run2 = (c) => { w.ran.push(c); return w.run(c); }; const before = w.ran.length; const say = quiet();
    const r = await uninstall({ dir, run: run2, ask: answers(...ans), say });
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(path.join(w.folders.programs, 'AP Desk')), false, 'the Start menu folder is gone');
    assert.equal(fs.existsSync(path.join(w.folders.desktop, 'AP Desk.lnk')), false);
    assert.ok(w.ran.slice(before).some(c => c.cmd === 'reg.exe' && c.args.join(' ') === `delete ${REG_KEY} /f`));
    assert.equal(fs.existsSync(path.join(dir, 'app')), false); assert.equal(fs.existsSync(path.join(dir, 'setup')), false);
    assert.equal(fs.existsSync(path.join(dir, 'runtime')), true, 'runtime is left for uninstall.bat');
    assert.equal(fs.existsSync(path.join(dir, 'data', 'desk.sqlite')), !dataGone);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'mine', 'nothing outside the folder is touched');
    if (!dataGone) assert.match(say.lines.join('\n'), /Your data is kept in .*data/);
  }
  const notDesk = tmp(); fs.writeFileSync(path.join(notDesk, 'x.txt'), 'x');
  assert.equal((await uninstall({ dir: notDesk, run: () => { throw new Error('no command may run'); }, ask: answers(), say: quiet() })).ok, false);
  assert.equal(fs.existsSync(path.join(notDesk, 'x.txt')), true);
  assert.deepEqual(programList(notDesk).includes('data'), false);
  const u = read('uninstall.bat');
  assert.ok(u.indexOf('if not exist "%~dp0app\\server.js" goto :notapp') < u.indexOf('check.mjs" stop'), 'refuses a folder that is not AP Desk before anything else');
  assert.ok(u.indexOf('check.mjs" stop') < u.indexOf('uninstall.mjs'), 'stops the desk first');
});

test('port: 3445, the remembered port, or the next free one when another program holds it', async () => {
  const busy = (...ports) => async (p) => !ports.includes(p);
  const none = async () => false;
  assert.equal(DEFAULT_PORT, 3445); assert.deepEqual([SPARE_PORTS[0], SPARE_PORTS.at(-1), SPARE_PORTS.length], [3446, 3465, 20]);
  assert.deepEqual(await choosePort({ isDesk: none, isFree: busy() }), { port: 3445 });
  assert.deepEqual(await choosePort({ isDesk: async (p) => p === 3445, isFree: busy(3445) }), { port: 3445, running: true }, 'the desk itself on its port: just open it');
  assert.deepEqual(await choosePort({ isDesk: none, isFree: busy(3445, 3446) }), { port: 3447, remember: true, note: 'Port 3445 is used by another program, so AP Desk is on 3447.' });
  assert.deepEqual(await choosePort({ saved: 3447, isDesk: none, isFree: busy() }), { port: 3447 }, 'a remembered port is kept');
  assert.deepEqual(await choosePort({ saved: 3447, isDesk: async (p) => p === 3447, isFree: busy(3447) }), { port: 3447, running: true });
  assert.deepEqual((await choosePort({ saved: 3447, isDesk: none, isFree: busy(3447) })).port, 3445);
  assert.deepEqual(await choosePort({ envPort: 4000, isDesk: none, isFree: busy(4000) }), { port: 4000 }, 'APD_PORT is used as given');
  const all = await choosePort({ isDesk: none, isFree: async () => false }); assert.equal(all.port, null); assert.match(all.note, /3445 to 3465 are all used/);
});

test('background: the log starts a new file past its size and keeps one old file', () => {
  const dir = tmp(); const f = path.join(dir, 'desk.log'); const log = rollingLog(f, 100);
  for (let i = 0; i < 12; i++) log.write(`line ${String(i).padStart(4, '0')}\n`);   // 10 bytes each
  assert.ok(fs.statSync(f).size <= 100); assert.ok(fs.existsSync(path.join(dir, 'desk-old.log')));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['desk-old.log', 'desk.log']);
  assert.match(fs.readFileSync(f, 'utf8'), /line 0011/);
  assert.match(read('setup/background.mjs'), /windowsHide: true/);
});

test('start page and icon: self-contained, probes a desk file, closes itself; the icon has 16, 32, 48 and 256 px', () => {
  const h = fs.readFileSync(path.join(ROOT, 'setup', 'assets', 'starting.html'), 'utf8');
  assert.deepEqual([...h.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m => m[1]).filter(u => !u.startsWith('data:')), [], 'no outside files');
  assert.equal(/https?:\/\/(?!127\.0\.0\.1)/.test(h.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), false, 'only the desk on this PC is contacted');
  assert.match(h, /ui\/shell\.css\?probe=/); assert.match(h, /window\.close\(\)/); assert.match(h, /prefers-reduced-motion: reduce/); assert.match(h, /prefers-color-scheme: dark/);
  assert.match(h, /Agent Population Desk/); assert.match(h, /Starting your desk…/); assert.match(h, />= 60000/);
  assert.equal(/location\.(replace|href|assign)\s*[(=]/.test(h), false, 'the page never opens the desk itself (pairing)');
  const ico = fs.readFileSync(path.join(ROOT, 'setup', 'assets', 'apdesk.ico'));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 4]);
  const sizes = []; for (let i = 0; i < 4; i++) { const e = 6 + 16 * i; sizes.push(ico[e] || 256); const off = ico.readUInt32LE(e + 12); assert.equal(ico.subarray(off, off + 8).toString('hex'), '89504e470d0a1a0a', 'a PNG image'); }
  assert.deepEqual(sizes, [16, 32, 48, 256]);
  const png = fs.readFileSync(path.join(ROOT, 'setup', 'assets', 'apdesk.png')); assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
});

test('shortcuts list: Start menu folder holds AP Desk, Stop, log and Uninstall', () => {
  const s = shortcuts('C:\\AP', { programs: '/p', desktop: '/d', startup: '/s', windows: '/w' });
  assert.deepEqual(s.menu.map(x => path.basename(x.lnk)), ['AP Desk.lnk', 'Stop AP Desk.lnk', 'AP Desk log.lnk', 'Uninstall AP Desk.lnk']);
  assert.ok(programEntries(ROOT).includes('install.bat') && !programEntries(ROOT).includes('data'));
});

test('no stray console window: start.bat hands off to the hidden runner and promises nothing about its window', () => {
  const bat = read('start.bat');
  assert.equal(/closes when/i.test(bat), false, 'no message promises to close a window the script does not own');
  assert.match(bat, /node "%~dp0setup\\background\.mjs" %BG%/);
  assert.ok(bat.indexOf('if "%MODE%"=="background" goto :background') < bat.indexOf('call "%~dp0setup\\open.bat" starting'), 'background mode does not open a second start page');
  for (const rel of BATS) assert.equal(/closes when/i.test(read(rel)), false, `${rel}: no window-closing promise`);
  const bg = read('setup/background.mjs');
  assert.match(bg, /cmd === 'open'[\s\S]*?'launch'[\s\S]*?detached: true, stdio: 'ignore', windowsHide: true/);
  assert.match(read('setup/install.mjs'), /detached: true, stdio: 'ignore', windowsHide: true/);
});

test('background launch: the same steps as start.bat, with no window; start.bat in its own window when setup is needed', async () => {
  const fake = ({ all = 0, port = '3447\n', running = 1, wait = [0] } = {}) => {
    const did = []; const waits = [...wait];
    const sh = {
      check: (what, env) => { did.push(['check', what, env.APD_PORT || '']); if (what === 'all') return { code: all }; if (what === 'port') return { code: port ? 0 : 1, stdout: port }; if (what === 'running') return { code: running }; return { code: waits.length ? waits.shift() : 1 }; },
      open: (what, env) => did.push(['open', what, env.APD_PORT]), runner: (env) => did.push(['runner', env.APD_PORT]), visible: (args) => did.push(['visible', args]),
    };
    return { sh, did };
  };
  let f = fake(); assert.equal(await launch({ sh: f.sh, env: {} }), 0);
  assert.deepEqual(f.did.filter(d => d[0] !== 'check'), [['open', 'starting', '3447'], ['runner', '3447'], ['open', 'desk', '3447']]);
  f = fake({ running: 0 }); await launch({ sh: f.sh, env: {} }); assert.deepEqual(f.did.filter(d => d[0] !== 'check'), [['open', 'desk', '3447']], 'already running: just open it');
  f = fake(); await launch({ open: false, sh: f.sh, env: {} }); assert.deepEqual(f.did.filter(d => d[0] !== 'check'), [['runner', '3447']], 'sign-in start: no window at all');
  f = fake({ all: 1 }); await launch({ sh: f.sh, env: {} }); assert.deepEqual(f.did.filter(d => d[0] !== 'check'), [['visible', 'background']], 'packages missing: setup shows what it does');
  f = fake({ port: '' }); await launch({ open: false, sh: f.sh, env: {} }); assert.deepEqual(f.did.filter(d => d[0] !== 'check'), [['visible', 'background nowindow']]);
  f = fake({ wait: [1, 1] }); assert.equal(await launch({ sh: f.sh, env: {} }), 1); assert.equal(f.did.some(d => d[0] === 'open' && d[1] === 'desk'), false, 'the start page says what to do');
});

test('quiet npm: the whole output goes to the install log, and only error lines come back', async () => {
  const dir = tmp(); const npm = path.join(dir, 'stand-in-npm.mjs'); const log = path.join(dir, 'data', 'install.log');
  fs.writeFileSync(npm, "console.log('added 120 packages'); console.error('npm warn deprecated inflight@1.0.6: old'); console.error('npm error code ECONNRESET'); console.error('npm error network the connection was reset'); process.exit(1);\n");
  const r = await quietRun({ cmd: process.execPath, args: [npm], cwd: dir, quiet: true, log });
  assert.equal(r.code, 1); assert.deepEqual(r.errors, ['npm error code ECONNRESET', 'npm error network the connection was reset']);
  const all = fs.readFileSync(log, 'utf8'); for (const l of ['added 120 packages', 'npm warn deprecated', 'npm error code ECONNRESET']) assert.ok(all.includes(l), l);
  // through the installer: the user sees the error lines and where the log is, never the warnings
  const src = fakeDownload({ zip: true }); const w = fakeWindows(); const d2 = path.join(w.home, 'AP Desk'); const say = quiet();
  const run = (c) => c.quiet ? quietRun({ ...c, cmd: process.execPath, args: [npm] }) : w.run(c);
  const res = await install({ argv: ['--folder', d2, '--yes'], env: w.env, source: src, run, say, isRunning: async () => false });
  const shown = say.lines.join('\n');
  assert.equal(res.ok, false); assert.match(shown, /npm error code ECONNRESET/); assert.equal(/npm warn/.test(shown), false);
  assert.match(res.message, new RegExp(`The install log is ${path.join(d2, 'data', 'install.log').replace(/[\\/.]/g, '\\$&')}\\.`));
  assert.match(fs.readFileSync(path.join(d2, 'data', 'install.log'), 'utf8'), /npm warn deprecated/);
  assert.deepEqual(w.ran.filter(c => c.quiet).length, 0, 'npm went through the quiet runner');
  assert.match(read('setup/install.mjs'), /if \(c\.quiet\) return quietRun\(c\);/);
  for (const l of read('setup/setup.bat').split('\r\n').filter(l => /call npm /.test(l))) assert.match(l, /--loglevel=error$/, l);
});

test('console fallback: /console, answers on the command line, or no browser; the banner is plain ASCII', async () => {
  const src = fakeDownload(); const never = async () => { throw new Error('the page is not used'); };
  for (const argv of [['/console'], ['--console']]) {
    const w = fakeWindows(); const say = quiet();
    const r = await main(argv, { page: never, env: w.env, source: src, run: w.run, ask: answers('', '', '', '', ''), say, isRunning: async () => false });
    assert.equal(r.ok, true); assert.equal(r.dir, path.join(w.env.LOCALAPPDATA, 'Programs', 'AP Desk'));
    assert.ok(say.lines.includes(BANNER[0]));
  }
  const w = fakeWindows(); const say = quiet(); let asked = 0;
  const r = await main([], { page: async () => { asked++; return null; }, env: w.env, source: src, run: w.run, ask: answers('', '', '', '', ''), say, isRunning: async () => false });
  assert.equal(asked, 1); assert.equal(r.ok, true); assert.match(say.lines.join('\n'), /could not be opened in a browser, so the questions are asked here/);
  const viaPage = await main([], { page: async () => ({ ok: true, dir: 'x' }) }); assert.deepEqual(viaPage, { ok: true, dir: 'x' });
  for (const l of BANNER) assert.equal(/[^\x20-\x7e]/.test(l), false);
  assert.match(read('install.bat'), /install\.bat \/console/); assert.match(read('install.bat'), /node "%~dp0setup\\install\.mjs" %\*/);
});
