// Agents page: the team as cards on the left, the chosen agent in the work panel on the right with tabs.
// Tabs in order: Profile, Model (models module), Tools and skills, Memory (memory module), Computer (browser module).
// The cause of "the agent profile looks so basic": a letter in a circle and bare rows. Now each agent has a drawn avatar
// (ui-avatars.js) and the Profile tab is four cards: who it is, what it always does, what it is good at, what it did lately.
import { AVATARS, COLOURS, LETTER, MOTION_KEY, avatarEl as drawAvatar, avatarValue, defaultAvatar, setAvatarMotion } from './ui-avatars.js';

const API = 'm/agents/';
const TAB_ORDER = [['profile', 'Profile', 'agents'], ['model', 'Model', 'models'], ['tools', 'Tools and skills', 'agents'], ['memory', 'Memory', 'memory'], ['computer', 'Computer', 'browser']];
const JOB_WORDS = { running: ['Running', 'run'], waiting: ['Waiting for you', 'slow'], done: ['Done', 'live'], failed: ['Failed', 'fail'], stopped: ['Stopped', 'off'], interrupted: ['Stopped', 'off'] };

export const pages = { agents: { title: 'Agents', render } };
export const agentTabs = {
  profile: { title: 'Profile', render: profileTab },
  tools: { title: 'Tools and skills', render: toolsTab },
};

/** The avatar element for an agent, for any page: avatarEl(agent, '' | 's' | 'l', state?). Marked with the agent's id so a new choice shows at once.
 *  state (optional): 'working' | 'waiting' | 'idle' | 'failed', or { state }; with none the avatar is calm and its eyes stay alive. */
export function avatarEl(agent, size = '', state = null) { const el = drawAvatar(agent, size, null, state); el.dataset.agent = agent?.id || ''; return el; }
const STATE_OF = { run: 'working', slow: 'waiting', fail: 'failed', live: 'idle', off: 'idle' };   // the Agents page's own status classes
const repaintAvatars = (a) => { for (const el of document.querySelectorAll('.agav[data-agent]')) if (el.dataset.agent === a.id) el.replaceWith(avatarEl(a, ['s', 'l'].find(c => el.classList.contains(c)) || '', el.dataset.state || null)); };

