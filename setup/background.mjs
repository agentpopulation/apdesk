// Runs the desk in the background with no window, for the Start menu, Desktop and Startup shortcuts.
//   node setup/background.mjs start   starts the background runner and returns at once
//   node setup/background.mjs run     the background runner itself: applies a waiting update, runs the desk,
//                                     starts it again when it asks (exit code 75), and writes its lines to data\desk.log
// Closing a window never stops it; "Stop AP Desk" (stop.bat) does, through the desk's own stop request.
// The log starts a new file when it grows past 5 MB and keeps one old file, data\desk-old.log.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { spawn } from 'node:child_process';
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

const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };   // local time

function runOnce(args, log) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    const code = await runOnce(['--no-warnings', path.join(ROOT, 'app', 'server.js')], log);
    if (code !== 75) { log.write(`--- AP Desk stopped (code ${code}), ${stamp()} ---\n`); return code; }   // 75: the desk asked to be started again
  }
}

const cmd = process.argv[2];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cmd === 'start') {
    // detached and hidden: no console window, and it keeps running when the window that started it closes
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], { cwd: ROOT, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
  } else if (cmd === 'run') process.exit(await runDesk());
  else { console.log('Use: node setup/background.mjs start'); process.exit(1); }
}
