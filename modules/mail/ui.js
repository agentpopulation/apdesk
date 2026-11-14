// Mail page (Inbox, Drafts, Sent, Allowed senders) and the "Mail accounts" settings section.
const STATUS = { waiting: ['Waiting for you', 'wait'], approved: ['Approved, not sent', 'wait'], sent: ['Sent', 'ok'], 'not sent': ['Not sent', 'stop'] };
let tab = 0;

/**
 * "Approve and send": fetch the draft as stored now, show all of what will be sent (To, subject, full body); only that
 * confirm's "Send" approves, posting back the shown values (the server refuses if the draft changed since).
 * Returns the decided approval row, or null when the owner cancels; throws when nothing was approved.
 */
export async function confirmAndSend(ui, draftId) {
  const { h, api } = ui;
  const s = (await api(`m/mail/drafts/${draftId}`)).send;
  if (!s.to.trim()) throw new Error('This draft has no address yet. Add an address first.');
  const shown = h('div', { class: 'stack' }, h('div', null, h('b', null, 'To: '), s.to), h('div', null, h('b', null, 'Subject: '), s.subject), h('div', { class: 'draft', style: { whiteSpace: 'pre-wrap' } }, s.body));
  if (!(await ui.confirm(shown, { ok: 'Send', title: 'Send this mail?' }))) return null;
  const p = await api(`m/mail/drafts/${draftId}/send`, { body: { to: s.to, subject: s.subject, body: s.body } });
  const row = p.approvalId ? await ui.decide(p.approvalId, 'approve') : null;
  if (row?.status !== 'approved') throw new Error('The draft changed. Look at it again.');
  return row;
}

