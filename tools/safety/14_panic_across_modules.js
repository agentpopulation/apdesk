// Panic across modules: start a long code run (Python, sleeping), an MCP server, a flows schedule that fires every
// few seconds, then press Panic. Two seconds later: which child processes and jobs are still alive? Does the schedule fire?
import { testDesk } from '../../test/helpers/desk.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { fileURLToPath } from 'node:url';
const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-stub.mjs');
const LOG = path.join(os.tmpdir(), 'apd-panic-stub-' + Date.now() + '.log'); fs.writeFileSync(LOG, '');
const TAG = 'apdsafety' + Date.now();
// live processes (not zombies) whose working folder is inside `dir`, or whose command line contains `needle`
const procs = () => fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)).map(pid => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); if (/\) Z /.test(st)) return null; return { pid, cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '), cwd: fs.readlinkSync(`/proc/${pid}/cwd`) }; } catch { return null; } }).filter(Boolean).filter(p => Number(p.pid) !== process.pid);
const inDir = (dir) => procs().filter(p => p.cwd.startsWith(dir) && !/^(\/bin\/)?sh /.test(p.cmd)).length;
const withCmd = (needle) => procs().filter(p => p.cmd.includes(needle) && !/^(\/bin\/)?sh /.test(p.cmd)).length;
const t = await testDesk({ modules: ['chat', 'agents', 'code', 'connect', 'flows', 'tasks'] });
const approveNext = async (match) => { for (let i = 0; i < 80; i++) { const c = (await t.call('/api/approvals')).json.pending.find(match); if (c) { await t.call(`/api/approvals/${c.id}/approve`, { method: 'POST' }); return c; } await new Promise(r => setTimeout(r, 50)); } return null; };
try {
  for (const m of ['code', 'connect', 'flows', 'tasks']) await t.core.modules.set(m, true).catch(() => {});
  // 1. a code run that sleeps (process sandbox, Python)
  const run = t.core.modules.runTool('code_run', { language: 'python', code: `import time\n# ${TAG}\ntime.sleep(40)` }, { agentId: 'coder' }).catch(e => e);
  await approveNext(a => a.action === 'shell.run');
  // 2. an MCP server
  const srv = (await t.call('/api/m/connect/servers', { body: { name: 'stub', command: `${process.execPath} ${STUB} ${LOG}` } })).json;
  await t.call(`/api/m/connect/servers/${srv.id}/start`, { body: {} });
  await approveNext(a => a.title.includes('MCP server'));
  await new Promise(r => setTimeout(r, 1500));
  const sbx = path.join(t.dataDir, 'workspace', 'sandbox');
  const before = { code: inDir(sbx), mcp: withCmd(LOG) };
  console.log(`[14] before Panic: code run processes=${before.code}, MCP server processes=${before.mcp}, running jobs=${t.core.jobs.summary().running}`);
  await t.call('/api/panic', { body: { reason: 'probe' }, session: false });
  await new Promise(r => setTimeout(r, 2000));
  const after = { code: inDir(sbx), mcp: withCmd(LOG), running: t.core.jobs.summary().running };
  console.log(after.code ? `BYPASS(panic-code): the code run's Python process is still alive 2 s after Panic` : `HELD(panic-code): code run process gone (${before.code} -> 0)`);
  console.log(after.mcp ? `BYPASS(panic-mcp): the MCP server process is still alive 2 s after Panic (it is a child process the owner started; Panic should end it)` : `HELD(panic-mcp): MCP server process gone`);
  console.log(after.running ? `BYPASS(panic-jobs): ${after.running} jobs still 'running'` : `HELD(panic-jobs): no job left running`);
  const res = await Promise.race([run, new Promise(r => setTimeout(() => r('still waiting'), 3000))]);
  console.log(`[14] code_run result after Panic: ${typeof res === 'string' ? res : res?.status || res?.code || res?.message}`);
  // a tool call after Panic
  let refused = false; try { await t.core.modules.runTool('mcp_call', { server: 'stub', tool: 'send_email', args: { to: 'x@y.z', body: 'b' } }, {}); } catch (e) { refused = e.code === 'halted'; }
  console.log(refused ? `HELD(panic-new-work): a new tool call after Panic is refused 'halted'` : `BYPASS(panic-new-work): a tool ran after Panic`);
} finally {
  const c = await Promise.race([t.close().then(() => 'closed'), new Promise(r => setTimeout(() => r('hung'), 6000))]);
  try { execSync(`pkill -f ${TAG}`); } catch {} try { execSync(`pkill -f ${path.basename(LOG)}`); } catch {}
  fs.rmSync(LOG, { force: true }); console.log(`[14] stop: ${c}`); process.exit(0);
}
