// Home and the optional onboarding roles. Owned by the shell.
// chips: a suggestion is text, or { text, needsBusiness: true } when it means the owner's own business ("my product") and
// cannot be done until he has said what he sells. team: the agents ticked by default on the first-start step (the
// Manager is always on); a role without a team list gets all five. hire: roles from the hire box (modules/agents/ui-roles.js)
// offered on the same step, ticked; a small business owner comes first: sales, customers, invoices and marketing, anywhere.
export const ROLES = {
  business:     { name: 'Small business owner', desc: 'Sales, customers, invoices, marketing', off: [], labels: {}, team: ['coordinator', 'scout', 'closer'], hire: ['finance', 'marketing', 'customer-care'], chips: [{ text: 'Find 20 leads with sources for my product', needsBusiness: true }, 'Which invoices are still unpaid? Draft polite reminders', 'Draft a calm reply to an unhappy customer', { text: 'Plan one month of marketing for my business', needsBusiness: true }] },
  sales:        { name: 'Sales person', desc: 'Leads, outreach, follow-ups', off: [], labels: {}, team: ['coordinator', 'scout', 'closer'], chips: [{ text: 'Find 20 leads with sources for my product', needsBusiness: true }, 'Draft outreach to the top five leads', 'Research this company before my call'] },
  entrepreneur: { name: 'Entrepreneur', desc: 'Research, decisions, a morning brief', off: [], labels: {}, chips: ['Research a market in depth', 'Ask the Council: build or buy?', 'Every morning at 8, brief me'] },
  host:         { name: 'Airbnb host', desc: 'Guests, bookings, messages', off: ['models'], labels: { sales: 'Guests', tasks: 'Bookings' }, team: ['coordinator', 'closer', 'operator'], chips: ['Draft a reply to my new booking request', 'Compare my price with five nearby listings', "Every Friday, list next week's check-ins"] },
  educator:     { name: 'Educator', desc: 'Lessons, marking, class plans', off: ['sales'], labels: { tasks: 'Classes' }, team: ['coordinator', 'scout', 'coder'], chips: ['Plan a 6-week course', "Research three sources for tomorrow's lesson", 'Make a quiz from this file'] },
  student:      { name: 'Student', desc: 'Study plans, research, notes', off: ['sales', 'models'], labels: { tasks: 'Study plan' }, team: ['coordinator', 'scout', 'coder'], chips: ['Research this topic and cite sources', 'Make a revision plan for my exams', 'Explain this file in plain words'] },
};
export const DEFAULT_CHIPS = [{ text: 'Find 20 leads with sources', needsBusiness: true }, 'Draft a polite reminder for an unpaid invoice', 'Research a topic in depth', 'Every morning at 8, brief me'];
export const chipsFor = (roleId) => ROLES[roleId]?.chips || DEFAULT_CHIPS;
export const chipText = (c) => typeof c === 'string' ? c : String(c?.text || '');
export const chipNeedsBusiness = (c) => !!(c && typeof c === 'object' && c.needsBusiness);
/** The five starting agents; the team ticked by default for a role (all five when the role has no opinion). */
export const STARTING_TEAM = ['coordinator', 'scout', 'closer', 'operator', 'coder'];
export const teamFor = (roleId) => ROLES[roleId]?.team || STARTING_TEAM;
/** The roles to hire offered (ticked) on the first-start step for a role; none for most. */
export const hiresFor = (roleId) => ROLES[roleId]?.hire || [];

/** The small quiet "Custom" tag beside a module the owner added himself (the module list carries custom: true); nothing
 *  when the field is false or missing. */
export const customTag = (h, m) => m?.custom === true ? h('span', { class: 'tag-custom', 'data-apd': 'custom-tag' }, 'Custom') : null;

/** extra: more settings saved with the role in the same call (first start: the place shown and step two kept open). */
export async function applyRole(ui, id, extra = {}) {
  const r = await ui.api('settings', { body: { ...extra, role: id || null, onboarded: true } });
  ui.state.settings = r.settings;
}

