// Chat page: rail of chats, the conversation at full width, the folding panel. Matches the Chat section of the approved preview.
import { chipsFor, chipText, chipNeedsBusiness } from '/ui/pages/home.js';
import { cleanReply, uniqueOutputs, previewText, stepChips, footTag, waitLine, hasTable, shortCell, railLine, liveText, PANEL_PREFIXES, BARE_LINES, bareStart, lastAsk, cutAtWord } from '/modules/chat/ui-text.js';

const API = 'm/chat/';
const PRESETS = [['everyone', 'Everyone'], ['sales-room', 'Sales room'], ['build-room', 'Build room']];
const PRESET_MEMBERS = { 'sales-room': ['coordinator', 'closer', 'scout'], 'build-room': ['coordinator', 'coder', 'operator'] };
const PROVIDER_NAMES = { ollama: 'Ollama', gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter', groq: 'Groq', mistral: 'Mistral', deepseek: 'DeepSeek', together: 'Together', fireworks: 'Fireworks', cerebras: 'Cerebras', xai: 'xAI', custom: 'Custom' };
const STATUS = { running: ['Running', 'run'], waiting: ['Waiting for you', 'wait'], done: ['Done', 'ok'], failed: ['Did not finish', 'stop'], stopped: ['Stopped', 'stop'], interrupted: ['Stopped', 'stop'] };
const DRAFT_WORDS = { pending: 'Waiting for you', approved: 'Approved', denied: 'Denied', timeout: 'Timed out', aborted: 'Stopped', halted: 'Stopped', sent: 'Sent', failed: 'Not sent' };

let mdLib = null;
async function loadMarkdown() {
  if (mdLib !== null) return mdLib;
  try {
    const [{ marked }, purify] = await Promise.all([import('/vendor/marked/marked.esm.js'), import('/vendor/dompurify/purify.es.mjs')]);
    const DOMPurify = purify.default || purify;
    mdLib = (text) => DOMPurify.sanitize(marked.parse(String(text ?? ''), { gfm: true, breaks: true }), { ADD_ATTR: ['target'] });
    mdLib.inline = (text) => DOMPurify.sanitize(marked.parseInline(String(text ?? ''), { gfm: true }), { ADD_ATTR: ['target'] });
  } catch (e) { console.warn('markdown libraries did not load; using the kit renderer', e); mdLib = false; }
  return mdLib;
}
function md(ui, text) {
  if (!mdLib) return ui.md(text);
  const el = ui.h('div', { class: 'md', html: mdLib(text) });
  for (const a of el.querySelectorAll('a[href]')) { if (/^https?:/i.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } }
  for (const t of el.querySelectorAll('table')) { const w = document.createElement('div'); w.className = 'scroll'; t.replaceWith(w); w.append(t); }
  for (const c of el.querySelectorAll('th, td')) if (shortCell(c.textContent)) c.classList.add('nw');   // "Day 1" stays on one line
  return el;
}

/** One table cell or short line as inline markdown: links open in a new tab. */
function mdInline(ui, text) {
  const s = String(text ?? '');
  if (!/[[*_`]|https?:\/\//.test(s)) return s;
  if (/^https?:\/\/\S+$/.test(s)) return ui.h('a', { href: s, target: '_blank', rel: 'noopener noreferrer' }, (() => { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return s; } })());
  const span = mdLib?.inline ? ui.h('span', { html: mdLib.inline(s) }) : (() => { const d = ui.md(s); const p = d.querySelector('p'); return p ? ui.h('span', { html: p.innerHTML }) : d; })();
  for (const a of span.querySelectorAll('a[href]')) { if (/^https?:/i.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } else a.removeAttribute('href'); }
  return span;
}
function fillRow(v, id) { if (v === '$row') return id; if (Array.isArray(v)) return v.map(x => fillRow(x, id)); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillRow(x, id)])); return v; }
function hasRow(v) { return v === '$row' || (Array.isArray(v) ? v.some(hasRow) : v && typeof v === 'object' ? Object.values(v).some(hasRow) : false); }

function css() {
  if (document.getElementById('chat-css')) return;
  const s = document.createElement('style'); s.id = 'chat-css';
  s.textContent = `
.chatv .talk{min-width:0}.chatv .who-t .nm{flex:1}
.chatv .msg{overflow-wrap:anywhere;min-width:0}
.chatv .msg.tbl{max-width:100%}
.chatv .msg .scroll{overflow-x:auto;max-width:100%}
.chatv .msg th,.chatv .msg td{overflow-wrap:normal;word-break:normal;min-width:7em;vertical-align:top}
.chatv .msg th{hyphens:none}.chatv .msg td{overflow-wrap:break-word}
.chatv .msg th.nw,.chatv .msg td.nw{white-space:nowrap;min-width:0}.chatv .msg .md p{margin:0 0 6px}.chatv .msg .md p:last-child{margin:0}
.chatv .msg.it .card{margin-top:8px}.chatv .msg.it .card table{font-size:13px}
.chatv .msg .steps{font-size:11.5px;color:var(--dim);margin-top:4px;display:flex;flex-wrap:wrap;gap:4px 10px}
.chatv .msg.sys{align-self:center;background:none;color:var(--dim);font-size:12px;padding:2px 8px;animation:none}
.chatv .msg .foot{display:flex;gap:6px;align-items:center;margin-top:4px}
.chatv .msg .act{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chatv .chat .empty{margin:auto}
.chatv .drawer .line>div:first-child b,.chatv .drawer .line .d{overflow-wrap:anywhere;word-break:break-word}.chatv .drawer .line>.pill,.chatv .drawer .line>.btn{flex-shrink:0;align-self:flex-start}
.chatv .compose .btn.stop{background:var(--stop)}
.chatv .under .mini b{font-weight:500}
.chatv .msg.me .md a{color:#fff}
.chatv .msg .waiting{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.chatv .msg .wait{font-size:12px;color:var(--dim)}
.chatv .chip.main{background:var(--accent);color:var(--on-accent);border-color:var(--accent);font-weight:500}
.chatv .under a.mini{color:var(--accent);text-decoration:underline;text-underline-offset:2px}`;
  document.head.append(s);
}

export const pages = { chat: { title: 'Chat', render, unmount() {} } };

async function render(el, ui, route) {
  const { h, api, btn, pill, toast, fmt, empty, line, sw } = ui;
  css(); await loadMarkdown();
  el.classList.add('chatv');
  const rail = h('aside', { class: 'rail', 'aria-label': 'Chats' });
  const grp = h('select', { id: 'grp', 'aria-label': 'Who is in this chat' });
  const grpN = h('span', { class: 'pill ok' });
  const panelBtn = h('button', { class: 'mini', type: 'button', 'aria-pressed': 'true' }, 'Panel');
  const chatEl = h('div', { class: 'chat', id: 'chat', 'aria-live': 'polite' });
  const chips = h('div', { class: 'chips', id: 'chips' });
  const input = h('input', { type: 'text', id: 'ask', placeholder: 'Message', autocomplete: 'off', 'aria-label': 'Message' });
  const sendBtn = h('button', { class: 'btn', type: 'submit' }, 'Send');
  const micBtn = h('button', { class: 'btn ghost', type: 'button', hidden: true, title: 'Speak instead of typing' }, 'Mic');
  const form = h('form', { class: 'compose', id: 'form' }, input, micBtn, sendBtn);
  const under = h('div', { class: 'under' });
  const drawerBody = h('div');
  const drawer = h('aside', { class: 'drawer', id: 'drawer', 'aria-label': 'Chat panel' }, drawerBody);
  const fileIn = h('input', { type: 'file', hidden: true, multiple: true });
  el.append(rail, h('div', { class: 'talk' }, h('div', { class: 'row hd' }, grp, grpN, panelBtn), chatEl, chips, form, under, fileIn), drawer);

  // On a narrow screen the panel covers the conversation, so it starts closed there and opens only from its button (not remembered).
  const narrow = () => { try { return matchMedia('(max-width: 860px)').matches; } catch { return false; } };
  let panelOpen = !narrow(); try { panelOpen = panelOpen && localStorage.getItem('apd-chat-panel') !== 'closed'; } catch {}
  const setPanel = (open, { keep = true } = {}) => { panelOpen = open; drawer.classList.toggle('open', open); panelBtn.setAttribute('aria-pressed', String(open)); if (keep && !narrow()) { try { localStorage.setItem('apd-chat-panel', open ? 'open' : 'closed'); } catch {} } };
  setPanel(panelOpen, { keep: false });
  panelBtn.onclick = () => setPanel(!panelOpen);

  let chats = []; let chat = null; let messages = []; let alive = true;
  const msgEls = new Map();       // message id -> element
  const streaming = new Map();    // message id -> text so far
  let curId = route?.parts?.[0] || null;
  if (!curId) { try { curId = localStorage.getItem('apd-chat') || 'everyone'; } catch { curId = 'everyone'; } }
  // the seconds on a waiting reply tick once a second
  const waitTick = setInterval(() => { for (const w of chatEl.querySelectorAll('.wait[data-wait]')) { try { w.textContent = waitLine(JSON.parse(w.dataset.wait)); } catch {} } }, 1000);
  ui.onLeave(() => { alive = false; clearInterval(waitTick); });

  const openFile = (p) => { if (typeof ui.openFile === 'function') ui.openFile(p); else location.hash = '#/files?path=' + encodeURIComponent(p || ''); };
  const agentName = (id) => ui.agent(id)?.name || (id === 'coordinator' ? 'Coordinator' : 'Agent');
  const chatTitle = (c) => c.title || (c.members.length === 1 ? agentName(c.members[0]) : 'Chat');

  // ---------- rail
  const paintRail = () => {
    const row = (c, name, sub, cls = '') => h('button', { class: 'who-t' + (cls ? ' ' + cls : ''), type: 'button', 'aria-current': c && chat && c.id === chat.id ? 'true' : null, 'data-c': c?.id, 'data-agent-id': c.members?.length === 1 ? c.members[0] : null, onclick: () => open(c.id) },
      cls.includes('rc') ? null : h('span', { class: 'av' + (c.kind === 'group' || c.everyone ? ' g' : '') }, initials(name)),
      h('span', { class: 'nm' }, name, sub ? h('small', null, sub) : null));
    const groups = chats.filter(c => PRESETS.some(p => p[0] === c.id));
    const agents = ui.state.agents.map(a => chats.find(c => c.id === 'dm-' + a.id) || { id: 'dm-' + a.id, members: [a.id], kind: 'direct', last: '' });
    const recent = chats.filter(c => !c.seeded).slice(0, 8);
    rail.replaceChildren(...[
      h('button', { class: 'who-t', type: 'button', onclick: newChat }, h('span', { class: 'av g' }, '+'), h('span', { class: 'nm' }, 'New chat')),
      h('h6', null, 'Groups'), ...groups.map(c => row(c, chatTitle(c), previewText(c.last) || `${c.members.length} agents`)),
      h('h6', null, 'Agents'), ...agents.map(c => row(c, agentName(c.members[0]), railLine(c.last, ui.agent(c.members[0])?.role || ''))),
      recent.length ? h('h6', { class: 'rc' }, 'Recent') : null, ...recent.map(c => row(c, chatTitle(c), null, 'rc')),
      h('span', { class: 'grow' }),
      h('button', { class: 'who-t', type: 'button', onclick: () => ui.go('settings') }, h('span', { class: 'av g' }, 'S'), h('span', { class: 'nm' }, 'Settings'))].filter(Boolean));
  };
  let deskStarted = null;   // has one exchange finished on this desk (any chat)? Before it, the row above the box shows the two starters
  async function loadChats() {
    try { const r = await api(API + 'chats'); chats = r.chats; const was = deskStarted; deskStarted = r.started !== false; if (alive && was !== deskStarted) { paintChips(); if (was !== null) paintUnder(); } } catch (e) { toast(e.message, 'err'); }
    if (alive) paintRail();
  }
  async function newChat() {
    try { const c = await api(API + 'chats', { body: { title: 'New chat', members: ['coordinator'] } }); await loadChats(); open(c.id); input.focus(); } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- header switcher: the group or agent inside this chat
  const paintHeader = () => {
    if (!chat) return;
    const opts = [];
    const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
    let sel = null;
    for (const [id, name] of PRESETS) { opts.push(['g:' + id, name]); if (!sel && (id === 'everyone' ? chat.everyone : sameSet(chat.members, PRESET_MEMBERS[id]))) sel = 'g:' + id; }
    for (const a of ui.state.agents) { opts.push(['a:' + a.id, a.name]); if (!sel && chat.members.length === 1 && chat.members[0] === a.id) sel = 'a:' + a.id; }
    if (!sel) { sel = 'cur'; opts.unshift(['cur', chatTitle(chat)]); }
    const label = (v, n) => v === sel && chat.title && !PRESETS.some(p => 'g:' + p[0] === v && p[1] === chat.title) && chat.members.length > 1 ? `${chat.title} · ${n}` : n;
    grp.replaceChildren(...opts.map(([v, n]) => h('option', { value: v, selected: v === sel }, label(v, n))));
    grpN.textContent = chat.members.length === 1 ? '1 agent' : `${chat.members.length} agents`;
  };
  grp.onchange = async () => {
    const v = grp.value; if (!chat || v === 'cur') return;
    const body = v === 'g:everyone' ? { everyone: true } : v.startsWith('g:') ? { members: PRESET_MEMBERS[v.slice(2)] } : { members: [v.slice(2)] };
    try { chat = await api(API + `chats/${chat.id}/members`, { method: 'PUT', body }); paintHeader(); paintUnder(); paintDrawer(); loadChats(); } catch (e) { toast(e.message, 'err'); }
  };

  // ---------- conversation
  const nearBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
  const toBottom = () => { chatEl.scrollTop = chatEl.scrollHeight; };
  const paintMessages = () => {
    msgEls.clear(); offerEl = null;
    const els = messages.map(m => { const e = msgEl(m); msgEls.set(m.id, e); return e; });
    chatEl.replaceChildren(...(els.length ? els : [empty(chat?.members.length === 1 ? `Ask ${agentName(chat.members[0])} anything.` : 'Ask anything. The Coordinator answers and hands work to the right agent.')]), approvalsEl());
    if (queued) paintQueue();
    toBottom();
  };
  const upsert = (m) => {
    const i = messages.findIndex(x => x.id === m.id);
    if (i >= 0) messages[i] = m; else messages.push(m);
    if (m.status !== 'streaming') streaming.delete(m.id);
    const stick = nearBottom();
    const e = msgEl(m); const old = msgEls.get(m.id);
    // a repaint of a bubble already on screen does not pop in again, so a streaming reply stays visible
    if (old) { e.style.animation = 'none'; old.replaceWith(e); } else { chatEl.querySelector(':scope > .empty')?.remove(); chatEl.insertBefore(e, queueEl || chatEl.querySelector(':scope > .approvals')); }
    msgEls.set(m.id, e);
    if (stick || i < 0) toBottom();
  };
  function msgEl(m) {
    if (m.role === 'system') return h('div', { class: 'msg sys', 'data-role': 'system' }, m.text);
    if (m.role === 'user') {
      return h('div', { class: 'msg me' + (m.cards?.length ? ' wide' : ''), 'data-role': 'user', dataset: { id: m.id } }, m.text ? md(ui, m.text) : null, ...(m.cards || []).map(c => cardEl(c, m)));
    }
    const live = m.status === 'streaming';
    const text = live ? liveText(cleanReply(streaming.get(m.id) ?? m.text), m.meta?.steps) : m.text;
    const wide = (m.cards || []).some(c => ['table', 'report', 'draft', 'progress', 'sources'].includes(c.kind) || String(c.kind).includes('.'));
    const who = h('span', { class: 'who' }, agentName(m.agentId), m.label ? [' · ', h('span', { class: 'mdl' }, m.label)] : null, m.meta?.note ? ' · ' + m.meta.note : null);
    const steps = (m.meta?.steps || []).filter(s => s.tool);
    const stepsEl = steps.length ? h('div', { class: 'steps' }, stepChips(steps, agentName, m.status).map(t => h('span', null, t))) : null;
    const waitEl = live && m.meta?.wait ? h('span', { class: 'wait', 'data-wait': JSON.stringify(m.meta.wait) }, waitLine(m.meta.wait)) : null;
    const body = text ? md(ui, text) : live ? h('div', { class: 'waiting' }, h('span', { class: 'typing' }, h('span'), h('span'), h('span')), waitEl) : null;
    const tagText = footTag(m);
    const foot = tagText ? pill(tagText, tagText === 'Offline' ? 'wait' : 'stop') : null;
    const speak = !live && text && window.apdVoice?.speak ? btn('Read aloud', { kind: 'ghost sm', onClick: () => window.apdVoice.speak(text) }) : null;
    return h('div', { class: 'msg it' + (wide ? ' wide' : '') + (hasTable(text) ? ' tbl' : ''), 'data-role': 'assistant', 'data-agent-id': m.agentId || '', 'data-status': m.status, dataset: { id: m.id } }, who, body, stepsEl, ...(m.cards || []).map(c => cardEl(c, m)), foot || speak ? h('div', { class: 'foot' }, foot, speak, h('span', { class: 'sub', style: { fontSize: '11px' } }, fmt.time(m.at))) : null);
  }

  // ---------- cards
  const runAction = async (a, extra = null) => {
    if (a.go) { if (String(a.go).startsWith('#')) location.hash = a.go; else ui.go(...String(a.go).split('/')); return; }
    if (a.stopAsk) { try { await api(API + `chats/${chat.id}/stop`, { method: 'POST' }); toast('Fine. Ask again when you want it.'); } catch (e) { toast(e.message, 'err'); } return; }
    if (a.retry) { try { await api(API + `chats/${chat.id}/retry`, { method: 'POST' }); setRunning(true); } catch (e) { toast(e.message, 'err'); } return; }
    if (!a.tool) return;
    // row actions: '$row' in the args stands for that row's id (rowIds beside rows); without it the row itself rides along
    let args = a.args && typeof a.args === 'object' ? a.args : {};
    if (extra) args = hasRow(args) ? fillRow(args, extra.rowId ?? extra.rowIndex) : { ...args, ...(extra.rowId != null ? { rowId: extra.rowId } : { row: extra.row }) };
    try { await api(API + `chats/${chat.id}/action`, { body: { tool: a.tool, args, label: a.label } }); } catch (e) { toast(e.message, 'err'); }
  };
  const actionBtns = (actions, extra) => (actions || []).filter(a => a && a.label && (a.tool || a.go || a.retry || a.stopAsk)).map(a => btn(a.label, { kind: 'ghost sm', onClick: (ev) => { ev.currentTarget.disabled = true; runAction(a, extra); } }));
  function cardEl(c, m) {
    const el = cardInner(c, m);
    if (el instanceof Element) el.setAttribute('data-card', String(c.kind || 'text'));
    return el;
  }
  function cardInner(c, m) {
    try {
      const own = moduleCard(c);
      if (own) return own;
      switch (c.kind) {
        case 'text': return h('div', { class: 'card' }, md(ui, c.text || ''));
        case 'table': {
          const cols = c.columns || []; const rows = c.rows || [];
          const asObj = (r) => Object.fromEntries(cols.map((k, i) => [k, Array.isArray(r) ? r[i] : r?.[k]]));
          const cell = (v) => mdInline(ui, v == null ? '' : typeof v === 'object' ? (v.url && (v.label || v.title) ? `[${v.label || v.title}](${v.url})` : v.label || v.text || v.title || v.url || '') : String(v));
          return h('div', { class: 'card', style: { padding: '8px 10px' } },
            c.title ? h('div', { class: 'row', style: { marginBottom: '4px' } }, h('b', null, c.title), h('span', { class: 'sub' }, `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`)) : null,
            h('div', { class: 'scroll', style: { maxHeight: '420px', overflow: 'auto' } }, h('table', null,
              h('thead', null, h('tr', null, cols.map(k => h('th', null, k)), c.rowActions?.length ? h('th') : null)),
              h('tbody', null, rows.map((r, i) => h('tr', null, (Array.isArray(r) ? r : cols.map(k => r?.[k])).map(v => h('td', null, cell(v))), c.rowActions?.length ? h('td', { style: { whiteSpace: 'nowrap' } }, actionBtns(c.rowActions, { row: asObj(r), rowIndex: i, rowId: Array.isArray(c.rowIds) ? c.rowIds[i] : undefined })) : null))))),
            c.actions?.length ? h('div', { class: 'act' }, actionBtns(c.actions)) : null);
        }
        case 'progress': {
          const [word, cls] = STATUS[c.status || 'running'] || STATUS.running;
          const running = c.status === 'running' || c.status === 'waiting' || !c.status;
          return h('div', { class: 'card', style: { padding: '4px 12px' } }, h('div', { class: 'line' },
            h('div', null, h('b', null, c.title || 'Working'), h('span', { class: 'd' }, [agentName(c.agentId || m.agentId), c.detail].filter(Boolean).join(' · '))),
            ui.meter(c.status === 'done' ? 1 : Number(c.progress) || 0, { live: running, style: { maxWidth: '180px' } }),
            pill(word, cls),
            ...actionBtns(c.actions),
            running && c.jobId ? btn('Stop', { kind: 'ghost sm', onClick: async () => { try { await api(`jobs/${c.jobId}/stop`, { method: 'POST' }); } catch (e) { toast(e.message, 'err'); } } }) : null));
        }
        case 'file': return h('div', { class: 'card', style: { padding: '4px 12px' } }, h('div', { class: 'line' },
          h('div', null, h('b', null, c.name || baseName(c.path)), h('span', { class: 'd' }, [c.note, c.size != null ? fmt.bytes(c.size) : null].filter(Boolean).join(' · '))),
          btn('Open', { kind: 'ghost sm', onClick: () => { openFile(c.path); } })));
        case 'draft': {
          const pending = c.approvalId && ui.state.pendingApprovals.some(a => a.id === c.approvalId);
          const state = pill(pending ? 'Waiting for you' : c.status ? DRAFT_WORDS[c.status] || c.status : c.approvalId ? 'Checking…' : 'Draft', pending ? 'wait' : /sent|approved/i.test(c.status || '') ? 'ok' : '');
          const note = c.note || c.result ? h('div', { class: 'sub', style: { marginTop: '6px' } }, c.note || c.result) : null;
          const closed = h('div', { class: 'sub', style: { marginTop: '6px', display: 'none' } }, 'This approval is no longer open here. Open Sales to send it; it asks you again there. ', btn('Open Sales', { kind: 'ghost sm', onClick: () => ui.go('sales') }));
          if (!pending && c.approvalId && !c.status) api(API + 'approvals/' + encodeURIComponent(c.approvalId)).then(r => { state.textContent = DRAFT_WORDS[r.status] || r.status; if (['timeout', 'halted', 'aborted'].includes(r.status)) closed.style.display = ''; }).catch(() => { state.textContent = 'Closed'; closed.style.display = ''; });
          return h('div', { class: 'card' },
            h('div', { class: 'row' }, h('b', null, c.title || 'Draft'), state),
            c.to || c.subject ? h('div', { class: 'sub', style: { marginTop: '4px' } }, [c.to && 'To ' + c.to, c.subject].filter(Boolean).join(' · ')) : null,
            h('div', { class: 'draft', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, c.body || ''),
            h('div', { class: 'act' },
              pending ? btn('Approve and send', { kind: 'sm', onClick: async () => { try { await ui.decide(c.approvalId, 'approve'); toast('Approved', 'ok'); repaintSoon(); } catch (e) { toast(e.message, 'err'); } } }) : null,
              pending ? btn('Deny', { kind: 'ghost sm', onClick: async () => { try { await ui.decide(c.approvalId, 'deny'); repaintSoon(); } catch (e) { toast(e.message, 'err'); } } }) : null,
              ...actionBtns(c.actions)), note, closed);
        }
        case 'sources': return h('div', { class: 'card' }, h('h6', { style: { margin: '0 0 4px' } }, 'Sources'), h('ol', { style: { margin: 0, paddingLeft: '20px' } }, (c.items || []).map(s => h('li', null, s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title || hostOf(s.url)) : s.title))));
        case 'report': return h('div', { class: 'card' },
          h('div', { class: 'row' }, h('b', null, c.title || 'Report'), (c.sources || []).length ? pill(`${c.sources.length} sources`) : null, h('span', { class: 'grow' }),
            c.go || c.path ? btn('Open', { kind: 'sm', onClick: () => { if (c.go) location.hash = c.go; else openFile(c.path); } }) : null),
          c.summary ? h('div', { style: { marginTop: '6px' } }, md(ui, c.summary)) : null);
        case 'actions': return h('div', { class: 'act' }, actionBtns(c.actions));
        default: return h('div', { class: 'card' }, md(ui, c.text || c.summary || c.title || ''));
      }
    } catch (e) { console.error(e); return h('div', { class: 'card sub' }, c.title || 'A card that could not be shown.'); }
  }
  const renderers = new Map();   // kind -> fn from another module's chatCards
  function moduleCard(c) {
    const fn = renderers.get(c.kind);
    if (fn) { const out = fn(c, ui); if (out instanceof Node) return out; }
    return null;
  }
  async function loadRenderers() {
    const kinds = new Set(messages.flatMap(m => (m.cards || []).map(c => c.kind)).filter(k => String(k).includes('.') && !renderers.has(k)));
    const mods = [...new Set([...kinds].map(k => k.split('.')[0]))].filter(id => ui.moduleOn(id));
    let added = false;
    for (const id of mods) { try { const mod = await ui.moduleUi(id); for (const [k, fn] of Object.entries(mod.chatCards || {})) if (typeof fn === 'function' && !renderers.has(k) && k.includes('.')) { renderers.set(k, fn); added = true; } } catch {} }
    return added;
  }

  // ---------- approvals for this chat, inline
  function approvalsEl() {
    const mine = chat ? ui.state.pendingApprovals.filter(a => a.chatId === chat.id) : [];
    return h('div', { class: 'approvals', style: { display: mine.length ? 'flex' : 'none', flexDirection: 'column', gap: '8px' } }, mine.map(a => h('div', { class: 'msg it wide' }, h('span', { class: 'who' }, `${agentName(a.agentId)} asks you`), ui.approvalCard(a))));
  }
  let repaintTimer = null;
  const repaintSoon = () => { clearTimeout(repaintTimer); repaintTimer = setTimeout(() => { if (alive && chat) { const st = chatEl.scrollTop; paintMessages(); chatEl.scrollTop = st; toBottom(); } }, 150); };

  // ---------- compose and controls
  // a chip press is told to the desk as such: a chip that means the owner's own business waits for what he sells
  // Before the desk's first exchange: "Say hello" (a first real answer) and "Select model / Add API" as the main button.
  // From then on, the role's suggestions.
  function paintChips() {
    if (deskStarted === false) return chips.replaceChildren(
      h('button', { class: 'chip', type: 'button', 'data-start': 'hello', onclick: () => send('Hello') }, 'Say hello'),
      h('button', { class: 'chip main', type: 'button', 'data-start': 'models', onclick: () => ui.go('models') }, 'Select model / Add API'));
    chips.replaceChildren(...chipsFor(ui.state.settings.role).map(c => h('button', { class: 'chip', type: 'button', onclick: () => send(chipText(c), { chip: true, needsBusiness: chipNeedsBusiness(c) }) }, chipText(c))));
  }
  paintChips();
  let prefillChip = null;   // a chip pressed on Home arrives as text in the box; sent unchanged, it is still that chip
  // Enter never stops a reply. While a reply is coming, Enter with text queues one message ("Waiting to send") that goes out by
  // itself the moment the turn ends, finished or stopped. Only a click on the visible Stop button stops a turn.
  let busy = false; let queued = null; let queueEl = null;
  const paintBtn = () => { const stopMode = !!chat?.running && !input.value.trim(); sendBtn.textContent = stopMode ? 'Stop' : queued && chat?.running ? 'Replace waiting' : chat?.running ? 'Send after' : 'Send'; sendBtn.classList.toggle('stop', stopMode); };
  const setRunning = (on) => { if (chat) chat.running = on; paintBtn(); if (!on && queued) setTimeout(flushQueue, 60); };
  input.addEventListener('input', paintBtn);
  const paintQueue = () => {
    queueEl?.remove(); queueEl = null;
    if (!queued) return;
    queueEl = h('div', { class: 'msg me', 'data-role': 'queued', style: { opacity: '.75' } }, md(ui, queued),
      h('div', { class: 'foot', style: { justifyContent: 'flex-end' } }, h('span', { style: { fontSize: '11px' } }, 'Waiting to send. It goes out when the reply above ends.'),
        h('button', { type: 'button', class: 'mini', style: { color: 'inherit' }, title: 'Remove the waiting message', onclick: () => { input.value = input.value || queued; queued = null; paintQueue(); paintBtn(); } }, 'Remove')));
    chatEl.insertBefore(queueEl, chatEl.querySelector(':scope > .approvals')); toBottom();
  };
  function queue(text) {
    if (queued) toast('The waiting message is replaced by the new one.');
    queued = text; input.value = ''; paintQueue(); paintBtn();
  }
  async function flushQueue() {
    if (!queued || chat?.running || busy) return;
    const t = queued; queued = null; paintQueue(); await send(t);
  }
  /** A side-panel prefix with nothing after it is never sent: it stays in the box with one line saying what is missing. */
  const bare = (t) => { const b = bareStart(t); if (!b) return false; prefill(PANEL_PREFIXES[b]); toast(BARE_LINES[b]); return true; };
  form.onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t || bare(t)) return; if (chat?.running) queue(t); else send(t); };
  sendBtn.type = 'button';
  sendBtn.onclick = () => { const t = input.value.trim(); if (!t) { if (chat?.running) stop(); return; } if (bare(t)) return; if (chat?.running) queue(t); else send(t); };
  async function send(text, chipOf = null) {
    text = String(text || '').trim(); if (!text || !chat || bare(text)) return;
    if (!chipOf && prefillChip && prefillChip.text === text) chipOf = { chip: true, needsBusiness: !!prefillChip.needsBusiness };
    prefillChip = null;
    if (busy) { queue(text); return; }
    if (ui.state.panic?.halted) { input.value = input.value || text; return toast('Everything is stopped. Press Resume first.', 'err'); }
    busy = true; input.value = '';
    try { setRunning(true); await api(API + `chats/${chat.id}/send`, { body: { text, ...(chipOf || {}) } }); }
    catch (e) { if (e.status === 409) { busy = false; chat.running = true; queue(text); return; } setRunning(false); input.value = text; toast(e.message, 'err'); }
    finally { busy = false; paintBtn(); }
  }
  async function stop() { try { await api(API + `chats/${chat.id}/stop`, { method: 'POST' }); } catch (e) { toast(e.message, 'err'); } }
  const speaker = () => chat ? (chat.members.length === 1 ? chat.members[0] : 'coordinator') : 'coordinator';
  async function paintUnder() {
    const online = ui.state.settings.online !== false;
    const sec = ui.state.security || {};
    const until = sec.autoApproveUntil && new Date(sec.autoApproveUntil) > new Date() ? sec.autoApproveUntil : null;
    const mins = until ? Math.max(1, Math.round((new Date(until) - Date.now()) / 60000)) : 0;
    const net = h('button', { class: 'mini', id: 'net', type: 'button', title: 'Online or offline. Offline uses only models on this PC.', onclick: async () => { try { await ui.setOnline(!online); paintUnder(); } catch (e) { toast(e.message, 'err'); } } }, h('i', { class: 'dot' + (online ? ' on' : '') }), h('span', null, online ? 'Online' : 'Offline'));
    const mdl = h('button', { class: 'mini', id: 'mdl-pick', type: 'button', title: 'The model that will answer. Change it in Models.', onclick: () => ui.go('models') }, '…');
    const lvl = h('button', { class: 'mini', id: 'lvl-chip', type: 'button', title: 'Security level. Change it in Settings › Security.', onclick: () => ui.go('settings', 'security') }, cap(sec.level || 'open'));
    const auto = h('button', { class: 'mini', id: 'auto', type: 'button', 'aria-pressed': String(!!until), title: 'Approve asks by itself for a while (never sending to a person, never spending over your limits)', onclick: async () => {
      const next = !until ? 15 : mins <= 15 ? 60 : mins <= 60 ? 'today' : 0;
      try { await ui.setAutoApprove(next); paintUnder(); } catch (e) { toast(e.message, 'err'); }
    } }, until ? (mins > 60 ? 'Auto-approve · today' : `Auto-approve · ${mins} min`) : 'Auto-approve off');
    const attach = h('button', { class: 'mini', type: 'button', title: 'Add a file to this chat', onclick: () => fileIn.click() }, 'Attach');
    const add = h('a', { class: 'mini', id: 'mdl-add', href: '#/models', hidden: true, title: 'Pick a model, or add an API key, in Models' }, 'Select model / Add API');
    under.replaceChildren(net, mdl, add, lvl, auto, attach);
    try {
      const a = await api(`agents/${speaker()}`);
      const first = online ? (a.resolved?.chain || [])[0] : (a.resolved?.chain || []).find(c => c.provider === 'ollama' || String(c.provider).startsWith('lan:'));
      const pname = first ? (first.provider === 'router' ? first.name : PROVIDER_NAMES[first.provider]) || (String(first.provider).startsWith('lan:') ? 'LAN node' : first.provider) : null;
      const lastLabel = [...messages].reverse().find(m => m.role === 'assistant' && m.agentId === speaker() && m.label && m.status === 'done')?.label;
      mdl.textContent = !first ? 'No model set up' : first.model ? `${pname} · ${first.model}` : `${pname} · auto${lastLabel ? ' (last: ' + lastLabel.replace(/^.*? · /, '') + ')' : ''}`;
      // no keyed or local model: the way to one stays in reach (before the first exchange it is the main button above the box)
      const own = (a.resolved?.whenOnline || a.resolved?.chain || []).some(c => !['router', 'ollama'].includes(c.provider) || (c.provider === 'ollama' && c.model)) || !!ui.state.settings['ollama.model'];
      add.hidden = own || deskStarted === false;
    } catch { mdl.textContent = 'Models'; }
  }
  fileIn.onchange = async () => {
    for (const f of [...fileIn.files]) {
      try {
        const r = await fetch(`/api/m/chat/chats/${encodeURIComponent(chat.id)}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-apd-session': document.querySelector('meta[name="apd-session"]').content }, body: f });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Upload failed');
        toast(j.read ? `${j.name} is in the chat.` : `${j.name} is saved in your inbox.`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }
    fileIn.value = '';
  };
  if (ui.moduleOn('voice')) {
    ui.moduleUi('voice').then(() => {
      if (!alive || !window.apdVoice?.listen) return;
      micBtn.hidden = false;
      micBtn.onclick = () => { try { window.apdVoice.listen((t) => { if (t) { input.value = (input.value ? input.value + ' ' : '') + t; input.focus(); } }); } catch (e) { toast(e.message, 'err'); } };
    }).catch(() => {});
  }

  // ---------- panel
  async function paintDrawer() {
    if (!chat) return;
    const name = chatTitle(chat);
    const memberPills = chat.members.map(id => h('span', { class: 'pill' }, agentName(id)));
    const tasks = h('div'); const outputs = h('div');
    const files = uniqueOutputs(messages).slice(0, 8);
    outputs.replaceChildren(...(files.length ? files.map(f => line(f.name || baseName(f.path), `${m_name(f.by)} · ${fmt.when(f.at)}`, btn('Open', { kind: 'ghost sm', onClick: () => { openFile(f.path); } }))) : [h('p', { class: 'sub' }, 'Files made in this chat show here.')]));
    const swarm = ui.seg(['1', '5', '20', '50'], Math.max(0, ['1', '5', '20', '50'].indexOf(String(chat.settings.swarm || 5))), (v) => saveSettings({ swarm: Number(v) }));
    drawerBody.replaceChildren(
      h('div', { style: { textAlign: 'center', padding: '6px 0' } }, h('span', { class: 'av big', style: { margin: '0 auto 6px' } }, initials(name)), h('b', null, name)),
      h('div', { class: 'chips', style: { justifyContent: 'center', margin: '4px 0' } }, memberPills),
      h('h6', { style: { marginLeft: 0 } }, 'Suggested'),
      line('Create a routine', 'Run this on a timetable', btn('Add', { kind: 'ghost sm', onClick: () => panelPrefix('routine') })),
      line('Turn into a task', 'Keeps working after you leave', btn('Add', { kind: 'ghost sm', onClick: panelTask })),
      line('Add an agent', 'Or change who is in this chat', btn('Add', { kind: 'ghost sm', onClick: editMembers })),
      h('h6', { style: { marginLeft: 0 } }, 'Background tasks'), tasks,
      h('h6', { style: { marginLeft: 0 } }, 'Outputs'), outputs,
      h('h6', { style: { marginLeft: 0 } }, 'This chat'),
      line('Deep research in chat', 'Research runs right here', sw(chat.settings.deepResearch !== false, 'Deep research in chat', (v) => saveSettings({ deepResearch: v }))),
      line('Swarm size', 'Agents in parallel', swarm),
      line('Remember this chat', 'Agents may learn from it', sw(chat.settings.remember !== false, 'Remember this chat', (v) => saveSettings({ remember: v }))),
      h('div', { class: 'row', style: { marginTop: '8px' } }, btn('Rename', { kind: 'ghost sm', onClick: rename }), btn(chat.seeded ? 'Clear messages' : 'Delete chat', { kind: 'ghost sm', onClick: remove })));
    try {
      const j = await api('jobs?limit=60');
      const mine = j.jobs.filter(x => x.chatId === chat.id && ['running', 'waiting'].includes(x.status)).concat(j.jobs.filter(x => x.chatId === chat.id && !['running', 'waiting'].includes(x.status)).slice(0, 3));
      tasks.replaceChildren(...(mine.length ? mine.map(x => line(x.title, `${m_name(x.agentId)}${x.detail ? ' · ' + x.detail : ''}`, pill(x.status === 'running' ? fmt.pct(x.progress) : (STATUS[x.status] || [x.status])[0], (STATUS[x.status] || [])[1] || ''))) : [h('p', { class: 'sub' }, 'Nothing running for this chat.')]));
    } catch { tasks.replaceChildren(); }
  }
  const m_name = (id) => agentName(id);
  async function saveSettings(p) { try { chat = { ...chat, ...(await api(API + `chats/${chat.id}`, { method: 'PATCH', body: { settings: p } })) }; } catch (e) { toast(e.message, 'err'); return false; } }
  function prefill(t) { input.value = t; input.focus(); paintBtn(); }
  // The side panel's prefixes: with text in the box the prefix goes in front of it; with an empty box the prefix waits there
  // for him to type. Nothing is sent from here.
  function panelPrefix(kind) {
    const p = PANEL_PREFIXES[kind]; const typed = input.value.trim();
    if (narrow()) setPanel(false);
    prefill(!typed || bareStart(typed) ? p : typed.toLowerCase().startsWith(p.trim().toLowerCase()) ? typed : p + typed);
  }
  // "Turn into a task" with an empty box offers the chat's last ask, as it was, with Run and Cancel
  let offerEl = null;
  function panelTask() {
    const ask = input.value.trim() && !bareStart(input.value) ? null : lastAsk(messages);
    if (!ask) return panelPrefix('task');
    if (narrow()) setPanel(false);
    offerEl?.remove();
    const close = () => { offerEl?.remove(); offerEl = null; };
    offerEl = h('div', { class: 'msg it', 'data-role': 'offer' }, h('div', null, 'Run this again in the background: ' + cutAtWord(ask, 90)),
      h('div', { class: 'act' }, btn('Run', { kind: 'sm', onClick: () => { close(); send(PANEL_PREFIXES.task + ask); } }), btn('Cancel', { kind: 'ghost sm', onClick: () => { close(); input.focus(); } })));
    chatEl.insertBefore(offerEl, queueEl || chatEl.querySelector(':scope > .approvals')); toBottom();
  }
  async function rename() { const t = await ui.ask('Name this chat', { value: chat.title || '' }); if (t == null || !t.trim()) return; try { chat = { ...chat, ...(await api(API + `chats/${chat.id}`, { method: 'PATCH', body: { title: t.trim() } })) }; paintHeader(); paintDrawer(); loadChats(); } catch (e) { toast(e.message, 'err'); } }
  async function remove() {
    if (!await ui.confirm(chat.seeded ? 'Clear every message in this chat?' : 'Delete this chat and its messages? Files it made stay in Files.', { ok: chat.seeded ? 'Clear' : 'Delete', kind: 'stop' })) return;
    try { await api(API + `chats/${chat.id}`, { method: 'DELETE' }); await loadChats(); open(chat.seeded ? chat.id : 'everyone'); } catch (e) { toast(e.message, 'err'); }
  }
  function editMembers() {
    const picked = new Set(chat.members);
    const box = h('div', { class: 'stack', style: { gap: '4px' } }, ui.state.agents.map(a => h('label', { class: 'row', style: { gap: '8px' } }, h('input', { type: 'checkbox', checked: picked.has(a.id), onchange: (e) => e.target.checked ? picked.add(a.id) : picked.delete(a.id) }), h('b', null, a.name), h('span', { class: 'sub' }, a.role))));
    ui.modal({ title: 'Who is in this chat', body: box, actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => { if (!picked.size) { toast('Pick at least one agent.', 'err'); return false; } try { chat = await api(API + `chats/${chat.id}/members`, { method: 'PUT', body: { members: [...picked] } }); paintHeader(); paintUnder(); paintDrawer(); loadChats(); } catch (e) { toast(e.message, 'err'); return false; } } }] });
  }

  // ---------- open a chat
  async function open(id) {
    if (!id) return;
    let r;
    try { r = await api(API + `chats/${encodeURIComponent(id)}/messages`); }
    catch (e) { if (id !== 'everyone') return open('everyone'); toast(e.message, 'err'); return; }
    if (!alive) return;
    chat = r.chat; messages = r.messages; streaming.clear();
    try { localStorage.setItem('apd-chat', chat.id); } catch {}
    if (location.hash !== '#/chat/' + encodeURIComponent(chat.id)) history.replaceState(null, '', '#/chat/' + encodeURIComponent(chat.id));
    setRunning(!!chat.running);
    paintRail(); paintHeader(); paintMessages(); paintDrawer(); paintUnder();
    if (await loadRenderers()) paintMessages();
  }

  // ---------- live events
  let chatsTimer = null;
  ui.on('chat', (d) => {
    if (!d || !alive) return;
    if (d.type === 'chats') { clearTimeout(chatsTimer); chatsTimer = setTimeout(loadChats, 300); return; }
    if (!chat || d.chatId !== chat.id) { if (d.type === 'message') { clearTimeout(chatsTimer); chatsTimer = setTimeout(loadChats, 600); } return; }
    if (d.type === 'delta') {
      streaming.set(d.messageId, (streaming.get(d.messageId) || '') + d.text);
      const m = messages.find(x => x.id === d.messageId); if (m) scheduleStream(m);
    } else if (d.type === 'reset') { streaming.set(d.messageId, ''); }
    else if (d.type === 'message' && d.message) {
      upsert(d.message);
      if (d.message.role === 'assistant' && d.message.status !== 'streaming' && d.message.id === Math.max(...messages.filter(x => x.role === 'assistant').map(x => x.id))) { setRunning(false); if (d.message.label) paintUnder(); }
      if (d.message.status === 'streaming') setRunning(true);
      if ((d.message.cards || []).some(c => c.kind === 'file' || String(c.kind).includes('.'))) { paintDrawer(); loadRenderers().then(a => a && repaintSoon()); }
    }
  });
  const pendingPaint = new Set(); let raf = 0;
  function scheduleStream(m) { pendingPaint.add(m.id); if (raf) return; raf = requestAnimationFrame(() => { raf = 0; for (const id of pendingPaint) { const mm = messages.find(x => x.id === id); if (mm) upsert(mm); } pendingPaint.clear(); }); }
  ui.on('approval', () => setTimeout(() => { if (!alive) return; const old = chatEl.querySelector(':scope > .approvals'); if (old) old.replaceWith(approvalsEl()); if (messages.some(m => (m.cards || []).some(c => c.kind === 'draft'))) repaintSoon(); }, 250));
  let jobTimer = null;
  ui.on('job', (j) => { if (chat && j?.chatId === chat.id) { clearTimeout(jobTimer); jobTimer = setTimeout(paintDrawer, 400); } });
  ui.on('agents', () => setTimeout(() => { if (alive) { paintRail(); paintHeader(); paintUnder(); } }, 300));
  ui.on('security', () => setTimeout(paintUnder, 50));
  ui.on('settings', () => setTimeout(paintUnder, 50));
  ui.on('panic', (st) => { if (st?.halted) setRunning(false); });

  await loadChats();
  await open(curId);
  let pre = null; try { pre = sessionStorage.getItem('apd-prefill'); sessionStorage.removeItem('apd-prefill'); prefillChip = JSON.parse(sessionStorage.getItem('apd-prefill-chip') || 'null'); sessionStorage.removeItem('apd-prefill-chip'); } catch {}
  if (pre) prefill(pre); else input.focus();
}

function initials(name) { return String(name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
