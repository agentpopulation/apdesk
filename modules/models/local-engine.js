// The local engine: llama.cpp's own server program (llama-server) and one model that fits this PC, fetched in the
// background through the core downloads service, verified, unpacked into the desk's data folder and run on loopback.
// It is a local provider of the model door ("Local model on this PC"): usable while Offline, never forwards anything.
// Nothing is fetched until the owner asks (Get a local model, or the first-start box); every download asks him first.
// Panic stops the program at once and it is not started again by itself; the owner's next ask starts it.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { unpack } from './unpack.js';
import { allowLocalEngine } from '../../app/core/offline.js';
import { sizeText } from '../../app/core/downloads.js';
import PINS from './local-engine.json' with { type: 'json' };

const NS = 'core.localEngine';
const KIND = 'local-engine';
const NAME = 'Local model on this PC';
const DEFAULTS = Object.freeze({ on: true, keepLoaded: false, idleMinutes: 15, choice: null, engine: null, model: null, downloads: {} });
const HEALTH_MS = 150000;

export class LocalEngine {
  constructor({ storage, panic, events, downloads, dataDir, log = () => {}, pins = PINS, hardware = null, platform = process.platform, arch = process.arch }) {
    this.s = storage; this.panic = panic; this.events = events; this.downloads = downloads; this.log = log;
    this.pins = pins; this.platform = platform; this.arch = arch;
    this.root = path.resolve(dataDir);
    this.dir = path.join(this.root, 'llama');
    this.hardwareFn = hardware; this.hw = null;
    this.proc = null; this.port = null; this.key = null; this.phase = 'stopped'; this.starting = null;
    this.lastUse = 0; this.restarts = []; this.stopping = false; this.lastError = null; this.stoppedBy = null; this.unallow = null; this.logTail = [];
    this.offPanic = panic.onStop((reason) => /shutting down/i.test(String(reason || '')) ? this.close() : this.onPanic());
    this.idle = setInterval(() => this.idleCheck(), 30000); this.idle.unref?.();
    if (!this.cfg().on) downloads.block(KIND, 'The local engine is switched off on the Models page.');
    this.rewatch();
    if (this.cfg().keepLoaded && this.usable()) setTimeout(() => { if (!this.closed) this.ensure().catch(e => this.log('local engine', 'start failed', e.message)); }, 50).unref?.();
  }

  // ---------- saved state (core kv: no module can write it)
  cfg() { return { ...DEFAULTS, ...(this.s.kvGet(NS, 'state', {}) || {}) }; }
  save(p) { const n = { ...this.cfg(), ...p }; this.s.kvSet(NS, 'state', n); return n; }
  changed() { try { this.events.emit('models', { change: 'local-engine' }); } catch {} }

  // ---------- picking for this PC
  async hardware() {
    if (this.hw && Date.now() - this.hw.t < 10 * 60000) return this.hw.v;
    let v = null;
    try { v = this.hardwareFn ? await this.hardwareFn() : await (await import('./hardware.js')).scan(); } catch (e) { v = { ramGb: 0, ramFreeGb: 0, gpu: null, line: 'The hardware scan did not work: ' + e.message }; }
    this.hw = { t: Date.now(), v }; return v;
  }
  /** The plain processor build, or a graphics build only where the scan is sure: Windows with a dedicated card of 4 GB or more. */
  pickBuild(hw) {
    const mine = this.pins.engine.builds.filter(b => b.platform === this.platform && b.arch === this.arch);
    const gpuSure = this.platform === 'win32' && hw?.gpu && hw.gpu.dedicated !== false && Number(hw.gpu.vramGb) >= 4;
    return (gpuSure && mine.find(b => b.gpu === 'vulkan')) || mine.find(b => b.gpu === 'cpu' || b.gpu === 'metal') || null;
  }
  /** Memory the model may use: graphics memory for a graphics build, else the smaller of 60% of RAM and 85% of free RAM. */
  budget(hw, build) {
    if (build?.gpu === 'vulkan' && hw?.gpu) return Number(hw.gpu.vramGb) * 0.9;
    const ram = Number(hw?.ramGb) || 0; const free = Number(hw?.ramFreeGb ?? ram) || 0;
    return Math.min(ram * 0.6, free * 0.85);
  }
  fits(m, hw, build) { return m.needsGb <= this.budget(hw, build); }
  pickModel(hw, build) { return [...this.pins.models.list].sort((a, b) => b.size - a.size).find(m => this.fits(m, hw, build)) || null; }
  pin(id) { return this.pins.models.list.find(m => m.id === id) || null; }
  nameOf(id) { return this.pin(id)?.name || id; }

