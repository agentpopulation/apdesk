// Settings › Modules: the Module Store. Replaces the shell's plain list (same section id).
// Built-in and custom modules, a filter, Add a module, Build your own module and Add a skill from a file (ui-add.js).
import { GROUPS, merge, FILTERS, passes } from './ui-catalog.js';
import { addModule, buildOwn, addSkill, removeModule, showResult } from './ui-add.js';

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

const FROM = { file: 'Added from a file', 'built here': 'Built here in the Store', 'built with a model': 'Built here, written with a model', 'by hand': 'Put in the modules folder by hand' };
/** The quiet tag beside a custom module's name: small, not bold. */
const customTag = (h) => h('span', { class: 'pill', 'data-custom-tag': '', style: { fontSize: '11px', fontWeight: '400', padding: '0 7px' } }, 'Custom');

function moduleCard(m, all, ui, repaint) {
  const { h, pill, sw, toast, api, btn, fmt } = ui;
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
    h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'pill' }, String(m.number ?? '')), h('b', { style: { minWidth: 0 } }, m.name), m.custom ? customTag(h) : null, h('span', { class: 'grow' }), pill(st, stKind), control),
    m.description ? h('div', { class: 'sub' }, m.description) : null,
    m.custom ? h('div', { class: 'sub', 'data-added': m.id }, [FROM[m.added?.from] || FROM['by hand'], m.added?.at ? fmt.when(m.added.at) : null, m.added?.label?.signed || (m.added?.signedBy ? `Signed by ${m.added.signedBy}.` : 'Not signed.')].filter(Boolean).join(' · ')) : null,
    m.custom && (m.hosts || []).length ? h('div', { class: 'sub' }, 'Outside addresses it may reach: ' + (m.hosts.includes('*') ? 'any address you type in' : m.hosts.join(', ')) + '.') : null,
    m.restart ? h('div', { class: 'sub', style: { color: 'var(--slow)' } }, 'A new copy is in place: restart the desk to run it.') : null,
    m.error ? h('div', { class: 'sub', style: { color: 'var(--stop)' } }, 'Why: ' + m.error) : null,
    (m.requires || []).length ? h('div', { class: 'sub' }, `Needs ${m.requires.map(name).join(', ')}${missing.length && !m.on ? ' switched on first' : ''}.`) : null,
    adds.length ? h('div', { class: 'sub' }, 'Adds ' + adds.join('; ') + '.') : (m.installed ? h('div', { class: 'sub' }, 'Works in the background; adds no place of its own.') : null),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, status ? pill(status[0], status[1]) : (m.installed ? pill('Status not given') : null)),
    details.length ? h('details', { 'data-details': m.id }, h('summary', { class: 'sub', style: { cursor: 'pointer' } }, 'Details'), ...details) : null,
    m.custom && !ui.storeState?.incognito ? h('div', { class: 'row' }, h('span', { class: 'grow' }), btn('Remove', { kind: 'ghost sm', 'data-remove': m.id, onClick: () => removeModule(ui, m, repaint) })) : null);
}

