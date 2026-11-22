// Settings frame, owned by the shell. Core sections live here; a module's ui.js `settings` export adds sections or
// replaces a core one with the same id (the Safety, Backup, Store, Vault and other modules do that).
import { ROLES } from '/ui/pages/home.js';
import { arrangeMenu, cleanMenu, movePlace, firstPlace, MENU_KEY, NAME_MAX, ALWAYS_SHOWN } from '/ui/menus.js';
import { peopleSettings } from '/ui/people.js';

export const ABOUT_MAX = 600;
export const ABOUT_HELP = 'What you sell, who buys it, and where. Your agents use this for leads, drafts and research.';

const ORDER = ['general', 'appearance', 'people', 'menu', 'security', 'modules', 'accounts', 'keys', 'channels', 'payments', 'network', 'memory', 'backup'];
const TITLES = { general: 'General', appearance: 'Appearance', people: 'People', menu: 'Menu', security: 'Security', modules: 'Modules', accounts: 'Accounts and lock', keys: 'Keys and logins', channels: 'Channels and mail', payments: 'Payments and spend', network: 'Network', memory: 'Memory', backup: 'Backup' };
const NEEDS = { accounts: 'accounts', keys: 'vault', channels: 'channels', payments: 'payments', network: 'network', memory: 'memory', backup: 'backup' };

/** The desk's address with a Copy button: the same words in General and under Show code. */
export function copyButton(ui, text, label = 'Copy') {
  const b = ui.btn(label, { kind: 'ghost sm', 'aria-label': 'Copy the address', onClick: async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      try { const t = ui.h('textarea', { style: { position: 'fixed', opacity: '0' } }); t.value = text; document.body.append(t); t.select(); ok = document.execCommand('copy'); t.remove(); } catch {}
    }
    b.textContent = ok ? 'Copied' : 'Select and copy it'; setTimeout(() => { b.textContent = label; }, 2000);
  } });
  return b;
}
const addressLine = (ui) => ui.line('Address', 'Open this address in Chrome or Edge on this PC. To keep it handy, install it as an app from the browser\'s menu.',
  ui.h('span', { class: 'field' }, ui.h('code', { class: 'val', id: 'desk-address' }, location.origin), copyButton(ui, location.origin)));

/** Settings › Security: the code that opens the desk in another browser, shown for 60 seconds in this window only. */
export function pairCard(ui) {
  const { h, api, card, line, btn } = ui;
  const box = h('div', { id: 'pair-code', 'aria-live': 'polite' });
  let timer = null;
  const hide = () => { clearInterval(timer); timer = null; box.replaceChildren(); show.hidden = false; };
  const show = btn('Show code', { kind: 'ghost sm', onClick: async () => {
    try {
      const r = await api('security/pair-code', { method: 'POST' });
      const end = Date.now() + (r.seconds || 60) * 1000; const count = h('span', { class: 'sub' });
      const tick = () => { const left = Math.ceil((end - Date.now()) / 1000); if (left <= 0) return hide(); count.textContent = `Hidden again in ${left} s.`; };
      show.hidden = true;
      box.replaceChildren(h('div', { class: 'paircode' },
        h('div', null, h('span', { class: 'sub' }, 'Code'), h('b', { class: 'code' }, `${r.code.slice(0, 3)} ${r.code.slice(3)}`)),
        h('div', null, h('span', { class: 'sub' }, 'Address'), h('span', { class: 'row', style: { gap: '6px' } }, h('code', null, r.address), copyButton(ui, r.address))),
        h('p', { class: 'sub' }, 'Open the address in the other browser on this PC and type the code there.'),
        h('div', { class: 'row' }, count, h('span', { class: 'grow' }), btn('Hide', { kind: 'ghost sm', onClick: hide }))));
      tick(); timer = setInterval(tick, 1000);
    } catch (e) { box.replaceChildren(h('p', { class: 'sub' }, e.message)); }
  } });
  ui.onLeave(() => clearInterval(timer));
  return card({ 'data-apd': 'pair' }, line('Open the desk in another browser', 'A browser that has not opened this desk before asks for a six-digit code. It is shown here, for one minute.', show), box);
}

