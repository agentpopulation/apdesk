// Background jobs: started by modules, kept in storage, keep running when the browser closes, stopped by Panic.
import { id as makeId, now } from './storage.js';

export class Jobs {
  constructor({ storage, panic, events, log = () => {} }) {
    this.s = storage; this.panic = panic; this.events = events; this.log = log;
    this.running = new Map();   // id -> { ac, promise }
    this.cardSink = null;       // set by the chat module: (chatId, card, jobId) => void
    // anything that was running when the server last stopped is interrupted, never silently resumed
    this.s.run("UPDATE jobs SET status = 'interrupted', updated = ?, finished = ? WHERE status IN ('running', 'waiting')", now(), now());
    panic.onStop(() => this.stopAll('Panic'));
  }
  row(r) {
    if (!r) return null;
    const j = (x) => { try { return x ? JSON.parse(x) : null; } catch { return null; } };
    const input = j(r.input);
    return { id: r.id, kind: r.kind, title: r.title, quiet: input?.quiet === true, agentId: r.agent_id, chatId: r.chat_id, status: r.status, progress: r.progress, detail: r.detail, input, output: j(r.output), error: r.error, created: r.created, updated: r.updated, finished: r.finished };
  }
  list({ status, limit = 100 } = {}) {
    const rows = status ? this.s.all('SELECT * FROM jobs WHERE status = ? ORDER BY created DESC LIMIT ?', status, limit) : this.s.all('SELECT * FROM jobs ORDER BY created DESC LIMIT ?', limit);
    return rows.map(r => this.row(r));
  }
  get(id) { return this.row(this.s.get('SELECT * FROM jobs WHERE id = ?', id)); }
  update(id, patch) {
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v && typeof v === 'object' ? JSON.stringify(v) : v); }
    sets.push('updated = ?'); vals.push(now());
    this.s.run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    const job = this.get(id);
    this.events.emit('job', job);
    return job;
  }
  /** Start a job now. Returns the stored job at once; the work continues in the background.
   *  quiet: the desk started it for its own upkeep, not the owner. It is kept in the input record (no new column) and read back as job.quiet;
   *  the shell, Home and the brief leave a quiet job out unless it failed. */
  async start({ kind, title, agentId = null, chatId = null, input = null, quiet = false, run }) {
    if (this.panic.halted) throw Object.assign(new Error('Everything is stopped. Press Resume first.'), { code: 'halted' });
    if (typeof run !== 'function') throw new Error('jobs.start needs run()');
    if (quiet) input = { ...(input && typeof input === 'object' ? input : {}), quiet: true };
    const id = makeId('job_'); const t = now();
    this.s.run('INSERT INTO jobs (id, kind, title, agent_id, chat_id, status, progress, detail, input, created, updated) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)', id, kind, title, agentId, chatId, 'running', 'Starting', JSON.stringify(input), t, t);
    const ac = new AbortController();
    const signal = this.panic.child(ac.signal);
    const self = this;
    const handle = {
      id, kind, title, agentId, chatId, input, signal,
      progress(p, detail) { if (signal.aborted) return; self.update(id, { progress: Math.max(0, Math.min(1, Number(p) || 0)), detail: detail ?? null }); },
      waiting(detail) { self.update(id, { status: 'waiting', detail: detail ?? 'Waiting for you' }); },
      resumed(detail) { self.update(id, { status: 'running', detail: detail ?? 'Running' }); },
      card(card) { if (chatId && self.cardSink) { try { self.cardSink(chatId, { ...card, jobId: id, agentId }, id); } catch (e) { self.log('card failed', e.message); } } },
      throwIfStopped() { if (signal.aborted) throw Object.assign(new Error('Stopped'), { code: 'aborted' }); },
    };
    const promise = (async () => {
      try {
        const output = await run(handle);
        if (signal.aborted) { this.update(id, { status: 'stopped', detail: 'Stopped', finished: now() }); return; }
        this.update(id, { status: 'done', progress: 1, detail: 'Done', output: output ?? null, finished: now() });
      } catch (e) {
        if (signal.aborted || e?.code === 'aborted' || e?.code === 'halted' || e?.name === 'AbortError') this.update(id, { status: 'stopped', detail: 'Stopped', finished: now() });
        else { this.log('job failed', kind, e?.message); this.update(id, { status: 'failed', error: String(e?.message || e), detail: 'Failed', finished: now() }); }
      } finally { this.running.delete(id); try { this.onEnd?.(id); } catch {} }
    })();
    this.running.set(id, { ac, promise });
    this.events.emit('job', this.get(id));
    return this.get(id);
  }
  stop(id, reason = 'Stopped by owner') {
    const r = this.running.get(id);
    if (r) r.ac.abort(reason);
    const j = this.get(id);
    if (j && (j.status === 'running' || j.status === 'waiting')) this.update(id, { status: 'stopped', detail: reason, finished: now() });
    return this.get(id);
  }
  stopAll(reason) { const ids = [...this.running.keys()]; for (const id of ids) this.stop(id, reason); return ids.length; }
  /** Wait for a job to finish (tests, acceptance runner). */
  async wait(id, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const j = this.get(id);
      if (!j || !['running', 'waiting'].includes(j.status)) return j;
      const r = this.running.get(id);
      if (r) await Promise.race([r.promise, new Promise(res => setTimeout(res, 250))]); else await new Promise(res => setTimeout(res, 100));
    }
    return this.get(id);
  }
  summary() {
    const c = (st) => this.s.get('SELECT COUNT(*) AS c FROM jobs WHERE status = ?', st).c;
    return { running: c('running'), waiting: c('waiting'), done: c('done'), failed: c('failed'), stopped: c('stopped'), interrupted: c('interrupted') };
  }
  forModule() { return Object.freeze({ start: (o) => this.start(o), list: (o) => this.list(o), get: (id) => this.get(id), stop: (id) => this.stop(id), wait: (id, t) => this.wait(id, t), summary: () => this.summary() }); }
}
