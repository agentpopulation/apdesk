// Scorecard: every count and every suggestion rule, on a throwaway desk whose own database is seeded with calls, jobs,
// replies and thumbs. Weeks are worked out in the owner's zone (America/New_York here), so a record lands in the week the owner sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testDesk } from '../../test/helpers/desk.js';
import { weeksBack, midnightOf, localParts } from './weeks.js';
import { suggest, RULES } from './suggest.js';
import { buildCells, median, servedBy, trend } from './stats.js';

const TZ = 'America/New_York';
const stamp = (ms) => new Date(ms).toISOString();

async function scoreDesk() {
  const t = await testDesk({ modules: ['chat', 'scorecard'] });
  t.core.settings.set('timeZone', TZ); t.core.settings.set('locale', 'en-US'); t.core.settings.set('currency', 'EUR');
  await t.call('/api/m/scorecard/settings', { body: { weekStart: 'mon' } });
  const weeks = weeksBack({ now: Date.now(), tz: TZ, firstDay: 1, count: 8, locale: 'en-US' });
  const at = (w, hours) => stamp(weeks[w].start + hours * 3600000);
  const S = t.core.storage;
  const call = (w, h, o = {}) => S.run('INSERT INTO calls (at, agent_id, purpose, provider, model, ok, ms, input_tokens, output_tokens, cost_minor, currency, error) VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, ?, ?, NULL)',
    at(w, h), o.agent ?? 'scout', o.purpose ?? 'chat', o.provider ?? 'router', o.model ?? 'm-bad', o.ok ?? 1, o.ms ?? 1000, o.cost === undefined ? 0 : o.cost, o.currency ?? 'EUR');
  const job = (w, h, status, o = {}) => S.run('INSERT INTO jobs (id, kind, title, agent_id, status, progress, input, created, updated, finished) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
    'job_' + Math.random().toString(36).slice(2), o.kind ?? 'tasks.run', 'A job', o.agent ?? 'scout', status, o.input ?? null, at(w, h), at(w, h), ['running', 'waiting'].includes(status) ? null : at(w, h + 1));
  const reply = (w, h, o = {}) => {
    const models = o.models ?? [{ provider: o.provider ?? 'router', model: o.model ?? 'm-bad', ok: o.status !== 'error' }, ...(o.skipped ? [{ provider: 'router', model: 'm-slow', ok: false, skipped: true }] : [])];
    const r = S.run('INSERT INTO m_chat_messages (chat_id, role, agent_id, text, cards, label, status, meta, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'dm-' + (o.agent ?? 'scout'), o.role ?? 'assistant', o.agent ?? 'scout', 'text', '[]', 'x', o.status ?? 'done', JSON.stringify({ models, ...(o.posted ? { posted: true } : {}) }), at(w, h), at(w, h));
    const id = Number(r.lastInsertRowid);
    if (o.thumb) S.run('INSERT INTO m_chat_ratings (message_id, thumb, research, reasons, comment, rated_at) VALUES (?, ?, NULL, ?, ?, ?)', String(id), o.thumb, '[]', '', at(w, h + 1));
    return id;
  };
  return { t, weeks, at, call, job, reply, get: async (p = '/api/m/scorecard/report') => (await t.call(p)).json, close: () => t.close() };
}
const rowOf = (rep, id) => rep.rows.find(r => r.agent.id === id);

test('weeks: in the owner zone, dates said, a Sunday-first week when asked, a day the clocks change', () => {
  // 22 Nov 2026 is a Sunday; in New York it is still the 22nd at 03:00 UTC on the 23rd
  const now = Date.parse('2026-11-23T03:00:00Z');
  const w = weeksBack({ now, tz: TZ, firstDay: 1, count: 3, locale: 'en-US' });
  assert.equal(w[0].startIso, '2026-11-16T05:00:00.000Z');   // Monday 16 Nov 00:00 in New York (UTC-5)
  assert.equal(w[0].label, 'Nov 16 to Nov 22');
  assert.equal(w[1].label, 'Nov 9 to Nov 15');
  const sun = weeksBack({ now, tz: TZ, firstDay: 0, count: 1, locale: 'en-US' });
  assert.equal(sun[0].label, 'Nov 22 to Nov 28');
  // the week of the clocks going back (1 Nov 2026) is 25 hours longer in a day, not mis-cut
  const dst = weeksBack({ now: Date.parse('2026-11-04T12:00:00Z'), tz: TZ, firstDay: 1, count: 1, locale: 'en-US' })[0];
  assert.equal(dst.startIso, '2026-11-02T05:00:00.000Z'); assert.equal(dst.label, 'Nov 2 to Nov 8');
  assert.equal(weeksBack({ now: Date.parse('2026-11-04T12:00:00Z'), tz: TZ, firstDay: 1, count: 2, locale: 'en-US' })[1].startIso, '2026-10-26T04:00:00.000Z');
  assert.equal(localParts(midnightOf(2026, 3, 8, TZ), TZ).h, 0);
});

test('the counts: replies, jobs, cost, time, models and skipped, for this week and last, per agent', async () => {
  const d = await scoreDesk();
  try {
    // this week, scout
    d.reply(0, 2, { thumb: 'up' }); d.reply(0, 3, { thumb: 'up' }); d.reply(0, 4, { thumb: 'down', skipped: true }); d.reply(0, 5, {});
    d.reply(0, 6, { status: 'error' }); d.reply(0, 7, { posted: true }); d.reply(0, 8, { role: 'user' }); d.reply(0, 9, { status: 'streaming' });
    d.job(0, 2, 'done'); d.job(0, 3, 'done'); d.job(0, 4, 'failed'); d.job(0, 5, 'stopped'); d.job(0, 6, 'interrupted'); d.job(0, 7, 'running');
    d.job(0, 8, 'done', { input: JSON.stringify({ quiet: true }) }); d.job(0, 9, 'done', { agent: null });
    d.call(0, 2, { ms: 1000 }); d.call(0, 3, { ms: 3000 }); d.call(0, 4, { ms: 2000, provider: 'openai', model: 'gpt-x', cost: 120 });
    d.call(0, 5, { ok: 0, ms: 500 }); d.call(0, 6, { cost: null, provider: 'gemini', model: 'g-1', ms: 2000 }); d.call(0, 7, { cost: 500, currency: 'INR', provider: 'openai', model: 'gpt-x', ms: 2000 });
    d.call(0, 8, { purpose: 'embed', ms: 9000 });
    // last week, scout: fewer replies, so this week is "up"
    d.reply(1, 2, { thumb: 'up' }); d.job(1, 3, 'done');
    // another agent, this week
    d.reply(0, 3, { agent: 'closer', model: 'm-good', thumb: 'down' });
    const ask = (id, status, how, h) => d.t.core.storage.run('INSERT INTO approvals (id, agent_id, action, title, status, how, created) VALUES (?, ?, ?, ?, ?, ?, ?)', id, 'closer', 'file.write', 'x', status, how, d.at(0, h));
    ask('ap1', 'approved', 'owner', 2); ask('ap2', 'denied', 'owner', 3); ask('ap3', 'approved', 'level', 4);
    const rep = await d.get(); const scout = rowOf(rep, 'scout'); const c = scout.this;
    assert.deepEqual({ ...rowOf(rep, 'closer').this.approvals }, { asked: 2, refused: 1 }, 'asked and refused by the owner; a grant by his level is not counted');
    assert.equal(c.replies, 4, 'done replies only: not the posted note, the user line or the one still streaming'); assert.equal(c.failedReplies, 1);
    assert.deepEqual(c.jobs, { done: 3, failed: 1, stopped: 2 }, 'a quiet upkeep job, a running job and a job with no agent are not counted; interrupted is stopped');
    assert.equal(c.jobs.done, 3);
    assert.deepEqual({ ...c.ratings }, { good: 2, poor: 1, rated: 3, share: 2 / 3 });
    assert.deepEqual({ ...c.approvals }, { asked: 0, refused: 0 }, 'the door offers counts: none asked this week is a real 0');
    assert.equal(rep.available.approvals, true); assert.equal(rep.available.ratings, true);
    assert.equal(c.cost.minor, 120, 'known costs only; the INR call is not added to EUR'); assert.equal(c.cost.unknownCalls, 2, 'one NULL and one in another currency'); assert.equal(c.cost.calls, 7);
    assert.equal(c.timeMs, 2000, 'the middle of 1000, 2000, 3000 (embeddings and the failed call are left out)');
    const by = Object.fromEntries(c.models.map(m => [m.model, m]));
    assert.equal(by['m-bad'].calls, 4); assert.equal(by['m-bad'].failed, 1); assert.equal(by['m-slow'].skipped, 1, 'the skipped attempt on the reply is counted for the model skipped');
    assert.equal(by['gpt-x'].ok, 2);
    assert.equal(c.models.find(m => m.model === 'm-bad').share, 3 / 6, 'share of answered calls: 3 of the 6 that answered');
    assert.equal(scout.last.replies, 1); assert.equal(scout.trend.dir, 'up'); assert.deepEqual([scout.trend.now, scout.trend.before], [7, 2]);
    assert.equal(rowOf(rep, 'closer').this.ratings.poor, 1);
    const idle = rowOf(rep, 'coder'); assert.equal(idle.idle, true); assert.equal(idle.trend, null);
    assert.equal(rep.weeks[0].label, d.weeks[0].label); assert.equal(rep.currency, 'EUR');
    // one agent over eight weeks
    d.reply(5, 5, { thumb: 'up' }); d.reply(7, 5, {});
    const h = await d.get('/api/m/scorecard/agent/scout');
    assert.equal(h.cells.length, 8); assert.equal(h.cells[5].replies, 1); assert.equal(h.cells[7].replies, 1); assert.equal(h.cells[0].replies, 4);
    assert.equal((await d.t.call('/api/m/scorecard/agent/nobody')).status, 404);
  } finally { await d.close(); }
});

test('a record lands in the week of the owner zone, not the UTC week', async () => {
  const d = await scoreDesk();
  try {
    // 23:30 on the last day of last week in New York is already the next day in UTC: still last week for the owner
    const lastSundayLate = stamp(d.weeks[0].start - 30 * 60000);
    d.t.core.storage.run('INSERT INTO calls (at, agent_id, purpose, provider, model, ok, ms, cost_minor, currency) VALUES (?, ?, ?, ?, ?, 1, 900, 0, ?)', lastSundayLate, 'scout', 'chat', 'router', 'm-bad', 'EUR');
    const rep = await d.get();
    assert.equal(rowOf(rep, 'scout').this.cost.calls, 0); assert.equal(rowOf(rep, 'scout').last.cost.calls, 1);
  } finally { await d.close(); }
});

test('counts that need another door say so: approvals when the door can count them', () => {
  const weeks = weeksBack({ now: Date.parse('2026-11-23T03:00:00Z'), tz: TZ, firstDay: 1, count: 2, locale: 'en-US' });
  const asked = (wk) => wk.index === 0 ? [{ agentId: 'scout', asked: 5, denied: 2 }] : [];
  const { cells } = buildCells({ weeks, agentIds: ['scout'], approvals: asked, ratings: new Map() });
  assert.deepEqual(cells.scout[0].approvals, { asked: 5, refused: 2 }); assert.deepEqual(cells.scout[1].approvals, { asked: 0, refused: 0 });
  const none = buildCells({ weeks, agentIds: ['scout'], ratings: null });
  assert.equal(none.cells.scout[0].approvals, null); assert.equal(none.cells.scout[0].ratings, null, 'no way to read thumbs: not available, never zero');
  assert.equal(median([3, 1, 2, 10]), 2.5); assert.equal(median([]), null);
  assert.equal(servedBy({ status: 'done', meta: { models: [{ provider: 'a', model: 'x', ok: false }, { provider: 'b', model: 'y', ok: true }, { provider: 'c', model: 'z', ok: false, skipped: true }] } }).model, 'y');
  assert.equal(servedBy({ status: 'error', meta: { models: [{ provider: 'a', model: 'x', ok: false }, { provider: 'c', model: 'z', ok: false, skipped: true }] } }).model, 'x');
  assert.equal(servedBy({ status: 'done', meta: {} }), null);
  assert.equal(trend({ any: true, work: 3 }, { any: true, work: 3 }).dir, 'same'); assert.equal(trend({ any: true, work: 1 }, { any: false, work: 0 }), null);
});

// ---- the suggestion rule
const A = [{ id: 'scout', name: 'Researcher', main: { provider: 'router', model: 'auto' } }];
const rep = (agentId, week, model, thumb, failed = false) => ({ agentId, week, model: { provider: 'router', model }, thumb, failed });
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const label = (p, m) => `Free API · ${m}`;
// the owner's example: 6 of 14 poor on the old model across two weeks, the other model rated good 11 of 12 times
const base = () => [
  ...many(7, i => rep('scout', 0, 'm-bad', i < 3 ? 'down' : 'up')), ...many(7, i => rep('scout', 1, 'm-bad', i < 3 ? 'down' : 'up')),
  ...many(12, i => rep('closer', i % 2, 'm-good', i === 0 ? 'down' : 'up')),
];

test('suggestion: a high share of poor ratings for two weeks on one model, another model clearly better here', () => {
  const r = suggest({ evidence: base(), agents: A, label });
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].text, 'Researcher: 6 of 14 replies rated poor on Free API · m-bad in two weeks; Free API · m-good was rated good 11 of 12 times here. Switch?');
  assert.deepEqual([r.suggestions[0].to.provider, r.suggestions[0].to.model], ['router', 'm-good']);
  assert.equal(r.suggestions[0].cost, 'free');
});

