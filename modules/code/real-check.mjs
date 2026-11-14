// Real check for Code and Sandbox: switch on; a real JavaScript run and a real Python run in the process sandbox after an
// approval; a container run when Docker is here; Panic kills a running program; the Aider sidecar makes one real edit
// through the desk's router endpoint (real model) when Aider is installed; switch off.
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { testDesk } from '../../test/helpers/desk.js';
const results = []; const check = (name, ok, ev) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev || ''}`); };
const note = (name, ev) => console.log(`NOTE  ${name}  ${ev}`);
const t = await testDesk({ real: true, modules: ['code'] });
const approved = [];
const approveAll = setInterval(async () => { const a = await t.call('/api/approvals'); for (const p of a.json?.pending || []) { approved.push(p.action); await t.call(`/api/approvals/${p.id}/approve`, { method: 'POST' }); } }, 150);
const runIt = async (body) => { const s = await t.call('/api/m/code/run', { body }); if (!s.json?.runId) return { status: 'refused', note: s.json?.error }; for (let i = 0; i < 600; i++) { const r = (await t.call('/api/m/code/runs/' + s.json.runId)).json; if (!['queued', 'asking', 'running'].includes(r.status)) return r; await new Promise(r => setTimeout(r, 100)); } };
try {
  check('off: routes answer 404', (await t.call('/api/m/code/status')).status === 404, '');
  await t.call('/api/modules/code/on', { method: 'POST' });
  const st = (await t.call('/api/state')).json;
  check('on: menu place Code and tool code_run appear', st.modules.find(m => m.id === 'code').menu[0]?.label === 'Code' && st.tools.some(x => x.name === 'code_run'), '');
  process.env.GEMINI_API_KEY_CHECK = 'secret-value';
  const js = await runIt({ language: 'javascript', code: 'const fs=require("fs");let outside="blocked";try{fs.readFileSync("/etc/hostname");outside="READ"}catch{};console.log("primes:", [2,3,5,7,11].join(","), "keys seen:", Object.keys(process.env).filter(k=>/KEY|TOKEN|SECRET/i.test(k)).length, "outside read:", outside);fs.writeFileSync("result.txt","ok")' });
  check('real JavaScript run in the process sandbox (asked first, no keys, folder only)', js.status === 'done' && /keys seen: 0 outside read: blocked/.test(js.stdout) && approved.includes('shell.run'), `${js.sandboxLabel}: "${js.stdout.trim()}" in ${js.ms} ms, files ${js.files.map(f => f.name).join(',')} in ${js.folder}`);
  const py = await runIt({ language: 'python', sandbox: 'process', code: 'import os, sys\nprint("python", sys.version.split()[0], "sum", sum(range(101)), "keys seen", len([k for k in os.environ if any(w in k.upper() for w in ("KEY","TOKEN","SECRET"))]))' });
  check('real Python run in the process sandbox', py.status === 'done' && /sum 5050 keys seen 0/.test(py.stdout), `"${py.stdout.trim()}" in ${py.ms} ms`);
  const tail = await t.call('/api/m/code/run', { body: { language: 'javascript', code: 'console.log(1);' + ' '.repeat(2100) + 'fetch("http://127.0.0.1:9/x")' } });
  check('a program with a hidden whitespace tail is refused before any card', tail.status === 400 && !(await t.call('/api/approvals')).json.pending.length, tail.json?.error);
  const pyCard = (await t.call('/api/approvals')).json.recent.find(a => a.action === 'shell.run' && /Python/.test(a.title));
  check('the Python card says plainly what the sandbox does not stop, and shows the whole program', /can read files on this PC .* and use the network/.test(pyCard?.detail || '') && /sum\(range\(101\)\)/.test(pyCard?.payload?.code || ''), pyCard?.detail);
  const slow = await runIt({ language: 'python', sandbox: 'process', code: 'import time\nwhile True: time.sleep(0.1)', timeoutMs: 1500 });
  check('time limit stops a run', slow.status === 'failed' && /time limit/.test(slow.note || ''), slow.note);
  const s = (await t.call('/api/m/code/status?refresh=1')).json; const c = s.sandboxes.find(x => x.id === 'container');
  if (c.available && c.images.python) { const d = await runIt({ language: 'python', code: 'print(1)' }); check('Python defaults to the container when Docker is here', d.sandbox === 'container', d.sandboxLabel); }
  else note('Python defaults to the container', `not checked here: ${c.available ? 'the Python image is not on this PC' : c.note}`);
  if (c.available && c.images.javascript) {
    const cr = await runIt({ language: 'javascript', sandbox: 'container', code: 'fetch("https://example.com").then(()=>console.log("NET OPEN")).catch(e=>console.log("network blocked:", e.cause?.code || e.message)); console.log("in container", process.version)' });
    check('container run: no network', cr.status === 'done' && /network blocked/.test(cr.stdout) && /in container/.test(cr.stdout), `${cr.sandboxLabel}: "${cr.stdout.trim().replace(/\n/g, ' | ')}"`);
  } else note('container run', `not checked: ${c.note}`);
  // Panic kills a running program
  const s4 = await t.call('/api/m/code/run', { body: { language: 'javascript', code: 'setInterval(()=>{}, 1000); console.log("started")', timeoutMs: 60000 } });
  for (let i = 0; i < 100; i++) { if ((await t.call('/api/m/code/runs/' + s4.json.runId)).json.status === 'running') break; await new Promise(r => setTimeout(r, 100)); }
  const t0 = Date.now(); await t.call('/api/panic', { method: 'POST', body: {} });
  let r4; for (let i = 0; i < 50; i++) { r4 = (await t.call('/api/m/code/runs/' + s4.json.runId)).json; if (r4.status !== 'running') break; await new Promise(r => setTimeout(r, 100)); }
  check('Panic kills a running program', r4.status === 'stopped', `stopped ${Date.now() - t0} ms after Panic`);
  await t.call('/api/panic/resume', { method: 'POST', body: {} });
  // Aider sidecar through /router/v1 (real model)
  const ai = (await t.call('/api/m/code/aider')).json;
  if (ai.available) {
    const dir = path.join(t.dataDir, 'workspace', 'projects', 'calc'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n');
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' }); g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
    const a = await t.call('/api/m/code/aider', { body: { folder: 'projects/calc', message: 'Fix the bug in add so it returns the sum a + b.', files: ['calc.py'], model: 'Meta-Llama-3_3-70B-Instruct' } });
    const aj = await t.core.jobs.wait(a.json.jobId, 360000);
    const after = fs.readFileSync(path.join(dir, 'calc.py'), 'utf8');
    check('Aider makes one real edit through the desk router', aj.status === 'done' && /return a \+ b/.test(after), `Aider ${ai.version}; job ${aj.status}${aj.error ? ' ' + aj.error.slice(0, 120) : ''}; calc.py now: ${after.trim().replace(/\n\s*/g, ' / ')}`);
  } else note('Aider sidecar', 'not checked: ' + ai.note);
  await t.call('/api/modules/code/off', { method: 'POST' });
  check('off: routes 404, tool gone', (await t.call('/api/m/code/status')).status === 404 && !(await t.call('/api/state')).json.tools.some(x => x.name === 'code_run'), '');
} catch (e) { check('no error', false, e.stack); }
finally { clearInterval(approveAll); await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
