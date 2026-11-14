// Check-only stand-in for the Search module: Wikipedia's API for search, plain fetches
// for reading. Used by real-check.mjs only when the real Search module does not load. Never shipped as the search path.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const UA = { 'user-agent': 'AgentPopulationDesk-check/0.1 (local test)' };

export function wikiSearch() {
  return {
    source: 'check-wikipedia',
    async search(q, { count = 10, signal } = {}) {
      const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${Math.min(20, count)}&srsearch=${encodeURIComponent(q)}`;
      const r = await fetch(u, { headers: UA, signal }); const j = await r.json();
      return (j.query?.search || []).map(s => ({ title: s.title, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(s.title.replace(/ /g, '_')), snippet: String(s.snippet || '').replace(/<[^>]+>/g, ''), source: 'wikipedia' }));
    },
    async read(url, { signal } = {}) {
      const m = String(url).match(/^https:\/\/en\.wikipedia\.org\/wiki\/(.+)$/);
      if (m) {
        const title = decodeURIComponent(m[1]);
        const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${encodeURIComponent(title)}`, { headers: UA, signal });
        const j = await r.json(); const p = Object.values(j.query?.pages || {})[0] || {};
        return { url, title: p.title || title, text: String(p.extract || '').slice(0, 40000) };
      }
      const r = await fetch(url, { headers: UA, signal, redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text(); const { document } = parseHTML(html);
      const art = new Readability(document).parse();
      return { url: r.url || url, title: art?.title || document.title || url, text: String(art?.textContent || document.body?.textContent || '').replace(/\s+/g, ' ').slice(0, 40000) };
    },
  };
}
/** Plain text of a fetched page, for checking that a source names a company. */
export async function fetchText(url, { signal } = {}) {
  const r = await fetch(url, { headers: UA, signal, redirect: 'follow' });
  const html = await r.text();
  const { document } = parseHTML(html);
  return { status: r.status, text: String(document.body?.textContent || html).replace(/\s+/g, ' '), html };
}
