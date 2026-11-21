// Bench, second part: heartbeat, keep awake, the to-do list, drafts, today's find, the rulebook, the weekly note and
// "already a customer". Plumbing tests with the fake model, a fake clock and stand-ins (never proof the words are good).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { benchDesk, H } from './fixtures.js';
import { testHooks } from './server.js';
import { todoList, gapBetween, gapText, cleanDraft, pickFind, rulesIn, weeklyNote, zoneTime } from './extras.js';
import { awakeCommand, keepAwake } from './keepawake.js';
import { freshPlan } from './engine.js';

/** A stand-in for child_process.spawn: records each call; kill() marks the child ended. */
function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => { const c = new EventEmitter(); c.killed = false; c.kill = () => { c.killed = true; c.emit('exit', 0); return true; }; calls.push({ cmd, args, opts, child: c }); return c; };
  return { spawn, calls, live: () => calls.filter((c) => !c.child.killed).length };
}
const job = (t, id, title, status = 'done', at = new Date().toISOString()) => t.core.storage.run("INSERT INTO jobs (id, kind, title, status, progress, detail, input, created, updated, finished) VALUES (?, 'tasks.run', ?, ?, 1, 'Done', '{}', ?, ?, ?)", id, title, status, at, at, at);

test('rules: a gap is a silence of more than 2 minutes; times read in the owner\'s zone', () => {
  assert.equal(gapBetween(1000, 1000 + 120000), null);
  assert.deepEqual(gapBetween(1000, 1000 + 120001), { from: 1000, to: 121001 });
  assert.equal(gapBetween(0, 5e9), null, 'no heartbeat yet: no gap');
  const t = Date.UTC(2026, 10, 21, 4, 30);
  assert.equal(zoneTime(t, { timeZone: 'Asia/Kolkata', locale: 'en-GB' }), '21 Nov, 10:00');
  assert.equal(gapText({ from: t, to: t + H }, { timeZone: 'America/New_York', locale: 'en-GB' }), 'The desk was not running from 20 Nov, 23:30 to 21 Nov, 00:30.');
});

test('rules: the to-do list and its time left (a dash, as null, when nothing was measured)', () => {
  const plan = freshPlan();
  let r = todoList(plan, 1, { measured: {} });
  assert.equal(r.leftMs, null, 'nothing measured yet');
  assert.deepEqual(r.items.slice(0, 4).map((i) => i.status), ['queued', 'queued', 'queued', 'queued']);
  assert.equal(r.items[3].why, 'opens after 12 hours away');
  Object.assign(plan.unfinished, { status: 'done', ms: 4000 });
  Object.assign(plan.selfcheck, { status: 'failed', why: 'a page timed out', ms: 2000 });
  Object.assign(plan.lessons, { status: 'running', startedMs: 1000 });
  r = todoList(plan, 1, { now: 2000, measured: { unfinished: [4000], selfcheck: [2000] } });
  assert.deepEqual(r.items.slice(0, 3).map((i) => [i.status, i.why]), [['done', ''], ['skipped', 'it did not work: a page timed out'], ['running', '']]);
  assert.equal(r.leftMs, 2000, 'running lessons: the average 3000 ms less the 1000 ms it has run');
  plan.lessons.status = 'done';
  assert.equal(todoList(plan, 1, { measured: {} }).leftMs, 0, 'nothing queued in an open stage: no time left');
});

test('rules: drafts keep their shape; sources come from the finding only', () => {
  assert.equal(cleanDraft('actions', { actions: [{ action: 'a', effort: 'small', why: 'w' }, { action: 'b', effort: 'small', why: 'w' }] }), null, 'fewer than 3 actions: no draft');
  const a = cleanDraft('actions', { actions: Array.from({ length: 9 }, (_, i) => ({ action: 'x' + i, effort: 'large', why: 'y' })) });
  assert.equal(a.actions.length, 7, 'at most 7');
  assert.equal(cleanDraft('actions', { actions: [1, 2, 3].map(() => ({ action: 'x', effort: 'small' })) }), null, 'each action needs its why');
  const o = cleanDraft('onepager', { summary: 'S', points: ['p'], recommendation: 'R', sources: [{ url: 'https://made-up.example' }] }, [{ url: 'https://real.example/a', title: 'Real' }]);
  assert.deepEqual(o.sources, [{ title: 'Real', url: 'https://real.example/a' }], 'a model\'s own source list is ignored');
});

