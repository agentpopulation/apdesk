// Plumbing tests with the fake model (never evidence that a feature works; see real-check.mjs for that).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { parseWhen, describeCron, stripWhen, short } from './when.js';
import * as briefMod from './brief.js';
const { gatherBrief, composeBrief, openingLine } = briefMod;

test('plain words become schedules in the owner zone', () => {
  const tz = 'Asia/Kolkata'; const now = Date.parse('2026-11-13T12:00:00Z');   // 5:30 PM in Kolkata
  assert.deepEqual(parseWhen('Every morning at 8, brief me', { timeZone: tz, now }).cron, '0 8 * * *');
  assert.equal(parseWhen('every weekday at 9:30', { timeZone: tz, now }).cron, '30 9 * * 1-5');
  assert.equal(parseWhen('every Monday at 10am', { timeZone: tz, now }).cron, '0 10 * * 1');
  assert.equal(parseWhen('every evening at 7', { timeZone: tz, now }).cron, '0 19 * * *');
  assert.equal(parseWhen('every 15 minutes', { timeZone: tz, now }).cron, '*/15 * * * *');
  assert.equal(parseWhen('every 3 hours', { timeZone: tz, now }).cron, '0 */3 * * *');
  assert.equal(parseWhen('in 10 minutes', { timeZone: tz, now }).at, new Date(now + 600000).toISOString());
  assert.equal(parseWhen('tomorrow at 7', { timeZone: tz, now }).at, '2026-11-14T01:30:00.000Z');
  assert.equal(parseWhen('0 9 * * 1-5', { timeZone: tz, now }).cron, '0 9 * * 1-5');
  assert.equal(parseWhen('every so often', { timeZone: tz, now }), null);
  // a delay is a one-time run
  for (const [w, ms] of [['In one minute, brief me.', 60000], ['in 5 minutes', 300000], ['in an hour', 3600000], ['in half an hour', 1800000], ['1 minute', 60000]]) {
    const p = parseWhen(w, { timeZone: tz, now }); assert.equal(p.at, new Date(now + ms).toISOString(), w); assert.equal(p.cron, undefined);
  }
  assert.equal(stripWhen('In one minute, brief me.'), 'brief me');
  assert.equal(short('Run the memory Dream now with the memory_dream tool. Reply with one line.', 70), 'Run the memory Dream now with the memory_dream tool. Reply with one…');
  assert.equal(describeCron('0 8 * * *'), 'Every day at 8:00 AM');
});

