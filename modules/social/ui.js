// Social: the drafts board. Write (or let the model write), rewrite per network, approve each post.
const API = 'm/social';
const LANES = [['draft', 'Drafts'], ['waiting', 'Waiting for you'], ['approved', 'Approved'], ['posted', 'Posted']];
const laneOf = (s) => s === 'declined' || s === 'failed' ? 'draft' : s;
const STATUS_WORD = { draft: 'Draft', waiting: 'Waiting for you', approved: 'Approved', posted: 'Posted', declined: 'Declined', failed: 'Not posted' };

export const pages = {
  social: { title: 'Social', async render(view, ui) {
    const { h, api, btn, toast, fmt, card } = ui;
    let nets = []; let drafts = [];
    const netSel = h('select', { 'aria-label': 'Network' });
    const brief = h('textarea', { placeholder: 'What is the post about? For example: we moved our racks to edge sites in three cities; what we learned.', style: { minHeight: '120px' } });
    const link = h('input', { type: 'text', placeholder: 'Link (optional)', style: { width: '100%' } });
    const status = h('span', { class: 'sub' });
    const board = h('div', { class: 'board', style: { flex: '1', minHeight: '0', alignItems: 'stretch', gridTemplateColumns: 'repeat(4,minmax(200px,1fr))' } });
    const busy = async (b, fn) => { b.disabled = true; const t = b.textContent; b.textContent = 'Working…'; try { await fn(); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; b.textContent = t; } };
    const writeBtn = btn('Write it with the model', { onClick: () => busy(writeBtn, async () => { const d = await api(`${API}/drafts/write`, { body: { network: netSel.value, brief: brief.value, link: link.value || undefined } }); status.textContent = `Written by ${d.label}${d.cut ? ' · cut to fit' : ''}`; await load(); }) });
    const saveBtn = btn('Save as typed', { kind: 'ghost', onClick: () => busy(saveBtn, async () => { await api(`${API}/drafts`, { body: { network: netSel.value, text: brief.value, link: link.value || undefined } }); brief.value = ''; status.textContent = 'Saved.'; await load(); }) });
    view.append(
      h('div', { class: 'row' }, h('h2', null, 'Social'), h('span', { class: 'sub' }, 'Nothing is posted until you approve that post.'), h('span', { class: 'grow' }), btn('Accounts', { kind: 'ghost sm', onClick: () => ui.go('settings', 'social') })),
      h('div', { style: { display: 'grid', gridTemplateColumns: '320px minmax(0,1fr)', gap: '14px', flex: '1', minHeight: '0' } },
        card({ class: 'stack', style: { alignSelf: 'start' } }, h('h3', null, 'New post'), h('div', { class: 'row' }, h('span', { class: 'sub' }, 'For'), netSel), brief, link, h('div', { class: 'row' }, writeBtn, saveBtn), status),
        board));

    const rewriteSel = (d) => { const s = h('select', { 'aria-label': 'Rewrite for', onchange: async () => { if (!s.value) return; const v = s.value; s.disabled = true; try { const r = await api(`${API}/drafts/${d.id}/rewrite`, { body: { network: v } }); toast(`Rewritten for ${r.networkName} by ${r.label}`, 'ok'); await load(); } catch (e) { toast(e.message, 'err'); s.disabled = false; s.value = ''; } } }, h('option', { value: '' }, 'Rewrite for…'), nets.filter(n => n.id !== d.network).map(n => h('option', { value: n.id }, n.name))); return s; };
    const approve = async (d) => {
      const ok = await ui.confirm(h('div', { class: 'stack' }, h('div', { class: 'draft', style: { whiteSpace: 'pre-wrap', maxHeight: '40vh', overflow: 'auto' } }, d.text), h('p', { class: 'sub' }, d.connected ? `It goes out from your connected ${d.networkName} account.` : `No ${d.networkName} account is connected: it is marked approved and you post it yourself.`)), { title: `Post this to ${d.networkName}?`, ok: d.connected ? 'Approve and post' : 'Approve' });
      if (!ok) return;
      try { const r = await api(`${API}/drafts/${d.id}/approve`, { method: 'POST' }); if (r.approvalId) await ui.decide(r.approvalId, 'approve'); setTimeout(load, 400); } catch (e) { toast(e.message, 'err'); }
    };
    const edit = async (d) => { const t = await ui.ask(`Edit the ${d.networkName} post`, { value: d.text, multiline: true }); if (t == null) return; try { await api(`${API}/drafts/${d.id}/edit`, { body: { text: t } }); await load(); } catch (e) { toast(e.message, 'err'); } };
    const copy = async (d) => { try { await navigator.clipboard.writeText(d.text); toast('Copied.', 'ok'); } catch { toast('The browser did not allow copying. Select the text instead.', 'err'); } };
    const draftCard = (d) => {
      const over = d.chars > d.limit;
      return h('div', { class: 'card', style: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { class: 'row' }, ui.pill(d.networkName, d.status === 'posted' ? 'ok' : d.status === 'waiting' ? 'wait' : ''), d.status === 'declined' || d.status === 'failed' ? ui.pill(STATUS_WORD[d.status], 'stop') : null, h('span', { class: 'grow' }), h('span', { class: 'sub' }, fmt.when(d.updated))),
        h('div', { class: 'draft', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '180px', overflow: 'auto' } }, d.text),
        h('div', { class: 'sub' }, `${d.chars} of ${d.limit} characters${over ? ' · too long' : ''}${d.label ? ' · written by ' + d.label : ' · typed by you'}`),
        d.note ? h('div', { class: 'sub' }, d.note) : null,
        d.postedUrl ? h('a', { href: d.postedUrl, target: '_blank', rel: 'noopener noreferrer', class: 'sub' }, 'Open the post') : null,
        h('div', { class: 'row' },
          ['draft', 'declined', 'failed'].includes(d.status) ? [btn(d.connected ? 'Approve and post' : 'Approve', { kind: 'sm', onClick: () => approve(d) }), btn('Edit', { kind: 'ghost sm', onClick: () => edit(d) }), rewriteSel(d)] : null,
          d.status === 'waiting' ? btn('Review', { kind: 'sm', onClick: () => ui.openApprovals() }) : null,
          d.status === 'approved' ? [btn('Copy text', { kind: 'sm', onClick: () => copy(d) }), h('a', { class: 'btn ghost sm', style: { textDecoration: 'none' }, href: d.openUrl, target: '_blank', rel: 'noopener noreferrer' }, `Open ${d.networkName}`), btn('I posted it', { kind: 'ghost sm', onClick: async () => { await api(`${API}/drafts/${d.id}/mark-posted`, { method: 'POST' }); load(); } })] : null,
          d.status !== 'waiting' ? btn('Discard', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm('Discard this draft?', { ok: 'Discard' })) { await api(`${API}/drafts/${d.id}/discard`, { method: 'POST' }); load(); } } }) : null));
    };
    const paint = () => board.replaceChildren(...LANES.map(([id, title]) => { const items = drafts.filter(d => laneOf(d.status) === id); return h('div', { class: 'lane', style: { minHeight: '0', overflow: 'auto' } }, h('header', null, title, h('span', null, String(items.length))), items.length ? items.map(draftCard) : h('div', { class: 'sub', style: { padding: '4px' } }, id === 'draft' ? 'Write a post on the left, or ask an agent in Chat.' : 'Nothing here.')); }));
    async function load() { try { drafts = (await api(`${API}/drafts`)).items; paint(); } catch (e) { toast(e.message, 'err'); } }
    nets = (await api(`${API}/networks`)).networks;
    netSel.replaceChildren(...nets.map(n => h('option', { value: n.id }, `${n.name} · up to ${n.limit} characters`)));
    await load();
    ui.on('social', () => load()); ui.on('approval', () => setTimeout(load, 300));
  } },
};

