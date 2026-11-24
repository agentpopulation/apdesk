// The Tasks door other modules use to add a to-do for a person.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

test('addTodo adds a to-do for a person with who and when, once, and the page lists it', async () => {
  const t = await testDesk({ modules: ['tasks'] });
  try {
    const tasks = t.core.modules.api('tasks');
    const a = tasks.addTodo({ title: 'Send the price list', who: 'Ravi', due: '2026-12-01', from: 'Meeting: Weekly sync', cause: 'owner-click' });
    assert.equal(a.who, 'Ravi'); assert.equal(a.due, '2026-12-01'); assert.equal(a.source, 'Meeting: Weekly sync'); assert.equal(a.done, false);
    assert.equal(tasks.addTodo({ title: 'Send the price list', who: 'Ravi', from: 'Meeting: Weekly sync', cause: 'owner-click' }).id, a.id, 'same to-do, same source: once');
    const b = tasks.addTodo({ title: 'Call Meena', from: 'Meeting: Weekly sync' });
    assert.equal(b.who, ''); assert.equal(b.due, null);
    assert.equal((await t.call('/api/m/tasks/todos')).json.todos.length, 2);
    const done = await t.call(`/api/m/tasks/todos/${a.id}/done`, { body: {} });
    assert.equal(done.json.done, true);
    assert.equal((await t.call('/api/m/tasks/todos')).json.todos[0].id, b.id, 'open ones first');
    assert.equal((await t.call(`/api/m/tasks/todos/${b.id}`, { method: 'DELETE' })).status, 200);
    assert.equal(tasks.todos().length, 1);
  } finally { await t.close(); }
});

test('addTodo refuses what is not the owner\'s click, no title, no source, a bad date; and starts no job', async () => {
  const t = await testDesk({ modules: ['tasks'] });
  try {
    const tasks = t.core.modules.api('tasks');
    assert.throws(() => tasks.addTodo({ title: 'x', from: 'Playbooks', cause: 'schedule' }), /pressed a button/);
    assert.throws(() => tasks.addTodo({ title: ' ', from: 'Meetings' }), /Say what/);
    assert.throws(() => tasks.addTodo({ title: 'x' }), /where the to-do came from/);
    assert.throws(() => tasks.addTodo({ title: 'x', from: 'Meetings', due: 'someday' }), /not valid/);
    assert.equal(tasks.todos().length, 0);
    tasks.addTodo({ title: 'x', from: 'Meetings', cause: 'owner-click' });
    assert.equal(t.core.jobs.list({ limit: 10 }).length, 0, 'a to-do is not a job');
    const man = JSON.parse((await import('node:fs')).readFileSync(new URL('./module.json', import.meta.url), 'utf8'));
    assert.equal(man.tools.some(x => /todo/.test(x)), false, 'no model tool adds a to-do');
    // a person's page call without the owner session is refused
    assert.equal((await t.call('/api/m/tasks/todos', { body: { title: 'y' }, session: false })).status === 200, false);
  } finally { await t.close(); }
});
