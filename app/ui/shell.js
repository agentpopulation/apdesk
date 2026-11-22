// The shell: top bar, the official menu, theme, Panic, approvals, Home, onboarding, Settings frame, module pages.
import * as kit from '/ui/kit.js';
import { homePage, ROLES, applyRole, teamFor, STARTING_TEAM } from '/ui/pages/home.js';
import { settingsPage, coreSettingsSections, ABOUT_MAX, ABOUT_HELP } from '/ui/pages/settings.js';
import { trackerPage, trackerBody } from '/ui/pages/tracker.js';
import { MENU_KEY, cleanMenu, arrangeMenu, firstPlace, placeName, tabTitle, cutPlaces, menuEnds } from '/ui/menus.js';
import { mergeJob, runningCount, needsYou, updateReady, leftWords, popShowsDownloads, whoAsks, jobWho } from '/ui/tracker-data.js';
import { showChooser, switcherMenu, personAvatar, takeEntryNotice } from '/ui/people.js';
const { $, $$, h, api, toast } = kit;

const OFFICIAL = [['chat', 'Chat'], ['research', 'Research'], ['tasks', 'Tasks'], ['sales', 'Sales'], ['files', 'Files'], ['agents', 'Agents'], ['models', 'Models'], ['settings', 'Settings']];
const state = { settings: {}, security: {}, panic: { halted: false }, modules: [], agents: [], jobs: {}, pendingApprovals: [], stoppedApprovals: [], route: { page: 'chat', parts: [], params: {} }, me: null, people: [], multi: false };
const listeners = new Map();          // event type -> Set(fn)
let pageCleanup = [];                 // unsubscribe + unmount for the page on screen
const loaded = new Map();             // module id -> ui.js exports

const ui = {
  ...kit, state,
  go(page, ...parts) { location.hash = '#/' + [page, ...parts.filter(x => x != null && x !== '')].map(encodeURIComponent).join('/'); },
  /** Listen to a server event while this page is on screen. Any type the server emits: job, approval, chat, panic, modules, agents, settings, security, models, toast, and whatever a module emits with ctx.events.emit. */
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); const off = () => listeners.get(type)?.delete(fn); pageCleanup.push(off); return off; },
  /** Run when the page leaves the screen (timers, streams). */
  onLeave(fn) { pageCleanup.push(fn); },
  moduleOn: (id) => state.modules.some(m => m.id === id && m.on),
  agent: (id) => state.agents.find(a => a.id === id) || null,
  whoAsks: (a) => whoAsks(state.agents, a),
  label: (page, fallback) => ownName(page) || roleLabel(page, fallback),
  /** The owner's name for a menu place (his own name, else the default), for a module's own texts; null when it is not a place. */
  placeName: (id) => placeName(basePlaces(), state.settings[MENU_KEY], id),
  /** Every menu place in the default order with its default name (Settings › Menu lists these). */
  menuPlaces: () => basePlaces(),
  /** Keep the owner's menu (names, order, hidden, first place) for this desk; null is the default menu. */
  async saveMenu(menu) { const r = await api('settings', { body: { [MENU_KEY]: menu == null ? null : cleanMenu(menu) } }); state.settings[MENU_KEY] = r.settings[MENU_KEY] ?? null; paintMenu(); return state.settings[MENU_KEY]; },
  refresh: () => refresh(),
  render: () => render(),
  async setLevel(level) { state.security = await api('settings/security', { body: { level } }); paintChrome(); return state.security; },
  async setAutoApprove(window) { state.security = await api('settings/auto-approve', { body: { window } }); paintChrome(); return state.security; },
  async setOnline(online) { await api('settings', { body: { online } }); state.settings.online = online; emitLocal('settings', { online }); return online; },
  async decide(id, decision) { const r = await api(`approvals/${id}/${decision}`, { method: 'POST' }); await refreshApprovals(); return r; },
  openApprovals: () => showApprovals(true),
  /** Approvals Panic cancelled, until the owner dismisses them (fresh from the desk), and the section that lists them. */
  refreshStopped: () => refreshStopped(), stoppedSection: () => stoppedSection(),
  /** Open a workspace file in Files (the folder opens with the file selected). The one link format for file cards. */
  openFile(path) { location.hash = '#/files?path=' + encodeURIComponent(String(path || '')); },
  panic: () => panic(true),
  // People (contracts/PEOPLE.md): the chooser, the switcher, locking and the per-window token.
  openChooser: (mode) => showChooser(ui, { mode }),
  closeModal() { const m = document.getElementById('modal'); if (m && typeof m._close === 'function') m._close(undefined); },
  async lockWindow() { try { await api('people/leave', { method: 'POST' }); } catch {} kit.setSession(''); location.reload(); },
  switcher: () => switcherMenu(ui),
  refreshWho: () => refreshWho(),
};
// Every page's calls go through here; the Doctor page's check result is kept, so the top bar's Doctor icon can show a
// mark when the last check found a problem (the Doctor module itself is not changed for it).
ui.api = async (path, opts) => { const r = await api(path, opts); if (/^\/?(api\/)?m\/doctor\/check(\?|$)/.test(String(path))) doctorSeen(r); return r; };
window.apd = ui;       // for the console and for acceptance checks

function emitLocal(type, data) { for (const fn of listeners.get(type) || []) { try { fn(data); } catch (e) { console.error(e); } } }
const globalOn = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };

