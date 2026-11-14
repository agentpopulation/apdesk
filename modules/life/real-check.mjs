// Real check for Life: switch on; no city means no guess; set a named city; a real forecast with its source and times;
// real exchange rates; a real day plan from real pages by a real model; then switch off.
import { testDesk } from '../../test/helpers/desk.js';
const results = []; const check = (name, ok, ev) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev || ''}`); };
const t = await testDesk({ real: true, modules: ['life'] });
try {
  check('off: routes answer 404', (await t.call('/api/m/life/weather')).status === 404, '');
  await t.call('/api/modules/life/on', { method: 'POST' });
  const st = (await t.call('/api/state')).json;
  check('on: menu place Life and tool weather appear', st.modules.find(m => m.id === 'life').menu[0]?.label === 'Life' && st.tools.some(x => x.name === 'weather'), '');
  const none = await t.core.modules.runTool('weather', {}, {});
  check('no city set: the tool asks instead of guessing', none.ok === false && none.needsCity, none.note);
  const plr = (await t.call('/api/m/life/places?q=Pune')).json; const pl = plr.places || []; if (!pl.length) console.log('place search:', JSON.stringify(plr));
  await t.call('/api/m/life/place', { body: { place: pl[0] } });
  const w = (await t.call('/api/m/life/weather')).json;
  const tz = t.core.settings.get('timeZone') || 'Asia/Kolkata';
  const local = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });
  check("a real forecast for a named city, with source and owner-zone time", w.ok && w.days?.length === 7 && w.current?.tempC != null, !w.ok ? JSON.stringify(w) : `${w.place}: ${w.current.tempC}°C ${w.current.weather}, measured ${local(w.current.at)} (${tz}); ${w.days[1].maxC}/${w.days[1].minC}°C tomorrow; ${w.source}`);
  const r = (await t.call('/api/m/life/rates?base=INR')).json;
  check('real exchange rates', r.rates?.length > 3, `${r.date}: 1 USD = ${r.rates?.find(x => x.code === 'USD')?.inBase?.toFixed(2)} INR; ${r.source}`);
  const j = await t.call('/api/m/life/plan', { body: { where: 'Kochi', interests: 'history and food' } });
  const done = await t.core.jobs.wait(j.json.jobId, 240000);
  const p = done.status === 'done' ? (await t.call('/api/m/life/plans/' + done.output.planId)).json : null;
  check('a real day plan by a real model, with sources and map links', p && p.text.length > 300 && p.sources.length >= 1 && /\[\d\]/.test(p.text), p ? `[${p.label}] ${p.sources.length} sources (${p.sources.map(s => s.title).join('; ')}); ${p.places.length} map links; "${p.text.replace(/\s+/g, ' ').slice(0, 120)}…"` : done.error);
  await t.call('/api/modules/life/off', { method: 'POST' });
  check('off: routes 404, tool gone', (await t.call('/api/m/life/weather')).status === 404 && !(await t.call('/api/state')).json.tools.some(x => x.name === 'weather'), '');
} catch (e) { check('no error', false, e.stack); }
finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