test('suggestion: failed answers count with poor ratings, and the sentence says so', () => {
  const ev = [...many(5, i => rep('scout', 0, 'm-bad', 'up')), ...many(3, i => rep('scout', 0, 'm-bad', 'down')), ...many(2, i => rep('scout', 0, 'm-bad', null, true)),
    ...many(3, i => rep('scout', 1, 'm-bad', 'up')), ...many(3, i => rep('scout', 1, 'm-bad', 'down')), ...many(6, i => rep('closer', 0, 'm-good', 'up'))];
  const r = suggest({ evidence: ev, agents: A, label });
  assert.equal(r.suggestions.length, 1); assert.match(r.suggestions[0].text, /^Researcher: 8 of 16 replies rated poor or failed on Free API · m-bad in two weeks; Free API · m-good was rated good 6 of 6 times here\. Switch\?$/);
});

test('suggestion: too little data gives none and says how much more it needs', () => {
  const few = [...many(3, () => rep('scout', 0, 'm-bad', 'down')), ...many(2, () => rep('scout', 1, 'm-bad', 'down')), ...many(12, () => rep('closer', 0, 'm-good', 'up'))];
  const r = suggest({ evidence: few, agents: A, label });
  assert.equal(r.suggestions.length, 0); assert.deepEqual(r.needs, [{ agentId: 'scout', name: 'Researcher', rated: 5, more: RULES.minRated - 5 }]);
  const exactly = suggest({ evidence: [...many(4, () => rep('scout', 0, 'm-bad', 'down')), ...many(4, () => rep('scout', 1, 'm-bad', 'down')), ...many(12, () => rep('closer', 0, 'm-good', 'up'))], agents: A, label });
  assert.equal(exactly.suggestions.length, 1, 'eight rated replies is enough');
});