// ---------- role labels and menu
const role = () => state.settings.role ? ROLES[state.settings.role] : null;
const roleLabel = (page, fallback) => role()?.labels?.[page] || fallback;
// Places that live in the top bar as an icon, not in the menu (their page still opens by its address)
const IN_BAR = new Set(['doctor']);
function basePlaces() {
  const extra = [];
  for (const m of state.modules) if (m.on) for (const it of m.menu || []) if (!OFFICIAL.some(o => o[0] === it.id) && !IN_BAR.has(it.id)) extra.push({ ...it, module: m.id });
  extra.sort((a, b) => (a.order || 100) - (b.order || 100));
  return [...OFFICIAL.map(([id, label]) => ({ id, label: roleLabel(id, label), official: true })), ...extra];
}
// the owner's menu (Settings › Menu): his names and order; a hidden place leaves the menu but its address still opens it
const menuItems = () => arrangeMenu(basePlaces(), state.settings[MENU_KEY]).filter(x => !x.hidden);
const ownName = (page) => cleanMenu(state.settings[MENU_KEY]).names[page] || null;
const openingPlace = () => firstPlace(basePlaces(), state.settings[MENU_KEY], role()?.off || []);
// ---------- a job finished: a notice that stays a while, a count on the menu place, a desktop notification
const badges = new Map();          // menu place -> finished jobs not yet looked at
const toldJobs = new Set();
const placeOf = (kind) => { const k = String(kind || ''); return k.startsWith('research') ? 'research' : (k.startsWith('sales') || k.startsWith('leads')) ? 'sales' : 'tasks'; };
function jobFinished(j) {
  if (!j || !['done', 'failed'].includes(j.status) || toldJobs.has(j.id + j.status)) return;
  if (j.quiet && j.status === 'done') return;   // the desk's own upkeep: listed under Housekeeping in Tasks, told only when it fails
  toldJobs.add(j.id + j.status);
  if (state.settings.notifications === false) return;
  const ok = j.status === 'done'; const text = `${ok ? 'Finished' : 'Failed'}: ${j.title || 'a job'}`;
  toast(text, ok ? 'ok' : 'err', 9000);
  const place = placeOf(j.kind);
  if (state.route.page !== place || document.hidden) { badges.set(place, (badges.get(place) || 0) + 1); paintMenu(); }
  if (document.hidden) {
    const n = [...badges.values()].reduce((a, b) => a + b, 0); document.title = `(${n}) ${titleNow()}`;
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification(appName(), { body: text, tag: j.id }); } catch {}
  }
}
// a job went to waiting: in a background window, once per job, a desktop notification says it needs the owner
const toldWaiting = new Set();
function jobNeedsYou(j) {
  if (!needsYou(j, toldWaiting) || state.settings.notifications === false || !document.hidden) return;
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(appName(), { body: `Needs you: ${j.title || 'a job'}`, tag: j.id + '-waiting' }); } catch {}
}
const appName = () => String(state.settings.appName || '').trim() || 'AP Desk';
// the tab says where the owner is, by his own name for the place: "<place> · <desk name>"
const PAGE_WORDS = { home: 'Home', tracker: 'Tracker' };
const titleNow = () => { const pg = state.route.page; return tabTitle(placeName(basePlaces(), state.settings[MENU_KEY], pg) || PAGE_WORDS[pg] || ownerOf(pg)?.name || null, appName()); };
const paintTitle = () => { if (!document.hidden && document.title !== titleNow()) document.title = titleNow(); };
document.addEventListener('visibilitychange', paintTitle);
function paintMenu() {
  const off = role()?.off || [];
  // at each end that hides places an arrow says so and moves the menu by a view (shown by menuEdges)
  const more = (side) => h('button', { class: 'more ' + side, tabindex: '-1', 'aria-label': 'More places', title: 'More places', onclick: () => { const m = $('#menu'); m.scrollBy({ left: (side === 'l' ? -1 : 1) * Math.max(60, m.clientWidth - 2 * MENU_FADE), behavior: 'smooth' }); } }, side === 'l' ? '\u2039' : '\u203a');
  $('#menu').replaceChildren(more('l'), ...menuItems().map(it => h('button', { class: 'nav', 'data-v': it.id, 'aria-current': it.id === state.route.page ? 'page' : null, disabled: off.includes(it.id), title: off.includes(it.id) ? 'Off for this role. Switch it on in Settings.' : null, onclick: () => ui.go(it.id) }, it.label, badges.get(it.id) ? h('span', { class: 'badge', title: 'Finished since you last looked' }, String(badges.get(it.id))) : null)), more('r'));
  fitMenu();
  paintTitle();
}
// ---------- small top bar icons: thin outlines in the text colour (the theme and download icons stay dull until hovered)
const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;
const ICON = {
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
  moon: svg('<path d="M20 14.6A8.2 8.2 0 1 1 9.4 4a6.6 6.6 0 0 0 10.6 10.6z"/>'),
  down: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>'),
  track: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M3.8 6.4l1.2 1.2 2.2-2.4M3.8 11.9l1.2 1.2 2.2-2.4"/><circle cx="5.2" cy="17.5" r="1.3"/>'),
  upd: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 16.5v-8M8.5 11.5 12 8l3.5 3.5"/>'),
  doc: svg('<path d="M3 12h4l2-4.5 3.5 9 2.5-6 1.5 1.5H21"/><rect x="2.5" y="3.5" width="19" height="17" rx="4"/>'),
  wifi: (cut) => svg('<path d="M2.5 9.2a14 14 0 0 1 19 0M5.6 12.6a9.4 9.4 0 0 1 12.8 0M8.7 16a5 5 0 0 1 6.6 0"/><circle cx="12" cy="19.3" r=".9" fill="currentColor"/>', cut ? '<path d="M4 3.5 20 20.5"/>' : ''),
};
function paintTheme() {
  // the icon shows what a press switches to: a sun while the black theme is on, a moon while the white theme is on
  const dark = document.documentElement.dataset.theme === 'dark', b = $('#theme');
  const name = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
  if (b.dataset.icon !== (dark ? 'sun' : 'moon')) { b.innerHTML = dark ? ICON.sun : ICON.moon; b.dataset.icon = dark ? 'sun' : 'moon'; }
  b.setAttribute('aria-label', name); b.title = name;
}
function paintChrome() {
  paintTheme(); paintDownloads(); paintNet(); paintTracker(); paintUpdate(); paintDoctor(); paintFoot();
  const nameEl = document.querySelector('.bar .name'); if (nameEl && nameEl.textContent !== appName()) nameEl.textContent = appName();
  const halted = !!state.panic.halted;
  document.body.classList.toggle('halted', halted);
  $('#halt').hidden = !halted; $('#panic').textContent = halted ? 'Stopped' : 'Panic';
  const n = state.pendingApprovals.length, st = state.stoppedApprovals.length;
  $('#waiting').hidden = n === 0 && st === 0;
  // at phone width only the number shows (the words are in the button's name), so the bar keeps room for its icons
  const words = n ? `${n} waiting for you` : `Stopped by Panic: ${st}`;
  if ($('#waiting').getAttribute('aria-label') !== words) { $('#waiting').replaceChildren(...(n ? [String(n), h('span', { class: 'wl' }, ' waiting for you')] : [h('span', { class: 'wl' }, 'Stopped by Panic: '), String(st)])); $('#waiting').setAttribute('aria-label', words); }
  paintMenu();
}
// Dark is the main theme and what a fresh desk opens in. The owner's own choice (the sun or moon, Settings › Appearance)
// is kept and marked as his ('ui.themeChosen'), so the stored default ('light') of a desk set up before is not taken for one.
const themeOf = (settings, mine) => (settings?.['ui.themeChosen'] || mine === 'dark') && (mine === 'light' || mine === 'dark') ? mine : 'dark';
function applyTheme(th) { if (th !== document.documentElement.dataset.theme) document.documentElement.dataset.theme = th; try { localStorage.setItem('apd-theme', th); } catch {} }
// before anything is drawn: a browser that has no theme kept yet opens dark (boot.js gives it light)
try { if (!localStorage.getItem('apd-theme')) applyTheme('dark'); } catch { document.documentElement.dataset.theme = 'dark'; }
async function setTheme(dark) {
  applyTheme(dark ? 'dark' : 'light');
  state.settings.theme = dark ? 'dark' : 'light'; state.settings['ui.themeChosen'] = true; paintChrome();
  api('settings', { body: { theme: state.settings.theme, 'ui.themeChosen': true } }).catch(() => {});
}
ui.setTheme = setTheme;

// ---------- the switcher: a small avatar at the top right, shown only when the desk has more than one person or anyone
// has a PIN (with one person and no PIN the desk is "open" and no avatar shows, exactly as before).
async function refreshWho() {
  try { const r = await api('people'); state.people = r.people; } catch { state.people = []; }
  state.multi = state.people.length > 1 || state.people.some(p => p.hasPin);
  try { const r = await api('people/me'); state.me = r.person ? { ...r.person, incognito: !!r.incognito, space: r.space } : null; } catch { state.me = null; }
  paintWho();
}
function paintWho() {
  paintIncognito();
  const b = $('#who'); if (!b) return;
  const show = !!(state.multi && state.me);
  b.hidden = !show;
  if (!show) return;
  b.replaceChildren(personAvatar(state.me, 'bar'));
  const name = `${state.me.name}${state.me.keeper ? ', keeper of this PC' : ''}. Switch person, lock the window`;
  b.setAttribute('aria-label', name); b.title = name;
}
// An Incognito window wears a plain mark in the top bar: nothing is saved here. Shown only while this window is in
// Incognito; removed the moment it leaves. The desk's own words, no emoji.
function paintIncognito() {
  const on = !!(state.me && state.me.incognito);
  let pill = document.getElementById('incog');
  if (!on) { if (pill) pill.hidden = true; return; }
  if (!pill) {
    pill = h('span', { class: 'incog', id: 'incog', role: 'status' }, 'Incognito', h('span', { class: 'tail' }, ' — nothing is saved'));
    $('.bar > div:first-child')?.append(pill);
  }
  pill.hidden = false;
  const name = 'You are in Incognito. Nothing is saved on this desk.';
  pill.setAttribute('aria-label', name); pill.title = name;
}
$('#who').onclick = () => switcherMenu(ui);

// ---------- Panic: one button, every screen
async function panic(on) {
  try { state.panic = on ? await api('panic', { body: { reason: 'Panic button' } }) : await api('panic/resume', { method: 'POST' }); }
  catch (e) { toast(e.message, 'err'); }
  paintChrome(); emitLocal('panic', state.panic);
}
$('#panic').onclick = () => panic(!state.panic.halted);
$('#resume').onclick = () => panic(false);
$('#theme').onclick = () => setTheme(document.documentElement.dataset.theme !== 'dark');
$('#home').onclick = () => ui.go('home');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.shiftKey) panic(true); });

