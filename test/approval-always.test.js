// Actions that always ask the owner: at every level, inside an open auto-approve window, and never covered by "ask once".
// Installing or removing a module, changing the owner's customer records from an agent's tool (record.change, and custom
// until every caller has its own name), a repeating schedule and a standing lesson or instruction from an agent's turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';
import { SETTINGS_TOKEN, ACTIONS, ALWAYS_ASK } from '../app/core/approval-door.js';

const tick = () => new Promise(r => setTimeout(r, 15));
async function asks(core, req) {
  const p = core.approval.request({ agentId: 'coordinator', chatId: 'c1', title: 'Try ' + req.action, ...req });
  for (let i = 0; i < 40; i++) {
    const row = core.approval.listPending().find(a => a.title === 'Try ' + req.action);
    if (row) { core.approval.decide(row.id, 'approve'); await p; return true; }
    const done = await Promise.race([p.then(() => true), tick().then(() => false)]);
    if (done) return false;
  }
  return false;
}

test('the always-ask actions are named in the door', () => {
  for (const a of ['install', 'record.change', 'schedule.repeat', 'memory.lesson', 'custom']) {
    assert.ok(ACTIONS.includes(a), a);
    assert.ok(ALWAYS_ASK.has(a), a);
  }
});

for (const level of ['open', 'careful', 'strict']) {
  test(`at ${level}, with auto-approve open, each always-ask action asks every time`, async () => {
    const t = await testDesk();
    try {
      const { core } = t;
      core.approval.setLevel(level, SETTINGS_TOKEN);
      core.approval.setAutoApprove(60, SETTINGS_TOKEN);
      for (const action of ['install', 'record.change', 'schedule.repeat', 'memory.lesson', 'custom']) {
        assert.equal(await asks(core, { action, payload: { what: action } }), true, action + ' asked');
        assert.equal(await asks(core, { action, payload: { what: action } }), true, action + ' asked again: no ask-once grant');
      }
      // control: an ordinary file write is covered by the window
      assert.equal(await asks(core, { action: 'file.write', payload: { path: 'a.txt' } }), false, 'a file write is covered by the window');
    } finally { await t.close(); }
  });
}
