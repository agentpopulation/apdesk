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
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

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
    const push = (a, b) => { while (a < b && /\s/.test(src[a])) a++; while (b > a && /\s/.test(src[b - 1])) b--; if (b > a) { sentences.push([a, b, first]); first = false; } };
    while ((c = cut.exec(src)) && c.index < pe) { const e = c.index + c[0].length; if (e >= pe) break; push(s, e); s = e; }
    push(s, pe);
  }
  const out = []; let cur = null;
  for (const [a, b, newPara] of sentences) {
    const n = words(src.slice(a, b));
    if (cur && !newPara && cur.n + n <= MAX_WORDS && cur.n < MIN_WORDS + 40) { cur.end = b; cur.n += n; continue; }
    if (cur && newPara && cur.n < 8 && cur.n + n <= MAX_WORDS) { cur.end = b; cur.n += n; continue; }   // a heading joins its paragraph
    if (cur) out.push(cur);
    cur = { start: a, end: b, n };
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
 * Returns only passages that share at least one word with the question, best first, with `score`.
 */
export function rankPassages(question, passages, { k1 = 1.2, b = 0.75 } = {}) {
  const q = [...new Set(tokens(question))];
  if (!q.length || !passages?.length) return [];
  const docs = passages.map((p) => tokens(p.text));
  const N = docs.length; const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const df = new Map(q.map((t) => [t, 0]));
  for (const d of docs) { const seen = new Set(d); for (const t of q) if (seen.has(t)) df.set(t, df.get(t) + 1); }
  const qBigrams = new Set(); const qt = tokens(question); for (let i = 1; i < qt.length; i++) qBigrams.add(qt[i - 1] + ' ' + qt[i]);
  const out = [];
  passages.forEach((p, i) => {
    const d = docs[i]; if (!d.length) return;
    const tf = new Map(); for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0, hit = 0;
    for (const t of q) {
      const f = tf.get(t) || 0; if (!f) continue; hit++;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
    }
    if (!hit) return;
    let pairs = 0; for (let j = 1; j < d.length; j++) if (qBigrams.has(d[j - 1] + ' ' + d[j])) pairs++;
    score += 0.3 * Math.min(pairs, 3);                                  // words of the question side by side
    score *= 0.5 + 0.5 * (hit / q.length);                              // passages that cover more of the question first
    out.push({ ...p, score: Math.round(score * 1000) / 1000 });
  });
  return out.sort((a, b2) => b2.score - a.score);
}
