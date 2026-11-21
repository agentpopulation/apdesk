// Passages and a small BM25 ranker in plain JS. Used for the pages read for one question; the library itself is
// ranked by SQLite FTS5 (bm25) in library.js. Passages are exact slices of the page text, so quotes stay word for word.

const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its ' +
  'of on or our than that the their them then there these they this those to was we were what when where which who whom whose why ' +
  'will with would you your about after before over under between me my so not no yes also any some such per vs via up down out ' +
  'tell give find show please name called much many').split(/\s+/));

/** Words of a text as the ranker compares them: lower case, letters and digits, no stop words, light endings folded. */
export function tokens(text) {
  const out = [];
  for (const raw of String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}
/** The plain words of a text without stop words (no endings folded), for the library's FTS5 query. */
export function keywords(text) {
  return [...new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w)))];
}
// a question asks "who won", a page says "winning" or "Spain's win": the past forms that do not end in "ed" fold too
const IRREGULAR = { won: 'win', wrote: 'write', written: 'write', began: 'begin', begun: 'begin', built: 'build', held: 'hold', fought: 'fight', sang: 'sing', sung: 'sing', ran: 'run', became: 'become', drew: 'draw', drawn: 'draw', beaten: 'beat', lost: 'lose', made: 'make', sank: 'sink', sunk: 'sink', flew: 'fly', flown: 'fly' };
function stem(w) {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length > 4 && /[^aeiou]tres?$/.test(w)) w = w.replace(/tre(s?)$/, 'ter$1');   // metre and meter, litre and liter
  if (w.length > 5 && w.endsWith('ing')) { w = w.slice(0, -3); return /([^aeiouls])\1$/.test(w) ? w.slice(0, -1) : w; }   // winning: win
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

// The reader's plain text is the page's text content, which joins blocks with nothing between them ("ContentsHistory",
// "pointElevation8,848 m"). Its markup copy keeps each block apart, so the text Finder splits is made from that.
const LINK = /\[((?:\\.|[^\]\\])*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"(?:\\.|[^"\\])*")?\)/g;
const IMAGE = /!\[(?:\\.|[^\]\\])*\]\((?:[^()\s]|\([^()]*\))*(?:\s+"(?:\\.|[^"\\])*")?\)/g;
/**
 * Page markup (as the reader gives it) to plain text: each block on its own line, a blank line between paragraphs,
 * lines that are only links (menus, contents, "See also") left out, and no marks left. The words are the page's own.
 */
