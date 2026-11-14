// Contract 2: the single model door. See contracts/MODEL-DOOR.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { id as makeId, now } from './storage.js';

const CATALOG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers.json'), 'utf8'));
export const PROVIDERS = CATALOG.providers;
export const FREE_ROUTER = CATALOG.freeRouter;
// Attempts per call. The built-in router alone gives up to 4 targets, so 6 lets a call that the free router cannot answer
// still reach Ollama and the first keyed model (MODEL-DOOR.md, Choosing).
const MAX_ATTEMPTS = 6;
/** A streamed reply that sends nothing for this long is dropped and the next target is tried (per call: opts.streamGapMs). */
export const STREAM_GAP_MS = 45000;
/** No new hop starts after this long from the start of a call (per call: opts.deadlineMs). At least the chat's own wait. */
export const CHAT_DEADLINE_MS = 170000;
// Free upstreams sometimes return their own notice as an ordinary reply (seen from Pollinations on 13 Nov 2026).
const NOTICE = /reached its budget|raise the key budget|enter\.pollinations\.ai|rate limit exceeded|quota exceeded|please sign in|model is (currently )?(unavailable|overloaded)/i;
const ENV_KEYS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'CEREBRAS_API_KEY', 'XAI_API_KEY'];

export class ModelError extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); } }

export class ModelDoor {
  constructor({ storage, settings, panic, agents, events, log = () => {}, fetchImpl = globalThis.fetch }) {
    this.s = storage; this.settings = settings; this.panic = panic; this.agents = agents; this.events = events; this.log = log; this.fetch = fetchImpl;
    this.envKeys = [];            // { id, provider, label, value, baseUrl? } not persisted
    this.cooldown = new Map();    // provider|keyId -> until ms
    this.cache = new Map();       // probe results
    this.last = new Map();        // provider -> the last real call's result, shown in Active now
    this.loadEnvKeys();
  }
  loadEnvKeys(env = process.env) {
    this.envKeys = [];
    for (const [pid, p] of Object.entries(PROVIDERS)) {
      if (pid === 'custom') continue;
      const v = env[p.env]; if (v) this.envKeys.push({ id: 'env:' + pid, provider: pid, label: 'from environment', value: v, enabled: true, created: now(), fromEnv: true });
    }
    if (env.LLM_BASE_URL && env.LLM_API_KEY) this.envKeys.push({ id: 'env:custom', provider: 'custom', label: 'from environment', value: env.LLM_API_KEY, enabled: true, created: now(), fromEnv: true, meta: { baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL || '' } });
    void ENV_KEYS;
  }

