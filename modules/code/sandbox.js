// Sandbox helpers for the Code module.
// Run limits, and the container flags (no network, read-only root, all powers dropped).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LIMITS = Object.freeze({ maxCodeBytes: 32_000, defaultTimeoutMs: 15_000, maxTimeoutMs: 60_000, minTimeoutMs: 250, maxOutputBytes: 200_000, memoryMb: 512 });
export const IMAGES = Object.freeze({ javascript: 'node:22-alpine', python: 'python:3.13-alpine' });
export const FILES = Object.freeze({ javascript: 'main.js', python: 'main.py' });
export const SANDBOX_LABEL = Object.freeze({ process: 'process sandbox (limits, not isolation)', container: 'container (no network, read-only, own folder only)' });

export function normalizeLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'js' || raw === 'javascript' || raw === 'node') return 'javascript';
  if (raw === 'py' || raw === 'python' || raw === 'python3') return 'python';
  return null;
}
export function normalizeTimeout(value) {
  if (value == null || value === '') return LIMITS.defaultTimeoutMs;
  const ms = Math.floor(Number(value));
  if (!Number.isFinite(ms)) return LIMITS.defaultTimeoutMs;
  return Math.max(LIMITS.minTimeoutMs, Math.min(LIMITS.maxTimeoutMs, ms));
}

/** An environment with nothing inherited but what a program needs to start. No keys, no tokens, no proxy settings. */
export function cleanEnv(dir) {
  const keep = process.platform === 'win32' ? ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'] : [];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  env.PATH = process.env.PATH || process.env.Path || '';
  env.HOME = dir; env.USERPROFILE = dir; env.TEMP = dir; env.TMP = dir; env.TMPDIR = dir;
  env.PYTHONIOENCODING = 'utf-8'; env.PYTHONDONTWRITEBYTECODE = '1'; env.PYTHONNOUSERSITE = '1';
  env.NODE_OPTIONS = ''; env.LANG = 'C.UTF-8';
  return env;
}

let pyCache = null;
/** The Python on this PC, if any: python on Windows (or the py launcher), python3 elsewhere. */
export function findPython() {
  if (pyCache !== null) return pyCache;
  const tries = process.platform === 'win32' ? [['python', []], ['py', ['-3']], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of tries) {
    try {
      const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const v = String(r.stdout || r.stderr || '').trim();
      if (r.status === 0 && /^Python 3\./.test(v)) return (pyCache = { cmd, pre, version: v.replace(/^Python\s+/, '') });
    } catch {}
  }
  return (pyCache = false);
}

let dockerCache = { at: 0, value: null };
export function dockerStatus({ force = false } = {}) {
  if (!force && dockerCache.value && Date.now() - dockerCache.at < 30_000) return dockerCache.value;
  let value;
  try {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 6000, windowsHide: true });
    if (r.error?.code === 'ENOENT') value = { available: false, reason: 'Docker is not installed on this PC.' };
    else if (r.status === 0 && String(r.stdout).trim()) value = { available: true, version: String(r.stdout).trim() };
    else value = { available: false, reason: 'Docker is installed but not running. Start Docker Desktop to use the container sandbox.' };
  } catch (e) { value = { available: false, reason: 'Docker could not be checked: ' + e.message }; }
  if (value.available) {
    value.images = {};
    for (const [lang, image] of Object.entries(IMAGES)) {
      const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 6000, windowsHide: true });
      value.images[lang] = r.status === 0;
    }
  }
  dockerCache = { at: Date.now(), value };
  return value;
}

/** The program and words for one run. `dir` is the run's own folder; nothing else is mounted or allowed. */
export function commandFor({ language, sandbox, dir, name }) {
  const file = FILES[language];
  if (sandbox === 'container') {
    const inner = language === 'javascript' ? ['node', file] : ['python', '-I', '-B', file];
    const args = ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', LIMITS.memoryMb + 'm', '--pids-limit', '128', '--cpus', '1', '--tmpfs', '/tmp:rw,size=64m', '-e', 'HOME=/work',
      '-v', `${dir}:/work`, '-w', '/work', IMAGES[language], ...inner];
    return { cmd: 'docker', args, shown: `docker run --network none --read-only ${IMAGES[language]} ${inner.join(' ')}` };
  }
  if (language === 'javascript') {
    // Node's permission model: the program may read and write only its own folder and may not start other programs.
    const args = ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, file];
    return { cmd: process.execPath, args, shown: `node --permission ${file}` };
  }
  const py = findPython();
  if (!py) return null;
  return { cmd: py.cmd, args: [...py.pre, '-I', '-B', file], shown: `${py.cmd} -I ${file}` };
}

export function killTree(child) {
  if (!child || child.exitCode != null || child.killed && child.signalCode) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}
export function dockerKill(name) {
  try { spawnSync('docker', ['kill', name], { timeout: 8000, windowsHide: true, stdio: 'ignore' }); } catch {}
}

/**
 * Run one program with a time limit and an output limit. Resolves when it ends or is killed.
 * `track(stop)` registers a stop function (Panic, switch-off) and returns an untrack function.
 */
export function runChild({ cmd, args, cwd, env, timeoutMs, maxOutputBytes = LIMITS.maxOutputBytes, signal, container = null, track = () => () => {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = Buffer.alloc(0), err = Buffer.alloc(0), size = 0, truncated = false, timedOut = false, stopped = false, done = false;
    let child;
    try { child = spawn(cmd, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ exitCode: null, stdout: '', stderr: String(e.message), ms: 0, error: e.message }); }
    const stop = (why) => {
      if (done) return;
      if (why === 'timeout') timedOut = true; else if (why === 'output') truncated = true; else stopped = true;
      if (container) dockerKill(container);
      killTree(child);
    };
    const untrack = track(() => stop('stopped'));
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('stopped');
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const take = (which) => (chunk) => {
      size += chunk.length;
      if (size > maxOutputBytes) { const room = Math.max(0, chunk.length - (size - maxOutputBytes)); chunk = chunk.subarray(0, room); stop('output'); }
      if (which === 'out') out = Buffer.concat([out, chunk]); else err = Buffer.concat([err, chunk]);
    };
    child.stdout.on('data', take('out')); child.stderr.on('data', take('err'));
    const finish = (exitCode, sig, error) => {
      if (done) return; done = true;
      clearTimeout(timer); untrack(); signal?.removeEventListener?.('abort', onAbort);
      resolve({ exitCode, signal: sig || null, stdout: out.toString('utf8'), stderr: err.toString('utf8'), ms: Date.now() - started, timedOut, truncated, stopped, error: error || null });
    };
    child.on('error', (e) => finish(null, null, e.code === 'ENOENT' ? `${cmd} is not installed on this PC.` : e.message));
    child.on('close', (code, sig) => finish(code, sig));
  });
}

/** Files the program left in its folder (names and sizes only). */
export function listFolder(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => ({ name: d.name, size: fs.statSync(path.join(dir, d.name)).size })); }
  catch { return []; }
}