// ---------- approvals: the badge, the list, the decision
async function refreshApprovals() { const r = await api('approvals'); state.pendingApprovals = r.pending; await refreshStopped(); paintChrome(); if (popKind() === 'approvals') paintPop(); }
// ---------- approvals Panic cancelled: listed until the owner dismisses them. They cannot be approved: the work was stopped.
async function refreshStopped() {
  try { state.stoppedApprovals = ui.moduleOn('safety') ? (await api('m/safety/stopped')).items : []; } catch { state.stoppedApprovals = []; }
  return state.stoppedApprovals;
}
async function dismissStopped(body) { try { await api('m/safety/stopped/dismiss', { body }); } catch (e) { toast(e.message, 'err'); } await refreshApprovals().catch(() => {}); }
function stoppedSection() {
  const list = state.stoppedApprovals; if (!list.length) return null;
  const one = list.length === 1;
  return h('div', { class: 'card', 'data-apd': 'stopped', style: { marginBottom: '8px' } },
    h('div', { class: 'row' }, h('h3', null, 'Stopped by Panic'), h('span', { class: 'grow' }), one ? null : kit.btn('Dismiss all', { kind: 'ghost sm', onClick: () => dismissStopped({ all: true }) })),
    h('p', { class: 'sub' }, one ? 'This was waiting for you when you pressed Panic. It was cancelled. Ask again if you still want it.' : 'These were waiting for you when you pressed Panic. They were cancelled. Ask again if you still want them.'),
    ...list.map(a => kit.line(a.title, `${jobWho(state.agents, a)} · ${ACTION_WORDS[a.action] || a.action} · stopped ${kit.fmt.when(a.decided)}`,
      kit.btn('Dismiss', { kind: 'ghost sm', onClick: () => dismissStopped({ id: a.id }) }))));
}
function approvalCard(a) {
  // Everything the approval covers is shown, in full: long text scrolls inside its box, nothing is cut or left out.
  const rows = []; const walk = (obj, prefix) => { for (const [k, v] of Object.entries(obj || {})) { if (v == null) continue; if (typeof v === 'object') walk(v, prefix + k + '.'); else rows.push([prefix + k, String(v)]); } };
  if (a.payload && typeof a.payload === 'object') walk(a.payload, ''); else if (a.payload != null) rows.push(['', String(a.payload)]);
  const total = rows.reduce((n, r) => n + r[1].length, 0);
  const body = rows.length ? h('div', { class: 'draft', style: { marginTop: '8px', maxHeight: '260px', overflow: 'auto' } },
    rows.map(([k, v]) => h('div', { style: { marginBottom: '6px' } }, k ? h('span', { class: 'sub', style: { display: 'block' } }, k + (v.length > 400 ? ` (${v.length} characters)` : '')) : null, h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: /code|command|script|body|text|content/i.test(k) && v.length > 120 ? 'var(--mono)' : null, fontSize: v.length > 600 ? '12.5px' : null } }, v)))) : null;
  return h('div', { class: 'card', style: { marginBottom: '8px' } },
    h('div', { class: 'row' }, h('b', null, a.title), kit.pill(ACTION_WORDS[a.action] || a.action, 'wait')),
    h('div', { class: 'sub' }, `${whoAsks(state.agents, a)}${a.detail ? ' · ' + a.detail : ''}${a.amount ? ' · ' + kit.fmt.money(a.amount, a.currency) : ''}`),
    body, total > 1500 ? h('div', { class: 'sub', style: { marginTop: '4px' } }, `Scroll to read all of it: ${total} characters. What you approve is exactly this.`) : null,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'grow' }),
      kit.btn('Deny', { kind: 'ghost sm', onClick: () => ui.decide(a.id, 'deny').catch(e => toast(e.message, 'err')) }),
      kit.btn(a.action === 'send.person' ? 'Approve and send' : 'Approve', { kind: 'sm', onClick: () => ui.decide(a.id, 'approve').catch(e => toast(e.message, 'err')) })));
}
const ACTION_WORDS = { 'file.write': 'Write a file', 'file.delete': 'Delete a file', 'file.read.outside': 'Open a folder', 'shell.run': 'Run a command', 'browser.open': 'Open a site', 'browser.act': 'Act in the browser', 'net.post': 'Send data', 'send.person': 'Send to a person', spend: 'Spend money', 'module.toggle': 'Switch a module', install: 'Install', login: 'Sign in', 'calendar.write': 'Change the calendar', custom: 'Action' };
ui.approvalCard = approvalCard; ui.ACTION_WORDS = ACTION_WORDS;
// ---------- one pop-up under the top bar: what waits for the owner, the downloads, or the network
const POP_BUTTON = { approvals: 'waiting', downloads: 'dl', network: 'net', tracker: 'trk' };
const popKind = () => $('#pop').hidden ? null : $('#pop').dataset.kind;
function showPop(kind, open) {
  const pop = $('#pop');
  if (!open) { if (kind && popKind() !== kind) return; const was = popKind(); pop.hidden = true; delete pop.dataset.kind; paintExpanded(); return was; }
  pop.dataset.kind = kind; pop.hidden = false; paintPop(); paintExpanded();
}
function paintExpanded() { for (const [k, id] of Object.entries(POP_BUTTON)) { const b = document.getElementById(id); if (b) { b.setAttribute('aria-expanded', String(popKind() === k)); b.setAttribute('aria-controls', 'pop'); } } }
const popHead = (title, kind) => h('div', { class: 'row', style: { marginBottom: '8px' } }, h('h3', null, title), h('span', { class: 'grow' }), kit.btn('Close', { kind: 'ghost sm', onClick: () => closePop(kind) }));
function closePop(kind) { const was = showPop(kind, false); if (was && POP_BUTTON[was]) document.getElementById(POP_BUTTON[was])?.focus({ preventScroll: true }); }
function paintPop() {
  const pop = $('#pop'), kind = pop.dataset.kind;
  // redrawn on every live update: a focused button inside keeps the focus (same row, same words)
  const f = pop.contains(document.activeElement) ? document.activeElement : null;
  const rowOf = (x) => { const r = x.closest('[data-dl],[data-job]'); return r ? (r.dataset.dl || 'job:' + r.dataset.job) : ''; };
  const key = f ? [rowOf(f), f.textContent] : null;
  drawPop(pop, kind);
  if (key) { const n = [...pop.querySelectorAll('button')].find(x => rowOf(x) === key[0] && x.textContent === key[1]); (n || pop.querySelector('button'))?.focus({ preventScroll: true }); }
}
function drawPop(pop, kind) {
  if (kind === 'approvals') pop.replaceChildren(popHead('Waiting for you', kind), ...(state.pendingApprovals.length ? state.pendingApprovals.map(approvalCard) : [kit.empty('Nothing is waiting.')]), stoppedSection());
  else if (kind === 'downloads') pop.replaceChildren(popHead('Downloads', kind), ...downloadRows());
  else if (kind === 'network') pop.replaceChildren(popHead('Network', kind), ...netRows());
  else if (kind === 'tracker') pop.replaceChildren(popHead('Tracker', kind), ...trackerBody(ui));
}
function showApprovals(open) { if (open) showPop('approvals', true); else showPop('approvals', false); }
const togglePop = (kind) => popKind() === kind ? closePop(kind) : showPop(kind, true);
$('#waiting').onclick = () => togglePop('approvals');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.shiftKey && popKind() && document.getElementById('modal')?.hidden !== false) closePop(); });
// a press anywhere else closes the downloads and network pop-ups (the approvals list stays until Close)
document.addEventListener('pointerdown', (e) => { const k = popKind(); if (k === 'downloads' || k === 'network' || k === 'tracker') { if (!e.target.closest?.('#pop, #dl, #net, #trk')) showPop(k, false); } }, true);

