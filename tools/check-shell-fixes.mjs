// Shell checks in a real browser: a pop-up closes on navigation, the top bar holds with many modules on (with the
// theme, network and download icons), downloads and network in the bar, Settings › Modules keeps its place, the
// first-start local model offer, the code for another browser, the installed app, and slow Chat routes.
// Run from the repository root, no model keys needed:  node tools/check-shell-fixes.mjs [screenshot dir]
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { testDesk } from '../test/helpers/desk.js';
import { startDownloadHost, sha } from '../test/helpers/download-host.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'apd-shell-checks'); fs.mkdirSync(SHOTS, { recursive: true });
const ids = fs.readdirSync(new URL('../modules/', import.meta.url)).filter(d => d !== 'looks' && fs.existsSync(new URL(`../modules/${d}/module.json`, import.meta.url)));
let fails = 0; const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await wait(100); } };
const t = await testDesk({ modules: ids });
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
  await barChecks(b); await downloadChecks(b); await networkChecks(b); await moduleChecks(b); await settingsChecks(b);
  await b.close();
} finally { await t.close(); }
await firstStartChecks(); await pairChecks();
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);

async function open(b, w, hgt, theme = 'light', hash = '#/home', ctxOpts = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: hgt }, ...ctxOpts }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript((th) => { try { localStorage.setItem('apd-theme', th); } catch {} }, theme);
  t.core.settings.set('theme', theme); t.core.settings.set('onboarded', true);
  await p.goto(t.base + '/' + hash); await p.waitForSelector('#menu .nav'); await p.waitForTimeout(700);
  return { ctx, p, errs };
}
function barGeometry(p) { return p.evaluate(() => {
  const r = (el) => { const x = el.getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom }; };
  const bar = r(document.querySelector('.bar')), menu = document.getElementById('menu');
  const ctl = [...document.querySelectorAll('.bar>div:last-child>*')].filter(e => e.offsetWidth).map(e => ({ id: e.id, ...r(e) }));
  const panic = r(document.getElementById('panic'));
  const overlap = (a, c) => a.l < c.r - 0.5 && c.l < a.r - 0.5 && a.t < c.b - 0.5 && c.t < a.b - 0.5;
  const m = r(menu), left = r(document.querySelector('.bar>div:first-child'));
  const clash = [...ctl.map(c => overlap(m, c) ? 'menu/' + c.id : null), ...ctl.map(c => overlap(left, c) ? 'title/' + c.id : null), ...ctl.flatMap((a, i) => ctl.slice(i + 1).map(c => overlap(a, c) ? a.id + '/' + c.id : null))].filter(Boolean);
  const cut = ctl.filter(c => c.l < bar.l || c.r > bar.r || c.t < bar.t || c.b > bar.b).map(c => c.id);
  const textCut = ctl.filter(c => { const el = document.getElementById(c.id); return el.scrollWidth > el.clientWidth + 1; }).map(c => c.id);
  return { items: menu.children.length, over: menu.classList.contains('over'), fades: [menu.classList.contains('fl'), menu.classList.contains('fr')], menuInBar: m.l >= bar.l && m.r <= bar.r && m.b <= bar.b, clash, cut, textCut, panicWhole: panic.l >= 0 && panic.r <= innerWidth && panic.t >= 0 && panic.b <= innerHeight, ctl: ctl.map(c => c.id), pageScroll: document.documentElement.scrollWidth - innerWidth };
}); }

