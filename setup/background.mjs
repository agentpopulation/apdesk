// Runs the desk in the background with no window, for the Start menu, Desktop and Startup shortcuts.
//   node setup/background.mjs open [nowindow]   for the shortcuts and the end of an install: hands the start to a
//                                     hidden copy of itself (launch) and returns at once, so the window Windows gives
//                                     a shortcut closes within a moment and no console window stays behind
//   node setup/background.mjs launch [nowindow]  the hidden part: the port, the start page, the runner, the desk's
//                                     own window once it answers (nowindow: no window at all, for signing in)
//   node setup/background.mjs start   starts the background runner and returns at once
//   node setup/background.mjs run     the background runner itself: applies a waiting update, runs the desk,
//                                     starts it again when it asks (exit code 75), and writes its lines to data\desk.log
//   node setup/background.mjs mark starting | mark stopped <exit code>   for start.bat: tells the start page
// Closing a window never stops it; "Stop AP Desk" (stop.bat) does, through the desk's own stop request.
// The log starts a new file when it grows past 5 MB and keeps one old file, data\desk-old.log.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { spawn, spawnSync } from 'node:child_process';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.APD_DATA || path.join(ROOT, 'data');
export const LOG_MAX = 5 * 1024 * 1024;

// A log file that never grows past max bytes: when the next write would pass it, the file becomes the old file.
export function rollingLog(file, max = LOG_MAX) {
  const old = file.replace(/\.log$/, '-old.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let size = 0; try { size = fs.statSync(file).size; } catch {}
  return {
    write(chunk) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (size > 0 && size + b.length > max) { try { fs.rmSync(old, { force: true }); fs.renameSync(file, old); } catch {} size = 0; }
      fs.appendFileSync(file, b); size += b.length;
    },
  };
}

