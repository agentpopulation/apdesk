// Agent Population Desk: one loopback server. Shell, four doors, modules.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Panic } from './core/panic.js';
import { guardOutbound, offlineAllowList, hostKey } from './core/offline.js';
import { sendJson, readRaw } from './core/modules.js';
import { settingsRoutes, publicSettings } from './core/settings-routes.js';
import { openSpace } from './core/space.js';
import { otherSpace } from './core/space-context.js';
import { Updater } from './core/update.js';
import { People } from './core/people.js';

const APP = path.dirname(fileURLToPath(import.meta.url));     // <install>/app: the shell and the doors
const ROOT = path.dirname(APP);                               // <install>: app, modules, vendor, node_modules, setup, data, backups
const MIME = { '.webmanifest': 'application/manifest+json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm' };

const MANIFEST = { id: '/', name: 'AP Desk', short_name: 'AP Desk', description: 'Your desk of agents, on this PC.', start_url: '/', scope: '/', display: 'standalone', background_color: '#f1f2f4', theme_color: '#16171a',
  icons: [{ src: '/icons/apdesk.png', sizes: '256x256', type: 'image/png', purpose: 'any' }, { src: '/icons/apdesk.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] };

/** The time on a console or log line: the owner's zone with its short name; the computer's own zone when none is set or
 *  the setting is not a zone. */
export function logStamp({ zone = null, locale = null, date = new Date() } = {}) {
  const time = (z) => date.toLocaleTimeString('en-GB', { hour12: false, timeZone: z || undefined });
  const name = (z, l) => new Intl.DateTimeFormat(l || 'en-GB', { timeZone: z || undefined, timeZoneName: 'short' }).formatToParts(date).find(x => x.type === 'timeZoneName')?.value || '';
  for (const [z, l] of [[zone, locale], [zone, null], [null, null]]) { try { return `${time(z)} ${name(z, l)}`.trim(); } catch { /* a setting that is not a zone or locale: the next one */ } }
  return date.toISOString().slice(11, 19);
}
function readVersion() { for (const f of [path.join(APP, 'version.json'), path.join(ROOT, 'package.json')]) { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')).version; if (v) return v; } catch {} } return '0.0.0'; }

export async function createDesk({ dataDir = process.env.APD_DATA || path.join(ROOT, 'data'), backupsDir = process.env.APD_BACKUPS || null, port = Number(process.env.APD_PORT) || 3445, host = '127.0.0.1', quiet = false, env = process.env, modulesDir = null, modules: onlyModules = null, pairing = false } = {}) {
  // log times in the owner's zone, with the zone named (the settings are not open yet on the first lines: the PC's zone then)
  // the zone and locale are read from the settings on every line, so a change made after the start shows at once
  let logSettings = null;
  const stamp = () => logStamp({ zone: logSettings?.get('timeZone'), locale: logSettings?.get('locale') });
  const log = (...a) => { if (!quiet) console.log(stamp(), ...a); };
  // The house (contracts/PEOPLE.md): this server, pairing and the session, Panic, the offline guard, downloads, the local
  // engine and updates. It is shared by every space. Each space is one data folder with its own full core.
  const panic = new Panic();
  const version = readVersion();
  const space = openSpace({ dataDir, backupsDir: backupsDir || (process.env.APD_DATA || dataDir !== path.join(ROOT, 'data') ? path.join(dataDir, '..', path.basename(dataDir) + '-backups') : path.join(ROOT, 'backups')), panic, main: true, env, log, root: ROOT, app: APP, modulesDir, onlyModules, host, version });
  // The routes below serve the desk's main space, the only one this part opens. They reach it through `core`.
  const { core } = space;
  core.port = port;
  const { storage, settings, events, agents, approval, model, jobs, services, modules } = core;
  logSettings = settings;
  const spaces = new Set([space]);
  // The people of this PC (contracts/PEOPLE.md), kept by the house in data/desk.sqlite. Person 1, the keeper, is this
  // data folder as it is; every other person has a space of their own in data/people/<id>/work/.
  const people = new People({ dataDir });
  const keeper = people.ensureFirst(settings.get('ownerName'));
  const personSpaces = new Map([[keeper.id, space]]);   // person id -> their Work space
  const personalSpaces = new Map();                     // person id -> their Personal space, once opened
  const incognitoSpaces = new Set();                    // the live Incognito spaces (one per window that is in Incognito)
  // Offline holds in this process: outside calls are refused here, whatever a module or a browser page asks for
  // Each space may call its own local model servers (its Ollama, its LAN model nodes): its own allow list
  const allowsIn = (c) => (url) => { try { const k = hostKey(url); return !!k && offlineAllowList({ settings: c.settings, port: () => core.port }).has(k); } catch { return false; } };
  core.offlineAllows = allowsIn(core);
  // a call is judged by the space that made it; a space that is closed may call nothing
  const callerCore = () => { const k = otherSpace(); if (!k) return core; for (const s of spaces) if (s.core.spaceKey === k) return s.core; return null; };
  const unguard = guardOutbound({ isOffline: () => settings.get('online') === false, allows: (u) => !!callerCore()?.offlineAllows(u), onRefused: (u) => log('offline', 'refused a call to', u.hostname) });
  // Signed updates (contracts/UPDATES.md): one for the whole desk, checked and installed from the owner's window (settings-routes.js).
  core.updater = new Updater(core).startDaily();

  // ---- Windows. One token per window, bound to one person and so to that person's space. A desk with one person and
  // no PIN is "open": its page gets the keeper's token as before, and a read without a token answers from that space.
  const windows = new Map();       // token -> { token, personId, space: 'work'|'personal', incognito: space|null, streams }
  const openStreams = new Set();   // event streams opened with no token while the desk was open
  const issue = (personId, space = 'work', incognito = null) => { const token = crypto.randomBytes(24).toString('hex'); windows.set(token, { token, personId, space, incognito, streams: new Set() }); return token; };
  /** End one event stream: its space stops writing to it first. */
  const endStream = ({ res, events: ev }) => { for (const c of [...ev.clients]) if (c.res === res) { clearInterval(c.ping); ev.clients.delete(c); } try { res.end(); } catch {} };
  // Ending a window that is in Incognito drops that Incognito space: its spend is carried back as one amount-only row,
  // its in-memory database is thrown away and its scratch folder deleted (dropIncognito). Returns a promise when it did.
  const endWindow = (token) => { const w = windows.get(token); if (!w) return null; windows.delete(token); for (const st of w.streams) endStream(st); return w.incognito ? dropIncognito(w.incognito) : null; };
  const endPerson = (personId) => { const ps = []; for (const [token, w] of [...windows]) if (w.personId === personId) { const p = endWindow(token); if (p) ps.push(p); } return Promise.all(ps); };
  const isOpen = () => people.count() === 1 && !people.keeper()?.hasPin;
  /** After a change that may end "open": a stream with no token no longer belongs to anyone. */
  const closedNow = () => { if (isOpen()) return; for (const st of [...openStreams]) endStream(st); openStreams.clear(); };
  let session = issue(keeper.id);     // the keeper's window token; the shell page carries it while the desk is open
  const pageToken = () => { if (!isOpen()) return ''; if (!windows.has(session)) session = issue(keeper.id); return session; };
  const reqWindow = new WeakMap();
  const windowOf = (req) => { if (reqWindow.has(req)) return reqWindow.get(req); const t = req.headers['x-apd-session']; return (typeof t === 'string' && windows.get(t)) || null; };
  // The space a window answers from: its Incognito space while it is in Incognito, else its person's Work or Personal space.
  const realSpaceOf = (w) => (w.space === 'personal' ? personalSpaces.get(w.personId) : personSpaces.get(w.personId)) || null;
  const spaceOfWindow = (w) => (w ? (w.incognito || realSpaceOf(w)) : null);
  /** Any person who has entered (house routes: Panic's Resume, pairing). */
  const sessionOk = (req) => !!windowOf(req);
  /** The token of a person whose space is sp (that space's routes). */
  const sessionFor = (sp) => (req) => { const w = windowOf(req); return !!w && spaceOfWindow(w) === sp; };
  const isKeeper = (req) => { const w = windowOf(req); return !!w && !!people.get(w.personId)?.keeper; };
  const KEEPER_NO = 'Only the keeper of this PC can do that.';

  // ---- Paired browsers. The desk hands its page (and so its session) only to a browser it knows. The first browser
  // to open a fresh desk is remembered by a cookie; any other browser must type the code shown in the desk's own
  // window. Another program on this PC, or code an agent runs, gets no session and no data: only Panic stays open.
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const knownBrowsers = () => { const v = settings.get('security.browsers'); return Array.isArray(v) ? v : []; };
  const cookieOf = (req) => { const m = /(?:^|;\s*)apd_owner=([A-Za-z0-9_-]{20,})/.exec(String(req.headers.cookie || '')); return m ? m[1] : null; };
  const browserOk = (req) => { if (!pairing) return true; const c = cookieOf(req); return !!c && knownBrowsers().includes(sha(c)); };
  const pairCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const pairTries = { wrong: 0, lockedUntil: 0 };
  const rememberBrowser = (res) => { const c = crypto.randomBytes(32).toString('base64url'); settings.set('security.browsers', [...knownBrowsers(), sha(c)].slice(-20)); res.setHeader('set-cookie', `apd_owner=${c}; HttpOnly; SameSite=Strict; Path=/; Max-Age=315360000`); };
  const pairPage = (note) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AP Desk</title><style>body{margin:0;height:100vh;display:grid;place-items:center;background:#f1f2f4;color:#16171a;font:15px -apple-system,"Segoe UI",system-ui,sans-serif}form{background:#fff;border:1px solid #e1e3e8;border-radius:16px;padding:26px;max-width:420px;display:flex;flex-direction:column;gap:12px}h1{font-size:20px;margin:0}p{margin:0;color:#5d626e}input{font:inherit;font-size:22px;letter-spacing:.2em;padding:10px 14px;border:1px solid #e1e3e8;border-radius:10px;text-align:center}button{font:inherit;background:#0a5fd6;color:#fff;border:0;border-radius:10px;padding:10px;cursor:pointer}.n{color:#c8261c}</style></head><body><form method="post" action="/pair"><h1>Open the desk in this browser</h1><p>This browser has not opened your desk before. Type the six-digit code shown in the desk's own window (the one start.bat opened), or under Show code in Settings › Security in a browser that already opens the desk.</p>${note ? `<p class="n">${note}</p>` : ''}<input name="code" inputmode="numeric" autocomplete="off" maxlength="7" autofocus aria-label="Code"><button>Open the desk</button><p>Panic still works without the code: stop.bat, or the Panic button in a browser you already use.</p></form></body></html>`;
  const allowedHosts = () => new Set([`127.0.0.1:${core.port}`, `localhost:${core.port}`, `[::1]:${core.port}`]);

  const stateOf = ({ settings, approval, modules, agents, jobs }) => ({
    app: 'Agent Population Desk', version: core.version, settings: publicSettings(settings), security: approval.state(), panic: panic.state(),
    modules: modules.list(), agents: agents.list(), jobs: jobs.summary(), pendingApprovals: approval.listPending(), tools: [...modules.tools.values()].map(t => ({ name: t.name, module: t.module, description: t.description })),
  });
  const state = () => stateOf(core);
  // The code that pairs another browser, for the owner's own window only (Settings › Security, Show code): the paired
  // browser's session, and a browser's own same-origin fetch. Another program, a module's server code, a frame or a
  // page on another site never gets it. The global checks before this already need the session and a paired browser.
  const pageFetch = (req) => req.headers['sec-fetch-site'] === 'same-origin' && req.headers['sec-fetch-mode'] === 'cors' && req.headers['sec-fetch-dest'] === 'empty';
  // The routes of one space, answered from its own core (c) for the token of its person (sessionOk). The house's own
  // routes among them (houseRoute below) are answered once, from the keeper's space, for everyone.
  const routesOf = (c, sessionOk) => {
  const { storage, settings, events, agents, approval, model, jobs, services, modules } = c;
  // Home's Finished tile: only work the owner asked for. A quiet job (the desk's own upkeep) is marked in its input record.
  const ownerDone = () => storage.get("SELECT COUNT(*) AS c FROM jobs WHERE status = 'done' AND COALESCE(CASE WHEN json_valid(input) THEN json_extract(input, '$.quiet') END, 0) != 1").c;
  return {
    'POST /api/security/pair-code': (req, res) => {
      if (!sessionOk(req) || !browserOk(req) || !pageFetch(req)) return sendJson(res, { error: 'The code is shown only in Settings › Security in a browser that already opens this desk.' }, 403);
      if (!pairing) return sendJson(res, { error: 'This desk does not ask for a code: pairing is off.' }, 409);
      approval.activity({ action: 'security.code', title: 'The code to pair another browser was shown in Settings', how: 'owner' });
      res.setHeader('cache-control', 'no-store');
      sendJson(res, { code: pairCode, address: `http://${host}:${core.port}`, seconds: 60 });
    },
    'GET /api/state': (req, res) => sendJson(res, stateOf(c)),
    'GET /api/events': (req, res) => events.handle(req, res),
    'GET /api/panic': (req, res) => sendJson(res, panic.state()),
    'POST /api/panic': async (req, res, { body }) => { const hooks = await panic.stopAll(body?.reason || 'Panic'); sendJson(res, { ...panic.state(), stopped: { hooks: hooks.length, jobs: jobs.summary() } }); },
    'POST /api/panic/resume': (req, res) => { if (!sessionOk(req)) return sendJson(res, { error: 'Only the owner at this desk can resume.' }, 403); panic.resume(); sendJson(res, panic.state()); },
    'GET /api/modules': (req, res) => sendJson(res, { modules: modules.list() }),
    'POST /api/modules/:id/:onoff': async (req, res, { params }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'Modules are switched in the Module Store on this desk.' }, 403);
      if (!['on', 'off'].includes(params.onoff)) return sendJson(res, { error: 'on or off' }, 400);
      const r = await modules.set(params.id, params.onoff === 'on');    // the keeper's space answers; the switch holds for every person
      for (const sp of [...personSpaces.values(), ...personalSpaces.values()]) if (sp !== space) { try { await sp.core.modules.set(params.id, params.onoff === 'on'); } catch (e) { log('modules', params.id, e.message); } }
      sendJson(res, r);
    },
    'GET /api/agents': (req, res) => sendJson(res, { agents: agents.list() }),
    'POST /api/agents': (req, res, { body }) => { if (!body?.name) return sendJson(res, { error: 'An agent needs a name.' }, 400); sendJson(res, agents.create(body)); },
    'GET /api/agents/:id': (req, res, { params }) => { const a = agents.get(params.id); a ? sendJson(res, { ...a, resolved: model.resolve(a.id) }) : sendJson(res, { error: 'Not found' }, 404); },
    'PATCH /api/agents/:id': (req, res, { params, body }) => { const a = agents.update(params.id, body || {}); a ? sendJson(res, a) : sendJson(res, { error: 'Not found' }, 404); },
    'DELETE /api/agents/:id': (req, res, { params }) => { if (params.id === 'coordinator') return sendJson(res, { error: 'The Coordinator stays.' }, 409); agents.remove(params.id); sendJson(res, { ok: true }); },
    'GET /api/jobs': (req, res, { query }) => sendJson(res, { jobs: jobs.list({ status: query.status || undefined, limit: Number(query.limit) || 100 }), summary: jobs.summary() }),
    'GET /api/jobs/:id': (req, res, { params }) => { const j = jobs.get(params.id); j ? sendJson(res, j) : sendJson(res, { error: 'Not found' }, 404); },
    'POST /api/jobs/:id/stop': (req, res, { params }) => sendJson(res, jobs.stop(params.id)),
    'GET /api/model/active': async (req, res) => sendJson(res, { online: model.online, active: await model.active() }),
    'GET /api/model/usage': (req, res) => sendJson(res, model.usage()),
    // One plain ask straight through the model door. Streams NDJSON: {delta} lines then {done, label, model, provider}.
    'POST /api/model/ask': async (req, res, { body }) => {
      const messages = Array.isArray(body?.messages) ? body.messages : [{ role: 'user', content: String(body?.prompt || '') }];
      const sys = body?.agentId ? agents.systemPrompt(body.agentId) : null;
      const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort('closed'); });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const line = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch {} };
      try {
        const r = await model.chat({ agentId: body?.agentId, model: body?.model, purpose: 'chat', messages: sys ? [{ role: 'system', content: sys }, ...messages] : messages, signal: ac.signal, onDelta: body?.stream === false ? undefined : (t) => line({ delta: t }) });
        line({ done: true, text: r.text, label: r.label, model: r.model, provider: r.provider, ms: r.ms, attempts: r.attempts });
      } catch (e) { line({ done: true, error: e.message, code: e.code || 'error', attempts: e.attempts || [] }); }
      res.end();
    },
    // The built-in Agent Population Router, for other programs on this PC (OpenAI-compatible).
    'GET /router/v1/models': async (req, res) => { const a = (await model.active()).find(x => x.provider === 'router'); sendJson(res, { object: 'list', data: (a?.models || []).map(id => ({ id, object: 'model', owned_by: 'agent-population-router' })) }); },
    'POST /router/v1/chat/completions': async (req, res, { body }) => {
      try {
        const r = await model.chat({ model: { provider: 'router', model: body?.model && body.model !== 'auto' ? body.model : null }, messages: body?.messages || [], tools: (body?.tools || []).map(t => t.function || t), temperature: body?.temperature, maxTokens: body?.max_tokens, purpose: 'router' });
        sendJson(res, { id: 'apr-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: r.model, provider: r.via || 'router', choices: [{ index: 0, finish_reason: r.toolCalls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: r.text, ...(r.toolCalls.length ? { tool_calls: r.toolCalls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) } }], usage: { prompt_tokens: r.usage?.input || 0, completion_tokens: r.usage?.output || 0, total_tokens: (r.usage?.input || 0) + (r.usage?.output || 0) } });   // strict OpenAI clients need all three
      } catch (e) { sendJson(res, { error: { message: e.message, code: e.code || 'error' } }, e.code === 'halted' ? 503 : 502); }
    },
    // Keys for dedicated services (search, voice and audio). Values never come back; only the owner adds or removes.
    'GET /api/keys/services': (req, res) => sendJson(res, { services: services.list(), note: services.catalog().alsoAudio }),
    'POST /api/keys/services/:id': (req, res, { params, body }) => { if (!sessionOk(req)) return sendJson(res, { error: 'Keys are added at this desk.' }, 403); if (typeof body?.enabled === 'boolean' && !body.value) services.toggle(params.id, body.enabled); else services.set(params.id, body?.value); sendJson(res, { services: services.list() }); },
    'DELETE /api/keys/services/:id': (req, res, { params }) => { if (!sessionOk(req)) return sendJson(res, { error: 'Keys are removed at this desk.' }, 403); services.remove(params.id); sendJson(res, { services: services.list() }); },
    'GET /api/home': (req, res) => sendJson(res, { jobs: { running: jobs.list({ status: 'running', limit: 10 }), waiting: jobs.list({ status: 'waiting', limit: 10 }), done: jobs.list({ status: 'done', limit: 8 }), summary: { ...jobs.summary(), done: ownerDone() } }, approvals: approval.listPending(), agents: agents.list().length, recent: modules.api('chat')?.recent?.(6) || [] }),
    ...settingsRoutes(c, sessionOk),
  };
  };
  // Shared by everyone: pairing, Panic, the module switches, updates, downloads and the local engine, the router for
  // other programs (served from the keeper's space), and the people routes.
  const houseRoute = (k) => /^\w+ \/(router\/|api\/(update(\/|$)|panic(\/|$)|security\/pair-code$|modules\/:id\/:onoff$))/.test(k);
  const compile = (routes) => Object.entries(routes).map(([k, handler]) => { const [method, p] = k.split(' '); return { key: k, method, parts: p.split('/'), handler }; });
  const matchIn = (compiled, method, pathname) => {
    const parts = pathname.replace(/\/$/, '').split('/');
    for (const r of compiled) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params = {}; let ok = true;
      for (let i = 0; i < parts.length; i++) { if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = decodeURIComponent(parts[i]); else if (r.parts[i] !== parts[i]) { ok = false; break; } }
      if (ok) return { key: r.key, handler: r.handler, params };
    }
    return null;
  };
  const houseRoutes = compile({
    ...Object.fromEntries(Object.entries(routesOf(core, sessionOk)).filter(([k]) => houseRoute(k))),
    ...(await import('./core/downloads-routes.js')).downloadRoutes(core, sessionOk),
    ...peopleRoutes(),
  });
  const spaceTables = new WeakMap();
  const tableOf = (sp) => { let t = spaceTables.get(sp); if (!t) spaceTables.set(sp, t = compile(Object.fromEntries(Object.entries(routesOf(sp.core, sessionFor(sp))).filter(([k]) => !houseRoute(k))))); return t; };
  // The keeper's gates (contracts/PEOPLE.md): updates, module switches, Online and Offline, the local engine and model
  // downloads, people and their PINs. Anyone else is told so in one sentence.
  const KEEPER_ONLY = new Set(['POST /api/update/check', 'POST /api/update/install', 'POST /api/update/daily', 'POST /api/update/channel', 'POST /api/update/background', 'POST /api/modules/:id/:onoff',
    'POST /api/downloads/:id/pause', 'POST /api/downloads/:id/resume', 'POST /api/downloads/:id/cancel', 'POST /api/local-engine/get', 'POST /api/local-engine/choose', 'POST /api/local-engine/stop',
    'POST /api/local-engine/remove', 'POST /api/local-engine/switch', 'POST /api/local-engine/keep-loaded', 'POST /api/people', 'POST /api/people/:id/remove', 'POST /api/people/:id/reset-pin',
    'POST /api/m/models/ollama/pull', 'POST /api/m/models/ollama/delete',
    // the pairing code admits new browsers to the whole PC; paid OpenRouter spends the PC's shared key (both house-level)
    'POST /api/security/pair-code', 'POST /api/settings/paid-models']);
  const keeperOnly = (key, body) => KEEPER_ONLY.has(key) || (key === 'POST /api/settings' && !!body && typeof body === 'object' && Object.hasOwn(body, 'online'));

  const serveFile = (res, file, extraHeaders = {}) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', ...extraHeaders });
      fs.createReadStream(file).pipe(res);
    });
  };
  const inside = (root, p) => { const abs = path.resolve(root, '.' + path.posix.normalize('/' + p)); return abs === root || abs.startsWith(root + path.sep) ? abs : null; };

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { res.writeHead(400); return res.end(); }
    // loopback only: refuse foreign Host headers (DNS rebinding) and cross-site writes (a web page posting to the desk)
    if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('AP Desk answers only on this PC.'); }
    const method = req.method.toUpperCase();
    // A page on another site must not make this desk do anything, reads included (a read can make the desk fetch an address).
    { const site = req.headers['sec-fetch-site']; if (site && !['same-origin', 'none'].includes(site) && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/router/') || url.pathname.startsWith('/modules/'))) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Cross-site requests are refused.' })); } }
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin; const site = req.headers['sec-fetch-site'];
      const originOk = !origin || allowedHosts().has(origin.replace(/^https?:\/\//, '').toLowerCase());
      if (!originOk || (site && !['same-origin', 'none'].includes(site))) return sendJson(res, { error: 'Cross-site requests are refused.' }, 403);
    }
    const p = url.pathname;
    // The window this request comes from: its token (an event stream, which cannot send a header, names it in the
    // address). The space that answers is that window's person's; with no token, the keeper's while the desk is open.
    const token = req.headers['x-apd-session'] || (p === '/api/events' ? url.searchParams.get('session') : null);
    const win = (typeof token === 'string' && windows.get(token)) || null;
    reqWindow.set(req, win);
    const sp = win ? spaceOfWindow(win) : isOpen() ? space : null;
    try {
      // Every request that changes something must come from the desk's own page (it carries the session).
      // Stopping is the exception: Panic is open to anything on this PC. The router endpoint is for other local
      // programs and reaches only the free router, never a paid key. Entering is how a window gets its token.
      if (p.startsWith('/api/') && method !== 'GET' && method !== 'HEAD' && p !== '/api/panic' && p !== '/api/people/enter' && !sessionOk(req)) return sendJson(res, { error: 'This desk takes changes only from its own window.' }, 403);
      // Pairing: a browser that is not paired gets nothing but Panic and the pairing page.
      if (pairing && p === '/pair' && method === 'POST') {
        const raw = (await readRaw(req, 4096)).toString('utf8'); let code = '';
        try { code = String(JSON.parse(raw).code || ''); } catch { code = new URLSearchParams(raw).get('code') || ''; }
        code = code.replace(/\D/g, '');
        const html = (status, body) => { res.writeHead(status, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }); res.end(body); };
        if (Date.now() < pairTries.lockedUntil) return html(429, pairPage('Too many wrong codes. Wait a minute and try again.'));
        const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pairCode));
        if (!ok) { if (++pairTries.wrong >= 5) { pairTries.wrong = 0; pairTries.lockedUntil = Date.now() + 60000; } return html(403, pairPage('That code is not right.')); }
        pairTries.wrong = 0; rememberBrowser(res); approval.activity({ action: 'security.browser', title: 'A new browser was paired with the desk', how: 'owner' });
        res.writeHead(303, { location: '/' }); return res.end();
      }
      if (pairing && (p.startsWith('/api/') || p.startsWith('/modules/')) && !browserOk(req) && p !== '/api/panic') return sendJson(res, { error: 'Open the desk in its own window first.', code: 'not_paired' }, 401);
      // A paired browser with no person entered may see who is here, enter, and stop everything. Nothing else.
      if (p.startsWith('/api/') && !sp && p !== '/api/panic' && !(p === '/api/people' && method === 'GET') && !(p === '/api/people/enter' && method === 'POST')) return sendJson(res, { error: 'Choose who you are first.', code: 'no_person' }, 401);
      const target = p.startsWith('/router/') ? space : sp;   // the router for other programs is served from the keeper's space
      // Incognito refuses Bench, schedules and downloads: it remembers nothing, so these have nothing to work on and would
      // write nowhere durable. The owner is told plainly, in the same words as when they try it.
      if (target?.core.incognito && method !== 'GET' && method !== 'HEAD') {
        const no = p === '/api/m/bench/start' ? 'Bench does not run in Incognito: it remembers nothing, so there is nothing for it to look back on.'
          : (p.startsWith('/api/downloads/') || p.startsWith('/api/local-engine/')) ? 'Downloads do not run in Incognito.'
          : (p.startsWith('/api/m/flows/schedules') || p.startsWith('/api/m/flows/chains')) ? 'Schedules do not run in Incognito: the Incognito desk is dropped when you leave, so a schedule would never fire.'
          : null;
        if (no) return sendJson(res, { error: no, code: 'incognito' }, 403);
      }
      // Screen lock (Accounts and Lock module): while the desk is locked nothing answers except what is needed to
      // show the lock, unlock it, and stop everything.
      if ((p.startsWith('/api/') || p.startsWith('/router/')) && target?.core.modules.api('accounts')?.isLocked?.() === true) {
        const open = p === '/api/state' || p === '/api/events' || p === '/api/panic' || /^\/api\/m\/accounts\/(state|unlock|lock)$/.test(p);
        if (!open) return sendJson(res, { error: 'The desk is locked.', code: 'locked' }, 423);
      }
      if (p.startsWith('/api/') || p.startsWith('/router/')) {
        const query = Object.fromEntries(url.searchParams);
        const houseHit = matchIn(houseRoutes, method, p);
        const hit = !houseHit && p.startsWith('/api/m/') ? target.core.modules.match(method, p) : null;
        const coreHit = hit ? null : houseHit || matchIn(tableOf(target), method, p);
        if (!hit && !coreHit) return sendJson(res, { error: p.startsWith('/api/m/') ? 'That module is off or has no such route.' : 'Not found' }, 404);
        let body;
        const ct = String(req.headers['content-type'] || '');
        if (method !== 'GET' && method !== 'HEAD' && (ct.includes('application/json') || ct === '')) {
          const raw = await readRaw(req);
          if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, { error: 'Bad JSON' }, 400); } }
        }
        if (keeperOnly(hit ? method + ' ' + p.replace(/\/$/, '') : coreHit.key, body) && !isKeeper(req)) return sendJson(res, { error: KEEPER_NO, code: 'not_keeper' }, 403);
        const arg = { query, params: (hit || coreHit).params, body, owner: houseHit ? sessionOk(req) : sessionFor(target)(req) };
        if (hit) await hit.route.handler(req, res, arg); else await coreHit.handler(req, res, arg);
        // a window's event stream ends when its token does (leave, switch, removal); one opened with no token, when the desk stops being open
        if (p === '/api/events' && res.headersSent && !res.writableEnded) { const set = win ? win.streams : openStreams; const st = { res, events: target.core.events }; set.add(st); res.on('close', () => set.delete(st)); }
        if (!res.writableEnded && !res.headersSent) sendJson(res, { ok: true });
        return;
      }
      if (p === '/' || p === '/index.html') {
        if (pairing && !browserOk(req)) {
          if (knownBrowsers().length === 0) rememberBrowser(res);        // the first browser on a fresh desk is the owner's
          else { res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }); return res.end(pairPage('')); }
        }
        const html = fs.readFileSync(path.join(APP, 'ui', 'index.html'), 'utf8').replace('__APD_SESSION__', pageToken()).replace('__APD_VERSION__', core.version);
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; img-src 'self' data: blob: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob: data:; frame-src 'self' blob:; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' });
        return res.end(html);
      }
      if (p.startsWith('/ui/')) { const f = inside(path.join(APP, 'ui'), p.slice(4)); return f ? serveFile(res, f) : (res.writeHead(404), res.end()); }
      if (p.startsWith('/vendor/')) { const f = inside(path.join(ROOT, 'vendor'), p.slice(8)); return f && /\.(js|mjs|css|json|svg|png|woff2|map|wasm)$/.test(f) ? serveFile(res, f) : (res.writeHead(404), res.end()); }
      if (p.startsWith('/modules/')) {
        const [, , id, ...rest] = p.split('/');
        const m = modules.manifests.get(id);
        const rel = rest.join('/');
        if (!m || !modules.isOn(id) || !(rel === 'ui.js' || rel.startsWith('ui/') || /^ui[\w.-]*\.(js|css)$/.test(rel))) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Module is off'); }
        const f = inside(m.dir, rel); return f ? serveFile(res, f) : (res.writeHead(404), res.end());
      }
      // Install as app (Chrome, Edge): the manifest and its icons hold nothing private, so they need no session or paired
      // browser (a browser fetches a manifest without cookies). The installed window opens "/" like any tab: pairing holds there.
      if (p === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': MIME['.webmanifest'], 'cache-control': 'no-cache' }); return res.end(JSON.stringify(MANIFEST)); }
      if (p === '/icons/apdesk.svg' || p === '/icons/apdesk.png') return serveFile(res, path.join(ROOT, 'setup', 'assets', path.basename(p)));
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
    } catch (e) {
      log('http', method, p, e?.status && e.status < 500 ? String(e.message || e) : (e?.stack || e));   // an expected refusal is one line; only a real fault prints its stack
      if (!res.headersSent) sendJson(res, { error: String(e?.message || e), code: e?.code || undefined }, e?.status || (e?.code === 'halted' ? 503 : 500));
      else try { res.end(); } catch {}
    }
  });

  /** Tests only (node --test): a second space on another data folder, in this process. No route, setting or tool reaches it. */
  /** A space other than the keeper's, on its own data folder, in this process. */
  const openOther = (dir, backups, extra = {}) => {
    const other = openSpace({ dataDir: dir, backupsDir: backups, panic, main: false, houseSettings: settings, houseStorage: storage, env, log, root: ROOT, app: APP, modulesDir, onlyModules, host, version, ...extra });
    Object.defineProperty(other.core, 'port', { get: () => core.port, enumerable: true });
    other.core.offlineAllows = allowsIn(other.core);
    other.core.restart = (reason) => core.restart(reason);
    other.core.model.localEngine = core.localEngine;
    spaces.add(other);
    const close = other.close;
    other.close = async () => { if (!spaces.delete(other)) return; await close(); };
    return other;
  };
  /** Tests only (node --test): a second space on another data folder, in this process. No route, setting or tool reaches it. */
  const openTestSpace = async ({ dataDir: dir } = {}) => {
    if (!process.env.NODE_TEST_CONTEXT) throw new Error('A second space is for node --test only in this version.');
    const other = openOther(dir, path.join(dir, '..', path.basename(dir) + '-backups'));
    await other.start();
    return other;
  };
  // Every person's space opens when the desk starts, so their jobs, schedules and Bench run while someone else is at the desk.
  const openPerson = (id) => { const dir = people.folderOf(id); const sp = openOther(dir, path.join(path.dirname(dir), 'backups')); personSpaces.set(id, sp); return sp; };
  // A person's Personal space, its own data folder and its own backups folder beside Work. Opened at desk start if it
  // exists, else on first switch.
  const openPersonal = (id) => { const dir = people.folderOf(id, 'personal'); const sp = openOther(dir, path.join(path.dirname(dir), 'personal-backups')); personalSpaces.set(id, sp); return sp; };
  // Incognito (contracts/PEOPLE.md): a full space on an in-memory database with a scratch workspace folder. It reads none
  // of the person's real data and starts empty; spend is the one carry-over, counted on the space the person came from.
  const openIncognito = async (fromSpace, personId) => {
    const scratch = path.join(dataDir, 'people', personId, '.incognito-' + crypto.randomBytes(6).toString('hex'));
    const inc = openOther(scratch, path.join(scratch, 'backups'), { memory: true, incognito: { personId, scratch } });
    inc.core.approval.spendCarry = fromSpace.core.approval;   // Incognito cannot get around the person's spend limits
    incognitoSpaces.add(inc);
    await inc.start();
    return inc;
  };
  /** Leaving Incognito (lock, switch or close): carry the spend back as one amount-only row, drop the in-memory
   *  database and delete the scratch folder. Deleting the scratch files is not a secure wipe on an SSD (said on screen). */
  const dropIncognito = async (inc) => {
    if (!incognitoSpaces.delete(inc)) return;
    try { inc.core.approval.spendCarry?.noteIncognitoSpend(inc.core.approval.incognitoSpendTotal()); } catch (e) { log('incognito', 'spend carry', e?.message || e); }
    const scratch = inc.core.incognito?.scratch;
    try { await inc.close(); } catch (e) { log('incognito', 'close', e?.message || e); }
    if (scratch) try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { log('incognito', 'wipe scratch', e?.message || e); }
  };
  for (const p of people.list()) {
    if (p.id !== keeper.id) openPerson(p.id);
    // A scratch folder left behind by a crash holds no durable value: wipe it. Then open any Personal space.
    for (const dir of people.incognitoScratch(p.id)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { log('incognito', 'wipe stale', e?.message || e); } }
    if (people.hasPersonal(p.id)) openPersonal(p.id);
  }

  // ---- The people routes (house). Who is here and entering need no token; the rest are the window's own person's.
  function peopleRoutes() {
    const me = (req) => windowOf(req);
    const noteIn = (id, title, action = 'people.pin') => { try { personSpaces.get(id)?.core.approval.activity({ action, title, how: 'desk' }); } catch {} };
    /** A PIN check that failed: a wait, or a wrong PIN that goes in that person's activity log. */
    const refused = (res, id, r) => {
      if (r.waiting) return sendJson(res, { error: `Too many wrong tries. Wait ${r.waitSeconds} seconds, then try again.`, waitSeconds: r.waitSeconds }, 429);
      noteIn(id, 'A wrong PIN was typed for you at the desk', 'people.pin.wrong');
      return sendJson(res, { error: 'That PIN is not right.', waitSeconds: r.waitSeconds }, 403);
    };
    const keeperPinOk = async (req, res, pin) => {
      const k = people.keeper();
      if (!k.hasPin) { sendJson(res, { error: 'Set your own PIN first, so no one else can enter as the keeper.' }, 409); return false; }
      const r = await people.verify(k.id, pin); if (r.ok) return true;
      refused(res, k.id, r); return false;
    };
    const entered = (res, id, token) => sendJson(res, { token, person: people.get(id), notice: people.takeNotice(id) });
    const spacesOf = (id) => people.hasPersonal(id) ? ['work', 'personal'] : ['work'];
    // What cannot be undone, said plainly on the Incognito screen (contracts/PEOPLE.md, section 8).
    const INCOGNITO_CAUTIONS = [
      'Incognito leaves nothing on this desk: when you leave, its chats, memory, visit log, ratings and approvals are dropped and its scratch files deleted.',
      'What you do still leaves the desk. A mail you approve is still sent and sits in the provider’s Sent folder. A site still saw your visit. Money spent is spent.',
      'Spend still counts. The amount is added to your own day and month totals, so Incognito cannot get around your spend limits.',
      'Outbound still goes through the address guard and your website rules; approvals still apply; Panic still stops it.',
      'Deleting the Incognito scratch files is not a secure wipe on an SSD.',
    ];
    return {
      'GET /api/people': (req, res) => sendJson(res, { people: people.list().map(p => ({ ...p, waiting: personSpaces.get(p.id)?.core.approval.listPending().length || 0, spaces: spacesOf(p.id) })), you: me(req)?.personId || null, incognito: !!me(req)?.incognito }),
      'GET /api/people/me': (req, res) => {
        const w = me(req); if (!w) return sendJson(res, { error: 'Choose who you are first.', code: 'no_person' }, 401);
        const incognito = !!w.incognito;
        sendJson(res, { person: people.get(w.personId), theme: spaceOfWindow(w).core.settings.get('theme'), space: incognito ? 'incognito' : w.space, incognito, spaces: spacesOf(w.personId), ...(incognito ? { cautions: INCOGNITO_CAUTIONS } : {}) });
      },
      'POST /api/people/enter': async (req, res, { body }) => {
        const id = String(body?.id || ''); if (!people.get(id)) return sendJson(res, { error: 'No such person on this desk.' }, 404);
        const r = await people.verify(id, body?.pin); if (!r.ok) return refused(res, id, r);
        entered(res, id, issue(id));
      },
      'POST /api/people/leave': async (req, res) => { await endWindow(me(req).token); sendJson(res, { ok: true }); },
      'POST /api/people/switch': async (req, res, { body }) => {
        const id = String(body?.id || ''); if (!people.get(id)) return sendJson(res, { error: 'No such person on this desk.' }, 404);
        const r = await people.verify(id, body?.pin); if (!r.ok) return refused(res, id, r);
        const was = me(req).token; const token = issue(id); await endWindow(was);   // leaving Incognito here drops it
        entered(res, id, token);
      },
      // Work and Personal of the same person: the PIN was already given for this person, so no PIN here. A person with only
      // Work never calls this. Leaving Incognito by switching space drops the Incognito space.
      'POST /api/people/me/space': async (req, res, { body }) => {
        const w = me(req); const which = body?.space === 'personal' ? 'personal' : body?.space === 'work' ? 'work' : null;
        if (!which) return sendJson(res, { error: 'Choose Work or Personal.' }, 400);
        if (which === 'personal' && !personalSpaces.has(w.personId)) await openPersonal(w.personId).start();
        const token = issue(w.personId, which, null); await endWindow(w.token);
        const sp = (which === 'personal' ? personalSpaces : personSpaces).get(w.personId);
        sendJson(res, { token, person: people.get(w.personId), space: which, spaces: spacesOf(w.personId), theme: sp.core.settings.get('theme') });
      },
      // Open an Incognito space for the person in this window. A full space on an in-memory database with a scratch folder.
      'POST /api/people/incognito': async (req, res) => {
        const w = me(req);
        if (w.incognito) return sendJson(res, { error: 'This window is already in Incognito.' }, 409);
        const inc = await openIncognito(realSpaceOf(w), w.personId);
        const token = issue(w.personId, w.space, inc); await endWindow(w.token);
        sendJson(res, { token, person: people.get(w.personId), incognito: true, space: w.space, cautions: INCOGNITO_CAUTIONS });
      },
      'POST /api/people/me/pin': async (req, res, { body }) => {
        const w = me(req); const p = people.get(w.personId);
        if (p.hasPin) { const r = await people.verify(p.id, body?.current); if (!r.ok) return refused(res, p.id, r); }
        await people.setPin(p.id, body?.pin);
        noteIn(p.id, p.hasPin ? 'Your PIN was changed' : 'Your PIN was set'); closedNow();
        sendJson(res, { person: people.get(p.id) });
      },
      // A person's own looks: name, emoji, colour and theme. Every other key is refused, and then nothing changes.
      'POST /api/people/me/look': (req, res, { body }) => {
        const w = me(req); const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
        if (!keys || !keys.length || keys.some(k => !['name', 'emoji', 'colour', 'theme'].includes(k))) return sendJson(res, { error: 'Only a name, an emoji, a colour and a theme change here.' }, 400);
        if ('theme' in body && !['light', 'dark'].includes(body.theme)) return sendJson(res, { error: 'Only a light or a dark theme.' }, 400);
        const { theme, ...look } = body; const c = spaceOfWindow(w).core;
        const person = Object.keys(look).length ? people.setLook(w.personId, look) : people.get(w.personId);
        if (theme) { c.settings.set('theme', theme); c.events.emit('settings', { theme }); }
        sendJson(res, { person, theme: c.settings.get('theme') });
      },
      'POST /api/people': async (req, res, { body }) => {
        if (!people.keeper().hasPin) return sendJson(res, { error: 'Set your own PIN first, so no one else can enter as the keeper.' }, 409);
        const person = await people.add({ name: body?.name, emoji: body?.emoji, colour: body?.colour, pin: body?.pin });
        await openPerson(person.id).start(); closedNow();
        approval.activity({ action: 'people.add', title: `${person.name} was added to this desk`, how: 'keeper' });
        // The honest limit of the PIN, said plainly when a person is added: it keeps people apart, it does not protect
        // their files from another OS user or from code run here. Real separation is a separate login and disk encryption.
        sendJson(res, { person, folder: people.folderOf(person.id), note: `${person.name} gets their own chats, keys and space, kept apart by their PIN. The PIN encrypts nothing: anyone who can sign in to this PC as this user, or run a program here, can still read every person's files. For real separation give each person their own Windows account and turn on disk encryption.` });
      },
      // Removing a person detaches them: their windows end, their space closes, their folder stays where it is.
      'POST /api/people/:id/remove': async (req, res, { params, body }) => {
        const p = people.get(params.id); if (!p) return sendJson(res, { error: 'No such person on this desk.' }, 404);
        if (p.keeper) return sendJson(res, { error: 'The keeper of this PC stays.' }, 409);
        if (!(await keeperPinOk(req, res, body?.pin))) return;
        await endPerson(p.id);
        const sp = personSpaces.get(p.id); personSpaces.delete(p.id);
        const psp = personalSpaces.get(p.id); personalSpaces.delete(p.id);
        try { await sp?.close(); await psp?.close(); } finally { await endPerson(p.id); }
        const { folder } = people.remove(p.id);
        approval.activity({ action: 'people.remove', title: `${p.name} was taken off this desk`, how: 'keeper', detail: 'The folder stays: ' + folder });
        sendJson(res, { ok: true, folder, message: `${p.name} is no longer on this desk. Their folder was not deleted. It is here: ${folder}` });
      },
      'POST /api/people/:id/reset-pin': async (req, res, { params, body }) => {
        const p = people.get(params.id); if (!p) return sendJson(res, { error: 'No such person on this desk.' }, 404);
        if (!(await keeperPinOk(req, res, body?.pin))) return;
        const by = people.get(me(req).personId);
        await people.resetPin(p.id, body?.newPin, by.id);
        if (p.id !== by.id) await endPerson(p.id);
        noteIn(p.id, `Your PIN was reset by ${by.name}`, 'people.pin.reset');
        approval.activity({ action: 'people.pin.reset', title: `The PIN of ${p.name} was reset`, how: 'keeper' });
        sendJson(res, { person: people.get(p.id) });
      },
    };
  }

  core.restart = (reason) => { log('restart requested:', reason); events.emit('toast', { text: 'The desk is restarting.' }); desk.restartRequested = reason || true; if (desk.onRestart) setTimeout(() => desk.onRestart(reason), 300); };
  const desk = {
    core, server, modules, state, restartRequested: null, onRestart: null, pairCode: pairing ? pairCode : null, openTestSpace, people,
    /** The keeper's window token (the page carries it while the desk is open). */
    get session() { return session; },
    /** A person's Work (default) or Personal space, or null. For the desk and its tests; no route or module reaches it. */
    spaceOf: (id, which = 'work') => (which === 'personal' ? personalSpaces.get(id) : personSpaces.get(id)) || null,
    /** The space a window token answers from, Incognito included. For the desk and its tests; no route or module reaches it. */
    spaceForToken: (token) => { const w = windows.get(String(token || '')); return w ? spaceOfWindow(w) : null; },
    async start() {
      await space.start();
      for (const sp of [...personSpaces.values(), ...personalSpaces.values()]) if (sp !== space) await sp.start();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      core.port = server.address().port;
      log(`AP Desk ${core.version} on http://${host}:${core.port}  data: ${dataDir}`);
      // run hidden (setup/background.mjs), these lines go to data\desk.log, which any program of this user can read: the code stays out
      if (pairing) console.log(env.APD_BACKGROUND === '1' ? '\n  To open the desk in another browser, use Show code in Settings › Security.\n' : `\n  To open the desk in another browser, type this code there: ${pairCode.slice(0, 3)} ${pairCode.slice(3)}\n`);
      try { fs.writeFileSync(path.join(dataDir, 'desk.pid'), String(process.pid)); } catch {}
      return desk;
    },
    async stop() {
      unguard();
      for (const inc of [...incognitoSpaces]) await dropIncognito(inc);   // carry spend, drop RAM, wipe scratch before shutdown
      await panic.stopAll('Shutting down').catch(() => {});
      const all = [...spaces].reverse(); spaces.clear();
      for (const s of all) await s.stop();   // Panic's stop hooks of every space ran just above
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      try { fs.rmSync(path.join(dataDir, 'desk.pid'), { force: true }); } catch {}
      for (const s of all) s.core.storage.close();
      people.close();
    },
    url: () => `http://${host}:${core.port}`,
  };
  return desk;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('unhandledRejection', (e) => console.error('unhandled', e?.stack || e));
  process.on('uncaughtException', (e) => console.error('uncaught', e?.stack || e));
  const desk = await createDesk({ pairing: process.env.APD_PAIRING !== 'off' });
  try { await desk.start(); }
  catch (e) { if (e.code === 'EADDRINUSE') { console.error(`Port ${process.env.APD_PORT || 3445} is in use. AP Desk may already be running: open http://127.0.0.1:${process.env.APD_PORT || 3445}`); process.exit(2); } throw e; }
  const bye = async () => { try { await desk.stop(); } finally { process.exit(0); } };
  desk.onRestart = async () => { try { await desk.stop(); } finally { process.exit(75); } };   // start.bat starts the desk again on 75
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  // stop.bat asks for a clean stop by leaving a note in the data folder
  const stopNote = path.join(desk.core.storage.dataDir, 'stop.request');
  try { fs.rmSync(stopNote, { force: true }); } catch {}
  setInterval(() => { if (fs.existsSync(stopNote)) { try { fs.rmSync(stopNote, { force: true }); } catch {} bye(); } }, 1000).unref();
}