  // ---------- keys (secrets table, kind 'provider-key')
  keysFor(provider, includeValue = false) {
    const rows = this.s.all("SELECT * FROM secrets WHERE kind = 'provider-key' AND provider = ? ORDER BY created", provider).map(r => ({ id: r.id, provider: r.provider, label: r.label, value: r.value, enabled: !!r.enabled, created: r.created, meta: safeJson(r.meta) }));
    const all = [...rows, ...this.envKeys.filter(k => k.provider === provider)];
    return includeValue ? all : all.map(k => ({ ...k, value: mask(k.value) }));
  }
  listKeys() { const out = {}; for (const pid of Object.keys(PROVIDERS)) out[pid] = this.keysFor(pid); return out; }
  addKey(provider, value, label = '', meta = {}) {
    if (!PROVIDERS[provider]) throw new ModelError('bad_provider', 'Unknown provider');
    if (!value || typeof value !== 'string' || value.length < 8) throw new ModelError('bad_key', 'That key looks too short');
    const id = makeId('key_');
    this.s.run("INSERT INTO secrets (id, kind, provider, label, value, created, enabled, meta) VALUES (?, 'provider-key', ?, ?, ?, ?, 1, ?)", id, provider, label || `Key ${this.keysFor(provider).length + 1}`, value.trim(), now(), JSON.stringify(meta || {}));
    this.cache.clear(); this.events.emit('models', { change: 'key' });
    return { id, provider, label, value: mask(value), enabled: true };
  }
  toggleKey(id, enabled) { this.s.run('UPDATE secrets SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id); this.cache.clear(); this.events.emit('models', { change: 'key' }); }
  removeKey(id) { this.s.run('DELETE FROM secrets WHERE id = ?', id); this.cache.clear(); this.events.emit('models', { change: 'key' }); }
  liveKeys(provider) { return this.keysFor(provider, true).filter(k => k.enabled && !this.onCooldown(provider, k.id)); }
  onCooldown(provider, keyId) { const u = this.cooldown.get(provider + '|' + keyId); return u && u > Date.now(); }
  cool(provider, keyId, ms) { this.cooldown.set(provider + '|' + keyId, Date.now() + ms); }

  // ---------- what is live
  get online() { return this.settings.get('online') !== false; }
  async probe(kind, fn, ttl = 30000) {
    const c = this.cache.get(kind); if (c && c.at > Date.now() - ttl) return c.v;
    let v; try { v = await fn(); } catch (e) { v = { ok: false, error: e.message }; }
    this.cache.set(kind, { at: Date.now(), v }); return v;
  }
  async routerModels() {
    if (!this.settings.get('router.enabled')) return { ok: false, error: 'off', models: [] };
    return this.probe('router', async () => {
      const r = await this.http(this.settings.get('router.baseUrl') + '/models', { headers: this.routerHeaders() }, 4000);
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, models: [] };
      const j = await r.json(); const list = (j.data || j.models || []).map(m => typeof m === 'string' ? m : m.id).filter(Boolean);
      return { ok: true, models: list };
    });
  }
  routerHeaders() { const k = this.liveKeys('custom').find(k => k.meta?.router); const key = this.settings.get('router.apiKey'); const h = {}; if (key) h.authorization = 'Bearer ' + key; else if (k) h.authorization = 'Bearer ' + k.value; return h; }
  async ollamaModels() {
    return this.probe('ollama', async () => {
      const r = await this.http(this.settings.get('ollama.baseUrl') + '/api/tags', {}, 2500);
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, models: [] };
      const j = await r.json(); return { ok: true, models: (j.models || []).map(m => ({ name: m.name, size: m.size, family: m.details?.family, parameters: m.details?.parameter_size, quant: m.details?.quantization_level })) };
    });
  }
  async lanNodes() { return (this.settings.get('network.lanNodes') || []).filter(n => n && n.baseUrl && n.enabled !== false); }
  /** The "Active now" list. */
  async active() {
    const out = [];
    const online = this.online;
    const [router, ollama] = await Promise.all([this.routerModels(), this.ollamaModels()]);
    if (this.settings.get('router.enabled')) {
      const builtin = !router.ok && this.settings.get('router.builtin') !== false;
      const ups = builtin ? (this.settings.get('router.upstreams') || FREE_ROUTER.upstreams).filter(u => u.enabled !== false) : [];
      out.push({ provider: 'router', kind: 'router', label: 'Agent Population Router', ok: online && (router.ok || builtin), builtin, upstreams: ups.map(u => ({ id: u.id, name: u.name, models: u.models, limit: u.limit })), models: router.ok ? router.models : ups.flatMap(u => u.models), error: !online ? 'offline' : (router.ok || builtin ? null : router.error), model: router.ok ? this.routerDefault(router.models) : 'auto' });
    }
    out.push({ provider: 'ollama', kind: 'local', label: 'Ollama', ok: ollama.ok, models: (ollama.models || []).map(m => m.name), detail: ollama.models || [], error: ollama.error, model: this.ollamaDefault(ollama.models) });
    for (const [pid, p] of Object.entries(PROVIDERS)) {
      const keys = this.keysFor(pid).filter(k => k.enabled);
      if (!keys.length) continue;
      out.push({ provider: pid, kind: 'keyed', label: p.name, ok: online, keys: keys.length, models: [this.keyedDefault(pid)], model: this.keyedDefault(pid), error: online ? null : 'offline', last: this.last.get(pid) || null });
    }
    for (const n of await this.lanNodes()) out.push({ provider: 'lan:' + n.id, kind: 'lan', label: n.name || n.baseUrl, ok: true, models: n.models || [], model: n.model || (n.models || [])[0] });
    return out;
  }
  routerDefault(list = []) { const want = this.settings.get('router.model'); if (want && want !== 'auto') return want; return list[0] || 'auto'; }
  ollamaDefault(list = []) { const want = this.settings.get('ollama.model'); const names = (list || []).map(m => m.name || m); if (want && names.includes(want)) return want; return names.find(n => !/embed|bge|minilm|nomic/i.test(n)) || names[0] || null; }
  keyedDefault(pid) { const want = this.settings.get(`provider.${pid}.model`); if (want) return want; const k = this.keysFor(pid, true).find(k => k.meta?.model); return k?.meta?.model || PROVIDERS[pid].defaultModel; }