// ---------- downloads in the top bar: shown while any is not finished, live from the desk's 'downloads' events
const dls = { list: [], summary: { active: 0, total: 0 }, told: new Set(), loaded: false };
const OPEN_DL = new Set(['waiting', 'queued', 'running', 'paused']);
function dlWords(d) {
  if (d.state === 'paused') return /panic/i.test(d.reason || '') ? 'Paused by Panic' : /offline|internet/i.test(d.reason || '') ? 'Waiting for the internet' : 'Paused';
  return { waiting: 'Waiting for you to approve', queued: 'Waiting to start', running: 'Downloading', done: 'Done', failed: 'Did not finish', cancelled: 'Cancelled' }[d.state] || d.state;
}
async function loadDownloads() {
  try {
    const r = await api('downloads'); dls.list = r.downloads || []; dls.summary = r.summary || dls.summary;
    if (!dls.loaded) { for (const d of dls.list) if (!OPEN_DL.has(d.state)) dls.told.add(d.id); dls.loaded = true; }
  } catch {}
  paintDownloads();
}
function paintDownloads() {
  const b = $('#dl'); if (!b) return;
  const { active = 0, total = 0 } = dls.summary || {};
  b.hidden = total === 0;
  if (b.hidden) { if (popShowsDownloads(popKind())) paintPop(); return; }
  const text = `${active} of ${total}`;
  if (b.dataset.text !== text) { b.innerHTML = ICON.down; b.append(h('span', null, text)); b.dataset.text = text; }
  const name = `Downloads: ${active} of ${total} moving. Show the list`;
  b.setAttribute('aria-label', name); b.title = name;
  if (popShowsDownloads(popKind())) paintPop();
}
function downloadRows() {
  const recent = (d) => d.finished && Date.now() - new Date(d.finished).getTime() < 15 * 60000;
  const list = dls.list.filter(d => OPEN_DL.has(d.state) || recent(d));
  if (!list.length) return [kit.empty('Nothing is downloading.')];
  const act = (d, what) => api(`downloads/${encodeURIComponent(d.id)}/${what}`, { method: 'POST' }).then(loadDownloads).catch(e => toast(e.message, 'err'));
  return list.map(d => {
    const open = OPEN_DL.has(d.state), p = d.total ? d.done / d.total : 0;
    const bits = [`${d.doneText} of ${d.totalText}`]; if (d.state === 'running' && d.speedText) bits.push(d.speedText); if (d.state === 'running' && d.secondsLeft != null) bits.push(leftWords(d.secondsLeft));
    return h('div', { class: 'card dlrow', 'data-dl': d.id, style: { marginBottom: '8px' } },
      h('div', { class: 'row' }, h('b', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, d.title), h('span', { class: 'grow' }), kit.pill(dlWords(d), d.state === 'running' ? 'run' : d.state === 'done' ? 'ok' : d.state === 'failed' ? 'stop' : d.state === 'cancelled' ? '' : 'wait')),
      kit.meter(p, { live: d.state === 'running', style: { margin: '8px 0 4px' } }),
      h('div', { class: 'sub' }, bits.join(' · ')),
      d.reason && d.state !== 'waiting' ? h('div', { class: 'sub' }, d.reason) : null,
      open ? h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'grow' }),
        d.state === 'waiting' ? kit.btn('Review', { kind: 'ghost sm', onClick: () => showApprovals(true) }) : null,
        ['running', 'queued', 'waiting'].includes(d.state) ? kit.btn('Pause', { kind: 'ghost sm', onClick: () => act(d, 'pause') }) : null,
        d.state === 'paused' ? kit.btn('Resume', { kind: 'sm', onClick: () => act(d, 'resume') }) : null,
        kit.btn('Cancel', { kind: 'ghost sm', onClick: () => act(d, 'cancel') })) : null);
  });
}
$('#dl').onclick = () => togglePop('downloads');

// ---------- the agent tracker in the top bar: the count of running jobs, live from the desk's 'job' events (read once at start)
const tracked = { jobs: new Map(), loaded: null };
function loadJobs() {
  tracked.loaded = api('jobs?limit=100').then(r => { for (const j of r.jobs || []) if (!tracked.jobs.has(j.id) || tracked.jobs.get(j.id).updated <= j.updated) mergeJob(tracked.jobs, j); }).catch(() => {}).then(() => { paintTracker(); });
  return tracked.loaded;
}
ui.tracker = {
  jobs: () => [...tracked.jobs.values()],
  ready: () => tracked.loaded || loadJobs(),
  downloadRows: () => downloadRows(),
  stop: (id) => api(`jobs/${encodeURIComponent(id)}/stop`, { method: 'POST' }).then(j => { mergeJob(tracked.jobs, j); paintTracker(); return j; }),
};
function paintTracker() {
  const b = $('#trk'); if (!b) return;
  const n = runningCount(tracked.jobs.values());
  const text = n ? String(n) : '';
  if (b.dataset.text !== text || !b.firstChild) { b.innerHTML = ICON.track; if (n) b.append(h('span', null, text)); b.dataset.text = text; }
  const name = `Tracker: ${n === 0 ? 'no job running' : n === 1 ? '1 job running' : n + ' jobs running'}. Show what your agents are doing`;
  b.setAttribute('aria-label', name); b.title = name;
  if (popKind() === 'tracker') paintPop();
}
$('#trk').onclick = () => togglePop('tracker');

// ---------- a checked update can be installed: a small dot on an icon that opens Settings › Backup › Updates. Nothing installs from it.
let updateOk = false;
function paintUpdate() {
  const b = $('#upd'); if (!b) return;
  b.hidden = !updateOk;
  if (updateOk && !b.firstChild) { b.innerHTML = ICON.upd; b.append(h('span', { class: 'newdot', 'aria-hidden': 'true' })); }
  const name = 'A new version can be installed. Open Settings, Backup, Updates';
  b.setAttribute('aria-label', name); b.title = name;
}
$('#upd').onclick = () => { location.hash = '#/settings/backup?at=updates'; };

// ---------- the network icon: green online, red no internet, grey when the owner set the desk Offline.
// What it knows costs nothing outside: the browser's own online state, the model door's last real calls, and, with the
// Network module on, that module's stored summary (it never calls out to answer).
const net = { summary: null, lastCall: null };
const NET_FAIL = /fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|getaddrinfo|socket/i;
function netState() {
  if (state.settings.online === false) return 'off';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'down';
  if (net.summary && net.summary.online === false) return 'down';
  if (net.lastCall && !net.lastCall.ok && NET_FAIL.test(net.lastCall.error || '')) return 'down';
  return 'up';
}
const NET_WORDS = { up: 'Online', down: 'No internet', off: 'Offline by your choice' };
function paintNet() {
  const b = $('#net'); if (!b) return;
  const st = netState();
  if (b.dataset.state !== st) { b.innerHTML = ICON.wifi(st !== 'up'); b.dataset.state = st; }
  const name = `Network: ${NET_WORDS[st]}. Show details`;
  b.setAttribute('aria-label', name); b.title = NET_WORDS[st];
  if (popKind() === 'network') paintPop();
}
async function loadNet({ calls = false } = {}) {
  if (ui.moduleOn('network')) { try { net.summary = await api('m/network/summary'); } catch { net.summary = null; } } else net.summary = null;
  if (calls) {
    try {
      const r = await api('model/active');
      const lasts = (r.active || []).map(p => p.last).filter(x => x && x.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      net.lastCall = lasts[0] || null;
    } catch {}
  }
  paintNet();
}
function netRows() {
  const st = netState(), s = net.summary, rows = [];
  const why = st === 'off' ? 'The desk is set to Offline, by your choice. Agents make no outside calls until you switch Online back on.'
    : st === 'up' ? 'This PC is online.' + (s?.viaLastCheckAt ? ` Last checked ${kit.fmt.ago(s.viaLastCheckAt)}.` : '')
    : navigator.onLine === false ? 'This PC has no internet connection right now.'
    : s?.online === false ? 'The last check found no internet.' : `The last call to an outside service did not get through${net.lastCall?.at ? ' (' + kit.fmt.ago(net.lastCall.at) + ')' : ''}.`;
  rows.push(h('p', { class: 'netstate', 'data-state': st }, h('span', { class: 'ico-dot', 'aria-hidden': 'true' }), h('b', null, NET_WORDS[st] + '. '), why));
  if (s?.latencyMs != null) rows.push(kit.line('Latency', null, h('span', { class: 'val' }, `${Math.round(s.latencyMs)} ms`)));
  if (s && s.down != null) rows.push(kit.line('Watched sites down', null, h('span', { class: 'val' }, String(s.down))));
  const m = state.modules.find(x => x.id === 'network');
  if (m) rows.push(h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'grow' }),
    !m.on && m.kind !== 'core' ? kit.btn('Switch on Network', { kind: 'ghost sm', onClick: () => { showPop('network', false); location.hash = '#/settings/modules?module=network'; } }) : null,
    kit.btn('Open Network', { kind: 'sm', onClick: () => { showPop('network', false); ui.go('network'); } })));
  return rows;
}
$('#net').onclick = () => { togglePop('network'); if (popKind() === 'network') loadNet({ calls: true }); };
window.addEventListener('online', () => paintNet()); window.addEventListener('offline', () => paintNet());

