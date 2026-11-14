// Real check for Vault and Logins on a real desk and in a real browser (no model involved: the vault never calls one).
//   node modules/vault/real-check.mjs
// Run from the repository root. No model keys are needed.
import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';

const results = [];
const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(evidence).replace(/\s+/g, ' ').slice(0, 300)}`); };
const t = await testDesk({ real: true, modules: ['vault', 'store'] });
const PASS = 'correct-horse-battery-' + Date.now().toString(36);
try {
  check('ships switched off', (await t.call('/api/m/vault/logins')).status === 404, 'route answers 404 before switch-on');
  const on = (await t.call('/api/modules/vault/on', { method: 'POST' })).json;
  check('switch on from the store route', on?.on === true, `on: ${on?.on}`);
  // a browser: save and show a login in Settings › Keys and logins
  const { chromium } = createRequire(import.meta.url)('playwright');
  await t.call('/api/settings', { body: { onboarded: true } });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(t.base + '/#/settings/keys');
  await page.waitForSelector('#lg-site', { timeout: 15000 });
  await page.fill('#lg-site', 'https://shop.example.com/login'); await page.fill('#lg-user', 'owner.test@example.com'); await page.fill('#lg-pass', PASS);
  await page.click('#lg-save');
  await page.waitForSelector('[data-reveal]', { timeout: 10000 });
  const listed = (await page.locator('[data-reveal]').locator('xpath=../..').innerText()).replace(/\s+/g, ' ');
  check('save a login in the browser: listed masked', /shop\.example\.com/.test(listed) && !listed.includes(PASS) && !listed.includes('owner.test@'), listed.slice(0, 120));
  await page.click('[data-reveal]');
  await page.waitForFunction((p) => document.body.innerText.includes(p), PASS, { timeout: 5000 }).catch(() => {});
  check('read it back as the owner (Show)', await page.evaluate((p) => document.body.innerText.includes(p), PASS), 'password shown after the owner\'s click');
  const id = (await t.call('/api/m/vault/logins')).json.logins[0].id;
  const nonOwner = await t.call(`/api/m/vault/logins/${id}/reveal`, { method: 'POST', session: false });
  check('a request without the owner\'s session is refused', nonOwner.status === 403 && !nonOwner.text.includes(PASS), `${nonOwner.status} ${nonOwner.json?.error}`);
  const listJson = (await t.call('/api/m/vault/overview')).text;
  check('no route answer, event or list carries the value', !listJson.includes(PASS) && !JSON.stringify(t.core.modules.api('vault').list()).includes(PASS), 'overview and vault.list() checked');
  // master passphrase: sealed at rest, locked means unreadable
  const m = await t.call('/api/m/vault/master', { body: { passphrase: PASS + '!' } });
  t.core.storage.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const raw = fs.readFileSync(path.join(t.dataDir, 'apd.sqlite'));
  const sealedRow = t.core.storage.get("SELECT value FROM secrets WHERE kind = 'module:vault'").value;
  check('with a passphrase the password is sealed on disk', m.json?.hasMaster && !raw.includes(Buffer.from(PASS)) && sealedRow.startsWith('enc:v1:'), `stored as ${sealedRow.slice(0, 24)}…`);
  await t.call('/api/m/vault/lock', { method: 'POST' });
  const lockedRead = await t.call(`/api/m/vault/logins/${id}/reveal`, { method: 'POST' });
  const ap = t.core.approval.request({ action: 'login', title: 'Sign in to shop.example.com', agentId: 'operator', payload: { site: 'shop.example.com', loginId: id } });
  await new Promise(r => setTimeout(r, 50)); t.core.approval.decide(t.core.approval.listPending()[0].id, 'approve');
  let modRead = 'refused'; try { t.core.modules.api('vault').loginFor(id, (await ap).id); modRead = 'READ'; } catch (e) { modRead = e.message; }
  check('locked: not even the owner or a module can read it', lockedRead.status === 423 && modRead !== 'READ', `${lockedRead.status} ${lockedRead.json?.error} · a module holding a granted sign-in approval: ${modRead}`);
  const wrong = await t.call('/api/m/vault/unlock', { body: { passphrase: 'nope-nope-nope' } });
  const right = await t.call('/api/m/vault/unlock', { body: { passphrase: PASS + '!' } });
  const back = await t.call(`/api/m/vault/logins/${id}/reveal`, { method: 'POST' });
  const ap2 = t.core.approval.request({ action: 'login', title: 'Sign in to shop.example.com', agentId: 'operator', payload: { site: 'shop.example.com', loginId: id } });
  await new Promise(r => setTimeout(r, 50)); t.core.approval.decide(t.core.approval.listPending()[0].id, 'approve');
  let unlockedRead; try { unlockedRead = t.core.modules.api('vault').loginFor(id, (await ap2).id).password === PASS ? 'read' : 'wrong value'; } catch (e) { unlockedRead = e.message; }
  check('unlocked: a module holding a granted sign-in approval for this site reads the login', unlockedRead === 'read', unlockedRead);
  check('wrong passphrase refused, right one unlocks', wrong.status === 403 && right.json?.locked === false && back.json?.password === PASS, `wrong ${wrong.status}, right unlocked, value back`);
  // switch off: the data stays, the routes go
  await page.goto(t.base + '/#/settings/modules'); await page.waitForSelector('[data-module="vault"]', { timeout: 10000 });
  await page.click('[data-module="vault"]'); await page.waitForTimeout(800);
  const off = await t.call('/api/m/vault/logins');
  const kept = t.core.storage.get("SELECT COUNT(*) AS n FROM secrets WHERE kind = 'module:vault'").n;
  check('switch off in the Module Store: the routes go, the data stays', off.status === 404 && !t.core.modules.isOn('vault') && kept === 1, `route ${off.status}, ${kept} sealed login kept`);
  await t.call('/api/modules/vault/on', { method: 'POST' });
  const again = (await t.call('/api/m/vault/logins')).json;
  check('switch on again: the login is there and starts locked', again.logins.length === 1 && again.locked === true, `${again.logins[0]?.site} ${again.logins[0]?.user}, locked ${again.locked}`);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
} catch (e) { check('vault real check ran', false, e.stack); }
finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
