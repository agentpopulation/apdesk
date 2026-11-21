// Doctor: "Check my desk" runs the checks in checks.js and lists each as fine or a problem. It changes nothing by
// itself: no timers, no settings written, no keys read. The one model call and the one internet check go through the
// desk's doors (ctx.model, ctx.fetch), wait for nothing while Offline and stop with Panic.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installedOf, layoutOf, loadKeys, keysFromFile } from '../../app/core/update.js';
import * as C from './checks.js';

const CHECK_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const WALK_MAX = 50000;

/** Stand-ins for tests only: statfs, portTaken(port), usualPort. */
export const testHooks = {};

export async function activate(ctx) {
  const hooks = testHooks;
  const S = (k) => ctx.settings.get(k);
  const online = () => S('online') !== false;
  const when = (iso) => {
    if (!iso) return 'not checked';
    const o = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: S('timeZone') || undefined };
    try { return new Date(iso).toLocaleString(S('locale') || undefined, o); } catch { return new Date(iso).toLocaleString(undefined, { ...o, timeZone: undefined }); }
  };
  const names = () => Object.fromEntries(Object.entries(ctx.model.providers()).map(([k, v]) => [k, v.name]));

  async function askModel(provider) {
    return ctx.model.chat({ model: { provider }, purpose: 'small', maxTokens: 16, messages: [{ role: 'user', content: 'Reply with the one word: ok' }], signal: AbortSignal.any([ctx.panic.child(), AbortSignal.timeout(60000)]) });
  }
  async function freeRoutes() {
    const out = [];
    if (S('router.enabled') !== false) out.push('router');
    let active = []; try { active = await ctx.model.active(); } catch {}
    if (active.some(a => a.provider === 'ollama' && a.ok && (a.models || []).length)) out.push('ollama');
    if (active.some(a => a.provider === 'llama' && a.ok)) out.push('llama');
    return out;
  }
  async function probeInternet() {
    const network = ctx.modules.api('network');
    if (network?.connection) {
      const r = await network.connection({ check: true }); const i = (r.rows || []).find(x => x.name === 'Internet');
      if (i) { if (!i.ok) throw new Error(i.detail || 'Not reachable'); const ms = Number((String(i.detail).match(/(\d+) ms/) || [])[1]); return { ok: true, ms: Number.isFinite(ms) ? ms : null }; }
    }
    const t0 = Date.now();
    const r = await ctx.fetch(CHECK_URL, { method: 'GET', signal: AbortSignal.timeout(8000) });
    try { await r.body?.cancel(); } catch {}
    return { ok: r.ok, status: r.status, ms: Date.now() - t0 };
  }
  function sizeOf(p) { try { return fs.statSync(p).size; } catch { return 0; } }
  function walk(dir) {
    let n = 0, seen = 0, more = false; const stack = [dir];
    while (stack.length) {
      const d = stack.pop(); let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of list) {
        if (++seen > WALK_MAX) { more = true; stack.length = 0; break; }
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p); else if (e.isFile()) n += sizeOf(p);
      }
    }
    return { bytes: n, more };
  }
  function disk() {
    let free = null, total = null;
    try { const s = (hooks.statfs || fs.statfsSync)(ctx.dataDir); free = Number(s.bavail) * Number(s.bsize); total = Number(s.blocks) * Number(s.bsize); } catch {}
    const db = path.join(ctx.dataDir, 'apd.sqlite');
    const ws = walk(ctx.workspace);
    return { free, total, dbBytes: sizeOf(db) + sizeOf(db + '-wal'), workspaceBytes: ws.bytes, workspaceMore: ws.more };
  }
  function portTaken(port) {
    if (hooks.portTaken) return hooks.portTaken(port);
    return new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }); const done = (v) => { s.destroy(); resolve(v); };
      s.setTimeout(1000, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
    });
  }
  function updates() {
    let setUp = false; try { setUp = loadKeys(keysFromFile()).length > 0; } catch {}
    return { setUp, layout: layoutOf(ctx.root), version: installedOf(ctx.root).version, last: S('update.last') || null, daily: S('update.daily') !== false, channel: S('update.channel') === 'preview' ? 'preview' : 'stable' };
  }
  function learned() { const v = ctx.model.learned(); return { days: v.days, minCalls: v.minCalls, rule: v.rule, lines: C.learnedLines(v) }; }

  async function checkAll() {
    const halted = ctx.panic.halted; const on = online();
    const last = ctx.model.lastCalls();
    let active = []; try { active = await ctx.model.active(); } catch {}
    const usual = hooks.usualPort || C.USUAL_PORT;
    const bench = ctx.modules.api('bench');
    let benchEnabled = false; try { benchEnabled = !!bench?.view?.()?.settings?.enabled; } catch {}
    const checks = [
      await C.modelCheck({ halted, online: on, routes: halted || !on ? [] : await freeRoutes(), chat: askModel }),
      C.keysCheck({ keys: ctx.model.keys.list(), lastCalls: last, names: names(), when }),
      await C.internetCheck({ halted, online: on, probe: probeInternet, networkOn: ctx.modules.isOn('network') }),
      C.diskCheck(disk()),
      C.localCheck({ active, lastCalls: ctx.model.lastCalls(), when }),
      C.updatesCheck({ ...updates(), when }),
      C.portCheck({ port: ctx.port, usual, usualTaken: Number(ctx.port) === Number(usual) ? false : await portTaken(usual) }),
      C.switchesCheck({ online: on, halted, benchOn: ctx.modules.isOn('bench'), benchEnabled, networkOn: ctx.modules.isOn('network') }),
    ];
    return { at: new Date().toISOString(), atText: when(new Date().toISOString()), problems: checks.filter(c => c.state === 'problem').length, checks, learned: learned() };
  }

  let running = null;
  ctx.route('POST', '/check', async (req, res, { owner }) => {
    if (!owner) return ctx.json(res, { error: 'The checks run only from the desk itself.' }, 403);
    try { running ||= checkAll().finally(() => { running = null; }); ctx.json(res, await running); }
    catch (e) { ctx.json(res, { error: 'The checks could not finish: ' + String(e?.message || e).slice(0, 160) }, 500); }
  });
  ctx.route('GET', '/learned', (req, res) => ctx.json(res, learned()));
  ctx.expose({ check: () => checkAll(), learned });
  return { async deactivate() {} };
}