// ---- 1, 8: the theme is an icon; the top bar holds with every menu place on, the download icon shown too, at three sizes
async function barChecks(b) {
  const body = Buffer.alloc(64 * 1024, 7); const host = await startDownloadHost({ '/one': { body, slowMs: 400, chunk: 1024 } });
  const d = await t.core.downloads.start({ title: 'Bar check file', url: host.url('/one'), allowHosts: ['127.0.0.1'], size: body.length, sha256: sha(body), to: path.join(t.dataDir, 'dl', 'bar.bin'), kind: 'check' });
  try {
    for (const [w, hgt] of [[1366, 768], [1920, 1080], [390, 844]]) for (const theme of ['light', 'dark']) {
      const { ctx, p, errs } = await open(b, w, hgt, theme);
      const th = await p.evaluate(() => { const e = document.getElementById('theme'); return { text: e.textContent.trim(), svg: !!e.querySelector('svg'), name: e.getAttribute('aria-label'), icon: e.dataset.icon, opacity: getComputedStyle(e).opacity }; });
      const wantName = theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
      check(`${w}x${hgt} ${theme}: the theme control is a dull icon with no words, named for what it does`, th.text === '' && th.svg && th.name === wantName && th.icon === (theme === 'dark' ? 'sun' : 'moon') && Math.abs(Number(th.opacity) - 0.6) < 0.05, JSON.stringify(th));
      const g = await barGeometry(p);
      check(`${w}x${hgt} ${theme}: ${g.items} menu places, the download, network and theme icons and Panic: nothing cut, nothing covered`, g.items >= 14 && g.ctl.includes('dl') && g.ctl.includes('net') && g.ctl.includes('theme') && !g.clash.length && !g.cut.length && !g.textCut.length && g.panicWhole && g.menuInBar && g.pageScroll <= 0, JSON.stringify(g));
      if (g.over) check(`${w}x${hgt} ${theme}: the menu fades and scrolls where places are hidden`, g.fades[1] === true && g.fades[0] === false, JSON.stringify(g.fades));
      if (g.over) { await p.evaluate(() => { const m = document.getElementById('menu'); m.scrollLeft = m.scrollWidth; }); await p.waitForTimeout(150); const f = await p.evaluate(() => [...document.getElementById('menu').classList]); check(`${w}x${hgt} ${theme}: scrolled to the end, only the start fades`, f.includes('fl') && !f.includes('fr'), f.join(' ')); await p.evaluate(() => { document.getElementById('menu').scrollLeft = 0; }); }
      await p.screenshot({ path: `${SHOTS}/topbar_${w}x${hgt}_${theme}.png` });
      if (w === 1366 && theme === 'light') {
        await p.hover('#theme'); await p.waitForTimeout(250);
        check('the theme icon rises to full on hover', await p.evaluate(() => getComputedStyle(document.getElementById('theme')).opacity) === '1');
        await p.click('#theme'); await p.waitForTimeout(300);
        const after = await p.evaluate(() => ({ theme: document.documentElement.dataset.theme, name: document.getElementById('theme').getAttribute('aria-label') }));
        check('a press switches the theme and the icon then offers the way back', after.theme === 'dark' && after.name === 'Switch to the light theme', JSON.stringify(after));
        await p.evaluate(() => { location.hash = '#/settings/appearance'; }); await p.waitForTimeout(600);
        check('Settings › Appearance keeps the choice in words', await p.evaluate(() => /White/.test(document.querySelector('.seg')?.textContent || '') && /Black/.test(document.querySelector('.seg')?.textContent || '')));
      }
      check(`${w}x${hgt} ${theme}: no page errors`, errs.length === 0, errs.join(' | ').slice(0, 200));
      await ctx.close();
    }
  } finally { try { t.core.downloads.cancel(d.id); } catch {} for (const x of t.core.approval.listPending()) t.core.approval.decide(x.id, 'deny'); await host.close(); }
}

