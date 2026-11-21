// Bench mode (module 31): while the owner is away from the desk's window, the desk looks back at its own work and looks up
// his market, in tiers by how long he has been away (1, 12, 36, 108 hours), and leaves him a note. Everything it finds is a
// Bench item with its evidence; the owner's Keep applies one through the module that owns it. Bench never sends, applies,
// signs up, approves or changes a setting: it uses the read-only settings view and other modules' exposed functions only.
import si from 'systeminformation';
import { TIERS, ACTIVITIES, BUDGET, KINDS, tierFor, freshPlan, nextActivity, modelOrder, buildNote, noteText, activity as activityDef } from './engine.js';
import { RUN } from './activities.js';

/** Tests set these: a fake clock (ms), a fake battery reading, no pause between calls, smaller budgets. */
export const testHooks = { clock: null, battery: null, paceMs: null, budget: null };
const nowMs = () => (typeof testHooks.clock === 'function' ? testHooks.clock() : Date.now());
const iso = (ms) => new Date(ms).toISOString();
const J = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = (ms, signal) => new Promise((res, rej) => { if (!ms) return res(); const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('Stopped'), { code: 'aborted' })); }, { once: true }); });
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export const START_AFTER = [15, 30, 60];
export const MODEL_MODES = ['local', 'free', 'paid'];
const GRACE_MS = 60000;   // after "Start a bench session now", the owner has a minute to walk away before his own clicks end it

