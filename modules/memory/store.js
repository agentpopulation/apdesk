// Memory store: one table and one FTS5 index in the desk's SQLite file. No model calls here.
// Also the clip helper and the Dream age thresholds (7 and 30 days).

export const KINDS = ['fact', 'preference', 'lesson', 'summary'];
export const SHARED = '';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const STALE_AGE_DAYS = 7;
export const FORGET_AGE_DAYS = 30;

export const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const scopeOf = (agentId) => (!agentId || agentId === 'shared' || agentId === 'all') ? SHARED : String(agentId);
const nowIso = () => new Date().toISOString();

const STOP = new Set('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its me my of on or our she so than that the their them then there these they this to was we were what when where which who whom why will with would you your yours about please tell know remember recall again any some just also very much more most should shall may might am'.split(' '));
export function terms(text, max = 12) {
  const words = String(text || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{2,}/gu) || [];
  const out = []; for (const w of words) if (!STOP.has(w) && !out.includes(w)) out.push(w);
  return out.slice(0, max);
}
export const normText = (s) => terms(s, 64).sort().join(' ');
export function jaccard(a, b) { const A = new Set(terms(a, 64)), B = new Set(terms(b, 64)); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n); }

export function migrate(db) {
  db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      keys TEXT NOT NULL DEFAULT '',
      source_chat TEXT,
      source TEXT,
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      uses INTEGER NOT NULL DEFAULT 0,
      last_used TEXT,
      merged_into INTEGER,
      vec TEXT,
      vec_model TEXT
    );
    CREATE INDEX IF NOT EXISTS m_memory_items_agent ON m_memory_items(agent_id, kind);
    CREATE VIRTUAL TABLE IF NOT EXISTS m_memory_fts USING fts5(text, keys, tokenize = 'porter unicode61');
  `);
}

const row = (r) => r && ({ id: r.id, agentId: r.agent_id || null, text: r.text, kind: r.kind, keys: r.keys || '', sourceChat: r.source_chat || null, source: r.source || null, at: r.created, updated: r.updated, weight: Math.round(r.weight * 100) / 100, uses: r.uses, lastUsed: r.last_used || null });

export class Store {
  constructor(db) { this.db = db; migrate(db); }
  get(id) { return row(this.db.get('SELECT * FROM m_memory_items WHERE id = ? AND merged_into IS NULL', Number(id))); }
  add({ agentId, text, kind = 'fact', keys = '', sourceChat = null, source = 'owner', weight = 1 }) {
    const t = clip(text, 600); if (!t) throw Object.assign(new Error('Write something to remember.'), { status: 400 });
    const k = KINDS.includes(kind) ? kind : 'fact';
    const scope = scopeOf(agentId); const at = nowIso();
    // the same text in the same scope is not stored twice
    const same = this.db.all('SELECT * FROM m_memory_items WHERE agent_id = ? AND merged_into IS NULL AND kind = ?', scope, k).find(r => normText(r.text) === normText(t));
    if (same) { this.db.run('UPDATE m_memory_items SET weight = MIN(weight + 0.2, 3), updated = ? WHERE id = ?', at, same.id); return { ...row(same), duplicate: true }; }
    let id;
    this.db.transaction(() => {
      const r = this.db.run('INSERT INTO m_memory_items (agent_id, text, kind, keys, source_chat, source, created, updated, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', scope, t, k, String(keys || ''), sourceChat, source, at, at, weight);
      id = Number(r.lastInsertRowid);
      this.db.run('INSERT INTO m_memory_fts (rowid, text, keys) VALUES (?, ?, ?)', id, t, String(keys || ''));
    });
    return this.get(id);
  }
  update(id, patch = {}) {
    const cur = this.db.get('SELECT * FROM m_memory_items WHERE id = ?', Number(id)); if (!cur) return null;
    const text = patch.text != null ? clip(patch.text, 600) : cur.text;
    const kind = patch.kind && KINDS.includes(patch.kind) ? patch.kind : cur.kind;
    const keys = patch.keys != null ? String(patch.keys) : cur.keys;
    const weight = patch.weight != null ? Math.max(0.05, Math.min(3, Number(patch.weight))) : cur.weight;
    const vecReset = text !== cur.text;
    this.db.transaction(() => {
      this.db.run(`UPDATE m_memory_items SET text = ?, kind = ?, keys = ?, weight = ?, updated = ?${vecReset ? ', vec = NULL, vec_model = NULL' : ''} WHERE id = ?`, text, kind, keys, weight, nowIso(), cur.id);
      this.db.run('DELETE FROM m_memory_fts WHERE rowid = ?', cur.id);
      this.db.run('INSERT INTO m_memory_fts (rowid, text, keys) VALUES (?, ?, ?)', cur.id, text, keys);
    });
    return this.get(cur.id);
  }
  setVector(id, vec, model) { this.db.run('UPDATE m_memory_items SET vec = ?, vec_model = ? WHERE id = ?', JSON.stringify(vec), model, Number(id)); }
  forget(id) { this.db.transaction(() => { this.db.run('DELETE FROM m_memory_fts WHERE rowid = ?', Number(id)); this.db.run('DELETE FROM m_memory_items WHERE id = ?', Number(id)); }); }
  mergeInto(keepId, otherIds, text) {
    this.db.transaction(() => {
      for (const o of otherIds) { if (Number(o) === Number(keepId)) continue; this.db.run('UPDATE m_memory_items SET merged_into = ?, updated = ? WHERE id = ?', Number(keepId), nowIso(), Number(o)); this.db.run('DELETE FROM m_memory_fts WHERE rowid = ?', Number(o)); }
    });
    const kept = this.db.get('SELECT * FROM m_memory_items WHERE id = ?', Number(keepId));
    return this.update(keepId, { text: text || kept.text, weight: Math.min(3, kept.weight + 0.2 * otherIds.length) });
  }
  forgetAll(agentId) {
    if (agentId === undefined) { this.db.transaction(() => { this.db.run('DELETE FROM m_memory_fts'); this.db.run('DELETE FROM m_memory_items'); }); return; }
    const ids = this.db.all('SELECT id FROM m_memory_items WHERE agent_id = ?', scopeOf(agentId)).map(r => r.id);
    this.db.transaction(() => { for (const id of ids) this.db.run('DELETE FROM m_memory_fts WHERE rowid = ?', id); this.db.run('DELETE FROM m_memory_items WHERE agent_id = ?', scopeOf(agentId)); });
  }
  /** Memories of one agent (and, when shared is true, the ones every agent shares). */
  list({ agentId, shared = true, kind, since, limit = 500 } = {}) {
    const where = ['merged_into IS NULL']; const p = [];
    if (agentId !== undefined) { const s = scopeOf(agentId); if (shared && s !== SHARED) { where.push('agent_id IN (?, ?)'); p.push(s, SHARED); } else { where.push('agent_id = ?'); p.push(s); } }
    if (kind) { where.push('kind = ?'); p.push(kind); }
    if (since) { where.push('created >= ?'); p.push(since); }
    return this.db.all(`SELECT * FROM m_memory_items WHERE ${where.join(' AND ')} ORDER BY created DESC LIMIT ?`, ...p, limit).map(row);
  }
  counts() { return this.db.all('SELECT agent_id, kind, COUNT(*) AS n FROM m_memory_items WHERE merged_into IS NULL GROUP BY agent_id, kind'); }
  /** Full-text search with stemming over the text and the extra search words. Fast; never calls a model. */
  search({ agentId, query, limit = 5, kinds, shared = true }) {
    const ts = terms(query); if (!ts.length) return [];
    const match = ts.map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ');
    const s = scopeOf(agentId); const scopes = shared && s !== SHARED ? [s, SHARED] : [s];
    let sql = `SELECT i.*, bm25(m_memory_fts, 1.0, 0.6) AS score FROM m_memory_fts JOIN m_memory_items i ON i.id = m_memory_fts.rowid
      WHERE m_memory_fts MATCH ? AND i.merged_into IS NULL AND i.agent_id IN (${scopes.map(() => '?').join(',')})`;
    const p = [match, ...scopes];
    if (kinds?.length) { sql += ` AND i.kind IN (${kinds.map(() => '?').join(',')})`; p.push(...kinds); }
    sql += ' ORDER BY score LIMIT 40';
    let rows; try { rows = this.db.all(sql, ...p); } catch { return []; }
    // bm25 is negative (more negative is better); scale by weight; count how many query words hit
    return rows.map(r => {
      const hay = terms(r.text + ' ' + r.keys, 200).join(' ');
      const hits = ts.filter(t => hay.includes(t.slice(0, Math.max(4, t.length - 2)))).length;
      return { ...row(r), score: -r.score * (0.5 + r.weight / 2), hits };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  vectors({ agentId }) { const s = scopeOf(agentId); return this.db.all('SELECT * FROM m_memory_items WHERE merged_into IS NULL AND vec IS NOT NULL AND agent_id IN (?, ?)', s, SHARED).map(r => ({ ...row(r), vec: JSON.parse(r.vec), vecModel: r.vec_model })); }
  touch(ids) { const at = nowIso(); for (const id of ids) this.db.run('UPDATE m_memory_items SET uses = uses + 1, last_used = ? WHERE id = ?', at, Number(id)); }
}