test('suggestion: it must stay high in both weeks, the other model must be clearly better and rated enough', () => {
  // good last week, poor only this week: not "two weeks"
  const oneWeek = [...many(6, () => rep('scout', 0, 'm-bad', 'down')), ...many(2, () => rep('scout', 0, 'm-bad', 'up')), ...many(8, () => rep('scout', 1, 'm-bad', 'up')), ...many(12, () => rep('closer', 0, 'm-good', 'up'))];
  assert.equal(suggest({ evidence: oneWeek, agents: A, label }).suggestions.length, 0);
  // the other model is only about as good: no suggestion
  const same = [...base().filter(e => e.agentId === 'scout'), ...many(12, () => rep('closer', 0, 'm-ok', 'up')).map((e, i) => ({ ...e, thumb: i < 6 ? 'up' : 'down' }))];
  assert.equal(suggest({ evidence: same, agents: A, label }).suggestions.length, 0);
  // the other model has too few ratings
  assert.equal(suggest({ evidence: [...base().filter(e => e.agentId === 'scout'), ...many(4, () => rep('closer', 0, 'm-good', 'up'))], agents: A, label }).suggestions.length, 0);
  // the agent is already on that model
  assert.equal(suggest({ evidence: base(), agents: [{ ...A[0], main: { provider: 'router', model: 'm-good' } }], label }).suggestions.length, 0);
  // the door's own record says the other model often fails to answer
  const bad = suggest({ evidence: base(), agents: A, label, learned: [{ purpose: 'chat', provider: 'router', model: 'm-good', calls: 20, share: 0.5, enough: true }] });
  assert.equal(bad.suggestions.length, 0);
  const fine = suggest({ evidence: base(), agents: A, label, learned: [{ purpose: 'chat', provider: 'router', model: 'm-good', calls: 20, share: 0.95, enough: true }] });
  assert.equal(fine.suggestions.length, 1);
});

