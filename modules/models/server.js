// Models and Router (module 2). The screen and the management around the model door; every call goes through ctx.model.
import fs from 'node:fs';
import path from 'node:path';
import * as hw from './hardware.js';
import { UPSTREAM_TERMS, PROVIDER_TERMS, safeFirst } from './catalog.js';
import providersFile from '../../app/core/providers.json' with { type: 'json' };
import { ROUTER_NAME } from '../../app/core/model-door.js';

const BUILTIN_UPSTREAMS = providersFile.freeRouter.upstreams;
const TEST_PROMPT = [{ role: 'user', content: 'Reply with the single word: ready' }];
const LITELLM_URL = 'http://127.0.0.1:4000';
const OLLAMA_FIX = 'Ollama is not running on this PC. Fix: install it from ollama.com, then start it (or run "ollama serve").';
// How long a Test waits. A local model's first call loads it into memory, which on a laptop can take far longer than a
// hosted call, so it gets a longer first wait and, when that runs out, one more try (the model is usually loaded by then).
// Per desk: kv 'testLimits' (tests use short ones).
const TEST_LIMITS = { hosted: 90000, localFirst: 150000, localRetry: 60000 };
const NOT_CHAT = /embed|tts|audio|image|imagen|veo|aqa|whisper|moderation|guard|rerank|transcri|speech|dall-e|learnlm|computer-use/i;

