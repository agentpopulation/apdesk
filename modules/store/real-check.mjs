// Real check for the Module Store, ask 14 (Mail on: it appears; off: it goes), and the layout of every Settings section
// the store, safety, vault, accounts and backup modules add (Security, Modules, Keys and logins, Accounts and lock, Backup) at 1920x1080 and 1366x768 in both themes.
//   node modules/store/real-check.mjs [screenshot folder]
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { testDesk } from '../../test/helpers/desk.js';

const MODS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-store-shots'); fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(evidence).replace(/\s+/g, ' ').slice(0, 300)}`); };
const mine = ['store', 'safety', 'backup', 'vault', 'accounts'];
const withMail = fs.existsSync(path.join(MODS, 'mail', 'module.json'));
const t = await testDesk({ real: true, modules: [...mine, ...(withMail ? ['mail'] : [])] });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
try {
  await t.call('/api/settings', { body: { onboarded: true } });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/settings/modules');
  await page.waitForSelector('[data-group="core"]', { timeout: 15000 });
  const cards = await page.locator('[data-card]').count();
  const groups = await page.locator('[data-group] h3').allTextContents();
  check('the Store shows 30 cards in three groups', cards === 30 && groups.join('|') === 'On from the first run (16)|Switch on when you want them (13)|Parked (1)', `${cards} cards · ${groups.join(' · ')}`);
  const vaultCard = (await page.locator('[data-card="vault"]').innerText()).replace(/\s+/g, ' ');
  check('a card says what it does, what it adds and its status', /Keys and logins/.test(vaultCard) && /Off/.test(vaultCard) && /Works|Partly|Placeholder/.test(vaultCard), vaultCard.slice(0, 200));
  const coreSw = await page.locator('[data-card="backup"] .sw').count();
  check('core modules show "Core" and have no switch', coreSw === 0 && /Core/.test(await page.locator('[data-card="backup"]').innerText()), 'Backup card');
  // ask 14
  if (withMail) {
    const menu = () => page.locator('#menu .nav').allTextContents();
    const before = await menu();
    await page.click('[data-module="mail"]');
    await page.waitForFunction(() => [...document.querySelectorAll('#menu .nav')].some(b => b.textContent === 'Mail'), null, { timeout: 10000 }).catch(() => {});
    const onMenu = await menu();
    const onRoute = (await t.call('/api/m/mail/state')).status;
    await page.waitForSelector('[data-module="mail"]', { timeout: 10000 });
    await page.click('[data-module="mail"]');
    await page.waitForFunction(() => ![...document.querySelectorAll('#menu .nav')].some(b => b.textContent === 'Mail'), null, { timeout: 10000 }).catch(() => {});
    const offMenu = await menu();
    check('ask 14: switch Mail on in the Store: it appears; off: it goes', !before.includes('Mail') && onMenu.includes('Mail') && !offMenu.includes('Mail'), `before: ${before.length} places · on: ${onMenu.join(', ')} (Mail route ${onRoute}) · off: ${offMenu.length} places`);
  } else check('ask 14: Mail on and off', false, 'not checked: the Mail module is not in this build');
  // layout of every section at two sizes and both themes
  await t.call('/api/modules/vault/on', { method: 'POST' }); await t.call('/api/modules/accounts/on', { method: 'POST' });
  const sections = ['security', 'modules', 'keys', 'accounts', 'backup'];
  const bad = [];
  for (const [w, hgt] of [[1920, 1080], [1366, 768]]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: hgt });
    await page.evaluate((th) => window.apd.setTheme(th === 'dark'), theme);
    for (const s of sections) {
      await page.evaluate((x) => { location.hash = '#/settings/' + x; }, s);
      await page.waitForTimeout(900);
      const g = await page.evaluate(() => {
        const pane = document.getElementById('pane'); const view = document.getElementById('view');
        const stretched = [...view.querySelectorAll('button:not(.level), input:not([type=checkbox]), select')].filter(e => e.offsetParent && e.getBoundingClientRect().width > 520).map(e => (e.textContent || e.placeholder || e.tagName).trim().slice(0, 30));
        const wide = [...view.querySelectorAll('*')].filter(e => e.offsetParent && e.getBoundingClientRect().right > pane.getBoundingClientRect().right + 1).length;
        return { pageScroll: document.documentElement.scrollHeight - innerHeight, hScroll: view.scrollWidth - view.clientWidth, stretched, wide, body: getComputedStyle(document.body).backgroundColor };
      });
      const file = `settings-${s}_${w}x${hgt}_${theme}.png`;
      await page.screenshot({ path: path.join(out, file) });
      if (g.pageScroll > 0 || g.hScroll > 1 || g.stretched.length || g.wide) bad.push(`${file}: ${JSON.stringify(g)}`);
    }
  }
  check('Settings sections hold at 1920x1080 and 1366x768 in both themes (no page scroll, nothing stretched or overflowing)', bad.length === 0, bad.length ? bad.slice(0, 3).join(' | ') : `20 screenshots in ${out}`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('store real check ran', false, e.stack); }
finally { await browser.close(); await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
