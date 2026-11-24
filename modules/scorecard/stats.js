// Counting only. Every figure comes from the desk's own records handed in here; a figure the records cannot give is null
// ("not known"), never a guess. No model is called anywhere in this module.
import { weekIndexOf } from './weeks.js';

const ANSWER_PURPOSES = new Set(['chat', 'research', 'draft', 'council', 'code']);   // calls that make an answer (not embeddings, plans, small helpers)
export const modelKey = (provider, model) => `${provider || ''}|${model || ''}`;

export function median(list) {
  const t = list.filter(Number.isFinite).sort((a, b) => a - b); const n = t.length;
  if (!n) return null;
  return n % 2 ? t[(n - 1) / 2] : (t[n / 2 - 1] + t[n / 2]) / 2;
}
const parse = (x) => { try { return x ? JSON.parse(x) : null; } catch { return null; } };

/** Which model wrote a reply, from the attempts the door reported: the last one that answered; for a reply that failed, the last one tried. */
export function servedBy(msg) {
  const tries = (Array.isArray(msg?.meta?.models) ? msg.meta.models : []).filter(a => a && a.provider && !a.skipped);
  const win = [...tries].reverse().find(a => a.ok);
  const a = msg?.status === 'error' ? tries.at(-1) : win;
  return a ? { provider: a.provider, model: a.model || null } : null;
}

const emptyCell = () => ({ replies: 0, failedReplies: 0, jobs: { done: 0, failed: 0, stopped: 0 }, approvals: null, ratings: null, timeMs: null, cost: { minor: 0, unknownCalls: 0, calls: 0 }, models: [], work: 0 });

/**
 * -> { cells: { agentId: [cell for each week] }, evidence: [{ agentId, week, model, thumb, failed }] }
 * approvals: null when the desk cannot say, else (week) => [{ agentId, asked, denied }]
 * ratings: null when the desk cannot say, else Map(messageId -> 'up' | 'down')
 */
export function buildCells({ weeks, agentIds, calls = [], jobs = [], messages = [], ratings = null, approvals = null, labelOf = (p, m) => m || p, currency = '' }) {
  const ids = new Set(agentIds);
  const cells = {}; for (const id of agentIds) cells[id] = weeks.map(() => emptyCell());
  const evidence = [];
  const times = {}, perModel = {}, okCalls = {};
  const slot = (id, w) => { (perModel[id] ||= weeks.map(() => new Map()))[w]; return perModel[id][w]; };

  for (const c of calls) {
    if (!ids.has(c.agent_id)) continue;
    const w = weekIndexOf(weeks, c.at); if (w < 0) continue;
    const cell = cells[c.agent_id][w];
    cell.cost.calls++;
    // a cost in another currency than today's cannot be added to the rest: it counts as not known
    if (c.cost_minor == null || (c.currency && currency && c.currency !== currency)) cell.cost.unknownCalls++; else cell.cost.minor += Number(c.cost_minor) || 0;
    const key = modelKey(c.provider, c.model);
    const m = slot(c.agent_id, w); const row = m.get(key) || { provider: c.provider, model: c.model || null, calls: 0, ok: 0, failed: 0, skipped: 0 };
    row.calls++; if (c.ok) row.ok++; else row.failed++; m.set(key, row);
    if (c.ok) { okCalls[c.agent_id] ||= weeks.map(() => 0); okCalls[c.agent_id][w]++; }
    if (c.ok && ANSWER_PURPOSES.has(c.purpose || 'chat') && Number(c.ms) > 0) { (times[c.agent_id] ||= weeks.map(() => []))[w].push(Number(c.ms)); }
  }

  for (const j of jobs) {
    if (!ids.has(j.agent_id) || parse(j.input)?.quiet === true) continue;   // the desk's own upkeep is not an agent's work
    const st = j.status === 'interrupted' ? 'stopped' : j.status;
    if (!['done', 'failed', 'stopped'].includes(st)) continue;
    const w = weekIndexOf(weeks, j.finished || j.created); if (w < 0) continue;
    cells[j.agent_id][w].jobs[st]++;
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !ids.has(msg.agentId) || msg.meta?.posted) continue;
    if (msg.status !== 'done' && msg.status !== 'error') continue;
    const w = weekIndexOf(weeks, msg.at); if (w < 0) continue;
    const cell = cells[msg.agentId][w]; const failed = msg.status === 'error';
    if (failed) cell.failedReplies++; else cell.replies++;
    const by = servedBy(msg);
    // attempts the door skipped (a model on cooldown, no tools, a spend limit) are counted for that model
    for (const a of (Array.isArray(msg.meta?.models) ? msg.meta.models : [])) if (a?.provider && a.skipped) {
      const m = slot(msg.agentId, w); const key = modelKey(a.provider, a.model); const row = m.get(key) || { provider: a.provider, model: a.model || null, calls: 0, ok: 0, failed: 0, skipped: 0 };
      row.skipped++; m.set(key, row);
    }
    const thumb = ratings ? (ratings.get(String(msg.id)) || null) : null;
    evidence.push({ agentId: msg.agentId, week: w, model: by, thumb, failed });
    if (ratings) { cell.ratings ||= { good: 0, poor: 0, rated: 0, share: null }; if (thumb === 'up') cell.ratings.good++; if (thumb === 'down') cell.ratings.poor++; }
  }

  for (const id of agentIds) weeks.forEach((wk, w) => {
    const cell = cells[id][w];
    if (ratings) { cell.ratings ||= { good: 0, poor: 0, rated: 0, share: null }; cell.ratings.rated = cell.ratings.good + cell.ratings.poor; cell.ratings.share = cell.ratings.rated ? cell.ratings.good / cell.ratings.rated : null; }
    if (approvals) { const hit = (approvals(wk) || []).find(a => a.agentId === id); cell.approvals = { asked: Number(hit?.asked) || 0, refused: Number(hit?.denied) || 0 }; }
    cell.timeMs = median(times[id]?.[w] || []);
    const rows = [...(perModel[id]?.[w]?.values() || [])];
    const total = okCalls[id]?.[w] || 0;
    cell.models = rows.map(r => ({ ...r, label: labelOf(r.provider, r.model), share: total && r.ok ? r.ok / total : (total ? 0 : null) })).sort((a, b) => b.ok - a.ok || b.calls - a.calls);
    cell.work = cell.replies + cell.jobs.done;
    cell.any = !!(cell.replies || cell.failedReplies || cell.jobs.done || cell.jobs.failed || cell.jobs.stopped || cell.cost.calls || cell.approvals?.asked);
  });
  return { cells, evidence };
}

/** Up, down or same against last week, on work done (replies written plus jobs done). null when there is nothing to compare. */
export function trend(now, before) {
  if (!now || !before || !before.any || !now.any) return null;
  if (now.work > before.work) return { dir: 'up', now: now.work, before: before.work };
  if (now.work < before.work) return { dir: 'down', now: now.work, before: before.work };
  return { dir: 'same', now: now.work, before: before.work };
}
