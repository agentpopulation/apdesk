// Browser check of the CRM tables at phone width (390x844), white and black themes: Contacts, Companies and the
// Import customers preview show every column without a side scroll. Prints PASS|FAIL lines and writes screenshots.
//   node modules/sales/ui-crm-check.mjs [outDir]
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-sales-crm-ui'); fs.mkdirSync(out, { recursive: true });
const results = []; const check = (n, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${ev}`); };
const t = await testDesk({ modules: ['sales'] });
const co = (await t.call('/api/m/sales/crm/companies', { body: { name: 'Harlow and Penn Industrial Supplies', site: 'https://www.harlow-and-penn.example/' } })).json.company;
await t.call('/api/m/sales/crm/companies', { body: { name: 'Kestrel Labs', site: 'kestrel.example', customer: true } });
await t.call('/api/m/sales/crm/contacts', { body: { name: 'Asha N', email: 'asha.narayanan@harlow-and-penn.example', role: 'Head of purchasing', companyId: co.id } });
await t.call('/api/m/sales/crm/contacts', { body: { name: 'V Rao', companyId: co.id } });
await t.call('/api/settings', { body: { onboarded: true } });
const csvFile = path.join(out, 'customers.csv');
fs.writeFileSync(csvFile, 'Company,Website,Contact,Email\nHarlow and Penn Industrial Supplies,harlow-and-penn.example,Asha N,asha.narayanan@harlow-and-penn.example\nMarlow Automation,marlow.example,,\nBad,,,\n');
const browser = await chromium.launch();
const errors = [];
// every cell of every visible table sits inside the window and its box does not scroll sideways; every column label is on screen
const fits = (sel) => document.querySelectorAll(sel).length > 0 && [...document.querySelectorAll(sel)].every(tb => {
  const box = tb.closest('.scroll') || tb.parentElement;
  const cells = [...tb.querySelectorAll('td')].filter(td => td.offsetParent);
  const heads = [...tb.querySelectorAll('th')].map(x => x.textContent);
  const blank = (lab) => [...tb.querySelectorAll('td')].filter(td => td.dataset.label === lab).every(td => !td.textContent.trim());   // an empty column has nothing to show
  const shown = (lab) => blank(lab) || cells.some(td => td.dataset.label === lab && td.getBoundingClientRect().width > 0) || [...tb.querySelectorAll('th')].some(th => th.textContent === lab && th.offsetParent && th.getBoundingClientRect().right <= innerWidth);
  return box.scrollWidth <= box.clientWidth + 1 && cells.every(td => { const r = td.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5; }) && heads.every(shown) && document.documentElement.scrollWidth <= innerWidth;
});
for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/\/modules\/(agents|chat)\//.test(r.url())) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(t.base + '/#/sales'); await page.waitForSelector('.salesv .seg');
  await page.evaluate((th) => window.apd.setTheme(th === 'dark'), theme); await page.waitForTimeout(200);
  for (const [i, tab] of [[1, 'contacts'], [2, 'companies']]) {
    await page.locator('.salesv > .row .seg').first().locator('button').nth(i).click(); await page.waitForSelector('.crm-pane table'); await page.waitForTimeout(200);
    const ok = await page.evaluate(`(${fits})('.crm-pane table')`);
    const from = await page.evaluate(() => [...document.querySelectorAll('.crm-pane td')].some(td => /typed by you/.test(td.textContent) && td.getBoundingClientRect().right <= innerWidth));
    check(`${tab} 390x844 ${theme}: every column on screen, no side scroll`, ok && from, `from shown: ${from}`);
    await page.screenshot({ path: path.join(out, `${tab}_390x844_${theme}.png`), fullPage: true });
  }
  await page.locator('button', { hasText: 'Import customers' }).click();
  await page.locator('#modal input[type=file]').setInputFiles(csvFile); await page.waitForSelector('#modal table'); await page.waitForTimeout(200);
  const ok = await page.evaluate(`(${fits})('#modal table')`);
  const what = await page.evaluate(() => [...document.querySelectorAll('#modal td')].filter(td => /New customer|Merged with|Skipped/.test(td.textContent)).every(td => td.getBoundingClientRect().right <= innerWidth));
  const line = await page.locator('#modal p.sub').first().textContent();
  check(`import preview 390x844 ${theme}: What happens is on screen for every row`, ok && what, line);
  check(`import preview ${theme}: a bare name is skipped, not counted as saved`, /3 rows: 1 new, 1 merged, 0 already there, 1 skipped/.test(line), line);
  await page.screenshot({ path: path.join(out, `import-preview_390x844_${theme}.png`), fullPage: true });
  await page.close();
}
// the wide layout keeps the plain table
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.goto(t.base + '/#/sales'); await page.waitForSelector('.salesv .seg');
await page.locator('.salesv > .row .seg').first().locator('button').nth(1).click(); await page.waitForSelector('.crm-pane table');
check('contacts 1366x768: the column heads show as a normal table', await page.evaluate(() => getComputedStyle(document.querySelector('.crm-pane thead')).display !== 'none'), '');
await page.screenshot({ path: path.join(out, 'contacts_1366x768_light.png') });
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close(); await t.close();
console.log(`${results.filter(Boolean).length} of ${results.length} passed. Screenshots: ${out}`);
process.exit(results.every(Boolean) ? 0 : 1);