// ---------- Doctor in the top bar: a quiet outline icon beside the network icon; a small mark when its last check found a
// problem. A press opens the Doctor page. Shown while the Doctor module is on.
function doctorSeen(r) {
  if (!r || !Array.isArray(r.checks)) return;
  const last = { problems: Number(r.problems) || 0, at: r.at || new Date().toISOString() };
  state.settings['ui.doctorLast'] = last; paintDoctor();
  api('settings', { body: { 'ui.doctorLast': last } }).catch(() => {});
}
function paintDoctor() {
  const b = $('#doc'); if (!b) return;
  b.hidden = !ui.moduleOn('doctor');
  if (b.hidden) return;
  const last = state.settings['ui.doctorLast'], n = Number(last?.problems) || 0;
  const key = n ? 'p' : 'f';
  if (b.dataset.mark !== key || !b.firstChild) { b.innerHTML = ICON.doc; if (n) b.append(h('span', { class: 'probdot', 'aria-hidden': 'true' })); b.dataset.mark = key; }
  const name = n ? `Doctor: the last check found ${n === 1 ? 'a problem' : n + ' problems'}${last.at ? ' (' + kit.fmt.when(last.at) + ')' : ''}. Open Doctor` : last ? 'Doctor: the last check found no problem. Open Doctor' : 'Doctor: check your desk';
  b.setAttribute('aria-label', name); b.title = name;
  b.toggleAttribute('aria-current', state.route.page === 'doctor');
}
$('#doc').onclick = () => ui.go('doctor');

// ---------- the footer line: at the left what the desk is doing now (an activity a page announced, a running job, a
// download; else Ready), at the right the count of running jobs and the version. One line; a press opens the Tracker.
function footWords() {
  if (state.panic.halted) return { text: 'Everything is stopped', busy: false };
  const acts = kit.activities(); if (acts.length) return { text: acts.at(-1).text, busy: true };
  const run = [...tracked.jobs.values()].filter(j => j.status === 'running' && !j.quiet).sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  if (run.length) return { text: `${jobWho(state.agents, run[0])}: ${run[0].title || 'a job'}`, busy: true };
  const d = dls.list.find(x => x.state === 'running');
  if (d) return { text: `Downloading ${d.title}${d.total ? ', ' + Math.round((d.done / d.total) * 100) + '%' : ''}`, busy: true };
  return { text: 'Ready', busy: false };
}
function paintFoot() {
  const f = $('#foot'); if (!f) return;
  const { text, busy } = footWords(), n = runningCount(tracked.jobs.values());
  const ver = state.version || document.querySelector('meta[name="apd-version"]')?.content || '';
  const jobs = n ? (n === 1 ? '1 job running' : `${n} jobs running`) : '';
  if ($('#foot-now').textContent !== text) $('#foot-now').textContent = text;
  if (f.dataset.busy !== (busy ? '1' : '0')) { f.dataset.busy = busy ? '1' : '0'; f.querySelector('.now').firstElementChild.className = busy ? 'fspin' : 'fdot'; }
  $('#foot-jobs').textContent = jobs;
  $('#foot-ver').textContent = /^\d/.test(ver) ? 'Version ' + ver : '';
  const name = `${text}.${jobs ? ' ' + jobs + '.' : ''} Open the Tracker`;
  f.setAttribute('aria-label', name); f.title = name;
}
$('#foot').onclick = () => ui.go('tracker');
kit.onActivity(() => paintFoot());