export async function activate(ctx) {
  ctx.db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_bench_sessions (id TEXT PRIMARY KEY, started TEXT, ended TEXT, state TEXT, away_since INTEGER, tier INTEGER DEFAULT 0,
      plan TEXT, used TEXT, models TEXT, end_why TEXT, manual INTEGER DEFAULT 0, grace_until INTEGER DEFAULT 0, wait_until INTEGER DEFAULT 0, why TEXT, seen TEXT);
    CREATE TABLE IF NOT EXISTS m_bench_items (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT, tier INTEGER, activity TEXT, title TEXT, body TEXT, evidence TEXT,
      complete INTEGER, state TEXT, data TEXT, created TEXT, decided TEXT, result TEXT);
    CREATE INDEX IF NOT EXISTS m_bench_items_session ON m_bench_items (session_id);`);
  const kv = ctx.kv;
  const cfg = () => ({ enabled: kv.get('enabled', false) === true, startAfter: START_AFTER.includes(kv.get('startAfter', 30)) ? kv.get('startAfter', 30) : 30,
    models: MODEL_MODES.includes(kv.get('models', 'free')) ? kv.get('models', 'free') : 'free', battery: Math.max(0, Math.min(100, Number(kv.get('battery', 30)) || 0)), site: String(kv.get('site', '') || '') });
  const budget = () => testHooks.budget || BUDGET;
  const online = () => ctx.settings.get('online') !== false;
  if (!kv.get('lastSeen', 0)) kv.set('lastSeen', nowMs());   // switched on just now: the owner is here

  // ---------------- storage
  const sessionOut = (r) => !r ? null : ({ id: r.id, started: r.started, ended: r.ended, state: r.state, awaySince: r.away_since, tier: r.tier || 0, plan: J(r.plan, freshPlan()), used: J(r.used, { calls: 0, pages: 0, searches: 0, ms: 0 }), models: J(r.models, []), endWhy: r.end_why || '', manual: !!r.manual, graceUntil: r.grace_until || 0, waitUntil: r.wait_until || 0, why: r.why || '', seen: r.seen || null });
  const getSession = (id) => sessionOut(ctx.db.get('SELECT * FROM m_bench_sessions WHERE id = ?', id));
  const current = () => sessionOut(ctx.db.get("SELECT * FROM m_bench_sessions WHERE state = 'running' ORDER BY started DESC LIMIT 1"));
  const saveSession = (s) => ctx.db.run('UPDATE m_bench_sessions SET ended = ?, state = ?, tier = ?, plan = ?, used = ?, models = ?, end_why = ?, wait_until = ?, why = ?, seen = ? WHERE id = ?', s.ended || null, s.state, s.tier || 0, JSON.stringify(s.plan), JSON.stringify(s.used), JSON.stringify(s.models), s.endWhy || null, s.waitUntil || 0, s.why || null, s.seen || null, s.id);
  const itemOut = (r) => !r ? null : ({ id: r.id, sessionId: r.session_id, kind: r.kind, tier: r.tier, activity: r.activity, title: r.title, body: r.body || '', evidence: J(r.evidence, []), complete: !!r.complete, state: r.state, data: J(r.data, {}), created: r.created, decided: r.decided, result: r.result || null });
  const items = (sessionId, { kind, state } = {}) => ctx.db.all('SELECT * FROM m_bench_items WHERE session_id = ? ORDER BY created, rowid', sessionId).map(itemOut).filter((i) => (!kind || i.kind === kind) && (!state || i.state === state));
  const getItem = (id) => itemOut(ctx.db.get('SELECT * FROM m_bench_items WHERE id = ?', id));
  const emit = (d) => { try { ctx.events.emit('bench', d); } catch {} };

  function createSession({ awaySince, manual = false }) {
    const id = rid('bs_'); const t = nowMs();
    ctx.db.run('INSERT INTO m_bench_sessions (id, started, state, away_since, tier, plan, used, models, manual, grace_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, iso(t), 'running', awaySince, tierFor(t - awaySince), JSON.stringify(freshPlan()), JSON.stringify({ calls: 0, pages: 0, searches: 0, ms: 0 }), '[]', manual ? 1 : 0, manual ? t + GRACE_MS : 0);
    kv.set('lastAway', awaySince);
    ctx.activity('Bench started a session', manual ? 'Started by you' : 'You were away');
    emit({ change: 'session', id });
    return getSession(id);
  }

  // ---------------- running activities
  const live = new Map();          // sessionId -> { jobId, activity, done: Promise }
  const watched = new Set();       // jobs other modules started for Bench (a research report): stopped with it
  function stopLive(sessionId, why) {
    const r = live.get(sessionId); if (!r) return;
    try { ctx.jobs.stop(r.jobId); } catch {}
    for (const id of watched) { try { ctx.jobs.stop(id); } catch {} }
    watched.clear();
    r.stopWhy = why;
  }
  function endSession(s, state, why) {
    stopLive(s.id, why);
    s = getSession(s.id) || s;
    for (const p of Object.values(s.plan)) if (p.status === 'running') { p.status = 'pending'; p.why = why; }
    Object.assign(s, { state, ended: iso(nowMs()), endWhy: why });
    saveSession(s);
    ctx.activity(`Bench ${state === 'stopped' ? 'stopped' : 'finished'}: ${why}`);
    emit({ change: 'ended', id: s.id, note: true });
    return s;
  }

  const providerTiers = () => Object.fromEntries(Object.entries(ctx.model.providers()).map(([k, v]) => [k, v.tier]));
  /** Paid use already allowed for a provider: OpenRouter's own paid switch; any other paid provider only when the owner's chain uses its key. */
  const paidAllowed = (p) => p === 'openrouter' ? ctx.settings.get('openrouter.allowPaid') === true : (ctx.settings.get('model.defaultChain') || []).some((x) => x === 'keyed' || x === p);

  /** The helper one activity gets: the doors through Bench's limits. */
  function helper(sid, a, job) {
    const t0 = Date.now(); const mine = { calls: 0, pages: 0, searches: 0 }; const cache = new Map();
    const B = budget();
    const sess = () => getSession(sid);
    const use = (k, n = 1) => { mine[k] += n; const s = sess(); s.used[k] = (s.used[k] || 0) + n; saveSession(s); };
    const check = (k) => {
      if (job.signal.aborted) throw fail('aborted', 'Stopped');
      const s = sess();
      if (mine[k] >= B.activity[k] || (s.used[k] || 0) >= B.session[k]) throw fail('budget', `the ${k === 'calls' ? 'model call' : k === 'pages' ? 'page' : 'search'} budget was reached`);
      if (Date.now() - t0 > B.activity.minutes * 60000 || (s.used.ms || 0) + (Date.now() - t0) > B.session.minutes * 60000) throw fail('budget', 'the time budget was reached');
    };
    const pace = testHooks.paceMs ?? 4000;
    let lastCall = 0;
    const b = {
      signal: job.signal, now: nowMs, get awaySince() { return sess().awaySince; }, get online() { return online(); },
      settings: ctx.settings, site: cfg().site, workspace: ctx.workspace, jobs: ctx.jobs,
      api: (id) => ctx.modules.api(id),
      async ask(o) {
        const order = modelOrder(await ctx.model.active(), { mode: cfg().models, tiers: providerTiers(), paidAllowed });
        if (!order.length) throw fail('nomodel', online() ? 'no model was set up for Bench' : 'the desk is offline and no local model is running');
        let retryAt = 0; const errs = [];
        for (const m of order) {
          check('calls');
          const wait = lastCall + pace - Date.now(); if (wait > 0) await sleep(wait, job.signal);
          lastCall = Date.now(); use('calls');
          try {
            const { agentId: _a, model: _m, signal: _s, ...rest } = o;
            const r = await ctx.model.chat({ ...rest, model: { provider: m.provider, model: m.model }, signal: job.signal });
            const s = sess(); if (!s.models.includes(r.label)) { s.models.push(r.label); saveSession(s); }
            return r;
          } catch (e) {
            if (job.signal.aborted || e.code === 'aborted' || e.code === 'halted') throw fail('aborted', 'Stopped');
            if (e.retryAt) retryAt = retryAt ? Math.min(retryAt, Date.parse(e.retryAt)) : Date.parse(e.retryAt);
            errs.push(e.message);
          }
        }
        if (retryAt) throw fail('busy', 'the free models were busy', { retryAt });
        throw fail('nomodel', 'no model answered');
      },
      modelFor: () => ({ chat: (o) => b.ask(o) }),
      async search(q) { const s = ctx.modules.api('search'); if (!s?.search) throw fail('no_search', 'Search is off'); check('searches'); use('searches'); return await s.search(q, { count: 6, signal: job.signal }) || []; },
      async read(url) { const s = ctx.modules.api('search'); if (!s?.read) throw fail('no_search', 'Search is off'); check('pages'); use('pages'); await sleep(Math.min(pace, 1000), job.signal); return s.read(url, { signal: job.signal, cache }); },
      left() { const s = sess(); return { calls: Math.min(B.activity.calls - mine.calls, B.session.calls - s.used.calls), pages: Math.min(B.activity.pages - mine.pages, B.session.pages - s.used.pages), searches: Math.min(B.activity.searches - mine.searches, B.session.searches - s.used.searches), minutes: Math.max(0, Math.floor(Math.min(B.activity.minutes * 60000 - (Date.now() - t0), B.session.minutes * 60000 - s.used.ms) / 60000)) }; },
      spent({ pages = 0, searches = 0 } = {}) { if (pages) use('pages', pages); if (searches) use('searches', searches); },
      note(e) { if (e?.code === 'busy' && e.retryAt) { const s = sess(); s.waitUntil = e.retryAt; saveSession(s); } b.lastStop = e; },
      item(x) {
        const id = rid('bi_');
        ctx.db.run('INSERT INTO m_bench_items (id, session_id, kind, tier, activity, title, body, evidence, complete, state, data, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, sid, KINDS.includes(x.kind) ? x.kind : 'needs', a.tier, a.id, String(x.title || '').slice(0, 300), String(x.body || '').slice(0, 4000), JSON.stringify((x.evidence || []).slice(0, 6)), x.complete ? 1 : 0, 'new', JSON.stringify(x.data || {}), iso(nowMs()));
        return id;
      },
      sessionItems: () => items(sid),
      /** File writes are allowed by the level itself only at Open; at Careful or Strict they would ask, so Bench does not try. */
      mayWriteFiles: () => ctx.settings.get('security.level') === 'open',
      who: () => ({ agentId: 'scout', jobId: job.id, signal: job.signal }),
      retried: (jobId) => (kv.get('retried', []) || []).includes(jobId),
      markRetried: (jobId) => kv.set('retried', [...(kv.get('retried', []) || []), jobId].slice(-500)),
      /** Another module's job started for Bench (quiet): stopped with Bench, waited for. */
      async runJob(start) {
        const j = await start(); const id = j?.id || j?.jobId; if (!id) return null;
        watched.add(id); const stop = () => { try { ctx.jobs.stop(id); } catch {} };
        job.signal.addEventListener('abort', stop, { once: true });
        try { return await ctx.jobs.wait(id, 90 * 60000); } finally { watched.delete(id); job.signal.removeEventListener('abort', stop); }
      },
    };
    b.finish = () => { const s = sess(); s.used.ms = (s.used.ms || 0) + (Date.now() - t0); saveSession(s); };
    return b;
  }

  async function startActivity(s, a) {
    s.plan[a.id] = { ...s.plan[a.id], status: 'running', tries: (s.plan[a.id]?.tries || 0) + 1, why: '' };
    saveSession(s);
    let resolveDone; const done = new Promise((r) => { resolveDone = r; });
    const rec = { jobId: null, activity: a.id, done };
    live.set(s.id, rec);
    const finish = (patch) => { const cur = getSession(s.id); if (!cur) return; cur.plan[a.id] = { ...cur.plan[a.id], ...patch, at: iso(nowMs()) }; saveSession(cur); emit({ change: 'activity', id: s.id, activity: a.id }); };
    try {
      const job = await ctx.jobs.start({ kind: 'bench.' + a.id, title: 'Bench: ' + a.title, quiet: true, input: { sessionId: s.id, activity: a.id },
        async run(j) {
          const b = helper(s.id, a, j);
          try {
            const out = await RUN[a.id](b);
            if (j.signal.aborted) throw fail('aborted', 'Stopped');
            const stop = b.lastStop;
            if (stop?.code === 'busy') finish({ status: 'done', summary: out.summary, why: 'the free models were busy for part of it' });
            else finish({ status: out.skip ? 'skipped' : 'done', summary: out.summary, why: out.skip || (stop?.code === 'budget' ? stop.message : '') });
            return { summary: out.summary };
          } catch (e) {
            const cur = getSession(s.id); const tries = cur?.plan[a.id]?.tries || 1;
            if (e.code === 'aborted' || j.signal.aborted) finish({ status: 'pending', why: rec.stopWhy || 'stopped' });
            else if (e.code === 'busy') { if (cur) { cur.waitUntil = e.retryAt; saveSession(cur); } finish(tries >= 3 ? { status: 'skipped', why: 'the free models stayed busy' } : { status: 'pending', why: 'the free models were busy; tried again later' }); }
            else if (e.code === 'nomodel') finish(tries >= 2 ? { status: 'skipped', why: e.message } : { status: 'pending', why: e.message });
            else if (e.code === 'budget') finish({ status: 'done', summary: 'Stopped early: ' + e.message, why: e.message });
            else if (e.code === 'offline') finish({ status: 'pending', why: 'the desk is offline' });
            else { ctx.log('activity failed', a.id, e.message); finish({ status: 'failed', why: String(e.message || e).slice(0, 200) }); }
            return { summary: '', why: e.message };
          } finally { b.finish(); }
        } });
      rec.jobId = job.id;
      ctx.jobs.wait(job.id, 24 * 3600000).finally(() => { if (live.get(s.id) === rec) live.delete(s.id); resolveDone(); });
    } catch (e) {
      live.delete(s.id); resolveDone();
      finish({ status: 'pending', why: e.code === 'halted' ? 'everything was stopped' : e.message });
    }
  }

  // ---------------- the battery: a PC with no battery, or on mains power, is never "low"
  let battCache = { at: 0, v: null };
  async function batteryLow(level) {
    let v;
    if (typeof testHooks.battery === 'function') v = await testHooks.battery();
    else { if (Date.now() - battCache.at > 5 * 60000) { try { battCache = { at: Date.now(), v: await si.battery() }; } catch { battCache = { at: Date.now(), v: null }; } } v = battCache.v; }
    if (!v || !v.hasBattery) return false;
    if (v.acConnected || v.isCharging) return false;
    return Number.isFinite(Number(v.percent)) && Number(v.percent) < level;
  }

  // ---------------- the tick: once a minute (tests call it after moving the clock)
  let ticking = null;
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const c = cfg(); let s = current();
      if (ctx.panic.halted) { if (s) endSession(s, 'stopped', 'Panic stopped it'); return; }
      if (!c.enabled) { if (s) endSession(s, 'done', 'Bench mode was switched off'); return; }
      const t = nowMs(); const seen = kv.get('lastSeen', t);
      if (!s) {
        const panicAt = kv.get('panicAt', 0);
        if (panicAt && seen <= panicAt) return;                       // after Panic, nothing starts until the owner has been back
        if (t - seen < c.startAfter * 60000) return;
        if (kv.get('lastAway', 0) === seen) return;                    // one session per time away
        s = createSession({ awaySince: seen });
      }
      if (live.has(s.id)) return;
      if (await batteryLow(c.battery)) { if (s.why !== 'battery') { s.why = 'battery'; saveSession(s); emit({ change: 'paused', id: s.id }); } return; }
      if (s.why === 'battery') { s.why = ''; saveSession(s); }
      if (s.waitUntil && Date.now() < s.waitUntil) return;              // a free host is cooling down: wait, do not hammer
      s.tier = tierFor(t - s.awaySince);
      const B = budget();
      if (s.used.calls >= B.session.calls || s.used.ms >= B.session.minutes * 60000) {
        for (const a of ACTIVITIES) if (s.plan[a.id].status === 'pending' && a.tier <= s.tier) Object.assign(s.plan[a.id], { status: 'skipped', why: 'the session budget was reached' });
        saveSession(s); return;
      }
      const isOnline = online();
      for (const a of ACTIVITIES) if (a.web && !isOnline && a.tier <= s.tier && s.plan[a.id].status === 'pending') s.plan[a.id].why = 'the desk is offline';
      saveSession(s);
      const a = nextActivity(s.plan, { tier: s.tier, online: isOnline });
      if (a) { await startActivity(s, a); return true; }
      return false;
    })().finally(() => { ticking = null; });
    return ticking;
  }

  /** The owner is here (a click, a key, a message, the page opened). Bench stops at once and the note is ready. */
  function ownerSeen() {
    const t = nowMs(); kv.set('lastSeen', t);
    const s = current();
    if (s && t >= (s.graceUntil || 0)) { endSession(s, 'done', 'you came back'); return { ended: s.id }; }
    return { ended: null };
  }

  // Panic: the running activity stops with every other job; the session ends and never resumes by itself.
  const offPanic = ctx.panic.onStop((reason) => { if (reason === 'Shutting down') return; kv.set('panicAt', nowMs()); const s = current(); if (s) endSession(s, 'stopped', 'Panic stopped it'); });
  // Safety net: an approval that would wait for the owner, asked by a job Bench started, stops that job at once.
  const offEvents = ctx.events.on((type, d) => {
    if (type !== 'approval' || d?.status !== 'pending' || !d.jobId) return;
    const s = current(); const r = s && live.get(s.id);
    if (!r || (d.jobId !== r.jobId && !watched.has(d.jobId))) return;
    try { ctx.jobs.stop(d.jobId); } catch {}
    if (r.jobId !== d.jobId) { try { ctx.jobs.stop(r.jobId); } catch {} }
    ctx.db.run('INSERT INTO m_bench_items (id, session_id, kind, tier, activity, title, body, evidence, complete, state, data, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', rid('bi_'), s.id, 'needs', activityDef(r.activity)?.tier || 1, r.activity, `Needs you: ${String(d.title || 'an approval').slice(0, 200)}`, 'Bench stopped this work instead of waiting for your approval.', '[]', 1, 'new', '{}', iso(nowMs()));
  });

  // a session that was running when the desk stopped resumes from its stored state; the activity that was running starts again
  for (const r of ctx.db.all("SELECT id FROM m_bench_sessions WHERE state = 'running'")) {
    const s = getSession(r.id); let changed = false;
    for (const p of Object.values(s.plan)) if (p.status === 'running') { p.status = 'pending'; p.why = 'the desk restarted'; changed = true; }
    if (changed) saveSession(s);
  }

  // ---------------- the note
  const lastEnded = () => sessionOut(ctx.db.get("SELECT * FROM m_bench_sessions WHERE state != 'running' ORDER BY ended DESC LIMIT 1"));
  const noteFor = (s) => { const list = items(s.id); const n = buildNote(s, list, { now: nowMs() }); return { session: s, note: n, text: noteText(n), items: list }; };
  function view() {
    const c = cfg(); const s = current(); const last = lastEnded();
    const r = s ? live.get(s.id) : null;
    return { settings: c, online: online(), halted: ctx.panic.halted, lastSeen: iso(kv.get('lastSeen', nowMs())), tiers: TIERS, activities: ACTIVITIES,
      running: s ? { ...s, now: r ? activityDef(r.activity)?.title : null, waiting: s.why === 'battery' ? 'Paused: the PC is on battery' : s.waitUntil > Date.now() ? 'Waiting for the free models' : '' } : null,
      note: last && !last.seen && items(last.id, { state: 'new' }).length ? noteFor(last) : null,
      paidAllowed: Object.entries(providerTiers()).some(([p, tier]) => tier === 'paid' && paidAllowed(p)) || paidAllowed('openrouter') };
  }

  // ---------------- what Keep does: one item, through the module that owns that kind of thing
  async function keep(it) {
    const d = it.data || {};
    if (it.kind === 'lesson') { const m = ctx.modules.api('memory'); if (!m?.remember) throw fail('off', 'Memory is off.'); const r = await m.remember({ text: d.text || it.title, kind: 'lesson', source: 'owner', wait: false }); return `Added to Memory as a lesson for every agent.${r?.id ? '' : ''}`; }
    if (it.kind === 'skill') { const a = ctx.modules.api('agents'); if (!a?.addSkill) throw fail('off', 'Agents is off.'); const s = a.addSkill({ title: d.title, body: d.body, description: `Drafted by Bench from your asks` }); return `Added to Agents as "${s.title}", switched off until you turn it on for an agent.`; }
    if (it.kind === 'lead') { const sales = ctx.modules.api('sales'); if (!sales?.addLead) throw fail('off', 'Sales is off.'); const l = sales.addLead({ ...(d.lead || {}), stage: 'new', foundBy: 'Bench' }); return l.duplicate ? `${l.company} is already in your pipeline (${l.stageLabel}).` : `Added ${l.company} to Sales as New.`; }
    if (it.kind === 'profile') return 'Saved only when you press Save in the box that opens.';
    if (it.kind === 'needs') throw fail('bad', 'This one needs you: open it or turn it into a task.');
    return 'Kept on the Bench page.';
  }
  const ownerOnly = (res, owner) => { if (!owner) { ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403); return true; } return false; };
  ctx.route('POST', '/seen', (req, res, { owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, ownerSeen()); });
  ctx.route('GET', '/state', (req, res) => ctx.json(res, view()));
  ctx.route('GET', '/sessions', (req, res) => ctx.json(res, { sessions: ctx.db.all('SELECT * FROM m_bench_sessions ORDER BY started DESC LIMIT 50').map(sessionOut).map((s) => ({ ...s, counts: Object.fromEntries(KINDS.map((k) => [k, items(s.id, { kind: k }).length]).filter(([, n]) => n)) })) }));
  ctx.route('GET', '/sessions/:id', (req, res, { params, query }) => { const s = getSession(params.id); if (!s) return ctx.json(res, { error: 'No such session.' }, 404); const n = noteFor(s); ctx.json(res, { ...n, items: items(s.id, { kind: query.kind || undefined, state: query.state || undefined }) }); });
  ctx.route('POST', '/sessions/:id/seen', (req, res, { params, owner }) => { if (ownerOnly(res, owner)) return; const s = getSession(params.id); if (!s) return ctx.json(res, { error: 'No such session.' }, 404); s.seen = iso(nowMs()); saveSession(s); emit({ change: 'seen', id: s.id }); ctx.json(res, { ok: true }); });
  ctx.route('POST', '/settings', (req, res, { body, owner }) => {
    if (ownerOnly(res, owner)) return;
    if (typeof body?.enabled === 'boolean') kv.set('enabled', body.enabled);
    if (START_AFTER.includes(Number(body?.startAfter))) kv.set('startAfter', Number(body.startAfter));
    if (MODEL_MODES.includes(body?.models)) kv.set('models', body.models);
    if (body?.battery != null && Number.isFinite(Number(body.battery))) kv.set('battery', Math.max(0, Math.min(100, Math.round(Number(body.battery)))));
    if (typeof body?.site === 'string') kv.set('site', body.site.trim().slice(0, 200));
    ctx.json(res, view());
  });
  ctx.route('POST', '/start', async (req, res, { owner }) => {
    if (ownerOnly(res, owner)) return;
    if (ctx.panic.halted) return ctx.json(res, { error: 'Everything is stopped. Press Resume first.' }, 409);
    if (!cfg().enabled) return ctx.json(res, { error: 'Switch Bench mode on first.' }, 409);
    const s = current(); if (s) return ctx.json(res, { ok: true, id: s.id, already: true });
    const t = nowMs(); const n = createSession({ awaySince: t - TIERS[0].hours * 3600000, manual: true });
    tick().catch((e) => ctx.log('tick', e.message));
    ctx.json(res, { ok: true, id: n.id, text: 'Bench started. It stops when you next use the desk, after one minute.' });
  });
  ctx.route('POST', '/items/:id/:act', async (req, res, { params, owner }) => {
    if (ownerOnly(res, owner)) return;
    const it = getItem(params.id); if (!it) return ctx.json(res, { error: 'No such finding.' }, 404);
    if (it.state !== 'new') return ctx.json(res, { error: 'This one was already decided.' }, 409);
    let result = '';
    try {
      if (params.act === 'keep') result = await keep(it);
      else if (params.act === 'dismiss') result = 'Dismissed.';
      else if (params.act === 'task') { const t = ctx.modules.api('tasks'); if (!t?.create) throw fail('off', 'Tasks is off.'); const j = await t.create({ title: it.title.replace(/^Needs you: /, ''), prompt: it.data?.prompt || `${it.title}. ${it.body}` }); result = `Started as a task: ${j.title}.`; }
      else return ctx.json(res, { error: 'Keep, dismiss or task.' }, 400);
    } catch (e) { return ctx.json(res, { error: e.message }, e.code === 'bad' ? 400 : 409); }
    const state = params.act === 'keep' ? 'kept' : params.act === 'dismiss' ? 'dismissed' : 'task';
    ctx.db.run('UPDATE m_bench_items SET state = ?, decided = ?, result = ? WHERE id = ?', state, iso(nowMs()), result, it.id);
    emit({ change: 'item', id: it.id, state });
    ctx.json(res, { ok: true, item: getItem(it.id), result, ...(it.kind === 'profile' && state === 'kept' ? { apply: { setting: 'business.about', text: it.data?.text || '' } } : {}) });
  });

  const timer = setInterval(() => { tick().catch((e) => ctx.log('tick', e.message)); }, 60000); timer.unref?.();
  ctx.expose({ tick, ownerSeen, current, session: getSession, items, note: (id) => { const s = id ? getSession(id) : lastEnded(); return s ? noteFor(s) : null; }, view, idle: async () => { for (const r of [...live.values()]) await r.done; if (ticking) await ticking; } });
  return { async deactivate() { clearInterval(timer); offPanic?.(); offEvents?.(); const s = current(); if (s) stopLive(s.id, 'Bench was switched off'); } };
}
