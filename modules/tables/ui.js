// The Tables page: give a page address, pick the list and say what each column is, then keep it fresh.
// Page text is shown as text nodes only, never as markup.
const CSS = `
.view.tblv{display:flex;flex-direction:column;min-height:0;height:100%;padding:0}
.tblv .tbl-top{padding:14px 18px 10px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.tblv .tbl-top h2{margin:0;font-size:18px}
.tblv form.tbl-add{display:flex;gap:8px;min-width:0;flex-wrap:wrap}
.tblv form.tbl-add input{flex:1 1 220px;min-width:0;font-size:15px;padding:8px 12px}
.tblv .tbl-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 28px;display:flex;flex-direction:column;gap:12px}
.tblv h3{margin:0 0 6px;font-size:15px;overflow-wrap:anywhere}
.tblv .tbl-grid{width:100%;table-layout:fixed;border-collapse:collapse;font-size:12.5px;margin-top:8px}
.tblv .tbl-grid th,.tblv .tbl-grid td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
.tblv .tbl-grid th{color:var(--dim);font-weight:600}
.tblv .tbl-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-top:8px}
.tblv .tbl-cols label{display:flex;flex-direction:column;gap:3px;font-size:12.5px;color:var(--dim);min-width:0;overflow-wrap:anywhere}
.tblv .tbl-cols select{font-size:13px;padding:4px 6px;min-width:0;max-width:100%}
.tblv .tbl-src{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--dim);min-width:0}
.tblv .tbl-src a{color:var(--accent);overflow-wrap:anywhere;word-break:break-all}
.tblv .tbl-note{margin:8px 0 0;font-size:13.5px;overflow-wrap:anywhere}
.tblv .tbl-ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}
.tblv .tbl-ctl input[type=number]{width:64px;font-size:13px;padding:4px 6px}
.tblv details summary{cursor:pointer;color:var(--dim);font-size:12.5px;margin-top:8px}
.tblv details ul{margin:6px 0 0;padding-left:18px;font-size:12.5px;overflow-wrap:anywhere}
@media (max-width:860px){.tblv .tbl-body{padding:12px 16px 24px}.tblv .tbl-top{padding:12px 16px 10px}}
`;

const one = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const STATE = { ok: ['Up to date', 'ok'], new: ['Not read yet', ''], changed: ['Table changed', 'wait'], moved: ['List moved', 'stop'], gone: ['List gone', 'stop'], refused: ['Not read', 'stop'], failed: ['Could not read', 'stop'], waiting: ['Waits: offline', 'wait'] };