test('rules: today\'s question, the rulebook lines and the weekly note', () => {
  const cands = [{ topic: 'Payroll rules in India', why: 'a task', at: '2026-11-20' }, { topic: 'Cloud credits', why: 'kept', at: '2026-11-21' }];
  assert.equal(pickFind(cands).topic, 'Cloud credits', 'newest first');
  assert.equal(pickFind(cands, { avoid: ['cloud'] }).topic, 'Payroll rules in India', 'a topic to avoid is left out');
  assert.equal(pickFind(cands, { recent: ['Cloud credits'] }).topic, 'Payroll rules in India', 'not the same topic twice in a row');
  assert.deepEqual(pickFind(cands, { pin: 'GST changes' }), { topic: 'GST changes', question: 'Is there anything new on "GST changes"?', why: 'You pinned this topic.' });
  assert.equal(pickFind([], {}), null);
  const rules = rulesIn('# House rules\n- Always say the city first.\n- Never send mail on Sundays.\n- At most 3 quotes per page.\nA plain line here.\n- Use plain words and a friendly tone.\n', 'knowledge/house.md');
  assert.deepEqual(rules.map((r) => [r.kind, r.line, r.text]), [['always', 2, 'Always say the city first.'], ['never', 3, 'Never send mail on Sundays.'], ['limit', 4, 'At most 3 quotes per page.'], ['style', 6, 'Use plain words and a friendly tone.']]);
  const now = Date.parse('2026-11-21T10:00:00Z'); const day = (d) => new Date(now - d * 24 * H).toISOString();
  const w = weeklyNote([
    { targetType: 'job', targetId: 'a', thumb: 'up', reasons: [], ratedAt: day(1) },
    { targetType: 'job', targetId: 'b', thumb: 'down', reasons: ['wrong facts', 'too long'], comment: 'wrong city', ratedAt: day(2) },
    { targetType: 'job', targetId: 'c', research: 'bad', reasons: ['wrong facts', 'outdated', 'weak sources'], ratedAt: day(3) },
    { targetType: 'job', targetId: 'd', thumb: 'down', reasons: ['too short'], ratedAt: day(9) },
  ], { now, titleOf: (r) => 'Job ' + r.targetId });
  assert.deepEqual(w.good.map((x) => x.title), ['Job a']);
  assert.deepEqual(w.poor.map((x) => [x.title, x.reasons.join('+'), x.comment]), [['Job b', 'wrong facts+too long', 'wrong city'], ['Job c', 'wrong facts+outdated+weak sources', '']]);
  assert.equal(w.suggestions.length, 3); assert.equal(w.suggestions[0].reason, 'wrong facts');
  assert.ok(!w.suggestions.some((s) => s.reason === 'too short'), 'an 8-day-old rating is not in the week');
});

test('heartbeat: one row per beat while Bench is on, kept 24 hours, with what runs and the spend so far', async () => {
  const { t, bench, clock } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    const n0 = bench.heartbeats().length;
    assert.ok(n0 >= 1, 'a beat when Bench was switched on');
    bench.beat(); clock.t += 30000; bench.beat();
    const rows = bench.heartbeats();
    assert.equal(rows.length, n0 + 2);
    const last = rows.at(-1);
    assert.equal(typeof last.spendMinor, 'number'); assert.equal(last.running, 'Nothing is running');
    clock.t += 25 * H; bench.beat();
    assert.equal(bench.heartbeats().length, 1, 'rows older than 24 hours are gone');
    await t.call('/api/m/bench/settings', { body: { enabled: false } });
    const before = bench.heartbeats().length; bench.beat();
    assert.equal(bench.heartbeats().length, before, 'no beat while Bench is off');
  } finally { await t.close(); }
});