test('suggestion: a paid model is never suggested while paid use is off; with it on, the sentence says it costs money', () => {
  const costOf = (p, m) => m === 'm-good' ? 'paid' : 'free';
  const off = suggest({ evidence: base(), agents: A, label, costOf, paidOn: false });
  assert.equal(off.suggestions.length, 0); assert.deepEqual(off.heldBack, [{ agentId: 'scout', reason: 'paid' }]);
  const on = suggest({ evidence: base(), agents: A, label, costOf, paidOn: true });
  assert.equal(on.suggestions.length, 1); assert.match(on.suggestions[0].text, /It costs money\. Switch\?$/); assert.equal(on.suggestions[0].paid, true);
  // a free model still wins over a paid one that rates the same
  const two = suggest({ evidence: [...base(), ...many(12, i => rep('closer', 0, 'm-free', i < 1 ? 'down' : 'up'))], agents: A, label, costOf, paidOn: false });
  assert.equal(two.suggestions[0].to.model, 'm-free'); assert.doesNotMatch(two.suggestions[0].text, /costs money/);
  const unknown = suggest({ evidence: base(), agents: A, label, costOf: () => 'unknown', paidOn: true });
  assert.match(unknown.suggestions[0].text, /It may cost money\./);
});

// ---- through the desk: seeded database, the real routes
async function seedBadAgent(d) {
  for (const w of [0, 1]) for (let i = 0; i < 7; i++) d.reply(w, 2 + i, { thumb: i < 3 ? 'down' : 'up', model: 'm-bad' });
  for (let i = 0; i < 12; i++) d.reply(i % 2, 2 + i, { agent: 'closer', model: 'm-good', thumb: i === 0 ? 'down' : 'up' });
}

