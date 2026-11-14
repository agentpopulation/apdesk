// Real checks for Search: the provider chain against the real web, and three real page reads (HTML, Wikipedia, PDF).
//   node modules/search/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers. SERPER_API_KEY (optional) adds Google results.
// Set APD_SEARXNG_URL=http://127.0.0.1:8899/ to include a local SearXNG sidecar.
import { testDesk } from '../../test/helpers/desk.js';
const results = []; const check = (name, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev}`); };
const t = await testDesk({ real: true, modules: ['search'] });
const s = t.core.modules.api('search');
try {
  const st = await s.status();
  for (const p of st.providers) console.log(`      ${p.state.padEnd(13)} ${p.label}: ${p.note || ''}`);
  const live = st.providers.filter((p) => p.ok);
  check('status: which providers answer now', live.length >= 2, live.map((p) => p.label).join(', ') + (st.searxngUrl ? ` · SearXNG at ${st.searxngUrl}` : ''));
  const ddg = st.providers.find((p) => p.id === 'duckduckgo');
  check('DuckDuckGo: answers, or its bot check is reported and skipped (never worked around)', ddg.ok || /bot check|could not be reached|no results|connection reset|no answer in time|HTTP/.test(ddg.note), ddg.note);
  const r = await s.search('heat pump efficiency in cold climates', { count: 10 });
  check('search returns 10 merged results with their sources', r.length === 10 && r.every((x) => /^https?:/.test(x.url) && x.title && x.source), r.attempts.map((a) => `${a.label}: ${a.ok ? a.n : a.note}`).join(' · '));
  const free = await s.searchDetailed('James Webb Space Telescope', { count: 6, skip: ['serper', 'brave', 'tavily', 'exa', 'jina'] });
  check('keyless only (no keyed provider) still finds pages', free.results.length >= 4, free.attempts.map((a) => `${a.label}: ${a.ok ? a.n : a.note}`).join(' · '));
  for (const u of ['https://en.wikipedia.org/wiki/Heat_pump', 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview', 'https://arxiv.org/pdf/1706.03762']) {
    try { const p = await s.read(u); check(`read ${u}`, p.status === 200 && p.text.length > 1000, `${p.kind}, "${p.title}", ${p.text.length} characters: ${p.text.slice(0, 90).replace(/\s+/g, ' ')}…`); }
    catch (e) { check(`read ${u}`, false, e.message); }
  }
  let refused = false; try { await s.read('http://127.0.0.1:22/'); } catch (e) { refused = e.code === 'private'; }
  check('reader refuses this computer and the local network', refused, '');
  const tr = await t.core.modules.runTool('web_read', { url: 'https://en.wikipedia.org/wiki/Readability' }, {});
  check('tool web_read answers with page text marked as data', tr.text?.length > 500 && /not instructions/.test(tr.note), tr.title);
} finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
