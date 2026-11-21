// One page read for Tables: the Search module's reader (address guard and the owner's website rules on every hop,
// Readability, size limits, bot-check refusal) with the raw HTML kept so tables can be found, and robots.txt first.
import { readPage } from '../search/reader.js';
import { checkUrlDeep } from '../search/guard.js';
import { UA } from '../search/providers.js';
import { robotsAllows } from '../network/watch.js';

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** robots.txt of the page's site, read once per run (cache: a Map). Throws { code: 'robots' } when the page is not allowed. */
export async function robotsCheck(fetchFn, url, { cache, lookup, deskPort, signal } = {}) {
  const u = new URL(url); const key = u.origin;
  let text = cache?.get(key);
  if (text === undefined) {
    text = '';
    let cur = new URL('/robots.txt', u.origin);
    for (let hop = 0; hop < 4; hop++) {
      await checkUrlDeep(cur.href, { deskPort, lookup });
      let res;
      try { res = await fetchFn(cur, { headers: { 'User-Agent': UA, Accept: 'text/plain,*/*;q=0.5' }, redirect: 'manual', signal }); }
      catch (e) { if (signal?.aborted) throw err('aborted', 'Stopped'); throw err('robots', `The robots.txt of ${u.hostname} did not answer, so the page was not read this time.`); }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) { try { await res.body?.cancel(); } catch {} cur = new URL(res.headers.get('location'), cur); continue; }
      if (res.status >= 500) { try { await res.body?.cancel(); } catch {} throw err('robots', `The robots.txt of ${u.hostname} answered ${res.status}, so the page was not read this time.`); }
      text = res.status === 200 ? (await res.text()).slice(0, 500_000) : '';     // no robots.txt: every page may be read
      break;
    }
    cache?.set(key, text);
  }
  if (!robotsAllows(text, u.pathname + u.search, UA)) throw err('robots', `The robots.txt of ${u.hostname} does not allow reading this page, so it was not read.`);
}

/**
 * readHtml(fetchFn, url, opts) -> { url, finalUrl, title, html, fetchedAt }. Throws like the Search reader
 * (code: bad_url | private | rule_* | http (with status) | blocked | empty | too_large | unsupported | aborted | timeout | network),
 * or robots, or offsite. robots.txt is checked for every address asked for, the first and each redirect target alike.
 * site: when given, an address on another site (a redirect away from it) is refused before anything is sent to it.
 */
export async function readHtml(fetchFn, url, { robots, site, lookup, deskPort, signal } = {}) {
  const cache = robots || new Map(); const bare = (h) => String(h).toLowerCase().replace(/^www\./, '');
  let page = null; let refusal = null;
  const keep = async (u, init) => {
    const at = new URL(String(u));
    try {
      if (site && bare(at.hostname) !== bare(site)) throw err('offsite', `The address leads to another site (${at.hostname}), so it was not read.`, { host: at.hostname });
      await robotsCheck(fetchFn, at.href, { cache, lookup, deskPort, signal });
    } catch (e) { refusal = e; throw e; }
    const r = await fetchFn(u, init); page = r.status === 200 ? r.clone() : null; return r;
  };
  let p;
  try { p = await readPage(keep, url, { signal, deskPort, lookup }); }
  catch (e) { throw refusal || e; }
  if (p.kind !== 'html' || !page) throw err('unsupported', 'This address is not a web page with a list on it.');
  const html = await page.text();
  return { url: p.url, finalUrl: p.finalUrl, title: p.title, html, fetchedAt: p.fetchedAt };
}
