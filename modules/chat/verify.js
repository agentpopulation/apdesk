// Web facts in files: every cell the Coordinator writes from the web must be said by a page read in this turn, or it is "not checked".
// Deterministic: no model call. Used by coordinator.js before table_file runs.

export const FACT_TOOLS = /^(?:web_search|web_read|knowledge_search|file_read|browser_\w+|research_\w+)$/;   // tools that gather facts (search tells the model what to read)
export const PAGE_TOOLS = /^(?:web_read|knowledge_search|file_read|browser_\w+|research_\w+)$/;               // only text from pages actually read may confirm a cell
export const NOT_CHECKED = 'not checked';

/** Does the ask need facts from outside (and not the owner's own data in the message)? */
export function needsOutsideFacts(text, { attachment = false } = {}) {
  const u = String(text || '');
  if (attachment) return false;
  if (/^\s*\|.*\|\s*$/m.test(u) || (u.match(/\d[\d,.]*/g) || []).length >= 8) return false;   // he gave the data himself
  if (/\b(?:my|our) (?:own )?(?:data|notes|list|numbers|file|figures|sales|expenses)\b/i.test(u) && !/\b(?:research|search|find|look up)\b/i.test(u)) return false;
  return /\b(?:compare|comparison|research|find|look up|price|prices|cost|spec|specs|specifications|launch|battery|weight|screen|population|revenue|founded|release|latest|current)\b/i.test(u) || /\$|₹|\bUSD\b|\bINR\b|\b(?:19|20)\d\d\b/.test(u);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A regex for a number as pages write it: 3561 / 3,561 / 3 561; 6.1 / 6,1. */
function numberPattern(n) {
  const [int, dec] = n.replace(/,/g, '').split('.');
  const groups = []; for (let i = int.length; i > 0; i -= 3) groups.unshift(int.slice(Math.max(0, i - 3), i));
  const intRe = groups.length > 1 ? groups.join('[,\\s. ]?') : esc(int);
  return new RegExp(`(?<![\\d.])${intRe}${dec ? `[.,]${esc(dec)}` : ''}(?![\\d])`, 'g');
}
const STOP = new Set(['the', 'and', 'for', 'with', 'apple', 'samsung', 'google', 'inc', 'ltd', 'pvt', 'limited', 'company']);
const tok = (w) => `(?<![a-z0-9])${esc(w)}(?![a-z0-9])`;
/** A row name as one pattern read from its first distinctive word: "iPhone 16" is iphone, then 16 within 30 characters with no
 *  other digits between, as whole tokens. So "iPhone 15 ... 16 GB" and "iPhone 16e" are not "iPhone 16". */
function namePattern(name) {
  const words = String(name || '').toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean).map(w => w.replace(/\+$/, ''));
  const keep = words.filter(w => /\d/.test(w) || (w.length >= 2 && !STOP.has(w)));
  const list = keep.length ? keep : words.slice(0, 1);
  const i = list.findIndex(w => !/^\d+$/.test(w));
  const anchor = i >= 0 ? list[i] : list[0];
  const tail = list.slice(list.indexOf(anchor) + 1);
  return anchor ? { anchor: new RegExp(tok(anchor), 'gi'), full: new RegExp(tok(anchor) + tail.map(w => `[^0-9]{0,30}?${tok(w)}`).join(''), 'iy') } : null;
}

const ALL_UNITS = new Set('mm cm m km in inch inches ft g kg gram grams kilogram kilograms oz ounce ounces lb lbs pound pounds mah wh gb tb mb kb hz khz mhz ghz mp ppi nits px pixels fps usd inr eur gbp dollars rupees $ ₹ € £ % ″ ” "'.split(' '));
const COLUMN_TYPES = [
  { key: /weigh|mass/i, words: /\b(?:weigh(?:t|s|ing)?|mass)\b/i, units: 'g gram grams kg kilogram kilograms oz ounce ounces lb lbs pound pounds' },
  { key: /batter|mah\b/i, words: /\b(?:battery|capacity)\b/i, units: 'mah wh' },
  { key: /screen|display|diagonal/i, words: /\b(?:screen|display|diagonal)\b/i, units: 'in inch inches ″ ” "' },
  { key: /price|cost|msrp|\busd\b|\binr\b|\beur\b|\bgbp\b|[$₹€£]/i, words: /\b(?:price[ds]?|costs?|msrp|retail(?:s|ed)?|starts? at|starting at|launched at)\b/i, units: 'usd inr eur gbp dollars rupees $ ₹ € £', price: true },
  { key: /storage|memory|\bram\b/i, words: /\b(?:storage|memory|ram)\b/i, units: 'gb tb mb' },
  { key: /camera|megapixel/i, words: /\b(?:camera|megapixels?)\b/i, units: 'mp' },
  { key: /refresh/i, words: /\brefresh\b/i, units: 'hz' },
];
/** What a number must sit next to before it can confirm a cell of this column: the column's own word or its unit.
 *  null when the header gives nothing to go on (then only the name rule applies). */
