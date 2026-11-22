// Keys for dedicated services that are not chat models: search (Serper, Tavily, Brave ...), page reading (Jina) and audio
// (ElevenLabs ...). One store so the owner sees every key in one place and modules read them one way: ctx.serviceKey(id).
// Several labelled keys per service, like model providers: get() hands out the first key that is on and not resting after
// a refusal or an empty allowance, so the next key is used. The old single key slot (set/toggle/remove by service) stays
// for the cards that still use it; it replaces only its own key ('svc_<id>'), never the labelled ones. That slot key is listed
// and handed out first: "Replace the key" in Settings must change the key in use, not add a spare behind an older one.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { now, id as newId } from './storage.js';
const CATALOG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'services.json'), 'utf8'));
const mask = (v) => !v ? '' : v.length <= 8 ? '••••' : v.slice(0, 4) + '••••' + v.slice(-4);
// how long a key rests before it is handed out again: a refused key a day (until a Test passes), an empty allowance an hour
const REST_MS = { refused: 24 * 3600e3, allowance: 3600e3 };
const TEST_MS = 15000;
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const resting = (meta, t = Date.now()) => meta.rest && new Date(meta.rest.until).getTime() > t ? meta.rest : null;
const unknown = () => Object.assign(new Error('Unknown service'), { status: 404 });

