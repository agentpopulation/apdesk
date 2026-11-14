// Real checks for Flows and Schedules (ask 7). Needs a real model:  node modules/flows/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { testDesk } from '../../test/helpers/desk.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const withChat = fs.existsSync(path.join(here, '..', 'chat', 'module.json')) && !process.argv.includes('--no-chat');
const present = (m) => fs.existsSync(path.join(here, '..', m, 'module.json'));
const mods = ['tasks', 'flows', ...(withChat ? ['chat', 'agents'].filter(present) : []), ...['search', 'sales'].filter(present)];
const results = [];
const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${evidence}`); };
const ist = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const t = await testDesk({ real: true, modules: mods });
console.log('modules loaded:', t.core.modules.list().filter(m => m.on).map(m => m.id).join(', '), '| not loaded:', t.core.modules.list().filter(m => !m.on).map(m => m.id + (m.error ? ' (' + m.error.slice(0, 60) + ')' : '')).join(', ') || 'none', '| time zone:', t.core.settings.get('timeZone'));
try {
  const flows = t.core.modules.api('flows');
  const chat = t.core.modules.api('chat');
  const chatId = chat?.createChat ? (await chat.createChat({ title: 'Schedule check', members: ['coordinator'] }))?.id ?? null : null;
  // 7a: the owner's words through the Coordinator tool
  const a = await t.core.modules.runTool('schedule_create', { when: 'Every morning at 8, brief me' }, { agentId: 'coordinator', chatId });
  const s7a = flows.list().find(s => s.title === a.title);
  const hhmm = s7a?.nextRun ? new Date(s7a.nextRun).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : null;
  const within = s7a?.nextRun && Date.parse(s7a.nextRun) - Date.now() <= 24 * 3600_000 && Date.parse(s7a.nextRun) > Date.now();
  check('7a "Every morning at 8, brief me" becomes a schedule at 8:00 Asia/Kolkata', a.ok && hhmm === '08:00' && within && s7a.kind === 'brief', `"${a.title}", ${a.when}, next run ${ist(s7a?.nextRun)} IST (${s7a?.nextRun})`);
  // 7c: words the rules do not read go to one model call that must return a cron we validate
  try {
    const c = await flows.schedule({ title: 'Monthly check', when: 'on the first day of every month at nine in the morning', prompt: 'List what is running' });
    check('7c unusual words: one model call returns a valid timetable', c.cron === '0 9 1 * *', `${c.when}, next ${ist(c.nextRun)}`);
    flows.remove(c.id);
  } catch (e) { check('7c unusual words: one model call returns a valid timetable', false, e.message); }
  // 7b: a schedule set for the next minute, in plain words, fires on time and runs a real model turn
  let target = new Date(Math.ceil((Date.now() + 25_000) / 60_000) * 60_000);
  const words = `every day at ${target.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}`;
  const b = await t.core.modules.runTool('schedule_create', { title: 'Brief check', when: words, prompt: 'brief me in a few lines', topics: t.core.modules.isOn('search') ? ['Indian monsoon'] : [] }, { agentId: 'coordinator', chatId });
  const s7b = flows.list().find(s => s.title === 'Brief check');
  console.log(`      set "${words}" (IST): next run ${ist(s7b.nextRun)}; waiting...`);
  let v; const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) { v = flows.get(s7b.id); if (v.lastJob) break; await new Promise(r => setTimeout(r, 500)); }
  const job = v.lastJob ? await t.core.jobs.wait(v.lastJob, 150_000) : null;
  const fired = job?.input?.firedAt;
  const late = fired ? (Date.parse(fired) - Date.parse(s7b.nextRun)) / 1000 : null;
  const firstLine = String(job?.output?.answer || job?.output?.text || job?.error || '').split('\n').map(x => x.trim()).find(Boolean) || '';
  let inChat = null;
  if (chat && job?.output?.chatId) { try { inChat = JSON.stringify(await chat.recent?.(20) || '').includes(firstLine.slice(0, 30)); } catch {} }
  check('7b a schedule one minute ahead fires on time and its brief is stored', job?.status === 'done' && late != null && late >= 0 && late < 5 && firstLine.length > 5,
    `scheduled ${ist(s7b.nextRun)}, fired ${ist(fired)} (${late}s late), [${job?.output?.label}] "${firstLine.slice(0, 120)}", news sources gathered: ${job?.output?.sources?.length ?? 0}, stored in ${job?.output?.delivered}${inChat != null ? ', in chat: ' + inChat : ''}`);
  if (chat && job?.output?.chatId) {
    const msgs = (await t.call(`/api/m/chat/chats/${encodeURIComponent(job.output.chatId)}/messages`)).json?.messages || [];
    const ownerStyle = msgs.filter(m => m.role === 'user' && /scheduled run/i.test(String(m.text || '')));
    const reply = msgs.filter(m => m.role === 'assistant' && String(m.text || '').includes(firstLine.slice(0, 25)));
    check('7b in the chat the scheduled run shows only the agent\'s reply, no owner-style prompt', ownerStyle.length === 0 && reply.length === 1, `owner-style prompts: ${ownerStyle.length}, replies with the brief: ${reply.length}, messages: ${msgs.map(m => m.role).join(', ')}`);
  }
  check('7b after the run the schedule is re-armed for tomorrow', !!flows.get(s7b.id).nextRun && Date.parse(flows.get(s7b.id).nextRun) > Date.now() + 23 * 3600_000, `next ${ist(flows.get(s7b.id).nextRun)}`);
  // chains of agents: two agents, the output of the first is the input of the second, one progress line per step
  const lines = []; const off = t.core.events.on((type, d) => { if (type === 'job' && d?.kind === 'flows.chain' && d.detail && lines.at(-1) !== d.detail) lines.push(d.detail); });
  const fc = await t.core.modules.runTool('flow_create', { title: 'Tea note', steps: [{ agentId: 'scout', instruction: 'Give two plain facts about Darjeeling tea, one line each.' }, { agentId: 'coder', instruction: 'Turn the facts you are given into a two-row markdown table with columns Fact and Why it matters.' }], runNow: true }, { agentId: 'coordinator', chatId });
  const chainJob = t.core.jobs.list({ limit: 10 }).find(x => x.kind === 'flows.chain');
  const cj = chainJob ? await t.core.jobs.wait(chainJob.id, 150_000) : null; off();
  const st = cj?.output?.steps || [];
  check('chain: each agent gets the work of the one before, one progress line per step', cj?.status === 'done' && st.length === 2 && /\|/.test(st[1].text) && lines.filter(l => /^Step \d of 2/.test(l)).length === 2,
    `${fc.steps?.join(' / ')} | lines: ${lines.filter(l => /^Step/.test(l)).join(' / ')} | [${st[0]?.label}] then [${st[1]?.label}] "${String(st[1]?.text || cj?.error || '').split('\n').find(x => x.includes('|')) || ''}"`);
} catch (e) { check('flows real check ran', false, e.stack); }
finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
