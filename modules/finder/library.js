// The private library: every page Finder reads is kept here (unless its site is on the "never keep" list), split into
// passages and indexed with SQLite FTS5, so it can be searched first and while Offline. Oldest pages go first past the
// size limit. Stored page text is untrusted web data; it is only ever returned as text.
import { splitPassages, keywords, tokens, rankPassages } from './rank.js';
import { normUrl } from '../search/providers.js';
import { ruleDomain, cleanHost } from '../network/rules.js';

export const DEFAULT_LIMIT_MB = 100;
// What a page takes in the file: its text once, plus its search index and spans. Measured on stand-in pages the index
// came to 0.45 to 0.85 of the text, so a page counts as twice its text and the file stays within the limit shown.
const storedBytes = (text) => 2 * Buffer.byteLength(text);
const hostOf = (u) => { try { return cleanHost(new URL(String(u)).hostname); } catch { return ''; } };

export function migrateLibrary(db) {
  db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_finder_pages (id INTEGER PRIMARY KEY AUTOINCREMENT, norm TEXT NOT NULL UNIQUE, url TEXT NOT NULL, host TEXT, title TEXT, kind TEXT, text TEXT, bytes INTEGER, read_at TEXT);
    CREATE INDEX IF NOT EXISTS m_finder_pages_read ON m_finder_pages (read_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS m_finder_passages USING fts5(body, page_id UNINDEXED, pos UNINDEXED, tokenize = 'porter unicode61');`);
  // 2: the passage text is no longer stored a second time (a contentless index over spans of the page text), and a
  // page's passages are found by an index, so removing a page does not scan the whole library.
  db.migrate(2, (d) => {
    d.exec(`DROP TABLE IF EXISTS m_finder_passages;
      CREATE TABLE IF NOT EXISTS m_finder_spans (id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL, pos INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS m_finder_spans_page ON m_finder_spans (page_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS m_finder_passages USING fts5(body, content = '', contentless_delete = 1, tokenize = 'porter unicode61');`);
    for (const r of d.all('SELECT id, text FROM m_finder_pages')) indexPage(d, r.id, r.text);
    d.run('UPDATE m_finder_pages SET bytes = 2 * LENGTH(CAST(text AS BLOB))');            // counted as below
  });
}
function indexPage(db, id, text) {
  const span = db.prepare('INSERT INTO m_finder_spans (page_id, pos, start, end) VALUES (?, ?, ?, ?)');
  const ins = db.prepare('INSERT INTO m_finder_passages (rowid, body) VALUES (?, ?)');
  for (const p of splitPassages(text)) { const r = span.run(id, p.pos, p.start, p.end); ins.run(Number(r.lastInsertRowid), p.text); }
}

/**
 * createLibrary(db, kv) -> { keep, get, search, stats, clear, neverKeep, setNeverKeep, setLimitMb, isNeverKeep }
 * db is the module's storage door (ctx.db), kv its settings (ctx.kv).
 */
export function createLibrary(db, kv) {
  migrateLibrary(db);
  const limitBytes = () => Math.round(Number(kv.get('limitMb', DEFAULT_LIMIT_MB)) * 1024 * 1024);
  const neverKeep = () => kv.get('neverKeep', []);

  const isNeverKeep = (url) => { const h = hostOf(url); return !!h && neverKeep().some((d) => h === d || h.endsWith('.' + d)); };

  function remove(id) {
    const r = db.get('SELECT MIN(id) AS a, MAX(id) AS b FROM m_finder_spans WHERE page_id = ?', id);   // a page's spans are written together, so their ids run on
    if (r?.a != null) db.run('DELETE FROM m_finder_passages WHERE rowid BETWEEN ? AND ?', r.a, r.b);
    db.run('DELETE FROM m_finder_spans WHERE page_id = ?', id); db.run('DELETE FROM m_finder_pages WHERE id = ?', id);
  }
  function prune() {
    let total = db.get('SELECT COALESCE(SUM(bytes), 0) AS n FROM m_finder_pages').n; let removed = 0;
    const max = limitBytes(); if (total <= max) return 0;
    const old = db.all('SELECT id, bytes FROM m_finder_pages ORDER BY read_at ASC, id ASC'); const drop = [];
    for (const o of old) { if (total <= max) break; drop.push(o.id); total -= o.bytes; }
    db.transaction(() => {
      if (drop.length <= 20) { for (const id of drop) { remove(id); removed++; } return; }
      // many at once (the limit was lowered): dropping rows from the index one by one is slow, so build it again from what stays
      for (const id of drop) { db.run('DELETE FROM m_finder_spans WHERE page_id = ?', id); db.run('DELETE FROM m_finder_pages WHERE id = ?', id); removed++; }
      db.run("INSERT INTO m_finder_passages (m_finder_passages) VALUES ('delete-all')");
      const ins = db.prepare('INSERT INTO m_finder_passages (rowid, body) VALUES (?, ?)');
      for (const pg of db.all('SELECT id, text FROM m_finder_pages')) for (const sp of db.all('SELECT id, start, end FROM m_finder_spans WHERE page_id = ?', pg.id)) ins.run(sp.id, pg.text.slice(sp.start, sp.end));
    });
    return removed;
  }
  /** Keep one page read from the web. Returns the stored row id, or null when its site is never kept. */
  function keep(page) {
    const url = page.finalUrl || page.url;
    if (!url || !page.text || isNeverKeep(url) || isNeverKeep(page.url)) return null;
    const text = String(page.text); const norm = normUrl(page.url || url);
    let id = null;
    db.transaction(() => {
      const prev = db.get('SELECT id FROM m_finder_pages WHERE norm = ?', norm); if (prev) remove(prev.id);
      db.run('INSERT INTO m_finder_pages (norm, url, host, title, kind, text, bytes, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', norm, url, hostOf(url), String(page.title || '').slice(0, 300), page.kind || 'html', text, storedBytes(text), page.fetchedAt || new Date().toISOString());
      id = db.get('SELECT id FROM m_finder_pages WHERE norm = ?', norm).id;
      indexPage(db, id, text);
    });
    prune();
    return id;
  }
  /** The stored copy of a page, or null. */
  function get(url) {
    const r = db.get('SELECT id, norm, url, host, title, kind, text, bytes, read_at FROM m_finder_pages WHERE norm = ?', normUrl(url));
    return r ? { id: r.id, url: r.url, host: r.host, openedHost: hostOf(r.norm), title: r.title, kind: r.kind, text: r.text, bytes: r.bytes, readAt: r.read_at } : null;
  }
  /**
   * Best passages in the library for a question (FTS5 bm25). `allowed(host)` drops pages the caller may not see now
   * (the website rules). Returns [{ text, url, title, host, readAt, pos, score, from: 'library' }].
   */
  function search(question, { limit = 8, allowed = () => true } = {}) {
    const words = [...new Set([...keywords(question), ...tokens(question)])].slice(0, 16); if (!words.length) return [];   // the folded form too: "won" finds "winning"
    const match = words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' OR ');
    let rows;
    try {
      rows = db.all(`SELECT f.rank AS rank, s.page_id AS page_id, s.pos AS pos, s.start AS start, s.end AS end
        FROM m_finder_passages f JOIN m_finder_spans s ON s.id = f.rowid WHERE m_finder_passages MATCH ? ORDER BY f.rank LIMIT ?`, match, Math.max(limit * 4, 20));
    } catch { return []; }
    const pages = new Map(); const out = [];
    for (const r of rows) {
      if (!pages.has(r.page_id)) pages.set(r.page_id, db.get('SELECT url, norm, title, host, text, read_at FROM m_finder_pages WHERE id = ?', r.page_id) || null);
      const p = pages.get(r.page_id); if (!p) continue;
      if (!allowed(p.host) || !allowed(hostOf(p.norm))) continue;      // the site that was opened and the site it led to
      out.push({ text: p.text.slice(r.start, r.end), url: p.url, title: p.title, host: p.host, readAt: p.read_at, pos: r.pos, start: r.start, from: 'library' });
    }
    // only passages that answer: they read as sentences and have the question's key words (strict: not found for it)
    return rankPassages(question, out, { strict: true }).slice(0, limit);
  }
  function stats() {
    const r = db.get('SELECT COUNT(*) AS pages, COALESCE(SUM(bytes), 0) AS bytes, MIN(read_at) AS oldest FROM m_finder_pages');
    return { pages: r.pages, bytes: r.bytes, oldest: r.oldest || null, limitMb: Number(kv.get('limitMb', DEFAULT_LIMIT_MB)), neverKeep: neverKeep() };
  }
  function clear() { const n = db.get('SELECT COUNT(*) AS n FROM m_finder_pages').n; db.transaction(() => { db.run("INSERT INTO m_finder_passages (m_finder_passages) VALUES ('delete-all')"); db.run('DELETE FROM m_finder_spans'); db.run('DELETE FROM m_finder_pages'); }); return n; }
  /** Add a site to "never keep" and drop what is already kept from it. */
  function addNeverKeep(site) {
    const d = ruleDomain(site);
    const list = [...new Set([...neverKeep(), d])]; kv.set('neverKeep', list);
    const rows = db.all('SELECT id, host, norm FROM m_finder_pages').filter((r) => [r.host, hostOf(r.norm)].some((h) => h === d || String(h).endsWith('.' + d)));
    db.transaction(() => { for (const r of rows) remove(r.id); });
    return { neverKeep: list, removed: rows.length };
  }
  function dropNeverKeep(site) { const list = neverKeep().filter((d) => d !== String(site || '').toLowerCase()); kv.set('neverKeep', list); return list; }
  function setLimitMb(mb) { const n = Math.round(Number(mb)); if (!Number.isFinite(n) || n < 5 || n > 5000) throw Object.assign(new Error('Pick a size from 5 MB to 5000 MB.'), { status: 400 }); kv.set('limitMb', n); return { limitMb: n, removed: prune() }; }
  return { keep, get, search, stats, clear, prune, neverKeep, isNeverKeep, addNeverKeep, dropNeverKeep, setLimitMb };
}