test('keep awake: the system tool per platform, nothing else', () => {
  assert.deepEqual(awakeCommand('linux', 42).cmd, 'systemd-inhibit');
  assert.ok(awakeCommand('linux', 42).args.includes('--what=sleep'), 'only sleep is held; the display may sleep');
  assert.deepEqual(awakeCommand('darwin', 42), { cmd: 'caffeinate', args: ['-i', '-w', '42'] });
  assert.match(awakeCommand('win32', 42).args.at(-1), /SetThreadExecutionState\(\[uint32\]2147483649\)/, 'ES_CONTINUOUS | ES_SYSTEM_REQUIRED, not the display flag');
  for (const p of ['linux', 'darwin', 'win32']) assert.doesNotMatch(awakeCommand(p, 42).args.join(' '), /SendInput|mouse_event|keybd_event|xdotool|osascript|SendKeys|wscript/i, 'no input is simulated');
  assert.equal(awakeCommand('aix', 1), null);
  const f = fakeSpawn(); const k = keepAwake({ spawn: f.spawn, platform: 'darwin', pid: 7 });
  k.hold(); k.hold(); assert.equal(f.calls.length, 1, 'held once'); assert.equal(k.state().held, true);
  k.release(); assert.equal(f.live(), 0); assert.equal(k.state().held, false);
  const g = fakeSpawn(); const k2 = keepAwake({ spawn: (...a) => { const c = g.spawn(...a); setImmediate(() => c.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }))); return c; }, platform: 'linux', pid: 7 });
  k2.hold();
  return new Promise((r) => setImmediate(() => { assert.match(k2.state().error, /systemd-inhibit was not found/); assert.equal(k2.state().held, false); r(); }));
});

test('keep awake: off by default, owner-only; held while work is queued or running, let go when empty, on Panic and on exit', async () => {
  const f = fakeSpawn(); testHooks.spawn = f.spawn; testHooks.platform = 'linux';
  const { t, bench, clock, at } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    assert.equal((await t.call('/api/m/bench/state')).json.keepAwake.on, false, 'off by default');
    await at(1.05); assert.equal(f.calls.length, 0, 'never held while the setting is off');
    assert.equal((await t.call('/api/m/bench/settings', { body: { keepAwake: true }, session: false })).status, 403, 'owner-only');
    await t.call('/api/m/bench/seen', { body: {} });
    assert.equal((await t.call('/api/m/bench/settings', { body: { keepAwake: true } })).json.keepAwake.on, true);
    // a slow model keeps an activity running
    let release; const gate = new Promise((r) => { release = r; });
    const real = t.core.model.chat.bind(t.core.model); t.core.model.chat = async (o) => { await gate; return real(o); };
    clock.t += 2 * H; await bench.tick();
    for (let i = 0; i < 5 && !f.calls.length; i++) await bench.tick();
    assert.equal(f.live(), 1, 'held while Bench works'); assert.equal(f.calls[0].cmd, 'systemd-inhibit');
    assert.equal((await t.call('/api/m/bench/state')).json.keepAwake.held, true);
    release(); await bench.idle();
    for (let i = 0; i < 10; i++) { if (!await bench.tick()) break; await bench.idle(); }
    assert.equal(f.live(), 0, 'let go when nothing is queued in an open stage');
    // queued again (stage 2 opens), then Panic
    t.core.model.chat = (o) => new Promise((_, j) => o.signal?.addEventListener('abort', () => j(Object.assign(new Error('Stopped'), { code: 'aborted' })), { once: true }));
    clock.t += 12 * H; await bench.tick();
    assert.equal(f.live(), 1, 'held again: stage 2 is queued');
    await t.call('/api/panic', { body: {} });
    assert.equal(f.live(), 0, 'Panic lets go');
    await t.call('/api/panic/resume', { body: {} });
    t.core.model.chat = real;
    clock.t += 60000; await t.call('/api/m/bench/seen', { body: {} }); clock.t += 2 * H; await bench.tick();
    assert.equal(f.live(), 1, 'held again in a new session');
    await t.core.modules.set('bench', false);
    assert.equal(f.live(), 0, 'switching Bench off (or the desk ending) lets go');
  } finally { testHooks.spawn = null; testHooks.platform = null; await t.close(); }
});

