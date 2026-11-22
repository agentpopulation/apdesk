// Several people on one PC, on screen (contracts/PEOPLE.md, P4): the chooser, the PIN prompt and its wait, the switcher
// (switch person, lock the window), the keeper adding a person with the plain caution, and a non-keeper not seeing the
// keeper-only items. Real Chromium, at 390x844 and 1366x768 in both themes. Person A (the keeper) and Person B are the
// test people; no model is needed. Run from the repository root:
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/check-people-ui.mjs [screenshot dir]
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { testDesk } from '../test/helpers/desk.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'apd-people-checks'); fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0; const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await wait(100); } };

const t = await testDesk({ modules: ['chat', 'backup', 'network', 'bench', 'finder', 'sales', 'memory', 'models'] });
const b = await chromium.launch();
const ctxFor = async (w, hgt, theme, { storageState } = {}) => {
  const ctx = await b.newContext({ viewport: { width: w, height: hgt }, ...(storageState ? { storageState } : {}) });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript((th) => { try { localStorage.setItem('apd-theme', th); } catch {} }, theme);
  return { ctx, p, errs };
};
const skipOnb = async (p) => { await p.getByText('Skip, show everything').click().catch(() => {}); await wait(300); };
// A fresh space (Personal, Incognito) shows onboarding: click whichever Skip is there until the overlay is gone, and mark
// the space onboarded so a later reload of the same space does not show it again.
const dismissOnb = async (p) => { for (let i = 0; i < 4; i++) { if (await p.evaluate(() => document.getElementById('onb').hidden).catch(() => true)) return; await p.getByRole('button', { name: /Skip, show everything|Skip for now/ }).first().click().catch(() => {}); await wait(350); } };
// Mark the live document before an action that reloads the window, so settle can wait for the new document to arrive
// (a reload keeps the old #menu .nav around until the last moment, which otherwise races the evaluate below).
const markNav = (p) => p.evaluate(() => { window.__apdnav = true; }).catch(() => {});
const settle = async (p) => {
  await p.waitForFunction(() => window.__apdnav === undefined, null, { timeout: 12000 }).catch(() => {});
  await p.waitForSelector('#menu .nav', { timeout: 8000 });
  await p.evaluate(async () => { try { const k = await import('/ui/kit.js'); await k.api('settings', { body: { onboarded: true } }); } catch {} });
  await dismissOnb(p); await wait(200);
};
const openSwitcher = async (p) => { await p.click('#who'); await until(() => p.evaluate(() => !document.getElementById('modal').hidden)); };

