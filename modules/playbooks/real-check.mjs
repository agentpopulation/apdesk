// Real check for Playbooks against REAL free models (the built-in free router and free keys from the environment).
// node modules/playbooks/real-check.mjs [log file]
// 1. "Weekly competitor watch" for two example firms (on .example addresses: nothing about them is on the web, so an
//    honest answer finds nothing and says "not checked"; any news, price or page about them is invented).
// 2. "Monday pipeline review" on a desk with ten sample deals: every company, value and date must come from the deals.
import fs from 'node:fs';
import { testDesk } from '../../test/helpers/desk.js';
import { checkFigures } from './book.js';

const log = process.argv[2] || null;
const out = (s) => { console.log(s); if (log) fs.appendFileSync(log, s + '\n'); };
const t = await testDesk({ real: true, modules: ['chat', 'agents', 'sales', 'files', 'search', 'research', 'tasks', 'office', 'memory', 'playbooks'] });
if (process.env.APD_GEMINI_MODEL) t.core.settings.set('provider.gemini.model', process.env.APD_GEMINI_MODEL);
const results = [];
async function runOne(id, inputs, check) {
  const t0 = Date.now();
  const r = await t.call(`/api/m/playbooks/books/${id}/run`, { body: { inputs } });
  if (r.status !== 200) { out(`FAIL ${id}: did not start: ${r.json?.error}`); results.push(false); return; }
  const job = await t.core.jobs.wait(r.json.jobId, 9 * 60_000);
  const ms = Date.now() - t0;
  const run = (await t.call(`/api/m/playbooks/books/${id}/runs`)).json.runs[0];
  out(`\n=== ${run.title} ===`);
  out(`status: ${run.status} (job ${job.status}${job.error ? ': ' + job.error : ''}); by ${run.agentName}; model: ${run.model}; cost: ${run.cost ? run.cost.minor + ' minor units ' + (run.cost.currency || '') : 'not known'}; time: ${Math.round(ms / 1000)} s`);
  out(`waiting for the owner: ${run.waiting.map(w => w.title).join('; ') || 'nothing'}`);
  if (run.note) out(`note: ${run.note}`);
  out('--- result ---\n' + (run.result || '(none)') + '\n--- end ---');
  if (run.chatId) {
    const msgs = (await t.call(`/api/m/chat/chats/${run.chatId}/messages`)).json?.messages || [];
    const steps = msgs.flatMap(m => m.meta?.steps || []).map(st => `${st.tool}(${JSON.stringify(st.args || {}).slice(0, 140)}) ${st.status || ''}`);
    out(`tool steps (${steps.length}): ${steps.join(' | ').slice(0, 3000) || 'none'}`);
  }
  const verdict = check(run);
  out(`check: ${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.why}`);
  results.push(verdict.ok);
}

try {
  // 1. competitor watch on two example firms
  await runOne('competitor-watch', {
    competitors: 'Quillfeather Office Goods, quillfeather-office.example\nBrindlecove Trading, brindlecove-trading.example',
    watch: 'prices, offers, new products, news', business: 'We sell office furniture to small firms',
  }, (run) => {
    const text = run.result || '';
    const links = [...text.matchAll(/https?:\/\/[^\s)\]]+/g)].map(m => m[0]);
    const offSite = links.filter(u => !/\.example\b/.test(u));
    const prices = text.match(/\d+[.,]\d{2}\b|\b\d+\s?(EUR|USD|GBP|per cent|%)/g) || [];
    const honest = /not checked|could not|no (news|information|results|changes|public)|nothing (was )?found|did not find|not find|unable|no (web )?presence|not (be )?found/i.test(text);
    return { ok: run.status === 'done' && honest && !prices.length, why: `${links.length} links (${offSite.length} not on the example sites), ${prices.length} prices or percentages, says nothing was found or not checked: ${honest}` };
  });

  // 2. pipeline review on ten sample deals
  const sales = t.core.modules.api('sales');
  const cur = t.core.settings.get('currency') || 'EUR';
  const deals = [
    ['Northwind Supplies', 1250000, 'talks', 'Send the revised quote'], ['Blue Harbour Trading', 480000, 'researched', null],
    ['Maple Office Works', 2200000, 'talks', 'Meeting on the fit-out plan'], ['Riverside Dental Group', 95000, 'new', null],
    ['Granite Logistics', 760000, 'drafted', 'Follow up on the first mail'], ['Sunrise Bakery Co', 30000, 'new', null],
    ['Harbor Light Studios', null, 'researched', 'Find the office manager'], ['Peak Fitness Centres', 1530000, 'talks', null],
    ['Quill and Ink Books', 120000, 'drafted', 'Answer their question on delivery'], ['Lakeside Hotel Group', 3900000, 'new', 'Ask for a site visit'],
  ];
  for (const [company, value, stage, nextStep] of deals) sales.addLead({ company, value, currency: cur, stage, nextStep, need: 'office furniture' });
  await runOne('pipeline-review', { focus: '5' }, (run) => {
    const text = run.result || '';
    const names = deals.map(d => d[0]);
    const named = names.filter(n => text.includes(n));
    const f = checkFigures(text, JSON.stringify(deals) + deals.map(d => d[1] == null ? '' : (d[1] / 100).toFixed(2)).join(' ') + ' 5 10', deals.map(d => d[1]).filter(v => v != null));
    const inventedNames = (text.match(/\*\*([A-Z][\w&' ]+?)\*\*/g) || []).map(x => x.replace(/\*/g, '')).filter(n => /(Group|Co|Ltd|Inc|Trading|Supplies|Works|Studios|Centres|Books|Logistics)$/.test(n) && !names.includes(n));
    return { ok: run.status === 'done' && named.length >= 5 && !f.unknown.length && !inventedNames.length, why: `${named.length} of 10 deals named; figures in no deal: ${f.unknown.join(', ') || 'none'}; totals that add up from the deals: ${f.added.join(', ') || 'none'}; company names not in the deals: ${inventedNames.join(', ') || 'none'}` };
  });
} finally {
  out(`\n${results.filter(Boolean).length} of ${results.length} checks passed (real free models; read the results above before trusting the count).`);
  await t.close();
}
