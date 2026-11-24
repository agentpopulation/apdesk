// Contract 1: how a module plugs in. See contracts/MODULES.md.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { now } from './storage.js';
import { inSpace, boundToSpace } from './space-context.js';
import { plainFailure } from './model-door.js';

// Modules that ship with the desk and need the plain database door: Backup copies and restores every table, Vault
// shows the owner his saved keys and logins. Named here, in the core, so a manifest cannot claim it.
const PRIVILEGED_DB = new Set(['backup', 'vault']);
// Event types only the core may emit: the shell trusts them for what it shows about Panic, the level and approvals.
const RESERVED_EVENTS = new Set(['panic', 'security', 'approval', 'modules', 'settings', 'agents', 'job', 'restart']);
// Built in or custom (contracts/MODULES.md, "Custom modules"). modules/shipped.json is the one list of the module folders
// that ship with the desk (tools/make-zip.mjs writes it; setup/apply-update.mjs reads it). Every other module folder is
// custom. A folder the Module Store added carries ADDED_FILE: where it came from, when, who signed it, and its label.
export const SHIPPED_FILE = 'shipped.json';
export const ADDED_FILE = '.apd-added.json';
/** The folder names a modules folder shipped with, or null when it has no record (a test folder, an old install). */
export function shippedIn(dir) {
  try { const r = JSON.parse(fs.readFileSync(path.join(dir, SHIPPED_FILE), 'utf8')); return Array.isArray(r?.entries) ? new Set(r.entries.map(String)) : null; } catch { return null; }
}
/** The Store's record of an added module folder, or null. */
export function addedRecord(folder) { try { const r = JSON.parse(fs.readFileSync(path.join(folder, ADDED_FILE), 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; } }
/** A module's own table names start with this (dashes in the id become underscores). */
export const tablePrefix = (id) => 'm_' + String(id).replace(/-/g, '_') + '_';
// Every Modules of one desk (the house: the keeper's space, each person's spaces, Incognito), by the house data folder.
// The Module Store adds a module once for the whole desk, so a new folder is found in every space without a restart.
const FAMILIES = new Map();   // house data dir -> Set<WeakRef<Modules>>

/** What /api/modules shows of the Store's record: never a path. */
function addedView(a) {
  if (!a) return { from: 'by hand', at: null, signedBy: null, label: null };
  const label = a.label && typeof a.label === 'object' ? { can: list(a.label.can), hosts: list(a.label.hosts), tools: list(a.label.tools), signed: str(a.label.signed), red: num(a.label.red), yellow: num(a.label.yellow) } : null;
  return { from: ['file', 'built here', 'built with a model'].includes(a.from) ? a.from : 'by hand', at: str(a.at), signedBy: str(a.signedBy), label, by: str(a.by) };
}
const str = (v) => (typeof v === 'string' && v ? v.slice(0, 300) : null);
const num = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const list = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => x.slice(0, 300)).slice(0, 50) : []);
/** Before the first added module's code is loaded: from then on no function leads to the constructors that make code
 *  from text (Function and its async and generator kinds), by any spelling of ".constructor". The module check refuses
 *  the names Function, eval, process and globalThis in an added module's files; this closes the way round them that a
 *  text check cannot see (x["constr" + "uctor"]). Built-in code that names Function itself is not changed. */
let codeFromTextClosed = false;
export function closeCodeFromText() {
  if (codeFromTextClosed) return; codeFromTextClosed = true;
  for (const f of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    const proto = Object.getPrototypeOf(f); const real = proto.constructor;
    const stub = function () { throw Object.assign(new Error('Making code from text is closed on this desk while an added module is loaded.'), { code: 'code_from_text_closed' }); };
    Object.defineProperty(stub, 'name', { value: real.name });
    // a getter, not a fixed value: ordinary code that sets .constructor on its own function (libraries do) still works
    Object.defineProperty(proto, 'constructor', { get() { return stub; }, set(v) { if (this !== proto) Object.defineProperty(this, 'constructor', { value: v, writable: true, configurable: true, enumerable: true }); }, configurable: false, enumerable: false });
  }
}
/** A host a custom module named under "hosts": exact, "*.example.org" for its subdomains, or "*" for any. */
export function hostDeclared(hosts, hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (Array.isArray(hosts) ? hosts : []).some(d => { d = String(d).toLowerCase(); return d === '*' || d === h || (d.startsWith('*.') && h.endsWith(d.slice(1))); });
}

