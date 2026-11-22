// Chat and Coordinator: chats, messages, cards, the Coordinator turn, and the API other modules post into.
import fs from 'node:fs';
import path from 'node:path';
import { makeStore, SEED_GROUPS, EVERYONE, EVERYONE_LINE } from './store.js';
import { makeCoordinator, cardKey, RESEARCH_JOBS, deliverableFor, NOT_NOW } from './coordinator.js';
import { aboutOf, clipAbout, ABOUT_KEY, ASK_ABOUT, ASK_ABOUT_SITE, savedLine, siteAddressOf, siteProposal } from './business.js';
import { dropFileClaims, previewText, cutAtWord, bareStart, BARE_LINES, NEXT_LINE } from './ui-text.js';

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|js|mjs|ts|py|html?|css|xml|ya?ml|ini|log|sql|sh|bat|ps1|rtf)$/i;

export async function activate(ctx) {
  const store = makeStore(ctx);
  store.seed(ctx.kv.get('roomsHidden', []));
  const emit = (data) => ctx.events.emit('chat', data);
  const bus = {
    emit,
    emitMessage: (m) => m && emit({ type: 'message', chatId: m.chatId, message: m }),
    /** Post a card. A progress card with the same id (or the same job) updates in place wherever it is in the chat. */
    postCard(chatId, card, { into } = {}) {
      if (!card || typeof card !== 'object') return null;
      const chat = resolveChat(chatId); if (!chat) return null;
      card = { ...card, kind: typeof card.kind === 'string' ? card.kind : 'text' };
      if (card.kind === 'progress') {
        const hit = store.findProgress(chat.id, { id: card.id, jobId: card.jobId });
        if (hit) {
          const cards = hit.message.cards.slice(); cards[hit.index] = { ...cards[hit.index], ...card, id: cards[hit.index].id };
          const m = store.update(hit.message.id, { cards }); bus.emitMessage(m); return { chatId: chat.id, messageId: m.id, cardId: cards[hit.index].id };
        }
        if (!card.id) card.id = card.jobId ? 'job:' + card.jobId : 'p' + Math.random().toString(36).slice(2, 9);
      } else if (card.id || (card.kind === 'draft' && card.approvalId)) {
        // the same card posted again (a draft's state after the owner decided, a table that grew) updates in place
        const hit = store.findCard(chat.id, card);
        if (hit) { const cards = hit.message.cards.slice(); cards[hit.index] = { ...cards[hit.index], ...card }; const m = store.update(hit.message.id, { cards }); bus.emitMessage(m); return { chatId: chat.id, messageId: m.id, cardId: card.id || null }; }
      }
      let m = into ? store.message(into) : null;
      const same = m && card.kind === 'file' && card.path ? m.cards.findIndex(x => x && x.kind === 'file' && x.path === card.path) : -1;   // one card per file per reply
      if (m && m.chatId === chat.id && same >= 0) { const cards = m.cards.slice(); cards[same] = { ...cards[same], ...card }; m = store.update(m.id, { cards }); }
      else if (m && m.chatId === chat.id) m = store.update(m.id, { cards: [...m.cards, card] });
      else { m = store.add(chat.id, { role: 'assistant', agentId: card.agentId || 'coordinator', cards: [card], label: card.label || null }); store.touch(chat.id, card.title || card.text || ''); emit({ type: 'chats' }); }
      bus.emitMessage(m);
      return { chatId: chat.id, messageId: m.id, cardId: card.id || null };
    },
  };
  const resolveChat = (chatId) => {
    if (!chatId) return null;
    let c = store.chat(chatId);
    if (!c && String(chatId).startsWith('dm-') && ctx.agents.get(String(chatId).slice(3))) c = store.direct(String(chatId).slice(3));
    return c;
  };
  const co = makeCoordinator(ctx, store, bus);
  // Panic drops every wait for the owner's business text, as it stops everything else
  ctx.panic.onStop(() => { for (const c of store.list()) if (c.settings.awaitBusiness) store.setSettings(c.id, { awaitBusiness: null }); });
  const speakerOf = (c, forced) => forced && ctx.agents.get(forced) ? forced : co.speakerFor(c, '');
  /** A typed message that is plainly an ask of its own, not an answer about the business: a question, or an ask for leads,
   *  drafts or research (the same test that decides what such an ask must produce). Unsure: it is taken as the answer. */
  const ASK_TOOLS = [{ name: 'leads_find' }, { name: 'outreach_draft' }, { name: 'research_deep' }];
  const newAsk = (text) => /\?\s*$/.test(text) || !!deliverableFor(text, ASK_TOOLS);

  // Jobs that came from a chat keep their progress card current on the server, browser open or not. A job's output may carry
  // { cards: [...] } and/or { text } for the chat; those land in the same chat when it finishes.
  const offJobs = ctx.events.on((type, job) => {
    if (type !== 'job' || !job?.chatId || !job.id) return;
    try {
      const chat = resolveChat(job.chatId); if (!chat) return;
      let status = job.status === 'interrupted' ? 'stopped' : job.status;
      // a task whose own turn did not do what it was asked did not finish, whatever its job's runner recorded
      const unfinished = status === 'done' && job.kind === 'tasks.run' ? store.messages(chat.id, { limit: 60 }).find(m => m.meta?.jobOf === job.id && m.meta?.unfinished)?.meta.unfinished : null;
      if (unfinished) { status = 'failed'; job = { ...job, status: 'failed', error: unfinished }; }
      const hit = store.findProgress(chat.id, { jobId: job.id });
      if (!hit && !['running', 'waiting'].includes(status)) return finish(chat, job, null);
      bus.postCard(chat.id, { kind: 'progress', jobId: job.id, title: hit?.message.cards[hit.index].title || job.title, agentId: job.agentId, progress: job.progress ?? 0, detail: status === 'failed' ? (job.error || 'Failed') : job.detail || '', status }, { into: hit ? null : co.running.get(chat.id)?.replyId });
      if (!['running', 'waiting'].includes(status)) finish(chat, job, hit);
    } catch (e) { ctx.log('job card failed', e.message); }
  });
  const finished = new Set();
  /** Jobs whose output.text is a model's reply: a background task, a schedule's run (not a brief: its lines are built by code
   *  from the desk's records), a chain of agents. Every other job's text is built by its module's code. */
  const modelWrote = (job) => {
    if (!/^(?:tasks\.run|flows\.schedule|flows\.chain)$/.test(job.kind || '')) return false;
    if (job.kind !== 'flows.schedule') return true;
    try { return ctx.modules.api('flows')?.get?.(job.input?.scheduleId)?.kind !== 'brief'; } catch { return true; }
  };
  function finish(chat, job, hadCard) {
    if (job.status !== 'done' || finished.has(job.id)) return;
    finished.add(job.id);
    const out = job.output && typeof job.output === 'object' ? job.output : null;
    const cards = Array.isArray(out?.cards) ? out.cards.filter(c => c && typeof c === 'object') : [];
    const written = [...cards, ...(Array.isArray(out?.files) ? out.files : [])].map(c => c && (c.path || c.name)).filter(Boolean);
    // A model's text may not name files the job did not write. Text the desk built by code (a brief's lines, a lead search's
    // result line, a stored summary) is posted as it is.
    const raw = typeof out?.text === 'string' ? out.text : (typeof out?.summary === 'string' && !cards.length ? out.summary : '');
    const text = typeof out?.text === 'string' && modelWrote(job) ? dropFileClaims(raw, written).text : raw;
    if (!cards.length && !text) return;
    if (store.messages(chat.id, { limit: 60 }).some(m => m.meta?.jobResult === job.id)) return;   // already posted (restart)
    const m = store.add(chat.id, { role: 'assistant', agentId: job.agentId || 'coordinator', text, cards, label: out.label || null, meta: { jobResult: job.id } });
    store.touch(chat.id, text || job.title); bus.emitMessage(m); emit({ type: 'chats' });
  }

  /** The desk's first exchange has finished (an owner message answered by a reply that finished, in any chat). Kept in kv
   *  once true, so clearing messages does not make the desk new again; a desk from before the flag is read from its messages. */
  const deskStarted = () => { if (ctx.kv.get('chat.started', false)) return true; if (!store.exchanged()) return false; ctx.kv.set('chat.started', true); return true; };

  // ---------- how long answers should be: asked once by a card after the desk's third finished exchange (a chat the owner
  // typed in, never a job's or a schedule's turn); "Ask me later" brings it back once, ten exchanges on. The choice lives in
  // this module's kv; coordinator.js adds its line to every turn's system prompt.
  const LENGTHS = ['short', 'detailed'];
  const askState = () => ({ later: 0, mark: 0, open: null, ...(ctx.kv.get('answerAsk', null) || {}) });
  const openCard = (st) => {
    const m = st.open ? store.message(st.open.messageId) : null;
    const i = m ? m.cards.findIndex(c => c?.kind === 'answer-length' && c.state === 'ask') : -1;
    return i >= 0 ? { m, i } : null;
  };
  /** The open card turns into its one saved line, or goes. */
  const closeCard = (st, saved) => {
    const hit = openCard(st); if (!hit) return;
    const cards = hit.m.cards.slice(); if (saved) cards[hit.i] = { ...cards[hit.i], state: 'saved' }; else cards.splice(hit.i, 1);
    bus.emitMessage(store.update(hit.m.id, { cards }));
  };
  function offerLength(chat, reply) {
    if (reply?.status !== 'done' || ctx.kv.get('answerLength', null) || !deskStarted()) return;
    const st = askState(); if (st.later >= 2 || openCard(st)) return;
    if (store.exchanges(st.mark) < (st.later ? 10 : 3)) return;
    bus.postCard(chat.id, { kind: 'answer-length', state: 'ask' }, { into: reply.id });
    ctx.kv.set('answerAsk', { ...st, open: { chatId: chat.id, messageId: reply.id } });
  }
  ctx.route('GET', '/answer-length', (req, res) => ctx.json(res, { value: ctx.kv.get('answerLength', null) || null }));
  ctx.route('PUT', '/answer-length', (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can change this.' }, 403);
    const value = body && typeof body === 'object' && 'value' in body ? body.value : undefined;
    if (value !== null && !LENGTHS.includes(value)) return ctx.json(res, { error: 'Pick short or detailed.' }, 400);
    if (value) ctx.kv.set('answerLength', value); else ctx.kv.del('answerLength');
    // the owner has answered the question, here or in Settings: the card does not come back by itself
    const st = askState(); closeCard(st, !!value); ctx.kv.set('answerAsk', { ...st, open: null, later: 2 });
    ctx.json(res, { value: value || null });
  });
  ctx.route('POST', '/answer-length/later', (req, res, { owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can change this.' }, 403);
    const st = askState(); closeCard(st, false);
    const later = Math.min(2, st.later + 1);
    ctx.kv.set('answerAsk', { ...st, open: null, later, mark: store.lastId() });
    ctx.json(res, { ok: true, later });
  });

  const listChats = () => {
    for (const a of ctx.agents.list()) store.direct(a.id);
    return store.list().map(c => ({ ...c, running: co.running.has(c.id) }));
  };

  // ---------- the starting rooms follow the team: a room needs at least two of its own agents (besides the Coordinator) on.
  // The first-start step calls fitRooms once after the owner picked his team; a room it left out comes back by itself when
  // hiring makes two of its agents on again. A desk that never had a room left out is never changed here.
  const roomMembersOn = (g) => g.members.filter(id => id !== 'coordinator' && ctx.agents.get(id)).length;
  function fitRooms() {
    const hidden = new Set(ctx.kv.get('roomsHidden', []));
    for (const g of SEED_GROUPS) {
      if (!g.members || roomMembersOn(g) >= 2) continue;
      const c = store.chat(g.id); if (c && store.messages(g.id, { limit: 1 }).length) continue;   // a room in use stays
      if (c) store.remove(g.id); hidden.add(g.id);
    }
    // the own chat of an agent that is not on the team, never used, goes with it
    for (const c of store.list()) if (c.id.startsWith('dm-') && !ctx.agents.get(c.id.slice(3)) && !store.messages(c.id, { limit: 1 }).length) store.remove(c.id);
    ctx.kv.set('roomsHidden', [...hidden]); emit({ type: 'chats' });
    return { rooms: store.list().filter(c => SEED_GROUPS.some(g => g.id === c.id)).map(c => c.id) };
  }
  const offAgents = ctx.events.on((type, data) => {
    if (type !== 'agents' || data?.change !== 'create') return;
    const hidden = ctx.kv.get('roomsHidden', []); if (!hidden.length) return;
    const back = hidden.filter(id => { const g = SEED_GROUPS.find(x => x.id === id); return g && roomMembersOn(g) >= 2; });
    if (!back.length) return;
    const left = hidden.filter(id => !back.includes(id)); ctx.kv.set('roomsHidden', left); store.seed(left); emit({ type: 'chats' });
  });
  ctx.route('POST', '/rooms/fit', (req, res, { owner }) => owner ? ctx.json(res, fitRooms()) : ctx.json(res, { error: 'Only the owner at this desk can change this.' }, 403));

  // ---------- routes for the UI
  ctx.route('GET', '/chats', (req, res) => ctx.json(res, { chats: listChats(), started: deskStarted() }));
  ctx.route('POST', '/chats', (req, res, { body }) => ctx.json(res, store.create({ title: body?.title, members: body?.members })));
  ctx.route('GET', '/chats/:id', (req, res, { params }) => { const c = resolveChat(params.id); c ? ctx.json(res, { ...c, running: co.running.has(c.id) }) : ctx.json(res, { error: 'That chat is gone.' }, 404); });
  ctx.route('PATCH', '/chats/:id', (req, res, { params, body }) => {
    const c = resolveChat(params.id); if (!c) return ctx.json(res, { error: 'That chat is gone.' }, 404);
    if (body?.title != null) { store.rename(c.id, body.title); store.setSettings(c.id, { named: 'owner' }); }   // his own name stays
    if (body?.settings && typeof body.settings === 'object') { const p = {}; for (const k of ['deepResearch', 'swarm', 'remember']) if (k in body.settings) p[k] = body.settings[k]; if (['everyone', 'coordinator'].includes(body.settings.whoAnswers)) p.whoAnswers = body.settings.whoAnswers; store.setSettings(c.id, p); }
    emit({ type: 'chats' }); ctx.json(res, store.chat(c.id));
  });
  ctx.route('DELETE', '/chats/:id', (req, res, { params, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Chats are deleted from the desk itself.' }, 403);
    const c = store.chat(params.id); if (!c) return ctx.json(res, { ok: true });
    if (c.seeded && !c.id.startsWith('c')) { db_clear(c.id); emit({ type: 'chats' }); return ctx.json(res, { ok: true, cleared: true }); }
    co.stop(c.id); store.remove(c.id); emit({ type: 'chats' }); ctx.json(res, { ok: true });
  });
  const db_clear = (id) => { co.stop(id); ctx.db.run('DELETE FROM m_chat_messages WHERE chat_id = ?', id); store.touch(id, ''); };
  ctx.route('GET', '/chats/:id/messages', (req, res, { params, query }) => { const c = resolveChat(params.id); if (!c) return ctx.json(res, { error: 'That chat is gone.' }, 404); ctx.json(res, { chat: { ...c, running: co.running.has(c.id) }, messages: store.messages(c.id, { limit: Number(query.limit) || 200, after: Number(query.after) || 0 }) }); });
  ctx.route('GET', '/chats/:id/members', (req, res, { params }) => { const c = resolveChat(params.id); c ? ctx.json(res, { members: c.members, everyone: c.everyone }) : ctx.json(res, { error: 'That chat is gone.' }, 404); });
  ctx.route('PUT', '/chats/:id/members', (req, res, { params, body }) => {
    const c = resolveChat(params.id); if (!c) return ctx.json(res, { error: 'That chat is gone.' }, 404);
    if (c.id === EVERYONE) return ctx.json(res, { error: EVERYONE_LINE, code: 'everyone' }, 400);   // Everyone always holds every agent
    const everyone = body?.everyone === true;
    const members = everyone ? null : (Array.isArray(body?.members) ? [...new Set(body.members)].filter(id => ctx.agents.get(id)) : []);
    if (!everyone && !members.length) return ctx.json(res, { error: 'A chat needs at least one agent.' }, 400);
    if (!everyone && members.length > 1 && !members.includes('coordinator') && ctx.agents.get('coordinator')) members.unshift('coordinator');
    let n = store.setMembers(c.id, members);
    // a new group is named from its members until the owner renames it; it never takes another room's name
    if (!everyone && !c.seeded && n.members.length > 1 && (c.title === 'New chat' || c.settings.named === 'members')) {
      const who = n.members.filter(id => id !== 'coordinator').map(id => ctx.agents.get(id)?.name).filter(Boolean);
      if (who.length) { store.rename(c.id, who.length > 1 ? who.slice(0, -1).join(', ') + ' and ' + who.at(-1) : who[0]); n = store.setSettings(c.id, { named: 'members' }); }
    }
    const names = n.members.map(id => ctx.agents.get(id)?.name).filter(Boolean);
    const m = store.add(c.id, { role: 'system', text: `Now in this chat: ${names.join(', ')}. The conversation above stays.` });
    bus.emitMessage(m); emit({ type: 'chats' }); ctx.json(res, n);
  });
  ctx.route('POST', '/chats/:id/send', async (req, res, { params, body, owner }) => {
    const c = resolveChat(params.id); if (!c) return ctx.json(res, { error: 'That chat is gone.' }, 404);
    const text = String(body?.text || '').trim(); if (!text) return ctx.json(res, { error: 'Type a message first.' }, 400);
    if (co.running.has(c.id)) return ctx.json(res, { error: 'A reply is still coming in this chat. Stop it first.' }, 409);
    if (ctx.panic.halted) return ctx.json(res, { error: 'Everything is stopped. Press Resume first.', code: 'halted' }, 503);
    const bare = bareStart(text); if (bare) return ctx.json(res, { error: BARE_LINES[bare], code: 'empty_ask' }, 400);   // a side-panel prefix alone asks for nothing
    const first = !deskStarted();
    const chip = body?.chip === true;
    const waiting = c.settings.awaitBusiness;
    let p;
    const site = waiting && owner && !chip && !newAsk(text) ? siteAddressOf(text) : null;
    if (site) {
      // his answer is his website: the chat keeps waiting, the desk reads the site and proposes three lines; nothing is saved
      // until he presses "Save these" (or types his own line), which comes back here as his answer
      const um = store.add(c.id, { role: 'user', text, meta: { aboutSite: true } }); bus.emitMessage(um);
      const reply = store.add(c.id, { role: 'assistant', agentId: speakerOf(c, body?.agentId), text: '', status: 'streaming', meta: { aboutSite: site } }); bus.emitMessage(reply);
      // the read is this chat's reply: a second send waits for it, and Stop (or Panic) aborts it
      const ac = new AbortController(); co.running.set(c.id, { ac, replyId: reply.id });
      siteProposal(ctx, site, { signal: ac.signal, chatId: c.id }).catch(() => ({ ok: false, text: 'I could not read that site. ' + ASK_ABOUT }))
        .then((r) => {
          if (co.running.get(c.id)?.ac === ac) co.running.delete(c.id);
          // stopped, or the wait was dropped meanwhile: nothing is proposed into a chat that no longer waits
          const gone = ac.signal.aborted || !store.chat(c.id)?.settings.awaitBusiness;
          const m = gone ? store.update(reply.id, { text: 'Stopped. Nothing was read or saved.', cards: [], status: 'stopped' })
            : store.update(reply.id, { text: r.text, cards: r.ok ? r.cards : [NOT_NOW], status: 'done' });
          bus.emitMessage(m); store.touch(c.id, m.text); emit({ type: 'chats' });
        });
      return ctx.json(res, { ok: true, chatId: c.id, replyId: reply.id, asked: true });
    }
    if (waiting && owner) {
      // the chat waits for what the owner sells: his next message is that answer, unless it is plainly a new ask of its own
      // (a chip he pressed, an ask for leads, drafts or research, or a question)
      store.setSettings(c.id, { awaitBusiness: null });
      if (chip || newAsk(text)) p = co.send(c.id, text, { speaker: body?.agentId });
      else {
        const about = ctx.settings.setOwnerText(ABOUT_KEY, clipAbout(text));
        const um = store.add(c.id, { role: 'user', text, meta: { aboutAnswer: true } }); bus.emitMessage(um);
        const ack = store.add(c.id, { role: 'assistant', agentId: speakerOf(c, body?.agentId), text: savedLine(about), meta: { aboutSaved: true } }); bus.emitMessage(ack);
        p = co.turn(c.id, String(waiting.text || ''), { speaker: body?.agentId, resume: true });
      }
    } else if (chip && body?.needsBusiness === true && !aboutOf(ctx.settings)) {
      // a suggestion that means the owner's own business, and he has not said what it is: ask first, start nothing
      const um = store.add(c.id, { role: 'user', text, meta: { chip: true } }); bus.emitMessage(um);
      if (c.title === 'New chat') store.rename(c.id, cutAtWord(text, 48));
      const q = store.add(c.id, { role: 'assistant', agentId: speakerOf(c, body?.agentId), text: ASK_ABOUT_SITE, cards: [NOT_NOW], meta: { asksAbout: true } });
      store.setSettings(c.id, { awaitBusiness: { text, at: new Date().toISOString() } });
      bus.emitMessage(q); store.touch(c.id, ASK_ABOUT_SITE); emit({ type: 'chats' });
      return ctx.json(res, { ok: true, chatId: c.id, replyId: q.id, asked: true });
    } else p = co.send(c.id, text, { speaker: body?.agentId, userMeta: chip ? { chip: true } : {} });
    // the reply that finished the desk's first exchange gets one line under it, once, that points at the suggestions
    p.then((m) => { offerLength(c, m); if (!first || m?.status !== 'done' || ctx.kv.get('chat.nextShown', false) || !deskStarted()) return; ctx.kv.set('chat.nextShown', true); bus.emitMessage(store.add(c.id, { role: 'system', text: NEXT_LINE, meta: { firstNext: true } })); emit({ type: 'chats' }); }, e => ctx.log('turn failed', e.message));
    await new Promise(r => setImmediate(r));
    ctx.json(res, { ok: true, chatId: c.id, replyId: co.running.get(c.id)?.replyId || null });
  });
  // "Try again" on a reply that claimed work no tool did: re-run the owner's last message, preferring a model that calls tools.
  ctx.route('POST', '/chats/:id/retry', async (req, res, { params, body }) => {
    const c = resolveChat(params.id); if (!c) return ctx.json(res, { error: 'That chat is gone.' }, 404);
    if (co.running.has(c.id)) return ctx.json(res, { error: 'A reply is still coming in this chat. Stop it first.' }, 409);
    if (ctx.panic.halted) return ctx.json(res, { error: 'Everything is stopped. Press Resume first.', code: 'halted' }, 503);
    const last = store.messages(c.id, { limit: 60 }).filter(m => m.role === 'user' && m.text && !m.meta?.action).at(-1);
    if (!last) return ctx.json(res, { error: 'There is nothing to try again.' }, 400);
    // direct: "Answer without the pages" under a research turn the pages did not answer: the ordinary turn, no research
    const direct = body?.direct === true;
    co.turn(c.id, last.text, { again: true, preferTools: !direct, noResearch: direct }).catch(e => ctx.log('retry failed', e.message));
    await new Promise(r => setImmediate(r));
    ctx.json(res, { ok: true, chatId: c.id, replyId: co.running.get(c.id)?.replyId || null });
  });
  // Stop also drops a wait for the owner's business text (the "Not now" button under that question does the same)
  ctx.route('POST', '/chats/:id/stop', (req, res, { params }) => {
    const c = resolveChat(params.id); const waited = !!c?.settings.awaitBusiness;
    if (waited) { store.setSettings(c.id, { awaitBusiness: null }); emit({ type: 'chats' }); }
    ctx.json(res, { stopped: co.stop(params.id) || waited });
  });
  ctx.route('POST', '/chats/:id/action', async (req, res, { params, body }) => {
    const c = resolveChat(params.id); if (!c) return ctx.json(res, { error: 'That chat is gone.' }, 404);
    const tool = String(body?.tool || '');
    if (!ctx.modules.tools().some(t => t.name === tool)) return ctx.json(res, { error: 'That action is not available now. Its module may be off.' }, 404);
    const agentId = c.members.length === 1 ? c.members[0] : co.handoffFor(tool);
    const label = String(body?.label || '').slice(0, 80);
    const um = store.add(c.id, { role: 'user', text: label || 'Run this', meta: { action: tool } }); bus.emitMessage(um);
    const reply = store.add(c.id, { role: 'assistant', agentId, text: '', status: 'streaming', meta: { steps: [{ tool, agentId, status: 'running' }] } }); bus.emitMessage(reply);
    try {
      const emitted = new Set();   // a card the tool already emitted is not added again from its result
      const out = await ctx.modules.runTool(tool, body?.args && typeof body.args === 'object' ? body.args : {}, { agentId, chatId: c.id, signal: ctx.panic.signal, emitCard: (card) => { emitted.add(cardKey(card)); return bus.postCard(c.id, { agentId, ...card }, { into: reply.id }); } });
      const cards = [out?.card, ...(Array.isArray(out?.cards) ? out.cards : [])].filter(c => c && !emitted.has(cardKey(c)));
      const cur = store.message(reply.id);
      const text = typeof out?.text === 'string' ? out.text : typeof out?.message === 'string' ? out.message : typeof out?.summary === 'string' ? out.summary : (cards.length || cur.cards.length ? '' : `Done: ${label || 'the action'}.`);
      const m = store.update(reply.id, { text, cards: [...cur.cards, ...cards], status: 'done', meta: { steps: [{ tool, agentId, status: 'done' }] } });
      bus.emitMessage(m); store.touch(c.id, text || label); ctx.json(res, { ok: true, messageId: m.id });
    } catch (e) {
      const m = store.update(reply.id, { text: e.code === 'halted' ? 'Stopped.' : 'That did not work: ' + String(e.message || e).slice(0, 300), status: e.code === 'halted' ? 'stopped' : 'error', meta: { steps: [{ tool, agentId, status: 'failed' }] } });
      bus.emitMessage(m); ctx.json(res, { ok: false, error: e.message }, 200);
    }
  });
  // Attach: the raw body goes to workspace/inbox; a text file is read into the chat, anything else is named.
  ctx.route('POST', '/chats/:id/upload', async (req, res, { params, query, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Files are attached from the desk itself.' }, 403);
    const c = resolveChat(params.id); if (!c) return ctx.json(res, { error: 'That chat is gone.' }, 404);
    const raw = await ctx.readBody(req, 50 * 1024 * 1024);
    const base = path.basename(String(query.name || 'file').replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
    fs.mkdirSync(ctx.workspacePath('inbox'), { recursive: true });
    let name = base; let n = 1; const ext = path.extname(base); const stem = base.slice(0, base.length - ext.length);
    while (fs.existsSync(ctx.workspacePath('inbox', name))) name = `${stem} (${++n})${ext}`;
    fs.writeFileSync(ctx.workspacePath('inbox', name), raw);
    const rel = 'inbox/' + name;
    const isText = TEXT_EXT.test(name) && raw.length <= 200 * 1024 && !raw.subarray(0, 4096).includes(0);
    const attachment = { path: rel, name, size: raw.length, text: isText ? raw.toString('utf8').slice(0, 60000) : null };
    const m = store.add(c.id, { role: 'user', text: String(query.note || '').slice(0, 2000), cards: [{ kind: 'file', path: rel, name, size: raw.length, note: isText ? 'Read into the chat' : 'Saved in your inbox' }], meta: { attachment } });
    store.touch(c.id, 'Attached ' + name); bus.emitMessage(m); emit({ type: 'chats' });
    ctx.json(res, { ok: true, path: rel, name, size: raw.length, read: isText, messageId: m.id });
  });
  // The state of an approval a draft card waits on (pending, approved, denied, timeout, halted), for the card after a restart.
  ctx.route('GET', '/approvals/:id', (req, res, { params }) => { const a = ctx.approval.get?.(params.id); a ? ctx.json(res, { id: a.id, status: a.status }) : ctx.json(res, { error: 'Not found' }, 404); });
  ctx.route('GET', '/settings', (req, res) => ctx.json(res, { handoff: { ...(ctx.kv.get('handoff', {}) || {}) }, jsonProviders: ctx.kv.get('jsonProviders', []) }));
  ctx.route('PUT', '/settings', (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can change this.' }, 403);
    if (body?.handoff && typeof body.handoff === 'object') ctx.kv.set('handoff', Object.fromEntries(Object.entries(body.handoff).filter(([k, v]) => /^[\w.-]+$/.test(k) && typeof v === 'string')));
    if (Array.isArray(body?.jsonProviders)) ctx.kv.set('jsonProviders', body.jsonProviders.map(String));
    ctx.json(res, { ok: true });
  });

  // ---------- ratings the owner leaves under an answer: Chat's own store, so they work whether Bench is on or not
  ctx.db.migrate(2, 'CREATE TABLE IF NOT EXISTS m_chat_ratings (message_id TEXT PRIMARY KEY, thumb TEXT, research TEXT, reasons TEXT, comment TEXT, rated_at TEXT NOT NULL)');
  const RATING_REASONS = ['wrong facts', 'weak sources', 'missed the point', 'too long', 'too short', 'outdated', 'other'];
  const ratingOut = (r) => !r ? null : ({ targetType: 'answer', targetId: r.message_id, thumb: r.thumb || null, research: r.research || null, reasons: (() => { try { return JSON.parse(r.reasons || '[]'); } catch { return []; } })(), comment: r.comment || '', ratedAt: r.rated_at });
  const putRating = (id, body, { keep = false, at = new Date().toISOString() } = {}) => {
    const thumb = ['up', 'down'].includes(body.thumb) ? body.thumb : null;
    const research = ['good', 'bad'].includes(body.research) ? body.research : null;
    const reasons = Array.isArray(body.reasons) ? body.reasons.filter((x) => RATING_REASONS.includes(x)).slice(0, 7) : [];
    const comment = String(body.comment || '').slice(0, 1000);
    if (thumb === null && research === null && !reasons.length && !comment) { if (!keep) ctx.db.run('DELETE FROM m_chat_ratings WHERE message_id = ?', id); return; }
    ctx.db.run(`INSERT INTO m_chat_ratings (message_id, thumb, research, reasons, comment, rated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO ${keep ? 'NOTHING' : 'UPDATE SET thumb = excluded.thumb, research = excluded.research, reasons = excluded.reasons, comment = excluded.comment, rated_at = excluded.rated_at'}`,
      id, thumb, research, JSON.stringify(reasons), comment, at);
  };
  /** Answer ratings Bench stored before Chat had its own: copied over once, the first time Bench offers them. */
  const copyBenchRatings = () => {
    if (ctx.kv.get('ratings.copied', false)) return;
    const bench = ctx.modules.api('bench'); if (typeof bench?.answerRatings !== 'function') return;
    for (const r of bench.answerRatings() || []) if (r?.targetId) putRating(String(r.targetId), r, { keep: true, at: r.ratedAt || new Date().toISOString() });
    ctx.kv.set('ratings.copied', true);
  };
  const getRating = (id) => { copyBenchRatings(); return ratingOut(ctx.db.get('SELECT * FROM m_chat_ratings WHERE message_id = ?', String(id))); };
  const ratingsSince = (since) => { copyBenchRatings(); return ctx.db.all('SELECT * FROM m_chat_ratings WHERE rated_at >= ? ORDER BY rated_at', String(since || '')).map(ratingOut); };
  const ownerOnly = (res, owner) => { if (owner) return false; ctx.json(res, { error: 'Only the owner at this desk can rate answers.' }, 403); return true; };
  ctx.route('POST', '/ratings', (req, res, { body, owner }) => {
    if (ownerOnly(res, owner)) return;
    const m = store.message(Number(body?.messageId));
    if (!m || m.role !== 'assistant') return ctx.json(res, { error: 'That answer is gone.' }, 404);
    copyBenchRatings(); putRating(String(m.id), body || {});
    ctx.json(res, { ok: true, rating: getRating(m.id) });
  });
  ctx.route('GET', '/ratings/:id', (req, res, { params, owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, { rating: getRating(params.id) }); });

  // ---------- what other modules call (the inter-module API)
  ctx.expose({
    postCard: (chatId, card) => bus.postCard(chatId, card),
    postMessage(chatId, { agentId = 'coordinator', text = '', cards = [], label = null } = {}) {
      const c = resolveChat(chatId); if (!c) return null;
      // posted: a note a module wrote (a new agent's welcome, a job's line), not a model's answer: it gets no rating controls
      const m = store.add(c.id, { role: 'assistant', agentId, text: String(text || ''), cards: (cards || []).filter(x => x && typeof x === 'object'), label, meta: { posted: true } });
      store.touch(c.id, text || cards?.[0]?.title || ''); bus.emitMessage(m); emit({ type: 'chats' });
      return { chatId: c.id, messageId: m.id };
    },
    /** Messages since a time, oldest first, for a look back at how turns went (role, status, the again mark, tool steps). Read-only. */
    messagesSince: (since, limit = 2000) => ctx.db.all('SELECT * FROM m_chat_messages WHERE at >= ? ORDER BY id LIMIT ?', String(since || ''), Math.min(5000, Number(limit) || 2000)).map(r => store.message(r.id)),
    /** The owner's answer ratings since a time, oldest first (thumb, research, reasons, comment, ratedAt). Read-only. */
    ratingsSince,
    createChat({ title, members } = {}) { const c = store.create({ title, members }); emit({ type: 'chats' }); return c; },
    // what Home shows under "Pick up where you left off": plain words (a value stored before the preview was cleaned is cleaned here)
    recent(n = 6) { return store.list().filter(c => c.last).slice(0, n).map(c => ({ id: c.id, title: c.title || ctx.agents.get(c.members[0])?.name || 'Chat', last: cutAtWord(previewText(c.last), 140), updated: c.updated })); },
    /** A full Coordinator turn, for schedules and channels. */
    async ask({ chatId, agentId, text, signal, jobId, quiet = false, note = null } = {}) {
      const c = chatId ? resolveChat(chatId) : agentId ? store.direct(agentId) : store.chat('everyone');
      if (!c) throw new Error('That chat is gone.');
      // a job asking in a chat whose own reply is still finishing (it started that job) waits for it, up to two minutes
      if (co.running.has(c.id) && (jobId || signal)) { const t0 = Date.now(); while (co.running.has(c.id) && Date.now() - t0 < 120000 && !signal?.aborted) await new Promise(r => setTimeout(r, 250)); }
      const inJob = !!(jobId || signal);
      let m = await co.turn(c.id, String(text || ''), { speaker: agentId, signal, jobId, quiet: !!quiet, note: note ? String(note).slice(0, 120) : null, inJob });
      // A job's turn that started research is not over until the research is: it waits here (the chat stays free), and the
      // research that did not finish makes the turn unfinished.
      const started = inJob ? (m.meta?.steps || []).filter(st => st.status === 'done' && RESEARCH_JOBS.test(st.tool) && st.result?.jobId).map(st => st.result.jobId) : [];
      if (started.length && !m.meta?.unfinished) {
        if (m.meta?.jobOf) bus.postCard(c.id, { kind: 'progress', jobId: m.meta.jobOf, status: 'running', detail: 'Waiting for the research to finish' });
        const open = (id) => ['running', 'waiting'].includes(ctx.jobs.get(id)?.status);
        while (started.some(open) && !signal?.aborted) await new Promise(r => setTimeout(r, 500));
        const bad = started.map(id => ctx.jobs.get(id)).find(j => j && j.status !== 'done');
        if (bad && !signal?.aborted) m = store.update(m.id, { meta: { ...m.meta, unfinished: `The research did not finish${bad.status === 'failed' && bad.error ? ': ' + String(bad.error).replace(/\s+/g, ' ').trim().slice(0, 200) : ` (${bad.status === 'failed' ? 'it failed' : 'it was stopped'})`}` } });
      }
      return { chatId: c.id, messageId: m.id, text: m.text, label: m.label, cards: m.cards, status: m.status, posted: true, unfinished: m.meta?.unfinished || null };
    },
    isRunning: (chatId) => co.running.has(chatId),
    stop: (chatId) => co.stop(chatId),
  });

  return { async deactivate() { offJobs?.(); offAgents?.(); for (const id of [...co.running.keys()]) co.stop(id); } };
}

