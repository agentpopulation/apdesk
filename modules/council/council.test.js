// Plumbing tests with the fake model (never proof that the Council works; see real-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { aggregate, parseRanking, endsWhole, toLastSentence, wholeSentences, agreement, parseRecommendation, recKey, sameCourse, REC_ASK } from './stages.js';
import * as stages from './stages.js';
import { liveSlots, spread, modelNote, figuresNote, FIGURES_NOTE } from './seats.js';

test('council: counting the vote', () => {
  const answers = [{ name: 'Builder' }, { name: 'Buyer' }, { name: 'Judge' }];
  const byLetter = { A: 2, B: 0, C: 1 };
  const agg = aggregate([{ name: 'Builder', order: ['A', 'B', 'C'] }, { name: 'Buyer', order: ['A', 'C', 'B'] }, { name: 'Judge', order: ['B', 'A', 'C'] }], byLetter, answers);
  assert.equal(agg.rankLine, "Best-argued answer by the seats' own ranking: Judge"); assert.equal(answers[agg.winner].name, 'Judge');
  assert.equal(agg.voteLine, undefined, 'the ranking never says "agreed N to M"');
  assert.deepEqual(parseRanking({ text: 'A is fine.\nFINAL RANKING:\n1. Answer C\n2. Answer A' }, ['A', 'B', 'C']).order, ['C', 'A']);
});

