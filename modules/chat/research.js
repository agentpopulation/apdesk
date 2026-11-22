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
  + '- needsFacts: true when a good answer needs facts from the web: products, models, specifications, prices, companies, people, places, events, news, anything that changes or that you may not know for sure. false for a greeting, thanks, an opinion, writing or editing text, a plan, maths, or a question about this desk.\n'
  + `- parts: the separate things the answer must cover (at most ${MAX_PARTS}), each a short web search phrase that names the thing fully, with its maker or kind, so the search finds that thing and not another of the same name (for example "NVIDIA H100 GPU", not "H100"). One part when the message is about one thing. A comparison is not a part. [] when needsFacts is false.\n`
  + '- compare: what the answer must compare or explain across the parts, in a few words; "" when nothing.';

/** The plan a model returned, cleaned: { needsFacts, parts, compare }, or null when it is not a plan. */
export function parsePlan(json, fallbackText = '') {
  if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.needsFacts !== 'boolean') return null;
  if (!json.needsFacts) return { needsFacts: false, parts: [], compare: '' };
  const seen = new Set();
  const parts = (Array.isArray(json.parts) ? json.parts : []).map(p => String(typeof p === 'object' && p ? p.part || p.name || p.query || '' : p ?? '').replace(/\s+/g, ' ').trim())
    .filter(p => p && p.length <= 120 && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).slice(0, MAX_PARTS);
  if (!parts.length && String(fallbackText).trim()) parts.push(cutAtWord(fallbackText, 80));
  if (!parts.length) return null;
  return { needsFacts: true, parts, compare: typeof json.compare === 'string' ? cutAtWord(json.compare, 160) : '' };
}

const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}.+-]+/u).map(w => w.replace(/^[.+-]+|[.+-]+$/g, '')).filter(Boolean);
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'vs', 'versus', 'in', 'on', 'for', 'to', 'how', 'what', 'is', 'are', 'its', 'with', 'about', 'from', 'details', 'specs', 'specifications']);
/** The words that name a part: its words of two or more letters, minus small words. "NVIDIA H100 specs" is h100. */
export function partKeys(part) {
  const all = words(part); const keep = all.filter(w => w.length >= 2 && !STOP.has(w));
  return keep.length ? keep : all.slice(0, 1);
}
const hasWord = (text, w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text);
/** Does this text name the part (every key word of it, as whole words)? */
export function names(text, part) { const k = partKeys(part); return k.length > 0 && k.every(w => hasWord(String(text || ''), w)); }
/** A part is supported when a page read for it, in this turn, names it. */
export function supported(part, pages = []) { return pages.some(p => names(p.text, part)); }

/** The answer with every line that talks about an unsupported part taken out (a line that says it was not checked stays),
 *  so nothing no page said is stated from memory. Table rows count as lines. */
export function dropUnsupported(text, unsupported = []) {
  if (!unsupported.length) return { text: String(text || ''), dropped: 0 };
  let dropped = 0; let inCode = false;
  const out = String(text || '').split('\n').filter(line => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return true; }
    if (inCode || !unsupported.some(p => names(line, p))) return true;
    if (/\bnot (?:checked|answered|found)\b|\bno page\b/i.test(line)) return true;
    dropped++; return false;
  });
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}
/** The plain line for parts no page supported, written by code. */
export function notAnsweredLine(unsupported = []) {
  return unsupported.map(p => `Not answered: ${p}: no page read said it.`).join('\n');
}
/** The line under a research answer written by a small local model. */
export const SMALL_WRITER_LINE = 'Written by a small local model; check the facts.';

/** The writer's instructions and the pages, part by part, fenced as data by the caller. */
export function writerBrief({ ask, plan, perPart }) {
  const n = perPart.length;
  const lines = [`The owner asked: ${ask}`, '', `Answer it in one reply that covers every part${plan.compare ? `, then ${plan.compare}` : ''}.`, `Parts (${n}): ${perPart.map(p => p.part).join('; ')}.`,
    'Use only what the pages below say. After each fact put the number of its page in square brackets, like [2]. End with a short "Sources" list of the pages you used, as [n] title - address.',
    'If the pages do not say something, write "not checked" for it; never fill it in from memory. A page about a different thing of the same name (another product, company or person) does not count: leave it out. Plain words, the answer first, no preamble.'];
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
