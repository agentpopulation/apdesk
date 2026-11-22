// Sales page: totals, the pipeline board (drag and drop or Move), the lead panel, Leads, Outreach, and a coach note.
// Tabs: Leads (all of the above), Contacts, Companies, Deals (ui-crm.js).
import { mountCrm, CRM_STYLE } from './ui-crm.js';
// Closer's own avatar beside the coach note, drawn by the Agents page's helper (letters when that page is not there)
let agentAvatar = null; import('/modules/agents/ui.js').then((m) => { agentAvatar = m.avatarEl || null; }, () => {});
const STAGES = [['new', 'New'], ['researched', 'Researched'], ['drafted', 'Drafted'], ['talks', 'In talks']];
const S_IDX = Object.fromEntries(STAGES.map(([id], i) => [id, i]));
const CHANNEL = { email: 'Email draft', linkedin: 'LinkedIn message', whatsapp: 'WhatsApp message', text: 'Text' };
const STATUS = { copy: ['Copy only', ''], waiting: ['Waiting for you', 'wait'], approved: ['Approved, not sent', 'wait'], sent: ['Sent', 'ok'], 'not sent': ['Not sent', 'stop'] };

const STYLE = `
.view.salesv{overflow:hidden}
.salesv .crm{flex:1;min-height:0;align-items:stretch}
.salesv .s-main{min-width:0;min-height:0;display:flex;flex-direction:column}
.salesv .board{flex:1;min-height:0;grid-template-rows:minmax(0,1fr)}
.salesv .lane{min-height:0;overflow:hidden}
.salesv .lane .cards{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;flex:1;padding:1px}
.salesv .lane.over{border-color:var(--accent);background:var(--accent-soft)}
.salesv .lead{cursor:grab;color:inherit;font:inherit}
.salesv .lead.dragging{opacity:.45}
.salesv .grp{flex:none;font-size:12px;color:var(--dim);border-top:1px dashed var(--line);padding:6px 2px 0;margin-top:2px}
.salesv .lead .ft{width:auto;display:flex;font-size:11.5px;font-weight:400;background:none;padding:0;margin:0;text-align:left;border-radius:0}
.salesv .lead .nw{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.salesv .lead .grow{flex:1}
.salesv .s-det{min-height:0;overflow-y:auto}
.salesv .s-list{flex:1;min-height:0;overflow:auto}
.salesv .coach{display:flex;gap:10px;align-items:center;padding:10px 14px}
.salesv .coach p{margin:0;flex:1;min-width:0}
.salesv .srcs a{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.salesv .tiles .stat{padding:10px 14px}
.salesv h6{margin:0 0 6px;font-size:12px;color:var(--dim);font-weight:600;text-transform:none}
@media (max-width:860px){.view.salesv{overflow:auto}.salesv .board{grid-template-rows:none}}
`;

let st = { mode: 0, pick: null, data: null, job: null, tab: 0 };
const TABS = ['Leads', 'Contacts', 'Companies', 'Deals'];

/**
 * "Approve and send", from any screen. Fetches the draft as stored now, hands it to onFresh (so a card can repaint),
 * shows all of what will be sent (To, subject, full body) and only that confirm's "Send" approves: the shown values go
 * back with the press and the server refuses if the stored draft no longer matches. Returns the decided approval row,
 * or null when the owner cancels. Throws with the reason when nothing was approved.
 */
export async function confirmAndSend(ui, draftId, { onFresh } = {}) {
  const { h, api } = ui;
  const r = await api(`m/sales/drafts/${draftId}`);
  onFresh?.(r.draft, r.send);
  const s = r.send;
  if (!s) throw new Error('This text is for copying. It cannot be sent from here.');
  if (!s.to) throw new Error('This draft has no address yet. Add an address first.');
  const shown = h('div', { class: 'stack' },
    h('div', null, h('b', null, 'To: '), s.to),
    h('div', null, h('b', null, 'Subject: '), s.subject),
    h('div', { class: 'draft', style: { whiteSpace: 'pre-wrap' } }, s.body),
    r.mailOn ? null : h('div', { class: 'sub' }, 'Mail is off, so it will be marked approved but not sent.'));
  if (!(await ui.confirm(shown, { ok: 'Send', title: 'Send this mail?' }))) return null;
  const p = await api(`m/sales/drafts/${draftId}/send`, { body: { to: s.to, subject: s.subject, body: s.body } });
  const row = p.approvalId ? await ui.decide(p.approvalId, 'approve') : null;
  if (row?.status !== 'approved') throw new Error('The draft changed. Look at it again.');
  return row;
}

