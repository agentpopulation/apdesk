// Agents and Skills: hire and retire agents, per-agent skills (short instruction packs) and which Coordinator tools each may use.
// Profile fields (name, personality, instructions) are saved through the core route PATCH /api/agents/:id.
import fs from 'node:fs';
import path from 'node:path';
import { SEED } from '../../app/core/agents.js';
import { ADVISORS, WELCOME, PROFILES, roleWelcome } from './advisors.js';
import { HIRE_ROLES, hireRole, roleOf, ownName, agentLine, storedName } from './ui-roles.js';

// The desk's own agents besides the Manager (id coordinator). Retiring one keeps its profile here so one click hires it back
// as it was. The advisor roles (ids co-founder, product-lead, ai-officer, sales-lead) are built in too, but start off the
// team: the first three are hired from the hire box by role; "sales-lead" is folded into the Sales expert and offered no
// more, though one already hired or retired keeps working and coming back.
const BUILT_IN = [...SEED.filter(a => a.id !== 'coordinator'), ...ADVISORS];
const STARTING = SEED.map(a => a.id);

export async function activate(ctx) {
  const DATA = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'skills.json'), 'utf8'));
  const custom = () => ctx.kv.get('customSkills', []) || [];
  const allSkills = () => [...DATA.skills, ...custom()];
  const skillIdsOf = (a) => Array.isArray(a?.meta?.skills) ? a.meta.skills : (DATA.defaults[a?.id] || []);
  const toolsOff = (a) => Array.isArray(a?.meta?.toolsOff) ? a.meta.toolsOff : [];
  const noAgent = (res) => ctx.json(res, { error: 'There is no such agent.' }, 404);
  const ownerOnly = (res) => ctx.json(res, { error: 'Only the owner at this desk can change what agents may do.' }, 403);
  const moduleName = (id) => ctx.modules.list().find(m => m.id === id)?.name || id;
  /** Why a role cannot be hired now (its module is off), in plain words; null when it can. */
  const blocked = (r) => r.module && !ctx.modules.isOn(r.module) ? `Switch on ${moduleName(r.module)} in Settings › Modules first. The ${r.label} needs it.` : null;

  const api = {
    /** Skills switched on for an agent, read fresh each call. */
    skillsFor(agentId) { const a = ctx.agents.get(agentId); if (!a) return []; const on = new Set(skillIdsOf(a)); return allSkills().filter(s => on.has(s.id)).map(s => ({ id: s.id, title: s.title, body: s.body })); },
    /** Coordinator tool names this agent may use: every registered tool except the ones the owner switched off. */
    toolsFor(agentId) { const a = ctx.agents.get(agentId); const off = new Set(toolsOff(a)); return ctx.modules.tools().map(t => t.name).filter(n => !off.has(n)); },
    catalog: () => ({ skills: allSkills(), packs: DATA.packs }),
    /** The one display rule for agents everywhere (ctx.modules.api('agents')): with an own name "Kent · Secretary", with none
     *  the role alone ("Secretary"). Built-ins: Manager, Researcher, Sales expert, Operations expert, Coder. A name that is
     *  only the role or an old code name counts as none. displayName(agentOrId), roleOf(agentOrId), ownName(agentOrId) and
     *  display(agentOrId) -> { role, name, line }. The same rule is served to pages as agent.display on GET /api/agents. */
    displayName: (agentOrId) => agentLine(typeof agentOrId === 'string' ? ctx.agents.get(agentOrId) || { id: agentOrId } : agentOrId),
    agentLine: (agentOrId) => agentLine(typeof agentOrId === 'string' ? ctx.agents.get(agentOrId) || { id: agentOrId } : agentOrId),
    roleOf: (agentOrId) => roleOf(typeof agentOrId === 'string' ? ctx.agents.get(agentOrId) : agentOrId),
    ownName: (agentOrId) => ownName(typeof agentOrId === 'string' ? ctx.agents.get(agentOrId) : agentOrId),
    /** { role, name, line } for an agent or id: the role words, the own name ('' when none), and the display line. */
    display: (agentOrId) => { const a = typeof agentOrId === 'string' ? ctx.agents.get(agentOrId) || { id: agentOrId } : agentOrId; return { role: roleOf(a), name: ownName(a), line: agentLine(a) }; },
  };
  ctx.expose(api);

  /** Roles to hire, each with what it is good at (skill titles), its starters, and a note when its module is off. */
  const rolesOut = () => { const titles = Object.fromEntries(allSkills().map(s => [s.id, s.title])); const onTeam = new Set(ctx.agents.list().map(a => a.id));
    return HIRE_ROLES.map(r => ({ id: r.id, label: r.label, line: r.line, goodAt: r.skills.map(s => titles[s]).filter(Boolean), starters: r.starters, tools: r.tools, avatar: r.avatar, module: r.module, moduleName: r.module ? moduleName(r.module) : null, blocked: blocked(r), onTeam: onTeam.has(r.id) })); };
  ctx.route('GET', '/catalog', (req, res) => ctx.json(res, { roles: rolesOut(), skills: allSkills().map(s => ({ id: s.id, title: s.title, category: s.category, description: s.description, custom: !!s.custom })), packs: DATA.packs.map(p => ({ id: p.id, name: p.name, role: p.role, personality: p.personality, skills: p.skills })) }));
  ctx.route('GET', '/skills/:id', (req, res, { params }) => { const s = allSkills().find(x => x.id === params.id); s ? ctx.json(res, s) : ctx.json(res, { error: 'No such skill.' }, 404); });
  ctx.route('GET', '/agents/:id', (req, res, { params }) => {
    const a = ctx.agents.get(params.id); if (!a) return noAgent(res);
    const on = new Set(skillIdsOf(a)); const off = new Set(toolsOff(a));
    const mods = Object.fromEntries(ctx.modules.list().map(m => [m.id, m.name]));
    ctx.json(res, {
      agent: a,
      skills: allSkills().map(s => ({ id: s.id, title: s.title, category: s.category, description: s.description, on: on.has(s.id), custom: !!s.custom })),
      tools: ctx.modules.tools().map(t => ({ name: t.name, module: t.module, moduleName: mods[t.module] || t.module, description: t.description, on: !off.has(t.name) })),
    });
  });
  ctx.route('PUT', '/agents/:id/skills', (req, res, { params, body, owner }) => {
    if (!owner) return ownerOnly(res);
    const a = ctx.agents.get(params.id); if (!a) return noAgent(res);
    const ids = new Set(allSkills().map(s => s.id));
    const on = (Array.isArray(body?.on) ? body.on : []).map(String).filter(x => ids.has(x));
    ctx.json(res, ctx.agents.update(a.id, { meta: { skills: [...new Set(on)] } }));
  });
  ctx.route('PUT', '/agents/:id/tools', (req, res, { params, body, owner }) => {
    if (!owner) return ownerOnly(res);
    const a = ctx.agents.get(params.id); if (!a) return noAgent(res);
    const off = (Array.isArray(body?.off) ? body.off : []).map(String).filter(x => /^[\w]+$/.test(x));
    ctx.json(res, ctx.agents.update(a.id, { meta: { toolsOff: [...new Set(off)] } }));
  });
  ctx.route('POST', '/hire', (req, res, { body, owner }) => {
    if (!owner) return ownerOnly(res);
    if (body?.roleId) return hireByRole(res, body);
    const name = String(body?.name || '').trim().slice(0, 40);
    if (!name) return ctx.json(res, { error: 'An agent needs a name, or pick a role.' }, 400);
    const pack = DATA.packs.find(p => p.id === body?.pack) || null;
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
    if (ctx.agents.get(id)) { let n = 2; while (ctx.agents.get(`${id}-${n}`)) n++; id = `${id}-${n}`; }
    const a = ctx.agents.create({ id, name, role: String(body?.role || pack?.role || '').slice(0, 200), personality: String(body?.personality || pack?.personality || '').slice(0, 600), instructions: String(body?.instructions || pack?.instructions || '').slice(0, 4000), meta: { skills: pack ? pack.skills : [], hired: true, pack: pack?.id || null } });
    const { uses: _u, ...line } = hiredLine(a, `${a.name} is hired`, `${a.name} is hired.`);
    ctx.json(res, { ...a, ...line });
  });
  ctx.route('DELETE', '/agents/:id', (req, res, { params, owner }) => {
    if (!owner) return ownerOnly(res);
    if (params.id === 'coordinator') return ctx.json(res, { error: 'The Manager stays: it sums up every group.' }, 409);
    const a = ctx.agents.get(params.id); if (!a) return noAgent(res);
    if (BUILT_IN.some(b => b.id === a.id)) ctx.kv.set('retired', { ...retired(), [a.id]: a });
    ctx.agents.remove(params.id); ctx.json(res, { ok: true });
  });
  /** A hire by role: the role is its identity, the name the owner's choice (none: it shows as its role). An advisor role
   *  whose built-in agent is off the team comes back with its own id and what it kept; a role already on the team gets a
   *  second agent. The first hire of an id leaves its welcome note, with a "Give me a name" button when it has no name. */
  function hireByRole(res, body) {
    const r = hireRole(body.roleId);
    if (!r) return ctx.json(res, { error: 'That role is not one the desk offers.' }, 400);
    const why = blocked(r); if (why) return ctx.json(res, { error: why }, 409);
    const own = String(body?.name || '').trim().slice(0, 40);
    const advisor = BUILT_IN.find(b => b.id === r.id);
    let id = r.id, base;
    if (advisor && !ctx.agents.get(r.id)) base = { ...advisor, ...(retired()[r.id] || {}) };
    else { if (ctx.agents.get(id)) { let n = 2; while (ctx.agents.get(`${id}-${n}`)) n++; id = `${id}-${n}`; } base = { ...(PROFILES[r.id] || {}), ...(advisor ? { personality: advisor.personality, instructions: advisor.instructions } : {}) }; }
    const back = !!(advisor && id === r.id && retired()[r.id]);
    const keepName = back && ownName({ ...base, id }) ? base.name : null;   // a name he gave before stays unless he gives a new one
    const meta = { ...(base.meta || {}), hired: true, roleId: r.id, skills: Array.isArray(base.meta?.skills) ? base.meta.skills : r.skills, ...(base.meta?.avatar ? {} : { avatar: r.avatar }) };
    const a = ctx.agents.create({ ...base, id, name: storedName(own || keepName, r.label), role: base.role || r.line, personality: base.personality || '', instructions: base.instructions || '', meta });
    if (back) { const { [r.id]: _, ...rest } = retired(); ctx.kv.set('retired', rest); }
    const who = agentLine(a), short = ownName(a) || who;   // the one-line toast cuts near 52 characters: the own name alone there
    const line = hiredLine(a, back ? `${short} is back` : `${short} joined`, back ? `${who} is back on your team.` : `${who} joined your team.`);
    const noted = !back && postWelcome(a.id, line.uses, r.id);
    ctx.json(res, { ...a, line: who, back, noted, model: line.model, message: line.message, detail: [line.detail, noted && 'It left you a note in its chat.'].filter(Boolean).join(' ') });
  }
  /** The hire's answer: who joined, and the first model it will try in plain words (its own main model, else the first step
   *  of the desk default route), so the owner knows it can answer at once. The page shows `message` in the one-line toast,
   *  which cuts after about 56 characters at 390 px: the cause of the model name never showing was a long sentence there.
   *  So `message` is short with the model name early; the full sentence is `detail`, and a first hire's note carries it too. */
  function hiredLine(a, short, first) {
    const c = ctx.model.resolve(a.id)?.chain?.[0];
    if (!c) return { model: null, message: `${short}. Choose a model in Models.`, detail: `${first} No model answers yet: choose one in Models.` };
    const m = c.model || (c.provider === 'router' ? (ctx.settings.get('router.model') || 'auto') : null);
    const model = m ? `${ctx.model.label(c.provider)} (${m})` : ctx.model.label(c.provider);
    const the = c.provider === 'router' ? 'the ' : '';
    return { model, message: `${short}. Model: ${model}.`, detail: `${first} It will answer with ${the}${model} until you choose another model.`, uses: `${the}${model}` };
  }
  /** A first hire's welcome note in its own chat: the role's fixed text (advisors.js), no model call, with the model it will
   *  answer with after the opening line. Chat off: no note. */
  function postWelcome(agentId, uses, roleId = null) {
    const note = WELCOME[agentId] || roleWelcome(roleId, Object.fromEntries(allSkills().map(s => [s.id, s.title])));
    if (!note) return false;
    const [open, ...rest] = note.split('\n\n');
    const text = [open, uses ? `I will answer with ${uses} until you choose another model on my page.` : 'No model answers for me yet: choose one on my page or in Models.', ...rest].join('\n\n');
    // welcome: true makes Chat add the small "Give me a name" button when the agent has no own name
    try { return !!ctx.modules.api('chat')?.postMessage?.('dm-' + agentId, { agentId, text, welcome: true }); } catch (e) { ctx.log('welcome note failed', e.message); return false; }
  }
  // built-in agents not on the team: as they were when retired, or as the desk first made them
  const retired = () => ctx.kv.get('retired', {}) || {};
  // the advisor roles are offered in the hire box by role; under "Not on your team" only once they were on it
  const offTeam = () => BUILT_IN.filter(b => !ctx.agents.get(b.id) && (STARTING.includes(b.id) || retired()[b.id])).map(b => ({ ...b, ...(retired()[b.id] || {}) }));
  ctx.route('GET', '/retired', (req, res) => ctx.json(res, { agents: offTeam().map(a => ({ id: a.id, name: a.name, line: agentLine(a), roleName: roleOf(a), role: a.role, avatar: a.avatar || null })) }));
  ctx.route('POST', '/retired/:id/hire', (req, res, { params, owner }) => {
    if (!owner) return ownerOnly(res);
    if (!BUILT_IN.some(b => b.id === params.id)) return noAgent(res);
    if (ctx.agents.get(params.id)) return ctx.json(res, { error: 'That agent is already on your team.' }, 409);
    const back = !!retired()[params.id];   // retired before: it comes back; never on the team before: it joins
    const a = ctx.agents.create({ ...BUILT_IN.find(b => b.id === params.id), ...(retired()[params.id] || {}) });
    const { [a.id]: _, ...rest } = retired(); ctx.kv.set('retired', rest);
    // The cause of a hired agent seeming to have no model: the hire said nothing about one. An agent with no model of its own
    // already answers with the desk default route; the hire now names that route (or the model it kept from before).
    const who = agentLine(a);
    const r = hiredLine(a, back ? `${who} is back` : `${who} joined`, back ? `${who} is back on your team.` : `${who} joined your team.`);
    const noted = !back && postWelcome(a.id, r.uses);
    ctx.json(res, { ...a, line: who, back, noted, model: r.model, message: r.message, detail: [r.detail, noted && 'It left you a note in its chat.'].filter(Boolean).join(' ') });
  });
  /** One of the owner's own skills (text). It is on for no agent until he ticks it on an agent's page. */
  // hidden characters (zero-width, direction marks, control codes) can hide an instruction from the owner who reads the skill
  const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDFFF]/g;
  const clean = (v) => String(v ?? '').replace(HIDDEN, '');
  function addSkill(body) {
    if (ctx.incognito) throw Object.assign(new Error('Skills are not added in Incognito. Leave Incognito first.'), { status: 403 });
    const title = clean(body?.title).trim().slice(0, 80); const text = clean(body?.body).trim().slice(0, 4000);
    if (!title || !text) throw Object.assign(new Error('A skill needs a name and its steps.'), { status: 400 });
    const id = 'own-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Date.now().toString(36).slice(-4);
    const s = { id, title, category: 'Yours', description: clean(body?.description || text.split('\n')[0]).slice(0, 160), body: text, custom: true, ...(body?.source === 'file' ? { source: 'file' } : {}) };
    ctx.kv.set('customSkills', [...custom(), s]); return s;
  }
  api.addSkill = addSkill;
  ctx.route('POST', '/skills', (req, res, { body, owner }) => {
    if (!owner) return ownerOnly(res);
    try { ctx.json(res, addSkill(body)); } catch (e) { ctx.json(res, { error: e.message }, e.status || 400); }
  });
  ctx.route('DELETE', '/skills/:id', (req, res, { params, owner }) => {
    if (!owner) return ownerOnly(res);
    ctx.kv.set('customSkills', custom().filter(s => s.id !== params.id)); ctx.json(res, { ok: true });
  });

  // The owner can ask in chat to rename an agent or change its manner. It asks first, at every level.
  ctx.tool({
    name: 'agent_update',
    description: "Change an agent's name, role, personality (tone) or standing instructions when the owner asks for it. The owner approves the change.",
    parameters: { type: 'object', properties: { agent: { type: 'string', description: 'the agent to change, by its name or its role' }, name: { type: 'string' }, role: { type: 'string' }, personality: { type: 'string', description: 'how it talks' }, instructions: { type: 'string' } }, required: ['agent'] },
    async run(args, call) {
      const who = String(args.agent || '').trim().toLowerCase();
      const a = ctx.agents.list().find(x => x.id === who || x.name.toLowerCase() === who || roleOf(x).toLowerCase() === who || agentLine(x).toLowerCase() === who);
      if (!a) return { ok: false, error: `There is no agent called ${args.agent}.` };
      const patch = {}; for (const k of ['name', 'role', 'personality', 'instructions']) if (typeof args[k] === 'string' && args[k].trim()) patch[k] = args[k].trim().slice(0, k === 'instructions' ? 4000 : 600);
      if (!Object.keys(patch).length) return { ok: false, error: 'Nothing to change.' };
      const d = await ctx.approval.request({ agentId: call.agentId || 'coordinator', chatId: call.chatId, jobId: call.jobId || undefined, action: 'custom', title: `Change the profile of ${agentLine(a)}`, detail: Object.keys(patch).join(', '), payload: patch, signal: call.signal });
      if (!d.ok) return { ok: false, error: d.reason === 'denied' ? 'The owner said no.' : 'Not approved.' };
      const n = ctx.agents.update(a.id, patch);
      return { ok: true, text: `${agentLine(a)} is now ${agentLine(n)}${patch.personality ? ', manner: ' + n.personality : ''}.` };
    },
  });
  return { async deactivate() {} };
}
