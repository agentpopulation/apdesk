// Several people on one PC, on screen (contracts/PEOPLE.md): the chooser (pick who you are, with a PIN), the switcher
// (top-right avatar: switch person, lock the window, and for the keeper add a person and manage people), and the small
// screen under Settings where each person sets their own name, emoji, colour, theme and PIN. The routes are the house's
// own (/api/people...); this file only draws them. No emoji in the desk's own words: a person's emoji is their own data.
import * as kit from '/ui/kit.js';
const { h, api, btn, card, toast } = kit;

// The honest limit of the PIN, said plainly wherever the keeper adds a person (the same point PEOPLE.md makes).
export const PIN_CAUTION = 'A PIN keeps people at this desk apart. It does not protect your files from anyone who can open this PC: they can read every person\'s chats and keys. For real separation, give each person their own Windows account and turn on disk encryption (BitLocker).';

const EMOJIS = ['🙂', '😎', '🦊', '🐱', '🐼', '🦉', '🌻', '🌲', '⭐', '🚀', '🎧', '📚', '🍵', '⚽', '🎨', '🧭', '🐝', '🍋'];
const COLOURS = ['#5b6270', '#0a6cff', '#127a40', '#c98a00', '#c8261c', '#7a4cd6', '#0a8a8a', '#d2382f', '#336699', '#aa5500'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Readable text on a colour, for a person's initials when they have chosen no emoji. */
function onColour(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m) return '#fff';
  const n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#16171a' : '#fff';
}
/** A person's avatar: their chosen emoji on their colour, or their initials. cls: '' | 'big' | 'bar'. */
export function personAvatar(p, cls = '') {
  const emoji = (p.emoji || '').trim();
  const el = h('span', { class: 'pav ' + cls, style: { background: p.colour || '#5b6270' }, 'aria-hidden': 'true' });
  if (emoji) el.textContent = emoji;
  else { el.textContent = String(p.name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); el.style.color = onColour(p.colour); el.classList.add('ini'); }
  return el;
}

function emojiPicker(current) {
  let value = current || '';
  const grid = h('div', { class: 'picks emoji', role: 'radiogroup', 'aria-label': 'Emoji' });
  const paint = () => grid.replaceChildren(...EMOJIS.map(e => h('button', { type: 'button', class: 'pk' + (e === value ? ' on' : ''), 'aria-pressed': String(e === value), onclick: () => { value = e; paint(); } }, e)));
  paint();
  return { el: grid, value: () => value };
}
function colourPicker(current) {
  let value = (current || COLOURS[0]).toLowerCase();
  const grid = h('div', { class: 'picks colour', role: 'radiogroup', 'aria-label': 'Colour' });
  const paint = () => grid.replaceChildren(...COLOURS.map(c => h('button', { type: 'button', class: 'sw-c' + (c === value ? ' on' : ''), style: { background: c }, 'aria-pressed': String(c === value), 'aria-label': 'Colour ' + c, onclick: () => { value = c; paint(); } })));
  paint();
  return { el: grid, value: () => value };
}
/** A PIN field: digits only, 4 to 12, hidden as it is typed. */
function pinField(label) {
  return h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '12', 'aria-label': label, class: 'pinf', oninput: (e) => { e.target.value = e.target.value.replace(/\D/g, ''); } });
}

