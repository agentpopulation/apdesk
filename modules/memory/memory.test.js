// Plumbing tests with the fake model (never proof that learning works; see real-check.mjs for that).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { nightlyDue } from './dream.js';

const script = (body) => {
  const sys = body.messages?.[0]?.content || '';
  if (/^Give 4 to 8/.test(sys)) return 'bookkeeping accounts tax finance';
  if (/long-term memory of a business owner/.test(sys) && /exchange/.test(body.messages[1].content)) return JSON.stringify({ memories: [{ event: 'ADD', kind: 'fact', text: 'The owner sells rack monitors.', keys: 'sensors hardware' }, { event: 'ADD', kind: 'fact', text: 'The api key is sk-abcdefghijklmnop123' }], ignored: ['a test line'] });
  if (/You tidy/.test(sys)) { const items = JSON.parse(body.messages[1].content); return JSON.stringify({ merge: [{ ids: items.filter(i => /office/i.test(i.text)).map(i => i.id), text: 'The owner\'s office is in Pune.' }], summary: 'A day.' }); }
  return 'ok';
};

test('memory: remember, recall by search words, forPrompt without a model, lessons always, owner-only forget', async () => {
  const t = await testDesk({ modules: ['memory'], script });
  try {
    const mem = t.core.modules.api('memory');
    await mem.remember({ text: 'His accountant is Priya Shah in Pune.', kind: 'fact' });
    await mem.remember({ agentId: 'closer', text: 'When I ask for leads, always include the city.', kind: 'lesson' });
    const r = await mem.recall({ query: 'who does my bookkeeping' });
    assert.match(r[0].text, /Priya/);
    const calls = t.fake.calls.length;
    const block = mem.forPrompt('closer', 'find me some leads');
    assert.match(block, /include the city/);
    assert.equal(mem.forPrompt('scout', 'hello there'), '');
    assert.match(mem.forPrompt('scout', 'remind me about my accountant'), /Priya/);
    assert.equal(t.fake.calls.length, calls, 'forPrompt made no model call');
    const learned = await mem.learnFromTurn({ chatId: 'c1', agentId: 'coordinator', user: 'We sell rack monitors to data centres in Pune.', assistant: 'Noted.' });
    assert.equal(learned.added.length, 1); assert.ok(learned.ignored.some(x => /Not kept/.test(x)), 'the secret was refused');
    const items = (await t.call('/api/m/memory/items')).json.items;
    assert.ok(items.length >= 3);
    assert.equal((await t.call(`/api/m/memory/items/${items[0].id}`, { method: 'DELETE', session: false })).status, 403);
    assert.equal((await t.call(`/api/m/memory/items/${items[0].id}`, { method: 'DELETE' })).status, 200);
    await mem.remember({ text: "The owner's office is in Pune." }); await mem.remember({ text: 'His office is located in Pune city.' });
    const job = (await t.call('/api/m/memory/dream', { body: {} })).json;
    const done = await t.core.jobs.wait(job.jobId, 5000);
    assert.equal(done.status, 'done'); assert.ok(done.output.merged >= 1);
    // who started it is recorded and shown; only the owner's button and the nightly timer can start a Dream
    assert.equal(done.quiet, false, 'Run Dream now is the owner\'s own job, not quiet');
    const st = (await t.call('/api/m/memory/status')).json; assert.equal(st.lastDream.source, 'owner'); assert.match(st.lastDream.startedBy, /Run Dream now/); assert.equal(st.dreams.length, 1);
    assert.equal((await t.call('/api/m/memory/dream', { body: {}, session: false })).status, 403, 'not the owner: refused');
    assert.ok(!t.core.modules.tools.has('memory_dream'), 'no model turn can start a Dream'); assert.equal(typeof mem.dream, 'undefined', 'no other module can start a Dream'); assert.equal((await mem.recall({ query: 'office' })).filter(m => /office/.test(m.text)).length, 1);
  } finally { await t.close(); }
});