async function render(el, ui, route) {
  const { h, api, btn, pill, toast, statusChip } = ui;
  el.classList.add('scroll', 'agp');
  const list = h('div', { class: 'stack alist', id: 'a-list' });
  const off = h('div', { class: 'stack', id: 'a-off' });   // built-in agents not on the team, one click to hire back
  const det = h('div', { class: 'work', id: 'a-det' });
  const count = pill('', 'brand');
  const busy = statusChip('', 'run'); busy.hidden = true;
  el.append(
    h('div', { class: 'phead' },
      h('div', { class: 't' }, h('div', { class: 'row' }, h('h2', null, 'Agents'), count, busy), h('p', { class: 'sub' }, 'Your team. Each agent has its own model, tools, memory and browser.')),
      btn('Hire an agent', { onClick: () => hire(ui, (a) => { ui.go('agents', a.id, 'profile'); }) })),
    h('div', { class: 'agrid' }, h('div', { class: 'stack' }, h('div', { class: 'lbl' }, 'On your team'), list, off), det));
  let alive = true; let cleanupTab = null;
  ui.onLeave(() => { alive = false; try { cleanupTab?.(); } catch {} });
  let agents = []; let jobs = [];
  const pickId = () => route?.parts?.[0] && agents.some(a => a.id === route.parts[0]) ? route.parts[0] : (agents[1] || agents[0])?.id;
  const tabs = () => TAB_ORDER.filter(([id, , mod]) => mod === 'agents' || (ui.moduleOn(mod) && (ui.state.modules.find(m => m.id === mod)?.agentTabs || []).includes(id)));
  /** [chip kind, short state, longer state for the header] */
  const jobLine = (a) => {
    const run = jobs.find(j => j.agentId === a.id && j.status === 'running'); const wait = jobs.find(j => j.agentId === a.id && j.status === 'waiting');
    const pend = ui.state.pendingApprovals.filter(x => x.agentId === a.id).length;
    if (wait || pend) return ['slow', `Waiting for you${pend > 1 ? ' · ' + pend : ''}`, wait ? `Waiting for you on ${wait.title}` : 'Waiting for you to approve a step'];
    if (run) return ['run', 'Working', `Working on ${run.title}`];
    return ['off', 'Idle', 'Idle, ready for a task'];
  };
  const modelWords = (a) => a.model?.main ? (a.model.main.model || a.model.main.provider || 'Its own model') : 'Desk default';
  async function load() {
    let gone = [];
    try { [agents, jobs, gone] = await Promise.all([api('agents').then(r => r.agents), api('jobs?limit=60').then(r => r.jobs).catch(() => []), api(API + 'retired').then(r => r.agents).catch(() => [])]); ui.state.agents = agents; } catch (e) { toast(e.message, 'err'); return; }
    if (!alive) return;
    count.textContent = `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`;
    const working = agents.filter(a => jobLine(a)[0] === 'run').length;
    busy.hidden = !working; busy.textContent = `${working} working`;
    const cur = pickId();
    list.replaceChildren(...agents.map(a => { const [cls, txt] = jobLine(a); return h('button', { class: 'card hov acard' + (a.id === cur ? ' sel' : ''), type: 'button', 'aria-current': a.id === cur ? 'true' : null, onclick: () => ui.go('agents', a.id, route?.parts?.[1] || 'profile') },
      avatarEl(a, '', STATE_OF[cls]),
      h('span', { class: 'ac-t' }, h('span', { class: 'ac-n' }, h('b', null, a.name), statusChip(txt, cls)), h('span', { class: 'sub ac-r' }, a.role || 'No role yet'), h('span', { class: 'ac-m', title: 'The model it answers with' }, modelWords(a)))); }));
    off.replaceChildren(...(gone.length ? [h('div', { class: 'lbl', style: { marginTop: '6px' } }, 'Not on your team'), ...gone.map(a => h('div', { class: 'card acard offc' },
      avatarEl(a, 's'),
      h('span', { class: 'ac-t' }, h('b', null, a.name), h('span', { class: 'sub ac-r' }, a.role || '')),
      btn('Hire', { kind: 'ghost sm', 'aria-label': 'Hire ' + a.name, onClick: () => hireBack(a) })))] : []));
    const sel = list.querySelector('.sel'); if (sel && list.scrollWidth > list.clientWidth) list.scrollLeft = sel.offsetLeft - list.offsetLeft - 8;   // narrow window: the chosen agent in view in the row
    await paintDetail(cur);
  }
  async function hireBack(a) {
    try {
      const r = await api(API + 'retired/' + encodeURIComponent(a.id) + '/hire', { method: 'POST', body: {} });
      if (ui.moduleOn('chat')) await api('m/chat/rooms/fit', { method: 'POST' });   // the same call first start makes; a room with two of its agents on comes back
      toast(r.message || `${a.name} joined your team.`, 'ok'); ui.go('agents', a.id, 'profile');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function paintDetail(id) {
    const a = agents.find(x => x.id === id); if (!a) { det.replaceChildren(ui.empty('No agents yet.')); return; }
    const avail = tabs();
    const tabId = avail.some(t => t[0] === route?.parts?.[1]) ? route.parts[1] : 'profile';
    const [cls, , long] = jobLine(a);
    const body = h('div', { class: 'work-body' });
    // the shared tab bar; it keeps the "seg" class the page checks look for
    const bar = h('div', { class: 'tabbar seg', role: 'tablist' }, avail.map(t => h('button', { type: 'button', role: 'tab', 'aria-selected': String(t[0] === tabId), 'aria-pressed': String(t[0] === tabId), onclick: () => ui.go('agents', a.id, t[0]) }, t[1])));
    det.replaceChildren(
      h('div', { class: 'work-head' }, avatarEl(a, 'l', STATE_OF[cls]),
        h('div', { class: 'wh-t' }, h('h3', null, a.name), h('div', { class: 'sub' }, a.role || 'No role yet'), h('div', null, statusChip(long, cls))),
        h('span', { class: 'grow' }),
        h('div', { class: 'row' }, a.id !== 'coordinator' ? btn('Retire', { kind: 'ghost', onClick: () => retire(a) }) : null, btn('Chat', { onClick: () => ui.go('chat', 'dm-' + a.id) }))),
      bar, body);
    try { cleanupTab?.(); } catch {} cleanupTab = null;
    const t = avail.find(x => x[0] === tabId);
    try {
      let def = agentTabs[tabId];
      if (t[2] !== 'agents') { const mod = await ui.moduleUi(t[2]); def = mod.agentTabs?.[tabId]; }
      if (!def) { body.replaceChildren(ui.empty(`${t[1]} could not open.`)); return; }
      const out = await def.render(body, ui, a);
      if (typeof out === 'function') cleanupTab = out;
    } catch (e) { console.error(e); body.replaceChildren(ui.empty(`${t[1]} hit an error: ${e.message}`)); }
  }
  async function retire(a) {
    if (!await ui.confirm(`Retire ${a.name}? Its chats and files stay; it stops taking work.`, { ok: 'Retire', kind: 'stop' })) return;
    try { await api(API + 'agents/' + encodeURIComponent(a.id), { method: 'DELETE' }); toast(`${a.name} retired.`); ui.go('agents'); } catch (e) { toast(e.message, 'err'); }
  }
  let t = null; const soon = () => { clearTimeout(t); t = setTimeout(() => alive && load(), 300); };
  ui.on('agents', (d) => { if (d?.change !== 'update') soon(); else { clearTimeout(t); t = setTimeout(async () => { if (!alive) return; try { agents = (await api('agents')).agents; ui.state.agents = agents; count.textContent = `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`; } catch {} }, 300); } });
  ui.on('job', (j) => { if (j?.status && j.status !== 'running') soon(); });
  await load();
}

// ---------- Profile: four cards. Text fields are saved through the core route PATCH /api/agents/:id, each with its tick.
async function profileTab(el, ui, agent) {
  const { h, api, btn, savedMark, statusChip, fmt } = ui;
  let a = agent;
  const patch = async (p) => { a = await api('agents/' + encodeURIComponent(a.id), { method: 'PATCH', body: p }); const i = ui.state.agents?.findIndex(x => x.id === a.id); if (i >= 0) ui.state.agents[i] = a; return a; };

  /** One field with Edit in place: the value as text; Edit opens a box with Save and Cancel; the tick answers the save. */
  const field = (label, key, { multiline = false, empty = 'Not set', quote = false } = {}) => {
    const mark = savedMark();
    const wrap = h('div', { class: 'pf' });
    const show = () => {
      const v = a[key] || '';
      wrap.replaceChildren(h('div', { class: 'pf-h' }, h('span', { class: 'pf-l' }, label), mark, h('span', { class: 'grow' }), btn(key === 'name' ? 'Rename' : 'Edit', { kind: 'ghost sm', 'aria-label': `${key === 'name' ? 'Rename' : 'Edit'} ${label.toLowerCase()}`, onClick: edit })),
        h('div', { class: 'pf-v' + (v ? '' : ' none') + (multiline ? ' long' : '') }, v ? (quote ? `"${v}"` : v) : empty));
    };
    const edit = () => {
      const box = multiline ? h('textarea', { rows: key === 'instructions' ? 6 : 3 }, a[key] || '') : h('input', { type: 'text', value: a[key] || '', maxlength: key === 'name' ? 40 : 200 });
      const save = async () => {
        const v = box.value.trim();
        if (key === 'name' && !v) { mark.fail('a name cannot be empty'); box.focus(); return; }
        if (v === (a[key] || '')) { show(); return; }
        const ok = await mark.run(() => patch({ [key]: v }));
        if (ok) { show(); if (key === 'name' || key === 'role') ui.toast(`${label} saved. The next reply uses it.`, 'ok'); }
      };
      box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); show(); } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });
      wrap.replaceChildren(h('div', { class: 'pf-h' }, h('span', { class: 'pf-l' }, label), mark), box,
        h('div', { class: 'row' }, btn('Save', { kind: 'sm', onClick: save }), btn('Cancel', { kind: 'ghost sm', onClick: show }), multiline ? h('span', { class: 'sub' }, 'The next reply uses it.') : null));
      setTimeout(() => { box.focus(); box.setSelectionRange?.(box.value.length, box.value.length); }, 20);
    };
    show(); return wrap;
  };

  // how it looks: a small grid of drawings and a row of colours; a choice saves at once and shows everywhere on the page
  const lookMark = savedMark();
  const grid = h('div', { class: 'avgrid', role: 'group', 'aria-label': 'Avatar' });
  const hues = h('div', { class: 'avhues', role: 'group', 'aria-label': 'Colour' });
  const cur = () => avatarValue(a.avatar) || defaultAvatar(a.id);
  const choose = async (next) => {
    const before = a.avatar;
    a = { ...a, avatar: next }; paintLook(); repaintAvatars(a);
    const ok = await lookMark.run(() => patch({ avatar: next }));
    if (!ok) { a = { ...a, avatar: before }; paintLook(); repaintAvatars(a); } else repaintAvatars(a);
  };
  const paintLook = () => {
    const c = cur();
    grid.replaceChildren(...[{ id: LETTER, label: 'Letters' }, ...AVATARS].map(x => h('button', { type: 'button', class: 'avpick', title: x.label, 'aria-label': x.label, 'aria-pressed': String(c.look === x.id), onclick: () => c.look !== x.id && choose({ look: x.id, colour: c.colour }) }, drawAvatar(a, '', { look: x.id, colour: c.colour }))));
    hues.replaceChildren(...COLOURS.map(x => h('button', { type: 'button', class: 'avhue', title: x.label, 'aria-label': x.label, 'aria-pressed': String(c.colour === x.id), style: { background: `var(${x.token})` }, onclick: () => c.colour !== x.id && choose({ look: c.look, colour: x.id }) })));
  };
  paintLook();
  // Avatar motion: one switch for the whole desk (the setting ui.avatarMotion, saved through the settings route); on unless switched off
  const motionMark = savedMark();
  const motionOn = ui.state.settings?.[MOTION_KEY] !== false;
  const motion = ui.sw(motionOn, 'Avatar motion', async (on) => {
    const ok = await motionMark.run(() => api('settings', { body: { [MOTION_KEY]: on } }));
    if (ok) { if (ui.state.settings) ui.state.settings[MOTION_KEY] = on; setAvatarMotion(on); } else return false;
  });
  const motionRow = h('div', { class: 'stack', style: { marginTop: '10px' } }, h('div', { class: 'pf-h' }, h('span', { class: 'pf-l', style: { whiteSpace: 'nowrap' } }, 'Avatar motion'), motion, motionMark), h('p', { class: 'sub' }, 'Blinking eyes and small movements. It stays still if your system asks for less motion.'));

  const skills = h('div', { class: 'chips' }, ui.spinner());
  const lately = h('div', { class: 'group' }, h('div', { class: 'sub' }, 'Reading the records…'));
  const card = (title, ...kids) => h('section', { class: 'box' }, h('div', { class: 'lbl' }, title), ...kids);
  // two columns on a wide window (who it is and what it always does on the left), one column on a narrow one
  el.replaceChildren(h('div', { class: 'pgrid' },
    h('div', { class: 'stack' },
      card('Who it is', field('Name', 'name'), field('Role', 'role', { empty: 'No role yet' }), field('Personality', 'personality', { multiline: true, empty: 'Not set: it talks plainly' })),
      card('What it always does', field('Standing instructions', 'instructions', { multiline: true, empty: 'None yet. Add what it should always do or never do.', quote: true }))),
    h('div', { class: 'stack' },
      card('How it looks', h('div', { class: 'pf-h' }, h('span', { class: 'pf-l' }, 'Avatar and colour'), lookMark), grid, hues, motionRow),
      card('What it is good at', skills, h('p', { class: 'sub' }, 'Switch skills on or off in Tools and skills.')),
      card('What it did lately', lately))));

  // skills from the agents module; last jobs from the desk's records (only what the records hold)
  api(API + 'agents/' + encodeURIComponent(a.id)).then((d) => {
    const on = (d.skills || []).filter(s => s.on);
    skills.replaceChildren(...(on.length ? on.map(s => h('span', { class: 'chip', title: s.description || '' }, s.title)) : [h('span', { class: 'sub' }, 'No skills switched on yet.')]));
  }).catch(() => skills.replaceChildren(h('span', { class: 'sub' }, 'Skills could not be read just now.')));
  api('jobs?limit=200').then((r) => {
    const mine = (r.jobs || []).filter(j => j.agentId === a.id && !j.quiet).slice(0, 5);
    lately.replaceChildren(...(mine.length ? mine.map(j => { const [w, k] = JOB_WORDS[j.status] || [j.status, 'off']; return h('div', { class: 'jl' }, h('span', { class: 'jl-t' }, j.title || 'A job'), statusChip(w, k), h('span', { class: 'sub jl-w' }, fmt.when(j.finished || j.updated || j.created))); }) : [h('div', { class: 'sub' }, 'Nothing yet.')]));
  }).catch(() => lately.replaceChildren(h('div', { class: 'sub' }, 'The records could not be read just now.')));
}

