// Plain words -> a schedule: { cron } (repeating, in the owner's zone) or { at } (one time, ISO UTC).
// Deterministic first; the model is asked only when these rules do not match (see server.js).
import { Cron } from 'croner';

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PART_DEFAULT = { morning: 8, afternoon: 14, evening: 18, night: 21 };
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90 };
const NUM_RE = '\\d+|' + Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length).join('|');
const UNIT_RE = 'seconds?|secs?|minutes?|mins?|hours?|hrs?|days?';

/** Is this a usable five-field cron expression? Returns the trimmed expression or null. */
export function validCron(expr, timezone) {
  const e = String(expr || '').trim().replace(/\s+/g, ' ');
  if (e.split(' ').length !== 5) return null;
  try { const c = new Cron(e, { timezone, paused: true }); const n = c.nextRun(); c.stop(); return n ? e : null; } catch { return null; }
}

/** Find a time of day in the words: "at 8", "8:30 pm", "at 19.15", "noon". */
function timeOf(t, part) {
  if (/\bnoon\b|\bmidday\b/.test(t)) return { h: 12, m: 0 };
  if (/\bmidnight\b/.test(t)) return { h: 0, m: 0 };
  let mm = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/);
  if (!mm) mm = t.match(/\bat\s+(\d{1,2})(?:[:.](\d{2}))?(?!\s*(?:minute|min|hour|hr|day|week))/);
  if (!mm) mm = t.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (!mm) return null;
  let h = Number(mm[1]); const m = Number(mm[2] || 0);
  const ap = (mm[3] || '').replace(/\./g, '');
  if (h > 23 || m > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h < 12 && (part === 'evening' || part === 'night' || (part === 'afternoon' && h < 7))) h += 12;
  return { h, m };
}

/** Today's date in a zone: { y, mo, d, wd } */
function zonedDate(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), wd: DAYS[String(p.weekday).toLowerCase().slice(0, 3)] };
}
/** The instant of H:MM on a given zoned date. */
function instantOn({ mo, d }, { h, m }, timeZone, fromMs) {
  const c = new Cron(`${m} ${h} ${d} ${mo} *`, { timezone: timeZone, paused: true });
  const n = c.nextRun(new Date(fromMs)); c.stop();
  return n;
}

/**
 * parseWhen('Every morning at 8, brief me', { timeZone }) -> { cron: '0 8 * * *', text: 'Every day at 8:00 AM' }
 * parseWhen('in 10 minutes') -> { at: '2026-…Z', text: 'Once, in 10 minutes' }      null when the rules do not match.
 */
export function parseWhen(words, { timeZone = 'Asia/Kolkata', now = Date.now() } = {}) {
  const raw = String(words || '').trim();
  if (!raw) return null;
  const cron = validCron(raw, timeZone);
  if (cron && /^[\d*\/,\-\s]+$/.test(raw)) return { cron, text: describeCron(cron) };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !Number.isNaN(Date.parse(raw))) return { at: new Date(raw).toISOString(), text: 'Once' };
  const t = ' ' + raw.toLowerCase().replace(/[,;!?]|\.(?=\s|$)/g, ' ').replace(/\s+/g, ' ') + ' ';
  const num = (x) => NUM_WORDS[x] ?? Number(x);
  // one time: in N seconds / minutes / hours / days ("in one minute", "in 5 minutes", "in an hour", "in half an hour", "in a couple of minutes")
  const every = /\b(every|each)\b/.test(t);
  let mm = t.match(/\b(?:in|after)\s+half\s+an?\s+hour\b/);
  if (mm) return { at: new Date(now + 30 * 60_000).toISOString(), text: 'Once, in 30 minutes' };
  mm = t.match(new RegExp(`\\b(?:in|after)\\s+(?:about\\s+)?(a couple of|a few|${NUM_RE})\\s*(${UNIT_RE})\\b`));
  if (!mm && !every) mm = t.match(new RegExp(`^\\s*\\+?(${NUM_RE})\\s*(${UNIT_RE}|m|h|s)\\s*(?:from now|later)?\\s*$`));   // a bare "1 minute", "5m"
  if (mm && !every) {
    const n = mm[1] === 'a couple of' ? 2 : mm[1] === 'a few' ? 3 : num(mm[1]);
    const u = mm[2][0];
    const unit = u === 's' ? 1000 : u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : 86_400_000;
    const word = { s: 'second', m: 'minute', h: 'hour', d: 'day' }[u];
    if (n > 0) return { at: new Date(now + Math.max(10_000, n * unit)).toISOString(), text: `Once, in ${n} ${word}${n === 1 ? '' : 's'}` };
  }
  // every N minutes / hours, every minute, every hour, hourly
  mm = t.match(/\bevery\s+(\d+|two|three|five|ten|fifteen|twenty|thirty)\s*(minutes?|mins?|hours?|hrs?)\b/);
  if (mm) {
    const n = num(mm[1]);
    if (mm[2][0] === 'm' && n >= 1 && n < 60) { const c = n === 1 ? '* * * * *' : `*/${n} * * * *`; return { cron: c, text: describeCron(c) }; }
    const hrs = mm[2][0] === 'h' ? n : n / 60;
    if (Number.isInteger(hrs) && hrs >= 1 && hrs <= 23) { const c = hrs === 1 ? '0 * * * *' : `0 */${hrs} * * *`; return { cron: c, text: describeCron(c) }; }
  }
  if (/\bevery minute\b/.test(t)) return { cron: '* * * * *', text: 'Every minute' };
  if (/\b(every hour|hourly)\b/.test(t)) return { cron: '0 * * * *', text: 'Every hour' };
  const part = (t.match(/\b(morning|afternoon|evening|night)s?\b/) || [])[1] || null;
  const time = timeOf(t, part) || (part ? { h: PART_DEFAULT[part], m: 0 } : null);
  const repeat = /\b(every|each|daily|weekdays?|weekends?|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/.test(t);
  if (repeat) {
    const tm = time || { h: 9, m: 0 };
    let dow = '*';
    if (/\b(every )?(weekday|weekdays|working day|work day)\b/.test(t)) dow = '1-5';
    else if (/\bweekends?\b/.test(t)) dow = '0,6';
    else {
      const days = [...t.matchAll(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day)?s?\b/g)].map(x => DAYS[x[1].slice(0, 3)]);
      if (days.length) dow = [...new Set(days)].sort((a, b) => a - b).join(',');
    }
    if (dow === '*' && !/\b(every|each|daily)\b/.test(t)) return null;
    if (dow === '*' && !time && !/\b(daily|every day|each day|every single day)\b/.test(t)) return null;
    if (dow === '*' && /\bevery\s+(week|month|year)\b/.test(t)) return null;   // let the model read these
    const c = `${tm.m} ${tm.h} * * ${dow}`;
    return { cron: c, text: describeCron(c) };
  }
  // one time: tomorrow at H, today at H, at H
  if (time && /\b(tomorrow|today|tonight|at)\b/.test(t)) {
    const tomorrow = /\btomorrow\b/.test(t);
    const day = zonedDate(now + (tomorrow ? 86_400_000 : 0), timeZone);
    let at = instantOn(day, time, timeZone, now);
    if (!tomorrow && (!at || at.getTime() - now > 86_400_000)) at = instantOn(zonedDate(now + 86_400_000, timeZone), time, timeZone, now);
    if (at) return { at: at.toISOString(), text: `Once, ${tomorrow ? 'tomorrow' : 'next'} at ${hm(time.h, time.m)}` };
  }
  return null;
}