test('on the desk: the page offers the switch; the owner switches it, can undo it; nothing changes by itself', async () => {
  const d = await scoreDesk();
  try {
    await seedBadAgent(d);
    d.t.core.agents.update('scout', { model: { main: { provider: 'router', model: 'auto' } } });
    const rep = await d.get();
    assert.equal(rep.suggestions.length, 1); const s = rep.suggestions[0];
    assert.match(s.text, /^Scout: 6 of 14 replies rated poor on Free API · m-bad in two weeks; Free API · m-good was rated good 11 of 12 times here\. Switch\?$/);
    assert.deepEqual(d.t.core.agents.get('scout').model.main, { provider: 'router', model: 'auto' }, 'looking at the page changes nothing');
    assert.equal((await d.t.call('/api/m/scorecard/switch', { body: { agentId: 'scout', provider: 'router', model: 'm-good' }, session: false })).status, 403);
    assert.equal((await d.t.call('/api/m/scorecard/switch', { body: { agentId: 'scout', provider: 'router', model: 'something-else' } })).status, 409, 'only a suggestion the page shows can be taken');
    const sw = await d.t.call('/api/m/scorecard/switch', { body: { agentId: 'scout', provider: 'router', model: 'm-good' } });
    assert.equal(sw.status, 200, sw.text);
    assert.deepEqual(d.t.core.agents.get('scout').model.main, { provider: 'router', model: 'm-good' });
    const after = await d.get(); assert.equal(after.suggestions.length, 0, 'already on that model'); assert.equal(after.switches.length, 1); assert.equal(after.switches[0].agentName, 'Scout');
    assert.equal((await d.t.call('/api/m/scorecard/undo', { body: { agentId: 'scout' }, session: false })).status, 403);
    const un = await d.t.call('/api/m/scorecard/undo', { body: { agentId: 'scout' } });
    assert.equal(un.status, 200, un.text);
    assert.deepEqual(d.t.core.agents.get('scout').model.main, { provider: 'router', model: 'auto' }, 'undone to what it was');
    assert.equal((await d.get()).switches.length, 0);
    // undo after the owner changed the model himself does nothing
    await d.t.call('/api/m/scorecard/switch', { body: { agentId: 'scout', provider: 'router', model: 'm-good' } });
    d.t.core.agents.update('scout', { model: { main: { provider: 'router', model: 'other' } } });
    assert.equal((await d.t.call('/api/m/scorecard/undo', { body: { agentId: 'scout' } })).status, 409);
    assert.equal(d.t.core.agents.get('scout').model.main.model, 'other');
    // an agent with no own model is put back to none
    d.t.core.agents.update('scout', { model: { main: null } });
    await d.t.call('/api/m/scorecard/switch', { body: { agentId: 'scout', provider: 'router', model: 'm-good' } });
    await d.t.call('/api/m/scorecard/undo', { body: { agentId: 'scout' } });
    assert.equal(d.t.core.agents.get('scout').model.main, null);
  } finally { await d.close(); }
});

