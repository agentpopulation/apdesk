// The morning brief: what goes in it. Sections, in order:
// Tasks (running, waiting for you), Needs you (approvals), Did not work since yesterday, then pipeline and news.
// Every source is optional and null-safe: a section whose module is off is left out, never invented.
// The whole brief is built by code from the desk's own records: no model call, so it is instant and the same on every model.
const MAX = 6;
const one = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function zonedTime(iso, timeZone) {
  try { return new Date(iso).toLocaleString('en-IN', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return String(iso); }
}

/** The stored one-line summary of a finished job, quoted as it is: its own `summary`, a report's stored summary,
 *  a council decision or the first line of its answer. Never re-described; cut only at a sentence end (or marked with …). */
export function storedSummary(ctx, job) {
  const o = job?.output && typeof job.output === 'object' ? job.output : null;
  if (!o) return '';
  let s = typeof o.summary === 'string' ? o.summary : '';
  if (!s && o.reportId) { try { s = ctx.modules.api('research')?.report?.(o.reportId)?.summary || ''; } catch {} }
  if (!s) s = [o.decision, o.answer, o.result, o.text].find(x => typeof x === 'string' && x.trim()) || '';
  s = String(s).split(/\n/).map(x => x.trim()).find(Boolean) || '';
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= 220) return s;
  const cut = s.slice(0, 220); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

/** Gather the facts, every line built by code from the desk's own records.
 *  Returns { sections: [{ title, rows }], sources: [{ title, url }], tz, sinceWords } */
export async function gatherBrief(ctx, { topics = [], signal, since = null, sinceMs = 24 * 3600_000 } = {}) {
  const tz = ctx.settings.get('timeZone') || 'Asia/Kolkata';
  const sinceWords = since ? 'since the last brief' : 'since yesterday';
  since = since || new Date(Date.now() - sinceMs).toISOString();
  const sections = []; const sources = [];
  // flows runs are the brief itself; quiet jobs are the desk's own upkeep and show here only when they failed
  const own = (j) => !String(j.kind).startsWith('flows.') && (!j.quiet || j.status === 'failed');
  // a scheduled run that is not a brief and did not finish is the owner's work too
  const ranForOwner = (j) => j.kind === 'flows.schedule' && j.input?.kind && j.input.kind !== 'brief';
  const jobs = ctx.jobs.list({ limit: 200 });
  const running = jobs.filter(j => j.status === 'running' && own(j));
  const waitingJobs = jobs.filter(j => j.status === 'waiting' && own(j));
  const done = jobs.filter(j => j.status === 'done' && j.finished >= since && own(j));
  const unfinished = jobs.filter(j => ['failed', 'interrupted', 'stopped'].includes(j.status) && (j.finished || j.updated) >= since && (own(j) || ranForOwner(j)));
  let pending = [];
  try { pending = ctx.approval.listPending() || []; } catch {}
  const name = (id) => ctx.agents.get(id)?.name || 'An agent';
  const at = (iso) => iso ? zonedTime(iso, tz) : 'time not recorded';
  const word = { failed: 'failed', stopped: 'stopped', interrupted: 'interrupted by a restart' };
  const waiting = [...pending.map(a => `${one(a.title)}: waiting for your approval (asked by ${name(a.agentId)}), since ${at(a.created)}`), ...waitingJobs.map(j => `${one(j.title)}: waiting for you, since ${at(j.updated)}`)];
  const counts = { running: running.length, waiting: waiting.length, done: done.length, unfinished: unfinished.length };
  // a counted section: the title holds the true count; rows past MAX are cut and the section says how many more there are
  const counted = (title, items, row) => {
    const rows = items.slice(0, MAX).map(row);
    if (items.length > MAX) rows.push(`and ${items.length - MAX} more, in Tasks`);
    sections.push({ title: `${title} (${items.length})`, rows });
  };
  counted('Running now', running, j => `${one(j.title)}: running (${name(j.agentId)}), started ${at(j.created)}`);
  counted('Waiting for you', waiting, x => x);
  counted(`Finished ${sinceWords}`, done, j => { const s = storedSummary(ctx, j); return `${one(j.title)}: done (${name(j.agentId)}), finished ${at(j.finished)}${s ? `. Its summary: "${s}"` : ''}`; });
  counted(`Did not finish ${sinceWords}`, unfinished, j => `${one(j.title)}: ${j.status === 'failed' && j.error ? `did not finish: ${one(j.error, 200)}` : word[j.status]}, ${at(j.finished || j.updated)}`);
  const sales = ctx.modules.api('sales');
  if (sales?.listLeads) {
    try {
      const leads = (await sales.listLeads()) || [];
      const list = Array.isArray(leads) ? leads : (leads.leads || []);
      const moved = list.filter(l => (l.updated || l.moved || l.changed || '') >= since);
      const byStage = {};
      for (const l of list) { const s = l.stage || l.status || 'New'; byStage[s] = (byStage[s] || 0) + 1; }
      sections.push({ title: 'Pipeline', rows: [
        ...(list.length ? [`${list.length} lead${list.length === 1 ? '' : 's'}: ${Object.entries(byStage).map(([s, n]) => `${n} ${s}`).join(', ')}`] : []),
        ...moved.slice(0, MAX).map(l => `Changed: ${one(l.company || l.name || l.title, 50)}${l.stage ? ' now ' + l.stage : ''}`),
        ...(moved.length > MAX ? [`and ${moved.length - MAX} more, in Sales`] : []),
      ] });
    } catch (e) { sections.push({ title: 'Pipeline', rows: [`Not checked: ${one(e.message, 60)}`] }); }
  }
  const search = ctx.modules.api('search');
  const named = (topics || []).map(t => one(t, 60)).filter(Boolean).slice(0, 3);
  if (named.length) {
    if (!search?.search) sections.push({ title: 'News', rows: ['Not checked: the Search module is off.'] });
    else for (const topic of named) {
      try {
        const hits = (await search.search(`${topic} news`, { count: 4, signal })) || [];
        const rows = hits.slice(0, 4).map(hh => { sources.push({ title: hh.title, url: hh.url }); return `${one(hh.title, 90)} (${one(hh.source || safeHost(hh.url), 30)}) ${hh.url}`; });
        if (rows.length) sections.push({ title: `News on ${topic}`, rows });
      } catch (e) { if (signal?.aborted) throw e; sections.push({ title: `News on ${topic}`, rows: [`Not checked: ${one(e.message, 60)}`] }); }
    }
  }
  return { sections: sections.filter(x => x.rows.length), counts, sources, tz, sinceWords };
}
const safeHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** The opening line, built from the true counts: "2 finished, 1 did not finish, nothing waits for you." */
export function openingLine(counts = {}) {
  const { running = 0, done = 0, unfinished = 0, waiting = 0 } = counts;
  const parts = [];
  if (running) parts.push(`${running} running`);
  if (done) parts.push(`${done} finished`);
  if (unfinished) parts.push(`${unfinished} did not finish`);
  parts.push(waiting ? `${waiting} wait${waiting === 1 ? 's' : ''} for you` : 'nothing waits for you');
  const line = parts.join(', ') + '.';
  return line[0].toUpperCase() + line.slice(1);
}

/** The whole brief: the opening line from the counts, then the code-built lines under their headings. */
export function composeBrief({ facts }) {
  if (!facts.sections.length) return `Nothing to report: nothing is running, nothing waits for you, and nothing finished or failed ${facts.sinceWords || 'since yesterday'}.`;
  const body = facts.sections.flatMap(s => ['', `**${s.title}**`, ...s.rows.map(r => `- ${r}`)]);
  return [openingLine(facts.counts), ...body].join('\n').trim() + `\n\nTimes are in ${facts.tz}.`;
}

export const BRIEF_TEMPLATE = { title: 'Morning brief', when: 'Every morning at 8', prompt: 'Brief me: what is running, what waits for me, pipeline changes and news on my topics.', kind: 'brief', topics: [] };
