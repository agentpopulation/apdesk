// The roster. Core owns the table because the model door, approvals and jobs name agents.
import { now } from './storage.js';
import { avatarValue } from '../../modules/agents/ui-avatars.js';

// The Manager's first instructions before agents had roles; a desk that still holds them exactly is given the new ones.
const OLD_MANAGER_SEED = 'You are the Coordinator of Agent Population Desk, a local desk of agents working for the owner. Answer plainly. When a job needs an agent or a tool, use the tool. Name what you did not check.';
const MANAGER_SEED = 'You lead the team of AP Desk (Agent Population Desk), a local desk of agents working for the owner. Answer plainly. When a job needs an agent or a tool, use the tool. Name what you did not check.';
export const SEED = [
  { id: 'coordinator', name: 'Coordinator', role: 'Routes every ask to the right agent and answers simple questions itself', personality: 'Calm, brief, plain words. Never guesses facts it has not checked.', instructions: MANAGER_SEED },
  { id: 'scout', name: 'Scout', role: 'Research and reports', personality: 'Thorough, sceptical, cites every claim.', instructions: 'You research. Every claim carries a source the owner can open. Say "not checked" when a page did not say it.' },
  { id: 'closer', name: 'Closer', role: 'Leads, outreach drafts, pipeline', personality: 'Warm, concrete, short sentences. Never sends anything itself.', instructions: 'You find leads with sources and write outreach drafts. Nothing is sent until the owner approves the draft.' },
  { id: 'operator', name: 'Operator', role: 'Browser and long jobs', personality: 'Patient and careful. Reports each step.', instructions: 'You drive your own browser to finish long tasks. Never enter a payment or login without the owner. Stop and ask when unsure.' },
  { id: 'coder', name: 'Coder', role: 'Files, tables and code', personality: 'Precise. Shows the file it made.', instructions: 'You make files: tables, documents, scripts. Put them in the workspace and show the path.' },
];

// An agent's role words and the owner's own name for it: a small copy of the rule in modules/agents/ui-roles.js (the core
// does not import a module's code; test/agents-prompt.test.js keeps the two the same).
const BUILT_IN = { coordinator: 'Manager', scout: 'Researcher', closer: 'Sales expert', operator: 'Operations expert', coder: 'Coder', 'co-founder': 'AI Co-founder', 'product-lead': 'Product expert', 'ai-officer': 'AI expert', 'sales-lead': 'Sales expert' };
const HIRED = { 'co-founder': 'AI Co-founder', finance: 'Finance expert', marketing: 'Marketing expert', 'product-lead': 'Product expert', 'ai-officer': 'AI expert', secretary: 'Secretary', writer: 'Writer', 'customer-care': 'Customer care expert', recruiter: 'Recruiter', 'data-analyst': 'Data analyst' };
const PACKS = { researcher: 'Researcher', sales: 'Sales expert', operator: 'Operations expert', maker: 'Coder', writer: 'Writer', office: 'Secretary' };
const OLD_NAMES = { coordinator: 'Coordinator', scout: 'Scout', closer: 'Closer', operator: 'Operator', coder: 'Coder', 'co-founder': 'Co-founder', 'product-lead': 'Product lead', 'ai-officer': 'AI officer', 'sales-lead': 'Sales lead' };
const roleOf = (a) => (a ? BUILT_IN[String(a.id || '')] || HIRED[String(a.meta?.roleId || '')] || PACKS[String(a.meta?.pack || '')] || '' : '');
const ownName = (a) => { const n = String(a?.name || '').trim(); const low = n.toLowerCase(); return !n || low === roleOf(a).toLowerCase() || low === String(OLD_NAMES[a?.id] || '').toLowerCase() ? '' : n; };
/** "Kent · Researcher" with an own name, the role alone without one; never empty. */
const agentLine = (a, fallback = 'An agent') => { const r = roleOf(a), n = ownName(a); return n && r ? `${n} · ${r}` : r || n || fallback; };
export const CORE_ROLES = Object.freeze({ roleOf, ownName, agentLine });

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
    const meta = j(r.meta, {});
    return { id: r.id, name: r.name, role: r.role || '', personality: r.personality || '', instructions: r.instructions || '', model: { main: j(r.model_main, null), fallback: j(r.model_fallback, null) }, tools: j(r.tools, []), enabled: !!r.enabled, created: r.created, updated: r.updated, meta, avatar: avatarValue(meta.avatar) };
  }
  list() {
    // the seed is made in one go, so its agents can share a time; they keep the seed's order, also after one is hired back
    const pos = (id) => { const i = SEED.findIndex(a => a.id === id); return i < 0 ? SEED.length : i; };
    return this.s.all('SELECT * FROM agents ORDER BY created').map(r => this.row(r)).sort((a, b) => a.created < b.created ? -1 : a.created > b.created ? 1 : pos(a.id) - pos(b.id));
  }
  get(id) { return this.row(this.s.get('SELECT * FROM agents WHERE id = ?', id)); }
  create(a) {
    const id = a.id || a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent-' + Date.now().toString(36);
    const t = now();   // a built-in agent hired back keeps its first place in the list
    this.s.run('INSERT INTO agents (id, name, role, personality, instructions, model_main, model_fallback, tools, enabled, created, updated, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      id, a.name, a.role || '', a.personality || '', a.instructions || '', a.model?.main ? JSON.stringify(a.model.main) : null, a.model?.fallback ? JSON.stringify(a.model.fallback) : null, JSON.stringify(a.tools || []), a.created || t, t, JSON.stringify(a.meta || {}));
    this.events?.emit('agents', { id, change: 'create' });
    return this.get(id);
  }
  update(id, patch) {
    const cur = this.get(id); if (!cur) return null;
    // The avatar is kept in meta (no new column); a choice outside the drawn set is refused, null goes back to letters.
    const av = patch.avatar === undefined ? undefined : patch.avatar === null ? null : avatarValue(patch.avatar);
    if (av === null && patch.avatar !== null && patch.avatar !== undefined) throw Object.assign(new Error('That avatar is not one of the choices.'), { status: 400 });
    const meta = { ...cur.meta, ...(patch.meta || {}), ...(av !== undefined ? { avatar: av } : {}) };
    const { avatar: _a, ...rest } = patch;
    const next = { ...cur, ...rest, model: { ...cur.model, ...(patch.model || {}) }, meta };
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
    const role = roleOf(a), name = ownName(a);
    const who = role ? `You are the ${role} on the owner's team${name ? `; he calls you ${name}` : ''}.` : `You are ${name || 'an agent'}${name ? ', an agent' : ''} on the owner's team.`;
    const instructions = a.id === 'coordinator' && a.instructions === OLD_MANAGER_SEED ? MANAGER_SEED : a.instructions;
    return [who, a.role && `Your job: ${a.role}.`, a.personality && `Your manner: ${a.personality}`, instructions, extra].filter(Boolean).join('\n');
  }
}
