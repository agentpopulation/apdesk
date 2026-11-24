// Basic Office-file to Markdown reader (zip reading with adm-zip).
// SPDX-License-Identifier: Apache-2.0
/**
 * Basic Markdown reader for the common Office files when anydoc's native core is not loaded
 * (no prebuilt for this CPU, e.g. Windows on ARM, or a box whose npm skipped the optional binary).
 * Text and tables only: no images, no formulas' results beyond the cached value, no OCR. PDFs are
 * read by pdf-text.js.
 * Pure JavaScript over the zip reader Desk already has; nothing leaves the PC.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
const AdmZip = createRequire(import.meta.url)('adm-zip');

/** Plain text: read as it is, on every OS, never through anydoc (UI batch 2: attack.txt). */
export const PLAIN_TEXT_EXTENSIONS = Object.freeze(['.txt', '.text', '.md', '.markdown', '.log', '.json', '.tsv']);
/** Extensions the basic reader handles (anydoc handles many more when its native core loads). */
export const BASIC_EXTENSIONS = Object.freeze(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm', '.csv', ...PLAIN_TEXT_EXTENSIONS]);
const MAX_SHEET_ROWS = 2000;
const ZIP_LIMITS = { maxEntries: 5000, maxTotalBytes: 200 * 1024 * 1024 };

export function isBasicExtension(file) {
  return BASIC_EXTENSIONS.includes(path.extname(String(file || '')).toLowerCase());
}

export function isPlainTextExtension(file) {
  return PLAIN_TEXT_EXTENSIONS.includes(path.extname(String(file || '')).toLowerCase());
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Concatenated text of every <prefix:t> run (or plain <t> when prefix is '') inside an XML fragment. */
function runText(xml, prefix) {
  const tag = prefix ? `${prefix}:t` : 't';
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';
  for (const m of xml.matchAll(re)) out += decodeXml(m[1]);
  return out;
}

function cell(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function table(rows) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!width) return '';
  const pad = (r) => [...r, ...Array(width - r.length).fill('')].map(cell);
  const [head, ...body] = rows;
  return [`| ${pad(head).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...body.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n');
}

/** Said under a table cut to MAX_SHEET_ROWS data rows, so counts and totals are never taken as whole. */
function cutNote(more) {
  return more > 0
    ? `\n\n(Only the first ${MAX_SHEET_ROWS} data rows are shown; ${more} more rows were left out, so counts and totals from this table are incomplete.)`
    : '';
}

const MD_ROW = /^\s*\|.*\|\s*$/;
const MD_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Put "Table: N data rows below the header row." before each Markdown table, so a model asked
 * "how many rows" or "what is the total" counts from the file instead of guessing.
 */
export function withRowCounts(markdown) {
  const lines = String(markdown || '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!(MD_ROW.test(lines[i]) && MD_RULE.test(lines[i + 1] || ''))) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let j = i + 2;
    while (j < lines.length && MD_ROW.test(lines[j])) j += 1;
    const n = j - i - 2;
    out.push(`Table: ${n} data ${n === 1 ? 'row' : 'rows'} below the header row.`, ...lines.slice(i, j));
    i = j;
  }
  return out.join('\n');
}

function entryMap(bytes) {
  const map = new Map();
  const entries = new AdmZip(Buffer.from(bytes)).getEntries();
  if (entries.length > ZIP_LIMITS.maxEntries) throw new Error('too many entries');
  let total = 0;
  for (const e of entries) { if (e.isDirectory) continue; total += e.header.size; if (total > ZIP_LIMITS.maxTotalBytes) throw new Error('too large'); map.set(e.entryName.replace(/\\/g, '/'), e.getData()); }
  return map;
}

function docx(files) {
  const doc = files.get('word/document.xml');
  if (!doc) throw Object.assign(new Error('missing word/document.xml'), { code: 'missingPart' });
  const xml = doc.toString('utf8').replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>');
  const out = [];
  for (const m of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const block = m[0];
    if (block.startsWith('<w:tbl')) {
      const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => runText(c[0], 'w')));
      if (rows.length) out.push(table(rows));
      continue;
    }
    const text = runText(block, 'w').trim();
    if (!text) continue;
    const level = /<w:pStyle w:val="(?:Heading|heading)\s?(\d)"/.exec(block);
    out.push(level ? `${'#'.repeat(Math.min(6, Number(level[1])))} ${text}` : text);
  }
  return out.join('\n\n');
}

function colIndex(ref) {
  const letters = /^[A-Z]+/i.exec(String(ref || ''))?.[0]?.toUpperCase() || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Every sheet of a workbook as rows of cell text: [{ name, rows, more }], at most cap data rows per sheet. */
function xlsxSheets(files, cap = MAX_SHEET_ROWS) {
  const shared = [];
  const sst = files.get('xl/sharedStrings.xml');
  if (sst) for (const si of sst.toString('utf8').matchAll(/<si\b[\s\S]*?<\/si>/g)) shared.push(runText(si[0], ''));
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  let sheets = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)]
    .map((m) => ({ name: decodeXml(m[1]), file: `xl/${String(target.get(m[2]) || '').replace(/^\/?xl\//, '')}` }));
  if (!sheets.length) {
    sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()
      .map((file, i) => ({ name: `Sheet${i + 1}`, file }));
  }
  const out = [];
  for (const sheet of sheets) {
    const data = files.get(sheet.file);
    if (!data) continue;
    const rows = [];
    let more = 0;
    for (const row of data.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length > cap) { more += 1; continue; }
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] || '';
        const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let text = '';
        if (type === 's') text = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') text = runText(body, '');
        else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else text = decodeXml(v ?? '');
        cells[ref ? colIndex(ref) : cells.length] = text;
      }
      const values = Array.from(cells, (x) => x ?? '');
      // Blank formatted rows are not data; leaving them in breaks row counts.
      if (values.some((x) => String(x).trim())) rows.push(values);
    }
    if (!rows.length) continue;
    out.push({ name: sheet.name, rows, more });
  }
  return out;
}

function xlsx(files) {
  return xlsxSheets(files).map((x) => `## ${x.name}\n\n${table(x.rows)}${cutNote(x.more)}`).join('\n\n');
}

/**
 * The rows of cells of a table file, for a module that imports rows (Sales customers): a .xlsx or .xlsm workbook (its
 * first sheet that holds data, every row), or CSV text. { rows, sheet, sheets }; a file it cannot read throws with a plain line.
 */
export function readTable(bytes, ext) {
  const e = String(ext || '').toLowerCase().replace(/^(?!\.)/, '.');
  if (e === '.csv') return { rows: parseCsv(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')), sheet: '', sheets: 1 };
  if (e !== '.xlsx' && e !== '.xlsm') throw Object.assign(new Error('Only .xlsx and .csv files can be read as a table.'), { code: 'unsupported' });
  let files;
  try { files = entryMap(bytes); } catch (err) { throw Object.assign(new Error('The spreadsheet is damaged or has no readable content.'), { code: 'malformed', cause: err }); }
  const sheets = xlsxSheets(files, Infinity);
  if (!sheets.length) return { rows: [], sheet: '', sheets: 0 };
  return { rows: sheets[0].rows, sheet: sheets[0].name, sheets: sheets.length };
}

function pptx(files) {
  const slides = [...files.keys()]
    .map((k) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(k))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const out = [];
  for (const m of slides) {
    const xml = files.get(m[0]).toString('utf8');
    const lines = [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((p) => runText(p[0], 'a').trim()).filter(Boolean);
    out.push(`## Slide ${m[1]}${lines.length ? `\n\n${lines.join('\n')}` : ''}`);
  }
  return out.join('\n\n');
}

/** RFC 4180-ish CSV, like Sales › Leads import: also reads ; or tab when that is the separator. */
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const sep = [',', ';', '\t'].map((s) => [s, firstLine.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

/**
 * @param {Buffer} bytes
 * @param {string} ext e.g. '.docx'
 * @returns {{ markdown: string, format: string }}
 */
export function basicToMarkdown(bytes, ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.tsv') {
    const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t'));
    return { markdown: table(rows.slice(0, MAX_SHEET_ROWS + 1)) + cutNote(rows.length - MAX_SHEET_ROWS - 1), format: 'tsv' };
  }
  if (PLAIN_TEXT_EXTENSIONS.includes(e)) {
    return { markdown: Buffer.from(bytes).toString('utf8').replace(/^﻿/, ''), format: e.slice(1) };
  }
  if (e === '.csv') {
    const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
    const rows = parseCsv(text);
    return { markdown: table(rows.slice(0, MAX_SHEET_ROWS + 1)) + cutNote(rows.length - MAX_SHEET_ROWS - 1), format: 'csv' };
  }
  let files;
  try {
    files = entryMap(bytes);
  } catch (err) {
    throw Object.assign(new Error('The document is damaged or has no readable content.'), { code: 'malformed', cause: err });
  }
  if (e === '.docx' || e === '.docm') return { markdown: docx(files), format: 'docx' };
  if (e === '.xlsx' || e === '.xlsm') return { markdown: xlsx(files), format: 'xlsx' };
  if (e === '.pptx' || e === '.pptm') return { markdown: pptx(files), format: 'pptx' };
  throw Object.assign(new Error('This file type cannot be converted to Markdown.'), { code: 'unsupported' });
}