// ---- the chooser: a full-window screen, like picking a profile on a TV app. No valid token for this window: pick who
// you are (and the PIN if there is one) to open your desk. Also used by the switcher's "Switch person".
export async function showChooser(ui, { mode = 'enter' } = {}) {
  const host = document.getElementById('chooser');
  host.hidden = false; host.dataset.mode = mode;
  let list = [];
  try { list = (await api('people')).people; } catch { list = []; }
  const show = (node) => host.replaceChildren(h('div', { class: 'card' }, node));

  const screenList = () => {
    const grid = h('div', { class: 'people' }, list.map(p => h('button', { class: 'person', onclick: () => choose(p) },
      personAvatar(p, 'big'), h('b', { class: 'pn' }, p.name),
      p.waiting ? h('span', { class: 'sub' }, p.waiting === 1 ? '1 waiting' : `${p.waiting} waiting`) : (p.keeper ? h('span', { class: 'sub' }, 'Keeper') : null))));
    return [h('h2', null, mode === 'switch' ? 'Switch person' : 'Who is at this desk?'),
      h('p', { class: 'sub' }, mode === 'switch' ? 'Pick a person to switch this window to. Everyone else keeps working.' : 'Pick who you are to open your desk.'),
      grid,
      mode === 'switch' ? h('div', { class: 'row', style: { justifyContent: 'center' } }, btn('Cancel', { kind: 'ghost', onClick: close })) : null];
  };

  const screenPin = (p) => {
    const input = pinField('PIN for ' + p.name);
    const err = h('p', { class: 'sub perr', role: 'status' });
    const go = async () => {
      err.textContent = '';
      try { await enter(ui, p, input.value, mode); }
      catch (e) { err.textContent = e.status === 429 ? `Too many wrong tries. Wait ${e.data?.waitSeconds || 0} seconds, then try again.` : 'That PIN is not right.'; input.value = ''; input.focus(); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    show([h('div', { class: 'stack', style: { alignItems: 'center', gap: '12px' } },
      personAvatar(p, 'big'), h('b', null, p.name), h('p', { class: 'sub' }, 'Enter your PIN'), input, err,
      h('div', { class: 'row', style: { justifyContent: 'center' } }, btn('Back', { kind: 'ghost', onClick: () => show(screenList()) }), btn('Open', { onClick: go })))]);
    setTimeout(() => input.focus(), 30);
  };
  const choose = (p) => p.hasPin ? screenPin(p) : enter(ui, p, null, mode).catch(e => toast(e.message, 'err'));
  const close = () => { host.hidden = true; host.replaceChildren(); };
  show(screenList());
}

/** Enter (or, when this window already holds a token, switch) as a person. On success the window keeps the new token and
 *  reloads onto that person's desk; a wrong PIN or a wait throws, for the caller to show. */
async function enter(ui, p, pin, mode) {
  const route = mode === 'switch' && kit.session() ? 'people/switch' : 'people/enter';
  const r = await api(route, { body: { id: p.id, pin } });
  kit.setSession(r.token);
  stashNotice(r.notice);
  location.reload();
}
function stashNotice(n) { try { if (n && (n.wrongTries || n.resetBy)) sessionStorage.setItem('apd-entry-notice', JSON.stringify(n)); } catch {} }
/** Show, once, what a person is told on entry: wrong tries since last time, and who reset their PIN and when. */
export function takeEntryNotice() {
  let n = null;
  try { const s = sessionStorage.getItem('apd-entry-notice'); if (!s) return; sessionStorage.removeItem('apd-entry-notice'); n = JSON.parse(s); } catch { return; }
  const msgs = [];
  if (n.wrongTries) msgs.push(n.wrongTries === 1 ? '1 wrong PIN was tried for you since you were last here.' : `${n.wrongTries} wrong PINs were tried for you since you were last here.`);
  if (n.resetBy) msgs.push(`Your PIN was reset by ${n.resetBy}${n.resetAt ? ' on ' + kit.fmt.when(n.resetAt) : ''}.`);
  if (msgs.length) setTimeout(() => toast(msgs.join(' '), 'err', 9000), 500);
}

// A person's spaces, said plainly for the confirm before Incognito opens. The desk's own words; the house holds the full
// list too (shown in the switcher once you are in Incognito). No internal ids, no model text.
export const INCOGNITO_CAUTIONS = [
  'Incognito saves nothing on this desk: its chats, memory, history and approvals are dropped the moment you leave.',
  'What leaves the desk still happens. A mail you approve is still sent. A site still saw your visit. Money spent is spent.',
  'Spend still counts against your day and month limits, so Incognito cannot get around them.',
  'Your address and website rules, approvals and Panic all still apply.',
];

/** Switch this person between Work and Personal (no PIN: the person is already in). The house hands back a fresh token for
 *  this window; we keep it and reload, so the boot gate opens the chosen space. Same pattern as entering or switching. */
async function switchSpace(ui, which) {
  try { const r = await api('people/me/space', { body: { space: which } }); kit.setSession(r.token); location.reload(); }
  catch (e) { toast(e.message, 'err'); }
}
/** Open Incognito: show what it means first, and only on the person's confirm open it and reload into it. */
function openIncognito(ui) {
  const body = h('div', { class: 'stack', style: { gap: '10px' } },
    h('p', { class: 'sub' }, 'Incognito opens a fresh desk that remembers nothing. Before you go in:'),
    h('ul', { class: 'cautions' }, INCOGNITO_CAUTIONS.map(c => h('li', { class: 'sub' }, c))));
  const open = async () => {
    try { const r = await api('people/incognito', { method: 'POST' }); kit.setSession(r.token); location.reload(); return undefined; }
    catch (e) { toast(e.message, 'err'); return false; }
  };
  kit.modal({ title: 'Open Incognito', body, actions: [{ label: 'Cancel' }, { label: 'Open Incognito', onClick: open }] });
}

/** Under the person in the switcher: the Work/Personal choice and Open Incognito, or, while in Incognito, the plain
 *  reminder of what it means and a way out. */
function spacesSection(ui, me) {
  if (me.incognito) {
    const cautions = (me.cautions && me.cautions.length ? me.cautions : INCOGNITO_CAUTIONS);
    return h('div', { class: 'stack', style: { gap: '8px' } },
      h('b', null, 'You are in Incognito'),
      h('ul', { class: 'cautions' }, cautions.map(c => h('li', { class: 'sub' }, c))),
      btn('Leave Incognito', { kind: 'ghost wide', onClick: () => switchSpace(ui, 'work') }));
  }
  const cur = me.space === 'personal' ? 'personal' : 'work';
  const onlyWork = !(me.spaces || []).includes('personal');
  const seg = kit.seg(['Work', 'Personal'], cur === 'personal' ? 1 : 0, (_o, i) => { const val = i === 1 ? 'personal' : 'work'; if (val !== cur) switchSpace(ui, val); });
  return h('div', { class: 'stack', style: { gap: '6px' } },
    h('span', { class: 'sub' }, 'Your space'),
    seg,
    onlyWork && cur !== 'personal' ? h('span', { class: 'sub' }, 'Personal starts empty: a separate desk just for you.') : null,
    btn('Open Incognito', { kind: 'ghost wide', onClick: () => openIncognito(ui) }));
}

// ---- the switcher: the top-right avatar opens this. Lists the people and the actions.
export async function switcherMenu(ui) {
  let me, list;
  try { const r = await api('people/me'); me = { ...r.person, incognito: !!r.incognito, space: r.space, spaces: r.spaces, cautions: r.cautions }; list = (await api('people')).people; } catch (e) { return toast(e.message, 'err'); }
  const full = (label, onClick, kind = 'ghost') => btn(label, { kind: kind + ' wide', onClick });
  const others = list.filter(p => p.id !== me.id);
  const body = h('div', { class: 'stack', style: { gap: '12px' } },
    h('div', { class: 'row' }, personAvatar(me, 'big'), h('div', null, h('b', null, me.name), h('span', { class: 'sub', style: { display: 'block' } }, me.keeper ? 'Keeper of this PC' : 'At this desk'))),
    spacesSection(ui, me),
    others.length ? h('div', { class: 'row', style: { gap: '6px' } }, others.map(p => h('span', { class: 'who-chip', title: p.name }, personAvatar(p), h('span', { class: 'sub' }, p.name)))) : null,
    h('div', { class: 'stack', style: { gap: '6px' } },
      full('Switch person', () => { ui.closeModal(); ui.openChooser('switch'); }),
      full('Lock this window', () => ui.lockWindow()),
      full('My profile and PIN', () => { ui.closeModal(); ui.go('settings', 'people'); }),
      me.keeper ? full('Add a person', () => addPersonModal(ui)) : null,
      me.keeper ? full('Settings for people', () => { ui.closeModal(); ui.go('settings', 'people'); }) : null));
  kit.modal({ title: 'People', body, actions: [{ label: 'Close' }] });
}

// ---- add a person (keeper only). Name, emoji, colour, a PIN the new person will use, and the plain caution.
export function addPersonModal(ui, onAdded) {
  const name = h('input', { type: 'text', maxlength: '40', 'aria-label': 'Name', placeholder: 'Their name' });
  const emoji = emojiPicker(pick(EMOJIS)), colour = colourPicker(pick(COLOURS));
  const pin = pinField('A PIN for them'), err = h('p', { class: 'sub perr', role: 'status' });
  const body = h('div', { class: 'stack', style: { gap: '12px' } },
    h('label', { class: 'f' }, 'Name', name),
    h('div', null, h('span', { class: 'sub' }, 'Emoji'), emoji.el),
    h('div', null, h('span', { class: 'sub' }, 'Colour'), colour.el),
    h('label', { class: 'f' }, 'Their PIN (4 to 12 digits)', pin),
    h('p', { class: 'sub caution' }, PIN_CAUTION), err);
  const add = async () => {
    err.textContent = '';
    if (!name.value.trim()) { err.textContent = 'Give them a name.'; return false; }
    if (!/^\d{4,12}$/.test(pin.value)) { err.textContent = 'A PIN is 4 to 12 digits.'; return false; }
    try {
      const r = await api('people', { body: { name: name.value.trim(), emoji: emoji.value(), colour: colour.value(), pin: pin.value } });
      toast(`${r.person.name} was added. They open their desk with their PIN.`, 'ok', 6000);
      onAdded?.(r.person);
      return undefined;
    } catch (e) { err.textContent = e.message; return false; }
  };
  kit.modal({ title: 'Add a person', body, actions: [{ label: 'Cancel' }, { label: 'Add', onClick: add }] });
  setTimeout(() => name.focus(), 30);
}

// ---- Settings › People: each person sets their own look and PIN; the keeper also manages the people of this PC.
export async function peopleSettings(el, ui) {
  const { card, line } = ui;
  let me, list;
  try { me = (await api('people/me')).person; } catch { el.append(card(h('p', { class: 'sub' }, 'Choose who you are first.'))); return; }
  try { list = (await api('people')).people; } catch { list = []; }

  // my look: name, emoji, colour, theme
  const look = card(h('h3', null, 'Your profile'));
  const nameIn = h('input', { type: 'text', maxlength: '40', value: me.name, 'aria-label': 'Your name' });
  const emoji = emojiPicker(me.emoji), colour = colourPicker(me.colour);
  const mark = h('span', { class: 'saved', role: 'status', 'aria-live': 'polite' });
  const saveLook = async (extra = {}) => {
    try {
      const r = await api('people/me/look', { body: { name: nameIn.value.trim() || me.name, emoji: emoji.value(), colour: colour.value(), ...extra } });
      me = r.person; mark.textContent = 'Saved'; mark.className = 'saved ok'; clearTimeout(mark._t); mark._t = setTimeout(() => { mark.textContent = ''; }, 2000);
      ui.refreshWho?.();
    } catch (e) { clearTimeout(mark._t); mark.textContent = 'Not saved: ' + e.message; mark.className = 'saved err'; }
  };
  nameIn.onchange = () => saveLook();
  for (const g of [emoji.el, colour.el]) g.addEventListener('click', (e) => { if (e.target.closest('button')) saveLook(); });
  const theme = ui.seg(['White', 'Black'], document.documentElement.dataset.theme === 'dark' ? 1 : 0, (_, i) => { ui.setTheme(i === 1); saveLook({ theme: i === 1 ? 'dark' : 'light' }); });
  look.append(h('div', { class: 'row', style: { gap: '14px', alignItems: 'center' } }, personAvatar(me, 'big'), h('div', { class: 'stack', style: { gap: '4px', flex: '1', minWidth: '0' } }, h('span', { class: 'sub' }, 'Name'), nameIn)),
    h('div', null, h('span', { class: 'sub' }, 'Emoji'), emoji.el),
    h('div', null, h('span', { class: 'sub' }, 'Colour'), colour.el),
    line('Theme', 'White or black, just for you', theme),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), mark));
  el.append(look);

  // my PIN: set, or change with the old one
  el.append(myPinCard(ui, me));

  // the keeper manages the people of this PC
  if (me.keeper) el.append(await keeperPeopleCard(ui, me, list));
}