export const pages = {
  mail: {
    title: 'Mail',
    async render(el, ui) {
      const { h, btn, pill, api, toast, fmt } = ui;
      el.style.overflow = 'hidden';
      const seg = ui.seg(['Inbox', 'Drafts', 'Sent', 'Allowed senders'], tab, (o, i) => { tab = i; paint(); });
      const body = h('div', { class: 'card', style: { flex: '1', minHeight: '0', overflow: 'auto' } });
      const head = h('div', { class: 'row' }, h('h2', null, 'Mail'), seg, h('span', { class: 'grow' }), btn('Check mail', { kind: 'ghost', onClick: fetchMail }), btn('New draft', { onClick: () => compose() }));
      el.replaceChildren(head, body);
      let s = null;
      async function load() { s = await api('m/mail/state'); paint(); }
      function paint() {
        if (!s) return;
        if (!s.accounts.length && tab < 3) { body.replaceChildren(ui.empty('No mail account yet.'), h('div', { class: 'row', style: { justifyContent: 'center' } }, btn('Add a mail account', { onClick: () => ui.go('settings', 'mail') }))); if (tab !== 1) return; }
        if (tab === 0) {
          body.replaceChildren(...(s.inbox.length ? s.inbox.map(m => ui.line(m.subject || '(no subject)', `${m.name || m.from} · ${fmt.when(m.date)}${m.allowed ? '' : ' · not an allowed sender: agents do not read it'}`,
            m.allowed ? btn('Read', { kind: 'ghost sm', onClick: () => ui.modal({ title: m.subject || '(no subject)', wide: true, body: h('div', { class: 'draft', style: { whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto' } }, m.text || ''), actions: [{ label: 'Close' }] }) }) : btn('Allow sender', { kind: 'ghost sm', onClick: () => allow(m.from) })))
            : [ui.empty('Press Check mail to read recent mail. Agents read only mail from allowed senders.')]));
        } else if (tab === 1) {
          body.replaceChildren(...(s.drafts.length ? s.drafts.map(d => { const [w, k] = STATUS[d.status] || [d.status, '']; return ui.line(`To ${d.to || 'no address'} · ${d.subject}`, `${d.source === 'mail' ? 'Draft' : 'From ' + d.source}${d.note ? ' · ' + d.note : ''} · ${fmt.when(d.created)}`, pill(w, k), btn('Review', { kind: 'ghost sm', onClick: () => review(d) })); })
            : [ui.empty('No drafts waiting.')]));
        } else if (tab === 2) {
          body.replaceChildren(...(s.sent.length ? s.sent.map(d => ui.line(`To ${d.to} · ${d.subject}`, `Sent ${fmt.when(d.sentAt)}${d.source !== 'mail' ? ' · from ' + d.source : ''}`, btn('Open', { kind: 'ghost sm', onClick: () => ui.modal({ title: d.subject, wide: true, body: h('div', { class: 'draft', style: { whiteSpace: 'pre-wrap' } }, `To: ${d.to}\n\n${d.body}`), actions: [{ label: 'Close' }] }) })))
            : [ui.empty('Nothing sent yet.')]));
        } else {
          const inp = h('input', { type: 'text', placeholder: 'name@company.com or @company.com', style: { flex: '1' } });
          body.replaceChildren(h('p', { class: 'sub' }, 'Agents read the text of mail only from these senders. Mail from anyone else is listed by sender and subject only.'),
            h('div', { class: 'row' }, inp, btn('Allow', { onClick: () => allow(inp.value) })),
            ...(s.allowed.length ? s.allowed.map(a => ui.line(a.address, `Added ${fmt.date(a.created)}`, btn('Remove', { kind: 'ghost sm', onClick: async () => { await api(`m/mail/allowed/${a.id}`, { method: 'DELETE' }); load(); } }))) : [ui.empty('No allowed senders yet.')]));
        }
      }
      async function allow(address) { try { await api('m/mail/allowed', { body: { address } }); toast('Allowed', 'ok'); load(); } catch (e) { toast(e.message, 'err'); } }
      async function fetchMail(e) { const b = e.currentTarget; b.disabled = true; try { await api('m/mail/inbox/fetch', { method: 'POST' }); tab = 0; seg.set(0); await load(); } catch (x) { toast(x.message, 'err'); } b.disabled = false; }
      function compose(d = null, { focusTo = false } = {}) {
        const to = h('input', { type: 'email', value: d?.to || '', style: { width: '100%' } }); if (focusTo) setTimeout(() => to.focus(), 50); const subj = h('input', { type: 'text', value: d?.subject || '', style: { width: '100%' } }); const txt = h('textarea', { rows: 10 }, d?.body || '');
        ui.modal({ title: d ? 'Edit draft' : 'New draft', wide: true, body: h('div', { class: 'stack' }, h('label', { class: 'f' }, 'To', to), h('label', { class: 'f' }, 'Subject', subj), h('label', { class: 'f' }, 'Text', txt), h('span', { class: 'sub' }, 'The draft waits for you. It is sent only when you press Approve and send.')),
          actions: [{ label: 'Cancel' }, { label: 'Save draft', kind: '', onClick: async () => { try { if (d) await api(`m/mail/drafts/${d.id}`, { method: 'PATCH', body: { to: to.value, subject: subj.value, body: txt.value } }); else await api('m/mail/drafts', { body: { to: to.value, subject: subj.value, body: txt.value } }); tab = 1; seg.set(1); load(); } catch (e) { toast(e.message, 'err'); return false; } } }] });
      }
      function review(d) {
        ui.modal({ title: d.subject, wide: true, body: h('div', { class: 'stack' }, h('div', { class: 'sub' }, `To ${d.to || 'no address'}`), h('div', { class: 'draft', style: { whiteSpace: 'pre-wrap', maxHeight: '50vh', overflow: 'auto' } }, d.body)),
          actions: [{ label: 'Delete', onClick: async () => { await api(`m/mail/drafts/${d.id}`, { method: 'DELETE' }); load(); } }, { label: 'Edit', onClick: () => { setTimeout(() => compose(d), 0); } },
            // a draft with no address cannot be sent: the button opens its edit box with the To field ready instead
            !d.to ? { label: 'Add an address', kind: '', onClick: () => { setTimeout(() => compose(d, { focusTo: true }), 0); } } : { label: 'Approve and send', kind: '', onClick: () => { setTimeout(async () => { try { if (await confirmAndSend(ui, d.id)) setTimeout(load, 800); } catch (e) { toast(e.message, 'err'); load(); } }, 0); } }] });
      }
      ui.on('mail', () => { clearTimeout(el._t); el._t = setTimeout(() => load().catch(() => {}), 200); });
      await load();
    },
  },
};

export const settings = {
  mail: {
    title: 'Mail accounts',
    async render(el, ui) {
      const { h, btn, api, toast } = ui;
      const s = await api('m/mail/state');
      const list = h('div', { class: 'card' }, h('h3', null, 'Mail accounts'), h('p', { class: 'sub' }, 'Passwords are kept in the desk\'s key store and never shown again. Google and Outlook sign-in (OAuth) is not built: use an app password.'),
        ...(s.accounts.length ? s.accounts.map(a => ui.line(a.email, `${s.providers[a.provider]?.label || 'Mailbox'} · sends via ${a.smtp.host}${a.imap.host ? ' · reads via ' + a.imap.host : ''}`,
          btn('Test', { kind: 'ghost sm', onClick: async () => { const r = await api(`m/mail/accounts/${a.id}/test`, { method: 'POST' }); toast(r.text, r.ok ? 'ok' : 'err'); } }),
          btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm(`Remove ${a.email}?`, { ok: 'Remove', kind: 'stop' })) { await api(`m/mail/accounts/${a.id}`, { method: 'DELETE' }); settings.mail.render(el, ui); } } }))) : [ui.empty('No account yet.')]));
      const prov = h('select', null, Object.entries(s.providers).map(([k, p]) => h('option', { value: k }, p.label)));
      const f = (label, type = 'text', v = '') => { const i = h('input', { type, value: v, style: { width: '100%' } }); return [h('label', { class: 'f' }, label, i), i]; };
      const [eL, email] = f('Mail address', 'email'); const [nL, name] = f('Your name on mail', 'text', ui.state.settings?.ownerName || ''); const [pL, pass] = f('App password', 'password');
      const [sL, smtp] = f('Sending server (SMTP)'); const [spL, sport] = f('Port', 'number'); const [iL, imap] = f('Reading server (IMAP)'); const note = h('p', { class: 'sub' });
      const fill = () => { const p = s.providers[prov.value]; smtp.value = p.smtp.host; sport.value = p.smtp.port; imap.value = p.imap.host; note.textContent = p.note; };
      prov.onchange = fill; fill();
      const add = h('div', { class: 'card stack' }, h('h3', null, 'Add an account'), h('label', { class: 'f' }, 'Provider', prov), note, eL, nL, pL, sL, spL, iL,
        h('div', { class: 'row' }, h('span', { class: 'grow' }), btn('Add account', { onClick: async () => { try { const p = s.providers[prov.value]; await api('m/mail/accounts', { body: { provider: prov.value, email: email.value, name: name.value, password: pass.value, smtp: { host: smtp.value, port: Number(sport.value), tls: Number(sport.value) === 465 ? 'ssl' : 'starttls' }, imap: { host: imap.value, port: p.imap.port, tls: 'ssl' } } }); toast('Account added', 'ok'); settings.mail.render(el, ui); } catch (e) { toast(e.message, 'err'); } } })));
      el.replaceChildren(h('div', { class: 'stack' }, list, add));
    },
  },
};
