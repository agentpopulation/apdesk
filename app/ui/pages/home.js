// Home and the optional onboarding roles. Owned by the shell.
// chips: a suggestion is text, or { text, needsBusiness: true } when it means the owner's own business ("my product") and
// cannot be done until he has said what he sells. team: the agents ticked by default on the first-start step (the
// Coordinator is always on); a role without a team list gets all five.
export const ROLES = {
  sales:        { name: 'Sales person', desc: 'Leads, outreach, follow-ups', off: [], labels: {}, team: ['coordinator', 'scout', 'closer'], chips: [{ text: 'Find 20 leads with sources for my product', needsBusiness: true }, 'Draft outreach to the top five leads', 'Research this company before my call'] },
  entrepreneur: { name: 'Entrepreneur', desc: 'Research, decisions, a morning brief', off: [], labels: {}, chips: ['Research a market in depth', 'Ask the Council: build or buy?', 'Every morning at 8, brief me'] },
  host:         { name: 'Airbnb host', desc: 'Guests, bookings, messages', off: ['models'], labels: { sales: 'Guests', tasks: 'Bookings' }, team: ['coordinator', 'closer', 'operator'], chips: ['Draft a reply to my new booking request', 'Compare my price with five nearby listings', "Every Friday, list next week's check-ins"] },
  educator:     { name: 'Educator', desc: 'Lessons, marking, class plans', off: ['sales'], labels: { tasks: 'Classes' }, team: ['coordinator', 'scout', 'coder'], chips: ['Plan a 6-week course', "Research three sources for tomorrow's lesson", 'Make a quiz from this file'] },
  student:      { name: 'Student', desc: 'Study plans, research, notes', off: ['sales', 'models'], labels: { tasks: 'Study plan' }, team: ['coordinator', 'scout', 'coder'], chips: ['Research this topic and cite sources', 'Make a revision plan for my exams', 'Explain this file in plain words'] },
};
export const DEFAULT_CHIPS = ['Research a topic in depth', { text: 'Find 20 leads with sources', needsBusiness: true }, 'Every morning at 8, brief me', 'Compare three products into a table file'];
export const chipsFor = (roleId) => ROLES[roleId]?.chips || DEFAULT_CHIPS;
export const chipText = (c) => typeof c === 'string' ? c : String(c?.text || '');
export const chipNeedsBusiness = (c) => !!(c && typeof c === 'object' && c.needsBusiness);
/** The five starting agents; the team ticked by default for a role (all five when the role has no opinion). */
export const STARTING_TEAM = ['coordinator', 'scout', 'closer', 'operator', 'coder'];
export const teamFor = (roleId) => ROLES[roleId]?.team || STARTING_TEAM;

export async function applyRole(ui, id) {
  const r = await ui.api('settings', { body: { role: id || null, onboarded: true } });
  ui.state.settings = r.settings;
}

export async function homePage(el, ui) {
  const { h, api, card, line, btn, pill, meter, fmt, empty } = ui;
  el.classList.add('scroll');
  const role = ROLES[ui.state.settings.role];
  const hour = Number(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: ui.state.settings.timeZone || undefined }));
  const hello = hour < 4 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const tiles = h('div', { class: 'tiles' }), running = h('div'), waiting = h('div'), recent = h('div'), extra = h('div', { class: 'tiles' });
  el.append(
    h('div', null, h('h2', null, hello + (ui.state.settings.ownerName ? ', ' + ui.state.settings.ownerName : '')), h('p', { class: 'sub' }, role ? `Set up for: ${role.name}. ${role.desc}.` : 'Everything is switched on.')),
    tiles,
    h('div', { class: 'two' }, card(h('h3', null, 'What is running'), running), card(h('h3', null, 'Waiting for you'), waiting)),
    card(h('h3', null, 'Pick up where you left off'), recent), extra);
  const paint = async () => {
    let d; try { d = await api('home'); } catch (e) { running.replaceChildren(empty(e.message)); return; }
    await ui.refreshStopped?.();
    const owners = (list) => list.filter(j => !j.quiet);   // the desk's own upkeep stays in Tasks › Housekeeping
    const tile = (n, label, page) => h('button', { class: 'card hov stat', onclick: () => ui.go(page) }, h('b', null, String(n)), h('span', null, label));
    tiles.replaceChildren(tile(d.jobs.summary.running, 'Tasks running', 'tasks'), tile(d.approvals.length + d.jobs.summary.waiting, 'Waiting for you', 'tasks'), tile(d.jobs.summary.done, 'Finished', 'tasks'), tile(d.agents, 'Agents', 'agents'));
    const run = owners(d.jobs.running);
    running.replaceChildren(...(run.length ? run.map(j => h('div', { class: 'line' }, h('div', null, h('b', null, j.title), h('span', { class: 'd' }, `${ui.agent(j.agentId)?.name || 'Agent'} · ${j.detail || 'Working'}`)), meter(j.progress, { live: true, style: { maxWidth: '160px' } }), pill(fmt.pct(j.progress), 'run'))) : [empty('Nothing is running.')]));
    const waits = [...d.approvals.map(a => line(a.title, `${ui.agent(a.agentId)?.name || 'An agent'} asks · ${ui.ACTION_WORDS[a.action] || a.action}`, btn('Review', { kind: 'ghost sm', onClick: () => ui.openApprovals() }))),
      ...d.jobs.waiting.map(j => line(j.title, j.detail || 'Waiting for you', btn('Open', { kind: 'ghost sm', onClick: () => ui.go('tasks') })))];
    const stopped = ui.stoppedSection?.();
    waiting.replaceChildren(...(waits.length || stopped ? [...waits, stopped].filter(Boolean) : [empty('Nothing is waiting.')]));
    const rec = [...(d.recent || []).map(c => line(c.title || 'Chat', c.last || '', btn('Open', { kind: 'ghost sm', onClick: () => ui.go('chat', c.id) }))),
      ...owners(d.jobs.done).slice(0, 4).map(j => line(j.title, `Finished ${fmt.ago(j.finished)}`, btn('Open', { kind: 'ghost sm', onClick: () => j.chatId ? ui.go('chat', j.chatId) : ui.go('tasks') })))];
    recent.replaceChildren(...(rec.length ? rec : [empty('Start in Chat: ask for research, leads, a schedule or a file.'), h('div', { class: 'chips', style: { justifyContent: 'center' } }, chipsFor(ui.state.settings.role).map(c => h('button', { class: 'chip', onclick: () => { try { sessionStorage.setItem('apd-prefill', chipText(c)); sessionStorage.setItem('apd-prefill-chip', JSON.stringify({ text: chipText(c), needsBusiness: chipNeedsBusiness(c) })); } catch {} ui.go('chat'); } }, chipText(c))))]));
    const mods = ui.state.modules.filter(m => m.on && m.kind !== 'core' && (m.menu || []).length);
    extra.replaceChildren(...mods.map(m => h('button', { class: 'card hov', onclick: () => ui.go(m.menu[0].id) }, h('b', null, m.name), h('div', { class: 'sub' }, 'Module is on. Open it.'))));
  };
  await paint();
  ui.on('job', paint); ui.on('approval', paint); ui.on('modules', paint); ui.on('panic', paint);
}
