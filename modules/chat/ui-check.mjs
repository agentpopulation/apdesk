// Chat and Agents pages in a real browser: layout at 1920x1080 and 1366x768 in both themes, the panel folds,
// a real reply shows the agent and model, ask 6 with the browser closed and reopened, Agents tabs and deep link.
// node modules/chat/ui-check.mjs [screenshot dir]
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-chat-ui'); fs.mkdirSync(out, { recursive: true });
const want = ['chat', 'agents', 'models', 'memory', 'browser', 'files'].filter(id => fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', id, 'module.json')));
const t = await testDesk({ real: true, modules: want });
t.core.settings.set('provider.gemini.model', process.env.APD_GEMINI_MODEL || 'gemini-3.5-flash-lite');
t.core.settings.set('onboarded', true);
const results = []; const check = (name, ok, ev) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(ev || '').replace(/\s+/g, ' ').slice(0, 240)}`); };
const browser = await chromium.launch();
const errors = [];
const newPage = async (w, h) => { const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/favicon|net::ERR/.test(m.text())) errors.push(m.text()); }); return { ctx, p }; };
const geo = (p) => p.evaluate(() => {
  const r = (s) => document.querySelector(s)?.getBoundingClientRect();
  const v = r('#view'), rail = r('.rail'), talk = r('.talk'), dr = r('#drawer'), msg = [...document.querySelectorAll('.msg.it')].pop()?.getBoundingClientRect();
  return { scroll: document.documentElement.scrollHeight - innerHeight, rail: rail?.width, talk: talk?.width, drawer: dr?.width, view: v?.width, padL: parseFloat(getComputedStyle(document.querySelector('.talk')).paddingLeft), padR: parseFloat(getComputedStyle(document.querySelector('.talk')).paddingRight), chatOverflow: getComputedStyle(document.querySelector('#chat')).overflowY, msgMax: msg?.width };
});
try {
  let { ctx, p } = await newPage(1920, 1080);
  await p.goto(t.base + '/#/chat/everyone'); await p.waitForSelector('#chat'); await p.waitForTimeout(500);
  let g = await geo(p);
  check('1920x1080: three columns, conversation fills the space between them (20px padding), no page scroll', g.scroll <= 0 && Math.abs(g.rail - 230) < 2 && Math.abs(g.drawer - 290) < 3 && Math.abs(g.talk - (g.view - g.rail - g.drawer)) < 3 && g.padL === 20 && g.padR === 20, JSON.stringify(g));
  await p.click('.talk .hd .mini'); await p.waitForTimeout(450);
  const g2 = await geo(p);
  check('panel folds away and the conversation widens', g2.drawer < 2 && g2.talk > g.talk + 280, `drawer ${g2.drawer}, talk ${g.talk} -> ${g2.talk}`);
  await p.click('.talk .hd .mini'); await p.waitForTimeout(450);
  // a real reply on screen, with the agent and the model named
  await p.fill('#ask', 'What is the capital of Japan? One word.'); await p.press('#ask', 'Enter');
  await p.waitForFunction(() => { const m = [...document.querySelectorAll('.msg.it')].pop(); return m && /tokyo/i.test(m.textContent) && m.querySelector('.mdl'); }, null, { timeout: 90000 }).catch(() => {});
  const who = await p.evaluate(() => [...document.querySelectorAll('.msg.it')].pop()?.querySelector('.who')?.textContent || '');
  const said = await p.evaluate(() => [...document.querySelectorAll('.msg.it')].pop()?.textContent || '');
  check('ask 1 on screen: the reply shows the agent and the model that answered', /^Coordinator · .+·|^Coordinator · (Google Gemini|Agent Population Router|OpenRouter)/.test(who) && /tokyo/i.test(said), `"${who}" · ${said.slice(who.length, who.length + 60)}`);
  // ask 10 regression on a slow model (the free router): sending while a reply streams, and right after a stop, always sends
  await t.call('/api/agents/coordinator', { method: 'PATCH', body: { model: { main: { provider: 'router' } } } });
  await p.evaluate(() => { location.hash = '#/chat/dm-coordinator'; }); await p.waitForTimeout(800);
  await p.fill('#ask', 'Please write about 250 words on the history of the printing press.'); await p.press('#ask', 'Enter');
  await p.waitForFunction(() => [...document.querySelectorAll('#form .btn')].pop().textContent === 'Stop', null, { timeout: 10000 }).catch(() => {});
  const stopShown = await p.locator('#form .btn').last().innerText();
  await p.waitForTimeout(1500);
  await p.fill('#ask', 'What is 2 plus 2? Answer with one word.');
  const sendShown = await p.locator('#form .btn').last().innerText();
  await p.press('#ask', 'Enter');
  await p.waitForTimeout(400);
  const q = await p.evaluate(() => ({ queued: !!document.querySelector('.msg[data-role=queued]') && /Waiting to send/.test(document.querySelector('.msg[data-role=queued]').textContent), box: document.querySelector('#ask').value, firstStatus: [...document.querySelectorAll('.msg[data-role=assistant]')].pop()?.dataset.status }));
  check('ask 10: Enter while a reply streams never stops it; the message waits as "Waiting to send"', stopShown === 'Stop' && /Send/.test(sendShown) && q.queued && q.box === '' && q.firstStatus === 'streaming', JSON.stringify({ stopShown, sendShown, ...q }));
  await p.waitForFunction(() => [...document.querySelectorAll('.msg[data-role=user]')].some(m => /2 plus 2/.test(m.textContent)), null, { timeout: 180000 }).catch(() => {});
  const st1 = await p.evaluate(() => ({ sent: [...document.querySelectorAll('.msg[data-role=user]')].some(m => /2 plus 2/.test(m.textContent)), queuedLeft: !!document.querySelector('.msg[data-role=queued]'), statuses: [...document.querySelectorAll('.msg[data-role=assistant]')].map(m => m.dataset.status) }));
  check('ask 10: when that reply ends, the waiting message goes out by itself; the first reply was not stopped', st1.sent && !st1.queuedLeft && st1.statuses[0] === 'done', JSON.stringify(st1));
  await p.waitForFunction(() => { const m = [...document.querySelectorAll('.msg[data-role=assistant]')].pop(); return m && m.dataset.status !== 'streaming' && /4|four/i.test(m.textContent); }, null, { timeout: 120000 }).catch(() => {});
  // Stop with an empty box, then type and send at once
  await p.fill('#ask', 'Please write about 250 words on the history of the telescope.'); await p.press('#ask', 'Enter');
  await p.waitForFunction(() => [...document.querySelectorAll('#form .btn')].pop().textContent === 'Stop', null, { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(800);
  await p.locator('#form .btn', { hasText: 'Stop' }).click();
  await p.waitForTimeout(300);
  const stoppedNow = await p.evaluate(() => [...document.querySelectorAll('.msg[data-role=assistant]')].pop()?.dataset.status);
  await p.fill('#ask', 'Name one colour of the rainbow. One word.'); await p.press('#ask', 'Enter');
  await p.waitForFunction(() => [...document.querySelectorAll('.msg[data-role=user]')].some(m => /colour of the rainbow/.test(m.textContent)), null, { timeout: 20000 }).catch(() => {});
  const st2 = await p.evaluate(() => ({ sent: [...document.querySelectorAll('.msg[data-role=user]')].some(m => /colour of the rainbow/.test(m.textContent)), box: document.querySelector('#ask').value }));
  check('ask 10: a click on Stop stops at once; the next message right after goes out', stoppedNow === 'stopped' && st2.sent && st2.box === '', JSON.stringify({ stoppedNow, ...st2 }));
  await p.waitForFunction(() => { const m = [...document.querySelectorAll('.msg[data-role=assistant]')].pop(); return m && m.dataset.status !== 'streaming'; }, null, { timeout: 120000 }).catch(() => {});
  const lastReply = await p.evaluate(() => [...document.querySelectorAll('.msg[data-role=assistant]')].pop()?.textContent || '');
  check('the message sent after a stop gets its own real answer', /red|orange|yellow|green|blue|indigo|violet/i.test(lastReply), lastReply.slice(0, 120));
  await p.screenshot({ path: path.join(out, 'chat-stop-then-send_1920x1080_light.png') });
  await t.call('/api/agents/coordinator', { method: 'PATCH', body: { model: { main: null } } });
  await p.evaluate(() => { location.hash = '#/chat/everyone'; }); await p.waitForTimeout(600);
  const under = await p.locator('.under').innerText();
  check('controls under the box: online, model chip, security chip, auto-approve, attach', /Online/.test(under) && /Open|Careful|Strict/.test(under) && /Auto-approve/.test(under) && /Attach/.test(under) && !/…/.test(under), under.replace(/\n/g, ' | '));
  await p.click('#lvl-chip'); await p.waitForTimeout(400);
  check('security chip opens Settings › Security and does not change the level', /#\/settings\/security/.test(p.url()) && t.core.settings.get('security.level') === 'open', p.url());
  for (const [w, hgt] of [[1920, 1080], [1366, 768]]) for (const theme of ['light', 'dark']) {
    await p.setViewportSize({ width: w, height: hgt });
    await p.evaluate((th) => window.apd.setTheme(th === 'dark'), theme);
    for (const pg of ['chat/everyone', 'agents/scout/profile', 'agents/scout/tools']) {
      await p.evaluate((x) => { location.hash = '#/' + x; }, pg); await p.waitForTimeout(700);
      const s = await p.evaluate(() => ({ scroll: document.documentElement.scrollHeight - innerHeight, bodyW: document.documentElement.scrollWidth - innerWidth }));
      const name = `${pg.replace(/\//g, '-')}_${w}x${hgt}_${theme}.png`; await p.screenshot({ path: path.join(out, name) });
      if (pg.startsWith('chat')) { const gg = await geo(p); check(`${w}x${hgt} ${theme} chat: no page scroll, full width conversation`, s.scroll <= 0 && s.bodyW <= 0 && Math.abs(gg.talk - (gg.view - gg.rail - gg.drawer)) < 3, `scroll ${s.scroll}, talk ${Math.round(gg.talk)} of ${Math.round(gg.view)}`); }
      else check(`${w}x${hgt} ${theme} ${pg}: no page scroll`, s.scroll <= 0 && s.bodyW <= 0, `scroll ${s.scroll}`);
    }
  }
  await p.setViewportSize({ width: 1920, height: 1080 });
  await p.evaluate(() => { location.hash = '#/agents/scout/profile'; }); await p.waitForTimeout(700);
  const tabs = await p.locator('#a-det .seg button').allTextContents();
  check('Agents: tabs in order Profile, Model, Tools and skills, Memory, Computer (those whose modules are on)', JSON.stringify(tabs) === JSON.stringify(['Profile', 'Model', 'Tools and skills', 'Memory', 'Computer'].filter(x => x === 'Profile' || x === 'Tools and skills' || (x === 'Model' && want.includes('models')) || (x === 'Memory' && want.includes('memory')) || (x === 'Computer' && want.includes('browser')))), tabs.join(', '));
  for (const tb of ['model', 'memory', 'computer']) { if (!tabs.length) break; await p.evaluate((x) => { location.hash = '#/agents/scout/' + x; }, tb); await p.waitForTimeout(900); const txt = await p.locator('#a-det').innerText(); check(`Agents deep link #/agents/scout/${tb} renders`, !/could not open|hit an error/.test(txt) && txt.length > 40, txt.split('\n').slice(3, 6).join(' | ')); await p.screenshot({ path: path.join(out, `agents-scout-${tb}_1920x1080_dark.png`) }); }

  // cards: markdown links in table cells, a row action with '$row', a draft whose button resolves the approval (nothing is sent)
  const got = [];
  t.core.modules.tools.set('fx_draft', { module: 'sales', name: 'fx_draft', description: 'fixture', parameters: { type: 'object', properties: {} }, async run(args) { got.push(args); return { ok: true, text: 'Draft made (fixture).' }; } });
  t.core.modules.api('chat').postCard('sales-room', { kind: 'table', title: 'Leads', columns: ['Company', 'Source'], rows: [['Kaveri Foods', '[Kaveri news](https://example.com/kaveri)'], ['Deccan Motors', 'https://example.org/deccan']], rowIds: ['lead_1', 'lead_2'], rowActions: [{ label: 'Draft', tool: 'fx_draft', args: { leadIds: ['$row'] } }], agentId: 'closer' });
  const pend = t.core.approval.request({ agentId: 'closer', chatId: 'sales-room', action: 'send.person', title: 'Send mail to kaveri@example.com', payload: { to: 'kaveri@example.com' } });
  await new Promise(r => setTimeout(r, 200));
  const apr = t.core.approval.listPending().find(a => a.chatId === 'sales-room');
  t.core.modules.api('chat').postCard('sales-room', { kind: 'draft', title: 'Outreach to Kaveri Foods', to: 'kaveri@example.com', subject: 'A quick idea', body: 'Hello, ...', approvalId: apr?.id, agentId: 'closer' });
  await p.evaluate(() => { location.hash = '#/chat/sales-room'; }); await p.waitForTimeout(900);
  const link = await p.locator('#chat table a', { hasText: 'Kaveri news' }).first().getAttribute('target').catch(() => null);
  check('table cells render markdown links that open in a new tab', link === '_blank', `target ${link}`);
  await p.locator('#chat table button', { hasText: 'Draft' }).nth(1).click(); await p.waitForTimeout(700);
  check("a row action replaces '$row' with that row's id", JSON.stringify(got[0]) === JSON.stringify({ leadIds: ['lead_2'] }), JSON.stringify(got[0]));
  await p.locator('#chat .card button', { hasText: 'Approve and send' }).first().click();
  const dec = await pend;
  await p.waitForTimeout(500);
  check('draft card: "Approve and send" resolves the approval through the owner route; the card itself sends nothing', dec.ok && dec.how === 'owner', JSON.stringify(dec));
  await p.screenshot({ path: path.join(out, 'chat-cards-sales-room_1920x1080_dark.png') });

  // ask 6 in a real browser: a job from the chat, the browser goes away, comes back to finished work
  await p.evaluate(() => { location.hash = '#/chat/build-room'; }); await p.waitForTimeout(600);
  let release; const gate = new Promise(r => { release = r; });
  const job = await t.core.jobs.start({ kind: 'fixture.compare', title: 'Compare three laptops', agentId: 'coder', chatId: 'build-room', run: async (j) => { j.progress(0.3, 'Reading three product pages'); await gate; j.progress(0.9, 'Writing the table'); return { text: 'The comparison is ready.', cards: [{ kind: 'table', title: 'Laptops', columns: ['Model', 'Price'], rows: [['A', '₹ 60,000'], ['B', '₹ 72,000'], ['C', '₹ 81,000']] }, { kind: 'file', path: 'tables/laptops.xlsx', name: 'laptops.xlsx', size: 9000 }] }; } });
  await p.waitForFunction(() => /Compare three laptops/.test(document.querySelector('#chat').textContent) && /Running/.test(document.querySelector('#chat').textContent), null, { timeout: 5000 }).catch(() => {});
  const sawRunning = await p.evaluate(() => /Running/.test(document.querySelector('#chat').textContent));
  await ctx.close();                                   // the browser goes away
  release(); await t.core.jobs.wait(job.id); await new Promise(r => setTimeout(r, 300));
  ({ ctx, p } = await newPage(1366, 768));
  await p.goto(t.base + '/#/chat/build-room'); await p.waitForSelector('#chat .msg'); await p.waitForTimeout(600);
  const back = await p.locator('#chat').innerText();
  check('ask 6 in a browser: job card live, browser closed, reopened: card says Done and the table and file are in the chat', sawRunning && /Compare three laptops/.test(back) && /Done/.test(back) && /The comparison is ready/.test(back) && /laptops\.xlsx/.test(back) && /₹ 72,000/.test(back), back.replace(/\n/g, ' | ').slice(-260));
  await p.screenshot({ path: path.join(out, 'chat-ask6-reopened_1366x768.png') });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
} catch (e) { check('ui check ran', false, e.stack); }
finally { await browser.close(); await t.close(); }
console.log('screenshots:', out);
process.exit(results.every(Boolean) ? 0 : 1);
