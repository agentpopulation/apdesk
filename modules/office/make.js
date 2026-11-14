// Office files from plain data: tables (exceljs, CSV) and documents from Markdown (docx, pdfkit, Markdown).
// The Markdown block walk uses the
// marked lexer so tables, links and nested inline marks survive. Pure: returns Buffers; saving is server.js's job.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ---------- tables ----------
const NUM_RE = /^\s*[-+]?[\s$₹€£¥]*[-+]?\d{1,3}(?:[,\s]\d{2,3})*(?:\.\d+)?\s*$|^\s*[-+]?[$₹€£¥]?\s*\d+(?:\.\d+)?\s*$/;

/** "₹ 1,29,999" -> 129999; "12.5" -> 12.5; "45%" -> { pct: 0.45 }; anything else stays text. */
export function asCell(v) {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v).trim();
  const pct = /^([-+]?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pct) return { pct: Number(pct[1]) / 100 };
  if (NUM_RE.test(s) && /\d/.test(s)) { const n = Number(s.replace(/[^\d.+-]/g, '')); if (Number.isFinite(n)) return n; }
  return s;
}

/** columns: ['Name', ...] or [{ key, label|header }]; rows: arrays or objects. -> { headers, keys, rows: [[cell]] } */
export function normalizeTable(columns, rows) {
  const cols = (Array.isArray(columns) ? columns : []).map((c, i) => typeof c === 'string' ? { key: c, label: c } : { key: c?.key ?? c?.label ?? c?.header ?? `Column ${i + 1}`, label: String(c?.label ?? c?.header ?? c?.key ?? `Column ${i + 1}`) });
  const list = Array.isArray(rows) ? rows : [];
  if (!cols.length && list.length && !Array.isArray(list[0]) && typeof list[0] === 'object') for (const k of Object.keys(list[0])) cols.push({ key: k, label: k });
  const out = list.map((r) => {
    if (Array.isArray(r)) return cols.map((_, i) => asCell(r[i]));
    if (r && typeof r === 'object') {
      const lower = Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v]));
      return cols.map((c) => asCell(r[c.key] ?? r[c.label] ?? lower[String(c.key).toLowerCase()] ?? lower[c.label.toLowerCase()]));
    }
    return cols.map((_, i) => (i === 0 ? asCell(r) : ''));
  });
  return { headers: cols.map((c) => c.label), rows: out };
}

