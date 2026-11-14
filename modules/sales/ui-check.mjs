// Browser check of the Sales, Mail and Calendar pages: 1920x1080 and 1366x768, white and black themes. No model needed:
// the data is added through the routes. Prints PASS|FAIL lines and writes screenshots.  node modules/sales/ui-check.mjs [outDir]
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-sales-ui'); fs.mkdirSync(out, { recursive: true });
const results = []; const check = (n, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${ev}`); };
const t = await testDesk({ modules: ['sales', 'mail', 'calendar'] });
const names = ['Northgate Logistics', 'Kaveri Foods', 'Sahyadri Pharma', 'Coastal Cold Chain', 'Meridian Textiles', 'Orbit Components', 'Deccan Motors', 'Harlow & Penn', 'Orion Drives India', 'Kestrel Ltd', 'Marlow Automation India', 'Tarang Electric India', 'Vellore Controls', 'Sahyog Robotics', 'Nilgiri Automation', 'Konkan Hydraulics', 'Ridgeway Automation', 'Pallava Valves'];
for (const [i, c] of names.entries()) {
  const r = await t.call('/api/m/sales/leads', { body: { company: c, contactName: i % 3 ? '' : 'R. Menon', contactRole: i % 3 ? '' : 'Operations head', valueMinor: i % 4 ? (i + 3) * 120000 : null, need: 'Warehouse automation', sources: [{ title: 'Top automation companies', url: 'https://example.com/list' }], findings: 'The page lists them among industrial automation makers.', unchecked: i % 4 === 3 ? ['Country: not checked'] : [] } });
  if (i % 4 === 1) await t.call(`/api/m/sales/leads/${r.json.lead.id}/move`, { body: { stage: 'Researched' } });
  if (i % 4 === 2) await t.call(`/api/m/sales/leads/${r.json.lead.id}/move`, { body: { stage: 'In talks' } });
}
await t.call('/api/modules/mail/on', { method: 'POST' }); await t.call('/api/modules/calendar/on', { method: 'POST' });
await t.call('/api/m/calendar/events', { body: { title: 'Call with Deccan Motors', start: new Date().toISOString().slice(0, 10) + 'T10:00', end: new Date().toISOString().slice(0, 10) + 'T10:30' } });
await t.call('/api/settings', { body: { onboarded: true } });
const browser = await chromium.launch();
const errors = [];
for (const [w, hgt] of [[1920, 1080], [1366, 768]]) for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: w, height: hgt } });
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(t.base + '/#/sales'); await page.waitForSelector('.lane .lead', { timeout: 15000 });
  await page.evaluate((th) => window.apd.setTheme(th === 'dark'), theme); await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const v = document.querySelector('.view'); const b = document.querySelector('.board'); const lanes = [...document.querySelectorAll('.lane .cards')];
    const det = document.querySelector('.s-det').getBoundingClientRect(); const pane = document.querySelector('#pane').getBoundingClientRect();
    return { pageScroll: document.documentElement.scrollHeight - innerHeight, viewScroll: v.scrollHeight - v.clientHeight, laneScrolls: lanes.some(l => l.scrollHeight > l.clientHeight + 2), laneCanScroll: lanes.map(l => getComputedStyle(l).overflowY), boardBottom: Math.round(b.getBoundingClientRect().bottom), paneBottom: Math.round(pane.bottom), detRight: Math.round(pane.right - det.right), paneW: Math.round(pane.width), vw: innerWidth, title: document.querySelector('.view h2').textContent, tiles: [...document.querySelectorAll('.tiles .stat')].map(x => x.innerText.replace(/\n/g, ' ')) };
  });
  check(`Sales ${w}x${hgt} ${theme}: full window, no page scroll, board scrolls inside its lanes`, g.pageScroll <= 0 && g.viewScroll <= 1 && g.boardBottom <= g.paneBottom && g.laneCanScroll.every(x => x === 'auto') && g.paneW > g.vw - 40, JSON.stringify({ pageScroll: g.pageScroll, viewScroll: g.viewScroll, laneOverflowing: g.laneScrolls, boardBottom: g.boardBottom, paneBottom: g.paneBottom }));
  await page.screenshot({ path: path.join(out, `sales_${w}x${hgt}_${theme}.png`) });
  if (w === 1920 && theme === 'light') {
    check('the New lane shows checked leads first, then the labelled not-checked group', await page.evaluate(() => { const lane = document.querySelector('.lane .cards'); const kids = [...lane.children]; const g = kids.findIndex(x => x.classList.contains('grp')); return g > 0 && kids.slice(g + 1).every(x => /Country: not checked/.test(x.textContent)) && kids.slice(0, g).every(x => !/not checked/.test(x.querySelectorAll('.sub')[2]?.textContent || '')); }), '');
    check('title, tiles', g.title === 'Sales' && g.tiles.length === 4, g.tiles.join(' | '));
    // drag a card from New to In talks
    const first = page.locator('.lane[data-stage="new"] .lead').first(); const name = (await first.locator('b').first().textContent());
    await first.dragTo(page.locator('.lane[data-stage="talks"]'));
    await page.waitForTimeout(700);
    const moved = await page.locator('.lane[data-stage="talks"] .lead b', { hasText: name }).count();
    check('drag and drop moves a lead across the board', moved === 1, `${name} -> In talks`);
    await page.locator('.lane .lead').first().click(); await page.waitForTimeout(300);
    await page.locator('.s-det select').selectOption('drafted'); await page.waitForTimeout(700);
    check('the Move control moves the picked lead', (await page.locator('.s-det .pill').first().textContent()).includes('Drafted'), await page.locator('.s-det h3').textContent());
    for (const [i, n] of [[1, 'leads'], [2, 'outreach']]) { await page.locator('.seg button').nth(i).click(); await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `sales_${n}_${w}x${hgt}_${theme}.png`) }); }
    await page.locator('.seg button').nth(0).click();
    const menu = await page.locator('#menu .nav').allTextContents();
    check('Mail and Calendar have menu places while on', menu.includes('Mail') && menu.includes('Calendar'), menu.join(', '));
  }
  for (const pg of ['mail', 'calendar']) {
    await page.evaluate((p) => { location.hash = '#/' + p; }, pg); await page.waitForTimeout(500);
    const s = await page.evaluate(() => ({ pageScroll: document.documentElement.scrollHeight - innerHeight, h2: document.querySelector('.view h2')?.textContent, off: !!document.querySelector('.offnote') }));
    check(`${pg} ${w}x${hgt} ${theme}: renders, no page scroll`, s.pageScroll <= 0 && s.h2 && !s.off, JSON.stringify(s));
    await page.screenshot({ path: path.join(out, `${pg}_${w}x${hgt}_${theme}.png`) });
  }
  await page.close();
}
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(t.base + '/#/settings/mail'); await page.waitForTimeout(800);
check('Settings › Mail accounts section renders', await page.locator('text=Add an account').count() > 0, '');
await page.screenshot({ path: path.join(out, 'settings_mail_1920x1080.png') });
await page.evaluate(() => { location.hash = '#/calendar'; }); await page.waitForTimeout(400);
for (const [i, n] of [[1, 'week'], [2, 'day'], [3, 'list']]) { await page.locator('.seg button').nth(i).click(); await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, `calendar_${n}_1920x1080.png`) }); }
check('Calendar day view shows the event', await page.locator('.seg button').nth(0).click().then(() => page.locator('.ev', { hasText: 'Deccan' }).count()) > 0, '');
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close(); await t.close();
console.log('screenshots:', out);
process.exit(results.every(Boolean) ? 0 : 1);
