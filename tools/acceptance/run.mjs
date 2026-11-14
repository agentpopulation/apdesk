// Acceptance runner for the 17 acceptance asks, against the real app with a real model.
// Usage: node tools/acceptance/run.mjs [--only 1,3,11] [--shots DIR] [--root DIR [--data DIR] [--backups DIR]] [--url http://127.0.0.1:PORT --data DIR [--backups DIR]] [--strict] [--keep]
//   --root: start, restart and re-start (exit 75) the desk from DIR/app/server.js with cwd DIR (an unzipped release); default the repository root
//   no --url: starts one desk (node app/server.js, every module that loads, real models, fresh temp data folder, free port)
//   --url/--data: runs against a desk that is already running (for example an unzipped release); restarts use <data>/desk.pid
//   --strict: a module that is missing, off or broken, or a screen hook that is not found, is a FAIL (use before a release)
// Prints one line per ask, writes tools/acceptance/RESULTS.md and FAILURES.md. Exit code 0 only when nothing fails.
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Desk, HERE, APD, appRequire, launch, openDesk, sleep, tmp, makePairer, pairingCheck } from './lib.mjs';
import { ASKS, OWNERS, TITLES, LABELS, NotChecked, o1bCheck } from './asks.mjs';

const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
if (arg('help')) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 7).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
const only = String(arg('only', '')).split(',').map(Number).filter(Boolean);
const list = only.length ? only : [...Object.keys(ASKS).map(Number).filter(n => n !== 17), 17];   // ask 17 (delete the data folder, restore) always last
const shots = path.resolve(arg('shots', tmp('apd-accept-shots-'))); fs.mkdirSync(shots, { recursive: true });
const strict = !!arg('strict', false), keep = !!arg('keep', false);
const askTimeout = Number(arg('ask-timeout-min', 40)) * 60000;
const root = arg('root') ? path.resolve(arg('root')) : APD; const runStart = Date.now();

