// The only file that holds SETTINGS_TOKEN. The security level and the auto-approve window change here and nowhere else.
// These routes need the session token that the shell page carries; agents and modules never see it.
import { SETTINGS_TOKEN } from './approval-door.js';
import { sendJson } from './modules.js';
import { checkPlace, SPEND_KEYS } from './settings.js';
import { isLocalAddress, LOCAL_WORDS } from './offline.js';
import { PAID_OFF } from './model-door.js';

const OWNER_ONLY_PREFIX = ['security.', 'spend.', 'openrouter.', 'update.'];
// Only settings something on the desk reads. A key that is not here (or a ui.* or provider.<id>.model key) is refused with
// a plain reason, so nothing is stored that looks like a setting and does nothing.
const PLAIN_KEYS = new Set(['theme', 'role', 'onboarded', 'online', 'ownerName', 'appName', 'companyName', 'business.about', 'notifications', 'country', 'currency', 'timeZone', 'locale', 'router.enabled', 'router.baseUrl', 'router.builtin', 'router.model', 'router.apiKey', 'router.upstreams', 'ollama.baseUrl', 'ollama.model', 'model.defaultChain', 'network.lanNodes', 'city']);
const PLACE = new Set(['country', 'currency', 'timeZone', 'locale']);

export function settingsRoutes(core, sessionOk) {
  const { settings, approval } = core;
  const setPaid = (provider, on) => {
    const was = settings.get('openrouter.allowPaid') === true;
    const r = core.model.setPaid(provider, on, SETTINGS_TOKEN);
    if (was !== r.on) { approval.activity({ action: 'models.paid', title: r.on ? 'Paid OpenRouter models switched on' : 'Paid OpenRouter models switched off', how: 'owner' }); core.events.emit('settings', { 'openrouter.allowPaid': r.on }); }
    return r;
  };
  // Signed updates (contracts/UPDATES.md): checked and installed only from the owner's window, like the security level.
  // The house makes the one updater (app/server.js) and keeps it in core.updater.
  const updater = () => core.updater;
  return {
    'GET /api/update': (req, res) => { const st = updater().state(); updater().shown(); sendJson(res, st); },
    'POST /api/update/check': async (req, res) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'Updates are checked only from Settings on this desk.' }, 403);
      sendJson(res, await updater().check());
    },
    'POST /api/update/install': (req, res) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'Updates are installed only from Settings on this desk.' }, 403);
      updater().install(SETTINGS_TOKEN).catch((e) => core.log('update', e.message));   // the owner approves the card; the card follows the 'update' events
      sendJson(res, updater().state());
    },
    'POST /api/update/daily': (req, res, { body }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'This changes only in Settings on this desk.' }, 403);
      if (typeof body?.on !== 'boolean') return sendJson(res, { error: '{ on: true | false }' }, 400);
      settings.set('update.daily', body.on);
      approval.activity({ action: 'update.daily', title: body.on ? 'Check for updates once a day: on' : 'Check for updates once a day: off', how: 'owner' });
      sendJson(res, updater().state());
    },
    'POST /api/update/channel': (req, res, { body }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'This changes only in Settings on this desk.' }, 403);
      if (!['stable', 'preview'].includes(body?.channel)) return sendJson(res, { error: '{ channel: "stable" | "preview" }' }, 400);
      if (updater().channel !== body.channel) {
        settings.set('update.channel', body.channel); updater().remember(null); updater().dropBackground();
        approval.activity({ action: 'update.channel', title: body.channel === 'preview' ? 'Updates: stable and preview versions' : 'Updates: stable versions only', how: 'owner' });
      }
      sendJson(res, updater().state());
    },
    // The owner's switch is his yes for update downloads only (contracts/UPDATES.md). Installing still asks every time.
    'POST /api/update/background': async (req, res, { body }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'This changes only in Settings on this desk.' }, 403);
      if (typeof body?.on !== 'boolean') return sendJson(res, { error: '{ on: true | false }' }, 400);
      settings.set('update.background', body.on);
      approval.activity({ action: 'update.background', title: body.on ? 'Download updates in the background: on' : 'Download updates in the background: off', how: 'owner' });
      if (body.on) { try { updater().background(); } catch (e) { core.log('update', e.message); } } else updater().dropBackground();
      sendJson(res, updater().state());
    },
    'GET /api/settings': (req, res) => sendJson(res, publicSettings(settings)),
    'POST /api/settings': (req, res, { body }) => {
      // every key is checked first: one that is refused saves nothing, and the answer says why in plain words
      const take = {};
      for (let [k, v] of Object.entries(body && typeof body === 'object' ? body : {})) {
        if (OWNER_ONLY_PREFIX.some(p => k.startsWith(p))) continue;        // these have their own guarded routes
        if (!(PLAIN_KEYS.has(k) || /^provider\.[a-z]+\.model$/.test(k) || /^ui\.[\w.-]+$/.test(k))) return sendJson(res, { error: `"${String(k).slice(0, 40)}" is not a setting on this desk, so nothing was saved.` }, 400);
        if (settings.isHouseKey?.(k)) return sendJson(res, { error: k === 'online' ? 'Online and offline are set for the whole desk, by the keeper.' : 'The local model addresses are set for the whole PC, on the keeper\'s own desk. Nothing was saved.' }, 403);
        if (k === 'business.about') v = String(v ?? '').trim().slice(0, 600);   // the owner's own words about his business, capped
        if (PLACE.has(k)) { const c = checkPlace(k, v); if (!c.ok) return sendJson(res, { error: c.reason }, 400); v = c.value; }
        take[k] = v;
      }
      // a new currency: limits the owner set in the old one would mean something else now, so they are cleared (a payment
      // asks every time, paid model calls are off) until he sets them again; limits he never set follow the new currency's usual ones
      let notice = null;
      // (limits that are already cleared stay as they are: nothing to change, log or tell)
      if ('currency' in take && take.currency !== settings.get('currency') && SPEND_KEYS.some(k => settings.stored(k) && Number(settings.get(k)) > 0)) {
        for (const k of SPEND_KEYS) settings.set(k, 0);
        approval.activity({ action: 'spend.limits', title: 'Spend limits cleared: the currency changed', how: 'owner' });
        notice = `Your spend limits were set in ${settings.get('currency')}, so they are cleared for ${take.currency}: ${PAID_OFF}`;
      }
      // a model address that is not on this PC or the owner's network is saved, but Offline does not call it: say so now
      const outside = [take['ollama.baseUrl'], ...(Array.isArray(take['network.lanNodes']) ? take['network.lanNodes'].map(n => n && n.baseUrl) : [])]
        .filter(u => typeof u === 'string' && u && !isLocalAddress(u)).map(u => { try { return new URL(u).hostname; } catch { return null; } }).filter(Boolean);
      if (outside.length) notice = [notice, `Saved. While the desk is offline, ${[...new Set(outside)].join(' and ')} is not called, because it is not on this PC or your own network. ${LOCAL_WORDS}`].filter(Boolean).join(' ');
      const changed = {};
      for (const [k, v] of Object.entries(take)) { settings.set(k, v); changed[k] = v; }
      core.events.emit('settings', changed);
      sendJson(res, { ok: true, changed, settings: publicSettings(settings), ...(notice ? { notice } : {}) });
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
    // Spend limits are each person's own. Switching paid OpenRouter on spends the PC's shared key, so it has its own
    // keeper-gated route (paid-models) and is not flipped here.
    'POST /api/settings/spend': (req, res, { body }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'Spend limits change only in Settings on this desk.' }, 403);
      const next = {};
      for (const k of ['perItem', 'perDay', 'perMonth']) {
        if (body?.[k] == null) continue;
        const n = Number(body[k]);
        if (!Number.isFinite(n) || n < 0 || (typeof body[k] !== 'number' && typeof body[k] !== 'string')) return sendJson(res, { error: 'A spend limit is an amount of 0 or more. Nothing was changed.' }, 400);
        next[k] = Math.round(n);
      }
      // saved as the owner's own (so a later change of currency knows he set them); logged only when an amount moved
      const moved = Object.entries(next).filter(([k, v]) => settings.get('spend.' + k) !== v);
      for (const [k, v] of Object.entries(next)) settings.set('spend.' + k, v);
      if (moved.length) approval.activity({ action: 'spend.limits', title: 'Spend limits changed', how: 'owner' });
      sendJson(res, approval.state());
    },
    // The paid switch beside the keys (Models) and in Settings › Payments and spend: one setting, one guarded route.
    // Only the keeper may switch it on: the OpenRouter key is the PC's (from the environment), shared by every space.
    'POST /api/settings/paid-models': (req, res, { body }) => {
      if (!sessionOk(req)) return sendJson(res, { error: 'Paid models are switched on or off only from the desk window.' }, 403);
      if (body?.provider !== 'openrouter' || typeof body?.on !== 'boolean') return sendJson(res, { error: 'Only OpenRouter has a paid switch: { provider: "openrouter", on: true|false }.' }, 400);
      sendJson(res, setPaid('openrouter', body.on));
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