export const hm = (h, m) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;

/** A cron expression in plain words (the owner never sees the expression itself). */
export function describeCron(expr) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length !== 5) return 'On a custom timetable';
  const [mi, ho, dom, mon, dow] = p;
  const isN = (x) => /^\d+$/.test(x);
  if (p.join(' ') === '* * * * *') return 'Every minute';
  let m = mi.match(/^\*\/(\d+)$/); if (m && ho === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m[1]} minutes`;
  if (isN(mi) && ho === '*' && dom === '*' && mon === '*' && dow === '*') return mi === '0' ? 'Every hour' : `Every hour at ${mi} past`;
  m = ho.match(/^\*\/(\d+)$/); if (isN(mi) && m && dom === '*' && mon === '*' && dow === '*') return `Every ${m[1]} hours`;
  if (!isN(mi) || !isN(ho)) return 'On a custom timetable';
  const at = hm(Number(ho), Number(mi));
  if (dom === '*' && mon === '*') {
    if (dow === '*') return `Every day at ${at}`;
    if (dow === '1-5') return `Every weekday at ${at}`;
    if (dow === '0,6' || dow === '6,0') return `Every weekend day at ${at}`;
    if (/^[0-7](,[0-7])*$/.test(dow)) { const names = dow.split(',').map(d => DAY_NAMES[Number(d) % 7]); return `Every ${names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0]} at ${at}`; }
  }
  if (isN(dom) && mon === '*' && dow === '*') return `Every month on day ${dom} at ${at}`;
  if (isN(dom) && isN(mon) && dow === '*') return `Every year on ${dom} ${MONTHS[Number(mon) - 1] || ''} at ${at}`;
  return 'On a custom timetable';
}

/** What to do, with the time words taken out: "Every morning at 8, brief me" -> "brief me". */
export function stripWhen(text) {
  const s = String(text || '').replace(/\b(every|each)\s+(\d+\s*)?(day|morning|afternoon|evening|night|weekday|weekend|hour|minute|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, ' ')
    .replace(/\b(daily|hourly|tomorrow|today|tonight)\b/gi, ' ').replace(/\b(in|after)\s+half\s+an?\s+hour\b/gi, ' ').replace(new RegExp(`\\b(in|after)\\s+(about\\s+)?(a couple of|a few|${NUM_RE})\\s*(${UNIT_RE})\\b`, 'gi'), ' ').replace(/\b\d+\s*(minutes?|mins?|hours?)\b/gi, ' ')
    .replace(/\bat\s+\d{1,2}([:.]\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/gi, ' ').replace(/\b\d{1,2}([:.]\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/gi, ' ').replace(/\b(on|and)\s*(?=[,.]|$)/gi, ' ')
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').replace(/\s{2,}/g, ' ');
  return s;
}

/** Shorten at a word, never in the middle of one: short('Reply with one line', 14) -> 'Reply with one…' */
export function short(text, n = 70) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 1); const i = cut.lastIndexOf(' ');
  return (i > n * 0.4 ? cut.slice(0, i) : s.slice(0, n)).replace(/[\s,;:.-]+$/, '') + '…';
}
