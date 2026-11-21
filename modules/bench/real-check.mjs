// Real check for Bench: real free models and the real web, a time-compressed session for a made-up business, tier 1 and the
// tier-2 activities. Free models only: Bench runs in "Local then free" and the paid switch stays off. Prints the note word for word.
// Usage: node modules/bench/real-check.mjs   (with the free keys in the environment; never paid ones)
import { testDesk } from '../../test/helpers/desk.js';
import { testHooks } from './server.js';

const H = 3600000; const t0 = Date.now();
const results = []; const check = (name, ok, ev) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ev || ''}`); };
const clock = { t: Date.now() }; const base = clock.t;
testHooks.clock = () => clock.t; testHooks.battery = async () => ({ hasBattery: false });
const t = await testDesk({ real: true, modules: ['bench', 'chat', 'memory', 'agents', 'sales', 'search', 'research', 'tasks'] });
try {
  t.core.settings.set('business.about', 'Payroll software for small firms in India; HR heads and founders buy it; Pune and Mumbai');
  t.core.settings.set('country', 'IN'); t.core.settings.set('security.level', 'careful');
  await t.core.modules.set('bench', true);
  await t.call('/api/m/bench/settings', { body: { enabled: true, models: 'free' } });
  const at = new Date(base - 2 * H).toISOString();
  for (const [role, text, meta] of [['user', 'Find 10 leads for my payroll software in Pune', '{}'], ['assistant', 'Looking for companies in Pune that…', '{}'], ['assistant', 'Here are some companies in Pune…', '{"again":true}']]) t.core.storage.run('INSERT INTO m_chat_messages (chat_id, role, text, cards, status, meta, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'c1', role, text, '[]', 'done', meta, at, at);
  const bench = t.core.modules.api('bench');
  const run = async (hours, until) => { clock.t = base + hours * H; for (let i = 0; i < 12; i++) { if (!await bench.tick()) { if (until?.()) break; await new Promise((r) => setTimeout(r, 5000)); if (!await bench.tick()) break; } await bench.idle(); if (until?.()) break; } };
  await run(0.6);
  await run(1.1);
  await run(12.1, () => ['done', 'skipped', 'failed'].includes(bench.current()?.plan.competitors.status));
  const s = bench.current();
  console.log('plan:', Object.entries(s.plan).map(([k, p]) => `${k}=${p.status}${p.why ? ' (' + p.why + ')' : ''}`).join('; '));
  for (const [k, p] of Object.entries(s.plan)) if (p.summary) console.log(`  ${k}: ${p.summary}`);
  check('tier 1 ran', ['unfinished', 'selfcheck', 'lessons'].every((k) => s.plan[k].status !== 'pending'), '');
  check('a tier-2 web activity ran (competitors)', s.plan.competitors.status === 'done', s.plan.competitors.why || '');
  const paid = t.core.storage.get("SELECT COUNT(*) AS c FROM calls WHERE cost_minor > 0").c;
  check('no paid call', paid === 0 && t.core.settings.get('openrouter.allowPaid') !== true, `models used: ${s.models.join(', ') || 'none'}`);
  check('nothing applied: no approval asked, no memory written', t.core.storage.get('SELECT COUNT(*) AS c FROM approvals').c === 0 && t.core.storage.get('SELECT COUNT(*) AS c FROM m_memory_items').c === 0, '');
  await t.call('/api/m/bench/seen', { body: {} });
  const n = (await t.call('/api/m/bench/state')).json.note;
  console.log('\n----- the note, word for word -----\n' + (n ? n.text : '(no note)') + '\n-----');
  for (const i of n?.items || []) console.log(`[${i.kind}] ${i.title} | ${i.body.replace(/\s+/g, ' ').slice(0, 220)} | ${(i.evidence || []).map((e) => e.url + (e.quote ? ` "${e.quote.slice(0, 120)}"` : '')).join(' ; ')}`);
  console.log(`\nreal time: ${Math.round((Date.now() - t0) / 1000)} s; model calls ${s.used.calls}, pages read ${s.used.pages}, searches ${s.used.searches}`);
} catch (e) { check('no error', false, e.stack); }
finally { await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
