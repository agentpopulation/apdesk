// The shell: top bar, the official menu, theme, Panic, approvals, Home, onboarding, Settings frame, module pages.
import * as kit from '/ui/kit.js';
import { homePage, ROLES, applyRole, teamFor, STARTING_TEAM } from '/ui/pages/home.js';
import { settingsPage, coreSettingsSections, ABOUT_MAX, ABOUT_HELP } from '/ui/pages/settings.js';
const { $, $$, h, api, toast } = kit;

const OFFICIAL = [['chat', 'Chat'], ['research', 'Research'], ['tasks', 'Tasks'], ['sales', 'Sales'], ['files', 'Files'], ['agents', 'Agents'], ['models', 'Models'], ['settings', 'Settings']];
const state = { settings: {}, security: {}, panic: { halted: false }, modules: [], agents: [], jobs: {}, pendingApprovals: [], stoppedApprovals: [], route: { page: 'chat', parts: [], params: {} } };
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
  label: (page, fallback) => roleLabel(page, fallback),
  refresh: () => refresh(),
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
};
window.apd = ui;       // for the console and for acceptance checks

function emitLocal(type, data) { for (const fn of listeners.get(type) || []) { try { fn(data); } catch (e) { console.error(e); } } }
const globalOn = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };

// ---------- role labels and menu
const role = () => state.settings.role ? ROLES[state.settings.role] : null;
const roleLabel = (page, fallback) => role()?.labels?.[page] || fallback;
function menuItems() {
  const extra = [];
  for (const m of state.modules) if (m.on) for (const it of m.menu || []) if (!OFFICIAL.some(o => o[0] === it.id)) extra.push({ ...it, module: m.id });
  extra.sort((a, b) => (a.order || 100) - (b.order || 100));
  return [...OFFICIAL.map(([id, label]) => ({ id, label: roleLabel(id, label), official: true })), ...extra];
}
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
    const n = [...badges.values()].reduce((a, b) => a + b, 0); document.title = `(${n}) ${appName()}`;
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification(appName(), { body: text, tag: j.id }); } catch {}
  }
}
const appName = () => String(state.settings.appName || '').trim() || 'AP Desk';
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = appName(); });
function paintMenu() {
  const off = role()?.off || [];
  $('#menu').replaceChildren(...menuItems().map(it => h('button', { class: 'nav', 'data-v': it.id, 'aria-current': it.id === state.route.page ? 'page' : null, disabled: off.includes(it.id), title: off.includes(it.id) ? 'Off for this role. Switch it on in Settings.' : null, onclick: () => ui.go(it.id) }, it.label, badges.get(it.id) ? h('span', { class: 'badge', title: 'Finished since you last looked' }, String(badges.get(it.id))) : null)));
  fitMenu();
}
function paintChrome() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#theme').textContent = dark ? 'White theme' : 'Black theme';
  const nameEl = document.querySelector('.bar .name'); if (nameEl && nameEl.textContent !== appName()) nameEl.textContent = appName();
  if (!document.hidden && document.title !== appName()) document.title = appName();
  const halted = !!state.panic.halted;
  document.body.classList.toggle('halted', halted);
  $('#halt').hidden = !halted; $('#panic').textContent = halted ? 'Stopped' : 'Panic';
  const n = state.pendingApprovals.length, st = state.stoppedApprovals.length;
  $('#waiting').hidden = n === 0 && st === 0;
  $('#waiting').textContent = n ? (n === 1 ? '1 waiting for you' : `${n} waiting for you`) : `Stopped by Panic: ${st}`;
  paintMenu();
}
async function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('apd-theme', dark ? 'dark' : 'light'); } catch {}
  state.settings.theme = dark ? 'dark' : 'light'; paintChrome();
  api('settings', { body: { theme: state.settings.theme } }).catch(() => {});
}
ui.setTheme = setTheme;

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
async function refreshApprovals() { const r = await api('approvals'); state.pendingApprovals = r.pending; await refreshStopped(); paintChrome(); if (!$('#pop').hidden) showApprovals(true); }
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
    ...list.map(a => kit.line(a.title, `${ui.agent(a.agentId)?.name || a.agentId || 'An agent'} · ${ACTION_WORDS[a.action] || a.action} · stopped ${kit.fmt.when(a.decided)}`,
      kit.btn('Dismiss', { kind: 'ghost sm', onClick: () => dismissStopped({ id: a.id }) }))));
}
function approvalCard(a) {
  const agent = ui.agent(a.agentId)?.name || a.agentId || 'An agent';
  // Everything the approval covers is shown, in full: long text scrolls inside its box, nothing is cut or left out.
  const rows = []; const walk = (obj, prefix) => { for (const [k, v] of Object.entries(obj || {})) { if (v == null) continue; if (typeof v === 'object') walk(v, prefix + k + '.'); else rows.push([prefix + k, String(v)]); } };
  if (a.payload && typeof a.payload === 'object') walk(a.payload, ''); else if (a.payload != null) rows.push(['', String(a.payload)]);
  const total = rows.reduce((n, r) => n + r[1].length, 0);
  const body = rows.length ? h('div', { class: 'draft', style: { marginTop: '8px', maxHeight: '260px', overflow: 'auto' } },
    rows.map(([k, v]) => h('div', { style: { marginBottom: '6px' } }, k ? h('span', { class: 'sub', style: { display: 'block' } }, k + (v.length > 400 ? ` (${v.length} characters)` : '')) : null, h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: /code|command|script|body|text|content/i.test(k) && v.length > 120 ? 'var(--mono)' : null, fontSize: v.length > 600 ? '12.5px' : null } }, v)))) : null;
  return h('div', { class: 'card', style: { marginBottom: '8px' } },
    h('div', { class: 'row' }, h('b', null, a.title), kit.pill(ACTION_WORDS[a.action] || a.action, 'wait')),
    h('div', { class: 'sub' }, `${agent} asks${a.detail ? ' · ' + a.detail : ''}${a.amount ? ' · ' + kit.fmt.money(a.amount, a.currency) : ''}`),
    body, total > 1500 ? h('div', { class: 'sub', style: { marginTop: '4px' } }, `Scroll to read all of it: ${total} characters. What you approve is exactly this.`) : null,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'grow' }),
      kit.btn('Deny', { kind: 'ghost sm', onClick: () => ui.decide(a.id, 'deny').catch(e => toast(e.message, 'err')) }),
      kit.btn(a.action === 'send.person' ? 'Approve and send' : 'Approve', { kind: 'sm', onClick: () => ui.decide(a.id, 'approve').catch(e => toast(e.message, 'err')) })));
}
const ACTION_WORDS = { 'file.write': 'Write a file', 'file.delete': 'Delete a file', 'file.read.outside': 'Open a folder', 'shell.run': 'Run a command', 'browser.open': 'Open a site', 'browser.act': 'Act in the browser', 'net.post': 'Send data', 'send.person': 'Send to a person', spend: 'Spend money', 'module.toggle': 'Switch a module', install: 'Install', login: 'Sign in', 'calendar.write': 'Change the calendar', custom: 'Action' };
ui.approvalCard = approvalCard; ui.ACTION_WORDS = ACTION_WORDS;
function showApprovals(open) {
  const pop = $('#pop'); pop.hidden = !open; if (!open) return;
  pop.replaceChildren(h('div', { class: 'row', style: { marginBottom: '8px' } }, h('h3', null, 'Waiting for you'), h('span', { class: 'grow' }), kit.btn('Close', { kind: 'ghost sm', onClick: () => showApprovals(false) })),
    ...(state.pendingApprovals.length ? state.pendingApprovals.map(approvalCard) : [kit.empty('Nothing is waiting.')]), stoppedSection());
}
$('#waiting').onclick = () => showApprovals($('#pop').hidden);

