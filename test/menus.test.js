// Menus your way: the owner's names, order, hidden places and the place that opens first, kept as ui.menu in settings.
// The rules are plain functions (app/ui/menus.js) so they are checked here without a browser; the route that keeps them is
// the desk's own settings route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMenu, arrangeMenu, firstPlace, movePlace, MENU_KEY, NAME_MAX } from '../app/ui/menus.js';
import { testDesk } from './helpers/desk.js';

const PLACES = [{ id: 'chat', label: 'Chat' }, { id: 'tasks', label: 'Tasks' }, { id: 'settings', label: 'Settings' }, { id: 'bench', label: 'Bench', module: 'bench' }, { id: 'mail', label: 'Mail', module: 'mail' }];
const ids = (list) => list.map(x => x.id);

test('menus: no choices keep the default menu, names and order', () => {
  for (const raw of [undefined, null, {}, [], 'x', 7]) {
    const m = arrangeMenu(PLACES, raw);
    assert.deepEqual(ids(m), ids(PLACES)); assert.deepEqual(m.map(x => x.label), PLACES.map(x => x.label));
    assert.ok(m.every(x => !x.renamed && !x.hidden));
  }
  assert.equal(firstPlace(PLACES, null), 'chat');
});

test('menus: a renamed place shows the owner\'s name; the default name is kept beside it', () => {
  const m = arrangeMenu(PLACES, { names: { bench: '  Night   shift ' } });
  const b = m.find(x => x.id === 'bench');
  assert.equal(b.label, 'Night shift'); assert.equal(b.defaultLabel, 'Bench'); assert.equal(b.renamed, true);
  assert.equal(m.find(x => x.id === 'chat').renamed, false);
});

test('menus: names are plain text, capped, with no line breaks or control characters; an empty name means the default', () => {
  const c = cleanMenu({ names: { bench: 'Night\nshift\u0007', mail: 'x'.repeat(200), chat: '   ', tasks: 42 } });
  assert.equal(c.names.bench, 'Night shift'); assert.equal(c.names.mail.length, NAME_MAX); assert.ok(!('chat' in c.names)); assert.equal(c.names.tasks, '42');
});

test('menus: the owner\'s order wins; a place he has not placed yet keeps its default turn after his', () => {
  const m = arrangeMenu(PLACES, { order: ['mail', 'chat', 'gone', 'mail'] });
  assert.deepEqual(ids(m), ['mail', 'chat', 'tasks', 'settings', 'bench']);
});

test('menus: hidden places leave the menu, Settings can never be hidden (the way back to these choices)', () => {
  const c = cleanMenu({ hidden: ['bench', 'settings', 'bench'] });
  assert.deepEqual(c.hidden, ['bench']);
  const shown = arrangeMenu(PLACES, { hidden: ['bench', 'settings'] }).filter(x => !x.hidden);
  assert.deepEqual(ids(shown), ['chat', 'tasks', 'settings', 'mail']);
});

test('menus: the place that opens first is the owner\'s choice when it is shown and usable, else Chat', () => {
  assert.equal(firstPlace(PLACES, { first: 'bench' }), 'bench');
  assert.equal(firstPlace(PLACES, { first: 'bench', hidden: ['bench'] }), 'chat', 'a hidden place does not open first');
  assert.equal(firstPlace(PLACES, { first: 'studio' }), 'chat', 'a place that is not there (module off) does not open first');
  assert.equal(firstPlace(PLACES, { first: 'tasks' }, ['tasks']), 'chat', 'a place off for the role does not open first');
  assert.equal(firstPlace([{ id: 'tasks', label: 'Tasks' }], {}), 'tasks', 'with Chat gone, the first shown place');
});

test('menus: moving a place by a button and by a drop', () => {
  const o = ['chat', 'tasks', 'settings', 'bench'];
  assert.deepEqual(movePlace(o, 'bench', -1), ['chat', 'tasks', 'bench', 'settings']);
  assert.deepEqual(movePlace(o, 'chat', -1), o, 'the first cannot go further up');
  assert.deepEqual(movePlace(o, 'bench', 1), o, 'the last cannot go further down');
  assert.deepEqual(movePlace(o, 'bench', { before: 'chat' }), ['bench', 'chat', 'tasks', 'settings']);
  assert.deepEqual(movePlace(o, 'chat', { after: 'bench' }), ['tasks', 'settings', 'bench', 'chat']);
  assert.deepEqual(movePlace(o, 'chat', { before: 'chat' }), o);
  assert.deepEqual(movePlace(o, 'nope', 1), o);
});

test('menus: the choices are kept per desk through the settings route; they change no role, module, level or setting', async () => {
  const t = await testDesk();
  try {
    const before = (await t.call('/api/state')).json;
    const menu = { names: { bench: 'Night shift' }, order: ['tasks', 'chat'], hidden: ['mail'], first: 'tasks', role: 'host', 'security.level': 'open' };
    const r = await t.call('/api/settings', { body: { [MENU_KEY]: cleanMenu(menu) } });
    assert.equal(r.status, 200);
    const st = (await t.call('/api/state')).json;
    assert.deepEqual(st.settings[MENU_KEY], { order: ['tasks', 'chat'], names: { bench: 'Night shift' }, hidden: ['mail'], first: 'tasks' });
    assert.equal(st.settings.role, before.settings.role); assert.equal(st.security.level, before.security.level);
    assert.deepEqual(st.modules.map(m => [m.id, m.on]), before.modules.map(m => [m.id, m.on]));
    // Reset to the default menu
    await t.call('/api/settings', { body: { [MENU_KEY]: null } });
    assert.equal((await t.call('/api/state')).json.settings[MENU_KEY], null);
    // the page can load the rules
    const js = await fetch(t.base + '/ui/menus.js'); assert.equal(js.status, 200);
  } finally { await t.close(); }
});
