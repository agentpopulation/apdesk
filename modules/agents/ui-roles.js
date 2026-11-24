// The file name starts with "ui" because the desk serves only ui*.js files of a module to the window; the server imports it too.
// Roles are an agent's identity; its name is the owner's choice. One place for both, read by the server and by pages:
// the role of every built-in agent (by id, which stays in code and data), the roles the owner can hire, and agentLine(),
// the one line that names an agent on screen: "Kent · Secretary" with an own name, "Secretary" without one.
// Plain data and plain functions: no page and no server needed.

/** The five built-in agents, by id. Their old default names are no own name: an agent still carrying one shows its role. */
export const BUILT_IN_ROLES = { coordinator: 'Manager', scout: 'Researcher', closer: 'Sales expert', operator: 'Operations expert', coder: 'Coder' };
/** The advisor roles a desk had before (ids stay): their new role words. "sales-lead" is folded into Sales expert. */
export const ADVISOR_ROLES = { 'co-founder': 'AI Co-founder', 'product-lead': 'Product expert', 'ai-officer': 'AI expert', 'sales-lead': 'Sales expert' };
/** The names the desk itself gave before roles: none of them is an own name. */
export const OLD_NAMES = { coordinator: 'Coordinator', scout: 'Scout', closer: 'Closer', operator: 'Operator', coder: 'Coder', 'co-founder': 'Co-founder', 'product-lead': 'Product lead', 'ai-officer': 'AI officer', 'sales-lead': 'Sales lead' };
/** Agents hired from a starting pack before roles: the role each pack was. */
const PACK_ROLES = { researcher: 'Researcher', sales: 'Sales expert', operator: 'Operations expert', maker: 'Coder', writer: 'Writer', office: 'Secretary' };

/** Roles the owner can hire. Each: role words, what it does (one line), what it is good at (skills.json ids), three
 *  starters, the tools it owns, a default look, and `module`: the module it cannot work without (null: the core does). */
const R = (id, label, line, skills, starters, tools, look, module = null) => ({ id, label, line, skills, starters, tools, avatar: look, module });
export const HIRE_ROLES = [
  R('co-founder', 'AI Co-founder', 'The whole business with you: focus, money, the next 30 days', ['cofounder-30-day', 'cofounder-stop-keep-try', 'cofounder-money-view'],
    [{ text: 'Make a 30-day plan for my business', needsBusiness: true }, 'What should I stop, keep and try?', 'Look at my income and costs: what stands out?'], ['task_create', 'memory_recall', 'knowledge_search'], { look: 'lion', colour: 'violet' }),
  R('finance', 'Finance expert', 'Invoices, money in and out, prices', ['invoice-follow-up', 'finance-cash-view', 'quotation-draft'],
    ['Which invoices are still unpaid? Draft polite reminders', 'Show money in and out this month from my records', 'Draft a quotation for a customer'], ['table_file', 'doc_file', 'file_read'], { look: 'owl', colour: 'green' }),
  R('marketing', 'Marketing expert', 'Posts, offers and a simple marketing plan', ['marketing-month-plan', 'marketing-post-drafts', 'product-customer-voice'],
    [{ text: 'Plan one month of marketing for my business', needsBusiness: true }, 'Draft three short posts about my best offer', 'What do my customers say they like? Turn it into a message'], ['social_draft', 'web_search', 'doc_file'], { look: 'fox', colour: 'pink' }),
  R('product-lead', 'Product expert', 'What you sell and what to change in it', ['product-offer-review', 'product-customer-voice', 'product-next-three'],
    [{ text: 'Review what I sell and what to change first', needsBusiness: true }, 'Turn my customer replies into what they really say', 'Pick the next three changes to my product, smallest first'], ['web_search', 'knowledge_search', 'task_create'], { look: 'bee', colour: 'blue' }),
  R('ai-officer', 'AI expert', 'Where AI helps the business, and where it does not', ['ai-where-it-helps', 'ai-risk-check', 'ai-tool-gaps'],
    [{ text: 'Where could AI save me time in my business?', needsBusiness: true }, 'What should I approve by hand before an agent does it?', 'What is this desk missing for my business?'], ['web_search', 'task_create'], { look: 'robot', colour: 'slate' }),
  R('secretary', 'Secretary', 'Calendar, reminders, follow-ups and the inbox', ['secretary-follow-ups', 'mail-triage', 'meeting-notes'],
    ['What is on my calendar this week?', 'Remind me of every follow-up I promised', 'Turn my meeting notes into tasks'], ['calendar_add', 'calendar_list', 'task_create', 'mail_draft'], { look: 'penguin', colour: 'amber' }, 'calendar'),
  R('writer', 'Writer', 'Letters, replies and posts in your voice', ['email-reply-draft', 'customer-reply', 'summarise-document'],
    ['Draft a polite reply to this email', 'Write a short letter to my customers about a price change', 'Summarise this document in five lines'], ['doc_file', 'file_read'], { look: 'cat', colour: 'purple' }),
  R('customer-care', 'Customer care expert', 'Customer questions, complaints and calm replies', ['customer-reply', 'care-common-answers', 'email-reply-draft'],
    ['Draft a calm reply to an unhappy customer', 'Write answers to the five questions customers ask most', 'Plan what to say when an order is late'], ['mail_draft', 'channel_draft', 'knowledge_search'], { look: 'bear', colour: 'teal' }),
  R('recruiter', 'Recruiter', 'Job posts, shortlists and interview questions', ['recruit-job-post', 'recruit-shortlist', 'email-reply-draft'],
    ['Write a job post for a shop assistant', 'Make a shortlist from these applications', 'Draft interview questions for this job'], ['doc_file', 'file_read', 'web_search'], { look: 'rabbit', colour: 'orange' }),
  R('data-analyst', 'Data analyst', 'Tables and numbers: what changed and why', ['data-read-table', 'data-what-changed', 'weekly-review'],
    ['Read my sales table and tell me what stands out', 'What changed this month compared with last month?', 'Make a simple table of my best customers'], ['read_saved_table', 'table_file', 'file_read'], { look: 'octopus', colour: 'blue' }, 'tables'),
];
const BY_ID = Object.fromEntries(HIRE_ROLES.map(r => [r.id, r]));
export const hireRole = (id) => BY_ID[String(id || '')] || null;

