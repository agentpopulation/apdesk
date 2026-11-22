// Settings › Page reading: optional reading services for pages the desk's own read found empty.
const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
export const settings = {
  reading: { title: 'Page reading', async render(el, ui) {
    const { h, api, card, btn, sw, toast, empty } = ui;
    const line = (...a) => { const l = ui.line(...a); l.style.flexWrap = 'wrap'; l.firstChild.style.minWidth = '240px'; return l; };
    const box = h('div'), capBox = h('div'), tryBox = h('div');
    const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok, 'ok'); await paint(); return r; } catch (e) { toast(e.message, 'err'); } };
    const pw = (ph) => h('input', { type: 'password', placeholder: ph, autocomplete: 'new-password', style: { width: '220px' } });
    let notice = h('p', { class: 'sub' });

    const row = (s) => {
      const key = pw(s.hasKey ? 'Replace the key' : 'Paste the key');
      const saveKey = s.keyFrom === 'here'
        ? () => api('m/search/readers', { body: { id: s.id, key: key.value, on: true } })
        : () => api('keys/services/' + s.id, { body: { value: key.value } }).then(() => api('m/search/readers', { body: { id: s.id, on: true } }));
      const state = s.on ? 'On' : s.switchedOn ? 'On, but it needs a key or its keyless tier' : 'Off';
      const desc = [state, s.hasKey ? (s.keyFrom === 'here' ? 'Key added' : 'Uses the Jina key in Keys and logins') : 'No key yet', `${plural(s.usedToday, 'page')} read through it today`, s.robots, s.keylessLine].filter(Boolean).join(' · ');
      return line(s.label, desc,
        h('span', { class: 'sub' }, 'Use'), sw(s.switchedOn, `Use ${s.label}`, (on) => act(() => api('m/search/readers', { body: { id: s.id, on } }))),
        s.keylessLine ? h('span', { class: 'sub' }, 'Without a key') : null, s.keylessLine ? sw(s.keyless, `${s.label} without a key`, (on) => act(() => api('m/search/readers', { body: { id: s.id, keyless: on } }))) : null,
        key, btn('Save', { kind: 'ghost sm', onClick: () => act(saveKey, `${s.label} key saved`) }),
        s.hasKey && s.keyFrom === 'here' ? btn('Remove', { kind: 'ghost sm', onClick: () => act(() => api('m/search/readers', { body: { id: s.id, removeKey: true } }), 'Key removed') }) : null,
        btn('Test', { kind: 'ghost sm', onClick: async () => { try { const r = await api('m/search/readers/test', { body: { id: s.id } }); toast(r.ok ? r.note : r.error, r.ok ? 'ok' : 'err'); await paint(); } catch (e) { toast(e.message, 'err'); } } }),
        h('a', { href: s.signup, target: '_blank', rel: 'noopener noreferrer', class: 'sub' }, 'Get a key'));
    };

    const paint = async () => {
      let d; try { d = await api('m/search/readers'); } catch (e) { box.replaceChildren(empty(e.message)); return; }
      notice.textContent = d.notice;
      box.replaceChildren(...d.services.map(row));
      const cap = h('input', { type: 'number', min: 1, max: 1000, value: d.cap, style: { width: '90px' } });
      capBox.replaceChildren(line('Daily cap', 'Pages each service may read in one day. The count starts again at midnight in your time zone.', cap,
        btn('Save', { kind: 'ghost sm', onClick: () => act(() => api('m/search/readers/cap', { body: { cap: Number(cap.value) } }), 'Cap saved') })));
    };

    // Try a page: read it the desk's own way; when that comes back empty, offer "Read with <service>".
    const addr = h('input', { type: 'url', placeholder: 'https://', autocomplete: 'off', style: { width: '280px' } });
    const out = h('div', { class: 'sub' });
    const show = (r) => { out.replaceChildren(r.error ? r.error : `Read "${r.title}"${r.through ? '' : ' the desk\'s own way'}. ${plural(r.text.length, 'character')}.`); };
    const readIt = async (withId) => {
      out.textContent = 'Reading…';
      let r; try { r = await api('m/search/read?url=' + encodeURIComponent(addr.value.trim()) + (withId ? '&with=' + encodeURIComponent(withId) : '')); } catch (e) { r = e.data?.error ? e.data : { error: e.message }; }
      show(r);
      for (const s of r.readWith || []) out.append(' ', btn(`Read with ${s.label}`, { kind: 'ghost sm', onClick: () => readIt(s.id) }));
      if (withId) await paint();
    };
    tryBox.replaceChildren(line('Address', 'Read the desk\'s own way first. If it comes back empty, a button offers each service that is on.', addr, btn('Read', { kind: 'ghost sm', onClick: () => readIt(null) })), out);

    el.append(card(h('h3', null, 'Reading services'), notice, box, capBox), card(h('h3', null, 'Try a page'), tryBox));
    await paint();
    ui.on('models', paint);
  } },
};