// ---------- Tools and skills: which Coordinator tools it may use; skill packs on or off
async function toolsTab(el, ui, agent) {
  const { h, api, btn, toast, line, sw, empty } = ui;
  el.replaceChildren(ui.spinner());
  let d;
  try { d = await api(API + 'agents/' + encodeURIComponent(agent.id)); } catch (e) { el.replaceChildren(empty(e.message)); return; }
  const off = new Set(d.tools.filter(t => !t.on).map(t => t.name));
  const on = new Set(d.skills.filter(s => s.on).map(s => s.id));
  const saveTools = async () => { await api(API + `agents/${encodeURIComponent(agent.id)}/tools`, { method: 'PUT', body: { off: [...off] } }); };
  const saveSkills = async () => { await api(API + `agents/${encodeURIComponent(agent.id)}/skills`, { method: 'PUT', body: { on: [...on] } }); };
  const byModule = new Map(); for (const t of d.tools) { if (!byModule.has(t.moduleName)) byModule.set(t.moduleName, []); byModule.get(t.moduleName).push(t); }
  const toolRows = [...byModule.entries()].map(([mod, ts]) => line(mod, ts.map(t => words(t.name)).join(', '), sw(ts.every(t => !off.has(t.name)), mod, async (v) => { for (const t of ts) v ? off.delete(t.name) : off.add(t.name); await saveTools(); })));
  const skillList = h('div');
  const paintSkills = () => skillList.replaceChildren(...d.skills.map(s => line(s.title, s.description, btn('Read', { kind: 'ghost sm', onClick: () => showSkill(ui, s.id) }), sw(on.has(s.id), s.title, async (v) => { v ? on.add(s.id) : on.delete(s.id); await saveSkills(); }))));
  paintSkills();
  el.replaceChildren(
    h('h6', { style: { marginLeft: 0 } }, 'Tools it may use'),
    toolRows.length ? h('div', null, toolRows) : h('p', { class: 'sub' }, 'No tools are switched on in the desk yet. They appear here when their modules are on.'),
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('h6', { style: { margin: 0 } }, 'Skills'), h('span', { class: 'sub' }, `${on.size} on`), h('span', { class: 'grow' }), btn('Write a skill', { kind: 'ghost sm', onClick: async () => {
      const title = await ui.ask('Name of the skill', { placeholder: 'Supplier comparison' }); if (!title) return;
      const body = await ui.ask('Its steps, in plain words', { multiline: true, placeholder: '1. ...\n2. ...' }); if (!body) return;
      try { const s = await api(API + 'skills', { body: { title, body } }); d.skills.push({ ...s, on: true }); on.add(s.id); await saveSkills(); paintSkills(); toast('Skill added and switched on.', 'ok'); } catch (e) { toast(e.message, 'err'); }
    } })),
    h('p', { class: 'sub' }, 'Skills are short instruction packs. The agent follows the steps when an ask fits. Text only: nothing in a skill is ever run.'),
    skillList);
}
async function showSkill(ui, id) {
  try { const s = await ui.api(API + 'skills/' + encodeURIComponent(id)); ui.modal({ title: s.title, body: ui.h('div', { style: { maxHeight: '60vh', overflow: 'auto' } }, ui.md(s.body)), actions: [{ label: 'Close' }], wide: true }); } catch (e) { ui.toast(e.message, 'err'); }
}

