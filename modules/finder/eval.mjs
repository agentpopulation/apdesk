// The measure: a fixed set of questions with known answers, scored from recorded stand-in pages, so a change to
// search can be measured without the network. Both paths run the desk's real Search code (its provider parsers and
// its page reader) against stand-in answers for DuckDuckGo and Wikipedia; nothing leaves this computer.
// Usage: node modules/finder/eval.mjs            prints the scores of the old path and of Finder (measured on stand-ins)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runChain } from '../search/providers.js';
import { readPage } from '../search/reader.js';
import { createFinder } from './finder.js';
import { createLibrary } from './library.js';
import { memoryDoor } from './standin.js';
import { tokens } from './rank.js';

export const SET = JSON.parse(fs.readFileSync(new URL('./eval-set.json', import.meta.url), 'utf8'));
export const SHORT = 1500;          // what an agent is handed first: about one screen of text

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const INTRO = [
  (t) => `This note on ${t} is one of a set of short reference notes. It starts with some background before the main points, as most reference pages do.`,
  (t) => `${t} comes up often in school lessons, quizzes and general reading, so this note keeps to short plain sentences that are easy to follow.`,
  () => 'Some readers arrive here from a search and want one quick fact. The parts below are kept short for that reason, and each part stands on its own.',
  () => 'The notes in this set are checked against standard school textbooks. Where sources use different words for the same thing, the more common words are used.',
  () => 'Links to related notes are at the end of the page. They cover the history of the subject, the people involved and where to read more.',
  () => 'Each note in the set has the same layout: a short opening, a few plain paragraphs, and a closing part with links to the other notes.',
];
const OUTRO = (t) => `Other notes in this set cover topics close to ${t}, with the same short layout.`;
const html = (title, paras) => `<!doctype html><html><head><title>${esc(title)}</title></head><body><nav>Home | Notes | About</nav><article><h1>${esc(title)}</h1>${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</article><footer>Stand-in page for the measure.</footer></body></html>`;
// A page shaped like a large encyclopedia article, with no space between its tags: a menu, a table of contents, a fact
// box, the answer fifth of the paragraphs that say anything, then "See also" links and a list of references. The
// question's own words fill the contents, the links and the references, so a ranker that counts words alone picks them.
// A page can also carry `lead` (the answer said in the opening, in other words than the question's) and `decoys`
// (sentences further down that use the question's own words but do not answer it), as on long real pages.
const li = (t, href = '#' + slug(t)) => `<li><a href="${esc(href)}">${esc(t)}</a></li>`;
const messy = (x) => { const t = x.title; return `<!doctype html><html><head><title>${esc(t)}</title></head><body>`
  + `<nav><ul>${['Main page', 'Contents', 'Current events', 'Random article'].map((m) => li(m, '/wiki/' + slug(m))).join('')}</ul></nav>`
  + `<main><article><h1>${esc(t)}</h1><div id="toc"><h2>Contents</h2><ul>${[`${t} overview`, 'History', 'Geography', `${t} records`, 'See also', 'References'].map((m) => li(m)).join('')}</ul></div>`
  + `<table class="infobox"><tr><th>${esc(t)}</th></tr><tr><th>Overview</th><td>${esc(t)} records</td></tr><tr><th>History</th><td>${esc(t)} history</td></tr></table>`
  + [...(x.lead ? [x.fact] : []), ...INTRO.slice(0, 4).map((f) => f(t)), ...(x.extra ? [x.extra] : []), ...(x.lead ? [] : [x.fact]), ...INTRO.slice(4).map((f) => f(t)), ...(x.decoys || [])].map((p) => `<p>${esc(p)}</p>`).join('')
  + `<h2 id="see_also">See also</h2><ul>${[`List of ${t} records`, `${t} in popular culture`, `Timeline of ${t}`].map((m) => li(m, '/wiki/' + slug(m))).join('')}</ul>`
  + `<h2 id="references">References</h2><ol>${[1, 2, 3, 4].map((n) => `<li>^ "${esc(t)}: the full record, part ${n}". Notes. Retrieved 3 May 2023. Archived from the original on 4 May 2023.</li>`).join('')}</ol>`
  + `<ol>${[1, 2, 3].map((n) => `<li>"${esc(t)} | match and records | part ${n} of the full report". Notes and Records. 3 May 2023. Retrieved 3 May 2023.</li>`).join('')}</ol>`
  + '</article></main><footer>Stand-in page for the measure.</footer></body></html>'; };

