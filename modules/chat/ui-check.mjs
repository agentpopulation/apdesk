// Chat and Agents pages in a real browser: layout at 1920x1080 and 1366x768 in both themes, the panel folds,
// a real reply shows the agent and model, ask 6 with the browser closed and reopened, Agents tabs and deep link.
// node modules/chat/ui-check.mjs [screenshot dir]
// node modules/chat/ui-check.mjs --panel [--tag=before|after] [screenshot dir]   only the side panel and reply bubble checks (no model needed)
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const PANEL = process.argv.includes('--panel'); const TAG = (process.argv.find(a => a.startsWith('--tag=')) || '--tag=after').slice(6);
const out = process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(os.tmpdir(), 'apd-chat-ui'); fs.mkdirSync(out, { recursive: true });
const want = ['chat', 'agents', 'models', 'memory', 'browser', 'files'].filter(id => fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', id, 'module.json')));
const t = await testDesk({ real: !PANEL, modules: want });
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
if (PANEL) { try { await runPanel(); } catch (e) { check('panel check ran', false, e.stack); } await browser.close(); await t.close(); console.log('screenshots:', out); process.exit(results.every(Boolean) ? 0 : 1); }
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
  check('ask 1 on screen: the reply shows the agent and the model that answered', /^Coordinator · .+·|^Coordinator · (Google Gemini|Free API|OpenRouter)/.test(who) && /tokyo/i.test(said), `"${who}" · ${said.slice(who.length, who.length + 60)}`);
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

// ---- side panel (folds by itself, pin, icon) and the reply bubble
async function runPanel() {
  const LABEL = 'Free API · Meta-Llama-3_3-70B-Instruct (OVHcloud AI Endpoints)';
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const GROUP = [{ id: 9101, role: 'user', text: 'What should a small bakery that delivers to offices do this week to get three new office customers?', meta: {} },
    { id: 9102, role: 'assistant', agentId: 'scout', text: 'Look for offices within 3 km that order lunch in: their reviews and job posts name the team size.', label: 'Free API · gpt-oss-20b', meta: { groupOf: 'g1', steps: [{ tool: 'web_search', agentId: 'scout', status: 'done' }, { tool: 'web_search', agentId: 'scout', status: 'done' }, { tool: 'web_read', agentId: 'scout', status: 'done' }] } },
    { id: 9103, role: 'assistant', agentId: 'closer', text: 'Closer had nothing to add', meta: { groupOf: 'g1', passed: true } },
    { id: 9104, role: 'assistant', agentId: 'coder', text: 'Operator did not answer in time.', meta: { groupOf: 'g1', late: true } },
    { id: 9105, role: 'assistant', agentId: 'coordinator', text: 'Scout: start with nearby offices that already order in. Next: send a tasting box to three of them on Thursday.', label: 'Google Gemini · gemini-3.5-flash-lite', meta: { groupSummary: 'g1', of: ['scout', 'operator'] } }];
  const open = async (w, h, theme, hash, { reply = false, group = false, fixture = null } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.addInitScript((th) => { try { if (!sessionStorage.getItem('apd-init')) { localStorage.setItem('apd-theme', th); sessionStorage.setItem('apd-init', '1'); } } catch {} }, theme);
    t.core.settings.set('theme', theme); t.core.settings.set('onboarded', true);
    if (reply || group) await p.route(/\/m\/chat\/ratings/, (route) => route.request().method() === 'POST' ? route.fulfill({ json: { ok: true, rating: { targetType: 'answer', targetId: '9002', thumb: JSON.parse(route.request().postData() || '{}').thumb || null, research: JSON.parse(route.request().postData() || '{}').research || null, reasons: JSON.parse(route.request().postData() || '{}').reasons || [], comment: '' } } }) : route.fulfill({ json: { rating: null } }));
    if (group) await p.route(/\/chats\/[^/?]+\/messages/, async (route) => {
      const r = await route.fetch(); const j = await r.json();
      j.messages = GROUP.map((m, i) => ({ chatId: j.chat?.id, cards: [], status: 'done', label: null, at: Date.now() - 9000 + i * 1000, ...m }));
      await route.fulfill({ response: r, json: j });
    });
    if (reply) await p.route(/\/chats\/[^/?]+\/messages/, async (route) => {
      const r = await route.fetch(); const j = await r.json();
      j.messages = [{ id: 9001, chatId: j.chat?.id, role: 'user', text: 'Hello', cards: [], status: 'done', meta: {}, at: Date.now() - 5000 },
        { id: 9002, chatId: j.chat?.id, role: 'assistant', agentId: 'coordinator', text: reply === 'research' ? 'The VR200 pairs a Vera CPU with Rubin GPUs [1].' : 'Hello! How can I help you today?', cards: [], label: LABEL, status: 'done', meta: reply === 'research' ? { steps: [{ tool: 'web_search', agentId: 'scout', status: 'done' }, { tool: 'web_read', agentId: 'scout', status: 'done' }] } : {}, at: Date.now() - 4000 }];
      await route.fulfill({ response: r, json: j });
    });
    if (fixture) await p.route(/\/chats\/[^/?]+\/messages/, async (route) => {
      const r = await route.fetch(); const j = await r.json();
      j.messages = fixture.map((m, i) => ({ chatId: j.chat?.id, cards: [], status: 'done', label: null, meta: {}, at: Date.now() - 9000 + i * 1000, ...m }));
      await route.fulfill({ response: r, json: j });
    });
    await p.goto(t.base + '/#/' + hash); await p.waitForSelector('#chat'); await p.waitForTimeout(400);
    return { ctx, p };
  };
  const dw = (p) => p.evaluate(() => document.querySelector('#drawer').getBoundingClientRect().width);
  const folded = async (p, ms) => { const t0 = Date.now(); await p.waitForFunction(() => document.querySelector('#drawer').getBoundingClientRect().width < 2, null, { timeout: ms }).catch(() => {}); return Date.now() - t0; };
  const away = async (p, x) => { await p.mouse.move(x, 300); await p.evaluate(() => document.activeElement?.blur()); };
  const composerClear = (p) => p.evaluate(() => {
    const vw = innerWidth, vh = innerHeight; const ok = [];
    for (const el of [document.querySelector('#ask'), [...document.querySelectorAll('#form .btn')].pop()]) {
      const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      ok.push(r.left >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5 && r.width > 20 && (top === el || el.contains(top)));
    }
    return ok.every(Boolean) && document.documentElement.scrollWidth <= innerWidth + 1;
  });
  for (const theme of ['light', 'dark']) {
    for (const [w, h] of [[1366, 768], [390, 844]]) {
      const tag = `${w}x${h} ${theme}`; const name = (s) => path.join(out, `chat-panel_${s}_${TAG}_${w}x${h}_${theme}.png`);
      const { ctx, p } = await open(w, h, theme, 'chat/everyone');
      if (TAG === 'before') { await p.waitForTimeout(4500); await p.screenshot({ path: name('1-open') }); await ctx.close(); continue; }   // screenshots only, for a before and after
      if (w > 860) {
        check(`${tag}: panel is shown when the chat opens`, await dw(p) > 250, `width ${await dw(p)}`);
        await p.screenshot({ path: name('1-open') });
        const ms = await folded(p, 6000);
        check(`${tag}: panel folds by itself after about 3 seconds`, ms > 1500 && ms < 5000 && await dw(p) < 2, `${ms} ms`);
        await p.waitForTimeout(400);
        const icon = p.getByRole('button', { name: 'Show the panel' });
        check(`${tag}: icon named "Show the panel" with that hover text shows when folded`, await icon.isVisible() && await icon.getAttribute('title') === 'Show the panel');
        check(`${tag}: first fold shows the one-line hint`, await p.getByText('The panel folded away. The button on the right opens it.').isVisible());
        check(`${tag}: message box and Send are clear while folded`, await composerClear(p));
        await p.screenshot({ path: name('2-folded') });
        await icon.click(); await p.waitForTimeout(450);
        check(`${tag}: the icon opens the panel`, await dw(p) > 250);
        check(`${tag}: message box and Send are clear while open`, await composerClear(p));
        await p.mouse.move(w - 100, 300); await p.waitForTimeout(4500);
        check(`${tag}: pointer or focus in the panel keeps it open`, await dw(p) > 250);
        await away(p, 400);
        check(`${tag}: it folds again 3 seconds after the pointer and focus leave`, await folded(p, 6000) < 5500 && await dw(p) < 2);
        await p.getByRole('button', { name: 'Panel', exact: true }).click(); await p.waitForTimeout(450);
        check(`${tag}: the Panel link beside the title still opens it`, await dw(p) > 250);
        await p.getByRole('button', { name: 'Keep the panel open' }).click();
        await away(p, 400); await p.waitForTimeout(4500);
        check(`${tag}: pinned, it does not fold`, await dw(p) > 250);
        await p.reload(); await p.waitForSelector('#chat'); await p.waitForTimeout(4500);
        check(`${tag}: pinned, it stays open after a reload`, await dw(p) > 250 && await p.getByRole('button', { name: 'Let the panel fold away' }).count() === 1);
        await p.screenshot({ path: name('3-pinned') });
        await p.getByRole('button', { name: 'Let the panel fold away' }).click();
        await away(p, 400); await folded(p, 6000);
        const cid = await p.evaluate(() => { try { return localStorage.getItem('apd-chat'); } catch { return null; } }) || 'everyone';
        await t.core.jobs.start({ kind: 'test', title: 'Panel check task', agentId: 'coordinator', chatId: cid, run: async () => { await wait(1500); return { summary: 'ok' }; } });
        await p.waitForTimeout(1200);
        check(`${tag}: a background task of this chat opens the folded panel`, await dw(p) > 250, `width ${await dw(p)}`);
        await p.screenshot({ path: name('4-news') });
      } else {
        check(`${tag}: panel is closed at first and there is no fold icon (today's drawer)`, await dw(p) < 2 && !(await p.locator('.panel-show').isVisible()));
        await p.getByRole('button', { name: 'Panel', exact: true }).click(); await p.waitForTimeout(450);
        await p.screenshot({ path: name('1-drawer') });
        const a = await dw(p); await p.waitForTimeout(4000);
        check(`${tag}: the Panel link opens the drawer and it stays open`, a > 250 && await dw(p) > 250);
        const close = p.getByRole('button', { name: 'Close the panel' });
        check(`${tag}: the open drawer has its own Close button, in view`, await close.isVisible());
        await close.click(); await p.waitForTimeout(450);
        check(`${tag}: Close shuts the drawer and the Panel link is reachable again`, await dw(p) < 2 && await p.getByRole('button', { name: 'Panel', exact: true }).isVisible());
        check(`${tag}: message box and Send are clear`, await composerClear(p));
        await p.screenshot({ path: name('2-closed') });
      }
      await ctx.close();
    }
  }
  // the reply bubble: who line on its own line, then the reply, then one row with the rating and the time
  for (const theme of ['light', 'dark']) {
    for (const [w, h] of [[1220, 800], [1366, 768], [390, 844]]) {
      const tag = `${w}x${h} ${theme}`;
      const { ctx, p } = await open(w, h, theme, 'chat/everyone', { reply: true });
      await p.waitForSelector('.msg.it .rate button'); await p.waitForTimeout(500);
      await p.screenshot({ path: path.join(out, `chat-bubble_${TAG}_${w}x${h}_${theme}.png`) });
      const g = await p.evaluate(() => {
        const R = (e) => e.getBoundingClientRect();
        const b = document.querySelector('.msg.it'); const br = R(b);
        const who = b.querySelector('.who'), body = b.querySelector('.md'), foot = b.querySelector('.foot'), time = b.querySelector('.foot .time');
        const lh = parseFloat(getComputedStyle(who).lineHeight) || 16;
        const [a, m, f] = [who, body, foot].map(R);
        const kids = [...foot.children].map(R);
        const inside = [...b.querySelectorAll('.who,.md,.foot,.foot *')].every(e => { const r = R(e); return r.left >= br.left - 1 && r.right <= br.right + 1 && r.bottom <= br.bottom + 1; });
        const rowOverlap = kids.some((x, i) => kids.some((y, j) => j > i && x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1));
        return { stacked: a.bottom <= m.top + 1 && m.bottom <= f.top + 1, oneLine: a.height < lh * 1.6, whoW: Math.round(a.width), bubbleW: Math.round(br.width), inside, rowOverlap, timeIn: !!time && R(time).right <= br.right + 1, title: who.title };
      });
      check(`${tag}: reply bubble: who line on one line and wide, nothing overlaps, nothing outside the bubble`, g.stacked && g.oneLine && g.whoW > 120 && g.inside && !g.rowOverlap && g.timeIn && /OVHcloud/.test(g.title), JSON.stringify(g));
      await ctx.close();
    }
  }
  // Everyone: not edited, no switcher; groups pick who answers; avatars in the list and the bubbles; a group turn's look
  for (const theme of ['light', 'dark']) for (const [w, h] of [[1366, 768], [390, 844]]) {
    const tag = `${w}x${h} ${theme}`;
    const { ctx, p } = await open(w, h, theme, 'chat/everyone', { group: true });
    if (w <= 860) { await p.getByRole('button', { name: 'Panel', exact: true }).click(); await p.waitForTimeout(450); }
    else await p.getByRole('button', { name: 'Keep the panel open' }).click().catch(() => {});
    const e = await p.evaluate(() => ({ switcher: !document.querySelector('#grp')?.hidden, title: document.querySelector('.hd-title')?.textContent, line: document.querySelector('[data-everyone]')?.textContent || '', add: /Add an agent/.test(document.querySelector('#drawer')?.textContent || ''), who: [...(document.querySelector('[data-who-answers]')?.options || [])].map(o => o.textContent), railAv: document.querySelectorAll('.rail .agav').length, bubbleAv: document.querySelectorAll('.msg.it .who .agav').length, pass: document.querySelector('.msg[data-role=pass]')?.textContent, late: document.querySelector('.msg[data-role=late]')?.textContent, rec: [...document.querySelectorAll('.msg .rec')].map(x => x.textContent) }));
    check(`${tag}: Everyone has no switcher and no add control, only its line; Who answers offers the two choices`, !e.switcher && e.title === 'Everyone' && /Everyone always holds all your agents/.test(e.line) && !e.add && e.who.join('|') === 'Everyone, then a summary|The Coordinator', JSON.stringify(e));
    check(`${tag}: avatars in the chat list and in every reply bubble; a pass and a time-out are quiet lines; the record line is from the steps`, e.railAv >= 4 && e.bubbleAv === 2 && e.pass === 'Closer had nothing to add' && /did not answer in time/.test(e.late) && e.rec.includes('Scout answered · Scout searched the web 2 times, read a page') && e.rec.some(x => /summed up/.test(x)), JSON.stringify(e));
    await p.screenshot({ path: path.join(out, `chat-group_${TAG}_${w}x${h}_${theme}.png`) });
    await ctx.close();
  }
  // rating: two dim thumbs; after "poor" the research pair, the reasons and the note, all inside the bubble at 390 px
  for (const theme of ['light', 'dark']) for (const [w, h] of [[1366, 768], [390, 844]]) for (const kind of ['research', 'plain']) {
    const tag = `${w}x${h} ${theme}${kind === 'plain' ? ' (a reply with no search)' : ''}`;
    const { ctx, p } = await open(w, h, theme, 'chat/everyone', { reply: kind === 'research' ? 'research' : true });
    await p.waitForSelector('.msg.it .rate button'); await p.waitForTimeout(400);
    const widthAt = () => p.evaluate(() => Math.round(document.querySelector('.msg.it').getBoundingClientRect().width));
    const rest = await widthAt();
    const bare = await p.evaluate(() => { const r = document.querySelector('.msg.it .rate'); r.style.display = 'none'; const w = Math.round(document.querySelector('.msg.it').getBoundingClientRect().width); r.style.display = ''; return w; });
    const names = await p.evaluate(() => [...document.querySelectorAll('.msg.it .rate button')].map(b => b.getAttribute('aria-label')));
    const words = await p.evaluate(() => document.querySelector('.msg.it .rate').innerText.trim());
    await p.screenshot({ path: path.join(out, `chat-rating_1-rest-${kind}_${TAG}_${w}x${h}_${theme}.png`) });
    await p.getByRole('button', { name: 'Poor answer' }).click(); await p.waitForTimeout(700);
    const after = await p.evaluate(() => {
      const R = (e) => e.getBoundingClientRect(); const b = document.querySelector('.msg.it'); const br = R(b);
      const inside = [...b.querySelectorAll('.foot, .foot *')].every(e => { const r = R(e); return r.width === 0 || (r.left >= br.left - 1 && r.right <= br.right + 1 && r.bottom <= br.bottom + 1); });
      const bold = [...b.querySelectorAll('.rate, .rate *')].some(e => Number(getComputedStyle(e).fontWeight) >= 600);
      return { inside, bold, pressed: document.querySelector('.msg.it .rate [aria-label="Poor answer"]').getAttribute('aria-pressed'), research: !!document.querySelector('.msg.it .rate [aria-label="Strong research"]'), chips: document.querySelectorAll('.msg.it .rate .why .chip').length, note: /Add a note/.test(document.querySelector('.msg.it .rate').textContent), saved: document.querySelector('.msg.it .rate .saved')?.getAttribute('aria-label') || '' };
    });
    const grown = await widthAt();
    await p.screenshot({ path: path.join(out, `chat-rating_2-poor-${kind}_${TAG}_${w}x${h}_${theme}.png`) });
    check(`${tag}: rating at rest is two thumbs named Good answer and Poor answer, no words, and does not widen the bubble`, names.join('|') === 'Good answer|Poor answer' && words === '' && Math.abs(rest - bare) <= 1, JSON.stringify({ names, words, rest, bare }));
    check(`${tag}: after "poor": marked, Saved tick, ${kind === 'research' ? 'research pair' : 'no research pair (no search, no page)'}, seven reasons and a note, no bold, all inside the bubble, bubble no wider`, after.pressed === 'true' && /Saved/.test(after.saved) && after.research === (kind === 'research') && after.chips === 7 && after.note && !after.bold && after.inside && grown <= rest + 1, JSON.stringify({ ...after, rest, grown }));
    await ctx.close();
  }
  // the research plan card at 390 px: its title has the whole line, no word broken in a narrow column
  const PLAN_CARD = [{ id: 9201, role: 'user', text: 'can you find more details about VR200 and hows it different from GB200 or H100 ?' },
    { id: 9202, role: 'assistant', agentId: 'scout', text: 'The VR200 pairs a Vera CPU with Rubin GPUs [1].', label: LABEL, cards: [{ kind: 'progress', id: 'research-9202', agentId: 'scout', title: 'Research plan: NVIDIA VR200 Vera Rubin GPU · NVIDIA GB200 Grace Blackwell · NVIDIA H100 Hopper GPU · then architectural differences', progress: 1, status: 'done', detail: '6 pages read for 3 parts in 42 s' }], meta: { steps: [{ tool: 'web_search', agentId: 'scout', status: 'done' }] } },
    { id: 9203, role: 'user', text: 'Hi' }, { id: 9204, role: 'assistant', agentId: 'scout', text: 'Hello! What shall I look up?', label: LABEL, meta: { planNote: 'Could not plan this as research; answering directly.' } }];
  for (const theme of ['dark', 'light']) for (const [w, h] of [[390, 844], [1366, 768]]) {
    const { ctx, p } = await open(w, h, theme, 'chat/dm-scout', { fixture: PLAN_CARD });
    await p.waitForSelector('.card[data-card="progress"]'); await p.waitForTimeout(300);
    const g = await p.evaluate(() => { const c = document.querySelector('.card[data-card="progress"]'); const b = c.querySelector('b'); const cr = c.getBoundingClientRect(); const br = b.getBoundingClientRect(); return { card: Math.round(cr.width), title: Math.round(br.width), lines: Math.round(br.height / parseFloat(getComputedStyle(b).lineHeight || 20)), note: document.querySelector('[data-plan-note]')?.textContent || '' }; });
    await p.locator('.card[data-card="progress"]').scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(out, `chat-plan-card_${TAG}_${w}x${h}_${theme}.png`) });
    check(`${w}x${h} ${theme}: the research plan card's title is not squeezed into a narrow column, and the no-plan line shows quietly`, (w < 600 ? g.title >= g.card * 0.75 : g.title >= 300) && g.note === 'Could not plan this as research; answering directly.', JSON.stringify(g));
    await ctx.close();
  }
  // the one-time tip that the panel folded away sits clear of the messages
  {
    const { ctx, p } = await open(1366, 768, 'dark', 'chat/everyone', { reply: true });
    await p.evaluate(() => { localStorage.removeItem('apd-chat-panel-tip'); localStorage.removeItem('apd-chat-pin'); });
    await p.reload(); await p.waitForSelector('#chat'); await p.mouse.move(400, 400);
    await p.waitForFunction(() => { const t = document.querySelector('.panel-tip'); return t && !t.hidden; }, null, { timeout: 9000 }).catch(() => {});
    const g = await p.evaluate(() => { const t = document.querySelector('.panel-tip'); if (!t || t.hidden) return { shown: false }; const a = t.getBoundingClientRect(); const msgs = [...document.querySelectorAll('#chat .msg')].map(m => m.getBoundingClientRect()); const c = document.querySelector('#chat').getBoundingClientRect(); return { shown: true, overChat: a.bottom > c.top + 1 && a.top < c.bottom, overMsg: msgs.some(r => a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top) }; });
    await p.screenshot({ path: path.join(out, `chat-fold-tip_${TAG}_1366x768_dark.png`) });
    check('1366x768 dark: the one-time "panel folded away" tip shows clear of the messages', g.shown && !g.overChat && !g.overMsg, JSON.stringify(g));
    await ctx.close();
  }
  // a group of the owner's choice: the Coordinator's tick is locked with its reason; the group is named from its members, filed under Groups
  for (const [w, h, theme] of [[1366, 768, 'dark'], [390, 844, 'light']]) {
    const made = (await t.call('/api/m/chat/chats', { body: { title: 'New chat', members: ['coordinator'] } })).json;
    const { ctx, p } = await open(w, h, theme, 'chat/' + made.id);
    if (w < 860) { await p.click('.talk .hd .mini'); await p.waitForTimeout(400); }
    await p.locator('#drawer').getByRole('button', { name: 'Add' }).last().click(); await p.waitForTimeout(300);
    const m = await p.evaluate(() => { const row = document.querySelector('[data-member="coordinator"]'); const box = row?.querySelector('input'); return { locked: !!box?.disabled && !!box?.checked, line: row?.querySelector('.sub')?.textContent || '' }; });
    await p.screenshot({ path: path.join(out, `chat-new-group_1-pick_${TAG}_${w}x${h}_${theme}.png`) });
    for (const id of ['scout', 'closer']) await p.locator(`[data-member="${id}"] input`).check();
    await p.getByRole('button', { name: 'Save' }).click(); await p.waitForTimeout(800);
    if (w < 860) { await p.locator('#drawer .panel-close').click().catch(() => {}); await p.waitForTimeout(300); }
    const g = await p.evaluate((id) => { const sel = document.querySelector('#grp'); const rows = [...document.querySelectorAll('.rail > *')]; const gi = rows.findIndex(e => e.tagName === 'H6' && e.textContent === 'Groups'); const ai = rows.findIndex(e => e.tagName === 'H6' && e.textContent === 'Agents'); const at = rows.findIndex(e => e.dataset?.c === id); return { header: sel?.selectedOptions?.[0]?.textContent || '', inGroups: at > gi && at < ai, members: document.querySelector('.hd .pill')?.textContent || '' }; }, made.id);
    await p.screenshot({ path: path.join(out, `chat-new-group_2-made_${TAG}_${w}x${h}_${theme}.png`) });
    check(`${w}x${h} ${theme}: new group: the Coordinator's tick is locked with "it sums up"; saved as "Scout and Closer" under Groups, no other room's name`, m.locked && m.line === 'The Coordinator is in every group: it sums up' && g.header === 'Scout and Closer' && (g.inGroups || w < 860) && g.members === '3 agents', JSON.stringify({ ...m, ...g }));
    await ctx.close();
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
}
