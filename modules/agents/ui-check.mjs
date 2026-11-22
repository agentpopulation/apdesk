// Screen check of the Agents page in a real browser, with stand-ins (the fake model; a stand-in picture for the browser).
// Covers: the Profile cards, picking an avatar (tick, header and list card repaint, back on a failed save), the avatar of an
// agent not on the team, the tab bar on a phone (no tab cut, the open tab in view), the Computer tab's closed-browser
// words with the last picture's time in the owner's zone, and the "Starts when needed" chip.
// Also covers the avatars' life: blinking, pupils that follow the pointer, the states, the "Avatar motion" switch, reduced motion,
// one shared pointer listener, and nothing moving when switched off, off screen or in a hidden tab.
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
await page.addInitScript(() => {   // count the avatar script's pointer listener: adds minus removes
  window.__avl = 0; const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (t, f, o) { if (t === 'pointermove' && f?.name === 'avatarPointer') window.__avl++; return add.call(this, t, f, o); };
  EventTarget.prototype.removeEventListener = function (t, f, o) { if (t === 'pointermove' && f?.name === 'avatarPointer') window.__avl--; return rem.call(this, t, f, o); };
});
const shots = process.argv[3] || path.join(out, 'avatar-life-shots'); fs.mkdirSync(shots, { recursive: true });
const until = async (fn, arg, ms = 3000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await page.evaluate(fn, arg); if (v) return v; await sleep(80); } return v; };
// the first eye's pupil offset (drawing units), read from its computed transform
const pupil = (sel) => page.evaluate((q) => { const m = new DOMMatrix(getComputedStyle(document.querySelector(q + ' .pu')).transform); return [m.e, m.f]; }, sel);
// animations running inside avatars (a running one is one that is not paused or finished)
const running = () => page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && (a.effect?.target?.closest?.('.agav'))).map(a => a.animationName || a.constructor.name));
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

  // ---- the avatars' life ----
  await until(() => document.documentElement.dataset.avmotion === 'on');
  const head = '#a-det .work-head .agav';
  const box = await page.locator(head).boundingBox(); const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 140, cy); await until((q) => new DOMMatrix(getComputedStyle(document.querySelector(q + ' .pu')).transform).e < -0.8, head);
  const left = await pupil(head); await page.screenshot({ path: path.join(shots, 'pointer-left.png'), clip: { x: Math.max(0, cx - 200), y: Math.max(0, cy - 60), width: 340, height: 120 } });
  await page.mouse.move(cx + 140, cy); await until((q) => new DOMMatrix(getComputedStyle(document.querySelector(q + ' .pu')).transform).e > 0.8, head);
  const right = await pupil(head); await page.screenshot({ path: path.join(shots, 'pointer-right.png'), clip: { x: Math.max(0, cx - 140), y: Math.max(0, cy - 60), width: 340, height: 120 } });
  check('pupils move toward the pointer (left, then right), a few pixels at most', left[0] < -0.8 && right[0] > 0.8 && Math.abs(left[0]) <= 2.2 && Math.abs(right[0]) <= 2.2, `left ${left.map(n => n.toFixed(2))}, right ${right.map(n => n.toFixed(2))}`);
  await page.mouse.move(cx > 683 ? 40 : 1340, 740); await until((q) => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector(q + ' .pu')).transform).e) < 0.05, head);
  const far = await pupil(head);
  check('pupils return to centre when the pointer is far away', Math.abs(far[0]) < 0.05 && Math.abs(far[1]) < 0.05, far.map(n => n.toFixed(2)).join(','));

  // a blink: read the animation, jump its clock to the closed moment, read the eyelid
  const blink = await page.evaluate((q) => {
    const eye = document.querySelector(q + ' .ey'); const an = eye.getAnimations().find(a => a.animationName === 'avblink'); if (!an) return null;
    const dur = an.effect.getComputedTiming().duration, delay = an.effect.getTiming().delay; an.pause();
    const at = (f) => { an.currentTime = f * dur + delay + 2 * dur; return new DOMMatrix(getComputedStyle(eye).transform).d; };
    const r = { dur, open: at(0.5), shut: at(0.975) }; an.play(); return r;
  }, head);
  check('an avatar blinks within a few seconds (the lid closes, then opens)', blink && blink.dur <= 7300 && blink.shut < 0.2 && blink.open > 0.99, JSON.stringify(blink));
  const rhythms = await page.evaluate(() => new Set([...document.querySelectorAll('.avgrid .agav')].map(e => e.style.getPropertyValue('--bd') + '/' + e.style.getPropertyValue('--bl'))).size);
  check('each avatar has its own blink rhythm', rhythms >= 20, `${rhythms} different rhythms in the picker`);
  const eyeless = await page.evaluate(() => [...document.querySelectorAll('.avgrid .agav[data-eyes="0"]')].map(e => e.dataset.look + ':' + e.getAnimations({ subtree: true }).map(a => a.animationName).join('+')));
  check('drawings without eyes sway or twinkle instead', eyeless.length === 6 && eyeless.every(x => /av(sway|twinkle|needle)/.test(x)), eyeless.join(' | '));
  check('the letter avatar stays still', await page.evaluate(() => { const l = document.querySelector('#a-list .agav[data-look="letter"]') || document.querySelector('.avgrid .agav[data-look="letter"]'); return !!l && l.getAnimations({ subtree: true }).length === 0 && !l.dataset.state; }));

  // one pointer listener for all of them
  const many = await page.evaluate(() => document.querySelectorAll('.agav').length);
  check('one pointer listener serves every avatar on the page', (await page.evaluate(() => window.__avl)) === 1 && many >= 25, `${many} avatars, ${await page.evaluate(() => window.__avl)} listener`);

  // states on a small stage (large, zoomed, for the pictures); the letter ignores a state
  await page.evaluate(async () => {
    const { avatarEl } = await import('/modules/agents/ui.js');
    const st = document.createElement('div'); st.id = 'av-stage'; st.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;display:flex;gap:14px;padding:12px;background:#1b1440;border-radius:14px;zoom:1.8';
    for (const [look, state] of [['robot', 'working'], ['owl', 'waiting'], ['cat', 'idle'], ['panda', 'failed'], ['robot', null], ['leaf', 'working']]) st.append(avatarEl({ id: 'x-' + look, name: 'Xy', avatar: { look, colour: 'teal' } }, 'l', state));
    st.append(avatarEl({ id: 'x-l', name: 'Xy' }, 'l', 'working'));
    document.body.append(st);
  });
  const stg = await page.evaluate(() => [...document.querySelectorAll('#av-stage .agav')].map(e => ({ state: e.dataset.state || '', ring: e.getAnimations().some(a => a.animationName === 'avring'), dot: getComputedStyle(e, '::after').content !== 'none' && Math.round(parseFloat(getComputedStyle(e, '::after').width)) === 9, bob: e.getAnimations({ subtree: true }).some(a => a.animationName === 'avbob'), n: e.getAnimations({ subtree: true }).length })));
  check('working: a ring pulses and the drawing bobs', stg[0].ring && stg[0].bob && stg[0].state === 'working', JSON.stringify(stg[0]));
  check('waiting: an amber dot; failed: a dot; idle and no state: none', stg[1].dot && stg[3].dot && !stg[2].dot && !stg[4].dot && !stg[2].ring, JSON.stringify(stg.map(x => x.dot)));
  check('the letter avatar ignores a state and does not move', stg[6].state === '' && stg[6].n === 0 && !stg[6].ring, JSON.stringify(stg[6]));
  const stageBox = await page.locator('#av-stage').boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height + 60); await sleep(500);
  const wy = (await pupil('#av-stage .agav:nth-child(2)'))[1], iy = (await pupil('#av-stage .agav:nth-child(3)'))[1];
  check('waiting: the eyes look out toward the owner, idle looks straight', wy > 0.8 && Math.abs(iy) < 1.8, `waiting y ${wy.toFixed(2)}, idle y ${iy.toFixed(2)}`);
  await page.screenshot({ path: path.join(shots, 'states-working-waiting-idle-failed.png'), clip: { x: 0, y: 0, width: stageBox.width + 16, height: stageBox.height + 16 } });
  await page.screenshot({ path: path.join(shots, 'working.png'), clip: { x: stageBox.x, y: stageBox.y, width: 200, height: 170 } });
  await page.screenshot({ path: path.join(shots, 'waiting.png'), clip: { x: stageBox.x + 150, y: stageBox.y, width: 200, height: 170 } });

  // off screen and hidden tab: nothing animates
  await page.evaluate(() => { document.getElementById('av-stage').style.left = '-4000px'; }); await sleep(400);
  const offs = await page.evaluate(() => { const a = document.querySelector('#av-stage .agav'); return [a.classList.contains('avoff'), a.getAnimations({ subtree: true }).some(x => x.playState === 'running')]; });
  check('an avatar off screen does not animate', offs[0] && !offs[1], JSON.stringify(offs));
  await page.evaluate(() => { document.getElementById('av-stage').style.left = '8px'; }); await sleep(400);
  const hid = await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return getComputedStyle(document.querySelector('#av-stage .ey')).animationPlayState; });
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  check('in a hidden tab the avatars pause', hid === 'paused', hid);

  // cost with 30 avatars: a burst of pointer moves is answered by one frame's work
  const cost = await page.evaluate(async () => {
    const t0 = performance.now(); for (let i = 0; i < 300; i++) document.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 + i, clientY: 300 })); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  });
  check('300 pointer moves with 30 avatars cost under 60 ms', cost < 60, cost.toFixed(1) + ' ms');
  await page.evaluate(() => document.getElementById('av-stage').remove());

  // reduced motion: nothing animates and the pupils stay put
  await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(200);
  await page.mouse.move(cx - 140, cy); await sleep(500);
  const rm = await running(), rmp = await pupil(head);
  check('with reduced motion nothing in an avatar animates or follows the pointer', rm.length === 0 && Math.abs(rmp[0]) < 0.05, `${rm.join(',')} pupil ${rmp.map(n => n.toFixed(2))}`);
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await sleep(200);
  check('without it they move again', (await running()).length > 0);

  // the switch "Avatar motion": saved for the whole desk, and it stops everything
  const sw = page.locator('#a-det button.sw[aria-label="Avatar motion"]');
  check('the Profile tab has the "Avatar motion" switch, on', await sw.count() === 1 && await sw.getAttribute('aria-pressed') === 'true');
  await sw.click(); await sleep(600);
  const setOff = (await t.call('/api/settings')).json?.['ui.avatarMotion'];
  await page.mouse.move(cx - 130, cy); await sleep(500);
  const swOff = await running(), swp = await pupil(head);
  check('switched off: saved for the desk, nothing animates, pupils stay put', setOff === false && swOff.length === 0 && Math.abs(swp[0]) < 0.05, `setting ${setOff}, running ${swOff.join(',')}, pupil ${swp.map(n => n.toFixed(2))}`);
  await page.reload(); await page.waitForSelector('#menu .nav'); await go('#/agents/scout/profile', 1200);
  await until(() => document.documentElement.dataset.avmotion === 'off');
  check('and it stays off after a reload', (await running()).length === 0 && await page.locator('#a-det button.sw[aria-label="Avatar motion"]').getAttribute('aria-pressed') === 'false');
  await page.locator('#a-det button.sw[aria-label="Avatar motion"]').click(); await sleep(600);
  check('switched on again, they move', (await t.call('/api/settings')).json?.['ui.avatarMotion'] === true && (await running()).length > 0);
  await page.mouse.move(40, 740);
  // the shared listener is let go when no avatar is left (a bare page, five avatars added and removed)
  const bare = await browser.newPage(); await bare.goto(t.base + '/api/health').catch(() => {});
  const gone = await bare.evaluate(async () => {
    const m = await import('/modules/agents/ui-avatars.js'); const d = document.createElement('div'); document.body.append(d);
    for (let i = 0; i < 5; i++) d.append(m.avatarEl({ id: 'q' + i, name: 'Q' }, 's', { look: 'owl', colour: 'teal' }));
    const during = m.avatarLifeStats(); d.remove(); await new Promise(r => setTimeout(r, 5200));
    return { during, after: m.avatarLifeStats() };
  });
  check('with no avatar left on the page the shared listener is removed', gone.during.listening && gone.during.avatars === 5 && !gone.after.listening && gone.after.avatars === 0, JSON.stringify(gone));
  await bare.close();

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
    await go('#/agents/scout/profile', 1200); await page.screenshot({ path: path.join(out, `agents-profile_390x844_${theme}.png`) });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  for (const theme of ['dark', 'light']) { await page.evaluate((d) => window.apd.setTheme(d), theme === 'dark'); await go('#/agents/scout/profile', 1000); await page.screenshot({ path: path.join(out, `agents-profile_1366x768_${theme}.png`) }); }
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) { check('the check ran to the end', false, e.message); }
finally { await browser.close(); await t.close(); }
const fails = results.filter(x => !x).length;
console.log(`${results.length - fails} pass, ${fails} fail. Pictures in ${out}`);
process.exit(fails ? 1 : 0);