/** The stand-in web: an answer page per question (on the web, on Wikipedia, or both) and a decoy index page on the web. */
export function corpus(set = SET) {
  const pages = new Map(); const web = []; const wiki = [];
  for (const x of set.questions) {
    const s = slug(x.title);
    const body = [...INTRO.map((f) => f(x.title)), x.fact, OUTRO(x.title)];
    const place = x.id % 3;                                     // 0: both, 1: web only, 2: Wikipedia only
    const page = () => (x.page === 'messy' ? messy(x) : html(x.title, body));
    if (place !== 2) { const url = `https://notes.example/${s}`; pages.set(url, page()); web.push({ url, title: x.title, text: body.join(' ') }); }
    if (place !== 1) { const key = x.title.replace(/ /g, '_'); const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(key)}`; pages.set(url, page()); wiki.push({ url, key, title: x.title, text: body.join(' ') }); }
    const decoy = [...INTRO.map((f) => f(x.title)), `This index lists every note about ${x.title}: the overview, the history and the further reading.`, OUTRO(x.title)];
    const durl = `https://index.example/${s}`; pages.set(durl, html(`${x.title}: index of notes`, decoy)); web.push({ url: durl, title: `${x.title}: index of notes`, text: decoy.join(' ') });
  }
  return { pages, web, wiki };
}

function match(list, q, n) {
  const qt = new Set(tokens(String(q).replace(/"/g, ' ')));
  if (!qt.size) return [];
  return list.map((d) => {
    const tt = new Set(tokens(d.title)); const bt = new Set(tokens(d.text));
    let s = 0, inTitle = 0; for (const t of qt) { if (tt.has(t)) { s += 2; inTitle++; } if (bt.has(t)) s += 1; }
    return { d, s, inTitle };
  }).filter((x) => x.inTitle > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.d);
}

/** A fetch that answers from the stand-in web only. Anything else is refused, so a run can never reach the network. */
export function standInFetch(c = corpus()) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(String(url)); calls.push(u.href);
    if (u.hostname === 'html.duckduckgo.com') {
      const rows = match(c.web, u.searchParams.get('q'), 10);
      return new Response(`<html><body>${rows.map((d) => `<div class="result"><a class="result__a" href="${esc(d.url)}">${esc(d.title)}</a><a class="result__snippet" href="${esc(d.url)}">${esc(d.text.slice(0, 150))}</a></div>`).join('')}</body></html>`, { headers: { 'content-type': 'text/html' } });
    }
    if (u.hostname === 'en.wikipedia.org' && u.pathname.startsWith('/w/rest.php')) return Response.json({ pages: match(c.wiki, u.searchParams.get('q'), Number(u.searchParams.get('limit')) || 5).map((d) => ({ key: d.key, title: d.title, excerpt: d.text.slice(0, 120) })) });
    if (u.hostname === 'hn.algolia.com') return Response.json({ hits: [] });
    if (u.hostname === 'api.duckduckgo.com') return Response.json({});
    const page = c.pages.get(u.href);
    if (page) return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (/\.example$|wikipedia\.org$/.test(u.hostname)) return new Response('not here', { status: 404 });
    throw new Error('the measure never leaves this computer: ' + u.hostname);
  };
  f.calls = calls; return f;
}
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];   // stand-in DNS: every stand-in host is public
const env = (fetch) => ({ fetch, secret: () => null, searxngUrl: null });

