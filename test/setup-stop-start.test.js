// Stopping and starting: stop.bat tells a failed stop from "was not running", uninstall.bat asks once before it
// stops or removes anything, and the start page hears when the desk stopped. On Linux: the .mjs logic is run,
// the .bat files are read (no command here reaches Windows).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { stopDesk, STOP_CODE } from '../setup/check.mjs';
import { markStart, readStart, whyStopped, runDesk, launch } from '../setup/background.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bat = (rel) => fs.readFileSync(path.join(ROOT, rel), 'latin1');
const lines = (raw) => raw.split('\r\n').map(l => l.trim()).filter(l => l && !/^rem\b/i.test(l));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apd-ss-'));
const noWait = async () => {};

test('58: stop is "stopped", "not running" or "still running", and stop.bat words each one', async () => {
  const data = tmp();
  assert.equal(await stopDesk({ answers: async () => false, data, wait: noWait }), 'not running');
  let up = 3; assert.equal(await stopDesk({ answers: async () => up-- > 0, data, wait: noWait }), 'stopped');
  assert.equal(fs.existsSync(path.join(data, 'stop.request')), false, 'the stop note is cleared');
  // the desk keeps answering and there is no desk.pid: this is a failed stop, not "was not running"
  assert.equal(await stopDesk({ answers: async () => true, data, wait: noWait, kill: () => { throw new Error('no pid to end'); } }), 'still running');
  // there is a desk.pid, but ending it does not stop the answers: still running
  fs.writeFileSync(path.join(data, 'desk.pid'), '4242'); const killed = [];
  assert.equal(await stopDesk({ answers: async () => true, data, wait: noWait, kill: (p) => killed.push(p) }), 'still running');
  assert.deepEqual(killed, [4242]);
  let after = 41; assert.equal(await stopDesk({ answers: async () => after-- > 0, data, wait: noWait, kill: () => {} }), 'stopped', 'ended through desk.pid, and it stopped answering');
  assert.deepEqual(STOP_CODE, { stopped: 0, 'not running': 1, 'still running': 2 });

  const s = lines(bat('stop.bat'));
  const at = (t) => s.findIndex(l => l === t);
  assert.ok(at('if errorlevel 2 goto :stillrunning') > 0 && at('if errorlevel 2 goto :stillrunning') < at('if errorlevel 1 goto :notrunning'), 'errorlevel 2 is read before 1');
  const still = s.slice(at(':stillrunning'));
  assert.match(still.join('\n'), /AP Desk did not stop/); assert.equal(/was not running|has stopped/.test(still.join('\n')), false);
  assert.ok(still.includes('exit /b 1'));
});

test('57: uninstall.bat asks one question that says what goes and what stays, before it stops or removes anything', () => {
  const raw = bat('uninstall.bat'); const s = lines(raw);
  const ask = s.findIndex(l => l.startsWith('set /p "SURE='));
  assert.ok(ask > 0, 'there is a question');
  for (const later of ['check.mjs" stop', 'uninstall.mjs"', 'rmdir', 'del ']) {
    const i = s.findIndex(l => l.includes(later));
    assert.ok(i > ask, `"${later}" comes after the question`);
  }
  const before = s.slice(0, ask).join('\n');
  assert.match(before, /the program in/); assert.match(before, /shortcuts/); assert.match(before, /Settings, Apps/);
  assert.match(before, /chats, files, settings and backups stay/);
  // only Y or yes goes on; Enter alone, or anything else, keeps AP Desk and says so
  const after = s.slice(ask + 1, ask + 6);
  assert.deepEqual(after.slice(0, 2), ['if /i "%SURE%"=="y" goto :remove', 'if /i "%SURE%"=="yes" goto :remove']);
  assert.ok(after.some(l => /AP Desk was not removed\. Nothing was changed\./.test(l)));
  assert.equal(/[<>|&]/.test(before.split('\n').filter(l => l.startsWith('echo')).join('')), false, 'no echo line holds a character cmd reads as a command');
  // a folder such as C:\\Users\\Tom & Ann is printed through a for variable, never expanded straight into an echo line
  assert.equal(s.some(l => /^echo\b.*%~/.test(l)), false, 'no echo line expands a folder');
  assert.ok(s.includes('for %%d in ("%~dp0.") do echo   - the program in %%~fd'));
  // a desk that did not stop is not removed from under itself
  const stop = s.findIndex(l => l.includes('check.mjs" stop'));
  assert.equal(s[stop + 1], 'if errorlevel 2 goto :stillrunning');
  assert.match(s.slice(s.indexOf(':stillrunning')).join('\n'), /nothing was removed/);
});

