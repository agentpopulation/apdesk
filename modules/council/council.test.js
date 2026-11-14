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
  const router = { provider: 'router', kind: 'router', label: 'Agent Population Router', ok: true, model: 'llama-3.3-70b', models: ['llama-3.3-70b', 'llama-3.1-8b', 'qwen3-32b', 'mistral-small', 'gpt-oss-120b', 'nomic-embed-text'] };
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
    for (const a of run.answers) { assert.equal(a.text, half + ' three years. So we should buy.'); assert.equal(a.cut, false); }
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
  assert.equal(agreement(seats('build', 'buy', 'wait')), 'The seats disagree: Builder: build; Buyer: buy; Judge: wait');
  assert.equal(agreement(seats('buy the CRM', null, 'buy')), '2 of 3 seats recommend buy the CRM; one seat gave no clear recommendation');
  assert.equal(agreement(seats('build', null, 'buy')), 'The seats disagree: Builder: build; Judge: buy; one seat gave no clear recommendation');
  assert.equal(agreement(seats(null, null, 'wait')), '1 of 3 seats recommends wait; two seats gave no clear recommendation');
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

test('council: the Verdict headline counts the seats\' recommendations, the ranking keeps its own name, a fallback model is named, the seats\' sums are left as written with the figures note', async () => {
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
    for (const a of run.answers) assert.equal(a.text, 'Buy the CRM. At 1,500 × 10 × 12 = 18,000 rupees a year it is cheaper than building.\nRecommendation: buy the CRM');
    assert.equal(run.verdict.reasons[0], 'Hiring 2 people at ₹6 lakh each plus ₹3 lakh tools = ₹15 lakh.');
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
