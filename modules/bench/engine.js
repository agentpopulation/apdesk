// Bench mode, the plain rules: tiers by hours away, the order activities run in, the model order, budgets, and the note.
// No I/O here, so the tests can walk a whole 108-hour session in milliseconds.

/** Hours away at which each tier opens. */
export const TIERS = Object.freeze([{ n: 1, hours: 1 }, { n: 2, hours: 12 }, { n: 3, hours: 36 }, { n: 4, hours: 108 }]);
/** Every activity, in the order it runs. web: it reads the internet, so it waits while the desk is offline. */
export const ACTIVITIES = Object.freeze([
  { id: 'unfinished', tier: 1, web: false, title: 'Unfinished work' },
  { id: 'selfcheck', tier: 1, web: true, title: 'Self-check' },
  { id: 'lessons', tier: 1, web: false, title: 'Lessons' },
  { id: 'business', tier: 2, web: true, title: 'Know the business' },
  { id: 'competitors', tier: 2, web: true, title: 'Competition' },
  { id: 'skills', tier: 2, web: false, title: 'Skills' },
  { id: 'customers', tier: 3, web: true, title: 'Customers' },
  { id: 'funding', tier: 3, web: true, title: 'Money and credits' },
  { id: 'tools', tier: 3, web: true, title: 'Free tools' },
  { id: 'report', tier: 4, web: true, title: 'Market report' },
  { id: 'pricing', tier: 4, web: false, title: 'Pricing table' },
  { id: 'plan', tier: 4, web: false, title: 'A 30-day plan' },
]);
export const activity = (id) => ACTIVITIES.find((a) => a.id === id) || null;

/** What one activity and one session may use. minutes are minutes of work, not of time away. */
export const BUDGET = Object.freeze({
  activity: { calls: 14, pages: 16, searches: 8, minutes: 25 },
  session: { calls: 140, pages: 140, searches: 60, minutes: 6 * 60 },
});
export const KINDS = ['needs', 'work', 'doubt', 'lesson', 'profile', 'competitor', 'skill', 'lead', 'funding', 'tool', 'report', 'table', 'plan', 'draft'];
export const KIND_WORDS = { needs: 'Needs you', work: 'Unfinished work', doubt: 'Doubts about earlier work', lesson: 'Lessons', profile: 'Your business', competitor: 'Competitors', skill: 'Skill drafts', lead: 'Possible customers', funding: 'Money and credits', tool: 'Free tools and data', report: 'Market report', table: 'Pricing table', plan: 'A 30-day plan', draft: 'Drafts' };

export const HOUR = 3600000;
/** The highest tier open after this long away (0 before the first hour). */
export function tierFor(msAway) { let t = 0; for (const x of TIERS) if (msAway >= x.hours * HOUR) t = x.n; return t; }

/** A fresh plan: every activity pending. */
export const freshPlan = () => Object.fromEntries(ACTIVITIES.map((a) => [a.id, { status: 'pending', tries: 0 }]));

/**
 * The next activity to start, or null. Earlier tiers first (the list is in tier order); an activity of an open tier that has not
 * run yet runs before anything later. While offline only the activities that need no web are taken.
 */
export function nextActivity(plan, { tier, online }) {
  for (const a of ACTIVITIES) {
    const p = plan[a.id]; if (!p || p.status !== 'pending') continue;
    if (a.tier > tier) return null;
    if (a.web && !online) continue;
    return a;
  }
  return null;
}

/**
 * The models Bench asks, in order: local first (Ollama, LAN nodes), then free (the built-in Free API, providers with a free
 * tier on a key, OpenRouter's free models only), then paid only when the owner's Bench switch says "also paid" AND paid use is
 * already allowed for that provider (paidAllowed). active: the door's "Active now"; tiers: provider id -> 'paid' | 'free-signup' | 'custom'.
 */
