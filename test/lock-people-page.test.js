// A restarted desk in a real browser, for each mix of PINs: none, the Accounts lock PIN only, the person's own PIN only,
// and both. Each way in ends on a desk that has loaded (the agents are there), and each PIN box says which PIN it wants.
// Then first start's step two, drawn behind the lock, is drawn again from the real settings once the desk is open.
// Skipped when no browser is here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
import { createDesk } from '../app/server.js';

const req = createRequire(import.meta.url);
let chromium = null; try { ({ chromium } = req('playwright-core')); } catch {}
const exe = ['/opt/pw-browsers/chromium', process.env.APD_CHROMIUM].find(p => p && fs.existsSync(p));
const launch = async () => chromium.launch(exe ? { executablePath: exe } : {});
let can = !!chromium; if (can) { try { const b = await launch(); await b.close(); } catch { can = false; } }
const opts = { skip: can ? false : 'no browser on this computer', timeout: 120000 };

async function open(dataDir, modules = ['accounts']) {
  const desk = await createDesk({ dataDir, port: 0, quiet: true, env: {}, modules });
  desk.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1'); desk.core.settings.set('router.enabled', false);
  await desk.start();
  const call = async (p, body) => (await fetch(desk.url() + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-apd-session': desk.session }, body: body ? JSON.stringify(body) : undefined })).json();
  return { desk, call };
}
/** A desk set up by `before` (with the page's token), then restarted: the restart is what the owner meets. */
async function restarted(before, modules) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-lockpage-'));
  const a = await open(dataDir, modules);
  await before(a);
  await a.desk.stop();
  const b = await open(dataDir, modules);
  return { ...b, async close() { await b.desk.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const loaded = (page) => page.waitForFunction(() => (window.apd?.state?.agents?.length || 0) > 0 && !document.getElementById('apd-lock'), null, { timeout: 15000 });

test('a restarted desk: no PIN, the lock PIN only, the own PIN only, and both each end on a desk that has loaded', opts, async () => {
  const browser = await launch();
  try {
    for (const [lockPin, ownPin] of [[false, false], [true, false], [false, true], [true, true]]) {
      const name = `lock PIN ${lockPin ? 'on' : 'off'}, own PIN ${ownPin ? 'on' : 'off'}`;
      const d = await restarted(async (a) => {
        await a.call('/api/settings', { onboarded: true, 'ui.firstStep': 'saved' });
        if (lockPin) { await a.call('/api/modules/accounts/on', {}); assert.equal((await a.call('/api/m/accounts/pin', { pin: '4826' })).hasPin, true); }
        if (ownPin) assert.equal((await a.call('/api/people/me/pin', { pin: '2468' })).ok !== false, true);
      });
      const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(d.desk.url() + '/');
        if (ownPin) {
          await page.waitForSelector('#chooser .person', { timeout: 10000 });
          await page.click('#chooser .person');
          await page.waitForSelector('#chooser .pinf');
          assert.match(await page.textContent('#chooser'), /Enter your own PIN/, name + ': the chooser says it wants the person\'s own PIN');
          await page.fill('#chooser .pinf', '2468'); await page.keyboard.press('Enter');
          await page.waitForLoadState('load');
        }
        if (lockPin) {
          await page.waitForSelector('#apd-lock', { timeout: 10000 });
          assert.match(await page.textContent('#apd-lock'), /lock PIN/, name + ': the lock says it wants the lock PIN');
          await page.fill('#lock-pin', '4826'); await page.click('#lock-unlock');
        }
        await loaded(page);
        assert.equal(await page.$('#apd-lock'), null, name);
        assert.ok(await page.isHidden('#chooser'), name + ': the chooser is closed');
        assert.deepEqual(errors, [], name);
      } finally { await page.context().close(); await d.close(); }
    }
  } finally { await browser.close(); }
});

test('first start behind the lock: after the unlock, step two shows the real spend limits, not "no usual limits", and no "locked" line stays', opts, async () => {
  const d = await restarted(async (a) => {
    await a.call('/api/settings', { currency: 'USD', timeZone: 'America/New_York', onboarded: true, 'ui.firstStep': 'open' });   // the role step done, step two open
    await a.call('/api/modules/accounts/on', {}); await a.call('/api/m/accounts/pin', { pin: '4826' });
  }, ['accounts', 'chat', 'agents']);   // the chat page behind the lock: it must not call the shut desk and leave a "locked" toast
  const browser = await launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 }, timezoneId: 'America/New_York' })).newPage();
    await page.goto(d.desk.url() + '/');
    await page.waitForSelector('#apd-lock', { timeout: 10000 });
    await page.fill('#lock-pin', '4826'); await page.click('#lock-unlock');
    await loaded(page);
    await page.waitForSelector('[data-apd="spend-limits"]', { timeout: 10000 });
    const words = await page.textContent('[data-apd="spend-limits"]');
    assert.match(words, /\$25 an item, \$50 a day and \$200 a month/, words);
    assert.doesNotMatch(await page.textContent('body'), /no usual limits|The desk is locked/);
  } finally { await browser.close(); await d.close(); }
});
