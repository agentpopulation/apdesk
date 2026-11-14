// Search providers for the whole desk. Keyless first, keyed when the owner adds a key.
// Also decodeEntities, the DuckDuckGo challenge test and the DuckDuckGo HTML parser.
// Every request sends an honest User-Agent. A challenge page is never worked around: the provider is skipped and the reason is said.

export const UA = 'AgentPopulationDesk/0.1 (local desktop app)';

const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', copy: '©', reg: '®', trade: '™' };
export function decodeEntities(value) {
  let text = String(value ?? '');
  if (!text.includes('&')) return text;
  text = text.replace(/&amp;(?=#x?[0-9a-f]+;|[a-z]+;)/gi, '&');
  text = text.replace(/&#(x?)([0-9a-f]+);/gi, (whole, x, d) => { if (!x && !/^\d+$/.test(d)) return whole; const c = parseInt(d, x ? 16 : 10); return c > 0 && c <= 0x10ffff && !(c >= 0xd800 && c <= 0xdfff) ? String.fromCodePoint(c) : ''; });
  text = text.replace(/&([a-z]+);/gi, (whole, n) => (n.toLowerCase() === 'amp' ? whole : NAMED[n.toLowerCase()] ?? whole));
  return text.replace(/&amp;/gi, '&');
}
export const plain = (v) => decodeEntities(String(v || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** DuckDuckGo's challenge / anomaly page instead of results. */
export function isDdgChallenge(status, html) {
  if (Number(status) === 202 || Number(status) === 429 || Number(status) === 403) return true;
  const t = String(html || '');
  if (/result__a|result-link/.test(t)) return false;
  return /anomaly-modal|anomaly\.js|challenge-form|g-recaptcha|h-captcha|bots use DuckDuckGo too|Unfortunately, bots|select all squares|automated requests/i.test(t);
}
export function realDdgUrl(href) {
  const raw = String(href || '').trim();
  try { const u = new URL(raw.startsWith('//') ? 'https:' + raw : raw, 'https://duckduckgo.com'); const t = u.searchParams.get('uddg'); return /duckduckgo\.com$/i.test(u.hostname) && t ? decodeURIComponent(t) : u.href; } catch { return raw; }
}
export function parseDdgHtml(html, max) {
  const out = []; let m;
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>|class="result__snippet")/gi;
  while ((m = re.exec(html)) && out.length < max) out.push({ title: plain(m[2]), url: realDdgUrl(decodeEntities(m[1])), snippet: plain(m[3] || '') });
  return out;
}

class ProviderError extends Error { constructor(code, message) { super(message); this.code = code; } }
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const http = (id, r) => { const e = new ProviderError('http', `HTTP ${r.status}`); e.status = r.status; const ra = Number(r.headers?.get?.('retry-after')); if (Number.isFinite(ra)) e.retryAfterMs = ra * 1000; return e; };

/**
 * Each provider: { id, label, kind: 'sidecar'|'keyless'|'keyed', cap?: share of results, configured(env), run(env, q, n, signal) -> rows }
 * env = { fetch, secret(name), searxngUrl }
 */
export const PROVIDERS = [
  {
    id: 'searxng', label: 'SearXNG (your own)', kind: 'sidecar',
    configured: (env) => !!env.searxngUrl,
    async run(env, q, n, signal) {
      const get = async (cats) => {
        const u = new URL('search', env.searxngUrl.replace(/\/?$/, '/')); u.searchParams.set('q', q); u.searchParams.set('format', 'json'); if (cats) u.searchParams.set('categories', cats);
        const r = await env.fetch(u, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal });
        if (!r.ok) throw http('SearXNG', r);
        const d = await json(r); return Array.isArray(d?.results) ? d.results : [];
      };
      let rows = await get('');
      if (!rows.length) rows = await get('general,science,it,news');
      return rows.slice(0, n).map((x) => ({ title: plain(x.title), url: String(x.url || ''), snippet: plain(x.content || '') }));
    },
  },
  {
    id: 'duckduckgo', label: 'DuckDuckGo', kind: 'keyless',
    configured: () => true,
    async run(env, q, n, signal) {
      const r = await env.fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { Accept: 'text/html', 'User-Agent': UA }, signal });
      const html = r.status === 200 ? await r.text() : '';
      if (isDdgChallenge(r.status, html)) throw new ProviderError('challenge', 'answered with a bot check; skipped (we never work around it)');
      if (!r.ok) throw http('DuckDuckGo', r);
      return parseDdgHtml(html, n);
    },
  },
  {
    id: 'wikipedia', label: 'Wikipedia', kind: 'keyless', cap: 3,
    configured: () => true,
    async run(env, q, n, signal) {
      const r = await env.fetch(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=${Math.min(10, n)}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal });
      if (!r.ok) throw http('Wikipedia', r);
      const d = await json(r);
      return (d?.pages || []).map((p) => ({ title: plain(p.title), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(p.key || p.title).replace(/ /g, '_'))}`, snippet: plain(p.excerpt || p.description || '') }));
    },
  },
  {
    id: 'serper', label: 'Serper (Google results)', kind: 'keyed',
    configured: (env) => !!env.secret('serper'),
    async run(env, q, n, signal) {
      const r = await env.fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': env.secret('serper'), 'content-type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ q, num: Math.min(20, Math.max(10, n)) }), signal });
      if (!r.ok) throw http('Serper', r);
      const d = await json(r);
      return (d?.organic || []).map((x) => ({ title: plain(x.title), url: String(x.link || ''), snippet: plain(x.snippet || '') }));
    },
  },
  {
    id: 'brave', label: 'Brave Search', kind: 'keyed',
    configured: (env) => !!env.secret('brave'),
    async run(env, q, n, signal) {
      const r = await env.fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(20, n)}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': env.secret('brave'), 'User-Agent': UA }, signal });
      if (!r.ok) throw http('Brave', r);
      const d = await json(r);
      return (d?.web?.results || []).map((x) => ({ title: plain(x.title), url: String(x.url || ''), snippet: plain(x.description || '') }));
    },
  },
  {
    id: 'tavily', label: 'Tavily', kind: 'keyed',
    configured: (env) => !!env.secret('tavily'),
    async run(env, q, n, signal) {
      const r = await env.fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${env.secret('tavily')}`, 'User-Agent': UA }, body: JSON.stringify({ query: q, max_results: Math.min(20, n) }), signal });
      if (!r.ok) throw http('Tavily', r);
      const d = await json(r);
      return (d?.results || []).map((x) => ({ title: plain(x.title), url: String(x.url || ''), snippet: plain(x.content || '').slice(0, 400) }));
    },
  },
  {
    id: 'exa', label: 'Exa', kind: 'keyed',
    configured: (env) => !!env.secret('exa'),
    async run(env, q, n, signal) {
      const r = await env.fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.secret('exa'), 'User-Agent': UA }, body: JSON.stringify({ query: q, numResults: Math.min(20, n) }), signal });
      if (!r.ok) throw http('Exa', r);
      const d = await json(r);
      return (d?.results || []).map((x) => ({ title: plain(x.title), url: String(x.url || ''), snippet: plain(x.text || x.summary || '').slice(0, 400) }));
    },
  },
  {
    id: 'jina', label: 'Jina search', kind: 'keyed',
    configured: (env) => !!env.secret('jina'),
    async run(env, q, n, signal) {
      const r = await env.fetch(`https://s.jina.ai/?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${env.secret('jina')}`, 'X-Respond-With': 'no-content', 'User-Agent': UA }, signal });
      if (!r.ok) throw http('Jina', r);
      const d = await json(r);
      return (d?.data || []).slice(0, n).map((x) => ({ title: plain(x.title), url: String(x.url || ''), snippet: plain(x.description || '') }));
    },
  },
  {
    id: 'hackernews', label: 'Hacker News (Algolia)', kind: 'keyless', cap: 2,
    configured: () => true,
    async run(env, q, n, signal) {
      const r = await env.fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=${Math.min(20, n)}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal });
      if (!r.ok) throw http('Hacker News', r);
      const d = await json(r);
      return (d?.hits || []).filter((h) => h.url).map((h) => ({ title: plain(h.title), url: String(h.url), snippet: `Discussed on Hacker News (${h.points || 0} points)` }));
    },
  },
  {
    id: 'ddg-instant', label: 'DuckDuckGo instant answers', kind: 'keyless', cap: 2,
    configured: () => true,
    async run(env, q, n, signal) {
      const r = await env.fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal });
      if (!r.ok) throw http('DuckDuckGo instant answers', r);
      const d = await json(r); const out = [];
      if (d?.AbstractURL && d?.AbstractText) out.push({ title: plain(d.Heading || q), url: d.AbstractURL, snippet: plain(d.AbstractText).slice(0, 300) });
      for (const t of d?.Results || []) if (t.FirstURL) out.push({ title: plain(t.Text), url: t.FirstURL, snippet: plain(t.Text) });
      return out.slice(0, n);
    },
  },
];

