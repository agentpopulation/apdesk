// Calendar page: Month, Week, Day and List views in the owner's time zone; add, edit, delete; .ics import and export.
const STYLE = `
.view.calv{overflow:hidden}
.calv .cal-body{flex:1;min-height:0;overflow:auto}
.calv .mgrid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-auto-rows:minmax(84px,1fr);gap:6px;height:100%}
.calv .mhead{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;font-size:12px;color:var(--dim);font-weight:600;padding:0 4px}
.calv .day{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px;display:flex;flex-direction:column;gap:3px;min-height:0;overflow:hidden;cursor:pointer;text-align:left;font:inherit;color:inherit}
.calv .day.out{opacity:.45}.calv .day.today{border-color:var(--accent)}
.calv .day .n{font-size:12px;font-weight:600}
.calv .ev{font-size:12px;background:var(--accent-soft);color:var(--accent);border-radius:6px;padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;border:0;text-align:left;font-family:inherit}
.calv .wgrid{display:grid;grid-template-columns:repeat(7,minmax(130px,1fr));gap:8px;height:100%}
.calv .wcol{background:var(--side);border:1px solid var(--line);border-radius:var(--r);padding:8px;display:flex;flex-direction:column;gap:6px;min-height:0;overflow:auto}
.calv .wcol header{font-size:12.5px;font-weight:600}
`;
let view = 0; let cursor = null;

