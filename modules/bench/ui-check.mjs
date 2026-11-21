// Browser check of the Bench pages (Bench with its to-do list, drafts and Rulebook tab; While you were away with gaps, today's
// find and the weekly note; Bench settings): 390x844 and 1366x768, white and black themes. Fake model, fake web (plumbing
// only). Prints PASS|FAIL lines and writes screenshots.   node modules/bench/ui-check.mjs [outDir]
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createRequire } from 'node:module';
import { benchDesk } from './fixtures.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || path.join(os.tmpdir(), 'apd-bench-ui'); fs.mkdirSync(out, { recursive: true });
const results = []; const check = (n, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${ev}`); };

const { t, at, clock } = await benchDesk({ modules: ['bench', 'chat', 'search', 'sales', 'memory', 'files'] });
t.core.storage.run("INSERT INTO jobs (id, kind, title, status, progress, detail, input, created, updated, finished) VALUES ('job_u1', 'tasks.run', 'Payroll buyers in Pune', 'done', 1, 'Done', '{}', ?, ?, ?)", new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
fs.mkdirSync(t.core.storage.workspacePath('knowledge'), { recursive: true });
fs.writeFileSync(t.core.storage.workspacePath('knowledge', 'house-rules.md'), '- Always say the city first.\n- Never send mail on Sundays.\n- At most 3 quotes per page.\n');
await at(12.05);
t.core.storage.run("INSERT INTO m_bench_gaps (id, from_at, to_at, noted) VALUES ('gp_ui', ?, ?, ?)", new Date(clock.t - 3 * 3600000).toISOString(), new Date(clock.t - 2 * 3600000).toISOString(), new Date().toISOString());
await t.call('/api/m/bench/rules/scan', { body: {} });
await t.call('/api/m/bench/ratings', { body: { targetType: 'job', targetId: 'job_u1', thumb: 'down', reasons: ['wrong facts'], comment: 'wrong city' } });
await t.call('/api/settings', { body: { onboarded: true } });

const browser = await chromium.launch();
const errors = [];
const screens = [['bench', '#/bench'], ['bench-return', '#/bench-return'], ['bench-settings', '#/settings/bench']];
for (const [w, hgt] of [[390, 844], [1366, 768]]) for (const theme of ['light', 'dark']) for (const [name, hash] of screens) {
  const page = await browser.newPage({ viewport: { width: w, height: hgt } });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(t.base + '/' + hash); await page.waitForTimeout(1500);
  await page.evaluate((th) => window.apd?.setTheme?.(th === 'dark'), theme); await page.waitForTimeout(300);
  const g = await page.evaluate(() => ({ wide: document.documentElement.scrollWidth - innerWidth, text: document.querySelector('.view')?.innerText || '' }));
  const want = { bench: /To do/, 'bench-return': /Today's find[\s\S]*When the desk was not running|When the desk was not running[\s\S]*Today's find/, 'bench-settings': /Keep this PC awake[\s\S]*Topics to avoid/ }[name];
  check(`${name} ${w}x${hgt} ${theme}: no sideways scroll, content there`, g.wide <= 0 && want.test(g.text), `wide=${g.wide}`);
  if (name === 'bench' && w === 1366 && theme === 'light') {
    check('a Draft card with its buttons', /Draft[\s\S]*Make again[\s\S]*Hand to Mail drafts/.test(g.text));
    await page.getByText('Rulebook', { exact: true }).first().click(); await page.waitForTimeout(600);
    const rb = await page.evaluate(() => document.querySelector('.view').innerText);
    check('the Rulebook tab lists the proposed rules with file and line, and says checking comes later', /knowledge\/house-rules\.md, line 1/.test(rb) && /comes later/.test(rb));
    await page.screenshot({ path: path.join(out, `bench-rulebook_${w}x${hgt}_${theme}.png`), fullPage: false });
  }
  await page.screenshot({ path: path.join(out, `${name}_${w}x${hgt}_${theme}.png`) });
  await page.close();
}
check('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
await browser.close(); await t.close();
console.log(`${results.filter(Boolean).length}/${results.length} passed. Screenshots: ${out}`);
process.exit(results.every(Boolean) ? 0 : 1);
