// The prompts and the counting for the three stages. The flow (answer alone, rank anonymised answers with a final
// ranking line, average the positions, a chairman synthesises) follows karpathy/llm-council backend/council.py;
// the wording is ours (that repository states no licence, so no text was copied).

export function answerMessages(question, seat, format, brief = '') {
  if (format?.plan) return [
    { role: 'system', content: `You are ${seat.name}, one of four advisors to a business owner (${format.label}). Your view: ${seat.stance}. ${seat.brief}\nRead the brief and propose a 30-day plan of three or four steps, one per line, each starting "Step 1:", "Step 2:" and so on, each short enough to become one task. Say first, in one sentence, what you see. Use only figures the brief gives. Plain text, no Markdown. These are proposals: nothing is done or sent.\nEnd with one more line on its own that starts with "Recommendation:" and names your first move in two to six words, key word first.` },
    { role: 'user', content: `${question}\n\n${brief}` },
  ];
  return [
    { role: 'system', content: `You are ${seat.name}, one of three seats on a council that advises a business owner (format: ${format?.label || 'Council'}). Your stance: ${seat.stance}. ${seat.brief}\nAnswer on your own, in at most 120 words of plain English, no headings, no Markdown. Your first sentence states your position. You cannot look anything up here, so use only figures the question or the brief gives.\nEnd with one more line on its own that starts with "Recommendation:" and names the course you recommend in two to six words, key word first: yes, no or wait for a yes-or-no question, otherwise the option you pick, named the way the question names it.` },
    { role: 'user', content: brief ? `${question}\n\n${brief}` : question },
  ];
}

export function rankMessages(question, items) {
  const list = items.map(x => `Answer ${x.letter}:\n${x.text}`).join('\n\n');
  return [
    { role: 'system', content: 'You review answers from a council. The authors are hidden. Judge each answer on how correct, useful and well argued it is for the owner, not on its stance.' },
    { role: 'user', content: `Question: ${question}\n\n${list}\n\nFor each answer give one short line on what it gets right or wrong. Then rank all the answers from best to worst.\nReturn JSON only: {"notes":{"A":"...","B":"..."},"ranking":["B","A","C"]}` },
  ];
}

export function chairMessages(question, answers, seats, agg, { plan = false, brief = '' } = {}) {
  const body = answers.map((a, i) => a.text ? `${a.name} (${seats[i].stance}):\n${a.text}` : null).filter(Boolean).join('\n\n');
  const ranks = agg.averages.map(x => `${x.name}: average place ${x.avg} from ${x.n} reviews`).join('\n');
  const agree = agg.agreeLine ? `\nWhat the seats recommend: ${agg.agreeLine}.\n${agg.major ? `Most seats recommend: ${agg.major.course}. Your decision is that course, and your reasons${plan ? ' and plan' : ''} support it.` : 'No course has a majority. Do not say the seats agree; in the decision, say what the choice between their first moves turns on.'}\n` : '';
  return [
    { role: 'system', content: 'You are the chairman of a council advising a business owner. Write the final Verdict from the seats\' answers and how they ranked each other. Be decisive and plain.' },
    { role: 'user', content: `Question: ${question}\n${brief ? '\n' + brief + '\n' : ''}\nThe seats' answers:\n${body}\n\nPeer ranking (lower is better):\n${ranks || 'no rankings'}\nThe best-ranked answer was ${agg.winner != null ? answers[agg.winner].name + "'s" : 'not clear'}.\n${agree}\n${plan ? 'Return JSON only: {"decision":"the one thing to do first, in one or two sentences","reasons":["the main reason","a second reason"],"agree":["where the advisors agree, one short line each"],"differ":["where they differ, one short line each, naming who"],"steps":[{"step":"one step of the 30-day plan, short enough to be one task","by":"the advisor it came from"}],"answer":"a fuller plan in at most 150 words"}. At most six steps. Use only figures the brief gives. Plain text, no Markdown.' : 'Return JSON only: {"decision":"the decision or answer in one or two sentences","reasons":["the main reason","a second reason"],"answer":"a fuller final answer in at most 150 words"}. Plain text, no Markdown.'}` },
  ];
}

