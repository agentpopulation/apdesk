// Settings frame, owned by the shell. Core sections live here; a module's ui.js `settings` export adds sections or
// replaces a core one with the same id (the Safety, Backup, Store, Vault and other modules do that).
import { ROLES } from '/ui/pages/home.js';

export const ABOUT_MAX = 600;
export const ABOUT_HELP = 'What you sell, who buys it, and where. Your agents use this for leads, drafts and research.';

const ORDER = ['general', 'appearance', 'security', 'modules', 'accounts', 'keys', 'channels', 'payments', 'network', 'memory', 'backup'];
const TITLES = { general: 'General', appearance: 'Appearance', security: 'Security', modules: 'Modules', accounts: 'Accounts and lock', keys: 'Keys and logins', channels: 'Channels and mail', payments: 'Payments and spend', network: 'Network', memory: 'Memory', backup: 'Backup' };
const NEEDS = { accounts: 'accounts', keys: 'vault', channels: 'channels', payments: 'payments', network: 'network', memory: 'memory', backup: 'backup' };

export const coreSettingsSections = {
  general: { title: 'General', render(el, ui) {
    const { h, api, card, line } = ui; const s = ui.state.settings;
    // Every field here saves by itself when the owner leaves it (or presses Enter): a short "Saved" beside it says so,
    // or the reason in plain words when it did not save.
    const save = async (patch, mark) => {
      try {
        const r = await api('settings', { body: patch }); ui.state.settings = r.settings; ui.setPrefs(r.settings); await ui.refresh();
        if (mark) { mark.textContent = 'Saved'; mark.className = 'saved ok'; clearTimeout(mark._t); mark._t = setTimeout(() => { mark.textContent = ''; }, 2000); }
        return true;
      } catch (e) { if (mark) { clearTimeout(mark._t); mark.textContent = 'Not saved: ' + e.message; mark.className = 'saved err'; } else ui.toast(e.message, 'err'); return false; }
    };
    const mark = () => h('span', { class: 'saved', role: 'status', 'aria-live': 'polite' });
    const text = (key, ph) => { const m = mark(); return h('span', { class: 'field' }, h('input', { type: 'text', value: s[key] ?? '', placeholder: ph, 'data-key': key, onchange: (e) => save({ [key]: e.target.value }, m) }), m); };
    const roleMark = mark();
    const roleSel = h('select', { onchange: async (e) => { if (await save({ role: e.target.value || null, onboarded: true }, roleMark)) setTimeout(() => location.reload(), 700); } }, h('option', { value: '' }, 'Everything'), Object.entries(ROLES).map(([id, r]) => h('option', { value: id, selected: s.role === id }, r.name)));
    const notifyOn = s.notifications !== false;
    const canAsk = typeof Notification !== 'undefined';
    const notifyMark = mark();
    const notifySw = ui.sw(notifyOn, 'Tell me when a job finishes', async (on) => { await save({ notifications: on }, notifyMark); if (on && canAsk && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} } });
    const perm = !canAsk ? 'This browser has no desktop notifications.' : Notification.permission === 'granted' ? 'Desktop notifications are allowed.' : Notification.permission === 'denied' ? 'Desktop notifications are blocked in this browser; the notice and the menu count still show.' : 'Switch it on to allow desktop notifications.';
    // "What you do": the owner's own words about his business, for leads, drafts and research. Up to 600 characters.
    const aboutMark = mark();
    const about = h('textarea', { id: 'about', rows: 3, maxlength: String(ABOUT_MAX), placeholder: 'For example: Payroll software for small firms. HR heads buy it. Pune and Mumbai.', 'aria-label': 'What you do', onchange: (e) => save({ 'business.about': e.target.value }, aboutMark) });
    about.value = s['business.about'] || '';
    const aboutBox = h('div', { class: 'line about' }, h('div', null, h('b', null, 'What you do'), h('span', { class: 'd' }, ABOUT_HELP), about, h('span', { class: 'field' }, aboutMark)));
    el.append(h('p', { class: 'sub', id: 'saves-note' }, 'Changes are saved when you leave a field.'),
      card(h('h3', null, 'You'), line('Your name', 'Agents use it when they write for you', text('ownerName', 'Your name')), line('Your business', 'Agents use it when they write in its name', text('companyName', 'Business name')), line('What you mainly use the desk for', 'Renames some places and changes the suggestions', h('span', { class: 'field' }, roleSel, roleMark))),
      card(h('h3', null, 'This desk'), line('Name of this desk', 'Shown in the top bar and the window title', text('appName', 'AP Desk')), aboutBox, line('About', 'AP Desk is short for Agent Population Desk. On X: @agentpopulation', h('span', { class: 'val' }, '@agentpopulation')), line('Tell me when a job finishes', 'A notice, a count on the menu place and, when the window is in the background, a desktop notification. ' + perm, h('span', { class: 'field' }, notifySw, notifyMark))),
      card(h('h3', null, 'Where you are'), line('Country', 'Two-letter code', text('country', 'US')), line('Currency', 'Money is shown in this currency', text('currency', 'USD')), line('Time zone', 'Times are shown in this zone', text('timeZone', 'Europe/London')), line('Number and date style', 'For example en-GB, en-US', text('locale', 'en-US'))));
  } },
  appearance: { title: 'Appearance', render(el, ui) {
    const { h, card, line, seg } = ui;
    el.append(card(h('h3', null, 'Look'), line('Theme', 'White or black. The toggle at the top right does the same.', seg(['White', 'Black'], document.documentElement.dataset.theme === 'dark' ? 1 : 0, (_, i) => ui.setTheme(i === 1))),
      line('Window', 'The desk always fills the window.', h('span', { class: 'val' }, 'Full window'))));
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
    const paint = () => list.replaceChildren(...ui.state.modules.map(m => h('div', { class: 'line' }, h('div', null, h('b', null, `${m.number ?? ''} ${m.name}`.trim()), h('span', { class: 'd' }, m.description + (m.error ? ` · ${m.error}` : ''))),
      m.kind === 'core' ? pill('Core', 'ok') : m.kind === 'parked' ? pill('Parked') : sw(m.on, m.name, async (on) => { await api(`modules/${m.id}/${on ? 'on' : 'off'}`, { method: 'POST' }); await ui.refresh(); toast(`${m.name} is ${on ? 'on' : 'off'}`, 'ok'); }))));
    el.append(card(h('h3', null, 'Modules'), h('p', { class: 'sub' }, 'Core modules stay on. Switch the others on when you want them.'), list));
    paint(); ui.on('modules', async () => { await ui.refresh(); paint(); });
  } },
};

