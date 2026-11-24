// Settings › Channels: Telegram (your own phone talking to the desk), ntfy pushes to your own phone, the other channels.
const API = 'm/channels';
const STATE_PILL = { listening: ['Listening', 'ok'], token_refused: ['Token not accepted', 'stop'], conflict: ['Busy elsewhere', 'stop'], unreachable: ['Retrying', 'wait'], offline: ['Offline', 'wait'], paused: ['Stopped by Panic', 'stop'], off: ['Paused', ''], needs_token: ['No token', ''], error: ['Stopped', 'stop'] };
const DRAFT_WORD = { waiting: ['Waiting for you', 'wait'], sent: ['Sent', 'ok'], denied: ['Declined', 'stop'], failed: ['Not sent', 'stop'], 'not sent': ['Not sent', ''] };

export const settings = {
  channels: { title: 'Channels and mail', async render(el, ui) {
    const { h, api, card, line, btn, toast, pill, sw, fmt, empty, needs } = ui;
    const box = h('div', { class: 'stack' }); el.append(box);
    const post = async (p, body) => { try { const r = await api(`${API}${p}`, { body: body ?? {} }); return r; } catch (e) { toast(e, 'err'); return null; } };
    // a press that changes something says so only after the desk did it; a failure has already said why
    const done = async (p, body, words) => { const r = await post(p, body); if (r) toast(words, 'ok'); paint(); return r; };
    // a change that saves by itself answers back: a tick beside the field when the page stays as it is, a toast when it repaints
    const say = async (p, body) => { const r = await post(p, body); if (r) toast('Saved.', 'ok'); return r; };
    async function paint() {
      const [s, inbox, drafts] = await Promise.all([api(`${API}/status`), api(`${API}/inbox`), api(`${API}/drafts`)]);
      const t = s.telegram; const [pw, pk] = STATE_PILL[t.state] || [t.state, ''];
      const token = h('input', { type: 'password', placeholder: t.hasToken ? 'Saved. Paste a new one to replace it.' : 'Bot token from @BotFather', autocomplete: 'off', style: { minWidth: '300px' } });
      const agentMark = ui.savedMark();
      const agentSel = h('select', { onchange: (e) => agentMark.run(() => api(`${API}/telegram/settings`, { body: { agentId: e.target.value } }), { field: e.target, old: t.agentId }) }, ui.state.agents.map(a => h('option', { value: a.id, selected: a.id === t.agentId }, ui.agentLine ? ui.agentLine(a) : a.name)));
      const apiMark = ui.savedMark();
      const apiBase = h('input', { type: 'text', value: t.apiBase, style: { minWidth: '260px' }, onchange: (e) => apiMark.run(() => api(`${API}/telegram/settings`, { body: { apiBase: e.target.value } }), { field: e.target, old: t.apiBase }) });
      const allowIn = h('input', { type: 'text', placeholder: 'Chat number', style: { width: '160px' } });
      const strangers = inbox.items.filter(i => !i.allowed); const mine = inbox.items.filter(i => i.allowed);
      const n = s.ntfy; const jobsMark = ui.savedMark(), waitMark = ui.savedMark(), serverMark = ui.savedMark();
      box.replaceChildren(
        card(h('div', { class: 'row' }, h('h3', null, 'Telegram'), pill(pw, pk), h('span', { class: 'grow' }), t.hasToken ? sw(t.enabled, 'Receive messages', async (on) => { await say('/telegram/settings', { enabled: on }); paint(); }) : null),
          h('p', { class: 'sub' }, 'Talk to your desk from your phone. Only your own chat is answered; anyone else is listed below and never answered.'),
          line('Status', t.line),
          line('Bot token', t.hasToken ? 'Saved in the key store' : 'Make a bot with @BotFather in Telegram and paste its token', token, btn('Save', { kind: 'sm', onClick: async () => { if (!token.value.trim()) return needs(token, 'Type a token first.'); if (await post('/telegram/token', { token: token.value })) { toast('Token saved.', 'ok'); } paint(); } }), t.hasToken ? btn('Check again', { kind: 'ghost sm', onClick: async () => { await post('/telegram/check'); paint(); } }) : null, t.hasToken ? btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm('Remove the bot token?', { ok: 'Remove' })) await done('/telegram/token', { remove: true }, 'Token removed.'); } }) : null),
          line('Your chats', t.allowed.length ? t.allowed.map(c => `chat ${c}`).join(', ') : 'None yet. Send your bot a message from your phone; it shows below, then press "This is me".', allowIn, btn('Allow', { kind: 'ghost sm', onClick: async () => { if (!allowIn.value.trim()) return needs(allowIn, 'Type the chat number first.'); if (await post('/telegram/allow', { chatId: allowIn.value.trim() })) toast('Chat allowed.', 'ok'); paint(); } }), ...t.allowed.map(c => btn(`Remove ${c}`, { kind: 'ghost sm', onClick: () => done('/telegram/allow', { chatId: c, allow: false }, 'Chat removed.') }))),
          line('Who answers', 'The agent your messages go to', agentSel, agentMark),
          line('Telegram address', 'Leave as it is unless you run your own Bot API server', apiBase, apiMark)),
        card(h('div', { class: 'row' }, h('h3', null, 'Messages received'), h('span', { class: 'grow' }), strangers.length ? btn('Clear the unknown ones', { kind: 'ghost sm', onClick: () => done('/inbox/clear', {}, 'Cleared.') }) : null),
          inbox.items.length ? inbox.items.slice(0, 20).map(i => i.allowed
            ? line(`You · ${i.firstLine}`, `${fmt.when(i.at)} · ${i.status}${i.label ? ' · answered by ' + i.label : ''}`)
            : line(`${i.sender} · not on your list`, `${fmt.when(i.at)} · "${i.firstLine}" · chat ${i.chatId} · not answered, not read by any agent`, btn('This is me', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm(`Allow chat ${i.chatId}? Its messages will be answered by your desk. Only do this for your own Telegram account.`, { ok: 'Allow' })) await done('/telegram/allow', { chatId: i.chatId }, 'Chat allowed.'); } })))
            : empty('No messages yet.')),
        card(h('h3', null, 'Messages to other people'), h('p', { class: 'sub' }, 'Agents can draft a Telegram message to someone else. It goes out only after you approve that one message.'),
          drafts.items.length ? drafts.items.slice(0, 20).map(d => { const [w, k] = DRAFT_WORD[d.status] || [d.status, '']; return line(`${d.channelName} to ${d.toName || d.to}`, `${fmt.when(d.created)} · "${d.text.slice(0, 120)}"${d.note ? ' · ' + d.note : ''}`, pill(w, k), d.status === 'waiting' ? btn('Review', { kind: 'sm', onClick: () => ui.openApprovals() }) : null, ['not sent', 'denied', 'failed'].includes(d.status) ? btn('Ask again', { kind: 'ghost sm', onClick: () => done(`/drafts/${d.id}/again`, {}, 'Asked again. It waits for your approval.') }) : null, d.status !== 'waiting' ? btn('Discard', { kind: 'ghost sm', onClick: () => done(`/drafts/${d.id}/discard`, {}, 'Discarded.') }) : null); }) : empty('No drafts.')),
        card(h('div', { class: 'row' }, h('h3', null, 'Phone pushes (ntfy)'), pill(n.on ? 'On' : 'Off', n.on ? 'ok' : ''), h('span', { class: 'grow' }), sw(n.on, 'Phone pushes', async (on) => { await say('/ntfy', { on }); paint(); })),
          h('p', { class: 'sub' }, 'A short push to your own phone when a job finishes or something waits for you. Install the ntfy app and subscribe to your topic. Anyone who knows the topic name can read the pushes, so keep it to yourself.'),
          line('Your topic', n.topic ? n.topic : 'Made when you switch pushes on', n.topic ? btn('New topic', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm('Make a new topic? Your phone has to subscribe again.', { ok: 'New topic' })) await done('/ntfy', { newTopic: true }, 'New topic made. Subscribe to it on your phone.'); } }) : null),
          line('Server', 'ntfy.sh, or your own', h('input', { type: 'text', value: n.server, onchange: (e) => serverMark.run(() => api(`${API}/ntfy`, { body: { server: e.target.value } }), { field: e.target, old: n.server }) }), serverMark),
          line('When a job finishes', '', sw(n.jobs, 'Jobs', (on) => jobsMark.run(() => api(`${API}/ntfy`, { body: { jobs: on } }))), jobsMark),
          line('When something waits for you', '', sw(n.waiting, 'Waiting', (on) => waitMark.run(() => api(`${API}/ntfy`, { body: { waiting: on } }))), waitMark),
          h('div', { class: 'row' }, btn('Send a test push', { kind: 'ghost sm', disabled: !n.topic, onClick: async () => { const r = await post('/ntfy/test'); if (r) toast(r.ok ? 'Sent to your topic.' : r.error, r.ok ? 'ok' : 'err'); } }))),
        card(h('h3', null, 'Other channels'), ...s.others.map(o => line(o.name, 'Not built in this version.', pill('Not built')))),
      );
    }
    await paint();
    ui.on('channel', () => paint().catch(() => {}));
  } },
};
