// A research question handled in steps inside the chat: a model plans the parts (one short JSON call), the desk searches and
// reads pages for each part, one answer covers every part with its sources, and each part is checked against the pages read.
// The plan comes from a model; nothing here reads the owner's words to decide what the ask is. With no plan, nothing changes.
import { cutAtWord } from './ui-text.js';

/** How long a research turn in the chat may run in all (kv 'researchTurnMs'). */
export const RESEARCH_TURN_MS = 150000;
/** Pages read per part, where pages exist; parts per ask. */
export const PAGES_PER_PART = 2;
export const MAX_PARTS = 4;

export const PLAN_SYSTEM = 'You plan how the desk answers the owner\'s newest message. Reply with ONE JSON object and nothing else:\n'
  + '{"needsFacts": true or false, "parts": ["..."], "compare": "..."}\n'
  + '- needsFacts: answer one question: does the owner ASK to find something out that needs facts from outside (the web): products, specifications, prices, companies, people, places, events, news, rules, anything that changes? '
  + 'A statement, a greeting, an introduction (who he is, what his business does), thanks, an opinion asked of you, an instruction about how to work, a task for you to do (write, plan, draft, edit, sum up, work out), or a question about his own business, his customers, contacts, deals or CRM (kept in this desk), or this desk is not that: false. '
  + 'Facts that could help do not make it true: only an ask to find them out does. When unsure, false.\n'
  + `- parts: the separate things the answer must find out (at most ${MAX_PARTS}), each a short web search phrase that names the thing fully, with its maker or kind, so the search finds that thing and not another of the same name (for example "NVIDIA H100 GPU", not "H100"). One part when the message is about one thing. A comparison is not a part. Use the dates in the message and today's date; never put in a year the message did not mean. [] when needsFacts is false.\n`
  + '- compare: what the answer must compare or explain across the parts, in a few words; "" when nothing.';
/** The one quiet line when no plan could be had for an ask. */
export const NO_PLAN_LINE = 'Could not plan this as research; answering directly.';
/** The one line when no part of a research turn ended up supported by a page read. */
export const NOTHING_FOUND_LINE = 'The pages read did not answer this.';

/** The plan a model returned, cleaned: { needsFacts, parts, compare }, or null when it is not a plan.
 *  cut: the object was cut off and mended; a mended plan with no parts is no plan (it is not sure). */
export function parsePlan(json, fallbackText = '', { cut = false } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.needsFacts !== 'boolean') return null;
  if (!json.needsFacts) return { needsFacts: false, parts: [], compare: '' };
  const seen = new Set();
  const parts = (Array.isArray(json.parts) ? json.parts : []).map(p => String(typeof p === 'object' && p ? p.part || p.name || p.query || '' : p ?? '').replace(/\s+/g, ' ').trim())
    .filter(p => p && p.length <= 120 && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).slice(0, MAX_PARTS);
  if (!parts.length && cut) return null;
  if (!parts.length && String(fallbackText).trim()) parts.push(cutAtWord(fallbackText, 80));
  if (!parts.length) return null;
  return { needsFacts: true, parts, compare: typeof json.compare === 'string' ? cutAtWord(json.compare, 160) : '' };
}
/** A plan object read from a model's text, whole or cut off: { json, cut }. A cut-off object is mended by closing its open
 *  string, array and object; a part cut in the middle is left out. { json: null } when there is no object at all. */
export function readPlanText(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'); if (a < 0) return { json: null, cut: false };
  const body = s.slice(a);
  const whole = body.slice(0, body.lastIndexOf('}') + 1);
  if (whole) { try { return { json: JSON.parse(whole), cut: false }; } catch {} }
  // walk the text, remembering where the last complete value ended, and close what is open
  let inStr = false; let esc = false; const stack = []; let lastSafe = -1; let safeStack = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') { inStr = false; lastSafe = i; safeStack = stack.slice(); } continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') { stack.pop(); lastSafe = i; safeStack = stack.slice(); }
    else if (/[\w.]/.test(c) && !/[\w.]/.test(body[i + 1] || '')) { lastSafe = i; safeStack = stack.slice(); }
    if (!stack.length && i > 0) break;
  }
  if (lastSafe < 0) return { json: null, cut: true };
  let t = body.slice(0, lastSafe + 1).replace(/,\s*$/, '');
  // a key with no value yet ("compare": ) is dropped
  t = t.replace(/,?\s*"[^"]*"\s*:\s*$/, '');
  for (const o of [...safeStack].reverse()) t += o === '{' ? '}' : ']';
  try { return { json: JSON.parse(t), cut: true }; } catch { return { json: null, cut: true }; }
}

