// Bench mode (module 31): while the owner is away from the desk's window, the desk looks back at its own work and looks up
// his market, in tiers by how long he has been away (1, 12, 36, 108 hours), and leaves him a note. Everything it finds is a
// Bench item with its evidence; the owner's Keep applies one through the module that owns it. Bench never sends, applies,
// signs up, approves or changes a setting: it uses the read-only settings view and other modules' exposed functions only.
import si from 'systeminformation';
import { spawn as realSpawn } from 'node:child_process';
import { TIERS, ACTIVITIES, BUDGET, KINDS, tierFor, freshPlan, nextActivity, modelOrder, buildNote, noteText, activity as activityDef } from './engine.js';
import { RUN, fieldWord } from './activities.js';
import { OPTIONS, OPTION_WORDS, LIMITS, LIMIT_WORDS, GATE_DEFAULTS, gateReady, effectiveMode, limitStatus, cleanCap, cleanLimits } from './spendgate.js';
import { BEAT_MS, BEAT_KEEP_MS, gapBetween, gapText, todoList, hasWork, DRAFT_TYPES, DRAFT_WORDS, cleanDraft, draftText, makeDraft, draftPick, draftable, zoneDay, zoneDayStart, pickFind, answerFind, rulesIn, RULE_WORDS, weeklyNote } from './extras.js';
import { keepAwake } from './keepawake.js';