// ---------- routing and pages
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, ''); const [pathPart, q] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  // Files has one address form: #/files?path=<workspace path>. A link written as #/files/<path> is turned into it.
  if (parts[0] === 'files' && parts.length > 1 && !q) { history.replaceState(null, '', '#/files?path=' + encodeURIComponent(parts.slice(1).join('/'))); return { page: 'files', parts: [], params: { path: parts.slice(1).join('/') } }; }
  return { page: parts[0] || openingPlace(), parts: parts.slice(1), params: Object.fromEntries(new URLSearchParams(q || '')) };
}
async function moduleUi(id) {
  if (loaded.has(id)) return loaded.get(id);
  try { const mod = await import(`/modules/${id}/ui.js`); loaded.set(id, mod); return mod; }
  catch (e) { console.error('module ui failed', id, e); loaded.set(id, { error: e }); return loaded.get(id); }
}
ui.moduleUi = moduleUi;
/** Which module renders a page id. */
function ownerOf(page) { return state.modules.find(m => (m.pages || []).includes(page)) || state.modules.find(m => m.id === page); }
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  for (const fn of pageCleanup.splice(0)) { try { fn(); } catch {} }
  state.route = parseHash();
  const { page } = state.route;
  badges.delete(page);   // the owner is looking at this place now
  keptFocus = null;
  // Each render draws into a fresh element, so a slower earlier render can never add to the page on screen.
  const old = $('#view'); const view = document.createElement('section'); view.id = 'view'; view.className = 'view'; old.replaceWith(view);
  const stale = () => seq !== renderSeq; $('#pane').scrollTop = 0; showPop(null, false);
  paintMenu(); paintDoctor();
  try {
    if (page === 'home') return await homePage(view, ui);
    if (page === 'settings') return await settingsPage(view, ui);
    if (page === 'tracker') return await trackerPage(view, ui);
    const m = ownerOf(page);
    if (!m) return view.replaceChildren(offNote('This place is not part of the desk.', null));
    if (!m.on) return view.replaceChildren(offNote(`${ownName(page) || m.name} is switched off.`, m));
    if (!m.hasUi) return view.replaceChildren(offNote(`${m.name} is on but has no screen yet.`, null));
    const mod = await moduleUi(m.id);
    if (stale()) return;
    const def = mod.pages?.[page];
    if (mod.error || !def) return view.replaceChildren(offNote(`${m.name} could not open its screen${mod.error ? ': ' + mod.error.message : ''}.`, null));
    ownHeading(view, page);
    await def.render(view, ui, state.route);
    if (def.unmount) pageCleanup.push(() => def.unmount());
  } catch (e) { console.error(e); view.replaceChildren(offNote('This screen hit an error: ' + e.message, null)); }
}
/** A renamed place: the page's own heading says the owner's name too, whenever the page draws it with the default one. */
function ownHeading(view, page) {
  const it = arrangeMenu(basePlaces(), state.settings[MENU_KEY]).find(x => x.id === page);
  if (!it?.renamed) return;
  const was = [it.defaultLabel, OFFICIAL.find(o => o[0] === page)?.[1], ownerOf(page)?.menu?.find(x => x.id === page)?.label].filter(Boolean);
  const fix = () => { for (const h2 of view.querySelectorAll('h2')) if (was.includes(h2.textContent.trim()) && h2.textContent !== it.label) h2.textContent = it.label; };
  const mo = new MutationObserver(fix); mo.observe(view, { childList: true, subtree: true }); pageCleanup.push(() => mo.disconnect()); fix();
}
// A control that a page redraws in place (a module switch in Settings) keeps the keyboard focus: when the focused
// element leaves the page and nothing else took the focus, its new copy (same data-module or id) gets it back.
let keptFocus = null;
document.addEventListener('focusin', (e) => {
  const t = e.target; if (!(t instanceof Element) || !t.closest('#view')) { keptFocus = null; return; }
  const key = t.getAttribute('data-module') ? `[data-module="${CSS.escape(t.getAttribute('data-module'))}"]` : t.id ? '#' + CSS.escape(t.id) : null;
  keptFocus = key ? { key, el: t } : null;
});
new MutationObserver(() => {
  if (!keptFocus || keptFocus.el.isConnected) return;
  if (document.activeElement && document.activeElement !== document.body) { keptFocus = null; return; }
  const n = $('#view')?.querySelector(keptFocus.key); if (n) n.focus({ preventScroll: true });
}).observe($('#pane'), { childList: true, subtree: true });
function offNote(text, m) {
  return h('div', { class: 'offnote' }, h('b', null, text), m && m.kind !== 'core' ? kit.btn(`Switch on ${m.name}`, { onClick: async () => { try { await api(`modules/${m.id}/on`, { method: 'POST' }); await refresh(); render(); } catch (e) { toast(e.message, 'err'); } } }) : null, m ? h('span', { class: 'sub' }, 'Modules are switched in Settings › Modules.') : null);
}
// The menu never shows half a word: it snaps to whole places (shell.css), a place across an edge or under a fade is not
// drawn, and the current place is brought wholly into view only when the owner moves (or the window is resized), never
// on a repaint, so a live event does not undo his own scrolling.
const MENU_FADE = 26;   // the width of the "more places" arrow at each end in shell.css (.menu .more)
let menuShown = null;
function fitMenu(move = false) {
  const menu = $('#menu'); if (!menu) return;
  const over = menu.scrollWidth > menu.clientWidth + 1;
  menu.classList.toggle('over', over);
  if (over && (move || menuShown !== state.route.page)) {
    const cur = menu.querySelector('[aria-current="page"]');
    if (cur) {
      const m = menu.getBoundingClientRect(), c = cur.getBoundingClientRect();
      if (c.left < m.left + MENU_FADE || c.right > m.right - MENU_FADE) menu.scrollLeft += c.left - (m.left + MENU_FADE);
    }
  }
  menuShown = state.route.page;
  menuEdges();
  placeNotice();
  if (!menu._wheel) { menu._wheel = true; menu.addEventListener('wheel', (e) => { if (menu.scrollWidth > menu.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { menu.scrollBy({ left: e.deltaY }); e.preventDefault(); } }, { passive: false }); window.addEventListener('resize', () => fitMenu(true)); menu.addEventListener('scroll', menuEdges, { passive: true }); }
}
/** Which ends of the menu hide places: only those ends show the arrow. A place across an edge or under an arrow is not drawn. */
function menuEdges() {
  const menu = $('#menu'); if (!menu) return;
  const over = menu.classList.contains('over');
  const { l: fl, r: fr } = over ? menuEnds(menu) : { l: false, r: false };
  menu.classList.toggle('fl', fl); menu.classList.toggle('fr', fr);
  const navs = [...menu.querySelectorAll('.nav')], m = menu.getBoundingClientRect();
  const cut = new Set(over ? cutPlaces(navs.map(n => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right }; }), { l: m.left + (fl ? MENU_FADE : 0), r: m.right - (fr ? MENU_FADE : 0) }, { l: m.left, r: m.right }) : []);
  navs.forEach((n, i) => n.classList.toggle('part', cut.has(i)));
}
// ---------- notices: in the top bar's free room right of the menu, else one slim line under the bar (the page moves down for it)
function placeNotice() {
  const box = $('#toasts'), t = box.lastElementChild, win = $('#win');
  if (!t) { win.classList.remove('noting'); return; }
  for (const x of box.children) if (!x.title) x.title = x.textContent;
  const bar = $('.bar').getBoundingClientRect(), menu = $('#menu').getBoundingClientRect();
  const menuRight = Math.min(menu.right, Math.max(menu.left, ...$$('#menu .nav').map(n => n.getBoundingClientRect().right)));
  const ctl = [...$('.bar>div:last-child').children].find(e => e.offsetWidth);
  const ctlLeft = ctl ? ctl.getBoundingClientRect().left : bar.right - 12;
  const ownRow = ctl && menu.top >= ctl.getBoundingClientRect().bottom - 1;   // phone width: the menu has its own row, so no room beside it
  const room = ownRow ? 0 : Math.min(360, ctlLeft - menuRight - 20);
  const ctx = placeNotice.ctx || (placeNotice.ctx = document.createElement('canvas').getContext('2d'));
  ctx.font = '12.5px ' + getComputedStyle(t).fontFamily;
  const side = room >= Math.min(ctx.measureText(t.textContent).width + 26, 220);
  box.classList.toggle('under', !side); win.classList.toggle('noting', !side);
  Object.assign(box.style, side ? { top: bar.top + 'px', height: bar.height + 'px', left: (ctlLeft - 10 - room) + 'px', width: room + 'px' }
    : { top: (bar.bottom - 1) + 'px', height: '', left: bar.left + 'px', width: bar.width + 'px' });
}
new MutationObserver(placeNotice).observe($('#toasts'), { childList: true });
window.addEventListener('resize', placeNotice);
window.addEventListener('hashchange', () => {
  // a pop-up opened on one page must not sit over the next one (it blocked the whole desk)
  const m = document.getElementById('modal');
  if (m && !m.hidden && m._hash !== location.hash) { try { m._close ? m._close(undefined) : (m.hidden = true, m.replaceChildren()); } catch { m.hidden = true; m.replaceChildren(); } }
  render();
});

// ---------- onboarding (optional; Skip shows everything). Step one: the role. Step two, one screen, only on a fresh desk:
// what he does, his starting team, and which models answer. Save or Skip; Skip leaves everything as a fresh desk has it.
function paintOnboarding() {
  $('#onb').hidden = !!state.settings.onboarded;
  $('#roles').replaceChildren(...Object.entries(ROLES).map(([id, r]) => h('button', { class: 'role', onclick: () => chooseRole(id) }, h('b', null, r.name), h('span', null, r.desc))));
}
async function chooseRole(id) {
  const fresh = !state.settings.onboarded;
  await applyRole(ui, id);
  if (fresh) {
    // the desk runs on this PC: the page's own time zone wins over the server's guess, once, on a fresh desk
    try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tz && tz !== state.settings.timeZone) { const r = await api('settings', { body: { timeZone: tz } }); state.settings = r.settings; kit.setPrefs({ timeZone: tz }); } } catch {}
    return firstStep(id);
  }
  $('#onb').hidden = true; paintChrome(); render();
}
$('#onb-skip').onclick = () => chooseRole(null);
ui.chooseRole = chooseRole;

/** True when a keyed provider, a local model or a LAN model can answer: then the free-model note is not needed. */
async function hasFastModel() {
  try { const r = await api('model/active'); return (r.active || []).some(p => (p.kind === 'keyed' && p.keys) || (p.kind === 'local' && p.ok && (p.models || []).length) || p.kind === 'lan'); } catch { return false; }
}
/** The first-start offer of a local model: what /api/local-engine/plan says fits this PC, ticked when it can be had.
 *  Nothing is fetched here; Save asks the desk to start the downloads, and each one still asks the owner first.
 *  There is always a choice: every model in the list is shown with its size and the memory it needs. One too large
 *  for this PC can still be picked, after one plain warning. Memory free right now is a note, never a refusal. */