const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}.+-]+/u).map(w => w.replace(/^[.+-]+|[.+-]+$/g, '')).filter(Boolean);
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'vs', 'versus', 'in', 'on', 'for', 'to', 'how', 'what', 'is', 'are', 'its', 'with', 'about', 'from', 'details', 'specs', 'specifications', 'spec', 'architecture', 'overview', 'features', 'review', 'comparison', 'latest', 'information', 'info']);
/** The words that name a part: its words of two or more letters, minus small words. "NVIDIA H100 specs" is h100. */
export function partKeys(part) {
  const all = words(part); const keep = all.filter(w => w.length >= 2 && !STOP.has(w));
  return keep.length ? keep : all.slice(0, 1);
}
const hasWord = (text, w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text);
/** Does this text name the part? A part with a model name in it ("NVIDIA H100 GPU": h100) is named by that name; any other
 *  by most of its key words ("bakery delivery rules in Pune": two of bakery, delivery, rules, pune). Whole words only. */
export function names(text, part) {
  const k = partKeys(part); if (!k.length) return false;
  const t = String(text || ''); const ids = k.filter(w => /\p{N}/u.test(w) && /\p{L}/u.test(w));
  if (ids.length) return ids.every(w => hasWord(t, w));
  const need = k.length <= 2 ? k.length : Math.ceil(k.length / 2);
  return k.filter(w => hasWord(t, w)).length >= need;
}
/** A part is supported when a page read for it, in this turn, names it. */
export function supported(part, pages = []) { return pages.some(p => names(p.text, part)); }

/** The answer with every line that talks about an unsupported part taken out (a line that says it was not checked stays),
 *  so nothing no page said is stated from memory. Table rows count as lines. */
export function dropUnsupported(text, unsupported = []) {
  if (!unsupported.length) return { text: String(text || ''), dropped: 0 };
  let dropped = 0; let inCode = false;
  const lines = String(text || '').split('\n');
  const out = lines.filter((line, i) => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return true; }
    if (inCode || !unsupported.some(p => names(line, p))) return true;
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) return true;   // a table's header row names the columns; the table needs it
    if (/\bnot (?:checked|answered|found)\b|\bno page\b/i.test(line)) return true;
    dropped++; return false;
  });
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}
const NOT_SAID = /\b(?:not (?:checked|specified|stated|given|found|answered|available|listed|confirmed|detailed|mentioned|covered)|no page\b[^.;]*|unknown|n\/a)\b/gi;
const contentWords = (s) => String(s || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(NOT_SAID, ' ').split(/[^\p{L}\p{N}.]+/u).map(w => w.replace(/^\.+|\.+$/g, '')).filter(w => w.length >= 4 && !STOP.has(w));
/** Does this piece of the answer say something a page read supports? A citation of a page read ([2], or its address), a
 *  figure that is on a page, or most of its words on one page. A piece that only says "not checked" says nothing. */
function backed(text, pages, partKeysSet) {
  // a sentence that says something was not checked says nothing about it
  const piece = String(text || '').replace(/\s*\(not checked\)/gi, '').split(/(?<=[.;!?])\s+|;\s*/).filter(x => !new RegExp(NOT_SAID.source, 'i').test(x)).join(' ');
  const words = contentWords(piece).filter(w => !partKeysSet.has(w));
  if (words.length < 2) return false;
  for (const m of String(piece).matchAll(/\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\]/g)) for (const n of m[1].split(/[,–-]/).map(x => Number(x.trim()))) if (pages.some(p => p.n === n)) return true;
  if (pages.some(p => p.url && String(piece).includes(p.url))) return true;
  const nums = String(piece).replace(/\[[\d,\s–-]+\]/g, ' ').match(/\d+(?:[.,]\d+)?/g) || [];
  if (nums.some(n => n.length >= 2 && pages.some(p => String(p.text || '').includes(n)))) return true;
  return pages.some(p => { const t = String(p.text || '').toLowerCase(); return words.filter(w => t.includes(w)).length >= Math.max(2, Math.ceil(words.length * 0.6)); });
}
/** Which parts the answer really answered: a part counts only when a line about it (its own line, the lines under it, or its
 *  column of a table) says something a page read supports. A part whose lines say only "not checked" is not answered. */
