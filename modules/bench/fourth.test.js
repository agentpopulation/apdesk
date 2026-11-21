// Bench, fourth part: what a second real run with free models showed. Drafts say only what the finding says, a second press
// on the same finding does not pile up copies, a lesson that says what an earlier one said is not proposed, plain rule lines
// count, and today's find on a kept finding stays on the same thing. Fake model and stand-ins (plumbing only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { benchDesk } from './fixtures.js';
import { makeDraft, draftText, rulesIn, answerFind, pickFind, hasMore } from './extras.js';
import { sameLesson } from './activities.js';

// three findings as a real run left them (one line each, one quote from a round-up page)
const roundup = { url: 'https://roundup.example/best-payroll', title: 'Best payroll software in India' };
const razorpayx = { id: 'bi_r', kind: 'competitor', title: 'RazorpayX', body: 'Specializes in automated tax filing and payments for TDS, PF, PT, ESIC', evidence: [{ ...roundup, quote: 'Best for Automated Tax Filing & Payments (TDS, PF, PT, ESIC)' }] };
const keka = { id: 'bi_k', kind: 'competitor', title: 'Keka', body: 'Popular choice for its dynamic salary structures and employee-centric UI', evidence: [{ ...roundup, quote: 'Keka – Popular Choice Between Indian Employers' }] };
const zoho = { id: 'bi_z', kind: 'competitor', title: 'Zoho Payroll', body: 'Best value when already in the Zoho stack with native PF, LWF, PT, and ESI support', evidence: [{ ...roundup, quote: 'Zoho Payroll integrates seamlessly with Zoho Books and Zoho People' }] };
const fakeAsk = (replies) => { const asked = []; const ask = async (o) => { asked.push(o); const r = replies[Math.min(asked.length - 1, replies.length - 1)]; return { text: r, route: 'route' + asked.length }; }; return { ask, asked }; };

// the replies a free model really gave for these findings
const KEKA_REPLY = 'Summary: Keka is a leading payroll and HR platform favored by Indian employers for its dynamic salary structures and employee-centric user interface. Its flexible payroll configuration and intuitive design make it a top choice for modern organizations.\n- Offers highly configurable salary components that adapt to varied business models.\n- Includes a mobile-friendly UI designed for easy employee self-service.\n- Simplifies compliance with Indian payroll regulations through automated tax calculations.\n- Provides real-time insights into salary disbursements and workforce analytics.';
const ZOHO_REPLY = 'Summary: Zoho Payroll is best value when already in the Zoho stack with native PF, LWF, PT, and ESI support. It integrates seamlessly with Zoho Books and Zoho People.\n- Zoho Payroll is best value when already in the Zoho stack.\n- Zoho Payroll has native PF, LWF, PT, and ESI support.\n- Zoho Payroll integrates seamlessly with Zoho Books and Zoho People.\nRecommendation: Consider Zoho Payroll when already in the Zoho stack.';

test('drafts: a one-line finding gets "nothing to draft" without a model call', async () => {
  assert.equal(hasMore(razorpayx), false, 'its quote says what its line says');
  const f = fakeAsk(['Summary: x']);
  await assert.rejects(() => makeDraft(f.ask, razorpayx, 'onepager'), (e) => e.code === 'nothing' && /nothing more to say/.test(e.message));
  assert.equal(f.asked.length, 0);
});

test('drafts: lines the finding does not hold are left out; a draft with too little left is not made', async () => {
  const f = fakeAsk([KEKA_REPLY]);
  await assert.rejects(() => makeDraft(f.ask, keka, 'onepager'), (e) => e.code === 'nothing', 'every key point was made up');
  assert.ok(f.asked.length <= 2);
  const z = fakeAsk([ZOHO_REPLY]);
  const d = await makeDraft(z.ask, zoho, 'onepager');
  assert.equal(d.points.length, 3, 'what the finding says stays');
  assert.equal(d.recommendation, 'Consider Zoho Payroll when already in the Zoho stack.');
  // one made-up point among real ones: that one goes, the rest stays
  const mixed = ZOHO_REPLY.replace('- Zoho Payroll has native', '- Consolidated dashboard provides real-time visibility of tax liabilities across multiple departments.\n- Zoho Payroll has native');
  const m = await makeDraft(fakeAsk([mixed]).ask, zoho, 'onepager');
  assert.ok(!m.points.some((p) => /dashboard/.test(p)), m.points.join(' | '));
  assert.equal(m.points.length, 3);
});