// ---------- Hire
async function hire(ui, done) {
  const { h, api, toast } = ui;
  let cat; try { cat = await api(API + 'catalog'); } catch (e) { toast(e.message, 'err'); return; }
  const name = h('input', { type: 'text', placeholder: 'For example: Mira', style: { width: '100%' } });
  const pack = h('select', { style: { width: '100%' } }, h('option', { value: '' }, 'No starting pack'), cat.packs.map(p => h('option', { value: p.id }, `${p.name}: ${p.role}`)));
  const role = h('input', { type: 'text', placeholder: 'What it does', style: { width: '100%' } });
  const pers = h('textarea', { placeholder: 'How it talks' });
  pack.onchange = () => { const p = cat.packs.find(x => x.id === pack.value); if (p) { if (!role.value) role.value = p.role; if (!pers.value) pers.value = p.personality; } };
  const lab = (t, x) => h('label', { class: 'f' }, t, x);
  ui.modal({ title: 'Hire an agent', body: h('div', { class: 'stack' }, lab('Name', name), lab('Starting skill pack', pack), lab('Role', role), lab('Personality', pers)), actions: [{ label: 'Cancel' }, { label: 'Hire', kind: '', onClick: async () => {
    if (!name.value.trim()) { toast('Give it a name.', 'err'); return false; }
    try { const a = await api(API + 'hire', { body: { name: name.value.trim(), pack: pack.value || null, role: role.value.trim(), personality: pers.value.trim() } }); toast(a.message || `${a.name} is hired.`, 'ok'); done?.(a); } catch (e) { toast(e.message, 'err'); return false; }
  } }] });
  setTimeout(() => name.focus(), 30);
}