// ---- 2: downloads in the top bar, live from the event stream
async function downloadChecks(b) {
  const body = Buffer.alloc(96 * 1024, 3); const host = await startDownloadHost({ '/slow': { body, slowMs: 120, chunk: 2048 } });
  const { ctx, p, errs } = await open(b, 1366, 768, 'light');
  let lists = 0; p.on('request', r => { if (new URL(r.url()).pathname === '/api/downloads') lists++; });
  try {
    check('no downloads: no download icon', await p.evaluate(() => document.getElementById('dl').hidden));
    const d = await t.core.downloads.start({ title: 'Engine for the check', url: host.url('/slow'), allowHosts: ['127.0.0.1'], size: body.length, sha256: sha(body), to: path.join(t.dataDir, 'dl', 'slow.bin'), kind: 'check' });
    await until(() => p.evaluate(() => !document.getElementById('dl').hidden));
    const shown = await p.evaluate(() => ({ text: document.getElementById('dl').textContent, name: document.getElementById('dl').getAttribute('aria-label') }));
    check('a download waiting for approval shows the icon with a count', shown.text === '0 of 1' && /Downloads: 0 of 1/.test(shown.name), JSON.stringify(shown));
    await p.click('#dl'); await p.waitForTimeout(300);
    check('the list says it waits for the owner, with Review, Pause and Cancel', await p.evaluate(() => { const r = document.querySelector('#pop [data-dl]'); return !!r && /Waiting for you to approve/.test(r.textContent) && /Engine for the check/.test(r.textContent) && [...r.querySelectorAll('button')].map(x => x.textContent).join(',') === 'Review,Pause,Cancel'; }));
    const ap = t.core.approval.listPending().find(x => x.action === 'install' && /Engine for the check/.test(x.title)); t.core.approval.decide(ap.id, 'approve');
    await until(() => p.evaluate(() => /Downloading/.test(document.querySelector('#pop [data-dl]')?.textContent || '')));
    await p.waitForTimeout(1500);
    const run = await p.evaluate(() => { const r = document.querySelector('#pop [data-dl]'); return { text: r.textContent, meter: !!r.querySelector('.meter b'), width: r.querySelector('.meter b')?.style.width, icon: document.getElementById('dl').textContent }; });
    check('downloading: progress bar, done and total size, speed, time left, and the count', run.meter && /KB of 96\.0 KB/.test(run.text) && /\/s/.test(run.text) && /left/.test(run.text) && run.icon === '1 of 1', JSON.stringify(run));
    await p.screenshot({ path: `${SHOTS}/downloads_1366x768_light.png` });
    const before = lists;
    await p.waitForTimeout(2000);
    const w1 = await p.evaluate(() => document.querySelector('#pop [data-dl] .meter b')?.style.width);
    check('live updates come from the event stream, not polling', lists === before && w1 !== run.width, `list reads during 2 s: ${lists - before}; bar ${run.width} -> ${w1}`);
    await p.click('#pop [data-dl] button:has-text("Pause")');
    await until(() => p.evaluate(() => /Paused/.test(document.querySelector('#pop [data-dl]')?.textContent || '')));
    check('Pause works and the row says Paused with Resume', await p.evaluate(() => [...document.querySelectorAll('#pop [data-dl] button')].some(x => x.textContent === 'Resume')));
    t.core.panic.resume?.();
    await p.click('#pop [data-dl] button:has-text("Resume")');
    await until(() => t.core.downloads.get(d.id)?.state === 'done', 30000);
    await until(() => p.evaluate(() => document.getElementById('dl').hidden), 5000);
    await p.waitForTimeout(400);
    const end = await p.evaluate(() => ({ hidden: document.getElementById('dl').hidden, notices: [...document.querySelectorAll('.toast')].filter(x => /Downloaded: Engine for the check/.test(x.textContent)).length, row: document.querySelector('#pop [data-dl]')?.textContent || '' }));
    check('finished: the icon goes, one notice says so, the list shows it done', end.hidden && end.notices === 1 && /Done/.test(end.row), JSON.stringify(end));
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    check('Escape closes the list', await p.evaluate(() => document.getElementById('pop').hidden));
    check('downloads: no page errors', errs.length === 0, errs.join(' | ').slice(0, 200));
  } finally { await ctx.close(); await host.close(); }
}

