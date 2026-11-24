// Downloads: one small core service for large files the desk fetches for itself (the local engine and its model now;
// signed updates and Ollama pulls later). Every download is an `install` action through the approval door, goes
// through the desk's guarded fetch (Offline refuses it), follows redirects only to the hosts named for it, stops when
// it grows past its stated size, and is checked against its SHA-256 before anyone may use it. A file that does not
// match is deleted. State lives in the database (core kv, which no module can write), so a download survives a restart.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { id as makeId, now } from './storage.js';
import { insideFolder } from './approval-door.js';
import { failureKind } from './model-door.js';

const NS = 'core.downloads';
const MAX_ACTIVE = 2;
const KEEP_FINISHED = 20;
const MAX_REDIRECTS = 5;
const LOOP = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** States: waiting (for the owner's approval), queued, running, paused, done, failed, cancelled. */
const OPEN = new Set(['waiting', 'queued', 'running', 'paused']);
/** The one standing yes: the owner's "Download updates in the background" switch (owner-only route), for desk updates.
 *  It is recorded on the download in place of an approval id. No other name, kind or caller can skip the question. */
const STANDING = Object.freeze({ 'update.background': Object.freeze({ kind: 'desk-update', setting: 'update.background', marker: 'owner switch: update.background' }) });
const STANDING_MARKERS = new Set(Object.values(STANDING).map(x => x.marker));

/** 1.2 GB, 954 MB: the same rounding the screen uses (app/ui/kit.js fmt.bytes). */
export function sizeText(n) { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }

/** Is this host one of the allowed ones? An entry starting with a dot allows that domain's subdomains (".hf.co"). */
export function hostAllowed(host, allow) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (allow || []).some(a => { a = String(a).toLowerCase(); return a.startsWith('.') ? h.endsWith(a) && h.length > a.length : h === a.replace(/^\[|\]$/g, ''); });
}

export class Downloads {
  /** roots: folders a download may be saved in (the desk's data folder). fetchImpl is read at call time, so the
   *  Offline guard installed on globalThis.fetch applies. */
  constructor({ storage, settings, panic, events, approval, roots, log = () => {}, fetchImpl = null, maxActive = MAX_ACTIVE }) {
    this.s = storage; this.settings = settings; this.panic = panic; this.events = events; this.approval = approval; this.log = log;
    this.roots = (roots || [storage.dataDir]).map(r => path.resolve(r));
    this.fetchImpl = fetchImpl; this.maxActive = maxActive;
    this.live = new Map();      // id -> { ac, speed: [{ t, n }] } for the transfers running in this process
    this.blocks = new Map();    // kind -> reason: downloads of this kind may not run (the local engine is switched off)
    this.waiters = new Map();   // id -> [resolve]
    this.lastEmit = new Map();
    // After a restart: a transfer that was running is queued again (its half file is resumed or restarted cleanly);
    // an approval that was still waiting ended with the old process, so the owner is asked again when he resumes it.
    for (const d of this.all()) {
      if (d.state === 'running') this.put({ ...d, state: 'queued', reason: null });
      if (d.state === 'waiting') this.put({ ...d, state: 'paused', pausedBy: 'restart', approvalId: null, reason: 'The desk restarted while this waited for your approval. Press Resume to be asked again.' });
    }
    this.offPanic = panic.onStop((reason) => this.onPanic(reason));
    this.offPanicChange = panic.onChange?.((st) => { if (!st.halted) this.pump(); });
    this.offOnline = settings.onChange?.((k, v) => { if (k === 'online') this.onOnline(v !== false); });
    setImmediate(() => this.pump());
  }

