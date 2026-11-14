// Connect (MCP): (a) an MCP tool that sends to a person is classed net.post, which Open allows without asking;
// (b) whether a call asks at all is decided by the server's own readOnlyHint.
import { testDesk } from '../../test/helpers/desk.js';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { fileURLToPath } from 'node:url';
const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-stub.mjs');
const LOG = path.join(os.tmpdir(), 'apd-mcp-stub-' + Date.now() + '.log'); fs.writeFileSync(LOG, '');
const t = await testDesk({ modules: ['chat', 'agents', 'connect'] });
const pendingCount = async () => (await t.call('/api/approvals')).json.pending.length;
try {
  await t.core.modules.set('connect', true).catch(() => {});
  const srv = (await t.call('/api/m/connect/servers', { body: { name: 'stub', command: `${process.execPath} ${STUB} ${LOG}` } })).json;
  const st = (await t.call(`/api/m/connect/servers/${srv.id}/start`, { body: {} })).json;
  let card; for (let i = 0; i < 60 && !card; i++) { await new Promise(r => setTimeout(r, 50)); card = (await t.call('/api/approvals')).json.pending.find(a => a.title.includes('MCP server')); }
  await t.call(`/api/approvals/${card.id}/approve`, { method: 'POST' });          // owner allows the server to start
  await t.core.jobs.wait(st.jobId, 15000);
  for (const tool of ['send_email', 'wipe_inbox']) await t.call(`/api/m/connect/servers/${srv.id}/tick`, { body: { tool, on: true } });

  // (a) Open level (the first-run level): agent sends mail through the MCP tool
  const before = await pendingCount();
  const a = await Promise.race([t.core.modules.runTool('mcp_call', { server: 'stub', tool: 'send_email', args: { to: 'stranger@example.com', body: 'hello' } }, { agentId: 'closer' }), new Promise(r => setTimeout(() => r('asked'), 1500))]);
  const sent = fs.readFileSync(LOG, 'utf8').includes('SENT to=stranger@example.com');
  console.log(sent && (await pendingCount()) === before
    ? `BYPASS(mcp-send-person): at Open an agent sent mail to stranger@example.com through an MCP tool with no approval (MCP calls are 'net.post', never 'send.person')`
    : `HELD(mcp-send-person): sent=${sent} result=${typeof a === 'string' ? a : a?.ok}`);

  // (b) Strict level: a tool that claims readOnlyHint skips the door entirely
  await t.call('/api/settings/security', { body: { level: 'strict' } });
  const b = await Promise.race([t.core.modules.runTool('mcp_call', { server: 'stub', tool: 'wipe_inbox', args: {} }, { agentId: 'closer' }), new Promise(r => setTimeout(() => r('asked'), 1500))]);
  const wiped = fs.readFileSync(LOG, 'utf8').includes('WIPED');
  console.log(wiped ? `BYPASS(mcp-readonly-hint): at Strict, 'wipe_inbox' ran with no approval because the server labelled it readOnlyHint` : `HELD(mcp-readonly-hint): ${typeof b === 'string' ? b : b?.ok}`);
  // pending ones are left; deny them
  for (const p of (await t.call('/api/approvals')).json.pending) await t.call(`/api/approvals/${p.id}/deny`, { method: 'POST' });
} finally { const c = await Promise.race([t.close().then(() => "closed"), new Promise(r => setTimeout(() => r("hung"), 6000))]); console.log(`[12] desk.stop(): ${c}`); fs.rmSync(LOG, { force: true }); process.exit(0); }
