// Contract 3, Panic: one call stops everything. Every job, model call, fetch, browser and child process hangs off
// panic.signal or registers an onStop hook. While halted, the doors refuse new work.
export class Panic {
  constructor() { this.halted = false; this.reason = null; this.at = null; this._ac = new AbortController(); this._hooks = new Set(); this._listeners = new Set(); }
  get signal() { return this._ac.signal; }
  /** A signal that aborts when Panic fires or when `parent` aborts. */
  child(parent) {
    const ac = new AbortController();
    const onAbort = (why) => () => { if (!ac.signal.aborted) ac.abort(why); };
    if (this.halted) ac.abort('halted');
    this._ac.signal.addEventListener('abort', onAbort('halted'), { once: true });
    if (parent) { if (parent.aborted) ac.abort(parent.reason || 'aborted'); else parent.addEventListener('abort', onAbort('aborted'), { once: true }); }
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
}
export class HaltedError extends Error { constructor() { super('Everything is stopped. Press Resume first.'); this.code = 'halted'; } }