export const settings = {
  social: { title: 'Social accounts', async render(el, ui) {
    const { h, api, card, line, btn, toast, pill } = ui;
    const nets = (await api(`${API}/networks`)).networks;
    const box = h('div', { class: 'stack' }); el.append(box);
    const paint = (list) => box.replaceChildren(
      card(h('h3', null, 'Posting from the desk'), h('p', { class: 'sub' }, 'Each post still waits for your approval. Keys are kept in the desk’s key store and never shown again.'),
        ...list.filter(n => n.connectable).map(n => {
          const inputs = n.fields.map(f => h('input', { type: /secret|password|token/i.test(f.key) ? 'password' : 'text', placeholder: f.label, 'aria-label': f.label, 'data-k': f.key, autocomplete: 'off' }));
          return h('div', { class: 'stack', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
            h('div', { class: 'row' }, h('b', null, n.name), n.connected ? pill('Connected', 'ok') : pill('Not connected'), h('span', { class: 'grow' }), n.connected ? btn('Disconnect', { kind: 'ghost sm', onClick: async () => { await api(`${API}/connect/${n.id}`, { body: { disconnect: true } }); reload(); } }) : null),
            h('span', { class: 'sub' }, n.help), h('div', { class: 'row' }, inputs, btn('Connect', { kind: 'sm', onClick: async () => { const b = {}; inputs.forEach(i => { if (i.value.trim()) b[i.dataset.k] = i.value.trim(); }); try { const r = await api(`${API}/connect/${n.id}`, { body: b }); toast(r.connected ? `${n.name} keys saved. Not tried yet: the first approved post uses them.` : 'Some keys are still missing.', r.connected ? 'ok' : 'err'); reload(); } catch (e) { toast(e.message, 'err'); } } })));
        })),
      card(h('h3', null, 'You post these yourself'), h('p', { class: 'sub' }, 'Posting from the desk is not built for these. Approve the draft, then Copy text and Open the site.'),
        ...list.filter(n => !n.connectable).map(n => line(n.name, `Up to ${n.limit} characters`, pill('Copy and post')))));
    const reload = async () => paint((await api(`${API}/networks`)).networks);
    paint(nets);
  } },
};