  /** What would be downloaded for this PC: the answer the first-start box and the Get button show. */
  async plan(modelId = null) {
    const hw = await this.hardware(); const build = this.pickBuild(hw); const c = this.cfg();
    const rec = build ? this.pickModel(hw, build) : null;
    const want = modelId ? this.pin(modelId) : (this.pin(c.choice) || rec);
    if (modelId && !want) throw Object.assign(new Error('That model is not on the list.'), { status: 400 });
    const engineHere = !!(c.engine && build && c.engine.build === build.id && fs.existsSync(this.serverPath(c.engine)));
    const modelHere = !!(want && c.model && c.model.id === want.id && fs.existsSync(this.modelPath(c.model)));
    const engineBytes = build && !engineHere ? build.size : 0; const modelBytes = want && !modelHere ? want.size : 0;
    const reason = !build ? `There is no ready-made llama.cpp build for this PC (${this.platform} ${this.arch}).`
      : !rec ? `This PC has too little free memory for the smallest model (${this.pins.models.list.map(m => m.needsGb).sort((a, b) => a - b)[0]} GB needed, about ${round1(this.budget(hw, build))} GB free for it).` : null;
    return {
      ok: !reason && !!want && this.fits(want, hw, build), reason: reason || (want && !this.fits(want, hw, build) ? `${want.name} needs about ${want.needsGb} GB, more than this PC has free for it (about ${round1(this.budget(hw, build))} GB).` : null),
      engine: build ? { id: build.id, name: `llama.cpp ${this.pins.engine.release}`, label: build.label, gpu: build.gpu, size: build.size, sizeText: sizeText(build.size), here: engineHere, licence: this.pins.engine.licence } : null,
      model: want ? this.modelOut(want, hw, build, modelHere) : null,
      recommended: rec?.id || null,
      choices: this.pins.models.list.map(m => this.modelOut(m, hw, build, !!(c.model && c.model.id === m.id && fs.existsSync(this.modelPath(c.model))))),
      engineBytes, modelBytes, totalBytes: engineBytes + modelBytes, totalText: sizeText(engineBytes + modelBytes),
      licences: [`llama.cpp ${this.pins.engine.release} (${this.pins.engine.licence}) from github.com/ggml-org/llama.cpp`, ...(want ? [`${want.name} by ${want.publisher} (${want.licence}) from huggingface.co/${want.repo}`] : [])],
      hardware: { line: hw?.line || null, ramGb: hw?.ramGb ?? null, ramFreeGb: hw?.ramFreeGb ?? null, gpu: hw?.gpu ? { name: hw.gpu.name, vramGb: hw.gpu.vramGb } : null, budgetGb: build ? round1(this.budget(hw, build)) : null },
    };
  }
  modelOut(m, hw, build, here) { return { id: m.id, name: m.name, size: m.size, sizeText: sizeText(m.size), licence: m.licence, publisher: m.publisher, tools: !!m.tools, needsGb: m.needsGb, fits: !!build && this.fits(m, hw, build), why: m.why, here }; }