export const coreSettingsSections = {
  general: { title: 'General', render(el, ui) {
    const { h, api, card, line } = ui; const s = ui.state.settings;
    // Every field here saves by itself when the owner leaves it (or presses Enter): the shared saved mark beside it says
    // "Saving…", then shows a drawn tick ("Saved"), or a cross with the reason, and the field gets its old value back.
    const save = async (patch, mark, field, old) => {
      const run = async () => { const r = await api('settings', { body: patch }); ui.state.settings = r.settings; ui.setPrefs(r.settings); await ui.refresh(); };
      if (mark) return mark.run(run, { field, old });
      try { await run(); return true; } catch (e) { ui.toast(e.message, 'err'); return false; }
    };
    const mark = () => ui.savedMark();
    const was = (key) => ui.state.settings[key] ?? '';
    const text = (key, ph) => { const m = mark(); return h('span', { class: 'field' }, h('input', { type: 'text', value: s[key] ?? '', placeholder: ph, 'data-key': key, onchange: (e) => save({ [key]: e.target.value }, m, e.target, was(key)) }), m); };
    const roleMark = mark();
    const roleSel = h('select', { onchange: async (e) => { if (await save({ role: e.target.value || null, onboarded: true }, roleMark, e.target, was('role'))) setTimeout(() => location.reload(), 700); } }, h('option', { value: '' }, 'Everything'), Object.entries(ROLES).map(([id, r]) => h('option', { value: id, selected: s.role === id }, r.name)));
    const notifyOn = s.notifications !== false;
    const canAsk = typeof Notification !== 'undefined';
    const notifyMark = mark();
    const notifySw = ui.sw(notifyOn, 'Tell me when a job finishes', async (on) => { await save({ notifications: on }, notifyMark); if (on && canAsk && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} } });
    const perm = !canAsk ? 'This browser has no desktop notifications.' : Notification.permission === 'granted' ? 'Desktop notifications are allowed.' : Notification.permission === 'denied' ? 'Desktop notifications are blocked in this browser; the notice and the menu count still show.' : 'Switch it on to allow desktop notifications.';
    // "What you do": the owner's own words about his business, for leads, drafts and research. Up to 600 characters.
    const aboutMark = mark();
    const about = h('textarea', { id: 'about', rows: 3, maxlength: String(ABOUT_MAX), placeholder: 'For example: Payroll software for small firms. HR heads buy it. Pune and Mumbai.', 'aria-label': 'What you do', onchange: (e) => save({ 'business.about': e.target.value }, aboutMark, e.target, was('business.about')) });
    about.value = s['business.about'] || '';
    const aboutBox = h('div', { class: 'line about' }, h('div', null, h('b', null, 'What you do'), h('span', { class: 'd' }, ABOUT_HELP), about, h('span', { class: 'field' }, aboutMark)));
    // how long answers should be: kept by the Chat module (its own routes), saved on change like the fields above
    const lengthLine = () => { const m = mark(); const sel = h('select', { id: 'answer-length', 'aria-label': 'How long answers should be', disabled: true, onchange: (e) => { const t = e.target; m.run(() => api('m/chat/answer-length', { method: 'PUT', body: { value: t.value || null } }).then(() => { t._old = t.value; }), { field: t, old: t._old ?? '' }); } }, [['…', 'Reading…'], ['', 'Not chosen'], ['short', 'Short'], ['detailed', 'Detailed']].map(([v, n]) => h('option', { value: v, hidden: v === '…' }, n))); sel.value = '…';
      // the Chat module answers this; while it is slow the field says so and the rest of the page is already there
      api('m/chat/answer-length').then(r => { sel.value = r.value || ''; sel._old = sel.value; }).catch(() => { sel.value = ''; m.textContent = 'Could not read it now'; m.className = 'saved'; }).finally(() => { sel.disabled = false; }); return line('How long answers should be', 'How your agents write their answers to you', h('span', { class: 'field' }, sel, m)); };
    el.append(h('p', { class: 'sub', id: 'saves-note' }, 'Changes are saved when you leave a field.'),
      card(h('h3', null, 'You'), line('Your name', 'Agents use it when they write for you', text('ownerName', 'Your name')), line('Your business', 'Agents use it when they write in its name', text('companyName', 'Business name')), line('What you mainly use the desk for', 'Renames some places and changes the suggestions', h('span', { class: 'field' }, roleSel, roleMark)), ui.moduleOn('chat') ? lengthLine() : null),
      card(h('h3', null, 'This desk'), line('Name of this desk', 'Shown in the top bar and the window title', text('appName', 'AP Desk')), aboutBox, addressLine(ui), line('About', 'AP Desk is short for Agent Population Desk. On X: @agentpopulation', h('span', { class: 'val' }, '@agentpopulation')), line('Tell me when a job finishes', 'A notice, a count on the menu place and, when the window is in the background, a desktop notification. ' + perm, h('span', { class: 'field' }, notifySw, notifyMark))),
      card(h('h3', null, 'Where you are'), line('Country', 'Two-letter code', text('country', 'US')), line('Currency', 'Money is shown in this currency', text('currency', 'USD')), line('Time zone', 'Times are shown in this zone', text('timeZone', 'Europe/London')), line('Number and date style', 'For example en-GB, en-US', text('locale', 'en-US'))));
  } },
  appearance: { title: 'Appearance', render(el, ui) {
    const { h, card, line, seg } = ui;
    el.append(card(h('h3', null, 'Look'), line('Theme', 'White or black. The sun or moon at the top right does the same.', seg(['White', 'Black'], document.documentElement.dataset.theme === 'dark' ? 1 : 0, (_, i) => ui.setTheme(i === 1))),
      line('Window', 'The desk always fills the window.', h('span', { class: 'val' }, 'Full window'))));
  } },
  people: { title: 'People', render(el, ui) { return peopleSettings(el, ui); } },
  menu: { title: 'Menu', render(el, ui) {
    const { h, btn, sw, card, line, toast } = ui;
    const mark = ui.savedMark();
    const rows = h('div', { class: 'mrows', role: 'list', 'aria-label': 'Menu places' });
    const firstSel = h('select', { id: 'menu-first', 'aria-label': 'The place that opens first' });
    const now = () => cleanMenu(ui.state.settings[MENU_KEY]);
    const save = async (menu, what = 'Saved') => {
      const ok = await mark.run(() => ui.saveMenu(menu), { word: what });
      paint(); return ok;
    };
    // a new order keeps the places of switched-off modules where the owner put them (they come back there)
    const withOrder = (ids) => { const m = now(); return { ...m, order: [...ids, ...m.order.filter(x => !ids.includes(x))] }; };
    let dragId = null;
    const paint = () => {
      const m = now(); const places = arrangeMenu(ui.menuPlaces(), m); const ids = places.map(x => x.id);
      const move = (id, to) => save(withOrder(movePlace(ids, id, to)));
      rows.replaceChildren(...places.map((it, i) => {
        const name = h('input', { type: 'text', value: it.renamed ? it.label : '', placeholder: it.defaultLabel, maxlength: String(NAME_MAX), 'aria-label': `Name for ${it.defaultLabel}`, 'data-place-name': it.id,
          onchange: (e) => { const names = { ...now().names }; const v = e.target.value.trim(); if (v && v !== it.defaultLabel) names[it.id] = v; else delete names[it.id]; save({ ...now(), names }); } });
        const keep = ALWAYS_SHOWN.includes(it.id);
        const shown = keep ? h('span', { class: 'sub mkeep' }, 'Always shown') : sw(!it.hidden, `Show ${it.label} in the menu`, (on) => { const hidden = now().hidden.filter(x => x !== it.id); if (!on) hidden.push(it.id); return save({ ...now(), hidden }); }, { 'data-place-shown': it.id });
        const row = h('div', { class: 'mrow' + (it.hidden ? ' off' : ''), role: 'listitem', draggable: 'true', 'data-place': it.id },
          h('span', { class: 'grip', 'aria-hidden': 'true', title: 'Drag to move' }, '⋮⋮'), name,
          h('span', { class: 'mbtns' }, btn('↑', { kind: 'ghost sm', 'aria-label': `Move ${it.label} up`, disabled: i === 0, onClick: () => move(it.id, -1) }), btn('↓', { kind: 'ghost sm', 'aria-label': `Move ${it.label} down`, disabled: i === places.length - 1, onClick: () => move(it.id, 1) })), shown);
        row.addEventListener('dragstart', (e) => { dragId = it.id; row.classList.add('drag'); try { e.dataTransfer.setData('text/plain', it.id); e.dataTransfer.effectAllowed = 'move'; } catch {} });
        row.addEventListener('dragend', () => { dragId = null; row.classList.remove('drag'); });
        row.addEventListener('dragover', (e) => { if (dragId && dragId !== it.id) { e.preventDefault(); } });
        row.addEventListener('drop', (e) => { e.preventDefault(); const from = dragId || e.dataTransfer?.getData('text/plain'); if (!from || from === it.id) return; const r = row.getBoundingClientRect(); move(from, e.clientY > r.top + r.height / 2 ? { after: it.id } : { before: it.id }); });
        return row;
      }));
      const off = ROLES[ui.state.settings.role]?.off || []; const opens = firstPlace(ui.menuPlaces(), m, off);
      firstSel.replaceChildren(...places.filter(x => !x.hidden && !off.includes(x.id)).map(x => h('option', { value: x.id, selected: x.id === opens }, x.label)));
    };
    firstSel.onchange = (e) => save({ ...now(), first: e.target.value });
    el.append(card(h('h3', null, 'Menu'), h('p', { class: 'sub' }, 'Rename, move, hide or show the places in the top menu. Drag a row, or use the arrows. This changes only the menu: switches, roles and permissions stay as they are.'),
      rows, line('Opens first', 'The place the desk opens on', h('span', { class: 'field' }, firstSel)),
      h('div', { class: 'row', style: { marginTop: '8px' } }, mark, h('span', { class: 'grow' }), btn('Reset to the default menu', { kind: 'ghost sm', id: 'menu-reset', onClick: () => save(null, 'The default menu is back') }))));
    paint(); ui.on('modules', () => setTimeout(paint, 0));
  } },
  security: { title: 'Security', render(el, ui) {
    const { h, api, card, line, btn, toast, fmt, empty } = ui;
    const levels = h('div', { class: 'levels' }), auto = h('div'), pending = h('div'), log = h('div');
    const LV = [['open', 'Open', 'Agents work freely in the workspace. Sending to a person and spending over your limit still ask.'], ['careful', 'Careful', 'Agents ask once per job before writing files or acting in the browser.'], ['strict', 'Strict', 'Agents ask before every action that changes anything.']];
    const paint = async () => {
      const sec = ui.state.security;
      levels.replaceChildren(...LV.map(([id, name, desc]) => h('button', { class: 'level', 'aria-pressed': String(sec.level === id), onclick: async () => { try { await ui.setLevel(id); paint(); } catch (e) { toast(e.message, 'err'); } } }, h('b', null, name), h('span', null, desc))));
      const until = sec.autoApproveUntil;
      auto.replaceChildren(line('Auto-approve', until ? `On until ${fmt.when(until)}. It never covers sending to a person or spending over your limit.` : 'Off. Turn it on for a while when you trust the job in hand.',
        ...[['Off', 0], ['15 minutes', 15], ['1 hour', 60], ['Today', 'today']].map(([label, w]) => btn(label, { kind: 'ghost sm', onClick: async () => { try { await ui.setAutoApprove(w); paint(); } catch (e) { toast(e.message, 'err'); } } }))));
      pending.replaceChildren(...(ui.state.pendingApprovals.length ? ui.state.pendingApprovals.map(ui.approvalCard) : [empty('Nothing is waiting for you.')]));
      try { const a = await api('activity'); log.replaceChildren(...(a.items.length ? a.items.slice(0, 40).map(x => line(x.title || x.action, `${fmt.when(x.at)} · ${x.how || ''}${x.agent_id ? ' · ' + (ui.agent(x.agent_id)?.name || x.agent_id) : ''}`)) : [empty('No activity yet.')])); } catch {}
    };
    el.append(card(h('h3', null, 'Security level'), h('p', { class: 'sub' }, 'Changed only here. No chat message and no other program can change it.'), levels), card(auto), card(h('h3', null, 'Waiting for you'), pending), card(h('h3', null, 'Recent decisions'), log));
    paint(); ui.on('approval', paint); ui.on('security', paint);
  } },
  modules: { title: 'Modules', render(el, ui) {
    const { h, api, card, sw, pill, toast } = ui;
    const list = h('div');
    const paint = () => list.replaceChildren(...ui.state.modules.map(m => h('div', { class: 'line', 'data-card': m.id }, h('div', null, h('b', null, `${m.number ?? ''} ${m.name}`.trim()), h('span', { class: 'd' }, m.description + (m.error ? ` · ${m.error}` : ''))),
      m.kind === 'core' ? pill('Core', 'ok') : m.kind === 'parked' ? pill('Parked') : sw(m.on, m.name, async (on) => { await api(`modules/${m.id}/${on ? 'on' : 'off'}`, { method: 'POST' }); await ui.refresh(); toast(`${m.name} is ${on ? 'on' : 'off'}`, 'ok'); paint(); }, { 'data-module': m.id }))));
    el.append(card(h('h3', null, 'Modules'), h('p', { class: 'sub' }, 'Core modules stay on. Switch the others on when you want them.'), list));
    paint(); ui.on('modules', async () => { await ui.refresh(); paint(); });
  } },
};

