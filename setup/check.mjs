// Small checks for start.bat, stop.bat and setup.bat. Exit code 0 means yes.
//   node check.mjs            Node is new enough and the packages are installed
//   node check.mjs node       Node is 22.13 or newer
//   node check.mjs packages   the packages are installed
//   node check.mjs running    the desk answers on port 3960
//   node check.mjs wait       wait up to 60 seconds for the desk to answer
//   node check.mjs stop       ask the desk to stop and wait until it has
//   node check.mjs layout     prints "repo" for a repository checkout, "zip" for the unzipped app
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.APD_PORT) || 3960;
const DATA = process.env.APD_DATA || path.join(ROOT, 'data');
const nodeOk = () => { const [a, b] = process.versions.node.split('.').map(Number); return a > 22 || (a === 22 && b >= 13); };
// the package list is setup/package.json in the zip, and package.json beside start.bat in a repository checkout
const pkgFile = () => [path.join(ROOT, 'package.json'), path.join(ROOT, 'setup', 'package.json')].find(f => fs.existsSync(f));
const packagesOk = () => { try { const want = Object.keys(JSON.parse(fs.readFileSync(pkgFile(), 'utf8')).dependencies || {}); return want.every(n => fs.existsSync(path.join(ROOT, 'node_modules', n, 'package.json'))); } catch { return fs.existsSync(path.join(ROOT, 'node_modules')); } };
const running = async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/panic`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cmd = process.argv[2] || 'all';
let ok = false;
if (cmd === 'all') ok = nodeOk() && packagesOk();
else if (cmd === 'node') { ok = nodeOk(); if (!ok) console.log(`Node ${process.versions.node} is too old. 22.13 or newer is needed.`); }
else if (cmd === 'packages') ok = packagesOk();
else if (cmd === 'layout') { console.log(fs.existsSync(path.join(ROOT, 'package.json')) ? 'repo' : 'zip'); ok = fs.existsSync(path.join(ROOT, 'package.json')); }
else if (cmd === 'running') ok = await running();
else if (cmd === 'wait') { for (let i = 0; i < 120 && !ok; i++) { ok = await running(); if (!ok) await sleep(500); } }
else if (cmd === 'stop') {
  if (!(await running())) process.exit(1);
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'stop.request'), new Date().toISOString());
  for (let i = 0; i < 40; i++) { await sleep(500); if (!(await running())) { ok = true; break; } }
  if (!ok) { try { const pid = Number(fs.readFileSync(path.join(DATA, 'desk.pid'), 'utf8')); if (pid) { process.kill(pid); ok = true; } } catch {} }
  try { fs.rmSync(path.join(DATA, 'stop.request'), { force: true }); } catch {}
}
process.exit(ok ? 0 : 1);
