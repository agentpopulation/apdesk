// Plumbing tests for Office (no model).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { asCell, normalizeTable, slug, blocksOf } from './make.js';
import { testDesk } from '../../test/helpers/desk.js';
const ExcelJS = createRequire(import.meta.url)('exceljs');

test('cells: numbers become numbers, text stays text', () => {
  assert.equal(asCell('1,29,999'), 129999); assert.equal(asCell('₹ 85,000'), 85000); assert.equal(asCell('1.4'), 1.4);
  assert.deepEqual(asCell('45%'), { pct: 0.45 }); assert.equal(asCell('1.4 kg'), '1.4 kg'); assert.equal(asCell('Model 3'), 'Model 3');
  assert.deepEqual(normalizeTable([{ key: 'n', label: 'Name' }], [{ n: 'A' }]).rows, [['A']]);
  assert.equal(slug('Compare: Laptops 2026!'), 'compare-laptops-2026');
  assert.deepEqual(blocksOf('# T\n\n1. a\n2. b\n\n| x |\n|---|\n| 1 |').map((b) => b.type), ['h', 'ol', 'table']);
});

test('makeTable writes a real xlsx in workspace/tables; makeDoc writes docx/pdf/md in reports', async () => {
  const t = await testDesk({ modules: ['files', 'office'] });
  try {
    const office = t.core.modules.api('office');
    const r = await office.makeTable({ title: 'Laptops', columns: ['Name', 'Price'], rows: [['A', '99,900'], ['B', 45990]] });
    assert.equal(r.path, 'tables/laptops.xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(t.dataDir, 'workspace', 'tables', 'laptops.xlsx'));
    assert.deepEqual(wb.worksheets[0].getRow(2).values.slice(1), ['A', 99900]);
    assert.equal((await office.makeTable({ title: 'Laptops', columns: ['Name'], rows: [['A']] })).name, 'laptops (2).xlsx');
    assert.match((await office.makeTable({ title: 'L', columns: ['a'], rows: [['x,y']], format: 'csv' })).path, /tables\/l\.csv$/);
    for (const format of ['docx', 'pdf', 'md']) assert.equal((await office.makeDoc({ title: 'Q3 report', markdown: '# Q3\n\ntext', format })).path, `reports/q3-report.${format}`);
    const tool = await t.core.modules.runTool('table_file', { title: 'T', columns: ['a'], rows: [['1']] }, { agentId: 'scout', chatId: 'c' });
    assert.equal(tool.cards[0].kind, 'file');
  } finally { await t.close(); }
});