export async function tableXlsx({ title, columns, rows }) {
  const ExcelJS = require('exceljs');
  const { headers, rows: data } = normalizeTable(columns, rows);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AP Desk'; wb.created = new Date();
  const ws = wb.addWorksheet(sheetName(title));
  ws.addRow(headers);
  for (const r of data) ws.addRow(r.map((c) => (c && typeof c === 'object' ? c.pct : c)));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F6F' } };
  head.alignment = { vertical: 'middle' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (headers.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  headers.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    const lens = [String(h).length, ...data.map((r) => { const c = r[i]; return c && typeof c === 'object' ? 6 : typeof c === 'number' ? fmtLen(c) : String(c ?? '').length; })];
    col.width = Math.max(8, Math.min(60, Math.max(...lens) + 2));
    if (data.some((r) => r[i] && typeof r[i] === 'object')) col.numFmt = '0%';
    else if (data.length && data.every((r) => typeof r[i] === 'number' || r[i] === '')) col.numFmt = data.some((r) => typeof r[i] === 'number' && !Number.isInteger(r[i])) ? '#,##0.00' : '#,##0';
    if (data.some((r) => typeof r[i] === 'string' && r[i].length > 60)) col.alignment = { wrapText: true, vertical: 'top' };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const fmtLen = (n) => Math.ceil(Math.abs(n)).toLocaleString('en-US').length + (Number.isInteger(n) ? 0 : 3);
function sheetName(t) { return String(t || 'Table').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Table'; }

export function tableCsv({ columns, rows }) {
  const { headers, rows: data } = normalizeTable(columns, rows);
  const q = (v) => { const s = v && typeof v === 'object' ? `${Math.round(v.pct * 10000) / 100}%` : String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return Buffer.from('\uFEFF' + [headers, ...data].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n', 'utf8');
}

// ---------- documents ----------
function lex(markdown) { const { marked } = require('marked'); return marked.lexer(String(markdown || '').replace(/\r\n/g, '\n')); }

/** Inline tokens -> runs [{ text, bold, italic, code, link }] */
export function runsOf(tokens, mark = {}) {
  const out = [];
  for (const t of tokens || []) {
    if (t.type === 'strong') out.push(...runsOf(t.tokens, { ...mark, bold: true }));
    else if (t.type === 'em') out.push(...runsOf(t.tokens, { ...mark, italic: true }));
    else if (t.type === 'del') out.push(...runsOf(t.tokens, mark));
    else if (t.type === 'link') out.push(...runsOf(t.tokens, { ...mark, link: t.href }));
    else if (t.type === 'codespan') out.push({ ...mark, text: decode(t.text), code: true });
    else if (t.type === 'br') out.push({ ...mark, text: '\n' });
    else if (t.tokens?.length) out.push(...runsOf(t.tokens, mark));
    else out.push({ ...mark, text: decode(t.text ?? t.raw ?? '') });
  }
  return out;
}
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Blocks: { type: 'h', level, runs } | { type: 'p', runs } | { type: 'ul'|'ol', start, items: [runs] } | { type: 'table', header: [runs], rows: [[runs]] } | { type: 'code', text } | { type: 'quote', runs } | { type: 'hr' } */
export function blocksOf(markdown, sources = null) {
  const blocks = [];
  const walk = (tokens) => {
    for (const t of tokens) {
      if (t.type === 'heading') blocks.push({ type: 'h', level: t.depth, runs: runsOf(t.tokens) });
      else if (t.type === 'paragraph' || t.type === 'text') blocks.push({ type: 'p', runs: runsOf(t.tokens || [{ type: 'text', text: t.text }]) });
      else if (t.type === 'list') blocks.push({ type: t.ordered ? 'ol' : 'ul', start: Number(t.start) || 1, items: t.items.map((it) => runsOf(it.tokens.flatMap((x) => (x.type === 'list' ? [] : x.tokens ? [{ type: 'text', tokens: x.tokens }, { type: 'text', text: ' ' }] : [x])))) });
      else if (t.type === 'table') blocks.push({ type: 'table', header: t.header.map((c) => runsOf(c.tokens)), rows: t.rows.map((r) => r.map((c) => runsOf(c.tokens))) });
      else if (t.type === 'code') blocks.push({ type: 'code', text: t.text });
      else if (t.type === 'blockquote') blocks.push({ type: 'quote', runs: runsOf(t.tokens.flatMap((x) => x.tokens || [])) });
      else if (t.type === 'hr') blocks.push({ type: 'hr' });
      else if (t.type === 'html') blocks.push({ type: 'p', runs: [{ text: t.text.replace(/<[^>]+>/g, '') }] });
    }
  };
  walk(lex(markdown));
  if (Array.isArray(sources) && sources.length) {
    blocks.push({ type: 'h', level: 2, runs: [{ text: 'Sources' }] });
    blocks.push({ type: 'ol', start: Number(sources[0].n) || 1, items: sources.map((s) => [{ text: s.title || s.url, link: s.url || null }, ...(s.url && s.title ? [{ text: ` (${s.url})` }] : [])]) });
  }
  return blocks;
}
const plainOf = (runs) => runs.map((r) => r.text).join('');

export async function docDocx({ title, markdown, sources }) {
  const d = require('docx');
  const blocks = blocksOf(markdown, sources);
  const runs = (rs, extra = {}) => rs.map((r) => {
    const tr = new d.TextRun({ text: r.text, bold: r.bold || extra.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined, style: r.link ? 'Hyperlink' : undefined });
    return r.link ? new d.ExternalHyperlink({ link: r.link, children: [tr] }) : tr;
  });
  const HL = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  const children = [];
  if (title && !(blocks[0]?.type === 'h' && blocks[0].level === 1 && plainOf(blocks[0].runs).trim() === String(title).trim())) children.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun(String(title))] }));
  let listN = 0;
  for (const b of blocks) {
    if (b.type === 'h') children.push(new d.Paragraph({ heading: HL[b.level - 1], children: runs(b.runs) }));
    else if (b.type === 'p') children.push(new d.Paragraph({ children: runs(b.runs), spacing: { after: 120 } }));
    else if (b.type === 'quote') children.push(new d.Paragraph({ children: runs(b.runs), indent: { left: 720 }, spacing: { after: 120 } }));
    else if (b.type === 'code') for (const l of b.text.split('\n')) children.push(new d.Paragraph({ children: [new d.TextRun({ text: l, font: 'Consolas', size: 19 })] }));
    else if (b.type === 'hr') children.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } }, children: [] }));
    else if (b.type === 'ul') for (const it of b.items) children.push(new d.Paragraph({ bullet: { level: 0 }, children: runs(it) }));
    else if (b.type === 'ol') { listN += 1; for (const it of b.items) children.push(new d.Paragraph({ numbering: { reference: 'num', level: 0, instance: listN }, children: runs(it) })); }
    else if (b.type === 'table') {
      const cell = (rs, head) => new d.TableCell({ children: [new d.Paragraph({ children: runs(rs, { bold: head }) })], shading: head ? { type: d.ShadingType.CLEAR, fill: 'E7ECF2', color: 'auto' } : undefined });
      children.push(new d.Table({ width: { size: 100, type: d.WidthType.PERCENTAGE }, rows: [new d.TableRow({ tableHeader: true, children: b.header.map((h) => cell(h, true)) }), ...b.rows.map((r) => new d.TableRow({ children: b.header.map((_, i) => cell(r[i] || [], false)) }))] }));
      children.push(new d.Paragraph({ children: [] }));
    }
  }
  const doc = new d.Document({
    creator: 'AP Desk', title: String(title || 'Document'),
    numbering: { config: [{ reference: 'num', levels: [{ level: 0, format: d.LevelFormat.DECIMAL, text: '%1.', alignment: d.AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    sections: [{ children }],
  });
  return Buffer.from(await d.Packer.toBuffer(doc));
}

// Fonts with ₹ and accents: the PC's own Arial or Segoe UI, else DejaVu/Liberation, else the built-in Helvetica.
const FONT_CANDIDATES = [
  ['C:\\Windows\\Fonts\\segoeui.ttf', 'C:\\Windows\\Fonts\\segoeuib.ttf', 'C:\\Windows\\Fonts\\segoeuii.ttf'],
  ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\ariali.ttf'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
  ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf'],
];
function pdfFonts(doc) {
  for (const [r, b, i] of FONT_CANDIDATES) {
    if (fs.existsSync(r) && fs.existsSync(b)) { doc.registerFont('R', r); doc.registerFont('B', b); doc.registerFont('I', fs.existsSync(i) ? i : r); return { R: 'R', B: 'B', I: 'I', unicode: true }; }
  }
  return { R: 'Helvetica', B: 'Helvetica-Bold', I: 'Helvetica-Oblique', unicode: false };
}

export async function docPdf({ title, markdown, sources }) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: String(title || 'Document'), Creator: 'AP Desk' }, bufferPages: true });
  const F = pdfFonts(doc);
  const clean = (s) => (F.unicode ? s : String(s).replace(/₹/g, 'Rs. ').replace(/[^\x00-\xff]/g, '?'));
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  const W = doc.page.width - 112;
  const ink = '#1d2430', link = '#1f5fbf';
  const writeRuns = (rs, { size = 10.5, indent = 0, bold = false } = {}) => {
    const list = rs.filter((r) => r.text !== '');
    if (!list.length) { doc.moveDown(0.3); return; }
    doc.fontSize(size); doc.x = 56 + indent;
    list.forEach((r, k) => {
      doc.font(r.bold || bold ? F.B : r.italic ? F.I : F.R).fillColor(r.link ? link : ink);
      doc.text(clean(r.text), { continued: k < list.length - 1, link: r.link || null, underline: !!r.link, width: W - indent });
    });
    doc.x = 56;
  };
  const blocks = blocksOf(markdown, sources);
  if (title && !(blocks[0]?.type === 'h' && blocks[0].level === 1)) { doc.font(F.B).fontSize(20).fillColor(ink).text(clean(String(title)), { width: W }); doc.moveDown(0.6); }
  for (const b of blocks) {
    if (b.type === 'h') { doc.moveDown(b.level <= 2 ? 0.6 : 0.3); writeRuns(b.runs, { size: [20, 15, 12.5, 11.5, 11, 11][b.level - 1], bold: true }); doc.moveDown(0.25); }
    else if (b.type === 'p') { writeRuns(b.runs); doc.moveDown(0.45); }
    else if (b.type === 'quote') { writeRuns(b.runs, { indent: 18 }); doc.moveDown(0.45); }
    else if (b.type === 'code') { doc.font('Courier').fontSize(9).fillColor(ink).text(clean(b.text), 56, undefined, { width: W }); doc.moveDown(0.45); }
    else if (b.type === 'hr') { const y = doc.y + 4; doc.moveTo(56, y).lineTo(56 + W, y).strokeColor('#bbbbbb').stroke(); doc.moveDown(0.8); }
    else if (b.type === 'ul' || b.type === 'ol') {
      b.items.forEach((it, i) => writeRuns([{ text: b.type === 'ol' ? `${b.start + i}.  ` : '•  ' }, ...it], { indent: 14 }));
      doc.moveDown(0.45);
    } else if (b.type === 'table') pdfTable(doc, F, clean, b, W);
  }
  // page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) { doc.switchToPage(range.start + i); doc.page.margins.bottom = 0; doc.font(F.R).fontSize(8).fillColor('#888888').text(`${i + 1} / ${range.count}`, 56, doc.page.height - 40, { width: W, align: 'right', lineBreak: false }); }
  doc.end(); await done;
  return Buffer.concat(chunks);
}

