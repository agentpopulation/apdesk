// Contract 3: the single approval door. See contracts/APPROVAL-DOOR.md.
// The security level and the auto-approve window are written only through setLevel/setAutoApprove, which require the
// SETTINGS_TOKEN symbol that core/settings-routes.js holds. No module context, chat message or request flag reaches them.
import crypto from 'node:crypto';
import path from 'node:path';
import { id as makeId, now } from './storage.js';

export const SETTINGS_TOKEN = Symbol('apd.settings.token');
export const LEVELS = ['open', 'careful', 'strict'];
export const ACTIONS = ['file.write', 'file.delete', 'file.read.outside', 'shell.run', 'browser.open', 'browser.act', 'net.post', 'send.person', 'spend', 'module.toggle', 'install', 'login', 'calendar.write', 'custom'];
const ALWAYS_ASK = new Set(['send.person']);
// A desk update replaces the program itself: it asks the owner at every level and inside an auto-approve window.
// (A request can only make the door stricter this way; installing is done by core/update.js, never by the grant.)
const alwaysAsks = (action, req) => ALWAYS_ASK.has(action) || (action === 'install' && req?.payload?.kind === 'desk-update');
const ASK_ONCE = { careful: new Set(['file.write', 'browser.act']), strict: new Set() };
// allow | ask | once  per level
const POLICY = {
  'file.write':        { open: 'allow', careful: 'once', strict: 'ask' },
  'file.delete':       { open: 'allow', careful: 'ask', strict: 'ask' },
  'file.read.outside': { open: 'folder', careful: 'folder', strict: 'ask' },
  'shell.run':         { open: 'ask', careful: 'ask', strict: 'ask' },
  'browser.open':      { open: 'allow', careful: 'visited', strict: 'ask' },
  'browser.act':       { open: 'allow', careful: 'once', strict: 'ask' },
  'net.post':          { open: 'allow', careful: 'ask', strict: 'ask' },
  'calendar.write':    { open: 'ask', careful: 'ask', strict: 'ask' },
  'module.toggle':     { open: 'ask', careful: 'ask', strict: 'ask' },
  'install':           { open: 'ask', careful: 'ask', strict: 'ask' },
  'login':             { open: 'ask', careful: 'ask', strict: 'ask' },
  'custom':            { open: 'ask', careful: 'ask', strict: 'ask' },
  'send.person':       { open: 'ask', careful: 'ask', strict: 'ask' },
  'spend':             { open: 'limit', careful: 'ask', strict: 'ask' },
};
const TIMEOUT_MS = 24 * 3600 * 1000;
// Exact field names only (a field called shipping_note must never be hidden because it contains "pin").
const SECRET_KEY = /^(password|passwd|passphrase|otp|cvv|cvc|card_?number|pin|pin_?code|secret|token|access_?token|api_?key|authorization)$/i;
// For these actions the owner approves content, so nothing in the payload is ever hidden from the card.
const SHOW_ALL = new Set(['send.person', 'shell.run', 'net.post', 'spend', 'file.write', 'file.delete', 'browser.act', 'calendar.write', 'install', 'custom']);
const MAX_PAYLOAD = 256 * 1024;

const ONCE_TTL_MS = 15 * 60 * 1000;   // an "ask once" grant never outlives this, even if nobody ended its scope

