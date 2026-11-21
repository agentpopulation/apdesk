// Finder: several wordings to several providers at once within one time budget, results merged by address, the best
// pages read (through the desk's one reader and its address guard), split into passages and ranked against the
// question. Every page read is kept in the private library, which is searched first and alone while Offline.
// Page text is untrusted data: it is only quoted, never followed.
import { rewordings, assign } from './rewrite.js';
import { rankPassages, splitPassages, pageText, tokens } from './rank.js';
import { normUrl } from '../search/providers.js';

const stopped = () => Object.assign(new Error('Stopped'), { code: 'aborted' });
const plainNote = (e) => (e?.name === 'TimeoutError' || /time/i.test(String(e?.message)) ? 'no answer in time' : String(e?.message || e || 'failed').slice(0, 200));
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

/**
 * createFinder({ library, providers, searchOne, read, canOpen, budgetMs, readBudgetMs, readCount, freshMs, now, modelWording })
 *   providers()                      -> provider ids to ask now
 *   searchOne(query, id, signal)     -> [{ title, url, snippet }]
 *   read(url, signal)                -> { url, finalUrl, title, text, kind, fetchedAt }   (the desk's reader: guard and rules inside)
 *   canOpen(url)                     -> true, or throws with a plain message (the website rules, checked before any read)
 *   allowedHost(host)                -> may a kept page from this host be shown to this caller now (the website rules)
 *   modelWording(question, signal)   -> one extra wording or null (optional)
 */
