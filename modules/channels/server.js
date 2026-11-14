// Channels (module 20): the owner talks to his own desk from Telegram, and gets ntfy pushes on his own phone topic.
// Anything meant for another person is a draft plus a `send.person` approval; send() asserts the grant right before it sends.
import crypto from 'node:crypto';
import { telegramClient, cleanApiBase, tokenRefused, TELEGRAM_API } from './telegram.js';
import { ntfyPush, cleanServerUrl, randomTopic, validTopic, NTFY_SERVER } from './ntfy.js';

export const OTHERS = [
  { id: 'whatsapp', name: 'WhatsApp' }, { id: 'discord', name: 'Discord' }, { id: 'slack', name: 'Slack' }, { id: 'teams', name: 'Microsoft Teams' },
];
const NAMES = { telegram: 'Telegram', ntfy: 'ntfy', whatsapp: 'WhatsApp', discord: 'Discord', slack: 'Slack', teams: 'Microsoft Teams' };
const uid = (p) => p + crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();
const firstLine = (t) => String(t || '').split(/\r?\n/).find(x => x.trim())?.trim().slice(0, 120) || '(no text)';
const err = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

export async function activate(ctx) {
  const { db, kv } = ctx;
  db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_channels_inbox (id TEXT PRIMARY KEY, channel TEXT, chat_id TEXT, sender TEXT, first_line TEXT, allowed INTEGER, status TEXT, label TEXT, at TEXT);
    CREATE TABLE IF NOT EXISTS m_channels_drafts (id TEXT PRIMARY KEY, channel TEXT, to_ TEXT, to_name TEXT, text TEXT, agent_id TEXT, chat_id TEXT, approval_id TEXT, status TEXT, note TEXT, created TEXT, updated TEXT);`);
  let alive = true;

  // ---------------- settings (kv) and the token (secrets)
  const tgSet = () => ({
    enabled: kv.get('telegram.enabled', true), allowed: (kv.get('telegram.allowed', []) || []).map(String), agentId: kv.get('telegram.agentId', 'coordinator'),
    apiBase: kv.get('telegram.apiBase', TELEGRAM_API), pollTimeout: Math.max(1, Math.min(50, Number(kv.get('telegram.pollTimeout', 25)) || 25)),
  });
  const tg = { state: 'needs_token', line: 'Paste your bot token to start.', bot: null, at: null };
  const setTg = (state, line, extra = {}) => { const changed = tg.state !== state || tg.line !== line; Object.assign(tg, { state, line, at: now(), ...extra }); if (changed) ctx.events.emit('channel', { telegram: { state, line } }); };
  const client = () => telegramClient({ fetch: (u, i) => ctx.fetch(u, i), token: ctx.secrets.get('telegram.token'), base: tgSet().apiBase });

  // ---------------- Telegram long polling. Stops on deactivate; pauses while Panic is on (ctx.fetch refuses then).
  let poll = null;   // { ac, done }
  function stopPolling() { if (poll) { poll.ac.abort('stopped'); poll = null; } }
  function startPolling() {
    stopPolling();
    if (!ctx.secrets.has('telegram.token')) return setTg('needs_token', 'Paste your bot token to start.');
    if (!tgSet().enabled) return setTg('off', 'Telegram is paused. Switch it on to receive messages.');
    const ac = new AbortController();
    poll = { ac, done: pollLoop(ac.signal).catch((e) => { ctx.log('telegram loop', e.message); setTg('error', 'Telegram stopped after an error. Press Check again.'); }) };
  }
  async function checkToken(signal) {
    let me;
    try { me = await client().getMe(signal); }
    catch (e) { if (e.code === 'halted') return setTg('paused', 'Stopped by Panic. Press Resume.'); if (e.code === 'offline') return setTg('offline', 'The desk is offline.'); return setTg('unreachable', 'Telegram could not be reached. Trying again.'); }
    if (tokenRefused(me)) { setTg('token_refused', 'Token not accepted: Telegram refused this bot token. Paste it again from BotFather.', { bot: null }); return false; }
    if (!me.ok) { setTg('unreachable', `Telegram answered ${me.status}. Trying again.`); return null; }
    tg.bot = { username: me.result?.username || null, name: me.result?.first_name || null };
    return true;
  }
  async function pollLoop(signal) {
    let backoff = 2000; let checked = false;
    while (!signal.aborted && alive) {
      if (ctx.panic.halted) { setTg('paused', 'Stopped by Panic. Press Resume to listen again.'); await sleep(3000, signal); continue; }
      if (!checked) {
        const ok = await checkToken(signal);
        if (signal.aborted) break;
        if (ok === false) return;                                       // token refused: stop, do not spin
        if (!ok) { await sleep(backoff, signal); backoff = Math.min(backoff * 2, 60000); continue; }
        await client().deleteWebhook(signal).catch(() => {});           // polling and a webhook cannot both run
        checked = true;
      }
      let r;
      try { r = await client().getUpdates({ offset: kv.get('telegram.offset', 0), timeout: tgSet().pollTimeout }, signal); }
      catch (e) { if (signal.aborted) break; if (e.code === 'halted' || ctx.panic.halted) continue; setTg(e.code === 'offline' ? 'offline' : 'unreachable', e.code === 'offline' ? 'The desk is offline.' : 'Telegram could not be reached. Trying again.'); await sleep(backoff, signal); backoff = Math.min(backoff * 2, 60000); continue; }
      if (tokenRefused(r)) return setTg('token_refused', 'Token not accepted: Telegram refused this bot token. Paste it again from BotFather.');
      if (r.status === 409) return setTg('conflict', "Another program is reading this bot's messages. Stop it, or use another bot.");
      if (!r.ok) { setTg('unreachable', `Telegram answered ${r.status}. Trying again.`); await sleep(backoff, signal); backoff = Math.min(backoff * 2, 60000); continue; }
      backoff = 2000;
      setTg('listening', tg.bot?.username ? `Listening as @${tg.bot.username}` : 'Listening');
      for (const u of r.result || []) {
        kv.set('telegram.offset', Number(u.update_id) + 1);              // saved before handling: a restart never handles one twice
        try { await handleUpdate(u); } catch (e) { ctx.log('telegram update', e.message); }
      }
    }
  }

  // ---------------- inbound
  const turns = new Set();
  async function handleUpdate(u) {
    const m = u?.message; if (!m || !m.chat) return;
    const chatId = String(m.chat.id);
    const sender = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || (m.from?.username ? '@' + m.from.username : m.chat.title || 'Someone');
    const text = String(m.text || m.caption || '');
    const set = tgSet();
    // Only the owner's own private chat on the allow-list is read by a model and answered. Groups never are.
    const allowed = m.chat.type === 'private' && set.allowed.includes(chatId);
    const rowId = uid('in_');
    db.run('INSERT INTO m_channels_inbox (id, channel, chat_id, sender, first_line, allowed, status, label, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rowId, 'telegram', chatId, sender.slice(0, 80), firstLine(text), allowed ? 1 : 0, allowed ? 'answering' : 'not answered', null, now());
    ctx.events.emit('channel', { inbox: true });
    if (!allowed) return;                                                // never answered, never shown to a model
    if (!text.trim()) return db.run("UPDATE m_channels_inbox SET status = 'no text to answer' WHERE id = ?", rowId);
    const p = ctx.jobs.start({
      kind: 'channels.telegram', title: 'Your Telegram message', agentId: set.agentId, input: { chars: text.length },
      run: async (job) => {
        job.progress(0.2, 'Thinking');
        const a = await answer(text, set.agentId, job.signal);
        job.progress(0.8, 'Replying on Telegram');
        await replyToOwnChat(chatId, `${a.text}\n\n— ${a.label}`, job.signal);
        db.run("UPDATE m_channels_inbox SET status = 'answered', label = ? WHERE id = ?", a.label, rowId);
        ctx.events.emit('channel', { inbox: true });
        return { answeredBy: a.label, via: a.via };
      },
    }).catch((e) => { db.run('UPDATE m_channels_inbox SET status = ? WHERE id = ?', 'not answered: ' + e.message.slice(0, 80), rowId); });
    turns.add(p); p.finally(() => turns.delete(p));
  }
  async function answer(text, agentId, signal) {
    const chat = ctx.modules.api('chat');
    if (chat?.ask) {
      const r = await chat.ask({ text, agentId, chatId: kv.get('telegram.deskChat', undefined) || undefined });
      if (r?.chatId) kv.set('telegram.deskChat', r.chatId);
      return { text: String(r?.text || '').trim() || '(no answer)', label: r?.label || 'unknown model', via: 'chat' };
    }
    const sys = ctx.agents.systemPrompt ? ctx.agents.systemPrompt(agentId, 'The owner is writing to you from Telegram on his phone. Answer briefly, in plain text without tables.') : 'Answer briefly, in plain text.';
    const r = await ctx.model.chat({ agentId, purpose: 'chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: text }], signal });
    return { text: String(r.text || '').trim() || '(no answer)', label: r.label, via: 'model' };
  }
  /** The reply to the owner's own allowed chat. Refuses any chat that is not on the allow-list. */
  async function replyToOwnChat(chatId, text, signal) {
    if (!tgSet().allowed.includes(String(chatId))) throw err('That chat is not on your allow-list.', 403);
    const r = await client().sendMessage(chatId, text, signal);
    if (tokenRefused(r)) { setTg('token_refused', 'Token not accepted: Telegram refused this bot token.'); throw err('Telegram did not accept the token.'); }
    if (!r.ok) throw err(`Telegram did not take the reply (${r.status}).`, 502);
    return r;
  }

  // ---------------- outbound to other people: draft -> approval -> send
  const draftOut = (r) => r && ({ id: r.id, channel: r.channel, channelName: NAMES[r.channel] || r.channel, to: r.to_, toName: r.to_name, text: r.text, agentId: r.agent_id, chatId: r.chat_id, approvalId: r.approval_id, status: r.status, note: r.note, created: r.created, updated: r.updated });
  const getDraft = (id) => draftOut(db.get('SELECT * FROM m_channels_drafts WHERE id = ?', id));
  const setDraft = (id, status, note = null) => { db.run('UPDATE m_channels_drafts SET status = ?, note = ?, updated = ? WHERE id = ?', status, note, now(), id); ctx.events.emit('channel', { draft: id, status }); };

  /** What the owner approves for one message, built the same way for the request and right before the send. */
  const sendPayload = ({ channel, to, toName = null, text, draftId = null }) => ({ channel: NAMES[channel] || channel, to: String(to ?? ''), toName: toName || null, text: String(text ?? ''), draftId });

  /** send({ channel, to, text, approvalId, toName?, draftId? }): the only door out to another person. */
  async function send({ channel, to, toName = null, text, approvalId, draftId = null, signal } = {}) {
    if (channel !== 'telegram') throw err(`${NAMES[channel] || 'That channel'} sending is not built in this version.`, 409);
    if (!to || !String(text || '').trim()) throw err('A send needs who it goes to and the text.');
    if (!ctx.secrets.has('telegram.token')) throw err('No Telegram bot token is saved.', 409);
    ctx.approval.assertGranted(approvalId, 'send.person', sendPayload({ channel, to, toName, text, draftId }));   // right before the send; that one item, single use
    const r = await client().sendMessage(String(to), String(text), signal);
    if (tokenRefused(r)) throw err('Telegram did not accept the token.', 502);
    if (!r.ok) throw err(`Telegram did not deliver it: ${r.description || r.status}.`, 502);
    return { ok: true, channel, to: String(to) };
  }

  function askApproval(id) {
    const d = getDraft(id);
    const title = `Send a ${d.channelName} message to ${d.toName || d.to}`;
    const pending = ctx.approval.request({ agentId: d.agentId, chatId: d.chatId, action: 'send.person', title, detail: 'Channels', payload: sendPayload({ channel: d.channel, to: d.to, toName: d.toName, text: d.text, draftId: d.id }) });
    const ap = ctx.approval.listPending().filter(a => a.payload?.draftId === d.id).pop();
    db.run('UPDATE m_channels_drafts SET approval_id = ?, status = ?, note = NULL, updated = ? WHERE id = ?', ap?.id || null, 'waiting', now(), id);
    ctx.events.emit('channel', { draft: id, status: 'waiting' });
    pending.then(async (dec) => {
      if (!alive) return;
      if (!dec.ok) return setDraft(id, dec.reason === 'denied' ? 'denied' : 'not sent', { denied: 'You said no.', timeout: 'No answer within a day.', halted: 'Stopped by Panic.', aborted: 'Cancelled.' }[dec.reason] || dec.reason);
      try { const cur = getDraft(id); await send({ channel: cur.channel, to: cur.to, toName: cur.toName, text: cur.text, draftId: cur.id, approvalId: dec.id }); setDraft(id, 'sent', 'Sent after your approval.'); }
      catch (e) { setDraft(id, 'failed', e.code === 'not_granted' ? 'Not sent: the message changed after you were asked. Ask again to approve the new text.' : e.message); }
    });
    return ap?.id || null;
  }
  function createDraft({ channel = 'telegram', to, toName, text, agentId = null, chatId = null }) {
    channel = String(channel || 'telegram').toLowerCase();
    if (!NAMES[channel] || channel === 'ntfy') throw err('Drafts can go to Telegram. The other channels are not built in this version.');
    if (!to || !String(text || '').trim()) throw err('A draft needs who it is for and the text.');
    const id = uid('cd_'); const t = now();
    db.run('INSERT INTO m_channels_drafts (id, channel, to_, to_name, text, agent_id, chat_id, approval_id, status, note, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
      id, channel, String(to).slice(0, 80), toName ? String(toName).slice(0, 80) : null, String(text).slice(0, 4000), agentId, chatId, 'waiting', t, t);
    const approvalId = askApproval(id);
    const d = getDraft(id);
    if (chatId) ctx.chatCard(chatId, { kind: 'draft', title: `${d.channelName} message`, to: d.toName || d.to, subject: null, body: d.text, approvalId, actions: [] });
    return d;
  }
  // after a restart the core expires waiting approvals: mark those drafts so the owner can ask again
  const pendingIds = new Set(ctx.approval.listPending().map(a => a.id));
  for (const r of db.all("SELECT id, approval_id FROM m_channels_drafts WHERE status = 'waiting'")) if (!pendingIds.has(r.approval_id)) setDraft(r.id, 'not sent', 'The desk restarted before you decided. Ask again to send it.');

  ctx.tool({
    name: 'channel_draft',
    description: 'Draft a message to another person on a messaging channel (Telegram). Nothing is sent: the owner sees the draft and approves or declines it. Use `to` = the Telegram chat id of the person.',
    parameters: { type: 'object', properties: { channel: { type: 'string', enum: ['telegram'] }, to: { type: 'string', description: 'Telegram chat id' }, toName: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] },
    async run(args, call) { const d = createDraft({ ...args, agentId: call?.agentId, chatId: call?.chatId }); return { ok: true, draft: d.id, status: 'Waiting for the owner to approve. Nothing has been sent.' }; },
  });

  // ---------------- ntfy: pushes to the owner's own topic only
  const ntfySet = () => ({ on: kv.get('ntfy.on', false), server: kv.get('ntfy.server', NTFY_SERVER), topic: kv.get('ntfy.topic', ''), jobs: kv.get('ntfy.jobs', true), waiting: kv.get('ntfy.waiting', true) });
  async function notify(text, { title = 'AP Desk', tags = 'robot', force = false } = {}) {
    const s = ntfySet();
    if (!force && !s.on) return { ok: false, error: 'Phone pushes are off.' };
    if (!validTopic(s.topic)) return { ok: false, error: 'No topic yet.' };
    return ntfyPush({ fetch: (u, i) => ctx.fetch(u, i), server: s.server, topic: s.topic, token: ctx.secrets.get('ntfy.token'), title, text, tags });
  }
  const told = new Set();
  const offEvents = ctx.events.on((type, data) => {
    const s = ntfySet(); if (!s.on || !alive) return;
    if (type === 'job' && s.jobs && data?.id && ['done', 'failed'].includes(data.status) && !told.has(data.id + data.status)) {
      told.add(data.id + data.status); if (told.size > 500) told.clear();
      notify(data.status === 'done' ? `Done: ${data.title}` : `Failed: ${data.title}`, { tags: data.status === 'done' ? 'white_check_mark' : 'warning' }).catch(() => {});
    }
    if (type === 'approval' && s.waiting && data?.status === 'pending' && data.id && !told.has(data.id)) { told.add(data.id); notify(`Waiting for you: ${data.title}`, { tags: 'bell' }).catch(() => {}); }
  });

  // ---------------- routes
  const owner = (arg) => { if (!arg.owner) throw err('Only the owner at this desk can change channels.', 403); };
  const status = (isOwner) => {
    const s = tgSet(); const n = ntfySet();
    return {
      telegram: { state: tg.state, line: tg.line, bot: tg.bot, hasToken: ctx.secrets.has('telegram.token'), enabled: s.enabled, allowed: s.allowed, agentId: s.agentId, apiBase: s.apiBase, custom: s.apiBase !== TELEGRAM_API },
      ntfy: { on: n.on, server: n.server, topic: isOwner ? n.topic : (n.topic ? 'set' : ''), jobs: n.jobs, waiting: n.waiting, hasToken: ctx.secrets.has('ntfy.token') },
      others: OTHERS.map(o => ({ ...o, state: 'not built in this version' })),
    };
  };
  ctx.route('GET', '/status', (req, res, arg) => ctx.json(res, status(arg.owner)));
  ctx.route('POST', '/telegram/token', async (req, res, arg) => {
    owner(arg); const token = String(arg.body?.token || '').trim();
    if (!token) { ctx.secrets.set('telegram.token', null); stopPolling(); setTg('needs_token', 'Paste your bot token to start.', { bot: null }); return ctx.json(res, status(true)); }
    if (token.length > 200 || /\s/.test(token)) throw err('That does not look like a bot token.');
    ctx.secrets.set('telegram.token', token); kv.set('telegram.offset', 0); tg.bot = null;
    const ac = new AbortController(); setTimeout(() => ac.abort(), 15000);
    const ok = await checkToken(ac.signal);
    if (ok) startPolling();
    ctx.json(res, status(true));
  });
  ctx.route('POST', '/telegram/check', async (req, res, arg) => { owner(arg); const ok = await checkToken(); if (ok) startPolling(); ctx.json(res, status(true)); });
  ctx.route('POST', '/telegram/settings', (req, res, arg) => {
    owner(arg); const b = arg.body || {};
    if (b.apiBase !== undefined) kv.set('telegram.apiBase', cleanApiBase(b.apiBase));
    if (b.allowed !== undefined) kv.set('telegram.allowed', [...new Set((Array.isArray(b.allowed) ? b.allowed : String(b.allowed).split(/[\s,]+/)).map(x => String(x).trim()).filter(x => /^-?\d{1,20}$/.test(x)))]);
    if (b.agentId !== undefined && ctx.agents.get(String(b.agentId))) kv.set('telegram.agentId', String(b.agentId));
    if (b.pollTimeout !== undefined) kv.set('telegram.pollTimeout', Number(b.pollTimeout) || 25);
    if (b.enabled !== undefined) kv.set('telegram.enabled', !!b.enabled);
    if (b.apiBase !== undefined || b.enabled !== undefined) startPolling();
    ctx.json(res, status(true));
  });
  ctx.route('POST', '/telegram/allow', (req, res, arg) => {
    owner(arg); const id = String(arg.body?.chatId || ''); if (!/^-?\d{1,20}$/.test(id)) throw err('That is not a chat number.');
    const list = new Set(tgSet().allowed); if (arg.body?.allow === false) list.delete(id); else list.add(id);
    kv.set('telegram.allowed', [...list]); ctx.json(res, status(true));
  });
  ctx.route('GET', '/inbox', (req, res) => ctx.json(res, { items: db.all('SELECT * FROM m_channels_inbox ORDER BY at DESC LIMIT 100').map(r => ({ id: r.id, channel: r.channel, chatId: r.chat_id, sender: r.sender, firstLine: r.first_line, allowed: !!r.allowed, status: r.status, label: r.label, at: r.at })) }));
  ctx.route('POST', '/inbox/clear', (req, res, arg) => { owner(arg); db.run('DELETE FROM m_channels_inbox WHERE allowed = 0'); ctx.json(res, { ok: true }); });
  ctx.route('GET', '/drafts', (req, res) => ctx.json(res, { items: db.all('SELECT * FROM m_channels_drafts ORDER BY created DESC LIMIT 100').map(draftOut) }));
  ctx.route('POST', '/drafts', (req, res, arg) => { owner(arg); ctx.json(res, createDraft({ ...(arg.body || {}), agentId: null })); });
  ctx.route('POST', '/drafts/:id/again', (req, res, arg) => { owner(arg); const d = getDraft(arg.params.id); if (!d) throw err('No such draft.', 404); if (d.status === 'sent') throw err('This one was sent already.', 409); askApproval(d.id); ctx.json(res, getDraft(d.id)); });
  ctx.route('POST', '/drafts/:id/edit', (req, res, arg) => {
    owner(arg); const d = getDraft(arg.params.id); if (!d) throw err('No such draft.', 404); if (d.status === 'sent') throw err('This one was sent already.', 409);
    const text = String(arg.body?.text || '').trim(); if (!text) throw err('The message needs some text.');
    db.run('UPDATE m_channels_drafts SET text = ?, updated = ? WHERE id = ?', text.slice(0, 4000), now(), d.id);
    ctx.events.emit('channel', { draft: d.id }); ctx.json(res, getDraft(d.id));
  });
  ctx.route('POST', '/drafts/:id/discard', (req, res, arg) => { owner(arg); db.run('DELETE FROM m_channels_drafts WHERE id = ? AND status != ?', arg.params.id, 'waiting'); ctx.json(res, { ok: true }); });
  // A direct send: refused unless approvalId is a granted, unused send.person approval.
  ctx.route('POST', '/send', async (req, res, arg) => {
    try { ctx.json(res, await send(arg.body || {})); }
    catch (e) { ctx.json(res, { ok: false, error: e.code === 'not_granted' ? 'Refused: you have not approved this send.' : e.message }, e.code === 'not_granted' ? 403 : (e.status || 500)); }
  });
  ctx.route('POST', '/ntfy', (req, res, arg) => {
    owner(arg); const b = arg.body || {};
    if (b.server !== undefined) kv.set('ntfy.server', cleanServerUrl(b.server));
    if (b.newTopic || (b.on && !validTopic(kv.get('ntfy.topic', '')))) kv.set('ntfy.topic', randomTopic());
    for (const k of ['on', 'jobs', 'waiting']) if (b[k] !== undefined) kv.set('ntfy.' + k, !!b[k]);
    if (b.token !== undefined) ctx.secrets.set('ntfy.token', String(b.token || '').trim() || null);
    ctx.json(res, status(true));
  });
  ctx.route('POST', '/ntfy/test', async (req, res, arg) => { owner(arg); ctx.json(res, await notify('A test push from your desk.', { force: true, title: 'Desk test' })); });

  ctx.expose({ send, notify, draft: (d) => createDraft(d), status: () => status(false) });
  startPolling();

  return {
    async deactivate() {
      alive = false; stopPolling(); offEvents?.();
      await Promise.race([Promise.allSettled([...turns]), sleep(2000)]);
    },
    _test: { handleUpdate, tg },
  };
}