// ---- 3: the network icon
async function networkChecks(b) {
  const { ctx, p, errs } = await open(b, 1366, 768, 'light');
  try {
    const st = () => p.evaluate(() => { const n = document.getElementById('net'); return { state: n.dataset.state, name: n.getAttribute('aria-label'), color: getComputedStyle(n).color }; });
    const up = await st();
    check('online: a green network icon whose name says Online', up.state === 'up' && /Network: Online/.test(up.name), JSON.stringify(up));
    await p.click('#net'); await p.waitForTimeout(500);
    const pop = await p.evaluate(() => ({ text: document.getElementById('pop').textContent, buttons: [...document.querySelectorAll('#pop button')].map(x => x.textContent) }));
    check('the popover says the state in words and has Open Network', /Online\. This PC is online/.test(pop.text) && pop.buttons.includes('Open Network'), JSON.stringify(pop));
    await p.screenshot({ path: `${SHOTS}/network_online_1366x768_light.png` });
    await p.mouse.click(600, 500); await p.waitForTimeout(200);
    check('a press elsewhere closes it', await p.evaluate(() => document.getElementById('pop').hidden));
    await ctx.setOffline(true); await p.waitForTimeout(300);
    const down = await st();
    check('no internet: red, and the name says No internet', down.state === 'down' && /No internet/.test(down.name) && down.color !== up.color, JSON.stringify(down));
    await p.screenshot({ path: `${SHOTS}/network_down_1366x768_light.png` });
    await ctx.setOffline(false);
    await p.evaluate(() => window.apd.setOnline(false)); await p.waitForTimeout(400);
    const off = await st();
    check('Offline by choice: grey, named so', off.state === 'off' && /Offline by your choice/.test(off.name), JSON.stringify(off));
    await p.evaluate(() => window.apd.setOnline(true)); await p.waitForTimeout(300);
    // the Network module off: the popover offers to switch it on, at its card in Settings › Modules
    await t.core.modules.set('network', false); await p.waitForTimeout(1200);
    await p.click('#net'); await p.waitForTimeout(400);
    const offPop = await p.evaluate(() => [...document.querySelectorAll('#pop button')].map(x => x.textContent));
    check('Network module off: the popover has Switch on Network', offPop.includes('Switch on Network'), offPop.join(','));
    await p.click('#pop button:has-text("Switch on Network")'); await p.waitForTimeout(1200);
    const at = await p.evaluate(() => { const c = document.querySelector('[data-card="network"]'); const r = c?.getBoundingClientRect(); return { hash: location.hash, focus: document.activeElement?.getAttribute('data-module'), inView: !!r && r.top >= 0 && r.bottom <= innerHeight }; });
    check('it opens Settings › Modules at the Network card, its switch focused', /settings\/modules/.test(at.hash) && at.focus === 'network' && at.inView, JSON.stringify(at));
    await p.screenshot({ path: `${SHOTS}/network_switch_on_1366x768_light.png` });
    await t.core.modules.set('network', true); await p.waitForTimeout(800);
    // with the module on, its summary adds latency and watched sites down; a 404 is coped with
    await p.route('**/api/m/network/summary', r => r.fulfill({ json: { online: true, viaLastCheckAt: new Date().toISOString(), latencyMs: 23, down: 2, note: 'Online.' } }));
    await p.click('#net'); await p.waitForTimeout(500);
    const withMod = await p.evaluate(() => document.getElementById('pop').textContent);
    check('with the module: latency and the number of watched sites down', /23 ms/.test(withMod) && /Watched sites down\s*2/.test(withMod), withMod.slice(0, 200));
    await p.screenshot({ path: `${SHOTS}/network_module_1366x768_light.png` });
    await p.unroute('**/api/m/network/summary'); await p.route('**/api/m/network/summary', r => r.fulfill({ status: 404, json: { error: 'off' } }));
    await p.evaluate(() => window.apd.refresh()); await p.click('#net'); await p.click('#net'); await p.waitForTimeout(500);
    check('a 404 from the module leaves the icon working', await p.evaluate(() => document.getElementById('net').dataset.state === 'up' && !document.getElementById('pop').hidden));
    check('network: no page errors', errs.length === 0, errs.join(' | ').slice(0, 200));
  } finally { await ctx.close(); }
}

