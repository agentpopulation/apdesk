// Rewordings of a question without a model: a quoted phrase, the key terms, and the form without site: limits.
// A model wording (from the caller) is accepted only as one plain short line; it is search text, never instructions.

const QWORDS = new Set('what which who whom whose when where why how is are was were do does did can could should would will the a an of in on at to for from by with and or about tell me give find show please much many long old big tall'.split(' '));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** [question, ...up to 3 rewordings], no repeats (case-insensitive). `extra` is a model's wording, if any. */
export function rewordings(question, { extra = null } = {}) {
  const q = clean(question);
  if (!q) return [];
  const siteless = clean(q.replace(/(?:\b(?:on|from|at|in)\s+)?\bsite:[^\s?!]+/gi, '').replace(/\s+([?!.,;:])/g, '$1').replace(/\b(?:on|from|at)\s+(?:the\s+)?[a-z0-9-]+\.(?:com|org|net|gov|edu|io|in|uk)\b/gi, ''));
  const words = siteless.replace(/[?!.,;:]+(?=\s|$)/g, '').split(' ');
  const key = words.filter((w) => !QWORDS.has(w.toLowerCase()));
  // a phrase: the longest run of capitalised words after the first word, else the first two key words side by side
  let phrase = null, best = [];
  for (let i = 1, run = []; i <= words.length; i++) {
    const w = words[i];
    if (w && /^[A-Z0-9]/.test(w) && !QWORDS.has(w.toLowerCase())) run.push(w);
    else { if (run.length >= 2 && run.length > best.length) best = run; run = []; }
  }
  if (best.length) phrase = best.join(' ');
  else for (let i = 1; i < words.length; i++) if (!QWORDS.has(words[i - 1].toLowerCase()) && !QWORDS.has(words[i].toLowerCase())) { phrase = words[i - 1] + ' ' + words[i]; break; }
  const rest = phrase ? key.filter((w) => !phrase.split(' ').includes(w)) : key;
  const out = [q];
  if (phrase) out.push(clean(`"${phrase}" ${rest.join(' ')}`));
  if (key.length && key.length < words.length) out.push(key.join(' '));
  if (siteless && siteless !== q) out.push(siteless);
  const x = clean(extra);
  if (x && !/[\r\n]/.test(String(extra)) && x.length <= 200 && !/[<>{}`]/.test(x)) out.push(x);
  const seen = new Set(); const uniq = [];
  for (const s of out) { const k = s.toLowerCase(); if (s && !seen.has(k)) { seen.add(k); uniq.push(s); } }
  return uniq.slice(0, extra ? 5 : 4);
}

/**
 * Which provider gets which wording: every provider gets the question, and the other wordings are dealt out in turn,
 * so each one reaches a provider however few there are (with more providers than wordings, they go round again).
 */
export function assign(words, providers) {
  const plan = providers.map((p) => ({ provider: p, query: words[0] }));
  const rest = words.slice(1); if (!rest.length || !providers.length) return order(plan, providers);
  const n = Math.max(rest.length, providers.length);
  for (let i = 0; i < n; i++) plan.push({ provider: providers[i % providers.length], query: rest[i % rest.length] });
  return order(plan, providers);
}
const order = (plan, providers) => providers.flatMap((p) => plan.filter((x) => x.provider === p))
  .filter((x, i, a) => a.findIndex((y) => y.provider === x.provider && y.query === x.query) === i);
