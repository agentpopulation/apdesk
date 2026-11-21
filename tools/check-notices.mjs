// Shell and core checks in a real browser: finished-job badge and notice, a finished download's one notice, desk name,
// Offline held in the process.
// Run from the repository root, no model keys needed:  node tools/check-notices.mjs [screenshot dir]
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { testDesk } from '../test/helpers/desk.js';
import { startDownloadHost, sha, autoApprove } from '../test/helpers/download-host.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'apd-shell-checks'); fs.mkdirSync(SHOTS, { recursive: true });
const t = await testDesk({ modules: ['chat', 'sales', 'tasks', 'research', 'search'] });
let fails = 0; const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };
try {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1366, height: 768 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(t.base + '/#/home'); await p.waitForTimeout(1200);
  await p.getByText('Skip, show everything').click().catch(() => {}); await p.waitForTimeout(500);
  // a job finishes while the owner is on Home
  const job = await t.core.jobs.start({ kind: 'research.deep', title: 'Report on tea', run: async () => ({ ok: true }) });
  await t.core.jobs.wait(job.id, 3000); await p.waitForTimeout(800);
  const badge = await p.evaluate(() => document.querySelector('.nav[data-v="research"] .badge')?.textContent || null);
  const notice = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
  check('a finished job shows a notice and a count on its menu place', badge === '1' && /Finished: Report on tea/.test(notice), `badge ${badge}, notice "${notice}"`);
  await p.screenshot({ path: path.join(SHOTS, 'finished_badge_1366x768.png') });
  await p.evaluate(() => { location.hash = '#/research'; }); await p.waitForTimeout(700);
  check('the count clears when the owner opens that place', await p.evaluate(() => !document.querySelector('.nav[data-v="research"] .badge')));
  // a download: one notice when it finishes while the window is open, none for one that finished before
  { const body = Buffer.alloc(40 * 1024, 5); const host = await startDownloadHost({ '/a': { body }, '/b': { body, slowMs: 60, chunk: 4096 } }); const ok = autoApprove(t.core);
    try {
      const spec = (n) => ({ title: 'Notice file ' + n, url: host.url('/' + n), allowHosts: ['127.0.0.1'], size: body.length, sha256: sha(body), to: path.join(t.dataDir, 'dl', n + '.bin'), kind: 'check' });
      const a = await t.core.downloads.start(spec('a')); await t.core.downloads.whenDone(a.id);
      await p.reload(); await p.waitForSelector('#menu .nav'); await p.waitForTimeout(800);
      const b2 = await t.core.downloads.start(spec('b')); await t.core.downloads.whenDone(b2.id); await p.waitForTimeout(700);
      t.core.events.emit('downloads', { download: t.core.downloads.out(t.core.downloads.get(b2.id)), summary: t.core.downloads.summary() }); await p.waitForTimeout(400);   // the same news twice
      const n = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent));
      check('a finished download gives one notice; one finished before the window opened gives none', n.filter(x => x === 'Downloaded: Notice file b').length === 1 && !n.some(x => /Notice file a/.test(x)), n.join(' | '));
      await p.screenshot({ path: path.join(SHOTS, 'download_notice_1366x768.png') });
    } finally { ok.stop(); await host.close(); } }
  // desk name
  await p.evaluate(() => { location.hash = '#/settings/general'; }); await p.waitForTimeout(800);
  const field = p.locator('input[placeholder="AP Desk"]'); await field.fill('Example Traders Desk'); await field.dispatchEvent('change'); await p.waitForTimeout(900);
  const name = await p.evaluate(() => ({ bar: document.querySelector('.bar .name').textContent, title: document.title }));
  check('the desk can be renamed in Settings: top bar and window title follow', name.bar === 'Example Traders Desk' && name.title === 'Settings · Example Traders Desk', JSON.stringify(name));
  await p.screenshot({ path: path.join(SHOTS, 'renamed_1366x768.png') });
  check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
  await b.close();
  // Offline in the process
  t.core.settings.set('online', false);
  const tryFetch = async (u) => { try { await fetch(u, { signal: AbortSignal.timeout(4000) }); return 'called'; } catch (e) { return e.code === 'offline' ? 'refused offline' : 'other: ' + (e.code || e.name); } };
  const outside = await tryFetch('https://example.com/'); const router = await tryFetch('http://127.0.0.1:8787/v1/models'); const searx = await tryFetch('http://127.0.0.1:8888/search?q=x');
  const own = await t.call('/api/state');
  check('Offline: a public site, the router on this PC and a local search engine are all refused in the desk process', outside === 'refused offline' && router === 'refused offline' && searx === 'refused offline', JSON.stringify({ outside, router, searx }));
  check('Offline: the desk still answers its own browser', own.status === 200);
  t.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:9');
  check('Offline: the local model address is still allowed to be called', (await tryFetch('http://127.0.0.1:9/api/tags')) !== 'refused offline');
  t.core.settings.set('online', true);
  check('Online again: outside calls are no longer refused by the desk', (await tryFetch('http://127.0.0.1:9/nothing')) !== 'refused offline');
} finally { await t.close(); }
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
