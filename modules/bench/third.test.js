// Bench, third part: what a real run with free models showed. Drafts that free models can give, lessons that do not blame the
// owner's own Stop and are not proposed twice, why there is no find, usage rows and the owner's day, the spend words, the
// note's grammar, wider rule lines, and the owner's own name for Bench. Fake model and stand-ins (plumbing only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { benchDesk, H } from './fixtures.js';
import { makeDraft, rulesIn, zoneDayStart, hasMore } from './extras.js';
import { buildNote, freshPlan } from './engine.js';
import { usageTable, spendWords, placeName } from './ui.js';

const page = { url: 'https://nimbus.example/pricing', title: 'Nimbus pricing', quote: 'Nimbus has a mobile app for leave and attendance' };
const finding = { id: 'bi_1', kind: 'competitor', title: 'Nimbus HR', body: 'Nimbus offers payroll and HR software. Price: Rs 9,999 per month.', evidence: [page] };
/** A stand-in for the model door: replies in turn, records what was asked. */
const fakeAsk = (replies) => { const asked = []; const ask = async (o) => { asked.push(o); const r = replies[asked.length - 1]; if (r instanceof Error) throw r; return { text: r, route: 'route' + asked.length }; }; return { ask, asked }; };

test('drafts: plain lines are enough, a cut-off reply is tried once more on another model, and nothing is made up', async () => {
  let f = fakeAsk(['Summary: Nimbus offers payroll and HR software.\nKey points:\n- **Payroll and HR software.**\n- Rs 9,999 per month.\nRecommendation: Look at the Rs 9,999 per month price.']);
  let d = await makeDraft(f.ask, finding, 'onepager');
  assert.equal(d.summary, 'Nimbus offers payroll and HR software.');
  assert.deepEqual(d.points, ['Payroll and HR software.', 'Rs 9,999 per month.']);
  assert.equal(d.recommendation, 'Look at the Rs 9,999 per month price.');
  assert.deepEqual(d.sources, [{ title: 'Nimbus pricing', url: page.url }], 'sources from the finding only');
  assert.notEqual(f.asked[0].json, true, 'no JSON is asked for');
  // the reply a thinking model cut off in the middle (seen with a free model): one more try, on another route
  f = fakeAsk(['\n\n{\n  "summary": "Nimbus HR offers payroll", \n  "points": [\n    "Nimbus offers payroll', 'Summary: Nimbus offers payroll software.\n- Nimbus offers payroll and HR software.\n- Nimbus has a mobile app.\nRecommendation: Read their page.']);
  d = await makeDraft(f.ask, finding, 'onepager');
  assert.equal(f.asked.length, 2); assert.deepEqual(f.asked[1].avoid, ['route1'], 'the second try avoids the model that gave the cut-off reply');
  assert.equal(d.summary, 'Nimbus offers payroll software.');
  // still nothing usable after the second try: a plain error, no third call
  f = fakeAsk(['Summary only, no points', 'also nothing']);
  await assert.rejects(() => makeDraft(f.ask, finding, 'onepager'), (e) => e.code === 'shape' && /two free models/.test(e.message));
  assert.equal(f.asked.length, 2);
  // the old JSON shape is still read
  f = fakeAsk([JSON.stringify({ summary: 'Nimbus offers payroll software.', points: ['Nimbus has a mobile app.', 'Rs 9,999 per month.'], recommendation: '' })]);
  assert.equal((await makeDraft(f.ask, finding, 'onepager')).summary, 'Nimbus offers payroll software.');
  // a next-actions list as "action | effort | why" lines
  f = fakeAsk(['1. Compare prices | small | Their price is on their page.\n2. Call two buyers | medium | To hear what they pay.\n3. Write a price page | large | Buyers look for it.']);
  d = await makeDraft(f.ask, finding, 'actions');
  assert.deepEqual(d.actions.map((a) => a.effort), ['small', 'medium', 'large']);
});

test('drafts: a finding with nothing more to say than itself makes no draft, and says so', async () => {
  const lesson = { id: 'bi_2', kind: 'lesson', title: 'Give a detailed response.', body: 'You pressed Stop on the reply to: "Find 10 leads"', evidence: [{ url: '', title: 'Your chat', quote: 'Find 10 leads' }] };
  let f = fakeAsk(['Summary: x\n- y']);
  await assert.rejects(() => makeDraft(f.ask, lesson, 'onepager'), (e) => e.code === 'nothing' && /nothing more to say/.test(e.message));
  assert.equal(f.asked.length, 0, 'no page behind it: the model is not asked');
  f = fakeAsk(['NONE']);
  await assert.rejects(() => makeDraft(f.ask, finding, 'onepager'), (e) => e.code === 'nothing');
  assert.equal(f.asked.length, 1, 'the model said there is nothing to add: no second try');
});

