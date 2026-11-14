// Calendar (module 18): a local calendar in SQLite. Month, Week, Day and List views; add, edit, delete; .ics import and export.
// An agent adding an event asks the approval door ('calendar.write'); inviting other people is 'send.person', one approval
// per person, and goes through Mail only when Mail is on. Google or Outlook sync is not built.
import crypto from 'node:crypto';
import { writeIcs, readIcs, wallToUtc } from './ics.js';
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const now = () => new Date().toISOString();
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

export async function activate(ctx) {
  ctx.db.migrate(1, `CREATE TABLE IF NOT EXISTS m_calendar_events (id TEXT PRIMARY KEY, uid TEXT UNIQUE, title TEXT, start TEXT, end_ TEXT, all_day INTEGER DEFAULT 0, date TEXT, end_date TEXT,
    location TEXT, notes TEXT, attendees TEXT, rrule TEXT, created_by TEXT, created TEXT, updated TEXT);
    CREATE INDEX IF NOT EXISTS m_calendar_events_start ON m_calendar_events (start);`);
  const tz = () => ctx.settings.get('timeZone') || 'UTC';
  const emit = (d) => ctx.events.emit('calendar', d);
  const out = (r) => r && ({ id: r.id, uid: r.uid, title: r.title, start: r.start, end: r.end_, allDay: !!r.all_day, date: r.date, endDate: r.end_date, location: r.location || '', notes: r.notes || '', attendees: JSON.parse(r.attendees || '[]'), rrule: r.rrule || null, createdBy: r.created_by || 'You', created: r.created, updated: r.updated });
  const get = (id) => out(ctx.db.get('SELECT * FROM m_calendar_events WHERE id = ?', id));

  /** Normalise what an owner, an agent or a file gives us. Times without a zone are the owner's wall clock. */
  function normalise(e) {
    const title = clip(e?.title || e?.summary, 200);
    if (!title) throw Object.assign(new Error('An event needs a title.'), { status: 400 });
    const allDay = !!e.allDay || (/^\d{4}-\d\d-\d\d$/.test(String(e.start || '')) && !e.end);
    let start, end, date = null, endDate = null;
    if (allDay) {
      date = String(e.date || e.start || '').slice(0, 10); endDate = String(e.endDate || date).slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw Object.assign(new Error('Give the day as a date.'), { status: 400 });
      start = wallToUtc(date + 'T00:00', tz()); end = wallToUtc(endDate + 'T23:59', tz());
    } else {
      start = wallToUtc(e.start, tz()); if (!start) throw Object.assign(new Error('Give a start time I can read, like 2026-11-20 10:00.'), { status: 400 });
      end = e.end ? wallToUtc(e.end, tz()) : new Date(new Date(start).getTime() + (Number(e.minutes) || 60) * 60000).toISOString();
      if (!end || end < start) end = new Date(new Date(start).getTime() + 3600000).toISOString();
    }
    const attendees = (Array.isArray(e.attendees) ? e.attendees : String(e.attendees || '').split(/[,;]/)).map(a => typeof a === 'string' ? { name: '', email: a.trim().toLowerCase() } : { name: clip(a?.name, 120), email: String(a?.email || '').trim().toLowerCase() }).filter(a => EMAIL.test(a.email)).slice(0, 50);
    return { title, start, end, allDay, date, endDate, location: clip(e.location, 300), notes: String(e.notes || e.description || '').slice(0, 4000), attendees, rrule: e.rrule ? clip(e.rrule, 300) : null };
  }
  function insert(e, by = 'You') {
    const n = normalise(e); const id = 'ev_' + crypto.randomBytes(6).toString('hex'); const uid = e.uid ? clip(e.uid, 300) : `${id}@apd.local`;
    const dup = ctx.db.get('SELECT id FROM m_calendar_events WHERE uid = ?', uid);
    if (dup) return { ...get(dup.id), duplicate: true };
    ctx.db.run('INSERT INTO m_calendar_events (id, uid, title, start, end_, all_day, date, end_date, location, notes, attendees, rrule, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, uid, n.title, n.start, n.end, n.allDay ? 1 : 0, n.date, n.endDate, n.location, n.notes, JSON.stringify(n.attendees), n.rrule, by, now(), now());
    emit({ change: 'event', id });
    return get(id);
  }
  function update(id, patch) {
    const cur = get(id); if (!cur) return null;
    const n = normalise({ ...cur, ...(cur.allDay && !('date' in patch) && 'start' in patch ? { date: String(patch.start).slice(0, 10) } : {}), ...patch });
    ctx.db.run('UPDATE m_calendar_events SET title = ?, start = ?, end_ = ?, all_day = ?, date = ?, end_date = ?, location = ?, notes = ?, attendees = ?, rrule = ?, updated = ? WHERE id = ?', n.title, n.start, n.end, n.allDay ? 1 : 0, n.date, n.endDate, n.location, n.notes, JSON.stringify(n.attendees), n.rrule, now(), id);
    emit({ change: 'event', id });
    return get(id);
  }
  function list({ from, to } = {}) {
    const f = from ? wallToUtc(from, tz()) : '0000'; const t = to ? wallToUtc(to, tz()) : '9999';
    return ctx.db.all('SELECT * FROM m_calendar_events WHERE end_ >= ? AND start <= ? ORDER BY start', f, t).map(out);
  }
  const when = (ev) => { try { return ev.allDay ? new Date(ev.start).toLocaleDateString(ctx.settings.get('locale') || 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz() }) : new Date(ev.start).toLocaleString(ctx.settings.get('locale') || 'en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz() }); } catch { return ev.start; } };

  /** An agent's add: asks the owner ('calendar.write'), then invites each attendee only with its own send.person approval. */
  async function agentAdd(e, { agentId = null, chatId = null, signal } = {}) {
    const n = normalise(e);
    const d = await ctx.approval.request({ agentId, chatId, action: 'calendar.write', title: `Add "${n.title}" on ${when(n)}`, detail: [n.location, n.attendees.length ? `with ${n.attendees.map(a => a.email).join(', ')}` : ''].filter(Boolean).join(' · ') || 'Calendar', payload: { title: n.title, start: n.start, end: n.end, location: n.location }, signal });
    if (!d.ok) return { ok: false, text: d.reason === 'denied' ? 'You said no, so the event was not added.' : `The event was not added (${d.reason}).` };
    const ev = insert(e, ctx.agents.get(agentId)?.name || 'An agent');
    const invites = [];
    if (n.attendees.length) {
      const mail = ctx.modules.api('mail');
      for (const a of n.attendees) {
        if (!mail?.send) { invites.push(`${a.email}: not invited, Mail is off`); continue; }
        const body = `You are invited: ${ev.title}\nWhen: ${when(ev)} (${tz()})${ev.location ? `\nWhere: ${ev.location}` : ''}${ev.notes ? `\n\n${ev.notes}` : ''}\n\n${writeIcs([ev])}`;
        const ok = await ctx.approval.request({ agentId, chatId, action: 'send.person', title: `Invite ${a.email} to ${ev.title}`, detail: when(ev), payload: { to: a.email, subject: `Invitation: ${ev.title}`, body }, signal });
        if (!ok.ok) { invites.push(`${a.email}: not invited`); continue; }
        try { await mail.send({ to: a.email, subject: `Invitation: ${ev.title}`, body, approvalId: ok.id, source: 'calendar', ref: ev.id }); invites.push(`${a.email}: invited`); } catch (x) { invites.push(`${a.email}: not sent (${x.message})`); }
      }
    }
    return { ok: true, event: ev, text: `Added "${ev.title}" on ${when(ev)}.${invites.length ? ' ' + invites.join('; ') + '.' : ''}` };
  }

  ctx.tool({ name: 'calendar_add', description: 'Add an event to the owner\'s calendar. The owner approves it first. Times without a zone are the owner\'s local time (YYYY-MM-DDTHH:MM). Attendees get an invitation only if the owner approves each one and Mail is on.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'string', description: 'YYYY-MM-DDTHH:MM local time, or YYYY-MM-DD for all day' }, end: { type: 'string' }, allDay: { type: 'boolean' }, location: { type: 'string' }, notes: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' }, description: 'mail addresses' } }, required: ['title', 'start'] },
    async run(args, call) { return agentAdd(args, { agentId: call.agentId, chatId: call.chatId, signal: call.signal }); } });
  ctx.tool({ name: 'calendar_list', description: 'List calendar events between two dates (owner\'s local dates, YYYY-MM-DD). Default: the next 14 days.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
    async run(args) {
      const from = args.from || new Date().toISOString().slice(0, 10); const to = args.to || new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
      const evs = list({ from, to: /T/.test(to) ? to : to + 'T23:59' });
      return { ok: true, events: evs.map(e => ({ title: e.title, when: when(e), location: e.location })), text: evs.length ? evs.map(e => `${when(e)}: ${e.title}`).join('\n') : 'Nothing in the calendar for those days.' };
    } });

  const ownerOnly = (res, owner) => { if (!owner) { ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403); return true; } return false; };
  const fail = (res, e) => ctx.json(res, { error: e.message }, e.status || 500);
  ctx.route('GET', '/events', (req, res, { query }) => ctx.json(res, { events: list({ from: query.from, to: query.to }), timeZone: tz() }));
  ctx.route('POST', '/events', (req, res, { body, owner }) => { if (ownerOnly(res, owner)) return; try { ctx.json(res, { event: insert(body || {}) }); } catch (e) { fail(res, e); } });
  ctx.route('PATCH', '/events/:id', (req, res, { params, body, owner }) => { if (ownerOnly(res, owner)) return; try { const e = update(params.id, body || {}); e ? ctx.json(res, { event: e }) : ctx.json(res, { error: 'Not found' }, 404); } catch (e) { fail(res, e); } });
  ctx.route('DELETE', '/events/:id', (req, res, { params, owner }) => { if (ownerOnly(res, owner)) return; ctx.db.run('DELETE FROM m_calendar_events WHERE id = ?', params.id); emit({ change: 'event' }); ctx.json(res, { ok: true }); });
  ctx.route('GET', '/export.ics', (req, res) => { res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="calendar.ics"', 'cache-control': 'no-store' }); res.end(writeIcs(list())); });
  ctx.route('POST', '/import', (req, res, { body, owner }) => {
    if (ownerOnly(res, owner)) return;
    const evs = readIcs(String(body?.ics || ''), { tz: tz() });
    if (!evs.length) return ctx.json(res, { error: 'No events found in that file.' }, 400);
    let added = 0, same = 0, bad = 0;
    for (const e of evs.slice(0, 5000)) { try { const r = insert(e, 'Import'); if (r.duplicate) same++; else added++; } catch { bad++; } }
    ctx.json(res, { added, same, bad, text: `Added ${added} event${added === 1 ? '' : 's'}${same ? `, ${same} already there` : ''}${bad ? `, ${bad} could not be read` : ''}.` });
  });

  ctx.expose({ add: (event, opts) => agentAdd(event, opts || {}), list: (range) => list(range || {}), exportIcs: () => writeIcs(list()) });
  return { async deactivate() {} };
}
