// The roster. Core owns the table because the model door, approvals and jobs name agents.
import { now } from './storage.js';

export const SEED = [
  { id: 'coordinator', name: 'Coordinator', role: 'Routes every ask to the right agent and answers simple questions itself', personality: 'Calm, brief, plain words. Never guesses facts it has not checked.', instructions: 'You are the Coordinator of Agent Population Desk, a local desk of agents working for the owner. Answer plainly. When a job needs an agent or a tool, use the tool. Name what you did not check.' },
  { id: 'scout', name: 'Scout', role: 'Research and reports', personality: 'Thorough, sceptical, cites every claim.', instructions: 'You research. Every claim carries a source the owner can open. Say "not checked" when a page did not say it.' },
  { id: 'closer', name: 'Closer', role: 'Leads, outreach drafts, pipeline', personality: 'Warm, concrete, short sentences. Never sends anything itself.', instructions: 'You find leads with sources and write outreach drafts. Nothing is sent until the owner approves the draft.' },
  { id: 'operator', name: 'Operator', role: 'Browser and long jobs', personality: 'Patient and careful. Reports each step.', instructions: 'You drive your own browser to finish long tasks. Never enter a payment or login without the owner. Stop and ask when unsure.' },
  { id: 'coder', name: 'Coder', role: 'Files, tables and code', personality: 'Precise. Shows the file it made.', instructions: 'You make files: tables, documents, scripts. Put them in the workspace and show the path.' },
];

export class Agents {
  constructor(storage, events) { this.s = storage; this.events = events; this.seed(); }
  seed() {
    const n = this.s.get('SELECT COUNT(*) AS c FROM agents').c;
    if (n > 0) return;
    for (const a of SEED) this.create(a);
  }
  row(r) {
    if (!r) return null;
    const j = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
    return { id: r.id, name: r.name, role: r.role || '', personality: r.personality || '', instructions: r.instructions || '', model: { main: j(r.model_main, null), fallback: j(r.model_fallback, null) }, tools: j(r.tools, []), enabled: !!r.enabled, created: r.created, updated: r.updated, meta: j(r.meta, {}) };
  }
  list() { return this.s.all('SELECT * FROM agents ORDER BY created').map(r => this.row(r)); }
  get(id) { return this.row(this.s.get('SELECT * FROM agents WHERE id = ?', id)); }
  create(a) {
    const id = a.id || a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent-' + Date.now().toString(36);
    const t = now();
    this.s.run('INSERT INTO agents (id, name, role, personality, instructions, model_main, model_fallback, tools, enabled, created, updated, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      id, a.name, a.role || '', a.personality || '', a.instructions || '', a.model?.main ? JSON.stringify(a.model.main) : null, a.model?.fallback ? JSON.stringify(a.model.fallback) : null, JSON.stringify(a.tools || []), t, t, JSON.stringify(a.meta || {}));
    this.events?.emit('agents', { id, change: 'create' });
    return this.get(id);
  }
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    const next = { ...cur, ...patch, model: { ...cur.model, ...(patch.model || {}) }, meta: { ...cur.meta, ...(patch.meta || {}) } };
    this.s.run('UPDATE agents SET name = ?, role = ?, personality = ?, instructions = ?, model_main = ?, model_fallback = ?, tools = ?, enabled = ?, updated = ?, meta = ? WHERE id = ?',
      next.name, next.role, next.personality, next.instructions, next.model.main ? JSON.stringify(next.model.main) : null, next.model.fallback ? JSON.stringify(next.model.fallback) : null, JSON.stringify(next.tools || []), next.enabled ? 1 : 0, now(), JSON.stringify(next.meta || {}), id);
    this.events?.emit('agents', { id, change: 'update' });
    return this.get(id);
  }
  remove(id) { this.s.run('DELETE FROM agents WHERE id = ?', id); this.events?.emit('agents', { id, change: 'remove' }); }
  /** The system prompt for an agent: who it is, how it talks, its standing instructions. */
  systemPrompt(id, extra = '') {
    const a = this.get(id);
    if (!a) return extra;
    return [`You are ${a.name}, an agent in AP Desk (Agent Population Desk).`, a.role && `Your job: ${a.role}.`, a.personality && `Your manner: ${a.personality}`, a.instructions, extra].filter(Boolean).join('\n');
  }
}
