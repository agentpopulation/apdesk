// Figures read as figures: each number in a piece of text becomes a token with a kind and a value, worked out from the
// token's own shape and the words right next to it. Two figures are the same only when kind and value are the same.
// A shape that cannot be read for certain is kind 'unsure', and an unsure figure is never the same as any other.
//
// Kinds: number (a count or a plain amount), money (with its currency), percent, time, range, date, day (a day with its
// month), year (next to a month or a day), ordinal, id (phone-like or account-like digits), code (letters and digits
// together, as written), unsure.

// ---- digits of any script into plain digits

/** The first code point of each set of ten Unicode decimal digits (each run of them holds whole sets, 0 to 9 in order). */
const ZEROS = (() => {
  const out = []; const nd = /\p{Nd}/u; const is = (c) => nd.test(String.fromCodePoint(c));
  for (let c = 0; c < 0x20000; c++) {
    if (!is(c)) continue;
    let e = c; while (is(e + 1)) e++;
    for (let z = c; z <= e; z += 10) out.push(z);
    c = e;
  }
  return out;
})();
const digitOf = (cp) => { for (const z of ZEROS) if (cp >= z && cp <= z + 9) return cp - z; return -1; };

/** The text with every decimal digit as 0-9, full-width forms folded, a fixed or thin space between digits as a group
 *  mark, the minus sign as "-", and a dash between digits as "-". */
export function plainDigits(s) {
  let t = String(s ?? '').replace(/(\p{Nd})[   ](?=\p{Nd})/gu, "$1'").normalize('NFKC');
  t = t.replace(/\p{Nd}/gu, (ch) => { const d = digitOf(ch.codePointAt(0)); return d < 0 ? ch : String(d); });
  t = t.replace(/٫/g, '.').replace(/٬/g, ',').replace(/−/g, '-').replace(/’/g, "'");
  return t.replace(/(\d) ?[‐-―] ?(?=\d)/g, '$1-');
}

// ---- a number's value, from its marks

/** Digits before and after the decimal point -> a decimal string with no extra zeros ("4800", "48", "0.5"). */
const dec = (int, frac = '') => { const i = int.replace(/^0+(?=\d)/, '') || '0'; const f = frac.replace(/0+$/, ''); return f ? `${i}.${f}` : i; };
/** A decimal string times ten to the n. */
const shift = (v, n) => { const [i, f = ''] = v.split('.'); const g = f.padEnd(n, '0'); return dec(i + g.slice(0, n), g.slice(n)); };
const GROUP3 = (gs) => gs.length >= 2 && gs[0].length >= 1 && gs[0].length <= 3 && gs.slice(1).every(g => g.length === 3);
const INDIAN = (gs) => gs.length >= 3 && gs[0].length >= 1 && gs[0].length <= 2 && gs.slice(1, -1).every(g => g.length === 2) && gs.at(-1).length === 3;

/**
 * The value of digits with group and decimal marks, or null when the shape does not say it for certain.
 * "4,800", "4,80,000" and "1'000" are grouped; "48.00" has decimals; "1.250,50" and "12,345.67" are read by which mark
 * comes last; "9.500" (one dot, three digits after) and "1,5" (one comma, one or two after) could be read two ways.
 * With style 'point' (a line that also writes an amount like "1.250,50", see styleOf) a point groups thousands and a
 * comma is the decimal mark: "9.500" is nine thousand five hundred and "1,5" is one and a half.
 */
export function numberValue(t, style = '') {
  if (/^\d+$/.test(t)) return dec(t);
  if (!/^\d[\d.,']*\d$/.test(t) || /[.,']{2}/.test(t)) return null;
  if (style === 'point') {
    if (t.includes("'") || t.split(',').length > 2) return null;
    const [int, frac = ''] = t.split(',');
    const gs = int.split('.');
    return gs.length === 1 || GROUP3(gs) ? dec(gs.join(''), frac) : null;
  }
  const marks = [...new Set(t.replace(/\d/g, ''))];
  if (marks.length > 2) return null;
  if (marks.length === 2) {
    const li = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','), t.lastIndexOf("'")); const last = t[li];
    const group = marks.find(m => m !== last); const intPart = t.slice(0, li);
    if (last === "'" || intPart.includes(last)) return null;
    const gs = intPart.split(group);
    return GROUP3(gs) || (group === ',' && INDIAN(gs)) ? dec(gs.join(''), t.slice(li + 1)) : null;
  }
  const m = marks[0]; const gs = t.split(m);
  if (m === "'") return GROUP3(gs) ? dec(gs.join('')) : null;
  if (gs.length > 2) return GROUP3(gs) || (m === ',' && INDIAN(gs)) ? dec(gs.join('')) : null;
  const [a, b] = gs;
  if (m === ',') return b.length === 3 && a.length <= 3 ? dec(a + b) : null;   // "4,800" is four thousand eight hundred; "1,5" is not certain
  if (b.length === 3) return null;                                           // "9.500": nine and a half, or nine thousand five hundred
  return dec(a, b);                                                          // "48.00" is forty-eight
}

