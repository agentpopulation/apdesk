// Real checks for Tasks (ask 6), restart and Panic. Needs a real model:  node modules/tasks/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
// Desk A runs in its own process with no browser attached; it is killed hard (like the PC losing power) and desk B
// starts on the same data folder.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = pathToFileURL(path.join(here, '..', '..', 'app', 'server.js')).href;
const has = (m) => fs.existsSync(path.join(here, '..', m, 'module.json'));
const mods = ['tasks', 'flows', ...(!process.argv.includes('--no-chat') && has('chat') ? ['chat', 'agents'].filter(has) : [])];
const results = [];
const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${evidence}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ist = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'none';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-tasks-'));
const boot = `import { createDesk } from ${JSON.stringify(serverJs)};
const desk = await createDesk({ dataDir: ${JSON.stringify(dataDir)}, port: 0, quiet: true, modules: ${JSON.stringify(mods)} });
desk.core.settings.set('model.defaultChain', ['gemini', 'router', 'openrouter', 'keyed', 'ollama']);
await desk.start(); console.log('READY ' + JSON.stringify({ url: desk.url(), session: desk.session }));`;

function startA() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', boot], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = ''; p.stdout.on('data', (d) => { buf += d; const m = buf.match(/READY (\{.*\})/); if (m) resolve({ p, ...JSON.parse(m[1]) }); });
    p.on('exit', (c) => reject(new Error('desk A exited ' + c)));
  });
}
const api = (d) => async (p, body, method) => { const r = await fetch(d.url + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-apd-session': d.session }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); try { return JSON.parse(t); } catch { return { text: t }; } };
async function waitJob(call, id, ms = 150_000) { const end = Date.now() + ms; let j; while (Date.now() < end) { j = await call('/api/jobs/' + id); if (!['running', 'waiting'].includes(j.status)) return j; await sleep(1000); } return j; }

let B = null;
try {
  const A = await startA(); const a = api(A);
  console.log('desk A (own process, no browser) modules:', (await a('/api/modules')).modules.filter(m => m.on).map(m => m.id).join(', '));
  // 6: a task started through the API, nobody watching; its finished work waits in the job (and the chat)
  const t1 = await a('/api/m/tasks/create', { title: 'Three facts about monsoons', prompt: 'Give three short facts about the Indian monsoon, one line each.', agentId: 'scout' });
  const d1 = await waitJob(a, t1.id);
  const ans = d1.output?.answer || d1.output?.text || '';
  check('6 a task started with no browser finishes and its result waits in the job', d1.status === 'done' && ans.length > 20, `[${d1.output?.label}] "${ans.replace(/\s+/g, ' ').slice(0, 110)}" delivered to ${d1.output?.delivered}${d1.output?.chatId ? ' (chat kept)' : ''}`);
  if (d1.output?.chatId && mods.includes('chat')) {
    const chats = await a('/api/m/chat/chats');
    const hit = (chats.chats || []).find(x => x.id === d1.output.chatId);
    check('6 the same answer waits in its chat', !!hit && JSON.stringify(hit).includes(ans.replace(/\s+/g, ' ').trim().slice(0, 20).split(' ')[0]), `chat "${hit?.title || 'Scout (direct)'}" last: "${String(hit?.last?.text || hit?.last || '').replace(/\s+/g, ' ').slice(0, 80)}"`);
  }
  // a schedule stored on A, one one-time run due while A is down, and a long task running when A dies
  const daily = await a('/api/m/flows/schedules', { title: 'Morning brief', when: 'every morning at 8', prompt: 'brief me' });
  const soon = await a('/api/m/flows/schedules', { title: 'While off', when: 'in 1 minute', prompt: 'Say hi' });
  await a('/api/m/flows/schedules/' + soon.id, { at: new Date(Date.now() + 8_000).toISOString() }, 'PATCH');
  const long = await a('/api/m/tasks/create', { title: 'Long essay', prompt: 'Write a 3000-word essay on the history of tea in India, with ten sections.', agentId: 'coordinator' });
  let before = await a('/api/jobs/' + long.id);
  for (let i = 0; i < 20 && before.status === 'running' && !(before.progress > 0.08 || /Writing|working/i.test(before.detail || '')); i++) { await sleep(150); before = await a('/api/jobs/' + long.id); }
  A.p.kill('SIGKILL'); await sleep(15_000);
  console.log(`      desk A killed while "${before.title}" was ${before.status}; 15 s later desk B starts on the same data folder`);
  const { createDesk } = await import(serverJs);
  B = await createDesk({ dataDir, port: 0, quiet: true, modules: mods, env: process.env });
  B.core.settings.set('model.defaultChain', ['gemini', 'router', 'openrouter', 'keyed', 'ollama']);
  await B.start(); const b = api({ url: B.url(), session: B.session });
  const lj = await b('/api/jobs/' + long.id);
  check('restart: the task that was running is marked interrupted, not resumed', before.status === 'running' && lj.status === 'interrupted', `status before kill ${before.status}, after restart ${lj.status}`);
  const sch = (await b('/api/m/flows/schedules')).schedules;
  const d = sch.find(s => s.id === daily.id); const w = sch.find(s => s.id === soon.id);
  check('restart: schedules are re-armed', d?.armed && new Date(d.nextRun).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) === '08:00', `"${d?.title}" ${d?.when}, next ${ist(d?.nextRun)} IST`);
  check('restart: a run due while the desk was off is shown as missed, not replayed', w?.missedAt && !w.lastJob && w.lastStatus === 'missed', `"${w?.title}" missed at ${ist(w?.missedAt)}, last job: ${w?.lastJob || 'none'}`);
  // Run again, then Panic while that task and a firing schedule are both running
  const fireJob = await b(`/api/m/flows/schedules/${daily.id}/run`, {});
  const again = await b(`/api/m/tasks/jobs/${long.id}/again`, {});
  check('restart: Run again starts the interrupted task afresh', again?.id && again.id !== long.id && again.status === 'running', `new job ${again?.status}`);
  await sleep(1200);
  const r1 = await b('/api/jobs/' + again.id); const r2 = await b('/api/jobs/' + fireJob.id);
  const t0 = Date.now(); await b('/api/panic', { reason: 'check' });
  await sleep(500);
  const s1 = await b('/api/jobs/' + again.id); const s2 = await b('/api/jobs/' + fireJob.id);
  check('Panic stops a running task and a firing schedule', r1.status === 'running' && r2.status === 'running' && s1.status === 'stopped' && s2.status === 'stopped', `before: task ${r1.status}, schedule run ${r2.status}; ${Date.now() - t0} ms after Panic: task ${s1.status}, schedule run ${s2.status}`);
  const refused = await b(`/api/m/flows/schedules/${daily.id}/run`, {});
  check('while stopped, a schedule cannot start', !!refused.error, refused.error || '');
  await b('/api/panic/resume', {});
  // 6 in a real browser: start from the Tasks page, close the browser, come back to the finished work
  let chromium = null; try { chromium = (await import('node:module')).createRequire(import.meta.url)('playwright').chromium; } catch {}
  if (!chromium) console.log('      not checked in a browser: Playwright is not installed here');
  else {
    B.core.settings.set('onboarded', true);
    const browser = await chromium.launch();
    let page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(B.url() + '/#/tasks'); await page.waitForSelector('.tk-group');
    await page.click('text=New task'); await page.fill('#modal textarea', 'Name three Indian tea regions in one short line.');
    await page.click('#modal >> text=Start'); await page.waitForTimeout(400);
    await browser.close();                                  // the owner closes the browser at once
    const started = B.core.jobs.list({ limit: 5 }).find(x => x.kind === 'tasks.run' && /tea regions/.test(x.input?.prompt || ''));
    const fin = started ? await B.core.jobs.wait(started.id, 120_000) : null;
    const browser2 = await chromium.launch(); page = await browser2.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(B.url() + '/#/tasks'); await page.waitForSelector('.tk-group');
    const card = page.locator('.tk-job', { hasText: 'Name three Indian tea regions' }).first();
    await card.locator('text=Read the answer').click(); await page.waitForTimeout(200);
    const shown = (await card.locator('.tk-ans').innerText().catch(() => '')).replace(/\s+/g, ' ');
    await browser2.close();
    check('6 in a browser: start a task, close the browser, come back: the answer waits on the Tasks page', fin?.status === 'done' && shown.length > 10, `"${shown.slice(0, 120)}"`);
  }
} catch (e) { check('tasks real check ran', false, e.stack); }
finally { try { await B?.stop(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); }
process.exit(results.every(Boolean) ? 0 : 1);
