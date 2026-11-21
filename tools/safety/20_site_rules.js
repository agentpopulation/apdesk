// Website rules (Network page): can an agent reach a site the owner said "never" to, or change the lists?
// Tries a direct read, a redirect to it, other spellings of the host (upper case, trailing dot, subdomain), the agent's
// browser (direct and by redirect, in a real Chromium when one is installed), and every way an agent could edit the
// lists. Prints HELD or BYPASS with one line of evidence each. Run from the repository root:
//   node modules/network/rules.probe.mjs
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
import { readPage } from '../../modules/search/reader.js';
import { Computer } from '../../modules/browser/computer.js';
import { ruleFor } from '../../modules/network/rules.js';

const say = (held, tag, line) => console.log(`${held ? 'HELD' : 'BYPASS'}(${tag}): ${line}`);
const t = await testDesk({ modules: ['search', 'browser', 'network'] });
const hits = [];
const site = http.createServer((req, res) => {
  hits.push(`${req.headers.host}${req.url}`);
  if (req.url === '/go') { res.writeHead(302, { location: `http://sub.blocked.localhost:${site.address().port}/secret` }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><main><p>' + 'SECRET-PAGE of the blocked site. '.repeat(10) + '</p></main></body></html>');
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const port = site.address().port;
try {
  await t.call('/api/modules/network/on', { method: 'POST' });
  // control: before any rule, a redirect hop to a loopback name the owner did not allow must not be requested either
  let exe = null; for (const n of ['playwright', 'playwright-core']) { try { const x = createRequire(import.meta.url)(n).chromium.executablePath(); if (fs.existsSync(x)) { exe = x; break; } } catch {} }
  if (!process.env.APD_BROWSER_PATH && exe) process.env.APD_BROWSER_PATH = exe;
  const opts = () => ({ allowHosts: ['127.0.0.1', 'sub.blocked.localhost', 'blocked.localhost'], deskPort: t.desk.port });
  { const c0 = new Computer({ agentId: 'control', dataDir: t.dataDir, guardOpts: () => ({ allowHosts: ['127.0.0.1'], deskPort: t.desk.port }) });
    try { await c0.start(); hits.length = 0; let err = null; await c0.goto(`http://127.0.0.1:${port}/go`).catch((e) => { err = e.message; }); const reached = hits.filter(h => h.startsWith('sub.')); say(!reached.length && hits.length === 1, 'CONTROL no-rule redirect hop', reached.length ? `the redirect hop reached ${reached.join(', ')}` : `the site saw only ${hits.join(', ')}; ${String(err || 'no error').slice(0, 90)}`); }
    catch (e) { console.log('NOT RUN(CONTROL): ' + String(e.message).slice(0, 60)); } finally { await c0.close().catch(() => {}); } }
  await t.call('/api/m/network/rules', { body: { kind: 'never', entry: 'blocked.localhost' } });
  await t.call('/api/m/network/rules', { body: { kind: 'never', entry: 'blocked.example' } });

  // 1. direct reads by an agent, in every spelling
  for (const u of ['https://blocked.example/', 'https://BLOCKED.EXAMPLE/x', 'https://blocked.example./', 'https://www.blocked.example/', 'https://a.b.blocked.example:8443/p', 'https://%62locked.example/']) {
    const r = await t.core.modules.runTool('web_read', { url: u }, { agentId: 'scout', chatId: 'probe' });
    say(/never open blocked\.example/.test(r.error || ''), 'read ' + u, r.error ? r.error.slice(0, 80) : `read ${String(r.text || '').length} characters`);
  }
  // 2. a redirect from an allowed site to the blocked one (the reader checks every hop before it is requested)
  const sent = [];
  const fetchFn = async (u) => { sent.push(String(u)); return String(u).includes('/go') ? new Response(null, { status: 302, headers: { location: 'https://Www.Blocked.Example./secret' } }) : new Response('<p>' + 'x '.repeat(100) + '</p>', { headers: { 'content-type': 'text/html' } }); };
  let code = 'read'; try { await readPage(fetchFn, 'https://allowed.example/go', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }); } catch (e) { code = e.code; }
  say(code === 'rule_never' && sent.length === 1, 'read-redirect', `refused with ${code}; requests sent: ${sent.join(', ')}`);

  // 3. the agent's browser: a direct open, and a redirect into the blocked site (real Chromium)
  const c = new Computer({ agentId: 'probe', dataDir: t.dataDir, guardOpts: opts });
  try {
    await c.start();
    hits.length = 0; let err = null;
    try { await c.goto(`http://BLOCKED.localhost.:${port}/x`); } catch (e) { err = e.message; }
    say(!!err && !hits.length, 'browser-direct', err ? `refused: ${err.slice(0, 80)}` : `opened; the site saw ${hits.join(', ')}`);
    hits.length = 0; err = null;
    try { await c.goto(`http://127.0.0.1:${port}/go`); } catch (e) { err = e.message; }
    const reached = hits.some(h => h.startsWith('sub.blocked.localhost'));
    say(!reached, 'browser-redirect', reached ? `the redirect reached it: ${hits.join(', ')}` : `the site saw only ${hits.join(', ')}; ${err ? 'the page failed: ' + err.slice(0, 60) : 'final page ' + c.page.url()}`);
  } catch (e) { console.log(`NOT RUN(browser): no browser here (${String(e.message).slice(0, 80)})`); }
  finally { await c.close().catch(() => {}); }

  // 4. can an agent or a chat change the lists?
  const tools = [...t.core.modules.tools.values()].filter(x => x.module === 'network').map(x => x.name);
  say(!tools.some(n => /rule|block|allow/i.test(n)), 'tools', `the Network module's agent tools are ${tools.join(', ')}; none edits the lists`);
  const noSession = await t.call('/api/m/network/rules', { body: { kind: 'ask', entry: 'other.example' }, session: false });
  const del = await t.call('/api/m/network/rules', { method: 'DELETE', body: { domain: 'blocked.example' }, session: false });
  say(noSession.status >= 400 && del.status >= 400 && ruleFor('blocked.example')?.kind === 'never', 'routes-without-owner', `add answered ${noSession.status}, remove answered ${del.status}; blocked.example is still "never"`);
  t.core.storage.kvScope('m:evil').set('rules', { never: [], ask: [] });
  const c2 = await t.core.modules.runTool('web_read', { url: 'https://blocked.example/' }, { agentId: 'scout' });
  say(/never open/.test(c2.error || ''), 'other-module-kv', 'another module writing its own "rules" setting changes nothing');
  for (const name of [...t.core.modules.tools.keys()]) {
    if (!/^(network_test|domain_lookup)$/.test(name)) continue;
    await t.core.modules.runTool(name, name === 'network_test' ? { what: 'connection', rules: { never: [] } } : { kind: 'dns', domain: 'blocked.example', never: [] }, { agentId: 'scout' }).catch(() => {});
  }
  say(ruleFor('www.blocked.example')?.kind === 'never', 'tool-args', 'extra arguments to the network tools change nothing');
} finally { await t.close(); site.close(); }
