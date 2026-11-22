// Checks on the desk's OWN output before it is shown or stored: is it readable text in the script of the conversation, and is
// each figure in it one a page read in this turn (or a record of the desk) gave. Nothing here reads the owner's words to decide
// what his ask is; his message is used only as a record (the numbers he gave, the script he writes in).

/** The one line a turn ends with when no model gave text worth showing. */
export const NO_USABLE = 'No model gave a usable answer. Try again in a moment.';
/** The line under an answer whose figures no page read gave. */
/** The line under a reply the model's length limit cut off (its half sentence taken out). */
export const CUT_LINE = 'The model stopped before the end of this answer.';
export const FIGURES_LINE = 'Figures marked "not checked" were not on any page read in this turn.';

const REFUSAL = /^\W*(?:I(?:'|’)m sorry,? but |Sorry,? )?I can(?:'|’)?t (?:help|assist) with (?:that|this)(?: request)?\W*$|^\W*I(?:'|’)m sorry,? but I can(?:'|’)?not (?:help|assist)[^.!?]*[.!?]?\W*$/i;
const NOT_CHECKED_ONLY = /^\W*(?:not checked|not answered|n\/a)\W*$/i;
const scriptOf = (ch) => {
  if (/\p{Script=Latin}/u.test(ch)) return 'Latin';
  for (const s of ['Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Arabic', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Cyrillic', 'Greek', 'Thai', 'Hebrew']) if (new RegExp(`\\p{Script=${s}}`, 'u').test(ch)) return s;
  return 'Other';
};
const scripts = (t) => { const c = new Map(); for (const ch of String(t || '').match(/\p{L}/gu) || []) { const s = scriptOf(ch); c.set(s, (c.get(s) || 0) + 1); } return c; };

/** Why one paragraph is junk, or null: broken characters, babble marks, a fragment, a bare refusal, "not checked" alone,
 *  or letters of a script that is not the conversation's. */
export function junkWhy(par, allowed = new Set(['Latin'])) {
  const p = String(par || '').trim(); if (!p) return null;
  if (/^\s*```/.test(p) || /^\s*\|/.test(p)) return null;   // code and table rows are judged as they are
  if (/[�]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(p)) return 'broken characters';
  if (NOT_CHECKED_ONLY.test(p)) return 'fragment';
  if (REFUSAL.test(p)) return 'refusal';
  const visible = p.replace(/\s+/g, '');
  const letters = (p.match(/[\p{L}\p{N}]/gu) || []).length;
  if (visible.length >= 4 && letters / visible.length < 0.45) return 'broken characters';
  let marks = 0;
  if (/\?{2,}|[\p{L}]\?[\p{L}]|\[\?/u.test(p)) marks++;
  if (/[.…?]{4,}/.test(p)) marks++;
  if (/[​-‍⁠]/.test(p)) marks++;
  const sc = scripts(p); const all = [...sc.values()].reduce((a, b) => a + b, 0);
  const alien = [...sc].filter(([s]) => !allowed.has(s)).reduce((a, [, n]) => a + n, 0);
  if (alien && (alien / all > 0.3 || all < 20)) marks++;
  if (marks >= 2) return 'broken characters';
  if (/([\p{L}\p{M}]{1,8}?)\1{5,}/u.test(p)) return 'repeated characters';   // "ốngốngốngống…": a model stuck on one sound
  const words = p.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  if (words.length <= 3 && /(?:\.{3}|…|\?{2,}|…\?|\?…)\s*$/.test(p)) return 'fragment';
  return null;
}

/** The reply as it may be shown: junk paragraphs taken out. ok is false when what is left is not an answer (mostly junk, a
 *  bare refusal, only fragments). ownerText: the owner's message, whose script (with Latin) is the conversation's. */
const ENDS_OPEN = /\b(?:a|an|the|of|to|and|or|with|for|in|on|at|by|from|that|which|your|my|our|is|are|was|be)\s*$/i;
/** A one-line reply that stops in the middle of a sentence: no closing mark, and cut off by the model's limit, or stopping
 *  right after a colon or on a word that cannot end one ("…a clear starting point: an office delivery"). */
export function unfinished(text, { cut = false } = {}) {
  const t = String(text || '').trim();
  const lastLine = t.split('\n').filter(l => l.trim() && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)).at(-1) || '';
  if (t.includes('\n') && /^\s*#{1,6}\s|^\s*\*\*[^*]+\*\*\s*$/.test(lastLine)) return true;   // it stops on a heading, with nothing under it
  if (!t || t.includes('\n') || /[.!?…:;)\]"'*`»”’\p{N}]$/u.test(t)) return false;
  if (t.split(/\s+/).length < 6) return false;
  return cut || /:\s*(?:\S+\s+){0,5}\S+$/.test(t) || ENDS_OPEN.test(t);
}
export function usableReply(text, { ownerText = '', cut = false } = {}) {
  const s = String(text || '').replace(/\r\n?/g, '\n');
  const allowed = new Set(['Latin', ...scripts(ownerText).keys()]);
  const main = [...scripts(s)].sort((a, b) => b[1] - a[1])[0]; if (main) allowed.add(main[0]);   // a reply wholly in Hindi is in a script of its own
  const pars = s.split(/\n[ \t]*\n/); let junk = 0; let total = 0; const kept = []; const why = [];
  let inCode = false;
  for (const par of pars) {
    const fences = (par.match(/^\s*```/gm) || []).length;
    const w = inCode || fences ? null : junkWhy(par, allowed);
    if (fences % 2) inCode = !inCode;
    total += par.length;
    if (w) { junk += par.length; why.push(w); } else kept.push(par);
  }
  let out = kept.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  // a long reply the model's limit cut off: the half sentence at its end goes, and the caller says it stopped early
  let cutTail = false;
  if (cut && out.includes('\n') && !/[.!?…:;)\]"'*`»”’|]\s*$/u.test(out)) {
    const i = Math.max(out.lastIndexOf('\n'), ...['. ', '! ', '? '].map(m => out.lastIndexOf(m) + 1));
    out = out.slice(0, i).trim(); cutTail = true;
  }
  const letters = (out.match(/\p{L}/gu) || []).length;
  const ok = !!out && letters >= 2 && !(total && junk / total > 0.5) && !REFUSAL.test(out) && !unfinished(out, { cut });
  if (out && unfinished(out, { cut })) why.push('fragment');
  return { ok, text: ok ? out : '', dropped: why.length, why: [...new Set(why)], cutTail };
}

// ---- figures: a number with a currency, a scale, a percent or a unit of measure
const CUR_PRE = String.raw`(?:US\$|A\$|C\$|S\$|Rs\.?\s?|INR\s?|USD\s?|EUR\s?|GBP\s?|[₹$€£¥])`;
const NUM = String.raw`\d{1,3}(?:[,    ]\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SCALE = String.raw`%|per ?cent\b|k\b|K\b|[Ll]akhs?\b|[Ll]acs?\b|[Cc]rores?\b|[Cc]r\b|[Mm]illion\b|mn\b|[Bb]illion\b|bn\b|[Tt]rillion\b`;
const CUR_SCALE = String.raw`M\b|B\b|T\b|Mn\b|Bn\b`;   // "$3M", "$2B": only after a currency sign
const UNIT = String.raw`(?:[KMGTPE]i?B|[KMGTP]b)(?:\/s|ps)?\b|[KMGTP]?bps\b|(?:[TPE]|peta|tera|exa)?FLOPS\b|ExaFLOPS\b|TOPS\b|[kMG]?W\b|[kMG]Wh\b|[kMG]?Hz\b|nm\b|mm\b|cm\b|km\b|kg\b|mg\b|g\b|ml\b|mL\b|litres?\b|liters?\b|L\b|tonnes?\b|°C\b|×|x\b`;
const POST_CUR = String.raw`\s(?:rupees?|INR|USD|dollars?|euros?|pounds?)\b`;
const FIG = new RegExp(String.raw`(?<![\p{L}\p{N}_:/.,$₹€£¥\[#\-‐‑‒])(${CUR_PRE})?(${NUM})(?:\s?(?:[\-‐‑‒–—]|to)\s?(?:${CUR_PRE})?(${NUM}))?(\+)?(\s?(?:${SCALE})|(?:${CUR_SCALE}))?(\+)?(\s?(?:${UNIT}))?(${POST_CUR})?(?![\p{N}]|[:/.,]\d)`, 'gu');
const CODE = [[/^(?:₹|rs\.?|inr|rupees?)$/i, 'INR'], [/^(?:\$|usd|dollars?|us\$)$/i, 'USD'], [/^a\$$/i, 'AUD'], [/^c\$$/i, 'CAD'], [/^s\$$/i, 'SGD'], [/^(?:€|eur|euros?)$/i, 'EUR'], [/^(?:£|gbp|pounds?)$/i, 'GBP'], [/^¥$/, 'JPY']];
const codeOf = (t) => { const x = String(t || '').trim(); return x ? (CODE.find(([re]) => re.test(x))?.[1] || null) : null; };
const digits = (n) => String(n || '').replace(/[,    ]/g, '');
const unitKey = (u) => String(u || '').trim().toLowerCase().replace(/^×$/, 'x').slice(0, 3);

/** The figures a set of texts gives: { nums: Set of numbers, near: Map number -> the 30 characters after it, lower case }. */
export function figuresIn(...texts) {
  const nums = new Set(); const near = new Map();
  for (const t of texts) {
    const s = String(t || '');
    for (const m of s.matchAll(/\d{1,3}(?:[,    ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
      const n = digits(m[0]); nums.add(n);
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase();
      near.set(n, (near.get(n) || '') + '|' + after);
    }
  }
  return { nums, near };
}
const onRecord = (n, unit, given) => {
  if (!given.nums.has(digits(n))) return false;
  const k = unitKey(unit); if (!k || k === '%' || k === 'x') return true;
  return (given.near.get(digits(n)) || '').includes(k.slice(0, 2));
};
/** A figure placeholder a weak model left ("2 × ? PFLOPS", "? GB"): the line that holds one is junk. */
const PLACEHOLDER = new RegExp(String.raw`[×*]\s*\?|\?\s*[×*]|\d\s?\?\s?\d|\?\s?(?:${UNIT}|${SCALE})`, 'u');
export const hasPlaceholder = (line) => PLACEHOLDER.test(String(line || ''));

/** Each figure (an amount, a percent, a scaled number or a measure) that no record gave gets " (not checked)" right after the
 *  whole figure, never inside a word; an amount in another currency than the owner's is marked the same way. A line holding a
 *  placeholder figure is dropped. Code, citation numbers, years and labels are left as they are.
 *  given: figuresIn(pages read, records, the owner's own words). Returns { text, marked, dropped }. */
export function checkFigures(text, { given = figuresIn(), currency = '' } = {}) {
  let marked = 0; let dropped = 0; let inCode = false;
  const lines = String(text || '').split('\n').filter(line => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return true; }
    if (inCode || !hasPlaceholder(line)) return true;
    dropped++; return false;
  });
  inCode = false;
  const out = lines.map(line => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return line; }
    if (inCode) return line;
    const clean = line.replace(/[ \t]*\(not checked\)/gi, '');
    return clean.replace(FIG, (m, pre, a, b, plus1, scale, plus2, unit, post, at, all) => {
      const cur = codeOf(pre) || codeOf(post);
      if (scale && !cur && new RegExp(`^(?:${CUR_SCALE})$`).test(scale)) scale = '';   // "336 B": a scale letter counts only after a currency
      if (!cur && !scale && !unit) return m;                      // a bare count, a label, a year: not a figure here
      const before = all.slice(0, at);
      if (/`[^`]*$/.test(before)) return m;
      const foreign = !!(cur && currency && cur !== String(currency).toUpperCase());
      const u = unit || scale || cur || '';
      if (!foreign && [a, b].filter(Boolean).every(x => onRecord(x, cur ? '' : u, given))) return m;
      marked++;
      return m.replace(/\s+$/, '') + ' (not checked)' + (/\s$/.test(m) ? ' ' : '');
    });
  });
  return { text: out.join('\n'), marked, dropped };
}

/** The owner's place and money, and the rule on figures, for every writer's instructions. */
export function placeLine({ country = '', currency = '', locale = 'en' } = {}) {
  const name = (type, code) => { try { return code ? new Intl.DisplayNames([locale || 'en'], { type }).of(code) : ''; } catch { return ''; } };
  const place = name('region', country); const money = name('currency', currency);
  const where = place || currency ? `The owner is${place ? ' in ' + place : ''}${currency ? `${place ? ' and' : ''} works in ${money || currency} (${currency})` : ''}. Give money in ${currency || 'his currency'}; never convert another currency by guess. ` : '';
  return where + 'A price, figure or amount needs a page read in this turn or a record of the desk; without one, say it is not checked. Never give a figure from memory as a fact.';
}
