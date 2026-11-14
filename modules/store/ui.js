// Settings › Modules: the Module Store. Replaces the shell's plain list (same section id).
import { GROUPS, merge } from './ui-catalog.js';

const OFFICIAL_PAGES = { chat: 'Chat', research: 'Research', tasks: 'Tasks', sales: 'Sales', files: 'Files', agents: 'Agents', models: 'Models' };
const STATUS = { works: ['Works', 'ok'], partial: ['Partly works', 'wait'], stub: ['Placeholder', ''] };

function state(m) {
  if (!m.installed) return ['Not in this build', ''];
  if (m.kind === 'parked') return ['Parked', ''];
  if (m.error) return ['Failed to start', 'stop'];
  if (m.on) return ['On', 'ok'];
  if (m.wanted && !m.on) return ['Waiting for another module', 'wait'];
  return ['Off', ''];
}

function moduleCard(m, all, ui, repaint) {
  const { h, pill, sw, toast, api } = ui;
  const name = (id) => all.find(x => x.id === id)?.name || id;
  const [st, stKind] = state(m);
  const adds = [];
  for (const it of m.menu || []) adds.push(`a place in the menu: ${it.label}`);
  for (const s of m.settings || []) adds.push(`Settings › ${s.label}`);
  for (const t of m.agentTabs || []) adds.push(`an agent tab: ${t[0].toUpperCase() + t.slice(1)}`);
  // pages the owner can open: the official menu places by name, anything else as "a page" (unless its menu entry already says it)
  const inMenu = new Set((m.menu || []).map(it => it.id));
  for (const pg of m.pages || []) if (!inMenu.has(pg)) adds.unshift(OFFICIAL_PAGES[pg] ? `the ${OFFICIAL_PAGES[pg]} page` : 'a page');
  if ((m.tools || []).length) adds.push(`${m.tools.length} tool${m.tools.length > 1 ? 's' : ''} for agents`);
  const details = [];
  if ((m.tools || []).length) details.push(h('div', { class: 'sub', style: { fontSize: '11.5px' } }, 'Tools for agents: ' + m.tools.join(', ')));
  for (const a of m.attribution || []) details.push(h('div', { class: 'sub', style: { fontSize: '11.5px' } }, a));
  const status = STATUS[m.status];
  let control;
  if (!m.installed || m.kind === 'parked') control = null;
  else if (m.kind === 'core') control = pill('Core', 'ok');
  else control = sw(m.on, `Switch ${m.name} ${m.on ? 'off' : 'on'}`, async (on) => {
    try { await api(`modules/${m.id}/${on ? 'on' : 'off'}`, { method: 'POST' }); }
    catch (e) { toast(e.message, 'err'); await ui.refresh(); repaint(); return false; }
    await ui.refresh(); toast(`${m.name} is ${on ? 'on' : 'off'}`, 'ok'); repaint();
  }, { 'data-module': m.id });
  const missing = (m.requires || []).filter(r => !all.find(x => x.id === r)?.on);
  return h('div', { class: 'card', 'data-card': m.id, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'pill' }, String(m.number ?? '')), h('b', { style: { minWidth: 0 } }, m.name), h('span', { class: 'grow' }), pill(st, stKind), control),
    m.description ? h('div', { class: 'sub' }, m.description) : null,
    m.error ? h('div', { class: 'sub', style: { color: 'var(--stop)' } }, 'Why: ' + m.error) : null,
    (m.requires || []).length ? h('div', { class: 'sub' }, `Needs ${m.requires.map(name).join(', ')}${missing.length && !m.on ? ' switched on first' : ''}.`) : null,
    adds.length ? h('div', { class: 'sub' }, 'Adds ' + adds.join('; ') + '.') : (m.installed ? h('div', { class: 'sub' }, 'Works in the background; adds no place of its own.') : null),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, status ? pill(status[0], status[1]) : (m.installed ? pill('Status not given') : null)),
    details.length ? h('details', { 'data-details': m.id }, h('summary', { class: 'sub', style: { cursor: 'pointer' } }, 'Details'), ...details) : null);
}

export const settings = {
  modules: { title: 'Modules', async render(el, ui) {
    const { h, card } = ui;
    const q = h('input', { type: 'search', placeholder: 'Find a module', style: { width: '220px' } });
    const body = h('div', { class: 'stack' });
    const repaint = () => {
      const all = merge(ui.state.modules);
      const text = q.value.trim().toLowerCase();
      const shown = all.filter(m => !text || (m.name + ' ' + (m.description || '')).toLowerCase().includes(text));
      body.replaceChildren(...GROUPS.map(([kind, title, desc]) => {
        const list = shown.filter(m => (m.kind || 'switch-on') === kind);
        const total = all.filter(m => (m.kind || 'switch-on') === kind).length;
        if (!list.length) return null;
        return h('div', { class: 'stack', 'data-group': kind },
          h('div', { class: 'row' }, h('h3', null, `${title} (${total})`), h('span', { class: 'grow' }), h('span', { class: 'sub' }, desc)),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: '10px', alignItems: 'start' } }, list.map(m => moduleCard(m, all, ui, repaint))));
      }).filter(Boolean));
    };
    q.addEventListener('input', repaint);
    el.append(card(h('div', { class: 'row' }, h('div', null, h('h3', null, 'Module Store'), h('p', { class: 'sub' }, 'Core modules stay on. Switch the others on when you want them: their places, settings and tools appear at once, and go when you switch them off.')), h('span', { class: 'grow' }), q)), body);
    repaint();
    ui.on('modules', async () => { await ui.refresh(); repaint(); });
  } },
};