/** Tests set these: a fake clock (ms), a fake battery reading, no pause between calls, smaller budgets. */
export const testHooks = { clock: null, battery: null, paceMs: null, budget: null, spawn: null, platform: null };
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
  // v2: the money choice (one row), ratings the owner leaves, and the step trace behind each job.
  ctx.db.migrate(2, `
    CREATE TABLE IF NOT EXISTS m_bench_spendgate (id TEXT PRIMARY KEY, option TEXT, chosen INTEGER DEFAULT 0, cap_session INTEGER DEFAULT 0, cap_day INTEGER DEFAULT 0, limits TEXT, set_at TEXT);
    CREATE TABLE IF NOT EXISTS m_bench_ratings (id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, thumb TEXT, research TEXT, reasons TEXT, comment TEXT, rated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS m_bench_ratings_target ON m_bench_ratings (target_type, target_id);
    CREATE TABLE IF NOT EXISTS m_bench_steps (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER, agent_id TEXT, action TEXT, provider TEXT, model TEXT, ms INTEGER, outcome TEXT, at TEXT);
    CREATE INDEX IF NOT EXISTS m_bench_steps_job ON m_bench_steps (job_id, seq);`);
  // v3: heartbeats (kept 24 hours), gaps when the desk was not running, today's find, and the rulebook.
  ctx.db.migrate(3, `
    CREATE TABLE IF NOT EXISTS m_bench_heartbeats (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, running TEXT, session_id TEXT, spend_minor INTEGER DEFAULT 0, currency TEXT);
    CREATE INDEX IF NOT EXISTS m_bench_heartbeats_at ON m_bench_heartbeats (at);
    CREATE TABLE IF NOT EXISTS m_bench_gaps (id TEXT PRIMARY KEY, from_at TEXT NOT NULL, to_at TEXT NOT NULL, noted TEXT);
    CREATE TABLE IF NOT EXISTS m_bench_finds (day TEXT PRIMARY KEY, session_id TEXT, topic TEXT, question TEXT, why TEXT, answer TEXT, sources TEXT, status TEXT, created TEXT);
    CREATE TABLE IF NOT EXISTS m_bench_rules (id TEXT PRIMARY KEY, kind TEXT, text TEXT, original TEXT, file TEXT, line INTEGER, state TEXT, created TEXT, decided TEXT);`);
  const kv = ctx.kv;
  const cfg = () => ({ enabled: kv.get('enabled', false) === true, startAfter: START_AFTER.includes(kv.get('startAfter', 30)) ? kv.get('startAfter', 30) : 30,
    models: MODEL_MODES.includes(kv.get('models', 'free')) ? kv.get('models', 'free') : 'free', battery: Math.max(0, Math.min(100, Number(kv.get('battery', 30)) || 0)), site: String(kv.get('site', '') || '') });
  const budget = () => testHooks.budget || BUDGET;
  /** The owner's own name for Bench's menu place (Settings, Menu), else "Bench". */
  const placeName = () => { const n = ctx.settings.get('ui.menu')?.names?.bench; return typeof n === 'string' && n.trim() ? n.replace(/\s+/g, ' ').trim().slice(0, 30) : 'Bench'; };
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
  // keep awake (off by default): the system's own tool only, held while work is queued or running
  const awake = keepAwake({ spawn: (...a) => (testHooks.spawn || realSpawn)(...a), platform: testHooks.platform || process.platform, pid: process.pid, log: (...a) => ctx.log(...a) });

  // ---------------- the spend gate: the money choice Bench must have before it spends, with its caps and session limits
  const gateRow = () => ctx.db.get("SELECT * FROM m_bench_spendgate WHERE id = 'gate'");
  const gate = () => { const r = gateRow(); if (!r) return { ...GATE_DEFAULTS, limits: { ...LIMITS } };
    return { option: r.option || null, chosen: !!r.chosen, capSessionMinor: r.cap_session || 0, capDayMinor: r.cap_day || 0, limits: { ...LIMITS, ...J(r.limits, {}) }, setAt: r.set_at || null }; };
  const setGate = (patch) => {
    const g = gate();
    const next = { option: OPTIONS.includes(patch.option) ? patch.option : g.option, chosen: g.chosen || OPTIONS.includes(patch.option),
      cap_session: patch.capSessionMinor != null ? cleanCap(patch.capSessionMinor) : g.capSessionMinor,
      cap_day: patch.capDayMinor != null ? cleanCap(patch.capDayMinor) : g.capDayMinor,
      limits: JSON.stringify(patch.limits ? cleanLimits({ ...g.limits, ...patch.limits }) : g.limits) };
    ctx.db.run("INSERT INTO m_bench_spendgate (id, option, chosen, cap_session, cap_day, limits, set_at) VALUES ('gate', ?, 1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET option = excluded.option, chosen = 1, cap_session = excluded.cap_session, cap_day = excluded.cap_day, limits = excluded.limits, set_at = excluded.set_at",
      next.option, next.cap_session, next.cap_day, next.limits, iso(nowMs()));
    emit({ change: 'gate' });
    return gate();
  };
  // paid spend (minor units) from the model-call log: the door prices every call by its list price, so a call on a free-tier key
  // (Gemini, Groq, ...) carries a cost it never charged; only paid providers count, and OpenRouter, whose free models cost 0
  const paidSince = (sinceIso) => { const tiers = providerTiers(); return ctx.db.all('SELECT provider, COALESCE(SUM(cost_minor), 0) AS c FROM calls WHERE at >= ? GROUP BY provider', sinceIso)
    .reduce((a, r) => a + (r.provider === 'openrouter' || tiers[r.provider] !== 'free-signup' ? Number(r.c) || 0 : 0), 0); };
  const dayStartIso = () => iso(zoneDayStart(nowMs(), ctx.settings.get('timeZone')));   // the owner's day, in his zone
  const daySpend = () => paidSince(dayStartIso());
  const sessionSpend = (s) => s ? paidSince(s.started) : 0;
  const sessionUsed = (s) => ({ tasks: Object.values(s.plan || {}).filter((p) => p.status !== 'pending').length, sources: s.used.pages || 0, steps: s.used.calls || 0, minutes: Math.round((s.used.ms || 0) / 60000) });
  const effMode = (s) => effectiveMode(gate(), { daySpend: daySpend(), sessionSpend: sessionSpend(s) });

  // ---------------- the step trace: the desk's own record of what ran (times, models, sources), not a model's reason
  const stepCount = (jobId) => ctx.db.get('SELECT COUNT(*) AS c FROM m_bench_steps WHERE job_id = ?', jobId).c;
  const addStep = (jobId, agentId, step) => {
    if (!jobId) return;
    ctx.db.run('INSERT INTO m_bench_steps (id, job_id, seq, agent_id, action, provider, model, ms, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rid('st_'), jobId, stepCount(jobId), agentId || null, String(step.action || '').slice(0, 80), step.provider || null, step.model || null, step.ms || 0, String(step.outcome || '').slice(0, 300), iso(nowMs()));
  };
  const stepsFor = (jobId) => ctx.db.all('SELECT * FROM m_bench_steps WHERE job_id = ? ORDER BY seq', jobId).map((r) => ({ seq: r.seq, agentId: r.agent_id, action: r.action, provider: r.provider, model: r.model, ms: r.ms, outcome: r.outcome, at: r.at }));

  // ---------------- ratings the owner leaves on an answer, a job or a Bench finding (collected only; no auto-tuning)
  const RATING_REASONS = ['wrong facts', 'weak sources', 'missed the point', 'too long', 'too short', 'outdated', 'other'];
  const ratingOut = (r) => !r ? null : ({ targetType: r.target_type, targetId: r.target_id, thumb: r.thumb || null, research: r.research || null, reasons: J(r.reasons, []), comment: r.comment || '', ratedAt: r.rated_at });
  const getRating = (type, id) => ratingOut(ctx.db.get('SELECT * FROM m_bench_ratings WHERE target_type = ? AND target_id = ?', String(type), String(id)));
  const setRating = (type, id, body) => {
    const thumb = ['up', 'down'].includes(body.thumb) ? body.thumb : null;
    const research = ['good', 'bad'].includes(body.research) ? body.research : null;
    const reasons = Array.isArray(body.reasons) ? body.reasons.filter((x) => RATING_REASONS.includes(x)).slice(0, 7) : [];
    const comment = String(body.comment || '').slice(0, 1000);
    if (thumb === null && research === null && !reasons.length && !comment) { ctx.db.run('DELETE FROM m_bench_ratings WHERE target_type = ? AND target_id = ?', String(type), String(id)); emit({ change: 'rating', targetType: type, targetId: id }); return null; }
    ctx.db.run('INSERT INTO m_bench_ratings (id, target_type, target_id, thumb, research, reasons, comment, rated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_type, target_id) DO UPDATE SET thumb = excluded.thumb, research = excluded.research, reasons = excluded.reasons, comment = excluded.comment, rated_at = excluded.rated_at',
      rid('rt_'), String(type), String(id), thumb, research, JSON.stringify(reasons), comment, iso(nowMs()));
    emit({ change: 'rating', targetType: type, targetId: id });
    return getRating(type, id);
  };

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
  /** One model route by name; a second try avoids the routes named (when another is left; the Free API picks its next host). */
  const routeKey = (m) => `${m.provider}:${m.model || ''}`;
  const pick = (order, avoid) => { const rest = order.filter((m) => !(avoid || []).includes(routeKey(m))); return rest.length ? rest : order; };
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
        // the gate decides the model mode; at 80% of a session limit a paid mode winds down to free
        const g = gate(); const em = effectiveMode(g, { daySpend: daySpend(), sessionSpend: sessionSpend(sess()) });
        let mode = em.mode || 'local'; if (limitStatus(g.limits, sessionUsed(sess())).winding && mode === 'paid') mode = 'free';
        const order = pick(modelOrder(await ctx.model.active(), { mode, tiers: providerTiers(), paidAllowed }), o.avoid);
        if (!order.length) throw fail('nomodel', online() ? 'no model was set up for Bench' : 'the desk is offline and no local model is running');
        let retryAt = 0; const errs = [];
        for (const m of order) {
          check('calls');
          const wait = lastCall + pace - Date.now(); if (wait > 0) await sleep(wait, job.signal);
          lastCall = Date.now(); use('calls'); const t1 = Date.now();
          try {
            const { agentId: _a, model: _m, signal: _s, avoid: _v, ...rest } = o;
            const r = { ...await ctx.model.chat({ ...rest, model: { provider: m.provider, model: m.model }, signal: job.signal }), route: routeKey(m) };
            const s = sess(); if (!s.models.includes(r.label)) { s.models.push(r.label); saveSession(s); }
            addStep(job.id, 'scout', { action: 'asked a model', provider: r.provider || m.provider, model: r.model || m.model, ms: r.ms || (Date.now() - t1), outcome: 'answered' });
            return r;
          } catch (e) {
            if (job.signal.aborted || e.code === 'aborted' || e.code === 'halted') throw fail('aborted', 'Stopped');
            addStep(job.id, 'scout', { action: 'asked a model', provider: m.provider, model: m.model, ms: Date.now() - t1, outcome: 'no answer: ' + e.message });
            if (e.retryAt) retryAt = retryAt ? Math.min(retryAt, Date.parse(e.retryAt)) : Date.parse(e.retryAt);
            errs.push(e.message);
          }
        }
        if (retryAt) throw fail('busy', 'the free models were busy', { retryAt });
        throw fail('nomodel', 'no model answered');
      },
      modelFor: () => ({ chat: (o) => b.ask(o) }),
      async search(q) { const s = ctx.modules.api('search'); if (!s?.search) throw fail('no_search', 'Search is off'); check('searches'); use('searches'); const t1 = Date.now(); const r = await s.search(q, { count: 6, signal: job.signal }) || []; addStep(job.id, 'scout', { action: 'searched', ms: Date.now() - t1, outcome: `"${String(q).slice(0, 60)}" -> ${r.length} results` }); return r; },
      async read(url) { const s = ctx.modules.api('search'); if (!s?.read) throw fail('no_search', 'Search is off'); check('pages'); use('pages'); await sleep(Math.min(pace, 1000), job.signal); const t1 = Date.now(); const r = await s.read(url, { signal: job.signal, cache }); addStep(job.id, 'scout', { action: 'read a page', ms: Date.now() - t1, outcome: String(url).slice(0, 120) }); return r; },
      left() { const s = sess(); return { calls: Math.min(B.activity.calls - mine.calls, B.session.calls - s.used.calls), pages: Math.min(B.activity.pages - mine.pages, B.session.pages - s.used.pages), searches: Math.min(B.activity.searches - mine.searches, B.session.searches - s.used.searches), minutes: Math.max(0, Math.floor(Math.min(B.activity.minutes * 60000 - (Date.now() - t0), B.session.minutes * 60000 - s.used.ms) / 60000)) }; },
      spent({ pages = 0, searches = 0 } = {}) { if (pages) use('pages', pages); if (searches) use('searches', searches); },
      note(e) { if (e?.code === 'busy' && e.retryAt) { const s = sess(); s.waitUntil = e.retryAt; saveSession(s); } b.lastStop = e; },
      item(x) {
        const id = rid('bi_');
        ctx.db.run('INSERT INTO m_bench_items (id, session_id, kind, tier, activity, title, body, evidence, complete, state, data, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, sid, KINDS.includes(x.kind) ? x.kind : 'needs', a.tier, a.id, String(x.title || '').slice(0, 300), String(x.body || '').slice(0, 4000), JSON.stringify((x.evidence || []).slice(0, 6)), x.complete ? 1 : 0, 'new', JSON.stringify({ ...(x.data || {}), _jobId: job.id }), iso(nowMs()));
        return id;
      },
      sessionItems: () => items(sid),
      /** Bench's own findings of one kind, in every session and whatever the owner decided (so one is not proposed twice). */
      everItems: (kind) => ctx.db.all('SELECT * FROM m_bench_items WHERE kind = ?', kind).map(itemOut),
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
    const t0 = Date.now();
    s.plan[a.id] = { ...s.plan[a.id], status: 'running', tries: (s.plan[a.id]?.tries || 0) + 1, why: '', startedMs: t0 };
    saveSession(s);
    let resolveDone; const done = new Promise((r) => { resolveDone = r; });
    const rec = { jobId: null, activity: a.id, done };
    live.set(s.id, rec);
    const finish = (patch) => { const cur = getSession(s.id); if (!cur) return; cur.plan[a.id] = { ...cur.plan[a.id], ...patch, ...(patch.status !== 'pending' ? { ms: Date.now() - t0 } : {}), at: iso(nowMs()) }; saveSession(cur); emit({ change: 'activity', id: s.id, activity: a.id }); };
    try {
      const job = await ctx.jobs.start({ kind: 'bench.' + a.id, title: 'Bench: ' + a.title, quiet: true, input: { sessionId: s.id, activity: a.id },
        async run(j) {
          const b = helper(s.id, a, j);
          try {
            const out = await RUN[a.id](b);
            if (j.signal.aborted) throw fail('aborted', 'Stopped');
            await autoDraft(b, a, s.id).catch((e) => ctx.log('draft', e.message));   // a rough Draft with a result; optional
            if (j.signal.aborted) throw fail('aborted', 'Stopped');
            const stop = b.lastStop;
            if (stop?.code === 'busy') finish({ status: 'done', summary: out.summary, why: 'the free models were busy for part of it' });
            else finish({ status: out.skip ? 'skipped' : 'done', summary: out.summary, why: out.skip || (stop?.code === 'budget' ? stop.message : '') });
            return { summary: out.summary };
          } catch (e) {
            const cur = getSession(s.id); const tries = cur?.plan[a.id]?.tries || 1;
            // the desk itself is stopping (desk.stop, an update restart): leave it "running", as a desk that was cut off, so the next
            // start deletes its half-made findings and runs it again from the start
            if ((e.code === 'aborted' || j.signal.aborted) && ctx.panic.halted && (!rec.stopWhy || shuttingDown)) { /* resumed on the next start */ }
            else if (e.code === 'aborted' || j.signal.aborted) finish({ status: 'pending', why: rec.stopWhy || 'stopped' });
            else if (e.code === 'busy') { if (cur) { cur.waitUntil = e.retryAt; saveSession(cur); } finish(tries >= 3 ? { status: 'skipped', why: 'the free models stayed busy' } : { status: 'pending', why: 'the free models were busy; tried again later' }); }
            else if (e.code === 'nomodel') finish(tries >= 2 ? { status: 'skipped', why: e.message } : { status: 'pending', why: e.message });
            else if (e.code === 'budget') finish({ status: 'done', summary: 'Stopped early: ' + e.message, why: e.message });
            else if (e.code === 'offline') finish({ status: 'pending', why: 'the desk is offline' });
            else { ctx.log('activity failed', a.id, e.message); finish({ status: 'failed', why: String(e.message || e).slice(0, 200) }); }
            return { summary: '', why: e.message };
          } finally { b.finish(); }
        } });
      rec.jobId = job.id;
      ctx.jobs.wait(job.id, 24 * 3600000).finally(() => { if (live.get(s.id) === rec) live.delete(s.id); resolveDone(); syncAwake(); });
    } catch (e) {
      live.delete(s.id); resolveDone();
      finish({ status: 'pending', why: e.code === 'halted' ? 'everything was stopped' : e.message });
    }
  }

  // ---------------- drafts: a rough one-pager or next-actions list that comes with a result (a Bench item of kind "draft")
  const insertItem = (sid, tier, activityId, x, jobId) => {
    const id = rid('bi_');
    ctx.db.run('INSERT INTO m_bench_items (id, session_id, kind, tier, activity, title, body, evidence, complete, state, data, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, sid, x.kind, tier || 0, activityId, String(x.title || '').slice(0, 300), String(x.body || '').slice(0, 8000), JSON.stringify((x.evidence || []).slice(0, 6)), x.complete ? 1 : 0, 'new', JSON.stringify({ ...(x.data || {}), ...(jobId ? { _jobId: jobId } : {}) }), iso(nowMs()));
    return id;
  };
  const updItem = (id, patch) => {
    const it = getItem(id); if (!it) return null;
    const n = { ...it, ...patch };
    ctx.db.run('UPDATE m_bench_items SET title = ?, body = ?, data = ?, state = ?, decided = ?, result = ? WHERE id = ?', n.title, String(n.body || '').slice(0, 8000), JSON.stringify(n.data || {}), n.state, n.decided || null, n.result || null, id);
    emit({ change: 'item', id, state: n.state });
    return getItem(id);
  };
  const draftTitle = (type, from) => `Draft: ${DRAFT_WORDS[type]} ${type === 'onepager' ? 'on' : 'from'} ${String(from.title || '').slice(0, 200)}`;
  const draftItem = (type, from, d, version = 1) => ({ kind: 'draft', title: draftTitle(type, from), body: draftText(d), evidence: from.evidence || [], complete: false, data: { draft: d, fromItem: from.id, version } });
  /** After an activity: one one-pager per session (from a finding with full evidence) and one next-actions list (from the plan). */
  async function autoDraft(b, a, sid) {
    const list = items(sid); const drafts = list.filter((i) => i.kind === 'draft');
    const have = { onepager: drafts.some((d) => d.data?.draft?.type === 'onepager'), actions: drafts.some((d) => d.data?.draft?.type === 'actions') };
    const pick = draftPick(a.id, list.filter((i) => i.activity === a.id && i.state === 'new' && i.kind !== 'draft'), have);
    if (!pick.item) return;
    const d = await makeDraft((o) => b.ask(o), pick.item, pick.type);
    const x = draftItem(pick.type, pick.item, d); b.item({ ...x, data: { ...x.data, route: d.route } });
  }
  /** A model answer for something the owner pressed, inside his spend choice (no session budget: he is here). */
  async function ownerAsk(o, signal) {
    const g = gate(); if (!gateReady(g)) throw fail('gate', 'Choose how Bench may spend first.');
    const em = effectiveMode(g, { daySpend: daySpend(), sessionSpend: 0 });
    const order = pick(modelOrder(await ctx.model.active(), { mode: em.mode || 'local', tiers: providerTiers(), paidAllowed }), o.avoid);
    if (!order.length) throw fail('nomodel', 'No model is set up for Bench.');
    for (const m of order) {
      try { const { agentId: _a, model: _m, signal: _s, avoid: _v, ...rest } = o; return { ...await ctx.model.chat({ ...rest, model: { provider: m.provider, model: m.model }, signal }), route: routeKey(m) }; }
      catch (e) { if (signal?.aborted || e.code === 'aborted' || e.code === 'halted') throw fail('aborted', 'Stopped'); }
    }
    throw fail('nomodel', 'No model answered.');
  }
  /** The owner asked for a draft (or another go at one), and waits for it on the page: the answer is the reply he sees, so the
   *  job is quiet and ends done either way; a draft that was not made is told to him there, not left as an unfinished task. */
  async function ownerDraft(from, type, avoid = []) {
    if (!draftable(from)) throw fail('nothing', 'There is nothing to draft: this finding has nothing more to say than its own words.');
    const job = await ctx.jobs.start({ kind: 'bench.draft', title: `${placeName()}: a ${DRAFT_WORDS[type]}`, quiet: true, input: { itemId: from.id, type }, async run(j) {
      try { const d = await makeDraft((o) => ownerAsk(o, j.signal), from, type, { avoid }); return { draft: d, route: d.route }; }
      catch (e) { if (e.code === 'aborted' || j.signal.aborted) throw e; return { draft: null, code: e.code || 'nomodel', why: String(e.message || e).slice(0, 160) }; }
    } });
    const done = await ctx.jobs.wait(job.id, 10 * 60000);
    if (done?.status === 'done' && done.output?.draft) return { d: done.output.draft, jobId: job.id, route: done.output.route || '' };
    const why = done?.output?.why || done?.error || '';
    if (done?.output?.code === 'nothing') throw fail('nothing', why);
    throw fail('nomodel', why ? `The draft was not made: ${String(why).replace(/\.$/, '')}.` : 'The draft was not made.');
  }
  /** Another go at a draft, in place: another model than the one that made the last version, when one is set up (the same ask
   *  to the same model can come back word for word from the provider's own store). */
  async function redraft(it, from) {
    const { d, jobId, route } = await ownerDraft(from, it.data.draft.type, it.data.route ? [it.data.route] : []);
    return updItem(it.id, { body: draftText(d), data: { ...it.data, draft: d, route, version: (it.data.version || 1) + 1, _jobId: jobId } });
  }
  async function draftAct(act, it, body) {
    if (act === 'draft') {
      if (['draft', 'needs'].includes(it.kind)) throw fail('bad', 'Make a draft from a finding.');
      const type = DRAFT_TYPES.includes(body?.type) ? body.type : null; if (!type) throw fail('bad', 'A one-pager or a next-actions list.');
      // a draft of this type from this finding is already waiting: another press makes that one again, not a copy
      const open = items(it.sessionId).find((x) => x.kind === 'draft' && x.state === 'new' && x.data?.fromItem === it.id && x.data?.draft?.type === type);
      if (open) return redraft(open, it);
      const { d, jobId, route } = await ownerDraft(it, type);
      return getItem(insertItem(it.sessionId, it.tier, 'draft', { ...draftItem(type, it, d), data: { ...draftItem(type, it, d).data, route } }, jobId));
    }
    if (it.kind !== 'draft' || !it.data?.draft) throw fail('bad', 'This is not a draft.');
    if (it.state !== 'new') throw fail('decided', 'This one was already decided.');
    const type = it.data.draft.type;
    if (act === 'redo') {
      const from = getItem(it.data.fromItem); if (!from) throw fail('gone', 'The finding this draft came from is gone.');
      return redraft(it, from);
    }
    if (act === 'edit') {
      const d = cleanDraft(type, { ...it.data.draft, ...(body?.draft || {}) }, it.data.draft.sources || []);
      if (!d) throw fail('bad', type === 'onepager' ? 'A one-pager needs a summary and at least one key point.' : 'A next-actions list needs 3 to 7 actions, each with its effort and why.');
      return updItem(it.id, { body: draftText(d), data: { ...it.data, draft: d, edited: true } });
    }
    if (act === 'handover') {
      // never sent from Bench: the draft goes to Mail's drafts, where only the owner's "Approve and send" sends it
      const mail = ctx.modules.api('mail'); if (!mail?.draft) throw fail('off', 'Mail is off, so there is no drafts list to hand it to.');
      const to = String(body?.to || '').trim().slice(0, 300);
      await mail.draft({ to, subject: it.title.replace(/^Draft: /, '').slice(0, 300), body: draftText(it.data.draft) });
      return updItem(it.id, { state: 'kept', decided: iso(nowMs()), result: 'Handed to Mail drafts. Nothing is sent until you approve it there.', data: { ...it.data, handedOver: true } });
    }
    throw fail('bad', 'Unknown action.');
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
      if (!gateReady(gate())) return;                                   // no money choice yet: Bench waits for the owner to choose
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
      // a session limit at 100% WHILE work is left: stop, checkpoint, and list what is left (the owner's own ceiling)
      const ls = limitStatus(gate().limits, sessionUsed(s));
      const workLeft = ACTIVITIES.some((a) => a.tier <= s.tier && s.plan[a.id].status === 'pending');
      if (ls.stop && workLeft) {
        for (const a of ACTIVITIES) if (s.plan[a.id].status === 'pending' && a.tier <= s.tier) Object.assign(s.plan[a.id], { status: 'skipped', why: `the session ${LIMIT_WORDS[ls.which]} limit was reached` });
        saveSession(s); endSession(s, 'done', `the session ${LIMIT_WORDS[ls.which]} limit was reached`); return;
      }
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
      const q = isOnline ? findDue() : null;
      if (q) { await startFind(s, q); return true; }
      return false;
    })().finally(() => { ticking = null; syncAwake(); });
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
  let shuttingDown = false;
  const offPanic = ctx.panic.onStop((reason) => { awake.release(); if (reason === 'Shutting down') { shuttingDown = true; return; } kv.set('panicAt', nowMs()); const s = current(); if (s) endSession(s, 'stopped', 'Panic stopped it'); });
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
    for (const [k, p] of Object.entries(s.plan)) if (p.status === 'running') {
      p.status = 'pending'; p.why = 'the desk restarted'; changed = true;
      ctx.db.run("DELETE FROM m_bench_items WHERE session_id = ? AND activity = ? AND state = 'new'", s.id, k);   // it runs again from the start
    }
    if (changed) saveSession(s);
  }

  // ---------------- heartbeat and gaps
  const place = () => ({ timeZone: ctx.settings.get('timeZone') || undefined, locale: ctx.settings.get('locale') || undefined });
  const lastBeat = () => ctx.db.get('SELECT at FROM m_bench_heartbeats ORDER BY id DESC LIMIT 1');
  function runningWord() {
    const s = current(); const r = s && live.get(s.id);
    if (r) return r.activity === 'find' ? "Today's find" : activityDef(r.activity)?.title || 'Bench work';
    return s ? 'A session is open; nothing is running' : 'Nothing is running';
  }
  /** One heartbeat row while Bench is on: the time, what is running, the spend so far. Rows older than 24 hours go. */
  function beat() {
    if (!cfg().enabled) { if (kv.get('beatOff', false) !== true) kv.set('beatOff', true); return false; }
    if (kv.get('beatOff', false) !== false) kv.set('beatOff', false);
    const t = nowMs(); const s = current();
    ctx.db.run('INSERT INTO m_bench_heartbeats (at, running, session_id, spend_minor, currency) VALUES (?, ?, ?, ?, ?)', iso(t), runningWord(), s?.id || null, sessionSpend(s), ctx.settings.get('currency') || '');
    ctx.db.run('DELETE FROM m_bench_heartbeats WHERE at < ?', iso(t - BEAT_KEEP_MS));
    syncAwake();
    return true;
  }
  const heartbeats = () => ctx.db.all('SELECT * FROM m_bench_heartbeats ORDER BY id').map((r) => ({ at: r.at, running: r.running, sessionId: r.session_id, spendMinor: r.spend_minor || 0, currency: r.currency || '' }));
  const gaps = () => ctx.db.all('SELECT * FROM m_bench_gaps ORDER BY from_at').map((r) => ({ from: r.from_at, to: r.to_at }));
  // on start: silence since the last heartbeat (Bench was on and not switched off since) is a time the desk was not running
  { const lb = lastBeat(); const g = cfg().enabled && kv.get('beatOff', false) !== true && lb ? gapBetween(Date.parse(lb.at), nowMs()) : null;
    if (g) { ctx.db.run('INSERT INTO m_bench_gaps (id, from_at, to_at, noted) VALUES (?, ?, ?, ?)', rid('gp_'), iso(g.from), iso(g.to), iso(nowMs())); ctx.activity('Bench: the desk was not running for a while', gapText(g, place())); } }

  // ---------------- the to-do list and keep awake
  /** Measured durations of earlier activities (this session and the last few), by activity. */
  function measured() {
    const out = {};
    for (const r of ctx.db.all('SELECT plan FROM m_bench_sessions ORDER BY started DESC LIMIT 20')) for (const [k, p] of Object.entries(J(r.plan, {}))) if (Number.isFinite(p?.ms) && p.status !== 'pending' && p.status !== 'running') (out[k] ||= []).push(p.ms);
    return out;
  }
  const todoFor = (s) => s ? todoList(s.plan, s.tier, { now: Date.now(), measured: measured() }) : null;
  let off = false;
  function syncAwake() {
    if (off) { awake.release(); return; }
    const s = current();
    const want = kv.get('keepAwake', false) === true && cfg().enabled && !ctx.panic.halted && !!s && s.why !== 'battery' && (live.has(s.id) || hasWork(todoFor(s), { online: online() }));
    if (want) awake.hold(); else awake.release();
  }
  const awakeView = () => ({ on: kv.get('keepAwake', false) === true, ...awake.state(), platform: testHooks.platform || process.platform,
    note: `Keeps this PC from sleeping only while ${placeName()} has work queued or running; the screen may still turn off. It uses the system\'s own tool and nothing else: no clicks or keys are made. It was tested with a stand-in only and has not been run for real on Windows or macOS.` });

  // ---------------- today's find: once a day, one question from the owner's own history in the desk
  const findCfg = () => ({ off: kv.get('findOff', false) === true, avoid: (kv.get('findAvoid', []) || []).filter((x) => typeof x === 'string'), pin: String(kv.get('findPin', '') || '') });
  const today = () => zoneDay(nowMs(), ctx.settings.get('timeZone'));
  const findOut = (r) => !r ? null : ({ day: r.day, topic: r.topic, question: r.question, why: r.why, answer: r.answer || '', sources: J(r.sources, []), status: r.status, created: r.created });
  const finds = () => ctx.db.all('SELECT * FROM m_bench_finds ORDER BY created, rowid').map(findOut);
  const titleOf = (r) => r.targetType === 'bench_item' ? getItem(r.targetId)?.title || '' : r.targetType === 'job' ? ctx.jobs.get(r.targetId)?.title || '' : '';
  function findCandidates() {
    const out = [];
    for (const j of ctx.jobs.list({ status: 'done', limit: 200 })) if (!j.quiet && !String(j.kind).startsWith('bench.') && j.title) out.push({ topic: j.title, why: `It comes from a task you ran: "${String(j.title).slice(0, 120)}".`, at: j.finished || j.created });
    // a kept name from the owner's market (a competitor, a possible customer, a free tool) is asked about with his field word
    const fw = fieldWord(ctx.settings.get('business.about') || '');
    for (const r of ctx.db.all("SELECT title, kind, decided FROM m_bench_items WHERE state = 'kept' AND kind NOT IN ('draft', 'needs') ORDER BY decided DESC LIMIT 50")) out.push({ topic: String(r.title).replace(/: (new|already a customer|already in your pipeline)$/, ''), why: 'You kept this Bench finding.', at: r.decided, ...(fw && ['competitor', 'lead', 'tool'].includes(r.kind) ? { about: fw } : {}) });
    for (const r of ctx.db.all("SELECT * FROM m_bench_ratings WHERE thumb = 'up' OR research = 'good' ORDER BY rated_at DESC LIMIT 50")) { const t = titleOf(ratingOut(r)); if (t) out.push({ topic: t, why: 'You rated this good.', at: r.rated_at }); }
    return out;
  }
  /** Today's question when one is due, else null (a day with nothing to pick is marked done). */
  function findDue() {
    const f = findCfg(); const day = today();
    if (f.off || kv.get('findDay', '') === day || !gateReady(gate())) return null;
    const recent = ctx.db.all('SELECT topic FROM m_bench_finds ORDER BY created DESC LIMIT 14').map((r) => r.topic);
    const q = pickFind(findCandidates(), { avoid: f.avoid, pin: f.pin, recent });
    if (!q) { kv.set('findDay', day); return null; }
    return { ...q, day };
  }
  /** Why there is no find to show, in one line. */
  function noFindWhy() {
    if (findCfg().off) return "Today's find is off in its settings.";
    if (!cfg().enabled) return `${placeName()} is off, so there is no find.`;
    if (!gateReady(gate())) return 'There is no find until you choose how it may spend.';
    const f = findCfg(); const recent = ctx.db.all('SELECT topic FROM m_bench_finds ORDER BY created DESC LIMIT 14').map((r) => r.topic);
    if (!pickFind(findCandidates(), { avoid: f.avoid, pin: f.pin, recent })) return findCandidates().length ? 'Every topic from your history was asked lately or is one to avoid.' : 'No finished tasks or ratings to pick a question from yet.';
    return `The find is picked while ${placeName()} works.`;
  }
  async function startFind(s, q) {
    kv.set('findDay', q.day);
    let resolveDone; const done = new Promise((r) => { resolveDone = r; });
    const rec = { jobId: null, activity: 'find', done }; live.set(s.id, rec);
    const store = (r) => ctx.db.run('INSERT OR REPLACE INTO m_bench_finds (day, session_id, topic, question, why, answer, sources, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', q.day, s.id, q.topic, q.question, q.why, r.answer || '', JSON.stringify(r.sources || []), r.status, iso(nowMs()));
    try {
      const job = await ctx.jobs.start({ kind: 'bench.find', title: "Bench: today's find", quiet: true, input: { sessionId: s.id }, async run(j) {
        const b = helper(s.id, { id: 'find', tier: s.tier, title: "Today's find" }, j);
        try { const r = await answerFind(b, q); if (j.signal.aborted) throw fail('aborted', 'Stopped'); store(r); emit({ change: 'find', day: q.day }); return { summary: r.status }; }
        catch (e) {
          if (e.code === 'aborted' || j.signal.aborted) { kv.set('findDay', ''); return { summary: 'stopped' }; }   // not done today: it may run in the next session
          store({ status: `Not answered: ${String(e.message || e).slice(0, 160)}.` }); return { summary: e.message };
        } finally { b.finish(); }
      } });
      rec.jobId = job.id;
      ctx.jobs.wait(job.id, 24 * 3600000).finally(() => { if (live.get(s.id) === rec) live.delete(s.id); resolveDone(); syncAwake(); });
    } catch { live.delete(s.id); resolveDone(); kv.set('findDay', ''); }
  }

  // ---------------- the rulebook: rules proposed from the owner's own files, read through the Files module (read-only)
  const ruleOut = (r) => ({ id: r.id, kind: r.kind, kindWord: RULE_WORDS[r.kind] || r.kind, text: r.text, original: r.original, file: r.file, line: r.line, state: r.state, created: r.created, decided: r.decided });
  const rulesView = () => { const all = ctx.db.all('SELECT * FROM m_bench_rules ORDER BY file, line, rowid').map(ruleOut);
    return { proposed: all.filter((r) => r.state === 'proposed'), confirmed: all.filter((r) => r.state === 'confirmed'), rejected: all.filter((r) => r.state === 'rejected').length,
      later: 'Checking results against these rules comes later. For now they are only listed.' }; };
  const DESK_FOLDERS = new Set(['reports', 'tables', 'drafts']);   // what the desk itself writes is not the owner's rules
  async function scanRules() {
    const files = ctx.modules.api('files'); if (!files?.list || !files?.read) throw fail('off', 'Files is off, so the desk cannot read your workspace files.');
    const found = []; let read = 0;
    const walk = async (dir, depth) => {
      let r; try { r = await files.list(dir); } catch { return; }
      for (const e of r.items || []) {
        const p = dir ? `${dir}/${e.name}` : e.name;
        if (e.kind === 'folder') { if (depth < 3 && !(depth === 0 && DESK_FOLDERS.has(e.name))) await walk(p, depth + 1); continue; }
        if (!/\.(md|txt)$/i.test(e.name) || read >= 200) continue;
        read++; try { const f = await files.read(p); found.push(...rulesIn(f.text, p)); } catch {}
      }
    };
    await walk('', 0);
    for (const r of found.slice(0, 200)) {
      if (ctx.db.get('SELECT id FROM m_bench_rules WHERE file = ? AND original = ?', r.file, r.text)) continue;
      ctx.db.run('INSERT INTO m_bench_rules (id, kind, text, original, file, line, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', rid('ru_'), r.kind, r.text, r.text, r.file, r.line, 'proposed', iso(nowMs()));
    }
    emit({ change: 'rules' });
    return { ...rulesView(), filesRead: read };
  }

  // ---------------- the weekly note "What I learned": suggestions from the last 7 days of ratings; nothing changes by itself
  // answer ratings live in Chat when Chat offers them; Bench's own store keeps the ratings of jobs and Bench items
  const allRatings = (since) => {
    const chat = ctx.modules.api('chat');
    if (typeof chat?.ratingsSince !== 'function') return ctx.db.all('SELECT * FROM m_bench_ratings').map(ratingOut);
    return [...ctx.db.all("SELECT * FROM m_bench_ratings WHERE target_type != 'answer'").map(ratingOut), ...(chat.ratingsSince(since) || [])];
  };
  const weekly = () => weeklyNote(allRatings(iso(nowMs() - 8 * 24 * 3600000)), { now: nowMs(), titleOf: (r) => titleOf(r) || (r.targetType === 'answer' ? 'An answer in chat' : '') });

  // ---------------- the note
  const lastEnded = () => sessionOut(ctx.db.get("SELECT * FROM m_bench_sessions WHERE state != 'running' ORDER BY ended DESC LIMIT 1"));
  const noteFor = (s) => { const list = items(s.id); const n = buildNote(s, list, { now: nowMs(), name: placeName() }); return { session: s, note: n, text: noteText(n), items: list }; };
  /** The money choice with today's spend and this session's limit status, for the page header and the gate card. */
  function gateView() {
    const g = gate(); const s = current(); const ds = daySpend(); const ss = sessionSpend(s);
    const em = effectiveMode(g, { daySpend: ds, sessionSpend: ss });
    const ls = limitStatus(g.limits, s ? sessionUsed(s) : {});
    return { option: g.option, chosen: g.chosen, ready: gateReady(g), optionWord: g.option ? OPTION_WORDS[g.option] : null, options: OPTIONS, optionWords: OPTION_WORDS,
      capSessionMinor: g.capSessionMinor, capDayMinor: g.capDayMinor, limits: g.limits, limitDefaults: LIMITS, limitWords: LIMIT_WORDS,
      currency: ctx.settings.get('currency') || '', effectiveMode: em.mode, invalid: em.invalid, why: em.why, daySpendMinor: ds, sessionSpendMinor: ss, limitStatus: ls, setAt: g.setAt };
  }
  function view() {
    const c = cfg(); const s = current(); const last = lastEnded(); const gv = gateView();
    const r = s ? live.get(s.id) : null;
    const gateWait = !gv.ready ? 'Waiting for your spend choice' : gv.invalid ? `Spend choice needs you: ${gv.why}` : gv.limitStatus.winding ? `Winding down: ${gv.limitStatus.which} near its limit` : '';
    return { settings: { ...c, models: gv.chosen ? gv.option : null, find: findCfg() }, gate: gv, keepAwake: awakeView(), online: online(), halted: ctx.panic.halted, lastSeen: iso(kv.get('lastSeen', nowMs())), tiers: TIERS, activities: ACTIVITIES,
      running: s ? { ...s, todo: todoFor(s), now: r ? (r.activity === 'find' ? "Today's find" : activityDef(r.activity)?.title) : null, waiting: s.why === 'battery' ? 'Paused: the PC is on battery' : gateWait || (s.waitUntil > Date.now() ? 'Waiting for the free models' : '') } : null,
      note: last && !last.seen && items(last.id, { state: 'new' }).length ? noteFor(last) : null,
      paidAllowed: Object.entries(providerTiers()).some(([p, tier]) => tier === 'paid' && paidAllowed(p)) || paidAllowed('openrouter') };
  }

  // ---------------- the return panel: "While you were away", from jobs, the calls log and Bench's own findings (no made-up results)
  const twoLines = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const jobSources = (j) => { const out = j.output; const src = Array.isArray(out?.sources) ? out.sources : Array.isArray(out?.evidence) ? out.evidence : []; return src.slice(0, 6).map((e) => ({ title: e.title || e.url || '', url: e.url || null })); };
  function returnPanel() {
    const all = ctx.jobs.list({ limit: 200 });
    const ownerJobs = all.filter((j) => !j.quiet || j.status === 'failed');   // quiet upkeep is left out unless it failed
    const doneJobs = ownerJobs.filter((j) => j.status === 'done');
    const waitingJobs = ownerJobs.filter((j) => j.status === 'waiting');
    const stuckJobs = ownerJobs.filter((j) => ['failed', 'stopped', 'interrupted'].includes(j.status));
    const s = current() || lastEnded();
    const list = s ? items(s.id, { state: 'new' }) : [];
    const needItems = list.filter((i) => i.kind === 'needs');
    const resultItems = list.filter((i) => i.kind !== 'needs');
    const drafts = (ctx.approval.listPending?.() || []);
    const jobCard = (j) => ({ kind: 'job', id: j.id, jobId: j.id, title: j.title, summary: twoLines(j.output?.summary || j.detail), sources: jobSources(j), status: j.status, finished: j.finished || j.updated, agentId: j.agentId, chatId: j.chatId, steps: stepCount(j.id), rating: getRating('job', j.id) });
    const itemCard = (i) => ({ kind: 'bench', id: i.id, jobId: i.data?._jobId || null, title: i.title, summary: twoLines(i.body), sources: (i.evidence || []).map((e) => ({ title: e.title || e.url || 'Your desk', url: e.url || null })), itemKind: i.kind, complete: i.complete, steps: i.data?._jobId ? stepCount(i.data._jobId) : 0, rating: getRating('bench_item', i.id) });
    const note = s ? buildNote(s, items(s.id), { now: nowMs(), name: placeName() }) : null;
    const workedMs = (s?.used?.ms || 0) + doneJobs.reduce((a, j) => a + (j.finished && j.created ? Math.max(0, Date.parse(j.finished) - Date.parse(j.created)) : 0), 0);
    const recentGaps = gaps().filter((g) => Date.parse(g.to) >= nowMs() - 48 * 3600000).slice(-5).map((g) => ({ ...g, text: gapText({ from: Date.parse(g.from), to: Date.parse(g.to) }, place()) }));
    const find = findOut(ctx.db.get('SELECT * FROM m_bench_finds ORDER BY created DESC, rowid DESC LIMIT 1'));
    return {
      gaps: recentGaps, find, findWhy: find ? '' : noFindWhy(), weekly: weekly(),
      headline: { finished: doneJobs.length + resultItems.length, needsYou: waitingJobs.length + needItems.length + drafts.length, workedMs, spendTodayMinor: daySpend(), currency: ctx.settings.get('currency') || '', since: s ? s.started : null },
      results: [...resultItems.map(itemCard), ...doneJobs.map(jobCard)],
      needs: [
        ...needItems.map((i) => ({ kind: 'bench', id: i.id, title: i.title, detail: twoLines(i.body) })),
        ...waitingJobs.map((j) => ({ kind: 'job', id: j.id, title: j.title, detail: j.detail || 'Waiting for you' })),
        ...drafts.map((a) => ({ kind: 'draft', id: a.id, title: a.title || 'A draft is waiting for your approval', detail: a.detail || '' })),
      ],
      didntGetTo: [
        ...stuckJobs.map((j) => ({ title: j.title, why: j.error || j.detail || j.status, next: j.status === 'failed' ? 'Open it, read the error, and try again.' : 'Start it again when you are ready.' })),
        ...(note ? note.notDone.map((l) => ({ title: l, why: '', next: '' })) : []),
      ],
    };
  }

  // ---------------- usage: a read-only per-agent view over the existing model-call log, plus Bench's own step log.
  // We do NOT instrument new tool kinds: model calls already pass the model door (the `calls` table) and Bench's own
  // searches/reads/model calls are in m_bench_steps. Other tool/app/API kinds have no single choke point to read, so they
  // are left out rather than scattered log calls across the desk.
  function usagePanel() {
    const day = dayStartIso();
    const agents = ctx.db.all("SELECT COALESCE(agent_id, '(desk)') AS agent, COUNT(*) AS calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cost_minor), 0) AS cost FROM calls WHERE at >= ? GROUP BY agent ORDER BY calls DESC", day)
      .map((r) => ({ agent: r.agent, calls: r.calls, errors: r.errors, inputTokens: r.input, outputTokens: r.output, costMinor: r.cost }));
    const benchSteps = ctx.db.all("SELECT action, COUNT(*) AS n, COALESCE(SUM(ms), 0) AS ms FROM m_bench_steps WHERE at >= ? GROUP BY action ORDER BY n DESC", day).map((r) => ({ action: r.action, count: r.n, ms: r.ms }));
    return { day, currency: ctx.settings.get('currency') || '', agents, benchSteps };
  }
  const usageCsv = () => {
    const u = usagePanel();
    const esc = (s) => /[",\n]/.test(String(s)) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
    const rows = [['agent', 'calls', 'errors', 'input_tokens', 'output_tokens', 'cost_minor', 'currency']];
    for (const a of u.agents) rows.push([a.agent, a.calls, a.errors, a.inputTokens, a.outputTokens, a.costMinor, u.currency]);
    return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  };

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
  const withRating = (i) => ({ ...i, rating: getRating('bench_item', i.id), draftable: !['draft', 'needs'].includes(i.kind) && draftable(i) });
  ctx.route('GET', '/sessions/:id', (req, res, { params, query }) => { const s = getSession(params.id); if (!s) return ctx.json(res, { error: 'No such session.' }, 404); const n = noteFor(s); ctx.json(res, { ...n, todo: todoFor(s), items: items(s.id, { kind: query.kind || undefined, state: query.state || undefined }).map(withRating) }); });
  ctx.route('POST', '/sessions/:id/seen', (req, res, { params, owner }) => { if (ownerOnly(res, owner)) return; const s = getSession(params.id); if (!s) return ctx.json(res, { error: 'No such session.' }, 404); s.seen = iso(nowMs()); saveSession(s); emit({ change: 'seen', id: s.id }); ctx.json(res, { ok: true }); });
  ctx.route('POST', '/settings', (req, res, { body, owner }) => {
    if (ownerOnly(res, owner)) return;
    if (typeof body?.enabled === 'boolean') kv.set('enabled', body.enabled);
    if (START_AFTER.includes(Number(body?.startAfter))) kv.set('startAfter', Number(body.startAfter));
    if (OPTIONS.includes(body?.models)) { kv.set('models', body.models); setGate({ option: body.models }); }   // the money choice is the model mode
    if (body?.battery != null && Number.isFinite(Number(body.battery))) kv.set('battery', Math.max(0, Math.min(100, Math.round(Number(body.battery)))));
    if (typeof body?.site === 'string') kv.set('site', body.site.trim().slice(0, 200));
    if (typeof body?.keepAwake === 'boolean') kv.set('keepAwake', body.keepAwake);
    if (typeof body?.findOff === 'boolean') kv.set('findOff', body.findOff);
    if (body?.findAvoid != null) kv.set('findAvoid', (Array.isArray(body.findAvoid) ? body.findAvoid : String(body.findAvoid).split(',')).map((x) => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 20));
    if (typeof body?.findPin === 'string') kv.set('findPin', body.findPin.trim().slice(0, 140));
    if (typeof body?.enabled === 'boolean') beat();   // on: the first heartbeat now; off: marked, so the silence is no gap
    syncAwake();
    ctx.json(res, view());
  });
  ctx.route('POST', '/start', async (req, res, { owner }) => {
    if (ownerOnly(res, owner)) return;
    if (ctx.panic.halted) return ctx.json(res, { error: 'Everything is stopped. Press Resume first.' }, 409);
    if (!cfg().enabled) return ctx.json(res, { error: `Switch ${placeName()} on first.` }, 409);
    if (!gateReady(gate())) return ctx.json(res, { error: `Choose how ${placeName()} may spend first: Local only, Free, or Paid, capped.` }, 409);
    const s = current(); if (s) return ctx.json(res, { ok: true, id: s.id, already: true });
    const t = nowMs(); const n = createSession({ awaySince: t - TIERS[0].hours * 3600000, manual: true });
    tick().catch((e) => ctx.log('tick', e.message));
    ctx.json(res, { ok: true, id: n.id, text: `${placeName()} started. It stops when you next use the desk, after one minute.` });
  });
  ctx.route('POST', '/items/:id/:act', async (req, res, { params, owner, body }) => {
    if (ownerOnly(res, owner)) return;
    const it = getItem(params.id); if (!it) return ctx.json(res, { error: 'No such finding.' }, 404);
    if (['draft', 'redo', 'edit', 'handover'].includes(params.act)) {
      try { return ctx.json(res, { ok: true, item: withRating(await draftAct(params.act, it, body)) }); }
      catch (e) { return ctx.json(res, { error: e.message }, e.code === 'bad' ? 400 : 409); }
    }
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

  // The money choice and its caps. Raising a cap, like any change here, needs the owner at the desk (owner session).
  ctx.route('POST', '/spendgate', (req, res, { body, owner }) => {
    if (ownerOnly(res, owner)) return;
    if (body?.option != null && !OPTIONS.includes(body.option)) return ctx.json(res, { error: 'Choose Local only, Free, or Paid, capped.' }, 400);
    const patch = {};
    if (OPTIONS.includes(body?.option)) patch.option = body.option;
    if (body?.capSessionMinor != null) patch.capSessionMinor = body.capSessionMinor;
    if (body?.capDayMinor != null) patch.capDayMinor = body.capDayMinor;
    if (body?.limits && typeof body.limits === 'object') patch.limits = body.limits;
    setGate(patch);
    if (OPTIONS.includes(body?.option)) kv.set('models', body.option);
    ctx.json(res, view());
  });
  // Ratings the owner leaves (collected only; nothing auto-tunes from them yet).
  ctx.route('POST', '/ratings', (req, res, { body, owner }) => {
    if (ownerOnly(res, owner)) return;
    const type = String(body?.targetType || '').slice(0, 40); const id = String(body?.targetId || '').slice(0, 120);
    if (!type || !id) return ctx.json(res, { error: 'A rating needs what it is about.' }, 400);
    ctx.json(res, { ok: true, rating: setRating(type, id, body || {}) });
  });
  ctx.route('GET', '/ratings/:type/:id', (req, res, { params, owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, { rating: getRating(params.type, params.id) }); });
  // The step trace: the desk's own record of what ran (times, models, pages), not a model's stated reason.
  ctx.route('GET', '/steps/:jobId', (req, res, { params, owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, { jobId: params.jobId, steps: stepsFor(params.jobId) }); });
  // The return panel: "While you were away".
  ctx.route('GET', '/return', (req, res, { owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, returnPanel()); });
  // Per-agent usage today, from the model-call log and Bench's step log; CSV export is owner-only.
  ctx.route('GET', '/usage', (req, res, { owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, usagePanel()); });
  ctx.route('GET', '/usage.csv', (req, res, { owner }) => {
    if (ownerOnly(res, owner)) return;
    if (res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="usage-today.csv"', 'cache-control': 'no-store' });
    res.end(usageCsv());
  });

  // Today's find, the rulebook and the weekly note.
  ctx.route('GET', '/finds', (req, res, { owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, { finds: finds().slice(-30).reverse() }); });
  ctx.route('GET', '/rules', (req, res, { owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, rulesView()); });
  ctx.route('POST', '/rules/scan', async (req, res, { owner }) => { if (ownerOnly(res, owner)) return; try { ctx.json(res, await scanRules()); } catch (e) { ctx.json(res, { error: e.message }, 409); } });
  ctx.route('POST', '/rules/:id/:act', (req, res, { params, body, owner }) => {
    if (ownerOnly(res, owner)) return;
    const r = ctx.db.get('SELECT * FROM m_bench_rules WHERE id = ?', params.id); if (!r) return ctx.json(res, { error: 'No such rule.' }, 404);
    let text = r.text; let state;
    if (params.act === 'confirm') state = 'confirmed';
    else if (params.act === 'reject') state = 'rejected';
    else if (params.act === 'edit') { text = String(body?.text || '').replace(/\s+/g, ' ').trim().slice(0, 300); if (!text) return ctx.json(res, { error: 'A rule needs some words.' }, 400); state = 'confirmed'; }
    else return ctx.json(res, { error: 'Confirm, edit or reject.' }, 400);
    ctx.db.run('UPDATE m_bench_rules SET text = ?, state = ?, decided = ? WHERE id = ?', text, state, iso(nowMs()), r.id);
    emit({ change: 'rules' });
    ctx.json(res, { ok: true, rule: ruleOut(ctx.db.get('SELECT * FROM m_bench_rules WHERE id = ?', r.id)) });
  });
  ctx.route('GET', '/weekly', (req, res, { owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, weekly()); });

  beat();
  const beatTimer = setInterval(() => { try { beat(); } catch (e) { ctx.log('heartbeat', e.message); } }, BEAT_MS); beatTimer.unref?.();
  const timer = setInterval(() => { tick().catch((e) => ctx.log('tick', e.message)); }, 60000); timer.unref?.();
  ctx.expose({ tick, ownerSeen, current, session: getSession, items, note: (id) => { const s = id ? getSession(id) : lastEnded(); return s ? noteFor(s) : null; }, view, gate, setGate, rating: getRating, setRating,
    answerRatings: () => ctx.db.all("SELECT * FROM m_bench_ratings WHERE target_type = 'answer' ORDER BY rated_at").map(ratingOut), steps: stepsFor, returnPanel, usage: usagePanel, beat, heartbeats, gaps, todo: (id) => todoFor(id ? getSession(id) : current()), finds, rules: rulesView, scanRules, weekly, awake: awakeView, idle: async () => { for (const r of [...live.values()]) await r.done; if (ticking) await ticking; } });
  return { async deactivate() {
    off = true; clearInterval(timer); clearInterval(beatTimer); awake.release(); offPanic?.(); offEvents?.();
    if (!shuttingDown) kv.set('beatOff', true);   // switched off, not a desk that stopped: the silence that follows is no gap
    const s = current(); if (s) stopLive(s.id, 'Bench was switched off');
  } };
}
