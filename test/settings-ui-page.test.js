// The shell and Settings in a real browser: the place is picked from lists and found by city or country, first start
// shows the place row and keeps step two over a reload, and no "null" reaches the screen. Skipped when no browser is here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from './helpers/desk.js';

const req = createRequire(import.meta.url);
let chromium = null; try { ({ chromium } = req('playwright-core')); } catch {}
const exe = ['/opt/pw-browsers/chromium', process.env.APD_CHROMIUM].find(p => p && fs.existsSync(p));
const launch = async () => chromium.launch(exe ? { executablePath: exe } : {});
let can = !!chromium; if (can) { try { const b = await launch(); await b.close(); } catch { can = false; } }
const opts = { skip: can ? false : 'no browser on this computer', timeout: 90000 };

async function open(t, hash = '', { timezoneId = 'Europe/London' } = {}) {
  const browser = await launch();
  const page = await (await browser.newContext({ timezoneId, viewport: { width: 1366, height: 768 } })).newPage();
  await page.goto(t.base + '/' + hash);
  await page.waitForLoadState('networkidle');
  return { browser, page };
}
const options = (page, sel) => page.$$eval(sel + ' option', os => os.map(o => o.value));

test('where you are: the four are lists, and the time zone is found by a city or a country in its current name', opts, async () => {
  const t = await testDesk();
  t.core.settings.set('onboarded', true);
  const { browser, page } = await open(t, '#/settings/general');
  try {
    await page.waitForSelector('select[data-key="timeZone"]');
    for (const k of ['country', 'currency', 'timeZone', 'locale']) {
      assert.equal(await page.locator(`select[data-key="${k}"]`).count(), 1, k + ' is a list');
      assert.equal(await page.locator(`input[data-key="${k}"]`).count(), 0, k + ' is not a text box');
    }
    const lands = await page.$$eval('select[data-key="country"] option', os => os.map(o => o.textContent));
    assert.equal(new Set(lands).size, lands.length, 'no country is listed twice');
    const find = page.locator('.tzfind');
    const zones = await options(page, 'select[data-key="timeZone"]');
    assert.ok(zones.includes('Asia/Kolkata') && zones.includes('Europe/Kyiv'), 'today\'s names');
    assert.ok(!zones.includes('Asia/Calcutta') && !zones.includes('Europe/Kiev'), 'no old names');
    for (const [typed, zone] of [['Kyiv', 'Europe/Kyiv'], ['Kolkata', 'Asia/Kolkata'], ['Mumbai', 'Asia/Kolkata'], ['Delhi', 'Asia/Kolkata']]) {
      await find.fill(typed);
      assert.ok((await options(page, 'select[data-key="timeZone"]')).includes(zone), `${typed} finds ${zone}`);
    }
    await find.fill('India');
    const india = await options(page, 'select[data-key="timeZone"]');
    assert.ok(india.indexOf('Asia/Kolkata') >= 0 && india.indexOf('Asia/Kolkata') <= 1, 'India comes before the Indiana zones: ' + india.slice(0, 3));
    // picking one saves it
    await find.fill('Kyiv');
    await page.selectOption('select[data-key="timeZone"]', 'Europe/Kyiv');
    await page.waitForFunction(() => document.querySelector('select[data-key="timeZone"]')?.closest('.field')?.textContent.includes('Saved'), null, { timeout: 5000 });
    assert.equal(t.core.settings.get('timeZone'), 'Europe/Kyiv');
  } finally { await browser.close(); await t.close(); }
});

test('first start: the place row asks "Is this right?", the role saves the place, and step two comes back after a reload', opts, async () => {
  const t = await testDesk();
  const { browser, page } = await open(t, '', { timezoneId: 'Asia/Kolkata' });
  try {
    await page.waitForSelector('#onb-place');
    const words = await page.textContent('#onb-place');
    assert.match(words, /Is this right\?/);
    assert.match(words, /Asia\/Kolkata/, 'the browser zone in its current name');
    assert.doesNotMatch(words, /Calcutta|null|undefined/);
    await page.locator('#roles button.role').first().click();
    await page.waitForFunction(() => document.body.innerText.includes('Save'), null, { timeout: 10000 });
    assert.equal(t.core.settings.get('ui.firstStep'), 'open');
    assert.equal(t.core.settings.get('timeZone'), 'Asia/Kolkata');
    assert.equal(t.core.settings.stored('country'), true, 'the place shown is saved with the role');
    const before = await page.innerText('#onb');
    assert.doesNotMatch(before, /\bnull\b|undefined|NaN/, 'no empty part is written out');
    await page.reload(); await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !document.querySelector('#onb')?.hidden, null, { timeout: 10000 });
    assert.equal(await page.isVisible('#onb'), true, 'step two is still there');
  } finally { await browser.close(); await t.close(); }
});

test('waiting for you: an install card names its rows in plain words, shows the size, leaves the bookkeeping out, and no "null"', opts, async () => {
  const t = await testDesk();
  t.core.settings.set('onboarded', true);
  const asked = t.core.approval.request({ action: 'install', title: 'Get the local model', agentId: null, payload: { kind: 'download', what: 'model', sha256: 'ab'.repeat(32), url: 'https://example.com/m.gguf', file: 'm.gguf', size: 2147483648 } });
  const { browser, page } = await open(t);
  try {
    await page.waitForSelector('#waiting:not([hidden])', { timeout: 10000 });
    await page.click('#waiting');
    await page.waitForFunction(() => document.body.innerText.includes('Get the local model'), null, { timeout: 5000 });
    const card = await page.evaluate(() => [...document.querySelectorAll('.card')].find(c => c.innerText.includes('Get the local model'))?.innerText || '');
    assert.match(card, /From/); assert.match(card, /Saved as/); assert.match(card, /Size/);
    assert.match(card, /2(\.0)? GB/, 'the size in plain units: ' + card);
    assert.doesNotMatch(card, /sha256|\bkind\b|\bwhat\b|abababab/, 'no bookkeeping');
    const pop = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(pop, /\bnull\b|undefined|NaN|\[object Object\]/);
  } finally {
    for (const a of t.core.approval.listPending()) t.core.approval.decide(a.id, 'deny', 'owner');
    await asked.catch(() => {});
    await browser.close(); await t.close();
  }
});
