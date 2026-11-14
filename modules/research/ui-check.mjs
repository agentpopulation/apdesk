// Browser check of the Research page: starts a real deep research and a 3-agent swarm from the page itself,
// then screenshots every tab at 1920x1080 and 1366x768 in both themes and checks the window never scrolls.
//   node modules/research/ui-check.mjs [outDir]
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers. SERPER_API_KEY (optional) adds Google results.
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createDesk } from '../../app/server.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-research-ui'); fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-research-ui-'));
const desk = await createDesk({ dataDir, port: 0, quiet: true, modules: ['chat', 'search', 'research', 'council', 'files', 'office'] });
desk.core.settings.set('model.defaultChain', ['gemini', 'router', 'openrouter', 'keyed', 'ollama']);
await desk.start();
const results = []; const check = (name, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev}`); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
try {
  await page.goto(desk.url()); await page.waitForSelector('#menu .nav');
  if (await page.locator('#onb-skip').isVisible()) await page.click('#onb-skip');
  await page.evaluate(() => { location.hash = '#/research'; }); await page.waitForTimeout(800);
  await page.fill('input[aria-label="Research question"]', process.env.Q || 'What is the James Webb Space Telescope, what has it discovered, and what are its limits?');
  await page.click('text=Start research');
  const t0 = Date.now();
  await page.waitForFunction(() => /Ready|Failed|Stopped/.test(document.querySelector('.view .row h3 + .pill')?.textContent || ''), null, { timeout: 15 * 60_000 });
  const state = await page.locator('.view .row h3 + .pill').first().textContent();
  const nSrc = await page.locator('.cols .card .line a.btn').count();
  const sups = await page.locator('.report sup').count();
  const stepText = await page.locator('.view .row h3 ~ .sub').first().textContent().catch(() => '');
  const counts = await page.locator('.cols .stack .card .row .sub').first().textContent().catch(() => '');
  check('deep research started and finished from the page', state === 'Ready', `${state}: ${stepText} (${counts}) after ${Math.round((Date.now() - t0) / 1000)}s; ${nSrc} source Open links; ${sups} citation marks`);
  const hrefs = await page.locator('.cols .card .line a.btn').evaluateAll((as) => as.map((a) => a.href));
  check('every source has an Open link to its page', /(\d+) cited/.test(counts) && Number(counts.match(/(\d+) cited/)[1]) >= 10 && hrefs.every((h) => /^https?:\/\//.test(h)), counts + ' · ' + hrefs.slice(0, 3).join(' '));
  if (state !== 'Ready') throw new Error('deep research did not finish: ' + stepText);
  const dl = await Promise.all([page.waitForEvent('download', { timeout: 20000 }).catch(() => null), page.click('button:has-text("PDF")')]);
  check('PDF button downloads the report', !!dl[0], dl[0] ? await dl[0].suggestedFilename() : 'no download');
  await page.click('text=Open full report'); await page.waitForTimeout(400);
  check('Open full report shows the whole report', await page.locator('#modal .report sup').count() >= sups, ''); await page.screenshot({ path: path.join(out, 'deep_full_1920x1080_light.png') });
  await page.keyboard.press('Escape'); await page.evaluate(() => { const m = document.querySelector('#modal'); m.hidden = true; m.replaceChildren(); });
  // swarm
  await page.evaluate(() => { location.hash = '#/research/swarm'; }); await page.waitForTimeout(600);
  await page.fill('input[aria-label="Swarm job"]', 'Explain three renewable energy sources: solar, wind and hydro: how each works and its main drawback');
  await page.locator('input[aria-label="Number of agents"]').fill('3');
  await page.click('text=Start swarm');
  await page.waitForTimeout(4000); await page.screenshot({ path: path.join(out, 'swarm_running_1920x1080_light.png') });
  await page.waitForFunction(() => /Ready|Failed|Stopped/.test(document.querySelector('.view .row h3 + .pill')?.textContent || ''), null, { timeout: 8 * 60_000 });
  const tiles = await page.locator('.swg .tile').count();
  check('swarm of 3 ran from the page, tiles and a merged answer shown', tiles === 3 && await page.locator('text=Merged answer').count() === 1, `${tiles} tiles, ${await page.locator('.view .row h3 + .pill').first().textContent()}`);
  // screenshots and layout
  for (const [w, hgt] of [[1920, 1080], [1366, 768]]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.evaluate((t) => window.apd.setTheme(t === 'dark'), theme);
    for (const tab of ['', 'council', 'swarm']) {
      await page.evaluate((t) => { location.hash = '#/research' + (t ? '/' + t : ''); }, tab); await page.waitForTimeout(900);
      const g = await page.evaluate(() => ({ docScroll: document.documentElement.scrollHeight - innerHeight, paneW: document.querySelector('#pane').getBoundingClientRect().width, vw: innerWidth, viewW: document.querySelector('#view').getBoundingClientRect().width, overflowX: document.querySelector('#pane').scrollWidth - document.querySelector('#pane').clientWidth }));
      const name = `research-${tab || 'deep'}_${w}x${hgt}_${theme}.png`;
      await page.screenshot({ path: path.join(out, name) });
      check(`${tab || 'deep'} ${w}x${hgt} ${theme}: full window, no page scroll`, g.docScroll <= 0 && g.overflowX <= 0 && g.viewW > g.vw - 60, JSON.stringify(g));
    }
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally { await browser.close(); await desk.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
console.log('screenshots:', out);
process.exit(results.every(Boolean) ? 0 : 1);
