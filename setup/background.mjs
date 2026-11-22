// Runs the desk in the background with no window, for the Start menu, Desktop and Startup shortcuts.
//   node setup/background.mjs open [nowindow]   for the shortcuts and the end of an install: hands the start to a
//                                     hidden copy of itself (launch) and returns at once, so the window Windows gives
//                                     a shortcut closes within a moment and no console window stays behind
//   node setup/background.mjs launch [nowindow]  the hidden part: the port, the start page, the runner, the desk's
//                                     own window once it answers (nowindow: no window at all, for signing in)
//   node setup/background.mjs start   starts the background runner and returns at once
//   node setup/background.mjs run     the background runner itself: applies a waiting update, runs the desk,
//                                     starts it again when it asks (exit code 75), and writes its lines to data\desk.log
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

function runOnce(args, log, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.on('data', (d) => log.write(d)); p.stderr.on('data', (d) => log.write(d));
    p.on('error', (e) => { log.write(`Could not start: ${e.message}\n`); resolve(1); });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function runDesk({ log = rollingLog(path.join(DATA, 'desk.log')) } = {}) {
  for (;;) {
    log.write(`\n--- AP Desk starting, ${stamp()} ---\n`);
    const update = path.join(ROOT, 'setup', 'apply-update.mjs');
    if (fs.existsSync(update)) await runOnce([update], log);
    const code = await runOnce(['--no-warnings', path.join(ROOT, 'app', 'server.js')], log, { APD_BACKGROUND: '1' });   // hidden: the desk keeps the pairing code out of this log
    if (code !== 75) { log.write(`--- AP Desk stopped (code ${code}), ${stamp()} ---\n`); return code; }   // 75: the desk asked to be started again
  }
}

// cmd.exe /s /c ""file" args": the outer quotes are taken off as they are, so a folder name with spaces or
// brackets in it reaches the .bat file whole.
const batLine = (file, args) => ['/d', '/s', '/c', `""${file}" ${args}"`];
const SELF = fileURLToPath(import.meta.url);
const CHECK = path.join(ROOT, 'setup', 'check.mjs');
export const realShell = {
  check: (what, env) => { const r = spawnSync(process.execPath, [CHECK, what], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true }); return { code: r.status ?? 1, stdout: r.stdout || '' }; },
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
  if (open) sh.open('starting', env);
  sh.runner(env);
  if (!open) return 0;
  if (sh.check('wait', env).code !== 0 && sh.check('wait', env).code !== 0) return 1;   // the start page says what to do
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
  else { console.log('Use: node setup/background.mjs open'); process.exit(1); }
}