export function plainText(markdown) {
  const out = [];
  for (const raw of String(markdown || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw) || /^\s*([-*_]\s*){3,}$/.test(raw)) { out.push(''); continue; }
    let links = 0;
    let line = raw.replace(IMAGE, '').replace(LINK, (_, t) => { links++; return '\u0001' + t + '\u0002'; });
    if (links && !/[\p{L}\p{N}]/u.test(line.replace(/\u0001[^\u0002]*\u0002/g, '').replace(/^\s*(?:[-*+]|\d+\\?\.)\s+/, ''))) continue;
    line = line.replace(/[\u0001\u0002]/g, '').replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*(?:[-*+]|\d+\\?\.)\s+/, '')
      .replace(/(\*\*|__)(?=\S)(.+?\S)\1/g, '$2').replace(/(^|[^\w\\])([*_])(?=\S)(.+?\S)\2(?!\w)/g, '$1$3').replace(/`([^`]+)`/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|=])/g, '$1').trim();
    if (line || out.at(-1) !== '') out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** The text of a page read, with its blocks apart: from the markup copy when the reader made one, else its text. */
export function pageText(page) {
  const md = page?.markdown; const text = String(page?.text || '');
  if (!md || md === text || page.kind === 'pdf' || page.kind === 'text') return text;
  const t = plainText(md);
  return t.length >= 80 ? t : text;
}

/**
 * How much of a passage reads as sentences, from 0 to 1. Lines of a few words with no sentence end (headings, menus,
 * fact boxes), words glued together where blocks met ("ContentsHistory"), and reference lists ("Retrieved", "ISBN", "^")
 * all count against it: a line that is one entry of a reference list is never a sentence, however it ends.
 */
export function prose(text) {
  let all = 0, said = 0;
  for (const line of String(text || '').split('\n')) {
    const n = words(line); if (!n) continue; all += n;
    if (CITE.test(line)) continue;                                             // one entry of a reference list
    const end = line.trim().replace(/(\[[^\]]{1,12}\])+$/, '');
    const ask = /\?["”')\]]?$/.test(end);
    const capital = (line.match(/(^|\s)\p{Lu}/gu) || []).length / n;              // Title Case: a heading
    if ((n >= 4 && /[.!]["”')\]]?$/.test(end)) || (n >= 8 && !ask && capital < 0.6) || (ask && n >= 15)) said += n;
  }
  if (!all) return 0;
  let q = said / all;
  const glued = (String(text).match(/\p{Ll}{2}[\p{Lu}\p{N}]|\p{N}[\p{Lu}]\p{Ll}/gu) || []).length;
  if (glued / all > 0.04) q *= 0.2;
  const cites = (String(text).match(/\b(?:Retrieved|Archived|ISBN|ISSN|OCLC|doi|PMID)\b|(?:^|\s)[\^↑](?=\s)|\bpp?\.\s?\d/g) || []).length;
  if (cites * 15 > all) q *= 0.2;
  return q;
}
// a line that is one entry of a reference list: when it was looked up or kept, a book or paper number, a back mark
const CITE = /\b(?:Retrieved|Accessed|Archived)\b[^.]{0,40}\b\d{4}\b|\b(?:ISBN|ISSN|OCLC|PMID|doi)\b|^\s*[\^↑]/;
// the measure a "how ..." question asks for, as a page names it
const MEASURE = { high: 'height', tall: 'height', long: 'length', deep: 'depth', wide: 'width', far: 'distance', old: 'age', heavy: 'weight', fast: 'speed', big: 'size', hot: 'temperature', cold: 'temperature' };
const FIGURE = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|dozen)\b/i;
const MIN_PROSE = 0.3;     // below this a passage is a list, a heading or a reference, not an answer
const MIN_COVER = 0.5;     // share of the question's key words a passage (with its page title) must have; more than this when strict

// Pages say what they are about first (an encyclopedia's opening, a news story's first lines): a passage near the top of
// its page counts for more, by up to LEAD, less and less further down.
const LEAD = 0.6, LEAD_CHARS = 2000;
// Words of the question the page's title already names: every passage of that page is about them, so inside its
// passages they count for this much, and the question's other words decide which passage answers.
const NAMED = 0.3;
const MAX_WORDS = 90, MIN_WORDS = 20;
const words = (t) => t.split(/\s+/).filter(Boolean).length;

/**
 * Split page text into passages of a few sentences, never across a paragraph. Returns [{ pos, text }], each text an
 * exact slice of the input. Readers often join paragraphs with no space ("end.Next"), so a sentence end followed by
 * a capital letter counts too.
 */
export function splitPassages(text) {
  const src = String(text || '');
  const sentences = [];                                            // [start, end, paragraphStart]
  const para = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g; let m;
  while ((m = para.exec(src))) {
    const ps = m.index, pe = m.index + m[0].length;
    const cut = /[.!?]["')\]]?(?=\s+\S|[A-Z])/g; cut.lastIndex = ps; let s = ps, c, first = true;
    const push = (a, b) => { while (a < b && /\s/.test(src[a])) a++; while (b > a && /\s/.test(src[b - 1])) b--; if (b > a) { sentences.push([a, b, first, false]); first = false; } };
    const at = sentences.length;
    while ((c = cut.exec(src)) && c.index < pe) { const e = c.index + c[0].length; if (e >= pe) break; push(s, e); s = e; }
    push(s, pe);
    if (sentences.length === at + 1) sentences[at][3] = true;      // the paragraph is one line
  }
  const out = []; let cur = null;
  for (const [a, b, newPara, oneLine] of sentences) {
    const n = words(src.slice(a, b));
    if (cur && !newPara && cur.n + n <= MAX_WORDS && cur.n < MIN_WORDS + 40) { cur.end = b; cur.n += n; continue; }
    if (cur && newPara && (cur.n < 8 || cur.head) && cur.n + n <= MAX_WORDS) { cur.end = b; cur.n += n; cur.head = false; continue; }   // a heading joins its paragraph
    if (cur) out.push(cur);
    cur = { start: a, end: b, n, head: newPara && oneLine && n <= 12 && !/[.!]["')\]]?$/.test(src.slice(a, b)) };
    while (cur.n > MAX_WORDS) {                                    // one very long sentence: cut at a word
      const w = /\S+/g; w.lastIndex = cur.start; let k = 0, e = cur.start, x;
      while ((x = w.exec(src)) && k < MAX_WORDS) { k++; e = x.index + x[0].length; }
      out.push({ start: cur.start, end: e, n: k });
      let s2 = e; while (s2 < cur.end && /\s/.test(src[s2])) s2++;
      cur = { start: s2, end: cur.end, n: cur.n - k };
    }
  }
  if (cur && cur.n) out.push(cur);
  return out.map((p, pos) => ({ pos, start: p.start, end: p.end, text: src.slice(p.start, p.end) }));
}

/**
 * Rank passages against a question with BM25 over the passages given. Each passage keeps its own fields.
 * Returns only passages that answer: they read as sentences, and they (with their page title) have at least half of
 * the question's key words (more than half when strict: passages from the library), and, when the question asks for an
 * amount ("how high", "how many"), they give a figure. Best first, with `score`; a passage may carry `start`, where it
 * begins in its page, so the opening of a page counts for more.
 */
export function rankPassages(question, passages, { k1 = 1.2, b = 0.75, strict = false } = {}) {
  const q = [...new Set(tokens(question))];
  if (!q.length || !passages?.length) return [];
  const docs = passages.map((p) => tokens(p.text));
  const N = docs.length; const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map(q.map((t) => [t, 0]));
  for (const d of docs) { const seen = new Set(d); for (const t of q) if (seen.has(t)) df.set(t, df.get(t) + 1); }
  const qBigrams = new Set(); const qt = tokens(question); for (let i = 1; i < qt.length; i++) qBigrams.add(qt[i - 1] + ' ' + qt[i]);
  const idf = (t) => Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
  // Key words: all but the kind of answer asked for ("how high", "what year", "which gas", "how many minutes"), which a
  // page gives as a number or a name instead. A key word no passage has: pages found by searching this question often
  // say it in other words ("high" for "height"), so it is not asked for there; passages from the library were not
  // found for this question (strict), so there it is asked for, and a question about another place or thing goes unanswered.
  const asks = new Set([...String(question).toLowerCase().matchAll(/\b(?:how(?:\s+(?:many|much))?|what|which)\s+(\p{L}+)/gu)].map((m) => stem(m[1])));
  const key = q.filter((t) => !asks.has(t)); const keys = (key.length ? key : q).filter((t) => strict || df.get(t) > 0);
  // "how high": a page says "height", or gives the figure; "high" alone ("high-altitude winds") is not the answer
  for (const a of asks) if (MEASURE[a]) {
    if (q.includes(a)) q.splice(q.indexOf(a), 1);
    if (!q.includes(MEASURE[a])) { q.push(MEASURE[a]); df.set(MEASURE[a], docs.filter((d) => d.includes(MEASURE[a])).length); }
  }
  const weight = q.reduce((s, t) => s + idf(t), 0);
  // "how high", "how many": the answer is an amount, which a page gives as a figure or a number word
  const amount = /\bhow\s+(?:many|much)\b/i.test(question) || [...asks].some((a) => MEASURE[a]);
  // "What is X?": the passage with a sentence that starts "X is ..." gives the answer the question asks for
  const subject = /^\s*(?:what|who)\s+(?:is|are|was|were)\s+(?:an?\s+|the\s+)?(.+?)[\s?.!]*$/i.exec(question)?.[1];
  const defines = subject ? new RegExp(`(^|[.!?]["')\\]]?\\s+|\\n)(the\\s+|an?\\s+)?${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\[[^\\]]{1,12}\\])*\\s+(is|are|was|were)\\s`, 'iu') : null;
  const out = [];
  passages.forEach((p, i) => {
    const d = docs[i]; if (!d.length) return;
    const named = new Set(tokens(p.title || '')); const has = new Set([...d, ...named]);
    const share = keys.filter((t) => has.has(t)).length / (keys.length || 1);
    if (strict ? !(share > MIN_COVER) : share < MIN_COVER) return;
    const pq = prose(p.text); if (pq < MIN_PROSE) return;
    const tf = new Map(); for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0, hit = 0;
    for (const t of q) {
      const f = tf.get(t) || 0; if (!f) continue; hit++;
      score += (named.has(t) ? NAMED : 1) * idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
    }
    if (!hit) return;
    let pairs = 0; for (let j = 1; j < d.length; j++) if (qBigrams.has(d[j - 1] + ' ' + d[j])) pairs++;
    score += 0.3 * Math.min(pairs, 3);                                  // words of the question side by side
    if (defines?.test(p.text)) score += 2;
    score *= 0.5 + 0.5 * q.reduce((s, t) => s + (has.has(t) ? idf(t) : 0), 0) / (weight || 1);   // more of the question, the rarer words most, first
    score *= pq;                                                        // sentences before lists and headings
    if (amount && !FIGURE.test(p.text)) return;                          // asked for an amount, it gives none: not an answer
    if (Number.isFinite(p.start)) score *= 1 + LEAD / (1 + p.start / LEAD_CHARS);    // the opening of its page first
    out.push({ ...p, score: Math.round(score * 1000) / 1000 });
  });
  return out.sort((a, b2) => b2.score - a.score);
}
