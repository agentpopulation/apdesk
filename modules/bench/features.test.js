// Spend gate, ratings, the step trace and the return panel: the pieces added on top of Bench mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { benchDesk, ABOUT, script, stubWeb, H } from './fixtures.js';
import { testHooks } from './server.js';

/** A desk with Bench on but NO money choice yet, so the gate can be tested from the start. */
async function gatelessDesk() {
  const clock = { t: Date.now() };
  testHooks.clock = () => clock.t; testHooks.paceMs = 0; testHooks.battery = async () => ({ hasBattery: false }); testHooks.budget = null;
  const t = await testDesk({ modules: ['bench', 'chat', 'search', 'memory', 'agents'], script: script() });
  stubWeb(t, []);
  t.core.settings.set('business.about', ABOUT); t.core.settings.set('country', 'IN'); t.core.settings.set('security.level', 'careful');
  await t.core.modules.set('bench', true);
  const bench = t.core.modules.api('bench');
  await t.call('/api/m/bench/settings', { body: { enabled: true, site: 'https://acmepayroll.example/' } });   // enabled, but no money choice
  clock.base = clock.t;
  const away = async (hours) => { clock.t = clock.base + hours * H; for (let i = 0; i < 20; i++) { const started = await bench.tick(); await bench.idle(); if (!started) break; } };
  return { t, bench, clock, away };
}

test('spend gate: Bench will not run a session until a money choice is made', async () => {
  const { t, bench, away } = await gatelessDesk();
  try {
    assert.equal(bench.gate().chosen, false, 'a fresh desk has no money choice');
    const v0 = await t.call('/api/m/bench/state');
    assert.equal(v0.json.gate.ready, false);
    await away(2);
    assert.equal(bench.current(), null, 'no session runs without a money choice');
    // the manual Start also refuses
    const start = await t.call('/api/m/bench/start', { body: {} });
    assert.equal(start.status, 409); assert.match(start.json.error, /Local only|Free|Paid/);
    // choose Free and it runs
    const set = await t.call('/api/m/bench/spendgate', { body: { option: 'free' } });
    assert.equal(set.json.gate.ready, true); assert.equal(set.json.gate.option, 'free');
    await away(2);
    assert.ok(bench.current(), 'with a money choice, a session runs');
  } finally { await t.close(); }
});

test('spend gate: a reached paid cap winds Bench to free and the gate reappears as invalid', async () => {
  const { t, bench } = await gatelessDesk();
  try {
    // choose Paid with a tiny per-day cap, then log spend past it
    await t.call('/api/m/bench/spendgate', { body: { option: 'paid', capDayMinor: 100, capSessionMinor: 0 } });
    const g = bench.gate();
    assert.equal(g.option, 'paid'); assert.equal(g.capDayMinor, 100);
    // record a paid model call so today's spend exceeds the cap
    t.core.model.record({ provider: 'openai', model: 'gpt-4o', ok: true, ms: 10, usage: { input: 2_000_000, output: 2_000_000 } });
    const v = await t.call('/api/m/bench/state');
    assert.ok(v.json.gate.daySpendMinor >= 100, `spend ${v.json.gate.daySpendMinor} should clear the cap`);
    assert.equal(v.json.gate.effectiveMode, 'free', 'past the cap Bench falls back to free');
    assert.equal(v.json.gate.invalid, true, 'the gate is invalid so it reappears for the owner');
  } finally { await t.close(); }
});

test('spend gate: caps and session limits are owner-only and are cleaned on the way in', async () => {
  const { t, bench } = await gatelessDesk();
  try {
    const bad = await t.call('/api/m/bench/spendgate', { body: { option: 'sideways' } });
    assert.equal(bad.status, 400);
    const notOwner = await t.call('/api/m/bench/spendgate', { body: { option: 'free' }, session: false });
    assert.equal(notOwner.status, 403, 'raising/changing the choice needs the owner at the desk');
    await t.call('/api/m/bench/spendgate', { body: { option: 'paid', capSessionMinor: '250.7', capDayMinor: -5, limits: { steps: 20, sources: -3 } } });
    const g = bench.gate();
    assert.equal(g.capSessionMinor, 251); assert.equal(g.capDayMinor, 0, 'a negative cap means no cap');
    assert.equal(g.limits.steps, 20); assert.equal(g.limits.sources, 140, 'an unsound limit keeps its default');
  } finally { await t.close(); }
});

test('ratings: thumbs, a research verdict, reason chips and a comment are stored per target, owner-only', async () => {
  const { t, bench } = await gatelessDesk();
  try {
    const notOwner = await t.call('/api/m/bench/ratings', { body: { targetType: 'answer', targetId: '7', thumb: 'up' }, session: false });
    assert.equal(notOwner.status, 403);
    const r = await t.call('/api/m/bench/ratings', { body: { targetType: 'answer', targetId: '7', thumb: 'down', research: 'bad', reasons: ['wrong facts', 'nonsense chip', 'too long'], comment: 'missed my city' } });
    assert.equal(r.json.rating.thumb, 'down'); assert.equal(r.json.rating.research, 'bad');
    assert.deepEqual(r.json.rating.reasons, ['wrong facts', 'too long'], 'unknown reason chips are dropped');
    assert.equal(r.json.rating.comment, 'missed my city');
    const got = await t.call('/api/m/bench/ratings/answer/7');
    assert.equal(got.json.rating.thumb, 'down');
    // update replaces; clearing everything removes the row
    await t.call('/api/m/bench/ratings', { body: { targetType: 'answer', targetId: '7', thumb: 'up' } });
    assert.equal(bench.rating('answer', '7').thumb, 'up');
    await t.call('/api/m/bench/ratings', { body: { targetType: 'answer', targetId: '7' } });
    assert.equal(bench.rating('answer', '7'), null, 'an empty rating clears it');
  } finally { await t.close(); }
});

