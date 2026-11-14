// Report files: Markdown, PDF and Word in workspace/reports. Through Office's makeDoc when it is on; else written here
// with pdfkit and docx (both already in the app). Either way the approval door is asked first.
import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { slug } from './util.js';

/** Markdown lines -> simple blocks: { type: 'h1'|'h2'|'h3'|'li'|'p', text } with links and bold stripped to plain text. */
export function blocks(markdown) {
  const out = []; const inline = (t) => t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)\*([^*]+)\*/g, '$1$2').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)').replace(/`([^`]+)`/g, '$1');
  for (const raw of String(markdown || '').split('\n')) {
    const l = raw.trimEnd(); if (!l.trim()) continue;
    const h = l.match(/^(#{1,3})\s+(.*)$/); if (h) { out.push({ type: 'h' + h[1].length, text: inline(h[2]) }); continue; }
    if (/^>\s?/.test(l)) { out.push({ type: 'q', text: inline(l.replace(/^>\s?/, '')) }); continue; }
    const li = l.match(/^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/); if (li) { out.push({ type: 'li', n: li[1] || null, text: inline(li[2]) }); continue; }
    out.push({ type: 'p', text: inline(l) });
  }
  return out;
}

export function pdfBuffer(title, markdown) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title, Creator: 'AP Desk' } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    for (const b of blocks(markdown)) {
      if (b.type === 'h1') doc.font('Helvetica-Bold').fontSize(18).text(b.text).moveDown(0.5);
      else if (b.type === 'h2') doc.moveDown(0.4).font('Helvetica-Bold').fontSize(13.5).text(b.text).moveDown(0.25);
      else if (b.type === 'h3') doc.font('Helvetica-Bold').fontSize(12).text(b.text).moveDown(0.2);
      else if (b.type === 'q') doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#444').text(b.text, { indent: 14 }).fillColor('black').moveDown(0.3);
      else if (b.type === 'li') doc.font('Helvetica').fontSize(10.5).text(`${b.n ? b.n + '.' : '•'} ${b.text}`, { indent: 10 }).moveDown(0.15);
      else doc.font('Helvetica').fontSize(10.5).text(b.text, { align: 'left' }).moveDown(0.35);
    }
    doc.end();
  });
}

export async function docxBuffer(title, markdown) {
  const kids = blocks(markdown).map((b) => {
    if (b.type[0] === 'h') return new Paragraph({ heading: { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 }[b.type], children: [new TextRun(b.text)] });
    if (b.type === 'q') return new Paragraph({ children: [new TextRun({ text: b.text, italics: true, size: 19 })], indent: { left: 400 }, spacing: { after: 100 } });
    if (b.type === 'li') return new Paragraph({ children: [new TextRun(`${b.n ? b.n + '.' : '•'} ${b.text}`)], indent: { left: 360 } });
    return new Paragraph({ children: [new TextRun(b.text)], spacing: { after: 120 } });
  });
  return Packer.toBuffer(new Document({ creator: 'AP Desk', title, sections: [{ children: kids }] }));
}

/**
 * writeReport(ctx, { title, markdown, sources, jobId, agentId, chatId, signal }) -> { md, pdf, docx, via, errors }
 * Paths are workspace-relative ("reports/x.md").
 */
export async function writeReport(ctx, { title, markdown, sources, jobId, agentId, chatId, signal }) {
  const out = { errors: [] };
  const office = ctx.modules.api('office');
  if (office?.makeDoc) {   // no sources argument: the Markdown already ends with its Sources list
    out.via = 'office';
    for (const fmt of ['md', 'pdf', 'docx']) {
      try { const r = await office.makeDoc({ title, markdown, format: fmt, dir: 'reports' }, { agentId, jobId, chatId, signal }); out[fmt] = r.path; }
      catch (e) { out.errors.push(`${fmt}: ${e.message}`); }
    }
    if (out.md && out.pdf && out.docx) return out;
  }
  out.via = out.via ? 'office and research' : 'research';
  const d = await ctx.approval.request({ agentId, jobId, chatId, action: 'file.write', title: `Write the report "${title.slice(0, 60)}" (Markdown, PDF, Word)`, detail: 'Workspace › reports', payload: { path: 'reports/' }, signal });
  if (!d.ok) { out.errors.push(`Not written: ${d.reason}`); return out; }
  const dir = ctx.workspacePath('reports'); await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
  const base = `${slug(title)}-${stamp}`;
  const make = { md: async () => Buffer.from(markdown, 'utf8'), pdf: () => pdfBuffer(title, markdown), docx: () => docxBuffer(title, markdown) };
  for (const fmt of ['md', 'pdf', 'docx']) {
    if (out[fmt]) continue;
    try { await fs.writeFile(path.join(dir, `${base}.${fmt}`), await make[fmt]()); out[fmt] = `reports/${base}.${fmt}`; }
    catch (e) { out.errors.push(`${fmt}: ${e.message}`); }
  }
  return out;
}
