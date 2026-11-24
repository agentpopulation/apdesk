// Browser check of the Scorecard: a throwaway desk with a seeded database on one test port, the module switched on and off twice,
// then the page, one agent, the agent tab and Settings at 1366x768 and 390x844 in both themes. Prints PASS|FAIL lines and writes pictures.
//   node modules/scorecard/ui-check.mjs <port> <dataDir> <shotsDir>
import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import { createDesk } from '../../app/server.js';
import { weeksBack } from './weeks.js';
const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');
const [port, dataDir, shots] = [Number(process.argv[2] || 3475), process.argv[3], process.argv[4]];
fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(shots, { recursive: true });
const results = []; const check = (n, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${ev}`); };

const desk = await createDesk({ dataDir, port, quiet: true }); await desk.start();
const core = desk.core; core.settings.set('onboarded', true); core.settings.set('timeZone', 'Asia/Kolkata'); core.settings.set('currency', 'EUR'); core.settings.set('locale', 'en-GB');
for (let i = 0; i < 2; i++) { await desk.modules.set('scorecard', false); const off = (await fetch(desk.url() + '/api/m/scorecard/report', { headers: { 'x-apd-session': desk.session } })).status; await desk.modules.set('scorecard', true); const on = (await fetch(desk.url() + '/api/m/scorecard/report', { headers: { 'x-apd-session': desk.session } })).status; check(`switched off then on, round ${i + 1}`, off === 404 && on === 200, `off ${off}, on ${on}`); }

const S = core.storage; const weeks = weeksBack({ now: Date.now(), tz: 'Asia/Kolkata', firstDay: 1, count: 8, locale: 'en-GB' });
const at = (w, h) => new Date(weeks[w].start + h * 3600000).toISOString();
const reply = (w, h, o = {}) => { const r = S.run('INSERT INTO m_chat_messages (chat_id, role, agent_id, text, cards, label, status, meta, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'dm-' + (o.agent || 'scout'), 'assistant', o.agent || 'scout', 'text', '[]', 'x', o.status || 'done', JSON.stringify({ models: [{ provider: o.provider || 'router', model: o.model || 'qwen-small', ok: o.status !== 'error' }, ...(o.skipped ? [{ provider: 'router', model: 'llama-slow', ok: false, skipped: true }] : [])] }), at(w, h), at(w, h)); if (o.thumb) S.run('INSERT INTO m_chat_ratings (message_id, thumb, research, reasons, comment, rated_at) VALUES (?, ?, NULL, ?, ?, ?)', String(r.lastInsertRowid), o.thumb, '[]', '', at(w, h + 1)); };
const call = (w, h, o = {}) => S.run('INSERT INTO calls (at, agent_id, purpose, provider, model, ok, ms, input_tokens, output_tokens, cost_minor, currency) VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, ?, ?)', at(w, h), o.agent || 'scout', 'chat', o.provider || 'router', o.model || 'qwen-small', o.ok ?? 1, o.ms || 1800, o.cost === undefined ? 0 : o.cost, 'EUR');
const job = (w, h, st, agent) => S.run('INSERT INTO jobs (id, kind, title, agent_id, status, progress, created, updated, finished) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)', 'job_' + Math.random().toString(36).slice(2), 'research.deep', 'A job', agent, st, at(w, h), at(w, h), at(w, h + 1));
for (let w = 0; w < 8; w++) for (let i = 0; i < (w < 2 ? 8 : 3 + (w % 4) * 2); i++) { reply(w, 2 + i, { thumb: w < 2 ? (i % 2 ? 'down' : 'up') : i % 3 ? 'up' : null, skipped: i === 1 }); call(w, 2 + i, { ms: 1500 + i * 400 }); }
for (let w = 0; w < 2; w++) for (let i = 0; i < 12; i++) { reply(w, 2 + i, { agent: 'closer', model: 'gemma-large', thumb: i === 0 ? 'down' : 'up' }); call(w, 2 + i, { agent: 'closer', model: 'gemma-large', provider: 'gemini', cost: i % 2 ? null : 0, ms: 3200 }); }
for (let i = 0; i < 4; i++) { job(0, 3 + i, i < 3 ? 'done' : 'failed', 'operator'); job(1, 3 + i, 'done', 'operator'); }
job(0, 5, 'stopped', 'scout'); job(0, 6, 'done', 'scout');
call(0, 4, { agent: 'operator', cost: 140 }); call(0, 6, { agent: 'operator', cost: null });
core.agents.update('scout', { model: { main: { provider: 'router', model: 'auto' } } });
await fetch(desk.url() + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-apd-session': desk.session }, body: JSON.stringify({ onboarded: true }) });
const rep = await (await fetch(desk.url() + '/api/m/scorecard/report', { headers: { 'x-apd-session': desk.session } })).json();
check('the seeded record gives a suggestion', rep.suggestions.length === 1, rep.suggestions[0]?.text || '');
check('week dates are said in the owner zone', /^\d+ \w+ to \d+ \w+$/.test(rep.weeks[0].label), rep.weeks[0].label);

const execPath = fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined;
let browser; try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }
const errors = [];
const screens = [['scorecard', '#/scorecard'], ['scorecard-agent', '#/scorecard/scout'], ['scorecard-tab', '#/scorecard/scout'], ['scorecard-settings', '#/settings/scorecard']];
for (const [w, hgt] of [[1366, 768], [390, 844]]) for (const theme of ['dark', 'light']) for (const [name, hash] of screens) {
  const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('apd-theme', t); } catch {} }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  core.settings.set('theme', theme);
  await page.goto(desk.url() + '/' + hash); await page.waitForSelector('#menu .nav', { timeout: 15000 }); await page.waitForTimeout(1200);
  await page.evaluate(async (dark) => { await window.apd.setTheme(dark); }, theme === 'dark'); await page.waitForTimeout(500);
  check(`${name} ${w}x${hgt} ${theme}: the theme really is ${theme}`, await page.evaluate(() => document.documentElement.dataset.theme) === theme);
  if (name === 'scorecard-tab') await page.evaluate(async () => { const m = await window.apd.moduleUi('scorecard'); const v = document.querySelector('#view'); v.replaceChildren(); const d = document.createElement('div'); d.style.padding = '16px'; v.append(d); await m.agentTabs.scorecard.render(d, window.apd, window.apd.agent('scout')); });
  if (name === 'scorecard-tab') await page.waitForTimeout(500);
  const g = await page.evaluate(() => { const v = document.querySelector('#view'); const body = v.querySelector('.sc-body') || v; return { wide: document.documentElement.scrollWidth - innerWidth, vwide: v.scrollWidth - v.clientWidth, text: v.innerText, bodyScroll: body.scrollWidth - body.clientWidth }; });
  const want = { scorecard: /Scorecard[\s\S]*This week[\s\S]*Researcher[\s\S]*Switch/, 'scorecard-agent': /Work done each week[\s\S]*Week by week/, 'scorecard-tab': /last eight weeks[\s\S]*Work done each week/, 'scorecard-settings': /Week starts on[\s\S]*Suggest a better model/ }[name];
  check(`${name} ${w}x${hgt} ${theme}: content there, nothing sideways`, want.test(g.text) && g.wide <= 0 && g.vwide <= 0 && g.bodyScroll <= 0, `wide=${g.wide} vwide=${g.vwide} body=${g.bodyScroll}`);
  check(`${name} ${w}x${hgt} ${theme}: no raw words`, !/\b(null|undefined|NaN|Invalid Date|\[object)\b|\$\d|\bUTC\b|m_chat|m_scorecard/.test(g.text), '');
  if (name === 'scorecard') {
    const rows = await page.$$eval('tbody.sc-agentrow', (b) => b.map(x => x.innerText.replace(/\s+/g, ' ').slice(0, 90)));
    check(`scorecard ${w}x${hgt} ${theme}: a row for every agent`, rows.length >= 5, String(rows.length));
    check(`scorecard ${w}x${hgt} ${theme}: an idle agent says so`, /No work this week\./.test(g.text));
    check(`scorecard ${w}x${hgt} ${theme}: cost says unknown calls, not a guess`, /plus \d+ calls? of unknown cost/.test(g.text));
    check(`scorecard ${w}x${hgt} ${theme}: approvals are counted now the door offers them`, !/Approvals asked and refused are not available/.test(g.text) && rows.some(r => /Researcher/.test(r)));
  }
  await page.screenshot({ path: path.join(shots, `${name}_${w}x${hgt}_${theme}.png`) });
  if (name === 'scorecard' && w === 1366 && theme === 'dark') {
    const before = await page.$$eval('tbody.sc-agentrow', (b) => b.map(x => x.dataset.agent).join(','));
    await page.click('th button[title="Sort by replies"]'); await page.waitForTimeout(200);
    const after = await page.$$eval('tbody.sc-agentrow', (b) => b.map(x => x.dataset.agent).join(','));
    const sorted = await page.$$eval('tbody.sc-agentrow tr.sc-main td:nth-child(2)', (c) => c.map(x => Number(x.innerText.split('\n')[0])).filter(Number.isFinite));
    check('sorting by replies puts the most first', sorted.length > 1 && sorted.every((v, i) => i === 0 || sorted[i - 1] >= v) && before !== after, `${sorted.join(',')}`);
    await page.click('#sc-save'); await page.waitForTimeout(1200);
    const saved = fs.readdirSync(path.join(dataDir, 'workspace', 'reports')).filter(f => /^scorecard-.*\.csv$/.test(f));
    check('Save this week as a file writes a CSV in the workspace', saved.length === 1, saved.join(','));
    await page.click('[data-sug="scout"] button:has-text("Switch")'); await page.waitForTimeout(800);
    const after2 = core.agents.get('scout').model.main;
    check('the Switch button changes the model and shows the saved tick and Undo', after2?.model === 'gemma-large' && await page.$('[data-sug="scout"] .saved[data-saved="ok"]') && await page.$('[data-sug="scout"] button:has-text("Undo")'), JSON.stringify(after2));
    await page.screenshot({ path: path.join(shots, `scorecard-switched_${w}x${hgt}_${theme}.png`) });
    await page.click('[data-sug="scout"] button:has-text("Undo")'); await page.waitForTimeout(800);
    check('Undo puts the model back', core.agents.get('scout').model.main?.model === 'auto', JSON.stringify(core.agents.get('scout').model.main));
  }
  await ctx.close();
}
await browser.close();
check('no console or page errors', errors.length === 0, [...new Set(errors)].slice(0, 3).join(' | '));
for (let i = 0; i < 2; i++) { await desk.modules.set('scorecard', false); await desk.modules.set('scorecard', true); }
check('still switches on after the page was used', core.modules.isOn('scorecard'));
await desk.stop();
console.log(`${results.filter(Boolean).length} of ${results.length} passed; pictures in ${shots}`);
process.exit(results.every(Boolean) ? 0 : 1);
