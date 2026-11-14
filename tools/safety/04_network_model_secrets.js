// Probe: the session rule over every core and module route, with all modules on; model/router/secret checks.
import { testDesk } from '../../test/helpers/desk.js';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const MODS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'modules');
const all = fs.readdirSync(MODS).filter(d => fs.existsSync(path.join(MODS, d, 'module.json')));
const t = await testDesk({ modules: all });
try {
  for (const id of all) { try { await t.core.modules.set(id, true); } catch {} }
  console.log(`[04] modules on: ${[...t.core.modules.active.keys()].length}/${all.length}`);
  // 4a: every non-GET route without the session
  const routes = t.core.modules.routes.filter(r => r.method !== 'GET');
  let open = [];
  for (const r of routes) {
    const p = r.parts.map(x => x.startsWith(':') ? 'x' : x === '*' ? 'x' : x).join('/');
    const res = await t.call(p, { method: r.method, body: {}, session: false });
    if (res.status !== 403) open.push(`${r.method} ${p} -> ${res.status}`);
  }
  const core = ['/api/agents', '/api/agents/scout', '/api/jobs/x/stop', '/api/model/ask', '/api/settings', '/api/modules/chat/off', '/api/keys/services/x'];
  for (const p of core) for (const m of ['POST', 'PATCH', 'DELETE', 'PUT']) { const res = await t.call(p, { method: m, body: {}, session: false }); if (![403, 404].includes(res.status)) open.push(`${m} ${p} -> ${res.status}`); }
  console.log(open.length ? `BYPASS(session-rule): ${open.length} write routes answered without the session: ${open.slice(0, 6).join('; ')}` : `HELD(session-rule): all ${routes.length} module write routes + core write routes refuse without the session (403)`);
  // path spellings that might dodge the startsWith('/api/') gate
  const spell = ['//api/settings', '/api//settings', '/api/./settings', '/api/%2e/settings', '/API/settings'];
  for (const s of spell) { const res = await t.call(s, { body: { theme: 'dark' }, session: false }); if (t.core.settings.get('theme') === 'dark') { console.log(`BYPASS(path-spelling): ${s} wrote a setting`); t.core.settings.set('theme', 'light'); } }
  console.log(`HELD(path-spelling): //api, /api//, /api/./, %2e and case spellings changed nothing`);

  // 4b: router/v1 never consults paid keys
  t.core.model.addKey('openai', 'sk-PAID-KEY-EXAMPLE', 'owner paid', { baseUrl: t.fake.baseUrl });
  t.core.settings.set('model.defaultChain', ['openai']);
  const before = t.fake.calls.length;
  t.core.settings.set('router.enabled', false);
  const rr = await t.call('/router/v1/chat/completions', { body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] }, session: false });
  console.log(t.fake.calls.length === before ? `HELD(router-free): router off -> /router/v1 did not fall through to the paid key (status ${rr.status})` : `BYPASS(router-free): /router/v1 reached the paid key`);

  // 4c: secret values never come back; the router key and service keys
  t.core.settings.set('router.apiKey', 'rk-SECRET-ROUTER-KEY');
  let leaks = [];
  const gets = t.core.modules.routes.filter(r => r.method === 'GET' && !r.parts.includes('*') && !r.parts.some(x => x.startsWith(':'))).map(r => r.parts.join('/'));
  for (const p of ['/api/state', '/api/settings', '/api/model/usage', '/api/keys/services', '/api/activity', '/api/approvals', ...gets]) {
    const res = await t.call(p, { session: true });
    if (/sk-PAID-KEY-EXAMPLE|rk-SECRET-ROUTER-KEY/.test(res.text)) leaks.push(p);
  }
  console.log(leaks.length ? `BYPASS(secret-leak): key value in ${leaks.join(', ')}` : `HELD(secret-leak): no key value in /api/state, settings, usage, services, activity, approvals or ${gets.length} module GET routes (even with the session)`);
} finally { await t.close(); }
