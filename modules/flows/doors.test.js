// The Flows door: a schedule that hands its run to another module (kind 'module').
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

// a stand-in module that offers runScheduled, put in place of a real one for the test
function withTarget(t, calls, out = { answer: 'Done.' }) {
  const mods = t.core.modules; const real = mods.api.bind(mods);
  mods.api = (id) => id === 'playbooks' ? { runScheduled: async (ref, o) => { calls.push({ ref, hasSignal: !!o?.signal }); return typeof out === 'function' ? out() : out; } } : real(id);
  const list = mods.list.bind(mods);
  mods.list = (...a) => [...list(...a), { id: 'playbooks', name: 'Playbooks' }];
}

/** The owner says yes to the card a repeating schedule from a tool now asks for ('schedule.repeat'). Returns a stop function. */
const approving = (t) => { const i = setInterval(() => { for (const p of t.core.approval.listPending()) if (p.action === 'schedule.repeat') t.core.approval.decide(p.id, 'approve'); }, 20); return () => clearInterval(i); };

test('a module schedule shows in the list, runs the module as a job with its ref, and the output is kept', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'] });
  try {
    const calls = []; withTarget(t, calls);
    const flows = t.core.modules.api('flows');
    const s = await flows.schedule({ title: 'Month-end summary', when: 'every day at 8', moduleId: 'playbooks', ref: { book: 'month-end' } });
    assert.equal(s.kind, 'module'); assert.equal(s.moduleId, 'playbooks'); assert.equal(s.what, 'Runs a job for Playbooks'); assert.ok(s.armed);
    assert.ok(flows.list().some(x => x.id === s.id), 'managed in the one list');
    const job = await flows.runNow(s.id, { byOwner: true }); const d = await t.core.jobs.wait(job.id, 5000);
    assert.equal(d.status, 'done'); assert.deepEqual(calls[0].ref, { book: 'month-end' }); assert.equal(calls[0].hasSignal, true); assert.equal(d.output.answer, 'Done.');
    assert.equal(flows.get(s.id).lastStatus, 'done');
    // the owner can pause it like any other
    assert.equal((await flows.edit(s.id, { enabled: false })).enabled, false);
    // a model's tool cannot make one: schedule_create has no module field
    const man = JSON.parse((await import('node:fs')).readFileSync(new URL('./module.json', import.meta.url), 'utf8'));
    assert.deepEqual(man.tools, ['schedule_create', 'schedule_list', 'flow_create']);
    const stop = approving(t);
    const viaTool = await t.core.modules.runTool('schedule_create', { when: 'every day at 8', prompt: 'brief me', moduleId: 'playbooks' }, { agentId: 'coordinator' });
    stop();
    assert.notEqual(flows.list().find(x => x.title === viaTool.title)?.kind, 'module');
  } finally { await t.close(); }
});

test('a module schedule can never come due more than once an hour', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'] });
  try {
    const calls = []; withTarget(t, calls);
    const flows = t.core.modules.api('flows');
    for (const when of ['every 15 minutes', '*/30 * * * *', '0,30 9 * * *']) await assert.rejects(flows.schedule({ title: 'x', when, moduleId: 'playbooks', ref: 1 }), /at most once an hour/, when);
    const ok = await flows.schedule({ title: 'Hourly', when: '0 * * * *', moduleId: 'playbooks', ref: 1 }); assert.ok(ok.armed);
    await assert.rejects(flows.edit(ok.id, { cron: '*/10 * * * *' }), /at most once an hour/);
    assert.equal(flows.get(ok.id).cron, '0 * * * *', 'a refused edit changes nothing');
    // a due time that comes less than an hour after a run is skipped, with the reason; the owner's Run now still works
    const j1 = await flows.runNow(ok.id, { byOwner: true }); await t.core.jobs.wait(j1.id, 5000);
    await assert.rejects(flows.runNow(ok.id), /ran in the last hour/);
    t.core.storage.run('UPDATE m_flows_schedules SET last_run = ? WHERE id = ?', new Date().toISOString(), ok.id);
    // the clock path: due again within the hour of a run, it is skipped with the reason and the module is not called
    const once = await flows.schedule({ title: 'Soon', at: new Date(Date.now() + 1500).toISOString(), moduleId: 'playbooks', ref: 2 });
    t.core.storage.run('UPDATE m_flows_schedules SET last_run = ? WHERE id = ?', new Date().toISOString(), once.id);
    const n = calls.length; await new Promise(r => setTimeout(r, 2600));
    assert.equal(calls.length, n); assert.equal(flows.get(once.id).lastStatus, 'skipped'); assert.match(flows.get(once.id).lastNote, /at most once an hour/);
  } finally { await t.close(); }
});

test('it waits, with the reason, while offline, after Panic, in Incognito, and when the module is off; nothing is run', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'] });
  try {
    const calls = []; withTarget(t, calls);
    const flows = t.core.modules.api('flows');
    const s = await flows.schedule({ title: 'Weekly', at: new Date(Date.now() + 1500).toISOString(), moduleId: 'playbooks', ref: 'x' });
    t.core.settings.set('online', false);
    await new Promise(r => setTimeout(r, 2600));
    let v = flows.get(s.id);
    assert.equal(calls.length, 0); assert.equal(v.lastStatus, 'skipped'); assert.match(v.lastNote, /desk is offline/); assert.equal(v.lastJob, null);
    await assert.rejects(flows.runNow(s.id, { byOwner: true }), /offline/);
    t.core.settings.set('online', true);
    const s2 = await flows.schedule({ title: 'Daily', when: 'every day at 8', moduleId: 'playbooks', ref: 'x' });
    await t.core.panic.stopAll('test');
    await assert.rejects(flows.runNow(s2.id, { byOwner: true }), /Panic/);
    const s3 = await flows.schedule({ title: 'Soon', at: new Date(Date.now() + 1200).toISOString(), moduleId: 'playbooks', ref: 3 });
    await new Promise(r => setTimeout(r, 2200)); assert.match(flows.get(s3.id).lastNote, /Panic/); assert.equal(calls.length, 0);
    t.core.panic.resume();
    // the module goes off
    const mods = t.core.modules; const real = mods.api; mods.api = (id) => id === 'playbooks' ? null : real.call(mods, id);
    await assert.rejects(flows.runNow(s2.id, { byOwner: true }), /Playbooks is switched off/);
    await assert.rejects(flows.schedule({ title: 'y', when: 'every day at 8', moduleId: 'playbooks', ref: 1 }), /cannot run schedules/);
    assert.equal(calls.length, 0);
  } finally { await t.close(); }
});

test('only a module that offers runScheduled can be named, and a module cannot name Flows itself', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'] });
  try {
    const flows = t.core.modules.api('flows');
    await assert.rejects(flows.schedule({ title: 'x', when: 'every day at 8', moduleId: 'tasks', ref: 1 }), /cannot run schedules/);
    await assert.rejects(flows.schedule({ title: 'x', when: 'every day at 8', moduleId: 'flows', ref: 1 }), /itself/);
    await assert.rejects(flows.schedule({ title: 'x', when: 'every day at 8', moduleId: 'nothing', ref: 1 }), /cannot run schedules/);
    t.core.incognito = true;
    await assert.rejects(flows.schedule({ title: 'x', when: 'every day at 8', moduleId: 'tasks', ref: 1 }), /Incognito/);
    t.core.incognito = false;
    await assert.rejects(flows.schedule({ title: '', when: 'every day at 8', moduleId: 'tasks', ref: 1 }), /name/);
  } finally { await t.close(); }
});
