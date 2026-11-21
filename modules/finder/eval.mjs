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

/** The stand-in web: an answer page per question (on the web, on Wikipedia, or both) and a decoy index page on the web. */
export function corpus(set = SET) {
  const pages = new Map(); const web = []; const wiki = [];
  for (const x of set.questions) {
    const s = slug(x.title);
    const body = [...INTRO.map((f) => f(x.title)), x.fact, OUTRO(x.title)];
    const place = x.id % 3;                                     // 0: both, 1: web only, 2: Wikipedia only
    if (place !== 2) { const url = `https://notes.example/${s}`; pages.set(url, html(x.title, body)); web.push({ url, title: x.title, text: body.join(' ') }); }
    if (place !== 1) { const key = x.title.replace(/ /g, '_'); const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(key)}`; pages.set(url, html(x.title, body)); wiki.push({ url, key, title: x.title, text: body.join(' ') }); }
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
/** Finder: several wordings to both providers at once, the best pages read, passages ranked. A fresh library each time. */
export async function finderPath(question, fetch) {
  const { db, kv } = memoryDoor();
  const f = createFinder({
    library: createLibrary(db, kv), providers: () => ['duckduckgo', 'wikipedia'],
    searchOne: async (q, id, signal) => (await runChain(env(fetch), q, { count: 8, only: [id], signal })).results,
    read: (url, signal) => readPage(fetch, url, { signal, lookup }),
  });
  return (await f.find(question)).passages.map((p) => p.text);
}

const has = (text, answers) => answers.some((a) => text.toLowerCase().includes(a.toLowerCase()));
/** Score one path: in the first SHORT characters handed over, and anywhere in what is handed over. */
export async function score(path, set = SET, fetch = standInFetch(corpus(set))) {
  let short = 0, any = 0; const misses = [];
  for (const x of set.questions) {
    const texts = await path(x.q, fetch); const all = texts.join('\n');
    const s = has(all.slice(0, SHORT), x.answers), a = has(all, x.answers);
    short += s; any += a; if (!s) misses.push(x.id);
  }
  return { n: set.questions.length, short, any, misses };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const pct = (k, n) => `${k}/${n} (${Math.round((100 * k) / n)}%)`;
  console.log(`Measured on stand-in pages (${SET.questions.length} questions with fixed answers), not on the live web.`);
  for (const [name, p] of [['Old search path', oldPath], ['Finder', finderPath]]) {
    const r = await score(p);
    console.log(`${name.padEnd(16)} answer in the first ${SHORT} characters: ${pct(r.short, r.n)}; anywhere in what is returned: ${pct(r.any, r.n)}`);
  }
}