  // ---------- choosing
  resolve(agentId) {
    const a = agentId ? this.agents.get(agentId) : null;
    const chain = [];
    if (a?.model?.main?.provider) chain.push({ ...a.model.main, why: 'agent main' });
    if (a?.model?.fallback?.provider) chain.push({ ...a.model.fallback, why: 'agent fallback' });
    for (const step of this.settings.get('model.defaultChain') || ['router', 'ollama', 'keyed']) {
      if (step === 'router') { if (this.settings.get('router.enabled')) chain.push({ provider: 'router', model: null, why: 'default' }); }
      else if (step === 'ollama') chain.push({ provider: 'ollama', model: null, why: 'default' });
      else if (PROVIDERS[step]) { if (this.keysFor(step).some(k => k.enabled)) chain.push({ provider: step, model: null, why: 'default key' }); }
      else if (step === 'keyed') { for (const pid of Object.keys(PROVIDERS)) if (this.keysFor(pid).some(k => k.enabled)) chain.push({ provider: pid, model: null, why: 'default key' }); for (const n of this.settings.get('network.lanNodes') || []) if (n?.enabled !== false && n?.baseUrl) chain.push({ provider: 'lan:' + n.id, model: n.model || null, why: 'lan' }); }
    }
    const seen = new Set(); const uniq = chain.filter(c => { const k = c.provider + '|' + (c.model || ''); if (seen.has(k)) return false; seen.add(k); return true; });
    // Offline: the chain that will really be used holds only local models. The full list is kept for the screen.
    const online = this.online;
    return { main: a?.model?.main || null, fallback: a?.model?.fallback || null, online, chain: online ? uniq : uniq.filter(c => this.isLocal(c.provider)), whenOnline: uniq };
  }
  isLocal(provider) { return provider === 'ollama' || String(provider).startsWith('lan:'); }