export async function activate(ctx) {
  const S = (k) => ctx.settings.get(k);
  let lastHardware = ctx.kv.get('hardware', null);
  let lock = Promise.resolve();
  const serial = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };
  const tests = () => ctx.kv.get('tests', {});
  const tkey = (provider, model, keyId) => [provider, model || '', keyId || ''].join('|');

  // ---------- the router
  function upstreams() {
    const list = rawUpstreams();
    return list.map(u => ({ id: u.id, name: u.name, baseUrl: u.baseUrl, models: u.models || [], liveModels: !!u.liveModels, noTools: u.noTools || [], enabled: u.enabled !== false, limit: UPSTREAM_TERMS[u.id]?.limit || u.limit || '', terms: UPSTREAM_TERMS[u.id]?.terms || 'No statement on keeping prompts, so treat it as logging.', logsOrTrains: UPSTREAM_TERMS[u.id]?.logsOrTrains ?? u.logsOrTrains ?? 'unknown', signup: UPSTREAM_TERMS[u.id]?.signup || '' }));
  }
  function rawUpstreams() {
    const fr = typeof ctx.model.freeRouter === 'function' ? ctx.model.freeRouter().upstreams : S('router.upstreams');
    return Array.isArray(fr) && fr.length ? fr : BUILTIN_UPSTREAMS;
  }
  async function routerStatus() {
    const enabled = S('router.enabled') !== false;
    const baseUrl = S('router.baseUrl');
    const builtinOn = S('router.builtin') !== false;
    const own = enabled ? await ctx.model.routerModels() : { ok: false, error: 'off', models: [] };
    const ups = upstreams();
    const mode = !enabled ? 'off' : own.ok ? 'owner' : builtinOn ? 'builtin' : 'none';
    const models = mode === 'owner' ? own.models : mode === 'builtin' ? ups.filter(u => u.enabled).flatMap(u => u.models) : [];
    const line = mode === 'off' ? `${ROUTER_NAME.short} is switched off.`
      : mode === 'owner' ? `Your own router answers at ${baseUrl} with ${own.models.length} models.`
      : mode === 'builtin' ? `No router of your own answers at ${baseUrl}, so the built-in free hosts are used: ${ups.filter(u => u.enabled).map(u => u.name).join(', ') || 'none switched on'}.`
      : `No router of your own answers at ${baseUrl}, and the built-in free hosts are off.`;
    const t = tests(); const upTests = Object.fromEntries(ups.map(u => [u.id, t[tkey('router', 'up:' + u.id, null)] || null]));
    return { name: ROUTER_NAME.full, shortName: ROUTER_NAME.short, raw: rawUpstreams(), cooling: typeof ctx.model.routerCooling === 'function' ? ctx.model.routerCooling() : {}, tests: upTests, enabled, baseUrl, builtin: builtinOn, ownerAnswers: !!own.ok, ownerError: own.ok ? null : own.error, mode, models, upstreams: ups, line, online: S('online') !== false };
  }

  // ---------- providers and keys (values never leave the door; we only see labels)
  function providers() {
    const defs = ctx.model.providers(); const keys = ctx.model.keys.list();
    return Object.entries(defs).map(([id, p]) => ({
      id, name: p.name, signup: p.signup, tier: id === 'custom' ? 'paid' : (p.tier || 'paid'), freeNote: p.freeNote || null, terms: PROVIDER_TERMS[id] || 'No statement on keeping prompts, so treat it as logging.',
      paidOff: id === 'openrouter' && !openrouterPaid(), paidOn: id === 'openrouter' && openrouterPaid(), paid: paidKind(id, p), listsWithoutKey: !!providersFile.providers[id]?.listsWithoutKey, defaultModel: S(`provider.${id}.model`) || p.defaultModel, builtinModel: p.defaultModel,
      models: knownModels(id),
      keys: (keys[id] || []).map(k => ({ id: k.id, label: k.label, enabled: k.enabled, created: k.created, fromEnv: !!k.fromEnv, baseUrl: k.meta?.baseUrl || null, model: k.meta?.model || null, test: tests()[tkey(id, null, k.id)] || null })),
    }));
  }
  function knownModels(pid) {
    const def = providersFile.providers[pid] || {}; const keys = ctx.model.keys.list()[pid] || [];
    const list = [S(`provider.${pid}.model`), def.defaultModel, ...(def.altModels || []), ...keys.map(k => k.meta?.model), ...(ctx.kv.get('fetchedModels', {})[pid] || [])].filter(Boolean);
    const out = [...new Set(list)];
    return pid === 'openrouter' && !openrouterPaid() ? out.filter(m => /:free$/.test(m) || m === 'openrouter/free') : out;
  }
  function openrouterPaid() { return S('openrouter.allowPaid') === true; }
  /** 'switch': free models unless the owner switches paid on (OpenRouter). 'always': adding a key means paying.
   *  'account': a free tier on the same key; billing is between the owner and that provider. null: the owner's own server. */
  function paidKind(id, p) { return id === 'openrouter' ? 'switch' : id === 'custom' ? null : (p.tier || 'paid') === 'paid' ? 'always' : 'account'; }
  /** The whole list for the Default model box: live from the provider (OpenRouter needs no key), else the suggested ones. */
  async function catalog(pid) {
    if (!providersFile.providers[pid]) throw new Error('Unknown provider.');
    const c = await ctx.model.modelCatalog(pid);
    const suggested = knownModels(pid).map(id => ({ id, price: pid === 'openrouter' && /:free$/.test(id) ? 'free' : null }));
    const name = providersFile.providers[pid].name;
    const why = !c.error ? null : /fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|No answer within/i.test(c.error) ? `Could not reach ${name} just now.` : /HTTP 401|HTTP 403/.test(c.error) ? `${name} refused the key for its model list.` : c.error;
    if (!c.ok || !c.models.length) return { provider: pid, source: 'suggested', models: suggested, needsKey: !!c.needsKey, error: why, at: null, total: suggested.length, hiddenPaid: 0 };
    const chat = c.models.filter(m => !NOT_CHAT.test(m.id));
    const ids = new Set(chat.map(m => m.id));
    const mine = suggested.filter(m => m.id === S(`provider.${pid}.model`) && !ids.has(m.id));   // the saved default stays visible
    return { provider: pid, source: 'live', models: [...mine, ...chat], needsKey: false, error: null, at: c.at, total: c.total, hiddenPaid: c.hiddenPaid || 0 };
  }

  // ---------- one real test call through the door
  const limits = () => ({ ...TEST_LIMITS, ...(ctx.kv.get('testLimits', {}) || {}) });
  const isLocal = (p) => p === 'ollama' || p === 'llama';   // a model on this PC: the longer first wait and one more try
  /** One call with its own wait. A wait that runs out is told apart from a provider error. */
  async function oneTry(pick, ms) {
    const timer = AbortSignal.timeout(ms + 2000);   // the door's own wait (timeoutMs) normally ends it first
    try { return { r: await ctx.model.chat({ model: pick, messages: TEST_PROMPT, purpose: 'small', signal: timer, timeoutMs: ms, deadlineMs: ms + 1000 }) }; }
    catch (e) {
      const last = e.attempts?.at(-1)?.error || '';
      const late = timer.aborted || /No answer within|aborted due to timeout|timeout/i.test(last + ' ' + e.message);
      return { e, late };
    }
  }
  async function testOne({ provider, model = null, keyId = null, upstream = null }) {
    return serial(async () => {
      if (!provider) throw new Error('Pick a provider to test.');
      if (upstream) { const u = upstreams().find(x => x.id === upstream); model = model || u?.models?.[0] || null; }
      if (keyId && !(ctx.model.keys.list()[provider] || []).some(k => k.id === keyId)) throw new Error('That key is gone.');
      const L = limits(); const local = isLocal(provider);
      const pick = { provider, model, ...(keyId ? { keyId } : {}), ...(upstream ? { via: upstream } : {}) };
      const t0 = Date.now(); let out; let tries = 1;
      let got = await oneTry(pick, local ? L.localFirst : L.hosted);
      if (local && got.late) { tries = 2; got = await oneTry(pick, L.localRetry); }
      const at = new Date().toISOString();
      if (got.r) {
        const r = got.r; const said = String(r.text || '').trim();
        const same = r.provider === provider && (!upstream || r.via === upstream);
        // A hosted service may answer its own error as text ("budget reached"): its reply must be the word we asked for.
        // A model on this PC has no host in between, so any short reply it gives is an answer, shown with what it said.
        const real = local ? said.length > 0 && said.length < 400 : /\bready\b/i.test(said) && said.length < 400;
        const ok = same && real;
        out = { ok, provider, model: r.model, label: r.label, ms: r.ms, reply: said.slice(0, 80), at, tries, local,
          ...(local && ok && !/\bready\b/i.test(said) ? { said: said.slice(0, 80) } : {}),
          error: !same ? `Answered by ${r.label}, not by the provider under test.` : !real ? (said ? `It answered with something else: "${said.slice(0, 120)}"` : 'It answered with nothing.') : null };
      } else {
        const e = got.e; const ms = local ? (tries === 2 ? L.localRetry : L.localFirst) : L.hosted;
        let error = got.late ? `No answer within ${seconds(ms)}.` + (local ? ' The model may still be loading; try again in a minute.' : '') : testReason(e);
        out = { ok: false, provider, model, label: ctx.model.label(provider, model), ms: Date.now() - t0, at, tries, local, error, code: e.code || null };
      }
      const all = tests(); all[tkey(provider, upstream ? 'up:' + upstream : null, keyId)] = out; ctx.kv.set('tests', all);
      ctx.events.emit('models', { change: 'test', provider, ok: out.ok });
      return out;
    });
  }
  /** Is this Ollama model in memory already? (Ollama's /api/ps.) The page shows "Loading the model…" while it is not. */
  async function ollamaLoaded(model) {
    try {
      const r = await ctx.fetch(ollamaBase() + '/api/ps', { signal: AbortSignal.timeout(2000) }); if (!r.ok) return { loaded: false };
      const j = await r.json(); const names = (j.models || []).map(m => m.name || m.model);
      return { loaded: model ? names.includes(model) : names.length > 0 };
    } catch { return { loaded: false }; }
  }
  async function activeList() {
    const act = await ctx.model.active(); const t = tests();
    return act.map(a => ({ ...a, models: a.provider === 'ollama' ? safeFirst(a.models || []) : a.models, test: t[tkey(a.provider, null, null)] || null }));
  }
  async function testAll() {
    const act = (await ctx.model.active()).filter(a => a.provider !== 'ollama' || a.ok);
    const out = [];
    for (const a of act) out.push(await testOne({ provider: a.provider }));
    return out;
  }

  // ---------- what the pickers may offer: only reachable or installed models
  /** model -> reason, for models that failed their last real call (door's last call, or our last Test), newest result wins. */
  async function failing() {
    const seen = new Map();
    const note = (provider, model, ok, at, error) => { if (!model) return; const k = provider + '|' + model; const cur = seen.get(k); if (!cur || cur.at < at) seen.set(k, { ok, at, error }); };
    for (const a of await ctx.model.active()) if (a.last) note(a.provider, a.last.model, a.last.ok, a.last.at, a.last.error);
    for (const t of Object.values(tests())) note(t.provider, t.model, t.ok, t.at, t.error);
    for (const c of ctx.model.usage().recent || []) note(c.provider, c.model, !!c.ok, c.at, c.error);    // every real call the door made, fallbacks included
    const out = {};
    for (const [k, v] of seen) if (!v.ok && Date.now() - new Date(v.at).getTime() < 20 * 60000) { const [p, ...m] = k.split('|'); (out[p] ||= {})[m.join('|')] = /429|quota|rate|too many requests/i.test(v.error || '') ? 'out of quota now' : 'not answering now'; }
    return out;
  }
  function chainLabel() {
    const names = { router: ROUTER_NAME.short, ollama: 'Ollama', keyed: 'your other keys' };
    const parts = (S('model.defaultChain') || ['router', 'ollama', 'keyed']).map(x => names[x] || providersFile.providers[x]?.name?.replace(/^Google /, '') || x);
    return 'Desk default (' + [...new Set(parts)].join(', then ') + ')';
  }
  async function keyedModels(pid) {
    let listed = [];
    try { listed = (typeof ctx.model.listModels === 'function' ? await ctx.model.listModels(pid) : []) || []; } catch { listed = []; }   // a 429 on /models must not empty the picker
    const known = knownModels(pid);
    const chat = listed.filter(m => !NOT_CHAT.test(m));
    // The catalog's picks first (when the provider lists them, or lists nothing), then what the provider lists.
    const first = chat.length ? known.filter(m => chat.includes(m) || m === S(`provider.${pid}.model`)) : known;
    const out = [...new Set([...first, ...chat])];
    return out.length ? out : known;
  }
  async function available() {
    const groups = []; const bad = await failing();
    const rs = await routerStatus();
    if (S('online') !== false && (rs.mode === 'owner' || rs.mode === 'builtin')) groups.push({ provider: 'router', label: ROUTER_NAME.full, models: ['auto', ...rs.models] });
    const o = await ctx.model.ollamaModels();
    if (o.ok) groups.push({ provider: 'ollama', label: 'Ollama on this PC', models: safeFirst((o.models || []).map(m => m.name).filter(n => !/embed|bge|minilm/i.test(n))) });
    const le = (await ctx.model.active()).find(a => a.provider === 'llama' && a.ok);   // the desk's own llama-server, once installed and on
    if (le) groups.push({ provider: 'llama', label: `Local model on this PC (${le.name})`, models: le.models });
    if (S('online') !== false) for (const p of providers()) if (p.keys.some(k => k.enabled)) {
      // Drop a keyed provider only when every enabled key was refused outright (a bad key). Over quota or not answering: keep it, marked.
      const refused = p.keys.filter(k => k.enabled).every(k => k.test && !k.test.ok && /refused/i.test(k.test.error || ''));
      if (!refused) groups.push({ provider: p.id, label: p.name, models: await keyedModels(p.id) });
    }
    for (const n of S('network.lanNodes') || []) if (n?.enabled !== false && n?.baseUrl) groups.push({ provider: 'lan:' + n.id, label: 'LAN · ' + (n.name || n.baseUrl), models: [n.model || 'auto'] });
    return groups.filter(g => g.models.length).map(g => {
      const failing = bad[g.provider] || {};
      const marked = g.models.filter(m => failing[m]);
      const note = g.provider !== 'router' && marked.length && marked.length === g.models.length
        ? (marked.every(m => /quota/.test(failing[m])) ? `${g.label} is over its free quota right now; it will be tried again automatically.` : `${g.label} is not answering right now; it will be tried again automatically.`)
        : null;
      return { ...g, failing, note };
    });
  }

  // ---------- Ollama: list, pull, delete
  const ollamaBase = () => String(S('ollama.baseUrl') || 'http://127.0.0.1:11434').replace(/\/$/, '');
  async function ollama() {
    const o = await ctx.model.ollamaModels();
    if (!o.ok) return { ok: false, line: OLLAMA_FIX, models: [] };
    return { ok: true, line: `Ollama answers at ${ollamaBase()} with ${o.models.length} model${o.models.length === 1 ? '' : 's'}.`, models: safeFirst(o.models, m => m.name) };
  }
  // where Ollama fetches a model from: the host named in it (hf.co/...), else Ollama's own registry
  const modelHost = (model) => /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\//i.exec(model)?.[1].toLowerCase() || 'registry.ollama.ai';
  async function pull(model, { agentId = null, chatId = null } = {}) {
    model = String(model || '').trim();
    if (!/^[\w.\-/:]+$/.test(model)) throw new Error('That does not look like an Ollama model name, for example qwen3:14b.');
    return ctx.jobs.start({ kind: 'models.pull', title: `Download ${model}`, agentId, chatId, input: { model }, async run(job) {
      job.waiting('Waiting for you to allow the download');
      const d = await ctx.approval.request({ agentId, chatId, jobId: job.id, action: 'install', title: `Download the local model ${model}`, detail: 'Downloaded by Ollama on this PC.', from: modelHost(model), payload: { model }, signal: job.signal });
      if (!d.ok) throw new Error(d.reason === 'denied' ? 'You said no to the download.' : `Not downloaded (${d.reason}).`);
      job.resumed('Downloading');
      const r = await ctx.fetch(ollamaBase() + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: job.signal });
      if (!r.ok) throw new Error(r.status === 404 ? OLLAMA_FIX : `Ollama said HTTP ${r.status}.`);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let last = '';
      for (;;) {
        job.throwIfStopped();
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw new Error('Ollama: ' + j.error);
          last = j.status || last;
          if (j.total) job.progress(j.completed / j.total * 0.99, `${last} · ${Math.round(j.completed / 1e6)} of ${Math.round(j.total / 1e6)} MB`); else job.progress(0.01, last);
        }
      }
      if (!/success/i.test(last)) throw new Error('The download ended early: ' + (last || 'no reply'));
      ctx.events.emit('models', { change: 'ollama' });
      return { model, done: true };
    } });
  }
  async function removeModel(model) {
    return ctx.jobs.start({ kind: 'models.delete', title: `Remove ${model}`, input: { model }, async run(job) {
      job.waiting('Waiting for you');
      const d = await ctx.approval.request({ jobId: job.id, action: 'custom', title: `Remove the local model ${model} from Ollama`, detail: 'Frees its space on disk. It can be downloaded again.', payload: { model }, signal: job.signal });
      if (!d.ok) throw new Error('Not removed.');
      job.resumed('Removing');
      const r = await ctx.fetch(ollamaBase() + '/api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: job.signal });
      if (!r.ok) throw new Error(`Ollama said HTTP ${r.status}.`);
      ctx.events.emit('models', { change: 'ollama' });
      return { model, removed: true };
    } });
  }

  // ---------- LoRAs and adapters
  async function adaptersInOllama() {
    const o = await ctx.model.ollamaModels(); if (!o.ok) return { ok: false, items: [] };
    const items = [];
    for (const m of o.models.slice(0, 40)) {
      try {
        const r = await ctx.fetch(ollamaBase() + '/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }) });
        if (!r.ok) continue; const j = await r.json();
        for (const line of String(j.modelfile || '').split('\n')) { const a = line.match(/^\s*ADAPTER\s+(.+)$/i); if (a) items.push({ model: m.name, adapter: path.basename(a[1].trim()) }); }
      } catch {}
    }
    return { ok: true, items };
  }
  function scanFolder(dir, depth = 3) {
    const found = [];
    const walk = (d, n) => {
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      if (ents.some(e => e.name === 'adapter_config.json')) found.push({ name: path.basename(d), path: d, kind: 'PEFT adapter folder', size: ents.filter(e => e.isFile()).reduce((s, e) => { try { return s + fs.statSync(path.join(d, e.name)).size; } catch { return s; } }, 0) });
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && n > 0 && !e.name.startsWith('.')) walk(p, n - 1);
        else if (e.isFile() && /\.(gguf|safetensors)$/i.test(e.name) && /lora|adapter/i.test(e.name)) { let size = 0; try { size = fs.statSync(p).size; } catch {} found.push({ name: e.name, path: p, kind: /\.gguf$/i.test(e.name) ? 'GGUF adapter (Ollama can use it)' : 'safetensors adapter', size }); }
        if (found.length > 200) return;
      }
    };
    walk(dir, depth); return found;
  }
  async function scanLoraFolder(folder) {
    folder = path.resolve(String(folder || ''));
    return ctx.jobs.start({ kind: 'models.lora', title: 'Look for LoRA adapters', input: { folder }, async run(job) {
      const d = await ctx.approval.request({ jobId: job.id, action: 'file.read.outside', title: 'Look for LoRA adapters in a folder', detail: folder, payload: { path: folder }, signal: job.signal });
      if (!d.ok) throw new Error('Not allowed to open that folder.');
      if (!fs.existsSync(folder)) throw new Error('That folder does not exist.');
      const items = scanFolder(folder);
      ctx.kv.set('loraFolder', { folder, items, at: new Date().toISOString() });
      return { folder, count: items.length };
    } });
  }

  // ---------- LAN nodes and LiteLLM
  async function probeModels(baseUrl, ms = 3000) {
    try {
      const r = await ctx.fetch(baseUrl.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(ms) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const j = await r.json(); return { ok: true, models: (j.data || j.models || []).map(m => m.id || m.name || m).filter(x => typeof x === 'string') };
    } catch (e) { return { ok: false, error: e.code === 'offline' ? 'offline' : 'does not answer' }; }
  }
  async function litellm() {
    let p = await probeModels(LITELLM_URL + '/v1', 1500);
    if (!p.ok && /HTTP 40[13]/.test(p.error || '')) p = { ok: true, models: [], needsKey: true };   // answers, but its model list needs the master key
    const added = (ctx.model.keys.list().custom || []).some(k => String(k.meta?.baseUrl || '').startsWith(LITELLM_URL));
    return { url: LITELLM_URL + '/v1', found: p.ok, needsKey: !!p.needsKey, models: p.models || [], added };
  }

  // ---------- usage
  function usage() {
    const u = ctx.model.usage();
    return { currency: S('currency'), today: (u.today || []).map(r => ({ label: ctx.model.label(r.provider, r.model), provider: r.provider, model: r.model, calls: r.calls, failed: r.calls - (r.ok || 0), cost: r.cost || 0, tokens: (r.input || 0) + (r.output || 0) })) };
  }
  async function hardware(force = false) {
    if (!lastHardware || force) { lastHardware = await hw.scan(); ctx.kv.set('hardware', lastHardware); }
    return lastHardware;
  }

  // ---------- routes
  const R = (m, p, fn) => ctx.route(m, p, async (req, res, arg) => { try { ctx.json(res, await fn(arg)); } catch (e) { ctx.json(res, { error: plainError(e) }, e.status || 400); } });
  R('GET', '/overview', async () => ({ online: S('online') !== false, active: await activeList(), router: await routerStatus(), providers: providers(), currency: S('currency') }));
  R('GET', '/active', async () => ({ online: S('online') !== false, active: await activeList() }));
  R('GET', '/router', () => routerStatus());
  R('GET', '/providers', () => ({ providers: providers() }));
  R('GET', '/catalog/:provider', ({ params }) => catalog(String(params.provider || '')));
  R('GET', '/available', async () => ({ groups: await available(), defaultLabel: chainLabel() }));
  R('POST', '/test', ({ body }) => testOne(body || {}));
  R('POST', '/test-all', async () => ({ results: await testAll() }));
  R('POST', '/test-agent', async ({ body }) => {
    const agentId = String(body?.agentId || ''); if (!ctx.agents.get(agentId)) throw new Error('No such agent.');
    try { const r = await ctx.model.chat({ agentId, messages: [{ role: 'system', content: ctx.agents.systemPrompt(agentId) }, ...TEST_PROMPT], purpose: 'small', signal: AbortSignal.timeout(90000) }); return { ok: true, label: r.label, ms: r.ms, reply: String(r.text).trim().slice(0, 80), fallbackUsed: r.fallbackUsed }; }
    catch (e) { return { ok: false, error: plainError(e) }; }
  });
  R('POST', '/keys', async ({ body }) => {
    const { provider, value, label, baseUrl, model } = body || {};
    const meta = {}; if (baseUrl) meta.baseUrl = String(baseUrl).trim().replace(/\/$/, ''); if (model) meta.model = String(model).trim();
    if (provider === 'custom' && !meta.baseUrl) throw new Error('A custom provider needs its base URL, for example http://127.0.0.1:4000/v1.');
    if (provider === 'custom' && !meta.model) {
      // Ask the server which models it has, with the key just typed (used for this one request, never kept by this module).
      try { const r = await ctx.fetch(meta.baseUrl + '/models', { headers: { authorization: 'Bearer ' + String(value || '') }, signal: AbortSignal.timeout(4000) }); if (r.ok) { const j = await r.json(); meta.model = (j.data || [])[0]?.id || ''; } } catch {}
      if (!meta.model) throw new Error('Type the model name for this server; its model list did not answer.');
    }
    const k = ctx.model.keys.add(provider, String(value || ''), String(label || '').slice(0, 60), meta);
    return { id: k.id, provider: k.provider, label: k.label, enabled: true };     // never the value
  });
  R('POST', '/keys/:id/toggle', ({ params, body }) => { ctx.model.keys.toggle(params.id, !!body?.on); return { ok: true }; });
  ctx.route('DELETE', '/keys/:id', (req, res, { params, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Keys are removed only from the desk itself.' }, 403);
    ctx.model.keys.remove(params.id); ctx.json(res, { ok: true });
  });
  R('GET', '/ollama', () => ollama());
  R('GET', '/ollama/loaded', ({ query }) => ollamaLoaded(query.model ? String(query.model) : null));
  R('POST', '/ollama/pull', ({ body }) => pull(body?.model));
  R('POST', '/ollama/delete', ({ body }) => removeModel(String(body?.model || '')));
  R('GET', '/loras', async () => ({ ollama: await adaptersInOllama(), folder: ctx.kv.get('loraFolder', null) }));
  R('POST', '/loras/scan', ({ body }) => scanLoraFolder(body?.folder));
  R('POST', '/lan/probe', async ({ body }) => probeModels(lanUrl(body?.baseUrl)));
  R('GET', '/litellm', () => litellm());
  R('GET', '/hardware', async ({ query }) => hardware(query.force === '1'));
  R('GET', '/usage', () => usage());

  ctx.tool({
    name: 'model_test', description: 'Test whether a model provider answers right now (one short real call). Without a provider, tests every active one.',
    parameters: { type: 'object', properties: { provider: { type: 'string', description: 'router, ollama, gemini, openrouter, groq, ... or lan:<id>. Leave empty for all.' }, model: { type: 'string' } } },
    async run(args) {
      const list = args.provider ? [await testOne({ provider: args.provider, model: args.model || null })] : await testAll();
      return { results: list.map(r => ({ model: r.label, answers: r.ok, seconds: Math.round(r.ms / 100) / 10, problem: r.error || undefined })) };
    },
  });
  ctx.expose({ hardware: () => hardware(), routerStatus: () => routerStatus(), test: (o) => testOne(o), available: () => available(), usage: () => usage() });
  return { async deactivate() {} };
}

export function lanUrl(u) {
  let s = String(u || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(s)) s = 'http://' + s;
  if (/:11434$/.test(s)) s += '/v1';                 // a plain Ollama address: use its OpenAI-compatible path
  return s;
}
const seconds = (ms) => { const s = Math.round(ms / 100) / 10; return `${s} second${s === 1 ? '' : 's'}`; };
/** Why a Test failed, in plain words, from the last thing the door tried. */
export function testReason(e) {
  const last = String(e?.attempts?.at(-1)?.error || '');
  const m = last || String(e?.message || e || '');
  if (/^not available$/.test(m)) return 'Not available: no working key, or the key was refused recently and is cooling down.';
  if (/answered with a notice/i.test(m)) return `It answered with something else: "${m.replace(/^.*?not a reply:\s*/i, '').slice(0, 120)}"`;
  if (/model.{0,20}loading|loading model/i.test(m)) return 'The model is still loading. Try again in a minute.';
  if (/^Empty reply/.test(m)) return 'It answered with nothing.';
  if (/HTTP 5\d\d/.test(m)) return `The provider had a problem on its side (${m.match(/HTTP 5\d\d/)[0]}). Try again later.`;
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(m + ' ' + (e?.cause?.code || ''))) return 'Nothing answers at this address.';
  return plainError(last ? new Error(last) : e);
}
export function plainError(e) {
  const m = String(e?.message || e || 'Something went wrong');
  if (/HTTP 401|HTTP 403/.test(m)) return 'The key was refused (not valid or not allowed).';
  if (/HTTP 429/.test(m)) return 'Too many requests right now. Try again in a minute.';
  const wait = m.match(/No answer within ([\d.]+) seconds/); if (wait) return `No answer within ${seconds(Number(wait[1]) * 1000)}.`;
  if (/not available/.test(m) && /No model answered/.test(m)) return 'Not available: no working key, or the key was refused recently and is cooling down.';
  if (/timeout|aborted due to timeout/i.test(m)) return 'No answer in time.';
  return m.replace(/\s*\{.*$/, '').slice(0, 220);
}
