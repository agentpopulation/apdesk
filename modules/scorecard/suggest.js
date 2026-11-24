// When an agent keeps scoring low on one model for two weeks while another model on this desk did clearly better, say so
// in one sentence with the numbers. Pure counting over the desk's own ratings. Nothing here switches anything.
import { modelKey } from './stats.js';

export const RULES = Object.freeze({
  minRated: 8,        // rated replies on the agent's model, in the two weeks, before any suggestion
  highShare: 0.4,     // poor ratings or failed answers, as a share of rated plus failed, in each of the two weeks
  minPerWeek: 2,      // rated plus failed replies needed in a week for that week to count
  otherMinRated: 5,   // rated replies the other model needs on this desk
  otherGood: 0.8,     // and the share of them rated good
  betterBy: 0.3,      // and how far above the agent's own good share
  learnedFloor: 0.7,  // the door's own record: a model that answered less often than this is not suggested
});

const tally = (rows) => { const t = { up: 0, down: 0, failed: 0 }; for (const r of rows) { if (r.thumb === 'up') t.up++; else if (r.thumb === 'down') t.down++; if (r.failed) t.failed++; } t.rated = t.up + t.down; return t; };
const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && (a.model || '') === (b.model || '');

/**
 * evidence: replies of the last two weeks [{ agentId, week (0 or 1), model: { provider, model } | null, thumb: 'up' | 'down' | null, failed }]
 * agents: [{ id, name, main: { provider, model } | null }]
 * costOf(provider, model) -> 'free' | 'paid' | 'unknown'; paidOn: the owner switched paid models on; learned: [{ purpose, provider, model, calls, share, enough }]
 * -> { suggestions: [...], needs: [{ agentId, name, rated, more }], heldBack: [{ agentId, reason }] }
 */
export function suggest({ evidence, agents, label = (p, m) => m || p, costOf = () => 'free', paidOn = false, learned = [] }) {
  const out = { suggestions: [], needs: [], heldBack: [] };
  for (const a of agents) {
    const mine = evidence.filter(e => e.agentId === a.id && e.week <= 1);
    if (!mine.length) continue;
    // the model that wrote most of this agent's replies in the two weeks
    const count = new Map(); for (const e of mine) if (e.model) { const k = modelKey(e.model.provider, e.model.model); count.set(k, (count.get(k) || 0) + 1); }
    const top = [...count.entries()].sort((x, y) => y[1] - x[1])[0]; if (!top) continue;
    const M = mine.find(e => e.model && modelKey(e.model.provider, e.model.model) === top[0]).model;
    const onM = mine.filter(e => e.model && sameModel(e.model, M));
    const all = tally(onM);
    if (all.rated < RULES.minRated) { out.needs.push({ agentId: a.id, name: a.name, rated: all.rated, more: RULES.minRated - all.rated }); continue; }
    const weeks = [0, 1].map(w => tally(onM.filter(e => e.week === w)));
    const high = weeks.every(t => t.rated + t.failed >= RULES.minPerWeek && (t.down + t.failed) / (t.rated + t.failed) >= RULES.highShare);
    if (!high) continue;
    const poor = all.down, failed = all.failed, base = all.rated + all.failed;
    const myGood = all.up / all.rated;
    // the other models: what they did on this desk in the same two weeks
    const others = new Map();
    for (const e of evidence) if (e.week <= 1 && e.model && !sameModel(e.model, M)) { const k = modelKey(e.model.provider, e.model.model); (others.get(k) || others.set(k, { model: e.model, rows: [] }).get(k)).rows.push(e); }
    const cands = [];
    for (const { model, rows } of others.values()) {
      const t = tally(rows); if (!model.model || t.rated < RULES.otherMinRated) continue;
      const good = t.up / t.rated;
      if (good < RULES.otherGood || good - myGood < RULES.betterBy) continue;
      if (sameModel(a.main, model)) continue;   // already the agent's own choice
      const rec = learned.find(r => r.provider === model.provider && r.model === model.model && r.purpose === 'chat' && r.enough);
      if (rec && rec.share < RULES.learnedFloor) continue;   // the desk's own call record says it often fails to answer
      cands.push({ model, t, good, cost: costOf(model.provider, model.model) });
    }
    cands.sort((x, y) => y.good - x.good || y.t.rated - x.t.rated);
    const usable = cands.filter(c => c.cost === 'free' || paidOn);
    if (!usable.length) { if (cands.length) out.heldBack.push({ agentId: a.id, reason: 'paid' }); continue; }
    const B = usable[0];
    const from = label(M.provider, M.model), to = label(B.model.provider, B.model.model);
    const what = failed ? 'rated poor or failed' : 'rated poor';
    out.suggestions.push({
      agentId: a.id, agentName: a.name, from: { ...M, label: from }, to: { ...B.model, label: to }, poor, failed, base, goodOther: B.t.up, ratedOther: B.t.rated, cost: B.cost, paid: B.cost !== 'free',
      text: `${a.name}: ${poor + failed} of ${base} replies ${what} on ${from} in two weeks; ${to} was rated good ${B.t.up} of ${B.t.rated} times here.${B.cost === 'paid' ? ' It costs money.' : B.cost === 'unknown' ? ' It may cost money.' : ''} Switch?`,
    });
  }
  return out;
}