  // ---------- the call
  async chat(opts) {
    if (this.panic.halted) throw new ModelError('halted', 'Everything is stopped. Press Resume first.');
    const signal = this.panic.child(opts.signal);
    const online = this.online;
    let chain = opts.model?.provider ? [{ ...opts.model, why: 'explicit' }] : this.resolve(opts.agentId).chain;
    if (!online) chain = chain.filter(c => this.isLocal(c.provider));   // an explicit pick of an online model is refused offline too
    if (!chain.length) throw new ModelError(online ? 'no_provider' : 'offline', online ? 'No model is set up. Add a key or start Ollama or the router in Models.' : 'The desk is offline and no local model is running. Start Ollama or go online.');
    const attempts = [];
    const limit = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : CHAT_DEADLINE_MS;
    const deadline = Date.now() + limit; let late = false;
    let shown = false;   // a target already streamed text: the caller is told to clear it before the next one streams
    const onDelta = opts.onDelta ? (d) => { shown = true; opts.onDelta(d); } : undefined;
    const hopOpts = { ...opts, onDelta };
    for (const step of chain) {
      if (attempts.length >= MAX_ATTEMPTS) break;
      if (signal.aborted) throw new ModelError('aborted', 'Stopped.', { attempts });
      if (Date.now() >= deadline) { late = true; break; }
      const targets = await this.targets(step, opts);
      if (!targets.length) { attempts.push({ provider: step.provider, model: step.model, ok: false, error: 'not available' }); continue; }
      for (const t of targets) {
        if (attempts.length >= MAX_ATTEMPTS) break;
        if (Date.now() >= deadline) { late = true; break; }
        // a paid model is not called once today's or this month's spend has reached the owner's limit
        if (t.key && this.priceOf(t.model) && this.spendGuard) { const over = this.spendGuard(); if (over) { attempts.push({ provider: t.provider, model: t.model, ok: false, error: `not called: your ${over} is reached` }); continue; } }
        const t0 = Date.now();
        try {
          if (shown) { shown = false; try { opts.onReset?.(); } catch {} }
          const r = await this.callOne(t, hopOpts, signal, deadline - Date.now());
          const ms = Date.now() - t0;
          attempts.push({ provider: t.provider, model: t.model, ok: true, ms });
          this.last.set(t.provider, { ok: true, at: now(), model: t.model, ms });
          this.record({ ...opts, provider: t.provider, model: t.model, ok: true, ms, usage: r.usage });
          return { ...r, provider: t.provider, model: t.model, via: t.via || null, label: this.label(t.provider, t.model, t.viaName), ms, attempts, fallbackUsed: attempts.length > 1 };
        } catch (e) {
          const ms = Date.now() - t0;
          if (signal.aborted || e.name === 'AbortError' || e.code === 'aborted') throw new ModelError('aborted', 'Stopped.', { attempts });
          attempts.push({ provider: t.provider, model: t.model, ok: false, error: e.message, ms });
          if (!this.last.get(t.provider)?.ok || this.last.get(t.provider).model === t.model) this.last.set(t.provider, { ok: false, at: now(), model: t.model, error: short(e.message) });
          this.record({ ...opts, provider: t.provider, model: t.model, ok: false, ms, error: e.message });
          if (e.status === 429) this.cool(t.provider, (t.keyId || '-') + (t.via ? '' : '|' + t.model), /quota|per day|daily/i.test(e.message) ? 15 * 60000 : 60000);   // one model out of quota does not silence the key's other models
          else if (e.status === 401 || e.status === 403) this.cool(t.provider, t.keyId || '-', t.via ? 60000 : 10 * 60000);
          else if (t.via) this.cool(t.provider, t.keyId, 20000);
          this.log('model', t.provider, t.model, 'failed:', e.message);
        }
      }
      if (late) break;
    }
    throw new ModelError('all_failed', (late ? `No model answered within ${limit / 1000} seconds. ` : 'No model answered. ') + attempts.map(a => `${this.label(a.provider, a.model)}: ${a.error}`).join('; '), { attempts });
  }
  /** Concrete (provider, model, baseUrl, key) targets for one chain step. */
  async targets(step, opts = {}) {
    const p = step.provider;
    if (p === 'router') {
      if (!this.settings.get('router.enabled') || !this.online) return [];
      const r = await this.routerModels();
      if (r.ok) return [{ provider: 'router', api: 'openai', baseUrl: this.settings.get('router.baseUrl'), model: step.model || this.routerDefault(r.models), headers: this.routerHeaders() }];
      if (this.settings.get('router.builtin') === false) return [];
      return this.builtinRouterTargets(step.model, !!opts.tools?.length);
    }
    if (p === 'ollama') {
      const r = await this.ollamaModels(); if (!r.ok) return [];
      const model = step.model || this.ollamaDefault(r.models); if (!model) return [];
      return [{ provider: 'ollama', api: 'openai', baseUrl: this.settings.get('ollama.baseUrl') + '/v1', model, headers: {} }];
    }
    if (p.startsWith('lan:')) {
      const n = (this.settings.get('network.lanNodes') || []).find(x => 'lan:' + x.id === p); if (!n || !n.baseUrl) return [];
      return [{ provider: p, api: 'openai', baseUrl: n.baseUrl.replace(/\/$/, ''), model: step.model || n.model || (n.models || [])[0] || 'auto', headers: n.apiKey ? { authorization: 'Bearer ' + n.apiKey } : {} }];
    }
    const def = PROVIDERS[p]; if (!def || !this.online) return [];
    const out = [];
    // The owner's rule: OpenRouter is used with free models only. A paid model id is refused here, at the one door,
    // unless the owner switches paid OpenRouter on in Settings (guarded route; off by default).
    const freeOnly = p === 'openrouter' && this.settings.get('openrouter.allowPaid') !== true;
    const isFree = (m) => /:free$/.test(String(m || '')) || m === 'openrouter/free';
    for (const k of this.liveKeys(p)) {
      if (step.keyId && k.id !== step.keyId) continue;            // a Test of one key uses that key only
      const first = step.model || k.meta?.model || this.keyedDefault(p);
      let models = step.model ? [first] : [first, ...(def.altModels || []).filter(m => m !== first).slice(0, 3)];
      if (freeOnly) models = models.filter(isFree);
      for (const model of models) if (!this.onCooldown(p, k.id + '|' + model)) out.push({ provider: p, api: def.api, baseUrl: (k.meta?.baseUrl || def.baseUrl).replace(/\/$/, ''), model, key: k.value, keyId: k.id, headers: {} });
    }
    return out;
  }
  /** The built-in Agent Population Router: no-sign-in upstreams, rotated so one model's rate limit is not hit twice in a row. */
  builtinRouterTargets(wantModel, needTools = false) {
    const ups = (this.settings.get('router.upstreams') || FREE_ROUTER.upstreams).filter(u => u && u.enabled !== false);
    const all = [];
    for (const u of ups) for (const m of u.models || []) if (!(needTools && (u.noTools || []).includes(m))) all.push({ provider: 'router', via: u.id, viaName: u.name, api: 'openai', baseUrl: u.baseUrl.replace(/\/$/, ''), chatPath: u.chatPath, model: m, headers: u.key ? { authorization: 'Bearer ' + u.key } : {}, keyId: 'builtin:' + u.id + ':' + m });
    let list = all.filter(t => !this.onCooldown('router', t.keyId));
    if (wantModel && wantModel !== 'auto') { const hit = list.filter(t => t.model === wantModel); if (hit.length) return hit; }
    if (!list.length) return [];
    // one model per upstream first, rotating which, so the chain reaches a second upstream quickly
    this._rr = (this._rr || 0) + 1;
    const byUp = new Map(); for (const t of list) { if (!byUp.has(t.via)) byUp.set(t.via, []); byUp.get(t.via).push(t); }
    const out = [];
    for (const [, arr] of byUp) out.push(arr[this._rr % arr.length]);
    for (const [, arr] of byUp) if (arr.length > 1) out.push(arr[(this._rr + 1) % arr.length]);
    return out.slice(0, 4);
  }
  label(provider, model, via) {
    const name = provider === 'router' ? 'Agent Population Router' : provider === 'ollama' ? 'Ollama' : String(provider).startsWith('lan:') ? 'LAN node' : (PROVIDERS[provider]?.name || provider);
    return model ? `${name} · ${model}${via ? ' (' + via + ')' : ''}` : name;
  }
  /** leftMs: time left before the call's deadline; a hop's wait for its first byte never runs past it. */
  async callOne(t, opts, signal, leftMs = Infinity) {
    if (t.api === 'anthropic') return this.callAnthropic(t, opts, signal, leftMs);
    return this.callOpenAI(t, opts, signal, leftMs);
  }
  async callOpenAI(t, opts, signal, leftMs = Infinity) {
    const body = { model: t.model, messages: opts.messages, stream: !!opts.onDelta };
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.json && !t.via && t.provider !== 'router') body.response_format = { type: 'json_object' };
    if (opts.tools?.length) body.tools = opts.tools.map(f => ({ type: 'function', function: { name: f.name, description: f.description, parameters: f.parameters || { type: 'object', properties: {} } } }));
    if (t.provider === 'openrouter' && this.settings.get('openrouter.allowPaid') !== true && !(/:free$/.test(String(t.model)) || t.model === 'openrouter/free')) throw Object.assign(new Error('Paid OpenRouter models are switched off. Only free models are used.'), { status: 402 });
    const headers = { 'content-type': 'application/json', ...t.headers };
    if (t.key) headers.authorization = 'Bearer ' + t.key;
    if (t.provider === 'openrouter') { headers['http-referer'] = 'http://127.0.0.1:3960'; headers['x-title'] = 'AP Desk'; }
    const r = await this.http(t.baseUrl + (t.chatPath ?? '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal }, Math.max(1, Math.min(opts.timeoutMs || (t.via ? 60000 : 180000), leftMs)));
    if (!r.ok) { const txt = await r.text().catch(() => ''); throw Object.assign(new Error(`HTTP ${r.status} ${short(txt)}`), { status: r.status }); }
    let text = ''; let toolCalls = []; let usage = null;
    let finish = null;
    if (body.stream) {
      const acc = new Map(); let lastSlot = 0;
      for await (const ev of sse(r.body, signal, opts.streamGapMs || STREAM_GAP_MS)) {
        if (ev === '[DONE]') break;
        let j; try { j = JSON.parse(ev); } catch { continue; }
        const ch = j.choices?.[0]; const d = ch?.delta || {};
        if (ch?.finish_reason) finish = ch.finish_reason;
        if (d.content) { text += d.content; try { opts.onDelta(d.content); } catch {} }
        for (const tc of d.tool_calls || []) {
          // Which call does this piece belong to? Its index when the provider sends one. Gemini sends parallel calls
          // with no index: there a piece that carries a new id, or a name after the current call already has its
          // arguments, starts the next call. Without this, two calls were glued into one ("file_writefile_write").
          let slot = tc.index;
          if (slot == null) {
            const cur = acc.get(lastSlot);
            const startsNew = !cur || (tc.id && cur.id && tc.id !== cur.id) || (tc.function?.name && cur.name && (cur.args || tc.id));
            slot = startsNew ? (cur ? lastSlot + 1 : 0) : lastSlot;
          }
          lastSlot = slot;
          const cur = acc.get(slot) || { id: tc.id, name: '', args: '' };
          if (tc.id) cur.id = tc.id; if (tc.function?.name) cur.name += tc.function.name; if (tc.function?.arguments) cur.args += tc.function.arguments; if (tc.extra_content) cur.extra_content = tc.extra_content;
          acc.set(slot, cur);
        }
        if (j.usage) usage = j.usage;
      }
      toolCalls = [...acc.values()];
    } else {
      const j = await r.json();
      const m = j.choices?.[0]?.message || {};
      finish = j.choices?.[0]?.finish_reason || null;
      text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(c => c.text || '').join('') : '';
      toolCalls = (m.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function?.name, args: tc.function?.arguments, extra_content: tc.extra_content }));
      usage = j.usage || null;
    }
    const cutOff = /^(length|max_tokens|MAX_TOKENS)$/.test(String(finish || ''));   // the reply hit its length limit: callers must not treat it as whole
    const out = { text, toolCalls: toolCalls.map(tc => ({ id: tc.id || makeId('call_'), name: tc.name, args: parseArgs(tc.args), ...(tc.extra_content ? { extra_content: tc.extra_content } : {}) })), usage: usage ? { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 } : null };
    out.finish = finish || null; out.cutOff = cutOff;
    if (opts.json) out.json = extractJson(text);
    if (!out.text && !out.toolCalls.length) throw new Error('Empty reply');
    if (t.via && NOTICE.test(out.text.slice(0, 400))) throw Object.assign(new Error('The free provider answered with a notice, not a reply: ' + short(out.text)), { status: 429 });
    return out;
  }
  async callAnthropic(t, opts, signal, leftMs = Infinity) {
    const sys = opts.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const msgs = [];
    for (const m of opts.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') { msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }] }); continue; }
      if (m.role === 'assistant' && m.tool_calls?.length) { msgs.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.tool_calls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.function?.name || tc.name, input: parseArgs(tc.function?.arguments ?? tc.args) }))] }); continue; }
      msgs.push({ role: m.role, content: String(m.content ?? '') });
    }
    const body = { model: t.model, max_tokens: opts.maxTokens || 4096, messages: msgs, stream: !!opts.onDelta };
    if (sys) body.system = sys;
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.tools?.length) body.tools = opts.tools.map(f => ({ name: f.name, description: f.description, input_schema: f.parameters || { type: 'object', properties: {} } }));
    const r = await this.http(t.baseUrl + '/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': t.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal }, Math.max(1, Math.min(opts.timeoutMs || 180000, leftMs)));
    if (!r.ok) { const txt = await r.text().catch(() => ''); throw Object.assign(new Error(`HTTP ${r.status} ${short(txt)}`), { status: r.status }); }
    let text = ''; const toolCalls = []; let usage = null; let finish = null;
    if (body.stream) {
      let cur = null;
      for await (const ev of sse(r.body, signal, opts.streamGapMs || STREAM_GAP_MS)) {
        let j; try { j = JSON.parse(ev); } catch { continue; }
        if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') cur = { id: j.content_block.id, name: j.content_block.name, args: '' };
        else if (j.type === 'content_block_delta') { if (j.delta?.type === 'text_delta') { text += j.delta.text; try { opts.onDelta(j.delta.text); } catch {} } else if (j.delta?.type === 'input_json_delta' && cur) cur.args += j.delta.partial_json; }
        else if (j.type === 'content_block_stop' && cur) { toolCalls.push(cur); cur = null; }
        else if (j.type === 'message_delta') { if (j.delta?.stop_reason) finish = j.delta.stop_reason; if (j.usage) usage = { ...(usage || {}), output_tokens: j.usage.output_tokens }; }
        else if (j.type === 'message_start' && j.message?.usage) usage = { ...j.message.usage };
      }
    } else {
      const j = await r.json();
      for (const c of j.content || []) { if (c.type === 'text') text += c.text; else if (c.type === 'tool_use') toolCalls.push({ id: c.id, name: c.name, args: c.input }); }
      usage = j.usage; finish = j.stop_reason || null;
    }
    const out = { text, toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, args: parseArgs(tc.args) })), usage: usage ? { input: usage.input_tokens || 0, output: usage.output_tokens || 0 } : null };
    out.finish = finish || null; out.cutOff = /^(length|max_tokens|MAX_TOKENS)$/.test(String(finish || ''));
    if (opts.json) out.json = extractJson(text);
    return out;
  }
  async embed({ texts, agentId, model }) {
    if (this.panic.halted) throw new ModelError('halted', 'Everything is stopped.');
    const list = Array.isArray(texts) ? texts : [texts];
    const o = await this.ollamaModels();
    const emb = model || (o.models || []).map(m => m.name).find(n => /embed|bge|minilm|nomic/i.test(n));
    if (o.ok && emb) {
      const r = await this.http(this.settings.get('ollama.baseUrl') + '/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: emb, input: list }) }, 60000);
      if (r.ok) { const j = await r.json(); return { vectors: j.embeddings, model: emb, provider: 'ollama' }; }
    }
    if (this.online) for (const pid of ['openai', 'gemini', 'mistral', 'together']) {
      const k = this.liveKeys(pid)[0]; if (!k) continue;
      const m = pid === 'openai' ? 'text-embedding-3-small' : pid === 'gemini' ? 'text-embedding-004' : pid === 'mistral' ? 'mistral-embed' : 'togethercomputer/m2-bert-80M-8k-retrieval';
      const r = await this.http(PROVIDERS[pid].baseUrl + '/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + k.value }, body: JSON.stringify({ model: m, input: list }) }, 60000);
      if (r.ok) { const j = await r.json(); return { vectors: (j.data || []).map(d => d.embedding), model: m, provider: pid }; }
    }
    throw new ModelError('unavailable', 'No embedding model is available. Pull one in Ollama (for example nomic-embed-text).');
  }
  /** The model ids a provider offers, read with the owner's key on the server. Modules never see the key. */
  async listModels(provider) {
    if (provider === 'router') return (await this.active()).find(a => a.provider === 'router')?.models || [];
    if (provider === 'ollama') return ((await this.ollamaModels()).models || []).map(m => m.name);
    const def = PROVIDERS[provider]; const k = this.liveKeys(provider)[0];
    if (!def || !k || !this.online) return [];
    const r = await this.probe('models:' + provider, async () => {
      const base = (k.meta?.baseUrl || def.baseUrl).replace(/\/$/, '');
      const headers = def.api === 'anthropic' ? { 'x-api-key': k.value, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + k.value };
      const res = await this.http(base + '/models', { headers }, 8000);
      if (!res.ok) return { ok: false, models: [] };
      const j = await res.json(); return { ok: true, models: (j.data || j.models || []).map(m => String(typeof m === 'string' ? m : m.id || m.name || '').replace(/^models\//, '')).filter(Boolean) };
    }, 300000);
    let list = r.models || [];
    if (provider === 'openrouter' && this.settings.get('openrouter.allowPaid') !== true) list = list.filter(m => /:free$/.test(m));
    return list;
  }
  record(o) {
    try {
      const cost = this.estimate(o.provider, o.model, o.usage);
      this.s.run('INSERT INTO calls (at, agent_id, purpose, provider, model, ok, ms, input_tokens, output_tokens, cost_minor, currency, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', now(), o.agentId || null, o.purpose || 'chat', o.provider, o.model, o.ok ? 1 : 0, o.ms || 0, o.usage?.input || 0, o.usage?.output || 0, cost, this.settings.get('currency'), o.error || null);
    } catch (e) { this.log('record failed', e.message); }
  }
  /** True when this model costs money by our price list (free ids and unknown models count as free). */
  priceOf(model) { const p = CATALOG.prices.find(x => String(model || '').toLowerCase().includes(x.match)); return p && (p.in > 0 || p.out > 0) ? p : null; }
  estimate(provider, model, usage) {
    if (!usage || provider === 'router' || provider === 'ollama' || String(provider).startsWith('lan:')) return 0;
    const p = CATALOG.prices.find(x => String(model || '').toLowerCase().includes(x.match)); if (!p) return 0;
    const usd = (usage.input || 0) / 1e6 * p.in + (usage.output || 0) / 1e6 * p.out;
    const rate = CATALOG.usdRates[this.settings.get('currency')] || 1;
    return Math.round(usd * rate * 100);
  }
  usage() {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    return { today: this.s.all('SELECT provider, model, COUNT(*) AS calls, SUM(ok) AS ok, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_minor) AS cost FROM calls WHERE at >= ? GROUP BY provider, model ORDER BY calls DESC', day.toISOString()), recent: this.s.all('SELECT * FROM calls ORDER BY id DESC LIMIT 50') };
  }
  async http(url, init = {}, timeoutMs = 30000) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), timeoutMs);
    const onAbort = () => ac.abort('aborted'); init.signal?.addEventListener('abort', onAbort, { once: true });
    // The caller's signal stays wired to the request for the whole body, so Panic cuts a reply mid-stream.
    // The timeout covers only the wait for the first byte; a streamed body has its own gap timer (sse).
    try { return await this.fetch(url, { ...init, signal: ac.signal }); }
    catch (e) {
      if (init.signal?.aborted) throw Object.assign(new Error('Stopped'), { code: 'aborted', name: 'AbortError' });
      if (ac.signal.reason === 'timeout') throw new Error(`No answer within ${Math.round(timeoutMs / 100) / 10} seconds`);
      throw e;
    }
    finally { clearTimeout(t); }
  }
  /** What a module gets. Keys are managed by the Models module through these calls; values never come back. */
  forModule() {
    return Object.freeze({
      chat: (o) => this.chat(o), embed: (o) => this.embed(o), active: () => this.active(), listModels: (p) => this.listModels(p), resolve: (id) => this.resolve(id), label: (p, m) => this.label(p, m),
      providers: () => Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { name: v.name, baseUrl: v.baseUrl, signup: v.signup, defaultModel: v.defaultModel, tier: v.tier || 'paid', freeNote: v.freeNote || null }])),
      freeRouter: () => ({ note: FREE_ROUTER.note, upstreams: (this.settings.get('router.upstreams') || FREE_ROUTER.upstreams) }),
      /** The assistant message to send back before the tool results, with everything the provider needs kept (Gemini's signature). */
      toolMessage: (r) => toolMessage(r),
      keys: { list: () => this.listKeys(), add: (p, v, l, m) => this.addKey(p, v, l, m), toggle: (id, on) => this.toggleKey(id, on), remove: (id) => this.removeKey(id) },
      routerModels: () => this.routerModels(), ollamaModels: () => this.ollamaModels(), usage: () => this.usage(), get online() { return undefined; },
    });
  }
}