  // ---------- storage
  all() { return Object.values(this.s.kvAll(NS)).filter(d => d && d.id).sort((a, b) => String(a.created).localeCompare(String(b.created))); }
  get(id) { const d = this.s.kvGet(NS, String(id || ''), null); return d && d.id ? d : null; }
  put(d) { d = { ...d, updated: now() }; this.s.kvSet(NS, d.id, d); return d; }
  patch(id, p) { const d = this.get(id); if (!d) return null; const n = this.put({ ...d, ...p }); this.emit(n, true); return n; }
  prune() {
    const fin = this.all().filter(d => !OPEN.has(d.state)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    for (const d of fin.slice(KEEP_FINISHED)) this.s.kvDel(NS, d.id);
  }

  // ---------- what the screen sees
  out(d) {
    if (!d) return null;
    const l = this.live.get(d.id);
    const speed = l ? rate(l.speed) : 0;
    const left = speed > 0 && d.total ? Math.max(0, Math.round((d.total - d.done) / speed)) : null;
    return { id: d.id, kind: d.kind, title: d.title, state: d.state, reason: d.reason || null, done: d.done || 0, total: d.total || d.size || 0,
      doneText: sizeText(d.done || 0), totalText: sizeText(d.total || d.size || 0), speed: Math.round(speed), speedText: speed ? sizeText(speed) + '/s' : null,
      secondsLeft: left, host: hostOf(d.url), created: d.created, updated: d.updated, finished: d.finished || null };
  }
  /** active: moving or about to move (running, queued). total: every download not finished (adds waiting and paused). */
  summary() {
    const open = this.all().filter(d => OPEN.has(d.state));
    const n = (st) => open.filter(d => d.state === st).length;
    // stuck: paused because something went wrong (not by the owner, Panic or Offline): the top bar can say so
    return { active: n('running') + n('queued'), total: open.length, running: n('running'), queued: n('queued'), waiting: n('waiting'), paused: n('paused'), stuck: open.filter(d => d.state === 'paused' && d.pausedBy === 'error').length };
  }
  list() { return { downloads: this.all().reverse().map(d => this.out(d)), summary: this.summary() }; }
  emit(d, force = false) {
    const t = Date.now();
    if (!force && t - (this.lastEmit.get(d.id) || 0) < 700) return;
    this.lastEmit.set(d.id, t);
    try { this.events.emit('downloads', { download: this.out(d), summary: this.summary() }); } catch {}
  }

  // ---------- starting
  /**
   * start({ id?, title, url, allowHosts, size, sha256, to, kind, approval? }) -> the stored download, at once.
   * The owner is asked (action install) with a title that says what and how big; the transfer starts when he says yes.
   * approval: { agentId, chatId } passed to the door. Refused while Panic holds, and for a kind that is blocked.
   * standingYes: 'update.background' only, for kind 'desk-update', only while that owner-only switch is on: the
   * download is queued without a card, the switch is recorded in place of an approval, and the activity log says so.
   */
  async start(spec, { agentId = null, chatId = null, standingYes = null } = {}) {
    if (this.panic.halted) throw Object.assign(new Error('Everything is stopped. Press Resume first.'), { code: 'halted', status: 503 });
    const d = this.check(spec);
    const yes = standingYes == null ? null : this.standing(standingYes, d.kind);
    const block = this.blocks.get(d.kind); if (block) throw Object.assign(new Error(block), { code: 'blocked', status: 409 });
    const same = this.all().find(x => OPEN.has(x.state) && x.to === d.to);
    if (same) return this.out(same);                                  // one download per file
    if (yes) {
      const rec = this.put({ ...d, id: d.id || makeId('dl_'), state: 'queued', done: 0, total: d.size, created: now(), reason: null, approvalId: yes.marker, agentId: null, chatId: null });
      try { this.approval.activity?.({ action: 'update.download', title: `Downloading ${d.title} in the background`, how: 'owner switch', detail: 'Download updates in the background is on. Installing still asks you.' }); } catch {}
      this.emit(rec, true); this.pump();
      return this.out(rec);
    }
    const rec = this.put({ ...d, id: d.id || makeId('dl_'), state: 'waiting', done: 0, total: d.size, created: now(), reason: 'Waiting for your approval', approvalId: null, agentId, chatId });
    this.emit(rec, true);
    this.ask(rec.id);
    return this.out(rec);
  }
  /** The standing yes named, if it holds right now for this kind; otherwise refused. */
  standing(name, kind) {
    const y = typeof name === 'string' && Object.hasOwn(STANDING, name) ? STANDING[name] : null;
    if (!y || kind !== y.kind || this.settings.get(y.setting) !== true) throw Object.assign(new Error('This download needs your approval.'), { code: 'forbidden', status: 403 });
    return y;
  }
  /** A download that holds a standing yes whose switch is now off goes back to asking. */
  stillAllowed(d) {
    if (!STANDING_MARKERS.has(d.approvalId)) return !!d.approvalId;
    const y = Object.values(STANDING).find(x => x.marker === d.approvalId);
    return d.kind === y.kind && this.settings.get(y.setting) === true;
  }
  check(spec) {
    const fail = (m) => { throw Object.assign(new Error(m), { status: 400, code: 'bad_download' }); };
    const title = String(spec?.title || '').trim(); if (!title) fail('A download needs a title that says what it is.');
    let u; try { u = new URL(String(spec.url)); } catch { fail('That is not a web address.'); }
    const allowHosts = Array.isArray(spec.allowHosts) ? spec.allowHosts.map(String) : [];
    if (!hostAllowed(u.hostname, allowHosts)) fail('The address is not on the list of hosts allowed for this download.');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOP.has(u.hostname))) fail('Downloads use https.');
    const size = Number(spec.size); if (!Number.isSafeInteger(size) || size <= 0) fail('A download needs its exact size in bytes.');
    const sha256 = String(spec.sha256 || '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(sha256)) fail('A download needs its SHA-256.');
    const to = path.resolve(String(spec.to || ''));
    if (!this.roots.some(r => insideFolder(to, r) && to !== r)) fail('A download is saved only inside the desk\'s own folder.');
    return { id: spec.id ? String(spec.id).replace(/[^\w.-]/g, '').slice(0, 60) || null : null, title: title.slice(0, 200), url: u.href, allowHosts, size, sha256, to, kind: String(spec.kind || 'file').replace(/[^\w.-]/g, '').slice(0, 40) || 'file' };
  }
  async ask(id) {
    const d = this.get(id); if (!d) return;
    const r = await this.approval.request({ action: 'install', agentId: d.agentId || null, chatId: d.chatId || null,
      title: `${d.title} (${sizeText(d.size)})`.slice(0, 300), from: hostOf(d.url), detail: `From ${hostOf(d.url)}. The desk checks the file is the one published before it is used.`,
      // plain words: the exact size and the SHA-256 are checked by the desk, not read by the owner. The address is kept in
      // the download's own record and fetched from there; what a screen is given names the host only (the detail line)
      payload: { file: path.basename(d.to), size: sizeText(d.size) } });
    const cur = this.get(id); if (!cur || cur.state !== 'waiting') return;      // cancelled meanwhile
    if (r.ok) { this.patch(id, { state: 'queued', approvalId: r.id, reason: null }); this.pump(); return; }
    if (r.reason === 'halted') this.patch(id, { state: 'paused', pausedBy: 'panic', reason: 'Panic stopped this before you allowed it. Press Resume to be asked again.' });
    else this.finish(id, 'cancelled', r.reason === 'denied' ? 'You said no to this download.' : 'Not allowed, so not downloaded.');
  }