test('drafts on a press: a failure is a plain answer, not a stuck task; a finding with no page offers no draft', async () => {
  const { t, bench, at } = await benchDesk({ modules: ['bench', 'chat', 'search', 'sales', 'memory'] });
  try {
    await at(12.05);
    const s = bench.current(); const comp = bench.items(s.id).find((i) => i.kind === 'competitor' && hasMore(i));
    const real = t.core.model.chat.bind(t.core.model);
    t.core.model.chat = async (o) => o.purpose === 'draft' ? { text: '{"summary": "cut off', label: 'x', provider: 'router', model: 'm' } : real(o);
    const r = await t.call(`/api/m/bench/items/${comp.id}/draft`, { body: { type: 'onepager' } });
    assert.equal(r.status, 409); assert.match(r.json.error, /^The draft was not made: /);
    const p = (await t.call('/api/m/bench/return')).json;
    assert.ok(!p.didntGetTo.some((d) => /one-pager/.test(d.title)), 'no "did not finish" task left behind: ' + JSON.stringify(p.didntGetTo));
    assert.ok(!t.core.jobs.list({ limit: 50 }).some((j) => j.kind === 'bench.draft' && j.status === 'failed' && !j.quiet));
    t.core.model.chat = real;
    const sess = (await t.call(`/api/m/bench/sessions/${s.id}`)).json.items;
    assert.equal(sess.find((i) => i.id === comp.id).draftable, true);
    const lesson = sess.find((i) => i.kind === 'lesson' || i.kind === 'needs' || i.kind === 'work');
    if (lesson) {
      assert.equal(lesson.draftable, false);
      const n = await t.call(`/api/m/bench/items/${lesson.id}/draft`, { body: { type: 'onepager' } });
      assert.ok([400, 409].includes(n.status));
    }
  } finally { await t.close(); }
});

/** Turns in the chat store as the Chat module writes them. */
function addTurns(t, rows) { const at = new Date().toISOString(); for (const r of rows) t.core.storage.run('INSERT INTO m_chat_messages (chat_id, role, agent_id, text, cards, label, status, meta, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', r.chat || 'c1', r.role, r.role === 'user' ? null : 'coordinator', r.text, '[]', null, r.status || 'done', JSON.stringify(r.meta || {}), r.at || at, at); }

test('lessons: the owner\'s own Stop is no mistake to learn from; a lesson already proposed, kept or dismissed is not proposed again', async () => {
  const { t, bench, at, clock } = await benchDesk({ modules: ['bench', 'chat', 'search', 'memory'] });
  try {
    addTurns(t, [{ role: 'user', text: 'Find 10 leads for my payroll software' }, { role: 'assistant', text: 'Stopped', status: 'stopped' }]);
    await at(1.05);
    let s = bench.current();
    assert.equal(bench.items(s.id).filter((i) => i.kind === 'lesson').length, 0, 'no lesson from a Stop');
    addTurns(t, [{ chat: 'c2', role: 'user', text: 'Research the HR market in Pune' }, { chat: 'c2', role: 'assistant', text: 'Here.' }, { chat: 'c2', role: 'assistant', text: 'Again.', meta: { again: true } }]);
    await t.call('/api/m/bench/seen', { body: {} });
    clock.base = clock.t; await at(1.05);
    s = bench.current();
    const first = bench.items(s.id).filter((i) => i.kind === 'lesson');
    assert.equal(first.length, 1, 'one lesson from Try again');
    await t.call(`/api/m/bench/items/${first[0].id}/dismiss`, { body: {} });
    await t.call('/api/m/bench/seen', { body: {} });
    clock.base = clock.t; await at(1.05);
    assert.equal(bench.items(bench.current().id).filter((i) => i.kind === 'lesson').length, 0, 'the same turn gives no lesson twice, even dismissed');
  } finally { await t.close(); }
});

test('return page: why there is no find on a new desk', async () => {
  const { t, at } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    await at(1.05);
    const p = (await t.call('/api/m/bench/return')).json;
    assert.equal(p.find, null);
    assert.equal(p.findWhy, 'No finished tasks or ratings to pick a question from yet.');
  } finally { await t.close(); }
});