function localModelBox() {
  const cb = h('input', { type: 'checkbox', id: 'onb-local', disabled: true, 'aria-describedby': 'onb-local-d' });
  const what = h('span', { class: 'd', id: 'onb-local-d' }, 'Checking what fits this PC…');
  const choose = h('button', { type: 'button', class: 'link', hidden: true, 'aria-expanded': 'false' }, 'Choose another');
  // memory free now changes from minute to minute: after closing programs the owner can read it again
  const again = h('button', { type: 'button', class: 'link', hidden: true }, 'Check again');
  // nothing recommended: Models is where the owner can look further; it saves this step without the model, as the model note does
  const models = h('button', { type: 'button', class: 'link', hidden: true, 'data-apd': 'local-model-open' }, 'Open Models');
  const note = h('span', { class: 'd', 'data-apd': 'local-model-note', hidden: true });
  const free = h('span', { class: 'd', 'data-apd': 'local-model-free', hidden: true });   // plan.freeNote: "Close some programs before you use it: …"
  const warn = h('span', { class: 'd', 'data-apd': 'local-model-warn', role: 'status', hidden: true });
  const list = h('div', { class: 'choices', hidden: true, role: 'radiogroup', 'aria-label': 'Local model' });
  const box = h('div', { class: 'localbox', 'data-apd': 'local-model' },
    h('label', { class: 'tick' }, cb, h('span', null, h('b', null, 'Download a local model in the background'), what,
      h('span', { class: 'd' }, 'It runs on this PC and works without the internet.'), note, free, warn)), h('div', { class: 'row', style: { paddingLeft: '22px' } }, choose, again, models), list);
  const pick = { id: null, ok: false };
  // the owner's untick holds: a fresh read (Check again) is not a pick, so only a model he picks ticks the box again
  let unticked = false; cb.onchange = () => { unticked = !cb.checked; };
  const off = (why, retry = false) => { again.hidden = !retry; models.hidden = true; note.hidden = free.hidden = warn.hidden = true; cb.checked = false; cb.disabled = true; pick.ok = false; what.textContent = why; choose.hidden = true; list.hidden = true; box.classList.add('off'); };
  const line = (c) => c.fits ? `${c.sizeText} download, needs about ${c.needsGb} GB of memory.${c.why ? ' ' + c.why[0].toUpperCase() + c.why.slice(1) + '.' : ''}` : `${c.sizeText} download. ${c.notFit || `Needs about ${c.needsGb} GB, more than this PC has.`}`;
  const show = (plan, picked = false) => {
    if (state.settings.online === false) return off('Not now: the desk is Offline. Switch it online first, then get it on the Models page.');
    if (state.panic.halted) return off('Not now: everything is stopped. Press Resume first.');
    const choices = plan.choices || [];
    if ((!plan.ok || !plan.model) && !choices.length) return off(plan.reason || 'No local model fits this PC.');
    if (plan.model && !plan.totalBytes) return off(`${plan.model.name} is already on this PC.`);
    list.replaceChildren(...choices.map(c => h('label', { class: 'tick' }, h('input', { type: 'radio', name: 'onb-model', value: c.id, checked: c.id === plan.model?.id, 'data-fits': String(!!c.fits), onchange: () => choice(c.id) }),
      h('span', null, h('b', null, c.name + (c.id === plan.recommended ? ' (best fit)' : '')), h('span', { class: 'd' }, line(c))))));
    choose.hidden = choices.length < 2; box.classList.remove('off');
    if (!plan.ok || !plan.model) {
      // nothing recommended: unticked, why in one line, the list open, and Models one press away
      pick.ok = false; cb.checked = false; cb.disabled = true; what.textContent = plan.reason || 'No model is recommended for this PC.';
      note.hidden = free.hidden = warn.hidden = again.hidden = true; models.hidden = false; list.hidden = false; choose.setAttribute('aria-expanded', 'true');
      return;
    }
    pick.id = plan.model.id; pick.ok = true; models.hidden = plan.recommended != null;
    if (picked) unticked = false;
    if (cb.disabled || picked) { cb.disabled = false; cb.checked = picked || !unticked; }
    what.textContent = `${plan.model.name}${plan.engineBytes ? ' and its engine' : ''}, ${plan.totalText}`;
    note.textContent = plan.note || ''; note.hidden = !plan.note;
    free.textContent = plan.freeNote || ''; free.hidden = !plan.freeNote; again.hidden = !plan.lowMemory;
    warn.textContent = plan.warning || ''; warn.hidden = !plan.warning;
  };
  const read = async (id, fresh = false) => { const q = [id && 'model=' + encodeURIComponent(id), fresh && 'fresh=1'].filter(Boolean).join('&'); const [plan, eng] = await Promise.all([api('local-engine/plan' + (q ? '?' + q : '')), api('local-engine').catch(() => null)]); if (eng && eng.on === false) return off('The local engine is switched off on the Models page.'); show(plan, !!id && !fresh); };
  const choice = (id) => { what.textContent = 'Checking…'; read(id).catch(e => off('Could not check it now: ' + e.message)); };
  again.onclick = () => { again.hidden = true; what.textContent = 'Checking…'; read(pick.id, true).catch(e => off('Could not check it now: ' + e.message, true)); };
  choose.onclick = () => { list.hidden = !list.hidden; choose.setAttribute('aria-expanded', String(!list.hidden)); };
  models.onclick = () => { cb.checked = false; pick.ok = false; const save = [...(box.closest('.card')?.querySelectorAll('.btn') || [])].find(b => b.textContent === 'Save'); ui.go('models'); save?.click(); };
  read(null).catch(e => off('Could not check what fits this PC: ' + e.message));
  return { el: box, wanted: () => pick.ok && cb.checked && !cb.disabled ? pick.id : null };
}

