// Real check for Studio: switch on; build a one-page site from a real brief with a real model; the files exist and the
// preview renders in a real browser inside a sandboxed iframe; replay one ask on two models; switch off.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const results = []; const check = (name, ok, ev) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev || ''}`); };
const t = await testDesk({ real: true, modules: ['studio'] });
try {
  check('off: routes answer 404', (await t.call('/api/m/studio/sites')).status === 404, '');
  await t.call('/api/modules/studio/on', { method: 'POST' });
  const st = (await t.call('/api/state')).json;
  check('on: menu place Studio and tool site_build appear', st.modules.find(m => m.id === 'studio').menu[0]?.label === 'Studio' && st.tools.some(x => x.name === 'site_build'), '');
  const b = await t.call('/api/m/studio/sites', { body: { brief: 'A one-page site for Asha’s Bakery in Pune: fresh sourdough, cakes and filter coffee; open 7 am to 7 pm every day; orders by phone (placeholder number). Warm colours.', name: 'asha-bakery' } });
  const j = await t.core.jobs.wait(b.json.jobId, 300000);
  const dir = path.join(t.dataDir, 'workspace', 'sites', 'asha-bakery');
  const html = fs.existsSync(path.join(dir, 'index.html')) ? fs.readFileSync(path.join(dir, 'index.html'), 'utf8') : '';
  check('a real model wrote index.html and style.css into workspace/sites', j.status === 'done' && html.length > 300 && fs.existsSync(path.join(dir, 'style.css')) && !/<script/i.test(html), j.status === 'done' ? `[${j.output.label}] ${j.output.files.map(f => `${f.name} ${f.size} B`).join(', ')}` : j.error);
  const pv = await fetch(t.base + '/api/m/studio/preview/asha-bakery/index.html');
  check('preview route serves it with a sandbox policy', pv.status === 200 && /sandbox/.test(pv.headers.get('content-security-policy') || ''), pv.headers.get('content-security-policy'));
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(t.base + '/api/m/studio/sites');   // a same-origin parent, as the desk page is
  await page.evaluate((src) => { document.body.innerHTML = `<iframe sandbox="" src="${src}" style="width:1200px;height:700px"></iframe>`; }, '/api/m/studio/preview/asha-bakery/index.html');
  await page.waitForTimeout(1500);
  const fr = page.frames()[1];
  const txt = fr ? await fr.evaluate(() => document.body.innerText).catch(() => '') : '';
  const styled = fr ? await fr.evaluate(() => { const b = getComputedStyle(document.body); return document.styleSheets.length > 0 && (b.fontFamily !== 'Times New Roman' && !/^"?Times/.test(b.fontFamily) || b.backgroundColor !== 'rgba(0, 0, 0, 0)'); }).catch(() => false) : false;
  check('the site renders in a sandboxed frame, styled', /Asha|Bakery/i.test(txt) && styled, `text: "${txt.replace(/\s+/g, ' ').slice(0, 80)}…", stylesheet applied: ${styled}`);
  await browser.close();
  const models = (await t.call('/api/m/studio/models')).json.models;
  const a = { provider: 'gemini', model: 'gemini-3.5-flash-lite' };   // the larger Gemini models are out of quota on the shared key today
  const bb = models.find(m => m.provider === 'router') || models[1];
  console.log('models offered on the replay screen:', models.map(m => m.label).join(', '));
  const rp = await t.call('/api/m/studio/replay', { body: { ask: 'In one sentence: why is the sky blue?', a, b: bb } });
  const rj = await t.core.jobs.wait(rp.json.jobId, 180000);
  const rs = rj.output?.results || [];
  check('eval replay: one ask, two models, labelled and timed', rs.length === 2 && rs.every(r => r.ok && r.label), rs.map(r => `[${r.label}, ${(r.ms / 1000).toFixed(1)} s] ${String(r.text || r.error).replace(/\s+/g, ' ').slice(0, 70)}`).join(' | '));
  await t.call('/api/modules/studio/off', { method: 'POST' });
  check('off: routes 404, tool gone', (await t.call('/api/m/studio/sites')).status === 404 && !(await t.call('/api/state')).json.tools.some(x => x.name === 'site_build'), '');
} catch (e) { check('no error', false, e.stack); }
finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