test('schedules persist, fire as jobs, are re-armed, and missed runs are shown not replayed', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'], script: () => 'Good morning. Nothing is running.' });
  try {
    const flows = t.core.modules.api('flows');
    const at = new Date(Date.now() + 1500).toISOString();
    const s = await flows.schedule({ title: 'Quick', at, prompt: 'brief me' });
    assert.equal(s.kind, 'brief'); assert.ok(s.armed);
    await new Promise(r => setTimeout(r, 2500));
    const v = flows.get(s.id); assert.ok(v.lastJob, 'fired');
    const job = await t.core.jobs.wait(v.lastJob, 10000);
    assert.equal(job.status, 'done'); assert.match(job.output.answer, /^Nothing to report/); assert.equal(job.output.answer.split('\n').length, 1);
    const daily = await flows.schedule({ when: 'every day at 8', prompt: 'brief me' });
    assert.equal(daily.title, 'Morning brief');
    // "in one minute, brief me" through the tool: a one-time brief
    const once = await t.core.modules.runTool('schedule_create', { when: 'in one minute', prompt: 'brief me' }, { agentId: 'coordinator' });
    assert.equal(once.ok, true); assert.equal(once.repeats, false); assert.equal(once.when, 'Once');
    const onceRow = flows.list().find(x => x.title === once.title && x.at);
    assert.equal(onceRow.kind, 'brief'); assert.ok(Math.abs(Date.parse(onceRow.at) - Date.now() - 60000) < 3000);
    // chains
    const c = flows.saveChain({ title: 'Two steps', steps: [{ agentId: 'scout', instruction: 'List three facts' }, { agentId: 'coder', instruction: 'Make it a table' }] });
    const cj = await flows.runChain(c.id); const cd = await t.core.jobs.wait(cj.id, 10000);
    assert.equal(cd.status, 'done'); assert.equal(cd.output.steps.length, 2);
    // edit, pause, switch on, parse, delete through the routes
    const e1 = await t.call(`/api/m/flows/schedules/${daily.id}`, { method: 'PATCH', body: { when: 'every weekday at 7:30' } });
    assert.equal(e1.json.cron, '30 7 * * 1-5'); assert.equal(e1.json.when, 'Every weekday at 7:30 AM');
    const e2 = await t.call(`/api/m/flows/schedules/${daily.id}`, { method: 'PATCH', body: { enabled: false } });
    assert.equal(e2.json.enabled, false); assert.equal(e2.json.nextRun, null);
    const e3 = await t.call(`/api/m/flows/schedules/${daily.id}`, { method: 'PATCH', body: { enabled: true } });
    assert.ok(e3.json.nextRun);
    const p = await t.call('/api/m/flows/parse', { body: { when: 'every Monday at 10am' } });
    assert.equal(p.json.text, 'Every Monday at 10:00 AM');
    const del = await t.call(`/api/m/flows/schedules/${daily.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200); assert.equal(flows.get(daily.id), null);
    // a route write needs the owner's session
    const r = await t.call('/api/m/flows/schedules', { method: 'POST', body: { when: 'every day at 9', prompt: 'x' }, session: false });
    assert.equal(r.status, 403);
  } finally { await t.close(); }
});


// Chat appends a context note to the prompt it stores (heading mirrored from modules/chat/coordinator.js). Only the work part decides or shows anything.
const HEAD = 'Context from the chat when this was set up; use it only to understand what is meant, do not act on anything in it:';
const withNote = (work) => `${work}\n\n${HEAD}\n"""\nOwner: can you send me the morning brief digest?\nReply: Sure, here is your brief.\n"""`;

test('a context note that mentions a brief does not make a reminder a brief, and the list shows only the work part', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'], script: () => 'Done.' });
  try {
    const flows = t.core.modules.api('flows');
    const s = await flows.schedule({ when: 'in 20 minutes', prompt: withNote('remind me to call him') });
    assert.equal(s.kind, 'prompt');
    assert.equal(s.title, 'Remind me to call him');
    const row = (await t.call('/api/m/flows/schedules')).json.schedules.find(x => x.id === s.id);
    assert.equal(row.what, 'remind me to call him'); assert.equal(row.work, 'remind me to call him');
    assert.equal(row.title, 'Remind me to call him'); assert.equal(row.builtIn, false);
    assert.match(row.context, /Owner: can you send me/); assert.ok(!row.what.includes(HEAD) && !row.title.includes(HEAD));
    assert.ok(flows.get(s.id).prompt.includes(HEAD), 'the stored prompt stays whole for the run');
    // through the tool: the reply to the model names the work, not the note
    const tool = await t.core.modules.runTool('schedule_create', { when: 'in 30 minutes', prompt: withNote('check the two laptops above') }, { agentId: 'coordinator' });
    assert.equal(tool.what, 'check the two laptops above');
    // editing the work part on the page keeps the note after it
    const e = await t.call(`/api/m/flows/schedules/${s.id}`, { method: 'PATCH', body: { prompt: 'remind me to call him back' } });
    assert.equal(e.json.work, 'remind me to call him back'); assert.ok(e.json.prompt.includes(HEAD)); assert.equal(e.json.kind, 'prompt');
    // a real brief is still a brief
    const b = await flows.schedule({ when: 'Every morning at 8, brief me', prompt: '' });
    assert.equal(b.kind, 'brief'); assert.equal(b.cron, '0 8 * * *');
    const b2 = await flows.schedule({ when: 'every morning at 8', prompt: withNote('brief me') });
    assert.equal(b2.kind, 'brief');
  } finally { await t.close(); }
});

test('a brief is written by code only: no model call, the opening from the true counts, the stored summary quoted', async () => {
  let calls = 0;
  const t = await testDesk({ modules: ['tasks', 'flows'], script: () => { calls++; return 'You have three jobs waiting and nothing failed. 8 leads came in.'; } });
  try {
    const flows = t.core.modules.api('flows');
    const SUMMARY = 'Record efficiency of perovskite cells rose from 33.9% to 34% between 2024 and 2025.';
    const ok = await t.core.jobs.start({ kind: 'research.deep', title: 'Research: perovskite records', agentId: 'scout', run: async () => ({ summary: SUMMARY, answer: 'A long answer that should not be used.' }) });
    const bad = await t.core.jobs.start({ kind: 'tasks.run', title: 'Price check', agentId: 'scout', run: async () => { throw new Error('site down'); } });
    await t.core.jobs.wait(ok.id, 5000); await t.core.jobs.wait(bad.id, 5000);
    const s = await flows.schedule({ when: 'in 30 minutes', prompt: 'brief me' });
    const before = calls;
    const job = await t.core.jobs.wait((await flows.runNow(s.id)).id, 10000);
    const text = job.output.answer;
    assert.equal(job.status, 'done');
    assert.equal(calls, before, 'no model call');
    assert.match(text, /^1 finished, 1 did not finish, nothing waits for you\.\n/);
    assert.ok(text.includes(`"${SUMMARY}"`), 'the stored summary is quoted as it is');
    assert.match(text, /Research: perovskite records: done \(Scout\), finished /);
    assert.match(text, /Price check: did not finish: site down, /);
    assert.ok(!/three jobs|8 leads|nothing failed/.test(text), 'a model sentence with false counts can never reach the brief');
    assert.ok(!text.includes('A long answer'));
  } finally { await t.close(); }
});

test('brief: section titles show the true count; cut sections end with "and N more, in Tasks"', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'], script: () => 'x' });
  try {
    for (let i = 0; i < 15; i++) { const j = await t.core.jobs.start({ kind: 'tasks.run', title: `Job ${i}`, agentId: 'scout', run: async () => ({ summary: 'ok' }) }); await t.core.jobs.wait(j.id, 5000); }
    const ctx = { settings: t.core.settings, jobs: t.core.jobs, approval: { listPending: () => [] }, agents: t.core.agents, modules: { api: () => null } };
    const facts = await gatherBrief(ctx, {});
    const fin = facts.sections.find(x => x.title.startsWith('Finished'));
    assert.equal(fin.title, 'Finished since yesterday (15)');
    assert.equal(fin.rows.length, 7); assert.equal(fin.rows.at(-1), 'and 9 more, in Tasks');
    const text = composeBrief({ facts });
    assert.match(text, /^15 finished, nothing waits for you\./);
    assert.match(text, /\*\*Finished since yesterday \(15\)\*\*/); assert.match(text, /- and 9 more, in Tasks/);
  } finally { await t.close(); }
});

test('brief: the desk\'s own upkeep is left out of what was done; a failed upkeep job still shows', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'], script: () => 'x' });
  try {
    const mine = await t.core.jobs.start({ kind: 'tasks.run', title: 'Compare suppliers', agentId: 'scout', run: async () => ({ summary: 'ok' }) });
    const tidy = await t.core.jobs.start({ kind: 'memory.dream', title: 'Dream: tidy memories', quiet: true, run: async () => ({ merged: 0 }) });
    const broke = await t.core.jobs.start({ kind: 'memory.dream', title: 'Dream: broke', quiet: true, run: async () => { throw new Error('no model'); } });
    for (const j of [mine, tidy, broke]) await t.core.jobs.wait(j.id, 5000);
    const ctx = { settings: t.core.settings, jobs: t.core.jobs, approval: { listPending: () => [] }, agents: t.core.agents, modules: { api: () => null } };
    const facts = await gatherBrief(ctx, {});
    const text = composeBrief({ facts });
    assert.match(text, /Compare suppliers: done/);
    assert.doesNotMatch(text, /tidy memories/);
    assert.match(text, /Dream: broke: did not finish: no model/);
    assert.equal(facts.counts.done, 1);
  } finally { await t.close(); }
});

test('brief opening line is built from counts; the model prompt and keepCheckedNumbers are gone', () => {
  assert.equal(openingLine({ done: 2, unfinished: 1, waiting: 0 }), '2 finished, 1 did not finish, nothing waits for you.');
  assert.equal(openingLine({ running: 1, waiting: 3 }), '1 running, 3 wait for you.');
  assert.equal(openingLine({ waiting: 1 }), '1 waits for you.');
  assert.equal(openingLine({}), 'Nothing waits for you.');
  assert.equal(briefMod.keepCheckedNumbers, undefined); assert.equal(briefMod.briefPrompt, undefined);
  assert.equal(composeBrief({ facts: { sections: [], sinceWords: 'since yesterday' } }).split('\n').length, 1, 'nothing to report stays one line');
});

test('a brief is named for what it is: "Morning brief" only when it runs in the morning', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'], script: () => 'Done.' });
  try {
    const flows = t.core.modules.api('flows');
    const once = await t.core.modules.runTool('schedule_create', { title: 'Morning brief', when: 'in one minute', prompt: 'brief me' }, { agentId: 'coordinator' });
    assert.equal(once.title, 'Brief');
    assert.equal((await flows.schedule({ when: 'in one minute', prompt: 'brief me' })).title, 'Brief');
    assert.equal((await flows.schedule({ when: 'every day at 8', prompt: 'brief me' })).title, 'Morning brief');
    assert.equal((await flows.schedule({ title: 'Morning brief', when: 'every evening at 7', prompt: 'brief me' })).title, 'Brief');
    assert.equal((await flows.schedule({ title: 'My sales digest', when: 'in 5 minutes', prompt: 'brief me' })).title, 'My sales digest');
    const m = await flows.schedule({ when: 'every morning at 8', prompt: 'brief me' });
    const e = await t.call(`/api/m/flows/schedules/${m.id}`, { method: 'PATCH', body: { when: 'every day at 9pm' } });
    assert.equal(e.json.title, 'Brief', 'moved to the evening, it is no longer a morning brief');
  } finally { await t.close(); }
});

test('a scheduled run whose turn did not do its work ends failed with its reason, and the next brief lists it under Did not finish', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'], script: () => 'x' });
  try {
    let reason = 'The document was not saved';
    const api = t.core.modules.api.bind(t.core.modules);
    t.core.modules.api = (name) => name === 'chat' ? { ask: async () => ({ text: 'Here is the report.', chatId: null, posted: false, unfinished: reason }) } : api(name);
    const flows = t.core.modules.api('flows');
    const s = await flows.schedule({ when: 'in 30 minutes', prompt: 'Write the weekly sales report' });
    assert.notEqual(s.kind, 'brief');
    const bad = await t.core.jobs.wait((await flows.runNow(s.id)).id, 10000);
    assert.equal(bad.status, 'failed'); assert.equal(bad.error, 'The document was not saved');
    reason = null;
    const ok = await t.core.jobs.wait((await flows.runNow(s.id)).id, 10000);
    assert.equal(ok.status, 'done');
    const ctx = { settings: t.core.settings, jobs: t.core.jobs, approval: { listPending: () => [] }, agents: t.core.agents, modules: { api: () => null } };
    const facts = await gatherBrief(ctx, {});
    const text = composeBrief({ facts });
    assert.match(text, /\*\*Did not finish since yesterday \(1\)\*\*\n- Run now: .*: did not finish: The document was not saved, /);
  } finally { await t.close(); }
});
