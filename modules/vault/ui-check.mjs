// Browser check of pages where a press must answer and nothing raw shows: Settings > Keys and logins (no stray word, empty
// boxes answer beside the field and send nothing), Channels (empty token), Memory (empty Add), Voice (engines that cannot work,
// no mic pill over the footer), Files at 390 px (the list shows) and its date column. 390x844 and 1366x768, both themes.
//   CHECK_PORT=3464 node modules/vault/ui-check.mjs [outDir]
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createDesk } from '../../app/server.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-pages-one'); fs.mkdirSync(out, { recursive: true });
let fails = 0; const check = (n, ok, ev = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${ev}`); };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-p1-'));
const desk = await createDesk({ dataDir, port: Number(process.env.CHECK_PORT || 0), quiet: true }); await desk.start();
desk.core.settings.set('onboarded', true); desk.core.settings.set('ui.themeChosen', true);
for (const m of ['vault', 'channels', 'memory', 'voice', 'files']) await desk.modules.set(m, true);
const ws = desk.core.storage.workspace; fs.writeFileSync(path.join(ws, 'notes.md'), '# Notes'); fs.mkdirSync(path.join(ws, 'drafts'), { recursive: true });
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }); }
const open = async (w, h, theme, hash) => {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 }); p.errs = []; p.posts = [];
  p.on('pageerror', (e) => p.errs.push(e.message)); p.on('response', (r) => { if (r.request().method() === 'POST') p.posts.push(r.url().replace(/^.*\/api\//, '') + ' ' + r.status()); });
  await p.addInitScript((t) => { try { localStorage.setItem('apd-theme', t); } catch {} }, theme); desk.core.settings.set('theme', theme);
  await p.goto(desk.url() + '/' + hash); await p.waitForSelector('#menu .nav'); await p.waitForTimeout(900); return p;
};
const shot = (p, n, w, h, theme) => p.screenshot({ path: `${out}/${n}_${w}x${h}_${theme}.png` });
try {
  for (const [w, h] of [[1366, 768], [390, 844]]) for (const theme of ['dark', 'light']) {
    // Keys and logins
    let p = await open(w, h, theme, '#/settings/keys'); await p.waitForSelector('#lg-save');
    const text = await p.evaluate(() => document.querySelector('#view').innerText);
    check(`keys ${w} ${theme}: no stray "null" or "undefined"`, !/\bnull\b|\bundefined\b/.test(text));
    check(`keys ${w} ${theme}: no box for the three services nothing uses`, !/Deepgram|Cartesia|AssemblyAI/.test(text));
    await p.click('#lg-save'); await p.waitForTimeout(300);
    const note = await p.evaluate(() => document.querySelector('#lg-site')?.nextElementSibling?.textContent || '');
    check(`keys ${w} ${theme}: empty Save answers beside the field`, /Type the site first/.test(note), note);
    check(`keys ${w} ${theme}: and sends nothing`, !p.posts.some(x => /vault\/logins/.test(x)), p.posts.join(','));
    await shot(p, 'keys', w, h, theme); await p.close();
    // Channels
    p = await open(w, h, theme, '#/settings/channels'); await p.waitForSelector('text=Bot token');
    await p.getByRole('button', { name: 'Save', exact: true }).first().click(); await p.waitForTimeout(300);
    check(`channels ${w} ${theme}: empty token Save answers`, await p.getByText('Type a token first.').count() === 1);
    check(`channels ${w} ${theme}: and sends nothing`, !p.posts.some(x => /channels\/telegram\/token/.test(x)), p.posts.join(','));
    await shot(p, 'channels', w, h, theme); await p.close();
    // Memory
    p = await open(w, h, theme, '#/settings/memory'); await p.waitForSelector('[aria-label="New memory"]');
    await p.getByRole('button', { name: 'Add', exact: true }).click(); await p.waitForTimeout(300);
    check(`memory ${w} ${theme}: empty Add answers`, await p.getByText('Type something to remember first.').count() === 1);
    check(`memory ${w} ${theme}: and sends nothing`, !p.posts.some(x => /memory\/items/.test(x)), p.posts.join(','));
    await shot(p, 'memory', w, h, theme); await p.close();
    // Voice
    p = await open(w, h, theme, '#/settings/voice'); await p.waitForSelector('text=Dictation');
    const vt0 = await p.evaluate(() => document.querySelector('#view').innerText);
    check(`voice ${w} ${theme}: the unavailable choices are marked and say why`, /On this PC is not available\. whisper\.cpp was not found/.test(vt0) && await p.locator('.seg button[data-unavailable]').count() >= 4);
    await p.getByRole('button', { name: /^ElevenLabs/ }).first().click(); await p.waitForTimeout(300);
    const vt = await p.evaluate(() => document.querySelector('#view').innerText);
    check(`voice ${w} ${theme}: pressing an engine with no key answers and does not choose it`, /ElevenLabs is not available\. There is no ElevenLabs key/.test(vt) && !p.posts.some(x => /voice\/settings/.test(x)) && await p.locator('.seg button[aria-pressed=true]').first().innerText() === 'Browser', p.posts.join(','));
    const g = await p.evaluate(() => { const v = document.querySelector('#apd-voice').getBoundingClientRect(), f = document.querySelector('#foot').getBoundingClientRect(); return { pillBottom: v.bottom, footTop: f.top }; });
    check(`voice ${w} ${theme}: the mic and speaker buttons sit above the footer`, g.pillBottom <= g.footTop + 1, JSON.stringify(g));
    check(`voice ${w} ${theme}: no Windows-only words on this system`, process.platform === 'win32' || !/\.exe|C:\\/.test(vt));
    await shot(p, 'voice', w, h, theme); await p.close();
    // Files
    p = await open(w, h, theme, '#/files'); await p.waitForSelector('.fx-row, .fx-item, .fx-list'); await p.waitForTimeout(600);
    const f = await p.evaluate(() => { const c = document.querySelector('.fx-cell.is-mtime'); return { main: document.querySelector('.fx-main')?.getBoundingClientRect().width, cut: c ? c.scrollWidth > c.clientWidth + 1 : false, shown: c?.textContent || '' }; });
    check(`files ${w} ${theme}: the list has room`, f.main > 250, JSON.stringify(f));
    if (w > 700) check(`files ${w} ${theme}: the date is whole`, !f.cut && f.shown.length > 0, JSON.stringify(f));
    await shot(p, 'files', w, h, theme); check(`pages ${w} ${theme}: no page errors`, p.errs.length === 0, p.errs.join(' | ')); await p.close();
  }
} finally { await b.close(); await desk.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
