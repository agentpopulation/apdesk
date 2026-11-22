// Life page: weather for your city, exchange rates, and a day plan for a trip.
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
export const pages = {
  life: {
    title: 'Life',
    async render(el, ui) {
      const { h, api, card, line, btn, pill, toast, fmt, empty, md } = ui;
      const wx = h('div', { class: 'stack' }), fx = h('div', { class: 'stack' }), planOut = h('div', { class: 'stack' }), past = h('div', { class: 'stack' });
      const round = (n) => (n == null ? '–' : Math.round(n));
      function chooser(note) {
        const q = h('input', { type: 'text', placeholder: 'Your city', value: ui.state.settings.city || '' });
        const list = h('div', { class: 'stack' });
        const find = async () => {
          put(list, h('span', { class: 'sub' }, 'Looking…'));
          try { const { places, error } = await api('m/life/places?q=' + encodeURIComponent(q.value)); if (error) return put(list, h('p', { class: 'sub' }, error)); put(list, ...(places.length ? places.map(p => line(p.label, p.timezone ? `Time zone ${p.timezone}` : '', btn('This one', { kind: 'ghost sm', onClick: async () => { await api('m/life/place', { body: { place: p } }); try { const r = await api('settings', { body: { city: p.name } }); ui.state.settings = r.settings; } catch {} paintWeather(); } }))) : [empty('No place by that name.')])); }
          catch (e) { put(list, h('p', { class: 'sub' }, ui.plainError(e))); }
        };
        return h('div', { class: 'stack' }, h('p', { class: 'sub' }, note), h('div', { class: 'row' }, q, btn('Find', { onClick: find })), list);
      }
      async function paintWeather() {
        put(wx, h('span', { class: 'sub' }, 'Getting the forecast…'));
        try {
          const w = await api('m/life/weather');
          if (w.unreachable) return put(wx, h('p', { class: 'sub' }, w.error), btn('Try again', { kind: 'ghost sm', onClick: paintWeather }));
          if (!w.ok) return put(wx, chooser('Which city is yours? The desk never guesses it. Pick it once and the weather shows here.'));
          const dayName = (iso) => {   // a stored style or zone the browser does not accept falls back to the computer's own
            const o = { weekday: 'short', day: 'numeric', month: 'short' };
            for (const [loc, timeZone] of [[ui.state.settings.locale, w.placeTimeZone], [undefined, w.placeTimeZone], [undefined, undefined]]) { try { return new Date(iso).toLocaleDateString(loc || undefined, { ...o, timeZone: timeZone || undefined }); } catch {} }
            return ui.fmt.date(iso);
          };
          put(wx, 
            h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, w.place), h('span', { class: 'grow' }), btn('Change city', { kind: 'ghost sm', onClick: () => put(wx, chooser('Pick another city.')) })),
            h('div', { class: 'row' }, h('b', { style: { fontSize: '30px' } }, `${round(w.current.tempC)}°C`), h('div', null, h('b', null, w.current.weather), h('span', { class: 'sub', style: { display: 'block' } }, `Feels like ${round(w.current.feelsC)}°C · humidity ${round(w.current.humidity)}% · wind ${round(w.current.windKph)} km/h`))),
            ui.table([{ label: 'Day', render: d => dayName(d.day) }, { label: 'Sky', render: d => d.weather }, { label: 'High', render: d => `${round(d.maxC)}°` }, { label: 'Low', render: d => `${round(d.minC)}°` }, { label: 'Rain', render: d => `${d.rainMm ?? 0} mm${d.rainChance != null ? ` · ${d.rainChance}%` : ''}` }, { label: 'Sunrise · sunset (your time)', render: d => `${fmt.time(d.sunrise)} · ${fmt.time(d.sunset)}` }], w.days),
            h('span', { class: 'sub' }, `Source: ${w.source}. Measured at ${fmt.time(w.current.at)}, fetched ${fmt.when(w.fetchedAt)}, your time.`));
        } catch (e) { put(wx, h('p', { class: 'sub' }, ui.plainError(e))); }
      }
      async function paintRates() {
        try {
          const r = await api('m/life/rates'); if (r.error) return put(fx, h('p', { class: 'sub' }, r.error));
          put(fx, h('span', { class: 'sub' }, `What one unit costs in ${r.base}, ${fmt.date(r.date + 'T12:00:00Z')}`),
            h('div', { class: 'row' }, ...r.rates.map(x => h('span', { class: 'pill' }, `${x.code} ${x.inBase >= 100 ? x.inBase.toFixed(0) : x.inBase.toFixed(2)}`))),
            h('span', { class: 'sub' }, `Source: ${r.source}. Share prices are not built: no keyless public source we trust.`));
        } catch (e) { put(fx, h('p', { class: 'sub' }, 'Rates are not available right now. Try again in a minute.')); }
      }
      const showPlan = (p) => put(planOut, 
        h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, `A day in ${p.where}`), h('span', { class: 'grow' }), pill(p.label), h('a', { href: p.mapLink, target: '_blank', rel: 'noopener noreferrer', class: 'btn ghost sm' }, 'Map')),
        md(p.text),
        p.places.length ? h('div', { class: 'row' }, h('span', { class: 'sub' }, 'On the map:'), ...p.places.map(x => h('a', { href: x.map, target: '_blank', rel: 'noopener noreferrer', class: 'pill' }, x.name))) : null,
        h('div', null, h('span', { class: 'sub' }, 'Sources'), ...p.sources.map(s => h('div', null, `[${s.n}] `, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title)))));
      async function paintPast() { const { plans } = await api('m/life/plans'); put(past, ...(plans.length ? plans.slice(0, 8).map(p => line(p.where, `${fmt.when(p.at)} · ${p.label}`, btn('Open', { kind: 'ghost sm', onClick: () => showPlan(p) }))) : [empty('No plans yet.')])); }
      const where = h('input', { type: 'text', placeholder: 'Where to, for example Lisbon' }); const likes = h('input', { type: 'text', placeholder: 'What you like (optional)', style: { flex: '1' } });
      const go = btn('Make a plan', { onClick: async () => {
        go.disabled = true; put(planOut, h('span', { class: 'sub' }, 'Reading about the place and writing a plan…'));
        try {
          const { jobId } = await api('m/life/plan', { body: { where: where.value, interests: likes.value } });
          const off = ui.on('job', async (j) => { if (j?.id !== jobId || ['running', 'waiting'].includes(j.status)) return; off(); go.disabled = false; if (j.status === 'done') { showPlan(await api('m/life/plans/' + j.output.planId)); paintPast(); } else put(planOut, h('p', { class: 'sub' }, 'No plan: ' + (j.error || j.status))); });
        } catch (e) { toast(e.message, 'err'); go.disabled = false; put(planOut, ); }
      } });
      el.append(h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Life')),
        h('div', { class: 'cols' },
          h('div', { class: 'stack' }, card(h('h3', null, 'Weather'), wx), card(h('h3', null, 'Exchange rates'), fx)),
          h('div', { class: 'stack' }, card(h('h3', null, 'Plan a day out'), h('div', { class: 'row' }, where, likes, go), h('p', { class: 'sub' }, 'The plan is written by a model from pages it reads; sources are listed under it.'), planOut), card(h('h3', null, 'Earlier plans'), past))));
      paintWeather(); paintRates(); paintPast();
    },
  },
};
