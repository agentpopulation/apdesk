// One page read for Tables: the page itself through the Search module's exposed readHtml (Offline, the owner's website
// rules and the address guard on every hop, size limits, bot-check refusal, the visit log), with robots.txt checked for
// every address asked for and, for next pages, the same-site rule.
import { robotsAllows } from '../network/watch.js';

const err = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** robots.txt of the page's site, read once per run (cache: a Map). Throws { code: 'robots' } when the page is not allowed.
 *  guard(href) checks each address before it is asked for; ua is the name the desk reads pages under. */
export async function robotsCheck(fetchFn, url, { cache, signal, guard, ua } = {}) {
  const u = new URL(url); const key = u.origin;
  let text = cache?.get(key);
  if (text === undefined) {
    text = '';
    let cur = new URL('/robots.txt', u.origin);
    for (let hop = 0; hop < 4; hop++) {
      await guard(cur.href);
      let res;
      try { res = await fetchFn(cur, { headers: { 'User-Agent': ua, Accept: 'text/plain,*/*;q=0.5' }, redirect: 'manual', signal }); }
      catch (e) { if (signal?.aborted) throw err('aborted', 'Stopped'); throw err('robots', `The robots.txt of ${u.hostname} did not answer, so the page was not read this time.`); }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) { try { await res.body?.cancel(); } catch {} cur = new URL(res.headers.get('location'), cur); continue; }
      if (res.status >= 500) { try { await res.body?.cancel(); } catch {} throw err('robots', `The robots.txt of ${u.hostname} answered ${res.status}, so the page was not read this time.`); }
      text = res.status === 200 ? (await res.text()).slice(0, 500_000) : '';     // no robots.txt: every page may be read
      break;
    }
    cache?.set(key, text);
  }
  if (!robotsAllows(text, u.pathname + u.search, ua)) throw err('robots', `The robots.txt of ${u.hostname} does not allow reading this page, so it was not read.`);
}

/**
 * readHtml(fetchFn, url, opts) -> { url, finalUrl, title, html, fetchedAt }. Throws like the Search reader
 * (code: offline | bad_url | private | rule_* | http (with status) | blocked | empty | too_large | unsupported | aborted |
 * timeout | network), or robots, or offsite. robots.txt is checked for every address asked for, the first and each
 * redirect target alike. site: when given, an address on another site (a redirect away from it) is refused before
 * anything is sent to it. search: the Search module's exposed API; the page is read through its readHtml, and each
 * robots.txt address goes through its address guard. fetchFn reads robots.txt.
 */
export async function readHtml(fetchFn, url, { robots, site, signal, search, who } = {}) {
  const cache = robots || new Map(); const bare = (h) => String(h).toLowerCase().replace(/^www\./, '');
  const beforeHop = async (at) => {
    if (site && bare(at.hostname) !== bare(site)) throw err('offsite', `The address leads to another site (${at.hostname}), so it was not read.`, { host: at.hostname });
    await robotsCheck(fetchFn, at.href, { cache, signal, guard: (h) => search.checkUrl(h), ua: search.userAgent });
  };
  if (typeof search?.readHtml !== 'function') throw err('unsupported', 'The Search module is off, so the page was not read.');
  return search.readHtml(url, { signal, who, hop: beforeHop });
}