test('59: the start state: written before the page opens, "stopped" with a word for why, and "no answer" never hides a why', () => {
  const file = path.join(tmp(), 'start-state.js');
  assert.equal(readStart(file), null);
  assert.equal(markStart('noanswer', '', { file }), false, 'no start was marked: nothing to say');
  markStart('starting', '', { file, now: 1000 }); assert.deepEqual(readStart(file), { state: 'starting', why: '', at: 1000 });
  assert.match(fs.readFileSync(file, 'utf8'), /^window\.APD_START = \{.*\};\n$/);
  assert.equal(markStart('noanswer', '', { file }), true); assert.equal(readStart(file).state, 'noanswer');
  markStart('stopped', 'missing', { file }); assert.equal(markStart('noanswer', '', { file }), false); assert.equal(readStart(file).why, 'missing', 'the reason stays');
  assert.equal(whyStopped(0), 'asked'); assert.equal(whyStopped(2), 'port'); assert.equal(whyStopped(1, 'Error: listen EADDRINUSE: address already in use'), 'port');
  assert.equal(whyStopped(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\\x\\app\\core\\a.js'"), 'missing');
  assert.equal(whyStopped(1, 'ENOSPC: no space left on device'), 'disk'); assert.equal(whyStopped(1, 'TypeError: x'), 'error'); assert.equal(whyStopped(3221225477), 'error');
});

test('59: the runner marks "stopped" with why when the desk exits, and launch marks the start and a start with no answer', async () => {
  const dir = tmp(); const desk = path.join(dir, 'desk.mjs');
  fs.writeFileSync(desk, "console.error(\"Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'\"); process.exit(1);\n");
  const marks = []; const log = { text: '', write(d) { this.text += String(d); } };
  assert.equal(await runDesk({ log, mark: (...a) => marks.push(a), desk }), 1);
  assert.deepEqual(marks, [['stopped', 'missing']]); assert.match(log.text, /AP Desk stopped \(code 1\)/);

  const did = [];
  const sh = { check: (what) => ({ code: what === 'all' ? 0 : what === 'port' ? 0 : 1, stdout: '3447' }), mark: (s) => did.push(['mark', s]), open: (w) => did.push(['open', w]), runner: () => did.push(['runner']), visible: () => did.push(['visible']) };
  assert.equal(await launch({ sh, env: {} }), 1);
  assert.deepEqual(did, [['mark', 'starting'], ['open', 'starting'], ['runner'], ['mark', 'noanswer']], '"starting" is written before the page opens');
});

test('59: start.bat marks the start before the page, and after an error it says so, marks it and waits', () => {
  const s = lines(bat('start.bat'));
  const mark = s.indexOf('node "%~dp0setup\\background.mjs" mark starting'); const page = s.indexOf('if "%OPEN%"=="yes" call "%~dp0setup\\open.bat" starting');
  assert.ok(mark > 0 && mark < page);
  const rc = s.indexOf('set "RC=%errorlevel%"'); const end = s.slice(rc);
  assert.deepEqual(end.slice(0, 7), ['set "RC=%errorlevel%"', 'if "%RC%"=="75" goto :run', 'if "%RC%"=="2" if "%OPEN%"=="yes" call "%~dp0setup\\open.bat" desk', 'if "%RC%"=="0" exit /b 0', 'if "%RC%"=="-1073741510" exit /b %RC%', 'node "%~dp0setup\\background.mjs" mark stopped %RC%', 'if "%RC%"=="2" exit /b %RC%']);
  assert.ok(end.slice(7, 12).includes('pause'), 'the window stays open to show why');
  assert.match(fs.readFileSync(path.join(ROOT, 'setup', 'background.mjs'), 'utf8'), /cmd === 'mark'/);
});

test('60 and 26: every hidden start tells the desk it has no window; start.bat\'s own window shows the code; Unix start files name no Windows things', () => {
  const bg = fs.readFileSync(path.join(ROOT, 'setup', 'background.mjs'), 'utf8');
  assert.match(bg, /runOnce\(\['--no-warnings', desk\], tee, \{ APD_BACKGROUND: '1' \}\)/, 'the runner the shortcuts use sets APD_BACKGROUND');
  assert.match(bg, /runner: \(env\) => \{ spawn\(process\.execPath, \[SELF, 'run'\]/); assert.match(bg, /cmd === 'start'[\s\S]*?\[fileURLToPath\(import\.meta\.url\), 'run'\]/);
  const startBat = bat('start.bat');
  assert.equal(/APD_BACKGROUND/i.test(startBat), false, 'start.bat in a window does not hide the code: its window is the one the pairing page names');
  assert.match(startBat, /^node --no-warnings "%~dp0app\\server\.js"$/m);
  for (const rel of ['start.sh', 'start.command']) {
    const t = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
    assert.equal(/\.bat\b|Start menu|\bPC\b|C:\\|Windows/i.test(t), false, `${rel}: no Windows words`);
  }
});

test('59: the start page reads the start state from the data folder and holds the words for every why', () => {
  const h = fs.readFileSync(path.join(ROOT, 'setup', 'assets', 'starting.html'), 'utf8');
  assert.match(h, /new URL\('\.\.\/\.\.\/data\/start-state\.js', location\.href\)/, 'setup\\assets\\..\\..\\data is the folder the runner writes to');
  const script = h.slice(h.indexOf('<script>'));
  for (const why of ['port', 'missing', 'disk', 'error', 'asked', 'noanswer']) assert.match(script, new RegExp(`\\b${why}: \\['`), `words for ${why}`);
  assert.match(script, /\.textContent = w\[0\]/); assert.equal(/innerHTML/.test(script), false, 'nothing from the file is put on the page as markup');
  assert.match(script, /st\.at >= started - 60000/, 'an old state from an earlier start is not shown');
});