export const ORDER = PROVIDERS.map((p) => p.id);

/** Drop tracking bits so the same page is not counted twice. */
export function normUrl(u) {
  try { const x = new URL(u); x.hash = ''; for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src)/i.test(k)) x.searchParams.delete(k); x.hostname = x.hostname.replace(/^www\./, ''); return x.href.replace(/\/$/, ''); } catch { return String(u || ''); }
}

/**
 * Walk the chain, merging results until `count` is reached. Providers with a cap (Wikipedia, HN) add at most that many,
 * so general web providers (SearXNG, DuckDuckGo, then keyed ones) still get a turn.
 * Returns { results, attempts: [{ provider, label, ok, n, note, ms }] }.
 */
/** A provider's error in plain words: "connection reset", "HTTP 500", "no answer in time". */
export function plainError(e) {
  if (!e) return 'not tried';
  if (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' || e.cause?.code === 'ETIMEDOUT' || e.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') return 'no answer in time';
  const c = e.cause?.code || e.code || '';
  if (c === 'ECONNRESET' || c === 'UND_ERR_SOCKET') return 'connection reset';
  if (c === 'ECONNREFUSED') return 'connection refused';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'address not found';
  if (c === 'offline') return 'the desk is offline';
  if (e.message === 'fetch failed') return `could not be reached${c ? ' (' + c + ')' : ''}`;
  return String(e.message || e);
}
/** "DuckDuckGo: connection reset; Wikipedia: HTTP 500" for the providers that failed. */
export const failureLine = (attempts) => (attempts || []).filter((a) => !a.ok).map((a) => `${a.label}: ${a.note}`).join('; ');

