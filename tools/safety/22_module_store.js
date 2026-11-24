// Probe: the Module Store's Add a module, and the rules an added (custom) module lives under. Each attempt prints
// BYPASS (it got through) or HELD. Runs on its own modules folder: the real Store, linked, and nothing else.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { testDesk } from '../../test/helpers/desk.js';
import { makeZip } from '../../app/core/module-check/fixtures/zip-writer.mjs';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-probe-store-'));
fs.symlinkSync(path.join(ROOT, 'modules', 'store'), path.join(dir, 'store'));
fs.writeFileSync(path.join(dir, 'shipped.json'), JSON.stringify({ version: 'probe', entries: ['store', 'shipped.json'] }));
const t = await testDesk({ modulesDir: dir });
const send = async (zip, token = t.desk.session) => { const r = await fetch(t.base + '/api/m/store/check', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-apd-session': token }, body: zip }); return { status: r.status, json: await r.json() }; };
const mod = (id, server, manifest = {}) => [{ name: `${id}/module.json`, data: JSON.stringify({ id, number: 77, name: 'Probe', description: 'A probe module for the safety review of the Module Store.', kind: 'switch-on', status: 'stub', tools: [], hosts: [], ...manifest }) }, { name: `${id}/server.js`, data: server }];
const until = async (fn) => { for (let i = 0; i < 150; i++) { if (await fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
try {
  // 1. a zip entry that climbs out of the temp folder
  const c = await send(makeZip([...mod('climb', 'export async function activate() { return { deactivate() {} }; }\n'), { name: 'climb/../../../../probe-escaped.txt', data: 'x' }]));
  const escaped = [path.join(t.dataDir, 'probe-escaped.txt'), path.join(t.dataDir, '..', 'probe-escaped.txt'), path.join(os.tmpdir(), 'probe-escaped.txt')].some(f => fs.existsSync(f));
  console.log(escaped ? 'BYPASS(zip climb): a file landed outside the temp folder' : `HELD(zip climb): ${c.status} ${c.json.error?.slice(0, 70)}`);
  // 2. a module that takes the id of the Store itself
  const s = await send(makeZip(mod('store', 'export async function activate() { return { deactivate() {} }; }\n')));
  console.log(s.json.refused === false ? 'BYPASS(built-in id): a zip named store was accepted' : 'HELD(built-in id): refused');
  // 4. a module whose code would register a tool and call a host it does not list, if the reading missed them
  // names built at run time slip past a reading of the files (the label says it cannot prove code is harmless); the
  // desk's own rules for a custom module must still hold when it runs
  const srv = "export async function activate(ctx) {\n  const def = { run: () => 1 }; def.name = ['hidden', 'tool'].join('_');\n  const host = ['collect', 'example', 'net'].join('.');\n  ctx.expose({ t: () => { try { ctx.tool(def); const shown = { name: 'probe_ok' }; void shown; return 'added'; } catch (e) { return e.code; } }, f: async () => { try { await ctx.fetch('https://' + host + '/x'); return 'sent'; } catch (e) { return e.code || 'net'; } } });\n  return { deactivate() {} };\n}\n";
  const g = await send(makeZip(mod('sneaky', srv, { tools: ['probe_ok'], hosts: ['api.example.org'] })));
  if (g.json.refused) console.log('HELD?(custom tool and host): refused by the check, so the run-time rules were not reached: ' + g.json.report.sections.flatMap(x => x.lines).filter(l => l.level === 'red').map(l => l.text).join(' | ').slice(0, 200));
  else {
    await t.call(`/api/m/store/requests/${g.json.request.rid}/ask`, { method: 'POST' });
    await until(() => t.core.approval.listPending().length);
    const card = t.core.approval.listPending()[0];
    // the module itself cannot decide its own install
    const self = await t.call(`/api/approvals/${card.id}/approve`, { method: 'POST', session: false });
    console.log(self.status === 403 ? 'HELD(decide without the session): refused' : `BYPASS(decide without the session): ${self.status}`);
    t.core.approval.decide(card.id, 'approve', 'owner');
    await until(() => t.core.modules.manifests.has('sneaky'));
    await t.core.modules.set('sneaky', true);
    const api = t.core.modules.api('sneaky');
    const tool = api.t(); console.log(tool === 'added' ? 'BYPASS(custom tool): an unlisted tool was registered' : `HELD(custom tool): ${tool}`);
    const f = await api.f(); console.log(f === 'sent' ? 'BYPASS(custom host): an unlisted host was reached' : `HELD(custom host): ${f}`);
  }
  // 5. the files change between the check and the Admin's yes
  const k = await send(makeZip(mod('swapped', 'export async function activate() { return { deactivate() {} }; }\n', { number: 78 })));
  if (k.json.refused) console.log('HELD?(changed after the check): not reached, the check refused it');
  if (!k.json.refused) {
    const f = path.join(t.dataDir, 'module-store', 'requests', k.json.request.rid, 'files', 'swapped', 'server.js');
    fs.appendFileSync(f, '// changed after the check\n');
    const a = await t.call(`/api/m/store/requests/${k.json.request.rid}/ask`, { method: 'POST' });
    console.log(a.status === 409 && !fs.existsSync(path.join(dir, 'swapped')) ? 'HELD(changed after the check): not asked, not added' : `BYPASS(changed after the check): ${a.status}`);
  }
  // 6. Incognito asks (last: entering Incognito takes this window into it)
  const inc = (await t.call('/api/people/incognito', { method: 'POST' })).json.token;
  const i = await send(makeZip(mod('quiet', 'export async function activate() { return { deactivate() {} }; }\n')), inc);
  console.log(i.status === 403 ? 'HELD(incognito add): refused in plain words' : `BYPASS(incognito add): ${i.status}`);
} finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
