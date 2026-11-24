// The approval door's doors for other modules: a strict job asks for everything, a decision is made once, counts per agent
// for the Scorecard, spend counted on the owner's clock, and only the Models and Vault modules may change model keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';
import { dayStart, KEY_MODULES } from '../app/core/model-door.js';

const tick = () => new Promise(r => setTimeout(r, 20));
const pendingFor = async (core, jobId) => { for (let i = 0; i < 50; i++) { const p = core.approval.listPending().find(a => a.jobId === jobId); if (p) return p; await tick(); } return null; };

test('a job started with strictApprovals asks for every action, at Open and inside an auto-approve window', async () => {
  const t = await testDesk();
  try {
    const { core } = t;
    assert.equal(core.approval.level, 'open');
    // control: at Open a plain job's file write goes ahead without asking
    let plain;
    const j0 = await core.jobs.start({ kind: 'test', title: 'plain', run: async (job) => { plain = await core.approval.request({ agentId: 'coordinator', jobId: job.id, action: 'file.write', title: 'Write a.txt', payload: { path: 'a.txt' } }); } });
    await core.jobs.wait(j0.id, 5000);
    assert.equal(plain.ok, true); assert.equal(plain.how, 'level');

    const ctxJobs = core.jobs.forModule();
    assert.ok(ctxJobs.takes.includes('strictApprovals'), 'a module can tell the option is there');
    assert.equal(core.approval.forModule().strictJobs, true);
    const results = [];
    const j = await ctxJobs.start({ kind: 'test', title: 'strict', strictApprovals: true, run: async (job) => {
      results.push(await core.approval.request({ agentId: 'coordinator', jobId: job.id, action: 'file.write', title: 'Write b.txt', payload: { path: 'b.txt' } }));
      results.push(await core.approval.request({ agentId: 'coordinator', jobId: job.id, action: 'file.write', title: 'Write b.txt again', payload: { path: 'b.txt' } }));
    } });
    assert.equal(core.jobs.get(j.id).strictApprovals, true);
    const first = await pendingFor(core, j.id);
    assert.ok(first, 'the first write waits for the owner');
    core.approval.decide(first.id, 'approve');
    // the second write of the same job asks again: a strict job keeps no ask-once grant, and a window does not cover it
    core.approval.setAutoApprove(60, (await import('../app/core/approval-door.js')).SETTINGS_TOKEN);
    const second = await pendingFor(core, j.id);
    assert.ok(second && second.id !== first.id, 'the second write asks too, with auto-approve open');
    core.approval.decide(second.id, 'deny');
    await core.jobs.wait(j.id, 5000);
    assert.deepEqual(results.map(r => r.ok), [true, false]);
    assert.equal(core.jobs.isStrict(j.id), false, 'a job that is over is no longer kept');
  } finally { await t.close(); }
});

test('a decision is made once: deciding again changes nothing and writes no second line', async () => {
  const t = await testDesk();
  try {
    const { core } = t;
    const p = core.approval.request({ agentId: 'coordinator', action: 'send.person', title: 'Send a note', payload: { to: 'a@shop.example', body: 'hi' } });
    let row; for (let i = 0; i < 50 && !row; i++) { row = core.approval.listPending()[0]; await tick(); }
    const lines = () => core.approval.activityList(500).filter(a => a.title === 'Send a note').length;
    const one = core.approval.decide(row.id, 'approve', 'owner', 'Phone of the shop');
    assert.equal(one.status, 'approved'); assert.equal(one.already, undefined);
    assert.equal((await p).ok, true);
    const n = lines();
    const two = core.approval.decide(row.id, 'deny');
    assert.equal(two.already, true); assert.equal(two.status, 'approved', 'the first decision stands');
    assert.equal(lines(), n, 'no second activity line');
    assert.match(core.approval.activityList(5).find(a => a.title === 'Send a note').detail, /Decided on the phone "Phone of the shop"/);
    // through the desk's own route: the answer says it was already decided
    const r = await t.call(`/api/approvals/${row.id}/deny`, { method: 'POST' });
    assert.equal(r.json.status, 'approved'); assert.equal(r.json.already, true);
  } finally { await t.close(); }
});

test('countsBetween: per agent, asked and refused between two times; what the level granted is not counted', async () => {
  const t = await testDesk();
  try {
    const { core } = t; const door = core.approval.forModule();
    const from = new Date(Date.now() - 1000).toISOString();
    await core.approval.request({ agentId: 'coordinator', action: 'file.write', title: 'granted by the level', payload: {} });   // Open: allowed
    const asks = [core.approval.request({ agentId: 'coordinator', action: 'shell.run', title: 'one', payload: { cmd: 'a' } }), core.approval.request({ agentId: 'scout', action: 'shell.run', title: 'two', payload: { cmd: 'b' } })];
    let pend = []; for (let i = 0; i < 50 && pend.length < 2; i++) { pend = core.approval.listPending(); await tick(); }
    core.approval.decide(pend.find(a => a.agentId === 'coordinator').id, 'deny'); core.approval.decide(pend.find(a => a.agentId === 'scout').id, 'approve');
    await Promise.all(asks);
    const to = new Date(Date.now() + 1000).toISOString();
    assert.deepEqual(door.countsBetween(from, to), [{ agentId: 'coordinator', asked: 1, denied: 1 }, { agentId: 'scout', asked: 1, denied: 0 }]);
    assert.deepEqual(door.countsBetween(to, new Date(Date.now() + 5000).toISOString()), []);
  } finally { await t.close(); }
});

test('spend today and this month are counted from midnight in the owner\'s zone, as in the model door', async () => {
  const t = await testDesk();
  try {
    const { core } = t;
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      core.storage.run("DELETE FROM approvals WHERE action = 'spend'");
      core.settings.set('timeZone', zone);
      const start = dayStart(Date.now(), zone).getTime();
      const put = (ms, amount) => core.storage.run("INSERT INTO approvals (id, action, title, amount, currency, status, how, created, decided) VALUES (?, 'spend', 'x', ?, 'USD', 'approved', 'owner', ?, ?)", 'ap_t' + ms + amount, amount, new Date(ms).toISOString(), new Date(ms).toISOString());
      put(start - 60000, 700);   // one minute before the owner's midnight: yesterday
      put(start + 60000, 300);   // one minute after: today
      assert.equal(core.approval.spent('day'), 300, `today in ${zone}`);
      const month = dayStart(Date.now(), zone, true).getTime();
      assert.equal(core.approval.spent('month'), month <= start - 60000 ? 1000 : 300, `this month in ${zone}`);
    }
  } finally { await t.close(); }
});

test('the model door hands key changes only to the modules named in the core', () => {
  assert.deepEqual([...KEY_MODULES].sort(), ['models', 'vault']);
});

test('a module that is not named gets the list of keys only, never add, switch or remove', async () => {
  const t = await testDesk();
  try {
    const other = t.core.model.forModule('chat');
    assert.equal(typeof other.keys.list, 'function');
    for (const k of ['add', 'toggle', 'remove', 'tier']) assert.equal(other.keys[k], undefined, k);
    assert.ok(Object.isFrozen(other.keys));
    const models = t.core.model.forModule('models');
    for (const k of ['list', 'add', 'toggle', 'remove', 'tier']) assert.equal(typeof models.keys[k], 'function', k);
  } finally { await t.close(); }
});