export class ApprovalDoor {
  constructor({ storage, settings, panic, events, log = () => {} }) {
    this.s = storage; this.settings = settings; this.panic = panic; this.events = events; this.log = log;
    this.pending = new Map();     // id -> { resolve, timer }
    this.once = new Map();        // "action|agent|scope" -> when it was granted; ends with the job or chat turn, or after ONCE_TTL_MS
    this.visited = new Set();     // hostnames the browser already opened (Careful)
    this.granted = new Map();     // id -> { action, usedAt }
    this.spendModuleOn = () => false;
    this.stoppedByPanic = 0;      // waiting approvals Panic cancelled since the last Resume
    panic.onChange((st) => {
      if (st.halted) { this.cancelAll('halted'); return; }
      const n = this.stoppedByPanic; this.stoppedByPanic = 0;
      if (n) this.events.emit('toast', { text: `Panic cancelled ${n === 1 ? '1 request that was' : n + ' requests that were'} waiting for you. They are listed under Stopped by Panic in Settings › Security.`, kind: '' });
    });
    // expire stale rows from a previous run
    this.s.run("UPDATE approvals SET status = 'timeout', decided = ? WHERE status = 'pending'", now());
  }
  get level() { const l = this.settings.get('security.level'); return LEVELS.includes(l) ? l : 'open'; }
  get autoApproveUntil() { const u = this.settings.get('security.autoApproveUntil'); return u && new Date(u).getTime() > Date.now() ? u : null; }
  state() { return { level: this.level, autoApproveUntil: this.autoApproveUntil, pending: this.listPending().length, limits: this.limits(), spentToday: this.spent('day'), spentMonth: this.spent('month') }; }

  // ---- only settings-routes.js holds the token
  setLevel(level, token) {
    if (token !== SETTINGS_TOKEN) throw Object.assign(new Error('The security level changes only in Settings.'), { code: 'forbidden' });
    if (!LEVELS.includes(level)) throw Object.assign(new Error('Unknown level'), { code: 'bad_level' });
    this.settings.set('security.level', level);
    this.once.clear();
    this.activity({ action: 'security.level', title: `Security level: ${level}`, how: 'owner' });
    this.events.emit('security', this.state());
    return this.state();
  }
  setAutoApprove(minutesOrToday, token) {
    if (token !== SETTINGS_TOKEN) throw Object.assign(new Error('Auto-approve changes only from the desk controls.'), { code: 'forbidden' });
    let until = null;
    if (minutesOrToday === 'today') { const d = new Date(); d.setHours(23, 59, 59, 999); until = d.toISOString(); }
    else if (Number(minutesOrToday) > 0) until = new Date(Date.now() + Number(minutesOrToday) * 60000).toISOString();
    this.settings.set('security.autoApproveUntil', until);
    this.activity({ action: 'security.autoApprove', title: until ? `Auto-approve until ${until}` : 'Auto-approve off', how: 'owner' });
    this.events.emit('security', this.state());
    return this.state();
  }

  limits() { return { perItem: this.settings.get('spend.perItem'), perDay: this.settings.get('spend.perDay'), perMonth: this.settings.get('spend.perMonth'), currency: this.settings.get('currency') }; }
  spent(period) {
    const since = new Date(); if (period === 'day') since.setHours(0, 0, 0, 0); else { since.setDate(1); since.setHours(0, 0, 0, 0); }
    const a = this.s.get("SELECT COALESCE(SUM(amount), 0) AS t FROM approvals WHERE action = 'spend' AND status = 'approved' AND decided >= ?", since.toISOString())?.t || 0;
    const c = this.s.get('SELECT COALESCE(SUM(cost_minor), 0) AS t FROM calls WHERE at >= ?', since.toISOString())?.t || 0;
    return a + c;
  }
  overLimit(amount) {
    const l = this.limits(); const a = Number(amount) || 0;
    if (a > l.perItem) return 'per item limit';
    if (this.spent('day') + a > l.perDay) return 'daily limit';
    if (this.spent('month') + a > l.perMonth) return 'monthly limit';
    return null;
  }

