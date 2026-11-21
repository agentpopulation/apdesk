// The brief the four advisors of the Turnaround review all read: the desk's own records, nothing else.
// A record the Council cannot reach is written as "not checked", never guessed.
export const DEFAULT_QUESTION = 'What should the next 30 days look like for this business?';
const num = (v) => Number.isFinite(v) ? String(v) : 'not checked';

/** facts: { about, leads, inTalks, draftsWaiting, customers, tasks: { running, done, failed, of } | null }; null means not reached. */
export function buildBrief(f = {}) {
  const t = f.tasks;
  return [
    "Brief from this desk's own records. Nothing here comes from outside.",
    `What the owner sells: ${f.about ? `"${String(f.about).replace(/"{3,}/g, '"')}"` : 'not checked (the owner has not said)'}`,
    `Leads in the pipeline: ${num(f.leads)}`,
    `In talks: ${num(f.inTalks)}`,
    `Drafts waiting for approval: ${num(f.draftsWaiting)}`,
    `Customers: ${num(f.customers)}`,
    t ? `Recent tasks (last ${t.of}): ${t.running} running, ${t.done} finished, ${t.failed} failed` : 'Recent tasks: not checked',
    'Anything not in this brief is "not checked".',
  ].join('\n');
}