function pdfTable(doc, F, clean, b, W) {
  const texts = [b.header.map(plainOf), ...b.rows.map((r) => b.header.map((_, i) => plainOf(r[i] || [])))];
  const weights = b.header.map((_, i) => Math.max(4, Math.min(40, Math.max(...texts.map((r) => (r[i] || '').length)))));
  const total = weights.reduce((a, x) => a + x, 0);
  const widths = weights.map((w) => (w / total) * W);
  doc.fontSize(9);
  texts.forEach((row, ri) => {
    const font = ri === 0 ? F.B : F.R; doc.font(font);
    const hgt = Math.max(...row.map((t, i) => doc.heightOfString(clean(t || ' '), { width: widths[i] - 8 }))) + 6;
    if (doc.y + hgt > doc.page.height - 60) doc.addPage();
    const y = doc.y; let x = 56;
    if (ri === 0) doc.rect(56, y, W, hgt).fill('#e7ecf2');
    row.forEach((t, i) => { doc.font(font).fillColor('#1d2430').text(clean(t || ''), x + 4, y + 3, { width: widths[i] - 8 }); x += widths[i]; });
    doc.moveTo(56, y + hgt).lineTo(56 + W, y + hgt).strokeColor('#cccccc').lineWidth(0.5).stroke();
    doc.y = y + hgt; doc.x = 56;
  });
  doc.moveDown(0.8);
}

export function docMd({ title, markdown, sources }) {
  let md = String(markdown || '').trim();
  if (title && !/^#\s/.test(md)) md = `# ${title}\n\n${md}`;
  if (Array.isArray(sources) && sources.length) md += '\n\n## Sources\n\n' + sources.map((s, i) => `${s.n ?? i + 1}. [${s.title || s.url}](${s.url})`).join('\n');
  return Buffer.from(md + '\n', 'utf8');
}

/** "Compare laptops: 2026!" -> "compare-laptops-2026" (safe on Windows). */
export function slug(title, fallback = 'file') {
  const s = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || fallback;
}
