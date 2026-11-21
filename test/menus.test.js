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

// ---- the owner's name for a place, for the tab title and for module texts (ui.placeName), and the menu's whole places
import { placeName, tabTitle, cutPlaces } from '../app/ui/menus.js';

test('menus: a place\'s name is the owner\'s name, else its default; a hidden place keeps its name; an unknown place has none', () => {
  const raw = { names: { bench: 'Night shift' }, hidden: ['mail'] };
  assert.equal(placeName(PLACES, raw, 'bench'), 'Night shift');
  assert.equal(placeName(PLACES, raw, 'chat'), 'Chat');
  assert.equal(placeName(PLACES, raw, 'mail'), 'Mail', 'hidden from the menu, its address still opens it by this name');
  assert.equal(placeName(PLACES, raw, 'studio'), null);
  assert.equal(placeName(PLACES, null, 'bench'), 'Bench');
});

test('menus: the tab title is "<place> · <desk name>", the desk name alone when there is no place', () => {
  assert.equal(tabTitle('Night shift', 'AP Desk'), 'Night shift · AP Desk');
  assert.equal(tabTitle(null, 'My desk'), 'My desk');
  assert.equal(tabTitle('', 'My desk'), 'My desk');
});

test('menus: a place only partly inside the menu\'s clear area is marked, so no half word is ever shown', () => {
  const view = { l: 40, r: 300 };
  const boxes = [{ l: 10, r: 60 }, { l: 60, r: 120 }, { l: 120, r: 300 }, { l: 300, r: 360 }, { l: 280, r: 320 }, { l: 400, r: 460 }, { l: -80, r: -20 }];
  assert.deepEqual(cutPlaces(boxes, view), [0, 4], 'wholly in view or wholly out of it is fine; across an edge is cut');
  assert.deepEqual(cutPlaces([{ l: 39.6, r: 300.4 }], view), [], 'a part of a pixel is not a cut');
  const box = { l: 14, r: 326 };   // the fades: 26 px on each side
  assert.deepEqual(cutPlaces([{ l: 0, r: 30 }, { l: 310, r: 380 }, { l: 330, r: 390 }, { l: -60, r: 10 }], view, box), [0, 1], 'a place under a fade is cut too');
});

import fs from 'node:fs';
import { menuEnds } from '../app/ui/menus.js';

test('settings: a renamed menu place shows the owner\'s new name in the Settings side list, not the old one', () => {
  // a module's settings section is titled through the shell's owner-name helper, so renaming the place (Bench -> "Night
  // shift" in Settings › Menu) renames its Settings section too; without the owner's name it falls back to the module's label.
  const settings = fs.readFileSync(new URL('../app/ui/pages/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /title: ui\.label\(s\.id, s\.label \|\| mod\.settings\[s\.id\]\.title\)/, 'the section title uses ui.label(id, fallback)');
  assert.doesNotMatch(settings, /title: s\.label \|\| mod\.settings\[s\.id\]\.title,/, 'the old title, which kept the stale name, is gone');
  // the helper returns the owner's own menu name first (from ui.menu names), else the fallback
  const shell = fs.readFileSync(new URL('../app/ui/shell.js', import.meta.url), 'utf8');
  assert.match(shell, /label: \(page, fallback\) => ownName\(page\) \|\| roleLabel\(page, fallback\)/);
  assert.match(shell, /const ownName = \(page\) => cleanMenu\(state\.settings\[MENU_KEY\]\)\.names\[page\] \|\| null/);
  // and the owner's name really is what the menu rules return for a renamed place
  assert.equal(cleanMenu({ names: { bench: 'Night shift' } }).names.bench, 'Night shift');
});

test('menus: an end that hides places shows a "more places" sign there; a menu that fits shows none', () => {
  assert.deepEqual(menuEnds({ scrollLeft: 0, clientWidth: 600, scrollWidth: 600 }), { l: false, r: false }, 'it fits');
  assert.deepEqual(menuEnds({ scrollLeft: 0, clientWidth: 600, scrollWidth: 1200 }), { l: false, r: true }, 'at the start');
  assert.deepEqual(menuEnds({ scrollLeft: 300, clientWidth: 600, scrollWidth: 1200 }), { l: true, r: true }, 'in the middle');
  assert.deepEqual(menuEnds({ scrollLeft: 600, clientWidth: 600, scrollWidth: 1200 }), { l: true, r: false }, 'at the end');
  // a hidden place leaves no blank gap without a sign: the menu draws an arrow at each end that hides places
  const js = fs.readFileSync(new URL('../app/ui/shell.js', import.meta.url), 'utf8'), css = fs.readFileSync(new URL('../app/ui/shell.css', import.meta.url), 'utf8');
  assert.match(js, /menuEnds\(/, 'the shell asks menuEnds which ends hide places');
  assert.match(js, /'aria-label': 'More places'/, 'the sign is a button named for what it does');
  assert.match(css, /\.menu\.over\.fl \.more\.l,\.menu\.over\.fr \.more\.r\{visibility:visible\}/, 'shown only at an end that hides places');
  assert.doesNotMatch(css, /\.menu\.over\{[^}]*mask-image/, 'no fade that would hide the sign');
});
