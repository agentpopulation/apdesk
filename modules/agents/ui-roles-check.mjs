// Screen check of roles and own names in a real browser (stand-in model): the team list by role, the hire box with a role
// whose module is off, a hire with no name, the hello note's "Give me a name" button and its answer, first start for a
// small business owner with roles to hire, and the quiet "Custom" tag. 1366x768 and 390x844, dark and light.
// Run from the repository root:  node modules/agents/ui-roles-check.mjs [shotsDir]    (exit code 1 when a check fails)
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-roles-ui'); fs.mkdirSync(out, { recursive: true });
let fails = 0; const check = (name, ok, ev = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(ev).slice(0, 300)}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BAD = /\bnull\b|\bundefined\b|\bNaN\b|\[object|\b(Coordinator|Scout|Closer|Operator|keeper)\b/;
const exe = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const sizes = [[1366, 768], [390, 844]], themes = ['light', 'dark'];
const pageAt = async (t, w, hgt, theme) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1 }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript((th) => { try { localStorage.setItem('apd-theme', th); } catch {} }, theme);
  t.core.settings.set('theme', theme); t.core.settings.set('ui.themeChosen', true);
  return { ctx, p, errs };
};
try {
  // ---- 1. the Agents page, the hire box, the name button
  const t = await testDesk({ modules: ['agents', 'chat', 'calendar', 'models', 'memory', 'browser', 'tasks'] });
  try {
    t.core.settings.set('onboarded', true); t.core.settings.set('ui.firstStep', 'skipped');
    await t.call('/api/agents/closer', { method: 'PATCH', body: { name: 'Kent' } });
    for (const [w, hgt] of sizes) for (const theme of themes) {
      const { ctx, p, errs } = await pageAt(t, w, hgt, theme);
      const tag = `${w}x${hgt} ${theme}`;
      await p.goto(t.base + '/#/agents/closer/profile'); await p.waitForSelector('#a-list .acard'); await sleep(900);
      const names = await p.$$eval('#a-list .acard .ac-n b', els => els.map(e => e.textContent));
      check(`${tag}: the team is shown by role, with the own name beside it`, JSON.stringify(names) === JSON.stringify(['Manager', 'Researcher', 'Kent · Sales expert', 'Operations expert', 'Coder']), names.join(' | '));
      const head = await p.textContent('#a-det .wh-t h3'); const role = await p.textContent('[data-apd="role-name"]').catch(() => '');
      check(`${tag}: the agent page heads with "Kent · Sales expert" and shows the role`, head === 'Kent · Sales expert' && role === 'Sales expert', `${head} / ${role}`);
      await p.screenshot({ path: path.join(out, `agents-team_${w}x${hgt}_${theme}.png`) });
      await p.getByRole('button', { name: 'Hire an agent' }).click(); await p.waitForSelector('#modal select'); await sleep(300);
      const opts = await p.$$eval('#modal select option', els => els.map(e => e.textContent));
      check(`${tag}: the hire box offers the roles, Secretary saying it needs Calendar`, opts.includes('AI Co-founder') && opts.includes('Finance expert') && opts.some(o => o === 'Secretary (needs Calendar)') && opts.at(-1) === 'Your own role' && !opts.some(o => /Sales lead/.test(o)), opts.join(' | '));
      const name0 = await p.inputValue('#modal input[type="text"]');
      check(`${tag}: the name box holds a suggested name he can change`, /^[A-Z][a-z]+$/.test(name0), name0);
      await p.selectOption('#modal select', 'secretary'); await sleep(200);
      const blocked = await p.textContent('[data-apd="hire-blocked"]').catch(() => '');
      check(`${tag}: a role whose module is off says which module to switch on`, /Switch on Calendar in Settings › Modules first/.test(blocked), blocked);
      await p.selectOption('#modal select', 'finance'); await sleep(200);
      const about = await p.textContent('[data-apd="hire-about"]');
      check(`${tag}: the chosen role says what it does and what it is good at`, /Invoices, money in and out, prices/.test(about) && /Good at: Invoice follow-up, Cash view, Quotation draft\./.test(about), about);
      await p.screenshot({ path: path.join(out, `agents-hire_${w}x${hgt}_${theme}.png`) });
      const all = await p.evaluate(() => document.body.innerText);
      check(`${tag}: no old code names, ids or empty words on screen`, !BAD.test(all), (all.match(BAD) || [''])[0]);
      await p.getByRole('button', { name: 'Cancel' }).click();
      check(`${tag}: no page errors`, errs.length === 0, errs.join(' | '));
      await ctx.close();
    }
    // a hire with no name, then its hello note's button (the card drawn on its own: the chat page is another builder's)
    const { ctx, p, errs } = await pageAt(t, 1366, 768, 'light');
    await p.goto(t.base + '/#/agents'); await p.waitForSelector('#a-list .acard'); await sleep(600);
    await p.getByRole('button', { name: 'Hire an agent' }).click(); await p.waitForSelector('#modal select');
    await p.selectOption('#modal select', 'writer'); await p.fill('#modal input[type="text"]', '');
    await p.locator('#modal').getByRole('button', { name: 'Hire' }).click(); await sleep(1200);
    const toast = await p.evaluate(() => document.querySelector('.toast, #toast')?.textContent || '');
    const w = t.core.agents.get('writer');
    check('a hire with an empty name joins as its role alone, and says so', w && w.name === 'Writer' && /^Writer joined\./.test(toast), `${w?.name} / ${toast}`);
    const note = (await t.call('/api/m/chat/chats/dm-writer/messages')).json.messages[0];
    check('its hello note carries the "Give me a name" button (Chat draws it for a note posted with welcome: true)', note?.cards?.[0]?.actions?.[0]?.nameAgent === 'writer', JSON.stringify(note?.cards));
    await p.setViewportSize({ width: 1366, height: 768 });
    const btn = p.getByRole('button', { name: 'Give me a name' });
    check('the hello note shows a small "Give me a name" button', await btn.count() === 1);
    await btn.click(); await p.waitForSelector('#modal input'); await p.fill('#modal input', 'Hugo'); await p.locator('#modal').getByRole('button', { name: 'Save' }).click(); await sleep(800);
    const said = await p.textContent('[data-apd="give-name"]');
    check('the button saves the name and answers back truthfully', /Saved\. I am Hugo · Writer now\./.test(said) && t.core.agents.get('writer').name === 'Hugo', said);
    await p.screenshot({ path: path.join(out, 'hello-name-saved_1366x768_light.png') });
    check('name button: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  } finally { await t.close(); }

  // ---- 2. first start: a small business owner first, with roles to hire; the Custom tag in Settings › Modules
  for (const [w, hgt] of sizes) for (const theme of themes) {
    const t = await testDesk({ modules: ['agents', 'chat', 'models', 'tasks', 'sales', 'calendar'] });
    const { ctx, p, errs } = await pageAt(t, w, hgt, theme);
    const tag = `${w}x${hgt} ${theme}`;
    try {
      await p.goto(t.base + '/#/home'); await p.waitForSelector('#roles .role'); await sleep(500);
      const first = await p.textContent('#roles .role >> nth=0');
      check(`${tag}: first start offers the small business owner first`, /^Small business owner/.test(first) && /Sales, customers, invoices, marketing/.test(first), first);
      await p.screenshot({ path: path.join(out, `first-start-roles_${w}x${hgt}_${theme}.png`) });
      await p.click('#roles .role[data-role="business"]'); await p.waitForSelector('#onb-about'); await sleep(600);
      const team = await p.textContent('#onb .ticks');
      const ph = await p.getAttribute('#onb-about', 'placeholder');
      check(`${tag}: the team shows the Manager and roles to hire for invoices, marketing and customers`, /Manager/.test(team) && /Finance expert/.test(team) && /Marketing expert/.test(team) && /Customer care expert/.test(team) && !BAD.test(team), team.slice(0, 200));
      check(`${tag}: the example fits a small business anywhere`, /bakery/i.test(ph) && !/India|GST|₹/.test(ph), ph);
      await p.screenshot({ path: path.join(out, `first-start-team_${w}x${hgt}_${theme}.png`), fullPage: false });
      if (w === 1366 && theme === 'light') {
        await p.locator('#onb').getByRole('button', { name: 'Save' }).click(); await sleep(1500);
        const ids = t.core.agents.list().map(a => a.id);
        check('Save hires the ticked roles by role, with no own name', ['finance', 'marketing', 'customer-care'].every(id => ids.includes(id)) && t.core.modules.api('agents').agentLine('finance') === 'Finance expert', ids.join(','));
        // the quiet Custom tag beside a module the owner added (the module list's custom field), nothing when it is missing
        await p.evaluate(() => { location.hash = '#/settings/modules'; }); await sleep(900);
        await p.evaluate(() => { const m = window.apd.state.modules.find(x => x.id === 'calendar'); if (m) m.custom = true; }); await p.evaluate(() => { location.hash = '#/settings/general'; }); await sleep(300); await p.evaluate(() => { location.hash = '#/settings/modules'; }); await sleep(900);
        const tags = await p.$$eval('[data-apd="custom-tag"]', els => els.map(e => [e.textContent, getComputedStyle(e).fontWeight]));
        check('Settings › Modules: a quiet "Custom" tag, not bold, only beside the custom module', tags.length === 1 && tags[0][0] === 'Custom' && Number(tags[0][1]) < 600, JSON.stringify(tags));
        await p.screenshot({ path: path.join(out, 'settings-modules-custom_1366x768_light.png') });
      }
      check(`${tag}: first start, no page errors`, errs.length === 0, errs.join(' | '));
    } finally { await ctx.close(); await t.close(); }
  }
} finally { await browser.close(); }
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
