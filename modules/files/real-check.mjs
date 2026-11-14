// Real checks for Files and Knowledge (ask 15 and the file safety rules).
//   node modules/files/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testDesk } from '../../test/helpers/desk.js';

const results = [];
const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${evidence}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pretend home folder with a Downloads folder, so "This PC" places are real folders but not the session's own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-files-home-'));
fs.mkdirSync(path.join(home, 'Downloads')); fs.writeFileSync(path.join(home, 'Downloads', 'private.txt'), 'bank statement');
process.env.APD_EXPLORER_HOME = home;

const t = await testDesk({ real: true, modules: ['files', 'office'] });
const ws = path.join(t.dataDir, 'workspace');
const pending = async () => (await t.call('/api/approvals')).json.pending;
try {
  // ---- ask 15 with a real model choosing file_write ----
  const tool = t.core.modules.tools.get('file_write');
  let r = null; let err = null;
  for (let i = 0; i < 3 && !r?.toolCalls?.length; i++) {
    try {
      r = await t.core.model.chat({ purpose: 'chat', tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }], messages: [
        { role: 'system', content: 'You are a desk assistant with tools. Use file_write to save files the owner asks for.' },
        { role: 'user', content: 'Save a short packing list for a two-day trip to Pune as drafts/packing-list.md' }] });
    } catch (e) { err = e; await sleep(30000); }
  }
  const call = r?.toolCalls?.find((c) => c.name === 'file_write');
  check('a real model asks to write a file with file_write', !!call, call ? `[${r.label}] path=${call.args.path} ${String(call.args.content).length} chars` : `no tool call: ${err?.message || String(r?.text).slice(0, 100)}`);
  const args = call?.args || { path: 'drafts/packing-list.md', content: '- shirts' };

  // Open: writes, no question
  const open = await t.core.modules.runTool('file_write', args, { agentId: 'coordinator', jobId: 'job_open' });
  check('ask 15: at Open file_write writes without asking', open.ok && (await pending()).length === 0 && fs.existsSync(path.join(ws, ...open.path.split('/'))) && open.cards?.[0]?.kind === 'file', `${open.path} ${open.size} bytes, card ${open.cards?.[0]?.kind}, waiting 0`);

  // Careful: the first write in a job asks once; the owner approves; the second write in that job does not ask
  await t.call('/api/settings/security', { body: { level: 'careful' } });
  const first = t.core.modules.runTool('file_write', { ...args, path: 'drafts/careful-1.md' }, { agentId: 'coordinator', jobId: 'job_careful' });
  await sleep(150);
  const p1 = await pending();
  check('ask 15: at Careful the first write in a job asks the owner', p1.length === 1 && p1[0].action === 'file.write' && !fs.existsSync(path.join(ws, 'drafts', 'careful-1.md')), `waiting: ${p1.map((p) => p.title).join(', ')}`);
  await t.call(`/api/approvals/${p1[0]?.id}/approve`, { method: 'POST' });
  const firstOut = await first;
  const second = await Promise.race([t.core.modules.runTool('file_write', { ...args, path: 'drafts/careful-2.md' }, { agentId: 'coordinator', jobId: 'job_careful' }), sleep(2000).then(() => ({ timedOut: true }))]);
  check('ask 15: the owner approves once; the second write in the same job does not ask', firstOut.ok && second.ok && (await pending()).length === 0 && fs.existsSync(path.join(ws, 'drafts', 'careful-2.md')), `first ${firstOut.path}, second ${second.path || JSON.stringify(second)}`);
  const other = t.core.modules.runTool('file_write', { ...args, path: 'drafts/careful-3.md' }, { agentId: 'coordinator', jobId: 'job_other' });
  await sleep(150);
  const p3 = await pending();
  check('ask 15: a different job asks again', p3.length === 1, `waiting: ${p3.length}`);
  await t.call(`/api/approvals/${p3[0]?.id}/deny`, { method: 'POST' });
  const denied = await other;
  check('a denied write writes nothing', !denied.ok && !fs.existsSync(path.join(ws, 'drafts', 'careful-3.md')), denied.error);
  await t.call('/api/settings/security', { body: { level: 'open' } });

  // ---- Bin: delete never erases, restore puts it back ----
  const del = await t.call('/api/m/files/recycle', { body: { root: 'home', paths: [open.path] } });
  const binList = (await t.call('/api/m/files/list?root=bin')).json.items;
  check('Delete moves the file to the Bin', del.status === 200 && !fs.existsSync(path.join(ws, ...open.path.split('/'))) && binList.length === 1 && fs.existsSync(path.join(t.dataDir, 'bin', 'payloads', binList[0].binId)), `bin: ${binList.map((b) => `${b.name} from ${b.from}`).join(', ')}`);
  const rest = await t.call('/api/m/files/restore', { body: { id: binList[0]?.binId } });
  check('Restore puts it back where it was', rest.status === 200 && fs.readFileSync(path.join(ws, ...open.path.split('/')), 'utf8') === String(args.content) && (await t.call('/api/m/files/list?root=bin')).json.items.length === 0, `${rest.json?.path}`);
  check('Delete needs the owner', (await t.call('/api/m/files/recycle', { body: { root: 'home', paths: [open.path] }, session: false })).status === 403, '403 without the session');

  // ---- locked folders ----
  const dl = path.join(home, 'Downloads');
  const nonOwner = await t.call('/api/m/files/grants', { body: { root: 'downloads' }, session: false });
  check('a locked folder stays locked for a non-owner request', nonOwner.status === 403 && (await pending()).length === 0 && (await t.call('/api/m/files/list?root=downloads')).status === 403, `grant without session: ${nonOwner.status}, approvals raised: 0`);
  const agentRead = await t.core.modules.runTool('file_read', { path: path.join(dl, 'private.txt') }, { agentId: 'scout' });
  check('an agent cannot read a locked folder', !agentRead.ok && !/bank/.test(JSON.stringify(agentRead)), agentRead.error);
  const g = await t.call('/api/m/files/grants', { body: { root: 'downloads' } });
  const pg = await pending();
  check('the owner asking to open Downloads raises a file.read.outside approval', g.json.pending && pg.length === 1 && pg[0].action === 'file.read.outside' && pg[0].payload.folder === dl, `${pg[0]?.title}`);
  await t.call(`/api/approvals/${pg[0]?.id}/approve`, { method: 'POST' });
  await sleep(100);
  const listed = await t.call('/api/m/files/list?root=downloads');
  const agentRead2 = await t.core.modules.runTool('file_read', { path: path.join(dl, 'private.txt') }, { agentId: 'scout' });
  check('after the owner approves, Files lists it and agents may read it', listed.status === 200 && listed.json.items.some((i) => i.name === 'private.txt') && agentRead2.ok, `${listed.json.items?.map((i) => i.name).join(',')}; agent read ${agentRead2.ok}`);

  // ---- path escapes ----
  const esc1 = await t.core.modules.runTool('file_write', { path: '../apd.sqlite', content: 'x' }, { agentId: 'scout' });
  const esc2 = await t.core.modules.runTool('file_read', { path: path.join(t.dataDir, 'apd.sqlite') }, { agentId: 'scout' });
  const esc3 = await t.call('/api/m/files/list?root=home&path=' + encodeURIComponent('../'));
  fs.symlinkSync(t.dataDir, path.join(ws, 'sneaky'));
  const esc4 = await t.call('/api/m/files/list?root=home&path=sneaky');
  const esc5 = await t.core.modules.runTool('file_read', { path: 'sneaky/apd.sqlite' }, { agentId: 'scout' });
  const esc6 = await t.call('/api/m/files/list?root=home');
  check('path escapes are refused (.., absolute, symlink into the data folder)', !esc1.ok && !esc2.ok && esc3.status === 400 && esc4.status === 403 && !esc5.ok && !esc6.json.items.some((i) => i.name === 'sneaky'),
    `write ../: ${esc1.error} | read db: ${esc2.error} | list ../: ${esc3.status} | link: ${esc4.status}, ${esc5.error}`);

  // ---- Knowledge ----
  const up = await fetch(`${t.base}/api/m/files/upload?root=home&path=knowledge&name=${encodeURIComponent('solar-notes.md')}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-apd-session': t.desk.session }, body: '# Rooftop solar\n\nThe Nagpur warehouse roof can carry 220 kilowatts of panels after the 2025 retrofit.\n' });
  const office = t.core.modules.api('office');
  await office.makeDoc({ title: 'Cooling report', markdown: '# Cooling\n\nThe chiller in Bay 4 uses ammonia refrigerant and was serviced in March.\n', format: 'pdf', dir: 'knowledge' });
  await t.call('/api/m/files/knowledge/reindex', { body: {} });
  const k1 = await t.core.modules.runTool('knowledge_search', { query: 'how many kilowatts can the warehouse roof carry' });
  const k2 = await t.core.modules.api('files').knowledgeSearch('ammonia chiller');
  check('Knowledge: an uploaded Markdown file is found with its passage', up.status === 200 && k1.passages?.[0]?.file === 'knowledge/solar-notes.md' && /220 kilowatts/.test(k1.passages[0].text), `${k1.passages?.[0]?.file}: ${k1.passages?.[0]?.text.replace(/\s+/g, ' ').slice(0, 80)}`);
  check('Knowledge: a PDF is read and found with its passage', k2[0]?.file === 'knowledge/cooling-report.pdf' && /ammonia/.test(k2[0].text), `${k2[0]?.file} p${k2[0]?.page}: ${k2[0]?.snippet}`);
} finally { await t.close(); fs.rmSync(home, { recursive: true, force: true }); }
process.exit(results.every(Boolean) ? 0 : 1);