export const pages = {
  tables: {
    title: 'Tables',
    async render(el, ui) {
      const { h, api, card, btn, pill, toast, fmt, empty, sw, confirm } = ui;
      if (!document.getElementById('tblv-css')) document.head.append(h('style', { id: 'tblv-css' }, CSS));
      el.classList.add('tblv');
      let info = { sources: [], meanings: [], lawful: '', phoneApps: '', pageLimit: { min: 1, max: 20, default: 5 } };
      const box = h('input', { type: 'text', inputmode: 'url', spellcheck: 'false', placeholder: 'Page address, for example events.example/attendees', 'aria-label': 'Page address', autocomplete: 'off' });
      const go = btn('Find lists', { type: 'submit' });
      const lawful = h('p', { class: 'sub' }); const phone = h('p', { class: 'sub' });
      const top = h('div', { class: 'tbl-top' }, h('h2', null, 'Tables'), lawful,
        h('form', { class: 'tbl-add', onsubmit: (e) => { e.preventDefault(); find(); } }, box, go), phone);
      const found = h('div', { class: 'stack', 'aria-live': 'polite' });
      const list = h('div', { class: 'stack' });
      el.replaceChildren(top, h('div', { class: 'tbl-body' }, found, list));

      const link = (url) => (/^https?:\/\//i.test(url) ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url) : h('span', null, url));
      const grid = (heads, rows) => h('table', { class: 'tbl-grid' }, h('thead', null, h('tr', null, heads.map((x) => h('th', null, x)))), h('tbody', null, rows.map((r) => h('tr', null, heads.map((_, i) => h('td', null, r[i] || h('span', { class: 'sub' }, 'not checked')))))));
      const meaningSelect = (value, heading) => { const s = h('select', { 'aria-label': `What the column ${heading} is` }, info.meanings.map((m) => h('option', { value: m.id }, m.label))); s.value = value || 'other'; return s; };
      const colPicker = (columns) => { const sels = columns.map((c) => meaningSelect(c.guess, c.heading)); return { el: h('div', { class: 'tbl-cols' }, columns.map((c, i) => h('label', null, c.heading, sels[i]))), values: () => sels.map((s) => s.value) }; };
      const busy = (b, label) => { b.disabled = true; const t = b.textContent; b.textContent = label; return () => { b.disabled = false; b.textContent = t; }; };

      async function find() {
        const url = box.value.trim(); if (!url) { box.focus(); return; }
        const done = busy(go, 'Reading the page…'); found.replaceChildren(empty('Reading that one page…'));
        if (!info.sources.length) list.replaceChildren();          // the "No lists yet" line would contradict what is found
        try {
          const r = await api('/api/m/tables/preview', { body: { url } });
          if (!r.candidates.length) { found.replaceChildren(empty(r.note)); return; }
          found.replaceChildren(h('p', { class: 'sub' }, `${one(r.candidates.length, 'list')} found on ${r.url}. Pick one and say what each column is. The guesses come from the heading words.`), ...r.candidates.map((c, n) => candidate(r, c, n)));
        } catch (e) { found.replaceChildren(empty(ui.plainError(e))); }
        finally { done(); }
      }
      function candidate(r, c, n) {
        const pick = colPicker(c.columns);
        const pagesIn = h('input', { type: 'number', min: info.pageLimit.min, max: info.pageLimit.max, value: info.pageLimit.default, 'aria-label': 'Pages to read at most' });
        const save = btn('Save this list', { onClick: async () => {
          const done = busy(save, 'Saving…');
          try { await api('/api/m/tables/sources', { body: { token: r.token, index: c.index, columns: pick.values(), pageLimit: Number(pagesIn.value) } }); toast('The list is saved.', 'ok'); found.replaceChildren(); box.value = ''; load(); }
          catch (e) { toast(e.message, 'err'); } finally { done(); }
        } });
        return card(h('h3', null, `List ${n + 1}: ${c.kind === 'table' ? 'a table' : 'repeated blocks'}, ${one(c.rowCount, 'row')}`),
          grid(c.columns.map((x) => x.heading), c.sample), pick.el,
          h('div', { class: 'tbl-ctl' }, h('span', { class: 'sub' }, 'Pages to read at most'), pagesIn, save));
      }

      function lines(title, rows) { return rows.length ? h('details', null, h('summary', null, `${title}: ${rows.length}`), h('ul', null, rows.slice(0, 30).map((r) => h('li', null, (Array.isArray(r) ? r : r.after).filter(Boolean).join(' · '))))) : null; }
      function source(s) {
        const [label, kind] = STATE[s.state] || [s.state, ''];
        const rowsBox = h('div');
        const refresh = btn('Refresh now', { kind: 'ghost sm', onClick: async () => { const done = busy(refresh, 'Reading…'); try { const r = await api(`/api/m/tables/sources/${s.id}/refresh`, { body: {} }); toast(r.source.note || 'Done'); load(); } catch (e) { toast(e.message, 'err'); } finally { done(); } } });
        const pagesIn = h('input', { type: 'number', min: info.pageLimit.min, max: info.pageLimit.max, value: s.pageLimit, 'aria-label': 'Pages to read at most' });
        const setPages = btn('Save', { kind: 'ghost sm', onClick: async () => { try { await api(`/api/m/tables/sources/${s.id}/settings`, { body: { pageLimit: Number(pagesIn.value) } }); toast('Page limit saved.', 'ok'); load(); } catch (e) { toast(e.message, 'err'); } } });
        const daily = sw(s.schedule, 'Refresh once a day', async (v) => { await api(`/api/m/tables/sources/${s.id}/settings`, { body: { schedule: v } }); toast(v ? 'This list is read once a day.' : 'This list is read only when you press Refresh.', 'ok'); load(); });
        const showRows = btn('Show rows', { kind: 'ghost sm', onClick: async () => {
          if (rowsBox.firstChild) { rowsBox.replaceChildren(); return; }
          try {
            const r = await api(`/api/m/tables/sources/${s.id}/rows`); const heads = r.columns.map((c) => c.heading);
            rowsBox.replaceChildren(r.rows.length ? grid([...heads, 'Read on'], r.rows.map((row, n) => [...heads.map((_, i) => row[i] || ''), fmt.date(r.read?.[n])])) : empty('No rows kept yet.'));
          } catch (e) { toast(e.message, 'err'); }
        } });
        const gone = s.goneRows > 0 ? s.goneRows : 0;
        const stored = `${one(s.rows + gone, 'stored row')}${gone ? `: ${s.rows} on the list and ${gone} no longer on it` : ''}`;
        const remove = btn('Remove everything from this source', { kind: 'ghost sm', onClick: async () => {
          if (!(await confirm(`Remove this list and its ${stored}? Its marks in the CRM go too, with what it filled in. Companies and contacts that also came from somewhere else, or that are on a deal, stay.`, { ok: 'Remove', kind: 'stop' }))) return;
          try {
            const r = await api(`/api/m/tables/sources/${s.id}`, { method: 'DELETE' });
            const cos = `${r.crm.companies} ${r.crm.companies === 1 ? 'company' : 'companies'}`;
            toast(`Removed ${one(r.rows, 'row')}${r.gone ? ` (${r.rows - r.gone} on the list, ${r.gone} no longer on it)` : ''}. From the CRM: ${cos} and ${one(r.crm.contacts, 'contact')} that came only from this list.`, 'ok'); load();
          } catch (e) { toast(e.message, 'err'); }
        } });
        let fix = null;
        if (s.state === 'changed' && s.pending) {
          const pick = colPicker(s.pending.columns);
          const use = btn('Use these columns', { onClick: async () => { const done = busy(use, 'Reading…'); try { await api(`/api/m/tables/sources/${s.id}/columns`, { body: { columns: pick.values() } }); toast('Columns saved and the list read again.', 'ok'); load(); } catch (e) { toast(e.message, 'err'); } finally { done(); } } });
          fix = h('div', null, grid(s.pending.columns.map((c) => c.heading), s.pending.sample), pick.el, h('div', { class: 'tbl-ctl' }, use));
        } else if (s.state === 'moved' && s.movedTo) {
          const use = btn('Use the new address', { onClick: async () => { const done = busy(use, 'Reading…'); try { await api(`/api/m/tables/sources/${s.id}/address`, { body: {} }); toast('The new address is used from now on.', 'ok'); load(); } catch (e) { toast(e.message, 'err'); } finally { done(); } } });
          fix = h('div', { class: 'tbl-ctl' }, link(s.movedTo), use);
        }
        const run = s.lastRun && s.lastRun.state === 'ok' ? [lines('New on the list', s.lastRun.added), lines('Changed', s.lastRun.changed), lines('No longer on the list', s.lastRun.gone)] : [];
        return card(h('h3', null, s.title),
          h('div', { class: 'tbl-src' }, pill(label, kind), link(s.url), h('span', null, s.lastOk ? 'read on ' + fmt.date(s.lastOk) : 'not read yet')),
          h('div', { class: 'tbl-src' }, h('span', null, `${one(s.rows, 'row')} on the list`), gone ? h('span', null, `${gone} no longer on it, still stored`) : null, h('span', null, 'Last read ' + (s.lastRead ? fmt.when(s.lastRead) : 'not yet')), s.schedule && s.nextAt ? h('span', null, 'Next read ' + fmt.when(s.nextAt)) : null),
          s.note ? h('p', { class: 'tbl-note' }, s.note) : null, fix, ...run,
          h('div', { class: 'tbl-ctl' }, refresh, showRows, h('span', { class: 'row' }, daily, h('span', { class: 'sub' }, 'Refresh once a day')), h('span', { class: 'row' }, h('span', { class: 'sub' }, 'Pages at most'), pagesIn, setPages), remove),
          rowsBox);
      }
      async function load() {
        try { info = await api('/api/m/tables/sources'); } catch (e) { list.replaceChildren(empty(ui.plainError(e))); return; }
        lawful.replaceChildren(info.lawful); phone.replaceChildren(info.phoneApps);
        list.replaceChildren(...(info.sources.length ? info.sources.map(source) : found.firstChild ? [] : [empty('No lists yet. Give the address of a public page with a list on it: the desk reads that one page and shows the lists it finds.')]));
      }
      await load();
    },
  },
};