export class Modules {
  constructor(core) {
    this.core = core;                 // { storage, settings, panic, events, agents, model, approval, jobs, log, port, root }
    this.dir = core.modulesDir || path.join(core.root, 'modules');
    this.manifests = new Map();       // id -> manifest
    this.active = new Map();          // id -> { handle, routes: [], tools: [], api }
    this.routes = [];                 // { module, method, parts, handler }
    this.tools = new Map();           // name -> { module, name, description, parameters, run }
    this.inSpace = (fn) => inSpace(core.spaceKey, fn);   // a module's code runs inside the space it was switched on in
    this.house = core.houseDataDir || core.storage?.dataDir || this.dir;
    if (!FAMILIES.has(this.house)) FAMILIES.set(this.house, new Set());
    FAMILIES.get(this.house).add(new WeakRef(this));
    this.discover();
  }
  /** Every live Modules of this desk (this one included). */
  family() { const set = FAMILIES.get(this.house) || new Set(); const out = []; for (const r of [...set]) { const x = r.deref(); if (x) out.push(x); else set.delete(r); } return out; }
  /** Read the module folders. Safe to run again while the desk runs (the Module Store does, after adding or removing one):
   *  a module that is on keeps the manifest it started with; if its folder was replaced, it is marked as waiting for a
   *  restart and runs the old code until then. A custom folder never takes the id of a built-in module, never starts as
   *  core and never starts on by itself. */
  discover() {
    const before = new Map(this.manifests);
    this.manifests.clear();
    if (!fs.existsSync(this.dir)) return;
    const shipped = shippedIn(this.dir);
    const seen = [];
    for (const name of fs.readdirSync(this.dir).sort()) {
      const f = path.join(this.dir, name, 'module.json');
      if (!fs.existsSync(f)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!m.id) m.id = name;
        m.dir = path.join(this.dir, name);
        m.hasServer = fs.existsSync(path.join(m.dir, 'server.js'));
        m.hasUi = fs.existsSync(path.join(m.dir, 'ui.js'));
        const added = addedRecord(m.dir);
        m.custom = !!added || (shipped ? !shipped.has(name) : false);
        if (m.custom) {
          m.added = added;
          if (m.id !== name) { this.core.log('modules', 'custom module skipped: its id is not its folder name', name); continue; }
          if (m.kind === 'core' || m.boot) { m.kind = 'switch-on'; delete m.boot; }   // the owner can always switch an added module off
          m.defaultOn = false;
        }
        if (this.core.onlyModules && !this.core.onlyModules.includes(m.id)) continue;   // tests load a chosen set
        seen.push(m);
      } catch (e) { this.core.log('modules', 'bad manifest', name, e.message); }
    }
    // built-in modules first, so a custom folder can never shadow one
    for (const m of [...seen.filter(x => !x.custom), ...seen.filter(x => x.custom)]) {
      if (this.manifests.has(m.id)) { this.core.log('modules', 'second module with the id', m.id, 'skipped'); continue; }
      const running = this.active.has(m.id) ? before.get(m.id) : null;
      if (running) {
        let changed = false; try { changed = fs.readFileSync(path.join(m.dir, 'module.json'), 'utf8') !== running.source; } catch {}
        if (changed || running.dir !== m.dir || (m.added?.at || null) !== (running.added?.at || null)) running.restart = true;   // the Store put a new copy in place
        running.custom = m.custom; running.added = m.added;
        this.manifests.set(m.id, running);
      } else {
        try { m.source = fs.readFileSync(path.join(m.dir, 'module.json'), 'utf8'); } catch {}
        this.manifests.set(m.id, m);
      }
    }
    // a module that is on stays known until it is switched off, even if its folder went (it runs until then)
    for (const [id, m] of before) if (!this.manifests.has(id) && this.active.has(id)) this.manifests.set(id, { ...m, restart: true, gone: true });
  }
  wantOn(id) {
    const m = this.manifests.get(id); if (!m) return false;
    if (m.kind === 'parked') return false;
    const r = this.core.moduleChoice ? this.core.moduleChoice(id) : this.core.storage.get('SELECT on_ FROM modules WHERE id = ?', id);
    if (m.kind === 'core') return true;
    return r ? !!r.on_ : !!m.defaultOn;
  }
  isOn(id) { return this.active.has(id); }
  api(id) { return this.active.get(id)?.api || null; }
  list() {
    return [...this.manifests.values()].map(m => ({
      id: m.id, number: m.number ?? null, name: m.name, description: m.description || '', kind: m.kind || 'switch-on', defaultOn: !!m.defaultOn,
      on: this.isOn(m.id), wanted: this.wantOn(m.id), error: this.errors?.get(m.id) || null, status: m.status || null,
      menu: m.menu || [], pages: m.pages || [], settings: m.settings || [], agentTabs: m.agentTabs || [], tools: m.tools || [], commands: Array.isArray(m.commands) ? m.commands : [], requires: m.requires || [], hasUi: m.hasUi, boot: !!m.boot, attribution: m.attribution || [],
      custom: !!m.custom, restart: !!m.restart, hosts: Array.isArray(m.hosts) ? m.hosts : [],
      ...(m.custom ? { added: addedView(m.added) } : {}),
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
        // a custom module added again under the same id (removed, then added) must not get the code cached from before
        if (m.custom) closeCodeFromText();
        const mod = await import(pathToFileURL(path.join(m.dir, 'server.js')).href + (m.custom ? '?v=' + encodeURIComponent(m.added?.at || '0') : ''));
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
      /** True in an Incognito space (contracts/PEOPLE.md): a module can refuse what Incognito cannot keep, in plain words. Read-only. */
      get incognito() { return !!core.incognito; },
      get port() { return core.port; },      // the desk's own port (for refusing the desk itself, and for sidecars that use /router/v1)
      route(method, p, handler) { self.routes.push({ module: id, method: method.toUpperCase(), parts: ('/api/m/' + id + (p.startsWith('/') ? p : '/' + p)).replace(/\/$/, '').split('/'), handler: (...args) => self.inSpace(() => handler(...args)) }); },
      json(res, data, status = 200) { sendJson(res, data, status); },
      readBody: (req, limit) => readRaw(req, limit),
      db: core.storage.scope(id, { privileged: PRIVILEGED_DB.has(id) && !core.modulesDir }), kv: core.storage.kvScope('m:' + id),
      workspace: core.storage.workspace, workspacePath: (...parts) => core.storage.workspacePath(...parts), dataDir: core.storage.dataDir, backupsDir: core.storage.backupsDir, root: core.root,
      deskDataDir: core.houseDataDir || core.storage.dataDir,   // the desk's whole data folder: every person's space is inside it
      houseBackupsDir: core.houseBackupsDir || null,            // the keeper's backups folder (outside the data folder); shielded from another person's Files
      model: core.model.forModule(m.custom ? '' : id), approval: core.approval.forModule(), jobs: core.jobs.forModule(),
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
      // the Models page manages the keys (add, test, switch, remove), never reading a value; every other module sees the list only
      services: id === 'models' && core.services?.forModule ? core.services.forModule({ fetch: (u, i) => ctx.fetch(u, i) }) : { list: () => core.services?.list() ?? [] },
      /** The service refused the key this module was given (why 'refused'), or its allowance ran out ('allowance'): that key rests, the next one is used. */
      serviceKeyRefused: (sid, why) => core.services?.report?.(String(sid || ''), why === 'allowance' ? 'allowance' : 'refused') ?? false,
      tool(def) {
        if (!def?.name || typeof def.run !== 'function') throw new Error('ctx.tool needs name and run');
        // a custom module adds only the tools its module.json lists: the owner saw that list before he switched it on
        if (m.custom && !(m.tools || []).includes(def.name)) throw Object.assign(new Error(`${m.name} may add only the tools its module.json lists; "${def.name}" is not listed.`), { code: 'tool_not_listed' });
        self.tools.set(def.name, { module: id, name: def.name, description: def.description || '', parameters: def.parameters || { type: 'object', properties: {} }, run: def.run, agents: Array.isArray(def.agents) ? def.agents.map(String) : null }); },
      /** Remove one of this module's own Coordinator tools while the module stays on (an MCP tool the owner unticked). */
      untool(name) { const t = self.tools.get(name); if (t && t.module === id) self.tools.delete(name); },
      expose(api) { rec.api = boundToSpace(core.spaceKey, api); },   // called from anywhere, it runs in this module's space
      chatCard(chatId, card) { return self.api('chat')?.postCard?.(chatId, card) ?? null; },
      modules: { api: (x) => self.api(x), isOn: (x) => self.isOn(x), list: () => self.list(), tools: () => [...self.tools.values()].map(t => ({ name: t.name, module: t.module, description: t.description, parameters: t.parameters, agents: Array.isArray(t.agents) ? [...t.agents] : null })), runTool: (name, args, call) => self.runTool(name, args, call) },
      log: (...a) => core.log(id, ...a),
      /** A failure as one plain line and a short code, as the model door says it ({ code, line }); the raw text is for ctx.log only. */
      plainFailure: (e) => plainFailure(e),
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
        // a custom module reaches only the hosts its module.json names ("*" for addresses the owner types in)
        if (m.custom && !hostDeclared(m.hosts, u.hostname)) throw Object.assign(new Error(`${m.name} may reach only the addresses its module.json names; ${u.hostname} is not one of them.`), { code: 'host_not_listed' });
        return fetch(u, { ...init, signal: core.panic.child(init.signal) });
      },
    };
    // The Module Store's own door to the module folder (contracts/MODULES.md, "Custom modules"). Only the built-in Store.
    if (id === 'store' && !m.custom) ctx.moduleFolder = self.folderDoor();
    return ctx;
  }
  /** The house-wide operations the Module Store needs, across every space of this desk. */
  folderDoor() {
    const self = this;
    const main = () => self.family().find(x => !x.core.houseDataDir) || self;
    return Object.freeze({
      dir: self.dir,
      /** Folder names of the built-in modules (shipped.json); with no record, every folder without the Store's mark. */
      builtIn: () => { const s = shippedIn(self.dir); return s ? [...s].filter(n => n !== SHIPPED_FILE) : [...self.manifests.values()].filter(m => !m.custom).map(m => path.basename(m.dir)); },
      /** Every module folder present (built in or custom) with its number. */
      present: () => [...self.manifests.values()].map(m => ({ id: m.id, number: m.number ?? null, custom: !!m.custom, on: self.isOn(m.id), folder: path.basename(m.dir) })),
      isMainSpace: () => !self.core.houseDataDir,
      /** Ask the keeper (the main space's approval door): installs and removals wait for him, whoever asked. */
      askKeeper: (req) => main().core.approval.request({ ...req, action: 'install' }),
      /** The keeper's yes was for exactly this payload, decided by him (not a level or a window), and is used once. */
      assertKeeperGranted: (aid, payload) => {
        const row = main().core.approval.forModule().get(aid);
        if (row?.how !== 'owner') throw Object.assign(new Error('The Admin did not approve this.'), { code: 'not_granted' });
        return main().core.approval.assertGranted(aid, 'install', payload);
      },
      /** Read the module folders again in every space, and tell every open page. */
      rediscover: () => { for (const x of self.family()) { x.discover(); try { x.core.events.emit('modules', { changed: true }); } catch {} } },
      /** Switch a custom module off in every space (before it is removed). */
      async stopEverywhere(mid) {
        const t = self.manifests.get(mid); if (!t?.custom) throw Object.assign(new Error('Only an added module can be removed.'), { status: 409 });
        for (const x of self.family()) if (x.isOn(mid)) await x.deactivate(mid);
        main().core.storage.run('DELETE FROM modules WHERE id = ?', mid);
      },
      /** Remove a custom module's own data (its tables, its kv and its migrations) in every space open now. -> spaces done */
      dropData(mid) {
        const t = self.manifests.get(mid); if (t && !t.custom) throw Object.assign(new Error('A built-in module keeps its data.'), { status: 409 });
        const pre = tablePrefix(mid);
        const longer = [...self.manifests.keys()].filter(o => o !== mid && tablePrefix(o).startsWith(pre)).map(tablePrefix);   // m_hello_ must not take m_hello_notes_
        let n = 0;
        for (const x of self.family()) {
          const st = x.core.storage; n++;
          for (const r of st.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'", pre.replace(/_/g, '\\_') + '%')) {
            if (longer.some(l => r.name.startsWith(l))) continue;
            st.exec(`DROP TABLE IF EXISTS "${r.name.replace(/"/g, '""')}"`);
          }
          st.run('DELETE FROM kv WHERE ns = ?', 'm:' + mid); st.run('DELETE FROM migrations WHERE module IN (?, ?)', mid, mid.replace(/-/g, '_'));
          st.run("DELETE FROM secrets WHERE kind = ?", 'module:' + mid);
        }
        return n;
      },
    });
  }
  async runTool(name, args, call = {}) {
    const t = this.tools.get(name);
    if (!t) throw Object.assign(new Error(`No such tool: ${name}`), { code: 'no_tool' });
    // a tool registered with an agents list is only for those agents (a run with no agent is the owner's own)
    if (Array.isArray(t.agents) && call.agentId && !t.agents.includes(call.agentId)) throw Object.assign(new Error('That tool is not one of this agent\'s tools.'), { code: 'not_for_agent' });
    if (this.core.panic.halted) throw Object.assign(new Error('Everything is stopped. Press Resume first.'), { code: 'halted' });
    // Incognito (contracts/PEOPLE.md) refuses schedules: it is dropped when the person leaves, so a schedule would never fire.
    if (this.core.incognito && (name === 'schedule_create' || name === 'flow_create')) throw Object.assign(new Error('Schedules do not run in Incognito.'), { code: 'incognito' });
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
