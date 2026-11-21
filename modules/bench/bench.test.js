// Bench mode: plumbing tests with the fake model and a fake clock (never proof that the findings are good; see real-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { benchDesk, H, ABOUT, script, stubWeb } from './fixtures.js';
import { testHooks } from './server.js';
import { tierFor, nextActivity, freshPlan, modelOrder, buildNote, noteText, ACTIVITIES } from './engine.js';
import { turnSignals, askGroups } from './activities.js';
import { createDesk } from '../../app/server.js';
import { startFakeLlm } from '../../test/helpers/fake-llm.js';

const statuses = (s) => Object.fromEntries(Object.entries(s.plan).map(([k, p]) => [k, p.status]));
const tierOf = (id) => ACTIVITIES.find((a) => a.id === id).tier;
const ranUpTo = (s, tier) => Object.entries(statuses(s)).every(([k, st]) => (tierOf(k) <= tier ? st !== 'pending' && st !== 'running' : st === 'pending'));
/** Turns in the chat store as the Chat module writes them (role, status, the again mark, tool steps, cards). */
function addTurns(t, rows) { const at = new Date().toISOString(); for (const r of rows) t.core.storage.run('INSERT INTO m_chat_messages (chat_id, role, agent_id, text, cards, label, status, meta, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', r.chat || 'c1', r.role, r.role === 'user' ? null : 'coordinator', r.text, JSON.stringify(r.cards || []), null, r.status || 'done', JSON.stringify(r.meta || {}), r.at || at, at); }

