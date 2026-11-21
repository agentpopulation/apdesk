// The agent tracker's lists: what each agent is doing, the to-do list of jobs, time left, the "needs you" notice and the
// update dot. Plain functions over the jobs the desk's 'job' events carry; the page and the pop-up draw them.
export const HOUR = 3600000;
export const DASH = '–';
const ENDED = ['done', 'failed', 'stopped', 'interrupted'];
const at = (iso) => Date.parse(iso || '') || 0;
/** The desk's own upkeep stays out of sight unless it failed (the rule Home and the notices already follow). */
const shownJob = (j) => !j.quiet || j.status === 'failed';

/** Keep the latest copy of a job from a 'job' event. */
export function mergeJob(map, j) { if (j && j.id) map.set(j.id, j); return map; }

export function todoLists(jobs, now = Date.now()) {
  const list = [...jobs].filter(shownJob).sort((a, b) => at(b.created) - at(a.created));
  const ended = list.filter(j => ENDED.includes(j.status) && now - at(j.finished || j.updated) < HOUR).sort((a, b) => at(b.finished || b.updated) - at(a.finished || a.updated));
  return { queued: list.filter(j => j.status === 'queued'), running: list.filter(j => j.status === 'running'), waiting: list.filter(j => j.status === 'waiting'), done: ended };
}
export const runningCount = (jobs) => [...jobs].filter(j => shownJob(j) && j.status === 'running').length;

export const leftWords = (s) => s < 60 ? 'under a minute left' : s < 3600 ? `about ${Math.ceil(s / 60)} min left` : `about ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`;
/** Only a job that reports its own seconds left gets a time; every other one shows a dash. */
export const timeLeft = (j) => j && j.status === 'running' && Number.isFinite(j.secondsLeft) && j.secondsLeft >= 0 ? leftWords(j.secondsLeft) : DASH;

export function agentsNow(agents, jobs) {
  const open = [...jobs].filter(j => shownJob(j) && (j.status === 'running' || j.status === 'waiting'));
  return agents.map(a => {
    const mine = open.filter(j => j.agentId === a.id).sort((x, y) => (x.status === 'running' ? 0 : 1) - (y.status === 'running' ? 0 : 1));
    const j = mine[0];
    return { id: a.id, name: a.name || 'An agent', busy: !!j, job: j || null, more: Math.max(0, mine.length - 1), text: !j ? 'Not working on anything' : j.status === 'waiting' ? `Waiting for you: ${j.title}` : j.title };
  });
}

/** A running job with no agent is the desk's own work: the newest one, and how many more. */
export function deskNow(jobs) {
  const mine = [...jobs].filter(j => shownJob(j) && j.status === 'running' && !j.agentId).sort((a, b) => at(b.created) - at(a.created));
  const j = mine[0];
  return { busy: !!j, job: j || null, more: Math.max(0, mine.length - 1), text: j ? `The desk is working: ${j.title || 'a job'}` : '' };
}

/** Who a job belongs to, in plain words: the agent's name, never its id. */
export function jobWho(agents, j) {
  if (!j || !j.agentId) return 'The desk';
  return (agents || []).find(a => a.id === j.agentId)?.name || 'An agent';
}
/** Who asks for an approval: the agent by name, else the desk itself (the owner's own Get, the desk's own work). */
export const whoAsks = (agents, a) => `${jobWho(agents, a)} asks`;
/** The pop-ups that show the downloads list: a 'downloads' event repaints either one while it is open. */
export const popShowsDownloads = (kind) => kind === 'downloads' || kind === 'tracker';

/** A job just went to waiting: tell once per job, never for the desk's quiet upkeep. */
export function needsYou(j, told) {
  if (!j || j.status !== 'waiting' || j.quiet || told.has(j.id)) return false;
  told.add(j.id); return true;
}

/** The 'update' event's state says a checked update can be installed. */
export const updateReady = (st) => !!(st && st.canInstall === true && st.release && st.release.version);
