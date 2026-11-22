// Page-reading services: a second try for a page the desk's own read found empty or too heavy. Off until the owner
// adds a key or switches on the keyless tier the service documents. Never used to get past a site that said no:
// no stealth or rotating proxies are asked for, and services built to defeat blocks are not offered.
// What each one says about itself is what its own public documentation said when this was written (22 Nov 2026).
import { UA } from './providers.js';

/**
 * Each: { id, label, signup, keyless: line or null, keyFrom: 'module' | 'service' (the shared Jina key), request(url, { key, want }) -> [address, init], parse(json, want) -> { status, title, body, finalUrl } | null }
 * want: 'markdown' (text for agents) or 'html' (the page's markup, for Tables).
 */
export const READERS = [
  {
    id: 'firecrawl', label: 'Firecrawl', signup: 'https://firecrawl.dev', keyFrom: 'module',
    keyless: 'Without a key: Firecrawl\'s own page says 1,000 free credits a month (read 22 Nov 2026).',
    robots: 'Firecrawl says it keeps to robots.txt by default.',
    request(url, { key, want }) {
      // no Authorization header at all for the keyless tier: the service grants it only then
      return ['https://api.firecrawl.dev/v2/scrape', { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json', 'User-Agent': UA, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ url, formats: [want], onlyMainContent: want === 'markdown', proxy: 'basic', timeout: 30000 }) }];
    },
    parse(d, want) {
      if (!d?.success || !d.data) return null;
      const m = d.data.metadata || {};
      return { status: Number(m.statusCode) || null, title: m.title || '', body: String((want === 'html' ? d.data.html : d.data.markdown) || ''), finalUrl: m.url || m.sourceURL || null };
    },
  },
  {
    id: 'jina', label: 'Jina Reader', signup: 'https://jina.ai/reader', keyFrom: 'service',
    keyless: 'Without a key: Jina\'s own page says it is free, with the lowest rate limit (read 22 Nov 2026).',
    robots: 'Jina keeps to robots.txt only when asked; the desk always asks.',
    request(url, { key, want }) {
      // X-Robots-Txt: keep to the site's robots.txt; X-Assert-Status-Code: refuse unless the site answered 200
      return [`https://r.jina.ai/${url}`, { headers: { Accept: 'application/json', 'User-Agent': UA, 'X-Robots-Txt': UA, 'X-Assert-Status-Code': '200', ...(want === 'html' ? { 'X-Respond-With': 'html' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) } }];
    },
    parse(d, want) {
      const x = d?.data; if (!x || typeof x !== 'object') return null;
      return { status: null, title: x.title || '', body: String((want === 'html' ? x.html : x.content) || ''), finalUrl: x.finalUrl || x.url || null };
    },
  },
];

/** The service's own refusal in plain words. The answer's body is never shown: it is untrusted and could echo a key. */
export function serviceError(label, status) {
  if (status === 401 || status === 403) return `${label} did not accept the key.`;
  if (status === 402) return `${label} says the allowance is used up.`;
  if (status === 429) return `${label} asked the desk to wait (too many reads).`;
  if (status === 422) return `${label} says the site did not answer with a page.`;
  return `${label} answered ${status}.`;
}