export class ServiceKeys {
  constructor({ storage, events, env = process.env }) { this.s = storage; this.events = events; this.env = {}; this.loadEnv(env); }
  loadEnv(env) { this.env = {}; for (const [id, s] of Object.entries(CATALOG.services)) if (env[s.env]) this.env[id] = env[s.env]; }
  catalog() { return CATALOG; }
  rows(id) { return this.s.all("SELECT id, label, value, enabled, created, meta FROM secrets WHERE kind = 'service-key' AND provider = ? ORDER BY id = 'svc_' || provider DESC, created, rowid", id); }
  row(keyId) { return this.s.get("SELECT id, provider, label, value, enabled, created, meta FROM secrets WHERE kind = 'service-key' AND id = ?", String(keyId || '')); }
  changed(id) { this.events?.emit('models', { change: 'service-key', id }); }
  /** The value, for server-side use by the owning module only. Null when the owner has not added one or switched it off. */
  get(id) {
    const rows = this.rows(id);
    if (!rows.length) return this.env[id] || null;
    const on = rows.filter(r => r.enabled);
    // every key resting: an empty allowance may have refilled, a refused key will not, so the allowance one comes first
    const rank = (r) => { const w = resting(parse(r.meta))?.why; return !w ? 0 : w === 'allowance' ? 1 : 2; };
    return [...on].sort((a, b) => rank(a) - rank(b))[0]?.value ?? null;
  }
  has(id) { return !!this.get(id); }
  check(id, value) {
    if (!CATALOG.services[id]) throw unknown();
    if (!value || String(value).trim().length < 8) throw Object.assign(new Error('That key looks too short'), { status: 400 });
  }
  /** The single key slot (older cards): replaces its own key only. */
  set(id, value) {
    this.check(id, value);
    // a value saved already as a labelled key moves into the slot instead of being stored twice
    this.s.run("DELETE FROM secrets WHERE kind = 'service-key' AND provider = ? AND (id = ? OR value = ?)", id, 'svc_' + id, String(value).trim());
    this.s.run("INSERT INTO secrets (id, kind, provider, label, value, created, enabled, meta) VALUES (?, 'service-key', ?, ?, ?, ?, 1, '{}')", 'svc_' + id, id, CATALOG.services[id].name, String(value).trim(), now());
    this.changed(id);
  }
  /** One more labelled key. Returns its id and label, never the value. */
  add(id, value, label) {
    this.check(id, value);
    const v = String(value).trim();
    if (this.rows(id).some(r => r.value === v)) throw Object.assign(new Error('That key is saved already.'), { status: 400 });
    const k = { id: newId('svk_'), label: String(label || '').trim().slice(0, 60) || `Key ${this.rows(id).length + 1}` };
    this.s.run("INSERT INTO secrets (id, kind, provider, label, value, created, enabled, meta) VALUES (?, 'service-key', ?, ?, ?, ?, 1, '{}')", k.id, id, k.label, v, now());
    this.changed(id);
    return k;
  }
  toggle(id, on) { this.s.run("UPDATE secrets SET enabled = ? WHERE kind = 'service-key' AND provider = ?", on ? 1 : 0, id); this.changed(id); }
  remove(id) { this.s.run("DELETE FROM secrets WHERE kind = 'service-key' AND provider = ?", id); this.changed(id); }
  toggleKey(keyId, on) { const r = this.row(keyId); if (!r) throw gone(); this.s.run("UPDATE secrets SET enabled = ? WHERE id = ?", on ? 1 : 0, r.id); this.changed(r.provider); }
  removeKey(keyId) { const r = this.row(keyId); if (!r) throw gone(); this.s.run("DELETE FROM secrets WHERE id = ?", r.id); this.changed(r.provider); }
  meta(keyId, patch) { const r = this.row(keyId); if (!r) return; this.s.run('UPDATE secrets SET meta = ? WHERE id = ?', JSON.stringify({ ...parse(r.meta), ...patch }), r.id); }
  /** A module says the key it was given was refused or ran out: that key rests and the next one is used. */
  report(id, why = 'refused') {
    const v = this.get(id); const r = this.rows(id).find(x => x.value === v); if (!r) return false;
    this.meta(r.id, { rest: { why: why === 'allowance' ? 'allowance' : 'refused', until: new Date(Date.now() + REST_MS[why === 'allowance' ? 'allowance' : 'refused']).toISOString() } });
    this.changed(id); return true;
  }
  /** One small real call of that service with this one key. fetch is the caller's (the desk's guarded fetch: Offline, Panic). */
  async test(id, keyId, { fetch, timeoutMs = TEST_MS } = {}) {
    const def = CATALOG.services[id]; if (!def) throw unknown();
    const r = this.row(keyId); if (!r || r.provider !== id) throw gone();
    const t = def.test; const t0 = Date.now(); const at = now();
    let out;
    try {
      const res = await fetch(t.url, { method: t.method || 'GET', headers: { ...(t.headers || {}), ...(t.body ? { 'content-type': 'application/json' } : {}), [def.header]: (def.prefix || '') + r.value }, body: t.body ? JSON.stringify(t.body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
      try { await res.arrayBuffer(); } catch {}
      const ms = Date.now() - t0;
      if (res.ok) out = { ok: true, ms, at };
      else if (res.status === 401 || res.status === 403) out = { ok: false, ms, at, why: 'refused', error: `${short(def)} refused the key (not valid or not allowed).` };
      else if (res.status === 402 || res.status === 429 || res.status === 432) out = { ok: false, ms, at, why: 'allowance', error: `${short(def)} says the allowance is used up or there were too many requests. The next key is used meanwhile.` };
      else out = { ok: false, ms, at, error: res.status >= 500 ? `${short(def)} had a problem on its side (HTTP ${res.status}). Try again later.` : `${short(def)} answered HTTP ${res.status}.` };
    } catch (e) {
      const ms = Date.now() - t0;
      if (e.code === 'offline') out = { ok: false, skipped: true, ms, at, error: 'Not tested: the desk is offline. It is tested when you press Test online.' };
      else if (e.code === 'halted') out = { ok: false, skipped: true, ms, at, error: 'Not tested: everything is stopped. Press Resume, then Test.' };
      else if (e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message)) out = { ok: false, ms, at, error: `No answer from ${short(def)} within ${Math.round(timeoutMs / 1000)} seconds.` };
      else out = { ok: false, ms, at, error: `Could not reach ${short(def)} just now.` };
    }
    const { why, ...test } = out;
    // a refusal or an empty allowance rests the key; a pass brings it back; a skipped test changes nothing about the key
    this.meta(r.id, out.skipped ? { test } : { test, rest: why ? { why, until: new Date(Date.now() + REST_MS[why]).toISOString() } : null });
    this.changed(id);
    return { ...test, label: r.label, service: id };
  }
  /** One service's keys for the screen: label, when added, on or off, last test, resting. Never a value. */
  keys(id) {
    return this.rows(id).map(r => { const m = parse(r.meta); const rest = resting(m); return { id: r.id, label: r.label, created: r.created, enabled: !!r.enabled, key: mask(r.value), test: m.test || null, resting: rest ? rest.why : null }; });
  }
  /** For the screen: every service with whether a key is in place. Values are masked. */
  list() {
    return Object.entries(CATALOG.services).map(([id, s]) => {
      const keys = this.keys(id); const first = keys[0];
      const fromEnv = !keys.length && !!this.env[id];
      return { id, kind: s.kind, name: s.name, built: s.built !== false, signup: s.signup, free: s.free, spends: s.test?.spends || null, hasKey: !!keys.length || fromEnv, enabled: keys.length ? keys.some(k => k.enabled) : fromEnv, fromEnvironment: fromEnv, key: first ? first.key : fromEnv ? mask(this.env[id]) : null, created: first?.created || null, keys };
    });
  }
  /** What a module that manages keys may do: never read a value. fetch is that module's guarded fetch. */
  forModule({ fetch }) {
    return { list: () => this.list(), keys: (id) => this.keys(id), add: (id, v, l) => this.add(id, v, l), removeKey: (k) => this.removeKey(k), toggleKey: (k, on) => this.toggleKey(k, on), test: (id, k) => this.test(id, k, { fetch }), report: (id, why) => this.report(id, why) };
  }
}
const gone = () => Object.assign(new Error('That key is gone.'), { status: 404 });
const short = (def) => def.name.replace(/\s*\(.*\)$/, '');