test('memory: learns from Chat\'s message events (user, streaming reply ignored, final reply learned)', async () => {
  const t = await testDesk({ modules: ['memory'], script });
  try {
    const ev = t.core.events;
    ev.emit('chat', { type: 'message', chatId: 'c9', message: { role: 'user', chatId: 'c9', text: 'We sell rack monitors to data centres in Pune.', status: 'done' } });
    ev.emit('chat', { type: 'message', chatId: 'c9', message: { role: 'assistant', chatId: 'c9', agentId: 'coordinator', text: '', status: 'streaming' } });
    ev.emit('chat', { type: 'delta', chatId: 'c9', messageId: 2, text: 'Noted' });
    ev.emit('chat', { type: 'message', chatId: 'c9', message: { role: 'assistant', chatId: 'c9', agentId: 'coordinator', text: 'Noted.', status: 'done' } });
    for (let i = 0; i < 50 && !(await t.call('/api/m/memory/items')).json.items.length; i++) await new Promise(r => setTimeout(r, 50));
    assert.match((await t.call('/api/m/memory/items')).json.items.map(m => m.text).join(' '), /rack monitors/);
  } finally { await t.close(); }
});

test('memory: the nightly Dream is the desk\'s own upkeep (quiet); Settings still shows when it last ran', async () => {
  const t = await testDesk({ modules: ['memory'], script });
  try {
    t.core.settings.set('timeZone', 'UTC');
    const at3 = new Date(); at3.setUTCHours(3, 20, 0, 0);
    mock.timers.enable({ apis: ['Date'], now: at3.getTime() });   // only the clock is 3:20; timers run as usual
    let job = null;
    try { for (let i = 0; i < 80 && !job; i++) { await new Promise(r => setTimeout(r, 100)); job = t.core.jobs.list().find(j => j.kind === 'memory.dream'); } }
    finally { mock.timers.reset(); }
    assert.ok(job, 'the nightly timer started a Dream');
    assert.equal(job.quiet, true);
    const done = await t.core.jobs.wait(job.id, 5000); assert.equal(done.status, 'done');
    const st = (await t.call('/api/m/memory/status')).json; assert.equal(st.lastDream.source, 'nightly');
  } finally { await t.close(); }
});

test('memory: the nightly Dream is due only between 3:17 and 3:47 in the owner\'s zone, once a night, never later in the day', () => {
  const ist = 'Asia/Kolkata';
  assert.equal(nightlyDue(new Date('2026-11-13T21:47:00Z'), ist, null).due, true, '3:17 AM IST');
  assert.equal(nightlyDue(new Date('2026-11-13T21:46:00Z'), ist, null).due, false, '3:16 AM IST');
  assert.equal(nightlyDue(new Date('2026-11-14T04:28:00Z'), ist, null).due, false, '9:58 AM IST: a missed night is not run later');
  assert.equal(nightlyDue(new Date('2026-11-13T22:20:00Z'), ist, null).due, false, '3:50 AM IST: the window has passed');
  const first = nightlyDue(new Date('2026-11-13T21:47:00Z'), ist, null);
  assert.equal(first.day, '2026-11-14'); assert.equal(nightlyDue(new Date('2026-11-13T21:50:00Z'), ist, first.day).due, false, 'once a night');
  assert.equal(nightlyDue(new Date('2026-11-14T03:17:00Z'), 'UTC', null).due, true);
});

test('memory: the old Flows schedule that asked a model turn to call memory_dream is removed', async () => {
  const t = await testDesk({ modules: ['flows', 'memory'], script });
  try {
    const flows = t.core.modules.api('flows');
    await flows.schedule({ title: 'Nightly Dream', cron: '17 3 * * *', prompt: 'Run the memory Dream now with the memory_dream tool. Reply with one line.', agentId: 'coordinator' });
    await flows.schedule({ title: 'Morning brief', cron: '0 8 * * *', prompt: 'Brief me on my pipeline.' });
    for (let i = 0; i < 80 && flows.list().some(s => s.title === 'Nightly Dream'); i++) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(flows.list().map(s => s.title), ['Morning brief']);
  } finally { await t.close(); }
});