export async function homePage(el, ui) {
  const { h, api, card, line, btn, pill, meter, fmt, empty } = ui;
  el.classList.add('scroll');
  const role = ROLES[ui.state.settings.role];
  let hour = new Date().getHours();
  try { hour = Number(new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: ui.state.settings.timeZone || undefined })); } catch {}   // the desk refuses a zone it cannot use; this is the last guard
  const hello = hour < 4 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const bench = h('div'), tiles = h('div', { class: 'tiles' }), running = h('div'), waiting = h('div'), recent = h('div'), extra = h('div', { class: 'tiles' });
  el.append(
    h('div', null, h('h2', null, hello + (ui.state.settings.ownerName ? ', ' + ui.state.settings.ownerName : '')), h('p', { class: 'sub' }, role ? `Set up for: ${role.name}. ${role.desc}.` : 'Everything is switched on.')),
    bench, tiles,
    h('div', { class: 'two' }, card(h('h3', null, 'What is running'), running), card(h('h3', null, 'Waiting for you'), waiting)),
    card(h('h3', null, 'Pick up where you left off'), recent), extra);
  const paint = async () => {
    let d; try { d = await api('home'); } catch (e) { running.replaceChildren(empty(e.message)); return; }
    await ui.refreshStopped?.();
    // the note Bench mode left while the owner was away, at the top (the module's own card)
    if (ui.moduleOn('bench')) { try { await (await ui.moduleUi('bench')).homeCard?.(bench, ui); } catch { bench.replaceChildren(); } } else bench.replaceChildren();
    const owners = (list) => list.filter(j => !j.quiet);   // the desk's own upkeep stays in Tasks › Housekeeping
    // a count that is live wears a coloured stripe: blue while tasks run, amber while something waits for the owner
    const tile = (n, label, page, live = '') => h('button', { class: 'card hov stat' + (live && n ? ' ' + live : ''), onclick: () => ui.go(page) }, h('b', null, String(n)), h('span', null, label));
    tiles.replaceChildren(tile(d.jobs.summary.running, 'Tasks running', 'tasks', 'run'), tile(d.approvals.length + d.jobs.summary.waiting, 'Waiting for you', 'tasks', 'slow'), tile(d.jobs.summary.done, 'Done', 'tasks'), tile(d.agents, 'Agents', 'agents'));
    const run = owners(d.jobs.running);
    running.replaceChildren(...(run.length ? run.map(j => h('div', { class: 'line' }, h('div', null, h('b', null, j.title), h('span', { class: 'd' }, `${j.agentId ? ui.agentLine(j.agentId) : 'The desk'} · ${j.detail || 'Working'}`)), meter(j.progress, { live: true, style: { maxWidth: '160px' } }), pill(fmt.pct(j.progress), 'run'))) : [empty('Nothing is running.')]));
    const waits = [...d.approvals.map(a => line(a.title, `${ui.whoAsks(a)} · ${ui.ACTION_WORDS[a.action] || 'Action'}`, btn('Review', { kind: 'ghost sm', onClick: () => ui.openApprovals() }))),
      ...d.jobs.waiting.map(j => line(j.title, j.detail || 'Waiting for you', btn('Open', { kind: 'ghost sm', onClick: () => ui.go('tasks') })))];
    const stopped = ui.stoppedSection?.();
    waiting.replaceChildren(...(waits.length || stopped ? [...waits, stopped].filter(Boolean) : [empty('Nothing is waiting.')]));
    const rec = [...(d.recent || []).map(c => line(c.title || 'Chat', c.last || '', btn('Open', { kind: 'ghost sm', onClick: () => ui.go('chat', c.id) }))),
      ...owners(d.jobs.done).slice(0, 4).map(j => line(j.title, `Done ${fmt.ago(j.finished)}`, btn('Open', { kind: 'ghost sm', onClick: () => j.chatId ? ui.go('chat', j.chatId) : ui.go('tasks') })))];
    recent.replaceChildren(...(rec.length ? rec : [empty('Start in Chat: ask for research, leads, a schedule or a file.'), h('div', { class: 'chips', style: { justifyContent: 'center' } }, chipsFor(ui.state.settings.role).map(c => h('button', { class: 'chip', onclick: () => { try { sessionStorage.setItem('apd-prefill', chipText(c)); sessionStorage.setItem('apd-prefill-chip', JSON.stringify({ text: chipText(c), needsBusiness: chipNeedsBusiness(c) })); } catch {} ui.go('chat'); } }, chipText(c))))]));
    const mods = ui.state.modules.filter(m => m.on && m.kind !== 'core' && (m.menu || []).length);
    // each place by the name the menu gives it, with what it is for in its own words (the first sentence of its description)
    const what = (m) => (String(m.description || '').match(/^.*?\.(?=\s|$)/) || [''])[0].trim() || 'Open it.';
    extra.replaceChildren(...mods.map(m => h('button', { class: 'card hov', onclick: () => ui.go(m.menu[0].id) }, h('b', null, ui.label(m.menu[0].id, m.menu[0].label || m.name), customTag(h, m)), h('div', { class: 'sub' }, what(m)))));
  };
  await paint();
  ui.on('job', paint); ui.on('approval', paint); ui.on('modules', paint); ui.on('panic', paint); ui.on('bench', paint);
}
