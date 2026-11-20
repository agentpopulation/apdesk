// The only file that holds SETTINGS_TOKEN. The security level and the auto-approve window change here and nowhere else.
// These routes need the session token that the shell page carries; agents and modules never see it.
import { SETTINGS_TOKEN } from './approval-door.js';
import { sendJson } from './modules.js';

const OWNER_ONLY_PREFIX = ['security.', 'spend.', 'openrouter.'];
const PLAIN_KEYS = new Set(['theme', 'role', 'onboarded', 'online', 'ownerName', 'appName', 'companyName', 'business.about', 'notifications', 'country', 'currency', 'timeZone', 'locale', 'router.enabled', 'router.baseUrl', 'router.freeOnly', 'router.builtin', 'router.model', 'router.apiKey', 'router.upstreams', 'ollama.baseUrl', 'ollama.model', 'model.defaultChain', 'network.lanNodes', 'menuPosition', 'textSize', 'motion', 'countries', 'city', 'startWithWindows', 'notifications']);

export function settingsRoutes(core, sessionOk) {
  const { settings, approval } = core;
  return {
    'GET /api/settings': (req, res) => sendJson(res, publicSettings(settings)),
    'POST /api/settings': (req, res, { body }) => {
      const changed = {};
      for (let [k, v] of Object.entries(body || {})) {
        if (OWNER_ONLY_PREFIX.some(p => k.startsWith(p))) continue;        // these have their own guarded routes
        if (k === 'business.about') v = String(v ?? '').trim().slice(0, 600);   // the owner's own words about his business, capped
        if (PLAIN_KEYS.has(k) || /^provider\.[a-z]+\.model$/.test(k) || k.startsWith('ui.')) { settings.set(k, v); changed[k] = v; }
      }
      core.events.emit('settings', changed);
      sendJson(res, { ok: true, changed, settings: publicSettings(settings) });
    },
    'POST /api/settings/security': (req, res, { body }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'The security level changes only in Settings on this desk.' }, 403);
      sendJson(res, approval.setLevel(String(body?.level || ''), SETTINGS_TOKEN));
    },
    'POST /api/settings/auto-approve': (req, res, { body }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'Auto-approve changes only from the desk controls.' }, 403);
      const v = body?.window;   // 15 | 60 | 'today' | 0
      sendJson(res, approval.setAutoApprove(v === 'today' ? 'today' : Number(v) || 0, SETTINGS_TOKEN));
    },
    'POST /api/settings/spend': (req, res, { body }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'Spend limits change only in Settings on this desk.' }, 403);
      for (const k of ['perItem', 'perDay', 'perMonth']) if (body?.[k] != null && Number(body[k]) >= 0) settings.set('spend.' + k, Math.round(Number(body[k])));
      if (typeof body?.openrouterPaid === 'boolean') settings.set('openrouter.allowPaid', body.openrouterPaid);
      approval.activity({ action: 'spend.limits', title: 'Spend limits changed', how: 'owner' });
      sendJson(res, approval.state());
    },
    'GET /api/security': (req, res) => sendJson(res, approval.state()),
    'GET /api/approvals': (req, res) => sendJson(res, { pending: approval.listPending(), recent: approval.listRecent(50) }),
    'POST /api/approvals/:id/:decision': (req, res, { params }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'Only the owner at this desk can decide.' }, 403);
      if (!['approve', 'deny'].includes(params.decision)) return sendJson(res, { error: 'approve or deny' }, 400);
      const row = approval.decide(params.id, params.decision, 'owner');
      if (!row) return sendJson(res, { error: 'Not found' }, 404);
      sendJson(res, row);
    },
    'GET /api/activity': (req, res) => sendJson(res, { items: approval.activityList(300) }),
  };
}
export function publicSettings(settings) {
  const all = settings.all(); delete all['router.apiKey']; delete all['security.browsers'];
  return all;
}
