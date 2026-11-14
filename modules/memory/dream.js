// Dream: review the day's memories, merge duplicates, write one short summary memory, lower the weight of stale ones.
// The stale rule: older than 7 days and not used for 30.
import { DAY_MS, STALE_AGE_DAYS, FORGET_AGE_DAYS, normText, jaccard, clip } from './store.js';
import { parseJson } from './learn.js';

export const DREAM_SYSTEM = `You tidy the long-term memory of a business owner's AI agents. You get a list of memories, each with an id and a scope.
1. Find duplicates: memories in the SAME scope that state the same fact, even in other words. Do not merge different facts that are only about the same subject ("makes sensors" and "sells to data centres" are two facts). For each group give the ids and one merged sentence that keeps all the information.
2. Write one short summary (two or three sentences) of what was learned today about the owner and his business. Leave it empty if there is nothing worth summarising.
Return JSON only: {"merge":[{"ids":[1,2],"text":"merged sentence"}],"summary":"..."}`;

export async function dream({ store, model, signal, progress = () => {}, log = () => {} }) {
  const report = { merged: 0, groups: [], summary: null, lowered: 0, reviewed: 0, label: null, at: new Date().toISOString() };
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const all = store.list({ limit: 2000 }).filter(m => m.kind !== 'summary');
  const today = all.filter(m => m.at >= since || m.updated >= since);
  report.reviewed = today.length;
  progress(0.1, `Reviewing ${today.length} memories from today`);
  // 1. plain duplicates (the same words in the same scope) need no model
  const byScope = new Map(); for (const m of all) { const k = (m.agentId || '') + '|' + m.kind; if (!byScope.has(k)) byScope.set(k, []); byScope.get(k).push(m); }
  const gone = new Set();
  for (const [, list] of byScope) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j]; if (gone.has(a.id) || gone.has(b.id)) continue;
    if (normText(a.text) === normText(b.text) || jaccard(a.text, b.text) >= 0.85) {
      const keep = a.text.length >= b.text.length ? a : b; const drop = keep === a ? b : a;
      store.mergeInto(keep.id, [drop.id], keep.text); gone.add(drop.id); report.merged++; report.groups.push({ ids: [keep.id, drop.id], text: keep.text, how: 'same words' });
    }
  }
  // 2. duplicates in other words, and the summary: one model call over today's memories and their near neighbours
  const fresh = today.filter(m => !gone.has(m.id));
  if (fresh.length >= 2 && model) {
    const pool = new Map(fresh.map(m => [m.id, m]));
    for (const m of fresh) for (const n of store.search({ agentId: m.agentId, query: m.text, limit: 4 })) if (!gone.has(n.id) && n.kind !== 'summary') pool.set(n.id, n);
    const items = [...pool.values()].slice(0, 60).map(m => ({ id: m.id, scope: m.agentId || 'shared', kind: m.kind, text: m.text }));
    progress(0.4, 'Looking for duplicates in other words');
    const ask = () => model.chat({ purpose: 'small', json: true, signal, temperature: 0, maxTokens: 2500, messages: [{ role: 'system', content: DREAM_SYSTEM }, { role: 'user', content: JSON.stringify(items) }] });
    let r = await ask(); let j = parseJson(r);
    if (!j) { log('dream: unreadable reply from', r.label, clip(r.text, 200)); r = await ask(); j = parseJson(r); }   // one more try; the door rotates models
    report.label = r.label;
    if (!j) { report.note = 'The model reply could not be read: ' + clip(r.text, 160); j = {}; }
    for (const g of Array.isArray(j.merge) ? j.merge : []) {
      const ids = (g.ids || []).map(Number).filter(id => pool.has(id) && !gone.has(id));
      if (ids.length < 2) continue;
      const scope = pool.get(ids[0]).agentId || ''; if (!ids.every(id => (pool.get(id).agentId || '') === scope)) continue;
      const keep = ids.slice().sort((a, b) => (pool.get(b).weight - pool.get(a).weight) || (a - b))[0];
      const text = clip(g.text || pool.get(keep).text, 600);
      store.mergeInto(keep, ids.filter(x => x !== keep), text); ids.filter(x => x !== keep).forEach(x => gone.add(x));
      report.merged += ids.length - 1; report.groups.push({ ids, text, how: 'same meaning' });
    }
    const summary = clip(j.summary || '', 500);
    if (summary && fresh.length >= 3) { const d = new Date().toISOString().slice(0, 10); report.summary = store.add({ agentId: null, text: `Summary of ${d}: ${summary}`, kind: 'summary', source: 'dream' }); }
  }
  // 3. stale memories weigh less (lessons are kept at full weight: the owner taught them on purpose)
  progress(0.85, 'Lowering the weight of stale memories');
  const old = Date.now() - STALE_AGE_DAYS * DAY_MS, unused = Date.now() - FORGET_AGE_DAYS * DAY_MS;
  for (const m of store.list({ limit: 5000 })) {
    if (m.kind === 'lesson' || gone.has(m.id)) continue;
    const lastUse = m.lastUsed ? Date.parse(m.lastUsed) : 0;
    if (Date.parse(m.at) < old && lastUse < unused && m.weight > 0.2) { store.update(m.id, { weight: m.weight * 0.8 }); report.lowered++; }
  }
  log('dream', report.merged, 'merged', report.lowered, 'lowered');
  return report;
}

/** The nightly Dream is due once a night, between 3:17 and 3:47 in the owner's zone. A missed night is not run later. */
export const NIGHTLY = { hour: 3, minute: 17, windowMin: 30 };
export function nightlyDue(now, timeZone, lastDay) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  catch { parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  const g = (t) => parts.find(p => p.type === t)?.value;
  const day = `${g('year')}-${g('month')}-${g('day')}`; const mins = Number(g('hour')) * 60 + Number(g('minute'));
  const start = NIGHTLY.hour * 60 + NIGHTLY.minute;
  return { day, due: mins >= start && mins < start + NIGHTLY.windowMin && lastDay !== day };
}