export function answeredParts(answer, parts = [], pages = []) {
  const got = new Set(); const keys = new Map(parts.map(p => [p, new Set(partKeys(p))]));
  let cur = []; let cols = null; let inCode = false;
  const lines = String(answer || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (/^\W*(?:sources|references)\W*$/i.test(line)) break;
    const named = parts.filter(p => names(line, p));
    const row = line.match(/^\s*\|(.*)\|\s*$/);
    if (row) {
      const cells = row[1].split('|').map(c => c.trim());
      if (/^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) { cols = cells.map(c => parts.filter(p => names(c, p))); continue; }   // a header row
      if (/^[\s|:-]+$/.test(line)) continue;
      const rowParts = parts.filter(p => names(cells[0] || '', p));
      cells.forEach((c, j) => { for (const p of [...rowParts, ...(cols?.[j] || [])]) if (j > 0 && backed(c, pages, keys.get(p))) got.add(p); });
      continue;
    }
    cols = null;
    const heading = /^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*\s*(?:\[[\d,\s]+\])?\s*:?\s*$/.test(line);
    if (named.length) cur = named; else if (heading || !line.trim()) { if (heading) cur = []; }
    for (const p of named.length ? named : cur) if (backed(line, pages, keys.get(p))) got.add(p);
  }
  return parts.filter(p => got.has(p));
}
/** The plain line for parts no page supported, written by code. */
export function notAnsweredLine(unsupported = []) {
  return unsupported.map(p => `Not answered: ${p}: no page read said it.`).join('\n');
}
/** The line under a research answer written by a small local model. */
export const SMALL_WRITER_LINE = 'Written by a small local model; check the facts.';

/** The writer's instructions and the pages, part by part, fenced as data by the caller. */
export function writerBrief({ ask, plan, perPart, place = '' }) {
  const n = perPart.length;
  const lines = [`The owner asked: ${ask}`, '', `Answer it in one reply that covers every part${plan.compare ? `, then ${plan.compare}` : ''}.`, `Parts (${n}): ${perPart.map(p => p.part).join('; ')}.`,
    'Use only what the pages below say. After each fact put the number of its page in square brackets, like [2]. End with a short "Sources" list of the pages you used, as [n] title - address.',
    'If the pages do not say something, write "not checked" for it; never fill it in from memory. A page about a different thing of the same name (another product, company or person) does not count: leave it out. Plain words, the answer first, no preamble.',
    'For every figure, use the page\'s own words for what it measures (per GPU, per superchip, per rack, per month, with or without tax); never change that, and never write a figure the page does not give (no "?" or guesses inside a figure).'];
  if (place) lines.push(place);
  const none = perPart.filter(p => !p.ok).map(p => p.part);
  if (none.length) lines.push(`No page read said anything about: ${none.join('; ')}. For these write only that they were not checked; do not describe them.`);
  return lines.join('\n');
}
/** The pages as numbered blocks, part by part, within a size budget. */
export function pagesBlock(perPart, budget = 42000) {
  const per = Math.max(1500, Math.floor(budget / Math.max(1, perPart.reduce((n, p) => n + p.pages.length, 0))));
  const out = []; let i = 0;
  for (const p of perPart) {
    out.push(`PART: ${p.part}`);
    if (!p.pages.length) out.push('(no page was read for this part)');
    for (const pg of p.pages) out.push(`[${pg.n = ++i}] ${pg.title || ''} - ${pg.url || ''}\n${String(pg.text || '').slice(0, per)}`);
  }
  return out.join('\n\n');
}
