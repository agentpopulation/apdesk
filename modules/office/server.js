// Office (module 7): makeTable -> xlsx/csv, makeDoc -> docx/pdf/md, saved in the workspace through the Files
// module's write (which asks the approval door), or through the door directly when Files is off.
import fs from 'node:fs/promises';
import path from 'node:path';
import { tableXlsx, tableCsv, docDocx, docPdf, docMd, slug, normalizeTable } from './make.js';

export async function activate(ctx) {
  /** A workspace-relative folder ("tables", "reports/x"); refuses escapes. */
  const folder = (dir, fallback) => {
    const rel = String(dir || fallback).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const abs = ctx.workspacePath(...rel.split('/').filter(Boolean));
    return { rel: path.relative(ctx.workspace, abs).split(path.sep).join('/'), abs };
  };
  async function freeName(dirAbs, name) {
    const exists = async (n) => fs.access(path.join(dirAbs, n)).then(() => true, () => false);
    if (!(await exists(name))) return name;
    const ext = path.extname(name); const stem = name.slice(0, -ext.length);
    for (let i = 2; i < 1000; i++) if (!(await exists(`${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`;
    throw new Error('Too many files with that name.');
  }
  async function save(dir, fallbackDir, title, ext, buf, who = {}) {
    const f = folder(dir, fallbackDir);
    await fs.mkdir(f.abs, { recursive: true });
    const name = await freeName(f.abs, `${slug(title, ext === 'xlsx' || ext === 'csv' ? 'table' : 'document')}.${ext}`);
    const rel = [f.rel, name].filter(Boolean).join('/');
    const files = ctx.modules.api('files');
    if (files?.write) { const r = await files.write(rel, buf, who); return { path: r.path, name: r.name, size: r.size }; }
    const d = await ctx.approval.request({ action: 'file.write', agentId: who.agentId || null, jobId: who.jobId || undefined, chatId: who.chatId || undefined, title: `Write ${name}`, payload: { path: rel }, signal: who.signal });
    if (!d.ok) throw Object.assign(new Error(`Writing ${name} did not go ahead (${d.reason}).`), { code: 'not_approved' });
    await fs.writeFile(path.join(f.abs, name), buf);
    return { path: rel, name, size: buf.length };
  }

  /** makeTable({ title, columns, rows, format: 'xlsx'|'csv', dir? }, who?) -> { path, name } */
  async function makeTable({ title, columns, rows, format = 'xlsx', dir } = {}, who = {}) {
    const fmt = String(format).toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const { headers, rows: data } = normalizeTable(columns, rows);
    if (!headers.length) throw Object.assign(new Error('A table needs at least one column.'), { code: 'bad_table' });
    const buf = fmt === 'csv' ? tableCsv({ columns, rows }) : await tableXlsx({ title, columns, rows });
    const r = await save(dir, 'tables', title || 'table', fmt, buf, who);
    return { ...r, columns: headers.length, rows: data.length };
  }
  /** makeDoc({ title, markdown, format: 'docx'|'pdf'|'md', dir?, sources? }, who?) -> { path, name } */
  async function makeDoc({ title, markdown, format = 'docx', dir, sources } = {}, who = {}) {
    const fmt = ['docx', 'pdf', 'md'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'docx';
    const input = { title, markdown, sources };
    const buf = fmt === 'pdf' ? await docPdf(input) : fmt === 'md' ? docMd(input) : await docDocx(input);
    return save(dir, 'reports', title || 'document', fmt, buf, who);
  }
  ctx.expose({ makeTable, makeDoc });

  // A tool call writes only into the fixed folders (tables, reports): any folder an agent passes is ignored, so a tool
  // call can never write into Knowledge or another folder. Direct callers inside the desk (makeTable, makeDoc) may pass dir.
  const whoOf = (call) => ({ agentId: call?.agentId || null, jobId: call?.jobId || null, chatId: call?.chatId || null, signal: call?.signal });
  const card = (r, note) => ({ kind: 'file', path: r.path, name: r.name, size: r.size, note });
  ctx.tool({
    name: 'table_file',
    description: 'Save a table as an Excel (xlsx) or CSV file in the workspace\'s tables folder, for the owner to open or send. Give one row per item and one value per column; put units in the column name (e.g. "Weight (kg)") and numbers as plain numbers. Not for the owner\'s customer records: contacts, companies and deals live in the desk\'s own CRM and are added with the crm tools, never kept in a file.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title; also the file name' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Column names, in order' },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Rows, each an array of values in column order. Write numbers as plain digits (1299, 1.4), without units or currency signs.' },
        format: { type: 'string', enum: ['xlsx', 'csv'] },
      },
      required: ['title', 'columns', 'rows'],
    },
    async run(args, call) {
      try {
        const r = await makeTable({ title: args?.title, columns: args?.columns, rows: args?.rows, format: args?.format }, whoOf(call));
        const c = card(r, `${r.rows} row${r.rows === 1 ? '' : 's'}, ${r.columns} column${r.columns === 1 ? '' : 's'}`); call?.emitCard?.(c);
        return { ok: true, path: r.path, name: r.name, rows: r.rows, cards: [c] };
      } catch (e) { return { ok: false, error: e.message }; }
    },
  });
  ctx.tool({
    name: 'doc_file',
    description: 'Save a document written in Markdown as Word (docx), PDF or Markdown in the workspace\'s reports folder. Headings, lists, tables and links are kept. Not for the owner\'s customer records: those live in the desk\'s own CRM (crm tools).',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, markdown: { type: 'string' }, format: { type: 'string', enum: ['docx', 'pdf', 'md'] } },
      required: ['title', 'markdown'],
    },
    async run(args, call) {
      try { const r = await makeDoc({ title: args?.title, markdown: args?.markdown, format: args?.format }, whoOf(call)); const c = card(r, 'Document'); call?.emitCard?.(c); return { ok: true, path: r.path, name: r.name, cards: [c] }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
  });
  return { async deactivate() {} };
}