export function createFinder({ library, providers, searchOne, read, canOpen = () => true, allowedHost = () => true, budgetMs = 12000, readBudgetMs = 20000, readCount = 5, freshMs = 7 * 86400_000, now = () => Date.now(), modelWording = null }) {
  async function find(question, { libraryOnly = false, offline = false, signal, top = 5, perPage = 2 } = {}) {
    const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!q) throw Object.assign(new Error('Type a question first.'), { code: 'empty', status: 400 });
    if (signal?.aborted) throw stopped();
    const notes = []; const asked = []; const readLog = [];
    const kept = library.search(q, { limit: 12, allowed: allowedHost });
    if (libraryOnly || offline) {
      if (offline && !libraryOnly) notes.push('The desk is offline, so only your library was searched.');
      return finish(q, kept, { top, perPage, notes, asked, readLog, libraryOnly: true, offline });
    }
    // 1. wordings to providers, all at once, within one budget
    let extra = null;
    if (modelWording) { try { extra = await Promise.race([modelWording(q, signal), new Promise((r) => setTimeout(() => r(null), 4000))]); } catch { extra = null; } }
    const words = rewordings(q, { extra });
    const ids = await providers();
    if (!ids.length) notes.push('No search provider is set up.');
    const limit = AbortSignal.timeout(budgetMs);
    const sig = AbortSignal.any([signal, limit].filter(Boolean));
    const lists = await Promise.all(assign(words, ids).map(async ({ provider, query }) => {
      const t0 = now();
      try {
        const rows = await Promise.race([searchOne(query, provider, sig), new Promise((_, no) => { if (sig.aborted) no(sig.reason); else sig.addEventListener('abort', () => no(sig.reason), { once: true }); })]);
        asked.push({ provider, query, ok: true, n: rows.length, note: rows.length ? '' : 'no results', ms: now() - t0 });
        return rows;
      } catch (e) {
        if (signal?.aborted) throw stopped();
        asked.push({ provider, query, ok: false, n: 0, note: limit.aborted ? 'no answer in time' : plainNote(e), ms: now() - t0 });
        return [];
      }
    }));
    if (signal?.aborted) throw stopped();
    // 2. merge by address (reciprocal rank fusion: a page several lists agree on comes first)
    const merged = new Map();
    for (const rows of lists) rows.forEach((r, i) => {
      if (!/^https?:\/\//i.test(r?.url || '')) return;
      const k = normUrl(r.url); const m = merged.get(k) || { url: r.url, title: r.title || '', snippet: r.snippet || '', score: 0 };
      m.score += 1 / (60 + i); merged.set(k, m);
    });
    const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
    // 3. read the best pages (a recent library copy stands in for a read), never around the website rules
    const picks = [];
    for (const r of ranked) {
      if (picks.length >= readCount) break;
      try { canOpen(r.url); } catch (e) { readLog.push({ url: r.url, ok: false, note: 'not opened: ' + plainNote(e) }); continue; }
      picks.push(r);
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(readBudgetMs)].filter(Boolean));
    const fresh = []; const titles = [];
    // a kept copy stands in only when this caller may see both the site asked for and the site it led to without asking
    // the owner; otherwise the read runs, so an ask-first site is asked about
    const mayUse = (c, url) => !!c && allowedHost(c.host) && allowedHost(c.openedHost) && allowedHost(hostOf(url));
    await Promise.all(picks.map(async (r) => {
      const copy = library.get(r.url);
      if (copy && now() - Date.parse(copy.readAt) < freshMs && mayUse(copy, r.url)) { readLog.push({ url: r.url, ok: true, note: 'from your library' }); return; }
      try {
        const p = await read(r.url, deadline);
        const url = p.finalUrl || p.url || r.url; const readAt = p.fetchedAt || new Date(now()).toISOString();
        const text = pageText(p);                                     // the page's blocks kept apart
        library.keep({ ...p, text, url: r.url, finalUrl: url, fetchedAt: readAt });
        if (p.title || r.title) titles.push({ url, title: p.title || r.title, readAt, from: 'web' });
        for (const s of splitPassages(text)) fresh.push({ text: s.text, pos: s.pos, start: s.start, url, title: p.title || r.title, host: hostOf(url), readAt, from: 'web' });
        readLog.push({ url, ok: true, note: '' });
      } catch (e) {
        if (signal?.aborted) throw stopped();
        readLog.push({ url: r.url, ok: false, note: deadline.aborted ? 'no answer in time' : plainNote(e) });
      }
    }));
    if (signal?.aborted) throw stopped();
    // pages taken from the library for this question count with their stored passages
    const fromLib = [...kept];
    for (const r of picks) { const c = library.get(r.url); if (mayUse(c, r.url) && !fresh.some((f) => normUrl(f.url) === normUrl(c.url))) { if (c.title) titles.push({ url: c.url, title: c.title, readAt: c.readAt, from: 'library' }); for (const s of splitPassages(c.text)) fromLib.push({ text: s.text, pos: s.pos, start: s.start, url: c.url, title: c.title, host: c.host, readAt: c.readAt, from: 'library' }); } }
    if (!ranked.length && ids.length) notes.push('No page came back from the search providers.');
    return finish(q, [...fresh, ...fromLib], { top, perPage, notes, asked, readLog, libraryOnly: false, titles });
  }

  // nothing answered: one plain line, with what to do next
  const nothingLine = ({ libraryOnly, offline }) => (!libraryOnly ? 'No page read answers this. Try other words, or fewer of them.'
    : offline ? 'Nothing in your library answers this. Search again once the desk is online; the pages read then are kept here.'
      : 'Nothing in your library answers this. Switch off "Search my library only" to search the web.');
  // a page read whose title carries most of the question's words: shown as a source with its title
  const titleAnswers = (q, title) => { const k = [...new Set(tokens(q))]; const t = new Set(tokens(title)); return k.length > 0 && k.filter((w) => t.has(w)).length * 2 > k.length; };

  function finish(q, candidates, { top, perPage, notes, asked, readLog, libraryOnly, offline = false, titles = [] }) {
    const seen = new Set(); const uniq = [];
    for (const c of candidates) { const k = c.text.replace(/\s+/g, ' ').trim().toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(c); } }
    const per = new Map(); const passages = [];
    for (const p of rankPassages(q, uniq, { strict: libraryOnly })) {
      const k = normUrl(p.url); const n = per.get(k) || 0; if (n >= perPage) continue;
      per.set(k, n + 1); passages.push({ text: p.text, url: p.url, title: p.title || '', readAt: p.readAt, from: p.from, score: p.score });
      if (passages.length >= top) break;
    }
    const nothing = passages.length ? null : nothingLine({ libraryOnly, offline });
    if (nothing) { if (libraryOnly) notes.length = 0; notes.push(nothing); }
    const sources = []; for (const p of passages) if (!sources.some((s) => s.url === p.url)) sources.push({ url: p.url, title: p.title, readAt: p.readAt, from: p.from, ...(p.title && titleAnswers(q, p.title) ? { byTitle: true } : {}) });
    for (const t of [...titles, ...candidates]) if (t.title && titleAnswers(q, t.title) && !sources.some((s) => normUrl(s.url) === normUrl(t.url))) sources.push({ url: t.url, title: t.title, readAt: t.readAt, from: t.from, byTitle: true });
    return { question: q, passages, sources, asked, read: readLog, notes, nothing, libraryOnly };
  }
  return { find };
}
