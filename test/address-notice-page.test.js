// A model address that is not on this PC or the owner's network is saved, and the desk says at once, beside the field
// where it was saved, that Offline does not call it. An address on the owner's network saves with no such line.
// In a real browser on the Models page (Nodes). Skipped when no browser is here.
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

test('Models › Nodes: an outside address is saved and the reason Offline skips it shows beside the field', opts, async () => {
  const t = await testDesk({ modules: ['models'] });
  t.core.settings.set('onboarded', true);
  const browser = await launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
    await page.goto(t.base + '/#/models');
    await page.click('button[role="tab"]:has-text("Nodes")');
    const add = async (address) => {
      await page.fill('input[placeholder^="Address"]', address);
      await page.click('button:has-text("Add")');
    };
    await add('192.168.1.20:11434');
    await page.waitForFunction(() => (window.apd.state.settings['network.lanNodes'] || []).length === 1, null, { timeout: 15000 });
    await page.waitForSelector('[data-apd="nodes-what"]');
    assert.equal(await page.$('[data-apd="node-notice"]'), null, 'an address on the owner\'s network: no notice');
    await add('8.8.8.8:11434');
    await page.waitForSelector('[data-apd="node-notice"]', { timeout: 15000 });
    const words = await page.textContent('[data-apd="node-notice"]');
    assert.match(words, /^Saved\. While the desk is offline, 8\.8\.8\.8 is not called, because it is not on this PC or your own network\./, words);
    assert.equal(t.core.settings.get('network.lanNodes').length, 2, 'it was saved');
  } finally { await browser.close(); await t.close(); }
});