test('step trace: a Bench activity records what ran (models, pages, searches) as the desk\'s own record', async () => {
  const d = await benchDesk();   // Bench on, money choice free, fake web
  const { t, bench, at } = d;
  try {
    await at(12.05);   // through tier 2: 'business' reads the owner's site and asks a model, so there is work to trace
    const s = bench.current();
    const withJob = bench.items(s.id).find((i) => i.data?._jobId);
    assert.ok(withJob, 'a finding carries the job that produced it');
    const r = await t.call('/api/m/bench/steps/' + withJob.data._jobId);
    assert.ok(Array.isArray(r.json.steps) && r.json.steps.length, 'the job has a step trace');
    const actions = new Set(r.json.steps.map((x) => x.action));
    assert.ok([...actions].some((a) => /model|page|search/.test(a)), `factual actions: ${[...actions]}`);
    assert.ok(r.json.steps.every((x) => typeof x.seq === 'number' && typeof x.ms === 'number'), 'each step has an order and a duration');
  } finally { await t.close(); }
});

test('usage: a per-agent view from the model-call log, with an owner-only CSV export', async () => {
  const { t } = await gatelessDesk();
  try {
    t.core.model.record({ agentId: 'scout', provider: 'openai', model: 'gpt-4o', ok: true, ms: 10, usage: { input: 1000, output: 500 } });
    t.core.model.record({ agentId: 'scout', provider: 'router', model: 'local', ok: false, ms: 5, usage: { input: 0, output: 0 }, error: 'busy' });
    t.core.model.record({ agentId: 'closer', provider: 'gemini', model: 'flash', ok: true, ms: 8, usage: { input: 200, output: 100 } });
    const u = (await t.call('/api/m/bench/usage')).json;
    const scout = u.agents.find((a) => a.agent === 'scout');
    assert.ok(scout); assert.equal(scout.calls, 2); assert.equal(scout.errors, 1); assert.equal(scout.inputTokens, 1000);
    assert.ok(u.agents.find((a) => a.agent === 'closer'));
    const csv = await t.call('/api/m/bench/usage.csv');
    assert.equal(csv.status, 200); assert.match(csv.text.split('\r\n')[0], /^agent,calls,errors,/); assert.match(csv.text, /scout,2,1,/);
    const denied = await t.call('/api/m/bench/usage.csv', { session: false });
    assert.equal(denied.status, 403, 'CSV export is owner-only');
  } finally { await t.close(); }
});

test('return panel: a headline, result cards, a needs-you list and what was not done, from real jobs and findings only', async () => {
  const d = await benchDesk();
  const { t, bench, at } = d;
  try {
    // a failed owner job and a waiting owner job; a quiet upkeep job that must stay hidden
    const iso = new Date().toISOString();
    t.core.storage.run("INSERT INTO jobs (id, kind, title, status, progress, detail, input, error, created, updated, finished) VALUES ('job_fail', 'tasks.run', 'Compare payroll tools', 'failed', 0, 'Failed', '{}', 'No model answered', ?, ?, ?)", iso, iso, iso);
    t.core.storage.run("INSERT INTO jobs (id, kind, title, status, progress, detail, input, created, updated) VALUES ('job_wait', 'tasks.run', 'Draft an outreach email', 'waiting', 0.5, 'Waiting for you', '{}', ?, ?)", iso, iso);
    t.core.storage.run("INSERT INTO jobs (id, kind, title, status, progress, detail, input, created, updated, finished) VALUES ('job_quiet', 'bench.x', 'Quiet upkeep', 'done', 1, 'Done', '{\"quiet\":true}', ?, ?, ?)", iso, iso, iso);
    await at(12.05);   // make some findings
    const r = await t.call('/api/m/bench/return');
    const p = r.json;
    assert.ok(p.headline && typeof p.headline.spendTodayMinor === 'number');
    assert.ok(p.headline.needsYou >= 1, 'the waiting job counts as needing the owner');
    assert.ok(p.needs.some((x) => x.id === 'job_wait'), 'the waiting job is listed under Needs you');
    assert.ok(p.didntGetTo.some((x) => x.title === 'Compare payroll tools' && /again/i.test(x.next)), 'the failed job is listed with a next step');
    assert.ok(!p.results.some((x) => x.id === 'job_quiet') && !p.needs.some((x) => x.id === 'job_quiet'), 'a quiet upkeep job is hidden');
    assert.ok(p.results.length >= 1, 'Bench findings show as result cards');
    assert.ok(p.results.every((c) => 'rating' in c), 'every result card carries its rating slot');
  } finally { await t.close(); }
});