/** The old path as agents use it today: web_search (one provider after another), then web_read of the first result. */
export async function oldPath(question, fetch) {
  const r = await runChain(env(fetch), question, { count: 8 });
  const texts = r.results.slice(0, 3).map((x) => `${x.title}. ${x.snippet}`);
  if (r.results[0]) { try { const p = await readPage(fetch, r.results[0].url, { lookup }); texts.push(p.text.slice(0, 12000)); } catch {} }
  return texts;
}
const finderOn = (fetch, library = createLibrary(memoryDoor().db, memoryDoor().kv)) => createFinder({
  library, providers: () => ['duckduckgo', 'wikipedia'],
  searchOne: async (q, id, signal) => (await runChain(env(fetch), q, { count: 8, only: [id], signal })).results,
  read: (url, signal) => readPage(fetch, url, { signal, lookup }),
});
/** Finder: several wordings to both providers at once, the best pages read, passages ranked. A fresh library each time. */
export async function finderPath(question, fetch) {
  return (await finderOn(fetch).find(question)).passages.map((p) => p.text);
}
/** The library alone: the "after" questions are searched on the stand-in web first, then each absent question is asked of
 *  the library only. Counted right when nothing is handed over and the one line says the library has no answer. The
 *  "after" questions are asked of the library only too (held): counted when the answer is in the first two passages. */
export async function absentScore(set = SET, fetch = standInFetch(corpus(set))) {
  const { db, kv } = memoryDoor(); const f = finderOn(fetch, createLibrary(db, kv));
  const after = set.absent.after.map((id) => set.questions.find((x) => x.id === id));
  for (const x of after) await f.find(x.q);
  let right = 0; const misses = [];
  for (const q of set.absent.questions) {
    const r = await f.find(q, { libraryOnly: true });
    if (!r.passages.length && /^Nothing in your library answers this\./.test(r.nothing || '')) right++; else misses.push(q);
  }
  const held = { n: after.length, two: 0, misses: [] };
  for (const x of after) { const r = await f.find(x.q, { libraryOnly: true }); if (has(r.passages.slice(0, 2).map((p) => p.text).join('\n'), x.answers)) held.two++; else held.misses.push(x.id); }
  return { n: set.absent.questions.length, right, misses, held };
}

const has = (text, answers) => answers.some((a) => text.toLowerCase().includes(a.toLowerCase()));
/** Score one path: in the first SHORT characters handed over, and anywhere in what is handed over. */
export async function score(path, set = SET, fetch = standInFetch(corpus(set))) {
  let short = 0, any = 0, two = 0; const misses = [], messy = { n: 0, two: 0 };
  for (const x of set.questions) {
    const texts = await path(x.q, fetch); const all = texts.join('\n');
    const s = has(all.slice(0, SHORT), x.answers), a = has(all, x.answers), t = has(texts.slice(0, 2).join('\n'), x.answers);
    short += s; any += a; two += t; if (!s) misses.push(x.id);
    if (x.page === 'messy') { messy.n++; messy.two += t; }
  }
  return { n: set.questions.length, short, any, two, messy, misses };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const pct = (k, n) => `${k}/${n} (${Math.round((100 * k) / n)}%)`;
  console.log(`Measured on stand-in pages (${SET.questions.length} questions with fixed answers), not on the live web.`);
  for (const [name, p] of [['Old search path', oldPath], ['Finder', finderPath]]) {
    const r = await score(p);
    console.log(`${name.padEnd(16)} answer in the first ${SHORT} characters: ${pct(r.short, r.n)}; anywhere in what is returned: ${pct(r.any, r.n)}; in the first two items: ${pct(r.two, r.n)}, on the messy pages ${pct(r.messy.two, r.messy.n)}`);
  }
  const a = await absentScore();
  console.log(`Finder, library only, questions it holds no answer to: says so plainly ${pct(a.right, a.n)}; questions it holds: answer in the first two passages ${pct(a.held.two, a.held.n)}`);
}