  // ---------- getting (the owner's click only)
  /** Start the downloads for the engine and the model. Each one asks the owner (install) before a byte is fetched. */
  async get({ owner = false, modelId = null, agentId = null } = {}) {
    if (owner !== true) throw Object.assign(new Error('Only the owner starts this download, from the desk window.'), { status: 403, code: 'forbidden' });
    if (this.panic.halted) throw Object.assign(new Error('Everything is stopped. Press Resume first.'), { status: 503, code: 'halted' });
    if (!this.cfg().on) throw Object.assign(new Error('The local engine is switched off. Switch it on first.'), { status: 409, code: 'off' });
    const p = await this.plan(modelId);
    if (!p.ok) throw Object.assign(new Error(p.reason || 'Nothing to download for this PC.'), { status: 409 });
    const c = this.save({ choice: p.model.id });
    const build = this.pins.engine.builds.find(b => b.id === p.engine.id); const m = this.pin(p.model.id);
    const ids = { ...c.downloads };
    if (!p.engine.here) {
      const d = await this.downloads.start({ title: `Download llama.cpp ${this.pins.engine.release} for ${build.label}`, url: build.url, allowHosts: this.pins.engine.allowHosts, size: build.size, sha256: build.sha256, to: path.join(this.dir, 'incoming', build.file), kind: KIND }, { agentId });
      ids.engine = { id: d.id, build: build.id };
    }
    if (!p.model.here) {
      const d = await this.downloads.start({ title: `Download the local model ${m.name}`, url: m.url, allowHosts: this.pins.models.allowHosts, size: m.size, sha256: m.sha256, to: path.join(this.dir, 'models', m.file), kind: KIND }, { agentId });
      ids.model = { id: d.id, model: m.id };
    }
    this.save({ downloads: ids, failed: null });
    this.rewatch(); this.changed();
    return this.status();
  }
  /** Follow the downloads this engine started (again after a restart), and install each when it is verified. */
  rewatch() {
    const c = this.cfg();
    for (const part of ['engine', 'model']) {
      const w = c.downloads?.[part]; if (!w || this.watching?.has(w.id)) continue;
      (this.watching ||= new Set()).add(w.id);
      this.downloads.whenDone(w.id).then((d) => { this.watching.delete(w.id); if (!this.closed) return this.installed(part, w, d); }).catch(e => { this.log('local engine', e.message); });
    }
  }
  async installed(part, w, d) {
    const c = this.cfg(); const ids = { ...c.downloads }; delete ids[part];
    if (!d || d.state !== 'done') { this.save({ downloads: ids, failed: d?.state === 'failed' ? d.reason : c.failed }); this.changed(); return; }
    try {
      if (part === 'engine') {
        const build = this.pins.engine.builds.find(b => b.id === w.build);
        const archive = path.join(this.dir, 'incoming', build.file);
        const dest = path.join(this.dir, 'engine', build.id);
        const tmp = dest + '.unpack-' + process.pid;
        this.inside(tmp); fs.rmSync(tmp, { recursive: true, force: true });
        unpack(archive, tmp);
        const server = path.join(tmp, build.server);
        if (!fs.existsSync(server)) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`The archive has no ${path.basename(build.server)}.`); }
        if (this.platform !== 'win32') fs.chmodSync(server, 0o755);
        await this.stop('update');
        fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(tmp, dest);
        fs.rmSync(archive, { force: true });
        for (const old of safeList(path.join(this.dir, 'engine'))) if (old !== build.id) fs.rmSync(path.join(this.dir, 'engine', old), { recursive: true, force: true });
        this.save({ engine: { build: build.id, server: build.server, release: this.pins.engine.release, at: new Date().toISOString() }, downloads: ids });
      } else {
        const m = this.pin(w.model);
        const old = c.model && c.model.id !== m.id ? c.model : null;
        if (old) { await this.stop('change'); fs.rmSync(this.modelPath(old), { force: true }); }   // one model kept: the space of the old one is freed
        this.save({ model: { id: m.id, file: m.file, size: m.size, at: new Date().toISOString() }, downloads: ids });
      }
      this.log('local engine', part, 'installed');
    } catch (e) { this.save({ downloads: ids, failed: e.message }); this.log('local engine', 'install failed', e.message); }
    this.changed();
    if (this.cfg().keepLoaded && this.usable()) this.ensure().catch(() => {});
  }

  // ---------- the owner's other buttons
  async setOn(on, owner) {
    if (owner !== true) throw Object.assign(new Error('Only the owner switches the local engine.'), { status: 403 });
    this.save({ on: !!on });
    if (!on) { this.downloads.block(KIND, 'The local engine is switched off on the Models page.'); await this.stop('off'); }
    else this.downloads.block(KIND, null);
    this.changed(); return this.status();
  }
  async setKeepLoaded(on, owner) {
    if (owner !== true) throw Object.assign(new Error('Only the owner changes this.'), { status: 403 });
    this.save({ keepLoaded: !!on }); this.changed(); return this.status();
  }
  async choose(modelId, owner) {
    if (owner !== true) throw Object.assign(new Error('Only the owner picks the model.'), { status: 403 });
    const m = this.pin(modelId); if (!m) throw Object.assign(new Error('That model is not on the list.'), { status: 400 });
    this.save({ choice: m.id }); this.changed(); return this.status();
  }
  /** Stop the program, cancel its downloads and delete the folder it lives in: <data>/llama, nothing else. */
  async remove(owner) {
    if (owner !== true) throw Object.assign(new Error('Only the owner removes the local model.'), { status: 403 });
    await this.stop('remove');
    const c = this.cfg();
    for (const w of Object.values(c.downloads || {})) { try { this.downloads.cancel(w.id); } catch {} }
    for (const d of this.downloads.all().filter(x => x.kind === KIND && ['waiting', 'queued', 'running', 'paused'].includes(x.state))) { try { this.downloads.cancel(d.id); } catch {} }
    const before = dirSize(this.dir);
    this.inside(this.dir); fs.rmSync(this.dir, { recursive: true, force: true });
    this.save({ engine: null, model: null, downloads: {}, failed: null });
    this.changed();
    return { ...this.status(), freed: before, freedText: sizeText(before) };
  }
  inside(p) { const r = path.resolve(p); if (r !== this.dir && !r.startsWith(this.dir + path.sep)) throw new Error('Refused: outside the local engine folder.'); if (!r.startsWith(this.root + path.sep)) throw new Error('Refused: outside the data folder.'); return r; }

  // ---------- what the screen and the door see
  serverPath(e = this.cfg().engine) { return e ? path.join(this.dir, 'engine', e.build, e.server) : null; }
  modelPath(m = this.cfg().model) { return m ? path.join(this.dir, 'models', m.file) : null; }
  installedNow() { const c = this.cfg(); return !!(c.engine && c.model && fs.existsSync(this.serverPath(c.engine)) && fs.existsSync(this.modelPath(c.model))); }
  usable() { return this.cfg().on && !this.closed && this.installedNow(); }
  toolsOk() { return !!this.pin(this.cfg().model?.id)?.tools; }
  modelId() { return this.cfg().model?.id || null; }
  status() {
    const c = this.cfg(); const mine = this.downloads.all().filter(d => d.kind === KIND && ['waiting', 'queued', 'running', 'paused'].includes(d.state)).map(d => this.downloads.out(d));
    const here = this.installedNow();
    const phase = !c.on ? 'off' : mine.length ? 'downloading' : here && this.phase === 'running' ? 'running' : here && this.phase === 'starting' ? 'starting' : here && this.stoppedBy ? 'stopped' : here ? 'ready' : c.failed ? 'failed' : 'none';
    const m = this.pin(c.model?.id) || this.pin(c.choice);
    return {
      name: NAME, phase, on: c.on, keepLoaded: c.keepLoaded, idleMinutes: c.idleMinutes,
      reason: phase === 'stopped' ? (this.stoppedBy === 'panic' ? 'Stopped by Panic. It starts again the next time a local model is needed.' : this.stoppedBy === 'idle' ? `Stopped after ${c.idleMinutes} minutes without use, to free memory. It starts again when needed.` : 'Stopped. It starts again the next time a local model is needed.') : phase === 'failed' ? c.failed : this.lastError,
      model: m ? { id: m.id, name: m.name, size: m.size, sizeText: sizeText(m.size), licence: m.licence, publisher: m.publisher, tools: !!m.tools, here: !!(c.model && c.model.id === m.id) } : null,
      engine: c.engine ? { release: c.engine.release, build: c.engine.build, label: this.pins.engine.builds.find(b => b.id === c.engine.build)?.label || c.engine.build, licence: this.pins.engine.licence } : null,
      choice: c.choice, downloads: mine, folder: this.dir, used: here ? dirSize(this.dir) : 0,
    };
  }

  // ---------- running
  /** The door's target: starts the program if needed and waits until it is ready. null when it cannot answer. */
  async target({ signal, waitMs = HEALTH_MS } = {}) {
    if (!this.usable() || this.panic.halted) return null;
    await this.ensure({ signal, waitMs });
    this.touch();
    return { baseUrl: `http://127.0.0.1:${this.port}/v1`, key: this.key, model: this.modelId(), tools: this.toolsOk(), name: this.nameOf(this.modelId()) };
  }
  touch() { this.lastUse = Date.now(); }
  async ensure({ signal, waitMs = HEALTH_MS } = {}) {
    if (this.proc && this.phase === 'running') return;
    if (!this.starting) this.starting = this.start(waitMs).finally(() => { this.starting = null; });
    if (!signal) return this.starting;
    return Promise.race([this.starting, new Promise((_, no) => { if (signal.aborted) no(Object.assign(new Error('Stopped'), { code: 'aborted' })); signal.addEventListener('abort', () => no(Object.assign(new Error('Stopped'), { code: 'aborted' })), { once: true }); })]);
  }
  async start(waitMs = HEALTH_MS) {
    if (this.panic.halted) throw Object.assign(new Error('Everything is stopped. Press Resume first.'), { code: 'halted' });
    if (!this.usable()) throw new Error('The local model is not installed or is switched off.');
    const c = this.cfg(); const m = this.pin(c.model.id);
    const server = this.serverPath(c.engine); const model = this.modelPath(c.model);
    if (fs.statSync(model).size !== c.model.size) throw new Error('The model file is not the size it was when it was checked. Remove it and get it again.');
    this.stoppedBy = null; this.lastError = null; this.phase = 'starting'; this.changed();
    const port = await freePort(); const key = crypto.randomBytes(24).toString('hex');
    const run = path.join(this.dir, 'run'); fs.mkdirSync(run, { recursive: true });
    const keyFile = path.join(run, 'key-' + process.pid + '.txt');
    fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 });
    const args = ['--model', model, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', String(m?.ctx || 8192), '--api-key-file', keyFile,
      '--alias', c.model.id, '--parallel', '1', '--jinja', '--no-webui', '--offline', ...(m?.serverArgs || [])];
    const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(LLAMA|HF|GGML|HUGGING)_/i.test(k)) delete env[k];   // no outside setting may switch on its tools, tunnels or downloads
    const child = spawn(server, args, { cwd: path.dirname(server), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = child; this.port = port; this.key = key; this.logTail = [];
    const tail = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) { this.logTail.push(l.slice(0, 300)); if (this.logTail.length > 30) this.logTail.shift(); } };
    child.stdout.on('data', tail); child.stderr.on('data', tail);
    let exited = null; child.once('exit', (code, sig) => { exited = { code, sig }; this.onExit(child, code, sig); });
    child.once('error', (e) => { exited = { code: -1, error: e.message }; this.onExit(child, -1, null, e); });
    this.unallow?.(); this.unallow = allowLocalEngine(`http://127.0.0.1:${port}`);
    const t0 = Date.now();
    try {
      while (true) {
        if (exited) throw new Error(`The local engine could not start: ${exited.error || this.why()}`);
        if (this.panic.halted || this.stopping) throw Object.assign(new Error('Stopped'), { code: 'aborted' });
        if (Date.now() - t0 > waitMs) throw new Error(`The local model did not get ready within ${Math.round(waitMs / 1000)} seconds.`);
        try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { await r.body?.cancel(); break; } await r.body?.cancel(); } catch {}
        await sleep(300);
      }
    } catch (e) { this.lastError = e.message; await this.stop('failed'); this.lastError = e.message; this.changed(); throw e; }
    finally { fs.rmSync(keyFile, { force: true }); }   // the program has read it; the key lives only in memory now
    this.phase = 'running'; this.touch(); this.changed();
    this.log('local engine', 'running', c.model.id, 'on 127.0.0.1:' + port);
  }
  why() { const l = this.logTail.filter(x => /error|fail|cannot|unable|invalid/i.test(x)).slice(-1)[0] || this.logTail.slice(-1)[0] || 'it stopped at once'; return l.replace(/^.*?(error|failed?)[:\s]*/i, '').slice(0, 200); }
  onExit(child, code, sig, err) {
    if (this.proc !== child) return;
    const wasRunning = this.phase === 'running';
    this.proc = null; this.phase = 'stopped'; this.unallow?.(); this.unallow = null;
    if (this.stopping || this.panic.halted || this.closed) return;
    this.lastError = err ? `The local engine could not run: ${err.message}` : `The local engine stopped unexpectedly (${sig || 'code ' + code}).`;
    this.changed();
    if (!wasRunning || !this.cfg().on) return;
    // restarted when it exits by itself, at most three times in ten minutes
    this.restarts = this.restarts.filter(t => Date.now() - t < 600000);
    if (this.restarts.length >= 3) { this.lastError += ' It stopped three times, so it is not started again until it is needed.'; return; }
    this.restarts.push(Date.now());
    setTimeout(() => { if (!this.proc && !this.panic.halted && !this.closed && this.usable()) this.ensure().catch(e => this.log('local engine', 'restart failed', e.message)); }, 1500).unref?.();
  }
  async stop(why = 'owner') {
    const child = this.proc;
    if (why === 'panic' || why === 'idle' || why === 'owner') this.stoppedBy = why;
    if (!child) { this.phase = 'stopped'; return; }
    this.stopping = true;
    try {
      const gone = new Promise((res) => { if (child.exitCode != null || child.signalCode) res(); else child.once('exit', res); });
      try { child.kill('SIGTERM'); } catch {}
      await Promise.race([gone, sleep(4000)]);
      if (child.exitCode == null && !child.signalCode) { try { child.kill('SIGKILL'); } catch {} await Promise.race([gone, sleep(2000)]); }
    } finally {
      if (this.proc === child) this.proc = null;
      this.phase = 'stopped'; this.unallow?.(); this.unallow = null; this.stopping = false;
      this.changed();
    }
  }
  onPanic() { this.stoppedBy = 'panic'; return this.stop('panic'); }
  idleCheck() {
    const c = this.cfg();
    if (this.proc && this.phase === 'running' && !c.keepLoaded && Date.now() - this.lastUse > (Number(c.idleMinutes) || 15) * 60000) this.stop('idle').catch(() => {});
  }
  /** The door's view, for Active now. */
  brief() {
    const c = this.cfg(); if (!this.installedNow()) return null;
    return { provider: 'llama', kind: 'local', label: NAME, ok: c.on, models: [c.model.id], model: c.model.id, name: this.nameOf(c.model.id), running: this.phase === 'running', tools: this.toolsOk(), error: c.on ? null : 'switched off' };
  }
  async close() { this.closed = true; clearInterval(this.idle); this.offPanic?.(); await this.stop('shutdown'); }
}

export const LOCAL_NAME = NAME;
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round1 = (x) => Math.round(x * 10) / 10;
function safeList(d) { try { return fs.readdirSync(d); } catch { return []; } }
function dirSize(d) { let n = 0; const walk = (p) => { let st; try { st = fs.lstatSync(p); } catch { return; } if (st.isDirectory()) for (const e of safeList(p)) walk(path.join(p, e)); else n += st.size; }; walk(d); return n; }
