// Contract 3, Panic: one call stops everything. Every job, model call, fetch, browser and child process hangs off
// panic.signal or registers an onStop hook. While halted, the doors refuse new work.
export class Panic {
  constructor() { this.halted = false; this.reason = null; this.at = null; this._ac = new AbortController(); this._hooks = new Set(); this._listeners = new Set(); }
  get signal() { return this._ac.signal; }
  /** A signal that aborts when Panic fires or when `parent` aborts. */
  // A child's listeners are taken off the house signal and its parents as soon as any of them aborts, and by
  // signal.release() when the call ends without that, so a long-running desk does not keep one per finished call.
  // (AbortSignal.any is not used: in Node 22 it slows down with every signal it has made.)
  child(...parents) {
    const ac = new AbortController();
    parents = parents.filter(Boolean);
    const offs = [];
    const release = () => { for (const off of offs.splice(0)) off(); };
    Object.defineProperty(ac.signal, 'release', { value: release });
    if (this.halted) { ac.abort('halted'); return ac.signal; }
    const gone = parents.find(s => s.aborted); if (gone) { ac.abort(gone.reason || 'aborted'); return ac.signal; }
    const on = (sig, why) => { const fn = () => { release(); if (!ac.signal.aborted) ac.abort(why()); }; sig.addEventListener('abort', fn, { once: true }); offs.push(() => sig.removeEventListener('abort', fn)); };
    on(this._ac.signal, () => 'halted');
    for (const s of parents) on(s, () => s.reason || 'aborted');
    return ac.signal;
  }
  onStop(fn) { this._hooks.add(fn); return () => this._hooks.delete(fn); }
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  async stopAll(reason = 'Panic') {
    this.halted = true; this.reason = reason; this.at = new Date().toISOString();
    const ac = this._ac; this._ac = new AbortController();   // the next run gets a fresh signal after Resume
    ac.abort('halted');
    const results = [];
    for (const fn of this._hooks) { try { results.push(await Promise.race([fn(reason), new Promise(r => setTimeout(r, 3000))])); } catch (e) { results.push({ error: e.message }); } }
    for (const fn of this._listeners) { try { fn(this.state()); } catch {} }
    return results;
  }
  resume() { this.halted = false; this.reason = null; for (const fn of this._listeners) { try { fn(this.state()); } catch {} } }
  state() { return { halted: this.halted, reason: this.reason, at: this.at }; }
  /** The same Panic as seen from one space (contracts/PEOPLE.md): anyone's stop stops every space. The hooks and listeners
   *  a space adds run inside that space (run), and close() stops that space alone: it aborts every signal the space was
   *  handed (signal, child), runs the space's stop hooks and takes them all back. */
  scope(run = (fn) => fn()) {
    const p = this; const mine = new Set();
    const closed = new AbortController(); let seen = null;
    const add = (set, fn) => { const w = (x) => run(() => fn(x)); set.add(w); mine.add([set, w]); return () => { set.delete(w); for (const e of mine) if (e[1] === w) mine.delete(e); }; };
    return {
      get halted() { return p.halted; }, get reason() { return p.reason; }, get at() { return p.at; },
      get signal() { const s = p.signal; if (seen?.from !== s) seen = { from: s, signal: AbortSignal.any([s, closed.signal]) }; return seen.signal; },
      child: (parent) => p.child(parent, closed.signal), onStop: (fn) => add(p._hooks, fn), onChange: (fn) => add(p._listeners, fn),
      stopAll: (reason) => p.stopAll(reason), resume: () => p.resume(), state: () => p.state(),
      async close(reason = 'Shutting down') {
        const st = { halted: true, reason, at: new Date().toISOString() };
        closed.abort('closed');
        for (const [set, w] of [...mine]) if (set === p._hooks) { try { await Promise.race([w(reason), new Promise(r => setTimeout(r, 3000))]); } catch {} }
        for (const [set, w] of [...mine]) if (set === p._listeners) { try { w(st); } catch {} }
        for (const [set, w] of mine) set.delete(w); mine.clear();
      },
    };
  }
}
export class HaltedError extends Error { constructor() { super('Everything is stopped. Press Resume first.'); this.code = 'halted'; } }