process.env.NODE_NO_WARNINGS = '1';
let desk; const runDir = tmp('apd-accept-'); let browser = await launch();
const getBrowser = async () => { if (!browser?.isConnected()) browser = await launch(); return browser; };
if (arg('url')) {
  if (!arg('data')) { console.error('--url needs --data <the desk\'s data folder>'); process.exit(2); }
  desk = new Desk({ url: arg('url'), root, data: path.resolve(arg('data')), backups: arg('backups') ? path.resolve(arg('backups')) : null, logFile: path.join(runDir, 'desk.log') });
  desk.pairer = makePairer(getBrowser, desk);
  await desk.waitUp(15000);
  await desk.call('/api/settings', { body: { 'model.defaultChain': ['gemini', 'router', 'openrouter', 'keyed', 'ollama'] } });
} else {
  desk = new Desk({ root, data: arg('data') ? path.resolve(arg('data')) : path.join(runDir, 'data'), backups: arg('backups') ? path.resolve(arg('backups')) : path.join(runDir, 'backups'), logFile: path.join(runDir, 'desk.log') });
  desk.pairer = makePairer(getBrowser, desk);
  await desk.start();
}
const startedAt = new Date();
const ist = (d) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' });
const mods = await desk.modules();
console.log(`desk ${desk.url}  data ${desk.data}  log ${desk.logFile}`);
console.log(`modules: ${mods.map(m => `${m.id}${m.on ? '' : m.error ? '(broken: ' + m.error.slice(0, 60) + ')' : '(off)'}`).join(', ') || 'none'}`);
console.log(`screenshots: ${shots}`);
const pairing = await pairingCheck(browser, desk).catch(e => ({ ok: false, evidence: 'check failed: ' + e.message }));
console.log(`PAIRING ${pairing.ok ? 'PASS' : 'FAIL'}  ${pairing.evidence}\n`);
const t = {
  desk, shots, strict, get browser() { return browser; }, page: null, ctx: null,
  async reopen(hash = '#/chat') { if (!browser?.isConnected()) browser = await launch(); const o = await openDesk(browser, desk, { hash }); t.ctx = o.ctx; t.page = o.page; return o; },
  async closeBrowser() { try { await t.ctx?.close(); } catch {} t.ctx = null; t.page = null; },
};
const results = [];
const usageMap = async () => { const m = new Map(); try { for (const x of (await desk.call('/api/model/usage')).json?.today || []) m.set(`${x.provider} · ${x.model}`, x.ok || 0); } catch {} return m; };
const callsStart = await desk.callsToday().catch(() => 0);
async function runAsk(n) {
  const r = { n: LABELS[n] || n, title: TITLES[n], owner: OWNERS[n], state: 'FAIL', evidence: '', how: '', shot: null };
  const c0 = await desk.callsToday().catch(() => 0); const u0 = await usageMap(); const t0 = Date.now(); r.t0 = t0;
  Object.assign(t, { how: '', shot: null, shot2: null, did: '', saw: '', expected: '', repro: '', details: null, extra: null });
  try {
    await desk.waitUp(30000);
    await t.reopen();
    const out = await Promise.race([ASKS[n](t), sleep(askTimeout).then(() => { throw new Error(`ask took longer than ${askTimeout / 60000} min`); })]);
    r.state = out.ok ? 'PASS' : 'FAIL'; r.evidence = out.evidence;
  } catch (e) {
    if (e instanceof NotChecked) { r.state = 'NOT CHECKED'; r.evidence = e.message; }
    else { r.state = 'FAIL'; r.evidence = 'runner stopped: ' + String(e.message || e).split('\n')[0].slice(0, 200); r.stack = e.stack; if (t.page) t.shot = t.shot || await t.page.screenshot({ path: path.join(shots, `ask${String(n).padStart(2, '0')}_error.png`) }).then(() => path.join(shots, `ask${String(n).padStart(2, '0')}_error.png`)).catch(() => null); }
  }
  try { if ((await desk.call('/api/panic')).json?.halted) await desk.call('/api/panic/resume', { method: 'POST' }); } catch {}
  await t.closeBrowser();
  r.extra = t.extra;
  Object.assign(r, { how: t.how || r.how, shot: t.shot, shot2: t.shot2, did: t.did, saw: t.saw, expected: t.expected, repro: t.repro, details: t.details, secs: Math.round((Date.now() - t0) / 1000) });
  r.calls = Math.max(0, (await desk.callsToday().catch(() => c0)) - c0);
  const u1 = await usageMap(); r.models = [...u1].filter(([k, v]) => v > (u0.get(k) || 0)).map(([k, v]) => `${k} x${v - (u0.get(k) || 0)}`).join(', ');
  r.quotaRefusals = ((await desk.call('/api/model/usage').catch(() => ({}))).json?.recent || []).filter(c => new Date(c.at).getTime() >= t0 && !c.ok && /429|quota/i.test(c.error || '')).length;
  return r;
}
for (const n of list) {
  // O1b is judged over the whole run, so just before ask 17 deletes the data folder
  if (n === 17 && desk.o1At) { try { const x = await o1bCheck(t); const e = { n: x.n, title: x.title, owner: 'chat (Coordinator), flows', state: x.ok ? 'PASS' : 'FAIL', evidence: x.evidence, how: 'HTTP: jobs, Sales leads and every chat message read at the end of the run', shot: null, models: '', calls: 0, did: 'read the jobs list, the Sales pipeline and every chat message after the offline ask', saw: x.evidence, expected: 'no bakery lead search in any later turn, no bakery in the pipeline, no bakery table in the chat' }; results.push(e); console.log(`ASK ${String(x.n).padEnd(2)} ${e.state.padEnd(11)} ${e.evidence}`); } catch (e) { console.log('O1b failed to run: ' + e.message); } }
  let r = await runAsk(n);
  // capacity: a FAIL while Gemini refused calls for quota is retried once after a minute; the first try stays in the evidence
  if (arg('retry-capacity') && r.state === 'FAIL' && r.quotaRefusals > 0 && ![13, 17].includes(n)) {
    console.log(`ASK ${n}  failed while Gemini refused ${r.quotaRefusals} call(s) for quota: waiting 60 s, trying once more (first try: ${r.evidence.slice(0, 160)})`);
    await sleep(60000); const r2 = await runAsk(n);
    r2.evidence += ` (second try after a capacity failure; first try: ${r.evidence.slice(0, 200)})`; r2.calls += r.calls; r2.firstTry = r; r = r2;
  }
  results.push(r);
  console.log(`ASK ${String(r.n).padEnd(2)} ${r.state.padEnd(11)} ${r.evidence.replace(/\s+/g, ' ')}${r.models ? '  [models: ' + r.models + ']' : ''}`);
  try { for (const x of r.extra || []) { const e = { n: x.n, title: x.title, owner: r.owner, state: x.ok ? 'PASS' : 'FAIL', evidence: x.evidence, how: r.how, shot: x.shot, models: r.models, calls: 0, did: x.evidence, saw: x.evidence }; results.push(e); console.log(`ASK ${String(x.n).padEnd(2)} ${e.state.padEnd(11)} ${e.evidence}`); } } catch (e) { console.log('extra result failed: ' + e.message); }
}
const totalCalls = results.reduce((s, r) => s + (r.calls || 0), 0);
// every reply that carries "No file was saved." (it should appear only where a false file line was removed)
let noFileLines = [];
try {
  const chats = (await desk.call('/api/m/chat/chats')).json; const list = Array.isArray(chats) ? chats : (chats?.chats || chats?.items || []);
  for (const c of list) { const j = (await desk.call(`/api/m/chat/chats/${encodeURIComponent(c.id)}/messages?limit=500`)).json; const ms = Array.isArray(j) ? j : (j?.messages || j?.items || []);
    for (const m of ms) if (m.role === 'assistant' && /No file was saved\./.test(m.text || '')) noFileLines.push(`${c.id} #${m.id} [${m.label || ''}] "${String(m.text).replace(/\s+/g, ' ').slice(0, 140)}"`); }
} catch (e) { noFileLines = ['scan failed: ' + e.message]; }
console.log(`replies carrying "No file was saved.": ${noFileLines.length}`); for (const l of noFileLines) console.log('  ' + l);
console.log(`\nmodel calls recorded by the desk during the run: ${totalCalls}`);

