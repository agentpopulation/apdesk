// Screen check of the Computer tab and Settings › Payments in a real browser, at 1920x1080 and 1366x768, both themes.
// Without the Agents module the tab is rendered on its own in the desk's view.
// Run:  node modules/browser/ui-check.mjs [outDir]
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-browser-ui'); fs.mkdirSync(out, { recursive: true });
const results = []; const check = (name, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(ev).slice(0, 300)}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t = await testDesk({ real: true, modules: ['browser', 'payments', 'agents', 'chat'].filter(m => fs.existsSync(path.join(import.meta.dirname, '..', m, 'module.json'))) });
await t.call('/api/modules/payments/on', { body: {} });
const browser = await pw.chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
await page.goto(t.base); await page.waitForSelector('#menu .nav'); if (await page.locator('#onb-skip').isVisible()) await page.click('#onb-skip');
const showTab = async () => {
  const agentsUi = await page.evaluate(() => window.apd.moduleOn('agents') && window.apd.state.modules.find(m => m.id === 'agents')?.hasUi);
  if (agentsUi) { await page.evaluate(() => { location.hash = '#/agents/operator/computer'; }); await sleep(800); if (await page.locator('.bstage').count()) return 'agents page'; }
  await page.evaluate(async () => { const m = await import('/modules/browser/ui.js'); const v = document.querySelector('#view'); v.replaceChildren(); const h2 = document.createElement('h2'); h2.textContent = 'Operator · Computer'; v.append(h2); await m.agentTabs.computer.render(v, window.apd, window.apd.agent('operator') || { id: 'operator', name: 'Operator' }); });
  await page.waitForSelector('.bstage'); return 'rendered on its own';
};
const geo = () => page.evaluate(() => { const s = document.querySelector('.bstage').getBoundingClientRect(); return { pageScroll: document.documentElement.scrollHeight - innerHeight, stageBottom: Math.round(s.bottom), vh: innerHeight, stageW: Math.round(s.width), steps: !!document.querySelector('.bsteps'), take: [...document.querySelectorAll('button')].some(b => b.textContent === 'Take over' && !b.hidden) }; });
try {
  await page.evaluate(() => { location.hash = '#/home'; }); await sleep(400);
  const where = await showTab();
  check('Computer tab renders', true, where);
  // a real task, started from the tab's own box
  await page.fill('input[placeholder^="What should it do"]', 'On en.wikipedia.org open the article about the Eiffel Tower and report its height with the URL.');
  await page.fill('input[placeholder^="First page"]', 'https://en.wikipedia.org/wiki/Main_Page');
  await page.click('button:has-text("Start")');
  await page.waitForFunction(() => { const i = document.querySelector('.bstage img'); return i && i.naturalWidth > 0; }, null, { timeout: 60000 });
  const src1 = await page.locator('.bstage img').getAttribute('src'); await sleep(1500); const src2 = await page.locator('.bstage img').getAttribute('src');
  check('the live picture updates while the agent works', src1 !== src2, 'image source changed');
  await page.screenshot({ path: path.join(out, 'computer_1920x1080_light.png') });
  // take over from the screen, click and press a key on the picture, hand back
  await page.click('button:has-text("Take over")');
  await page.waitForFunction(() => [...document.querySelectorAll('.pill')].some(p => p.textContent === 'You are driving'), null, { timeout: 10000 });
  const box = await page.locator('.bstage').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.locator('.bstage').focus(); await page.keyboard.press('PageDown'); await sleep(1200);
  const st = (await t.call('/api/m/browser/operator/status')).json;
  check('Take over from the screen: a click and a key on the picture reach the page', st.mode === 'owner', `mode ${st.mode}`);
  await page.screenshot({ path: path.join(out, 'computer-takeover_1920x1080_light.png') });
  await page.click('button:has-text("Hand back")'); await sleep(600);
  const st2 = (await t.call('/api/m/browser/operator/status')).json;
  check('Hand back from the screen notes what you did', /pressed PageDown/.test(st2.steps.map(s => s.text).join(' ')) && st2.mode !== 'owner', st2.steps.filter(s => s.kind === 'owner').map(s => s.text).join(' | '));
  await page.waitForFunction(() => /What it found/.test(document.body.innerText), null, { timeout: 180000 }).catch(() => {});
  for (const [w, hgt] of [[1920, 1080], [1366, 768]]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: hgt }); await page.evaluate((d) => window.apd.setTheme(d), theme === 'dark'); await sleep(400);
    const g = await geo();
    check(`Computer tab holds at ${w}x${hgt} ${theme}`, g.pageScroll <= 0 && g.stageW > 300 && g.steps, JSON.stringify(g));
    await page.screenshot({ path: path.join(out, `computer_${w}x${hgt}_${theme}.png`) });
  }
  for (const [w, hgt] of [[1920, 1080], [1366, 768]]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: hgt }); await page.evaluate((d) => window.apd.setTheme(d), theme === 'dark');
    await page.evaluate(() => { location.hash = '#/settings/payments'; }); await sleep(900);
    const txt = await page.locator('#view').innerText();
    const g = await page.evaluate(() => ({ pageScroll: document.documentElement.scrollHeight - innerHeight }));
    check(`Payments settings at ${w}x${hgt} ${theme}`, /Spend limits/.test(txt) && /never pays by itself/.test(txt) && !/\$/.test(txt) && g.pageScroll <= 0, `₹ shown: ${/₹/.test(txt)}`);
    await page.screenshot({ path: path.join(out, `settings-payments_${w}x${hgt}_${theme}.png`) });
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('ui check ran to the end', false, e.stack); }
finally { await browser.close(); await t.close(); }
console.log('screenshots:', out);
process.exit(results.every(Boolean) ? 0 : 1);