export function columnRule(header) {
  const h = String(header || '');
  const t = COLUMN_TYPES.find(x => x.key.test(h));
  if (t) return { words: t.words, units: new Set(t.units.split(' ')), price: !!t.price };
  const paren = (h.match(/\(([^)]+)\)/)?.[1] || '').trim().toLowerCase();
  if (paren && ALL_UNITS.has(paren)) {
    const word = h.replace(/\(.*?\)/g, ' ').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4)[0];
    return { words: word ? new RegExp(`\\b${esc(word)}`, 'i') : /$^/, units: new Set([paren, paren + 's']), price: false };
  }
  return null;
}
/** Does the number at text[pos, pos+len) carry this column's word or unit? A unit that belongs to another kind of value never fits. */
export function fitsColumn(text, pos, len, rule) {
  if (!rule) return true;
  const after = text.slice(pos + len, pos + len + 14); const before = text.slice(Math.max(0, pos - 45), pos);
  const um = after.match(/^[\s ]?[-‐-–]?[\s ]?(″|”|"|\$|₹|€|£|%|[A-Za-zµ]+)/);
  const unit = um ? um[1].toLowerCase() : null;
  const currencyBefore = /(?:[$₹€£]|\busd|\binr|\brs\.?|\beur|\bgbp)\s?$/i.test(before);
  if (rule.price) { if (currencyBefore || (unit && rule.units.has(unit))) return true; if (unit && ALL_UNITS.has(unit)) return false; return rule.words.test(before); }
  if (currencyBefore) return false;
  if (unit && rule.units.has(unit)) return true;
  if (unit && ALL_UNITS.has(unit)) return false;                       // "(170 mm)" is not a weight
  return rule.words.test(before) || rule.words.test(after + text.slice(pos + len + 14, pos + len + 30));
}

/** pages: [{ url, text }] from tools that read pages in this turn (never search snippets). */
export function pagesFrom(tool, args, out) {
  if (!out || typeof out !== 'object') return [];
  const list = [];
  const add = (url, text) => { if (text && typeof text === 'string' && text.trim()) list.push({ url: url || null, text: text.slice(0, 200000) }); };
  if (typeof out.text === 'string') add(out.url || args?.url || null, (out.title ? out.title + '\n' : '') + out.text);
  for (const k of ['pages', 'results', 'items', 'sources', 'chunks']) if (Array.isArray(out[k])) for (const x of out[k]) if (x && typeof x === 'object' && typeof (x.text || x.content || x.markdown) === 'string') add(x.url || x.path || null, (x.title ? x.title + '\n' : '') + (x.text || x.content || x.markdown));
  if (!list.length && typeof out.markdown === 'string') add(out.url || args?.url || null, out.markdown);
  return list;
}

/**
 * Check every non-name cell of a table against the pages read in this turn.
 * A number passes when it appears within `window` characters of the full row name (words and model number); a text value passes
 * when it appears in such a passage. Each confirmed cell carries the page URL and the passage. Anything else is "not checked".
 */
export function verifyTable({ columns = [], rows = [] }, pages, { window = 300 } = {}) {
  const docs = (Array.isArray(pages) ? pages : [{ url: null, text: String(pages || '') }]).filter(d => d && d.text);
  const out = []; const cells = []; let confirmed = 0; let notChecked = 0; const sources = new Map();
  for (const row of rows) {
    const r = Array.isArray(row) ? row.map(v => v == null ? '' : String(v)) : [];
    const np = namePattern(r[0]);
    // the mention of this product closest to the value must be the full name (not a sibling model)
    const nameNear = (text, pos, len) => {
      if (!np) return false;
      let best = null; np.anchor.lastIndex = 0; let m;
      const lo = Math.max(0, pos - window), hi = pos + len + window;
      while ((m = np.anchor.exec(text))) { if (m.index > hi) break; if (m.index < lo) continue; const d = m.index <= pos ? pos - m.index : (m.index - pos) * 1.5; if (!best || d < best.d) best = { at: m.index, d }; }
      if (!best) return false;
      np.full.lastIndex = best.at; return np.full.test(text);
    };
    const find = (re, rule = null) => { for (const d of docs) { re.lastIndex = 0; let m; while ((m = re.exec(d.text))) { if (fitsColumn(d.text, m.index, m[0].length, rule) && nameNear(d.text, m.index, m[0].length)) return { doc: d, at: m.index, len: m[0].length }; if (!re.global) break; } } return null; };
    for (let c = 1; c < r.length; c++) {
      const v = r[c].trim();
      if (!v || /^(?:not checked|n\/?a|unknown|-|—)$/i.test(v)) { notChecked++; r[c] = NOT_CHECKED; cells.push({ row: r[0], column: columns[c], value: NOT_CHECKED, ok: null }); continue; }   // the model left it open
      const nums = v.match(/\d[\d,]*(?:\.\d+)?/g);
      let hit = null;
      if (nums) { const rule = columnRule(columns[c]); const hits = nums.map(n => find(numberPattern(n), rule)); hit = hits.every(Boolean) ? hits[0] : null; }
      else if (v.length >= 2) hit = find(new RegExp(esc(v), 'gi'));
      if (hit) {
        confirmed++;
        const quote = passage(hit.doc.text, hit.at, hit.len);   // the passage that passed: the number with its word or unit
        if (hit.doc.url) { try { sources.set(new URL(hit.doc.url).hostname.replace(/^www\./, ''), hit.doc.url); } catch {} }
        cells.push({ row: r[0], column: columns[c], value: v, ok: true, url: hit.doc.url, quote });
      } else { notChecked++; r[c] = NOT_CHECKED; cells.push({ row: r[0], column: columns[c], value: v, ok: false }); }
    }
    out.push(r);
  }
  return { rows: out, confirmed, notChecked, cells, sources: [...sources.keys()] };
}

/** The sentence (or, on pages without sentences, the nearby words) around a match, about 200 characters at most. */
function passage(text, at, len) {
  let a = Math.max(0, at - 110), b = Math.min(text.length, at + len + 90);
  const pre = text.slice(a, at); const cut = Math.max(pre.lastIndexOf('. '), pre.lastIndexOf('\n'), pre.lastIndexOf('! '), pre.lastIndexOf('? '));
  if (cut >= 0 && at - (a + cut) > 12) a = a + cut + 1;
  const post = text.slice(at + len, b); const end = post.search(/[.!?](?:\s|$)|\n/);
  if (end >= 12) b = at + len + end + 1;
  return text.slice(a, b).replace(/\s+/g, ' ').trim();
}

/** Sentences that promise later work ("let me check the specs before finalizing") are removed from a final reply. */
export function dropPromises(text) {
  const re = /\b(?:let me|let's|i(?:'ll| will| am going to|'m going to)|i need to|we need to|i should)\s+(?:now\s+|first\s+|still\s+)?(?:check|verify|confirm|finali[sz]e|double-check|look (?:into|up)|get back|update|re-?check|validate)\b/i;
  // line by line, so the reply keeps its line breaks (tables, lists, paragraphs); sentences are split only inside a line
  let dropped = 0; let inCode = false;
  const lines = String(text || '').split('\n').map(line => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return line; }
    if (inCode) return line;   // code stays as written
    const parts = line.split(/(?<=[.!?])[ \t]+/);
    const kept = parts.filter(p => !re.test(p));
    dropped += parts.length - kept.length;
    return kept.length < parts.length ? kept.join(' ').trimEnd() : line;
  });
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

// ---- a unit the header already names
const UNIT_OF = { g: 'g', gram: 'g', grams: 'g', gm: 'g', gms: 'g', kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', oz: 'oz', ounce: 'oz', ounces: 'oz', lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  mah: 'mAh', wh: 'Wh', in: 'in', inch: 'in', inches: 'in', '″': 'in', '”': 'in', '"': 'in', mm: 'mm', cm: 'cm', gb: 'GB', tb: 'TB', mp: 'MP', hz: 'Hz', w: 'W', watts: 'W',
  usd: 'USD', $: 'USD', dollars: 'USD', us$: 'USD', inr: 'INR', '₹': 'INR', rs: 'INR', 'rs.': 'INR', rupees: 'INR', eur: 'EUR', '€': 'EUR', euros: 'EUR', gbp: 'GBP', '£': 'GBP' };
/** The unit a header names in brackets: "Weight (g)", "Screen size (inches)", "Price (USD)"; or null. */
function headerUnit(h) {
  const paren = String(h || '').match(/\(\s*(?:in\s+)?([^)]+?)\s*\)/)?.[1];
  return paren ? UNIT_OF[paren.toLowerCase()] || null : null;
}
/** A cell that is exactly one number with one unit ("$799", "170 g", "6.1-inch", "4,500mAh"): { num, unit } or null. */
function parseCell(v) {
  const m = String(v ?? '').trim().match(/^(US\$|\$|₹|€|£|Rs\.?|USD|INR|EUR|GBP)?\s?(\d[\d,]*(?:\.\d+)?)\s?-?\s?([A-Za-z$₹€£″”"]+\.?)?$/i);
  if (!m || (m[1] && m[3]) || !(m[1] || m[3])) return null;
  const unit = UNIT_OF[(m[1] || m[3]).toLowerCase()];
  return unit ? { num: m[2], unit } : null;
}
/** When a column's header names its unit in brackets, a cell that is exactly a number in that same unit holds the bare number.
 *  Nothing is ever added to a cell; every other cell (bare numbers, other units, text such as "5G", ranges) stays as written. */
export function unifyUnits(columns = [], rows = []) {
  const out = rows.map(r => Array.isArray(r) ? r.slice() : r);
  for (let c = 1; c < columns.length; c++) {
    const hu = headerUnit(columns[c]); if (!hu) continue;
    out.forEach((r, i) => { if (!Array.isArray(r)) return; const p = parseCell(r[c]); if (p && p.unit === hu) out[i][c] = p.num; });
  }
  return { columns, rows: out };
}

// ---- what was confirmed is said by code
// Only the model's own summary of the cell check goes: a prose sentence that opens with "I could not confirm", "I was unable to
// verify", "I confirmed", "I have verified", "All values … verified", or gives counts of confirmed cells. A sentence that also
// explains a substitution or asks the owner something stays.
const CHECK_TALK = /^(?:I (?:could not|couldn't|was unable to|wasn't able to|was not able to) (?:confirm|verify)\b|I(?:'ve| have)? (?:confirmed|verified)\b|All (?:of the )?(?:[\w-]+ ){0,3}?(?:values|cells)\b[^.!?]*\b(?:confirmed|verified)\b|(?:\d+|all|none) (?:of|out of) (?:the )?(?:\d+ )?(?:values|cells)\b[^.!?]*\b(?:confirmed|verified)\b)/i;
const KEEP_TALK = /\?|\b(?:so I|instead|used|chose|picked|went with|replaced|substitut\w*|switched|please|let me know|would you|do you|should I|tell me|which one)\b/i;
const NOT_PROSE = /^\s*(?:\||[-*+•]\s|\d+[.)]\s|#|>)/;
/** The model's own sentences that sum up the cell check are removed; table rows, list items, headings and questions never are. */
export function dropCheckTalk(text) {
  return String(text || '').split('\n').map(line => {
    if (NOT_PROSE.test(line)) return line;
    return line.split(/(?<=[.!?])\s+/).filter(p => { const t = p.replace(/[‘’]/g, "'").trim(); return !(CHECK_TALK.test(t) && !KEEP_TALK.test(t)); }).join(' ');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const colWord = (c) => String(c || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
/** The sentence about a checked table, from the check's result: counts, then the cells not checked grouped by column. */
export function checkSentence(v) {
  const total = v.confirmed + v.notChecked;
  const open = (v.cells || []).filter(c => c.ok !== true);
  const groups = new Map(); for (const c of open) { const k = colWord(c.column); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c.row); }
  const list = [...groups].map(([col, rows]) => `${col} (${rows.slice(0, 10).join(', ')}${rows.length > 10 ? ' and more' : ''})`).join('; ');
  return `Checked against the pages read in this turn: ${v.confirmed} of ${total} cells confirmed.${open.length ? ` Could not confirm ${open.length === 1 ? 'one cell, which says' : open.length + ' cells, which say'} "not checked": ${list}.` : ''}${(v.sources || []).length ? ' Sources: ' + v.sources.slice(0, 6).join(', ') + '.' : ''}`;
}