// ---- 4: switching a module on in Settings › Modules keeps the place, the focus and adds the menu place without a reload
async function moduleChecks(b) {
  await t.core.modules.set('studio', false);
  const { ctx, p, errs } = await open(b, 1366, 768, 'light', '#/settings/modules');
  try {
    await p.evaluate(() => { window.__noReload = true; });
    const last = await p.evaluate(() => { const s = [...document.querySelectorAll('#view [data-module]')]; return s[s.length - 1].getAttribute('data-module'); });
    const sw = p.locator(`#view [data-module="${last}"]`);
    await sw.scrollIntoViewIfNeeded(); 
    const before = await p.evaluate((id) => ({ top: (document.getElementById('view').scrollTop + document.getElementById('pane').scrollTop), on: document.querySelector(`[data-module="${id}"]`).getAttribute('aria-pressed'), menu: document.getElementById('menu').children.length }), last);
    await sw.focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(2500);
    const after = await p.evaluate((id) => ({ top: (document.getElementById('view').scrollTop + document.getElementById('pane').scrollTop), on: document.querySelector(`[data-module="${id}"]`)?.getAttribute('aria-pressed'), focus: document.activeElement?.getAttribute('data-module'), menu: document.getElementById('menu').children.length, same: window.__noReload === true }), last);
    check(`switching on the last module (${last}) at 1366x768 keeps the scroll offset, the focus, no reload`, before.top > 100 && Math.abs(after.top - before.top) < 2 && after.focus === last && after.same && after.on !== before.on, JSON.stringify({ before, after }));
    await p.screenshot({ path: `${SHOTS}/modules_switched_1366x768_light.png` });
    await sw.focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(2000);
    const back = await p.evaluate((id) => ({ top: (document.getElementById('view').scrollTop + document.getElementById('pane').scrollTop), focus: document.activeElement?.getAttribute('data-module'), same: window.__noReload === true }), last);
    check('switching it off again: same place, same focus', Math.abs(back.top - before.top) < 2 && back.focus === last && back.same, JSON.stringify(back));
    // a module with a menu place: the place appears and goes without a reload
    await p.evaluate(() => { location.hash = '#/settings/modules?module=studio'; }); await p.waitForTimeout(900);
    const st = p.locator('#view [data-module="studio"]'); const top0 = await p.evaluate(() => (document.getElementById('view').scrollTop + document.getElementById('pane').scrollTop));
    await st.click(); await p.waitForTimeout(2000);
    const s1 = await p.evaluate(() => ({ place: !!document.querySelector('#menu .nav[data-v="studio"]'), top: (document.getElementById('view').scrollTop + document.getElementById('pane').scrollTop), same: window.__noReload === true }));
    check('Studio switched on: its menu place appears in place, the page stays where it was', s1.place && s1.same && Math.abs(s1.top - top0) < 2, JSON.stringify({ top0, ...s1 }));
    check('modules: no page errors', errs.length === 0, errs.join(' | ').slice(0, 200));
  } finally { await ctx.close(); }
}