/** One provider's own time limit, and the whole search's limit across every provider (a dead network costs about 25 s, not minutes). */
export const PROVIDER_TIMEOUT_MS = 15000;
export const SEARCH_BUDGET_MS = 25000;
/** A fast failure that a second try can cure: a reset connection, HTTP 5xx, or HTTP 429 that asks for a short wait. Never a timeout or a bot check. */
function curable(e, maxWaitMs) {
  if (!e || e.code === 'challenge' || e.code === 'offline' || plainError(e) === 'no answer in time') return false;
  if (e.code === 'http') return e.status >= 500 || (e.status === 429 && e.retryAfterMs != null && e.retryAfterMs <= maxWaitMs);
  const c = e.cause?.code || e.code || '';
  return c === 'ECONNRESET' || c === 'UND_ERR_SOCKET';
}
/** The provider's message with its cause, in full: "fetch failed (read ECONNRESET)". */
const fullError = (e) => !e ? '' : String(e.message || e) + (e.cause?.message ? ` (${e.cause.message})` : '');
export async function runChain(env, query, { count = 8, signal, only, skip = [], retryWaitMs = 700, timeoutMs = PROVIDER_TIMEOUT_MS, budgetMs = SEARCH_BUDGET_MS, minSliceMs = 1000 } = {}) {
  const q = String(query || '').trim(); if (!q) return { results: [], attempts: [], notTried: [] };
  const seen = new Set(); const results = []; const attempts = []; const notTried = [];
  const deadline = Date.now() + budgetMs; const left = () => deadline - Date.now();
  const stopped = () => Object.assign(new Error('Stopped'), { code: 'aborted' });
  for (const p of PROVIDERS) {
    if (results.length >= count) break;
    if (only && !only.includes(p.id)) continue;
    if (skip.includes(p.id) || !p.configured(env)) continue;
    if (signal?.aborted) throw stopped();
    if (left() < minSliceMs) { notTried.push(p.label); attempts.push({ provider: p.id, label: p.label, ok: false, n: 0, notTried: true, note: 'not tried: the search ran out of time', ms: 0 }); continue; }
    const t0 = Date.now(); const want = count - results.length;
    let rows = null, err = null;
    for (let attempt = 0; attempt < 2 && !rows; attempt++) {        // one retry, only after a fast failure a retry can cure
      const limit = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, left())));
      const sig = AbortSignal.any([signal, limit].filter(Boolean));
      try {
        // the race keeps the limit even for a provider that ignores its signal
        rows = await Promise.race([p.run(env, q, Math.max(want, 5), sig), new Promise((_, no) => { if (sig.aborted) no(sig.reason); else sig.addEventListener('abort', () => no(sig.reason), { once: true }); })]);
        err = null;
      } catch (e) {
        if (signal?.aborted) throw stopped();
        err = e;
        const wait = e.code === 'http' && e.status === 429 ? Math.max(retryWaitMs, e.retryAfterMs || 0) : retryWaitMs;
        if (attempt || !curable(e, 2000) || left() < wait + minSliceMs) break;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (rows) {
      let added = 0; const cap = p.cap ? Math.min(p.cap, want) : want;
      for (const r of rows) {
        if (added >= cap) break;
        if (!/^https?:\/\//i.test(r.url) || !r.title) continue;
        const k = normUrl(r.url); if (seen.has(k)) continue; seen.add(k);
        results.push({ title: r.title, url: r.url, snippet: r.snippet || '', source: p.label }); added++;
      }
      attempts.push({ provider: p.id, label: p.label, ok: true, n: added, note: rows.length ? '' : 'no results', ms: Date.now() - t0 });
    } else attempts.push({ provider: p.id, label: p.label, ok: false, n: 0, note: plainError(err), error: fullError(err), ms: Date.now() - t0 });
  }
  return { results, attempts, notTried };
}
