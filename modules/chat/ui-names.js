// How Chat shows and names an agent (shared with the page, so its name starts with ui-): by its role, with the owner's own name for it when he gave one ("Kent · Secretary";
// with no own name, the role alone: "Secretary"). The agents module's display helper decides when it is there (see who());
// this file is the same rule for when it is not, and for the page. The old code names never reach the screen.

/** The role of each built-in agent and advisor, by id (the ids stay as they are). */
export const ROLES = { coordinator: 'Manager', scout: 'Researcher', closer: 'Sales expert', operator: 'Operations expert', coder: 'Coder', 'ai-officer': 'AI expert', 'product-lead': 'Product expert', 'sales-lead': 'Sales lead', 'co-founder': 'AI Co-founder' };
/** What each built-in role does, for an agent's prompt when the agent itself does not say. */
const WORK = { coordinator: 'answers simple questions itself, hands work to the agent who owns it, and sums up a group', scout: 'research and reports', closer: 'leads, outreach drafts, the pipeline and the owner\'s customer records (the CRM in this desk)', operator: 'the browser and long jobs', coder: 'files, tables and code' };
/** The names the desk itself once gave its agents: shown as no own name at all. */
const OLD = new Set(['coordinator', 'scout', 'closer', 'operator', 'coder', 'ai officer', 'product lead', 'sales lead', 'co-founder', 'co founder', 'agent']);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** A role written as a label (a few words, no sentence), not as a description of the work. */
const labelLike = (s) => !!s && s.length <= 32 && s.split(' ').length <= 4 && !/[,.;:()]/.test(s) && !/\band\b/i.test(s);

/** { role, name, line } for an agent record (or just { id }). role: its role label, or '' when it has none; name: the owner's
 *  own name for it, or ''; line: "name · role", the role alone, or the name alone. */
export function parts(a) {
  if (!a || typeof a !== 'object') return { role: '', name: '', line: 'Agent' };
  const given = clean(a.roleName || a.meta?.roleName || a.meta?.role || '');
  const ownRole = clean(a.role);
  const role = clean(given || ROLES[a.id] || (labelLike(ownRole) ? ownRole : ''));
  let name = clean(a.ownName ?? a.meta?.ownName ?? a.name);
  if (OLD.has(name.toLowerCase()) || (role && name.toLowerCase() === role.toLowerCase())) name = '';
  const line = name && role ? `${name} · ${role}` : role || name || 'Agent';
  return { role, name, line };
}
/** The one line that shows an agent anywhere in Chat. */
export const displayLine = (a) => parts(a).line;
/** How a prompt names an agent: "Kent (Researcher)", or the role alone. */
export const promptName = (a) => { const p = parts(a); return p.name && p.role ? `${p.name} (${p.role})` : p.line; };
/** What an agent's role covers, for a prompt: its own description, else the built-in role's work. */
export function workOf(a) {
  const own = clean(a?.meta?.about || a?.description || a?.role || '');
  return (own && !labelLike(own) ? own : WORK[a?.id] || own || 'its own work').slice(0, 140);
}
/** The line that tells an agent who it is on this desk. */
export function selfLine(a) {
  const p = parts(a);
  if (!p.role && !p.name) return '';
  return p.role && p.name ? `On this desk your role is ${p.role}, and the owner named you ${p.name}. Call yourself ${p.name}, never by another name.`
    : p.role ? `On this desk your role is ${p.role}. You have no own name: call yourself the ${p.role}, never by another name.` : `On this desk the owner named you ${p.name}.`;
}

/** The display rule to use: the agents module's helper when it is on (display(agent) giving a line, or { role, name, line }),
 *  else this file's. get: id -> agent record. */
export function who(get, agentsApi = null) {
  const helper = typeof agentsApi?.display === 'function' ? agentsApi.display : null;
  const of = (x) => typeof x === 'string' ? (get(x) || { id: x }) : x;
  const p = (x) => {
    const a = of(x); const own = parts(a);
    if (!helper) return own;
    try {
      const v = helper(a);
      if (typeof v === 'string' && v.trim()) return { ...own, line: v.trim() };
      if (v && typeof v === 'object' && typeof v.line === 'string' && v.line.trim()) return { role: clean(v.role) || own.role, name: clean(v.name), line: v.line.trim() };
    } catch {}
    return own;
  };
  return {
    parts: p,
    line: (x) => p(x).line,
    prompt: (x) => { const q = p(x); return q.name && q.role ? `${q.name} (${q.role})` : q.line; },
    self: (x) => { const q = p(x); return selfLine({ id: '-', roleName: q.role, ownName: q.name, name: q.name }); },
  };
}