test('keep awake: web work that waits while the desk is offline does not keep the PC awake', async () => {
  const f = fakeSpawn(); testHooks.spawn = f.spawn; testHooks.platform = 'linux';
  const { t, bench, at } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    await t.call('/api/m/bench/settings', { body: { keepAwake: true } });
    t.core.settings.set('online', false);
    await at(1.05);
    const todo = bench.todo();
    assert.equal(todo.items.find((i) => i.id === 'selfcheck').status, 'queued', 'the web activity waits');
    assert.equal(f.live(), 0, 'nothing will run while offline: the PC may sleep');
    bench.beat(); assert.equal(f.live(), 0, 'and the heartbeat does not hold it again');
    t.core.settings.set('online', true); bench.beat();
    assert.equal(f.live(), 1, 'online again: the queued web work can run, so it is held');
  } finally { testHooks.spawn = null; testHooks.platform = null; await t.close(); }
});

test('to-do list: GET state carries every activity with its status and a time-left estimate', async () => {
  const { t, at } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    await at(1.05);
    const r = (await t.call('/api/m/bench/state')).json.running;
    assert.ok(r.todo && Array.isArray(r.todo.items) && r.todo.items.length === 12);
    const by = Object.fromEntries(r.todo.items.map((i) => [i.id, i]));
    assert.equal(by.unfinished.status, 'done'); assert.equal(typeof by.unfinished.ms, 'number', 'its duration was measured');
    assert.equal(by.business.status, 'queued'); assert.equal(by.business.why, 'opens after 12 hours away');
    assert.equal(r.todo.leftMs, 0, 'nothing queued in an open stage');
  } finally { await t.close(); }
});

test('drafts: a result comes with a Draft; the owner opens, edits, makes again, accepts or discards; handing over only on a press', async () => {
  const { t, bench, at } = await benchDesk({ modules: ['bench', 'chat', 'search', 'sales', 'memory'] });
  const mail = { drafts: [], sent: 0 }; const asked = [];
  t.core.modules.active.set('mail', { handle: null, api: { draft: (o) => { mail.drafts.push(o); return { id: 'md_x', ...o }; }, send: async () => { mail.sent++; } } });
  const realReq = t.core.approval.request.bind(t.core.approval); t.core.approval.request = (r) => { asked.push(r); return realReq(r); };
  try {
    await at(12.05);
    const s = bench.current(); const list = bench.items(s.id);
    const d = list.find((i) => i.kind === 'draft');
    assert.ok(d, 'a draft came with a result: ' + list.map((i) => i.kind).join());
    assert.equal(d.data.draft.type, 'onepager'); assert.match(d.title, /^Draft: one-pager on /);
    const from = list.find((i) => i.id === d.data.fromItem);
    assert.deepEqual(d.data.draft.sources.map((x) => x.url), (from.evidence || []).map((e) => e.url).filter(Boolean), 'its sources are the finding\'s own pages');
    assert.equal(mail.drafts.length, 0, 'nothing handed over by itself');
    // edit
    assert.equal((await t.call(`/api/m/bench/items/${d.id}/edit`, { body: { draft: { summary: 'Mine' } }, session: false })).status, 403);
    const e = await t.call(`/api/m/bench/items/${d.id}/edit`, { body: { draft: { summary: 'My own words.', points: ['One point'], recommendation: 'Do it.' } } });
    assert.equal(e.status, 200); assert.match(e.json.item.body, /^Summary: My own words\./);
    assert.deepEqual(e.json.item.data.draft.sources, d.data.draft.sources, 'an edit keeps the finding\'s sources');
    // make again
    const again = await t.call(`/api/m/bench/items/${d.id}/redo`, { body: {} });
    assert.equal(again.status, 200, JSON.stringify(again.json)); assert.match(again.json.item.body, /^Summary: A rival sells payroll/); assert.equal(again.json.item.data.version, 2);
    // a next-actions list from a finding, on the owner's press
    const comp = list.find((i) => i.kind === 'competitor');
    const na = await t.call(`/api/m/bench/items/${comp.id}/draft`, { body: { type: 'actions' } });
    assert.equal(na.status, 200, JSON.stringify(na.json)); assert.equal(na.json.item.data.draft.actions.length, 7);
    assert.ok(na.json.item.data.draft.actions.every((x) => x.effort && x.why));
    // hand over to Mail drafts: only on the press; nothing sent; no approval asked by Bench
    const ho = await t.call(`/api/m/bench/items/${d.id}/handover`, { body: { to: 'partner@example.com' } });
    assert.equal(ho.status, 200, JSON.stringify(ho.json));
    assert.equal(mail.drafts.length, 1); assert.equal(mail.drafts[0].to, 'partner@example.com'); assert.match(mail.drafts[0].body, /^Summary: A rival/);
    assert.equal(mail.sent, 0, 'never sent from Bench'); assert.deepEqual(asked, [], 'no approval asked');
    assert.equal(bench.items(s.id).find((i) => i.id === d.id).state, 'kept');
    // accept and discard
    assert.equal((await t.call(`/api/m/bench/items/${na.json.item.id}/keep`, { body: {} })).status, 200);
    const n2 = await t.call(`/api/m/bench/items/${comp.id}/draft`, { body: { type: 'onepager' } });
    assert.equal((await t.call(`/api/m/bench/items/${n2.json.item.id}/dismiss`, { body: {} })).json.item.state, 'dismissed');
  } finally { await t.close(); }
});

