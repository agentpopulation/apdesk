// The CRM tabs of the Sales page: Contacts, Companies, Deals. Owner-only data; nothing here sends anything.
export const CRM_STYLE = `
.salesv .crm-pane{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px}
.salesv [hidden]{display:none!important}
.salesv .crm-pane .s-list{flex:1;min-height:0;overflow:auto}
.salesv .lawful{margin:0;font-size:12.5px;color:var(--dim)}
.salesv .dboard{flex:1;min-height:0;display:grid;grid-template-columns:repeat(6,minmax(170px,1fr));grid-template-rows:minmax(0,1fr);gap:10px;overflow-x:auto;padding-bottom:4px}
.salesv .dboard .lane{min-height:0;overflow:hidden}
.salesv .dboard .cards{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;flex:1;padding:1px}
.salesv .dboard .lane.over{border-color:var(--accent);background:var(--accent-soft)}
.salesv .deal{cursor:grab;color:inherit;font:inherit;text-align:left}
.salesv .deal:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.salesv .srcl a,.salesv .srcl span{overflow-wrap:anywhere}
.salesv .due{color:var(--stop,#c0392b)}
.salesv .crm-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.salesv .crm-tools input[type=search]{flex:1 1 220px;min-width:0}
.salesv .crm-count{font-size:12.5px;color:var(--dim)}
.salesv th .sortb{all:unset;cursor:pointer;font:inherit;color:inherit}
.salesv th .sortb:focus-visible{outline:2px solid var(--accent)}
.salesv .more-row td{text-align:center;color:var(--dim);font-size:12.5px}
#modal input[type=tel]{background:var(--well);border:1px solid var(--line-strong);border-radius:var(--r-s);padding:6px 10px;max-width:100%;font:inherit;color:inherit}
#modal .pick{position:relative}
#modal .pick .opts{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:8px;margin-top:4px;max-height:220px;overflow:auto;background:var(--card,var(--bg))}
#modal .pick .opts button{all:unset;cursor:pointer;padding:6px 10px;font-size:13.5px;overflow-wrap:anywhere}
#modal .pick .opts button:hover,#modal .pick .opts button:focus-visible{background:var(--accent-soft)}
#modal .same{border:1px solid var(--accent);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
#modal .same label{display:flex;gap:6px;align-items:flex-start;font-size:13.5px}
#modal .imp-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
#modal .imp-cols label{display:flex;flex-direction:column;gap:3px;font-size:12.5px;min-width:0}
#modal .imp-cols .ex{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#modal .imp-table table{table-layout:fixed;width:100%}
#modal .imp-table td{overflow-wrap:anywhere;vertical-align:top}
#modal .rec h6{margin:6px 0 4px}
#modal .rec .item{font-size:13.5px;padding:3px 0;border-bottom:1px dashed var(--line);overflow-wrap:anywhere}
@media (max-width:600px){.crm-stk table,.crm-stk tbody,.crm-stk tr,.crm-stk td{display:block;width:100%}.crm-stk thead{display:none}
.crm-stk tr{padding:6px 0;border-bottom:1px solid var(--line)}.crm-stk td{display:flex;gap:10px;border:0;padding:3px 4px}.crm-stk td:has(> .v:empty){display:none}
.crm-stk td::before{content:attr(data-label);flex:0 0 92px;color:var(--dim);font-size:12px;padding-top:1px}.crm-stk td > .v{flex:1;min-width:0;overflow-wrap:anywhere}}
@media (max-width:600px){.salesv .dboard{display:flex;flex-direction:column;overflow:visible;flex:none}.salesv .dboard .lane{overflow:visible}.salesv .dboard .cards{overflow:visible}.salesv .crm-pane{overflow:visible}}
`;

const PAGE = 100;   // rows drawn at a time; more are drawn as the owner scrolls to them
const IMPORT_ROWS = 5000;   // the most rows one import takes (the desk refuses more, with both numbers)
const digits = (s) => String(s || '').replace(/\D/g, '');
/** Children for replaceChildren: a left-out part (null, false) is dropped, never printed as the word "null". */
const kids = (...k) => k.flat().filter(x => x != null && x !== false);
/** Digits after the point the currency has (yen 0, rupee 2); 2 when not known. */
const fractionDigits = (cur) => { try { return cur ? new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits : 2; } catch { return 2; } };
const base64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

