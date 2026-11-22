// The agent tracker: what each agent is doing now, the to-do list of jobs, the downloads, Stop for each running job and
// Panic. The same parts fill the top bar's pop-up (short) and the Tracker page (all of it). Live from the desk's events:
// the shell keeps the jobs from its 'job' events (ui.tracker.jobs()) and the downloads from 'downloads' events.
import { todoLists, agentsNow, deskNow, timeLeft, jobWho } from '/ui/tracker-data.js';

// Each agent's avatar, drawn by the Agents page's helper; a desk without the Agents module keeps the plain line.
let avatarEl = null;
const avatarReady = import('/modules/agents/ui.js').then((m) => { avatarEl = m.avatarEl || null; }, () => {});

const ENDED_WORDS = { done: 'Done', failed: 'Did not finish', stopped: 'Stopped', interrupted: 'Cut off when the desk stopped' };

function jobRow(ui, j) {
  const { h, btn, pill, meter, fmt } = ui;
  const who = jobWho(ui.state.agents, j);
  const open = j.status === 'running' || j.status === 'waiting' || j.status === 'queued';
  const pct = j.status === 'running' && Number.isFinite(j.progress) ? fmt.pct(j.progress) : '–';
  const when = open ? `started ${fmt.ago(j.created)}` : `${ENDED_WORDS[j.status] || j.status} ${fmt.ago(j.finished || j.updated)}`;
  const stop = open ? btn('Stop', { kind: 'ghost sm', 'aria-label': `Stop ${j.title}`, onClick: async (e) => { e.currentTarget.disabled = true; try { await ui.tracker.stop(j.id); } catch (er) { ui.toast(er.message, 'err'); e.currentTarget.disabled = false; } } }) : null;
  return h('div', { class: 'card trow', 'data-job': j.id },
    h('div', { class: 'row' }, h('b', { class: 'tname' }, j.title || 'A job'), h('span', { class: 'grow' }),
      j.status === 'waiting' ? pill('Waiting for you', 'wait') : j.status === 'running' ? pill('Running', 'run') : j.status === 'queued' ? pill('Waiting to start', 'wait') : pill(ENDED_WORDS[j.status] || j.status, j.status === 'done' ? 'ok' : j.status === 'failed' ? 'stop' : '')),
    j.status === 'running' ? meter(j.progress || 0, { live: true, style: { margin: '8px 0 4px' } }) : null,
    h('div', { class: 'sub' }, [who, j.detail && j.detail !== 'Done' ? j.detail : null, when].filter(Boolean).join(' · ')),
    open ? h('div', { class: 'row tmeta' }, h('span', { class: 'sub' }, `Progress ${pct}`), h('span', { class: 'sub' }, `Time left ${timeLeft(j)}`), h('span', { class: 'grow' }),
      j.status === 'waiting' ? btn('Review', { kind: 'ghost sm', onClick: () => ui.openApprovals() }) : null, stop) : null);
}

/** The parts, in order. full: every agent and every list; otherwise only busy agents and a short to-do list. */
export function trackerBody(ui, { full = false } = {}) {
  const { h, btn, empty } = ui;
  const jobs = ui.tracker.jobs(); const l = todoLists(jobs);
  const agents = agentsNow(ui.state.agents || [], jobs); const busy = agents.filter(a => a.busy);
  const shownAgents = full ? agents : busy;
  // a running job with no agent is the desk's own work: said as such, never as "no agent is working"
  const desk = deskNow(jobs);
  const deskLine = desk.busy ? h('div', { class: 'line', 'data-tracker-desk': '' }, h('div', null, h('b', null, desk.text), desk.more ? h('span', { class: 'd' }, `and ${desk.more} more`) : null), h('span', { class: 'dot on' })) : null;
  const agentPart = h('section', { class: 'tsec', 'data-tracker': 'agents' }, h('h3', null, 'Agents now'),
    shownAgents.length || deskLine ? h('div', { class: 'tlist' }, deskLine, shownAgents.map(a => h('div', { class: 'line' }, avatarEl?.(a, 's', a.busy ? 'working' : 'idle'), h('div', null, h('b', null, a.name), h('span', { class: 'd' }, a.text + (a.more ? ` and ${a.more} more` : ''))), h('span', { class: 'dot' + (a.busy ? ' on' : '') })))) : empty(agents.length ? `No agent is working right now. ${agents.length === 1 ? 'One agent is' : agents.length + ' agents are'} free.` : 'No agents yet.'));
  const group = (key, title, list, cap) => list.length ? h('div', { class: 'tgroup', 'data-todo': key }, h('h6', null, `${title} (${list.length})`), ...list.slice(0, cap).map(j => jobRow(ui, j)), list.length > cap ? h('p', { class: 'sub' }, `${list.length - cap} more on the Tracker page.`) : null) : null;
  const cap = full ? 200 : 3;
  const any = l.queued.length + l.running.length + l.waiting.length + l.done.length;
  const todoPart = h('section', { class: 'tsec', 'data-tracker': 'todo' }, h('h3', null, 'To do'),
    any ? [group('waiting', 'Waiting for you', l.waiting, cap), group('running', 'Running', l.running, cap), group('queued', 'Waiting to start', l.queued, cap), group('done', 'Ended in the last hour', l.done, full ? cap : 2)] : empty('No jobs right now, and none ended in the last hour.'));
  const dl = ui.tracker.downloadRows();
  const dlPart = full || !dl.some(x => x.classList?.contains('empty')) ? h('section', { class: 'tsec', 'data-tracker': 'downloads' }, h('h3', null, 'Downloads'), ...dl) : null;
  const halted = !!ui.state.panic?.halted;
  const foot = h('div', { class: 'row tfoot' }, h('span', { class: 'sub' }, halted ? 'Everything is stopped.' : 'Panic stops every agent, job and browser at once.'), h('span', { class: 'grow' }),
    full ? null : btn('Open Tracker', { kind: 'ghost sm', onClick: () => ui.go('tracker') }),
    btn(halted ? 'Stopped' : 'Panic', { kind: 'stop sm', 'data-apd': 'tracker-panic', disabled: halted, onClick: () => ui.panic() }));
  return [agentPart, todoPart, dlPart, foot].filter(Boolean);
}

export async function trackerPage(view, ui) {
  const { h } = ui;
  view.classList.add('scroll', 'trackerv');
  const body = h('div', { class: 'stack' });
  view.append(h('div', { class: 'row' }, h('h2', null, 'Tracker'), h('span', { class: 'grow' }), h('span', { class: 'sub' }, 'Live. Stop and Panic work here; anything else is changed on its own page.')), body);
  let queued = false;
  const paint = () => { queued = false; body.replaceChildren(...trackerBody(ui, { full: true }).map(x => x.tagName === 'SECTION' ? ui.card({ class: 'tcard' }, x) : x)); };
  const soon = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  await Promise.all([ui.tracker.ready(), avatarReady]);
  paint();
  for (const type of ['job', 'downloads', 'agents', 'panic']) ui.on(type, soon);
}