test('rules: tiers open at 1, 12, 36 and 108 hours; earlier tiers first; offline takes only the no-web activities', () => {
  assert.deepEqual([0.9, 1, 11.9, 12, 35.9, 36, 107.9, 108, 500].map((h) => tierFor(h * H)), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  const plan = freshPlan();
  assert.equal(nextActivity(plan, { tier: 0, online: true }), null);
  assert.equal(nextActivity(plan, { tier: 4, online: true }).id, 'unfinished', 'a tier-1 activity not yet run goes before later tiers');
  plan.unfinished.status = 'done';
  assert.equal(nextActivity(plan, { tier: 1, online: false }).id, 'lessons', 'offline: the self-check (web) waits, lessons run');
  plan.lessons.status = 'done';
  assert.equal(nextActivity(plan, { tier: 1, online: false }), null);
  assert.equal(nextActivity(plan, { tier: 2, online: false }).id, 'skills');
});

test('model order: local first, then free; paid only when Bench says "also paid" AND paid is already allowed for that provider', () => {
  const active = [{ provider: 'router', kind: 'router', ok: true }, { provider: 'ollama', kind: 'local', ok: true, models: ['q'] }, { provider: 'gemini', kind: 'keyed', ok: true }, { provider: 'openai', kind: 'keyed', ok: true }, { provider: 'openrouter', kind: 'keyed', ok: true }];
  const tiers = { gemini: 'free-signup', openai: 'paid', openrouter: 'free-signup' };
  const ids = (o) => o.map((x) => `${x.provider}${x.model ? ':' + x.model : ''}`);
  assert.deepEqual(ids(modelOrder(active, { mode: 'local', tiers })), ['ollama']);
  assert.deepEqual(ids(modelOrder(active, { mode: 'free', tiers, paidAllowed: () => true })), ['ollama', 'router', 'gemini', 'openrouter:openrouter/free'], 'free mode never adds a paid provider, even when paid is allowed');
  assert.deepEqual(ids(modelOrder(active, { mode: 'paid', tiers, paidAllowed: () => false })), ['ollama', 'router', 'gemini', 'openrouter:openrouter/free'], 'Bench switch on but paid not allowed: still none');
  assert.deepEqual(ids(modelOrder(active, { mode: 'paid', tiers, paidAllowed: (p) => p === 'openai' })), ['ollama', 'router', 'gemini', 'openrouter:openrouter/free', 'openai']);
});

test('signals: Stop, Try again and asking again in nearly the same words come from the chat store, not from wording', () => {
  const at = (m) => new Date(Date.UTC(2026, 10, 20, 10, m)).toISOString();
  const s = turnSignals([
    { chatId: 'a', role: 'user', text: 'Find 10 leads for my payroll software', at: at(0) }, { chatId: 'a', role: 'assistant', text: 'Looking…', status: 'stopped', at: at(1) },
    { chatId: 'b', role: 'user', text: 'Research the HR market in Pune', at: at(0) }, { chatId: 'b', role: 'assistant', text: 'Here.', status: 'done', at: at(1) }, { chatId: 'b', role: 'assistant', text: 'Again.', status: 'done', meta: { again: true }, at: at(2) },
    { chatId: 'c', role: 'user', text: 'List payroll software firms in Pune with prices', at: at(0) }, { chatId: 'c', role: 'assistant', text: 'Here.', status: 'done', at: at(1) }, { chatId: 'c', role: 'user', text: 'List payroll software firms in Pune with their prices', at: at(3) },
    { chatId: 'd', role: 'user', text: 'Thanks, that is wrong and bad', at: at(0) }, { chatId: 'd', role: 'assistant', text: 'Sorry.', status: 'done', at: at(1) },
  ]);
  assert.deepEqual(s.map((x) => x.kind), ['stopped', 'again', 'asked again'], 'words like "wrong" alone are no signal');
  const g = askGroups([1, 2, 3].flatMap((i) => [{ role: 'user', text: `Research topic ${i}` }, { role: 'assistant', status: 'done', meta: { steps: [{ tool: 'research_deep', status: 'done' }] }, cards: [{ kind: 'report' }] }]));
  assert.equal(g.length, 1); assert.equal(g[0].key, 'research_deep -> report');
});

test('a 108-hour session: tiers unlock in order, the note is built from the items, nothing is applied until Keep', async () => {
  const d = await benchDesk();
  const { t, bench, at } = d;
  const spy = { approvals: [], settings: [], mail: 0, channels: 0, memory: 0, skills: 0, leads: 0 };
  const realReq = t.core.approval.request.bind(t.core.approval); t.core.approval.request = (r) => { spy.approvals.push(r); return realReq(r); };
  const realSet = t.core.settings.set.bind(t.core.settings);
  t.core.modules.active.set('mail', { handle: null, api: { send: async () => { spy.mail++; } } });
  t.core.modules.active.set('channels', { handle: null, api: { send: async () => { spy.channels++; } } });
  try {
    const sales = t.core.modules.api('sales'); sales.addLead({ company: 'Lyra Foods' });
    fs.mkdirSync(t.core.storage.workspacePath('knowledge'), { recursive: true });
    fs.writeFileSync(t.core.storage.workspacePath('knowledge', 'our-customers.csv'), 'Company,Site\nOrion Textiles,orion-textiles.example\n');
    addTurns(t, [{ role: 'user', text: 'Find 10 leads for my payroll software' }, { role: 'assistant', text: 'Looking…', status: 'stopped' },
      ...[1, 2, 3].flatMap((i) => [{ role: 'user', text: `Research the payroll market ${i}` }, { role: 'assistant', text: 'Done', meta: { steps: [{ tool: 'research_deep', status: 'done' }] }, cards: [{ kind: 'report' }] }])]);
    t.core.storage.run("INSERT INTO jobs (id, kind, title, status, progress, detail, input, error, created, updated, finished) VALUES ('job_x1', 'tasks.run', 'Compare three payroll tools', 'failed', 0, 'Failed', '{}', 'No model answered. Free API: busy', ?, ?, ?)", new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const counts = () => ({ memory: t.core.storage.get("SELECT COUNT(*) AS c FROM m_memory_items").c, skills: (t.core.modules.api('agents').catalog().skills.filter((s) => s.custom)).length, leads: sales.listLeads().length });
    const before = counts();
    t.core.settings.set = (k, v) => { spy.settings.push(k); return realSet(k, v); };

    await at(0.4); assert.equal(bench.current(), null, 'away less than 30 minutes: no session');
    await at(0.6); assert.equal(bench.current().tier, 0); assert.ok(ranUpTo(bench.current(), 0), 'a session waits for the first hour');
    await at(1.05); assert.ok(ranUpTo(bench.current(), 1), JSON.stringify(statuses(bench.current())));
    await at(11.9); assert.ok(ranUpTo(bench.current(), 1));
    await at(12.05); assert.ok(ranUpTo(bench.current(), 2), JSON.stringify(statuses(bench.current())));
    await at(36.05); assert.ok(ranUpTo(bench.current(), 3), JSON.stringify(statuses(bench.current())));
    await at(108.05); assert.ok(ranUpTo(bench.current(), 4), JSON.stringify(statuses(bench.current())));
    const s = bench.current(); const list = bench.items(s.id);
    const kinds = new Set(list.map((i) => i.kind));
    for (const k of ['needs', 'lesson', 'profile', 'competitor', 'skill', 'lead', 'funding', 'tool', 'plan']) assert.ok(kinds.has(k), `an item of kind ${k}: ${[...kinds]}`);
    // limits: nothing asked, sent or set; nothing written into Memory, Agents, Sales or Settings
    assert.deepEqual(spy.approvals, [], 'no approval was asked'); assert.equal(spy.mail + spy.channels, 0, 'nothing was sent');
    assert.deepEqual(spy.settings, [], 'no setting was written'); assert.deepEqual(counts(), before, 'nothing applied before Keep');
    assert.ok(list.every((i) => i.state === 'new'));
    // the customers: "already a customer" from the Knowledge file, "already in your pipeline", or new; each says what was searched for whom
    const leads = list.filter((i) => i.kind === 'lead');
    assert.ok(leads.find((i) => /^Orion Textiles.*already a customer$/.test(i.title)), leads.map((i) => i.title).join(' | '));
    assert.ok(leads.find((i) => /^Lyra Foods: already in your pipeline$/.test(i.title)), leads.map((i) => i.title).join(' | '));
    assert.ok(leads.every((i) => /^Leads for: Payroll software for small firms .*\(from what you told me you sell\)\./.test(i.body)), leads[0].body);
    // facts only from pages: the profile line with no quote on the page is left out; a deadline only as the page states it
    assert.ok(!/Made up/.test(list.find((i) => i.kind === 'profile').body));
    assert.match(list.find((i) => i.kind === 'funding').body, /Deadline: 31 December 2026\./);
    // the owner comes back: the session ends, the note is built from the items only
    await t.call('/api/m/bench/seen', { body: {} });
    assert.equal(bench.current(), null);
    const n = (await t.call('/api/m/bench/state')).json.note;
    assert.ok(n, 'the note is ready');
    const titles = new Set(n.items.map((i) => i.title));
    for (const line of n.text.split('\n').filter((l) => l.startsWith('- ') && !/^- .*: (not reached|.*\.)$/.test(l) && !/^- (Not started|.*budget)/.test(l))) assert.ok(titles.has(line.slice(2)), `a note line that is not an item: ${line}`);
    assert.match(n.text, /^Bench ran for 4 days 11 hours; you came back\.\nThe work was done by Free API · fake-model\./);
    assert.equal(n.note.best.length, 3); assert.ok(n.note.best.every((i) => i.complete));
    // Keep applies exactly one item through its module; Dismiss takes one off the note
    t.core.settings.set = realSet;
    const lesson = n.items.find((i) => i.kind === 'lesson'); const skill = n.items.find((i) => i.kind === 'skill'); const lead = n.items.find((i) => i.kind === 'lead' && /: new$/.test(i.title));
    assert.equal((await t.call(`/api/m/bench/items/${lesson.id}/keep`, { body: {}, session: false })).status, 403, 'only the owner keeps');
    assert.equal((await t.call(`/api/m/bench/items/${lesson.id}/keep`, { body: {} })).status, 200);
    assert.deepEqual(counts(), { ...before, memory: before.memory + 1 });
    assert.equal(t.core.storage.get("SELECT kind FROM m_memory_items ORDER BY rowid DESC LIMIT 1").kind, 'lesson');
    await t.call(`/api/m/bench/items/${skill.id}/keep`, { body: {} });
    assert.deepEqual(counts(), { ...before, memory: before.memory + 1, skills: before.skills + 1 });
    const added = t.core.modules.api('agents').catalog().skills.filter((x) => x.custom).at(-1);
    assert.ok(!t.core.agents.list().some((a) => (a.meta?.skills || []).includes(added.id)), 'the skill is on for no agent');
    await t.call(`/api/m/bench/items/${lead.id}/keep`, { body: {} });
    assert.deepEqual(counts(), { ...before, memory: before.memory + 1, skills: before.skills + 1, leads: before.leads + 1 });
    assert.equal(sales.listLeads().at(-1).stage, 'new');
    assert.equal((await t.call(`/api/m/bench/items/${lead.id}/keep`, { body: {} })).status, 409, 'a decided item cannot be kept twice');
    const comp = n.items.find((i) => i.kind === 'competitor');
    await t.call(`/api/m/bench/items/${comp.id}/dismiss`, { body: {} });
    const n2 = (await t.call(`/api/m/bench/sessions/${n.session.id}`)).json;
    assert.ok(!n2.text.includes('- ' + comp.title) || n.items.filter((i) => i.title === comp.title).length > 1, 'dismissed: off the note');
    assert.ok(!n2.text.includes('- ' + lesson.title), 'kept: off the note');
  } finally { t.core.settings.set = realSet; await t.close(); }
});

test('owner activity stops a running session at once; Panic stops it and it does not start again by itself', async () => {
  const d = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  const { t, bench, clock } = d;
  try {
    addTurns(t, [{ role: 'user', text: 'Find 10 leads' }, { role: 'assistant', text: '…', status: 'stopped' }]);
    // a slow model: the lessons activity is running when the owner comes back
    let release; const gate = new Promise((r) => { release = r; });
    const real = t.core.model.chat.bind(t.core.model); t.core.model.chat = async (o) => { await Promise.race([gate, new Promise((r, j) => o.signal?.addEventListener('abort', () => j(Object.assign(new Error('Stopped'), { code: 'aborted' })), { once: true }))]); return real(o); };
    clock.t = clock.base + 1.1 * H;
    await bench.tick(); await bench.tick(); await bench.tick();   // unfinished, self-check, then lessons waits on the model
    const s = bench.current(); assert.equal(s.plan.lessons.status, 'running', JSON.stringify(statuses(s)));
    const job = t.core.jobs.list({ limit: 5 }).find((j) => j.kind === 'bench.lessons');
    assert.equal(job.quiet, true, 'Bench jobs are quiet: no finish notice or menu count while the owner is away');
    const r = await t.call('/api/m/bench/seen', { body: {} });
    assert.equal(r.json.ended, s.id);
    assert.equal(t.core.jobs.get(job.id).status, 'stopped', 'the running job stopped at once');
    release(); await bench.idle();
    const ended = bench.session(s.id); assert.equal(ended.state, 'done'); assert.equal(ended.plan.lessons.status, 'pending');
    assert.equal(ended.endWhy, 'you came back');
    // away again: a new session; Panic ends it and nothing starts after Resume until the owner has been back
    clock.t += 2 * H; await bench.tick(); await bench.idle();
    const s2 = bench.current(); assert.ok(s2 && s2.id !== s.id);
    await t.call('/api/panic', { body: {} });
    assert.equal(bench.session(s2.id).state, 'stopped'); assert.equal(bench.session(s2.id).endWhy, 'Panic stopped it');
    await t.call('/api/panic/resume', { body: {} });
    clock.t += 50 * H; await bench.tick(); await bench.idle();
    assert.equal(bench.current(), null, 'after Panic and Resume, Bench does not start by itself');
    await t.call('/api/m/bench/seen', { body: {} });
    clock.t += 2 * H; await bench.tick(); await bench.idle();
    assert.ok(bench.current(), 'once the owner has been back and away again, it may start');
  } finally { await t.close(); }
});

test('offline: only the activities that need no web run; battery below the level pauses; budgets hold', async () => {
  const d = await benchDesk({ modules: ['bench', 'chat', 'search', 'research'] });
  const { t, bench, at, clock, reads } = d;
  try {
    // a local model (the fake, as Ollama): the only model the desk may use offline
    t.core.settings.set('ollama.baseUrl', d.t.fake.ollamaUrl); t.core.model.cache.clear();
    addTurns(t, [{ role: 'user', text: 'Find 10 leads' }, { role: 'assistant', text: '…', status: 'stopped' }]);
    t.core.settings.set('online', false);
    testHooks.battery = async () => ({ hasBattery: true, acConnected: false, isCharging: false, percent: 12 });
    await at(13);
    const s = bench.current(); assert.equal(s.why, 'battery'); assert.ok(Object.values(s.plan).every((p) => p.status === 'pending'), 'on battery below 30%: nothing runs');
    testHooks.battery = async () => ({ hasBattery: false, acConnected: true, percent: 0 });   // a desktop with no battery is never low
    await at(13.1);
    const st = statuses(bench.current());
    assert.deepEqual([st.unfinished, st.lessons, st.skills], ['done', 'done', 'done'], JSON.stringify(st));
    assert.deepEqual([st.selfcheck, st.business, st.competitors], ['pending', 'pending', 'pending'], 'web activities wait while offline');
    assert.equal(bench.current().plan.business.why, 'the desk is offline');
    assert.equal(reads.length, 0, 'no page was read');
    assert.ok(t.fake.calls.length >= 1 && bench.current().models.every((m) => /^Ollama/.test(m)), bench.current().models.join());
    await t.call('/api/m/bench/seen', { body: {} });
    // budgets: one model call per activity, three per session
    t.core.settings.set('online', true);
    testHooks.budget = { activity: { calls: 1, pages: 1, searches: 1, minutes: 25 }, session: { calls: 3, pages: 2, searches: 2, minutes: 60 } };
    const calls0 = t.fake.calls.length; const reads0 = reads.length;
    clock.t += 200 * H; await bench.tick(); await bench.idle();
    for (let i = 0; i < 20; i++) { if (!await bench.tick()) break; await bench.idle(); }
    const s3 = bench.current();
    assert.ok(s3.used.calls <= 3 && t.fake.calls.length - calls0 <= 3, `calls ${s3.used.calls}`);
    assert.ok(s3.used.pages <= 2 && reads.length - reads0 <= 2, `pages ${s3.used.pages}`);
    assert.ok(Object.values(s3.plan).some((p) => /budget/.test(p.why || '')), JSON.stringify(s3.plan));
  } finally { testHooks.budget = null; await t.close(); }
});

test('paid models: never used unless Bench says "also paid" and paid use is already allowed for that provider', async () => {
  const d = await benchDesk({ modules: ['bench', 'chat'] });
  const { t, bench, clock } = d;
  try {
    t.core.model.addKey('openai', 'sk-fake-123456789', 'test', { baseUrl: t.fake.baseUrl });
    t.core.settings.set('router.enabled', false); t.core.model.cache.clear();   // no free model: only the paid key could answer
    addTurns(t, [{ role: 'user', text: 'Find 10 leads' }, { role: 'assistant', text: '…', status: 'stopped' }]);
    const paidCalls = () => t.core.storage.get("SELECT COUNT(*) AS c FROM calls WHERE provider = 'openai'").c;
    const run = async () => { clock.t += 3 * H; for (let i = 0; i < 5; i++) { if (!await bench.tick()) break; await bench.idle(); } await t.call('/api/m/bench/seen', { body: {} }); };
    await run(); assert.equal(paidCalls(), 0, 'default (local then free): no paid call');
    await t.call('/api/m/bench/settings', { body: { models: 'paid' } });
    t.core.settings.set('model.defaultChain', ['router', 'ollama']);   // the owner's own chain does not use his keys
    await run(); assert.equal(paidCalls(), 0, 'Bench switch on, but paid use not allowed for that provider');
    t.core.settings.set('model.defaultChain', ['router', 'ollama', 'keyed']);
    await run(); assert.ok(paidCalls() > 0, 'both on: the paid key may answer');
  } finally { await t.close(); }
});

test('a restart resumes the session from its stored state', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-bench-'));
  const fake = await startFakeLlm(script());
  const clock = { t: Date.now() }; testHooks.clock = () => clock.t; testHooks.paceMs = 0; testHooks.battery = async () => ({ hasBattery: false });
  const open = async () => { const desk = await createDesk({ dataDir, port: 0, quiet: true, env: {}, modules: ['bench', 'chat', 'search', 'memory'] }); desk.core.settings.set('router.baseUrl', fake.baseUrl); desk.core.settings.set('router.builtin', false); desk.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1'); await desk.start(); return desk; };
  try {
    let desk = await open();
    await desk.core.modules.set('bench', true); desk.core.modules.api('bench'); stubWeb({ core: desk.core });
    desk.core.settings.set('business.about', ABOUT);
    await fetch(desk.url() + '/api/m/bench/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-apd-session': desk.session }, body: JSON.stringify({ enabled: true, models: 'free' }) });
    const base = clock.t; clock.t = base + 1.2 * H;
    let bench = desk.core.modules.api('bench');
    await bench.tick(); await bench.idle();
    const id = bench.current().id; assert.equal(bench.current().plan.unfinished.status, 'done');
    await desk.stop();
    desk = await open(); stubWeb({ core: desk.core }); bench = desk.core.modules.api('bench');
    assert.equal(bench.current()?.id, id, 'the same session after the restart');
    for (let i = 0; i < 10; i++) { if (!await bench.tick()) break; await bench.idle(); }
    const st = statuses(bench.current());
    assert.equal(st.unfinished, 'done'); assert.equal(st.lessons, 'done', 'it went on from where it was');
    await desk.stop();
  } finally { await fake.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('note text: only what the items hold, best by the stated rule, what could not be done in plain words', () => {
  const s = { started: '2026-11-20T10:00:00Z', ended: '2026-11-20T13:30:00Z', endWhy: 'you came back', models: ['Ollama · qwen'], tier: 1, plan: { ...freshPlan(), unfinished: { status: 'done', summary: 'x' }, selfcheck: { status: 'skipped', why: 'no model answered' } } };
  const items = [
    { id: 'a', kind: 'lesson', tier: 1, title: 'Say the city first.', complete: true, state: 'new', created: '1' },
    { id: 'b', kind: 'needs', tier: 1, title: 'Tell me what you do', complete: true, state: 'new', created: '2' },
    { id: 'c', kind: 'doubt', tier: 1, title: 'A doubt', complete: false, state: 'new', created: '3' },
    { id: 'd', kind: 'lesson', tier: 1, title: 'Dismissed one', complete: true, state: 'dismissed', created: '4' },
  ];
  const text = noteText(buildNote(s, items));
  assert.equal(text, ['Bench ran for 3 hours 30 minutes; you came back.', 'The work was done by Ollama · qwen.', '3 findings wait for you: Keep, Dismiss or Turn into a task.', '', 'Best first:', '- Say the city first.', '', 'Needs you:', '- Tell me what you do', '', 'Doubts about earlier work:', '- A doubt', '', 'Not done:', '- Self-check: no model answered.', '- Lessons: not reached before you came back.', '- Not started, they open after a longer time away: Know the business, Competition, Skills, Customers, Money and credits, Free tools, Market report, Pricing table, A 30-day plan.'].join('\n'));
});
