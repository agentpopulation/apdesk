// The one page reader: fetch, then Readability (on linkedom) for HTML, unpdf for PDF, turndown for Markdown.
// Pages are untrusted data. The reader only returns text; it never follows instructions found in a page.
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { UA, plain } from './providers.js';
import { checkUrl, checkUrlDeep } from './guard.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 200_000;

/** Kept for callers of the old name: the text-only check. The reader itself uses checkUrlDeep on every hop. */
export const publicUrl = (raw, opts) => checkUrl(raw, opts);

const CHALLENGE = /<title>\s*(Just a moment|Attention Required|Access denied|Are you a robot|Security check)|cf-chl-|challenge-platform|g-recaptcha|h-captcha|px-captcha|Please enable JS and disable any ad blocker/i;

async function readBody(res, signal) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw Object.assign(new Error('The page is too large to read.'), { code: 'too_large' });
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    if (signal?.aborted) { try { await reader.cancel(); } catch {} throw Object.assign(new Error('Stopped'), { code: 'aborted' }); }
    const { value, done } = await reader.read(); if (done) break;
    n += value.length; if (n > MAX_BYTES) { try { await reader.cancel(); } catch {} throw Object.assign(new Error('The page is too large to read.'), { code: 'too_large' }); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

let td = null;
function turndown(html) { td ||= new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }); try { return td.turndown(html); } catch { return ''; } }

export function htmlToDoc(html, url) {
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll('script,style,noscript,template,iframe,svg')) el.remove();
  const pageTitle = plain(document.querySelector('title')?.textContent || '');
  let art = null;
  try { art = new Readability(document, { charThreshold: 300 }).parse(); } catch {}
  let text = art?.textContent || '';
  let markdown = art?.content ? turndown(art.content) : '';
  if (text.replace(/\s+/g, ' ').trim().length < 300) {          // Readability gave up: plain body text
    const { document: d2 } = parseHTML(html);
    for (const el of d2.querySelectorAll('script,style,noscript,template,iframe,svg,nav,header,footer,form')) el.remove();
    text = d2.body?.textContent || d2.documentElement?.textContent || '';
    markdown = '';
  }
  text = text.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: plain(art?.title || pageTitle) || new URL(url).hostname, text, markdown: markdown || text, byline: art?.byline || null, published: art?.publishedTime || null };
}

export async function pdfToText(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  let title = null; try { title = (await pdf.getMetadata())?.info?.Title || null; } catch {}
  return { title, text: String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), pages: totalPages };
}

/**
 * read(fetch, url, { signal }) -> { url, finalUrl, status, title, text, markdown, kind: 'html'|'pdf'|'text', bytes, fetchedAt }
 * Throws with code: bad_url | private | http | blocked | empty | too_large | unsupported | aborted | timeout.
 */
export async function readPage(fetchFn, rawUrl, { signal, timeoutMs = 20000, deskPort = null, lookup } = {}) {
  const ac = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
  const headers = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5', 'Accept-Language': 'en' };
  const fail = (e) => { if (signal?.aborted) return Object.assign(new Error('Stopped'), { code: 'aborted' }); return Object.assign(new Error(e.name === 'TimeoutError' ? 'The page did not answer in time.' : `Could not reach the page (${e.cause?.code || e.message}).`), { code: e.name === 'TimeoutError' ? 'timeout' : 'network' }); };
  // Every hop is checked (address text and DNS) before a request is sent; redirects are followed here, at most 5.
  const first = await checkUrlDeep(rawUrl, { deskPort, lookup });
  let cur = first; let res = null;
  for (let hop = 0; ; hop++) {
    try { res = await fetchFn(cur, { headers, redirect: 'manual', signal: ac }); }
    catch (e0) {
      if (hop === 0 && cur.protocol === 'http:' && !signal?.aborted && e0.name !== 'TimeoutError') {
        const s = new URL(cur.href); s.protocol = 'https:';
        try { res = await fetchFn(s, { headers, redirect: 'manual', signal: ac }); cur = s; } catch (e1) { throw fail(e1); }
      } else throw fail(e0);
    }
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    const loc = res.headers.get('location'); try { await res.body?.cancel(); } catch {}
    if (!loc) throw Object.assign(new Error(`The page answered ${res.status} with nowhere to go.`), { code: 'http', status: res.status });
    if (hop >= 4) throw Object.assign(new Error('The page redirected too many times.'), { code: 'http', status: res.status });
    cur = await checkUrlDeep(new URL(loc, cur).href, { deskPort, lookup });
  }
  const u = first; const finalUrl = cur.href;
  if (res.status !== 200) { try { await res.body?.cancel(); } catch {} throw Object.assign(new Error(`The page answered ${res.status}.`), { code: 'http', status: res.status }); }
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  const buf = await readBody(res, ac);
  const isPdf = type.includes('application/pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-';
  let out;
  if (isPdf) {
    const p = await pdfToText(buf).catch((e) => { throw Object.assign(new Error('The PDF could not be read: ' + e.message), { code: 'unsupported' }); });
    out = { title: p.title || decodeURIComponent(u.pathname.split('/').pop() || u.hostname), text: p.text, markdown: p.text, kind: 'pdf', pages: p.pages };
  } else if (type.includes('html') || type.includes('xml') || !type) {
    const html = buf.toString('utf8');
    if (CHALLENGE.test(html.slice(0, 20000)) && html.length < 60000) throw Object.assign(new Error('The site answered with a bot check; not read (we never work around it).'), { code: 'blocked' });
    out = { ...htmlToDoc(html, finalUrl), kind: 'html' };
  } else if (type.startsWith('text/') || type.includes('json')) {
    const t = buf.toString('utf8'); out = { title: u.hostname + u.pathname, text: t, markdown: t, kind: 'text' };
  } else throw Object.assign(new Error(`This kind of file (${type.split(';')[0]}) is not read.`), { code: 'unsupported' });
  if (!out.text || out.text.length < 80) throw Object.assign(new Error('The page had no readable text.'), { code: 'empty' });
  if (out.text.length > MAX_TEXT) out.text = out.text.slice(0, MAX_TEXT);
  if (out.markdown.length > MAX_TEXT) out.markdown = out.markdown.slice(0, MAX_TEXT);
  return { url: u.href, finalUrl, status: res.status, ...out, bytes: buf.length, fetchedAt: new Date().toISOString() };
}
