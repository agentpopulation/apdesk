// Agents page: cards on the left, the chosen agent on the right with tabs. Matches the Agents section of the approved preview.
// Tabs in order: Profile, Model (models module), Tools and skills, Memory (memory module), Computer (browser module).
const API = 'm/agents/';
const TAB_ORDER = [['profile', 'Profile', 'agents'], ['model', 'Model', 'models'], ['tools', 'Tools and skills', 'agents'], ['memory', 'Memory', 'memory'], ['computer', 'Computer', 'browser']];

export const pages = { agents: { title: 'Agents', render } };
export const agentTabs = {
  profile: { title: 'Profile', render: profileTab },
  tools: { title: 'Tools and skills', render: toolsTab },
};

async function render(el, ui, route) {
  const { h, api, btn, pill, toast } = ui;
  el.classList.add('scroll');
  const list = h('div', { class: 'stack', id: 'a-list' });
  const off = h('div', { class: 'stack', id: 'a-off' });   // built-in agents not on the team, one click to hire back
  const det = h('div', { class: 'card stack', id: 'a-det' });
  const count = pill('', 'ok');
  el.append(h('div', { class: 'row' }, h('h2', null, 'Agents'), count, h('span', { class: 'grow' }), btn('Hire an agent', { onClick: () => hire(ui, (a) => { ui.go('agents', a.id, 'profile'); }) })), h('div', { class: 'agrid' }, h('div', { class: 'stack' }, list, off), det));
  let alive = true; let cleanupTab = null;
  ui.onLeave(() => { alive = false; try { cleanupTab?.(); } catch {} });
  let agents = []; let jobs = [];
  const pickId = () => route?.parts?.[0] && agents.some(a => a.id === route.parts[0]) ? route.parts[0] : (agents[1] || agents[0])?.id;
  const tabs = () => TAB_ORDER.filter(([id, , mod]) => mod === 'agents' || (ui.moduleOn(mod) && (ui.state.modules.find(m => m.id === mod)?.agentTabs || []).includes(id)));
  const jobLine = (a) => {
    const run = jobs.find(j => j.agentId === a.id && j.status === 'running'); const wait = jobs.find(j => j.agentId === a.id && j.status === 'waiting');
    const pend = ui.state.pendingApprovals.filter(x => x.agentId === a.id).length;
    if (wait || pend) return ['wait', `Waiting for you${pend > 1 ? ' · ' + pend : ''}`];
    if (run) return ['run', `Working · ${run.title}`];
    return ['', 'Idle'];
  };
  async function load() {
    let gone = [];
    try { [agents, jobs, gone] = await Promise.all([api('agents').then(r => r.agents), api('jobs?limit=60').then(r => r.jobs).catch(() => []), api(API + 'retired').then(r => r.agents).catch(() => [])]); ui.state.agents = agents; } catch (e) { toast(e.message, 'err'); return; }
    if (!alive) return;
    count.textContent = `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`;
    const cur = pickId();
    list.replaceChildren(...agents.map(a => { const [cls, txt] = jobLine(a); return h('button', { class: 'card hov acard' + (a.id === cur ? ' sel' : ''), type: 'button', onclick: () => ui.go('agents', a.id, route?.parts?.[1] || 'profile') },
      h('span', { class: 'av big' }, initials(a.name)),
      h('span', { style: { minWidth: '0', flex: '1' } }, h('b', null, a.name), h('span', { class: 'sub', style: { display: 'block' } }, a.role || ''), pill(txt, cls))); }));
    off.replaceChildren(...(gone.length ? [h('h6', { style: { margin: '6px 0 0' } }, 'Not on your team'), ...gone.map(a => h('div', { class: 'card row acard' },
      h('span', { class: 'av big' }, initials(a.name)),
      h('span', { style: { minWidth: '0', flex: '1' } }, h('b', null, a.name), h('span', { class: 'sub', style: { display: 'block' } }, a.role || '')),
      btn('Hire', { kind: 'ghost sm', 'aria-label': 'Hire ' + a.name, onClick: () => hireBack(a) })))] : []));
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
    const [cls, txt] = jobLine(a);
    const body = h('div');
    const seg = ui.seg(avail.map(t => t[1]), avail.findIndex(t => t[0] === tabId), (label, i) => ui.go('agents', a.id, avail[i][0]));
    det.replaceChildren(
      h('div', { class: 'row' }, h('span', { class: 'av big' }, initials(a.name)), h('div', null, h('h3', null, a.name), h('div', { class: 'sub' }, txt)), cls ? pill(cls === 'run' ? 'Working' : 'Waiting', cls) : null, h('span', { class: 'grow' }),
        a.id !== 'coordinator' ? btn('Retire', { kind: 'ghost', onClick: () => retire(a) }) : null,
        btn('Chat', { onClick: () => ui.go('chat', 'dm-' + a.id) })),
      seg, body);
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
  ui.on('agents', (d) => { if (d?.change !== 'update') soon(); else { clearTimeout(t); t = setTimeout(async () => { if (!alive) return; try { agents = (await api('agents')).agents; ui.state.agents = agents; count.textContent = `${agents.length} agents`; } catch {} }, 300); } });
  ui.on('job', (j) => { if (j?.status && j.status !== 'running') soon(); });
  await load();
}

// ---------- Profile: name, personality, standing instructions (saved through PATCH /api/agents/:id)
async function profileTab(el, ui, agent) {
  const { h, api, btn, toast, line } = ui;
  let a = agent;
  const save = async (patch, what) => { try { a = await api('agents/' + encodeURIComponent(a.id), { method: 'PATCH', body: patch }); toast(`${what} saved. The next reply uses it.`, 'ok'); paint(); } catch (e) { toast(e.message, 'err'); } };
  const edit = (title, key, multiline = false) => btn(key === 'name' ? 'Rename' : 'Edit', { kind: 'ghost sm', onClick: async () => { const v = await ui.ask(title, { value: a[key] || '', multiline }); if (v == null) return; if (key === 'name' && !v.trim()) return toast('A name cannot be empty.', 'err'); await save({ [key]: v.trim() }, title); } });
  const paint = () => el.replaceChildren(
    line('Name', a.name, edit('Name', 'name')),
    line('Personality', a.personality || 'Not set', edit('Personality: how it talks', 'personality', true)),
    line('Standing instructions', a.instructions ? `"${short(a.instructions, 220)}"` : 'None', edit('Standing instructions', 'instructions', true)),
    line('Role', a.role || 'Not set', edit('Role', 'role')));
  paint();
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
    try { const a = await api(API + 'hire', { body: { name: name.value.trim(), pack: pack.value || null, role: role.value.trim(), personality: pers.value.trim() } }); toast(`${a.name} is hired.`, 'ok'); done?.(a); } catch (e) { toast(e.message, 'err'); return false; }
  } }] });
  setTimeout(() => name.focus(), 30);
}

function initials(n) { return String(n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
function short(s, n) { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function words(name) { return String(name).replace(/_/g, ' '); }
