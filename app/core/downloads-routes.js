// Routes for the downloads service and the local engine. Registered from app/server.js with one line:
//   ...(await import('./core/downloads-routes.js')).downloadRoutes(core, sessionOk),
// It makes core.downloads (the service) and core.localEngine (llama-server and its model, modules/models/local-engine.js),
// hands the engine to the model door as its local provider, and answers:
//   GET  /api/downloads                       every download with its state, and { active, total } for the top bar
//   POST /api/downloads/:id/pause|resume|cancel   owner only
//   GET  /api/local-engine                    the engine card: state, model, sizes, licence
//   GET  /api/local-engine/plan[?model=id][&fresh=1]   what would be downloaded for this PC (the first-start box shows this); fresh=1 scans the memory again
//   POST /api/local-engine/get { model? }     start both downloads; each asks the owner first. Owner only.
//   POST /api/local-engine/choose { model }   pick another model from the list. Owner only.
//   POST /api/local-engine/stop | remove      owner only; remove deletes <data>/llama and frees its space
//   POST /api/local-engine/switch { on }      Local engine: on / off. Owner only.
//   POST /api/local-engine/keep-loaded { on } start at desk start and never stop for being idle. Owner only.
import { sendJson } from './modules.js';
import { Downloads } from './downloads.js';
import { LocalEngine } from '../../modules/models/local-engine.js';

export function downloadRoutes(core, sessionOk) {
  if (!core.downloads) core.downloads = new Downloads({ storage: core.storage, settings: core.settings, panic: core.panic, events: core.events, approval: core.approval, roots: [core.storage.dataDir], log: core.log });
  if (!core.localEngine) {
    core.localEngine = new LocalEngine({ storage: core.storage, panic: core.panic, events: core.events, downloads: core.downloads, dataDir: core.storage.dataDir, log: core.log });
    core.model.localEngine = core.localEngine;   // desk.stop runs Panic's stop hooks with 'Shutting down': both close then
  }
  const dl = core.downloads; const eng = new Proxy({}, { get: (_, k) => { const e = core.localEngine; const v = e[k]; return typeof v === 'function' ? v.bind(e) : v; } });   // read per call: tests swap in an engine with stand-in pins
  const owner = (req, res) => { if (sessionOk(req)) return true; sendJson(res, { error: 'Only the owner can do this, from the desk window.' }, 403); return false; };
  const answer = async (res, fn) => { try { sendJson(res, await fn()); } catch (e) { sendJson(res, { error: String(e?.message || e), code: e?.code || undefined }, e?.status || 400); } };
  return {
    'GET /api/downloads': (req, res) => sendJson(res, dl.list()),
    'POST /api/downloads/:id/pause': (req, res, { params }) => owner(req, res) && answer(res, () => dl.pause(params.id)),
    'POST /api/downloads/:id/resume': (req, res, { params }) => owner(req, res) && answer(res, () => dl.resume(params.id)),
    'POST /api/downloads/:id/cancel': (req, res, { params }) => owner(req, res) && answer(res, () => dl.cancel(params.id)),
    'GET /api/local-engine': (req, res) => sendJson(res, eng.status()),
    'GET /api/local-engine/plan': (req, res, { query }) => answer(res, () => eng.plan(query.model ? String(query.model) : null, { fresh: query.fresh === '1' })),
    'POST /api/local-engine/get': (req, res, { body }) => owner(req, res) && answer(res, () => eng.get({ owner: true, modelId: body?.model ? String(body.model) : null })),
    'POST /api/local-engine/choose': (req, res, { body }) => owner(req, res) && answer(res, () => eng.choose(String(body?.model || ''), true)),
    'POST /api/local-engine/stop': (req, res) => owner(req, res) && answer(res, async () => { await eng.stop('owner'); return eng.status(); }),
    'POST /api/local-engine/remove': (req, res) => owner(req, res) && answer(res, () => eng.remove(true)),
    'POST /api/local-engine/switch': (req, res, { body }) => owner(req, res) && answer(res, () => eng.setOn(body?.on !== false, true)),
    'POST /api/local-engine/keep-loaded': (req, res, { body }) => owner(req, res) && answer(res, () => eng.setKeepLoaded(body?.on === true, true)),
  };
}
