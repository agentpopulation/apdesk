// The Finder page: one box, results as passages with their source and read time, "Search my library only",
// the library's size, a "never keep" list and Clear. Web text is shown as text nodes only, never as markup.
const CSS = `
.view.finv{display:flex;flex-direction:column;min-height:0;height:100%;padding:0}
.finv .fin-top{padding:14px 18px 10px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:10px}
.finv form{display:flex;gap:8px;min-width:0}
.finv form input{flex:1 1 auto;min-width:0;font-size:15px;padding:8px 12px}
.finv .fin-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 28px;display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:16px;align-items:start}
.finv .fin-list{display:flex;flex-direction:column;gap:10px;min-width:0}
.finv .fin-q{margin:0;font-size:14.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.finv .fin-src{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:12.5px;color:var(--dim);min-width:0}
.finv .fin-src a{color:var(--accent);overflow-wrap:anywhere;word-break:break-all}
.finv .fin-side{display:flex;flex-direction:column;gap:12px;min-width:0}
.finv .fin-side h3{margin:0 0 6px;font-size:14px}
.finv .fin-side ul{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:13px}
.finv .fin-side li{display:flex;justify-content:space-between;gap:8px;align-items:center;overflow-wrap:anywhere}
.finv .fin-side form input{font-size:13px;padding:5px 8px}
.finv details summary{cursor:pointer;color:var(--dim);font-size:12.5px}
.finv details ul{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--dim);overflow-wrap:anywhere}
@media (max-width:860px){.finv .fin-body{grid-template-columns:minmax(0,1fr);padding:12px 16px 24px}.finv .fin-top{padding:12px 16px 10px}}
`;