export const pages = {
  calendar: {
    title: 'Calendar',
    async render(el, ui) {
      const { h, btn, api, toast } = ui;
      if (!document.getElementById('cal-style')) document.head.append(h('style', { id: 'cal-style' }, STYLE));
      el.classList.add('calv');
      const tz = ui.state.settings?.timeZone || 'UTC'; const loc = ui.state.settings?.locale || 'en-IN';
      const keyOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
      const addDays = (k, n) => { const d = new Date(k + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
      const dow = (k) => (new Date(k + 'T12:00:00Z').getUTCDay() + 6) % 7;         // Monday 0
      const label = (k, o) => new Date(k + 'T12:00:00Z').toLocaleDateString(loc, { timeZone: 'UTC', ...o });
      const today = keyOf(Date.now()); cursor = cursor || today;
      const seg = ui.seg(['Month', 'Week', 'Day', 'List'], view, (o, i) => { view = i; paint(); });
      const title = h('h3', { style: { margin: 0, minWidth: '160px' } });
      const file = h('input', { type: 'file', accept: '.ics,text/calendar', hidden: true, onchange: importFile });
      el.replaceChildren(
        h('div', { class: 'row' }, h('h2', null, 'Calendar'), seg, btn('‹', { kind: 'ghost sm', title: 'Back', onClick: () => step(-1) }), btn('Today', { kind: 'ghost sm', onClick: () => { cursor = today; load(); } }), btn('›', { kind: 'ghost sm', title: 'Forward', onClick: () => step(1) }), title,
          h('span', { class: 'grow' }), btn('Import .ics', { kind: 'ghost', onClick: () => file.click() }), h('a', { class: 'btn ghost', href: '/api/m/calendar/export.ics', download: 'calendar.ics' }, 'Export .ics'), btn('Add event', { onClick: () => edit({ date: cursor }) }), file),
        h('div', { class: 'cal-body' }));
      const body = el.querySelector('.cal-body');
      let events = [];
      const range = () => {
        if (view === 0) { const first = cursor.slice(0, 8) + '01'; const s = addDays(first, -dow(first)); return [s, addDays(s, 41)]; }
        if (view === 1) { const s = addDays(cursor, -dow(cursor)); return [s, addDays(s, 6)]; }
        if (view === 2) return [cursor, cursor];
        return [cursor, addDays(cursor, 90)];
      };
      function step(n) { if (view === 0) { const d = new Date(cursor.slice(0, 8) + '01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); cursor = d.toISOString().slice(0, 10); } else cursor = addDays(cursor, n * (view === 1 ? 7 : view === 2 ? 1 : 30)); load(); }
      async function load() { const [a, b] = range(); events = (await api(`m/calendar/events?from=${a}T00:00&to=${b}T23:59`)).events; paint(); }
      const on = (k) => events.filter(e => keyOf(e.start) <= k && keyOf(new Date(new Date(e.end).getTime() - (e.allDay ? 0 : 1))) >= k);
      const time = (e) => e.allDay ? 'All day' : ui.fmt.time(e.start);
      const chip = (e) => h('button', { class: 'ev', type: 'button', title: e.title, onclick: (x) => { x.stopPropagation(); edit(e); } }, `${e.allDay ? '' : ui.fmt.time(e.start) + ' '}${e.title}`);
      function paint() {
        const [a] = range();
        title.textContent = view === 0 ? label(cursor, { month: 'long', year: 'numeric' }) : view === 1 ? `${label(a, { day: 'numeric', month: 'short' })} – ${label(addDays(a, 6), { day: 'numeric', month: 'short', year: 'numeric' })}` : view === 2 ? label(cursor, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Coming up';
        if (view === 0) {
          const days = Array.from({ length: 42 }, (_, i) => addDays(a, i)); const m = cursor.slice(0, 7);
          body.replaceChildren(h('div', { class: 'stack', style: { height: '100%', gap: '6px' } }, h('div', { class: 'mhead' }, days.slice(0, 7).map(k => h('span', null, label(k, { weekday: 'short' })))),
            h('div', { class: 'mgrid', style: { flex: '1' } }, days.map(k => { const evs = on(k); return h('div', { class: 'day' + (k.slice(0, 7) !== m ? ' out' : '') + (k === today ? ' today' : ''), onclick: () => { cursor = k; view = 2; seg.set(2); load(); } }, h('span', { class: 'n' }, String(Number(k.slice(8)))), evs.slice(0, 3).map(chip), evs.length > 3 ? h('span', { class: 'sub' }, `${evs.length - 3} more`) : null); }))));
        } else if (view === 1) {
          body.replaceChildren(h('div', { class: 'wgrid' }, Array.from({ length: 7 }, (_, i) => addDays(a, i)).map(k => h('div', { class: 'wcol', style: k === today ? { borderColor: 'var(--accent)' } : null }, h('header', null, label(k, { weekday: 'short', day: 'numeric', month: 'short' })), on(k).map(chip), btn('Add', { kind: 'ghost sm', onClick: () => edit({ date: k }) })))));
        } else if (view === 2) {
          const evs = on(cursor);
          body.replaceChildren(h('div', { class: 'card' }, evs.length ? evs.map(e => ui.line(e.title, [time(e), e.location, e.createdBy !== 'You' ? 'added by ' + e.createdBy : ''].filter(Boolean).join(' · '), btn('Open', { kind: 'ghost sm', onClick: () => edit(e) }))) : ui.empty('Nothing on this day.')));
        } else {
          body.replaceChildren(h('div', { class: 'card' }, events.length ? events.map(e => ui.line(e.title, `${ui.fmt.date(e.start)} · ${time(e)}${e.location ? ' · ' + e.location : ''}`, btn('Open', { kind: 'ghost sm', onClick: () => edit(e) }))) : ui.empty('Nothing in the next three months.')));
        }
      }
      function edit(e) {
        const isNew = !e.id;
        const hm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
        const t = h('input', { type: 'text', value: e.title || '', style: { width: '100%' } });
        const d = h('input', { type: 'date', value: e.start ? keyOf(e.start) : e.date || today });
        const s = h('input', { type: 'time', value: e.start && !e.allDay ? hm(e.start) : '10:00' }); const en = h('input', { type: 'time', value: e.end && !e.allDay ? hm(e.end) : '11:00' });
        const all = h('input', { type: 'checkbox', checked: !!e.allDay });
        const l = h('input', { type: 'text', value: e.location || '', style: { width: '100%' } }); const n = h('textarea', { rows: 3 }, e.notes || '');
        ui.modal({ title: isNew ? 'Add event' : 'Event', body: h('div', { class: 'stack' }, h('label', { class: 'f' }, 'Title', t), h('div', { class: 'row' }, h('label', { class: 'f' }, 'Day', d), h('label', { class: 'f' }, 'From', s), h('label', { class: 'f' }, 'To', en), h('label', { class: 'row sub' }, all, 'All day')), h('label', { class: 'f' }, 'Place', l), h('label', { class: 'f' }, 'Notes', n), h('span', { class: 'sub' }, `Times are in ${tz}.`)),
          actions: [...(isNew ? [] : [{ label: 'Delete', onClick: async () => { await api(`m/calendar/events/${e.id}`, { method: 'DELETE' }); load(); } }]), { label: 'Cancel' },
            { label: isNew ? 'Add' : 'Save', kind: '', onClick: async () => { const b = { title: t.value, allDay: all.checked, location: l.value, notes: n.value, ...(all.checked ? { date: d.value, endDate: d.value, start: d.value } : { start: `${d.value}T${s.value}`, end: `${d.value}T${en.value}` }) };
              try { if (isNew) await api('m/calendar/events', { body: b }); else await api(`m/calendar/events/${e.id}`, { method: 'PATCH', body: b }); cursor = d.value; load(); } catch (x) { toast(x.message, 'err'); return false; } } }] });
      }
      async function importFile() { const f = file.files[0]; if (!f) return; try { const r = await api('m/calendar/import', { body: { ics: await f.text() } }); toast(r.text, 'ok'); load(); } catch (e) { toast(e.message, 'err'); } file.value = ''; }
      ui.on('calendar', () => load().catch(() => {}));
      await load();
    },
  },
};