try {
  // ---- 1. the keeper's window (open desk): boots straight to the desk, no avatar; sets a PIN, then the avatar appears
  t.core.settings.set('onboarded', true); t.core.settings.set('theme', 'light');
  let f = await ctxFor(1366, 768, 'light');
  await f.p.goto(t.base + '/#/home'); await f.p.waitForSelector('#menu .nav'); await wait(500);
  check('open desk (one person, no PIN): no chooser, no switcher avatar', await f.p.evaluate(() => document.getElementById('chooser').hidden && document.getElementById('who').hidden));
  await f.p.goto(t.base + '/#/settings/people'); await f.p.waitForSelector('#view .card'); await wait(400);
  check('Settings › People: the keeper sees their profile, their PIN and People on this PC', await f.p.evaluate(() => /Your profile/.test(document.getElementById('view').textContent) && /Your PIN/.test(document.getElementById('view').textContent) && /People on this PC/.test(document.getElementById('view').textContent)));
  check('Settings › People: no stray "null" or "undefined" on screen', await f.p.evaluate(() => !/\b(null|undefined)\b/.test(document.getElementById('view').innerText)));
  await f.p.screenshot({ path: `${SHOTS}/settings_people_keeper_1366x768_light.png` });
  // set the keeper's PIN
  await f.p.fill('#view .pinf', '2468');
  await f.p.getByRole('button', { name: 'Set PIN' }).click(); await wait(600);
  check('after the keeper sets a PIN, the switcher avatar appears in the top bar', await until(() => f.p.evaluate(() => !document.getElementById('who').hidden), 3000));
  // add Person B through the switcher, with the caution visible
  await f.p.click('#who'); await until(() => f.p.evaluate(() => !document.getElementById('modal').hidden));
  check('the keeper switcher offers Add a person and Settings for people', await f.p.evaluate(() => { const b = [...document.querySelectorAll('#modal button')].map(x => x.textContent); return b.includes('Add a person') && b.includes('Settings for people') && b.includes('Switch person') && b.includes('Lock this window'); }));
  await f.p.screenshot({ path: `${SHOTS}/switcher_keeper_1366x768_light.png` });
  await f.p.locator('#modal').getByRole('button', { name: 'Add a person' }).click(); await wait(300);
  check('Add a person shows the plain caution about PINs and separate OS accounts', await f.p.evaluate(() => /does not protect your files/.test(document.getElementById('modal').textContent) && /Windows account/.test(document.getElementById('modal').textContent) && /disk encryption/.test(document.getElementById('modal').textContent)));
  await f.p.screenshot({ path: `${SHOTS}/add_person_1366x768_light.png` });
  await f.p.fill('#modal input[aria-label="Name"]', 'Person B');
  await f.p.click('#modal .picks.emoji .pk >> nth=2');
  await f.p.click('#modal .picks.colour .sw-c >> nth=5');
  await f.p.fill('#modal .pinf', '4821');
  await f.p.locator('#modal').getByRole('button', { name: 'Add', exact: true }).click(); await wait(700);
  check('Person B is added (two people now)', (await t.call('/api/people')).json.people.length === 2);
  const Bid = (await t.call('/api/people')).json.people.find(p => !p.keeper).id;
  t.desk.spaceOf(Bid).core.settings.set('onboarded', true);   // skip B's first-start onboarding for this check
  // the real two-person check: the keeper has a private chat and a long background job running; neither reaches Person B
  await t.call('/api/m/chat/chats', { body: { title: 'Keeper private chat' } });
  let releaseJob; const heldJob = new Promise(r => { releaseJob = r; });
  const bgJob = await t.core.jobs.start({ kind: 'research.check', title: 'Keeper long job', run: async () => { await heldJob; } });
  check('keeper window: no page errors', f.errs.length === 0, f.errs.join(' | ').slice(0, 200));
  await f.ctx.close();

  // ---- 2. the chooser (a fresh window, no token) at both sizes and themes: two people as avatars
  for (const [w, hgt, theme] of [[1366, 768, 'light'], [390, 844, 'dark']]) {
    const g = await ctxFor(w, hgt, theme);
    await g.p.goto(t.base + '/'); await g.p.waitForSelector('#chooser .person'); await wait(300);
    const info = await g.p.evaluate(() => ({ people: document.querySelectorAll('#chooser .person').length, names: [...document.querySelectorAll('#chooser .person .pn')].map(x => x.textContent), avatars: document.querySelectorAll('#chooser .person .pav').length, scroll: document.documentElement.scrollWidth - innerWidth, hidden: document.getElementById('chooser').hidden }));
    check(`${w}x${hgt} ${theme}: the chooser shows two people as avatars with names, no sideways scroll`, !info.hidden && info.people === 2 && info.avatars === 2 && info.names.includes('Person B') && info.scroll <= 0, JSON.stringify(info));
    await g.p.screenshot({ path: `${SHOTS}/chooser_${w}x${hgt}_${theme}.png` });
    await g.ctx.close();
  }

  // ---- 3. the PIN prompt, a wrong PIN and the wait, then entering as Person B
  let s = await ctxFor(1366, 768, 'light');
  await s.p.goto(t.base + '/'); await s.p.waitForSelector('#chooser .person'); await wait(200);
  await s.p.getByRole('button', { name: /Person B/ }).click(); await wait(200);
  check('picking a person with a PIN asks for the PIN', await s.p.evaluate(() => !!document.querySelector('#chooser .pinf') && /Enter your PIN/.test(document.getElementById('chooser').textContent)));
  for (let i = 0; i < 6; i++) { await s.p.fill('#chooser .pinf', '0000'); await s.p.getByRole('button', { name: 'Open' }).click(); await wait(120); }
  check('after too many wrong tries the PIN prompt shows the wait', await until(() => s.p.evaluate(() => /Wait \d+ seconds/.test(document.querySelector('#chooser .perr')?.textContent || '')), 3000), await s.p.evaluate(() => document.querySelector('#chooser .perr')?.textContent));
  await s.p.screenshot({ path: `${SHOTS}/chooser_pin_wait_1366x768_light.png` });
  // the right PIN enters even during a wait (no lockout)
  await s.p.fill('#chooser .pinf', '4821'); await s.p.getByRole('button', { name: 'Open' }).click();
  await s.p.waitForSelector('#menu .nav', { timeout: 8000 }); await skipOnb(s.p); await wait(300);
  check('the right PIN opens the desk as Person B', await s.p.evaluate(() => document.getElementById('chooser').hidden && !document.getElementById('who').hidden));
  check('Person B is not the keeper: the switcher hides Add a person and Settings for people', await (async () => { await s.p.click('#who'); await until(() => s.p.evaluate(() => !document.getElementById('modal').hidden)); const bb = await s.p.evaluate(() => [...document.querySelectorAll('#modal button')].map(x => x.textContent)); await s.p.getByRole('button', { name: 'Close' }).click().catch(() => {}); return bb.includes('Switch person') && bb.includes('Lock this window') && bb.includes('My profile and PIN') && !bb.includes('Add a person') && !bb.includes('Settings for people'); })());
  await s.p.screenshot({ path: `${SHOTS}/switcher_person_b_1366x768_light.png` });
  // Person B's desk is empty of the keeper's chats; B's own chat is B's alone; the keeper's job keeps running
  const bTitles = await s.p.evaluate(async () => { const k = await import('/ui/kit.js'); await k.api('m/chat/chats', { body: { title: 'Person B private chat' } }); return (await k.api('m/chat/chats')).chats.map(c => c.title); });
  check('Person B\'s desk holds none of the keeper\'s chats, and B has their own', !bTitles.includes('Keeper private chat') && bTitles.includes('Person B private chat'), JSON.stringify(bTitles));
  check('the keeper\'s background job keeps running while Person B is at the desk', t.core.jobs.get(bgJob.id).status === 'running');
  await s.p.evaluate(() => { location.hash = '#/chat'; }); await wait(500);
  await s.p.screenshot({ path: `${SHOTS}/person_b_desk_1366x768_light.png` });

  // ---- 4. switch person: back to the chooser for this window, then into the keeper
  await s.p.click('#who'); await until(() => s.p.evaluate(() => !document.getElementById('modal').hidden));
  await s.p.locator('#modal').getByRole('button', { name: 'Switch person' }).click();
  await s.p.waitForSelector('#chooser .person'); await wait(200);
  check('Switch person returns this window to the chooser (in switch mode, with Cancel)', await s.p.evaluate(() => !document.getElementById('chooser').hidden && /Switch person/.test(document.getElementById('chooser').textContent) && [...document.querySelectorAll('#chooser button')].some(x => x.textContent === 'Cancel')));
  await s.p.getByRole('button', { name: /Person A|Keeper/ }).first().click().catch(async () => { await s.p.locator('#chooser .person').first().click(); });
  await wait(200);
  if (await s.p.evaluate(() => !!document.querySelector('#chooser .pinf'))) { await s.p.fill('#chooser .pinf', '2468'); await s.p.locator('#chooser').getByRole('button', { name: 'Open' }).click(); }
  await s.p.waitForSelector('#menu .nav', { timeout: 8000 }); await skipOnb(s.p); await wait(300);
  check('switching into the keeper opens the desk and the keeper-only items are back', await (async () => { await s.p.click('#who'); await until(() => s.p.evaluate(() => !document.getElementById('modal').hidden)); const bb = await s.p.evaluate(() => [...document.querySelectorAll('#modal button')].map(x => x.textContent)); await s.p.getByRole('button', { name: 'Close' }).click().catch(() => {}); return bb.includes('Add a person'); })());
  // back on the keeper: their work is intact, Person B's is nowhere, and the background job never stopped
  const kTitles = await s.p.evaluate(async () => { const k = await import('/ui/kit.js'); return (await k.api('m/chat/chats')).chats.map(c => c.title); });
  check('the keeper\'s work is intact after switching back, and holds none of Person B\'s', kTitles.includes('Keeper private chat') && !kTitles.includes('Person B private chat'), JSON.stringify(kTitles));
  check('the keeper\'s background job survived the whole switch', t.core.jobs.get(bgJob.id).status === 'running');
  releaseJob(); await t.core.jobs.wait(bgJob.id, 3000);

  // ---- 5. lock this window: the token is dropped and the chooser returns
  await s.p.locator('#modal').getByRole('button', { name: 'Lock this window' }).click();
  await s.p.waitForSelector('#chooser .person', { timeout: 8000 }); await wait(200);
  check('Lock this window drops the token and shows the chooser again', await s.p.evaluate(() => !document.getElementById('chooser').hidden && document.querySelectorAll('#chooser .person').length === 2));
  check('people UI: no page errors', s.errs.length === 0, s.errs.join(' | ').slice(0, 200));
  await s.ctx.close();

  // ---- 6. Work/Personal spaces and Incognito, wired into the switcher and the top bar. Person B (a non-keeper, PIN 4821)
  // at both sizes and both themes: the switcher offers Work/Personal and Open Incognito; Personal is a separate empty space;
  // Incognito shows its cautions first and a top-bar mark, and leaving it drops everything it held.
  for (const [w, hgt, theme] of [[1366, 768, 'light'], [1366, 768, 'dark'], [390, 844, 'light'], [390, 844, 'dark']]) {
    const g = await ctxFor(w, hgt, theme);
    const tag = `${w}x${hgt} ${theme}`;
    await g.p.goto(t.base + '/'); await g.p.waitForSelector('#chooser .person'); await wait(200);
    await g.p.getByRole('button', { name: /Person B/ }).click(); await wait(150);
    await g.p.fill('#chooser .pinf', '4821'); await g.p.locator('#chooser').getByRole('button', { name: 'Open' }).click();
    await settle(g.p);
    const workTitle = `B Work chat ${tag}`;
    await g.p.evaluate(async (title) => { const k = await import('/ui/kit.js'); await k.api('m/chat/chats', { body: { title } }); }, workTitle);
    // the switcher offers Work/Personal and Open Incognito
    await openSwitcher(g.p);
    check(`${tag}: switcher shows the Work/Personal choice and Open Incognito`, await g.p.evaluate(() => { const txt = document.getElementById('modal').textContent; const names = [...document.querySelectorAll('#modal button')].map(x => x.textContent); return /Your space/.test(txt) && names.includes('Work') && names.includes('Personal') && names.includes('Open Incognito'); }));
    await g.p.screenshot({ path: `${SHOTS}/switcher_spaces_${w}x${hgt}_${theme}.png` });
    // switch to Personal: the window reloads into a separate, empty Personal space (the Work chat is not there)
    await markNav(g.p); await g.p.locator('#modal').getByRole('button', { name: 'Personal', exact: true }).click();
    await settle(g.p);
    const personal = await g.p.evaluate(async (title) => { const k = await import('/ui/kit.js'); const me = await k.api('people/me'); const chats = (await k.api('m/chat/chats')).chats.map(c => c.title); return { space: me.space, has: chats.includes(title) }; }, workTitle);
    check(`${tag}: Personal is a separate, empty space (the Work chat is absent)`, personal.space === 'personal' && !personal.has, JSON.stringify(personal));
    await g.p.screenshot({ path: `${SHOTS}/personal_space_${w}x${hgt}_${theme}.png` });
    // back to Work, then open Incognito: the cautions are shown before it opens
    await openSwitcher(g.p);
    await markNav(g.p); await g.p.locator('#modal').getByRole('button', { name: 'Work', exact: true }).click();
    await settle(g.p);
    await openSwitcher(g.p);
    await g.p.locator('#modal').getByRole('button', { name: 'Open Incognito' }).click(); await wait(250);
    check(`${tag}: opening Incognito shows the cautions first, before it is used`, await g.p.evaluate(() => { const txt = document.getElementById('modal').textContent; const names = [...document.querySelectorAll('#modal button')].map(x => x.textContent); return /saves nothing/.test(txt) && /Spend still counts/.test(txt) && names.includes('Open Incognito') && names.includes('Cancel'); }));
    await g.p.screenshot({ path: `${SHOTS}/incognito_cautions_${w}x${hgt}_${theme}.png` });
    // confirm: reload into Incognito. The top-bar indicator shows; a chat is made here to prove it is dropped on leave
    await markNav(g.p); await g.p.locator('#modal').getByRole('button', { name: 'Open Incognito' }).click();
    await settle(g.p);
    const incogTitle = `B Incognito chat ${tag}`;
    const inState = await g.p.evaluate(async (title) => { const k = await import('/ui/kit.js'); const me = await k.api('people/me'); await k.api('m/chat/chats', { body: { title } }); const pill = document.getElementById('incog'); return { incognito: me.incognito, pillShown: !!(pill && !pill.hidden), pillText: pill ? pill.textContent : '' }; }, incogTitle);
    check(`${tag}: in Incognito the top-bar indicator shows "Incognito"`, inState.incognito === true && inState.pillShown && /Incognito/.test(inState.pillText), JSON.stringify(inState));
    await g.p.screenshot({ path: `${SHOTS}/incognito_bar_${w}x${hgt}_${theme}.png` });
    // the switcher in Incognito: the reminder and a way out
    await openSwitcher(g.p);
    check(`${tag}: in Incognito the switcher says so and offers Leave Incognito`, await g.p.evaluate(() => { const txt = document.getElementById('modal').textContent; const names = [...document.querySelectorAll('#modal button')].map(x => x.textContent); return /You are in Incognito/.test(txt) && names.includes('Leave Incognito') && !names.includes('Open Incognito'); }));
    await g.p.screenshot({ path: `${SHOTS}/switcher_incognito_${w}x${hgt}_${theme}.png` });
    await markNav(g.p); await g.p.locator('#modal').getByRole('button', { name: 'Leave Incognito' }).click();
    await settle(g.p);
    const after = await g.p.evaluate(async (title) => { const k = await import('/ui/kit.js'); const me = await k.api('people/me'); const chats = (await k.api('m/chat/chats')).chats.map(c => c.title); const pill = document.getElementById('incog'); return { incognito: me.incognito, hasChat: chats.includes(title), pillShown: !!(pill && !pill.hidden) }; }, incogTitle);
    check(`${tag}: leaving Incognito drops its chat and removes the top-bar indicator`, after.incognito === false && !after.hasChat && !after.pillShown, JSON.stringify(after));
    // a non-keeper still sees no keeper-only items anywhere in this flow
    await openSwitcher(g.p);
    check(`${tag}: a non-keeper still has no keeper-only items`, await g.p.evaluate(() => { const names = [...document.querySelectorAll('#modal button')].map(x => x.textContent); return !names.includes('Add a person') && !names.includes('Settings for people'); }));
    await g.p.getByRole('button', { name: 'Close' }).click().catch(() => {});
    check(`${tag}: spaces and Incognito flow had no page errors`, g.errs.length === 0, g.errs.join(' | ').slice(0, 200));
    await g.ctx.close();
  }
} finally { await b.close(); await t.close(); }
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
