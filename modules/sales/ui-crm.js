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
.salesv .srcl a,.salesv .srcl span{overflow-wrap:anywhere}
.salesv .due{color:var(--stop,#c0392b)}
@media (max-width:600px){.crm-stk table,.crm-stk tbody,.crm-stk tr,.crm-stk td{display:block;width:100%}.crm-stk thead{display:none}
.crm-stk tr{padding:6px 0;border-bottom:1px solid var(--line)}.crm-stk td{display:flex;gap:10px;border:0;padding:3px 4px}.crm-stk td:has(> .v:empty){display:none}
.crm-stk td::before{content:attr(data-label);flex:0 0 92px;color:var(--dim);font-size:12px;padding-top:1px}.crm-stk td > .v{flex:1;min-width:0;overflow-wrap:anywhere}}
@media (max-width:600px){.salesv .dboard{display:flex;flex-direction:column;overflow:visible;flex:none}.salesv .dboard .lane{overflow:visible}.salesv .dboard .cards{overflow:visible}.salesv .crm-pane{overflow:visible}}
`;

export function mountCrm(pane, ui) {
  const { h, btn, pill, fmt, api, toast } = ui;
  const st = { tab: 'contacts', data: null, coFilter: 0, dealMode: 0 };
  const isUrl = (s) => /^https?:\/\//i.test(s || '');
  const NC = 'not checked';
  const val = (v) => v || h('span', { class: 'sub' }, NC);
  const loc = () => ui.state?.settings?.locale || undefined;
  // a deal's date is a calendar day in the owner's zone, stored as year-month-day: shown as that day, never shifted
  const day = (d) => { if (!d) return ''; try { return new Date(d + 'T00:00:00Z').toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
  const money = (minor, cur) => (minor == null ? NC : fmt.money(minor, cur));
  const coName = (id) => st.data.companies.find(c => c.id === id)?.name || '';
  const fromText = (s) => isUrl(s.from) ? h('a', { href: s.from, target: '_blank', rel: 'noopener noreferrer', title: s.from, onclick: (e) => e.stopPropagation() }, s.from.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)) : h('span', null, s.from);
  const firstFrom = (r) => r.sources[0] ? h('span', { class: 'srcl' }, fromText(r.sources[0]), r.sources.length > 1 ? h('span', { class: 'sub' }, ` and ${r.sources.length - 1} more`) : '') : NC;
  const sourcesBlock = (r) => h('div', { class: 'srcl stack', style: { gap: '4px' } }, h('h6', null, 'Where it came from'), r.sources.map(s => h('div', { class: 'sub' }, fromText(s), ` · ${fmt.when(s.at)}`)));
  // a table that, at phone width, turns each row into label and value lines so no column hides off the right edge (CSS above)
  const grid = (cols, rows, opts) => {
    const t = ui.table(cols.map(c => ({ ...c, render: (r) => h('span', { class: 'v' }, c.render(r)) })), rows, opts);
    if (t.querySelector?.('table')) { t.classList.add('crm-stk'); for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => { td.dataset.label = cols[i].label; }); }
    return t;
  };
  const field = (label, value = '', type = 'text', attrs = {}) => { const i = h('input', { type, value: value ?? '', style: { width: '100%' }, ...attrs }); return [h('label', { class: 'f' }, label, i), i]; };

  async function load() { st.data = await api('m/sales/crm'); paint(); }
  function show(tab) { st.tab = tab; if (!st.data) load().catch(e => toast(e.message, 'err')); else paint(); }
  function paint() {
    if (!st.data) { pane.replaceChildren(ui.spinner()); return; }
    if (st.tab === 'contacts') paintContacts(); else if (st.tab === 'companies') paintCompanies(); else paintDeals();
  }

  // ---------------- CSV out: the file comes from the desk as text and is saved by the browser
  async function exportCsv(what) {
    try { const r = await api(`m/sales/crm/export/${what}`); const a = h('a', { href: URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })), download: r.fileName }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ---------------- Contacts
  function paintContacts() {
    const cs = st.data.contacts;
    pane.replaceChildren(
      h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Contacts'), h('span', { class: 'grow' }), btn('Export CSV', { kind: 'ghost sm', onClick: () => exportCsv('contacts') }), btn('Add contact', { kind: 'sm', onClick: () => contactDialog() })),
      h('p', { class: 'lawful' }, st.data.lawful),
      h('div', { class: 'card s-list', style: { padding: '4px 8px' } }, grid([
        { label: 'Name', render: (c) => h('b', null, c.name || c.email) }, { label: 'Mail address', render: (c) => val(c.email) }, { label: 'Role', render: (c) => val(c.role) },
        { label: 'Company', render: (c) => val(coName(c.companyId)) }, { label: 'From', render: firstFrom },
      ], cs, { onRow: (c) => contactDialog(c), empty: 'No contacts yet. Add one, or press Add to CRM on a lead.' })));
  }
  function contactDialog(c = null, { companyId } = {}) {
    const [fn, n] = field('Name', c?.name); const [fe, e] = field('Mail address', c?.email, 'email'); const [fr, r] = field('Role', c?.role); const [fp, p] = field('Phone', c?.phone, 'tel');
    const co = h('select', { 'aria-label': 'Company' }, h('option', { value: '' }, 'No company'), st.data.companies.map(x => h('option', { value: x.id, selected: x.id === (c?.companyId || companyId) }, x.name)));
    const box = h('div', { class: 'stack' }, fn, fe, fr, fp, h('label', { class: 'f' }, 'Company', co),
      c ? h('div', { class: 'sub' }, c.notChecked.length ? `Not checked: ${c.notChecked.join(', ')}` : '') : null, c ? sourcesBlock(c) : h('div', { class: 'sub' }, 'Saved as typed by you. A contact with the same mail address, or the same name in the same company, is merged.'));
    ui.modal({ title: c ? 'Contact' : 'Add contact', body: box, actions: [
      ...(c ? [{ label: 'Remove', kind: 'ghost', onClick: async () => { if (!(await ui.confirm(`Remove ${c.name || c.email}?`, { ok: 'Remove', kind: 'stop' }))) return false; try { await api(`m/sales/crm/contacts/${c.id}`, { method: 'DELETE' }); await load(); } catch (x) { toast(x.message, 'err'); return false; } } }] : []),
      { label: 'Cancel' },
      { label: c ? 'Save' : 'Add', kind: '', onClick: async () => {
        const body = { name: n.value.trim(), email: e.value.trim(), role: r.value.trim(), phone: p.value.trim(), companyId: co.value || null };
        try { const x = c ? await api(`m/sales/crm/contacts/${c.id}`, { method: 'PATCH', body }) : await api('m/sales/crm/contacts', { body }); if (x.contact?.merged) toast('Merged with a contact you already had', 'ok'); await load(); } catch (x) { toast(x.message, 'err'); return false; }
      } }] });
  }

  // ---------------- Companies and customers
  function paintCompanies() {
    const all = st.data.companies; const cos = st.coFilter ? all.filter(c => c.customer) : all;
    const n = (id) => st.data.contacts.filter(c => c.companyId === id).length;
    pane.replaceChildren(
      h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Companies'), ui.seg(['All', `Customers (${all.filter(c => c.customer).length})`], st.coFilter, (o, i) => { st.coFilter = i; paint(); }), h('span', { class: 'grow' }),
        btn('Import customers', { kind: 'ghost sm', title: 'A CSV file: name, site, and an optional contact and mail address', onClick: importDialog }), btn('Export CSV', { kind: 'ghost sm', onClick: () => exportCsv('companies') }), btn('Add company', { kind: 'sm', onClick: () => companyDialog() })),
      h('div', { class: 'card s-list', style: { padding: '4px 8px' } }, grid([
        { label: 'Name', render: (c) => h('b', null, c.name) }, { label: 'Site', render: (c) => c.site ? h('a', { href: /^https?:/i.test(c.site) ? c.site : 'https://' + c.host, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, c.host) : val('') },
        { label: 'Customer', render: (c) => c.customer ? pill('Customer', 'ok') : '' }, { label: 'Contacts', render: (c) => String(n(c.id)) }, { label: 'From', render: firstFrom },
        { label: 'Not checked', render: (c) => c.notChecked.join(', ') },
      ], cos, { onRow: (c) => companyDialog(c), empty: st.coFilter ? 'No customers yet. Mark a company as a customer, or import a CSV.' : 'No companies yet. Add one, import customers, or press Add to CRM on a lead.' })));
  }
  function companyDialog(c = null) {
    const [fn, n] = field('Name', c?.name); const [fs, s] = field('Site', c?.site, 'text', { placeholder: 'company.com' });
    const notes = h('textarea', { rows: 3 }, c?.notes || '');
    let customer = !!c?.customer;
    const people = c ? st.data.contacts.filter(x => x.companyId === c.id) : [];
    const box = h('div', { class: 'stack' }, fn, fs, h('label', { class: 'f' }, 'Notes', notes),
      h('div', { class: 'row' }, ui.sw(customer, 'Customer', (v) => { customer = v; }), h('span', null, 'Customer')),
      c ? h('div', { class: 'sub' }, c.notChecked.length ? `Not checked: ${c.notChecked.join(', ')}` : '') : null,
      c ? h('div', null, h('h6', null, 'Contacts'), people.length ? people.map(p => h('div', { class: 'sub' }, `${p.name || p.email}${p.role ? ' · ' + p.role : ''}${p.email && p.name ? ' · ' + p.email : ''}`)) : h('div', { class: 'sub' }, 'None yet.')) : null,
      c ? sourcesBlock(c) : h('div', { class: 'sub' }, 'Saved as typed by you. A company with the same site, or the same name, is merged.'));
    const save = async () => {
      const body = { name: n.value.trim(), site: s.value.trim(), notes: notes.value, customer };
      try { const x = c ? await api(`m/sales/crm/companies/${c.id}`, { method: 'PATCH', body }) : await api('m/sales/crm/companies', { body }); if (x.company?.merged) toast('Merged with a company you already had', 'ok'); await load(); return x.company; } catch (x) { toast(x.message, 'err'); return false; }
    };
    ui.modal({ title: c ? c.name : 'Add company', body: box, actions: [
      ...(c ? [{ label: 'Remove', kind: 'ghost', onClick: async () => { if (!(await ui.confirm(`Remove ${c.name}? Its contacts and deals stay, without a company.`, { ok: 'Remove', kind: 'stop' }))) return false; try { await api(`m/sales/crm/companies/${c.id}`, { method: 'DELETE' }); await load(); } catch (x) { toast(x.message, 'err'); return false; } } },
        { label: 'Add contact', kind: 'ghost', onClick: () => { setTimeout(() => contactDialog(null, { companyId: c.id }), 0); } },
        { label: 'New deal', kind: 'ghost', onClick: () => { setTimeout(() => dealDialog(null, { companyId: c.id }), 0); } }] : []),
      { label: 'Cancel' },
      { label: c ? 'Save' : 'Add', kind: '', onClick: async () => (await save()) === false ? false : undefined }] });
  }
  function importDialog() {
    const file = h('input', { type: 'file', accept: '.csv,text/csv' });
    const out = h('div', { class: 'stack' });
    let picked = null;
    file.addEventListener('change', async () => {
      const f = file.files?.[0]; if (!f) return;
      if (f.size > 2_000_000) { out.replaceChildren(h('p', { class: 'sub' }, 'The file is too large: 2 MB at most.')); return; }
      picked = { csv: await f.text(), fileName: f.name };
      out.replaceChildren(ui.spinner());
      try {
        const r = await api('m/sales/crm/import/preview', { body: picked });
        const what = (x) => x.action === 'new' ? 'New customer' : x.action === 'merge' ? `Merged with ${x.with}` : `Skipped: ${x.why}`;
        const keep = r.rows.filter(x => x.action !== 'skip').length;
        out.replaceChildren(h('p', { class: 'sub', style: { margin: 0 } }, `${keep} of ${r.rows.length} row${r.rows.length === 1 ? '' : 's'} will be saved as customers. Nothing is saved until you press Save.`),
          h('div', { class: 'scroll', style: { maxHeight: '40vh' } }, grid([{ label: 'Company', render: (x) => val(x.name) }, { label: 'Site', render: (x) => val(x.host) }, { label: 'Contact', render: (x) => x.contact || '' }, { label: 'Mail address', render: (x) => x.email || '' }, { label: 'What happens', render: what }], r.rows, { empty: 'No rows in that file.' })));
      } catch (e) { picked = null; out.replaceChildren(h('p', { class: 'sub' }, ui.plainError(e))); }
    });
    ui.modal({ title: 'Import customers', wide: true, body: h('div', { class: 'stack' }, h('span', { class: 'sub' }, 'A CSV file with a company name and site, and an optional contact name and mail address. You see every row before anything is saved.'), file, out),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => {
        if (!picked) { toast('Pick a CSV file first.', 'err'); return false; }
        try { const r = await api('m/sales/crm/import', { body: picked }); toast(`${r.saved} saved as customers${r.skipped ? `, ${r.skipped} skipped` : ''}`, 'ok'); st.coFilter = 1; await load(); } catch (e) { toast(e.message, 'err'); return false; }
      } }] });
  }

  // ---------------- Deals
  function dealCard(d) {
    const c = h('button', { class: 'lead deal hov', type: 'button', draggable: 'true', onclick: () => dealDialog(d) },
      h('span', { class: 'top' }, h('b', null, d.title), h('span', { class: 'amt' }, d.value == null ? '' : fmt.money(d.value, d.currency))),
      d.companyName && d.companyName !== d.title ? h('span', { class: 'sub' }, d.companyName) : null,
      d.nextStep || d.nextDate ? h('span', { class: 'sub' + (d.due === 'overdue' ? ' due' : '') }, [d.nextStep && 'Next: ' + d.nextStep, d.nextDate && (d.due === 'today' ? 'today' : day(d.nextDate)), d.due === 'overdue' ? 'late' : ''].filter(Boolean).join(' · ')) : null);
    c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', d.id); e.dataTransfer.effectAllowed = 'move'; });
    return c;
  }
  function paintDeals() {
    const { deals, stages } = st.data;
    const head = h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Deals'), ui.seg(['Board', 'List'], st.dealMode, (o, i) => { st.dealMode = i; paint(); }), h('span', { class: 'grow' }),
      btn('Rename stages', { kind: 'ghost sm', onClick: stagesDialog }), btn('Export CSV', { kind: 'ghost sm', onClick: () => exportCsv('deals') }), btn('New deal', { kind: 'sm', onClick: () => dealDialog() }));
    if (st.dealMode === 1) {
      pane.replaceChildren(head, h('div', { class: 'card s-list', style: { padding: '4px 8px' } }, grid([
        { label: 'Deal', render: (d) => h('b', null, d.title) }, { label: 'Company', render: (d) => d.companyName || '' }, { label: 'Stage', render: (d) => pill(d.stageLabel) },
        { label: 'Value', render: (d) => money(d.value, d.currency) }, { label: 'Next step', render: (d) => d.nextStep || '' },
        { label: 'Date', render: (d) => d.nextDate ? h('span', { class: d.due === 'overdue' ? 'due' : '' }, day(d.nextDate) + (d.due === 'overdue' ? ' · late' : '')) : '' },
      ], deals, { onRow: (d) => dealDialog(d), empty: 'No deals yet. Press New deal.' })));
      return;
    }
    // the board; at phone width the lanes stack into one list by stage (CSS)
    pane.replaceChildren(head, h('div', { class: 'dboard' }, stages.map((s, k) => {
      const ds = deals.filter(d => d.stage === s.id);
      const cur = st.data.currency;
      const sum = ds.filter(d => d.currency === cur).reduce((a, d) => a + (d.value || 0), 0);
      const lane = h('div', { class: 'lane' },
        h('header', null, h('i', { class: `dot s${Math.min(k, 3)}` }), s.label, h('span', null, `${ds.length}${sum ? ' · ' + fmt.money(sum, cur) : ''}`)),
        h('div', { class: 'cards' }, ds.length ? ds.map(dealCard) : h('div', { class: 'empty', style: { padding: '10px 6px' } }, 'None')));
      lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('over'); });
      lane.addEventListener('dragleave', () => lane.classList.remove('over'));
      lane.addEventListener('drop', async (e) => { e.preventDefault(); lane.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'); if (id) { try { await api(`m/sales/crm/deals/${id}`, { method: 'PATCH', body: { stage: s.id } }); await load(); } catch (x) { toast(x.message, 'err'); } } });
      return lane;
    })));
  }
  function dealDialog(d = null, { companyId } = {}) {
    const cur = st.data.currency;
    const [ft, title] = field('Deal', d?.title, 'text', { placeholder: 'Leave empty to use the company name' });
    const co = h('select', { 'aria-label': 'Company' }, h('option', { value: '' }, 'No company'), st.data.companies.map(x => h('option', { value: x.id, selected: x.id === (d?.companyId || companyId) }, x.name)));
    const ct = h('select', { 'aria-label': 'Contact' });
    const paintCt = () => ct.replaceChildren(h('option', { value: '' }, 'No contact'), ...st.data.contacts.filter(x => !co.value || x.companyId === co.value).map(x => h('option', { value: x.id, selected: x.id === d?.contactId }, x.name || x.email)));
    co.addEventListener('change', paintCt); paintCt();
    const stage = h('select', { 'aria-label': 'Stage' }, st.data.stages.map(s => h('option', { value: s.id, selected: s.id === (d?.stage || 'new') }, s.label)));
    const [fv, value] = field(cur ? `Value (${cur})` : 'Value', d?.value == null ? '' : String(d.value / 100), 'number', { min: '0', step: 'any' });
    const [fx, next] = field('Next step', d?.nextStep);
    const [fd, date] = field('Next step date', d?.nextDate, 'date');
    const notes = h('textarea', { rows: 3 }, d?.notes || '');
    const box = h('div', { class: 'stack' }, ft, h('label', { class: 'f' }, 'Company', co), h('label', { class: 'f' }, 'Contact', ct), h('label', { class: 'f' }, 'Stage', stage), fv, fx, fd, h('label', { class: 'f' }, 'Notes', notes),
      h('span', { class: 'sub' }, 'A deal is your own record. Nothing is sent from here.'));
    ui.modal({ title: d ? d.title : 'New deal', body: box, actions: [
      ...(d ? [{ label: 'Remove', kind: 'ghost', onClick: async () => { if (!(await ui.confirm(`Remove the deal ${d.title}?`, { ok: 'Remove', kind: 'stop' }))) return false; try { await api(`m/sales/crm/deals/${d.id}`, { method: 'DELETE' }); await load(); } catch (x) { toast(x.message, 'err'); return false; } } }] : []),
      { label: 'Cancel' },
      { label: d ? 'Save' : 'Add', kind: '', onClick: async () => {
        const v = value.value.trim();
        const body = { companyId: co.value || null, contactId: ct.value || null, stage: stage.value, valueMinor: v === '' ? null : Math.round(Number(v) * 100), nextStep: next.value.trim(), nextDate: date.value, notes: notes.value };
        if (title.value.trim() || d) body.title = title.value.trim() || d.title;
        if (!body.title && !body.companyId) { toast('Give the deal a name or pick a company.', 'err'); return false; }
        try { d ? await api(`m/sales/crm/deals/${d.id}`, { method: 'PATCH', body }) : await api('m/sales/crm/deals', { body }); await load(); } catch (x) { toast(x.message, 'err'); return false; }
      } }] });
  }
  function stagesDialog() {
    const ins = st.data.stages.map(s => field(s.label, s.label, 'text', { dataset: { id: s.id } }));
    ui.modal({ title: 'Rename stages', body: h('div', { class: 'stack' }, ins.map(x => x[0]), h('span', { class: 'sub' }, 'Deals keep their place; only the names change.')),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => { try { await api('m/sales/crm/stages', { method: 'PUT', body: { labels: Object.fromEntries(ins.map(([, i]) => [i.dataset.id, i.value.trim()])) } }); await load(); } catch (x) { toast(x.message, 'err'); return false; } } }] });
  }

  return { show, refresh: () => (st.data ? load().catch(() => {}) : null) };
}
