// Real checks for Memory, Dream and Learn against real models.  node modules/memory/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import { testDesk } from '../../test/helpers/desk.js';

const results = []; const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(evidence).replace(/\s+/g, ' ').slice(0, 400)}`); };
const t = await testDesk({ real: true, modules: ['memory'] });
let calls = 0; const labels = [];
const orig = t.core.model.chat.bind(t.core.model);
t.core.model.chat = async (o) => { calls++; const r = await orig(o); labels.push(r.label); return r; };
try {
  const mem = t.core.modules.api('memory');
  // 1. three facts, recalled by other words
  const facts = [
    "The owner's accountant is Priya Shah; she files the company's GST returns every quarter.",
    'Vortex Automation, the owner\'s company, makes temperature and humidity sensors for server racks.',
    'The owner prefers answers as short bullet points, never long essays.',
  ];
  const saved = []; for (const f of facts) saved.push(await mem.remember({ text: f, kind: /prefers/.test(f) ? 'preference' : 'fact' }));
  check('remember three facts, each given search words by a real model', saved.every(s => s.id && s.keys), saved.map(s => `[${s.keys}]`).join(' '));
  const q = 'Who looks after my tax paperwork?';
  const got = await mem.recall({ query: q, limit: 3 });
  check('recall finds the right fact from other wording', /Priya/.test(got[0]?.text || ''), `"${q}" -> ${got.map(g => g.text.slice(0, 50)).join(' | ')}`);
  const st = (await t.call('/api/m/memory/status')).json;
  console.log(`NOTE  search: ${st.search.ok ? 'embeddings ' + st.search.model : st.search.note}`);
  // 2. forPrompt: fast, no model call, '' when nothing fits
  const before = calls; const t0 = performance.now();
  const block = mem.forPrompt('coordinator', 'Remind me who does our GST filing');
  const ms = Math.round(performance.now() - t0);
  const none = mem.forPrompt('coordinator', 'What is the capital of Peru?');
  check('forPrompt returns the fact without a model call', /Priya/.test(block) && calls === before && ms < 100, `${ms} ms, model calls during it: ${calls - before}; block: ${block.replace(/\n/g, ' / ').slice(0, 160)}`);
  check('forPrompt is empty when nothing fits', none === '', JSON.stringify(none));
  // 3. a lesson is always in forPrompt for that agent
  await mem.remember({ agentId: 'closer', text: 'When I ask for leads, always include the city.', kind: 'lesson' });
  const lb = mem.forPrompt('closer', 'Find me ten new buyers'); const other = mem.forPrompt('scout', 'Find me ten new buyers');
  check('a taught lesson is always in that agent\'s prompt, not another\'s', /include the city/.test(lb) && !/include the city/.test(other), lb.replace(/\n/g, ' / ').slice(0, 160));
  // 4. learning from a real exchange: a durable fact is kept, a throwaway line is not
  const turn = { chatId: 'chat-check', agentId: 'coordinator',
    user: 'Quick one: can you check that 17 times 23 is 391? Also, for the record, our main warehouse moved to Chakan, near Pune, last month.',
    assistant: 'Yes, 17 × 23 = 391. Noted that the main warehouse is now in Chakan, near Pune.' };
  const l = await mem.learnFromTurn(turn);
  const addedText = l.added.map(a => a.text).join(' | ');
  check('learnFromTurn keeps the durable fact', /Chakan/.test(addedText) || l.updated.some(u => /Chakan/.test(u.text)), `[${l.label}] added: ${addedText}`);
  check('learnFromTurn ignores the throwaway line', !/391|17|23|times/.test(addedText), `ignored: ${l.ignored.join(' | ').slice(0, 200)}`);
  const secret = await mem.learnFromTurn({ chatId: 'chat-check', user: 'My OpenAI api key is: sk-proj-9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d please keep it safe for later', assistant: 'I will not store keys.' });
  check('learnFromTurn never keeps a secret', !secret.added.some(a => /sk-|key/i.test(a.text)), `added: ${secret.added.map(a => a.text).join(' | ') || 'nothing'} [${secret.label || secret.skipped}]`);
  // 5. Dream merges two duplicates said in other words
  await mem.remember({ text: 'Most of Vortex Automation\'s sensors are sold to data centre operators.' });
  await mem.remember({ text: 'Data centres are the main buyers of the sensors Vortex makes.' });
  const job = (await t.call('/api/m/memory/dream', { body: {} })).json;      // the owner's Run Dream now button
  const done = await t.core.jobs.wait(job.jobId, 180000);
  const left = (await t.call('/api/m/memory/items')).json.items.filter(m => /data centre/i.test(m.text) && m.kind !== 'summary');
  check('Dream merges two duplicates', done.status === 'done' && done.output.merged >= 1 && left.length === 1, `[${done.output?.label}] merged ${done.output?.merged}, left: ${left.map(m => m.text).join(' | ')}; summary: ${done.output?.summary || 'none'}; ${done.output?.note || ''} ${done.error || ''}`);
  console.log(`NOTE  real model calls: ${calls}; models: ${[...new Set(labels)].join(', ')}`);
} catch (e) { check('real check ran to the end', false, e.stack); }
finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
