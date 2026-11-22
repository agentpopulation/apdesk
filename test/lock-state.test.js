// While the desk is locked, nothing private leaves it: the state the lock needs holds no approvals, agents or tools, and
// the event stream carries only the lock and Panic. A stream opened before the lock is ended when it locks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from './helpers/desk.js';

/** Read an event stream for ms milliseconds; resolves with everything it sent and whether the desk ended it. */
async function readStream(base, ms, onOpen = () => {}) {
  const ac = new AbortController(); let text = ''; let ended = false;
  const r = await fetch(base + '/api/events', { signal: ac.signal });
  const reader = r.body.getReader(); const dec = new TextDecoder();
  const t = setTimeout(() => ac.abort(), ms);
  onOpen();
  try { for (;;) { const { value, done } = await reader.read(); if (done) { ended = true; break; } text += dec.decode(value); } } catch { /* aborted by us */ }
  clearTimeout(t);
  return { text, ended };
}

test('locked: /api/state gives only what the lock screen needs; a waiting mail body is not in it', async () => {
  const t = await testDesk({ modules: ['accounts'] });
  try {
    await t.call('/api/modules/accounts/on', { method: 'POST' });
    assert.equal((await t.call('/api/m/accounts/pin', { body: { pin: '4826' } })).json.hasPin, true);
    const ask = t.core.approval.request({ action: 'send.person', title: 'Mail the supplier', payload: { to: 'x@example.com', body: 'PRIVATE-BODY-TEXT' } });
    assert.ok(JSON.stringify((await t.call('/api/state')).json).includes('PRIVATE-BODY-TEXT'), 'open: the card is there');
    assert.equal((await t.call('/api/m/accounts/lock', { method: 'POST' })).json.locked, true);
    for (const session of [true, false]) {
      const s = await t.call('/api/state', { session });
      assert.equal(s.status, 200);
      assert.ok(!s.text.includes('PRIVATE-BODY-TEXT'), 'no mail body while locked');
      assert.equal(s.json.locked, true);
      assert.deepEqual([s.json.pendingApprovals, s.json.agents, s.json.tools], [[], [], []]);
      assert.ok(s.json.settings.theme && 'timeZone' in s.json.settings && 'onboarded' in s.json.settings, 'looks, zone and first-run mark are there');
      assert.equal(s.json.settings.ownerName, undefined);
      assert.ok(s.json.modules.some(m => m.id === 'accounts'), 'the lock screen module is listed');
    }
    // every other route the lock lets through gives nothing private either
    assert.deepEqual(Object.keys((await t.call('/api/panic')).json).sort(), ['at', 'halted', 'reason']);
    assert.deepEqual(Object.keys((await t.call('/api/m/accounts/state')).json).sort(), ['hasPin', 'idleMinutes', 'lockOnStart', 'locked', 'totp', 'waitSeconds']);
    for (const p of ['/api/approvals', '/api/home', '/api/agents', '/api/jobs', '/api/model/usage']) assert.equal((await t.call(p)).status, 423, p);
    // who is at the desk is open, so the page can start and draw the lock; it says nothing of what waits
    const ppl = await t.call('/api/people');
    assert.equal(ppl.status, 200); assert.ok(!ppl.text.includes('PRIVATE-BODY-TEXT')); assert.ok(ppl.json.people.every(p => p.waiting === 0));
    // the locked stream: a new card is not sent; the unlock is
    const st = await readStream(t.base, 800, () => setTimeout(() => {
      t.core.approval.request({ action: 'send.person', title: 'Second mail', payload: { body: 'SECOND-PRIVATE' } });
      t.call('/api/m/accounts/unlock', { body: { pin: '4826' } });
    }, 150));
    assert.ok(!st.text.includes('SECOND-PRIVATE') && !st.text.includes('Second mail'), 'no approval event on the locked stream');
    assert.match(st.text, /event: accounts/);
    assert.ok(st.ended, 'the locked stream is ended on unlock, so the page reconnects to the full one');
    const open = await t.call('/api/state');
    assert.ok(open.text.includes('PRIVATE-BODY-TEXT'), 'unlocked: the cards are back');
    t.core.approval.cancelAll?.('test'); void ask;
  } finally { await t.close(); }
});

test('locked: a stream opened before the lock is ended when the desk locks', async () => {
  const t = await testDesk({ modules: ['accounts'] });
  try {
    await t.call('/api/modules/accounts/on', { method: 'POST' });
    await t.call('/api/m/accounts/pin', { body: { pin: '4826' } });
    await t.call('/api/m/accounts/unlock', { body: { pin: '4826' } });
    const st = await readStream(t.base, 1500, () => setTimeout(() => t.call('/api/m/accounts/lock', { method: 'POST' }), 150));
    assert.match(st.text, /event: accounts/);
    assert.ok(st.ended, 'ended by the desk, not by the test');
  } finally { await t.close(); }
});
