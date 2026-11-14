// Process tree helpers for MCP server processes (npx starts a child of its own).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/** Every descendant pid of `pid` (Linux /proc; on Windows taskkill /T handles the tree). */
export function descendants(pid) {
  if (process.platform === 'win32' || !fs.existsSync('/proc')) return [];
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(d)); } catch {}
  }
  const out = []; const walk = (p) => { for (const c of kids.get(p) || []) { out.push(c); walk(c); } }; walk(Number(pid));
  return out;
}
export function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } }
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 }); } catch {} return; }
  for (const p of [...descendants(pid).reverse(), Number(pid)]) { try { process.kill(p, 'SIGKILL'); } catch {} }
}
/** Split a command line into words, keeping "quoted parts" together. */
export function splitCommand(line) {
  const out = []; let cur = ''; let q = null; let any = false;
  for (const ch of String(line || '')) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
