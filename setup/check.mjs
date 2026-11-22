// Small checks for the start, stop and setup files. Exit code 0 means yes.
//   node check.mjs            Node is new enough and the packages are installed
//   node check.mjs node       Node is 22.13 or newer
//   node check.mjs packages   the packages are installed
//   node check.mjs port       prints the port the desk uses (see choosePort); exit 1 if none is free
//   node check.mjs running    the desk answers on its port
//   node check.mjs wait       wait up to 60 seconds for the desk to answer
//   node check.mjs stop       ask the desk to stop and wait until it has: exit 0 stopped, 1 was not running,
//                             2 it still answers (it did not stop)
//   node check.mjs layout     prints "repo" for a repository checkout, "zip" for the unzipped app
// The port: APD_PORT when it is set, else the one remembered in data\port.txt, else 3445.
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import { fileURLToPath } from 'node:url';
export const DEFAULT_PORT = 3445;
export const SPARE_PORTS = Array.from({ length: 20 }, (_, i) => 3446 + i);   // 3446 to 3465
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.APD_DATA || path.join(ROOT, 'data');
const PORT_FILE = path.join(DATA, 'port.txt');
const remembered = () => { try { const n = Number(fs.readFileSync(PORT_FILE, 'utf8').trim()); return n > 0 && n < 65536 ? n : null; } catch { return null; } };
const PORT = Number(process.env.APD_PORT) || remembered() || DEFAULT_PORT;
const nodeOk = () => { const [a, b] = process.versions.node.split('.').map(Number); return a > 22 || (a === 22 && b >= 13); };
// the package list is setup/package.json in the zip, and package.json beside start.bat in a repository checkout
const pkgFile = () => [path.join(ROOT, 'package.json'), path.join(ROOT, 'setup', 'package.json')].find(f => fs.existsSync(f));
const packagesOk = () => { try { const want = Object.keys(JSON.parse(fs.readFileSync(pkgFile(), 'utf8')).dependencies || {}); return want.every(n => fs.existsSync(path.join(ROOT, 'node_modules', n, 'package.json'))); } catch { return fs.existsSync(path.join(ROOT, 'node_modules')); } };
// the desk is what answers /api/panic with its Panic state; anything else on the port is another program
const isDesk = async (port) => { try { const r = await fetch(`http://127.0.0.1:${port}/api/panic`, { signal: AbortSignal.timeout(1500) }); return r.ok && 'halted' in (await r.json()); } catch { return false; } };
const isFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The port to start on. A port set in APD_PORT is used as it is. Otherwise the remembered port (or 3445) is kept
// when the desk already answers there or it is free; when another program holds it, the first free port of
// 3446 to 3465 is taken and remembered, so every later start, stop and shortcut finds the desk at the same address.
export async function choosePort({ envPort = null, saved = null, isDesk: desk = isDesk, isFree: free = isFree } = {}) {
  if (envPort) return { port: envPort };
  const want = saved || DEFAULT_PORT;
  if (await desk(want)) return { port: want, running: true };
  if (await free(want)) return { port: want };
  for (const p of [DEFAULT_PORT, ...SPARE_PORTS]) {
    if (p === want) continue;
    if (await free(p)) return { port: p, remember: true, note: `Port ${want} is used by another program, so AP Desk is on ${p}.` };
  }
  return { port: null, note: `Ports ${DEFAULT_PORT} to ${SPARE_PORTS.at(-1)} are all used by other programs. Close one of them and start AP Desk again.` };
}

async function main(cmd) {
  if (cmd === 'all') return nodeOk() && packagesOk();
  if (cmd === 'node') { const ok = nodeOk(); if (!ok) console.log(`Node ${process.versions.node} is too old. 22.13 or newer is needed.`); return ok; }
  if (cmd === 'packages') return packagesOk();
  if (cmd === 'layout') { const repo = fs.existsSync(path.join(ROOT, 'package.json')); console.log(repo ? 'repo' : 'zip'); return repo; }
  if (cmd === 'port') {
    const r = await choosePort({ envPort: Number(process.env.APD_PORT) || null, saved: remembered() });
    if (r.note) console.error(r.note);           // the console shows it; stdout carries only the port
    if (!r.port) return false;
    if (r.remember) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PORT_FILE, String(r.port) + '\n'); }
    console.log(r.port); return true;
  }
  if (cmd === 'running') return isDesk(PORT);
  if (cmd === 'wait') { for (let i = 0; i < 120; i++) { if (await isDesk(PORT)) return true; await sleep(500); } return false; }
  if (cmd === 'stop') return STOP_CODE[await stopDesk()];
  return false;
}

// Asks the desk to stop and waits until it no longer answers. 'stopped', 'not running', or 'still running' when it
// still answers after the wait and after its process was ended: the caller must not say it stopped.
export async function stopDesk({ answers = () => isDesk(PORT), data = DATA, wait = sleep, kill = (pid) => process.kill(pid), tries = 40 } = {}) {
  if (!(await answers())) return 'not running';
  const note = path.join(data, 'stop.request');
  fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(note, new Date().toISOString());
  const gone = async (n) => { for (let i = 0; i < n; i++) { await wait(500); if (!(await answers())) return true; } return false; };
  let ok = await gone(tries);
  if (!ok) { try { const pid = Number(fs.readFileSync(path.join(data, 'desk.pid'), 'utf8')); if (pid) { kill(pid); ok = await gone(10); } } catch {} }
  try { fs.rmSync(note, { force: true }); } catch {}
  return ok ? 'stopped' : 'still running';
}
// exit codes of "node check.mjs stop": 0 stopped, 1 was not running, 2 still running
export const STOP_CODE = { stopped: 0, 'not running': 1, 'still running': 2 };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await main(process.argv[2] || 'all');
  process.exit(typeof r === 'number' ? r : r ? 0 : 1);
}
