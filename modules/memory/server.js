// Memory, Dream and Learn (module 9). Store + recall + forPrompt (no model), learning from chat (one small model call),
// Dream (a job), lessons the owner teaches (always in forPrompt for that agent).
import crypto from 'node:crypto';
import { Store, KINDS, SHARED, scopeOf, clip, terms } from './store.js';
import { learnMessages, KEYS_SYSTEM, parseJson, cleanKeys, looksSecret, looksJunk, worthAsking } from './learn.js';
import { dream, nightlyDue } from './dream.js';

const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length && i < b.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return x && y ? d / Math.sqrt(x * y) : 0; };

export async function activate(ctx) {
  const store = new Store(ctx.db);
  const cfg = () => ({ learnChat: ctx.kv.get('learnChat', true), nightly: ctx.kv.get('nightly', true) });
  let embedOffUntil = 0;            // after `unavailable`, do not ask again for ten minutes
  const embedState = () => ctx.kv.get('embed', { ok: false, note: 'not tried yet' });

  async function embed(texts, signal) {
    if (Date.now() < embedOffUntil) return null;
    try { const r = await ctx.model.embed({ texts, signal }); if (r?.vectors?.length === texts.length) { ctx.kv.set('embed', { ok: true, model: r.model, provider: r.provider }); return r; } }
    catch (e) { embedOffUntil = Date.now() + 10 * 60_000; ctx.kv.set('embed', { ok: false, note: e.code === 'unavailable' ? 'No embedding model; search by words' : 'Embedding failed; search by words' }); }
    return null;
  }
  /** Extra search words (one small model call) and a vector when an embedding model exists. Failures leave plain word search. */
  async function enrich(item, { signal } = {}) {
    if (!item || item.duplicate) return item;
    let out = item;
    if (!item.keys) {
      try {
        for (let k = 0; k < 2; k++) {      // a second try when the first model gave no usable words (the door rotates models)
          const r = await ctx.model.chat({ purpose: 'small', signal, temperature: 0, maxTokens: 400, messages: [{ role: 'system', content: KEYS_SYSTEM }, { role: 'user', content: item.text }] });
          const keys = cleanKeys(String(r.text || '').replace(/<think>[\s\S]*?<\/think>/gi, ''));
          if (keys) { out = store.update(item.id, { keys }); break; }
          ctx.log('no search words from', r.label, clip(r.text, 80));
        }
      } catch (e) { ctx.log('keys failed', e.code || e.message); }
    }
    const v = await embed([out.text + (out.keys ? ' ' + out.keys : '')], signal);
    if (v) store.setVector(out.id, v.vectors[0], v.model);
    return out;
  }

  async function remember({ agentId, text, kind = 'fact', sourceChat = null, source = 'owner', keys = '', wait = true } = {}) {
    if (looksSecret(text)) throw Object.assign(new Error('That looks like a password, key or code. Memory never keeps those; use Keys and logins.'), { status: 400 });
    const item = store.add({ agentId, text, kind, keys: cleanKeys(keys), sourceChat, source });
    ctx.events.emit('memory', { change: 'add', id: item.id, agentId: item.agentId });
    const p = enrich(item).catch(() => item);
    if (!wait) return item;
    let tm; const out = await Promise.race([p, new Promise(r => { tm = setTimeout(() => r(item), 20_000); tm.unref?.(); })]); clearTimeout(tm); return out;
  }

  async function recall({ agentId, query, limit = 5, signal } = {}) {
    const words = store.search({ agentId, query, limit: Math.max(limit, 8) });
    let ranked = words.map(m => ({ ...m, s: m.score }));
    const vecs = store.vectors({ agentId });
    if (vecs.length) {
      const q = await embed([query], signal);
      if (q) {
        const top = Math.max(1, ...ranked.map(m => m.s));
        const byId = new Map(ranked.map(m => [m.id, m]));
        for (const v of vecs) { const c = cos(q.vectors[0], v.vec); if (v.vecModel !== q.model) continue; const prev = byId.get(v.id); const s = c * top * 1.5 + (prev ? prev.s * 0.5 : 0); if (c > 0.55 || prev) byId.set(v.id, { ...v, vec: undefined, s }); }
        ranked = [...byId.values()];
      }
    }
    ranked.sort((a, b) => b.s - a.s);
    const out = ranked.slice(0, limit).map(m => ({ id: m.id, text: m.text, kind: m.kind, at: m.at, agentId: m.agentId }));
    store.touch(out.map(m => m.id));
    return out;
  }

  /** The block chat puts before every reply. Fast, never calls a model, '' when nothing fits. */
  function forPrompt(agentId, text) {
    const lessons = store.list({ agentId, kind: 'lesson', limit: 50 }).sort((a, b) => b.weight - a.weight).slice(0, 8);
    const ts = terms(text);
    const hits = ts.length ? store.search({ agentId, query: text, limit: 5, kinds: ['fact', 'preference', 'summary'] }).filter(m => m.hits >= 1 && m.weight >= 0.3) : [];
    if (!lessons.length && !hits.length) return '';
    store.touch(hits.map(m => m.id));
    const parts = [];
    if (hits.length) parts.push('What you remember about the owner (use it only when it helps):\n' + hits.map(m => '- ' + clip(m.text, 220)).join('\n'));
    if (lessons.length) parts.push('Standing lessons from the owner (always follow):\n' + lessons.map(m => '- ' + clip(m.text, 220)).join('\n'));
    return parts.join('\n\n');
  }

  /** An agent's turn that saves a standing lesson or instruction asks the owner first, every time ('memory.lesson' always asks,
   *  at every level and inside an auto-approve window). A lesson ("when I ask for leads, always include the city") and a
   *  preference (how he wants work done) are both followed in later work, so both ask; an ordinary fact does not ask, and the
   *  owner's own note on the Memory page does not ask. The card shows the exact words. { ok, decision }. */
  const STANDING = new Set(['lesson', 'preference']);
  async function askLesson(text, { agentId, chatId, jobId, signal } = {}) {
    const d = await ctx.approval.request({ action: 'memory.lesson', agentId: agentId || 'coordinator', chatId: chatId || undefined, jobId: jobId || undefined, signal,
      title: 'Keep a standing instruction', detail: `"${clip(text, 400)}" It would be followed in later work until you delete it on the Memory page.` });
    return { ok: !!d?.ok, decision: d?.ok ? 'yes' : d?.reason === 'timeout' ? 'not answered' : d?.reason === 'halted' ? 'stopped' : 'no' };
  }
  const noLesson = (decision) => ({ ok: false, saved: false, refused: true, decision, error: decision === 'no' ? 'The owner said no to keeping this as a standing instruction. Nothing was saved: do not say it was.' : decision === 'stopped' ? 'Everything was stopped (Panic). Nothing was saved.' : 'The owner did not answer in time. Nothing was saved: do not say it was.' });

  // ---------- learning from chat
  const recentTurns = new Map();           // hash -> time, so a turn heard twice is learned once
  let queue = Promise.resolve();
  // "Remember this chat": our own switch per chat, and the Chat module's own chat setting when it shows one
  const chatOn = (chatId) => {
    if (!chatId) return true;
    if (ctx.kv.get('chat:' + chatId, true) === false) return false;
    const chat = ctx.modules.api('chat'); if (!chat) return true;
    try {
      const own = chat.settings?.(chatId);   // Chat's own options, through Chat: Memory reads no table of Chat's
      if (own) return own.remember !== false;
    } catch {}
    return true;
  };
  async function learnFromTurn({ chatId = null, agentId = null, user, assistant = '', signal } = {}) {
    const res = { added: [], updated: [], ignored: [], label: null, skipped: null };
    if (!cfg().learnChat) return { ...res, skipped: 'Learning from chat is off' };
    if (!chatOn(chatId)) return { ...res, skipped: 'Remember this chat is off' };
    if (!worthAsking(user)) return { ...res, skipped: 'Nothing to learn in that line' };
    const key = crypto.createHash('sha1').update(`${chatId}|${user}|${assistant}`).digest('hex');
    if (recentTurns.has(key)) return { ...res, skipped: 'Already learned' };
    recentTurns.set(key, Date.now()); for (const [k, t] of recentTurns) if (Date.now() - t > 30 * 60_000) recentTurns.delete(k);
    const existing = store.search({ agentId, query: user, limit: 8 }).filter(m => m.kind !== 'summary');
    const r = await ctx.model.chat({ purpose: 'small', json: true, temperature: 0, maxTokens: 700, signal: signal || ctx.panic.signal, messages: learnMessages({ user, assistant, existing, today: new Date().toISOString().slice(0, 10) }) });
    res.label = r.label;
    const j = parseJson(r) || {};
    res.ignored.push(...(Array.isArray(j.ignored) ? j.ignored.map(x => clip(x, 160)) : []));
    const known = new Map(existing.map(m => [String(m.id), m]));
    for (const m of Array.isArray(j.memories) ? j.memories : []) {
      const ev = String(m?.event || '').toUpperCase(); const text = clip(m?.text, 400); const kind = KINDS.includes(m?.kind) ? m.kind : 'fact';
      if (ev === 'NONE' || !text) { if (text) res.ignored.push('Already known: ' + text); continue; }
      if (looksSecret(text) || looksJunk(text)) { res.ignored.push('Not kept: ' + clip(text, 60)); continue; }
      const scope = kind === 'lesson' ? agentId : null;           // lessons belong to the agent taught; facts are shared
      if (STANDING.has(kind)) {
        // a lesson is kept only after the owner's yes on its card; the learning queue does not wait for him
        const old = ev === 'UPDATE' && known.has(String(m.id)) ? known.get(String(m.id)) : null;
        res.asked = [...(res.asked || []), text];
        askLesson(text, { agentId, chatId }).then(({ ok }) => {
          if (!ok) return;
          const it = old ? store.update(old.id, { text, kind, keys: cleanKeys(m.keys) }) : store.add({ agentId: scope, text, kind, keys: cleanKeys(m.keys), sourceChat: chatId, source: 'chat' });
          ctx.events.emit('memory', { change: 'learn', chatId, added: old ? 0 : 1, updated: old ? 1 : 0 });
        }).catch(e => ctx.log('lesson not kept', e.message));
        continue;
      }
      if (ev === 'UPDATE' && known.has(String(m.id))) { const u = store.update(known.get(String(m.id)).id, { text, kind, keys: cleanKeys(m.keys) }); res.updated.push(u); continue; }
      const it = store.add({ agentId: scope, text, kind, keys: cleanKeys(m.keys), sourceChat: chatId, source: 'chat' });
      if (it.duplicate) { res.ignored.push('Already known: ' + text); continue; }
      res.added.push(it);
      embed([it.text + ' ' + it.keys]).then(v => v && store.setVector(it.id, v.vectors[0], v.model)).catch(() => {});
    }
    if (res.added.length || res.updated.length) ctx.events.emit('memory', { change: 'learn', chatId, added: res.added.length, updated: res.updated.length });
    return res;
  }
  const enqueue = (turn) => { const p = queue.then(() => ctx.panic.halted ? null : learnFromTurn(turn)).catch(e => { ctx.log('learn failed', e.code || e.message); return null; }); queue = p; return p; };

  // chat events from the Chat module: handle whatever shape arrives
  const lastUser = new Map();
  const textOf = (m) => typeof m === 'string' ? m : (m?.text ?? m?.content ?? '');
  const offEvents = ctx.events.on((type, data) => {
    if (type !== 'chat' || !data || typeof data !== 'object') return;
    if (data.delta != null || data.partial || data.streaming || data.remember === false) return;
    const chatId = data.chatId || data.chat?.id || data.message?.chatId || null;
    if (typeof data.user === 'string' && typeof data.assistant === 'string') return void enqueue({ chatId, agentId: data.agentId || null, user: data.user, assistant: data.assistant });
    const msgs = Array.isArray(data.messages) ? data.messages : [data.message || data];
    for (const m of msgs) {
      if (m?.status && m.status !== 'done') continue;          // streaming, stopped or failed replies are not learned from
      const role = m?.role || (m?.agentId || m?.label ? 'assistant' : null); const text = textOf(m);
      if (!text || !role) continue;
      const cid = m.chatId || chatId;
      if (role === 'user' || role === 'owner') lastUser.set(cid, text);
      else if (role === 'assistant' && lastUser.has(cid)) { const u = lastUser.get(cid); lastUser.delete(cid); enqueue({ chatId: cid, agentId: m.agentId || data.agentId || null, user: u, assistant: text }); }
    }
  });

  // ---------- Dream
  // Only two things start a Dream: the nightly timer below and the owner's "Run Dream now" button (an owner-only route).
  // No tool and no exposed call starts it, so a model turn cannot. Each run records who started it.
  const STARTERS = { nightly: 'the nightly schedule', owner: 'you, with Run Dream now' };
  async function dreamNow(source) {
    if (!STARTERS[source]) throw Object.assign(new Error('Dream runs only at night or from Settings › Memory.'), { status: 403 });
    const started = new Date().toISOString();
    // The nightly run is the desk's own upkeep (quiet: no notice, badge or Home line unless it fails); Run Dream now is the owner's.
    return ctx.jobs.start({ kind: 'memory.dream', title: 'Dream: tidy memories', quiet: source === 'nightly', input: { source, startedBy: STARTERS[source] }, async run(job) {
      const report = await dream({ store, model: ctx.model, signal: job.signal, progress: (p, d) => job.progress(p, d), log: ctx.log, timeZone: ctx.settings.get('timeZone'), locale: ctx.settings.get('locale') });
      const rec = { at: started, source, startedBy: STARTERS[source], merged: report.merged, lowered: report.lowered, reviewed: report.reviewed, summary: report.summary?.text || null, label: report.label };
      ctx.kv.set('lastDream', rec);
      ctx.kv.set('dreams', [rec, ...ctx.kv.get('dreams', [])].slice(0, 10));
      ctx.events.emit('memory', { change: 'dream' });
      try { ctx.activity?.('Dream tidied memory', `Started by ${STARTERS[source]}: ${report.merged} merged, ${report.lowered} faded, ${report.reviewed} reviewed`); } catch {}
      return { startedBy: STARTERS[source], merged: report.merged, lowered: report.lowered, reviewed: report.reviewed, summary: report.summary?.text || null, label: report.label, groups: report.groups, note: report.note || null };
    } });
  }
  // An earlier build asked Flows to run a model turn with a memory_dream tool every night. That turn could be misrouted,
  // so the schedule is removed and the tool is gone: the Dream is started here, by a timer, at 3:17 in the owner's zone.
  let oldDropped = false;
  function dropOldFlowSchedule() {
    if (oldDropped) return;
    try {
      const flows = ctx.modules.api('flows'); if (!flows?.remove) return;
      const ids = new Set([ctx.kv.get('flowSchedule', null)?.id].filter(Boolean));
      for (const s of flows.list?.() || []) if (/memory_dream/.test(String(s?.prompt || '')) || (s?.title === 'Nightly Dream' && /Dream/.test(String(s?.prompt || '')))) ids.add(s.id);
      for (const id of ids) { try { flows.remove(id); ctx.log('removed the old Nightly Dream schedule', id); } catch {} }
      if (ctx.kv.get('flowSchedule', null)) ctx.kv.del('flowSchedule');
      oldDropped = true;
    } catch (e) { ctx.log('old schedule', e.message); }
  }
  const tick = () => {
    try {
      dropOldFlowSchedule();
      if (ctx.panic.halted || !cfg().nightly) return;
      const { due, day } = nightlyDue(new Date(), ctx.settings.get('timeZone'), ctx.kv.get('nightlyDay', null));
      if (!due) return;
      ctx.kv.set('nightlyDay', day);
      dreamNow('nightly').catch(e => ctx.log('nightly Dream', e.message));
    } catch (e) { ctx.log('nightly check', e.message); }
  };
  const timer = setInterval(tick, 60_000); timer.unref?.();
  setTimeout(tick, 5000).unref?.();

  // ---------- routes
  const agentName = (id) => id ? (ctx.agents.get(id)?.name || id) : 'Every agent';
  const view = (m) => ({ ...m, scope: agentName(m.agentId), vec: undefined });
  const need = (owner, res) => { if (!owner) { ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403); return false; } return true; };
  ctx.route('GET', '/items', (req, res, { query }) => {
    const agentId = query.agentId === undefined ? undefined : (query.agentId || null);
    const items = query.q ? store.search({ agentId, query: query.q, limit: 50, shared: query.shared !== '0' }) : store.list({ agentId, shared: query.shared !== '0', kind: query.kind || undefined, limit: Number(query.limit) || 300 });
    ctx.json(res, { items: items.map(view) });
  });
  ctx.route('POST', '/items', async (req, res, { body }) => { try { ctx.json(res, { item: view(await remember({ agentId: body?.agentId || null, text: body?.text, kind: body?.kind, source: 'owner', wait: false })) }); } catch (e) { ctx.json(res, { error: e.message }, e.status || 500); } });
  ctx.route('POST', '/items/:id', (req, res, { params, body }) => {
    if (body?.text && looksSecret(body.text)) return ctx.json(res, { error: 'That looks like a secret. Memory never keeps those.' }, 400);
    const it = store.update(params.id, { text: body?.text, kind: body?.kind, keys: body?.text ? '' : undefined }); if (!it) return ctx.json(res, { error: 'Not found' }, 404);
    if (body?.text) enrich(it).catch(() => {});
    ctx.events.emit('memory', { change: 'edit', id: it.id }); ctx.json(res, { item: view(it) });
  });
  ctx.route('DELETE', '/items/:id', (req, res, { params, owner }) => { if (!need(owner, res)) return; store.forget(params.id); ctx.events.emit('memory', { change: 'forget', id: Number(params.id) }); try { ctx.activity?.('A memory was forgotten', ''); } catch {} ctx.json(res, { ok: true }); });
  ctx.route('POST', '/forget-all', (req, res, { body, owner }) => { if (!need(owner, res)) return; store.forgetAll(body?.agentId === undefined ? undefined : body.agentId); ctx.events.emit('memory', { change: 'forget-all' }); try { ctx.activity?.('Memory forgotten', body?.agentId ? 'Everything one agent remembered' : 'Everything every agent remembered'); } catch {} ctx.json(res, { ok: true }); });
  ctx.route('GET', '/status', async (req, res) => {
    const counts = store.counts(); const byKind = {}; let total = 0;
    for (const c of counts) { byKind[c.kind] = (byKind[c.kind] || 0) + c.n; total += c.n; }
    ctx.json(res, { ...cfg(), total, byKind, shared: counts.filter(c => !c.agent_id).reduce((a, c) => a + c.n, 0), lastDream: ctx.kv.get('lastDream', null), dreams: ctx.kv.get('dreams', []), search: embedState() });
  });
  ctx.route('POST', '/settings', (req, res, { body, owner }) => {
    if (!need(owner, res)) return;
    if (typeof body?.learnChat === 'boolean') ctx.kv.set('learnChat', body.learnChat);
    if (typeof body?.nightly === 'boolean') ctx.kv.set('nightly', body.nightly);
    ctx.json(res, cfg());
  });
  ctx.route('POST', '/dream', async (req, res, { owner }) => { if (!need(owner, res)) return; try { const j = await dreamNow('owner'); ctx.json(res, { jobId: j.id }); } catch (e) { ctx.json(res, { error: e.message }, e.code === 'halted' ? 409 : 500); } });
  ctx.route('GET', '/chat/:chatId', (req, res, { params }) => ctx.json(res, { remember: chatOn(params.chatId) }));
  ctx.route('POST', '/chat/:chatId', (req, res, { params, body }) => { ctx.kv.set('chat:' + params.chatId, body?.remember !== false); ctx.json(res, { remember: chatOn(params.chatId) }); });

  // ---------- tools for the Coordinator
  ctx.tool({ name: 'memory_remember', description: 'Save something durable about the owner, his business or how he wants work done. kind: fact, preference, or lesson (a standing instruction for this agent).',
    parameters: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['fact', 'preference', 'lesson'] } }, required: ['text'] },
    async run(args, call) {
      if (STANDING.has(args.kind)) { const a = await askLesson(args.text, call); if (!a.ok) return noLesson(a.decision); }
      const it = await remember({ agentId: args.kind === 'lesson' ? call.agentId : null, text: args.text, kind: args.kind || 'fact', sourceChat: call.chatId, source: 'agent' }); return { saved: it.text, kind: it.kind, already: !!it.duplicate };
    } });
  ctx.tool({ name: 'memory_recall', description: 'Look up what the desk remembers about the owner and his business.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    async run(args, call) { const items = await recall({ agentId: call.agentId, query: args.query, limit: Math.min(10, args.limit || 5), signal: call.signal }); return { memories: items.map(m => ({ text: m.text, kind: m.kind, when: m.at })) }; } });

  ctx.expose({
    remember, recall, forPrompt, learnFromTurn,
    setChatRemember: (chatId, on) => ctx.kv.set('chat:' + chatId, on !== false), chatRemember: chatOn,
    list: (o) => store.list(o), forget: (id) => store.forget(id),
  });
  return { async deactivate() { clearInterval(timer); offEvents?.(); } };
}