/**
 * How one line writes its amounts: 'point' when it writes an amount with points for thousands and a comma for the
 * decimals ("1.250,50") and none the other way ("1,250.50"); else ''. Only then is "9.500" in that line read for certain.
 */
export function styleOf(line) {
  const t = plainDigits(line);
  const point = /(?<![\d.,])\d{1,3}(?:\.\d{3})+,\d+(?![\d.,])/.test(t);
  const comma = /(?<![\d.,])\d{1,3}(?:,\d{2,3})+\.\d+(?![\d.,])/.test(t);
  return point && !comma ? 'point' : '';
}

// ---- words next to a number

const CURRENCY = { '₹': 'INR', rs: 'INR', inr: 'INR', rupee: 'INR', rupees: 'INR', '$': 'USD', usd: 'USD', dollar: 'USD', dollars: 'USD',
  '€': 'EUR', eur: 'EUR', euro: 'EUR', euros: 'EUR', '£': 'GBP', gbp: 'GBP', pound: 'GBP', pounds: 'GBP', '¥': 'JPY', jpy: 'JPY', yen: 'JPY',
  aud: 'AUD', cad: 'CAD', sgd: 'SGD', aed: 'AED', chf: 'CHF', cny: 'CNY' };
const SYM = /[₹$€£¥]/;
/** Size words and letters: a figure's value is the number times ten to this. "m" counts only next to a currency. */
const SIZE = Object.fromEntries(Object.entries({ hundred: 2, thousand: 3, thousands: 3, k: 3, lakh: 5, lakhs: 5, lac: 5, lacs: 5, crore: 7, crores: 7, cr: 7,
  million: 6, millions: 6, mn: 6, billion: 9, billions: 9, bn: 9, trillion: 12, trillions: 12,
  'हज़ार': 3, 'हजार': 3, 'लाख': 5, 'करोड़': 7, 'करोड': 7,          // Hindi and Marathi
  'হাজার': 3, 'লাখ': 5, 'লক্ষ': 5, 'কোটি': 7,                     // Bengali
  'હજાર': 3, 'લાખ': 5, 'કરોડ': 7,                                 // Gujarati
  'ஆயிரம்': 3, 'லட்சம்': 5, 'கோடி': 7,                             // Tamil
  'ہزار': 3, 'لاکھ': 5, 'کروڑ': 7,                                 // Urdu
  'ألف': 3, 'آلاف': 3, 'مليون': 6, 'ملايين': 6, 'مليار': 9,         // Arabic
}).map(([w, n]) => [w.normalize('NFKC'), n]));
/** Words of one or two letters that may follow a number and are not a unit or a size. */
const SHORT = new Set('a i am an as at be by do go he if in is it me my no of oh ok on or so to up us we vs ad pm pc'.split(' '));
/** Units of three letters, written short. */
const UNIT3 = new Set('pcs hrs min sec yrs kgs gms mtr ltr sqm kms mts nos qty sft cms mms pkt pax kwh'.split(' '));
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const monthIn = (w) => { w = String(w || '').toLowerCase(); const i = MONTHS.indexOf(w); return i >= 0 ? i + 1 : MON[w] || 0; };
const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG = { thousand: 3, lakh: 5, lac: 5, crore: 7, million: 6, billion: 9 };
const TIMES = { hundred: 100, dozen: 12 };
/** Number words this reader turns into figures; others ("half", "twice", "hundreds") are matched as words. */
export const READ_WORDS = new Set([...Object.keys(ONES), ...Object.keys(BIG), ...Object.keys(TIMES)]);

// ---- the tokens

