// Route tracing: the system's own traceroute tool (tracert on Windows, traceroute or tracepath elsewhere), run on the
// owner's button with a hop and time limit, through an injectable runner. Nothing is installed: a missing tool is
// named. Pure apart from the default runner; server.js checks the target with the address guard first.
import { execFile } from 'node:child_process';

export const MAX_HOPS = 20;
export const TIME_LIMIT_MS = 60_000;
export const KEEP_RUNS = 20;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export const toolsFor = (platform = process.platform) => (platform === 'win32' ? ['tracert'] : ['traceroute', 'tracepath']);
export const missingName = (platform = process.platform) => (platform === 'win32' ? 'tracert' : 'traceroute or tracepath');

/** Arguments for each tool: numbers only (no name look-ups per hop), the hop limit, a short wait per hop, one probe. */
export function toolArgs(tool, address, { maxHops = MAX_HOPS } = {}) {
  const n = String(Math.max(1, Math.min(30, Number(maxHops) || MAX_HOPS)));
  if (tool === 'tracert') return ['-d', '-h', n, '-w', '1500', address];
  if (tool === 'traceroute') return ['-n', '-m', n, '-w', '2', '-q', '1', address];
  if (tool === 'tracepath') return ['-n', '-m', n, address];
  throw new Error('Unknown tool');
}

/** The hops from a tool's output: [{ hop, ip, ms }]; a hop that did not answer has ip and ms null. */
export function parseTrace(tool, text) {
  const hops = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    let hop = null, ip = null, ms = null;
    if (tool === 'tracepath') {
      const m = /^\s*(\d+)\??:\s+(\S+)(?:.*?\s([\d.]+)ms)?/.exec(raw); if (!m) continue;
      if (m[2] === '[LOCALHOST]') continue;
      hop = Number(m[1]); ip = IPV4.test(m[2]) ? m[2] : null; ms = ip && m[3] ? Number(m[3]) : null;
    } else {
      const m = /^\s*(\d+)\s+(.*)$/.exec(raw); if (!m) continue;
      hop = Number(m[1]); const rest = m[2];
      const addr = rest.split(/\s+/).find(t => IPV4.test(t.replace(/^\(|\)$/g, '')));
      ip = addr ? addr.replace(/^\(|\)$/g, '') : null;
      const times = [...rest.matchAll(/(<?)(\d+(?:\.\d+)?)\s*ms/g)].map(t => (t[1] ? 1 : Number(t[2])));
      ms = ip && times.length ? Math.min(...times) : null;
    }
    if (!hop || hops.has(hop) && hops.get(hop).ip) continue;
    hops.set(hop, { hop, ip, ms: ms == null ? null : Math.round(ms * 10) / 10 });
  }
  return [...hops.values()].sort((a, b) => a.hop - b.hop);
}

/** What changed against the previous run: hops whose address changed, and the hop count. */
export function diffRoutes(prev, cur) {
  if (!prev) return null;
  const a = prev.hops || [], b = cur.hops || [];
  const lines = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]?.ip || null, y = b[i]?.ip || null;
    if (x !== y) lines.push({ hop: i + 1, old: x, new: y });
  }
  return { changed: lines.length > 0, hopsBefore: a.length, hopsAfter: b.length, lines };
}

/**
 * The default runner: execFile with a time limit and the Panic signal. Resolves { stdout, timedOut }; rejects with
 * ENOENT when the tool is missing, 'halted' on Panic, and 'tool_failed' (with what it printed) when it ends with an error.
 */
export function systemRunner(tool, args, { timeoutMs = TIME_LIMIT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(tool, args, { timeout: timeoutMs, signal, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return reject(err);
      if (err && signal?.aborted) return reject(Object.assign(new Error('Stopped.'), { code: 'halted' }));
      if (err && !err.killed) return reject(Object.assign(new Error(`${tool} ended with an error.`), { code: 'tool_failed', stdout: String(stdout || '') }));
      resolve({ stdout: String(stdout || ''), timedOut: !!err?.killed });
    });
  });
}

/**
 * Run the first installed tool that works. Returns { tool, hops, timedOut } or { missing } when none is installed.
 * A tool that ends with an error and printed no hop is not a run: the next tool is tried, and when none works this
 * rejects with code 'tool_failed' ("Source unavailable").
 */
export async function trace(address, { platform = process.platform, run = systemRunner, maxHops = MAX_HOPS, timeoutMs = TIME_LIMIT_MS, signal } = {}) {
  if (!IPV4.test(String(address))) throw Object.assign(new Error('Routes are traced to an IPv4 address.'), { status: 400 });
  const failed = [];
  for (const tool of toolsFor(platform)) {
    let r;
    try { r = await run(tool, toolArgs(tool, address, { maxHops }), { timeoutMs, signal }); }
    catch (e) {
      if (e.code === 'ENOENT') continue;
      if (e.code !== 'tool_failed') throw e;
      const hops = parseTrace(tool, e.stdout).slice(0, maxHops);
      if (hops.length) return { tool, hops, timedOut: false };
      failed.push(tool); continue;
    }
    return { tool, hops: parseTrace(tool, r.stdout).slice(0, maxHops), timedOut: !!r.timedOut };
  }
  if (failed.length) throw Object.assign(new Error(`Source unavailable: ${failed.join(' and ')} ended with an error.`), { code: 'tool_failed', status: 502 });
  return { missing: missingName(platform) };
}