export const pages = {
  sales: {
    title: 'Sales',
    async render(el, ui) {
      const { h, btn, pill, fmt, api, toast, card } = ui;
      if (!document.getElementById('sales-style')) document.head.append(h('style', { id: 'sales-style' }, STYLE + CRM_STYLE));
      el.classList.add('salesv');
      const title = ui.label('sales', 'Sales');
      const money = (minor, cur) => (minor == null ? 'value not set' : fmt.money(minor, cur));
      const contactUrl = (l) => (String(l.contactOther || '').match(/https?:\/\/\S+/) || [])[0] || '';
      const contact = (l) => l.contactName ? `${l.contactName}${l.contactRole ? ' · ' + l.contactRole : ''}` : (l.email || (contactUrl(l) ? h('a', { href: contactUrl(l), target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, 'Contact page') : 'Contact not checked'));
      const ini = (s) => String(s || '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const open = (l) => (l.unchecked || []).length > 0;          // a found lead no page placed or showed selling what was asked
      const openText = (l) => (l.unchecked || []).join(' · ');
      const OPEN_GROUP = 'Not checked: no page read said where these are or what they sell';
      const checkedFirst = (ls) => [...ls].sort((a, b) => open(a) - open(b));
      const dot = (stage) => h('i', { class: `dot s${S_IDX[stage] ?? 0}`, style: { display: 'inline-block', marginRight: '5px' } });

      const seg = ui.seg(['Pipeline', 'Leads', 'Outreach'], st.mode, (o, i) => { st.mode = i; paint(); });
      const jobLine = h('span', { class: 'sub' });
      const tabs = ui.seg(TABS, st.tab, (o, i) => { st.tab = i; layout(); });
      const leadBar = h('div', { class: 'row', style: { flex: '1 1 auto', minWidth: 0 } }, seg, jobLine, h('span', { class: 'grow' }),
        btn('Your offer', { kind: 'ghost', title: 'What you sell: Closer uses it in drafts', onClick: offerDialog }), btn('Find leads', { kind: 'ghost', onClick: findDialog }), btn('Add lead', { onClick: () => leadDialog() }));
      const head = h('div', { class: 'row' }, h('h2', null, title), tabs, leadBar);
      const tiles = h('div', { class: 'tiles' });
      const coachBox = h('div', { class: 'card coach' });
      const main = h('div', { class: 's-main' });
      const det = h('div', { class: 'card stack s-det' });
      const leadsBody = h('div', { class: 'crm' }, main, det);
      const crmPane = h('div', { class: 'crm-pane' });
      const crmTabs = mountCrm(crmPane, ui);
      el.replaceChildren(head, tiles, coachBox, leadsBody, crmPane);
      function layout() {
        const leads = st.tab === 0;
        for (const x of [leadBar, tiles, coachBox, leadsBody]) x.hidden = !leads;
        crmPane.hidden = leads;
        if (!leads) crmTabs.show(['', 'contacts', 'companies', 'deals'][st.tab]);
      }
      layout();

      async function load() { st.data = await api('m/sales/state'); if (!st.pick || !st.data.leads.some(l => l.id === st.pick)) st.pick = st.data.leads[0]?.id || null; paint(); }
      const draftsFor = (id) => st.data.drafts.filter(d => d.leadId === id);
      const leadById = (id) => st.data.leads.find(l => l.id === id);

      function paint() {
        const d = st.data; if (!d) return;
        const t = d.totals;
        tiles.replaceChildren(...[[t.leads, 'Leads'], [fmt.money(t.pipelineMinor, t.currency), t.valued < t.leads ? `Pipeline value · ${t.valued} of ${t.leads} valued` : 'Pipeline value'], [t.draftsWaiting, 'Drafts waiting for you'], [t.inTalks, 'In talks']]
          .map(([b, s]) => h('div', { class: 'card stat' }, h('b', null, String(b)), h('span', null, s))));
        paintCoach();
        if (st.mode === 0) paintBoard(); else if (st.mode === 1) paintTable(); else paintOutreach();
        paintDetail();
      }
      function paintCoach() {
        const c = st.data.coach;
        coachBox.replaceChildren(agentAvatar && ui.agent('closer') ? agentAvatar(ui.agent('closer'), 's') : ui.av('Closer'), c?.text ? h('p', null, c.text, ' ', h('span', { class: 'sub' }, `· ${c.label} · ${fmt.ago(c.at)}`)) : h('p', { class: 'sub' }, 'Ask Closer what to do next with the pipeline.'),
          btn(c?.text ? 'Ask again' : 'Ask Closer', { kind: 'ghost sm', onClick: async (e) => { const b = e.currentTarget; b.disabled = true; b.replaceChildren(ui.spinner(), ' Thinking'); try { st.data.coach = await api('m/sales/coach', { method: 'POST' }); } catch (x) { toast(x.message, 'err'); } paintCoach(); } }));
      }
      function leadCard(l) {
        const n = l.sources.length;
        const c = h('button', { class: 'lead hov' + (l.id === st.pick ? ' sel' : ''), type: 'button', draggable: 'true', dataset: { id: l.id }, onclick: () => { st.pick = l.id; paint(); } },
          h('span', { class: 'top' }, h('b', null, l.company), h('span', { class: 'amt' }, l.value == null ? '' : fmt.money(l.value, l.currency))),
          h('span', { class: 'sub' }, contact(l)),
          l.nextStep || l.need ? h('span', { class: 'sub' }, l.nextStep ? 'Next: ' + l.nextStep : l.need) : null,
          open(l) ? h('span', { class: 'sub' }, openText(l)) : null,
          h('span', { class: 'ft' }, h('span', { class: 'av' }, ini(l.foundBy || 'You')), h('span', { class: 'nw' }, `${l.foundBy || 'You'} · ${n ? n + (n > 1 ? ' sources' : ' source') : 'no source'}`), h('span', { class: 'grow' }), h('span', { class: 'nw' }, fmt.ago(l.updated))));
        c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
        c.addEventListener('dragend', () => c.classList.remove('dragging'));
        return c;
      }
      function paintBoard() {
        main.replaceChildren(h('div', { class: 'board' }, STAGES.map(([id, label], k) => {
          const ls = checkedFirst(st.data.leads.filter(l => l.stage === id));
          const items = ls.flatMap((l, i) => open(l) && (i === 0 || !open(ls[i - 1])) ? [h('div', { class: 'grp' }, OPEN_GROUP), leadCard(l)] : [leadCard(l)]);
          const sum = ls.reduce((a, l) => a + (l.value || 0), 0);
          const lane = h('div', { class: 'lane', dataset: { stage: id } },
            h('header', null, h('i', { class: `dot s${k}` }), label, h('span', null, `${ls.length}${sum ? ' · ' + fmt.money(sum, st.data.totals.currency) : ''}`)),
            h('div', { class: 'cards' }, ls.length ? items : h('div', { class: 'empty', style: { padding: '14px 6px' } }, k === 0 ? 'No new leads yet' : 'Drop a lead here')));
          lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('over'); });
          lane.addEventListener('dragleave', () => lane.classList.remove('over'));
          lane.addEventListener('drop', (e) => { e.preventDefault(); lane.classList.remove('over'); const lid = e.dataTransfer.getData('text/plain'); if (lid) move(lid, id); });
          return lane;
        })));
      }
      function paintTable() {
        main.replaceChildren(h('div', { class: 'card s-list', style: { padding: '4px 8px' } }, ui.table([
          { label: 'Company', render: (l) => h('b', null, l.company) }, { label: 'Contact', render: contact },
          { label: 'Stage', render: (l) => pill([dot(l.stage), l.stageLabel]) }, { label: 'Value', render: (l) => money(l.value, l.currency) },
          { label: 'Next', render: (l) => l.nextStep || l.need || '' },
          { label: 'Not checked', render: (l) => openText(l) },
          { label: 'CRM', render: (l) => inCrm(l) ? pill('In the CRM', 'ok') : '' },
          { label: 'Source', render: (l) => l.sources[0] ? h('a', { href: l.sources[0].url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, l.sources[0].title) : 'none' },
        ], checkedFirst(st.data.leads), { onRow: (l) => { st.pick = l.id; paint(); }, empty: 'No leads yet.' })));
      }
      function paintOutreach() {
        const ds = st.data.drafts;
        main.replaceChildren(h('div', { class: 'card s-list' }, ds.length ? ds.map(dr => { const l = leadById(dr.leadId); const [word, kind] = STATUS[dr.status] || [dr.status, '']; return ui.line(l?.company || 'Removed lead', `${CHANNEL[dr.channel] || 'Draft'} by Closer${dr.subject ? ' · ' + dr.subject : ''}${dr.note ? ' · ' + dr.note : ''}`, pill(word, kind), btn('Review', { kind: 'ghost sm', onClick: () => { st.pick = dr.leadId; paint(); } })); })
          : ui.empty('No drafts yet. Pick a lead and press Draft outreach.')));
      }
      function paintDetail() {
        const l = leadById(st.pick);
        if (!l) { det.replaceChildren(ui.empty('Pick a lead to see what Closer found.')); return; }
        const dr = draftsFor(l.id)[0];
        const sel = h('select', { 'aria-label': 'Move to stage', onchange: (e) => move(l.id, e.target.value) }, STAGES.map(([id, label]) => h('option', { value: id, selected: id === l.stage }, label)));
        const next = STAGES[S_IDX[l.stage] + 1];
        det.replaceChildren(...[
          h('div', { class: 'row' }, h('span', { class: 'av big g' }, ini(l.company)), h('div', { style: { minWidth: 0, flex: 1 } }, h('h3', null, l.company), h('div', { class: 'sub' }, contact(l)))),
          h('div', { class: 'row' }, pill([dot(l.stage), l.stageLabel]), pill(money(l.value, l.currency)), pill(`${l.sources.length} source${l.sources.length === 1 ? '' : 's'}`), h('span', { class: 'grow' }),
            inCrm(l) ? pill('In the CRM', 'ok') : btn('Add to CRM', { kind: 'ghost sm', title: 'Save this company and contact in Companies and Contacts', onClick: (e) => addToCrm(l, e.currentTarget) })),
          open(l) ? h('div', { class: 'sub' }, `${openText(l)}: no page read said it.`) : null,
          h('div', null, h('h6', null, 'What Closer found'), h('p', { class: 'sub', style: { margin: 0 } }, l.findings || l.need || 'Nothing yet.')),
          l.email || l.website || l.contactOther ? h('div', { class: 'sub' }, l.email ? 'Mail: ' + l.email + ' · ' : '', l.website ? h('a', { href: l.website, target: '_blank', rel: 'noopener noreferrer' }, l.website.replace(/^https?:\/\//, '')) : '', (() => { const u = (l.contactOther.match(/https?:\/\/\S+/) || [])[0]; return u ? [' · ', h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, 'contact page')] : ''; })()) : null,
          l.sources.length ? h('div', { class: 'srcs' }, h('h6', null, 'Sources'), l.sources.map((s, i) => h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.url }, `${i + 1} · ${s.title}`))) : null,
          h('div', null, h('h6', null, 'Draft'), dr ? h('div', { class: 'stack', style: { gap: '6px' } },
            h('div', { class: 'row' }, h('b', { style: { flex: 1, minWidth: 0 } }, dr.channel === 'email' ? dr.subject : `${CHANNEL[dr.channel]}: copy and paste`), pill(...(STATUS[dr.status] || [dr.status]))),
            h('div', { class: 'draft', style: { whiteSpace: 'pre-wrap' } }, dr.body),
            h('div', { class: 'sub' }, `${dr.label ? 'Written by ' + dr.label : ''}${dr.note ? ' · ' + dr.note : ''}${dr.channel !== 'email' ? ' · for pasting, cannot be sent from here' : dr.to ? ' · to ' + dr.to : ' · no address yet'}`)) : h('p', { class: 'sub', style: { margin: 0 } }, 'No draft yet.')),
          h('div', { class: 'row' },
            // a draft with no address cannot be sent: the button opens the edit box with the To field ready instead
            dr && dr.status !== 'sent' && dr.channel === 'email' ? (dr.to || l.email ? btn('Approve and send', { onClick: () => approveSend(dr) }) : btn('Add an address', { onClick: () => editDraft(dr, { focusTo: true }) })) : null,
            dr && dr.status !== 'sent' ? btn('Edit', { kind: 'ghost', onClick: () => editDraft(dr) }) : null,
            dr ? btn('Copy text', { kind: dr.channel === 'email' ? 'ghost' : '', onClick: () => copy(dr.channel === 'email' ? `Subject: ${dr.subject}\n\n${dr.body}` : dr.body) }) : btn('Draft outreach', { onClick: () => draftFor(l.id) }),
            next ? btn('Move on', { kind: 'ghost', title: 'Move to ' + next[1], onClick: () => move(l.id, next[0]) }) : null),
          h('div', { class: 'row' }, h('label', { class: 'sub' }, 'Move ', sel), h('span', { class: 'grow' }), btn('Edit lead', { kind: 'ghost sm', onClick: () => leadDialog(l) }), btn('Remove', { kind: 'ghost sm', onClick: () => removeLead(l) })),
          h('div', { class: 'timeline' }, h('h6', null, 'Timeline'), h('div', { class: 'tl' }, ui.spinner()))].filter(Boolean));
        api(`m/sales/leads/${l.id}`).then(r => { const tl = det.querySelector('.tl'); if (tl) tl.replaceChildren(...(r.activity.length ? r.activity.map(a => ui.line(a.text, `${a.who} · ${fmt.when(a.at)}`)) : [h('span', { class: 'sub' }, 'Nothing yet.')])); }).catch(() => {});
      }

      const inCrm = (l) => (st.data.crmLeads || []).includes(l.id);
      async function addToCrm(l, b) {
        b.disabled = true;
        try { const r = await api(`m/sales/crm/from-lead/${l.id}`, { method: 'POST' }); toast(r.already ? `${l.company} is already in the CRM` : `${r.company.name} added to Companies${r.contact ? ' and Contacts' : ''}`, 'ok'); await load(); crmTabs.refresh(); }
        catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }
      async function move(id, stage) { try { await api(`m/sales/leads/${id}/move`, { body: { stage } }); await load(); } catch (e) { toast(e.message, 'err'); } }
      async function draftFor(id) { try { const r = await api('m/sales/draft', { body: { leadIds: [id] } }); toast(r.text || 'Writing the draft'); } catch (e) { toast(e.message, 'err'); } }
      async function approveSend(dr) {
        try { if (await confirmAndSend(ui, dr.id)) setTimeout(load, 600); }
        catch (e) { toast(e.message, 'err'); load().catch(() => {}); }
      }
      function editDraft(dr, { focusTo = false } = {}) {
        const subj = h('input', { type: 'text', value: dr.subject, style: { width: '100%' } });
        const to = h('input', { type: 'email', value: dr.to || leadById(dr.leadId)?.email || '', placeholder: 'Address (optional)', style: { width: '100%' } });
        const body = h('textarea', { rows: 10 }, dr.body);
        ui.modal({ title: 'Edit draft', wide: true, body: h('div', { class: 'stack' }, dr.channel === 'email' ? h('label', { class: 'f' }, 'To', to) : null, dr.channel === 'email' ? h('label', { class: 'f' }, 'Subject', subj) : null, h('label', { class: 'f' }, 'Text', body)),
          actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => { try { await api(`m/sales/drafts/${dr.id}`, { method: 'PATCH', body: dr.channel === 'email' ? { subject: subj.value, body: body.value, to: to.value } : { body: body.value } }); await load(); } catch (e) { toast(e.message, 'err'); return false; } } }] });
        if (focusTo && dr.channel === 'email') setTimeout(() => to.focus(), 50);
      }
      async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } catch { ui.modal({ title: 'Copy text', body: h('textarea', { rows: 10 }, text), actions: [{ label: 'Close' }] }); } }
      async function removeLead(l) { if (!(await ui.confirm(`Remove ${l.company} and its drafts?`, { ok: 'Remove', kind: 'stop' }))) return; try { await api(`m/sales/leads/${l.id}`, { method: 'DELETE' }); st.pick = null; await load(); } catch (e) { toast(e.message, 'err'); } }
      function leadDialog(l = null) {
        const cur = ui.state.settings?.currency || '';
        const f = (label, key, v = '', type = 'text') => { const i = h('input', { type, value: v ?? '', style: { width: '100%' }, dataset: { key } }); return h('label', { class: 'f' }, label, i); };
        const box = h('div', { class: 'stack' }, f('Company', 'company', l?.company), f('Contact name', 'contactName', l?.contactName), f('Role', 'contactRole', l?.contactRole), f('Mail address', 'email', l?.email, 'email'),
          f(cur ? `Value (${cur})` : 'Value', 'value', l?.value == null ? '' : String(l.value / 100), 'number'), f('Need', 'need', l?.need), f('Next step', 'nextStep', l?.nextStep), l ? null : f('Source address (optional)', 'source', '', 'url'));
        ui.modal({ title: l ? 'Edit lead' : 'Add lead', body: box, actions: [{ label: 'Cancel' }, { label: l ? 'Save' : 'Add', kind: '', onClick: async () => {
          const v = Object.fromEntries([...box.querySelectorAll('input')].map(i => [i.dataset.key, i.value.trim()]));
          if (!v.company) { toast('A lead needs a company name.', 'err'); return false; }
          const body = { company: v.company, contactName: v.contactName, contactRole: v.contactRole, email: v.email, need: v.need, nextStep: v.nextStep, valueMinor: v.value === '' ? null : Math.round(Number(v.value) * 100), currency: l?.currency || cur || undefined };
          if (!l && v.source) body.sources = [{ title: v.source, url: v.source }];
          try { const r = l ? await api(`m/sales/leads/${l.id}`, { method: 'PATCH', body }) : await api('m/sales/leads', { body }); st.pick = r.lead.id; await load(); } catch (e) { toast(e.message, 'err'); return false; }
        } }] });
      }
      function offerDialog() {
        const t = h('textarea', { rows: 4, placeholder: 'For example: We build PLC panels and retrofit packaging lines for mid-size plants in Maharashtra.' }, st.data.offer || '');
        ui.modal({ title: 'What you sell', body: h('div', { class: 'stack' }, h('span', { class: 'sub' }, 'Closer writes drafts from this and from what the pages said. Without it, drafts leave a gap for you to fill.'), t),
          actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => { try { const r = await api('m/sales/offer', { body: { offer: t.value } }); st.data.offer = r.offer; toast('Saved', 'ok'); } catch (e) { toast(e.message, 'err'); return false; } } }] });
      }
      function findDialog() {
        if (ui.state.settings?.online === false) { ui.modal({ title: 'Find leads', body: 'The desk is offline. Finding leads needs the internet.', actions: [{ label: 'Close' }] }); return; }
        if (!st.data.searchOn) { ui.modal({ title: 'Find leads', body: 'Search is switched off, so Closer cannot look on the web. Switch on Search in Settings › Modules, or add a lead by hand.', actions: [{ label: 'Close' }] }); return; }
        const q = h('textarea', { rows: 3, placeholder: 'For example: companies in Pune that make packaging machines' });
        const n = h('input', { type: 'number', value: '20', min: '1', max: '50' });
        ui.modal({ title: 'Find leads', body: h('div', { class: 'stack' }, h('label', { class: 'f' }, 'Who are you looking for?', q), h('label', { class: 'f' }, 'How many', n), h('span', { class: 'sub' }, 'Closer searches several ways, reads the pages and keeps only companies a page names. Nothing is sent.')),
          actions: [{ label: 'Cancel' }, { label: 'Start search', kind: '', onClick: async () => { if (!q.value.trim()) return false; try { const r = await api('m/sales/find', { body: { query: q.value.trim(), count: Number(n.value) || 20 } }); if (!r.ok) toast(r.text, 'err'); else { st.job = r.jobId; jobLine.textContent = 'Finding leads…'; } } catch (e) { toast(e.message, 'err'); } } }] });
      }

      ui.on('sales', (d) => { if (d?.change === 'crm') st.crmDirty = true; clearTimeout(st.t); st.t = setTimeout(() => { load().catch(() => {}); if (st.crmDirty) { st.crmDirty = false; crmTabs.refresh(); } }, 250); });
      ui.on('job', (j) => { if (!j || !String(j.kind || '').startsWith('sales.')) return; jobLine.textContent = j.status === 'running' ? `${j.title.split(':')[0]}: ${j.detail || ''}` : j.status === 'done' ? '' : `${j.title.split(':')[0]}: ${j.status}`; if (j.status !== 'running') load().catch(() => {}); });
      ui.on('modules', () => load().catch(() => {}));
      await load();
    },
  },
};

