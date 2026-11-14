// Real check for Accounts and Lock on a real desk and in a real browser (no model involved: the lock never calls one).
//   node modules/accounts/real-check.mjs
// Run from the repository root. No model keys are needed.
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
import { totp } from './totp.js';

const results = [];
const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(evidence).replace(/\s+/g, ' ').slice(0, 300)}`); };
const t = await testDesk({ real: true, modules: ['accounts', 'store', 'safety'] });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
try {
  await t.call('/api/settings', { body: { onboarded: true } });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/settings/modules');
  await page.waitForSelector('[data-module="accounts"]', { timeout: 15000 });
  await page.click('[data-module="accounts"]');
  await page.waitForFunction(() => window.apd.state.modules.find(m => m.id === 'accounts')?.on, null, { timeout: 10000 });
  check('switch on in the Module Store', t.core.modules.isOn('accounts'), 'Accounts and Lock is on');
  await page.goto(t.base + '/#/settings/accounts'); await page.waitForSelector('#acc-setpin', { timeout: 10000 });
  await page.fill('#acc-pin', '482615'); await page.click('#acc-setpin');
  await page.waitForSelector('#acc-lock', { timeout: 10000 });
  check('set a PIN', (await t.call('/api/m/accounts/state')).json.hasPin === true, 'PIN saved as a scrypt hash');
  await page.click('#acc-lock');
  await page.waitForSelector('#apd-lock', { timeout: 10000 });
  const cover = await page.evaluate(() => { const r = document.getElementById('apd-lock').getBoundingClientRect(); const p = document.getElementById('lock-panic').getBoundingClientRect(); const top = document.elementFromPoint(p.x + p.width / 2, p.y + p.height / 2); const menu = document.querySelector('#menu .nav').getBoundingClientRect(); return { full: r.width >= innerWidth && r.height >= innerHeight, panicOnTop: top?.id === 'lock-panic', menuCovered: document.elementFromPoint(menu.x + 5, menu.y + 5)?.closest('#apd-lock') != null }; });
  check('Lock now: the overlay covers the desk, Panic stays reachable above it', cover.full && cover.panicOnTop && cover.menuCovered, JSON.stringify(cover));
  const lockedRoute = await t.call('/api/m/accounts/options', { body: { idleMinutes: 5 } });
  check('while locked the routes report locked', lockedRoute.status === 423, `${lockedRoute.status} ${lockedRoute.json?.error}`);
  const ask = await t.call('/api/model/ask', { body: { prompt: 'hi', stream: false } });
  const other = await t.call('/api/m/safety/policy');
  const agents = await t.call('/api/agents', { session: false });
  const open = [await t.call('/api/state'), await t.call('/api/panic'), await t.call('/api/m/accounts/state')].map(r => r.status);
  check('a locked desk refuses a model ask and a module route over HTTP; state, Panic and unlock stay open', ask.status === 423 && other.status === 423 && agents.status === 423 && open.every(x => x === 200), `model ask ${ask.status}, Safety route ${other.status}, agents without session ${agents.status}; state/panic/lock status ${open.join('/')}`);
  await page.screenshot({ path: (await import('node:path')).join((await import('node:os')).tmpdir(), 'apd-accounts-lock_1366x768.png') });
  await page.evaluate(() => { location.hash = '#/settings/security'; }); await page.waitForTimeout(1000);
  const behindWhileLocked = await page.locator('tr[data-action]').count();
  await page.fill('#lock-pin', '000000'); await page.click('#lock-unlock');
  await page.waitForFunction(() => /wrong/i.test(document.getElementById('lock-msg')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const msg = await page.textContent('#lock-msg');
  check('wrong PIN refused', /wrong/i.test(msg) && await page.isVisible('#apd-lock'), msg);
  await page.fill('#lock-pin', '482615'); await page.click('#lock-unlock');
  await page.waitForSelector('#apd-lock', { state: 'detached', timeout: 5000 }).catch(() => {});
  const reopened = await page.waitForSelector('tr[data-action]', { timeout: 5000 }).then(() => page.locator('tr[data-action]').count(), () => 0);
  check('right PIN unlocks and the screen behind it loads again', !(await page.$('#apd-lock')) && (await t.call('/api/m/accounts/state')).json.locked === false && behindWhileLocked === 0 && reopened === 14, `Security's Fine-tune table had ${behindWhileLocked} rows while locked (the desk said 423), ${reopened} rows after unlock`);
  await page.goto(t.base + '/#/settings/accounts'); await page.waitForSelector('#acc-totp', { timeout: 10000 });
  // two-step codes
  await page.click('#acc-totp'); await page.waitForSelector('#acc-secret', { timeout: 5000 });
  const secret = (await page.textContent('#acc-secret')).replace(/\s/g, ''); const uri = await page.textContent('#acc-uri');
  await page.fill('#acc-code', totp(secret)); await page.click('#acc-confirm');
  await page.waitForFunction(() => /Two-step codes on/.test(document.body.innerText) || !document.getElementById('acc-confirm'), null, { timeout: 5000 }).catch(() => {});
  check('TOTP: secret and otpauth link shown, a code verifies', (await t.call('/api/m/accounts/state')).json.totp === true && uri.startsWith('otpauth://totp/'), `${secret.slice(0, 4)}… · ${uri.slice(0, 60)}…`);
  await t.call('/api/m/accounts/lock', { method: 'POST' });
  await page.waitForSelector('#apd-lock', { timeout: 10000 });
  await page.fill('#lock-pin', '482615'); await page.click('#lock-unlock'); await page.waitForTimeout(800);
  const pinOnly = await page.isVisible('#apd-lock');
  await page.fill('#lock-pin', '482615'); await page.fill('#lock-code', totp(secret)); await page.click('#lock-unlock');
  await page.waitForSelector('#apd-lock', { state: 'detached', timeout: 5000 }).catch(() => {});
  check('with two-step on: PIN alone refused, PIN and code unlock', pinOnly && !(await page.$('#apd-lock')), 'refused without the code, unlocked with it');
  // a fresh tab while locked: the shell's boot hook shows the lock on the first screen (Chat), not only in Settings
  await t.call('/api/m/accounts/lock', { method: 'POST' });
  const p2 = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await p2.goto(t.base + '/#/chat'); const bootLock = await p2.waitForSelector('#apd-lock', { timeout: 10000 }).then(() => true, () => false);
  check('a new tab opened on Chat while locked shows the lock', bootLock, bootLock ? 'boot hook loaded the overlay' : 'not shown (needs the shell boot hook)');
  await p2.close();
  await page.fill('#lock-pin', '482615'); await page.fill('#lock-code', totp(secret)); await page.click('#lock-unlock');
  await page.waitForSelector('#apd-lock', { state: 'detached', timeout: 5000 }).catch(() => {});
  // switch off
  await page.goto(t.base + '/#/settings/modules'); await page.waitForSelector('[data-module="accounts"]');
  await page.click('[data-module="accounts"]'); await page.waitForTimeout(800);
  const off = await t.call('/api/m/accounts/state');
  check('switch off: the routes go', off.status === 404 && !t.core.modules.isOn('accounts'), `route ${off.status}`);
  const log = (await t.call('/api/activity')).json.items.filter(x => x.action === 'module.accounts').map(x => x.title);
  check('lock, unlock, wrong PIN and changes are in the activity log', ['Desk locked', 'Desk unlocked', 'Wrong unlock attempt', 'Screen lock PIN set', 'Two-step codes switched on'].every(w => log.includes(w)), [...new Set(log)].join(', '));
  check('no page errors', errors.length === 0, errors.join(' | '));
  // lock after a quiet time: 1 minute, no browser activity at all
  await page.close();
  await t.call('/api/modules/accounts/on', { method: 'POST' });
  const re = (await t.call('/api/m/accounts/state')).json;
  if (re.locked) await t.call('/api/m/accounts/unlock', { body: { pin: '482615', code: totp(secret) } });
  await t.call('/api/m/accounts/options', { body: { idleMinutes: 1 } });
  check('switched on again it starts locked; PIN and code unlock it', re.locked === true && (await t.call('/api/m/accounts/state')).json.locked === false, 'locked on start, then unlocked');
  const t0 = Date.now(); let st;
  for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 10000)); st = (await t.call('/api/m/accounts/state')).json; if (st.locked) break; }
  check('locks by itself after the quiet time (1 minute)', st?.locked === true, `locked after ${Math.round((Date.now() - t0) / 1000)} s with no activity`);
} catch (e) { check('accounts real check ran', false, e.stack); }
finally { await browser.close(); await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
