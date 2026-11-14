// Agents and Skills: hire and retire agents, per-agent skills (short instruction packs) and which Coordinator tools each may use.
// Profile fields (name, personality, instructions) are saved through the core route PATCH /api/agents/:id.
import fs from 'node:fs';
import path from 'node:path';

export async function activate(ctx) {
  const DATA = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'skills.json'), 'utf8'));
  const custom = () => ctx.kv.get('customSkills', []) || [];
  const allSkills = () => [...DATA.skills, ...custom()];
  const skillIdsOf = (a) => Array.isArray(a?.meta?.skills) ? a.meta.skills : (DATA.defaults[a?.id] || []);
  const toolsOff = (a) => Array.isArray(a?.meta?.toolsOff) ? a.meta.toolsOff : [];
  const noAgent = (res) => ctx.json(res, { error: 'There is no such agent.' }, 404);
  const ownerOnly = (res) => ctx.json(res, { error: 'Only the owner at this desk can change what agents may do.' }, 403);

  const api = {
    /** Skills switched on for an agent, read fresh each call. */
    skillsFor(agentId) { const a = ctx.agents.get(agentId); if (!a) return []; const on = new Set(skillIdsOf(a)); return allSkills().filter(s => on.has(s.id)).map(s => ({ id: s.id, title: s.title, body: s.body })); },
    /** Coordinator tool names this agent may use: every registered tool except the ones the owner switched off. */
    toolsFor(agentId) { const a = ctx.agents.get(agentId); const off = new Set(toolsOff(a)); return ctx.modules.tools().map(t => t.name).filter(n => !off.has(n)); },
    catalog: () => ({ skills: allSkills(), packs: DATA.packs }),
  };
  ctx.expose(api);

  ctx.route('GET', '/catalog', (req, res) => ctx.json(res, { skills: allSkills().map(s => ({ id: s.id, title: s.title, category: s.category, description: s.description, custom: !!s.custom })), packs: DATA.packs.map(p => ({ id: p.id, name: p.name, role: p.role, personality: p.personality, skills: p.skills })) }));
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
    const name = String(body?.name || '').trim().slice(0, 40);
    if (!name) return ctx.json(res, { error: 'An agent needs a name.' }, 400);
    const pack = DATA.packs.find(p => p.id === body?.pack) || null;
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
    if (ctx.agents.get(id)) { let n = 2; while (ctx.agents.get(`${id}-${n}`)) n++; id = `${id}-${n}`; }
    const a = ctx.agents.create({ id, name, role: String(body?.role || pack?.role || '').slice(0, 200), personality: String(body?.personality || pack?.personality || '').slice(0, 600), instructions: String(body?.instructions || pack?.instructions || '').slice(0, 4000), meta: { skills: pack ? pack.skills : [], hired: true, pack: pack?.id || null } });
    ctx.json(res, a);
  });
  ctx.route('DELETE', '/agents/:id', (req, res, { params, owner }) => {
    if (!owner) return ownerOnly(res);
    if (params.id === 'coordinator') return ctx.json(res, { error: 'The Coordinator stays.' }, 409);
    if (!ctx.agents.get(params.id)) return noAgent(res);
    ctx.agents.remove(params.id); ctx.json(res, { ok: true });
  });
  ctx.route('POST', '/skills', (req, res, { body, owner }) => {
    if (!owner) return ownerOnly(res);
    const title = String(body?.title || '').trim().slice(0, 80); const text = String(body?.body || '').trim().slice(0, 4000);
    if (!title || !text) return ctx.json(res, { error: 'A skill needs a name and its steps.' }, 400);
    const id = 'own-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Date.now().toString(36).slice(-4);
    const s = { id, title, category: 'Yours', description: String(body?.description || text.split('\n')[0]).slice(0, 160), body: text, custom: true };
    ctx.kv.set('customSkills', [...custom(), s]); ctx.json(res, s);
  });
  ctx.route('DELETE', '/skills/:id', (req, res, { params, owner }) => {
    if (!owner) return ownerOnly(res);
    ctx.kv.set('customSkills', custom().filter(s => s.id !== params.id)); ctx.json(res, { ok: true });
  });

  // The owner can ask in chat to rename an agent or change its manner. It asks first, at every level.
  ctx.tool({
    name: 'agent_update',
    description: "Change an agent's name, role, personality (tone) or standing instructions when the owner asks for it. The owner approves the change.",
    parameters: { type: 'object', properties: { agent: { type: 'string', description: 'the agent to change, by its current name' }, name: { type: 'string' }, role: { type: 'string' }, personality: { type: 'string', description: 'how it talks' }, instructions: { type: 'string' } }, required: ['agent'] },
    async run(args, call) {
      const who = String(args.agent || '').trim().toLowerCase();
      const a = ctx.agents.list().find(x => x.id === who || x.name.toLowerCase() === who);
      if (!a) return { ok: false, error: `There is no agent called ${args.agent}.` };
      const patch = {}; for (const k of ['name', 'role', 'personality', 'instructions']) if (typeof args[k] === 'string' && args[k].trim()) patch[k] = args[k].trim().slice(0, k === 'instructions' ? 4000 : 600);
      if (!Object.keys(patch).length) return { ok: false, error: 'Nothing to change.' };
      const d = await ctx.approval.request({ agentId: call.agentId || 'coordinator', chatId: call.chatId, jobId: call.jobId || undefined, action: 'custom', title: `Change ${a.name}'s profile`, detail: Object.keys(patch).join(', '), payload: patch, signal: call.signal });
      if (!d.ok) return { ok: false, error: d.reason === 'denied' ? 'The owner said no.' : 'Not approved.' };
      const n = ctx.agents.update(a.id, patch);
      return { ok: true, text: `${a.name} is now ${n.name}${patch.personality ? ', manner: ' + n.personality : ''}.` };
    },
  });
  return { async deactivate() {} };
}