export async function settingsPage(el, ui) {
  const { h } = ui;
  el.classList.add('scroll');
  // sections: core, then every on module's `settings` export (same id replaces the core one)
  const collect = async () => {
    const sections = { ...coreSettingsSections };
    for (const m of ui.state.modules) {
      if (!m.on || !m.hasUi || !(m.settings || []).length) continue;
      const mod = await ui.moduleUi(m.id);
      // the owner's own name for the place wins (Settings › Menu rename), so the side list and heading follow a rename
      for (const s of m.settings) if (mod.settings?.[s.id]) sections[s.id] = { title: ui.label(s.id, s.label || mod.settings[s.id].title), render: mod.settings[s.id].render, module: m.id };
    }
    return sections;
  };
  let sections = await collect();
  const want = ui.state.route.parts[0] || 'general';
  const menu = h('div', { class: 'list' }), body = h('div', { class: 'stack' });
  el.append(h('h2', null, 'Settings'), h('div', { class: 'split' }, menu, body));
  const paintMenu = () => {
    const ids = [...ORDER, ...Object.keys(sections).filter(k => !ORDER.includes(k))];
    menu.replaceChildren(...ids.map(id => h('button', { class: 'nav', 'data-section': id, 'aria-current': id === want ? 'page' : null, onclick: () => ui.go('settings', id) }, sections[id]?.title || TITLES[id] || id)));
  };
  paintMenu();
  const shownBy = sections[want]?.module || (sections[want] ? 'core' : null);
  // A module switched on or off: the menu is redrawn in place and the section on screen stays (its own listener
  // updates its cards). Only when the section on screen changes hands is it drawn again.
  el._onModules = async () => {
    sections = await collect();
    const now = sections[want]?.module || (sections[want] ? 'core' : null);
    if (now !== shownBy) return 'render';
    paintMenu(); return 'kept';
  };
  const sec = sections[want];
  if (sec) await sec.render(body, ui);
  else {
    const need = NEEDS[want]; const m = ui.state.modules.find(x => x.id === need);
    body.append(h('div', { class: 'card' }, h('h3', null, TITLES[want] || want), h('p', { class: 'sub' }, m ? (m.on ? `${m.name} is on but has not added its settings.` : `${m.name} is switched off. Switch it on in Modules to use this.`) : 'This part is not installed.'),
      m && !m.on && m.kind !== 'core' ? ui.btn(`Switch on ${m.name}`, { onClick: async () => { try { await ui.api(`modules/${m.id}/on`, { method: 'POST' }); await ui.refresh(); ui.render(); } catch (e) { ui.toast(e.message, 'err'); } } }) : null));
  }
  // Security: the code for another browser, whoever draws the rest of the section
  if (want === 'security') { const c = pairCard(ui); body.children[1] ? body.insertBefore(c, body.children[1]) : body.append(c); }   // under the security level
  // the update dot in the top bar: #/settings/backup?at=updates opens at the Updates card
  if (ui.state.route.params.at === 'updates') body.querySelector('[data-updates]')?.scrollIntoView({ block: 'start' });
  // #/settings/modules?module=network: straight to that module's card, its switch focused
  const target = ui.state.route.params.module;
  if (target) {
    const card = body.querySelector(`[data-card="${CSS.escape(target)}"]`);
    if (card) { card.scrollIntoView({ block: 'center' }); (card.querySelector('[data-module]') || card).focus({ preventScroll: true }); card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600); }
  }
}
