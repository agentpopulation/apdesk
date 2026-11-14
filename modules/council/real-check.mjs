// Real checks for the Council against real models.  node modules/council/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import { testDesk } from '../../test/helpers/desk.js';

const results = []; const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(evidence).replace(/\s+/g, ' ').slice(0, 500)}`); };
const t = await testDesk({ real: true, modules: ['council'] });
let calls = 0; const orig = t.core.model.chat.bind(t.core.model); t.core.model.chat = async (o) => { calls++; return orig(o); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const run = async (id) => (await t.call('/api/m/council/runs/' + id)).json.run;
try {
  const defaults = (await t.call('/api/m/council/defaults?format=decision')).json;
  console.log(`NOTE  ${defaults.distinct} models are answering now${defaults.notice ? ' (' + defaults.notice + ')' : ''}; seats: ` + defaults.seats.map(s => `${s.name} (${s.stance}) on ${s.modelLabel}`).join('; ') + `; chairman ${defaults.chair.label}`);
  const picked = [...defaults.seats.map(s => s.model), defaults.chair].map(m => m.provider + '|' + (m.model || 'auto'));
  check('seats and chairman are given different models when more than one answers', new Set(picked).size === Math.min(4, defaults.distinct) && (defaults.distinct > 1 || /Only one model/.test(defaults.notice)), picked.join(', '));
  const question = process.env.COUNCIL_Q || 'A 10-person sales team: buy a CRM at about 1,500 rupees per user per month, or build our own? Give the yearly cost of buying.';
  const r = (await t.call('/api/m/council/ask', { body: { question } })).json;
  const job = await t.core.jobs.wait(r.jobId, 420000);
  const x = await run(r.runId);
  const providers = new Set(x.answers.filter(a => a.text).map(a => a.label.split(' · ')[0]));
  check('three seats answer on at least two different providers', x.answers.filter(a => a.text).length === 3 && providers.size >= 2, x.answers.map(a => `${a.name}: [${a.label || a.error}] ${String(a.text || '').slice(0, 90)}`).join(' || '));
  check('ranking stage: the seats rank each other anonymised', x.rankings.filter(k => k.order.length >= 2).length >= 2, x.rankings.map(k => `${k.name} [${k.label}] ranked ${k.order.join(' > ') || 'nothing'}`).join('; '));
  const agreeOk = /^(All three seats agree: .+|2 of 3 seats agree: .+; .+ differs: .+|The seats disagree)$/.test(x.verdict?.agreeLine || '') || (!x.verdict?.agreeLine && x.verdict?.voteLine === x.verdict?.rankLine);
  check('the Verdict headline says what it counts: agreement from the seats\' recommendations, the ranking under its own name, never "agreed N to M"', job.status === 'done' && x.verdict?.decision && agreeOk && /^Best-argued answer by the seats' own ranking: /.test(x.verdict.rankLine || '') && !/agreed \d+ to \d+/.test(JSON.stringify(x.verdict)) && x.verdict.reasons.length >= 1 && x.verdict.label,
    `${job.status} ${job.error || ''} | Verdict · ${x.verdict?.voteLine} | ${x.verdict?.rankLine} | agreement labelled by [${x.verdict?.agreeLabel || 'no reply'}] | chairman [${x.verdict?.label}]: ${x.verdict?.decision} Reasons: ${(x.verdict?.reasons || []).join(' / ')}`);
  console.log('NOTE  seats\' first sentences: ' + x.answers.map(a => `${a.name} [${a.label}${a.fellBack ? '; set ' + a.setLabel : ''}]: ${String(a.text || a.error || '').split(/(?<=[.!?])\s/)[0].slice(0, 120)}`).join(' || '));
  if (x.answers.some(a => a.sums?.length)) console.log('NOTE  sums marked: ' + x.answers.flatMap(a => a.sums || []).join('; '));
  const seatLabels = x.answers.filter(a => a.text).map(a => a.label); const distinctAnswered = new Set(seatLabels).size;
  check('the result is honest about the models: three different ones, or a plain note', distinctAnswered === 3 || x.verdict.notes.some(n => /one model/.test(n)), `${distinctAnswered} different models wrote the seats; chairman ${x.verdict.label}; notes: ${x.verdict.notes.join(' | ') || 'none'}`);
  const hasFigures = x.answers.some(a => /\d/.test(String(a.text || '').replace(/10-person|\b10\b|1,500/g, '')));
  check('figures are labelled as not checked', !hasFigures || x.verdict.notes.includes('Figures here come from the models, not from pages read: not checked'), `answers contain figures: ${hasFigures}; notes: ${x.verdict.notes.join(' | ') || 'none'}`);
  // a second run, stopped by Panic mid-way
  const r2 = (await t.call('/api/m/council/ask', { body: { question: 'Should a small sensor maker open a sales office in Bengaluru this year?' } })).json;
  const t0 = Date.now(); let mid;
  while (Date.now() - t0 < 120000) { mid = await run(r2.runId); if (mid.answers.some(a => a.text) || mid.status !== 'running') break; await sleep(300); }
  const answeredBefore = mid.answers.filter(a => a.text).length;
  await t.call('/api/panic', { body: { reason: 'check' } });
  const j2 = await t.core.jobs.wait(r2.jobId, 10000);
  const callsAtStop = calls; await sleep(4000);
  const y = await run(r2.runId);
  check('a second run is stopped by Panic mid-way', j2.status === 'stopped' && y.status === 'stopped' && !y.verdict && calls === callsAtStop, `job ${j2.status}, run ${y.status}, seats answered before Panic ${answeredBefore} of 3, verdict ${y.verdict ? 'written' : 'none'}, model calls after the stop ${calls - callsAtStop}`);
  await t.call('/api/panic/resume', { method: 'POST' });
  const rooms = (await t.call('/api/m/council/rooms')).json.rooms;
  check('rooms and past Verdicts are stored and listed', rooms.length === 2 && rooms.some(rm => rm.voteLine), rooms.map(rm => `${rm.question.slice(0, 40)}… ${rm.status} ${rm.voteLine || ''}`).join(' | '));
  console.log(`NOTE  real model calls: ${calls}`);
} catch (e) { check('real check ran to the end', false, e.stack); }
finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