async function firstStep(roleId) {
  const box = $('#onb .card'); const done = () => { $('#onb').hidden = true; paintChrome(); render(); };
  const role = ROLES[roleId];
  const help = roleId === 'sales' ? 'What you sell, who buys it, and where. Your agents use this for leads, drafts and research.' : ABOUT_HELP;
  const about = h('textarea', { id: 'onb-about', rows: 3, maxlength: String(ABOUT_MAX), 'aria-label': 'What do you do?', placeholder: 'For example: Payroll software for small firms. HR heads buy it. Pune and Mumbai.' });
  // the team: the agents a fresh desk has, ticked from the role; the Coordinator is always on
  const want = new Set(teamFor(roleId));
  const ticks = state.agents.filter(a => STARTING_TEAM.includes(a.id)).map(a => {
    const always = a.id === 'coordinator';
    const cb = h('input', { type: 'checkbox', value: a.id, checked: always || want.has(a.id), disabled: always, 'aria-label': a.name });
    return h('label', { class: 'tick' }, cb, h('span', null, h('b', null, a.name), h('span', { class: 'd' }, always ? 'Always on. ' + a.role : a.role)));
  });
  const team = ui.moduleOn('agents') && ticks.length > 1 ? h('div', null, h('h3', null, 'Your team'), h('p', { class: 'sub' }, 'Ticked for ' + (role ? role.name.toLowerCase() : 'everything') + '. You can hire or retire agents later on the Agents page.'), h('div', { class: 'ticks' }, ticks)) : null;
  // the model note comes in when the desk has said whether a fast model is there; the screen does not wait for it
  const noteSeen = !!state.settings['ui.modelNoteSeen'];
  const noteSlot = h('div', { hidden: true });
  let note = null;
  const local = localModelBox();
  const err = h('p', { class: 'sub', role: 'status' });
  const skipBtn = kit.btn('Skip for now', { kind: 'ghost', onClick: () => finish(false) }), saveBtn = kit.btn('Save', { onClick: () => finish(true) });
  async function finish(saveIt, { withLocal = saveIt } = {}) {
    skipBtn.disabled = saveBtn.disabled = true; err.textContent = saveIt ? 'Saving…' : '';
    try {
      const body = { 'ui.firstStep': saveIt ? 'saved' : 'skipped' };
      if (note) body['ui.modelNoteSeen'] = true;
      if (saveIt && about.value.trim()) body['business.about'] = about.value;
      const r = await api('settings', { body }); state.settings = r.settings;
      if (saveIt && team) {
        // an agent left unticked is retired the way the Agents page retires it; the rooms then follow the team
        const off = ticks.map(t => t.querySelector('input')).filter(cb => !cb.checked && !cb.disabled).map(cb => cb.value);
        for (const id of off) await api(`m/agents/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (off.length && ui.moduleOn('chat')) api('m/chat/rooms/fit', { method: 'POST' }).catch(() => {});   // the rooms follow in the background
        if (off.length) state.agents = (await api('agents')).agents;
      }
      // the local model: only on Save, only when ticked. Each download then asks the owner, as every download does.
      const modelId = saveIt && withLocal ? local.wanted() : null;
      if (modelId) {
        try { await api('local-engine/get', { body: { model: modelId } }); toast('The local model will download in the background once you allow it.', 'ok', 7000); }
        catch (e) { toast('The local model did not start: ' + e.message, 'err'); }
      }
      done(); return true;
    } catch (e) { err.textContent = 'That did not save: ' + e.message; skipBtn.disabled = saveBtn.disabled = false; return false; }
  }
  box.replaceChildren(
    h('div', null, h('h2', null, 'What do you do?'), h('p', { class: 'sub' }, help)), about, team, noteSlot, local.el, err,
    h('div', { class: 'row' }, h('span', { class: 'grow' }), skipBtn, saveBtn));
  box.classList.add('step2');
  about.focus();
  if (!noteSeen) hasFastModel().then((fast) => {
    if (fast || !noteSlot.isConnected) return;
    note = h('div', { class: 'note', id: 'model-note' }, h('span', null, 'Free models answer by default. They need no key but can be slow. For faster answers add a free key or a local model in Models.'),
      h('span', { class: 'row' }, kit.btn('Open Models', { kind: 'ghost sm', onClick: async () => { if (await finish(true, { withLocal: false })) ui.go('models'); } }), kit.btn('Got it', { kind: 'ghost sm', onClick: () => { note.remove(); api('settings', { body: { 'ui.modelNoteSeen': true } }).catch(() => {}); } })));
    noteSlot.replaceWith(note);
  });
}

// ---------- state and live events
async function refresh() {
  const s = await api('state');
  Object.assign(state, { settings: s.settings, security: s.security, panic: s.panic, modules: s.modules, agents: s.agents, jobs: s.jobs, pendingApprovals: s.pendingApprovals, tools: s.tools, version: s.version });
  kit.setPrefs({ timeZone: s.settings.timeZone, locale: s.settings.locale, currency: s.settings.currency });
  applyTheme(themeOf(s.settings, s.settings.theme));
  await refreshStopped();
  paintChrome();
}
function connect() {
  // an event stream cannot send a header, so this window's token goes in the address; its space's events only
  const es = new EventSource('/api/events' + (kit.session() ? '?session=' + encodeURIComponent(kit.session()) : ''));
  es.addEventListener('apd', (ev) => { let m = null; try { m = JSON.parse(ev.data); } catch { return; } if (m?.type) emitLocal(m.type, m.data || {}); });
  es.onerror = () => { /* the browser reconnects on its own */ };
  let opened = false; es.onopen = () => { if (opened) { loadDownloads(); loadJobs(); } opened = true; };   // events missed while away
}
globalOn('panic', (st) => { if (st && 'halted' in st) { state.panic = st; paintChrome(); if (!st.halted) refreshApprovals().catch(() => {}); } });
// an approval asked while the desk's window is in front opens its card at once (unless he has another pop-up open);
// the focus stays where the owner is typing
globalOn('approval', async (a) => {
  const asked = a?.status === 'pending';
  if (asked) toast(`Waiting for you: ${a.title}`);
  try { await refreshApprovals(); } catch { return; }
  if (asked && !document.hidden && !popKind() && state.pendingApprovals.some(x => x.id === a.id)) showApprovals(true);   // another pop-up he opened stays
});
globalOn('modules', async () => {
  loaded.clear(); await refresh(); bootModules();
  // Settings updates in place (its menu, the cards): the owner stays where he was, at the same scroll and focus
  const v = $('#view');
  if (state.route.page === 'settings' && typeof v?._onModules === 'function') { try { if (await v._onModules() !== 'render') return; } catch (e) { console.error(e); } }
  const m = ownerOf(state.route.page); if (state.route.page === 'settings' || (m && !m.on) || !m) render();
});
globalOn('agents', () => api('agents').then(r => { state.agents = r.agents; }).catch(() => {}));
globalOn('security', (s) => { if (s?.level) { state.security = s; paintChrome(); } });
globalOn('toast', (t) => toast(t.text || String(t), t.kind || ''));
globalOn('job', jobFinished);
globalOn('job', (j) => { mergeJob(tracked.jobs, j); paintTracker(); paintFoot(); });
globalOn('job', jobNeedsYou);
globalOn('update', (st) => { updateOk = updateReady(st); paintUpdate(); });
globalOn('downloads', ({ download, summary } = {}) => {
  if (download?.id) {
    const i = dls.list.findIndex(x => x.id === download.id); if (i >= 0) dls.list[i] = download; else dls.list.unshift(download);
    if (download.state === 'done' && !dls.told.has(download.id)) { dls.told.add(download.id); if (state.settings.notifications !== false) toast(`Downloaded: ${download.title}`, 'ok', 9000); }
    else if (OPEN_DL.has(download.state)) dls.told.delete(download.id);
  }
  if (summary) dls.summary = summary;
  paintDownloads(); paintFoot();
});
globalOn('settings', (ch) => { if (ch && 'online' in ch) { state.settings.online = ch.online; paintNet(); } });
globalOn('network', () => loadNet());
globalOn('modules', () => loadNet());

/** Modules whose manifest says "boot": true add something to every screen (Voice's mic button, the lock overlay).
 *  Their ui.js is loaded at start and whenever modules change; an exported boot(ui) is called once per load. */
async function bootModules() {
  for (const m of state.modules) if (m.on && m.hasUi && m.boot) { try { const mod = await moduleUi(m.id); if (typeof mod.boot === 'function' && !mod.__booted) { await mod.boot(ui); } } catch (e) { console.error('boot failed', m.id, e); } }
}
// ---------- Bench mode: tell the desk the owner is here (a click, a key, the page opened or shown), at most once a minute.
// The desk sees only its own window; it never looks at the rest of the PC.
let hereAt = 0;
function ownerHere() {
  if (document.hidden || !ui.moduleOn('bench')) return;
  const t = Date.now(); if (t - hereAt < 60000) return; hereAt = t;
  api('m/bench/seen', { method: 'POST' }).catch(() => {});
}
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, ownerHere, { capture: true, passive: true });
document.addEventListener('visibilitychange', ownerHere);
globalOn('modules', () => { hereAt = 0; ownerHere(); });
ui.coreSettingsSections = coreSettingsSections;

// The desk opens for a person. In the open desk (one person, no PIN) the page is served with that person's token, so it
// boots straight away as before. Otherwise this window needs a token: if it holds a live one (this window, kept across a
// reload) it boots as that person; if not, the chooser asks who is at the desk.
async function startDesk() {
  const token = kit.session();
  let me = null;
  if (token) { try { me = await api('people/me'); } catch { me = null; } }
  if (!me) { kit.setSession(''); return showChooser(ui, { mode: 'enter' }); }
  kit.setSession(token);          // keep this window on this person across a reload
  state.me = me.person;
  if (me.theme === 'dark') applyTheme('dark');   // a light theme waits for the settings: it may be only the stored default
  takeEntryNotice();              // wrong tries or a PIN reset, told once on entry
  await boot();
}
async function boot() {
  await refresh();
  await refreshWho();
  paintOnboarding();
  connect();
  loadDownloads(); loadNet({ calls: true }); loadJobs();
  // the Network module's stored summary, read again now and then while the window is shown (a read on this PC, never a call out)
  setInterval(() => { if (!document.hidden && ui.moduleOn('network')) loadNet(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNet(); });
  bootModules();
  ownerHere();
  if (!location.hash) location.hash = '#/' + openingPlace(); else render();
}
await startDesk();
