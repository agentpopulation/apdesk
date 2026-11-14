// Real checks for Research: one deep research end to end with a real model and the real web, then a 3-agent swarm.
//   node modules/research/real-check.mjs ["question"]
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers. SERPER_API_KEY (optional) adds Google results.
import fs from 'node:fs';
import { testDesk } from '../../test/helpers/desk.js';

const question = process.argv[2] || 'How do heat pumps work, how efficient are they, and what limits their adoption in cold climates?';
const results = []; const check = (name, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev}`); };
const t = await testDesk({ real: true, modules: (process.env.WITH_OFFICE ? ['files', 'office'] : []).concat(['search', 'research']) });
const research = t.core.modules.api('research');
try {
  const t0 = Date.now();
  const job = await research.deep({ question, agentId: 'scout' });
  let last = '';
  const timer = setInterval(() => { const j = t.core.jobs.get(job.id); if (j?.detail !== last) { last = j?.detail; console.log(`      ${Math.round((Date.now() - t0) / 1000)}s  ${Math.round((j?.progress || 0) * 100)}%  ${last}`); } }, 2000);
  const done = await t.core.jobs.wait(job.id, 15 * 60_000); clearInterval(timer);
  check('deep research job finished', done.status === 'done', `${done.status} in ${Math.round((Date.now() - t0) / 1000)}s ${done.error || ''}`);
  const rep = research.report(job.reportId);
  const d = rep?.data || {};
  console.log(`      models: ${(d.labels || []).join(', ')} · ${d.modelCalls} model calls · search: ${JSON.stringify(d.providers)}`);
  const srcs = d.sources || [];
  if (d.anchor) console.log(`      entity: ${d.anchor.name} (${d.anchor.domain || 'no domain'}), own site read: ${d.anchor.siteRead}; settled: ${d.screen?.settled}; kept ${d.counts?.read} pages; left out as a different organisation: ${(d.screen?.different || []).map((x) => `${new URL(x.url).hostname} (${x.about})`).join(', ') || 'none'}; not confirmed: ${(d.screen?.unclear || []).length}`);
  const insane = (d.claims || []).filter((c) => c.sanity); console.log(`      numbers sanity pass: ${insane.length} claims failed${insane.length ? ': ' + insane.map((c) => `"${c.text.slice(0, 80)}" (${c.sanity})`).join(' | ') : ''}`);
  check('at least ten distinct sources cited, each fetched with HTTP 200 and text extracted', srcs.length >= 10 && srcs.every((s) => s.chars > 400), `${srcs.length} cited of ${d.counts?.read} read (${d.counts?.tried} tried); top-up rounds used: ${d.topUpRounds ?? 0}; hosts: ${[...new Set(srcs.map((s) => s.host))].length}`);
  const again = await Promise.all(srcs.map(async (s) => { try { const r = await fetch(s.url, { headers: { 'User-Agent': 'AgentPopulationDesk/0.1 (local desktop app)' }, signal: AbortSignal.timeout(20000) }); await r.body?.cancel(); return r.status; } catch (e) { return e.cause?.code || 'error'; } }));
  check('each cited source URL answers 200 when fetched again', again.every((x) => x === 200), again.map((x, i) => `${i + 1}:${x}`).join(' '));
  const claims = d.claims || []; const passed = claims.filter((c) => c.ok?.length).length;
  const cites = claims.flatMap((c) => c.checks); const citeOk = cites.filter((k) => k.ok).length;
  check('claims passed the support check (quote found in the fetched text); at least ten kept, the rest marked "not checked"', passed >= 10, `${passed} of ${claims.length} claims; ${citeOk} of ${cites.length} citations verified (${cites.filter((k) => k.ok && k.by === 'model quote').length} by the model's quote found verbatim, ${cites.filter((k) => k.ok && k.by === 'code match').length} by a code match of 80% of the claim's words to one page sentence, only for claims without numbers); unsupported are marked "not checked"`);
  const whys = {}; for (const k of cites.filter((x) => !x.ok)) whys[k.why] = (whys[k.why] || 0) + 1;
  console.log('      citations not verified, by reason: ' + JSON.stringify(whys));
  const bad = claims.filter((c) => c.ok?.length).flatMap((c) => c.checks.filter((k) => k.ok)).filter((k) => !k.quote);
  check('every kept citation carries its verified quote', bad.length === 0, `example: "${(claims.find((c) => c.ok?.length)?.checks.find((k) => k.ok)?.quote || '').slice(0, 140)}"`);
  // five kept citations, printed with their quote, and an independent re-check: quote in a fresh fetch of the page, every number inside the quote
  const { htmlToDoc } = await import('../search/reader.js');
  const { norm, numbersIn } = await import('./util.js');
  const kept = claims.flatMap((c) => c.checks.filter((k) => k.ok).map((k) => ({ claim: c.text, quote: k.quote, by: k.by, url: srcs.find((s) => s.quotes?.some((q) => q.quote === k.quote))?.url })));
  const withNums = kept.filter((k) => numbersIn(k.claim).length); const sample = [...withNums.slice(0, 3), ...kept.filter((k) => !withNums.includes(k))].slice(0, 5);
  let sampleOk = 0;
  for (const k of sample) {
    const nums = numbersIn(k.claim).map((n) => n.v); const qn = new Set(numbersIn(k.quote).map((n) => n.v));
    let found = 'not re-fetched';
    try { const r = await fetch(k.url, { headers: { 'User-Agent': 'AgentPopulationDesk/0.1 (local desktop app)' }, signal: AbortSignal.timeout(20000) }); const ty = r.headers.get('content-type') || ''; if (/pdf/.test(ty)) { found = 'PDF (checked at read time)'; } else { const d = htmlToDoc(await r.text(), k.url); found = norm(d.text).includes(norm(k.quote).replace(/^["'(\[]+|["')\].,;:]+$/g, '')) ? 'quote found in a fresh fetch' : 'quote NOT found in a fresh fetch'; } } catch (e) { found = 'fresh fetch failed: ' + e.message; }
    const numsOk = nums.every((n) => qn.has(n));
    if (numsOk && !/NOT/.test(found)) sampleOk++;
    console.log(`      CLAIM: ${k.claim}\n      QUOTE: "${k.quote}"\n      SOURCE: ${k.url} (${k.by}; ${found})\n      NUMBERS: ${nums.length ? nums.map((n) => `${n} ${qn.has(n) ? 'in quote' : 'MISSING'}`).join(', ') : 'none in the claim'}\n`);
  }
  check('five kept citations: quote in the page and every number of the claim inside the quote', sample.length === 5 && sampleOk === 5, `${sampleOk} of ${sample.length}`);
  const f = rep?.files || {};
  const exists = ['md', 'pdf', 'docx'].map((k) => f[k] && fs.existsSync(t.core.storage.workspacePath(...f[k].split('/'))) ? fs.statSync(t.core.storage.workspacePath(...f[k].split('/'))).size : 0);
  check('Markdown, PDF and Word written to workspace/reports', exists.every((n) => n > 500), `${t.core.storage.workspace}/ ${f.md} (${exists[0]} B), ${f.pdf} (${exists[1]} B), ${f.docx} (${exists[2]} B) via ${f.via} ${f.errors?.length ? f.errors.join('; ') : ''}`);
  const pdfHead = exists[1] ? fs.readFileSync(t.core.storage.workspacePath(...f.pdf.split('/'))).subarray(0, 5).toString() : '';
  const docxHead = exists[2] ? fs.readFileSync(t.core.storage.workspacePath(...f.docx.split('/'))).subarray(0, 2).toString() : '';
  check('PDF and Word files are real files', pdfHead === '%PDF-' && docxHead === 'PK', `${pdfHead} / ${docxHead}`);
  if (process.env.KEEP) { fs.mkdirSync(process.env.KEEP, { recursive: true }); for (const k of ['md', 'pdf', 'docx']) if (f[k]) fs.copyFileSync(t.core.storage.workspacePath(...f[k].split('/')), `${process.env.KEEP}/report.${k}`); }
  console.log('\n----- report (first 1500 characters) -----\n' + String(rep?.markdown || '').slice(0, 1500) + '\n-----');

  if (!process.env.NO_SWARM) {
    const s0 = Date.now();
    const sj = await research.swarm({ task: 'Compare the three most popular open-source relational databases: licence, strengths, and typical use', agents: 3 });
    const sd = await t.core.jobs.wait(sj.id, 8 * 60_000);
    const sw = research.swarmState(sj.swarmId);
    const listed = (String(sw.answer || '').match(/^- /gm) || []).length; const total = sw.tiles.reduce((a, x) => a + (x.findings?.length || 0), 0);
    check('swarm of 3 agents finished; every sourced finding is in the answer (only exact repeats merged)', sd.status === 'done' && sw.tiles.length === 3 && listed > 0 && listed === sw.data?.findings && sw.tiles.flatMap((x) => x.findings || []).filter((f) => !(sw.answer.includes(f.text) && sw.answer.includes(f.url))).length === total - listed, `${sd.status} in ${Math.round((Date.now() - s0) / 1000)}s; ${sw.data?.findings} findings from ${sw.data?.scouts} scouts (scouts returned ${total}, ${total - listed} duplicates merged); ${sw.sources?.length} sources, URLs whole ${sd.error || ''}`);
    for (const x of sw.tiles) console.log(`      ${x.agent} "${x.title}": ${x.status}, ${x.findings?.length ?? 0} findings, model: ${x.label || '-'}`);
    console.log(`      ${sw.data?.oneModel ? 'All scouts ran on one model' : 'Scouts ran on ' + (sw.data?.scoutModels || []).length + ' different models'}`);
    console.log('      swarm answer: ' + String(sw.answer || '').replace(/\s+/g, ' ').slice(0, 400));
  }
} finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