const RUN = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}]|[.,':/-](?=[\p{L}\p{N}]))*/gu;
const timeKey = (h, mm, ap) => `${+h}:${mm || '00'}${String(ap || '').toLowerCase().replace(/\./g, '')}`;

/** A decimal string times a whole number ("1.5" times 12 is "18"). */
const times = (v, n) => { const [i, f = ''] = v.split('.'); const d = (BigInt(i + f) * BigInt(n)).toString().padStart(f.length + 1, '0'); return dec(d.slice(0, d.length - f.length), d.slice(d.length - f.length)); };
/**
 * Letters right after a number that may be a unit or a size the reader does not know, so the figure is unsure: a group of
 * one or two letters ("kg", "L", "x", "b"), a short unit ("pcs", "hrs"), two to four capitals ("GB", "KWH"), or one to
 * three letters of another script, unless it is a short word, a size, a currency or a month.
 */
const unknownShort = (t) => {
  const l = String(t || '').toLowerCase(); if (!/^[\p{L}\p{M}]+$/u.test(l) || l in SIZE || CURRENCY[l] || monthIn(l) || l === 'm') return false;
  const n = l.replace(/\p{M}/gu, '').length;
  if (!/^[a-z]+$/.test(l)) return n <= 3;
  return (n <= 2 && !SHORT.has(l)) || UNIT3.has(l) || (/^[A-Z]{2,4}$/.test(t) && !SHORT.has(l));
};

/**
 * figures(text) -> [{ kind, key, text }]: every figure in the text, written in digits of any script or as English number
 * words, with its size word or letter ("3 cr", "₹2.5 lakh", "$2m", "5k", "USD mn 5", "२ लाख") as part of its value.
 * `key` holds the value (and the currency for money): two figures are the same when kind and key are the same. A number
 * next to a group of letters the reader does not know ("5 kg", "10kg", "1 m" with no currency, "5L") is unsure. Each line
 * is read in its own style (styleOf).
 */
export function figures(text) {
  return String(text ?? '').split('\n').flatMap(line => lineFigures(line, styleOf(line)));
}

function lineFigures(text, style) {
  // a number that is not written with decimal digits (½, ², Ⅻ, ⑤) or a fraction slash: not read for certain
  const odd = [...String(text ?? '').matchAll(/[\p{No}\p{Nl}⁄]/gu)].map(m => ({ kind: 'unsure', key: m[0], text: '' }));
  const s = plainDigits(text);
  const runs = [...s.matchAll(RUN)].map(m => ({ t: m[0], l: m[0].toLowerCase(), i: m.index, end: m.index + m[0].length }));
  const out = []; const used = new Set();
  const low = (k) => (k >= 0 && runs[k] ? runs[k].l : '');
  const between = (a, b) => s.slice(runs[a].end, runs[b].i);
  const next = (k) => (k >= 0 && runs[k + 1] && /^ *$/.test(between(k, k + 1)) ? k + 1 : -1);
  const prev = (k) => (k > 0 && /^ *$/.test(between(k - 1, k)) ? k - 1 : -1);
  const push = (kind, key, from, to, lead = 0, tail = 0) => { out.push({ kind, key: String(key), text: s.slice(runs[from].i - lead, runs[to].end + tail) }); for (let x = from; x <= to; x++) used.add(x); };
  const monthAfter = (k) => { let j = next(k); if (low(j) === 'of') j = next(j); const month = monthIn(low(j)); return month ? { month, to: j } : null; };
  /** The size a word or letter gives: a power of ten, 'dozen', or 'unsure' for "m" with no currency next to it; else 0. */
  const sizeOf = (w, withCur) => (w === 'm' ? (withCur ? 6 : 'unsure') : w === 'dozen' ? 'dozen' : SIZE[w] || 0);
  const grow = (v, z) => (z === 'dozen' ? times(v, 12) : shift(v, z));

  // phone-like: a plus sign and digit groups ("+91 98765 43210")
  for (const m of s.matchAll(/\+ ?\d[\d ().-]{5,}\d/g)) {
    out.push({ kind: 'id', key: m[0].replace(/\D/g, ''), text: m[0] });
    runs.forEach((r, k) => { if (r.i >= m.index && r.end <= m.index + m[0].length) used.add(k); });
  }

  for (let k = 0; k < runs.length; k++) {
    if (used.has(k)) continue;
    const { t, l } = runs[k];
    if (!/\d/.test(t)) {
      // number words: "forty", "forty-five", "two hundred and fifty", "five lakh", "a dozen"
      if (/^\p{L}+(-\p{L}+)+$/u.test(t) && l.split('-').every(w => w in ONES)) { push('number', l.split('-').reduce((n, w) => n + ONES[w], 0), k, k); continue; }
      const startsWord = (l in ONES && (l !== 'one' || low(next(k)) in TIMES || low(next(k)) in BIG)) || ((l in TIMES || l in BIG) && ['a', 'an'].includes(low(prev(k))));
      if (!startsWord) continue;
      let total = 0n; let cur = 0n; let j = k;
      for (; j < runs.length; j++) {
        if (j > k && next(j - 1) !== j) break;
        const w = low(j);
        if (w === 'and' && j > k && low(next(j)) in ONES) continue;
        if (w in ONES) cur += BigInt(ONES[w]);
        else if (w in TIMES) cur = (cur || 1n) * BigInt(TIMES[w]);
        else if (w in BIG) { total += (cur || 1n) * 10n ** BigInt(BIG[w]); cur = 0n; }
        else break;
      }
      let v = String(total + cur); let to = j - 1;
      // a size letter after the words ("five k", "two cr"), or letters the reader does not know ("five kg")
      for (let z; (z = sizeOf(low(next(to)), false)) && z !== 'unsure';) { v = grow(v, z); to = next(to); }
      push(unknownShort(runs[next(to)]?.t) || low(next(to)) === 'm' ? 'unsure' : 'number', v, k, to); k = to; continue;
    }
    let m; let numT = t; let glued = '';
    // letters and digits together
    if (/\p{L}/u.test(t)) {
      if ((m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i))) { push('time', timeKey(m[1], m[2], m[3]), k, k); continue; }
      if ((m = t.match(/^(\d{1,2})(st|nd|rd|th)$/i))) {
        const mo = monthAfter(k); const pm = monthIn(low(prev(k)));
        if (mo) push('day', `${+m[1]}-${mo.month}`, k, mo.to); else if (pm) push('day', `${+m[1]}-${pm}`, prev(k), k); else push('ordinal', +m[1], k, k);
        continue;
      }
      if (!(m = t.match(/^(\d[\d.,']*)([\p{L}\p{M}]+)$/u))) { push('code', l, k, k); continue; }   // "Q3", "24x7", "A4": as written
      numT = m[1]; glued = m[2].toLowerCase();                                                       // "5k", "$2m", "10kg": the number and its letters
    }
    if (!glued) {
      // a date: 2026-12-05, 5/12/2026, 05.12.26
      if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { push('date', `${+m[1]}-${+m[2]}-${+m[3]}`, k, k); continue; }
      if ((m = t.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})$/))) { push('date', `${+m[1]}/${+m[3]}/${m[4].length === 2 ? 2000 + +m[4] : +m[4]}`, k, k); continue; }
      if (t.includes('/')) { push('unsure', t, k, k); continue; }
      // a time: 9:30, 21:05:10, 9 am, 9:30 p.m.
      const ap = /^(am|pm|a\.m|p\.m)$/.test(low(next(k))) ? next(k) : -1;
      if ((m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) { push('time', timeKey(m[1], m[2] + (m[3] ? ':' + m[3] : ''), ap >= 0 ? low(ap) : ''), k, ap >= 0 ? ap : k); continue; }
      if (t.includes(':')) { push('unsure', t, k, k); continue; }
      if (ap >= 0 && /^\d{1,2}$/.test(t)) { push('time', timeKey(t, '', low(ap)), k, ap); continue; }
      // hyphens: a range "1-25", or an account-like string "44-0021-7781"
      if (t.includes('-')) {
        const ps = t.split('-');
        const a = ps.length === 2 && !/^0\d/.test(ps[0]) && !/^0\d/.test(ps[1]) ? [numberValue(ps[0], style), numberValue(ps[1], style)] : [null, null];
        if (a[0] != null && a[1] != null && ps.every(p => p.replace(/\D/g, '').length <= 6)) push('range', a.join('-'), k, k);
        else if (ps.every(p => /^\d+$/.test(p))) push('id', ps.join(''), k, k);
        else push('unsure', t, k, k);
        continue;
      }
      if (/^0\d+$/.test(t) || /^\d{9,}$/.test(t)) { push('id', t, k, k); continue; }   // a leading zero kept, or nine digits or more with no marks
    }
    let v = numberValue(numT, style);
    if (v == null) { push('unsure', t, k, k); continue; }
    if (!glued) {
      // a month next to it: a day of the month ("5 December", "December 5"), or the year after it
      const mo = monthAfter(k); const pm = monthIn(low(prev(k)));
      if (/^\d{1,2}$/.test(t) && +t >= 1 && +t <= 31 && (mo || pm)) { if (mo) push('day', `${+t}-${mo.month}`, k, mo.to); else push('day', `${+t}-${pm}`, prev(k), k); continue; }
      if (/^\d{4}$/.test(t) && (pm || (k > 0 && used.has(k - 1) && out.at(-1)?.kind === 'day' && /^,? *$/.test(between(k - 1, k))))) { push('year', t, k, k); continue; }
    }
    // sign and a currency before it: "-500", "₹4,800", "Rs 4,800", "Rs cr 3" (a size word between)
    const curBefore = (i) => {   // -> { cur, lead, first } for the run i that starts the figure
      const pre = s.slice(Math.max(0, runs[i].i - 4), runs[i].i);
      const neg = /(^|[^\p{L}\p{N}])-$/u.test(pre) || /(^|[^\p{L}\p{N}])-[₹$€£¥] ?$/u.test(pre) || /[₹$€£¥] ?-$/u.test(pre);
      const sym = pre.match(/-?([₹$€£¥]) ?-?$/);
      if (sym) return { cur: CURRENCY[sym[1]], lead: sym[0].length, first: i, neg };
      if (i > 0 && !used.has(i - 1) && /^\.? *$/.test(between(i - 1, i)) && CURRENCY[low(i - 1)]) return { cur: CURRENCY[low(i - 1)], lead: 0, first: i - 1, neg };
      return { cur: '', lead: neg ? 1 : 0, first: i, neg };
    };
    let { cur, lead, first, neg } = curBefore(k);
    let to = k; let tail = 0; let before = false; let unsure = false;
    // a size word or letter before it, not part of a figure before ("USD mn 5", "Rs cr 3")
    const b = prev(k);
    if (!cur && !glued && b >= 0 && !used.has(b) && sizeOf(low(b), true) && !(prev(b) >= 0 && /\d/.test(runs[prev(b)].t))) {
      const c = curBefore(b); const z = sizeOf(low(b), !!c.cur);
      if (z === 'unsure') unsure = true; else v = grow(v, z);
      before = true; ({ cur, lead, first, neg } = c);
    }
    // the size after it, glued ("5k", "$2m") or as words ("3 cr", "2 lakh crore")
    const curAfter = (j) => j >= 0 && !!(CURRENCY[low(next(j))] || /^ ?[₹$€£¥]/.test(s.slice(runs[j].end, runs[j].end + 3)));
    if (glued) {
      if (CURRENCY[glued]) cur = cur || CURRENCY[glued];
      else { const z = sizeOf(glued, !!cur || curAfter(k)); if (!z || z === 'unsure') unsure = true; else { v = grow(v, z); if (before) unsure = true; } }
    }
    for (let z; (z = sizeOf(low(next(to)), !!cur || curAfter(next(to))));) {
      if (z === 'unsure') { unsure = true; to = next(to); break; }
      if (before) unsure = true;   // a size word on both sides: not certain which it goes with
      v = grow(v, z); to = next(to);
    }
    // a currency after it, and percent
    const post = s.slice(runs[to].end, runs[to].end + 3);
    if (!cur && /^ ?[₹$€£¥]/.test(post)) { cur = CURRENCY[post.trim()[0]]; tail = post.match(/^ ?[₹$€£¥]/)[0].length; }
    if (!cur && CURRENCY[low(next(to))]) { cur = CURRENCY[low(next(to))]; to = next(to); }
    if (unsure || unknownShort(next(to) >= 0 ? runs[next(to)].t : '')) { push('unsure', s.slice(runs[first].i, runs[to].end), first, to, lead, tail); continue; }
    const val = (neg ? '-' : '') + v;
    if (/^ ?%/.test(post)) { push('percent', val, first, to, lead, post.match(/^ ?%/)[0].length); continue; }
    if (low(next(to)) === 'percent' || low(next(to)) === 'pc') { push('percent', val, first, next(to), lead); continue; }
    if (low(next(to)) === 'per' && low(next(next(to))) === 'cent') { push('percent', val, first, next(next(to)), lead); continue; }
    push(cur ? 'money' : 'number', cur ? `${cur} ${val}` : val, first, to, lead, tail);
  }
  return [...odd, ...out];
}

/** The first figure in `text` that is not in `raw` as the same kind with the same value, or that is unsure; else null. */
export function missingFigure(text, raw) {
  const have = new Set(figures(raw).filter(f => f.kind !== 'unsure').map(f => f.kind + '|' + f.key));
  return figures(text).find(f => f.kind === 'unsure' || !have.has(f.kind + '|' + f.key)) || null;
}
export { SYM };
