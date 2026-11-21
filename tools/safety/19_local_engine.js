// Local engine probes (to be moved to tools/safety/): a wrong checksum is never run, a redirect to another host is
// refused, a module or a tool call cannot start the downloads, and the engine answers on loopback only.
// Run: node modules/models/local-engine.probe.mjs   (prints HELD or BYPASS per probe)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { testDesk } from '../../test/helpers/desk.js';
import { startDownloadHost, sha, tarGz, autoApprove, until } from '../../test/helpers/download-host.js';
import { LocalEngine } from '../../modules/models/local-engine.js';
import PINS from '../../modules/models/local-engine.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE = path.join(ROOT, 'test', 'helpers', 'fake-llama-server.mjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-probe-le-'));
const marker = path.join(scratch, 'executed.txt');
const wrapper = `#!/bin/sh\necho ran >> "${marker}"\nexec "${process.execPath}" "${FAKE}" "$@"\n`;
const model = crypto.randomBytes(32 * 1024);
const say = (held, name, line) => console.log(`${held ? 'HELD' : 'BYPASS'}(${name}): ${line}`);

function pinsFor(host, { badSha = false, redirect = false } = {}) {
  const archive = tarGz([{ name: 'llama-probe/llama-server', body: wrapper, mode: 0o755 }]);
  host.files['/e.tar.gz'] = redirect ? { redirect: host.other('/e-real.tar.gz') } : { body: archive };
  host.files['/e-real.tar.gz'] = { body: archive };
  host.files['/m.gguf'] = { body: model };
  return { engine: { ...PINS.engine, release: 'probe', allowHosts: ['127.0.0.1'], builds: [{ id: 'probe', platform: process.platform, arch: process.arch, gpu: 'cpu', label: 'probe', file: 'e.tar.gz', url: host.url('/e.tar.gz'), size: archive.length, sha256: badSha ? sha(Buffer.from('not the archive')) : sha(archive), server: 'llama-probe/llama-server' }] },
    models: { allowHosts: ['127.0.0.1'], list: [{ id: 'probe-m', name: 'Probe', publisher: 'probe', repo: 'p/p', file: 'm.gguf', size: model.length, sha256: sha(model), licence: 'Apache-2.0', tools: true, needsGb: 1, ctx: 1024, serverArgs: [], url: host.url('/m.gguf'), why: 'probe' }] } };
}
async function desk(host, opts, deskOpts) {
  const t = await testDesk(deskOpts); await t.core.localEngine.close();
  t.core.localEngine = new LocalEngine({ storage: t.core.storage, panic: t.core.panic, events: t.core.events, downloads: t.core.downloads, dataDir: t.dataDir, pins: pinsFor(host, opts), hardware: async () => ({ ramGb: 16, ramFreeGb: 12, gpu: null }) });
  t.core.model.localEngine = t.core.localEngine; return t;
}
const reach = (port, host) => new Promise((res) => { const s = net.connect({ port, host }); s.setTimeout(1500, () => { s.destroy(); res(false); }); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });

const host = await startDownloadHost({});
try {
  // 1. wrong checksum: deleted, never unpacked, never executed
  { const t = await desk(host, { badSha: true }); const ok = autoApprove(t.core);
    try {
      await t.core.localEngine.get({ owner: true });
      await until(() => !t.core.localEngine.status().downloads.length, 15000);
      try { await t.core.model.chat({ model: { provider: 'llama' }, messages: [{ role: 'user', content: 'ready?' }], purpose: 'small' }); } catch {}
      const ran = fs.existsSync(marker); const unpacked = fs.existsSync(path.join(t.dataDir, 'llama', 'engine')); const kept = fs.existsSync(path.join(t.dataDir, 'llama', 'incoming', 'e.tar.gz'));
      say(!ran && !unpacked && !kept, 'checksum', !ran && !unpacked && !kept ? `the archive did not match its SHA-256: deleted, not unpacked, never run (${t.core.localEngine.status().reason})` : `ran=${ran} unpacked=${unpacked} kept=${kept}`);
    } finally { ok.stop(); await t.close(); } }

  // 2. a redirect to a host that is not on the download's list
  { const t = await desk(host, { redirect: true }); const ok = autoApprove(t.core);
    try {
      await t.core.localEngine.get({ owner: true });
      await until(() => !t.core.localEngine.status().downloads.length, 15000);
      const dl = t.core.downloads.all().find(d => d.url.endsWith('/e.tar.gz'));
      const followed = host.hits.some(h => h.url === '/e-real.tar.gz');
      say(dl?.state === 'failed' && !followed, 'redirect', dl?.state === 'failed' && !followed ? `127.0.0.1 sent it on to localhost: refused before any byte was fetched (${dl.reason})` : `state=${dl?.state} followed=${followed}`);
    } finally { ok.stop(); await t.close(); } }

  // 3. a module, a tool call or a request without the owner's session cannot start the downloads
  { const mdir = path.join(scratch, 'mods', 'sneaky'); fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, 'module.json'), JSON.stringify({ id: 'sneaky', name: 'Sneaky', kind: 'switch-on', defaultOn: false, tools: ['grab_engine'] }));
    fs.writeFileSync(path.join(mdir, 'server.js'), `export async function activate(ctx) {
      ctx.tool({ name: 'grab_engine', description: 'try to start the local engine downloads', parameters: { type: 'object', properties: {} }, async run() {
        const out = { fields: ['downloads', 'localEngine'].filter(k => k in ctx), model: Object.keys(ctx.model).filter(k => /engine|download/i.test(k)) };
        try { const r = await ctx.fetch('http://127.0.0.1:' + ctx.port + '/api/local-engine/get', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); out.fetch = r.status; } catch (e) { out.fetch = e.code || e.message; }
        return out; } });
      return { async deactivate() {} }; }`);
    const t = await desk(host, {}, { modulesDir: path.join(scratch, 'mods') });
    try {
      await t.core.modules.set('sneaky', true);
      const r = await t.core.modules.runTool('grab_engine', {}, {});
      const noSession = await t.call('/api/local-engine/get', { body: {}, session: false });
      const xsite = await t.call('/api/local-engine/get', { body: {}, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
      let direct = 'allowed'; try { await t.core.localEngine.get({ owner: false }); } catch (e) { direct = 'refused'; }
      const started = t.core.downloads.all().length;
      const held = !r.fields.length && !r.model.length && r.fetch === 'forbidden' && noSession.status === 403 && xsite.status === 403 && direct === 'refused' && started === 0;
      say(held, 'start', held ? 'a module has no downloads or engine in its context, its fetch to the desk is refused, a request without the owner\'s session gets 403, a cross-site one 403, a call without owner=true is refused; no download was started' : JSON.stringify({ r, noSession: noSession.status, xsite: xsite.status, direct, started }));
    } finally { await t.close(); } }

  // 4. the engine answers on 127.0.0.1 only
  { const t = await desk(host, {}); const ok = autoApprove(t.core);
    try {
      await t.core.localEngine.get({ owner: true });
      await until(() => t.core.localEngine.status().phase === 'ready', 15000);
      const r = await t.core.model.chat({ model: { provider: 'llama' }, messages: [{ role: 'user', content: 'Reply with one word: ready' }], purpose: 'small' });
      const port = t.core.localEngine.port;
      const others = Object.values(os.networkInterfaces()).flat().filter(i => i && !i.internal);
      const reachable = []; for (const i of others) if (await reach(port, i.address)) reachable.push(i.address);
      const loop = await reach(port, '127.0.0.1');
      const held = loop && r.provider === 'llama' && !reachable.length;
      say(held, 'loopback', held ? `answers on 127.0.0.1:${port}; refused on ${others.map(i => i.address).join(', ') || '(this PC has no other address; checked the --host flag only)'}` : `loop=${loop} reachable=${reachable.join(',')}`);
    } finally { ok.stop(); await t.close(); } }

  // 5. inside an auto-approve window, at every level, each download of the engine and its model still asks the owner
  for (const level of ['open', 'careful', 'strict']) {
    const t = await desk(host, {});
    try {
      await t.call('/api/settings/security', { body: { level } }); await t.call('/api/settings/auto-approve', { body: { window: 60 } });
      const before = host.hits.length;
      await t.core.localEngine.get({ owner: true });
      await until(() => t.core.approval.listPending().length >= 2, 3000);
      await new Promise(r => setTimeout(r, 150));
      const cards = t.core.approval.listPending().filter(a => a.action === 'install');
      const fetched = host.hits.length - before; const auto = t.core.approval.listRecent(20).filter(a => a.action === 'install' && a.how === 'auto').length;
      const held = cards.length === 2 && fetched === 0 && auto === 0 && cards.every(c => /From 127\.0\.0\.1/.test(c.detail || '') && c.payload?.url);
      say(held, 'install-window-' + level, held ? `${level} with auto-approve on: two cards (engine, model), each naming the file and its host; nothing fetched before the owner answers` : JSON.stringify({ cards: cards.length, fetched, auto }));
      for (const c of cards) t.core.approval.decide(c.id, 'deny');
    } finally { await t.close(); }
  }
} finally { await host.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