const one = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const pages = {
  finder: {
    title: 'Finder',
    async render(el, ui) {
      const { h, api, card, btn, pill, toast, fmt, empty, sw, confirm } = ui;
      if (!document.getElementById('finv-css')) document.head.append(h('style', { id: 'finv-css' }, CSS));
      el.classList.add('finv');
      const offline = ui.state.settings?.online === false;
      let libraryOnly = offline;
      const box = h('input', { type: 'search', placeholder: 'Ask a question', 'aria-label': 'Question', autocomplete: 'off' });
      const go = btn('Find', { type: 'submit' });
      const form = h('form', { role: 'search', onsubmit: (e) => { e.preventDefault(); run(); } }, box, go);
      const onlyLib = sw(libraryOnly, 'Search my library only', (v) => {
        if (offline && !v) { toast('The desk is offline, so only your library can be searched.'); return false; }
        libraryOnly = v; toast(v ? 'Only your library will be searched.' : 'The web will be searched too, and the pages read kept.'); return true;
      }, { 'aria-label': null, 'aria-labelledby': 'fin-only' });
      const top = h('div', { class: 'fin-top' }, form, h('div', { class: 'row' }, onlyLib, h('span', { id: 'fin-only' }, 'Search my library only'), offline ? pill('Offline', 'wait') : null));
      const list = h('div', { class: 'fin-list', 'aria-live': 'polite' }, empty('Type a question. Answers come as passages quoted from the pages read, with where and when each was read.'));
      const side = h('aside', { class: 'fin-side', 'aria-label': 'Your library' });
      el.replaceChildren(top, h('div', { class: 'fin-body' }, list, side));
      box.focus();

      const link = (url) => (/^https?:\/\//i.test(url) ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url) : h('span', null, url));
      function passage(p) {
        return card(h('p', { class: 'fin-q' }, p.text), h('div', { class: 'fin-src' }, p.title ? h('b', null, p.title) : null, link(p.url), h('span', null, 'read ' + (p.readAt ? fmt.when(p.readAt) : 'not checked')), p.from === 'library' ? pill('from your library') : null));
      }
      async function run() {
        const q = box.value.trim(); if (!q) { box.focus(); return; }
        go.disabled = true; list.replaceChildren(empty(libraryOnly ? 'Searching your library…' : 'Asking the search providers and reading the best pages…'));
        try {
          const r = await api(`/api/m/finder/find?q=${encodeURIComponent(q)}${libraryOnly ? '&library=1' : ''}`);
          const notes = (r.notes || []).filter((n) => n !== r.nothing).map((n) => h('p', { class: 'sub' }, n));
          const asked = r.asked?.length ? h('details', null, h('summary', null, `Asked ${one(new Set(r.asked.map((a) => a.provider)).size, 'provider')} with ${one(new Set(r.asked.map((a) => a.query)).size, 'wording')}; read ${one(r.read.filter((x) => x.ok).length, 'page')}`),
            h('ul', null, r.asked.map((a) => h('li', null, `${a.provider}, “${a.query}”: ${a.ok ? a.n + ' results' : a.note}`)), r.read.map((x) => h('li', null, `${x.url}: ${x.ok ? (x.note || 'read') : x.note}`)))) : null;
          list.replaceChildren(...notes, ...(r.passages.length ? r.passages.map(passage) : [empty(nextStep(r))]), asked || '');
        } catch (e) { list.replaceChildren(empty(e.message)); }
        finally { go.disabled = false; loadSide(); }
      }
      // nothing answered: say so once, and what to do next
      function nextStep(r) {
        if (!r.libraryOnly) return 'No page read answered this. Try other words, or fewer of them.';
        if (offline || r.notes?.some((n) => /offline/i.test(n))) return 'Nothing in your library answers this yet. Pages are kept each time Finder reads the web, so search again once the desk is online.';
        return 'Nothing in your library answers this yet. Switch off "Search my library only" to search the web; the pages read are kept here for next time.';
      }
      async function loadSide() {
        let s; try { s = await api('/api/m/finder/library'); } catch (e) { side.replaceChildren(card(h('p', { class: 'sub' }, e.message))); return; }
        const site = h('input', { type: 'text', placeholder: 'example.com', 'aria-label': 'Site never to keep' });
        const add = h('form', { class: 'row', onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await api('/api/m/finder/library/never-keep', { body: { site: site.value } });
            const d = (r.neverKeep || []).find((x) => !s.neverKeep.includes(x)) || site.value.trim();
            toast(`Pages from ${d} will not be kept.` + (r.removed ? ` ${one(r.removed, 'page')} kept from it before ${r.removed === 1 ? 'was' : 'were'} removed.` : ''), 'ok'); loadSide();
          } catch (x) { toast(x.message, 'err'); }
        } }, site, btn('Add', { kind: 'ghost sm', type: 'submit' }));
        const unkeep = async (d) => { try { await api('/api/m/finder/library/never-keep/remove', { body: { site: d } }); toast(`Pages from ${d} can be kept again.`, 'ok'); loadSide(); } catch (x) { toast(x.message, 'err'); } };
        side.replaceChildren(
          card(h('h3', null, 'Your library'),
            h('p', { class: 'sub' }, `${one(s.pages, 'page')}, ${fmt.bytes(s.bytes)} of ${s.limitMb} MB. The oldest pages go first when it is full.`),
            s.oldest ? h('p', { class: 'sub' }, 'Oldest page read ' + fmt.when(s.oldest)) : null,
            h('div', { class: 'row', style: { marginTop: '8px' } }, btn('Clear library', { kind: 'ghost sm', disabled: !s.pages, onClick: async () => { if (!(await confirm('Remove every page from your library? This cannot be undone.', { ok: 'Clear', kind: 'stop' }))) return; try { await api('/api/m/finder/library/clear', { body: {} }); toast('Library cleared'); loadSide(); } catch (x) { toast(x.message, 'err'); } } }))),
          card(h('h3', null, 'Never keep'), h('p', { class: 'sub' }, 'Pages from these sites are read when needed but never kept.'),
            h('ul', null, s.neverKeep.length ? s.neverKeep.map((d) => h('li', null, h('span', null, d), btn('Remove', { kind: 'ghost sm', 'aria-label': 'Remove ' + d, onClick: () => unkeep(d) }))) : h('li', { class: 'sub' }, 'None yet')), add),
          card(h('div', { class: 'row' }, sw(s.modelWording, 'Let a model add one more wording', async (v) => {
            await api('/api/m/finder/settings', { body: { modelWording: v } });     // a failed save throws: the switch goes back and says why
            toast(v ? 'A model will add one wording to each search.' : 'Searches use the plain wordings only.', 'ok');
          }, { 'aria-label': null, 'aria-labelledby': 'fin-mw', 'aria-describedby': 'fin-mw-d' }),
          h('div', null, h('span', { id: 'fin-mw' }, 'Let a model add one more wording'), h('p', { class: 'sub', id: 'fin-mw-d' }, 'It uses your default model. Off unless you switch it on.')))),
        );
      }
      loadSide();
    },
  },
};
