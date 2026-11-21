// Local speech engines as optional sidecars: whisper.cpp (speech to text) and Piper (text to speech).
// Detection and the child-process runner: one folder the owner picks, a shallow search, signal-aware kill.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WIN = process.platform === 'win32';
export const WHISPER_NAMES = WIN ? ['whisper-cli.exe', 'main.exe', 'whisper.exe'] : ['whisper-cli', 'main'];
export const PIPER_NAMES = WIN ? ['piper.exe'] : ['piper'];
const SKIP = new Set(['node_modules', '.git', 'CMakeFiles', 'espeak-ng-data', 'samples', 'examples', 'tests', 'models_src']);

/** Walk the owner's folder a few levels deep and pick the engines and model files. */
export function scanFolder(root, { depth = 4, limit = 6000 } = {}) {
  const found = { whisper: null, piper: null, whisperModels: [], piperVoices: [] };
  if (!root || !fs.existsSync(root)) return found;
  let seen = 0;
  const walk = (dir, d) => {
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (d < depth && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(full, d + 1); continue; }
      if (!found.whisper && WHISPER_NAMES.includes(e.name) && runnable(full)) found.whisper = full;
      else if (!found.piper && PIPER_NAMES.includes(e.name) && runnable(full)) found.piper = full;
      else if (/^ggml-.*\.bin$/i.test(e.name) && !/silero|vad/i.test(e.name)) found.whisperModels.push(full);
      else if (/\.onnx$/i.test(e.name) && fs.existsSync(full + '.json')) found.piperVoices.push(full);
    }
  };
  walk(path.resolve(root), 0);
  found.whisperModels.sort((a, b) => size(a) - size(b));
  return found;
}
const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
function runnable(f) { try { fs.accessSync(f, WIN ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }

const active = new Set();
/** Kill every running engine in this set (Panic, switch off). The Voice module passes its own set, one per space. */
export function killAll(track = active) { let n = 0; for (const c of track) { try { c.kill(); n++; } catch {} } track.clear(); return n; }

export function run(cmd, args, { input = null, timeoutMs = 300_000, signal, cwd, track = active } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false;
    let child;
    const finish = (row) => { if (done) return; done = true; clearTimeout(timer); track.delete(child); resolve({ ...row, stdout, stderr }); };
    try { child = spawn(cmd, args, { cwd: cwd || path.dirname(cmd), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: null, error: e.message, stdout, stderr }); }
    track.add(child);
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ code: null, error: 'timeout' }); }, timeoutMs);
    const onAbort = () => { try { child.kill(); } catch {} finish({ code: null, error: 'stopped' }); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-200_000); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('close', (code) => finish({ code }));
    try { child.stdin.end(input == null ? undefined : String(input)); } catch {}
  });
}

/** Duration of a PCM WAV in seconds, from its header. */
export function wavSeconds(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, byteRate = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4); const len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = b.readUInt32LE(off + 16);
    if (id === 'data') return byteRate ? Math.min(len, b.length - off - 8) / byteRate : null;
    off += 8 + len + (len % 2);
  }
  return null;
}
