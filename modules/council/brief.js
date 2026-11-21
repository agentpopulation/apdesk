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
    'Anything not in this brief has not been checked.',
  ].join('\n');
}

/** The owner's place and money, from settings, and the rule for figures. Read by every seat and the chairman. */
export function ownerLine({ country, currency, locale } = {}) {
  const loc = locale || 'en';
  const name = (type, code) => { try { return code ? new Intl.DisplayNames([loc], { type }).of(code) : ''; } catch { return ''; } };
  let sign = ''; try { sign = currency ? new Intl.NumberFormat(loc, { style: 'currency', currency }).formatToParts(0).find(p => p.type === 'currency')?.value || '' : ''; } catch {}
  const place = name('region', country); const money = name('currency', currency);
  return [
    place || currency ? `The owner is${place ? ' in ' + place : ''}${currency ? `${place ? ' and' : ''} works in ${money || currency} (${currency}${sign && sign !== currency ? ', ' + sign : ''})` : ''}. Give any money in ${currency || 'the owner\'s currency'}; never convert another currency by guess.` : '',
    'Any figure needs a record or a page it came from. The records are in the question and the brief; no page was read here. A figure without one is shown to the owner as not checked. There were no earlier talks, so name no source but the question and the brief.',
  ].filter(Boolean).join('\n');
}
