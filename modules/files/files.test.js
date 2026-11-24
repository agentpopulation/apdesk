// Plumbing tests for Files (no model). Windows paths are checked with path.win32 on any OS.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { cleanRel, validName, joinInside, isInside, isBlocked, insideGranted, listDrives } from './explorer.js';
import { chunkText, pageRegions } from './knowledge.js';
import { testDesk } from '../../test/helpers/desk.js';

const W = path.win32;

test('Windows paths: drive letters, backslashes, case, escapes', () => {
  const root = 'C:\\apdesk\\data\\workspace';
  assert.equal(joinInside(root, 'reports\\q3.pdf', W).abs, 'C:\\apdesk\\data\\workspace\\reports\\q3.pdf');
  assert.equal(joinInside(root, 'reports/q3.pdf', W).abs, 'C:\\apdesk\\data\\workspace\\reports\\q3.pdf');
  for (const bad of ['..\\apd.sqlite', 'C:\\Windows', 'c:/x', '\\\\server\\share', '/etc', 'a/../../b', '~/x', 'a\0b']) assert.throws(() => joinInside(root, bad, W), /path|folder|allowed|relative/i, bad);
  assert.ok(isInside('C:\\Users\\Owner\\Downloads', 'c:\\users\\owner\\downloads\\a.txt', W), 'case-insensitive on Windows');
  assert.ok(!isInside('C:\\Users\\Owner\\Downloads', 'C:\\Users\\Owner\\Downloads2\\a.txt', W), 'a sibling with the same prefix is outside');
  assert.ok(isInside('C:\\', 'C:\\Users', W), 'a drive root holds its folders');
  const env = { dataDir: 'C:\\apdesk\\data', workspace: 'C:\\apdesk\\data\\workspace' };
  assert.ok(isBlocked(env, 'C:\\apdesk\\data\\apd.sqlite', W));
  assert.ok(isBlocked(env, 'c:\\APDESK\\data\\profiles\\scout', W));
  assert.ok(!isBlocked(env, 'C:\\apdesk\\data\\workspace\\x.md', W));
  assert.ok(insideGranted('C:\\Users\\Owner\\Downloads\\a.pdf', ['C:\\Users\\Owner\\Downloads'], W));
  assert.ok(!insideGranted('C:\\Users\\Owner\\Documents\\a.pdf', ['C:\\Users\\Owner\\Downloads'], W));
  assert.deepEqual(listDrives('win32', ['C', 'D']).map((d) => d.dir), ['C:\\', 'D:\\']);
});

test('names and paths', () => {
  assert.deepEqual(cleanRel('a//b/c'), ['a', 'b', 'c']);
  for (const n of ['a/b', 'CON', 'x.', 'a:b', '']) assert.throws(() => validName(n));
  assert.equal(validName(' report.xlsx '), 'report.xlsx');
});

test('knowledge chunking keeps pages', () => {
  const r = pageRegions('[page 1]\nalpha\n[page 2]\nbeta');
  assert.deepEqual(r.map((x) => x.page), [1, 2]);
  assert.ok(chunkText('x '.repeat(2000)).length > 1);
});

test('files: write asks the door, list/read, owner-only routes, Bin', async () => {
  const t = await testDesk({ modules: ['files'] });
  try {
    const files = t.core.modules.api('files');
    const w = await files.write('notes/a.md', '# hi', { agentId: 'scout', jobId: 'j' });
    assert.equal(w.how, 'level');
    assert.equal((await files.read('notes/a.md')).text, '# hi');
    assert.deepEqual((await files.list('notes')).items.map((i) => i.name), ['a.md']);
    await assert.rejects(() => files.write('../x', 'y'), /leaves/);
    await assert.rejects(() => files.write(path.join(t.dataDir, 'x.txt'), 'y'), /only inside the workspace/);
    assert.equal((await t.call('/api/m/files/list?root=home', { session: false })).status, 403);
    const listed = (await t.call('/api/m/files/list?root=home&path=notes')).json;
    assert.equal(listed.items[0].madeBy, 'Scout');
    await files.trash('notes/a.md', { agentId: 'scout' });
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'workspace', 'notes', 'a.md')));
    assert.equal((await t.call('/api/m/files/list?root=bin')).json.items.length, 1);
    const mk = await t.call('/api/m/files/mkdir', { body: { root: 'home', path: '', name: 'New folder' } });
    assert.equal(mk.json.name, 'New folder');
    const mv = await t.call('/api/m/files/rename', { body: { root: 'home', path: 'New folder', name: 'Plans' } });
    assert.equal(mv.json.path, 'Plans');
  } finally { await t.close(); }
});

