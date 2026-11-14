// Smoke check: start the whole desk, say which modules load, open every place in a real browser in both
// themes at two sizes, and report page errors and layout breaks. No model calls. Usage: node tools/smoke.mjs [shots dir] [--quick]
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createDesk } from '../app/server.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2); const quick = args.includes('--quick'); const shots = args.find(a => !a.startsWith('--')) || path.join(os.tmpdir(), 'apd-smoke');
fs.mkdirSync(shots, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-smoke-'));
const desk = await createDesk({ dataDir, port: 0, quiet: true }); await desk.start();
desk.core.settings.set('onboarded', true);
const mods = desk.modules.list();
console.log(`modules: ${mods.filter(m => m.on).length} on, ${mods.filter(m => m.error).length} failed, ${mods.length} found`);
for (const m of mods.filter(m => m.error)) console.log(`  FAILED TO START  ${m.id}: ${m.error}`);
const missing = ['chat', 'models', 'search', 'research', 'browser', 'files', 'office', 'agents', 'memory', 'council', 'tasks', 'flows', 'sales', 'safety', 'backup', 'store'].filter(id => !mods.some(m => m.id === id && m.on));
if (missing.length) console.log('  core modules not on: ' + missing.join(', '));
// switch-on modules: on, then off again at the end
const switchOn = mods.filter(m => m.kind === 'switch-on');
const onOff = [];
for (const m of switchOn) { try { await desk.modules.set(m.id, true); onOff.push([m.id, 'on']); } catch (e) { onOff.push([m.id, 'FAILED on: ' + e.message]); } }
const browser = await chromium.launch();
let bad = 0;
const pages = ['home', 'chat', 'research', 'tasks', 'sales', 'files', 'agents', 'models', 'settings'];
const all = desk.modules.list();
for (const m of all) if (m.on) for (const it of m.menu || []) if (!pages.includes(it.id)) pages.push(it.id);
const settingsIds = ['general', 'appearance', 'security', 'modules', 'accounts', 'keys', 'channels', 'payments', 'network', 'memory', 'backup'];
for (const m of all) if (m.on) for (const s of m.settings || []) if (!settingsIds.includes(s.id)) settingsIds.push(s.id);
const targets = [...pages, ...settingsIds.map(s => 'settings/' + s)];
for (const [w, hgt] of quick ? [[1920, 1080]] : [[1920, 1080], [1366, 768]]) for (const theme of quick ? ['light'] : ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt } });
  const page = await ctx.newPage();
  let errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_ABORTED/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript((t) => { try { localStorage.setItem('apd-theme', t); } catch {} }, theme);
  desk.core.settings.set('theme', theme);
  await page.goto(desk.url() + '/#/home'); await page.waitForSelector('#menu .nav', { timeout: 15000 });
  for (const t of targets) {
    errors = [];
    await page.evaluate((x) => { location.hash = '#/' + x; }, t); await page.waitForTimeout(quick ? 500 : 900);
    const g = await page.evaluate(() => { const v = document.querySelector('#view'), p = document.querySelector('#pane').getBoundingClientRect(); const off = v.querySelector('.offnote'); let wide = 0; for (const el of v.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > innerWidth + 2) wide++; } return { docScroll: Math.max(document.documentElement.scrollHeight - innerHeight, document.documentElement.scrollWidth - innerWidth), paneGap: Math.round(innerHeight - p.bottom), off: off ? off.textContent.slice(0, 90) : null, empty: v.children.length === 0, wide, panic: !!document.querySelector('#panic') && document.querySelector('#panic').getBoundingClientRect().right <= innerWidth }; });
    const problems = [];
    if (errors.length) problems.push('errors: ' + [...new Set(errors)].slice(0, 2).join(' | ').slice(0, 220));
    if (g.docScroll > 1) problems.push(`page scrolls by ${g.docScroll}px`);
    if (g.paneGap > 20 || g.paneGap < 0) problems.push(`pane does not fill (gap ${g.paneGap})`);
    if (g.off) problems.push('off note: ' + g.off);
    if (g.empty) problems.push('empty view');
    if (g.wide) problems.push(`${g.wide} elements wider than the window`);
    if (!g.panic) problems.push('Panic not reachable');
    await page.screenshot({ path: path.join(shots, `${t.replace('/', '-')}_${w}x${hgt}_${theme}.png`) });
    if (problems.length) { bad++; console.log(`  PROBLEM  ${t.padEnd(22)} ${w}x${hgt} ${theme}: ${problems.join('; ')}`); }
  }
  await ctx.close();
}
await browser.close();
for (const m of switchOn) { try { await desk.modules.set(m.id, false); } catch (e) { onOff.push([m.id, 'FAILED off: ' + e.message]); } }
const failedSwitch = onOff.filter(x => x[1] !== 'on');
for (const f of failedSwitch) console.log(`  SWITCH  ${f[0]}: ${f[1]}`);
console.log(`pages checked: ${targets.length} places, ${bad} with problems; switch-on modules: ${switchOn.length - failedSwitch.length} of ${switchOn.length} switch on and off; screenshots: ${shots}`);
await desk.stop(); fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(bad || failedSwitch.length || mods.some(m => m.error) ? 1 : 0);
