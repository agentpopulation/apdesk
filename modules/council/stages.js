// The prompts and the counting for the three stages. The flow (answer alone, rank anonymised answers with a final
// ranking line, average the positions, a chairman synthesises) follows karpathy/llm-council backend/council.py;
// the wording is ours (that repository states no licence, so no text was copied).

export function answerMessages(question, seat, format) {
  return [
    { role: 'system', content: `You are ${seat.name}, one of three seats on a council that advises a business owner (format: ${format?.label || 'Council'}). Your stance: ${seat.stance}. ${seat.brief}\nAnswer on your own, in at most 120 words of plain English, no headings. Your first sentence states your position. You cannot look anything up here: give a figure only as your own estimate, and say it is an estimate.` },
    { role: 'user', content: question },
  ];
}

export function rankMessages(question, items) {
  const list = items.map(x => `Answer ${x.letter}:\n${x.text}`).join('\n\n');
  return [
    { role: 'system', content: 'You review answers from a council. The authors are hidden. Judge each answer on how correct, useful and well argued it is for the owner, not on its stance.' },
    { role: 'user', content: `Question: ${question}\n\n${list}\n\nFor each answer give one short line on what it gets right or wrong. Then rank all the answers from best to worst.\nReturn JSON only: {"notes":{"A":"...","B":"..."},"ranking":["B","A","C"]}` },
  ];
}

export function chairMessages(question, answers, seats, agg) {
  const body = answers.map((a, i) => a.text ? `${a.name} (${seats[i].stance}):\n${a.text}` : null).filter(Boolean).join('\n\n');
  const ranks = agg.averages.map(x => `${x.name}: average place ${x.avg} from ${x.n} reviews`).join('\n');
  const agree = agg.agreeLine ? `\nWhat the seats recommend: ${agg.agreeLine}.\n` : '';
  return [
    { role: 'system', content: 'You are the chairman of a council advising a business owner. Write the final Verdict from the seats\' answers and how they ranked each other. Be decisive and plain.' },
    { role: 'user', content: `Question: ${question}\n\nThe seats' answers:\n${body}\n\nPeer ranking (lower is better):\n${ranks || 'no rankings'}\nThe best-ranked answer was ${agg.winner != null ? answers[agg.winner].name + "'s" : 'not clear'}.\n${agree}\nReturn JSON only: {"decision":"the decision or answer in one or two sentences","reasons":["the main reason","a second reason"],"answer":"a fuller final answer in at most 150 words"}` },
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

// ---- agreement: from what the seats recommend, labelled by one model call, counted by code
const PAIR = (a, b) => `${a}-${b}`;
export function agreeMessages(question, seats) {
  const letters = seats.map((_, k) => String.fromCharCode(65 + k));
  const pairs = letters.flatMap((a, i) => letters.slice(i + 1).map(b => PAIR(a, b)));
  return [
    { role: 'system', content: 'You label what each answer recommends. You do not judge which is better.' },
    { role: 'user', content: `Question: ${question}\n\n${seats.map((x, k) => `Answer ${letters[k]}:\n${x.text}`).join('\n\n')}\n\nFor each answer, name the course it recommends in at most six words. Then for each pair say whether the two recommend the same course (true) or not (false). If any answer gives no clear recommendation, or you are not sure, set "sure" to false.\nReturn JSON only: {"courses":{${letters.map(l => `"${l}":"..."`).join(',')}},"same":{${pairs.map(p => `"${p}":true`).join(',')}},"sure":true}` },
  ];
}
/** The agreement line from the labelling reply, or '' when the reply is missing, unsure or not consistent. */
export function agreement(reply, names) {
  const j = reply && typeof reply === 'object' ? reply : null;
  if (!j || j.sure !== true || !j.courses || !j.same || names.length < 2) return '';
  const letters = names.map((_, k) => String.fromCharCode(65 + k));
  const course = letters.map(l => String(j.courses[l] ?? '').replace(/\s+/g, ' ').trim().replace(/[.]$/, '').slice(0, 80));
  if (course.some(c => !c)) return '';
  const same = {};
  for (let a = 0; a < letters.length; a++) for (let b = a + 1; b < letters.length; b++) {
    const v = j.same[PAIR(letters[a], letters[b])] ?? j.same[PAIR(letters[b], letters[a])];
    if (typeof v !== 'boolean') return '';
    same[a + '-' + b] = v;
  }
  const s = (a, b) => same[Math.min(a, b) + '-' + Math.max(a, b)];
  if (names.length === 2) return s(0, 1) ? `Both seats that answered agree: ${course[0]}` : `The two seats that answered disagree: ${names[0]}: ${course[0]}; ${names[1]}: ${course[1]}`;
  if (names.length !== 3) return '';
  const trues = Object.values(same).filter(Boolean).length;
  if (trues === 3) return `All three seats agree: ${course[0]}`;
  if (trues === 0) return 'The seats disagree';
  if (trues !== 1) return '';                     // two pairs the same but the third not: not consistent, so not sure
  const [a, b] = [[0, 1], [0, 2], [1, 2]].find(([x, y]) => s(x, y)); const odd = [0, 1, 2].find(k => k !== a && k !== b);
  return `2 of 3 seats agree: ${course[a]}; ${names[odd]} differs: ${course[odd]}`;
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