function myPinCard(ui, me) {
  const { card } = ui;
  const box = card(h('h3', null, 'Your PIN'));
  const current = me.hasPin ? pinField('Your current PIN') : null;
  const next = pinField('A new PIN'), err = h('p', { class: 'sub perr', role: 'status' });
  const save = async () => {
    err.textContent = '';
    if (!/^\d{4,12}$/.test(next.value)) { err.textContent = 'A PIN is 4 to 12 digits.'; return; }
    try {
      await api('people/me/pin', { body: { current: current ? current.value : undefined, pin: next.value } });
      toast(me.hasPin ? 'Your PIN was changed.' : 'Your PIN was set.', 'ok');
      me.hasPin = true; ui.refreshWho?.(); ui.render();
    } catch (e) { err.textContent = e.status === 429 ? 'Too many wrong tries. Try again in a moment.' : (me.hasPin ? 'That current PIN is not right.' : e.message); }
  };
  box.append(h('p', { class: 'sub' }, me.hasPin ? 'Change your PIN. It keeps your desk to yourself.' : 'Set a PIN so only you open your desk. Without one, your desk opens straight away.'),
    me.hasPin ? h('label', { class: 'f' }, 'Current PIN', current) : '',   // DOM append writes null as the word "null"
    h('label', { class: 'f' }, me.hasPin ? 'New PIN' : 'PIN', next), err,
    h('div', { class: 'row' }, h('span', { class: 'grow' }), btn(me.hasPin ? 'Change PIN' : 'Set PIN', { onClick: save })));
  return box;
}

