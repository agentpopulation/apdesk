// Built in or custom (contracts/MODULES.md, "Custom modules"): the flag in /api/modules, a folder found again while the
// desk runs, the rules an added module lives under (its listed tools and hosts only, never core, never on by itself),
// ctx.incognito, and the Store's house-wide door.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { testDesk } from '../../test/helpers/desk.js';
import { hostDeclared, ADDED_FILE } from './modules.js';

const SRV = `export async function activate(ctx) {
  ctx.route('GET', '/who', (req, res) => ctx.json(res, { incognito: ctx.incognito, door: typeof ctx.moduleFolder }));
  ctx.expose({ tool: (name) => { try { ctx.tool({ name, run: () => ({ ok: true }) }); return 'ok'; } catch (e) { return e.code; } },
    fetch: async (u) => { try { await ctx.fetch(u); return 'sent'; } catch (e) { return e.code || 'net'; } } });
  return { deactivate() {} };
}
`;
function folder(dir, id, manifest = {}, { added = null, server = SRV } = {}) {
  const d = path.join(dir, id); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'module.json'), JSON.stringify({ id, number: 70, name: id, description: 'A test module.', kind: 'switch-on', status: 'stub', tools: [], hosts: [], ...manifest }));
  fs.writeFileSync(path.join(d, 'server.js'), server);
  if (added) fs.writeFileSync(path.join(d, ADDED_FILE), JSON.stringify(added));
  return d;
}
function modulesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-mods-'));
  folder(dir, 'alpha', { number: 60 });
  fs.writeFileSync(path.join(dir, 'shipped.json'), JSON.stringify({ version: '0.1.2', entries: ['alpha', 'shipped.json'] }));
  return dir;
}