test('on the desk: too little data says how much more; paid off holds a paid model back; paid on says it costs money', async () => {
  const d = await scoreDesk();
  try {
    for (let i = 0; i < 5; i++) d.reply(i % 2, 2 + i, { thumb: 'down' });
    const few = await d.get();
    assert.equal(few.suggestions.length, 0); assert.deepEqual(few.needs.map(n => [n.agentId, n.rated, n.more]), [['scout', 5, 3]]);
  } finally { await d.close(); }
  const e = await scoreDesk();
  try {
    for (const w of [0, 1]) for (let i = 0; i < 7; i++) e.reply(w, 2 + i, { thumb: i < 3 ? 'down' : 'up', model: 'm-bad' });
    for (let i = 0; i < 12; i++) e.reply(i % 2, 2 + i, { agent: 'closer', provider: 'openai', model: 'gpt-x', thumb: i === 0 ? 'down' : 'up' });
    e.call(0, 2, { agent: 'closer', provider: 'openai', model: 'gpt-x', cost: 7 });
    const off = await e.get();
    assert.equal(off.suggestions.length, 0); assert.deepEqual(off.heldBack, [{ agentId: 'scout', reason: 'paid' }]);
    e.t.core.settings.set('openrouter.allowPaid', true);
    const on = await e.get();
    assert.equal(on.suggestions.length, 1); assert.match(on.suggestions[0].text, /It costs money\. Switch\?$/);
    // the owner can switch suggestions off on the Settings section
    assert.equal((await e.t.call('/api/m/scorecard/settings', { body: { suggestions: false }, session: false })).status, 403);
    await e.t.call('/api/m/scorecard/settings', { body: { suggestions: false } });
    const quiet = await e.get(); assert.equal(quiet.suggestions.length, 0); assert.equal(quiet.suggestionsOn, false);
    assert.equal((await e.t.call('/api/m/scorecard/settings', { body: { weekStart: 'blursday' } })).status, 400);
    await e.t.call('/api/m/scorecard/settings', { body: { weekStart: 'sun', suggestions: true } });
    assert.equal((await e.get('/api/m/scorecard/settings')).weekStart, 'sun');
    assert.match((await e.get()).weeks[0].label, /^[A-Za-z]{3} \d+ to [A-Za-z]{3} \d+$/);
  } finally { await e.close(); }
});