  // ---------- the owner's buttons
  pause(id, reason = 'Paused by you.') {
    const d = this.get(id); if (!d) throw notFound();
    if (!['queued', 'running', 'waiting'].includes(d.state)) return this.out(d);
    this.live.get(id)?.ac.abort('paused');
    return this.out(this.patch(id, { state: 'paused', pausedBy: 'owner', reason }));
  }
  resume(id) {
    const d = this.get(id); if (!d) throw notFound();
    if (this.panic.halted) throw Object.assign(new Error('Everything is stopped. Press Resume first.'), { code: 'halted', status: 503 });
    if (d.state !== 'paused' && d.state !== 'failed') return this.out(d);
    const block = this.blocks.get(d.kind); if (block) throw Object.assign(new Error(block), { code: 'blocked', status: 409 });
    if (this.settings.get('online') === false) throw Object.assign(new Error('The desk is offline. Go online to download.'), { code: 'offline', status: 409 });
    if (!this.stillAllowed(d)) { const n = this.patch(id, { state: 'waiting', pausedBy: null, approvalId: null, reason: 'Waiting for your approval' }); this.ask(id); return this.out(n); }
    const n = this.patch(id, { state: 'queued', pausedBy: null, reason: null, finished: null });
    this.pump();
    return this.out(n);
  }
  cancel(id) {
    const d = this.get(id); if (!d) throw notFound();
    if (!OPEN.has(d.state)) return this.out(d);
    this.live.get(id)?.ac.abort('cancelled');
    if (d.state === 'waiting' && d.approvalId == null) { /* the door's card stays; when it is answered, ask() sees the download is gone */ }
    rmQuiet(d.to + '.part');
    return this.out(this.finish(id, 'cancelled', 'Cancelled.'));
  }
  /** Stop every download of a kind and keep them from running until unblocked (null). */
  block(kind, reason) {
    if (!reason) { this.blocks.delete(kind); return; }
    this.blocks.set(kind, reason);
    for (const d of this.all()) if (d.kind === kind && ['queued', 'running'].includes(d.state)) { this.live.get(d.id)?.ac.abort('blocked'); this.patch(d.id, { state: 'paused', pausedBy: 'blocked', reason }); }
  }
  /** Forget a finished or cancelled download (its file stays where it is). */
  forget(id) { const d = this.get(id); if (d && !OPEN.has(d.state)) this.s.kvDel(NS, d.id); }
  /** Resolves with the download once it is done, failed or cancelled. */
  whenDone(id) {
    const d = this.get(id); if (!d) return Promise.resolve(null);
    if (!OPEN.has(d.state)) return Promise.resolve(this.out(d));
    return new Promise((res) => { const l = this.waiters.get(id) || []; l.push(res); this.waiters.set(id, l); });
  }

