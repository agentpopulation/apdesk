// Chats and messages in m_chat_* tables. Cards live inside messages, so they survive a closed browser and a restart.
import { previewText, cutAtWord } from './ui-text.js';
const now = () => new Date().toISOString();
const j = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };

export const SEED_GROUPS = [
  { id: 'everyone', title: 'Everyone', members: null },                 // null = every agent on the roster
  { id: 'sales-room', title: 'Sales room', members: ['coordinator', 'closer', 'scout'] },
  { id: 'build-room', title: 'Build room', members: ['coordinator', 'coder', 'operator'] },
];

export function makeStore(ctx) {
  const db = ctx.db;
  db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_chat_chats (id TEXT PRIMARY KEY, title TEXT, kind TEXT, members TEXT, opts TEXT, created TEXT, updated TEXT, last TEXT, seeded INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS m_chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT, text TEXT, cards TEXT, label TEXT, status TEXT, meta TEXT, at TEXT, updated TEXT);
    CREATE INDEX IF NOT EXISTS m_chat_messages_chat ON m_chat_messages(chat_id, id);`);

  const roster = () => ctx.agents.list().map(a => a.id);
  const chatRow = (r) => {
    if (!r) return null;
    const members = r.members === null || r.members === 'null' ? roster() : j(r.members, []).filter(id => ctx.agents.get(id));
    return { id: r.id, title: r.title, kind: members.length === 1 ? 'direct' : 'group', members, everyone: r.members === null || r.members === 'null', settings: { deepResearch: true, swarm: 5, remember: true, ...j(r.opts, {}) }, created: r.created, updated: r.updated, last: r.last || '', seeded: !!r.seeded };
  };
  const msgRow = (r) => r && ({ id: r.id, chatId: r.chat_id, role: r.role, agentId: r.agent_id, text: r.text || '', cards: j(r.cards, []), label: r.label || null, status: r.status || 'done', meta: j(r.meta, {}), at: r.at, updated: r.updated });

  const s = {
    /** The starting groups; a room the first-start step left out (too few of its agents on the team) is not made again. */
    seed(hidden = []) {
      for (const g of SEED_GROUPS) if (!hidden.includes(g.id) && !db.get('SELECT 1 AS x FROM m_chat_chats WHERE id = ?', g.id)) {
        const t = now(); db.run('INSERT INTO m_chat_chats (id, title, kind, members, opts, created, updated, last, seeded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)', g.id, g.title, 'group', g.members ? JSON.stringify(g.members) : null, '{}', t, t, '');
      }
    },
    chat(id) { return chatRow(db.get('SELECT * FROM m_chat_chats WHERE id = ?', id)); },
    /** The direct chat with one agent; made on first use. */
    direct(agentId) {
      const id = 'dm-' + agentId;
      if (!db.get('SELECT 1 AS x FROM m_chat_chats WHERE id = ?', id)) { const t = now(); db.run('INSERT INTO m_chat_chats (id, title, kind, members, opts, created, updated, last, seeded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)', id, null, 'direct', JSON.stringify([agentId]), '{}', t, t, ''); }
      return s.chat(id);
    },
    create({ title, members }) {
      const id = 'c' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); const t = now();
      const m = Array.isArray(members) && members.length ? members.filter(x => ctx.agents.get(x)) : ['coordinator'];
      db.run('INSERT INTO m_chat_chats (id, title, kind, members, opts, created, updated, last, seeded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)', id, title || 'New chat', m.length === 1 ? 'direct' : 'group', JSON.stringify(m), '{}', t, t, '');
      return s.chat(id);
    },
    list() { return db.all('SELECT * FROM m_chat_chats ORDER BY updated DESC').map(chatRow); },
    rename(id, title) { db.run('UPDATE m_chat_chats SET title = ?, updated = ? WHERE id = ?', String(title || '').slice(0, 120), now(), id); return s.chat(id); },
    setMembers(id, members) { db.run('UPDATE m_chat_chats SET members = ?, updated = ? WHERE id = ?', members === null ? null : JSON.stringify(members), now(), id); return s.chat(id); },
    setSettings(id, patch) { const c = s.chat(id); db.run('UPDATE m_chat_chats SET opts = ? WHERE id = ?', JSON.stringify({ ...c.settings, ...patch }), id); return s.chat(id); },
    remove(id) { db.run('DELETE FROM m_chat_messages WHERE chat_id = ?', id); db.run('DELETE FROM m_chat_chats WHERE id = ?', id); },
    touch(id, last) { db.run('UPDATE m_chat_chats SET updated = ?, last = ? WHERE id = ?', now(), cutAtWord(previewText(last), 140), id); },
    messages(chatId, { limit = 200, after = 0 } = {}) {
      return db.all('SELECT * FROM (SELECT * FROM m_chat_messages WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id', chatId, Number(after) || 0, limit).map(msgRow);
    },
    message(id) { return msgRow(db.get('SELECT * FROM m_chat_messages WHERE id = ?', id)); },
    add(chatId, { role, agentId = null, text = '', cards = [], label = null, status = 'done', meta = {} }) {
      const t = now();
      const r = db.run('INSERT INTO m_chat_messages (chat_id, role, agent_id, text, cards, label, status, meta, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', chatId, role, agentId, text, JSON.stringify(cards || []), label, status, JSON.stringify(meta || {}), t, t);
      return s.message(Number(r.lastInsertRowid));
    },
    update(id, patch) {
      const cur = s.message(id); if (!cur) return null;
      const n = { ...cur, ...patch, meta: { ...cur.meta, ...(patch.meta || {}) } };
      db.run('UPDATE m_chat_messages SET text = ?, cards = ?, label = ?, status = ?, meta = ?, agent_id = ?, updated = ? WHERE id = ?', n.text, JSON.stringify(n.cards || []), n.label, n.status, JSON.stringify(n.meta), n.agentId, now(), id);
      return s.message(id);
    },
    /** The message holding a progress card with this card id or job id (newest first). */
    findProgress(chatId, { id, jobId }) {
      const rows = db.all("SELECT * FROM m_chat_messages WHERE chat_id = ? AND cards LIKE '%progress%' ORDER BY id DESC LIMIT 200", chatId).map(msgRow);
      for (const m of rows) { const i = m.cards.findIndex(c => c && c.kind === 'progress' && ((id && c.id === id) || (jobId && c.jobId === jobId))); if (i >= 0) return { message: m, index: i }; }
      return null;
    },
    /** The message holding a card of this kind with the same id (or, for drafts, the same approval). */
    findCard(chatId, card) {
      const rows = db.all("SELECT * FROM m_chat_messages WHERE chat_id = ? AND cards LIKE ? ORDER BY id DESC LIMIT 200", chatId, '%' + card.kind + '%').map(msgRow);
      for (const m of rows) { const i = m.cards.findIndex(c => c && c.kind === card.kind && ((card.id && c.id === card.id) || (card.approvalId && c.approvalId === card.approvalId))); if (i >= 0) return { message: m, index: i }; }
      return null;
    },
    /** Has an owner message on this desk been answered by a reply that finished (any chat)? */
    exchanged() { return !!db.get("SELECT 1 AS x FROM m_chat_messages a WHERE a.role = 'assistant' AND a.status = 'done' AND EXISTS (SELECT 1 FROM m_chat_messages u WHERE u.chat_id = a.chat_id AND u.role = 'user' AND u.id < a.id) LIMIT 1"); },
    /** Finished exchanges on this desk (any chat) whose reply is newer than message `after`: a reply that finished right after
     *  an owner message (system lines between them do not count). A job's or a schedule's turn is not the owner typing. */
    exchanges(after = 0) {
      return db.get("SELECT COUNT(*) AS n FROM m_chat_messages a WHERE a.id > ? AND a.role = 'assistant' AND a.status = 'done' AND json_extract(a.meta, '$.jobOf') IS NULL AND json_extract(a.meta, '$.note') IS NULL AND (SELECT p.role FROM m_chat_messages p WHERE p.chat_id = a.chat_id AND p.id < a.id AND p.role != 'system' ORDER BY p.id DESC LIMIT 1) = 'user'", Number(after) || 0).n;
    },
    lastId() { return db.get('SELECT MAX(id) AS n FROM m_chat_messages')?.n || 0; },
    lastOf(chatId) { return msgRow(db.get('SELECT * FROM m_chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1', chatId)); },
  };
  return s;
}
