// An agent's turn that makes a REPEATING schedule asks the owner first (approval action 'schedule.repeat'), at every level and
// inside an auto-approve window. A one-time reminder does not ask; a schedule the owner makes on the page does not ask.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

const pendingOf = async (t, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const p = t.core.approval.listPending(); if (p.length) return p[0]; await new Promise(r => setTimeout(r, 20)); }
  return null;
};

test('a repeating schedule from a tool asks with what repeats and how often; No saves nothing, Yes saves it', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'] });
  try {
    const flows = t.core.modules.api('flows');
    const call = { agentId: 'coordinator', chatId: 'dm-coordinator' };
    let run = t.core.modules.runTool('schedule_create', { when: 'every day at 8', prompt: 'brief me on the news' }, call);
    let p = await pendingOf(t);
    assert.ok(p, 'a card waits');
    assert.equal(p.action, 'schedule.repeat');
    assert.match(p.title, /repeat/i);
    assert.match(p.detail, /Every day at 8:00 AM/); assert.match(p.detail, /brief me on the news/);
    t.core.approval.decide(p.id, 'deny');
    let out = await run;
    assert.equal(out.ok, false); assert.equal(out.decision, 'no'); assert.match(out.error, /Nothing was saved/);
    assert.equal(flows.list().length, 0, 'nothing was saved');
    run = t.core.modules.runTool('schedule_create', { when: 'every Monday at 10', prompt: 'check the prices' }, call);
    p = await pendingOf(t); t.core.approval.decide(p.id, 'approve');
    out = await run;
    assert.equal(out.ok, true); assert.equal(out.repeats, true);
    assert.equal(flows.list().length, 1);
  } finally { await t.close(); }
});

test('a one-time reminder from a tool does not ask; the owner\'s own schedule on the page does not ask', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'] });
  try {
    const out = await t.core.modules.runTool('schedule_create', { when: 'in 5 minutes', prompt: 'remind me to call the supplier' }, { agentId: 'coordinator', chatId: 'dm-coordinator' });
    assert.equal(out.ok, true); assert.equal(out.repeats, false);
    const r = await t.call('/api/m/flows/schedules', { body: { title: 'Brief', when: 'every day at 9', prompt: 'brief me' } });
    assert.equal(r.status, 200);
    assert.equal(t.core.approval.listPending().length, 0);
    assert.equal(t.core.modules.api('flows').list().length, 2);
  } finally { await t.close(); }
});

test('a chain of agents set to repeat by a tool asks too, and on No neither the schedule nor its run is made', async () => {
  const t = await testDesk({ modules: ['tasks', 'flows'] });
  try {
    const run = t.core.modules.runTool('flow_create', { title: 'Weekly leads', steps: [{ agentId: 'scout', instruction: 'find leads' }], when: 'every Friday at 5 pm' }, { agentId: 'coordinator', chatId: 'dm-coordinator' });
    const p = await pendingOf(t);
    assert.equal(p.action, 'schedule.repeat'); assert.match(p.detail, /Friday/);
    t.core.approval.decide(p.id, 'deny');
    const out = await run;
    assert.equal(out.schedule.ok, false);
    assert.equal(t.core.modules.api('flows').list().length, 0);
  } finally { await t.close(); }
});