test('today\'s find: once a day from the owner\'s own history, inside the spend choice; off, avoid and pin', async () => {
  const { t, bench, at, clock } = await benchDesk({ modules: ['bench', 'chat', 'search'] });
  try {
    job(t, 'job_h1', 'Payroll buyers in Pune');
    await at(1.05);
    let f = (await t.call('/api/m/bench/return')).json.find;
    assert.ok(f, 'a find card');
    assert.equal(f.question, 'Is there anything new on "Payroll buyers in Pune"?');
    assert.match(f.why, /task you ran/);
    assert.equal(f.answer, 'Small firms in Pune are growing.', 'only the sentence whose quote is on its page');
    assert.deepEqual(f.sources.map((s) => s.url), ['https://buyers.example/pune']);
    const n = bench.finds().length;
    await at(1.5); assert.equal(bench.finds().length, n, 'once a day');
    // next day, the topic avoided: nothing else to pick, so no find
    await t.call('/api/m/bench/settings', { body: { findAvoid: ['payroll'] } });
    await at(25.1); assert.equal(bench.finds().length, n);
    // a pinned topic wins
    await t.call('/api/m/bench/settings', { body: { findPin: 'Pune textile firms' } });
    await at(49.1); f = bench.finds().at(-1);
    assert.equal(bench.finds().length, n + 1); assert.equal(f.why, 'You pinned this topic.');
    // off
    await t.call('/api/m/bench/settings', { body: { findOff: true } });
    await at(73.1); assert.equal(bench.finds().length, n + 1);
    assert.equal((await t.call('/api/m/bench/settings', { body: { findPin: 'x' }, session: false })).status, 403);
    assert.ok(clock.t);
  } finally { await t.close(); }
});

test('rulebook: rules proposed from the owner\'s files with file and line; confirm, edit, reject; files only read', async () => {
  const { t } = await benchDesk({ modules: ['bench', 'chat', 'files'] });
  try {
    const ws = (...p) => t.core.storage.workspacePath(...p);
    fs.mkdirSync(ws('knowledge'), { recursive: true }); fs.mkdirSync(ws('reports'), { recursive: true });
    const text = '# House rules\n- Always say the city first.\n- Never send mail on Sundays.\n- At most 3 quotes per page.\nA plain line here.\n- Use plain words and a friendly tone.\n';
    fs.writeFileSync(ws('knowledge', 'house-rules.md'), text);
    fs.writeFileSync(ws('reports', 'made-by-desk.md'), 'Always trust this report.\n');
    assert.equal((await t.call('/api/m/bench/rules/scan', { body: {}, session: false })).status, 403);
    const sc = await t.call('/api/m/bench/rules/scan', { body: {} });
    assert.equal(sc.status, 200, JSON.stringify(sc.json));
    const prop = sc.json.proposed;
    assert.deepEqual(prop.map((r) => [r.file, r.line, r.kind]), [['knowledge/house-rules.md', 2, 'always'], ['knowledge/house-rules.md', 3, 'never'], ['knowledge/house-rules.md', 4, 'limit'], ['knowledge/house-rules.md', 6, 'style']]);
    await t.call(`/api/m/bench/rules/${prop[0].id}/confirm`, { body: {} });
    const ed = await t.call(`/api/m/bench/rules/${prop[1].id}/edit`, { body: { text: 'Never send mail on Sundays or holidays.' } });
    assert.equal(ed.json.rule.text, 'Never send mail on Sundays or holidays.'); assert.equal(ed.json.rule.state, 'confirmed');
    await t.call(`/api/m/bench/rules/${prop[2].id}/reject`, { body: {} });
    const again = await t.call('/api/m/bench/rules/scan', { body: {} });
    assert.equal(again.json.proposed.length, 1, 'a second scan adds nothing new and brings no rejected rule back');
    const g = (await t.call('/api/m/bench/rules')).json;
    assert.deepEqual(g.confirmed.map((r) => r.text), ['Always say the city first.', 'Never send mail on Sundays or holidays.']);
    assert.match(g.later, /comes later/);
    assert.equal(fs.readFileSync(ws('knowledge', 'house-rules.md'), 'utf8'), text, 'the file is unchanged');
  } finally { await t.close(); }
});