test('council: a run stores answers, rankings and a Verdict; Panic stops a second run', async () => {
  const script = (body) => {
    const u = body.messages.at(-1).content; const s = body.messages[0].content;
    if (/chairman/.test(s)) return JSON.stringify({ decision: 'Buy now.', reasons: ['Faster', 'Cheaper'], answer: 'Buy.' });
    if (/review answers/.test(s)) return JSON.stringify({ notes: { A: 'ok' }, ranking: ['A', 'B', 'C'] });
    if (/slow/.test(u)) return { text: 'thinking '.repeat(50), delayMs: 3000 };
    return 'My position: buy. It costs about 50,000 a year.';
  };
  const t = await testDesk({ modules: ['council'], script });
  try {
    const r = (await t.call('/api/m/council/ask', { body: { question: 'Should we build or buy a rack monitor?' } })).json;
    const job = await t.core.jobs.wait(r.jobId, 10000);
    assert.equal(job.status, 'done', job.error);
    const run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    assert.equal(run.answers.length, 3); assert.equal(run.rankings.length, 3); assert.equal(run.verdict.voteLine, run.verdict.rankLine); assert.match(run.verdict.voteLine, /^Best-argued answer by the seats' own ranking: /); assert.equal(run.verdict.agreeLine, '', 'no seat gave a recommendation line, so only the ranking line shows'); assert.ok(run.verdict.notes.includes('No seat gave a clear recommendation, so the Verdict cannot say how far the seats agree; the headline shows how they ranked each other instead.'), run.verdict.notes.join(' | ')); assert.ok(run.answers.every(a => a.label));
    // the fake desk has one model: the result says so, and figures are labelled as not checked
    assert.ok(run.verdict.notes.some(n => /Only one model answered/.test(n)), run.verdict.notes.join(' | ')); assert.ok(run.verdict.notes.includes(FIGURES_NOTE));
    const d = (await t.call('/api/m/council/defaults')).json; assert.equal(d.distinct, 1); assert.match(d.notice, /Only one model is answering now, so all seats will use it/);
    const rooms = (await t.call('/api/m/council/rooms')).json.rooms; assert.equal(rooms.length, 1);
    const r2 = (await t.call('/api/m/council/ask', { body: { question: 'slow question' } })).json;
    await new Promise(res => setTimeout(res, 400));
    await t.call('/api/panic', { body: {} });
    assert.equal((await t.core.jobs.wait(r2.jobId, 5000)).status, 'stopped');
    assert.equal((await t.call('/api/m/council/runs/' + r2.runId)).json.run.status, 'stopped');
  } finally { await t.close(); }
});

test('council: seats and chairman are spread across providers first, then across one provider\'s models', () => {
  const label = (p, m) => `${p} · ${m}`;
  const router = { provider: 'router', kind: 'router', label: 'Free API by Agent Population Desk', ok: true, model: 'llama-3.3-70b', models: ['llama-3.3-70b', 'llama-3.1-8b', 'qwen3-32b', 'mistral-small', 'gpt-oss-120b', 'nomic-embed-text'] };
  const gemini = { provider: 'gemini', kind: 'keyed', label: 'Google Gemini', ok: true, model: 'gemini-3.6-flash', models: ['gemini-3.6-flash'] };
  const ollama = { provider: 'ollama', kind: 'local', label: 'Ollama', ok: true, model: 'qwen2.5:14b', models: ['qwen2.5:14b', 'nomic-embed-text'] };
  const key = (x) => x.provider + '|' + x.model;
  // three providers: one seat each, the chairman on a fourth distinct model
  let s = spread(liveSlots([router, ollama, gemini], label));
  assert.deepEqual(s.seats.map(x => x.provider), ['gemini', 'router', 'ollama']); assert.equal(s.notice, '');
  assert.equal(new Set([...s.seats, s.chair].map(key)).size, 4);
  // the router alone: three different router models by explicit pick (unlike families first), a fourth for the chairman, no embedding model
  s = spread(liveSlots([router, { ...ollama, ok: false }], label));
  assert.deepEqual(s.seats.map(x => x.model), ['llama-3.3-70b', 'qwen3-32b', 'mistral-small']); assert.equal(s.chair.model, 'gpt-oss-120b'); assert.equal(s.notice, '');
  // one model only: said plainly before the run
  s = spread(liveSlots([{ ...router, models: ['llama-3.3-70b'] }], label));
  assert.equal(s.distinct, 1); assert.equal(s.notice, 'Only one model is answering now, so all seats will use it.'); assert.equal(new Set([...s.seats, s.chair].map(key)).size, 1);
  // offline: local models only, and it says so; nothing local: it cannot meet
  s = spread(liveSlots([{ ...router, ok: false }, ollama], label), 3, { offline: true });
  assert.match(s.notice, /offline, so the Council runs on local models only/); assert.ok(s.seats.every(x => x.provider === 'ollama'));
  assert.match(spread(liveSlots([{ ...router, ok: false }], label), 3, { offline: true }).notice, /cannot meet/);
});

test('council: result notes for one model and for unchecked figures', () => {
  assert.match(modelNote([{ text: 'a', label: 'X' }, { text: 'b', label: 'X' }, { text: 'c', label: 'X' }]), /Only one model answered \(X\)/);
  assert.equal(modelNote([{ text: 'a', label: 'X' }, { text: 'b', label: 'Y' }, { text: 'c', label: 'Z' }]), '');
  assert.match(modelNote([{ text: 'a', label: 'X' }, { text: 'b', label: 'Y' }, { text: 'c', label: 'X' }]), /Two seats shared one model/);
  assert.equal(figuresNote('What should a senior engineer in Pune be paid?', [{ text: 'About 28 lakh a year.' }], { decision: 'Pay market rate.' }), FIGURES_NOTE);
  assert.equal(figuresNote('Should our 20-person company build or buy?', [{ text: 'A 20-person company should buy.' }], { decision: 'Buy.' }), '', 'a number the question gave is not a new figure');
  assert.equal(figuresNote('Build or buy?', [{ text: 'Buy.' }], { decision: 'Buy.', reasons: ['Faster'] }), '');
});

test('council: an answer cut off mid-sentence is continued once, else trimmed to its last full sentence and marked; the Verdict quotes no half sentence', async () => {
  assert.equal(endsWhole('Buying is cheaper, and 540,000 rupees over'), false); assert.equal(endsWhole('**Buy.**'), true);
  assert.equal(toLastSentence('It costs 540.5 a year. We should buy and'), 'It costs 540.5 a year.');
  assert.ok(endsWhole(wholeSentences('One full sentence here. '.repeat(30), 100)));
  const half = 'I argue against. Buying is live in two weeks. It costs less in year one, and 540,000 rupees over';
  const script = (body) => {
    const sys = body.messages[0].content; const last = body.messages.at(-1).content; const q = body.messages.find(m => m.role === 'user').content;
    if (/chairman/.test(sys)) return /trim/.test(sys + body.messages[1].content) ? '{"decision":"Buy now. Then review the cost after one year and' : JSON.stringify({ decision: 'Buy now.', reasons: ['Faster'] });
    if (/review answers/.test(sys)) return JSON.stringify({ ranking: ['A', 'B', 'C'] });
    if (/cut off in the middle/.test(last)) { continued++; return /trim/.test(q) ? { text: 'the next three years, which is why the', finish: 'length' } : 'three years. So we should buy.'; }
    if (/nopunct/.test(q)) return 'Buy it, the numbers favour buying 🙂';                        // whole, but no end punctuation
    if (/stopcut/.test(q)) return { text: 'I argue against. Buying is live in two weeks.', finish: 'length' };   // cut off, but ends with a full stop
    return { text: half, finish: 'length' };
  };
  let continued = 0;
  const t = await testDesk({ modules: ['council'], script });
  try {
    const noHalf = (text) => assert.ok(!/rupees over$|rupees over\s*(\(|\*|$)|which is why the|and$/m.test(text), text);
    // continued once: the sentence is finished, nothing is marked
    let r = (await t.call('/api/m/council/ask', { body: { question: 'Should we build or buy?' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    let run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    for (const a of run.answers) { assert.equal(a.text, half.replace('540,000 rupees', '540,000 rupees (not checked)') + ' three years. So we should buy.'); assert.equal(a.cut, false); }
    // the continuation is cut too: kept up to the last full sentence, marked "cut short"; the chairman's own cut-off reply is not quoted half
    r = (await t.call('/api/m/council/ask', { body: { question: 'Should we build or buy? (trim)' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    for (const a of run.answers) { assert.equal(a.text, 'I argue against. Buying is live in two weeks.'); assert.equal(a.cut, true); }
    assert.equal(run.verdict.decision, 'Buy now.');
    noHalf(run.verdict.decision); noHalf(run.verdict.answer || '');
    // only the model door's cutOff counts: a whole answer without end punctuation is kept as it is, with no extra call
    continued = 0;
    r = (await t.call('/api/m/council/ask', { body: { question: 'Should we build or buy? (nopunct)' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    assert.equal(continued, 0, 'no continuation call for a whole answer');
    for (const a of run.answers) { assert.equal(a.text, 'Buy it, the numbers favour buying 🙂'); assert.equal(a.cut, false); }
    // a cut-off answer that happens to end with a full stop is still continued
    r = (await t.call('/api/m/council/ask', { body: { question: 'Should we build or buy? (stopcut)' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    assert.equal(continued, run.answers.length, 'each cut-off answer is continued once');
    for (const a of run.answers) { assert.equal(a.text, 'I argue against. Buying is live in two weeks. three years. So we should buy.'); assert.equal(a.cut, false); }
  } finally { await t.close(); }
});

test('council: each seat\'s recommendation line is read tolerantly, and agreement is counted by code from those lines', () => {
  assert.equal(parseRecommendation('Buy it, it is cheaper.\nRecommendation: buy the CRM'), 'buy the CRM');
  assert.equal(parseRecommendation('Build.\n\n**Recommendation:** Build in-house.'), 'Build in-house');
  assert.equal(parseRecommendation('Wait.\n- Recommendation \u2013 wait for the Q3 quote. Then decide.'), 'wait for the Q3 quote');
  assert.equal(parseRecommendation('So my recommendation is to buy a ready CRM.'), 'buy a ready CRM');
  assert.equal(parseRecommendation('<think>Recommendation: no</think>I argue for it.\nRecommendation: "Yes"'), 'Yes');
  assert.equal(parseRecommendation('I argue for it. It pays back fast.'), null, 'no line, no guess');
  assert.equal(parseRecommendation('Recommendation: <the course>'), null, 'an echoed template is not a recommendation');
  assert.equal(parseRecommendation('Recommendation: none'), null);
  assert.equal(parseRecommendation('buy the CRM', { bare: true }), 'buy the CRM', 'a one-line reply to the second ask counts');
  assert.equal(parseRecommendation('My position: buy. It costs about 50,000 a year.', { bare: true }), null, 'two sentences are not a bare line');
  assert.equal(recKey("Don't build it"), 'no build'); assert.equal(recKey('Hold off until March'), 'wait'); assert.equal(recKey('Yes, open it'), 'yes');
  assert.equal(parseRecommendation('Recommendation: Buying a standard CRM is'), null, 'a line cut off mid-phrase is a miss, so the seat is asked again');
  assert.ok(sameCourse('Buying a standard CRM', 'buy CRM'), 'one key word whatever its ending'); assert.ok(sameCourse("Don't building", 'do not build'));
  assert.ok(sameCourse('buy the CRM', 'Buy a ready-made CRM')); assert.ok(!sameCourse('buy the CRM', 'build in-house'));
  assert.ok(!sameCourse('pay 28 lakh a year', 'pay 20 lakh a year'), 'different figures are different courses');
  const seats = (...r) => ['Builder', 'Buyer', 'Judge'].map((name, k) => ({ name, recommendation: r[k] ?? null }));
  assert.equal(agreement(seats('buy the CRM', 'Buy a CRM', 'buy')), 'All three seats agree: buy the CRM');
  assert.equal(agreement(seats('buy the CRM', 'buy', 'build in-house')), '2 of 3 seats agree: buy the CRM; Judge differs: build in-house');
  assert.equal(agreement(seats('build', 'buy', 'wait')), 'The seats differ: Builder: build; Buyer: buy; Judge: wait');
  assert.equal(agreement(seats('buy the CRM', null, 'buy')), '2 of 3 seats recommend buy the CRM; one seat gave no clear recommendation');
  assert.equal(agreement(seats('build', null, 'buy')), 'The seats differ: Builder: build; Judge: buy; one seat gave no clear recommendation');
  assert.equal(agreement(seats(null, null, 'wait')), 'The seats differ: Judge: wait; two seats gave no clear recommendation', 'one of three is no majority');
  assert.equal(agreement(seats(null, null, null)), '', 'nothing to count: the Verdict falls back to the ranking with a plain note');
  assert.equal(agreement([{ name: 'Builder', recommendation: 'buy' }, { name: 'Judge', recommendation: 'buy now' }]), 'Both seats that answered agree: buy');
});

test('council: a seat without a recommendation line is asked once more; one that still gives none is said plainly in the Verdict', async () => {
  const asked = [];
  const script = (body) => {
    const u = body.messages.at(-1).content; const s = body.messages[0].content;
    if (/chairman/.test(s)) return JSON.stringify({ decision: 'Buy the CRM.', reasons: ['Cheaper'] });
    if (/review answers/.test(s)) return JSON.stringify({ ranking: ['A', 'B', 'C'] });
    const seat = s.match(/You are (\w+)/)[1];
    if (u === REC_ASK) { asked.push(seat); return seat === 'Buyer' ? 'Recommendation: buy a ready CRM' : 'It depends on many things, really. Hard to say.'; }
    if (seat === 'Builder') return 'Buy it; building costs more.\nRecommendation: buy the CRM';
    return 'Buying is cheaper this year.';
  };
  const t = await testDesk({ modules: ['council'], script });
  try {
    const r = (await t.call('/api/m/council/ask', { body: { question: 'Should we build or buy a CRM?' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    const run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    assert.deepEqual(asked.sort(), ['Buyer', 'Judge'], 'only the seats without a line are asked, once each');
    assert.deepEqual(run.answers.map(a => a.recommendation), ['buy the CRM', 'buy a ready CRM', null]);
    assert.equal(run.verdict.voteLine, '2 of 3 seats recommend buy the CRM; one seat gave no clear recommendation');
    assert.match(run.verdict.rankLine, /^Best-argued answer by the seats' own ranking: /);
    assert.ok(!run.verdict.notes.some(n => /No seat gave a clear recommendation/.test(n)));
  } finally { await t.close(); }
});

test('council: no code rewrites a sum in an answer (checkArithmetic removed; it flagged correct lakh sums)', () => {
  assert.equal(stages.checkArithmetic, undefined);
});

test('council: the Verdict headline counts the seats\' recommendations, the ranking keeps its own name, a fallback model is named, the seats\' sums are left as written, each unchecked figure marked', async () => {
  const script = (body) => {
    const u = body.messages.at(-1).content; const s = body.messages[0].content;
    if (body.model === 'broken-model') return { status: 500, text: 'down' };
    if (/chairman/.test(s)) return JSON.stringify({ decision: 'Buy the CRM.', reasons: ['Hiring 2 people at ₹6 lakh each plus ₹3 lakh tools = ₹15 lakh.'], answer: 'Buy.' });
    if (/review answers/.test(s)) return JSON.stringify({ notes: { A: 'ok' }, ranking: ['A', 'B', 'C'] });
    return 'Buy the CRM. At 1,500 × 10 × 12 = 18,000 rupees a year it is cheaper than building.\nRecommendation: buy the CRM';
  };
  const t = await testDesk({ modules: ['council'], script });
  try {
    const r = (await t.call('/api/m/council/ask', { body: { question: 'A 10-person team: buy a CRM at 1,500 rupees per user per month, or build one?' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    let run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    assert.equal(run.verdict.voteLine, 'All three seats agree: buy the CRM');
    assert.match(run.verdict.rankLine, /^Best-argued answer by the seats' own ranking: (Builder|Buyer|Judge|\w+)/);
    assert.ok(!/agreed \d+ to \d+/.test(JSON.stringify(run.verdict)));
    // a case the earlier rule got wrong: a correct lakh sum was flagged; now no seat answer or Verdict line is changed by code
    // the figures the question gave (1,500 and 10) stay as they are; the others are marked on the figure, the sum itself unchanged
    for (const a of run.answers) assert.equal(a.text, 'Buy the CRM. At 1,500 × 10 × 12 (not checked) = 18,000 rupees (not checked) a year it is cheaper than building.\nRecommendation: buy the CRM');
    assert.equal(run.verdict.reasons[0], 'Hiring 2 (not checked) people at ₹6 lakh (not checked) each plus ₹3 lakh (not checked) tools = ₹15 lakh (not checked).');
    assert.ok(!/does not add up/.test(JSON.stringify(run)));
    assert.ok(run.verdict.notes.includes(FIGURES_NOTE), 'the figures note tells the owner the figures are not checked');
    // a seat whose set model is not answering: another model writes it, and the answer says so
    const room = (await t.call('/api/m/council/rooms/' + r.roomId)).json.room;
    const seats = room.seats.map((s, i) => ({ model: i === 0 ? { provider: s.model?.provider || 'router', model: 'broken-model' } : s.model }));
    const r2 = (await t.call(`/api/m/council/rooms/${r.roomId}/run`, { body: { seats } })).json;
    assert.equal((await t.core.jobs.wait(r2.jobId, 10000)).status, 'done');
    run = (await t.call('/api/m/council/runs/' + r2.runId)).json.run;
    const a0 = run.answers[0];
    assert.equal(a0.fellBack, true); assert.match(a0.setLabel, /broken-model/); assert.ok(!/broken-model/.test(a0.label));
    const { fellBackNote } = await import('./server.js');
    assert.equal(fellBackNote(a0), `answered by ${a0.label}; ${a0.setLabel} was not answering`);
    assert.equal(fellBackNote(run.answers[1]), '');
    // an old stored Verdict that said "agreed 2 to 1" from rankings is shown under its true name
    t.core.storage.run("UPDATE m_council_runs SET verdict = ? WHERE id = ?", JSON.stringify({ decision: 'Buy.', voteLine: 'agreed 2 to 1', winner: 'Judge', label: 'x', reasons: [] }), r.runId);
    run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    assert.equal(run.verdict.voteLine, "Best-argued answer by the seats' own ranking: Judge");
  } finally { await t.close(); }
});

test('council: a chairman reply that is JSON but has no decision is asked once more, never stored as an empty Verdict', async () => {
  let chair = 0;
  const script = (body) => {
    const s = body.messages[0].content;
    if (/chairman/.test(s)) return ++chair === 1 ? JSON.stringify({ verdict: { text: 'Buy' } }) : JSON.stringify({ decision: 'Buy the CRM.', reasons: ['Cheaper'] });
    if (/review answers/.test(s)) return JSON.stringify({ ranking: ['A', 'B', 'C'] });
    return 'Buy it.';
  };
  const t = await testDesk({ modules: ['council'], script });
  try {
    const r = (await t.call('/api/m/council/ask', { body: { question: 'Buy or build?' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    const run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    assert.equal(chair, 2); assert.equal(run.verdict.decision, 'Buy the CRM.');
  } finally { await t.close(); }
});

// ---- Turnaround review: four advisor seats on one brief from the desk's own records, a 30-day plan, steps that become tasks
import { buildBrief, DEFAULT_QUESTION } from './brief.js';
import { FORMATS } from './formats.js';

test('turnaround: the brief says "not checked" for what it cannot reach and quotes only what the desk holds', () => {
  const b = buildBrief({ about: 'Payroll software for small firms; India.', leads: 12, inTalks: 3, draftsWaiting: null, customers: 0, tasks: { running: 1, done: 4, failed: 2, of: 7 } });
  assert.match(b, /What the owner sells: "Payroll software for small firms; India\."/);
  assert.match(b, /Leads in the pipeline: 12/); assert.match(b, /In talks: 3/); assert.match(b, /Drafts waiting for approval: not checked/); assert.match(b, /Customers: 0/);
  assert.match(b, /Recent tasks \(last 7\): 1 running, 4 finished, 2 failed/);
  const empty = buildBrief({ about: '', leads: null, inTalks: null, draftsWaiting: null, customers: null, tasks: null });
  assert.match(empty, /What the owner sells: not checked/); assert.match(empty, /Leads in the pipeline: not checked/); assert.match(empty, /Recent tasks: not checked/);
  assert.match(empty, /not checked/);
});

test('turnaround: the format has the four advisor seats; a run reads the same brief, gives a plan with steps, agree and differ, and each step can become a task', async () => {
  const prompts = [];
  const script = (body) => {
    const s = body.messages[0].content;
    if (/chairman/.test(s)) { prompts.push({ chair: body.messages.at(-1).content }); return JSON.stringify({ decision: 'Fix the offer first, then call the warm leads.', reasons: ['Buyers are unclear on the offer', 'Three leads are in talks'], answer: 'Plan.', agree: ['Start with the offer'], differ: ['Sales lead wants calls this week; the AI officer wants a tool first'], steps: [{ step: 'Write the offer in one line and test it on three buyers', by: 'Product lead' }, { step: 'Call the three leads that are in talks', by: 'Sales lead' }, 'List the three jobs an agent could take over'] }); }
    if (/review answers/.test(s)) return JSON.stringify({ notes: { A: 'ok' }, ranking: ['A', 'B', 'C', 'D'] });
    prompts.push({ seat: s, user: body.messages.at(-1).content });
    return 'Step 1: Write the offer in one line.\nStep 2: Call the warm leads.\nRecommendation: fix the offer';
  };
  const t = await testDesk({ modules: ['council', 'tasks'], script });
  try {
    t.core.settings.set('business.about', 'Payroll software for small firms; India.');
    const fm = (await t.call('/api/m/council/formats')).json.formats.find(f => f.id === 'turnaround');
    assert.equal(fm.label, 'Turnaround review');
    assert.deepEqual(FORMATS.turnaround.seats.map(s => s.name), ['AI officer', 'Product lead', 'Sales lead', 'Co-founder']);
    const r = (await t.call('/api/m/council/ask', { body: { format: 'turnaround' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    const run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    const room = (await t.call('/api/m/council/rooms/' + r.roomId)).json.room;
    assert.equal(room.question, DEFAULT_QUESTION); assert.equal(room.seats.length, 4); assert.equal(run.answers.length, 4);
    const seatPrompts = prompts.filter(p => p.seat);
    assert.equal(seatPrompts.length, 4);
    for (const p of seatPrompts) { assert.match(p.user, /Payroll software for small firms/); assert.match(p.user, /Leads in the pipeline: not checked/, 'Sales is off, so it is not checked'); assert.match(p.seat, /30-day plan/); }
    assert.equal(new Set(seatPrompts.map(p => p.user)).size, 1, 'every seat reads the same brief');
    const v = run.verdict;
    assert.deepEqual(v.agree, ['Start with the offer']); assert.equal(v.differ.length, 1);
    assert.deepEqual(v.steps.map(s => s.by), ['Product lead', 'Sales lead', '']);
    assert.ok(v.steps.every(s => s.text));
    // the task button: one step becomes one task, through the Tasks module
    const a = await t.call(`/api/m/council/runs/${r.runId}/action`, { body: { action: 'task', step: 1 } });
    assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(a.json.ok, true);
    const tasks = t.core.jobs.list({ limit: 20 }).filter(j => /^Call the three leads/.test(j.title));
    assert.equal(tasks.length, 1, 'the chosen step only');
    assert.equal((await t.call(`/api/m/council/runs/${r.runId}/action`, { body: { action: 'task', step: 9 } })).status, 404);
  } finally { await t.close(); }
});

test('turnaround: counts come from Sales and recent tasks when they are on; Tasks off leaves the step button answering plainly', async () => {
  const seen = [];
  const t = await testDesk({ modules: ['council'], script: (b) => { if (/chairman/.test(b.messages[0].content)) return JSON.stringify({ decision: 'Go.', reasons: [], steps: ['Do one thing'] }); if (/review answers/.test(b.messages[0].content)) return JSON.stringify({ ranking: ['A'] }); seen.push(b.messages.at(-1).content); return 'Step 1: x\nRecommendation: go'; } });
  try {
    t.core.modules.api = ((orig) => (id) => id === 'sales' ? { totals: () => ({ leads: 5, inTalks: 2, draftsWaiting: 1 }), customers: () => [{ name: 'A' }] } : orig(id))(t.core.modules.api.bind(t.core.modules));
    const r = (await t.call('/api/m/council/ask', { body: { format: 'turnaround' } })).json;
    await t.core.jobs.wait(r.jobId, 10000);
    assert.ok(seen.length >= 4); assert.match(seen[0], /Leads in the pipeline: 5/); assert.match(seen[0], /In talks: 2/); assert.match(seen[0], /Drafts waiting for approval: 1/); assert.match(seen[0], /Customers: 1/);
    const a = await t.call(`/api/m/council/runs/${r.runId}/action`, { body: { action: 'task', step: 0 } });
    assert.equal(a.status, 409); assert.match(a.json.error, /Tasks is not on/);
  } finally { await t.close(); }
});

// ---- figures, currency, markdown, agreement that is not forced, slow seats
import { markFigures, plainText, majority } from './stages.js';
import { ownerLine } from './brief.js';

test('council: a figure no record gave is marked on that figure, whole, never inside a word; another currency is marked, never converted', () => {
  const inr = { currency: 'INR' };
  const given = new Set(['12']);
  assert.equal(markFigures('Start with $10,000 initially and charge $30 per box.', { given, ...inr }), 'Start with $10,000 (not checked) initially and charge $30 (not checked) per box.');
  assert.equal(markFigures('Expect ₹4,500 monthly from 3 offices.', { given, ...inr }), 'Expect ₹4,500 (not checked) monthly from 3 (not checked) offices.');
  assert.equal(markFigures('Budget ₹6 lakh each, about 1,50,000 rupees a quarter, a 20% margin.', { given, ...inr }), 'Budget ₹6 lakh (not checked) each, about 1,50,000 rupees (not checked) a quarter, a 20% (not checked) margin.');
  assert.equal(markFigures('Call the 12 leads you have.', { given, ...inr }), 'Call the 12 leads you have.', 'a figure from the records stays as it is');
  assert.equal(markFigures('Step 1: a 30-day trial. Step 2: review in 2 weeks. Run it in Q3 for B2B buyers on gpt-4o at 9:30 in 2027.', { given, ...inr }), 'Step 1: a 30-day trial. Step 2: review in 2 weeks. Run it in Q3 for B2B buyers on gpt-4o at 9:30 in 2027.');
  assert.equal(markFigures('Charge ₹250 (not checked) per box.', { given, ...inr }), 'Charge ₹250 (not checked) per box.', 'never marked twice');
  assert.equal(markFigures('Price it at $30.', { given: new Set(['30']), ...inr }), 'Price it at $30 (not checked).', 'an amount in another currency is marked even when the number was given');
  assert.equal(markFigures('Price it at $30.', { given: new Set(['30']), currency: 'USD' }), 'Price it at $30.');
  assert.equal(markFigures('2 of 4 advisors want a ₹200-300 box.', { given, ...inr }), '2 of 4 advisors want a ₹200-300 (not checked) box.');
  assert.equal(markFigures('Compile a 50\u2011office list; see Record 2. Reach 20-office parks in a 30\u2011day push.', { given, ...inr }), 'Compile a 50\u2011office (not checked) list; see Record 2. Reach 20-office (not checked) parks in a 30\u2011day push.', 'a compound stays whole; a label number is not a figure');
});

test('council: Markdown marks are drawn as plain text, never shown raw', () => {
  assert.equal(plainText('**Step 1:** Call the office.\n## Plan\n- *Try* `one` box\n* Two\n> __Note__'), 'Step 1: Call the office.\nPlan\n- Try one box\n- Two\nNote');
  assert.equal(plainText('Costs 5 * 3 = 15.'), 'Costs 5 * 3 = 15.');
});

test('council: agreement needs a majority of the same course; fewer says the seats differ and lists each', () => {
  const four = (...r) => ['AI officer', 'Product lead', 'Sales lead', 'Co-founder'].map((name, k) => ({ name, recommendation: r[k] ?? null }));
  assert.ok(!sameCourse('Launch targeted office starter pack', 'Launch weekend brunch box'), 'one shared first word is not one course');
  assert.equal(agreement(four('Launch targeted office starter pack', 'Launch weekend brunch box', 'Call office managers', 'Launch office starter pack')),
    'The seats differ: AI officer: Launch targeted office starter pack; Product lead: Launch weekend brunch box; Sales lead: Call office managers; Co-founder: Launch office starter pack');
  assert.equal(majority(four('Launch office starter pack', 'Launch weekend brunch box', 'Call office managers', 'Launch targeted office starter pack')), null);
  assert.equal(agreement(four('fix the offer', 'fix the offer first', 'call leads', 'fix offer')), '3 of 4 seats agree: fix the offer; Sales lead differs: call leads');
  assert.deepEqual(majority(four('fix the offer', 'fix the offer first', 'call leads', 'fix offer')).names, ['AI officer', 'Product lead', 'Co-founder']);
  const three = (...r) => ['Builder', 'Buyer', 'Judge'].map((name, k) => ({ name, recommendation: r[k] ?? null }));
  assert.equal(agreement(three(null, null, 'wait')), 'The seats differ: Judge: wait; two seats gave no clear recommendation');
});

test('council: every seat reads the owner\'s country and currency and that a figure needs a record or a page; figures are marked, Markdown is gone, the Verdict text belongs to its count', async () => {
  assert.match(ownerLine({ country: 'IN', currency: 'INR', locale: 'en-IN' }), /India.*Indian rupees? \(INR, ₹\)/i);
  assert.match(ownerLine({ country: 'IN', currency: 'INR', locale: 'en-IN' }), /record or a page/);
  const seen = [];
  const script = (body) => {
    const s = body.messages[0].content; const u = body.messages.at(-1).content;
    if (/chairman/.test(s)) { seen.push({ chair: u }); return JSON.stringify({ decision: 'Skip the brunch box and run a $500 ad.', reasons: ['Ads reach more offices.'], answer: 'Run ads.' }); }
    if (/review answers/.test(s)) return JSON.stringify({ ranking: ['A', 'B', 'C'] });
    seen.push({ seat: s, user: u });
    if (/You are Buyer/.test(s)) return '**Not now.** It needs $10,000 initially and only reaches 40 offices.\nRecommendation: wait';
    return '**Yes.** At $30 per box it makes $4,500 monthly.\nRecommendation: yes, add the brunch box';
  };
  const t = await testDesk({ modules: ['council'], script });
  try {
    for (const [k, v] of Object.entries({ country: 'IN', currency: 'INR', timeZone: 'Asia/Kolkata', locale: 'en-IN' })) t.core.settings.set(k, v);
    const r = (await t.call('/api/m/council/ask', { body: { question: 'Should my bakery add a weekend brunch box for office teams?', format: 'decision' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    const run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    for (const p of seen.filter(x => x.seat)) { assert.match(p.seat + p.user, /India/); assert.match(p.seat + p.user, /INR/); assert.match(p.seat + p.user, /record or a page/); assert.ok(!/write "not checked"/.test(p.seat + p.user), 'no seat is told to put the words in place of a fact'); }
    assert.match(seen.find(x => x.chair).chair, /India/);
    const all = JSON.stringify(run.answers.map(a => a.text)) + JSON.stringify(run.verdict);
    assert.ok(!/\*\*/.test(all), 'no raw Markdown');
    assert.ok(!/\$\d[\d,]*(?! \(not checked\))(?![\d,])/.test(all), 'every dollar amount is marked: ' + all);
    assert.match(run.answers[0].text, /\$30 \(not checked\) per box/);
    assert.equal(run.verdict.voteLine, '2 of 3 seats agree: yes, add the brunch box; Buyer differs: wait');
    assert.ok(!/Skip the brunch box/.test(run.verdict.decision), 'a decision against the counted course is not shown under it: ' + run.verdict.decision);
    assert.match(run.verdict.decision, /brunch box/i);
  } finally { await t.close(); }
});

test('council: a seat that has not started answering within the door\'s own limit is skipped as "did not answer in time" and the run goes on', async () => {
  const srv = await import('./server.js');
  const was = { ...srv.SEAT_WAIT }; srv.SEAT_WAIT.ms = 400;
  const script = (body) => {
    const s = body.messages[0].content;
    if (/chairman/.test(s)) return JSON.stringify({ decision: 'Buy the CRM.', reasons: ['Cheaper'] });
    if (/review answers/.test(s)) return JSON.stringify({ ranking: ['A', 'B'] });
    if (/You are Judge/.test(s)) return { text: 'Late.\nRecommendation: buy', delayMs: 4000 };
    return 'Buy it.\nRecommendation: buy the CRM';
  };
  const t = await testDesk({ modules: ['council'], script });
  try {
    const t0 = Date.now();
    const r = (await t.call('/api/m/council/ask', { body: { question: 'Should we build or buy a CRM?' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 15000)).status, 'done');
    assert.ok(Date.now() - t0 < 3500, 'the run did not wait for the slow seat');
    const run = (await t.call('/api/m/council/runs/' + r.runId)).json.run;
    assert.equal(run.answers[2].late, true); assert.equal(run.answers[2].text, null); assert.equal(run.answers[2].error, 'did not answer in time');
    assert.ok(run.answers[0].text && run.answers[1].text);
  } finally { Object.assign(srv.SEAT_WAIT, was); await t.close(); }
});

test('council: when the seats differ, a Verdict text that follows no seat\'s course gives way to each seat\'s own words', async () => {
  let decision = 'Launch a marketing campaign.';
  const script = (body) => {
    const s = body.messages[0].content;
    if (/chairman/.test(s)) return JSON.stringify({ decision, reasons: ['Reach'] });
    if (/review answers/.test(s)) return JSON.stringify({ ranking: ['A', 'B', 'C'] });
    const seat = s.match(/You are (\w+)/)[1];
    return { Builder: 'Build it.\nRecommendation: build in-house', Buyer: 'Buy it.\nRecommendation: buy the CRM', Judge: 'Wait.\nRecommendation: wait for the quote' }[seat];
  };
  const t = await testDesk({ modules: ['council'], script });
  try {
    let r = (await t.call('/api/m/council/ask', { body: { question: 'Build or buy a CRM?' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    let v = (await t.call('/api/m/council/runs/' + r.runId)).json.run.verdict;
    assert.match(v.voteLine, /^The seats differ: Builder: build in-house; Buyer: buy the CRM; Judge: wait for the quote$/);
    assert.equal(v.decision, 'The seats differ, so there is no one course yet. Each seat\'s own line is listed below.'); assert.deepEqual(v.reasons, ['Builder: Build it.', 'Buyer: Buy it.', 'Judge: Wait.']); assert.equal(v.split, true);
    decision = 'Wait for the vendor quote, then decide.';
    r = (await t.call('/api/m/council/ask', { body: { question: 'Build or buy a CRM?' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    v = (await t.call('/api/m/council/runs/' + r.runId)).json.run.verdict;
    assert.equal(v.decision, 'The seats differ, so there is no one course yet. The chairman\'s text follows the Judge\'s course: Wait for the vendor quote, then decide.', 'a text that follows one seat\'s course is said to be that seat\'s'); assert.equal(v.reasons.length, 3);
  } finally { await t.close(); }
});

test('council: a range written with a non-breaking hyphen, and a figure with a plus, are marked whole', () => {
  const inr = { given: new Set(), currency: 'INR' };
  assert.equal(markFigures('priced below ₹350‑400 per box', inr), 'priced below ₹350‑400 (not checked) per box');
  assert.equal(markFigures('lock in 10‑15 corporate clients', inr), 'lock in 10‑15 (not checked) corporate clients');
  assert.equal(markFigures('at ₹400+ per box', inr), 'at ₹400+ (not checked) per box');
  assert.equal(markFigures('reach 10k+ offices; 5+3 is 8', { given: new Set(['5', '3', '8']), currency: 'INR' }), 'reach 10k+ (not checked) offices; 5+3 is 8');
  assert.equal(markFigures('a 48‑hour lead time', inr), 'a 48‑hour lead time');
});

test('council: a source the seat says it used, which no record or page gave, is marked on that source', () => {
  const m = stages.markSources;
  assert.equal(m('It needs more staff, according to our previous discussions.'), 'It needs more staff, according to our previous discussions (source not checked).');
  assert.equal(m('Studies show office teams order on Fridays.'), 'Studies show (source not checked) office teams order on Fridays.');
  assert.equal(m('As we discussed, start small.'), 'As we discussed (source not checked), start small.');
  assert.equal(m('According to the brief, there are 12 leads.'), 'According to the brief, there are 12 leads.', 'the brief is a record the seat has');
  assert.equal(m('Research shows (source not checked) it works.'), 'Research shows (source not checked) it works.', 'never marked twice');
});

test('turnaround: when the advisors differ, "Where they agree" never holds the "seats differ" line, the text names the one seat it follows, and no task is offered for the whole Verdict', async () => {
  const recs = { 'AI officer': 'automate lead sourcing', 'Product lead': 'launch website and social pages', 'Sales lead': 'build office lead list', 'Co-founder': 'partner with office parks' };
  const script = (body) => {
    const s = body.messages[0].content;
    if (/chairman/.test(s)) return JSON.stringify({ decision: 'Launch a simple website and social pages, then a trial discount.', reasons: ['Visibility'] });
    if (/review answers/.test(s)) return JSON.stringify({ ranking: ['A', 'B', 'C', 'D'] });
    const seat = s.match(/You are ([\w -]+?), one of/)[1];
    return `I see few leads.\nStep 1: Do it.\nRecommendation: ${recs[seat]}`;
  };
  const t = await testDesk({ modules: ['council', 'tasks'], script });
  try {
    const r = (await t.call('/api/m/council/ask', { body: { format: 'turnaround' } })).json;
    assert.equal((await t.core.jobs.wait(r.jobId, 10000)).status, 'done');
    const v = (await t.call('/api/m/council/runs/' + r.runId)).json.run.verdict;
    assert.match(v.voteLine, /^The seats differ: /);
    assert.deepEqual(v.agree, [], 'no agreement line when the seats differ');
    assert.match(v.decision, /^The seats differ, so there is no one course yet\. The chairman's text follows the Product lead's course: Launch a simple website/);
    assert.equal(v.reasons.length, 4, 'each seat\'s own line');
    assert.deepEqual(v.steps, []); assert.equal(v.split, true);
    const a = await t.call(`/api/m/council/runs/${r.runId}/action`, { body: { action: 'task' } });
    assert.equal(a.status, 404, 'no one course, so no task for the whole Verdict');
  } finally { await t.close(); }
});

test('council: "(not checked)" is put only by code, on a figure; one a model wrote after a word goes, and digits written small are read as digits', () => {
  const shown = (x) => stages.markSources(markFigures(plainText(x), { given: new Set(['50']), currency: 'INR' }));
  assert.equal(shown('Write 50 messages for the owner to check (not checked). Save the owner time (not checked).'), 'Write 50 messages for the owner to check. Save the owner time.');
  assert.equal(shown('Charge ₹350 (not checked) per box.'), 'Charge ₹350 (not checked) per box.');
  assert.equal(shown('hit a ₹350–₄₅₀ price point'), 'hit a ₹350–450 (not checked) price point');
});

test('council: a seat backed by a hired agent records its calls under that agent; bare-model seats and the chairman under the desk', async () => {
  const script = (body) => {
    const s = body.messages[0].content;
    if (/chairman/.test(s)) return JSON.stringify({ decision: 'Buy now.', reasons: ['Faster', 'Cheaper'], answer: 'Buy.' });
    if (/review answers/.test(s)) return JSON.stringify({ ranking: ['A', 'B', 'C'] });
    return 'My position: buy.';
  };
  const t = await testDesk({ modules: ['council'], script });
  try {
    const api = t.core.modules.api('council');
    // one seat is a hired advisor (its own agent id), the other two are bare models
    const j = await api.ask({ question: 'Should we build or buy a rack monitor?', seats: [{ agentId: 'coordinator' }, {}, {}] });
    assert.equal((await t.core.jobs.wait(j.id, 10000)).status, 'done');
    const mine = t.core.storage.get("SELECT COUNT(*) AS c FROM calls WHERE agent_id = 'coordinator' AND purpose = 'council'");
    assert.ok(mine.c >= 1, 'the advisor seat\'s calls are credited to its agent');
    const desk = t.core.storage.get("SELECT COUNT(*) AS c FROM calls WHERE agent_id IS NULL AND purpose = 'council'");
    assert.ok(desk.c >= 1, 'a bare-model seat and the chairman still record under the desk');
  } finally { await t.close(); }
});
