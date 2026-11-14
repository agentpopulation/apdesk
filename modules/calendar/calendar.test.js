import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { writeIcs, readIcs, wallToUtc } from './ics.js';

test('ics round trip and owner-zone times', () => {
  assert.equal(wallToUtc('2026-11-20T10:00', 'Asia/Kolkata'), '2026-11-20T04:30:00.000Z');
  const ev = readIcs(writeIcs([{ uid: 'u1', title: 'A; b, c', start: '2026-11-20T04:30:00.000Z', end: '2026-11-20T05:00:00.000Z', notes: 'x\ny' }]))[0];
  assert.equal(ev.title, 'A; b, c'); assert.equal(ev.notes, 'x\ny'); assert.equal(ev.start, '2026-11-20T04:30:00.000Z');
});
test('an agent add waits for calendar.write', async () => {
  const t = await testDesk({ modules: ['calendar'] });
  try {
    await t.call('/api/modules/calendar/on', { method: 'POST' });
    const p = t.core.modules.runTool('calendar_add', { title: 'Call', start: '2026-11-20T10:00' }, { agentId: 'closer' });
    await new Promise(r => setTimeout(r, 100));
    const a = t.core.approval.listPending().find(x => x.action === 'calendar.write'); assert.ok(a);
    assert.equal((await t.call('/api/m/calendar/events')).json.events.length, 0);
    await t.call(`/api/approvals/${a.id}/approve`, { method: 'POST' });
    assert.equal((await p).ok, true);
    assert.equal((await t.call('/api/m/calendar/events')).json.events.length, 1);
  } finally { await t.close(); }
});
