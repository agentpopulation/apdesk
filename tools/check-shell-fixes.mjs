// Shell checks in a real browser: a pop-up closes on navigation, the top bar holds with many modules on.
// Run from the repository root, no model keys needed:  node tools/check-shell-fixes.mjs [screenshot dir]
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { testDesk } from '../test/helpers/desk.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'apd-shell-checks'); fs.mkdirSync(SHOTS, { recursive: true });
const ids = fs.readdirSync(new URL('../modules/', import.meta.url)).filter(d => d !== 'looks' && fs.existsSync(new URL(`../modules/${d}/module.json`, import.meta.url)));
const t = await testDesk({ modules: ids });
let fails = 0; const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };
try {
  for (const id of ['mail', 'calendar', 'social', 'code', 'connect', 'life', 'studio', 'network', 'voice']) { try { await t.core.modules.set(id, true); } catch (e) { console.log('could not switch on', id, e.message); } }
  const b = await chromium.launch();
  for (const [w, hgt] of [[1280, 800], [1024, 768], [1920, 1080]]) {
    const p = await b.newPage({ viewport: { width: w, height: hgt } });
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(t.base + '/#/home'); await p.waitForTimeout(1200);
    await p.getByText('Skip, show everything').click().catch(() => {}); await p.waitForTimeout(600);
    const m = await p.evaluate(() => {
      const r = (el) => { const x = el.getBoundingClientRect(); return { l: Math.round(x.left), r: Math.round(x.right), w: Math.round(x.width) }; };
      const name = document.querySelector('.name'), menu = document.getElementById('menu'), panic = document.querySelector('.panic'), bar = document.querySelector('.bar');
      return { name: r(name), nameClipped: name.scrollWidth > name.clientWidth + 1, menu: r(menu), over: menu.classList.contains('over'), items: menu.children.length, panic: r(panic), bar: r(bar), pageScroll: document.documentElement.scrollWidth - window.innerWidth };
    });
    check(`${w}x${hgt}: title whole, menu inside its space, Panic inside the bar, no page scroll`, !m.nameClipped && m.menu.l >= m.name.r && m.menu.r <= m.panic.l && m.panic.r <= m.bar.r && m.pageScroll <= 0, JSON.stringify(m));
    await p.screenshot({ path: `${SHOTS}/topbar_${w}x${hgt}.png` });
    if (w === 1280) {
      await p.evaluate(async () => { const k = await import('/ui/kit.js'); k.modal({ title: 'New chain of agents', body: 'A pop-up left open.', actions: [{ label: 'Close' }] }); });
      const open1 = await p.evaluate(() => !document.getElementById('modal').hidden);
      await p.evaluate(() => { location.hash = '#/chat'; }); await p.waitForTimeout(500);
      const open2 = await p.evaluate(() => !document.getElementById('modal').hidden);
      check('a pop-up left open closes when the owner moves to another page', open1 && !open2, `open before ${open1}, after ${open2}`);
      await p.evaluate(async () => { location.hash = '#/sales'; const k = await import('/ui/kit.js'); k.modal({ title: 'Opened with the move', body: 'x', actions: [{ label: 'Close' }] }); }); await p.waitForTimeout(500);
      check('a pop-up opened together with a move stays open', await p.evaluate(() => !document.getElementById('modal').hidden));
      await p.getByRole('button', { name: 'Close' }).click().catch(() => {});
    }
    check(`${w}x${hgt}: no page errors`, errs.length === 0, errs.join(' | ').slice(0, 200));
    await p.close();
  }
  await b.close();
} finally { await t.close(); }
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