const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${d.toLocaleTimeString('en-GB', { timeZoneName: 'short' }).split(' ').pop()}`; };   // the computer's zone, named

// How the start is going, for the start page (setup\assets\starting.html): data\start-state.js. A page opened from a
// file cannot read the desk's answers, but it may load a script file from the same folder tree, so the state is a
// one-line script. Only a word for why goes in it; the page holds the plain words for each, never the desk's own lines.
export const STATE_FILE = path.join(DATA, 'start-state.js');
export function readStart(file = STATE_FILE) { try { return JSON.parse(/=\s*(\{.*\});/.exec(fs.readFileSync(file, 'utf8'))[1]); } catch { return null; } }
export function markStart(state, why = '', { file = STATE_FILE, now = Date.now() } = {}) {
  if (state === 'noanswer' && readStart(file)?.state !== 'starting') return false;   // the desk already said why it stopped
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `window.APD_START = ${JSON.stringify({ state, why, at: now })};\n`); return true; } catch { return false; }
}
// Why the desk stopped, from its exit code and its last lines: port (2: another program has the port), missing
// (a program file is not there: an install or update did not finish), disk (full), asked (0: a clean stop), error.
export function whyStopped(code, tail = '') {
  if (code === 0) return 'asked';
  if (code === 2 || /EADDRINUSE/.test(tail)) return 'port';
  if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(tail)) return 'missing';
  if (/ENOSPC/.test(tail)) return 'disk';
  return 'error';
}

// A proxy set for this PC in HTTPS_PROXY or HTTP_PROXY (any case) is used for the desk's own web calls: Node reads it
// when NODE_USE_ENV_PROXY is 1 (an older Node ignores the variable). This PC itself never goes through the proxy, so
// the desk, Ollama and the local engine are added to NO_PROXY, in both spellings (Node reads no_proxy first).
const ME = ['127.0.0.1', 'localhost', '::1'];
export function proxyEnv(env) {
  const set = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(k => env[k]);
  if (!set || (env.NODE_USE_ENV_PROXY != null && env.NODE_USE_ENV_PROXY !== '')) return env;
  const have = [env.no_proxy, env.NO_PROXY].filter(Boolean).join(',').split(',').map(x => x.trim()).filter(Boolean);
  const list = [...new Set([...ME, ...have])].join(',');
  return { ...env, NODE_USE_ENV_PROXY: '1', NO_PROXY: list, no_proxy: list };
}

function runOnce(args, log, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: proxyEnv({ ...process.env, ...env }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.on('data', (d) => log.write(d)); p.stderr.on('data', (d) => log.write(d));
    p.on('error', (e) => { log.write(`Could not start: ${e.message}\n`); resolve(1); });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function runDesk({ log = rollingLog(path.join(DATA, 'desk.log')), mark = markStart, desk = path.join(ROOT, 'app', 'server.js') } = {}) {
  for (;;) {
    log.write(`\n--- AP Desk starting, ${stamp()} ---\n`);
    const update = path.join(ROOT, 'setup', 'apply-update.mjs');
    if (fs.existsSync(update)) await runOnce(['--no-warnings', update], log);
    let tail = ''; const tee = { write: (d) => { log.write(d); tail = (tail + String(d)).slice(-4000); } };
    const code = await runOnce(['--no-warnings', desk], tee, { APD_BACKGROUND: '1' });   // hidden: the desk keeps the pairing code out of this log
    if (code !== 75) { log.write(`--- AP Desk stopped (code ${code}), ${stamp()} ---\n`); mark('stopped', whyStopped(code, tail)); return code; }   // 75: the desk asked to be started again
  }
}

// cmd.exe /s /c ""file" args": the outer quotes are taken off as they are, so a folder name with spaces or
// brackets in it reaches the .bat file whole.
const batLine = (file, args) => ['/d', '/s', '/c', `""${file}" ${args}"`];
const SELF = fileURLToPath(import.meta.url);
const CHECK = path.join(ROOT, 'setup', 'check.mjs');
export const realShell = {
  check: (what, env) => { const r = spawnSync(process.execPath, [CHECK, what], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true }); return { code: r.status ?? 1, stdout: r.stdout || '' }; },
  mark: (state, why) => markStart(state, why),
  open: (what, env) => { spawnSync('cmd.exe', batLine(path.join(ROOT, 'setup', 'open.bat'), what), { cwd: ROOT, env, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }); },
  runner: (env) => { spawn(process.execPath, [SELF, 'run'], { cwd: ROOT, env, detached: true, stdio: 'ignore', windowsHide: true }).unref(); },
  // in its own window that closes when it ends: setup needs to show what it does, and why it stopped
  visible: (args) => { spawn('cmd.exe', batLine(path.join(ROOT, 'start.bat'), args), { cwd: ROOT, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref(); },
};

// The start the shortcuts use, with no console window: the same steps start.bat takes in background mode.
// When Node.js or the packages are not in place, or no port is free, start.bat runs in a window of its own instead.
export async function launch({ open = true, sh = realShell, env = { ...process.env } } = {}) {
  const fallback = () => { sh.visible(open ? 'background' : 'background nowindow'); return 0; };
  if (sh.check('all', env).code !== 0) return fallback();
  const port = String(sh.check('port', env).stdout || '').trim().split(/\s+/)[0];
  if (!/^\d+$/.test(port)) return fallback();
  env.APD_PORT = port;
  if (sh.check('running', env).code === 0) { if (open) sh.open('desk', env); return 0; }
  sh.mark?.('starting');
  if (open) sh.open('starting', env);
  sh.runner(env);
  if (!open) return 0;
  if (sh.check('wait', env).code !== 0 && sh.check('wait', env).code !== 0) { sh.mark?.('noanswer'); return 1; }   // the start page says so, and what to do
  sh.open('desk', env);
  return 0;
}

const cmd = process.argv[2];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cmd === 'start') {
    // detached and hidden: no console window, and it keeps running when the window that started it closes
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], { cwd: ROOT, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
  } else if (cmd === 'open') {
    spawn(process.execPath, [SELF, 'launch', ...process.argv.slice(3)], { cwd: ROOT, env: process.env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (cmd === 'launch') process.exit(await launch({ open: process.argv[3] !== 'nowindow' }));
  else if (cmd === 'run') process.exit(await runDesk());
  else if (cmd === 'mark') markStart(process.argv[3] === 'stopped' ? 'stopped' : 'starting', process.argv[3] === 'stopped' ? whyStopped(Number(process.argv[4])) : '');
  else { console.log('Use: node setup/background.mjs open'); process.exit(1); }
}