test('custom is every folder not in shipped.json; the Store record shows where it came from, never a path', async () => {
  const dir = modulesDir();
  folder(dir, 'gamma', { number: 61 });
  folder(dir, 'delta', { number: 62 }, { added: { from: 'file', at: '2026-11-22T10:00:00.000Z', signedBy: null, label: { can: ['adds a place in the menu: Delta'], hosts: [], tools: [], signed: 'Not signed.', red: 0, yellow: 1 }, dir: '/secret/path' } });
  const t = await testDesk({ modulesDir: dir });
  try {
    const list = (await t.call('/api/modules')).json.modules;
    const by = Object.fromEntries(list.map(m => [m.id, m]));
    assert.equal(by.alpha.custom, false); assert.equal(by.alpha.added, undefined);
    assert.equal(by.gamma.custom, true); assert.equal(by.gamma.added.from, 'by hand');
    assert.equal(by.delta.custom, true); assert.equal(by.delta.added.from, 'file'); assert.equal(by.delta.added.label.yellow, 1);
    assert.doesNotMatch(JSON.stringify(list), /secret\/path|apd-mods-/, 'no path reaches the page');
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an added module is never core and never on by itself; one whose id is not its folder is not loaded', async () => {
  const dir = modulesDir();
  folder(dir, 'gamma', { number: 61, kind: 'core', defaultOn: true, boot: true });
  folder(dir, 'theta', { id: 'alpha', number: 63 });
  const t = await testDesk({ modulesDir: dir });
  try {
    const g = t.core.modules.list().find(m => m.id === 'gamma');
    assert.equal(g.kind, 'switch-on'); assert.equal(g.on, false); assert.equal(g.defaultOn, false); assert.equal(g.boot, false);
    assert.ok(!t.core.modules.list().some(m => m.id === 'theta'));
    assert.equal(t.core.modules.manifests.get('alpha').dir, path.join(dir, 'alpha'), 'a custom folder cannot shadow a built-in module');
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discover runs again while the desk runs: a new folder appears; a replaced one that is on keeps running and waits for a restart', async () => {
  const dir = modulesDir();
  const t = await testDesk({ modulesDir: dir });
  try {
    assert.ok(!t.core.modules.manifests.has('gamma'));
    folder(dir, 'gamma', { number: 61 });
    t.core.modules.discover();
    assert.equal(t.core.modules.list().find(m => m.id === 'gamma')?.on, false, 'found, and off');
    await t.core.modules.set('gamma', true);
    fs.writeFileSync(path.join(dir, 'gamma', 'module.json'), JSON.stringify({ id: 'gamma', number: 61, name: 'Gamma two', description: 'A test module.', kind: 'switch-on', status: 'stub' }));
    t.core.modules.discover();
    const g = t.core.modules.list().find(m => m.id === 'gamma');
    assert.equal(g.on, true); assert.equal(g.restart, true); assert.equal(g.name, 'gamma', 'the running manifest stays until a restart');
    assert.equal((await t.call('/api/m/gamma/who')).status, 200, 'its routes still answer');
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an added module adds only the tools and reaches only the hosts its module.json names; a built-in one is not limited this way', async () => {
  const dir = modulesDir();
  folder(dir, 'gamma', { number: 61, tools: ['gamma_ok'], hosts: ['api.example.org', '*.example.net'] });
  const t = await testDesk({ modulesDir: dir });
  try {
    await t.core.modules.set('gamma', true); await t.core.modules.set('alpha', true);
    const g = t.core.modules.api('gamma'), a = t.core.modules.api('alpha');
    assert.equal(g.tool('gamma_ok'), 'ok'); assert.equal(g.tool('quiet_helper'), 'tool_not_listed');
    assert.equal(a.tool('anything_at_all'), 'ok');
    assert.equal(await g.fetch('https://rates.example.com/x'), 'host_not_listed');
    assert.equal(await g.fetch('http://127.0.0.1:9/x'), 'host_not_listed', 'a program on this PC too');
    assert.notEqual(await a.fetch('https://rates.example.com/x'), 'host_not_listed');
    assert.ok(hostDeclared(['*.example.net'], 'a.example.net') && hostDeclared(['*'], 'x.example') && !hostDeclared(['example.org'], 'evil.example'));
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ctx.incognito is true only in an Incognito space; only the built-in Store gets the folder door', async () => {
  const dir = modulesDir();
  folder(dir, 'store', { number: 16, kind: 'core' });          // a stand-in Store in a built-in folder
  fs.writeFileSync(path.join(dir, 'shipped.json'), JSON.stringify({ version: '0.1.2', entries: ['alpha', 'store', 'shipped.json'] }));
  const t = await testDesk({ modulesDir: dir });
  try {
    await t.core.modules.set('alpha', true);
    assert.deepEqual((await t.call('/api/m/alpha/who')).json, { incognito: false, door: 'undefined' });
    assert.equal((await t.call('/api/m/store/who')).json.door, 'object');
    const inc = await t.call('/api/people/incognito', { method: 'POST' });
    const tok = inc.json.token;
    const r = await t.call('/api/m/alpha/who', { session: false, headers: { 'x-apd-session': tok } });
    assert.equal(r.json.incognito, true);
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// The lock stays for the life of the process once an added module is loaded, so this file cannot show the state before it.
test('an added module cannot make code from text, even by a name put together while it runs (the control, before any added module, is in test/code-from-text.test.js)', async () => {
  const dir = modulesDir();
  const TRY = `export async function activate(ctx) {
  ctx.expose({ make: (a, b) => { try { const F = ctx.log[a + b]; return F('return 7')(); } catch (e) { return e.code || e.name; } } });
  return { deactivate() {} };
}
`;
  folder(dir, 'alpha', { number: 60 }, { server: TRY });
  folder(dir, 'delta', { number: 62 }, { server: TRY });
  const t = await testDesk({ modulesDir: dir });
  try {
    await t.core.modules.set('alpha', true); await t.core.modules.set('delta', true);
    assert.equal(t.core.modules.api('delta').make('constr', 'uctor'), 'code_from_text_closed');
    assert.equal(t.core.modules.api('alpha').make('constr', 'uctor'), 'code_from_text_closed', 'and it stays closed for the whole desk from then on');
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
