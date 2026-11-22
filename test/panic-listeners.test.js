// Panic hands each call a child signal. A finished call leaves nothing on the house signal; Panic and the parent still
// stop the child. Mail's stop hook is taken back when Mail is switched off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Panic } from '../app/core/panic.js';
import { testDesk } from './helpers/desk.js';

test('5000 finished calls leave no listener on the house signal; Panic and the parent still stop a child', async () => {
  const p = new Panic();
  for (let i = 0; i < 5000; i++) { const ac = new AbortController(); p.child(ac.signal); ac.abort('done'); }
  for (let i = 0; i < 500; i++) p.child().release();
  assert.equal(getEventListeners(p.signal, 'abort').length, 0);
  const kept = new AbortController(); for (let i = 0; i < 500; i++) p.child(kept.signal).release();
  assert.equal(getEventListeners(kept.signal, 'abort').length, 0, 'nor on a parent that lives on');
  // a space's view of Panic: the same, and closing the space stops its children
  const sc = p.scope(); const closedBy = sc.child();
  for (let i = 0; i < 500; i++) sc.child().release();
  assert.equal(getEventListeners(p.signal, 'abort').length, 1, 'only the one child still running');
  await sc.close(); assert.equal(closedBy.reason, 'closed');
  closedBy.release();
  const parent = new AbortController(); const a = p.child(parent.signal); const b = p.child();
  parent.abort('closed');
  assert.ok(a.aborted && !b.aborted, 'the parent stops its own child only');
  await p.stopAll('test');
  assert.ok(b.aborted); assert.equal(b.reason, 'halted');
  assert.ok(p.child().aborted, 'while halted a new child is born stopped');
  p.resume();
  assert.ok(!p.child().aborted);
  const gone = new AbortController(); gone.abort('earlier');
  assert.equal(p.child(gone.signal).reason, 'earlier');
});

test('switching Mail off and on adds no stop hook each time', async () => {
  const t = await testDesk({ modules: ['mail'] });
  try {
    const hooks = async () => { const r = (await t.call('/api/panic', { body: {} })).json; await t.call('/api/panic/resume', { method: 'POST' }); return r.stopped.hooks; };
    await t.call('/api/modules/mail/on', { method: 'POST' });
    const before = await hooks();
    for (let i = 0; i < 5; i++) { await t.call('/api/modules/mail/off', { method: 'POST' }); await t.call('/api/modules/mail/on', { method: 'POST' }); }
    assert.equal(await hooks(), before);
  } finally { await t.close(); }
});
