// Pure helpers for the Desk view of the Network page: the agent states, the agent-to-provider numbers and the picture
// geometry. Nothing here reads storage or the network; the server hands in rows the desk already holds.

const DAY = 86400_000;

/** One entry per enabled agent: working, waiting (for the owner), failed (last 24 hours), or idle, and what it is doing. */
export function agentStates({ agents = [], jobs = [], now = Date.now() } = {}) {
  const newest = (xs, key) => xs.slice().sort((a, b) => String(b[key] || '').localeCompare(String(a[key] || '')))[0];
  return agents.filter(a => a.enabled).map((a) => {
    const mine = jobs.filter(j => j.agentId === a.id);
    const waiting = newest(mine.filter(j => j.status === 'waiting'), 'updated');
    const running = newest(mine.filter(j => j.status === 'running'), 'updated');
    const failed = newest(mine.filter(j => j.status === 'failed' && Date.parse(j.finished || j.updated) >= now - DAY), 'finished');
    let state = 'idle', doing = null;
    if (waiting) { state = 'waiting'; doing = waiting.title; }
    else if (running) { state = 'working'; doing = running.title; }
    else if (failed) { state = 'failed'; doing = `${failed.title}${failed.error ? ': ' + String(failed.error).slice(0, 80) : ''}`; }
    return { id: a.id, name: a.name || a.id, role: a.role || '', state, doing: doing ? String(doing).slice(0, 100) : null };
  });
}

/**
 * Agents on one side, providers on the other, joined by the number of calls in the last 24 hours.
 *   calls: [{ agent_id, provider, ok }] from the core calls table   health: [{ provider, status }] (up, slow, down)
 *   visits: [{ agentId, host }] pages the agents opened (for the domain side of the selection)
 * Only agents that made calls are drawn. A provider whose last check failed is down, and so are its callers' marks.
 */
export function dependencyModel({ agents = [], calls = [], health = [], visits = [], label = (p) => p } = {}) {
  const name = new Map(agents.map(a => [a.id, a.name || a.id]));
  const hmap = new Map(health.map(h => [h.provider, h.status]));
  const edgeMap = new Map(), prov = new Map();
  for (const c of calls) {
    const p = c.provider || 'unknown';
    prov.set(p, (prov.get(p) || 0) + 1);
    if (!c.agent_id || !name.has(c.agent_id)) continue;
    const k = c.agent_id + '\u0000' + p; edgeMap.set(k, (edgeMap.get(k) || 0) + 1);
  }
  const edges = [...edgeMap].map(([k, count]) => { const [agentId, provider] = k.split('\u0000'); return { agentId, provider, count }; })
    .sort((a, b) => b.count - a.count || a.agentId.localeCompare(b.agentId) || a.provider.localeCompare(b.provider));
  const providers = [...prov].map(([provider, n]) => ({ provider, label: label(provider) || provider, calls: n, health: hmap.get(provider) ?? null, down: hmap.get(provider) === 'down' }))
    .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider));
  const downSet = new Set(providers.filter(p => p.down).map(p => p.provider));
  const order = agents.map(a => a.id);
  const ids = [...new Set(edges.map(e => e.agentId))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const out = ids.map(id => ({ id, name: name.get(id), calls: edges.filter(e => e.agentId === id).reduce((s, e) => s + e.count, 0), affected: edges.some(e => e.agentId === id && downSet.has(e.provider)) }));
  const plabel = new Map(providers.map(p => [p.provider, p.label]));
  const table = out.flatMap(a => edges.filter(e => e.agentId === a.id).map(e => ({ agent: a.name, provider: plabel.get(e.provider), calls: e.count, down: downSet.has(e.provider), health: hmap.get(e.provider) ?? null })));
  return { agents: out, providers, edges, table, visits: visits.filter(v => v.agentId && v.host).map(v => ({ agentId: v.agentId, host: String(v.host).toLowerCase() })) };
}

export const strokeWidth = (n, max) => (max > 0 ? Math.round((1 + 9 * Math.sqrt(Math.min(n, max) / max)) * 10) / 10 : 1);

/** Geometry only: node positions on two columns and one line per edge. */
export function layoutDeps(model, { width = 640, rowH = 34, pad = 14 } = {}) {
  const empty = !model.edges.length;
  const max = Math.max(0, ...model.edges.map(e => e.count));
  const rows = Math.max(model.agents.length, model.providers.length, 1);
  const height = pad * 2 + rows * rowH;
  const lx = Math.round(width * 0.3), rx = Math.round(width * 0.7);
  const at = (i, n) => Math.round(pad + rowH / 2 + (n === 1 ? (rows - 1) * rowH / 2 : i * ((rows * rowH - rowH) / Math.max(1, n - 1))));
  const agents = model.agents.map((a, i, l) => ({ ...a, x: lx, y: at(i, l.length) }));
  const providers = model.providers.map((p, i, l) => ({ ...p, x: rx, y: at(i, l.length) }));
  const lines = model.edges.map(e => {
    const a = agents.find(n => n.id === e.agentId), p = providers.find(n => n.provider === e.provider);
    return { agentId: e.agentId, provider: e.provider, count: e.count, x1: a.x, y1: a.y, x2: p.x, y2: p.y, w: strokeWidth(e.count, max), down: !!p.down };
  });
  return { empty, width, height, agents, providers, lines };
}

/** What a choice on one side marks on the other. sel: { kind: 'provider'|'domain', key } or null. */
export function related(model, sel) {
  const out = { providers: new Set(), agents: new Set() };
  if (!sel?.key) return out;
  const key = String(sel.key).toLowerCase();
  if (sel.kind === 'provider') {
    for (const p of model.providers) if (p.provider.toLowerCase() === key || String(p.label).toLowerCase() === key) out.providers.add(p.provider);
    for (const e of model.edges) if (out.providers.has(e.provider)) out.agents.add(e.agentId);
  } else if (sel.kind === 'domain') {
    for (const v of model.visits) if (v.host === key || v.host.endsWith('.' + key)) out.agents.add(v.agentId);
  }
  return out;
}

// A web address ends in letters, so 94.3 and 203.0.113.5 are not one.
const HOST = /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}\b/i;
const names = (p) => [p.provider, p.label].map(x => String(x || '').toLowerCase()).filter(x => x.length >= 3);

/** What a click on a row of the Link side means: a known provider in its text, else a web address, else nothing. */
export function pickFromText(text, model) {
  const t = String(text || '').toLowerCase();
  for (const p of model.providers) if (names(p).some(n => t.includes(n))) return { kind: 'provider', key: p.provider };
  const m = t.match(HOST);
  return m ? { kind: 'domain', key: m[0] } : null;
}

/** Does a row of Link-side text belong to the choice? */
export function textMatches(text, sel, model) {
  if (!sel?.key) return false;
  const t = String(text || '').toLowerCase(), key = String(sel.key).toLowerCase();
  if (sel.kind === 'domain') return t.includes(key);
  const p = model.providers.find(x => x.provider.toLowerCase() === key);
  return p ? names(p).some(n => t.includes(n)) : t.includes(key);
}