function words(name) { return String(name).replace(/_/g, ' '); }

// The page's own look (the dark and bold look's shared classes do the rest). Once per window.
if (typeof document !== 'undefined' && !document.getElementById('apd-agents-css')) {
  const s = document.createElement('style'); s.id = 'apd-agents-css';
  s.textContent = [
    '.agp .pill.brand{background:var(--brand-soft);color:var(--brand);box-shadow:none;font-weight:600}',
    '.agp .acard{padding:12px;align-items:flex-start;color:var(--fg)}.agp .acard.sel{background:var(--work);border-color:var(--work-line);box-shadow:var(--shadow-hi),inset 3px 0 0 var(--brand)}',
    '.agp .ac-t{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}.agp .ac-n{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agp .ac-n b{font-size:15px}',
    '.agp .ac-r{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agp .ac-m{font-family:var(--mono);font-size:12px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.agp .offc{align-items:center;padding:10px 12px;background:var(--raised);box-shadow:none}',
    '.agp #a-det>.work-head{align-items:center}.agp .wh-t{display:flex;flex-direction:column;gap:4px;min-width:0}.agp .wh-t h3{font-size:22px;font-weight:800}',
    '.agp #a-det>.tabbar.seg{display:flex;flex-wrap:nowrap;background:none;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:6px 10px 0}',
    '.agp #a-det>.tabbar.seg>button{border-radius:0;background:none;box-shadow:none;padding:9px 14px 10px;font-size:14px}',
    '.agp #a-det>.tabbar.seg>button[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--brand);background:none;box-shadow:none}',
    '.agp .pgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}.agp .pgrid>.stack{gap:14px}',
    '.agp .pf{display:flex;flex-direction:column;gap:6px;padding:8px 0;border-top:1px solid var(--line)}.agp .box>.pf:first-of-type{border-top:0;padding-top:0}',
    '.agp .pf-h{display:flex;align-items:center;gap:8px;min-height:26px}.agp .pf-l{font-size:13px;color:var(--dim)}',
    '.agp .pf-v{font-size:14.5px;overflow-wrap:anywhere}.agp .pf-v.long{white-space:pre-wrap;max-height:9.5em;overflow:auto}.agp .pf-v.none{color:var(--faint)}',
    '.agp .pf input,.agp .pf textarea{width:100%;max-width:640px;background:var(--well)}',
    '.agp .avgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(48px,1fr));gap:6px}',
    '.agp .avpick{display:grid;place-items:center;padding:3px;border-radius:12px;border:2px solid transparent}.agp .avpick:hover{border-color:var(--line-strong)}.agp .avpick[aria-pressed="true"]{border-color:var(--brand);background:var(--brand-soft)}',
    '.agp .avhues{display:flex;gap:8px;flex-wrap:wrap}.agp .avhue{width:26px;height:26px;border-radius:50%;border:2px solid transparent;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}.agp .avhue[aria-pressed="true"]{outline:2px solid var(--brand);outline-offset:2px}',
    '.agp .jl{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.agp .jl-t{flex:1;min-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agp .jl-w{font-variant-numeric:tabular-nums}',
    '@media (max-width:1100px){.agp .pgrid{grid-template-columns:minmax(0,1fr)}}',
    // narrow window: the team is one swipeable row, so the chosen agent shows right under it
    '@media (max-width:860px){.agp .alist,.agp #a-off{flex-direction:row;overflow-x:auto;gap:10px;padding-bottom:4px;scrollbar-width:thin}.agp .alist>.acard{flex:0 0 250px}.agp #a-off>.offc{flex:0 0 250px}.agp #a-off>.lbl{display:none}.agp .acard.hov:hover{transform:none}}',
    // a phone: five tabs in one row that does not wrap were wider than the window, so "Memory" was cut and an open
    // Computer tab sat off screen; the bar wraps to a second row here, so every tab and the open one show whole
    '@media (max-width:560px){.agp #a-det>.tabbar.seg{flex-wrap:wrap;overflow:visible;padding:4px 6px 0}.agp #a-det>.tabbar.seg>button{padding:8px 10px 9px}}',
    '@media (max-width:560px){.agp #a-det>.work-head .agav.l{width:56px;height:56px;border-radius:16px}.agp .wh-t h3{font-size:19px}.agp .work>.work-body{padding:12px}}',
  ].join('\n');
  document.head.append(s);
}