test('drafts: no recommendation, no "Recommendation" line', () => {
  const t = draftText({ type: 'onepager', summary: 'S.', points: ['P one.', 'P two.'], recommendation: '', sources: [] });
  assert.ok(!/Recommendation/.test(t), t);
  assert.ok(!/not given/.test(t), t);
});

test('drafts on a press: a second press on the same finding makes it again in place, on another model, not a copy', async () => {
  const { t, bench, at } = await benchDesk({ modules: ['bench', 'chat', 'search', 'sales', 'memory'] });
  try {
    await at(12.05);
    const s = bench.current(); const comp = bench.items(s.id).find((i) => i.kind === 'competitor' && hasMore(i));
    assert.ok(comp, 'a finding with more to say');
    const seen = []; const real = t.core.model.chat.bind(t.core.model);
    t.core.model.chat = async (o) => { if (o.purpose === 'draft') seen.push(`${o.model?.provider}/${o.model?.model}`); return real(o); };
    const one = await t.call(`/api/m/bench/items/${comp.id}/draft`, { body: { type: 'onepager' } });
    assert.equal(one.status, 200, JSON.stringify(one.json));
    const two = await t.call(`/api/m/bench/items/${comp.id}/draft`, { body: { type: 'onepager' } });
    assert.equal(two.status, 200, JSON.stringify(two.json));
    assert.equal(two.json.item.id, one.json.item.id, 'the same draft, made again');
    assert.equal(two.json.item.data.version, (one.json.item.data.version || 1) + 1);
    const drafts = bench.items(s.id).filter((i) => i.kind === 'draft' && i.data.fromItem === comp.id && i.data.draft.type === 'onepager');
    assert.equal(drafts.length, 1, 'no second copy: ' + drafts.map((d) => d.title).join(' | '));
    if (seen.length >= 2 && new Set(seen).size > 1) assert.notEqual(seen.at(-1), seen[0], 'the second go asks another model');
  } finally { await t.close(); }
});

test('lessons: two lessons that ask for the same thing in other words are the same; others are not', () => {
  assert.equal(sameLesson('Answer must be exactly one sentence and concise, no added qualifiers.', 'Answer in exactly one short sentence with no extra explanation.'), true);
  assert.equal(sameLesson('Give the precise current employer PF rate without extra context.', 'Give the precise current employer ESI rate without extra context.'), true);
  assert.equal(sameLesson('Answer with one sentence.', 'Answer with one source per claim.'), false);
  assert.equal(sameLesson('Answer in exactly one short sentence.', 'Provide precisely 10 payroll leads in Pune without conversational filler.'), false);
});

/** Turns in the chat store as the Chat module writes them. */
function addTurns(t, rows) { const at = new Date().toISOString(); for (const r of rows) t.core.storage.run('INSERT INTO m_chat_messages (chat_id, role, agent_id, text, cards, label, status, meta, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', r.chat || 'c1', r.role, r.role === 'user' ? null : 'coordinator', r.text, '[]', null, r.status || 'done', JSON.stringify(r.meta || {}), r.at || at, at); }