test('usage: "today" is the owner\'s day in his zone, and the rows carry their values', async () => {
  // 21 Nov 2026 20:00 UTC is 22 Nov 01:30 in India: the owner's day began at 21 Nov 18:30 UTC
  assert.equal(new Date(zoneDayStart(Date.UTC(2026, 10, 21, 20, 0), 'Asia/Kolkata')).toISOString(), '2026-11-21T18:30:00.000Z');
  assert.equal(new Date(zoneDayStart(Date.UTC(2026, 10, 21, 3, 0), 'America/New_York')).toISOString(), '2026-11-20T05:00:00.000Z');
  const { t, clock } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    t.core.settings.set('timeZone', 'Asia/Kolkata');
    clock.t = Date.UTC(2026, 10, 21, 20, 0);
    assert.equal((await t.call('/api/m/bench/usage')).json.day, '2026-11-21T18:30:00.000Z');
  } finally { await t.close(); }
  const tb = usageTable({ currency: 'INR', agents: [{ agent: 'coordinator', calls: 1, errors: 0, inputTokens: 10, outputTokens: 5, costMinor: 0 }, { agent: '(desk)', calls: 1, errors: 0, inputTokens: 3, outputTokens: 2, costMinor: 0 }] }, { money: (m) => '₹' + m / 100 });
  assert.ok(tb.cols.every((c) => c.key && c.label), 'columns as the kit table reads them');
  assert.deepEqual(tb.rows.map((r) => tb.cols.map((c) => r[c.key])), [['coordinator', '1', '0', '15', '—'], ['The desk', '1', '0', '5', '—']]);
});

test('spend words: a free key\'s list price is no paid spend; the header words are apart', async () => {
  const fmt = { money: (m) => '₹' + Math.round(m / 100) };
  assert.equal(spendWords({ daySpendMinor: 0 }, fmt), 'No paid spend today');
  assert.equal(spendWords({ daySpendMinor: 12000 }, fmt), '₹120 spent today');
  const { t } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    t.core.model.record({ provider: 'gemini', model: 'gemini-3.6-flash', ok: true, ms: 10, usage: { input: 20000, output: 20000 } });   // a free-tier key: priced by the list, not paid
    assert.equal((await t.call('/api/m/bench/state')).json.gate.daySpendMinor, 0);
    t.core.model.record({ provider: 'openai', model: 'gpt-4o', ok: true, ms: 10, usage: { input: 1_000_000, output: 0 } });
    assert.ok((await t.call('/api/m/bench/state')).json.gate.daySpendMinor > 0, 'a paid provider is paid spend');
  } finally { await t.close(); }
});

test('the note: the count agrees in number', () => {
  const s = { started: '2026-11-21T10:00:00Z', ended: '2026-11-21T11:00:00Z', state: 'done', plan: freshPlan(), tier: 1, models: [] };
  const one = buildNote(s, [{ id: 'a', kind: 'lesson', tier: 1, title: 'x', complete: true, state: 'new', created: '1' }]);
  assert.equal(one.head[2], '1 finding waits for you: Keep, Dismiss or Turn into a task.');
  assert.equal(buildNote(s, []).head[2], 'No findings wait for you.');
  assert.match(buildNote(s, [], { name: 'Night shift' }).head[0], /^Night shift ran for 1 hour/);
});

test('rules: a line in a list of rules counts by its place, not only by its words', () => {
  const file = ['# House rules', '- Always say the city first.', '- Never send mail on Sundays.', '- At most 3 quotes per page.', '- Quote prices including GST.',
    '- Reply to every customer within one working day.', '- Sign off with the company name.', '- Keep invoices in rupees.', '- Check the delivery date before you promise it.',
    '- Do not share a customer\'s phone number.', '- Add the order number to every reply.', '', '# Notes', '- The shop opens at ten.', 'A plain line here.'].join('\n');
  const found = rulesIn(file, 'knowledge/rules.md');
  assert.ok(found.some((r) => r.text === 'Quote prices including GST.'), found.map((r) => r.text).join(' | '));
  assert.equal(found.length, 10, 'all ten rules: ' + found.map((r) => r.text).join(' | '));
  assert.ok(!found.some((r) => /shop opens|plain line/.test(r.text)), 'a note under another heading is no rule');
  // a list of rules under no rules heading: two keyword rules make the list a list of rules
  const list = rulesIn('Our way:\n- Always reply the same day.\n- Never promise a date.\n- Quote prices including GST.\n', 'a.md');
  assert.deepEqual(list.map((r) => r.text), ['Always reply the same day.', 'Never promise a date.', 'Quote prices including GST.']);
});

test('the owner\'s name for Bench: the page and settings use it', () => {
  assert.equal(placeName({ label: (p, f) => (p === 'bench' ? 'Night shift' : f) }), 'Night shift');
  assert.equal(placeName({ label: (p, f) => f }), 'Bench');
  assert.equal(placeName({}), 'Bench', 'a shell that offers no name: the default');
});

test('the owner\'s name for Bench: the note on the server uses it', async () => {
  const { t, at } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    t.core.settings.set('ui.menu', { names: { bench: 'Night shift' } });
    await at(1.05);
    await t.call('/api/m/bench/seen', { body: {} });
    const s = (await t.call('/api/m/bench/sessions')).json.sessions[0];
    const n = (await t.call(`/api/m/bench/sessions/${s.id}`)).json;
    assert.match(n.text, /^Night shift ran for /);
    const st = await t.call('/api/m/bench/start', { body: {} });
    assert.match(st.json.text || '', /^Night shift started\./);
  } finally { await t.close(); }
});
