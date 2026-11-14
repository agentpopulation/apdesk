// iCalendar (RFC 5545) writer and a tolerant reader.
// No recurrence expansion (RRULE is kept as text); TZID times are resolved with Intl.

export function escapeText(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
export function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = []; let chunk = ''; let size = 0;
  for (const ch of line) { const len = Buffer.byteLength(ch, 'utf8'); const limit = out.length ? 74 : 75; if (size + len > limit) { out.push(chunk); chunk = ''; size = 0; } chunk += ch; size += len; }
  if (chunk) out.push(chunk);
  return out.join('\r\n ');
}
export function unfold(text) { return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, ''); }
function unescapeText(value) { return String(value || '').replace(/\\([\\;,nN])/g, (_, ch) => (ch === 'n' || ch === 'N' ? '\n' : ch)); }
export function parseLine(line) {
  let i = 0; let quoted = false;
  for (; i < line.length; i += 1) { const ch = line[i]; if (ch === '"') quoted = !quoted; else if (ch === ':' && !quoted) break; }
  if (i >= line.length) return null;
  const head = line.slice(0, i); const value = line.slice(i + 1);
  const bits = []; let cur = ''; quoted = false;
  for (const ch of head) { if (ch === '"') quoted = !quoted; if (ch === ';' && !quoted) { bits.push(cur); cur = ''; } else cur += ch; }
  bits.push(cur);
  const name = bits.shift().trim().toUpperCase();
  const params = {};
  for (const b of bits) { const k = b.indexOf('='); if (k > 0) params[b.slice(0, k).trim().toUpperCase()] = b.slice(k + 1).replace(/^"|"$/g, ''); }
  return { name, params, value };
}

const utcStamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const dateStamp = (key) => String(key).replace(/-/g, '');
function addDaysKey(key, n) { const d = new Date(key + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** events: [{ uid, title, start, end, allDay, date, endDate, location, notes, attendees: [{ name, email }], created, updated }] */
export function writeIcs(events, { name = 'AP Desk' } = {}) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Agent Population Desk//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(name)}`];
  for (const e of events) {
    L.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utcStamp(e.updated || e.created || new Date().toISOString())}`);
    if (e.allDay) { const first = e.date || String(e.start).slice(0, 10); L.push(`DTSTART;VALUE=DATE:${dateStamp(first)}`, `DTEND;VALUE=DATE:${dateStamp(addDaysKey(e.endDate || first, 1))}`); }
    else L.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(e.end || e.start)}`);
    L.push(`SUMMARY:${escapeText(e.title || 'Untitled')}`);
    if (e.notes) L.push(`DESCRIPTION:${escapeText(e.notes)}`);
    if (e.location) L.push(`LOCATION:${escapeText(e.location)}`);
    if (e.rrule) L.push(`RRULE:${String(e.rrule).replace(/^RRULE:/i, '')}`);
    for (const a of e.attendees || []) if (a?.email) L.push(`ATTENDEE${a.name ? `;CN="${String(a.name).replace(/"/g, "'")}"` : ''};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${a.email}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR', '');
  return L.map(foldLine).join('\r\n');
}

/** Offset of a time zone at an instant, in minutes (Asia/Kolkata -> 330). */
export function zoneOffset(tz, at = Date.now()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at) / 60000);
  } catch { return 0; }
}
/** "2026-11-20T10:00" (wall time in tz) -> ISO UTC. Strings with Z or an offset keep their meaning. */
export function wallToUtc(s, tz) {
  const str = String(s || '').trim();
  if (!str) return null;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(str)) { const d = new Date(str); return isNaN(d) ? null : d.toISOString(); }
  const m = str.match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?/);
  if (!m) { const d = new Date(str); return isNaN(d) ? null : d.toISOString(); }
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  let off = zoneOffset(tz, guess); let t = guess - off * 60000;
  off = zoneOffset(tz, t); t = guess - off * 60000;
  return new Date(t).toISOString();
}
function icsTime(prop, tz) {
  if (!prop) return { iso: null, date: null };
  const v = prop.value.trim();
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, iso: null };
  const m = v.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)?(Z)?$/);
  if (!m) return { iso: null, date: null };
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
  return { iso: m[7] ? new Date(wall + 'Z').toISOString() : wallToUtc(wall, prop.params.TZID || tz), date: null };
}
/** Parse VEVENTs. Unknown TZIDs fall back to the owner's zone. */
export function readIcs(text, { tz = 'UTC' } = {}) {
  const lines = unfold(text).split('\n'); const out = []; let cur = null; let depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd(); if (!line) continue;
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = { props: {}, attendees: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (/^BEGIN:/i.test(line)) { depth++; continue; }
    if (/^END:/i.test(line) && depth > 0) { depth--; continue; }
    if (/^END:VEVENT$/i.test(line)) {
      const p = cur.props; const s = icsTime(p.DTSTART, tz); const e = icsTime(p.DTEND, tz);
      if (s.iso || s.date) {
        const allDay = !!s.date;
        out.push({ uid: p.UID?.value || null, title: unescapeText(p.SUMMARY?.value || 'Untitled'), allDay, date: s.date, endDate: allDay && e.date ? addDaysKey(e.date, -1) : s.date,
          start: s.iso || wallToUtc(s.date + 'T00:00', tz), end: e.iso || (allDay ? wallToUtc((e.date || addDaysKey(s.date, 1)) + 'T00:00', tz) : s.iso),
          location: unescapeText(p.LOCATION?.value || ''), notes: unescapeText(p.DESCRIPTION?.value || ''), rrule: p.RRULE?.value || null, attendees: cur.attendees });
      }
      cur = null; continue;
    }
    if (depth > 0) continue;
    const pl = parseLine(line); if (!pl) continue;
    if (pl.name === 'ATTENDEE') { const email = pl.value.replace(/^mailto:/i, '').trim(); if (email) cur.attendees.push({ name: pl.params.CN || '', email }); }
    else if (!cur.props[pl.name]) cur.props[pl.name] = pl;
  }
  return out;
}
