// Scorecard: a weekly record per agent, counted from the desk's own records. No model call, no table of its own:
// it reads what the core lets a module read (calls, jobs, the roster), what Chat offers (replies and thumbs) and what the
// approval door offers (counts), and keeps two small settings and the last model switch in its own kv.
import fs from 'node:fs/promises';
import { weeksBack, firstDayOf } from './weeks.js';
import { buildCells, trend } from './stats.js';
import { suggest } from './suggest.js';

const WEEK_CHOICES = ['auto', 'mon', 'sun', 'sat'];
const SWITCH_DAYS = 14;
const LOCAL = new Set(['router', 'ollama', 'llama']);

export async function activate(ctx) {
  const S = (k) => ctx.settings.get(k);
  const prefs = () => ({ weekStart: WEEK_CHOICES.includes(ctx.kv.get('weekStart', 'auto')) ? ctx.kv.get('weekStart', 'auto') : 'auto', suggestions: ctx.kv.get('suggestions', true) !== false });
  const ownerOnly = (res) => ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403);
  const labelOf = (p, m) => { try { return ctx.model.label(p, m) || m || p; } catch { return m || p || 'unknown model'; } };
  const sameMain = (a, b) => !!a && !!b && a.provider === b.provider && (a.model || '') === (b.model || '');

  /** The weeks, newest first, in the owner's zone. `now` can be given by a test. */
  const weeksFor = (count, now = Date.now()) => {
    const tz = S('timeZone') || undefined; const locale = S('locale') || undefined;
    return weeksBack({ now, tz, firstDay: firstDayOf(prefs().weekStart, locale), count, locale });
  };

  /** Replies and thumbs live in Chat. Messages are read page by page so a long record never loses its newest end. */
  function repliesSince(sinceIso) {
    const chat = ctx.modules.api('chat');
    if (typeof chat?.messagesSince !== 'function') return null;
    const seen = new Map(); let since = sinceIso;
    for (let page = 0; page < 40; page++) {
      const got = chat.messagesSince(since, 5000) || [];
      let fresh = 0; for (const m of got) if (!seen.has(m.id)) { seen.set(m.id, m); fresh++; }
      if (got.length < 5000 || !fresh) break;
      since = got.at(-1).at;
    }
    return [...seen.values()];
  }
  function thumbs() {
    const chat = ctx.modules.api('chat');
    if (typeof chat?.ratingsSince !== 'function') return null;
    const map = new Map();
    for (const r of chat.ratingsSince('') || []) if (r && (r.thumb === 'up' || r.thumb === 'down')) map.set(String(r.targetId), r.thumb);
    return map;
  }

  function gather(count, now = Date.now()) {
    const weeks = weeksFor(count, now);
    const from = weeks.at(-1).startIso, to = new Date(Math.max(now, weeks[0].end)).toISOString();
    const agents = ctx.agents.list();
    const calls = ctx.db.all('SELECT at, agent_id, purpose, provider, model, ok, ms, cost_minor, currency FROM calls WHERE at >= ? AND at < ? ORDER BY at', from, to);
    const jobs = ctx.db.all('SELECT agent_id, status, created, finished, input FROM jobs WHERE COALESCE(finished, created) >= ? AND COALESCE(finished, created) < ?', from, to);
    const messages = repliesSince(from);
    const ratings = thumbs();
    const count_ = ctx.approval?.countsBetween;
    const approvals = typeof count_ === 'function' ? (wk) => { try { return count_(wk.startIso, wk.endIso) || []; } catch { return []; } } : null;
    const built = buildCells({ weeks, agentIds: agents.map(a => a.id), calls, jobs, messages: messages || [], ratings, approvals, labelOf, currency: S('currency') || '' });
    // what each model cost in these calls, for "does it cost money"
    const costs = new Map();
    for (const c of calls) { const k = `${c.provider}|${c.model || ''}`; const r = costs.get(k) || { zero: 0, paid: 0, other: 0 }; if (c.cost_minor === 0) r.zero++; else if (c.cost_minor > 0) r.paid++; else r.other++; costs.set(k, r); }
    return { weeks, agents, calls, ...built, costs, available: { replies: messages !== null, ratings: ratings !== null, approvals: approvals !== null } };
  }

  function costOf(g) {
    let tiers = {}; try { tiers = ctx.model.providers?.() || {}; } catch {}
    return (provider, model) => {
      if (LOCAL.has(provider) || String(provider).startsWith('lan:')) return 'free';
      if (provider === 'openrouter') return model === 'openrouter/free' || /:free$/.test(String(model || '')) ? 'free' : 'paid';
      const r = g.costs.get(`${provider}|${model || ''}`);
      if (r?.paid) return 'paid';
      if (r && r.zero && !r.other) return 'free';
      return tiers[provider]?.tier === 'paid' ? 'paid' : 'unknown';
    };
  }

  function suggestionsFor(g) {
    const empty = { suggestions: [], needs: [], heldBack: [] };
    if (!prefs().suggestions || !g.available.ratings) return empty;
    let learned = []; try { learned = ctx.model.learned?.()?.rows || []; } catch {}
    return suggest({
      evidence: g.evidence, learned, costOf: costOf(g), paidOn: S('openrouter.allowPaid') === true, label: labelOf,
      agents: g.agents.filter(a => a.enabled).map(a => ({ id: a.id, name: lineOf(a), main: a.model?.main || null })),
    });
  }

  // an agent is named by the Agents module's one rule ("Kent · Secretary", or the role alone); its stored name only when that module is off
  const lineOf = (a) => { try { return ctx.modules.api('agents')?.agentLine?.(a) || a.name; } catch { return a.name; } };
  const agentOut = (a) => ({ id: a.id, name: lineOf(a), role: a.role, enabled: a.enabled, model: a.model?.main ? labelOf(a.model.main.provider, a.model.main.model) : null });

  function activeSwitches() {
    const rec = ctx.kv.get('switches', {}) || {}; const out = [];
    for (const [id, r] of Object.entries(rec)) {
      const a = ctx.agents.get(id);
      if (!a || !r?.at || Date.now() - Date.parse(r.at) > SWITCH_DAYS * 86400000 || !sameMain(a.model?.main, r.to)) continue;
      out.push({ agentId: id, agentName: lineOf(a), toLabel: r.toLabel, fromLabel: r.fromLabel, at: r.at });
    }
    return out;
  }

  function report(now = Date.now()) {
    const g = gather(2, now);
    const sug = suggestionsFor(g);
    const rows = g.agents.map(a => {
      const [now0, before] = g.cells[a.id];
      return { agent: agentOut(a), this: now0, last: before, trend: trend(now0, before), idle: !now0.any };
    });
    return {
      weeks: g.weeks.map(w => ({ index: w.index, label: w.label, start: w.startIso, end: w.endIso })),
      currency: S('currency') || '', rows, available: g.available,
      suggestions: sug.suggestions, needs: sug.needs, heldBack: sug.heldBack, switches: activeSwitches(),
      suggestionsOn: prefs().suggestions,
    };
  }

  function history(agentId, now = Date.now()) {
    const g = gather(8, now); const a = g.agents.find(x => x.id === agentId); if (!a) return null;
    const sug = suggestionsFor(g);
    return {
      agent: agentOut(a), weeks: g.weeks.map(w => ({ index: w.index, label: w.label, start: w.startIso, end: w.endIso })), cells: g.cells[a.id],
      currency: S('currency') || '', available: g.available,
      suggestions: sug.suggestions.filter(s => s.agentId === a.id), needs: sug.needs.filter(s => s.agentId === a.id), switches: activeSwitches().filter(s => s.agentId === a.id),
      suggestionsOn: prefs().suggestions,
    };
  }

  // ---------- routes
  ctx.route('GET', '/report', (req, res) => ctx.json(res, report()));
  ctx.route('GET', '/agent/:id', (req, res, { params }) => { const h = history(params.id); h ? ctx.json(res, h) : ctx.json(res, { error: 'There is no such agent.' }, 404); });
  ctx.route('GET', '/settings', (req, res) => ctx.json(res, prefs()));
  ctx.route('POST', '/settings', (req, res, { body, owner }) => {
    if (!owner) return ownerOnly(res);
    if (body?.weekStart !== undefined) { if (!WEEK_CHOICES.includes(body.weekStart)) return ctx.json(res, { error: 'Pick Automatic, Monday, Sunday or Saturday.' }, 400); ctx.kv.set('weekStart', body.weekStart); }
    if (body?.suggestions !== undefined) ctx.kv.set('suggestions', body.suggestions === true);
    ctx.json(res, prefs());
  });

  // the button on a suggestion: only a suggestion the page shows right now can be taken
  ctx.route('POST', '/switch', (req, res, { body, owner }) => {
    if (!owner) return ownerOnly(res);
    const agent = ctx.agents.get(String(body?.agentId || ''));
    if (!agent) return ctx.json(res, { error: 'There is no such agent.' }, 404);
    const s = suggestionsFor(gather(2)).suggestions.find(x => x.agentId === agent.id && x.to.provider === body?.provider && (x.to.model || '') === (body?.model || ''));
    if (!s) return ctx.json(res, { error: 'That suggestion is no longer there. Open the page again to see the current ones.' }, 409);
    const previous = agent.model?.main || null;
    const fromLabel = previous ? labelOf(previous.provider, previous.model) : null;
    ctx.agents.update(agent.id, { model: { main: { provider: s.to.provider, model: s.to.model } } });
    const rec = ctx.kv.get('switches', {}) || {};
    rec[agent.id] = { from: previous, fromLabel, to: { provider: s.to.provider, model: s.to.model }, toLabel: s.to.label, at: new Date().toISOString() };
    ctx.kv.set('switches', rec);
    ctx.activity(`${lineOf(agent)} now uses ${s.to.label}`, `Changed from the Scorecard. It was ${fromLabel || 'the desk default'}.`);
    ctx.json(res, { ok: true, agentName: lineOf(agent), toLabel: s.to.label, fromLabel });
  });
  ctx.route('POST', '/undo', (req, res, { body, owner }) => {
    if (!owner) return ownerOnly(res);
    const id = String(body?.agentId || ''); const agent = ctx.agents.get(id);
    const rec = (ctx.kv.get('switches', {}) || {})[id];
    if (!agent || !rec) return ctx.json(res, { error: 'There is no switch to undo.' }, 404);
    if (!sameMain(agent.model?.main, rec.to)) return ctx.json(res, { error: `${lineOf(agent)}'s model was changed again since, so nothing was undone.` }, 409);
    ctx.agents.update(id, { model: { main: rec.from || null } });
    const all = ctx.kv.get('switches', {}) || {}; delete all[id]; ctx.kv.set('switches', all);
    ctx.activity(`${lineOf(agent)} is back on ${rec.fromLabel || 'the desk default'}`, 'Undone from the Scorecard.');
    ctx.json(res, { ok: true, agentName: lineOf(agent), backTo: rec.fromLabel || null });
  });

  // ---------- the file
  const q = (v) => { const t = String(v ?? ''); const safe = /^[=+\-@\t\r]/.test(t) ? "'" + t : t; return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe; };
  const NK = 'not known';
  function csvFor(rep, week) {
    const w = rep.weeks[week]; const cur = rep.currency || '';
    const head = ['Agent', 'Week from', 'Week to', 'Replies written', 'Jobs done', 'Jobs failed', 'Jobs stopped', 'Approvals asked', 'Approvals refused', 'Rated good', 'Rated poor', 'Share rated good', 'Middle time to answer (seconds)', 'Cost' + (cur ? ' (' + cur + ')' : ''), 'Calls of unknown cost', 'Models that answered'];
    const rows = [head];
    for (const r of rep.rows) {
      const c = week === 0 ? r.this : r.last; const rt = c.ratings;
      rows.push([
        r.agent.name, w.label.split(' to ')[0], w.label.split(' to ')[1], c.replies, c.jobs.done, c.jobs.failed, c.jobs.stopped,
        c.approvals ? c.approvals.asked : NK, c.approvals ? c.approvals.refused : NK,
        rt ? rt.good : NK, rt ? rt.poor : NK, rt && rt.share != null ? Math.round(rt.share * 100) + '%' : NK,
        c.timeMs != null ? (c.timeMs / 1000).toFixed(1) : NK,
        (c.cost.calls - c.cost.unknownCalls) || !c.cost.calls ? (c.cost.minor / 100).toFixed(2) : NK, c.cost.unknownCalls,
        c.models.map(m => `${m.label}${m.share != null ? ' ' + Math.round(m.share * 100) + '%' : ''}${m.failed ? ', ' + m.failed + ' failed' : ''}${m.skipped ? ', ' + m.skipped + ' skipped' : ''}`).join('; ') || (c.any ? NK : ''),
      ]);
    }
    return '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
  }
  ctx.route('POST', '/save', async (req, res, { body, owner }) => {
    if (!owner) return ownerOnly(res);
    const week = Number(body?.week) === 1 ? 1 : 0; const rep = report();
    const day = new Date(rep.weeks[week].start); const tz = S('timeZone') || undefined;
    let stamp; try { stamp = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(day); } catch { stamp = day.toISOString().slice(0, 10); }
    const name = `scorecard-${stamp}.csv`; const rel = `reports/${name}`;
    const d = await ctx.approval.request({ action: 'file.write', agentId: null, title: `Write ${name}`, detail: 'Workspace › reports', payload: { path: rel }, signal: ctx.panic.signal });
    if (!d.ok) return ctx.json(res, { error: d.reason === 'denied' ? `You said no to writing ${name}.` : `Writing ${name} did not go ahead (${d.reason}).` }, 403);
    const abs = ctx.workspacePath('reports', name);
    await fs.mkdir(ctx.workspacePath('reports'), { recursive: true });
    await fs.writeFile(abs, csvFor(rep, week), 'utf8');
    ctx.activity(`Saved ${name}`, `The scorecard for ${rep.weeks[week].label}.`);
    ctx.json(res, { ok: true, name, path: rel, label: rep.weeks[week].label });
  });

  ctx.expose({
    /** The counted record for this week and last, one row per agent (for Home, the weekly note, other pages). Read-only. */
    report: () => report(),
    /** The model suggestions the page shows now. Read-only: only the owner's click on the Scorecard page switches anything. */
    suggestions: () => report().suggestions,
  });
  return { async deactivate() {} };
}

export const testHooks = { };