/** Server-sent events from a streamed body. gapMs: nothing at all arriving for this long drops the stream with an ordinary
 *  provider error (code 'stalled'), so the chain moves on; any bytes, keep-alive lines too, restart the wait. */
async function* sse(body, signal, gapMs = 0) {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = '';
  const read = () => {
    if (!gapMs) return reader.read();
    let timer;
    const gap = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error(`The reply stopped coming for ${Math.round(gapMs / 100) / 10} seconds`), { code: 'stalled' })), gapMs); });
    return Promise.race([reader.read(), gap]).finally(() => clearTimeout(timer));
  };
  try {
    while (true) {
      if (signal?.aborted) { try { await reader.cancel(); } catch {} throw Object.assign(new Error('Stopped'), { code: 'aborted', name: 'AbortError' }); }
      let value, done;
      try { ({ value, done } = await read()); } catch (e) {
        if (signal?.aborted) throw Object.assign(new Error('Stopped'), { code: 'aborted', name: 'AbortError' });
        if (e.code === 'stalled') reader.cancel().catch(() => {});   // closes the connection; the pending read settles on its own
        throw e;
      }
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line.startsWith('data:')) yield line.slice(5).trim(); }
    }
  } finally { try { reader.releaseLock(); } catch {} }
}
export function toolMessage(r) {
  return { role: 'assistant', content: r.text || '', tool_calls: (r.toolCalls || []).map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }, ...(tc.extra_content ? { extra_content: tc.extra_content } : {}) })) };
}
export function parseArgs(a) { if (a == null) return {}; if (typeof a === 'object') return a; try { return JSON.parse(a); } catch { return extractJson(a) || { _raw: a }; } }
export function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  const c = s.indexOf('['), d = s.lastIndexOf(']'); if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch {} }
  return null;
}
function mask(v) { if (!v) return ''; return v.length <= 8 ? '••••' : v.slice(0, 4) + '••••' + v.slice(-4); }
function short(t) { return String(t || '').replace(/\s+/g, ' ').slice(0, 160); }
function safeJson(x) { try { return x ? JSON.parse(x) : {}; } catch { return {}; } }
