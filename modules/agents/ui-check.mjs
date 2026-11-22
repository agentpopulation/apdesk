// Screen check of the Agents page in a real browser, with stand-ins (the fake model; a stand-in picture for the browser).
// Covers: the Profile cards, picking an avatar (tick, header and list card repaint, back on a failed save), the avatar of an
// agent not on the team, the tab bar on a phone (no tab cut, the open tab in view), the Computer tab's closed-browser
// words with the last picture's time in the owner's zone, and the "Starts when needed" chip.
// Run from the repository root:  node modules/agents/ui-check.mjs [outDir]    (exit code 1 when a check fails)
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
import { keepLastShot } from '../browser/server.js';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-agents-ui'); fs.mkdirSync(out, { recursive: true });
const results = []; const check = (name, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(ev).slice(0, 300)}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const have = (m) => fs.existsSync(path.join(import.meta.dirname, '..', m, 'module.json'));
const t = await testDesk({ modules: ['agents', 'browser', 'models', 'memory', 'chat'].filter(have) });
t.core.settings.set('onboarded', true); t.core.settings.set('country', 'IN'); t.core.settings.set('currency', 'INR'); t.core.settings.set('timeZone', 'Asia/Kolkata');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
keepLastShot(t.core.storage.dataDir, 'scout', { frame: JPEG, frameAt: Date.parse('2026-11-22T06:30:00Z') });   // 12:00 PM in Asia/Kolkata
const browser = await pw.chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
const go = async (hash, ms = 900) => { await page.evaluate((x) => { location.hash = x; }, hash); await sleep(ms); };
try {
  await page.goto(t.base); await page.waitForSelector('#menu .nav'); if (await page.locator('#onb-skip').isVisible().catch(() => false)) await page.click('#onb-skip');
  await go('#/agents/scout/profile', 1200);
  const cards = await page.$$eval('#a-det .pgrid .box>.lbl', els => els.map(e => e.textContent));
  check('Profile shows its cards', ['Who it is', 'What it always does', 'How it looks', 'What it is good at', 'What it did lately'].every(c => cards.includes(c)), cards.join(' | '));
  await page.waitForFunction(() => /Nothing yet\.|Running|Done|Failed|Stopped|Waiting/.test(document.querySelector('#a-det .pgrid').innerText), null, { timeout: 5000 }).catch(() => {});
  check('What it did lately reads the records or says "Nothing yet."', /Nothing yet\./.test(await page.locator('#a-det .pgrid').innerText()));

  // pick an avatar: it saves at once with the tick, and the header and the list card show it
  const pick = page.locator('#a-det .avpick[aria-label="Owl"]');
  check('the avatar grid offers the drawings and Letters', (await page.locator('#a-det .avpick').count()) >= 20 && await page.locator('#a-det .avpick[aria-label="Letters"]').count() === 1);
  await pick.click({ timeout: 8000 }); await sleep(700);
  const saved = (await t.call('/api/agents/scout')).json;
  const shown = await page.evaluate(() => [...document.querySelectorAll('.agav[data-agent="scout"]')].map(e => e.dataset.look === 'owl'));
  check('picking Owl saves it on the agent', saved?.avatar?.look === 'owl', JSON.stringify(saved?.avatar));
  check('the header and the list card show the new avatar at once', shown.length >= 2 && shown.every(Boolean), JSON.stringify(shown));
  check('the choice answers back with the saved tick', /Saved/.test(await page.locator('#a-det .pgrid').innerText()));
  // a failed save puts the old look back
  await page.route('**/api/agents/scout', (r) => r.request().method() === 'PATCH' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"stand-in failure"}' }) : r.continue());
  await page.locator('#a-det .avpick[aria-label="Letters"]').click(); await sleep(700);
  await page.unroute('**/api/agents/scout');
  const back = await page.locator('#a-det .avpick[aria-label="Owl"]').getAttribute('aria-pressed');
  const headLook = await page.evaluate(() => document.querySelector('#a-det .work-head .agav').dataset.look === 'owl');
  check('a failed save puts the old avatar back', back === 'true' && headLook, `Owl pressed ${back}, header owl ${headLook}`);
  await page.screenshot({ path: path.join(out, 'agents-profile_1366x768.png') });

  // an agent not on the team keeps its avatar
  const r1 = await t.call('/api/agents/closer', { method: 'PATCH', body: { avatar: { look: 'owl', colour: 'teal' } } });
  const r2 = await t.call('/api/m/agents/agents/closer', { method: 'DELETE' });
  await go('#/agents/scout/profile', 1200);
  const offLook = await page.evaluate(() => { const e = document.querySelector('#a-off .agav[data-agent="closer"]'); return e ? (e.dataset.look === 'owl') : null; });
  check('an agent under "Not on your team" keeps its chosen avatar', r1.status === 200 && r2.status < 300 && offLook === true, `patch ${r1.status}, retire ${r2.status}, owl ${offLook}`);

  // the Computer tab: the closed browser said as it is, the last picture with its time in the owner's zone, the chip
  await go('#/agents/scout/computer', 1500);
  const comp = await page.locator('#a-det').innerText();
  check('Computer tab says the browser starts when it is needed', /Scout's browser starts when it is needed\. Give it a task below, or press Take over to drive it yourself\./.test(comp), comp.split('\n').slice(0, 4).join(' | '));
  check('Computer tab shows when the last picture was taken, in the owner\'s zone', /Last picture from its browser: (22 Nov, )?12:00\s?pm\./i.test(comp), (comp.match(/Last picture[^\n]*/) || [''])[0]);
  check('the chip says "Starts when needed"', /Starts when needed/.test(comp));

  // a phone: no tab cut, the open tab in view
  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate((d) => window.apd.setTheme(d), theme === 'dark');
    await go('#/agents/scout/computer', 1200);
    const g = await page.evaluate(() => { const b = document.querySelector('#a-det>.tabbar'); const r = b.getBoundingClientRect(); const s = b.querySelector('[aria-selected="true"]').getBoundingClientRect(); return { cut: b.scrollWidth > b.clientWidth + 1, selIn: s.left >= r.left - 1 && s.right <= r.right + 1, sel: b.querySelector('[aria-selected="true"]').textContent }; });
    check(`390x844 ${theme}: every tab whole and the open tab (${g.sel}) in view`, !g.cut && g.selIn, JSON.stringify(g));
    await page.screenshot({ path: path.join(out, `agents-computer_390x844_${theme}.png`) });
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) { check('the check ran to the end', false, e.message); }
finally { await browser.close(); await t.close(); }
const fails = results.filter(x => !x).length;
console.log(`${results.length - fails} pass, ${fails} fail. Pictures in ${out}`);
process.exit(fails ? 1 : 0);
