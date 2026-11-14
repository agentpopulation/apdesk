// Knowledge: workspace/knowledge, indexed into SQLite FTS5 (node:sqlite) with file and position.
// chunkText and pageRegions understand the page marker "[page N]" of pdf-text.js output. Text extraction: convert.js, and pdf-text.js for PDFs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { basicToMarkdown } from './convert.js';
import { pdfToText } from './pdf-text.js';

export const KNOWLEDGE_EXT = new Set(['.txt', '.text', '.md', '.markdown', '.log', '.json', '.tsv', '.csv', '.pdf', '.docx', '.xlsx', '.pptx']);
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

export const KNOWLEDGE_SQL = `
CREATE TABLE IF NOT EXISTS m_files_kdocs (path TEXT PRIMARY KEY, mtime TEXT, size INTEGER, chunks INTEGER, error TEXT, indexed TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS m_files_kfts USING fts5(text, path UNINDEXED, pos UNINDEXED, page UNINDEXED, tokenize = 'porter unicode61');
`;

function clampInt(value, min, max, fallback) { const n = Number(value); if (!Number.isFinite(n)) return fallback; return Math.max(min, Math.min(max, Math.trunc(n))); }

export function pageRegions(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  if (!raw.trim()) return [];
  if (raw.includes('\f')) return raw.split('\f').map((part, i) => ({ page: i + 1, text: part.trim() })).filter((row) => row.text);
  const markerRe = /(?:^|\n)\s*(?:<!--\s*page[:\s]*(\d+)\s*-->|#\s*page\s+(\d+)\b|---\s*page\s+(\d+)\s*---|\[page\s+(\d+)\])\s*(?:\n|$)/gi;
  const markers = []; let match;
  while ((match = markerRe.exec(raw)) !== null) {
    const page = Number(match[1] || match[2] || match[3] || match[4]);
    if (!Number.isFinite(page) || page < 1) continue;
    markers.push({ page: Math.trunc(page), index: match.index, end: match.index + match[0].length });
  }
  if (!markers.length) return [{ page: 1, text: raw.trim() }];
  const regions = [];
  for (let i = 0; i < markers.length; i += 1) {
    const slice = raw.slice(markers[i].end, i + 1 < markers.length ? markers[i + 1].index : raw.length).trim();
    if (slice) regions.push({ page: markers[i].page, text: slice });
  }
  if (!regions.length) return [{ page: 1, text: raw.trim() }];
  const preface = raw.slice(0, markers[0].index).trim();
  if (preface) regions.unshift({ page: 1, text: preface });
  return regions;
}

export function chunkText(text, options = {}) {
  const size = clampInt(options.chunkSize, 200, 4000, CHUNK_SIZE);
  const overlap = clampInt(options.overlap, 0, Math.floor(size / 2), CHUNK_OVERLAP);
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const paragraphs = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = []; let buf = '';
  const flush = () => {
    const piece = buf.trim(); if (!piece) return;
    if (piece.length <= size) { chunks.push(piece); buf = overlap > 0 ? piece.slice(Math.max(0, piece.length - overlap)) : ''; return; }
    let start = 0;
    while (start < piece.length) { const end = Math.min(piece.length, start + size); chunks.push(piece.slice(start, end).trim()); if (end >= piece.length) break; start = Math.max(end - overlap, start + 1); }
    buf = overlap > 0 ? piece.slice(Math.max(0, piece.length - overlap)) : '';
  };
  for (const para of paragraphs) {
    if (!buf) { buf = para; continue; }
    if (`${buf}\n\n${para}`.length <= size) buf = `${buf}\n\n${para}`; else { flush(); buf = para; }
  }
  flush();
  return chunks.filter(Boolean);
}

/** Plain text of a file (Markdown for docx/xlsx/csv tables), or a thrown error with a plain message. */
export async function extractText(abs) {
  const ext = path.extname(abs).toLowerCase();
  if (!KNOWLEDGE_EXT.has(ext)) throw Object.assign(new Error('This file type is not read into Knowledge.'), { code: 'unsupported' });
  const st = await fs.stat(abs);
  if (st.size > MAX_FILE_BYTES) throw Object.assign(new Error('This file is too large to read into Knowledge.'), { code: 'too_large' });
  const bytes = await fs.readFile(abs);
  if (ext === '.pdf') return pdfToText(bytes);
  return basicToMarkdown(bytes, ext).markdown;
}

export class Knowledge {
  constructor({ db, dir, workspace }) { this.db = db; this.dir = dir; this.workspace = workspace; }
  rel(abs) { return path.relative(this.workspace, abs).split(path.sep).join('/'); }

  async walk(dir = this.dir, out = [], depth = 0) {
    if (depth > 8) return out;
    let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of entries) {
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) await this.walk(abs, out, depth + 1);
      else if (d.isFile() && KNOWLEDGE_EXT.has(path.extname(d.name).toLowerCase())) out.push(abs);
    }
    return out;
  }

  /** Index one file (replacing its old passages). */
  async ingest(abs) {
    const rel = this.rel(abs);
    const st = await fs.stat(abs);
    let text = ''; let error = null;
    try { text = await extractText(abs); } catch (e) { error = e.message; }
    const pieces = [];
    for (const region of pageRegions(text)) for (const piece of chunkText(region.text)) pieces.push({ text: piece, page: region.page });
    this.db.transaction(() => {
      this.db.run('DELETE FROM m_files_kfts WHERE path = ?', rel);
      pieces.forEach((p, i) => this.db.run('INSERT INTO m_files_kfts (text, path, pos, page) VALUES (?, ?, ?, ?)', p.text, rel, i, p.page));
      this.db.run('INSERT OR REPLACE INTO m_files_kdocs (path, mtime, size, chunks, error, indexed) VALUES (?, ?, ?, ?, ?, ?)', rel, st.mtime.toISOString(), st.size, pieces.length, error, new Date().toISOString());
    });
    return { path: rel, passages: pieces.length, error };
  }

  /** Re-index the folder: new and changed files are read, removed files leave the index. */
  async reindex({ force = false } = {}) {
    await fs.mkdir(this.dir, { recursive: true });
    const files = await this.walk();
    const seen = new Set(); const done = [];
    for (const abs of files) {
      const rel = this.rel(abs); seen.add(rel);
      const st = await fs.stat(abs).catch(() => null); if (!st) continue;
      const row = this.db.get('SELECT mtime, size FROM m_files_kdocs WHERE path = ?', rel);
      if (!force && row && row.mtime === st.mtime.toISOString() && row.size === st.size) continue;
      done.push(await this.ingest(abs));
    }
    for (const r of this.db.all('SELECT path FROM m_files_kdocs')) if (!seen.has(r.path)) this.forget(r.path);
    return { files: files.length, indexed: done, status: this.status() };
  }

  forget(rel) { this.db.run('DELETE FROM m_files_kfts WHERE path = ?', rel); this.db.run('DELETE FROM m_files_kdocs WHERE path = ?', rel); }

  status() {
    const r = this.db.get('SELECT COUNT(*) AS files, COALESCE(SUM(chunks), 0) AS passages FROM m_files_kdocs');
    const errors = this.db.all('SELECT path, error FROM m_files_kdocs WHERE error IS NOT NULL');
    return { files: r.files, passages: r.passages, unreadable: errors };
  }

  /** Passages for a query, best first: [{ file, name, page, position, text, snippet }]. */
  search(query, { limit = 8 } = {}) {
    const words = String(query || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
    if (!words.length) return [];
    const q = (op) => words.slice(0, 12).map((w) => `"${w.replace(/"/g, '')}"*`).join(` ${op} `);
    const sql = "SELECT path, pos, page, text, snippet(m_files_kfts, 0, '«', '»', '…', 24) AS snip, bm25(m_files_kfts) AS score FROM m_files_kfts WHERE m_files_kfts MATCH ? ORDER BY score LIMIT ?";
    let rows = this.db.all(sql, q('AND'), limit);
    if (!rows.length) rows = this.db.all(sql, q('OR'), limit);
    return rows.map((r) => ({ file: r.path, name: path.posix.basename(r.path), page: Number(r.page) || 1, position: Number(r.pos), text: r.text.length > 1200 ? r.text.slice(0, 1200) + '…' : r.text, snippet: r.snip }));
  }
}