// ---------- routing and pages
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, ''); const [pathPart, q] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  // Files has one address form: #/files?path=<workspace path>. A link written as #/files/<path> is turned into it.
  if (parts[0] === 'files' && parts.length > 1 && !q) { history.replaceState(null, '', '#/files?path=' + encodeURIComponent(parts.slice(1).join('/'))); return { page: 'files', parts: [], params: { path: parts.slice(1).join('/') } }; }
  return { page: parts[0] || (state.settings.onboarded || state.settings.role ? 'chat' : 'chat'), parts: parts.slice(1), params: Object.fromEntries(new URLSearchParams(q || '')) };
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
  // Each render draws into a fresh element, so a slower earlier render can never add to the page on screen.
  const old = $('#view'); const view = document.createElement('section'); view.id = 'view'; view.className = 'view'; old.replaceWith(view);
  const stale = () => seq !== renderSeq; $('#pane').scrollTop = 0; showApprovals(false);
  paintMenu();
  try {
    if (page === 'home') return await homePage(view, ui);
    if (page === 'settings') return await settingsPage(view, ui);
    const m = ownerOf(page);
    if (!m) return view.replaceChildren(offNote('This place is not part of the desk.', null));
    if (!m.on) return view.replaceChildren(offNote(`${m.name} is switched off.`, m));
    if (!m.hasUi) return view.replaceChildren(offNote(`${m.name} is on but has no screen yet.`, null));
    const mod = await moduleUi(m.id);
    if (stale()) return;
    const def = mod.pages?.[page];
    if (mod.error || !def) return view.replaceChildren(offNote(`${m.name} could not open its screen${mod.error ? ': ' + mod.error.message : ''}.`, null));
    await def.render(view, ui, state.route);
    if (def.unmount) pageCleanup.push(() => def.unmount());
  } catch (e) { console.error(e); view.replaceChildren(offNote('This screen hit an error: ' + e.message, null)); }
}
function offNote(text, m) {
  return h('div', { class: 'offnote' }, h('b', null, text), m && m.kind !== 'core' ? kit.btn(`Switch on ${m.name}`, { onClick: async () => { try { await api(`modules/${m.id}/on`, { method: 'POST' }); await refresh(); render(); } catch (e) { toast(e.message, 'err'); } } }) : null, m ? h('span', { class: 'sub' }, 'Modules are switched in Settings › Modules.') : null);
}
function fitMenu() {
  const menu = $('#menu'); if (!menu) return;
  const over = menu.scrollWidth > menu.clientWidth + 1;
  menu.classList.toggle('over', over);
  if (over) menu.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  placeNotice();
  if (!menu._wheel) { menu._wheel = true; menu.addEventListener('wheel', (e) => { if (menu.scrollWidth > menu.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { menu.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false }); window.addEventListener('resize', fitMenu); }
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
  const room = Math.min(360, ctlLeft - menuRight - 20);
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
  const noteSeen = !!state.settings['ui.modelNoteSeen'];
  const note = !noteSeen && !(await hasFastModel()) ? h('div', { class: 'note', id: 'model-note' }, h('span', null, 'Free models answer by default. They need no key but can be slow. For faster answers add a free key or a local model in Models.'),
    h('span', { class: 'row' }, kit.btn('Open Models', { kind: 'ghost sm', onClick: async () => { await finish(true); ui.go('models'); } }), kit.btn('Got it', { kind: 'ghost sm', onClick: () => { note.remove(); api('settings', { body: { 'ui.modelNoteSeen': true } }).catch(() => {}); } }))) : null;
  const err = h('p', { class: 'sub', role: 'status' });
  async function finish(saveIt) {
    try {
      const body = { 'ui.firstStep': saveIt ? 'saved' : 'skipped' };
      if (note) body['ui.modelNoteSeen'] = true;
      if (saveIt && about.value.trim()) body['business.about'] = about.value;
      const r = await api('settings', { body }); state.settings = r.settings;
      if (saveIt && team) {
        // an agent left unticked is retired the way the Agents page retires it; the rooms then follow the team
        const off = ticks.map(t => t.querySelector('input')).filter(cb => !cb.checked && !cb.disabled).map(cb => cb.value);
        for (const id of off) await api(`m/agents/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (off.length && ui.moduleOn('chat')) await api('m/chat/rooms/fit', { method: 'POST' });
        if (off.length) state.agents = (await api('agents')).agents;
      }
      done(); return true;
    } catch (e) { err.textContent = 'That did not save: ' + e.message; return false; }
  }
  box.replaceChildren(
    h('div', null, h('h2', null, 'What do you do?'), h('p', { class: 'sub' }, help)), about, team, note, err,
    h('div', { class: 'row' }, h('span', { class: 'grow' }), kit.btn('Skip for now', { kind: 'ghost', onClick: () => finish(false) }), kit.btn('Save', { onClick: () => finish(true) })));
  box.classList.add('step2');
  about.focus();
}

// ---------- state and live events
async function refresh() {
  const s = await api('state');
  Object.assign(state, { settings: s.settings, security: s.security, panic: s.panic, modules: s.modules, agents: s.agents, jobs: s.jobs, pendingApprovals: s.pendingApprovals, tools: s.tools, version: s.version });
  kit.setPrefs({ timeZone: s.settings.timeZone, locale: s.settings.locale, currency: s.settings.currency });
  if (s.settings.theme && s.settings.theme !== document.documentElement.dataset.theme) { document.documentElement.dataset.theme = s.settings.theme; try { localStorage.setItem('apd-theme', s.settings.theme); } catch {} }
  await refreshStopped();
  paintChrome();
}
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('apd', (ev) => { let m = null; try { m = JSON.parse(ev.data); } catch { return; } if (m?.type) emitLocal(m.type, m.data || {}); });
  es.onerror = () => { /* the browser reconnects on its own */ };
}
globalOn('panic', (st) => { if (st && 'halted' in st) { state.panic = st; paintChrome(); if (!st.halted) refreshApprovals().catch(() => {}); } });
globalOn('approval', (a) => { refreshApprovals().catch(() => {}); if (a?.status === 'pending') toast(`Waiting for you: ${a.title}`); });
globalOn('modules', async () => { loaded.clear(); await refresh(); bootModules(); const m = ownerOf(state.route.page); if (state.route.page === 'settings' || (m && !m.on) || !m) render(); });
globalOn('agents', () => api('agents').then(r => { state.agents = r.agents; }).catch(() => {}));
globalOn('security', (s) => { if (s?.level) { state.security = s; paintChrome(); } });
globalOn('toast', (t) => toast(t.text || String(t), t.kind || ''));
globalOn('job', jobFinished);

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
await refresh();
paintOnboarding();
connect();
bootModules();
ownerHere();
if (!location.hash) location.hash = '#/chat'; else render();