test('the file: the same rows as a CSV in the workspace, after the approval door says yes; not known stays not known', async () => {
  const d = await scoreDesk();
  try {
    d.reply(0, 2, { thumb: 'up' }); d.reply(0, 3, { thumb: 'down' }); d.job(0, 2, 'done'); d.call(0, 2, { ms: 2500, cost: 150 }); d.call(0, 3, { cost: null, provider: 'gemini', model: 'g-1', ms: 2500 });
    d.reply(0, 4, { agent: 'closer' }); d.call(0, 4, { agent: 'closer', cost: null, provider: 'gemini', model: 'g-1' });
    assert.equal((await d.t.call('/api/m/scorecard/save', { body: { week: 0 }, session: false })).status, 403);
    const r = await d.t.call('/api/m/scorecard/save', { body: { week: 0 } });
    assert.equal(r.status, 200, r.text); assert.match(r.json.name, /^scorecard-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = fs.readFileSync(d.t.core.storage.workspacePath(r.json.path), 'utf8');
    const lines = text.replace(/^﻿/, '').trim().split('\r\n');
    assert.match(lines[0], /^Agent,Week from,Week to,Replies written,Jobs done,Jobs failed,Jobs stopped,Approvals asked,Approvals refused,Rated good,Rated poor,Share rated good,Middle time to answer \(seconds\),Cost \(EUR\),Calls of unknown cost,Models that answered$/);
    const scout = lines.find(l => l.startsWith('Scout,')); const closer = lines.find(l => l.startsWith('Closer,'));
    assert.match(scout, /^Scout,[^,]+,[^,]+,2,1,0,0,0,0,1,1,50%,2\.5,1\.50,1,/);
    assert.match(closer, /,not known,1,/, 'only unknown costs: the cost is not known, never 0.00');
    assert.doesNotMatch(text, /undefined|null|NaN|\$/);
    assert.equal(lines.length, 1 + d.t.core.agents.list().length, 'one row per agent');
  } finally { await d.close(); }
});

test('switched on and off, and it offers its record to other modules', async () => {
  const d = await scoreDesk();
  try {
    assert.equal(d.t.core.modules.isOn('scorecard'), true);
    await d.t.core.modules.set('scorecard', false); assert.equal((await d.t.call('/api/m/scorecard/report')).status, 404);
    await d.t.core.modules.set('scorecard', true); assert.equal((await d.t.call('/api/m/scorecard/report')).status, 200);
    assert.equal(typeof d.t.core.modules.api('scorecard').report, 'function');
    assert.equal(d.t.core.modules.api('scorecard').suggestions().length, 0);
  } finally { await d.close(); }
});

test('the module words: no emoji, no internal ids, no hard-coded currency, no model call', () => {
  const dir = new URL('.', import.meta.url);
  for (const f of ['server.js', 'stats.js', 'suggest.js', 'weeks.js', 'ui.js']) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /ctx\.model\.(chat|embed)\b/, f + ' makes no model call');
    assert.doesNotMatch(src, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, f + ' has no emoji');
    assert.doesNotMatch(src, /₹|['"]\$['"]|\\u20b9|currency: ['"][A-Z]{3}|toLocaleString\(\s*['"]en-US|timeZone: ['"]UTC/, f + ' hard-codes no currency or UTC');
  }
});

// ---------- the cost cell, the job count, and a hand count
import { costState, cellsFor } from './ui.js';

const nodeText = (n) => n == null || n === false ? '' : Array.isArray(n) ? n.map(nodeText).join(' ') : typeof n === 'object' ? nodeText(n.kids) : String(n);
const fakeUi = { h: (tag, attrs, ...kids) => ({ tag, kids }), fmt: { money: (m, c) => `${c} ${(m / 100).toFixed(2)}`, pct: (x) => Math.round(x * 100) + '%' }, plural: (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}` };
const costWords = (cost) => nodeText(cellsFor(fakeUi, { cost, replies: 0, failedReplies: 0, jobs: { done: 0, failed: 0, stopped: 0 }, ratings: null, approvals: null, timeMs: null }, { replies: true }, 'EUR').cost).replace(/\s+/g, ' ').trim();

test('the cost cell says one true thing: a sum, a sum with the calls left out, or not known alone', () => {
  assert.equal(costWords({ calls: 3, unknownCalls: 0, minor: 450 }), 'EUR 4.50');
  assert.equal(costWords({ calls: 3, unknownCalls: 1, minor: 450 }), 'EUR 4.50 plus 1 call of unknown cost');
  assert.equal(costWords({ calls: 5, unknownCalls: 2, minor: 0 }), 'EUR 0.00 plus 2 calls of unknown cost', 'known calls that were free are a real sum of zero');
  assert.equal(costWords({ calls: 2, unknownCalls: 2, minor: 0 }), 'not known', 'none known: not known, and not also "plus 2 calls"');
  assert.equal(costWords({ calls: 1, unknownCalls: 1, minor: 0 }), 'not known');
  assert.equal(costWords({ calls: 0, unknownCalls: 0, minor: 0 }), 'EUR 0.00', 'no call at all costs nothing');
  assert.deepEqual(costState({ calls: 2, unknownCalls: 2, minor: 0 }), { kind: 'unknown', unknown: 2 });
});

test('the cost cell on a desk: other-currency and empty-cost calls follow the same three sentences', async () => {
  const d = await scoreDesk();
  try {
    d.call(0, 2, { agent: 'scout', cost: null, provider: 'gemini', model: 'g-1' }); d.call(0, 3, { agent: 'scout', cost: null, provider: 'gemini', model: 'g-1' });   // none known
    d.call(0, 2, { agent: 'closer', cost: 40 }); d.call(0, 3, { agent: 'closer', cost: 60, currency: 'INR' });                                                     // one in another currency: left out
    d.call(0, 2, { agent: 'operator', cost: 10 }); d.call(0, 3, { agent: 'operator', cost: 0 });                                                                    // all known
    const rep = await d.get();
    assert.equal(costWords(rowOf(rep, 'scout').this.cost), 'not known');
    assert.equal(costWords(rowOf(rep, 'closer').this.cost), 'EUR 0.40 plus 1 call of unknown cost');
    assert.equal(costWords(rowOf(rep, 'operator').this.cost), 'EUR 0.10');
  } finally { await d.close(); }
});

test('jobs are counted by their status and nothing else', async () => {
  const d = await scoreDesk();
  try {
    const S = d.t.core.storage; let n = 0;
    const add = (w, h, status, o = {}) => S.run('INSERT INTO jobs (id, kind, title, agent_id, status, progress, input, output, error, created, updated, finished) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
      'job_x' + (++n), 'k', 'J', o.agent ?? 'scout', status, o.input ?? null, o.output ?? null, o.error ?? null, d.at(w, h), d.at(w, h), ['running', 'waiting', 'queued'].includes(status) ? null : d.at(w, h + 1));
    add(0, 2, 'done', { output: '{"text":"notes"}' });
    add(0, 3, 'done');                                                             // done with no output at all: still the job's own word, done
    add(0, 4, 'failed', { output: '{"text":"half the notes"}', error: 'It stopped part way.' });   // failed with output is failed, not done
    add(0, 5, 'failed');
    add(0, 6, 'stopped'); add(0, 7, 'interrupted');
    add(0, 8, 'running'); add(0, 9, 'waiting'); add(0, 10, 'queued'); add(0, 11, 'cancelled'); add(0, 12, 'error');   // not finished, or no such word: not counted
    add(0, 13, 'failed', { input: JSON.stringify({ quiet: true }) });              // the desk's own upkeep
    add(1, 2, 'failed', { agent: 'closer' }); add(1, 3, 'done', { agent: 'closer' });
    const rep = await d.get(); const c = rowOf(rep, 'scout').this;
    assert.deepEqual(c.jobs, { done: 2, failed: 2, stopped: 2 });
    assert.equal(c.work, 2, 'work done is the jobs done, never the failed ones');
    assert.deepEqual(rowOf(rep, 'closer').last.jobs, { done: 1, failed: 1, stopped: 0 });
    assert.equal(rowOf(rep, 'closer').last.work, 1);
    const csv = (await d.t.call('/api/m/scorecard/save', { body: { week: 0 } })); assert.equal(csv.status, 200, csv.text);
  } finally { await d.close(); }
});

test('a hand count: three agents, two weeks, every figure on the report equals a tally made from the seed list', async () => {
  const d = await scoreDesk();
  try {
    const seed = []; const tally = {};
    const T = (a, w) => (tally[a + w] ||= { replies: 0, failedReplies: 0, done: 0, failed: 0, stopped: 0, good: 0, poor: 0, minor: 0, calls: 0, unknown: 0, ms: [] });
    for (const a of ['scout', 'closer', 'operator']) for (const w of [0, 1]) {
      const k = a === 'scout' ? 6 : a === 'closer' ? 4 : 2;
      for (let i = 0; i < k + w; i++) {
        const thumb = i % 3 === 0 ? 'down' : i % 3 === 1 ? 'up' : null; d.reply(w, 2 + i, { agent: a, thumb }); const t = T(a, w); t.replies++; if (thumb === 'up') t.good++; if (thumb === 'down') t.poor++;
        const cost = i % 2 ? null : 30 + i; d.call(w, 2 + i, { agent: a, cost, ms: 800 + 300 * i }); t.calls++; cost == null ? t.unknown++ : (t.minor += cost); t.ms.push(800 + 300 * i);
      }
      d.reply(w, 20, { agent: a, status: 'error' }); T(a, w).failedReplies++;
      for (const st of ['done', 'done', 'failed', 'stopped']) { d.job(w, 21, st, { agent: a }); const t = T(a, w); st === 'done' ? t.done++ : st === 'failed' ? t.failed++ : t.stopped++; }
    }
    const rep = await d.get();
    for (const a of ['scout', 'closer', 'operator']) for (const w of [0, 1]) {
      const c = rowOf(rep, a)[w ? 'last' : 'this']; const t = tally[a + w]; const sorted = [...t.ms].sort((x, y) => x - y); const m = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      assert.deepEqual({ r: c.replies, fr: c.failedReplies, j: c.jobs, g: c.ratings.good, p: c.ratings.poor, minor: c.cost.minor, calls: c.cost.calls, un: c.cost.unknownCalls, ms: c.timeMs },
        { r: t.replies, fr: t.failedReplies, j: { done: t.done, failed: t.failed, stopped: t.stopped }, g: t.good, p: t.poor, minor: t.minor, calls: t.calls, un: t.unknown, ms: m }, `${a} week ${w}`);
      assert.equal(c.work, t.replies + t.done);
    }
  } finally { await d.close(); }
});