  /** Decide without asking when the policy allows; otherwise create a pending approval and wait for the owner. */
  async request(req) {
    const action = ACTIONS.includes(req?.action) ? req.action : 'custom';
    if (this.panic.halted) return { ok: false, reason: 'halted', id: null };
    if (req?.signal?.aborted) return { ok: false, reason: 'aborted', id: null };
    const level = this.level;
    const rule = POLICY[action][level];
    const scope = req.jobId || req.chatId || 'none';
    const onceKey = `${action}|${req.agentId || ''}|${scope}`;
    let decide = null;
    if (alwaysAsks(action, req)) decide = 'ask';
    else if (action === 'spend') {
      const amt = Number(req.amount);
      const cur = req.currency || this.settings.get('currency');
      const over = this.overLimit(req.amount);
      // an amount that is missing, not a number, zero or negative, or in another currency, cannot be checked against the limits: ask
      if (!Number.isFinite(amt) || amt <= 0) decide = 'ask:the amount is not stated';
      else if (cur !== this.settings.get('currency')) decide = 'ask:another currency';
      else if (over) decide = 'ask:' + over;
      else if (!this.spendModuleOn() && Number(req.amount) > 0) decide = 'ask:payments module is off';
      else decide = rule === 'limit' ? 'allow' : 'ask';
    } else if (rule === 'allow') decide = 'allow';
    else if (rule === 'once') { const at = this.once.get(onceKey); decide = at && Date.now() - at < ONCE_TTL_MS ? 'allow' : 'ask'; }
    else if (rule === 'visited') { const host = hostOf(req.payload?.url); decide = host && this.visited.has(host) ? 'allow' : 'ask'; }
    else if (rule === 'folder') { const f = String(req.payload?.folder || req.payload?.path || ''); decide = f && (this.settings.get('files.allowedFolders') || []).some(x => insideFolder(f, x)) ? 'allow' : 'ask'; }
    else decide = 'ask';

    // auto-approve window never covers send.person or spend over the limit
    if (decide === 'ask' && this.autoApproveUntil && !alwaysAsks(action, req) && action !== 'spend') decide = 'auto';
    if (decide === 'ask' && this.autoApproveUntil && action === 'spend' && Number.isFinite(Number(req.amount)) && Number(req.amount) > 0 && !this.overLimit(req.amount)) decide = 'auto';

    // The card must be able to show everything the grant covers. A payload too large to show is refused, never cut.
    let payloadSize = 0; try { payloadSize = JSON.stringify(req.payload ?? null).length; } catch { return { ok: false, reason: 'bad_payload', id: null }; }
    if (payloadSize > MAX_PAYLOAD) return { ok: false, reason: 'too_large', id: null };
    const row = { id: makeId('ap_'), agentId: req.agentId || null, chatId: req.chatId || null, jobId: req.jobId || null, action, title: String(req.title || action).slice(0, 300), detail: req.detail ? String(req.detail).slice(0, 1000) : null, payload: SHOW_ALL.has(action) ? (req.payload ?? null) : redact(req.payload), amount: req.amount != null ? Math.round(Number(req.amount)) : null, currency: req.currency || this.settings.get('currency') };
    if (decide === 'allow' || decide === 'auto') {
      const how = decide === 'allow' ? 'level' : 'auto';
      this.insert(row, 'approved', how);
      this.remember(action, onceKey, req);
      this.activity({ agentId: row.agentId, action, title: row.title, how, detail: row.detail });
      this.granted.set(row.id, { action, bind: bindHash(req.payload, req.amount) });
      return { ok: true, how, id: row.id };
    }
    // ask the owner
    this.insert(row, 'pending', null);
    const why = decide.startsWith('ask:') ? decide.slice(4) : null;
    this.events.emit('approval', { ...this.rowOut(row), status: 'pending', why });
    this.log('approval', 'asking', action, row.title);
    if (row.jobId) { try { this.onJobWait?.(row.jobId, row.title, true); } catch {} }   // the job shows that it waits on the owner
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(row.id, 'timeout', 'timeout'), TIMEOUT_MS);
      this.pending.set(row.id, { resolve, timer, row, req });
      // a signal that aborts because of Panic (a job's signal is a child of it) is recorded as stopped by Panic
      if (req.signal) req.signal.addEventListener('abort', () => { const why = this.panic.halted ? 'halted' : 'aborted'; this.decide(row.id, why, why); }, { once: true });
    });
    if (row.jobId) { try { this.onJobWait?.(row.jobId, row.title, false); } catch {} }
    return result;
  }
  /** The job or chat turn is over: its "ask once" grants end with it. Safe for modules to call: it can only make the door ask again. */
  endScope(scope) {
    const tail = '|' + String(scope || ''); if (tail === '|') return 0;
    let n = 0; for (const k of [...this.once.keys()]) if (k.endsWith(tail)) { this.once.delete(k); n++; }
    return n;
  }
  remember(action, onceKey, req) {
    if (ASK_ONCE[this.level]?.has(action)) this.once.set(onceKey, Date.now());
    if (action === 'browser.open') { const h = hostOf(req.payload?.url); if (h) this.visited.add(h); }
    if (action === 'file.read.outside' && req.payload?.folder) { const list = this.settings.get('files.allowedFolders') || []; if (!list.includes(req.payload.folder)) this.settings.set('files.allowedFolders', [...list, req.payload.folder]); }
  }
  insert(row, status, how) {
    this.s.run('INSERT INTO approvals (id, agent_id, chat_id, job_id, action, title, detail, payload, amount, currency, status, how, created, decided) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.agentId, row.chatId, row.jobId, row.action, row.title, row.detail, JSON.stringify(row.payload ?? null), row.amount, row.currency, status, how, now(), status === 'pending' ? null : now());
  }
  /** The owner's decision, from any screen. */
  decide(id, decision, how = 'owner') {
    const p = this.pending.get(id);
    const status = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : decision;   // timeout | aborted | halted
    this.s.run('UPDATE approvals SET status = ?, how = ?, decided = ? WHERE id = ? AND status = ?', status, how, now(), id, 'pending');
    const row = this.rowOut(this.s.get('SELECT * FROM approvals WHERE id = ?', id));
    if (!row) return null;
    this.activity({ agentId: row.agentId, action: row.action, title: row.title, how: status === 'approved' ? 'owner approve' : status === 'denied' ? 'owner deny' : status, detail: row.detail });
    this.events.emit('approval', row);
    if (p) {
      clearTimeout(p.timer); this.pending.delete(id);
      if (status === 'halted') this.stoppedByPanic++;
      if (status === 'approved') { this.remember(row.action, `${row.action}|${row.agentId || ''}|${row.jobId || row.chatId || 'none'}`, p.req); this.granted.set(id, { action: row.action, bind: bindHash(p.req.payload, p.req.amount) }); }
      p.resolve(status === 'approved' ? { ok: true, how: 'owner', id } : { ok: false, reason: status === 'denied' ? 'denied' : status, id });
    }
    return row;
  }
  cancelAll(reason) { for (const id of [...this.pending.keys()]) this.decide(id, reason, reason); }
  /**
   * Senders call this right before the send, with the id they were granted AND the exact payload they are about to
   * send. The grant is for that one item: a different recipient, subject, body, amount or any other field fails.
   * Single use.
   */
  assertGranted(id, action, payload) {
    const fail = (m) => { throw Object.assign(new Error(m), { code: 'not_granted' }); };
    const g = this.granted.get(id);
    if (!g || g.action !== action || g.usedAt) fail('No approval was granted for this send.');
    const row = this.s.get('SELECT status, amount FROM approvals WHERE id = ?', id);
    if (!row || row.status !== 'approved') fail('No approval was granted for this send.');
    if (payload === undefined) fail('The sender must show what it is sending: assertGranted(id, action, payload).');
    if (bindHash(payload, row.amount) !== g.bind) fail('This is not the item the owner approved.');
    g.usedAt = now();
    return true;
  }
  rowOut(r) {
    if (!r) return null;
    let payload = null; try { payload = r.payload ? JSON.parse(r.payload) : null; } catch {}
    return { id: r.id, agentId: r.agent_id ?? r.agentId ?? null, chatId: r.chat_id ?? r.chatId ?? null, jobId: r.job_id ?? r.jobId ?? null, action: r.action, title: r.title, detail: r.detail, payload: r.payload === undefined ? r.payload : payload, amount: r.amount, currency: r.currency, status: r.status, how: r.how, created: r.created, decided: r.decided };
  }
  listPending() { return this.s.all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created").map(r => this.rowOut(r)); }
  /** Approvals that were waiting when Panic was pressed and that the owner has not dismissed yet. Never decidable again. */
  listStopped(limit = 100) { return this.s.all("SELECT * FROM approvals WHERE status = 'halted' AND how = 'halted' ORDER BY decided DESC LIMIT ?", limit).map(r => this.rowOut(r)); }
  /** Take stopped-by-Panic items off that list (one id, or all). The row stays, status 'halted'; only the reminder goes. */
  dismissStopped(id) {
    const r = id === 'all' ? this.s.run("UPDATE approvals SET how = 'dismissed' WHERE status = 'halted' AND how = 'halted'")
      : this.s.run("UPDATE approvals SET how = 'dismissed' WHERE status = 'halted' AND how = 'halted' AND id = ?", String(id || ''));
    const n = Number(r?.changes || 0);
    if (n) { this.activity({ action: 'approval.dismiss', title: `Dismissed ${n} stopped by Panic`, how: 'dismissed' }); this.events.emit('approval', { id: id === 'all' ? null : String(id), status: 'halted', how: 'dismissed' }); }
    return n;
  }
  listRecent(limit = 50) { return this.s.all('SELECT * FROM approvals ORDER BY created DESC LIMIT ?', limit).map(r => this.rowOut(r)); }
  activity(a) { this.s.run('INSERT INTO activity (at, agent_id, action, title, how, detail) VALUES (?, ?, ?, ?, ?, ?)', now(), a.agentId || null, a.action, a.title || null, a.how || null, a.detail || null); }
  activityList(limit = 200) { return this.s.all('SELECT * FROM activity ORDER BY id DESC LIMIT ?', limit); }
  /** The object a module sees: request, assertGranted, read-only state. No setters. */
  forModule() {
    return Object.freeze({
      request: (r) => this.request(r), assertGranted: (id, a, payload) => this.assertGranted(id, a, payload),
      get level() { return undefined; }, // modules read the level through ctx.settings.get('security.level')
      state: () => this.state(), listPending: () => this.listPending(),   // read-only: only the owner's routes can decide
      endScope: (scope) => this.endScope(scope),   // a module ends its own turn's "ask once" grants; this never grants anything
      listStopped: () => this.listStopped(),        // read-only: what Panic cancelled
      // Takes a stopped-by-Panic reminder off the list; it cannot approve, resume or change anything else.
      // The Safety module calls it only from a route where owner is true.
      dismissStopped: (id) => this.dismissStopped(id),
      /** One approval by id (status pending | approved | denied | timeout | aborted | halted), or null. Read-only. */
      get: (id) => this.rowOut(this.s.get('SELECT * FROM approvals WHERE id = ?', String(id || ''))),
    });
  }
}

export function redact(payload) {
  if (!payload || typeof payload !== 'object') return payload ?? null;
  const out = Array.isArray(payload) ? [] : {};
  for (const [k, v] of Object.entries(payload)) {
    if (SECRET_KEY.test(k)) out[k] = '••••';
    else if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}
/** One stable fingerprint of what the owner was shown: every field of the payload, keys sorted, plus the amount. */
export function bindHash(payload, amount) {
  const norm = (v) => v && typeof v === 'object' ? (Array.isArray(v) ? v.map(norm) : Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])]))) : (v ?? null);
  return crypto.createHash('sha256').update(JSON.stringify([norm(payload ?? null), amount != null && Number.isFinite(Number(amount)) ? Math.round(Number(amount)) : null])).digest('hex');
}
/** Is path f inside the allowed folder a? Resolved first, so '..' cannot climb out; Windows paths compare without case. */
export function insideFolder(f, a) {
  const win = /^[a-zA-Z]:[\\/]|\\/.test(String(a)) || /^[a-zA-Z]:[\\/]/.test(String(f));
  const P = win ? path.win32 : path.posix;
  let x = P.resolve(String(f)), y = P.resolve(String(a));
  if (win) { x = x.toLowerCase(); y = y.toLowerCase(); }
  return x === y || x.startsWith(y.endsWith(P.sep) ? y : y + P.sep);
}
function hostOf(url) { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; } }
