// Keys for dedicated services that are not chat models: search (Serper, Tavily, Brave ...) and audio (ElevenLabs ...).
// One store so the owner sees every key in one place and modules read them one way: ctx.serviceKey(id).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { now } from './storage.js';
const CATALOG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'services.json'), 'utf8'));
const mask = (v) => !v ? '' : v.length <= 8 ? '••••' : v.slice(0, 4) + '••••' + v.slice(-4);

export class ServiceKeys {
  constructor({ storage, events, env = process.env }) { this.s = storage; this.events = events; this.env = {}; this.loadEnv(env); }
  loadEnv(env) { this.env = {}; for (const [id, s] of Object.entries(CATALOG.services)) if (env[s.env]) this.env[id] = env[s.env]; }
  catalog() { return CATALOG; }
  /** The value, for server-side use by the owning module only. Null when the owner has not added one or switched it off. */
  get(id) {
    const r = this.s.get("SELECT value, enabled FROM secrets WHERE kind = 'service-key' AND provider = ?", id);
    if (r) return r.enabled ? r.value : null;
    return this.env[id] || null;
  }
  has(id) { return !!this.get(id); }
  set(id, value) {
    if (!CATALOG.services[id]) throw Object.assign(new Error('Unknown service'), { status: 404 });
    if (!value || String(value).trim().length < 8) throw Object.assign(new Error('That key looks too short'), { status: 400 });
    this.s.run("DELETE FROM secrets WHERE kind = 'service-key' AND provider = ?", id);
    this.s.run("INSERT INTO secrets (id, kind, provider, label, value, created, enabled) VALUES (?, 'service-key', ?, ?, ?, ?, 1)", 'svc_' + id, id, CATALOG.services[id].name, String(value).trim(), now());
    this.events?.emit('models', { change: 'service-key', id });
  }
  toggle(id, on) { this.s.run("UPDATE secrets SET enabled = ? WHERE kind = 'service-key' AND provider = ?", on ? 1 : 0, id); this.events?.emit('models', { change: 'service-key', id }); }
  remove(id) { this.s.run("DELETE FROM secrets WHERE kind = 'service-key' AND provider = ?", id); this.events?.emit('models', { change: 'service-key', id }); }
  /** For the screen: every service with whether a key is in place. Values are masked. */
  list() {
    return Object.entries(CATALOG.services).map(([id, s]) => {
      const r = this.s.get("SELECT value, enabled, created FROM secrets WHERE kind = 'service-key' AND provider = ?", id);
      const fromEnv = !r && !!this.env[id];
      return { id, kind: s.kind, name: s.name, signup: s.signup, free: s.free, hasKey: !!r || fromEnv, enabled: r ? !!r.enabled : fromEnv, fromEnvironment: fromEnv, key: r ? mask(r.value) : fromEnv ? mask(this.env[id]) : null, created: r?.created || null };
    });
  }
}
