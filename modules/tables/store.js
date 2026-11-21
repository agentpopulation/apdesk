// Tables storage: m_tables_sources (the recipe: address, the table's signature, what each column is, when last read),
// m_tables_rows (the last good copy of each source's rows) and m_tables_runs (what each read found).
import { MEANING_IDS, normHead } from './extract.js';

const now = () => new Date().toISOString();
const j = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
const rid = () => 'tb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
export const PAGE_LIMIT = { min: 1, max: 20, default: 5 };

/** The owner's column choice, checked: one meaning per column; only Name (first and last name) and Other may repeat. */
export function checkColumns(cols, width) {
  if (!Array.isArray(cols) || cols.length !== width) throw bad('Say what each column is.');
  const out = cols.map(c => String(c || ''));
  if (out.some(c => !MEANING_IDS.includes(c))) throw bad('A column can be name, company, title, mail address, country, network operator, site or other.');
  for (const id of MEANING_IDS) if (!['name', 'other'].includes(id) && out.filter(c => c === id).length > 1) throw bad('Only one column can be the ' + id.replace('email', 'mail address').replace('operator', 'network operator') + '.');
  if (out.every(c => c === 'other')) throw bad('Pick at least one column that is a name, company, mail address or network operator.');
  return out;
}
export const clampPages = (n) => { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.max(PAGE_LIMIT.min, Math.min(PAGE_LIMIT.max, v)) : PAGE_LIMIT.default; };

/** What a row says, by meaning. Name columns are joined (first and last name). */
export function rowValues(cells, columns) {
  const v = { name: '', company: '', title: '', email: '', country: '', operator: '', site: '' };
  columns.forEach((m, i) => { const c = String(cells[i] || '').trim(); if (!c || m === 'other') return; v[m] = m === 'name' ? [v.name, c].filter(Boolean).join(' ') : (v[m] || c); });
  return v;
}
/** One row's identity across reads: its mail address, else name and company, else all its cells. */
export function rowKey(cells, columns) {
  const v = rowValues(cells, columns);
  if (/@/.test(v.email)) return 'm:' + v.email.toLowerCase();
  if (v.name || v.company || v.operator) return 'n:' + [v.name, v.company || v.operator, v.country].map(normHead).join('|');
  return 'c:' + cells.map(normHead).join('|');
}