test('lessons: the lessons already proposed, kept or dismissed go to the model, and one it says repeats them is not proposed', async () => {
  const { t, bench, at, clock } = await benchDesk({ modules: ['bench', 'chat', 'search', 'memory'] });
  const asked = []; const real = t.core.model.chat.bind(t.core.model);
  try {
    addTurns(t, [{ role: 'user', text: 'What is the PF contribution rate for employers in India? One line.' }, { role: 'assistant', text: '12% of basic wages, with conditions.' }, { role: 'assistant', text: '12%.', meta: { again: true } }]);
    t.core.model.chat = async (o) => { const sys = String(o.messages?.[0]?.content || ''); if (/learn from its mistakes/.test(sys)) { asked.push(o); const json = { lessons: [{ event: 1, lesson: asked.length === 1 ? 'Answer must be exactly one sentence and concise, no added qualifiers.' : 'Answer in exactly one short sentence with no extra explanation.', same: 0 }] }; return { text: JSON.stringify(json), json, provider: 'router', model: 'm', label: 'x' }; } return real(o); };
    await at(1.05);
    const first = bench.items(bench.current().id).filter((i) => i.kind === 'lesson');
    assert.equal(first.length, 1);
    await t.call(`/api/m/bench/items/${first[0].id}/dismiss`, { body: {} });
    addTurns(t, [{ chat: 'c2', role: 'user', text: 'What is the ESI contribution rate for employers in India? One line.' }, { chat: 'c2', role: 'assistant', text: '3.25% of wages, and more.' }, { chat: 'c2', role: 'assistant', text: '3.25%.', meta: { again: true } }]);
    await t.call('/api/m/bench/seen', { body: {} });
    clock.base = clock.t; await at(1.05);
    assert.equal(asked.length, 2);
    const user = String(asked[1].messages.at(-1).content) + String(asked[1].messages[0].content);
    assert.match(user, /Answer must be exactly one sentence and concise/, 'the earlier lesson, dismissed, is shown to the model');
    assert.equal(bench.items(bench.current().id).filter((i) => i.kind === 'lesson').length, 0, 'the near-repeat is not proposed, even when the model did not say so');
  } finally { t.core.model.chat = real; await t.close(); }
});

test('rules: imperative lines count outside a list too, and plain lines under a rules heading with no colon', () => {
  const plain = ['Quote prices including GST.', 'Send invoices on the 1st of the month.', 'Reply to every enquiry within a day.', 'Confirm the delivery address before dispatch.'].join('\n');
  assert.equal(rulesIn(plain, 'a.txt').length, 4, rulesIn(plain, 'a.txt').map((r) => r.text).join(' | '));
  assert.equal(rulesIn('Our rules\n' + plain, 'b.md').length, 4);
  // notes are no rules: plain sentences that are not instructions, and one lone instruction among notes
  const notes = ['Meeting notes', 'The client asked for a demo.', 'Ravi called the bank on Monday.', 'Prices went up in October.', 'Send the deck to Acme.', 'We met at ten.'].join('\n');
  assert.deepEqual(rulesIn(notes, 'n.txt'), []);
});

test("today's find on a kept finding: the search carries the owner's field, and a page about another thing of the same name is left out", async () => {
  const q = pickFind([{ topic: 'Keka', why: 'You kept this Bench finding.', at: '2026-11-21', about: 'payroll' }]);
  assert.equal(q.about, 'payroll');
  const searched = [];
  const pages = {
    'https://keka.example-archiver/': { title: 'Keka', text: 'Keka, the macOS file archiver. Store more, share with privacy. Keka is a file archiver for macOS that can create 7z and zip archives. '.repeat(4) },
    'https://keka.example-hr/': { title: 'Keka HR', text: 'Keka is payroll and HR software for Indian businesses. Keka payroll now files PF and ESI returns for you. '.repeat(4) },
  };
  const b = { signal: new AbortController().signal, api: () => null,
    async search(s) { searched.push(s); return Object.keys(pages).map((url) => ({ url })); },
    async read(u) { return { url: u, ...pages[u] }; },
    async ask(o) { const user = String(o.messages.at(-1).content); assert.ok(!/macOS/.test(user), 'the archiver page is not given to the model'); return { json: { answer: [{ sentence: 'Keka payroll now files PF and ESI returns.', page: 1, quote: 'Keka payroll now files PF and ESI returns for you' }] } }; } };
  const r = await answerFind(b, q);
  assert.match(searched[0], /payroll/);
  assert.equal(r.status, 'answered');
  assert.deepEqual(r.sources.map((s) => s.url), ['https://keka.example-hr/']);
});
