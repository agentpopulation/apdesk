// Settings › Channels: Telegram (your own phone talking to the desk), ntfy pushes to your own phone, the other channels.
const API = 'm/channels';
const STATE_PILL = { listening: ['Listening', 'ok'], token_refused: ['Token not accepted', 'stop'], conflict: ['Busy elsewhere', 'stop'], unreachable: ['Retrying', 'wait'], offline: ['Offline', 'wait'], paused: ['Stopped by Panic', 'stop'], off: ['Paused', ''], needs_token: ['No token', ''], error: ['Stopped', 'stop'] };
const DRAFT_WORD = { waiting: ['Waiting for you', 'wait'], sent: ['Sent', 'ok'], denied: ['Declined', 'stop'], failed: ['Not sent', 'stop'], 'not sent': ['Not sent', ''] };

export const settings = {
  channels: { title: 'Channels and mail', async render(el, ui) {
    const { h, api, card, line, btn, toast, pill, sw, fmt, empty } = ui;
    const box = h('div', { class: 'stack' }); el.append(box);
    const post = async (p, body) => { try { const r = await api(`${API}${p}`, { body: body ?? {} }); return r; } catch (e) { toast(e.message, 'err'); return null; } };
    async function paint() {
      const [s, inbox, drafts] = await Promise.all([api(`${API}/status`), api(`${API}/inbox`), api(`${API}/drafts`)]);
      const t = s.telegram; const [pw, pk] = STATE_PILL[t.state] || [t.state, ''];
      const token = h('input', { type: 'password', placeholder: t.hasToken ? 'Saved. Paste a new one to replace it.' : 'Bot token from @BotFather', autocomplete: 'off', style: { minWidth: '300px' } });
      const agentSel = h('select', { onchange: (e) => post('/telegram/settings', { agentId: e.target.value }) }, ui.state.agents.map(a => h('option', { value: a.id, selected: a.id === t.agentId }, a.name)));
      const apiBase = h('input', { type: 'text', value: t.apiBase, style: { minWidth: '260px' }, onchange: async (e) => { await post('/telegram/settings', { apiBase: e.target.value }); paint(); } });
      const allowIn = h('input', { type: 'text', placeholder: 'Chat number', style: { width: '160px' } });
      const strangers = inbox.items.filter(i => !i.allowed); const mine = inbox.items.filter(i => i.allowed);
      const n = s.ntfy;
      box.replaceChildren(
        card(h('div', { class: 'row' }, h('h3', null, 'Telegram'), pill(pw, pk), h('span', { class: 'grow' }), t.hasToken ? sw(t.enabled, 'Receive messages', async (on) => { await post('/telegram/settings', { enabled: on }); paint(); }) : null),
          h('p', { class: 'sub' }, 'Talk to your desk from your phone. Only your own chat is answered; anyone else is listed below and never answered.'),
          line('Status', t.line),
          line('Bot token', t.hasToken ? 'Saved in the key store' : 'Make a bot with @BotFather in Telegram and paste its token', token, btn('Save', { kind: 'sm', onClick: async () => { await post('/telegram/token', { token: token.value }); paint(); } }), t.hasToken ? btn('Check again', { kind: 'ghost sm', onClick: async () => { await post('/telegram/check'); paint(); } }) : null, t.hasToken ? btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm('Remove the bot token?', { ok: 'Remove' })) { await post('/telegram/token', { token: '' }); paint(); } } }) : null),
          line('Your chats', t.allowed.length ? t.allowed.map(c => `chat ${c}`).join(', ') : 'None yet. Send your bot a message from your phone; it shows below, then press "This is me".', allowIn, btn('Allow', { kind: 'ghost sm', onClick: async () => { await post('/telegram/allow', { chatId: allowIn.value.trim() }); paint(); } }), ...t.allowed.map(c => btn(`Remove ${c}`, { kind: 'ghost sm', onClick: async () => { await post('/telegram/allow', { chatId: c, allow: false }); paint(); } }))),
          line('Who answers', 'The agent your messages go to', agentSel),
          line('Telegram address', 'Leave as it is unless you run your own Bot API server', apiBase)),
        card(h('div', { class: 'row' }, h('h3', null, 'Messages received'), h('span', { class: 'grow' }), strangers.length ? btn('Clear the unknown ones', { kind: 'ghost sm', onClick: async () => { await post('/inbox/clear'); paint(); } }) : null),
          inbox.items.length ? inbox.items.slice(0, 20).map(i => i.allowed
            ? line(`You · ${i.firstLine}`, `${fmt.when(i.at)} · ${i.status}${i.label ? ' · answered by ' + i.label : ''}`)
            : line(`${i.sender} · not on your list`, `${fmt.when(i.at)} · "${i.firstLine}" · chat ${i.chatId} · not answered, not read by any agent`, btn('This is me', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm(`Allow chat ${i.chatId}? Its messages will be answered by your desk. Only do this for your own Telegram account.`, { ok: 'Allow' })) { await post('/telegram/allow', { chatId: i.chatId }); paint(); } } })))
            : empty('No messages yet.')),
        card(h('h3', null, 'Messages to other people'), h('p', { class: 'sub' }, 'Agents can draft a Telegram message to someone else. It goes out only after you approve that one message.'),
          drafts.items.length ? drafts.items.slice(0, 20).map(d => { const [w, k] = DRAFT_WORD[d.status] || [d.status, '']; return line(`${d.channelName} to ${d.toName || d.to}`, `${fmt.when(d.created)} · "${d.text.slice(0, 120)}"${d.note ? ' · ' + d.note : ''}`, pill(w, k), d.status === 'waiting' ? btn('Review', { kind: 'sm', onClick: () => ui.openApprovals() }) : null, ['not sent', 'denied', 'failed'].includes(d.status) ? btn('Ask again', { kind: 'ghost sm', onClick: async () => { await post(`/drafts/${d.id}/again`); paint(); } }) : null, d.status !== 'waiting' ? btn('Discard', { kind: 'ghost sm', onClick: async () => { await post(`/drafts/${d.id}/discard`); paint(); } }) : null); }) : empty('No drafts.')),
        card(h('div', { class: 'row' }, h('h3', null, 'Phone pushes (ntfy)'), pill(n.on ? 'On' : 'Off', n.on ? 'ok' : ''), h('span', { class: 'grow' }), sw(n.on, 'Phone pushes', async (on) => { await post('/ntfy', { on }); paint(); })),
          h('p', { class: 'sub' }, 'A short push to your own phone when a job finishes or something waits for you. Install the ntfy app and subscribe to your topic. Anyone who knows the topic name can read the pushes, so keep it to yourself.'),
          line('Your topic', n.topic ? n.topic : 'Made when you switch pushes on', n.topic ? btn('New topic', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm('Make a new topic? Your phone has to subscribe again.', { ok: 'New topic' })) { await post('/ntfy', { newTopic: true }); paint(); } } }) : null),
          line('Server', 'ntfy.sh, or your own', h('input', { type: 'text', value: n.server, onchange: async (e) => { await post('/ntfy', { server: e.target.value }); paint(); } })),
          line('When a job finishes', '', sw(n.jobs, 'Jobs', (on) => post('/ntfy', { jobs: on }))),
          line('When something waits for you', '', sw(n.waiting, 'Waiting', (on) => post('/ntfy', { waiting: on }))),
          h('div', { class: 'row' }, btn('Send a test push', { kind: 'ghost sm', disabled: !n.topic, onClick: async () => { const r = await post('/ntfy/test'); if (r) toast(r.ok ? 'Sent to your topic.' : r.error, r.ok ? 'ok' : 'err'); } }))),
        card(h('h3', null, 'Other channels'), ...s.others.map(o => line(o.name, 'Not built in this version.', pill('Not built')))),
      );
    }
    await paint();
    ui.on('channel', () => paint().catch(() => {}));
  } },
};