// ---- 7, 8: the desk's address in General; the installed app; slow Chat routes leave no blank card
async function settingsChecks(b) {
  const { ctx, p, errs } = await open(b, 1366, 768, 'light', '#/settings/general');
  try {
    const g = await p.evaluate(() => ({ addr: document.getElementById('desk-address')?.textContent, copy: !!document.querySelector('#desk-address + button'), text: document.getElementById('view').textContent }));
    check('Settings › General: the address with Copy and how to open or install it', g.addr === t.base && g.copy && /Open this address in Chrome or Edge on this PC\. To keep it handy, install it as an app from the browser's menu\./.test(g.text), JSON.stringify({ addr: g.addr, copy: g.copy }));
    await p.screenshot({ path: `${SHOTS}/settings_general_1366x768_light.png` });
    const cdp = await ctx.newCDPSession(p);
    const inst = await cdp.send('Page.getInstallabilityErrors');
    inst.installabilityErrors = inst.installabilityErrors.filter(e => e.errorId !== 'in-incognito');   // a test browser profile is always private
    const man = await cdp.send('Page.getAppManifest');
    check('Chrome finds the manifest and can install the desk as an app', !inst.installabilityErrors.length && /AP Desk/.test(man.data || '') && !man.errors.length, JSON.stringify({ inst: inst.installabilityErrors, errors: man.errors }));
    // slow Chat routes: Settings is drawn at once and says it is still reading
    await p.route('**/api/m/chat/**', async (r) => { await wait(6000); r.continue().catch(() => {}); });
    await p.evaluate(() => { location.hash = '#/settings/appearance'; }); await p.waitForTimeout(300);
    const t0 = Date.now(); await p.evaluate(() => { location.hash = '#/settings/general'; });
    await p.waitForSelector('#desk-address', { timeout: 3000 }).catch(() => {});
    const slow = await p.evaluate(() => ({ cards: document.querySelectorAll('#view .card').length, sel: document.getElementById('answer-length')?.selectedOptions[0]?.textContent, disabled: document.getElementById('answer-length')?.disabled }));
    check('Chat routes slow: Settings › General is all there at once, the answer length says Reading', Date.now() - t0 < 2000 && slow.cards >= 3 && slow.sel === 'Reading…' && slow.disabled === true, JSON.stringify({ ms: Date.now() - t0, ...slow }));
    await p.screenshot({ path: `${SHOTS}/settings_slow_chat_1366x768_light.png` });
    check('settings: no page errors', errs.length === 0, errs.join(' | ').slice(0, 200));
  } finally { await ctx.close(); }
}

// ---- 5, 8: first start offers the local model; nothing is downloaded without Save; slow Chat routes
async function firstStartChecks() {
  const b = await chromium.launch();
  const fresh = async (opts = {}) => {
    const d = await testDesk({ modules: ['chat', 'agents', 'models'] });
    const ctx = await b.newContext({ viewport: { width: 1366, height: 768 } }); const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    const gets = []; await p.route('**/api/local-engine/get', (r) => { gets.push(r.request().postDataJSON()); r.fulfill({ json: { downloads: [] } }); });
    if (opts.plan) await p.route('**/api/local-engine/plan*', (r) => r.fulfill({ json: opts.plan }));
    if (opts.slowChat) await p.route('**/api/m/chat/**', async (r) => { await wait(6000); r.continue().catch(() => {}); });
    if (opts.offline) d.core.settings.set('online', false);
    await p.goto(d.base + '/#/chat'); await p.waitForSelector('#roles .role');
    const t0 = Date.now(); await p.click(`#roles .role >> nth=${opts.role ?? 1}`);
    await p.waitForSelector('#onb-about', { timeout: 3000 }).catch(() => {});
    const ms = Date.now() - t0;
    return { d, ctx, p, errs, gets, ms, close: async () => { await ctx.close(); await d.close(); } };
  };
  const box = (p) => p.evaluate(() => { const cb = document.getElementById('onb-local'); return { checked: cb?.checked, disabled: cb?.disabled, text: document.querySelector('[data-apd="local-model"]')?.textContent || '' }; });
  try {
    let f = await fresh({ slowChat: true, role: 0 });   // Sales: two agents left unticked, so Save asks Chat to fit the rooms
    check('Chat routes slow: the first-start card is there at once', f.ms < 2000 && await f.p.evaluate(() => /What do you do\?/.test(document.querySelector('#onb .card').textContent)), `${f.ms} ms`);
    await until(async () => (await box(f.p)).disabled === false, 8000);
    let bx = await box(f.p);
    const plan = (await f.d.call('/api/local-engine/plan')).json;
    check('first start: a ticked box with the model, its engine and the total size, and the plain line', bx.checked && !bx.disabled && bx.text.includes(`${plan.model.name} and its engine, ${plan.totalText}`) && /It runs on this PC and works without the internet/.test(bx.text) && /Choose another/.test(bx.text), bx.text.slice(0, 200));
    await f.p.click('text=Choose another'); await f.p.waitForTimeout(200);
    const choices = await f.p.evaluate(() => [...document.querySelectorAll('[name="onb-model"]')].map(r => r.closest('label').textContent));
    check('Choose another lists the plan\'s choices with sizes', choices.length === plan.choices.length && plan.choices.every((c, i) => choices[i].includes(c.name) && choices[i].includes(c.sizeText)), choices.join(' | ').slice(0, 200));
    const small = plan.choices.find(c => c.fits && c.id !== plan.model.id);
    await f.p.check(`[name="onb-model"][value="${small.id}"]`); await f.p.waitForTimeout(800);
    bx = await box(f.p);
    const plan2 = (await f.d.call('/api/local-engine/plan?model=' + small.id)).json;
    check('choosing another updates the name and the total', bx.text.includes(`${small.name} and its engine, ${plan2.totalText}`), bx.text.slice(0, 160));
    await f.p.screenshot({ path: `${SHOTS}/first_start_local_1366x768_light.png` });
    check('nothing is downloaded before Save', f.gets.length === 0 && !(await f.d.call('/api/downloads')).json.downloads.length);
    const t1 = Date.now(); await f.p.click('#onb .btn:has-text("Save")');
    await until(() => f.p.evaluate(() => document.getElementById('onb').hidden), 4000);
    check('Save with the box ticked asks for that model, and does not wait on the slow Chat routes', f.gets.length === 1 && f.gets[0].model === small.id && Date.now() - t1 < 3000, JSON.stringify({ gets: f.gets, ms: Date.now() - t1 }));
    check('first start: no page errors', f.errs.length === 0, f.errs.join(' | ').slice(0, 200));
    await f.close();
    f = await fresh();
    await until(async () => (await box(f.p)).disabled === false, 8000);
    await f.p.click('#onb .btn:has-text("Skip for now")'); await f.p.waitForTimeout(800);
    check('Skip never downloads anything', f.gets.length === 0 && !(await f.d.call('/api/downloads')).json.downloads.length);
    await f.close();
    f = await fresh({ offline: true });
    await f.p.waitForTimeout(1500); bx = await box(f.p);
    check('Offline: the box is unticked and disabled with the reason', !bx.checked && bx.disabled && /Offline/.test(bx.text), bx.text.slice(0, 160));
    await f.p.screenshot({ path: `${SHOTS}/first_start_offline_1366x768_light.png` });
    await f.close();
    f = await fresh({ plan: { ok: false, reason: 'There is no ready-made llama.cpp build for this PC (linux riscv64).', model: null, choices: [], totalBytes: 0 } });
    await f.p.waitForTimeout(1500); bx = await box(f.p);
    check('no build fits: unticked and disabled with the plain reason', !bx.checked && bx.disabled && /no ready-made llama\.cpp build/.test(bx.text), bx.text.slice(0, 160));
    await f.p.click('#onb .btn:has-text("Save")'); await f.p.waitForTimeout(800);
    check('then Save downloads nothing', f.gets.length === 0);
    await f.close();
    // phone width: the card fits
    f = await fresh(); await f.p.setViewportSize({ width: 390, height: 844 }); await until(async () => (await box(f.p)).disabled === false, 8000);
    await f.p.screenshot({ path: `${SHOTS}/first_start_local_390x844_light.png` }); await f.close();
  } finally { await b.close(); }
}

// ---- 6: the code for another browser, shown in the owner's paired window only, for 60 seconds
async function pairChecks() {
  const d = await testDesk({ pairing: true });
  const b = await chromium.launch();
  try {
    let paired;   // the first browser on the fresh desk is the owner's: the second size reuses its cookie
    for (const [w, hgt, theme] of [[1366, 768, 'light'], [390, 844, 'dark']]) {
      const ctx = await b.newContext({ viewport: { width: w, height: hgt }, ...(paired ? { storageState: paired } : {}) }); const p = await ctx.newPage();
      const errs = []; p.on('pageerror', e => errs.push(e.message));
      await p.clock.install();
      await p.addInitScript((th) => { try { localStorage.setItem('apd-theme', th); } catch {} }, theme);
      d.core.settings.set('onboarded', true); d.core.settings.set('theme', theme);
      await p.goto(d.base + '/#/settings/security'); await p.waitForSelector('[data-apd="pair"]');
      await p.click('[data-apd="pair"] button:has-text("Show code")'); await p.waitForTimeout(400);
      const shown = await p.evaluate(() => ({ text: document.getElementById('pair-code').textContent, copies: [...document.querySelectorAll('#pair-code button')].map(x => x.getAttribute('aria-label') || x.textContent) }));
      check(`${w}x${hgt}: Show code shows the code, the address and a copy button for the address only`, shown.text.includes(`${d.desk.pairCode.slice(0, 3)} ${d.desk.pairCode.slice(3)}`) && shown.text.includes(d.base) && shown.copies.filter(x => /Copy/.test(x)).length === 1 && shown.copies.includes('Copy the address'), JSON.stringify(shown).slice(0, 220));
      await p.locator('#pair-code').scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${SHOTS}/settings_show_code_${w}x${hgt}_${theme}.png` });
      await p.clock.runFor(61000); await p.waitForTimeout(200);
      check(`${w}x${hgt}: after 60 seconds the code is hidden again`, await p.evaluate((c) => !document.getElementById('pair-code').textContent.includes(c.slice(0, 3) + ' ' + c.slice(3)) && !!document.querySelector('[data-apd="pair"] button:not([hidden])'), d.desk.pairCode));
      check(`${w}x${hgt}: pairing: no page errors`, errs.length === 0, errs.join(' | ').slice(0, 200));
      paired = await ctx.storageState(); await ctx.close();
    }
    // another browser (not paired) gets neither the page nor the code
    const other = await b.newContext(); const q = await other.newPage(); await q.goto(d.base + '/');
    const r = await q.evaluate(async () => { try { return (await fetch('/api/security/pair-code', { method: 'POST' })).status; } catch { return 'blocked by the pairing page'; } });
    const r2 = (await q.request.post(d.base + '/api/security/pair-code')).status();
    check('a browser that is not paired is refused the code', (r === 'blocked by the pairing page' || r === 401 || r === 403) && (r2 === 401 || r2 === 403), `${r}, ${r2}`);
    await other.close();
  } finally { await b.close(); await d.close(); }
}