export function parseJson(r) {
  if (r?.json && typeof r.json === 'object') return r.json;
  const t = String(r?.text || '').replace(/<think>[\s\S]*?<\/think>/gi, ''); const m = t.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** The ranking from JSON, else from a "ranking" line or the order letters appear in. */
export function parseRanking(r, letters) {
  const j = parseJson(r); const valid = new Set(letters);
  let order = [];
  if (j && Array.isArray(j.ranking)) order = j.ranking.map(x => String(x).trim().replace(/^answer\s+/i, '').toUpperCase().slice(0, 1));
  if (!order.length) { const t = String(r?.text || ''); const tail = t.split(/final ranking|ranking/i).pop(); order = (tail.match(/\b(?:Answer\s+)?([A-Z])\b/g) || []).map(x => x.slice(-1)); }
  order = [...new Set(order.filter(x => valid.has(x)))];
  const notes = j?.notes && typeof j.notes === 'object' ? Object.fromEntries(Object.entries(j.notes).map(([k, v]) => [String(k).slice(-1).toUpperCase(), String(v).slice(0, 240)])) : {};
  return { order, notes };
}

/** Average place per answer, and each seat's first pick. The winner is the best-argued answer by the seats' own ranking;
 *  it says nothing about whether the seats recommend the same course (that is agreement(), from their recommendations). */
export function aggregate(rankings, byLetter, answers) {
  const places = new Map();
  for (const r of rankings) r.order.forEach((letter, k) => { const i = byLetter[letter]; if (i == null) return; if (!places.has(i)) places.set(i, []); places.get(i).push(k + 1); });
  const averages = [...places.entries()].map(([i, p]) => ({ seat: i, name: answers[i].name, avg: Math.round(p.reduce((a, b) => a + b, 0) / p.length * 100) / 100, n: p.length })).sort((a, b) => a.avg - b.avg);
  const firsts = rankings.filter(r => r.order.length).map(r => ({ voter: r.name, pick: byLetter[r.order[0]] }));
  const tally = new Map(); for (const f of firsts) tally.set(f.pick, (tally.get(f.pick) || 0) + 1);
  // the winner: most first picks, then the best average place
  let winner = null;
  if (firsts.length) winner = [...tally.entries()].sort((a, b) => (b[1] - a[1]) || ((averages.find(x => x.seat === a[0])?.avg ?? 9) - (averages.find(x => x.seat === b[0])?.avg ?? 9)))[0][0];
  else if (averages.length) winner = averages[0].seat;
  const forW = tally.get(winner) || 0; const against = firsts.length - forW;
  const rankLine = winner != null ? rankLineFor(answers[winner].name) : '';
  return { averages, winner, vote: { for: forW, against, voters: firsts.map(f => ({ voter: f.voter, pick: answers[f.pick]?.name })) }, rankLine };
}
export const rankLineFor = (name) => `Best-argued answer by the seats' own ranking: ${name}`;

// ---- agreement: each seat ends its own answer with a "Recommendation:" line; code reads those lines and counts
/** Asked of a seat whose answer had no readable recommendation line: that line only, from the same model. */
export const REC_ASK = 'Give your recommendation as one line only, in this form: Recommendation: then the course you recommend in two to six words, key word first.';
export function recommendMessages(messages, answer) {
  return [...messages, { role: 'assistant', content: answer }, { role: 'user', content: REC_ASK }];
}
const REC_LINE = /(?:^|[\s*_>#(])(?:my\s+|final\s+)?recommendation\b[\s*_]*(?:[:\-\u2013\u2014]|\s+is\b(?:\s+to\b)?)\s*(.+)$/i;
const NO_REC = /^(none|n\/?a|unclear|unsure|not sure|no clear recommendation|no recommendation)$/i;
/** The seat's recommendation phrase from its answer (the last "Recommendation:" line), or null. With `bare`, a reply
 *  that is a single short line counts as the phrase even without the label. Markdown, quotes and end punctuation go. */
export function parseRecommendation(text, { bare = false } = {}) {
  const lines = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let phrase = null;
  for (let k = lines.length - 1; k >= 0 && phrase == null; k--) { const m = lines[k].match(REC_LINE); if (m) phrase = m[1]; }
  if (phrase == null && bare && lines.length === 1 && lines[0].split(/\s+/).length <= 8 && !/[.!?:]\s/.test(lines[0])) phrase = lines[0];
  if (phrase == null) return null;
  let t = phrase.replace(/[*_`"“”\[\]]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:i|we)\s+recommend\s+(?:that\s+)?(?:you\s+|we\s+)?/i, '').replace(/^(?:you|we)\s+should\s+/i, '').replace(/^to\s+/i, '')
    .split(/(?<=[.!?;])\s/)[0].replace(/[.!?;:,]+$/, '').trim();
  if (!t || /[<>|]/.test(t) || NO_REC.test(t)) return null;
  if (/\b(is|are|was|and|or|but|the|a|an|to|of|for|with|that|than|because)$/i.test(t)) return null;   // a line cut off mid-phrase
  return t.split(' ').slice(0, 8).join(' ');
}
/** The course a phrase names, for counting: yes, no, wait, "no <thing>" or the key word the phrase starts with. */
export function recKey(phrase) { return keyParts(phrase).key; }
const words = (phrase) => String(phrase || '').toLowerCase().replace(/[\u2019]/g, "'").replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean).filter(x => !['the', 'a', 'an', 'just'].includes(x));
/** The key and how many leading words it took. */
function keyParts(phrase) {
  const w = words(phrase); const [a, b, c] = w;
  const k = (key, used) => ({ key, rest: w.slice(used) });
  if (['yes', 'proceed'].includes(a)) return k('yes', 1);
  if ((a === 'go' && b === 'ahead') || (a === 'do' && b === 'it')) return k('yes', 2);
  if (['wait', 'delay', 'postpone', 'defer'].includes(a)) return k('wait', 1);
  if ((a === 'hold' && b === 'off') || (a === 'not' && b === 'yet')) return k('wait', 2);
  if (a === 'no') return k('no', 1);
  if (['not', "don't", 'dont', 'never', 'avoid', 'skip', 'drop'].includes(a)) return b ? k('no ' + stem(b), 2) : k('no', 1);
  if (a === 'do' && b === 'not') return c ? k('no ' + stem(c), 3) : k('no', 2);
  return k(stem(a || ''), 1);
}
const FILLER = new Set(['to', 'for', 'of', 'with', 'and', 'in', 'on', 'at', 'by', 'your', 'our', 'my', 'it', 'this', 'that', 'first', 'now', 'then', 'more', 'new', 'some', 'all']);
/** The content words after the key, stemmed, without figures: what makes "launch a starter pack" a different course from "launch a brunch box". */
const restOf = (phrase) => new Set(keyParts(phrase).rest.filter(x => !FILLER.has(x) && !/\d/.test(x)).map(stem));
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w).replace(/e$/, '');   // buying, buys, buy: one key
const figures = (p) => (String(p).replace(/(\d),(?=\d)/g, '$1').match(/\d+(?:\.\d+)?/g) || []).join(' ');
/** Two phrases recommend the same course when they start with the same key word and give no different figures. */
export function sameCourse(p, q) {
  if (recKey(p) !== recKey(q)) return false;
  const [x, y] = [figures(p), figures(q)];
  if (x && y && x !== y) return false;
  const [a, b] = [restOf(p), restOf(q)].sort((m, n) => m.size - n.size);   // the shorter phrase's words all in the longer one
  return [...a].every(w => b.has(w));
}
const groupsOf = (given) => { const groups = []; for (const r of given) { const g = groups.find(x => sameCourse(x[0].recommendation, r.recommendation)); g ? g.push(r) : groups.push([r]); } return groups.sort((a, b) => b.length - a.length); };
/** The course more than half of the seats that answered recommend ({ course, names }), or null. */
export function majority(recs) {
  const top = groupsOf(recs.filter(r => r.recommendation))[0];
  return top && top.length * 2 > recs.length ? { course: top[0].recommendation, names: top.map(r => r.name) } : null;
}
/** True when a Verdict's text follows the course: the same key, or most of the course's words with no turn to no or wait. */
export function belongsTo(text, course) {
  const k = recKey(course), d = recKey(text); if (k === d) return true;
  const neg = (x) => x === 'no' || x.startsWith('no ');
  if (d === 'wait' || k === 'wait' || neg(d) !== neg(k)) return false;
  const have = new Set(words(text).map(stem)); const need = [...(k === 'yes' ? [] : [k]), ...restOf(course)];
  return need.length > 0 && need.filter(w => have.has(w)).length * 2 >= need.length;
}
const COUNT = ['no', 'one', 'two', 'three', 'four', 'five'];
/** The agreement line from the seats that answered ([{ name, recommendation }]), counted by code; '' when no seat gave a
 *  clear recommendation. A seat with none is said plainly, never dropped from the count. */
export function agreement(recs) {
  const n = recs.length; const given = recs.filter(r => r.recommendation);
  if (n < 2 || !given.length) return '';
  const groups = groupsOf(given);
  const missing = n - given.length;
  const none = missing ? `; ${missing === 1 ? 'one seat' : (COUNT[missing] || missing) + ' seats'} gave no clear recommendation` : '';
  const top = groups[0]; const course = top[0].recommendation;
  if (top.length * 2 <= n) return 'The seats differ: ' + given.map(r => `${r.name}: ${r.recommendation}`).join('; ') + none;   // no majority: each seat's own line
  if (groups.length === 1) {
    if (missing) return `${top.length} of ${n} seats recommend${top.length === 1 ? 's' : ''} ${course}${none}`;
    return n === 2 ? `Both seats that answered agree: ${course}` : `All ${COUNT[n] || n} seats agree: ${course}`;
  }
  return `${top.length} of ${n} seats agree: ${course}; ` + groups.slice(1).flat().map(r => `${r.name} differs: ${r.recommendation}`).join('; ') + none;
}

// ---- what reaches the screen: plain text, and every figure no record gave marked on that figure
/** Markdown marks drawn as plain text: bold, italics, headings, quotes, code and "* " bullets. "5 * 3" stays. */
export function plainText(text) {
  return String(text ?? '')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/^[ \t]*>[ \t]?/gm, '').replace(/^([ \t]*)[*+][ \t]+/gm, '$1- ')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1').replace(/__([^_\n]+?)__/g, '$1').replace(/\*\*/g, '')
    .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=[\s).,;:!?]|$)/gm, '$1$2')
    .replace(/`([^`\n]*)`/g, '$1').replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');
}
const PRE = String.raw`(?:US\$|A\$|C\$|S\$|Rs\.?\s?|INR\s?|USD\s?|EUR\s?|GBP\s?|[₹$€£¥])`;
const NUM = String.raw`\d+(?:,\d{2,3})*(?:\.\d+)?`;
const FIGURE = new RegExp(String.raw`(?<![\p{L}\p{N}_:/.,$₹€£¥\-‐‑‒])(${PRE})?(${NUM})(?:\s?(?:[\-‐‑‒–—]|to)\s?(?:${PRE})?(${NUM}))?(?:\+(?!\p{N}))?(\s?(?:%|per ?cent\b|k\b|K\b|lakhs?\b|lacs?\b|crores?\b|cr\b|million\b|mn\b|billion\b|bn\b))?(?:\+(?!\p{N}))?(\s(?:rupees?|INR|USD|dollars?|euros?|pounds?)\b)?((?:[-‐‑]\p{L}+)+)?(?![\p{N}\p{L}]|[:/.,]\d)`, 'gu');
const CODE = [[/^(?:₹|rs\.?|inr|rupees?)$/i, 'INR'], [/^(?:\$|usd|dollars?|us\$)$/i, 'USD'], [/^a\$$/i, 'AUD'], [/^c\$$/i, 'CAD'], [/^s\$$/i, 'SGD'], [/^(?:€|eur|euros?)$/i, 'EUR'], [/^(?:£|gbp|pounds?)$/i, 'GBP'], [/^¥$/, 'JPY']];
const codeOf = (t) => { const x = String(t || '').trim(); return x ? (CODE.find(([re]) => re.test(x))?.[1] || null) : null; };
const TIME = /^(?:[-‐‑]|\s)?(?:days?|weeks?|months?|years?|yrs?|hours?|hrs?|minutes?|mins?|am|pm|a\.m\.|p\.m\.)(?![\p{L}])/iu;
const LABEL = /\b(?:step|day|week|month|phase|stage|option|round|part|point|record|source|page|item|table|no\.)\s*$/i;
/** Numbers the question and the brief give: the only records a seat has. */
export const givenFigures = (text) => new Set((String(text || '').match(/\d+(?:,\d{2,3})*(?:\.\d+)?/g) || []).map(x => x.replace(/,/g, '')));
/** Each figure that no record gave, and each amount in another currency than the owner's, gets " (not checked)" right after
 *  the whole figure (its sign, scale and unit included). Labels, counts of seats, durations, times and years are not figures. */
export function markFigures(text, { given = new Set(), currency = '' } = {}) {
  // the mark is put by this rule only: one a model wrote itself (after a word as often as after a figure) goes first;
  // digits a model wrote small ("₹350–₄₅₀") are read as the digits they are
  const t = String(text ?? '').replace(/[ \t]*\((?:source )?not checked\)/gi, '').replace(/[\u2080-\u2089]/g, (d) => String(d.charCodeAt(0) - 0x2080));
  return t.replace(FIGURE, (m, pre, a, b, scale, post, comp, at, all) => {
    const after = all.slice(at + m.length), before = all.slice(0, at);
    if (/^\s*\(?not checked/i.test(after)) return m;
    const cur = codeOf(pre) || codeOf(post);
    const foreign = !!(cur && currency && cur !== String(currency).toUpperCase());
    if (!foreign) {
      if (!cur && !scale && (TIME.test(comp || '') || TIME.test(after))) return m;
      if (!cur && (LABEL.test(before) || (/(?:^|\n)[ \t]*$/.test(before) && /^[.)]/.test(after)))) return m;   // "Step 2", a numbered line
      if (!cur && (/^\s+of\s+\d/.test(after) || /\d\s+of\s+$/.test(before))) return m;
      if (!cur && !scale && !b && /^(?:19|20)\d\d$/.test(a)) return m;
      if ([a, b].filter(Boolean).every(x => given.has(x.replace(/,/g, '')))) return m;
    }
    return m + ' (not checked)';
  });
}

/** A source the seat says it used. The seats read no page and hold no talks with the owner: only the question and the brief
 *  are records. "according to ..." runs to the end of its clause; "studies show" and "as we discussed" are the claim itself. */
const SOURCE = new RegExp(String.raw`\b(?:according to|as per|based on)\s+(?:our|your|the|my|recent|past|previous|earlier|industry|market)\b[^,.;:!?\n]{0,60}|\b(?:as (?:we|I) (?:discussed|mentioned|agreed|noted|said)|as (?:discussed|mentioned|agreed|noted) (?:earlier|before|previously))\b|\b(?:(?:our|your) (?:previous|earlier|past) (?:discussions?|conversations?|talks?|meetings?))\b|\b(?:studies|research|surveys?|data|reports?|statistics|industry data|market research)\s+(?:shows?|suggests?|found|finds|indicates?|says?)\b`, 'gi');
const RECORD = /\b(?:brief|question|desk'?s records)\b/i;
/** Each such source gets " (source not checked)" right after it, unless it names the brief or the question. */
export function markSources(text) {
  return String(text ?? '').replace(SOURCE, (m, at, all) => {
    const w = m.replace(/\s+$/, ''); const after = all.slice(at + w.length);
    if (RECORD.test(w) || /^\s*\(?(?:source )?not checked/i.test(after)) return m;
    return w + ' (source not checked)' + m.slice(w.length);
  });
}

// ---- answers cut off by a token limit: no half sentence reaches the seat card or the Verdict
const CLOSERS = /[*_`"'”’)\]\s]+$/;
/** True when the text closes its last sentence (full stop, question or exclamation mark, ellipsis), ignoring quotes and Markdown marks after it. */
export function endsWhole(text) { const t = String(text || '').replace(CLOSERS, ''); return !t || /[.!?…]$/.test(t); }
/** The text up to the end of its last full sentence. A full stop inside a number ("540.5") is not an end. */
export function toLastSentence(text) {
  const t = String(text || '').trim(); if (endsWhole(t)) return t;
  let end = -1; const re = /[.!?…]["'”’)\]*]*(?=\s)/g; let m;
  while ((m = re.exec(t))) end = m.index + m[0].length;
  return end > 0 ? t.slice(0, end).trim() : '';
}
/** Whole sentences up to about `max` characters, for summaries; a single long sentence is shortened with an ellipsis. */
export function wholeSentences(text, max = 240) {
  const t = String(text || '').replace(/\s+/g, ' ').trim(); if (t.length <= max) return t;
  const cut = toLastSentence(t.slice(0, max) + '\u0001');       // the marker makes the slice count as unfinished
  return cut && cut.length >= 40 ? cut : t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}
export function continueMessages(messages, soFar) {
  return [...messages, { role: 'assistant', content: soFar }, { role: 'user', content: 'You were cut off in the middle of a sentence. Continue from exactly where you stopped and finish in at most two sentences. Do not repeat anything you already wrote.' }];
}
/** Join an answer and its continuation without doubling a space or splitting a word wrongly. */
export function joinContinuation(a, b) {
  const x = String(a || '').replace(/\s+$/, ''), y = String(b || '').trim(); if (!y) return x;
  return x + (/^[,.;:!?)%]/.test(y) ? '' : ' ') + y;
}