  // ---------- Panic and Offline
  onPanic(reason) {
    const shutdown = /shutting down/i.test(String(reason || ''));
    if (shutdown) this.closed = true;
    for (const d of this.all()) {
      if (d.state === 'running') this.live.get(d.id)?.ac.abort(shutdown ? 'shutdown' : 'panic');
      if (shutdown) { if (d.state === 'running') this.put({ ...d, state: 'queued' }); continue; }   // picked up again at the next start
      if (['running', 'queued', 'waiting'].includes(d.state)) this.patch(d.id, { state: 'paused', pausedBy: 'panic', ...(d.state === 'waiting' ? { approvalId: null } : {}), reason: 'Stopped by Panic. It stays paused until you press Resume on it.' });
    }
  }
  onOnline(online) {
    for (const d of this.all()) {
      if (!online && ['running', 'queued'].includes(d.state)) { this.live.get(d.id)?.ac.abort('offline'); this.patch(d.id, { state: 'paused', pausedBy: 'offline', reason: 'Paused: the desk is offline. It goes on when the desk is online again.' }); }
      if (online && d.state === 'paused' && d.pausedBy === 'offline') this.patch(d.id, { state: 'queued', pausedBy: null, reason: null });
    }
    if (online) this.pump();
  }

  // ---------- the transfer
  pump() {
    if (this.panic.halted || this.closed) return;
    let running = this.all().filter(d => d.state === 'running' && this.live.has(d.id)).length;
    for (const d of this.all().filter(x => x.state === 'queued')) {
      if (running >= this.maxActive) break;
      if (this.blocks.has(d.kind)) { this.patch(d.id, { state: 'paused', pausedBy: 'blocked', reason: this.blocks.get(d.kind) }); continue; }
      if (this.settings.get('online') === false) { this.patch(d.id, { state: 'paused', pausedBy: 'offline', reason: 'Paused: the desk is offline. It goes on when the desk is online again.' }); continue; }
      running++;
      this.run(d.id);
    }
  }
  async run(id) {
    const ac = new AbortController();
    const signal = this.panic.child(ac.signal);
    const live = { ac, speed: [] }; this.live.set(id, live);
    let d = this.patch(id, { state: 'running', reason: null });
    const part = d.to + '.part';
    try {
      fs.mkdirSync(path.dirname(d.to), { recursive: true });
      let have = 0; try { have = fs.statSync(part).size; } catch {}
      if (have > d.size) { rmQuiet(part); have = 0; }
      const hash = crypto.createHash('sha256');
      if (have > 0) await hashFile(part, hash, have);                // the half file from before counts toward the checksum
      const res = await this.open(d, have, signal);
      let append = have > 0 && res.status === 206;
      if (append) {
        const m = /bytes\s+(\d+)-(\d+)?\/(\d+|\*)/i.exec(res.headers.get('content-range') || '');
        if (!m || Number(m[1]) !== have || (m[3] !== '*' && Number(m[3]) !== d.size)) { try { await res.body?.cancel(); } catch {} throw Object.assign(new Error('The host sent a part that does not fit what is already here.'), { code: 'bad_range' }); }
      }
      if (!append) have = 0;                                          // a full answer: start the file again cleanly
      const h = append ? hash : crypto.createHash('sha256');
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > 0 && have + len > d.size) { try { await res.body?.cancel(); } catch {} throw Object.assign(new Error(`The file is larger than stated (${sizeText(have + len)} instead of ${sizeText(d.size)}), so it was stopped and deleted.`), { code: 'too_large' }); }
      const out = fs.openSync(part, append ? 'a' : 'w');
      let done = have; let saved = 0;
      try {
        d = this.patch(id, { done, total: d.size });
        for await (const chunk of res.body) {
          if (signal.aborted) break;
          const b = Buffer.from(chunk);
          if (done + b.length > d.size) throw Object.assign(new Error(`The file grew past its stated size (${sizeText(d.size)}), so it was stopped and deleted.`), { code: 'too_large' });
          fs.writeSync(out, b); h.update(b); done += b.length;
          live.speed.push({ t: Date.now(), n: b.length }); if (live.speed.length > 400) live.speed.splice(0, 200);
          if (Date.now() - saved > 1000) { saved = Date.now(); const cur = { ...d, done }; this.s.kvSet(NS, id, { ...cur, updated: now() }); this.emit(cur, true); }
        }
      } finally { fs.closeSync(out); }
      if (signal.aborted) throw Object.assign(new Error('Stopped'), { code: 'aborted' });
      if (done !== d.size) throw Object.assign(new Error(`The download ended early (${sizeText(done)} of ${sizeText(d.size)}).`), { code: 'short' });
      const got = h.digest('hex');
      if (got !== d.sha256) throw Object.assign(new Error('The file did not match its SHA-256, so it was deleted and never used.'), { code: 'bad_checksum' });
      fs.renameSync(part, d.to);
      this.finish(id, 'done', null, { done });
      this.log('downloads', 'done', d.title);
    } catch (e) {
      const why = signal.aborted ? String(ac.signal.reason || (this.panic.halted ? 'panic' : 'aborted')) : null;
      if (why) { /* paused, cancelled, blocked, offline, panic or shutdown: the one who stopped it has set the state */ }
      else if (e.code === 'short' || e.code === 'bad_range' || /fetch failed|ECONNRESET|socket|terminated|other side closed/i.test(String(e.message) + String(e.cause?.code || ''))) {
        const cur = this.get(id);
        if (cur?.state === 'running') this.patch(id, { state: 'paused', pausedBy: 'error', reason: pausedWhy(e) });
        this.log('downloads', 'paused', d.title, e.message, e.cause?.code || '');
      } else {
        if (['too_large', 'bad_checksum', 'bad_host', 'http', 'not_https'].includes(e.code)) rmQuiet(part);
        if (e.code === 'offline') this.patch(id, { state: 'paused', pausedBy: 'offline', reason: 'Paused: the desk is offline. It goes on when the desk is online again.' });
        else this.finish(id, 'failed', plain(e));
        this.log('downloads', 'failed', d.title, e.message);
      }
    } finally {
      signal.release?.();   // the transfer is over: Panic lets go of it
      this.live.delete(id);
      if (this.get(id)?.state === 'cancelled') rmQuiet(part);
      setImmediate(() => this.pump());
    }
  }
  /** GET with redirects followed by hand, each hop checked against the allowed hosts. */
  async open(d, from, signal) {
    let url = d.url;
    const fetcher = this.fetchImpl || globalThis.fetch;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(url);
      if (!hostAllowed(u.hostname, d.allowHosts)) throw Object.assign(new Error(`The download was sent on to ${u.hostname}, which is not allowed for it, so it was refused.`), { code: 'bad_host' });
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOP.has(u.hostname))) throw Object.assign(new Error('The download was sent on to an address without https, so it was refused.'), { code: 'not_https' });
      const res = await fetcher(u.href, { redirect: 'manual', signal, headers: from > 0 ? { range: `bytes=${from}-` } : {} });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location'); try { await res.body?.cancel(); } catch {}
        if (!loc) throw Object.assign(new Error('The host sent the download on without saying where.'), { code: 'http' });
        url = new URL(loc, u).href; continue;
      }
      if (res.status === 416 && from > 0) { try { await res.body?.cancel(); } catch {} rmQuiet(d.to + '.part'); return this.open(d, 0, signal); }
      if (!res.ok) { try { await res.body?.cancel(); } catch {} throw Object.assign(new Error(`The host answered HTTP ${res.status}.`), { code: 'http' }); }
      return res;
    }
    throw Object.assign(new Error('Too many redirects.'), { code: 'http' });
  }
  finish(id, state, reason, extra = {}) {
    const n = this.patch(id, { state, reason, finished: now(), ...extra });
    const w = this.waiters.get(id) || []; this.waiters.delete(id);
    for (const res of w) { try { res(this.out(n)); } catch {} }
    this.prune();
    return n;
  }
  close() { this.closed = true; this.offPanic?.(); this.offPanicChange?.(); this.offOnline?.(); for (const l of this.live.values()) l.ac.abort('shutdown'); }

  /** What a module would get through its context (proposed for MODULES.md; not wired in yet): its own downloads only,
   *  saved only under <data>/downloads/<module id>/. */
  forModule(moduleId) {
    const mine = (d) => d && d.kind === 'm.' + moduleId;
    const dir = path.join(this.roots[0], 'downloads', moduleId);
    return Object.freeze({
      start: (spec, who) => {
        if (who?.standingYes != null) return Promise.reject(Object.assign(new Error('A module\'s download always asks the owner.'), { code: 'forbidden', status: 403 }));
        return this.start({ ...spec, kind: 'm.' + moduleId, to: path.join(dir, path.basename(String(spec?.file || spec?.to || 'file'))) }, { agentId: who?.agentId ?? null, chatId: who?.chatId ?? null });
      },
      get: (id) => { const d = this.get(id); return mine(d) ? this.out(d) : null; },
      list: () => this.all().filter(mine).map(d => this.out(d)),
      cancel: (id) => { const d = this.get(id); return mine(d) ? this.cancel(id) : null; },
      whenDone: (id) => { const d = this.get(id); return mine(d) ? this.whenDone(id) : Promise.resolve(null); },
      path: (id) => { const d = this.get(id); return mine(d) && d.state === 'done' ? d.to : null; },
    });
  }
}

