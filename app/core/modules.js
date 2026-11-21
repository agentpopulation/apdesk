// Contract 1: how a module plugs in. See contracts/MODULES.md.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { now } from './storage.js';
import { inSpace, boundToSpace } from './space-context.js';

// Modules that ship with the desk and need the plain database door: Backup copies and restores every table, Vault
// shows the owner his saved keys and logins. Named here, in the core, so a manifest cannot claim it.
const PRIVILEGED_DB = new Set(['backup', 'vault']);
// Event types only the core may emit: the shell trusts them for what it shows about Panic, the level and approvals.
const RESERVED_EVENTS = new Set(['panic', 'security', 'approval', 'modules', 'settings', 'agents', 'job', 'restart']);

export class Modules {
  constructor(core) {
    this.core = core;                 // { storage, settings, panic, events, agents, model, approval, jobs, log, port, root }
    this.dir = core.modulesDir || path.join(core.root, 'modules');
    this.manifests = new Map();       // id -> manifest
    this.active = new Map();          // id -> { handle, routes: [], tools: [], api }
    this.routes = [];                 // { module, method, parts, handler }
    this.tools = new Map();           // name -> { module, name, description, parameters, run }
    this.inSpace = (fn) => inSpace(core.spaceKey, fn);   // a module's code runs inside the space it was switched on in
    this.discover();
  }
  discover() {
    this.manifests.clear();
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir).sort()) {
      const f = path.join(this.dir, name, 'module.json');
      if (!fs.existsSync(f)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!m.id) m.id = name;
        m.dir = path.join(this.dir, name);
        m.hasServer = fs.existsSync(path.join(m.dir, 'server.js'));
        m.hasUi = fs.existsSync(path.join(m.dir, 'ui.js'));
        if (this.core.onlyModules && !this.core.onlyModules.includes(m.id)) continue;   // tests load a chosen set
        this.manifests.set(m.id, m);
      } catch (e) { this.core.log('modules', 'bad manifest', name, e.message); }
    }
  }
  wantOn(id) {
    const m = this.manifests.get(id); if (!m) return false;
    if (m.kind === 'parked') return false;
    const r = this.core.storage.get('SELECT on_ FROM modules WHERE id = ?', id);
    if (m.kind === 'core') return true;
    return r ? !!r.on_ : !!m.defaultOn;
  }
  isOn(id) { return this.active.has(id); }
  api(id) { return this.active.get(id)?.api || null; }
  list() {
    return [...this.manifests.values()].map(m => ({
      id: m.id, number: m.number ?? null, name: m.name, description: m.description || '', kind: m.kind || 'switch-on', defaultOn: !!m.defaultOn,
      on: this.isOn(m.id), wanted: this.wantOn(m.id), error: this.errors?.get(m.id) || null, status: m.status || null,
      menu: m.menu || [], pages: m.pages || [], settings: m.settings || [], agentTabs: m.agentTabs || [], tools: m.tools || [], requires: m.requires || [], hasUi: m.hasUi, boot: !!m.boot, attribution: m.attribution || [],
    })).sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
  }
  async startAll() {
    this.errors = new Map();
    // core first, then the rest, each after its requirements
    const order = [...this.manifests.values()].sort((a, b) => (a.kind === 'core' ? 0 : 1) - (b.kind === 'core' ? 0 : 1) || (a.number ?? 999) - (b.number ?? 999));
    for (let pass = 0; pass < 3; pass++) for (const m of order) {
      if (this.isOn(m.id) || !this.wantOn(m.id)) continue;
      if ((m.requires || []).some(r => !this.isOn(r))) continue;
      if (this.errors.has(m.id)) continue;                       // failed once this start; do not retry in a loop
      try { await this.activate(m.id); } catch (e) { /* recorded in this.errors; one broken module never blocks the desk */ }
    }
  }
  async activate(id) {
    const m = this.manifests.get(id);
    if (!m) throw Object.assign(new Error('No such module'), { status: 404 });
    if (this.isOn(id)) return true;
    if (m.kind === 'parked') throw Object.assign(new Error(`${m.name} is parked and not built.`), { status: 409 });
    const missing = (m.requires || []).filter(r => !this.isOn(r));
    if (missing.length) throw Object.assign(new Error(`${m.name} needs ${missing.join(', ')} switched on first.`), { status: 409 });
    const rec = { handle: null, api: null };
    this.active.set(id, rec);
    try {
      if (m.hasServer) {
        const mod = await import(pathToFileURL(path.join(m.dir, 'server.js')).href);
        if (typeof mod.activate === 'function') rec.handle = await this.inSpace(() => mod.activate(this.context(m, rec))) || null;
      }
      this.errors?.delete(id);
      this.core.log('modules', 'on', id);
      return true;
    } catch (e) {
      this.cleanup(id);
      this.errors?.set(id, String(e?.message || e));
      this.core.log('modules', 'failed to start', id, e?.stack || e);
      throw Object.assign(new Error(`${m.name} could not start: ${e?.message || e}`), { status: 500 });
    }
  }
  async deactivate(id) {
    const rec = this.active.get(id); if (!rec) return true;
    try { await this.inSpace(() => rec.handle?.deactivate?.()); } catch (e) { this.core.log('modules', 'deactivate error', id, e.message); }
    this.cleanup(id);
    this.core.log('modules', 'off', id);
    return true;
  }
  cleanup(id) {
    this.active.delete(id);
    this.routes = this.routes.filter(r => r.module !== id);
    for (const [name, t] of [...this.tools]) if (t.module === id) this.tools.delete(name);
  }
  /** The owner's switch in the Module Store. */
  async set(id, on) {
    const m = this.manifests.get(id);
    if (!m) throw Object.assign(new Error('No such module'), { status: 404 });
    if (m.kind === 'core' && !on) throw Object.assign(new Error(`${m.name} is part of the core and stays on.`), { status: 409 });
    if (on) await this.activate(id);
    else {
      const dependants = [...this.manifests.values()].filter(x => this.isOn(x.id) && (x.requires || []).includes(id));
      if (dependants.length) throw Object.assign(new Error(`Switch off ${dependants.map(d => d.name).join(', ')} first.`), { status: 409 });
      await this.deactivate(id);
    }
    this.core.storage.run('INSERT INTO modules (id, on_, changed) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET on_ = excluded.on_, changed = excluded.changed', id, on ? 1 : 0, now());
    this.core.events.emit('modules', { id, on: !!on });
    return this.list().find(x => x.id === id);
  }
  context(m, rec) {
    const core = this.core; const self = this; const id = m.id;
    const ctx = {
      id, manifest: m, dir: m.dir,
      get port() { return core.port; },      // the desk's own port (for refusing the desk itself, and for sidecars that use /router/v1)
      route(method, p, handler) { self.routes.push({ module: id, method: method.toUpperCase(), parts: ('/api/m/' + id + (p.startsWith('/') ? p : '/' + p)).replace(/\/$/, '').split('/'), handler: (...args) => self.inSpace(() => handler(...args)) }); },
      json(res, data, status = 200) { sendJson(res, data, status); },
      readBody: (req, limit) => readRaw(req, limit),
      db: core.storage.scope(id, { privileged: PRIVILEGED_DB.has(id) && !core.modulesDir }), kv: core.storage.kvScope('m:' + id),
      workspace: core.storage.workspace, workspacePath: (...parts) => core.storage.workspacePath(...parts), dataDir: core.storage.dataDir, backupsDir: core.storage.backupsDir, root: core.root,
      model: core.model.forModule(), approval: core.approval.forModule(), jobs: core.jobs.forModule(),
      panic: { get signal() { return core.panic.signal; }, get halted() { return core.panic.halted; }, onStop: (fn) => core.panic.onStop(fn), child: (s) => core.panic.child(s) },
      events: { emit: (type, data) => { if (RESERVED_EVENTS.has(String(type))) throw Object.assign(new Error(`Only the core emits '${type}' events.`), { code: 'reserved_event' }); return core.events.emit(type, data); }, on: (fn) => core.events.on((type, data) => self.inSpace(() => fn(type, data))) },
      agents: { list: () => core.agents.list(), get: (a) => core.agents.get(a), update: (a, p) => core.agents.update(a, p), create: (a) => core.agents.create(a), remove: (a) => core.agents.remove(a), systemPrompt: (a, extra) => core.agents.systemPrompt(a, extra) },
      settings: core.settings.readonly(),
      // Credentials that belong to this module (SMTP password, bot token). Stored in the secrets table, never logged.
      secrets: {
        get: (name) => core.storage.get("SELECT value FROM secrets WHERE kind = ? AND label = ?", 'module:' + id, name)?.value ?? null,
        set: (name, value) => { core.storage.run("DELETE FROM secrets WHERE kind = ? AND label = ?", 'module:' + id, name); if (value != null && value !== '') core.storage.run("INSERT INTO secrets (id, kind, provider, label, value, created, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)", 'sec_' + id + '_' + name + '_' + Date.now().toString(36), 'module:' + id, id, name, String(value), now()); },
        has: (name) => !!core.storage.get("SELECT 1 AS x FROM secrets WHERE kind = ? AND label = ?", 'module:' + id, name),
        list: () => core.storage.all("SELECT label, created FROM secrets WHERE kind = ?", 'module:' + id).map(r => ({ name: r.label, created: r.created })),
      },
      /** A dedicated service key the owner added (search: serper, tavily, brave, exa, jina; audio: elevenlabs, deepgram, cartesia, assemblyai). Null when absent. */
      serviceKey: (sid) => core.services?.get(sid) ?? null,
      services: { list: () => core.services?.list() ?? [] },
      tool(def) { if (!def?.name || typeof def.run !== 'function') throw new Error('ctx.tool needs name and run'); self.tools.set(def.name, { module: id, name: def.name, description: def.description || '', parameters: def.parameters || { type: 'object', properties: {} }, run: def.run, agents: def.agents || null }); },
      /** Remove one of this module's own Coordinator tools while the module stays on (an MCP tool the owner unticked). */
      untool(name) { const t = self.tools.get(name); if (t && t.module === id) self.tools.delete(name); },
      expose(api) { rec.api = boundToSpace(core.spaceKey, api); },   // called from anywhere, it runs in this module's space
      chatCard(chatId, card) { return self.api('chat')?.postCard?.(chatId, card) ?? null; },
      modules: { api: (x) => self.api(x), isOn: (x) => self.isOn(x), list: () => self.list(), tools: () => [...self.tools.values()].map(t => ({ name: t.name, module: t.module, description: t.description, parameters: t.parameters })), runTool: (name, args, call) => self.runTool(name, args, call) },
      log: (...a) => core.log(id, ...a),
      /** One line in the owner's activity log (Settings > Backup > Activity log): what this module did, in plain words. */
      activity: (title, detail) => core.approval.activity({ action: 'module.' + id, title: String(title || '').slice(0, 300), how: id, detail: detail ? String(detail).slice(0, 1000) : null }),
      /** After a restore: stop cleanly and start again (start.bat restarts the desk on exit code 75). Owner actions only. */
      requestRestart: (reason) => core.restart?.(reason || id),
      async fetch(url, init = {}) {
        const u = new URL(String(url));
        const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
        if (local && String(u.port || (u.protocol === 'https:' ? 443 : 80)) === String(core.port)) throw Object.assign(new Error('Agents cannot call the desk itself.'), { code: 'forbidden' });
        // Offline: only a local model server the owner set up may be called; a router or search engine on this PC forwards online
        if (core.settings.get('online') === false && !(core.offlineAllows ? core.offlineAllows(u) : local)) throw Object.assign(new Error('The desk is offline.'), { code: 'offline' });
        if (core.panic.halted) throw Object.assign(new Error('Everything is stopped. Press Resume first.'), { code: 'halted' });
        return fetch(u, { ...init, signal: core.panic.child(init.signal) });
      },
    };
    return ctx;
  }
  async runTool(name, args, call = {}) {
    const t = this.tools.get(name);
    if (!t) throw Object.assign(new Error(`No such tool: ${name}`), { code: 'no_tool' });
    if (this.core.panic.halted) throw Object.assign(new Error('Everything is stopped. Press Resume first.'), { code: 'halted' });
    return this.inSpace(() => t.run(args || {}, { ...call, signal: this.core.panic.child(call.signal) }));
  }
  /** Match /api/m/<id>/... */
  match(method, pathname) {
    const parts = pathname.replace(/\/$/, '').split('/');
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params = {}; let ok = true;
      for (let i = 0; i < parts.length; i++) {
        if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (r.parts[i] === '*') { params.rest = parts.slice(i).map(decodeURIComponent).join('/'); break; }
        else if (r.parts[i] !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    // wildcard routes: /api/m/<id>/files/*
    for (const r of this.routes) {
      const star = r.parts.indexOf('*'); if (r.method !== method || star < 0 || parts.length < star) continue;
      if (r.parts.slice(0, star).every((p, i) => p.startsWith(':') || p === parts[i])) {
        const params = { rest: parts.slice(star).map(decodeURIComponent).join('/') };
        r.parts.slice(0, star).forEach((p, i) => { if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]); });
        return { route: r, params };
      }
    }
    return null;
  }
}

export function sendJson(res, data, status = 200) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
export function readRaw(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
