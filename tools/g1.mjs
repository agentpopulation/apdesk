// Shell check: the shell runs full window in both themes, and Panic stops a REAL model's reply mid-stream.
// Run from the repository root:  node tools/g1.mjs [screenshot dir]
// Needs a real model: keys from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY, ...) or the built-in free router. Prints PASS/FAIL lines and writes screenshots.
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');   // the globally installed Playwright (or the app's own playwright-core)
import { createDesk } from '../app/server.js';
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-g1'); fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-g1-'));
const desk = await createDesk({ dataDir, port: 0, quiet: true }); await desk.start();
const results = []; const check = (name, ok, evidence) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${evidence || ''}`); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(desk.url()); await page.waitForSelector('#menu .nav');
// onboarding shows first, Skip shows everything
check('onboarding offers five roles and Skip', await page.locator('#roles .role').count() === 5 && await page.locator('#onb-skip').isVisible(), '');
await page.screenshot({ path: path.join(out, 'onboarding_1920x1080_light.png') });
await page.click('#onb-skip'); await page.waitForTimeout(300);
const menu = await page.locator('#menu .nav').allTextContents();
check('official menu, exactly', JSON.stringify(menu) === JSON.stringify(['Chat', 'Research', 'Tasks', 'Sales', 'Files', 'Agents', 'Models', 'Settings']), menu.join(', '));
const geo = await page.evaluate(() => { const b = document.querySelector('.bar').getBoundingClientRect(), m = document.querySelector('#menu').getBoundingClientRect(), p = document.querySelector('#pane').getBoundingClientRect(), pn = document.querySelector('#panic').getBoundingClientRect(), hm = document.querySelector('#home').getBoundingClientRect(); return { menuCentreOff: Math.abs((m.left + m.right) / 2 - (b.left + b.right) / 2), paneBottomGap: innerHeight - p.bottom, paneW: p.width, vw: innerWidth, scrollY: document.documentElement.scrollHeight - innerHeight, panicRight: innerWidth - pn.right, homeLeft: hm.left, radius: getComputedStyle(document.querySelector('#pane')).borderRadius }; });
check('menu centred, Home left, Panic right', geo.menuCentreOff < 2 && geo.homeLeft < 40 && geo.panicRight < 40, JSON.stringify(geo));
check('full window: pane fills, page never scrolls, rounded', geo.scrollY <= 0 && geo.paneBottomGap < 16 && geo.paneW > geo.vw - 40 && parseFloat(geo.radius) >= 12, '');
for (const pg of ['home', 'settings', 'settings/security', 'settings/modules']) { await page.evaluate((h) => { location.hash = '#/' + h; }, pg); await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, `${pg.replace('/', '-')}_1920x1080_light.png`) }); }
await page.click('#theme'); await page.waitForTimeout(250);
check('black theme toggles', await page.evaluate(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)'), '');
for (const pg of ['home', 'settings/security']) { await page.evaluate((h) => { location.hash = '#/' + h; }, pg); await page.waitForTimeout(350); await page.screenshot({ path: path.join(out, `${pg.replace('/', '-')}_1920x1080_dark.png`) }); }
// a real reply, cut by the Panic button
const started = await page.evaluate(async () => {
  window.__got = ''; window.__last = null;
  window.__p = window.apd.apiStream('model/ask', { prompt: 'Write a detailed 900-word essay on the history of the printing press. Do not stop early.' }, (l) => { if (l.delta) window.__got += l.delta; window.__last = l; });
  return true;
});
await page.waitForFunction(() => window.__got.length > 60, null, { timeout: 90000 }).catch(() => {});
const before = await page.evaluate(() => window.__got.length);
await page.click('#panic');
const last = await page.evaluate(async () => { await window.__p.catch(() => {}); return window.__last; });
await page.waitForTimeout(1500);
const after = await page.evaluate(() => window.__got.length);
check('Panic stops a real reply mid-stream', before > 60 && last?.done && last.code === 'aborted' && after - before < 400 && after < 4500, `chars before Panic ${before}, after ${after}, end: ${last?.code || last?.label}`);
check('halt overlay shows; new asks are refused', await page.locator('#halt').isVisible() && await page.evaluate(async () => { let l; await window.apd.apiStream('model/ask', { prompt: 'hi' }, (x) => { l = x; }); return l.code === 'halted'; }), '');
await page.screenshot({ path: path.join(out, 'panic_1920x1080_dark.png') });
await page.click('#resume'); await page.waitForTimeout(300);
const again = await page.evaluate(async () => { let l; await window.apd.apiStream('model/ask', { prompt: 'Reply with one word: ready' }, (x) => { l = x; }); return l; });
check('after Resume a real model answers and is named', !!again?.label && !!again?.text, `[${again?.label}] ${String(again?.text || again?.error).trim().slice(0, 60)}`);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close(); await desk.stop(); fs.rmSync(dataDir, { recursive: true, force: true });
console.log('screenshots:', out);
process.exit(results.every(Boolean) ? 0 : 1);