async function keeperPeopleCard(ui, me, list) {
  const { card, line } = ui;
  const box = card(h('h3', null, 'People on this PC'));
  const rows = h('div');
  const paint = async () => {
    let people; try { people = (await api('people')).people; } catch { people = list; }
    rows.replaceChildren(...people.map(p => line(p.name, p.keeper ? 'Keeper of this PC' : (p.hasPin ? 'Has a PIN' : 'No PIN yet'),
      personAvatar(p),
      p.keeper ? null : btn('Reset PIN', { kind: 'ghost sm', onClick: () => resetPinModal(ui, p, paint) }),
      p.keeper ? null : btn('Remove', { kind: 'ghost sm', onClick: () => removeModal(ui, p, paint) }))));
  };
  box.append(h('p', { class: 'sub caution' }, PIN_CAUTION), rows,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'grow' }),
      me.hasPin ? btn('Add a person', { onClick: () => addPersonModal(ui, paint) })
        : h('span', { class: 'sub' }, 'Set your own PIN above before you add people.')));
  await paint();
  return box;
}

/** Each keeper action asks the keeper's own PIN, with the plain wording the routes return. */
function keeperPinModal(ui, { title, body: extra, confirm, confirmLabel, onDone }) {
  const pin = pinField('Your PIN'), err = h('p', { class: 'sub perr', role: 'status' });
  const body = h('div', { class: 'stack', style: { gap: '10px' } }, extra, h('label', { class: 'f' }, 'Your keeper PIN', pin), err);
  const run = async () => {
    err.textContent = '';
    try { const r = await confirm(pin.value); onDone?.(r); return undefined; }
    catch (e) { err.textContent = e.status === 429 ? 'Too many wrong tries. Try again in a moment.' : (e.status === 403 ? 'That PIN is not right.' : e.message); return false; }
  };
  kit.modal({ title, body, actions: [{ label: 'Cancel' }, { label: confirmLabel, onClick: run }] });
  setTimeout(() => pin.focus(), 30);
}
function removeModal(ui, p, after) {
  keeperPinModal(ui, {
    title: `Remove ${p.name}`, confirmLabel: 'Remove',
    body: h('p', { class: 'sub' }, `${p.name} leaves this desk. Their folder is not deleted; the answer tells you where it is.`),
    confirm: async (pin) => { const r = await api(`people/${p.id}/remove`, { body: { pin } }); toast(r.message || `${p.name} was removed.`, 'ok', 7000); return r; },
    onDone: after,
  });
}
function resetPinModal(ui, p, after) {
  const next = pinField('A new PIN for them');
  keeperPinModal(ui, {
    title: `Reset ${p.name}'s PIN`, confirmLabel: 'Reset PIN',
    body: h('div', { class: 'stack', style: { gap: '8px' } }, h('p', { class: 'sub' }, `${p.name} is told who reset it and when, the next time they open their desk.`), h('label', { class: 'f' }, 'New PIN for them', next)),
    confirm: async (pin) => { if (!/^\d{4,12}$/.test(next.value)) throw Object.assign(new Error('A new PIN is 4 to 12 digits.'), { status: 400 }); await api(`people/${p.id}/reset-pin`, { body: { pin, newPin: next.value } }); toast(`${p.name}'s PIN was reset.`, 'ok'); },
    onDone: after,
  });
}