export async function settingsPage(el, ui) {
  const { h } = ui;
  el.classList.add('scroll');
  // sections: core, then every on module's `settings` export (same id replaces the core one)
  const sections = { ...coreSettingsSections };
  for (const m of ui.state.modules) {
    if (!m.on || !m.hasUi || !(m.settings || []).length) continue;
    const mod = await ui.moduleUi(m.id);
    for (const s of m.settings) if (mod.settings?.[s.id]) sections[s.id] = { title: s.label || mod.settings[s.id].title, render: mod.settings[s.id].render, module: m.id };
  }
  const ids = [...ORDER, ...Object.keys(sections).filter(k => !ORDER.includes(k))];
  const want = ui.state.route.parts[0] || 'general';
  const menu = h('div', { class: 'list' }), body = h('div', { class: 'stack' });
  el.append(h('h2', null, 'Settings'), h('div', { class: 'split' }, menu, body));
  menu.replaceChildren(...ids.map(id => h('button', { class: 'nav', 'aria-current': id === want ? 'page' : null, onclick: () => ui.go('settings', id) }, sections[id]?.title || TITLES[id] || id)));
  const sec = sections[want];
  if (sec) await sec.render(body, ui);
  else {
    const need = NEEDS[want]; const m = ui.state.modules.find(x => x.id === need);
    body.append(h('div', { class: 'card' }, h('h3', null, TITLES[want] || want), h('p', { class: 'sub' }, m ? (m.on ? `${m.name} is on but has not added its settings.` : `${m.name} is switched off. Switch it on in Modules to use this.`) : 'This part is not installed.'),
      m && !m.on && m.kind !== 'core' ? ui.btn(`Switch on ${m.name}`, { onClick: async () => { try { await ui.api(`modules/${m.id}/on`, { method: 'POST' }); await ui.refresh(); location.reload(); } catch (e) { ui.toast(e.message, 'err'); } } }) : null));
  }
}