function rate(samples) { const t = Date.now(); const recent = samples.filter(s => t - s.t < 5000); if (!recent.length) return 0; const span = Math.max(1, t - recent[0].t) / 1000; return recent.reduce((a, s) => a + s.n, 0) / span; }
function hostOf(u) { try { return new URL(u).hostname; } catch { return null; } }
function rmQuiet(f) { try { fs.rmSync(f, { force: true }); } catch {} }
function notFound() { return Object.assign(new Error('No such download.'), { status: 404 }); }
/** Why a download stopped part way, and what to do next: the real reason (not online, no answer, a broken connection). */
function pausedWhy(e) {
  const k = failureKind(e);
  if (k === 'not_online') return 'This PC is not online. Press Resume when it is back; the download goes on from where it stopped.';
  if (k === 'timeout') return 'The host stopped answering. Press Resume to try again from where it stopped.';
  if (k === 'broke') return 'The connection broke. Press Resume to go on from where it stopped.';
  if (k === 'no_answer' || /fetch failed/i.test(String(e?.message))) return 'The host could not be reached. Check the internet connection, then press Resume.';
  return plain(e) + ' Press Resume to go on.';
}
function plain(e) { const m = String(e?.message || e); if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(m + String(e?.cause?.code || ''))) return 'The host could not be reached.'; if (/ECONNRESET|terminated|other side closed|socket/i.test(m + String(e?.cause?.code || ''))) return 'The connection broke.'; return m.slice(0, 220); }
async function hashFile(file, hash, upTo) {
  await new Promise((res, rej) => { const s = fs.createReadStream(file, { start: 0, end: upTo - 1 }); s.on('data', (c) => hash.update(c)); s.on('end', res); s.on('error', rej); });
}