test('PDF text: a pdfkit document reads in order, per page, with plain errors', async () => {
  const { createRequire } = await import('node:module');
  const zlib = await import('node:zlib');
  const { pdfToText } = await import('./pdf-text.js');
  const { docPdf } = await import('../office/make.js');
  const PDFDocument = createRequire(import.meta.url)('pdfkit');
  const made = (opts, draw) => new Promise((resolve) => {
    const doc = new PDFDocument(opts); const parts = [];
    doc.on('data', (c) => parts.push(c)); doc.on('end', () => resolve(Buffer.concat(parts)));
    draw(doc); doc.end();
  });

  // Regular and bold subset fonts reuse the same glyph codes; each must decode through its own map.
  const md = '# Quarterly note\n\nHello PDF with a table.\n\nThis line has **bold words** and plain words.\n\n| Item | Price |\n| --- | --- |\n| Tea | ₹ 40 |\n| Coffee | ₹ 90 |\n\nA second paragraph closes the note.';
  const text = await pdfToText(await docPdf({ title: 'Quarterly note', markdown: md }));
  for (const line of ['Quarterly note', 'Hello PDF with a table.', 'This line has bold words and plain words.', 'Item Price', 'A second paragraph closes the note.']) assert.ok(text.includes(line), `${line} in:\n${text}`);
  assert.match(text, /Coffee (₹|Rs\.) 90/);

  const two = await pdfToText(await made({}, (d) => { d.text('First page words'); d.addPage(); d.text('Second page words'); }));
  assert.equal(two, '[page 1]\nFirst page words\n\n[page 2]\nSecond page words');

  // A content stream written with [/ASCII85Decode /FlateDecode], as ReportLab does.
  const a85 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 4) { const g = Buffer.alloc(4); b.copy(g, 0, i, i + 4); let n = g.readUInt32BE(0); const k = Math.min(4, b.length - i); if (n === 0 && k === 4) { s += 'z'; continue; } const c = []; for (let j = 0; j < 5; j += 1) { c.unshift(String.fromCharCode(33 + (n % 85))); n = Math.floor(n / 85); } s += c.join('').slice(0, k + 1); } return `${s}~>`; };
  const body = a85(zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Filtered stream text) Tj ET')));
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${body.length} /Filter [/ASCII85Decode /FlateDecode] >>\nstream\n${body}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const at = [];
  objs.forEach((o, i) => { at.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`;
  assert.equal(await pdfToText(Buffer.from(pdf, 'latin1')), 'Filtered stream text');

  await assert.rejects(pdfToText(Buffer.from('not a pdf at all')), { code: 'malformed' });
  await assert.rejects(pdfToText(await made({}, (d) => d.rect(50, 50, 100, 100).fill('#000'))), { code: 'pdfNoText' });
  await assert.rejects(pdfToText(await made({ userPassword: 'secret' }, (d) => d.text('hidden'))), { code: 'encrypted' });
});

test('readTable: an .xlsx workbook gives every row of its first sheet as cell text; CSV too; anything else is refused plainly', async () => {
  const { readTable } = await import('./convert.js');
  const { createRequire } = await import('node:module');
  const ExcelJS = createRequire(import.meta.url)('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Customers');
  ws.addRow(['Company', 'Phone']); for (let i = 0; i < 2500; i++) ws.addRow([`Firm ${i}`, `+91 98000 ${String(i).padStart(5, '0')}`]);
  const t = readTable(Buffer.from(await wb.xlsx.writeBuffer()), '.xlsx');
  assert.equal(t.sheet, 'Customers'); assert.equal(t.rows.length, 2501, 'every row, not cut at the preview limit');
  assert.deepEqual(t.rows[1], ['Firm 0', '+91 98000 00000']);
  assert.deepEqual(readTable(Buffer.from('a,b\n1,2\n'), 'csv').rows, [['a', 'b'], ['1', '2']]);
  assert.throws(() => readTable(Buffer.from('x'), '.pdf'), /Only \.xlsx and \.csv/);
  assert.throws(() => readTable(Buffer.from('not a zip'), '.xlsx'), /damaged/);
});
