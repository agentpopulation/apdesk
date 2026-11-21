// Section C: websites the owner watches. Polite by design: one request per check with the desk's own User-Agent,
// never more often than every 5 minutes, a longer wait after 429 or 5xx, and a robots.txt "no" or a block answer is
// recorded as "blocked" and never worked around. Pure functions; server.js gives them the guarded fetch and the clock.
import crypto from 'node:crypto';

export const UA = 'AgentPopulationDesk/0.1 (local desktop app; site watch)';
export const MIN_EVERY_MIN = 5;
export const DEFAULT_EVERY_MIN = 30;
export const DEFAULT_CHANGE_MIN = 1440;
export const DEFAULT_SLOW_MS = 3000;
const MAX_BACKOFF_MIN = 6 * 60;

/** A watched address from what the owner typed: http(s) only, no user name or password. */
export function siteUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw Object.assign(new Error('Type a web address, for example example.com.'), { status: 400 });
  let u; try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { throw Object.assign(new Error('That is not a web address.'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Only http and https addresses can be watched.'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Leave the user name and password out of the address.'), { status: 400 });
  u.hash = '';
  return u;
}
export const clampEvery = (m, def = DEFAULT_EVERY_MIN) => { const n = Math.round(Number(m)); return Number.isFinite(n) && n > 0 ? Math.max(MIN_EVERY_MIN, Math.min(7 * 1440, n)) : def; };

/** Does robots.txt let this User-Agent fetch this path? The most specific group and the longest rule win. */
export function robotsAllows(text, path, ua = UA) {
  const groups = []; let cur = null; let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
  }
  const name = ua.toLowerCase().split('/')[0];
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && name.includes(a)));
  const use = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  let best = null;
  for (const g of use) for (const r of g.rules) {
    if (!r.path) continue;                                     // "Disallow:" with nothing allows everything
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

/**
 * One check: one request (redirects followed by the guard, at most 3). fetch is the guarded fetch.
 * -> { at, state: 'up'|'slow'|'down'|'blocked', status, ms, finalUrl, note, retryAfterMin }
 */
export async function checkOnce(fetch, url, { slowMs = DEFAULT_SLOW_MS, timeoutMs = 20000, now = () => Date.now() } = {}) {
  const at = new Date(now()).toISOString();
  const t0 = performance.now();
  let res;
  try { res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.5' }, timeoutMs }); }
  catch (e) {
    if (e?.code === 'offline' || e?.code === 'halted') throw e;
    if (/^rule_|^private$|^desk$|^bad_url$/.test(e?.code || '')) return { at, state: 'blocked', status: null, ms: null, note: e.message };
    return { at, state: 'down', status: null, ms: Math.round(performance.now() - t0), note: e?.name === 'TimeoutError' || /timeout|aborted/i.test(e?.message) ? 'No answer in time.' : 'Could not connect.' };
  }
  const ms = Math.round(performance.now() - t0);
  try { await res.body?.cancel(); } catch {}
  const s = res.status;
  const ra = Number(res.headers.get('retry-after'));
  const retryAfterMin = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra / 60) : null;
  const base = { at, status: s, ms, finalUrl: res.url || String(url) };
  if (s === 429) return { ...base, state: 'blocked', note: 'The site asked us to slow down (429). We wait longer before the next check.', retryAfterMin };
  if (s === 401 || s === 403 || s === 451) return { ...base, state: 'blocked', note: `The site refused the check (${s}). Recorded, not retried another way.` };
  if (s >= 500) return { ...base, state: 'down', note: `The site answered ${s}.`, retryAfterMin };
  if (s >= 400) return { ...base, state: 'down', note: `The page answered ${s}.` };
  return { ...base, state: ms > slowMs ? 'slow' : 'up', note: ms > slowMs ? `Slow: ${(ms / 1000).toFixed(1)} s (your limit ${(slowMs / 1000).toFixed(1)} s).` : null };
}

/** When to check next, in ms since epoch: the owner's interval, longer after 429 or 5xx (doubling, at most 6 hours). */
export function nextCheckAt(site, result, now) {
  const every = clampEvery(site.every_min);
  if (result.status === 429 || (result.status >= 500) || (result.state === 'down' && result.status == null)) {
    const fails = Math.max(1, Number(site.fail_count || 0) + 1);
    const wait = Math.min(MAX_BACKOFF_MIN, Math.max(every, MIN_EVERY_MIN * 2 ** fails, result.retryAfterMin || 0));
    return now + wait * 60_000;
  }
  return now + every * 60_000;
}

/** Which notice a change of state raises, or null. 'blocked' raises none (it is the site's choice, recorded). */
export function transition(prev, next) {
  if (!prev || prev === next) return null;
  if (next === 'down' && (prev === 'up' || prev === 'slow')) return 'down';
  if ((next === 'up' || next === 'slow') && prev === 'down') return 'back';
  if (next === 'slow' && prev === 'up') return 'slow';
  return null;
}

export const textHash = (t) => crypto.createHash('sha256').update(normText(t)).digest('hex');
const normText = (t) => String(t || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

/** Lines added and removed between two texts, as plain text, at most `max` of each and 160 characters a line. */
export function diffSummary(before, after, { max = 5, width = 160 } = {}) {
  const a = normText(before).split('\n').filter(Boolean), b = normText(after).split('\n').filter(Boolean);
  const A = new Set(a), B = new Set(b);
  const added = b.filter(l => !A.has(l)), removed = a.filter(l => !B.has(l));
  const cut = (l) => (l.length > width ? l.slice(0, width - 1) + '…' : l);
  return { added: added.slice(0, max).map(cut), removed: removed.slice(0, max).map(cut), addedCount: added.length, removedCount: removed.length };
}
/** The stored copy of a page's text for the next comparison: capped so the database stays small. */
export const keepText = (t) => normText(t).slice(0, 60_000);
