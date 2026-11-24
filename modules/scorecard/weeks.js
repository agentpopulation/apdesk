// Weeks in the owner's time zone. A week runs from midnight on its first day to midnight a week later, so a record
// counted "this week" is the week the owner sees on his own clock, not a UTC week.

const DAY = 86400000;
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
const FIRST = { mon: 1, sun: 0, sat: 6 };

function zoneOk(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return undefined; } }

/** The wall-clock date and weekday (0 = Sunday) of an instant in a zone. */
export function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zoneOk(tz), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second), wd: WEEKDAY[p.weekday] ?? 0 };
}
/** The instant at which the wall clock of the zone reads midnight on that date. */
export function midnightOf(y, m, d, tz) {
  const wall = Date.UTC(y, m - 1, d);
  const offsetAt = (t) => { const p = localParts(t, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000; };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return t;
}
/** First day of the week for a locale (0 = Sunday ... 6 = Saturday); Monday when the runtime cannot say. */
export function localeFirstDay(locale) {
  try {
    const l = new Intl.Locale(String(locale || '').replace(/_/g, '-'));
    const info = typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo;
    if (info && Number.isInteger(info.firstDay)) return info.firstDay === 7 ? 0 : info.firstDay;
  } catch {}
  return 1;
}
export function firstDayOf(choice, locale) { return choice in FIRST ? FIRST[choice] : localeFirstDay(locale); }

/** `count` weeks, newest first: { index, start, end (ms), startIso, endIso, label }. Week 0 is the one that holds `now`. */
export function weeksBack({ now, tz, firstDay = 1, count = 2, locale }) {
  const p = localParts(now, tz);
  const back = (p.wd - firstDay + 7) % 7;
  const out = [];
  const fmt = (ms) => { try { return new Intl.DateTimeFormat(String(locale || 'en').replace(/_/g, '-'), { day: 'numeric', month: 'short', timeZone: zoneOk(tz) }).format(new Date(ms)); } catch { return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: zoneOk(tz) }).format(new Date(ms)); } };
  for (let i = 0; i < count; i++) {
    const start = midnightOf(p.y, p.m, p.d - back - 7 * i, tz);
    const end = midnightOf(p.y, p.m, p.d - back - 7 * i + 7, tz);
    // the label's last day is the day before `end`; for the running week it is the last day of the week
    out.push({ index: i, start, end, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString(), label: `${fmt(start)} to ${fmt(end - DAY / 2)}` });
  }
  return out;
}
export const weekIndexOf = (weeks, iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return -1; return weeks.findIndex(w => t >= w.start && t < w.end); };