/** Names offered in the hire box, short and easy to say anywhere; the owner changes or clears it. */
const SUGGEST = ['Asha', 'Leo', 'Mina', 'Omar', 'Sofia', 'Ken', 'Lina', 'Ravi', 'Nora', 'Teo', 'Maya', 'Sam'];
/** A suggested name not already used on the team. */
export function suggestName(taken = [], seed = 0) {
  const used = new Set((taken || []).map(x => String(x || '').toLowerCase()));
  for (let i = 0; i < SUGGEST.length; i++) { const n = SUGGEST[(seed + i) % SUGGEST.length]; if (!used.has(n.toLowerCase())) return n; }
  return '';
}

/** The role words of an agent: built-in by id, an advisor by id, a hired role, or the pack it was hired from; else ''. */
export function roleOf(a) {
  if (!a) return '';
  const id = String(a.id || '');
  return BUILT_IN_ROLES[id] || ADVISOR_ROLES[id] || hireRole(a.meta?.roleId)?.label || PACK_ROLES[a.meta?.pack] || '';
}
/** The owner's own name for an agent, or '' when it has none: a stored name that is its role or an old default is none. */
export function ownName(a) {
  const n = String(a?.name || '').trim(); if (!n) return '';
  const low = n.toLowerCase(), role = roleOf(a).toLowerCase(), old = String(OLD_NAMES[a?.id] || '').toLowerCase();
  return low === role || low === old ? '' : n;
}
/** The one line that names an agent on screen: "Kent · Secretary", the role alone with no own name, the name alone for
 *  an agent the owner made with his own role. Never empty. */
export function agentLine(a, { fallback = 'An agent' } = {}) {
  const role = roleOf(a), name = ownName(a);
  if (name && role) return `${name} · ${role}`;
  return role || name || String(a?.name || '').trim() || fallback;
}
/** By id, from a list of agents (for pages that hold ids): the line, or the fallback when the agent is gone. */
export function agentLineById(agents, id, opts) {
  const a = (agents || []).find(x => x.id === id);
  return a ? agentLine(a, opts) : (opts?.fallback ?? 'An agent');
}
/** The name to store for an agent: the own name, else its role (the column is never empty). */
export const storedName = (own, role) => String(own || '').trim().slice(0, 40) || role;