// ---------------------------------------------------------------- reports
const md = [];
md.push(`# Acceptance results`, '', `- Run: ${ist(startedAt)} to ${ist(new Date())} IST`, `- Desk: ${desk.url} ${arg('url') ? '(already running)' : '(started by the runner)'}, data ${desk.data}`, `- Modules on: ${mods.filter(m => m.on).map(m => m.id).join(', ') || 'none'}; missing or off: everything else`, `- Mode: ${strict ? 'strict (missing modules fail)' : 'build (missing modules are NOT CHECKED)'}; model calls recorded: ${totalCalls}`, `- Screenshots: ${shots}`, `- Pairing check: ${pairing.ok ? 'PASS' : 'FAIL'}: ${pairing.evidence}`, `- Total time: ${Math.round((Date.now() - runStart) / 60000)} min`, `- Replies carrying "No file was saved.": ${noFileLines.length}${noFileLines.length ? ': ' + noFileLines.join(' | ') : ''}`, `- Desk processes (each start, restart and exit-75 restart): ${(desk.starts || []).map(x => `${x.at.slice(11, 19)} pid ${x.pid}: ${x.procCmd || x.server} (cwd ${x.procCwd || x.cwd})`).join('; ') || 'external'}`, '');
md.push('| Ask | State | Evidence | Models that answered (ok calls) | How it was checked | Screenshot |', '|---|---|---|---|---|---|');
for (const r of results) md.push(`| ${r.n}. ${r.title} | **${r.state}** | ${String(r.evidence).replace(/\|/g, '/').replace(/\n/g, ' ')} | ${r.models || '-'} | ${(r.how || '-').replace(/\|/g, '/')} | ${r.shot || '-'} |`);
md.push('', `PASS ${results.filter(r => r.state === 'PASS').length} · FAIL ${results.filter(r => r.state === 'FAIL').length} · NOT CHECKED ${results.filter(r => r.state === 'NOT CHECKED').length}`, '');
fs.writeFileSync(path.join(HERE, 'RESULTS.md'), md.join('\n'));

const fl = ['# Acceptance failures', '', `Run ${ist(startedAt)} IST. One section per failing ask; Area is the part of the app the ask checks.`, ''];
const fails = results.filter(r => r.state === 'FAIL');
if (!fails.length) fl.push('No failures in this run.');
for (const r of fails) {
  fl.push(`## Ask ${r.n}: ${r.title}`, '', `- **Area:** ${r.owner}`, `- **What I did:** ${r.did || '(the runner stopped before it got far: see below)'}`, `- **What I saw:** ${r.saw || r.evidence}`, `- **What I expected:** ${r.expected || TITLES[r.n]}`, `- **Screenshot:** ${[r.shot, r.shot2].filter(Boolean).join(', ') || 'none'}`, `- **Smallest reproduction:** ${r.repro || '-'}`, `- **How checked:** ${r.how || '-'}`, `- **Models that answered:** ${r.models || '-'}`);
  if (r.details?.length) fl.push('- **Each failing combination:**', ...r.details.slice(0, 60).map(d => `  - ${d}`));
  if (r.stack) fl.push('- **Runner error:** `' + r.stack.split('\n').slice(0, 2).join(' ').slice(0, 300) + '`');
  fl.push('');
}
fs.writeFileSync(path.join(HERE, 'FAILURES.md'), fl.join('\n'));
console.log(`wrote ${path.join(HERE, 'RESULTS.md')} and FAILURES.md`);

await browser?.close().catch(() => {});
if (!arg('url')) { await desk.stop().catch(() => {}); if (!keep) fs.rmSync(path.join(runDir, 'data'), { recursive: true, force: true }); }
process.exit(fails.length ? 1 : 0);
