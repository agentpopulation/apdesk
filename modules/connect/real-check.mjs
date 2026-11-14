// Real check for Connect (MCP): switch on, add the reference filesystem server (fetched with npx), list its tools,
// call one for real, then switch off and show the server process is gone.
import fs from 'node:fs'; import path from 'node:path';
import { testDesk } from '../../test/helpers/desk.js';
import { alive, descendants } from './proc.js';
const results = []; const check = (name, ok, ev) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev || ''}`); };
const t = await testDesk({ real: true, modules: ['connect'] });
let auto = true;
const approveAll = setInterval(async () => { if (!auto) return; const a = await t.call('/api/approvals'); for (const p of a.json?.pending || []) await t.call(`/api/approvals/${p.id}/approve`, { method: 'POST' }); }, 200);
try {
  check('off: routes answer 404', (await t.call('/api/m/connect/servers')).status === 404, '');
  await t.call('/api/modules/connect/on', { method: 'POST' });
  const st = await t.call('/api/state');
  check('on: menu place Connect and tool mcp_call appear', st.json.modules.find(m => m.id === 'connect')?.on && st.json.tools.some(x => x.name === 'mcp_call'), st.json.modules.find(m => m.id === 'connect').menu.map(m => m.label).join(','));
  const folder = path.join(t.dataDir, 'workspace', 'mcp-demo'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'hello.txt'), 'Hello from the workspace, read by an MCP server.\n');
  const add = await t.call('/api/m/connect/servers', { body: { name: 'Files demo', command: 'npx -y @modelcontextprotocol/server-filesystem {workspace}/mcp-demo' } });
  const s = await t.call(`/api/m/connect/servers/${add.json.id}/start`, { method: 'POST' });
  const job = await t.core.jobs.wait(s.json.jobId, 180000);
  const srv = (await t.call('/api/m/connect/servers')).json.servers[0];
  check('server starts after approval (install) and lists its tools', job.status === 'done' && srv.running && srv.tools.length > 3, `${srv.tools.length} tools: ${srv.tools.map(x => x.name).slice(0, 6).join(', ')}; pid ${srv.pid}`);
  const r = await t.call(`/api/m/connect/servers/${srv.id}/call`, { body: { tool: 'read_text_file', args: { path: path.join(folder, 'hello.txt') } } });
  check('a real tool call returns the file text, marked untrusted', r.json?.ok && /Hello from the workspace/.test(r.json.text) && r.json.untrusted, JSON.stringify(r.json?.text || r.json).slice(0, 90));
  await t.call(`/api/m/connect/servers/${srv.id}/tick`, { body: { tool: 'list_directory', on: true } });
  const viaTool = await t.core.modules.runTool('mcp_files_demo_list_directory', { path: folder }, { agentId: 'coordinator' });
  check('a ticked MCP tool is a Coordinator tool', /hello\.txt/.test(viaTool.text || ''), String(viaTool.text).slice(0, 60));
  // a real model sees the ticked MCP tool, calls it with valid arguments, and the call runs
  const td = (await t.call('/api/state')).json.tools.find(x => x.name === 'mcp_files_demo_list_directory');
  const full = t.core.modules.tools.get('mcp_files_demo_list_directory');
  const mr = await t.core.model.chat({ purpose: 'chat', messages: [{ role: 'user', content: `List the files in the folder ${folder} using the tool.` }], tools: [{ name: full.name, description: full.description, parameters: full.parameters }] });
  const tc = mr.toolCalls?.[0];
  const ran = tc ? await t.core.modules.runTool(tc.name, tc.args, { agentId: 'coordinator' }) : null;
  check('a real model calls the MCP tool and it runs', tc?.name === 'mcp_files_demo_list_directory' && /hello\.txt/.test(ran?.text || ''), `[${mr.label}] called ${tc?.name}(${JSON.stringify(tc?.args)}) -> ${String(ran?.text || mr.text).slice(0, 40)}${td ? '' : ' (tool not in state)'}`);
  await t.call(`/api/m/connect/servers/${srv.id}/tick`, { body: { tool: 'list_directory', on: false } });
  check('unticking removes the tool from the Coordinator at once', !(await t.call('/api/state')).json.tools.some(x => x.name === 'mcp_files_demo_list_directory') && (await t.call('/api/state')).json.tools.some(x => x.name === 'mcp_call'), '');
  // Safety: the owner's class decides, never the server's readOnlyHint; unclassed tools ask as send.person at every level
  auto = false;
  const rt = srv.tools.find(x => x.name === 'read_text_file');
  const pend = async () => (await t.call('/api/approvals')).json.pending;
  const askOnce = async (label) => {
    const p = t.core.modules.runTool('mcp_call', { server: 'Files demo', tool: 'read_text_file', args: { path: path.join(folder, 'hello.txt') } }, { agentId: 'closer' });
    let card; for (let i = 0; i < 60 && !card; i++) { await new Promise(r => setTimeout(r, 50)); card = (await pend()).find(a => a.title.includes('read_text_file')); }
    if (card) await t.call(`/api/approvals/${card.id}/approve`, { method: 'POST' });
    const r = await p; return { card, r };
  };
  const open = await askOnce();
  check('an unclassed tool asks at Open (send.person), even though the server says it only reads', rt?.readOnly === true && open.card?.action === 'send.person' && JSON.stringify(open.card.payload) === JSON.stringify({ server: 'Files demo', tool: 'read_text_file', args: { path: path.join(folder, 'hello.txt') } }) && open.r.ok, `server says read-only: ${rt?.readOnly}; card "${open.card?.title}" action ${open.card?.action}; ran after approval: ${open.r.ok}`);
  await t.call('/api/settings/auto-approve', { body: { window: 15 } });
  const win = await askOnce();
  check('it still asks inside an auto-approve window', win.card?.action === 'send.person' && win.r.ok, `card while auto-approve is on: ${!!win.card}`);
  await t.call('/api/settings/auto-approve', { body: { window: 0 } });
  const noOwner = await t.call(`/api/m/connect/servers/${srv.id}/class`, { body: { tool: 'read_text_file', cls: 'read' }, session: false });
  check('only the owner can lower a tool\'s class', noOwner.status === 403, `without the owner: ${noOwner.status}`);
  await t.call(`/api/m/connect/servers/${srv.id}/class`, { body: { tool: 'read_text_file', cls: 'read' } });
  const before = (await t.call('/api/approvals')).json.recent.length;
  const ro = await t.core.modules.runTool('mcp_call', { server: 'Files demo', tool: 'read_text_file', args: { path: path.join(folder, 'hello.txt') } }, { agentId: 'closer' });
  check('a tool the owner classed "Reads only" runs without asking', ro.ok && /Hello/.test(ro.text) && (await pend()).length === 0 && (await t.call('/api/approvals')).json.recent.length === before, `no approval row added; text "${ro.text.trim().slice(0, 30)}"`);
  auto = true;
  const pids = [srv.pid, ...descendants(srv.pid)];
  await t.call('/api/modules/connect/off', { method: 'POST' });
  await new Promise(r => setTimeout(r, 800));
  check('off: routes 404 and the server process tree is gone', (await t.call('/api/m/connect/servers')).status === 404 && pids.every(p => !alive(p)), `pids ${pids.join(',')} alive: ${pids.filter(alive).join(',') || 'none'}`);
} catch (e) { check('no error', false, e.stack); }
finally { clearInterval(approveAll); await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
