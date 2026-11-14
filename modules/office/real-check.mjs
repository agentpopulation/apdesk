// Real checks for Office (ask 5). Needs a real model:  node modules/office/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import path from 'node:path';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

const results = [];
const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${evidence}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = await testDesk({ real: true, modules: ['files', 'office'] });
try {
  // Ask 5: a real instruction -> a real model picks table_file with arguments -> the tool writes an xlsx -> read it back.
  const tool = t.core.modules.tools.get('table_file');
  const instruction = 'Compare three laptops (name, price, weight, battery) into a table file.';
  let r = null; let err = null;
  for (let attempt = 0; attempt < 3 && !r?.toolCalls?.length; attempt++) {
    try {
      r = await t.core.model.chat({
        purpose: 'chat',
        messages: [
          { role: 'system', content: 'You are a desk assistant with tools. When the owner asks for a table file, call table_file once with complete data from what you know. Prices in Indian rupees.' },
          { role: 'user', content: instruction },
        ],
        tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
      });
    } catch (e) { err = e; await sleep(30000); }
  }
  const call = r?.toolCalls?.find((c) => c.name === 'table_file');
  check('ask 5: a real model turns the instruction into a table_file call', !!call, call ? `[${r.label}] columns=${JSON.stringify(call.args.columns)} rows=${call.args.rows?.length}` : `no tool call: ${err?.message || String(r?.text).slice(0, 120)}`);
  if (call) {
    const out = await t.core.modules.runTool('table_file', call.args, { agentId: 'coordinator', chatId: 'chat_real_5' });
    check('ask 5: table_file wrote a file and returned a file card', out.ok && out.cards?.[0]?.kind === 'file', JSON.stringify({ path: out.path, card: out.cards?.[0]?.kind, error: out.error }));
    if (out.ok) {
      const abs = path.join(t.dataDir, 'workspace', ...out.path.split('/'));
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(abs);
      const ws = wb.worksheets[0];
      const rows = []; ws.eachRow((row) => rows.push(row.values.slice(1)));
      const [header, ...body] = rows;
      console.log('      header:', JSON.stringify(header));
      for (const b of body) console.log('      row:   ', JSON.stringify(b));
      const want = ['name', 'price', 'weight', 'battery'];
      const hasCols = want.every((w) => header.some((h) => String(h).toLowerCase().includes(w)));
      check('ask 5: the xlsx is in the workspace with the asked columns', out.path.startsWith('tables/') && hasCols, `${out.path} header=${header.join(' | ')}`);
      const priceCol = header.findIndex((h) => /price/i.test(String(h)));
      const weightCol = header.findIndex((h) => /weight/i.test(String(h)));
      check('ask 5: three product rows, each with a name', body.length === 3 && body.every((b) => String(b[0] || '').trim().length > 2), body.map((b) => b[0]).join(', '));
      check('ask 5: prices and weights are stored as numbers', body.every((b) => typeof b[priceCol] === 'number' && b[priceCol] > 1000) && body.every((b) => typeof b[weightCol] === 'number' || /\d/.test(String(b[weightCol]))), body.map((b) => `${typeof b[priceCol]}:${b[priceCol]} / ${typeof b[weightCol]}:${b[weightCol]}`).join(', '));
      check('ask 5: header row is bold and frozen, columns sized', ws.getRow(1).font?.bold === true && ws.views?.[0]?.ySplit === 1 && header.every((_, i) => ws.getColumn(i + 1).width >= 8), header.map((_, i) => Math.round(ws.getColumn(i + 1).width)).join(','));
    }
  }
  // makeDoc for the research module: PDF and Word from Markdown with a table, a link and numbered sources (no model).
  const office = t.core.modules.api('office');
  const md = '# Edge data centres\n\nA short **summary** with a [link](https://en.wikipedia.org/wiki/Edge_computing) [1].\n\n## Findings\n\n1. First point\n2. Second point\n\n| Region | Sites |\n|---|---|\n| India | 12 |\n| EU | 30 |\n';
  const pdf = await office.makeDoc({ title: 'Edge data centres', markdown: md, format: 'pdf', sources: [{ n: 1, title: 'Edge computing', url: 'https://en.wikipedia.org/wiki/Edge_computing' }] });
  const docx = await office.makeDoc({ title: 'Edge data centres', markdown: md, format: 'docx', sources: [{ n: 1, title: 'Edge computing', url: 'https://en.wikipedia.org/wiki/Edge_computing' }] });
  const files = t.core.modules.api('files');
  const pdfText = (await files.read(pdf.path)).text; const docxText = (await files.read(docx.path)).text;
  check('makeDoc: PDF keeps headings, the table and numbered sources', /Findings/.test(pdfText) && /India/.test(pdfText) && /Sources/.test(pdfText), `${pdf.path} ${pdfText.replace(/\s+/g, ' ').slice(0, 110)}`);
  check('makeDoc: Word keeps headings, the table and numbered sources', /Findings/.test(docxText) && /\| India \| 12 \|/.test(docxText) && /Edge computing/.test(docxText), `${docx.path} ${docxText.replace(/\s+/g, ' ').slice(0, 110)}`);
} finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