export class TablesStore {
  constructor(db) {
    this.db = db;
    db.migrate(1, `
      CREATE TABLE IF NOT EXISTS m_tables_sources (id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, kind TEXT NOT NULL, headings TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
        columns TEXT NOT NULL, page_limit INTEGER NOT NULL DEFAULT 5, schedule INTEGER NOT NULL DEFAULT 0, state TEXT, note TEXT, moved_to TEXT, pending TEXT, froms TEXT,
        last_read TEXT, last_ok TEXT, next_at TEXT, fail_count INTEGER NOT NULL DEFAULT 0, pages_read INTEGER, created TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS m_tables_rows (source_id TEXT NOT NULL, key TEXT NOT NULL, cells TEXT NOT NULL, page TEXT, first_seen TEXT, last_seen TEXT, gone INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, key));
      CREATE TABLE IF NOT EXISTS m_tables_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, at TEXT, state TEXT, note TEXT, added TEXT, changed TEXT, gone TEXT, pages INTEGER);
    `);
  }
  raw(id) { return this.db.get('SELECT * FROM m_tables_sources WHERE id = ?', id); }
  out(r) {
    if (!r) return null;
    const headings = j(r.headings, []); const columns = j(r.columns, []);
    const count = this.db.get('SELECT SUM(gone = 0) AS live, SUM(gone = 1) AS gone FROM m_tables_rows WHERE source_id = ?', r.id) || {};
    const run = this.db.get('SELECT * FROM m_tables_runs WHERE source_id = ? ORDER BY id DESC LIMIT 1', r.id);
    let host = ''; try { host = new URL(r.url).hostname; } catch {}
    return { id: r.id, url: r.url, host, title: r.title || host, kind: r.kind, columns: headings.map((h, i) => ({ heading: h, meaning: columns[i] || 'other' })),
      pageLimit: r.page_limit, schedule: !!r.schedule, state: r.state || 'new', note: r.note || '', movedTo: r.moved_to || '', pending: j(r.pending, null),
      lastRead: r.last_read || null, lastOk: r.last_ok || null, nextAt: r.schedule ? r.next_at || null : null, pagesRead: r.pages_read || 0, rows: Number(count.live || 0), goneRows: Number(count.gone || 0),
      lastRun: run ? { at: run.at, state: run.state, note: run.note || '', added: j(run.added, []), changed: j(run.changed, []), gone: j(run.gone, []), pages: run.pages || 0 } : null };
  }
  list() { return this.db.all('SELECT * FROM m_tables_sources ORDER BY created').map(r => this.out(r)); }
  get(id) { return this.out(this.raw(id)); }
  add({ url, title, kind, headings, position, columns, pageLimit }) {
    const id = rid(); const t = now();
    this.db.run('INSERT INTO m_tables_sources (id, url, title, kind, headings, position, columns, page_limit, state, froms, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, url, String(title || '').slice(0, 200) || null, kind, JSON.stringify(headings), position, JSON.stringify(columns), clampPages(pageLimit), 'new', JSON.stringify([url]), t, t);
    return id;
  }
  patch(id, p) {
    const map = { url: 'url', kind: 'kind', headings: 'headings', position: 'position', columns: 'columns', pageLimit: 'page_limit', schedule: 'schedule', state: 'state', note: 'note', movedTo: 'moved_to', pending: 'pending', froms: 'froms', lastRead: 'last_read', lastOk: 'last_ok', nextAt: 'next_at', failCount: 'fail_count', pagesRead: 'pages_read' };
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(p)) { if (!(k in map)) continue; sets.push(map[k] + ' = ?'); vals.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null); }
    if (!sets.length) return;
    sets.push('updated = ?'); vals.push(now());
    this.db.run(`UPDATE m_tables_sources SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  }
  froms(id) { return j(this.raw(id)?.froms, []); }
  rows(id, { all = false } = {}) { return this.db.all(`SELECT * FROM m_tables_rows WHERE source_id = ? ${all ? '' : 'AND gone = 0'} ORDER BY first_seen, rowid`, id).map(r => ({ key: r.key, cells: j(r.cells, []), page: r.page, firstSeen: r.first_seen, lastSeen: r.last_seen, gone: !!r.gone })); }
  /**
   * Store a good read: rows new, changed and no longer on the list, and one run line.
   * relink (after the owner confirmed new columns): { old(cells), cur(cells), same(oldCells, newCells) } finds the same
   * person under the old and the new columns, so a row is not counted both new and gone only because its key changed.
   */
  saveRead(id, rows, { at, pages, note, relink = null }) {
    const old = new Map(this.rows(id, { all: true }).map(r => [r.key, r]));
    const added = [], changed = [], gone = [], addedKeys = []; const seen = new Set();
    const soft = new Map(); const direct = new Set(rows.map(r => r.key).filter(k => old.get(k) && !old.get(k).gone));
    if (relink) for (const o of old.values()) if (!o.gone && !direct.has(o.key)) { const k = relink.old(o.cells); if (k && !soft.has(k)) soft.set(k, o); }
    this.db.transaction(() => {
      for (const r of rows) {
        if (seen.has(r.key)) continue; seen.add(r.key);
        let o = old.get(r.key);
        const k = relink && (!o || o.gone) ? relink.cur(r.cells) : null; const was = k && soft.get(k);
        if (was && !seen.has(was.key)) {
          soft.delete(k); seen.add(was.key);
          if (!relink.same(was.cells, r.cells)) changed.push({ before: was.cells, after: r.cells });
          if (o) this.db.run('DELETE FROM m_tables_rows WHERE source_id = ? AND key = ?', id, r.key);
          this.db.run('DELETE FROM m_tables_rows WHERE source_id = ? AND key = ?', id, was.key);
          this.db.run('INSERT INTO m_tables_rows (source_id, key, cells, page, first_seen, last_seen, gone) VALUES (?, ?, ?, ?, ?, ?, 0)', id, r.key, JSON.stringify(r.cells), r.page, was.firstSeen, at);
          continue;
        }
        if (!o || o.gone) { added.push(r.cells); addedKeys.push(r.key); }
        else if (JSON.stringify(o.cells) !== JSON.stringify(r.cells)) changed.push({ before: o.cells, after: r.cells });
        if (o) this.db.run('UPDATE m_tables_rows SET cells = ?, page = ?, last_seen = ?, gone = 0 WHERE source_id = ? AND key = ?', JSON.stringify(r.cells), r.page, at, id, r.key);
        else this.db.run('INSERT INTO m_tables_rows (source_id, key, cells, page, first_seen, last_seen, gone) VALUES (?, ?, ?, ?, ?, ?, 0)', id, r.key, JSON.stringify(r.cells), r.page, at, at);
      }
      for (const [k, o] of old) if (!o.gone && !seen.has(k)) { gone.push(o.cells); this.db.run('UPDATE m_tables_rows SET gone = 1 WHERE source_id = ? AND key = ?', id, k); }
      const text = typeof note === 'function' ? note({ added, changed, gone, addedKeys }) : note;
      this.db.run('INSERT INTO m_tables_runs (source_id, at, state, note, added, changed, gone, pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, at, 'ok', text || null, JSON.stringify(added.slice(0, 200)), JSON.stringify(changed.slice(0, 200)), JSON.stringify(gone.slice(0, 200)), pages);
    });
    return { added, changed, gone };
  }
  logRun(id, { at, state, note }) { this.db.run('INSERT INTO m_tables_runs (source_id, at, state, note, pages) VALUES (?, ?, ?, ?, 0)', id, at, state, note || null); }
  /** Removes the source and every row it keeps, on the list or no longer on it: { rows, gone }. */
  remove(id) {
    const c = this.db.get('SELECT COUNT(*) AS n, SUM(gone = 1) AS g FROM m_tables_rows WHERE source_id = ?', id); const n = { rows: Number(c.n || 0), gone: Number(c.g || 0) };
    this.db.transaction(() => { for (const t of ['m_tables_rows', 'm_tables_runs']) this.db.run(`DELETE FROM ${t} WHERE source_id = ?`, id); this.db.run('DELETE FROM m_tables_sources WHERE id = ?', id); });
    return n;
  }
}
