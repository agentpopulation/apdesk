// Browser check of the Files page: 1920x1080 and 1366x768, white and black themes, full window, no page scroll,
// panes resize, a file previews, Delete -> Bin -> Restore through the buttons.   node modules/files/ui-check.mjs [outDir]
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-files-ui'); fs.mkdirSync(out, { recursive: true });
const results = []; const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${evidence}`); };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-files-home-'));
fs.mkdirSync(path.join(home, 'Downloads')); fs.writeFileSync(path.join(home, 'Downloads', 'invoice-0425.txt'), 'invoice');
process.env.APD_EXPLORER_HOME = home;
// Lowest text contrast inside the Files page (WCAG ratio; each text element against its first opaque background).
const CONTRAST = () => {
  const rgb = (c) => { const m = c.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 1]; return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0.5) return c; } return rgb(getComputedStyle(document.body).backgroundColor); };
  let worst = { ratio: 99 };
  for (const el of document.querySelectorAll('.fx *')) {
    if (!el.offsetParent || el.closest('[hidden]')) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el); const fg = rgb(cs.color); const bg = bgOf(el);
    const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const [l1, l2] = [lum(mix), lum(bg)].sort((a, b) => b - a); const ratio = (l1 + 0.05) / (l2 + 0.05);
    if (ratio < worst.ratio) worst = { ratio: Math.round(ratio * 100) / 100, text: el.textContent.trim().slice(0, 30), cls: el.className?.baseVal ?? el.className };
  }
  return worst;
};
const t = await testDesk({ modules: ['files', 'office'] });
t.core.settings.set('onboarded', true);
const office = t.core.modules.api('office'); const files = t.core.modules.api('files');
await office.makeTable({ title: 'Rack suppliers', columns: ['Supplier', 'Price (INR)', 'Lead time (days)'], rows: [['Meridian', 120000, 14], ['Orbit', 98000, 21]] }, { agentId: 'scout', chatId: 'c1' });
await office.makeDoc({ title: 'Edge data centres report', markdown: '# Edge data centres\n\nSummary with **bold** text.\n\n- one\n- two', format: 'pdf' }, { agentId: 'scout' });
await files.write('drafts/outreach-meridian.md', '# Hello Meridian\n\nA short note about racks.', { agentId: 'closer' });
await files.write('knowledge/company-profile.md', '# Company\n\nWe build racks.', {});
const browser = await chromium.launch();
const errors = [];
try {
  for (const [w, hgt] of [[1920, 1080], [1366, 768]]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: w, height: hgt } });
      page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.addInitScript((th) => { try { localStorage.setItem('apd-theme', th); } catch {} }, theme);
      t.core.settings.set('theme', theme);
      await page.goto(t.base + '/#/files'); await page.waitForSelector('.fx-row', { timeout: 15000 });
      await page.locator('.fx-tree-item', { hasText: 'Home' }).first().click();
      await page.waitForTimeout(300);
      await page.locator('.fx-row[data-name="tables"]').dblclick();
      await page.waitForSelector('.fx-row[data-name="rack-suppliers.xlsx"]');
      await page.locator('.fx-row[data-name="rack-suppliers.xlsx"]').click();
      await page.waitForSelector('.fx-preview-md table', { timeout: 8000 }).catch(() => {});
      const geo = await page.evaluate(() => {
        const pane = document.querySelector('#pane'); const fx = document.querySelector('.fx'); const main = document.querySelector('.fx-main'); const p = document.querySelector('.fx-pane');
        return { docScroll: document.documentElement.scrollHeight - innerHeight, paneScroll: pane.scrollHeight - pane.clientHeight, fxBottomGap: pane.getBoundingClientRect().bottom - fx.getBoundingClientRect().bottom, mainW: Math.round(main.getBoundingClientRect().width), mainH: Math.round(main.getBoundingClientRect().height), paneW: Math.round(p.getBoundingClientRect().width), paneShown: getComputedStyle(p).display !== 'none', bg: getComputedStyle(document.body).backgroundColor };
      });
      check(`${w}x${hgt} ${theme}: full window, no page scroll`, geo.docScroll <= 0 && geo.paneScroll <= 1 && geo.fxBottomGap < 40 && geo.mainH > hgt * 0.5, JSON.stringify(geo));
      const pv = await page.locator('.fx-pane').innerText();
      check(`${w}x${hgt} ${theme}: picking the xlsx shows its table and who made it`, /Meridian/.test(pv) && /Scout/.test(pv), pv.replace(/\s+/g, ' ').slice(0, 120));
      const worst = await page.evaluate(CONTRAST);
      check(`${w}x${hgt} ${theme}: every label at least 4.5:1 (locked folders, selected tree item, buttons)`, worst.ratio >= 4.5, JSON.stringify(worst));
      await page.screenshot({ path: path.join(out, `files_${w}x${hgt}_${theme}.png`) });
      if (w === 1920 && theme === 'light') {
        // panes resize by dragging the splitters
        const before = await page.evaluate(() => document.querySelector('.fx-tree').getBoundingClientRect().width);
        const sp = await page.locator('.fx-split[data-split="tree"]').boundingBox();
        await page.mouse.move(sp.x + sp.width / 2, sp.y + 100); await page.mouse.down(); await page.mouse.move(sp.x + 90, sp.y + 100, { steps: 5 }); await page.mouse.up();
        const after = await page.evaluate(() => document.querySelector('.fx-tree').getBoundingClientRect().width);
        const pBefore = await page.evaluate(() => document.querySelector('.fx-pane').getBoundingClientRect().width);
        const sp2 = await page.locator('.fx-split[data-split="pane"]').boundingBox();
        await page.mouse.move(sp2.x + sp2.width / 2, sp2.y + 100); await page.mouse.down(); await page.mouse.move(sp2.x - 80, sp2.y + 100, { steps: 5 }); await page.mouse.up();
        const pAfter = await page.evaluate(() => document.querySelector('.fx-pane').getBoundingClientRect().width);
        check('panes resize: tree and preview splitters', after > before + 60 && pAfter > pBefore + 50, `tree ${Math.round(before)} -> ${Math.round(after)}, preview ${Math.round(pBefore)} -> ${Math.round(pAfter)}`);
        // Tiles view
        await page.locator('.fx-viewseg button[data-view="tiles"]').click();
        check('Tiles view', await page.locator('.fx-list[data-view="tiles"] .fx-row').count() >= 1, '');
        await page.screenshot({ path: path.join(out, `files-tiles_${w}x${hgt}_${theme}.png`) });
        await page.locator('.fx-viewseg button[data-view="details"]').click();
        // Delete -> Bin -> Restore with the buttons
        await page.locator('.fx-row[data-name="rack-suppliers.xlsx"]').click();
        await page.locator('[data-cmd="delete"]').click();
        await page.locator('.fx-dialog [data-confirm]').click();
        await page.waitForSelector('.fx-row[data-name="rack-suppliers.xlsx"]', { state: 'detached' });
        await page.locator('.fx-tree-item[data-root="bin"]').click();
        await page.waitForSelector('.fx-row[data-name="rack-suppliers.xlsx"]');
        await page.locator('.fx-row[data-name="rack-suppliers.xlsx"]').click();
        await page.locator('[data-cmd="restore"]').click();
        await page.waitForTimeout(500);
        const back = fs.existsSync(path.join(t.dataDir, 'workspace', 'tables', 'rack-suppliers.xlsx'));
        check('Delete moves to the Bin and Restore brings it back (buttons)', back, '');
        // locked folder in the tree
        const locked = await page.locator('.fx-tree-row.is-locked').count();
        check('This PC folders are locked in the tree', locked >= 3, `${locked} locked`);
        // Allow access to Downloads: the owner's click raises the approval, Allow opens it, Close locks it again
        await page.locator('.fx-tree-row.is-locked [data-allow="downloads"]').click();
        await page.locator('.fx-dialog [data-confirm]').click();
        await page.waitForSelector('.fx-row[data-name="invoice-0425.txt"]', { timeout: 8000 }).catch(() => {});
        const opened = await page.locator('.fx-row[data-name="invoice-0425.txt"]').count();
        await page.screenshot({ path: path.join(out, `files-downloads_${w}x${hgt}_${theme}.png`) });
        await page.locator('.fx-tree-row:has([data-root="downloads"]) .is-close').click();
        await page.waitForTimeout(400);
        const relocked = (await t.call('/api/m/files/list?root=downloads')).status;
        check('Allow access opens Downloads after the owner approves; Close locks it again', opened === 1 && relocked === 403, `listed ${opened}, after Close: ${relocked}`);
        // a chat file card's link opens the folder with the file selected
        await page.goto(t.base + '/#/files?path=' + encodeURIComponent('drafts/outreach-meridian.md'));
        await page.waitForSelector('.fx-row[data-name="outreach-meridian.md"][aria-selected="true"]', { timeout: 8000 }).catch(() => {});
        const sel = await page.locator('.fx-row[aria-selected="true"]').getAttribute('data-name').catch(() => null);
        check('#/files?path=... opens the folder and selects the file', sel === 'outreach-meridian.md', String(sel));
        await page.screenshot({ path: path.join(out, `files-md_${w}x${hgt}_${theme}.png`) });
        // a folder path opens the folder (both link forms)
        for (const href of ['#/files?path=tables', '#/files/reports']) {
          await page.goto(t.base + '/' + href); await page.waitForTimeout(900);
          const crumb = await page.locator('.fx-crumb[aria-current]').innerText().catch(() => '');
          const rows = await page.locator('.fx-row').evaluateAll((r) => r.map((x) => x.dataset.name));
          const want = href.includes('tables') ? 'tables' : 'reports';
          check(`${href} opens the folder`, crumb === want && rows.length > 0 && !rows.includes(want), `crumb ${crumb}; items ${rows.join(', ')}`);
        }
      }
      await page.close();
    }
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally { await browser.close(); await t.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log('screenshots:', out);
process.exit(results.every(Boolean) ? 0 : 1);