export function mountCrm(pane, ui) {
  const { h, btn, pill, fmt, api, toast } = ui;
  const st = { tab: 'contacts', data: null, coFilter: 0, dealMode: 0, q: { contacts: '', companies: '' }, sort: { contacts: 'name', companies: 'name' }, focusDeal: null };
  const isUrl = (s) => /^https?:\/\//i.test(s || '');
  const NC = 'not checked'; const NS = 'not set';
  const dim = (t) => h('span', { class: 'sub' }, t);
  /** An empty field: "not checked" when a source should have said it and did not, else nothing (the owner left it empty). */
  const val = (v, rec, label) => v || (rec?.notChecked?.includes(label) ? dim(NC) : '');
  const loc = () => ui.state?.settings?.locale || undefined;
  // a deal's date is a calendar day in the owner's zone, stored as year-month-day: shown as that day, never shifted
  const day = (d) => { if (!d) return ''; try { return new Date(d + 'T00:00:00Z').toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
  // a currency with no smaller unit (yen) shows whole units only, never a part of one
  const cash = (minor, cur) => { let d = 2; try { if (cur) d = new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch {} return fmt.money(d === 0 ? Math.round(Number(minor) / 100) * 100 : minor, cur); };
  const money = (minor, cur) => (minor == null ? NS : cash(minor, cur));
  const coName = (id) => st.data.coById.get(id)?.name || '';
  const fromText = (s) => isUrl(s.from) ? h('a', { href: s.from, target: '_blank', rel: 'noopener noreferrer', title: s.from, onclick: (e) => e.stopPropagation() }, s.from.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)) : h('span', null, s.from);
  const firstFrom = (r) => r.sources[0] ? h('span', { class: 'srcl' }, fromText(r.sources[0]), r.sources.length > 1 ? dim(` and ${r.sources.length - 1} more`) : '', r.sources.some(s => s.goneAt) ? dim(' · no longer on a list') : '') : '';
  const field = (label, value = '', type = 'text', attrs = {}) => { const i = h('input', { type, value: value ?? '', style: { width: '100%' }, ...attrs }); return [h('label', { class: 'f' }, label, i), i]; };
  const plural = (n, one, many) => ui.plural ? ui.plural(n, one, many) : `${n} ${n === 1 ? one : many || one + 's'}`;
  /** A refusal goes beside its field when the desk names one; else a plain line at the bottom. */
  const refuse = (e, inputs) => { const f = e?.data?.field; const i = f && inputs[f]; if (i) ui.needs(i, e.message); else toast(e.message, 'err'); return false; };

  async function load() {
    const d = await api('m/sales/crm');
    d.coById = new Map(d.companies.map(c => [c.id, c])); d.ctById = new Map(d.contacts.map(c => [c.id, c]));
    st.data = d; paint();
  }
  function show(tab) { st.tab = tab; if (!st.data) load().catch(e => toast(e.message, 'err')); else paint(); }
  function paint() {
    if (!st.data) { pane.replaceChildren(ui.spinner()); return; }
    if (st.tab === 'contacts') paintContacts(); else if (st.tab === 'companies') paintCompanies(); else paintDeals();
    // a deal card moved by the keyboard gets the focus back after a repaint, unless the owner has moved on to something else
    if (st.tab === 'deals' && st.focusDeal) {
      const c = pane.querySelector(`[data-deal="${st.focusDeal}"]`); const a = document.activeElement;
      if (c && (!a || a === document.body || !a.isConnected || a.matches?.('[data-deal]'))) c.focus(); else if (!c) st.focusDeal = null;
    }
  }

  // ---------------- a long list: search, sort by any column, and only the rows in view are drawn (more as you scroll)
  function bigList({ cols, rows, sorts, sortKey, onSort, onRow, empty }) {
    if (!rows.length) return ui.empty(empty);
    const body = h('tbody'); let shown = 0;
    const more = h('tr', { class: 'more-row' }, h('td', { colspan: String(cols.length) }, ''));
    const draw = () => {
      const next = rows.slice(shown, shown + PAGE); shown += next.length;
      more.before(...next.map(r => h('tr', { class: 'pick', tabindex: '0', onclick: () => onRow(r), onkeydown: (e) => { if (e.key === 'Enter') onRow(r); } },
        cols.map(c => h('td', { 'data-label': c.label }, h('span', { class: 'v' }, c.render(r)))))));
      more.firstChild.textContent = shown < rows.length ? `Showing ${shown} of ${rows.length}. Scroll for more.` : '';
      if (shown >= rows.length) more.hidden = true;
    };
    body.append(more); draw();
    const head = h('tr', null, cols.map(c => h('th', { 'aria-sort': c.sort && c.sort === sortKey ? 'ascending' : 'none' }, c.sort ? h('button', { class: 'sortb', type: 'button', title: `Sort by ${c.label.toLowerCase()}`, onclick: () => onSort(c.sort) }, c.label + (c.sort === sortKey ? ' ▾' : '')) : c.label)));
    const wrap = h('div', { class: 'scroll crm-stk' }, h('table', null, h('thead', null, head), body));
    if (typeof IntersectionObserver === 'function') { const io = new IntersectionObserver((es) => { if (es.some(x => x.isIntersecting) && shown < rows.length) draw(); }); io.observe(more); }
    return wrap;
  }
  function toolbar(kind, sorts, count) {
    const q = h('input', { type: 'search', placeholder: kind === 'contacts' ? 'Search name, company, mail or phone' : 'Search name, site or city', value: st.q[kind], 'aria-label': `Search ${kind}` });
    let t = null; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.q[kind] = q.value; paint(); const n = pane.querySelector('input[type=search]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }, 150); });
    const sel = h('select', { 'aria-label': 'Sort by', onchange: () => { st.sort[kind] = sel.value; paint(); } }, sorts.map(([id, label]) => h('option', { value: id, selected: id === st.sort[kind] }, `Sort: ${label}`)));
    return h('div', { class: 'crm-tools' }, q, sel, h('span', { class: 'crm-count' }, count));
  }
  const by = (key) => (a, b) => (key(a) === key(b) ? 0 : !key(a) ? 1 : !key(b) ? -1 : String(key(a)).localeCompare(String(key(b)), loc(), { sensitivity: 'base', numeric: true }));
  const newest = (a, b) => String(b.created || '').localeCompare(String(a.created || ''));

  // ---------------- CSV out: the file comes from the desk as text and is saved by the browser
  async function exportCsv(what) {
    try { const r = await api(`m/sales/crm/export/${what}`); const a = h('a', { href: URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' })), download: r.fileName }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast(`${r.fileName} saved to your downloads`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ---------------- a company (or contact) chooser: a search box with the few closest names, never a list of thousands
  function chooser(items, selectedId, { label, none, name = (x) => x.name, extra = () => '' }) {
    let value = selectedId || '';
    const cur = items.find(x => x.id === value);
    const input = h('input', { type: 'search', value: cur ? name(cur) : '', placeholder: `Type to find ${label.toLowerCase()}`, autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-label': label });
    const opts = h('div', { class: 'opts', role: 'listbox', hidden: true });
    const pickOne = (x) => { value = x ? x.id : ''; input.value = x ? name(x) : ''; opts.hidden = true; input.setAttribute('aria-expanded', 'false'); el.dispatchEvent(new Event('change')); };
    const list = () => {
      const q = input.value.trim().toLowerCase(); const qd = digits(q);
      const hits = (q ? items.filter(x => name(x).toLowerCase().includes(q) || (qd.length > 3 && digits(extra(x)).includes(qd)) || extra(x).toLowerCase().includes(q)) : items).slice(0, 8);
      opts.replaceChildren(h('button', { type: 'button', role: 'option', onclick: () => pickOne(null) }, none), ...hits.map(x => h('button', { type: 'button', role: 'option', onclick: () => pickOne(x) }, name(x) + (extra(x) ? ` · ${extra(x)}` : ''))),
        ...(q && !hits.length ? [h('span', { class: 'sub', style: { padding: '6px 10px' } }, `Nothing called "${input.value.trim()}". Add it first, or pick ${none.toLowerCase()}.`)] : []));
      opts.hidden = false; input.setAttribute('aria-expanded', 'true');
    };
    input.addEventListener('input', () => { value = ''; list(); });
    input.addEventListener('focus', list);
    input.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); opts.querySelector('button')?.focus(); } if (e.key === 'Escape' && !opts.hidden) { e.stopPropagation(); opts.hidden = true; } });
    const el = h('label', { class: 'f pick' }, label, input, opts);
    // a name typed but not picked is not kept quietly: the one exact match is taken, else nothing and the box says so
    Object.defineProperty(el, 'value', { get() { if (!value && input.value.trim()) { const ex = items.find(x => name(x).toLowerCase() === input.value.trim().toLowerCase()); if (ex) value = ex.id; } return value; } });
    el.input = input; el.typedUnknown = () => !!input.value.trim() && !el.value;
    return el;
  }
  const companyChooser = (id) => chooser(st.data.companies, id, { label: 'Company', none: 'No company', extra: (x) => x.city || x.host || '' });

  // ---------------- the "same?" step: both records, the owner picks each differing value
  function sameBox(e, { kind, body, onDone, close }) {
    const d = e.data; const picks = {};
    const rows = (d.differs || []).map(x => {
      const name = `pick-${x.field}`; picks[x.field] = 'theirs';
      return h('div', null, h('b', null, x.label),
        h('label', null, h('input', { type: 'radio', name, checked: true, onchange: () => { picks[x.field] = 'theirs'; } }), `Keep: ${x.theirs}`),
        h('label', null, h('input', { type: 'radio', name, onchange: () => { picks[x.field] = 'mine'; } }), `Use what you typed: ${x.mine}`));
    });
    const path = kind === 'contact' ? 'contacts' : 'companies';
    const go = async (extra) => {
      try { const r = await api(`m/sales/crm/${path}`, { body: { ...body, ...extra } }); toast(extra.merge ? `Saved as one: ${(r.contact || r.company).name || (r.contact || r.company).email}` : 'Added', 'ok'); close(); await onDone(); }
      catch (x) { toast(x.message, 'err'); }
    };
    return h('div', { class: 'same', role: 'alert' }, h('b', null, e.message), rows.length ? h('span', { class: 'sub' }, 'Pick what to keep. Nothing you typed is lost: notes are kept from both.') : null, ...rows,
      h('div', { class: 'row' }, btn('Save as one', { kind: 'sm', onClick: () => go({ merge: d.same.id, pick: picks }) }),
        d.canSeparate ? btn(kind === 'contact' ? 'No, a different person' : 'No, a different company', { kind: 'ghost sm', onClick: () => go({ separate: true }) }) : h('span', { class: 'sub' }, kind === 'contact' ? 'Two contacts cannot share one mail address.' : 'Two companies cannot share one site.')));
  }

  // ---------------- a record's own page inside its dialog: deals, notes and where it came from
  function recordPage(kind, rec) {
    const box = h('div', { class: 'rec stack', style: { gap: '4px' } }, ui.spinner());
    api(`m/sales/crm/${kind === 'company' ? 'companies' : 'contacts'}/${rec.id}/page`).then((p) => {
      const note = h('textarea', { rows: 2, placeholder: 'Add a dated note', 'aria-label': 'New note' });
      const addNote = btn('Add note', { kind: 'ghost sm', onClick: async () => {
        if (!note.value.trim()) return ui.needs(note, 'Write the note first.');
        try { await api('m/sales/crm/notes', { body: { kind, id: rec.id, text: note.value } }); toast('Note added', 'ok'); box.replaceWith(recordPage(kind, rec)); } catch (e) { toast(e.message, 'err'); }
      } });
      box.replaceChildren(
        ...(kind === 'company' ? [h('h6', null, `Contacts (${p.contacts.length})`), ...(p.contacts.length ? p.contacts.slice(0, 50).map(x => h('div', { class: 'item' }, `${x.name || x.email}${x.role ? ' · ' + x.role : ''}${x.email && x.name ? ' · ' + x.email : ''}${x.phone ? ' · ' + x.phone : ''}`)) : [h('div', { class: 'sub' }, 'None yet.')]),
          p.contacts.length > 50 ? h('div', { class: 'sub' }, `and ${p.contacts.length - 50} more: search the Contacts tab.`) : ''] : []),
        h('h6', null, `Deals (${p.deals.length})`), ...(p.deals.length ? p.deals.map(d => h('div', { class: 'item' }, `${d.title} · ${d.stageLabel} · ${money(d.value, d.currency)}${d.closeDate ? ' · closes ' + day(d.closeDate) : ''}`)) : [h('div', { class: 'sub' }, 'No deals yet.')]),
        h('h6', null, 'Notes'), note, h('div', { class: 'row' }, addNote),
        ...p.notes.map(n => h('div', { class: 'item' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, n.text), dim(`${fmt.when(n.at)} · ${n.source === 'typed by you' ? 'by you' : n.source}`))),
        h('h6', null, 'Where it came from'), ...p.history.map(x => h('div', { class: 'item srcl' }, isUrl(x.from) && !/^No longer/.test(x.what) ? h('span', null, 'From ', fromText({ from: x.from })) : x.what, dim(` · ${fmt.when(x.at)}`))));
    }).catch((e) => box.replaceChildren(dim(ui.plainError(e))));
    return box;
  }

  // ---------------- Contacts
  function paintContacts() {
    const { contacts } = st.data; const q = st.q.contacts.trim().toLowerCase(); const qd = digits(q);
    let rows = !q ? contacts : contacts.filter(c => [c.name, c.email, c.role, c.city, coName(c.companyId)].some(x => String(x || '').toLowerCase().includes(q)) || (qd.length >= 4 && digits(c.phone).includes(qd)));
    const key = st.sort.contacts;
    rows = [...rows].sort(key === 'added' ? newest : by(key === 'company' ? (c) => coName(c.companyId) : key === 'source' ? (c) => c.sources[0]?.from || '' : (c) => c[key] || ''));
    const sorts = [['name', 'name'], ['company', 'company'], ['email', 'mail address'], ['phone', 'phone'], ['added', 'newest first'], ['source', 'where it came from']];
    pane.replaceChildren(...kids(
      h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Contacts'), h('span', { class: 'grow' }), btn('Export CSV', { kind: 'ghost sm', onClick: () => exportCsv('contacts') }), btn('Add contact', { kind: 'sm', onClick: () => contactDialog() })),
      h('p', { class: 'lawful' }, st.data.lawful),
      contacts.length ? toolbar('contacts', sorts, q ? `${rows.length} of ${contacts.length}` : plural(contacts.length, 'contact')) : null,
      h('div', { class: 'card s-list', style: { padding: '4px 8px' } }, bigList({ rows, sortKey: key, onSort: (k) => { st.sort.contacts = k; paint(); }, onRow: (c) => contactDialog(c),
        empty: q ? `No contact matches "${st.q.contacts.trim()}".` : 'No contacts yet. Add one, import customers in Companies, or press Add to CRM on a lead.',
        cols: [
          { label: 'Name', sort: 'name', render: (c) => h('b', null, c.name || c.email) }, { label: 'Mail address', sort: 'email', render: (c) => val(c.email, c, 'Mail address') },
          { label: 'Phone', sort: 'phone', render: (c) => c.phone }, { label: 'Company', sort: 'company', render: (c) => coName(c.companyId) },
          { label: 'Role', render: (c) => val(c.role, c, 'Role') }, { label: 'From', sort: 'source', render: firstFrom },
        ] }))));
  }
  function contactDialog(c = null, { companyId } = {}) {
    const [fn, n] = field('Name', c?.name); const [fe, e] = field('Mail address', c?.email, 'email'); const [fp, p] = field('Phone', c?.phone, 'tel');
    const [fr, r] = field('Role', c?.role); const [fc, city] = field('City', c?.city);
    const co = companyChooser(c?.companyId || companyId);
    const notes = h('textarea', { rows: 3 }, c?.notes || '');
    const inputs = { name: n, email: e, phone: p, role: r, city, notes, companyId: co.input };
    const sameSlot = h('div');
    const deals = c ? st.data.deals.filter(d => d.contactId === c.id) : [];
    const box = h('div', { class: 'stack' }, fn, fe, fp, fr, co, fc, h('label', { class: 'f' }, 'Notes', notes), sameSlot,
      c && c.notChecked.length ? h('div', { class: 'sub' }, `Not checked: ${c.notChecked.join(', ')}`) : null,
      c ? recordPage('contact', c) : h('div', { class: 'sub' }, 'Saved as typed by you. If it looks like a contact you already have, you are asked first.'));
    const m = ui.modal({ title: c ? (c.name || c.email) : 'Add contact', wide: true, body: box, actions: [
      ...(c ? [{ label: 'Remove', kind: 'ghost', onClick: async () => {
        const on = deals.length ? ` ${c.name || c.email} is on ${plural(deals.length, 'deal')} (${deals.map(d => d.title).join(', ')}). The deal${deals.length === 1 ? ' stays' : 's stay'}, without a contact.` : '';
        if (!(await ui.confirm(`Remove ${c.name || c.email}?${on}`, { ok: 'Remove', kind: 'stop' }))) return false;
        try { await api(`m/sales/crm/contacts/${c.id}`, { method: 'DELETE' }); toast(`Removed ${c.name || c.email}`, 'ok'); await load(); } catch (x) { toast(x.message, 'err'); return false; } } }] : []),
      { label: 'Cancel' },
      { label: c ? 'Save' : 'Add', kind: '', onClick: async () => {
        if (co.typedUnknown()) return ui.needs(co.input, 'Pick a company from the list, or clear the box. Add a new company in the Companies tab.');
        const body = { name: n.value.trim(), email: e.value.trim(), phone: p.value.trim(), role: r.value.trim(), city: city.value.trim(), notes: notes.value, companyId: co.value || null };
        if (!body.name && !body.email) return ui.needs(n, 'Type a name or a mail address.');
        try {
          const x = c ? await api(`m/sales/crm/contacts/${c.id}`, { method: 'PATCH', body }) : await api('m/sales/crm/contacts', { body });
          toast(c ? (x.contact.samePhone ? `Saved. ${x.contact.samePhone} has the same phone number.` : 'Saved') : x.contact.merged ? `Saved into ${x.contact.name || x.contact.email}, which you already had` : 'Added', 'ok');
          await load();
        } catch (x) {
          if (x.status === 409 && x.data?.same) { sameSlot.replaceChildren(sameBox(x, { kind: 'contact', body, close: () => m.close(), onDone: load })); sameSlot.scrollIntoView?.({ block: 'nearest' }); return false; }
          return refuse(x, inputs);
        }
      } }] });
  }

  // ---------------- Companies and customers
  function paintCompanies() {
    const all = st.data.companies; const base = st.coFilter ? all.filter(c => c.customer) : all;
    const nOf = new Map(); for (const c of st.data.contacts) if (c.companyId) nOf.set(c.companyId, (nOf.get(c.companyId) || 0) + 1);
    const q = st.q.companies.trim().toLowerCase();
    let rows = !q ? base : base.filter(c => [c.name, c.host, c.city, c.phone].some(x => String(x || '').toLowerCase().includes(q)));
    const key = st.sort.companies;
    rows = [...rows].sort(key === 'added' ? newest : by(key === 'source' ? (c) => c.sources[0]?.from || '' : key === 'site' ? (c) => c.host : (c) => c[key] || ''));
    const imports = st.data.imports || [];
    pane.replaceChildren(...kids(
      h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Companies'), ui.seg(['All', `Customers (${all.filter(c => c.customer).length})`], st.coFilter, (o, i) => { st.coFilter = i; paint(); }), h('span', { class: 'grow' }),
        btn('Import customers', { kind: 'ghost sm', title: 'A CSV or .xlsx file. You match the columns and see every row before anything is saved.', onClick: importDialog }),
        imports.length ? btn(`Imports (${imports.length})`, { kind: 'ghost sm', onClick: importsDialog }) : null,
        btn('Export CSV', { kind: 'ghost sm', onClick: () => exportCsv('companies') }), btn('Add company', { kind: 'sm', onClick: () => companyDialog() })),
      all.length ? toolbar('companies', [['name', 'name'], ['site', 'site'], ['city', 'city'], ['added', 'newest first'], ['source', 'where it came from']], q ? `${rows.length} of ${base.length}` : plural(base.length, 'company', 'companies')) : null,
      h('div', { class: 'card s-list', style: { padding: '4px 8px' } }, bigList({ rows, sortKey: key, onSort: (k) => { st.sort.companies = k; paint(); }, onRow: (c) => companyDialog(c),
        empty: q ? `No company matches "${st.q.companies.trim()}".` : st.coFilter ? 'No customers yet. Mark a company as a customer, or import a CSV.' : 'No companies yet. Add one, import customers, or press Add to CRM on a lead.',
        cols: [
          { label: 'Name', sort: 'name', render: (c) => h('b', null, c.name) }, { label: 'Site', sort: 'site', render: (c) => c.site ? h('a', { href: /^https?:/i.test(c.site) ? c.site : 'https://' + c.host, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, c.host) : val('', c, 'Site') },
          { label: 'City', sort: 'city', render: (c) => c.city }, { label: 'Customer', render: (c) => c.customer ? pill('Customer', 'ok') : '' },
          { label: 'Contacts', render: (c) => String(nOf.get(c.id) || 0) }, { label: 'From', sort: 'source', render: firstFrom },
        ] }))));
  }
  function companyDialog(c = null) {
    const [fn, n] = field('Name', c?.name); const [fs, s] = field('Site', c?.site, 'text', { placeholder: 'company.com' });
    const [fp, p] = field('Phone', c?.phone, 'tel'); const [fc, city] = field('City', c?.city);
    const notes = h('textarea', { rows: 3 }, c?.notes || '');
    let customer = !!c?.customer;
    const inputs = { name: n, company: n, site: s, phone: p, city, notes };
    const sameSlot = h('div');
    const box = h('div', { class: 'stack' }, fn, fs, fp, fc, h('label', { class: 'f' }, 'Notes', notes),
      h('div', { class: 'row' }, ui.sw(customer, 'Customer', (v) => { customer = v; }), h('span', null, 'Customer')), sameSlot,
      c && c.notChecked.length ? h('div', { class: 'sub' }, `Not checked: ${c.notChecked.join(', ')}`) : null,
      c ? recordPage('company', c) : h('div', { class: 'sub' }, 'Saved as typed by you. If it looks like a company you already have, you are asked first.'));
    const m = ui.modal({ title: c ? c.name : 'Add company', wide: true, body: box, actions: [
      ...(c ? [{ label: 'Remove', kind: 'ghost', onClick: async () => { if (!(await ui.confirm(`Remove ${c.name}? Its contacts and deals stay, without a company.`, { ok: 'Remove', kind: 'stop' }))) return false; try { await api(`m/sales/crm/companies/${c.id}`, { method: 'DELETE' }); toast(`Removed ${c.name}`, 'ok'); await load(); } catch (x) { toast(x.message, 'err'); return false; } } },
        { label: 'Add contact', kind: 'ghost', onClick: () => { setTimeout(() => contactDialog(null, { companyId: c.id }), 0); } },
        { label: 'New deal', kind: 'ghost', onClick: () => { setTimeout(() => dealDialog(null, { companyId: c.id }), 0); } }] : []),
      { label: 'Cancel' },
      { label: c ? 'Save' : 'Add', kind: '', onClick: async () => {
        const body = { name: n.value.trim(), site: s.value.trim(), phone: p.value.trim(), city: city.value.trim(), notes: notes.value, customer };
        if (!body.name) return ui.needs(n, 'Type the company name.');
        try { const x = c ? await api(`m/sales/crm/companies/${c.id}`, { method: 'PATCH', body }) : await api('m/sales/crm/companies', { body }); toast(c ? 'Saved' : x.company.merged ? `Saved into ${x.company.name}, which you already had` : 'Added', 'ok'); await load(); }
        catch (x) {
          if (x.status === 409 && x.data?.same) { sameSlot.replaceChildren(sameBox(x, { kind: 'company', body, close: () => m.close(), onDone: load })); return false; }
          return refuse(x, inputs);
        }
      } }] });
  }

  // ---------------- Import customers: pick a file, match the columns, see every row, save in parts
  function importDialog() {
    const file = h('input', { type: 'file', accept: '.csv,text/csv,.txt,.xlsx,.xlsm', 'aria-label': 'CSV or .xlsx file' });
    const out = h('div', { class: 'stack' });
    let picked = null; let columns = null; const same = {}; let last = null;
    const what = (x) => {
      if (x.action === 'skip') return `Skipped: ${x.why}`;
      const head = x.action === 'new' ? (x.with ? `New contact at ${x.with}` : 'New') : x.action === 'merge' ? `Merged with ${x.with}` : `Already there (${x.with})`;
      return [head, ...(x.warn || [])].join('. ').replace(/\.\./g, '.');
    };
    async function preview() {
      out.replaceChildren(ui.spinner());
      try {
        const r = await api('m/sales/crm/import/preview', { body: { ...picked, columns, same } }); last = r;
        columns = r.columns.map(c => c.field);
        const cols = h('div', { class: 'imp-cols' }, r.columns.map((c, i) => h('label', null, h('b', null, c.heading),
          h('select', { 'aria-label': `What ${c.heading} is`, onchange: (e) => { columns[i] = e.target.value; preview(); } }, r.fields.map(f => h('option', { value: f.id, selected: f.id === c.field }, f.label))),
          h('span', { class: 'ex' }, c.example ? `e.g. ${String(c.example).trim()}` : 'empty in every row'))));
        const k = r.counts;
        const sum = `${r.total} row${r.total === 1 ? '' : 's'}: ${k.added} new, ${k.merged} merged, ${k.already} already there, ${k.skipped.length} skipped. Nothing is saved until you press Save.`;
        const nearSel = (x) => x.near ? h('select', { 'aria-label': 'The same company?', onchange: (e) => { if (e.target.value) same[x.line] = x.near.id; else delete same[x.line]; preview(); } },
          h('option', { value: '' }, `Add as new (looks like ${x.near.name})`), h('option', { value: '1' }, `The same as ${x.near.name}`)) : (same[x.line] ? dim('The same as a company you have') : '');
        const rows = r.rows.slice(0, 500);
        out.replaceChildren(...kids(
          h('div', { class: 'sub' }, r.header ? 'What each column is. Change any that is wrong; the rows below follow.' : 'The file has no header row. What each column is (guessed from the rows):'), cols,
          h('p', { class: 'sub', style: { margin: 0 } }, sum),
          h('div', { class: 'scroll imp-table crm-stk', style: { maxHeight: '38vh' } }, h('table', null,
            h('thead', null, h('tr', null, ['Line', 'Company', 'Contact', 'Mail address', 'Phone', 'What happens'].map((x, i) => h('th', { style: { width: ['48px', '20%', '17%', '20%', '14%', ''][i] } }, x)))),
            h('tbody', null, rows.map(x => h('tr', null, [['Line', String(x.line)], ['Company', x.company], ['Contact', x.name], ['Mail address', x.email], ['Phone', x.phone], ['What happens', h('span', null, what(x), x.near || same[x.line] ? h('div', null, nearSel(x)) : null)]]
              .map(([l, v]) => h('td', { 'data-label': l }, h('span', { class: 'v' }, v || '')))))))),
          r.rows.length > rows.length ? dim(`The first ${rows.length} rows are shown; the counts above are for all ${r.total}.`) : null));
      } catch (e) { picked = null; out.replaceChildren(h('p', { class: 'sub', role: 'alert' }, ui.plainError(e))); }
    }
    file.addEventListener('change', async () => {
      const f = file.files?.[0]; if (!f) return;
      columns = null; for (const k of Object.keys(same)) delete same[k];
      if (/\.(xls|ods|numbers)$/i.test(f.name)) { picked = null; out.replaceChildren(h('p', { class: 'sub', role: 'alert' }, 'This kind of spreadsheet cannot be read. Save it as .xlsx or CSV in your spreadsheet program (File, Save as) and import that file.')); return; }
      if (f.size > 4_000_000) { picked = null; out.replaceChildren(h('p', { class: 'sub', role: 'alert' }, 'The file is too large: 4 MB at most. Split it into two files.')); return; }
      picked = /\.(xlsx|xlsm)$/i.test(f.name) ? { xlsx: base64(await f.arrayBuffer()), fileName: f.name } : { csv: await f.text(), fileName: f.name };
      preview();
    });
    const m = ui.modal({ title: 'Import customers', wide: true, body: h('div', { class: 'stack' }, h('span', { class: 'sub' }, `A CSV file or an .xlsx workbook (its first sheet), up to ${IMPORT_ROWS.toLocaleString(loc())} rows and 4 MB. You say what each column is and see every row before anything is saved. Rows are saved as customers.`), file, out),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => {
        if (!picked || !last) { toast('Pick a file first.', 'err'); return false; }
        const total = last.total; const step = 250; let importId = null; const sumUp = { added: 0, merged: 0, already: 0, skipped: [], warned: [] };
        const bar = ui.meter(0); const line = h('span', { class: 'sub' }, `Saving 0 of ${total} rows…`);
        out.replaceChildren(h('div', { class: 'stack' }, line, bar));
        for (const b of m.box.querySelectorAll('.row button')) b.disabled = true;
        try {
          for (let start = 0; start < total; start += step) {
            const r = await api('m/sales/crm/import', { body: { ...picked, columns, same, start, end: start + step, importId } });
            importId = r.importId; sumUp.added += r.added; sumUp.merged += r.merged; sumUp.already += r.already; sumUp.skipped.push(...r.skipped); sumUp.warned.push(...r.warned);
            bar.set(r.done / total); line.textContent = `Saving ${r.done} of ${total} rows…`;
          }
        } catch (e) { for (const b of m.box.querySelectorAll('.row button')) b.disabled = false; out.replaceChildren(h('p', { class: 'sub', role: 'alert' }, `Stopped: ${ui.plainError(e)}. ${importId ? 'What was saved so far is one import: you can take it back under Imports.' : 'Nothing was saved.'}`)); await load().catch(() => {}); return false; }
        st.coFilter = 1; await load();
        setTimeout(() => ui.modal({ title: 'Import done', body: h('div', { class: 'stack' },
          h('p', null, `${picked.fileName}: ${sumUp.added} added, ${sumUp.merged} merged into records you had, ${sumUp.already} already there, ${sumUp.skipped.length} skipped.`),
          sumUp.skipped.length ? h('div', null, h('h6', null, 'Skipped'), sumUp.skipped.slice(0, 200).map(x => h('div', { class: 'sub' }, `Line ${x.line}: ${x.why}`))) : null,
          sumUp.warned.length ? h('div', null, h('h6', null, 'Saved, with a word'), sumUp.warned.slice(0, 200).map(x => h('div', { class: 'sub' }, `Line ${x.line}: ${x.warn.join(' ')}`))) : null,
          h('span', { class: 'sub' }, 'To take this import back as one set, press Imports in Companies.')), actions: [{ label: 'Close' }] }), 0);
      } }] });
  }
  function importsDialog() {
    const list = st.data.imports || [];
    const m = ui.modal({ title: 'Imports', wide: true, body: h('div', { class: 'stack' }, h('span', { class: 'sub' }, 'Each file you imported. Taking one back removes the rows it added; rows you changed since, and rows another file or list also has, stay.'),
      ...list.map(x => h('div', { class: 'row card', style: { padding: '8px 12px' } }, h('div', { class: 'grow' }, h('b', null, x.file), h('div', { class: 'sub' }, `${fmt.when(x.at)} · ${x.added} added, ${x.merged} merged, ${x.already} already there, ${x.skipped} skipped`)),
        btn('Take back', { kind: 'ghost sm', onClick: async () => {
          if (!(await ui.confirm(`Take back the import of ${x.file}? The rows it added are removed, and what it filled into records you had is taken out. Rows you changed since, and rows another file or list also has, stay.`, { ok: 'Take back', kind: 'stop' }))) return;
          try { const r = await api(`m/sales/crm/imports/${x.id}`, { method: 'DELETE' });
            toast(`Took back ${x.file}: ${r.line}.`, 'ok', 9000); m.close(); await load(); }
          catch (e) { toast(e.message, 'err'); }
        } })))), actions: [{ label: 'Close' }] });
  }

  // ---------------- Deals
  const stageMove = async (d, dir) => {
    const ids = st.data.stages.map(s => s.id); const i = ids.indexOf(d.stage) + dir; if (i < 0 || i >= ids.length) return;
    // the card keeps the focus through every repaint (this one and the one the change event brings), so the next key moves it again
    st.focusDeal = d.id;
    try { await api(`m/sales/crm/deals/${d.id}`, { method: 'PATCH', body: { stage: ids[i] } }); toast(`${d.title}: ${st.data.stages[i].label}`, 'ok'); await load(); } catch (x) { toast(x.message, 'err'); }
  };
  function dealCard(d) {
    const who = [d.companyName && d.companyName !== d.title ? d.companyName : '', d.contactName].filter(Boolean).join(' · ');
    const c = h('button', { class: 'lead deal hov', type: 'button', draggable: 'true', 'data-deal': d.id, onclick: () => dealDialog(d),
      'aria-label': `${d.title}, ${d.stageLabel}${d.value != null ? ', ' + cash(d.value, d.currency) : ''}${d.closeDate ? ', closes ' + day(d.closeDate) : ''}. Left and right arrow keys move it to another stage.`,
      onkeydown: (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stageMove(d, e.key === 'ArrowRight' ? 1 : -1); } },
      onblur: () => { setTimeout(() => { if (st.focusDeal === d.id && document.activeElement && document.activeElement !== document.body && !document.activeElement.matches?.('[data-deal]')) st.focusDeal = null; }, 0); } },
      h('span', { class: 'top' }, h('b', null, d.title), h('span', { class: 'amt' }, d.value == null ? '' : cash(d.value, d.currency))),
      who ? h('span', { class: 'sub' }, who) : null,
      d.closeDate ? h('span', { class: 'sub' + (d.closeLate ? ' due' : '') }, `Closes ${day(d.closeDate)}${d.closeLate ? ' · date passed' : ''}`) : null,
      d.nextStep || d.nextDate ? h('span', { class: 'sub' + (d.due === 'overdue' ? ' due' : '') }, [d.nextStep && 'Next: ' + d.nextStep, d.nextDate && (d.due === 'today' ? 'today' : day(d.nextDate)), d.due === 'overdue' ? 'late' : ''].filter(Boolean).join(' · ')) : null);
    c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', d.id); e.dataTransfer.effectAllowed = 'move'; });
    return c;
  }
  function paintDeals() {
    const { deals, stages } = st.data;
    const head = h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Deals'), ui.seg(['Board', 'List'], st.dealMode, (o, i) => { st.dealMode = i; paint(); }), h('span', { class: 'grow' }),
      btn('Rename stages', { kind: 'ghost sm', onClick: stagesDialog }), btn('Export CSV', { kind: 'ghost sm', onClick: () => exportCsv('deals') }), btn('New deal', { kind: 'sm', onClick: () => dealDialog() }));
    const none = !deals.length ? h('div', { class: 'card', style: { padding: '10px 14px' } }, h('b', null, 'No deals yet. '), h('span', null, 'Press New deal to add one: give it a name or a company, a value and a close date. Or open a company and press New deal there.')) : null;
    if (st.dealMode === 1) {
      const sorted = [...deals].sort((a, b) => String(a.closeDate || '9999').localeCompare(String(b.closeDate || '9999')));
      pane.replaceChildren(head, none || h('div', { class: 'card s-list', style: { padding: '4px 8px' } }, bigList({ rows: sorted, sortKey: '', onSort: () => {}, onRow: (d) => dealDialog(d), empty: '',
        cols: [
          { label: 'Deal', render: (d) => h('b', null, d.title) }, { label: 'Company', render: (d) => d.companyName }, { label: 'Contact', render: (d) => d.contactName }, { label: 'Stage', render: (d) => pill(d.stageLabel) },
          { label: 'Value', render: (d) => d.value == null ? dim(NS) : money(d.value, d.currency) },
          { label: 'Closes', render: (d) => d.closeDate ? h('span', { class: d.closeLate ? 'due' : '' }, day(d.closeDate) + (d.closeLate ? ' · date passed' : '')) : '' },
          { label: 'Next step', render: (d) => [d.nextStep, d.nextDate && (d.due === 'today' ? 'today' : day(d.nextDate) + (d.due === 'overdue' ? ' · late' : ''))].filter(Boolean).join(' · ') },
        ] })));
      return;
    }
    // the board; at phone width the lanes stack into one list by stage (CSS)
    pane.replaceChildren(head, ...(none ? [none] : []), h('div', { class: 'dboard' }, stages.map((s, k) => {
      const ds = deals.filter(d => d.stage === s.id);
      // one total per currency, the owner's first: a deal in another currency is never left out or added in
      const cur = st.data.currency; const sums = new Map();
      for (const d of ds) if (d.value) sums.set(d.currency || cur, (sums.get(d.currency || cur) || 0) + d.value);
      const total = [...sums].sort(([a], [b]) => (a === cur ? -1 : b === cur ? 1 : String(a).localeCompare(String(b)))).map(([c, v]) => cash(v, c)).join(' + ');
      const lane = h('div', { class: 'lane' },
        h('header', null, h('i', { class: `dot s${Math.min(k, 3)}` }), s.label, h('span', null, `${ds.length}${total ? ' · ' + total : ''}`)),
        h('div', { class: 'cards' }, ds.length ? ds.map(dealCard) : h('div', { class: 'empty', style: { padding: '10px 6px' } }, 'None')));
      lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('over'); });
      lane.addEventListener('dragleave', () => lane.classList.remove('over'));
      lane.addEventListener('drop', async (e) => { e.preventDefault(); lane.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'); if (id) { try { await api(`m/sales/crm/deals/${id}`, { method: 'PATCH', body: { stage: s.id } }); toast(`Moved to ${s.label}`, 'ok'); await load(); } catch (x) { toast(x.message, 'err'); } } });
      return lane;
    })));
  }
  function dealDialog(d = null, { companyId } = {}) {
    const cur = st.data.currency;
    const [ft, title] = field('Deal', d?.title, 'text', { placeholder: 'Leave empty to use the company name' });
    const co = companyChooser(d?.companyId || companyId);
    const ct = chooser(st.data.contacts, d?.contactId, { label: 'Contact', none: 'No contact', name: (x) => x.name || x.email, extra: (x) => coName(x.companyId) || x.email || '' });
    const stage = h('select', { 'aria-label': 'Stage' }, st.data.stages.map(s => h('option', { value: s.id, selected: s.id === (d?.stage || 'new') }, s.label)));
    const [fv, value] = field(cur ? `Value (${cur})` : 'Value', d?.value == null ? '' : String(d.value / 100), 'number', { min: '0', step: 'any' });
    const [fcd, close] = field('Close date', d?.closeDate, 'date');
    const [fx, next] = field('Next step', d?.nextStep);
    const [fd, date] = field('Next step date', d?.nextDate, 'date');
    const notes = h('textarea', { rows: 3 }, d?.notes || '');
    const inputs = { title, value, closeDate: close, nextDate: date, stage, notes };
    const box = h('div', { class: 'stack' }, ft, co, ct, h('label', { class: 'f' }, 'Stage', stage), fv, fcd, fx, fd, h('label', { class: 'f' }, 'Notes', notes),
      h('span', { class: 'sub' }, 'A deal is your own record. Nothing is sent from here.'));
    ui.modal({ title: d ? d.title : 'New deal', body: box, actions: [
      ...(d ? [{ label: 'Remove', kind: 'ghost', onClick: async () => { if (!(await ui.confirm(`Remove the deal ${d.title}?`, { ok: 'Remove', kind: 'stop' }))) return false; try { await api(`m/sales/crm/deals/${d.id}`, { method: 'DELETE' }); toast(`Removed the deal ${d.title}`, 'ok'); await load(); } catch (x) { toast(x.message, 'err'); return false; } } }] : []),
      { label: 'Cancel' },
      { label: d ? 'Save' : 'Add', kind: '', onClick: async () => {
        if (co.typedUnknown()) return ui.needs(co.input, 'Pick a company from the list, or clear the box.');
        if (ct.typedUnknown()) return ui.needs(ct.input, 'Pick a contact from the list, or clear the box.');
        const v = value.value.trim();
        if (v !== '' && !(Number(v) >= 0)) return ui.needs(value, 'A value is a number of zero or more.');
        const fd = fractionDigits(d?.currency || cur); const scaled = Number(v) * 10 ** fd;
        if (v !== '' && Math.abs(scaled - Math.round(scaled)) > 1e-6) return ui.needs(value, fd === 0 ? `Amounts in ${d?.currency || cur} have no smaller unit: give a whole number.` : `Give the value with at most ${fd} digits after the point.`);
        const body = { companyId: co.value || null, contactId: ct.value || null, stage: stage.value, valueMinor: v === '' ? null : Math.round(Number(v) * 100), closeDate: close.value, nextStep: next.value.trim(), nextDate: date.value, notes: notes.value };
        if (title.value.trim() || d) body.title = title.value.trim() || d.title;
        if (!body.title && !body.companyId) return ui.needs(title, 'Give the deal a name or pick a company.');
        try { d ? await api(`m/sales/crm/deals/${d.id}`, { method: 'PATCH', body }) : await api('m/sales/crm/deals', { body }); toast(d ? 'Saved' : 'Added', 'ok'); await load(); } catch (x) { return refuse(x, inputs); }
      } }] });
  }
  function stagesDialog() {
    const ins = st.data.stages.map(s => field(s.label, s.label, 'text', { dataset: { id: s.id } }));
    ui.modal({ title: 'Rename stages', body: h('div', { class: 'stack' }, ins.map(x => x[0]), h('span', { class: 'sub' }, 'Deals keep their place; only the names change.')),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => { try { await api('m/sales/crm/stages', { method: 'PUT', body: { labels: Object.fromEntries(ins.map(([, i]) => [i.dataset.id, i.value.trim()])) } }); toast('Saved', 'ok'); await load(); } catch (x) { toast(x.message, 'err'); return false; } } }] });
  }

  return { show, refresh: () => (st.data ? load().catch(() => {}) : null) };
}