export function modelOrder(active, { mode = 'free', tiers = {}, paidAllowed = () => false } = {}) {
  const out = [];
  const ok = (a) => a && a.ok !== false;
  for (const a of active || []) if (a.kind === 'local' && ok(a) && (a.models || []).length) out.push({ provider: a.provider, model: null, why: 'local' });
  for (const a of active || []) if (a.kind === 'lan') out.push({ provider: a.provider, model: a.model || null, why: 'local' });
  if (mode === 'local') return out;
  for (const a of active || []) if (a.kind === 'router' && ok(a)) out.push({ provider: 'router', model: null, why: 'free' });
  for (const a of active || []) if (a.kind === 'keyed' && tiers[a.provider] === 'free-signup') out.push({ provider: a.provider, model: a.provider === 'openrouter' ? 'openrouter/free' : null, why: 'free' });
  if (mode !== 'paid') return out;
  for (const a of active || []) if (a.kind === 'keyed' && tiers[a.provider] !== 'free-signup' && paidAllowed(a.provider)) out.push({ provider: a.provider, model: null, why: 'paid' });
  if ((active || []).some((a) => a.provider === 'openrouter') && paidAllowed('openrouter')) out.push({ provider: 'openrouter', model: null, why: 'paid' });
  return out;
}

/** "2 hours 10 minutes" */
export function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000)); const h = Math.floor(m / 60); const d = Math.floor(h / 24);
  if (d >= 2) return `${d} days ${h % 24} ${h % 24 === 1 ? 'hour' : 'hours'}`;
  if (h) return `${h} hour${h === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} ${m % 60 === 1 ? 'minute' : 'minutes'}` : ''}`;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** The stated rule for "best": items with complete evidence first, newest tier first, then newest. Needs-you items are never "best". */
export function bestItems(items, n = 3) {
  return items.filter((i) => i.state === 'new' && !['needs', 'plan', 'draft'].includes(i.kind) && i.complete)
    .sort((a, b) => b.tier - a.tier || String(b.created).localeCompare(String(a.created))).slice(0, n);
}
export const BEST_RULE = 'Findings whose every line has a page or a record that says it, from the latest stage of the session (the plan and the items that need you are not counted).';

/**
 * The note, built by code from the session and its items only. A model writes only inside items (a line summarising a page).
 * -> { head: [lines], best: [items], groups: [{ kind, words, items }], needs: [items], notDone: [lines] }
 */
export function buildNote(session, items, { now = Date.now(), name = 'Bench' } = {}) {
  const shown = items.filter((i) => i.state === 'new');
  const ended = session.ended ? Date.parse(session.ended) : now;
  const ran = span(ended - Date.parse(session.started));
  const models = [...new Set(session.models || [])];
  const head = [
    session.state === 'running' ? `${name} has been working for ${ran}.` : `${name} ran for ${ran}${session.endWhy ? `; ${session.endWhy}` : ''}.`,
    models.length ? `The work was done by ${models.join(', ')}.` : 'No model was used.',
    !shown.length ? 'No findings wait for you.' : `${shown.length} finding${shown.length === 1 ? ' waits' : 's wait'} for you: Keep, Dismiss or Turn into a task.`,
  ];
  const best = bestItems(shown);
  const bestIds = new Set(best.map((i) => i.id));
  const needs = shown.filter((i) => i.kind === 'needs');
  const groups = KINDS.filter((k) => k !== 'needs').map((k) => ({ kind: k, words: KIND_WORDS[k], items: shown.filter((i) => i.kind === k && !bestIds.has(i.id)) })).filter((g) => g.items.length);
  const notDone = [];
  for (const a of ACTIVITIES) {
    const p = session.plan?.[a.id]; if (!p) continue;
    if (p.status === 'done' && p.summary) continue;
    if (p.status === 'skipped' || p.status === 'failed') notDone.push(`${a.title}: ${p.why || 'not done'}.`);
    else if (p.status === 'pending' && a.tier <= (session.tier || 0)) notDone.push(`${a.title}: ${p.why || (session.state === 'running' ? 'not reached yet' : 'not reached before you came back')}.`);
  }
  const later = ACTIVITIES.filter((a) => a.tier > (session.tier || 0));
  if (later.length) notDone.push(`Not started, they open after a longer time away: ${later.map((a) => a.title).join(', ')}.`);
  return { head, best, groups, needs, notDone, rule: BEST_RULE };
}

/** The note as plain text (Home's card and the tests read the same words). */
export function noteText(note) {
  const L = [...note.head];
  if (note.best.length) { L.push('', 'Best first:'); for (const i of note.best) L.push(`- ${i.title}`); }
  if (note.needs.length) { L.push('', 'Needs you:'); for (const i of note.needs) L.push(`- ${i.title}`); }
  for (const g of note.groups) { L.push('', `${g.words}:`); for (const i of g.items) L.push(`- ${i.title}`); }
  if (note.notDone.length) { L.push('', 'Not done:'); for (const x of note.notDone) L.push(`- ${x}`); }
  return L.join('\n');
}