// Chat cards for Sales drafts. An email draft: "Approve and send" asks for the approval only on that press and resolves it
// with the same click. Any other channel is copy-only: the text and a Copy button; nothing can send it.
export const chatCards = {
  'sales.draft': (c, ui) => {
    const { h, btn, pill, api, toast } = ui;
    const state = pill(c.copyOnly ? 'Copy only' : 'Waiting for you', c.copyOnly ? '' : 'wait');
    const copy = async () => { const text = c.copyOnly ? c.body : `Subject: ${c.subject}\n\n${c.body}`; try { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } catch { ui.modal({ title: 'Copy text', body: h('textarea', { rows: 10 }, text), actions: [{ label: 'Close' }] }); } };
    const addr = () => (c.to && c.to !== 'no address yet' ? c.to : '');
    const toLine = h('div', { class: 'sub', style: { marginTop: '4px' } });
    const paintTo = () => toLine.replaceChildren([addr() ? 'To ' + addr() : 'No address yet', c.subject].filter(Boolean).join(' · '));
    // a draft with no address cannot be sent: "Add an address" opens its edit box with the To field ready
    const addAddress = () => {
      const to = h('input', { type: 'email', value: '', placeholder: 'name@company.com', style: { width: '100%' } });
      const subj = h('input', { type: 'text', value: c.subject || '', style: { width: '100%' } });
      const body = h('textarea', { rows: 10 }, c.body || '');
      ui.modal({ title: 'Edit draft', wide: true, body: h('div', { class: 'stack' }, h('label', { class: 'f' }, 'To', to), h('label', { class: 'f' }, 'Subject', subj), h('label', { class: 'f' }, 'Text', body)),
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => {
          if (!to.value.trim()) { toast('Write an address first.', 'err'); return false; }
          try { const r = await api(`m/sales/drafts/${c.draftId}`, { method: 'PATCH', body: { to: to.value.trim(), subject: subj.value, body: body.value } }); Object.assign(c, { to: r.draft.to, subject: r.draft.subject, body: r.draft.body, noAddress: !r.draft.to }); bodyEl.textContent = c.body; paintTo(); paintActs(); } catch (e) { toast(e.message, 'err'); return false; }
        } }] });
      setTimeout(() => to.focus(), 50);
    };
    const send = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      // the card can be stale (edited in Sales or Mail): repaint it from the stored draft before the confirm
      const fresh = (d, s) => { if (!s) return; if (s.to !== addr() || s.subject !== c.subject || s.body !== c.body) { Object.assign(c, { to: s.to, subject: s.subject, body: s.body, noAddress: !s.to }); bodyEl.textContent = c.body; paintTo(); paintActs(); } };
      try { if (!(await confirmAndSend(ui, c.draftId, { onFresh: fresh }))) { b.disabled = false; return; } state.textContent = 'Approved'; setTimeout(async () => { try { const s = await api('m/sales/state'); const d = s.drafts.find(x => x.id === c.draftId); if (d) state.textContent = d.status === 'sent' ? 'Sent' : d.note || d.status; } catch {} }, 900); }
      catch (x) { toast(x.message, 'err'); b.disabled = false; }
    };
    const bodyEl = h('div', { class: 'draft', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, c.body || '');
    const acts = h('div', { class: 'row', style: { marginTop: '8px' } });
    const paintActs = () => acts.replaceChildren(...[
      c.copyOnly ? null : addr() ? btn('Approve and send', { kind: 'sm', onClick: send }) : btn('Add an address', { kind: 'sm', onClick: addAddress }),
      btn('Copy text', { kind: c.copyOnly ? 'sm' : 'ghost sm', onClick: copy }),
      btn('Open Sales', { kind: 'ghost sm', onClick: () => ui.go('sales') })].filter(Boolean));
    if (!c.copyOnly) paintTo();
    paintActs();
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('b', null, c.title || 'Draft'), state),
      !c.copyOnly ? toLine : null,
      bodyEl,
      c.note ? h('div', { class: 'sub', style: { marginTop: '6px' } }, c.note) : null,
      acts);
  },
};