export const settings = {
  modules: { title: 'Modules', async render(el, ui) {
    const { h, card, btn, seg } = ui;
    const q = h('input', { type: 'search', placeholder: 'Find a module', 'aria-label': 'Find a module', style: { width: '220px', maxWidth: '100%' } });
    const body = h('div', { class: 'stack' });
    let filter = 'all';
    const filterSeg = seg(FILTERS.map(f => f[1]), 0, (o, i) => { filter = FILTERS[i][0]; repaint(); });
    filterSeg.setAttribute('aria-label', 'Show');
    const tools = h('div', { class: 'stack', 'data-store-add': '' });
    const requests = h('div', { class: 'stack', 'data-requests': '' });
    let st = { incognito: false, requests: [], honest: '', onlyFrom: '', kit: null, limits: { zip: 5242880 } };
    const load = async () => { try { st = await ui.api('m/store/state'); } catch { /* the Store's own routes are part of the core; the list still shows */ } ui.storeState = st; paintTools(); };
    const after = async () => { await ui.refresh(); await load(); repaint(); };
    const WORDS = { checked: 'Checked, not asked yet', waiting: 'Waiting for the Admin', added: 'Added', denied: 'The Admin said no', ended: 'Ended when the desk restarted', failed: 'Could not be added' };
    function paintTools() {
      tools.replaceChildren(st.incognito
        ? h('p', { class: 'sub', 'data-incognito': '' }, 'You are in Incognito: modules and skills are not added, built or removed here, because Incognito keeps nothing. Leave Incognito to add one.')
        : h('div', { class: 'stack' },
          h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
            btn('Add a module', { onClick: () => addModule(ui, st, after) }),
            btn('Build your own module', { kind: 'ghost', onClick: () => buildOwn(ui, st, after) }),
            btn('Add a skill from a file', { kind: 'ghost', onClick: () => addSkill(ui, st) })),
          h('p', { class: 'sub', 'data-only-from': '' }, st.onlyFrom + ' A check reads the files; it cannot prove a module is harmless. Anyone at this desk may ask; the Admin of this PC approves every module before it is added.')));
      const open = st.requests.filter(r => r.state !== 'added' || r.restart);
      requests.replaceChildren(...(open.length ? [h('h3', { style: { marginTop: '6px' } }, 'Your requests'), ...open.map(r => h('div', { class: 'line', 'data-request': r.rid },
        h('div', null, h('span', null, r.name), h('span', { class: 'd' }, [WORDS[r.state] || r.state, r.state === 'added' && r.restart ? 'restart the desk to run the new copy' : null, r.yellow ? `${r.yellow} yellow line${r.yellow === 1 ? '' : 's'}` : null, r.why].filter(Boolean).join(' · '))),
        h('div', { class: 'row', style: { gap: '6px' } },
          ['checked', 'denied', 'ended'].includes(r.state) ? btn('Show the check', { kind: 'ghost sm', onClick: () => showResult(ui, { refused: false, request: r }, st, after) }) : null,
          r.state !== 'waiting' && r.state !== 'added' ? btn('Take off the list', { kind: 'ghost sm', onClick: async () => { try { await ui.api(`m/store/requests/${r.rid}/drop`, { method: 'POST' }); await load(); } catch (e) { ui.toast(e.message, 'err'); } } }) : null)))] : []));
    }
    const repaint = () => {
      const all = merge(ui.state.modules);
      const text = q.value.trim().toLowerCase();
      const shown = all.filter(m => passes(m, filter) && (!text || (m.name + ' ' + (m.description || '')).toLowerCase().includes(text)));
      if (!shown.length) { body.replaceChildren(h('div', { class: 'empty', 'data-empty': '' }, filter === 'custom' && !text ? 'No custom modules yet. Add one from a zip, or build your own above.' : 'No module matches. Clear the search or choose All.')); return; }
      body.replaceChildren(...GROUPS.map(([kind, title, desc]) => {
        const list = shown.filter(m => (m.kind || 'switch-on') === kind);
        const total = filter === 'all' && !text ? all.filter(m => (m.kind || 'switch-on') === kind).length : list.length;
        if (!list.length) return null;
        return h('div', { class: 'stack', 'data-group': kind },
          h('div', { class: 'row' }, h('h3', null, `${title} (${total})`), h('span', { class: 'grow' }), h('span', { class: 'sub' }, desc)),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: '10px', alignItems: 'start' } }, list.map(m => moduleCard(m, all, ui, repaint))));
      }).filter(Boolean));
    };
    q.addEventListener('input', repaint);
    el.append(card(h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, h('div', { style: { minWidth: 'min(100%, 260px)', flex: '1 1 260px' } }, h('h3', null, 'Module Store'), h('p', { class: 'sub' }, 'Core modules stay on. Switch the others on when you want them: their places, settings and tools appear at once, and go when you switch them off.')), filterSeg, q), tools, requests), body);
    repaint(); await load();
    ui.on('modules', async () => { await ui.refresh(); await load(); repaint(); });
    // a request waits for the Admin, who may decide in another window: the desk sends 'store' the moment he does
    ui.on('store', () => after());
  } },
};