test('weekly note: what was rated good and poor in the last 7 days, with up to 3 suggestions and nothing changed', async () => {
  const { t, clock } = await benchDesk({ modules: ['bench', 'chat'] });
  try {
    job(t, 'job_w1', 'Find payroll leads'); job(t, 'job_w2', 'Compare payroll tools'); job(t, 'job_w3', 'Old one');
    const rate = (body) => t.call('/api/m/bench/ratings', { body });
    const now = clock.t;
    clock.t = now - 9 * 24 * H; await rate({ targetType: 'job', targetId: 'job_w3', thumb: 'down', reasons: ['too short'] });
    clock.t = now - 2 * 24 * H; await rate({ targetType: 'job', targetId: 'job_w1', thumb: 'up' });
    await rate({ targetType: 'job', targetId: 'job_w2', thumb: 'down', reasons: ['wrong facts'], comment: 'wrong prices' });
    clock.t = now;
    const settingsBefore = JSON.stringify(t.core.storage.all('SELECT * FROM settings'));
    const w = (await t.call('/api/m/bench/weekly')).json;
    assert.deepEqual(w.good.map((x) => x.title), ['Find payroll leads']);
    assert.deepEqual(w.poor.map((x) => [x.title, x.reasons[0], x.comment]), [['Compare payroll tools', 'wrong facts', 'wrong prices']]);
    assert.equal(w.suggestions.length, 1); assert.match(w.note, /Nothing changes by itself/);
    assert.equal(JSON.stringify(t.core.storage.all('SELECT * FROM settings')), settingsBefore, 'nothing changed');
    assert.equal((await t.call('/api/m/bench/weekly', { session: false })).status, 403);
  } finally { await t.close(); }
});

test('already a customer: a lead the Sales customers list has is marked so (the real Sales list: name and host)', async () => {
  const { t, bench, at } = await benchDesk();
  try {
    const sales = t.core.modules.api('sales');
    sales.addCompany({ name: 'Vega Tools', customer: true }, { from: 'customers.csv' });                                              // same name
    sales.addCompany({ name: 'Orion Tex Group', site: 'https://orion-textiles.example', customer: true }, { from: 'customers.csv' });  // same site, another name
    const real = t.core.modules.active.get('sales');
    const search = real.api.searchLeads;   // the leads as found, with a site for Orion (the page text has none)
    t.core.modules.active.set('sales', { ...real, api: { ...real.api, searchLeads: async (o) => { const r = await search(o); return { ...r, leads: r.leads.map((l) => /^Orion/.test(l.company) ? { ...l, website: 'https://www.orion-textiles.example/' } : l) }; } } });
    assert.deepEqual(sales.customers().map((c) => Object.keys(c).sort()), [['host', 'name'], ['host', 'name']], 'the real shape');
    await at(36.05);
    const titles = bench.items(bench.current().id).filter((i) => i.kind === 'lead').map((i) => i.title);
    assert.ok(titles.includes('Vega Tools: already a customer'), titles.join(' | '));
    assert.ok(titles.some((x) => /^Orion Textiles.*: already a customer$/.test(x)), titles.join(' | '));
    assert.ok(titles.includes('Lyra Foods: new'), titles.join(' | '));
  } finally { await t.close(); }
});
