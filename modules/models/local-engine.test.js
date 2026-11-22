// The local engine (llama-server and one model) with a stand-in download host and a stand-in llama-server on loopback.
// Plumbing only: the stand-in answers like llama-server, it is not a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { testDesk } from '../../test/helpers/desk.js';
import { startDownloadHost, sha, tarGz, autoApprove, until } from '../../test/helpers/download-host.js';
import { unpack } from './unpack.js';
import { LocalEngine } from './local-engine.js';
import PINS from './local-engine.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '..', '..', 'test', 'helpers', 'fake-llama-server.mjs');
const posix = process.platform !== 'win32';
const NO_SH = !posix && 'the stand-in llama-server is a shell script';
const wrapper = `#!/bin/sh\necho run >> ran.txt\nexec "${process.execPath}" "${FAKE}" "$@"\n`;
const modelBody = crypto.randomBytes(64 * 1024);

function pins(host, { archive, archiveSha, tools = true } = {}) {
  archive ||= tarGz([{ name: 'llama-test/', dir: true }, { name: 'llama-test/llama-server', body: wrapper, mode: 0o755 }, { name: 'llama-test/libx.so.1.0', body: 'lib' }, { name: 'llama-test/libx.so', link: 'libx.so.1.0' }]);
  host.files['/engine.tar.gz'] = { body: archive };
  host.files['/small.gguf'] = { body: modelBody };
  return {
    engine: { ...PINS.engine, release: 'b-test', allowHosts: ['127.0.0.1'], builds: [{ id: 'test-cpu', platform: process.platform, arch: process.arch, gpu: 'cpu', label: 'This PC (test)', file: 'engine.tar.gz', url: host.url('/engine.tar.gz'), size: archive.length, sha256: archiveSha || sha(archive), server: 'llama-test/llama-server' }] },
    models: { allowHosts: ['127.0.0.1'], list: [
      { id: 'test-small', name: 'Test Small', publisher: 'Test', repo: 'x/y', file: 'small.gguf', size: modelBody.length, sha256: sha(modelBody), licence: 'Apache-2.0', tools, needsGb: 1, ctx: 2048, serverArgs: [], url: host.url('/small.gguf'), why: 'test' },
      { id: 'test-huge', name: 'Test Huge', publisher: 'Test', repo: 'x/z', file: 'huge.gguf', size: 10 ** 9, sha256: 'a'.repeat(64), licence: 'Apache-2.0', tools: true, needsGb: 100, ctx: 2048, serverArgs: [], url: host.url('/huge.gguf'), why: 'test' }] },
  };
}
const HW = async () => ({ ramGb: 16, ramFreeGb: 10, gpu: null, line: 'Test PC with 16 GB of RAM.' });
/** A desk whose engine uses the stand-in pins (the routes file made core.localEngine; it is swapped for one with test pins). */
async function deskWith(host, opts = {}) {
  const t = await testDesk(opts.desk);
  const old = t.core.localEngine; await old.close();
  t.core.localEngine = new LocalEngine({ storage: t.core.storage, panic: t.core.panic, events: t.core.events, downloads: t.core.downloads, dataDir: t.dataDir, pins: pins(host, opts), hardware: opts.hardware || HW });
  t.core.model.localEngine = t.core.localEngine;
  return t;
}
const freeOwnPort = (port, host) => new Promise((res) => { const s = net.connect({ port, host }); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
const ask = (t, extra = {}) => t.core.model.chat({ model: { provider: 'llama' }, messages: [{ role: 'user', content: 'Reply with one word: ready' }], purpose: 'small', ...extra });

test('local engine: picks a build and the largest model that fits the whole memory of the PC', () => {
  const e = Object.create(LocalEngine.prototype); e.pins = PINS;
  e.platform = 'win32'; e.arch = 'x64';
  assert.equal(e.pickBuild({ gpu: null }).id, 'win-cpu-x64');
  assert.equal(e.pickBuild({ gpu: { dedicated: true, vramGb: 8 } }).id, 'win-vulkan-x64', 'a dedicated card the scan is sure of');
  assert.equal(e.pickBuild({ gpu: { dedicated: true, vramGb: 2 } }).id, 'win-cpu-x64', 'too small a card: processor');
  e.arch = 'arm64'; assert.equal(e.pickBuild({ gpu: null }).id, 'win-cpu-arm64');
  e.platform = 'linux'; e.arch = 'x64'; assert.equal(e.pickBuild({ gpu: { dedicated: true, vramGb: 24 } }).id, 'linux-cpu-x64', 'Linux: processor build always');
  e.platform = 'darwin'; e.arch = 'arm64'; assert.equal(e.pickBuild({}).id, 'mac-arm64');
  e.platform = 'freebsd'; assert.equal(e.pickBuild({}), null);
  e.platform = 'linux'; e.arch = 'x64'; const b = e.pickBuild({});
  assert.equal(e.pickModel({ ramGb: 16, ramFreeGb: 12 }, b).id, 'granite-4.2-3b', 'no graphics card: 3B at most');
  e.platform = 'darwin'; e.arch = 'arm64'; assert.equal(e.pickModel({ ramGb: 16, ramFreeGb: 12 }, e.pickBuild({})).id, 'granite-4.2-8b', 'Apple graphics: the largest that fits');
  e.platform = 'win32'; e.arch = 'x64'; const gpu = { ramGb: 16, ramFreeGb: 12, gpu: { dedicated: true, vramGb: 8 } };
  assert.equal(e.pickModel(gpu, e.pickBuild(gpu)).id, 'granite-4.2-8b', 'a graphics card: the largest that fits');
  e.platform = 'linux'; e.arch = 'x64';
  assert.equal(e.pickModel({ ramGb: 16, ramFreeGb: 1.5 }, b).id, 'granite-4.2-3b', 'memory free this minute does not decide what fits');
  assert.equal(e.pickModel({ ramGb: 8, ramFreeGb: 1 }, b).id, 'granite-4.2-3b');
  assert.equal(e.pickModel({ ramGb: 4, ramFreeGb: 0.5 }, b).id, 'granite-4.0-1b');
  assert.equal(e.pickModel({ ramGb: 2, ramFreeGb: 1 }, b), null, 'nothing that needs more than the whole memory of the PC');
  for (const m of PINS.models.list) { assert.match(m.sha256, /^[0-9a-f]{64}$/); assert.ok(m.size > 0); assert.ok(/^Apache-2\.0$|^MIT$/.test(m.licence)); assert.ok(m.url.includes(m.commit) && m.url.endsWith('/' + m.file)); }
  for (const x of PINS.engine.builds) { assert.match(x.sha256, /^[0-9a-f]{64}$/); assert.ok(x.url.endsWith('/' + x.file)); }
});

test('local engine: no graphics card, the plan offers 3B at most and says why in one line; the 8B can still be chosen by hand', async () => {
  const e = Object.create(LocalEngine.prototype);
  Object.assign(e, { pins: PINS, platform: 'linux', arch: 'x64', hw: null, dir: path.join(os.tmpdir(), 'apd-no-engine-here'), cfg: () => ({ on: true, choice: null, engine: null, model: null, downloads: {} }) });
  e.hardwareFn = async () => ({ ramGb: 32, ramFreeGb: 24, gpu: null, line: 'Test PC with 32 GB of RAM.' });
  const p = await e.plan();
  assert.equal(p.recommended, 'granite-4.2-3b'); assert.equal(p.model.id, 'granite-4.2-3b'); assert.equal(p.ok, true);
  assert.equal(typeof p.note, 'string'); assert.ok(!p.note.includes('\n'), 'one line');
  assert.match(p.note, /graphics card/); assert.match(p.note, /Granite 4\.2 3B/); assert.match(p.note, /Choose another/);
  const big = p.choices.find(c => c.id === 'granite-4.2-8b'); assert.equal(big.fits, true, 'still offered under Choose another');
  const byHand = await e.plan('granite-4.2-8b'); assert.equal(byHand.ok, true); assert.equal(byHand.model.id, 'granite-4.2-8b');
  // a graphics card, or a PC where 3B is the largest that fits anyway: no such line
  e.platform = 'darwin'; e.arch = 'arm64'; e.hw = null;
  const mac = await e.plan(); assert.equal(mac.recommended, 'granite-4.2-8b'); assert.equal(mac.note, null);
  e.platform = 'linux'; e.arch = 'x64'; e.hw = null; e.hardwareFn = async () => ({ ramGb: 8, ramFreeGb: 5, gpu: null });
  const small = await e.plan(); assert.equal(small.recommended, 'granite-4.2-3b'); assert.equal(small.note, null);
});

test('local engine: little free memory is a note, not a refusal, and a fresh check reads the memory again instead of the ten-minute copy', async () => {
  const e = Object.create(LocalEngine.prototype);
  Object.assign(e, { pins: PINS, platform: 'linux', arch: 'x64', hw: null, dir: path.join(os.tmpdir(), 'apd-no-engine-here'), cfg: () => ({ on: true, choice: null, engine: null, model: null, downloads: {} }) });
  let free = 1.5; e.hardwareFn = async () => ({ ramGb: 8, ramFreeGb: free, gpu: null });
  const low = await e.plan();
  assert.equal(low.ok, true); assert.equal(low.recommended, 'granite-4.2-3b'); assert.match(low.freeNote, /Close some programs/); assert.equal(low.lowMemory, true, 'the box can offer to check again');
  free = 5;
  assert.equal((await e.plan()).lowMemory, true, 'a plain read keeps the cached scan');
  const again = await e.plan(null, { fresh: true });
  assert.equal(again.ok, true); assert.equal(again.lowMemory, false); assert.equal(again.freeNote, null); assert.equal(again.recommended, 'granite-4.2-3b');
});

const planner = (hw, platform = 'linux', arch = 'x64') => { const e = Object.create(LocalEngine.prototype); Object.assign(e, { pins: PINS, platform, arch, hw: null, dir: path.join(os.tmpdir(), 'apd-no-engine-here'), cfg: () => ({ on: true, choice: null, engine: null, model: null, downloads: {} }) }); e.hardwareFn = typeof hw === 'function' ? hw : async () => hw; return e; };
const WARN = 'This model needs more memory than this PC has. It may be very slow or not start.';

test('local engine: a 16 GB PC with 1.5 GB free gets a model, with a note to close some programs, never a refusal', async () => {
  const e = planner({ ramGb: 16, ramFreeGb: 1.5, gpu: null });
  const p = await e.plan();
  assert.equal(p.recommended, 'granite-4.2-3b'); assert.equal(p.model.id, 'granite-4.2-3b'); assert.equal(p.ok, true); assert.equal(p.reason, null);
  assert.equal(p.freeNote, 'Close some programs before you use it: it needs about 3.2 GB and about 1.5 GB is free right now.');
  assert.equal(p.choices.length, PINS.models.list.length, 'every model in the pin list');
  for (const c of p.choices) { assert.ok(c.sizeText && c.needsGb > 0); assert.equal(c.fits, true, c.id); }
  const roomy = await planner({ ramGb: 16, ramFreeGb: 12, gpu: null }).plan(); assert.equal(roomy.freeNote, null, 'no note when there is room now');
});

test('local engine: an 8 GB PC with no graphics card keeps the 3B cap; the 8B is listed with the reason and can be chosen with the warning', async () => {
  for (const [platform, arch] of [['win32', 'arm64'], ['win32', 'x64'], ['linux', 'x64']]) {
    const e = planner({ ramGb: 8, ramFreeGb: 6, gpu: null }, platform, arch);
    const p = await e.plan(); assert.equal(p.recommended, 'granite-4.2-3b', platform + arch); assert.equal(p.ok, true);
    const big = p.choices.find(c => c.id === 'granite-4.2-8b'); assert.equal(big.fits, false); assert.match(big.notFit, /6\.6 GB/); assert.match(big.notFit, /4\.8 GB/);
    const byHand = await e.plan('granite-4.2-8b'); assert.equal(byHand.ok, true); assert.equal(byHand.warning, WARN);
  }
  const big = await planner({ ramGb: 32, ramFreeGb: 2, gpu: null }).plan(); assert.equal(big.recommended, 'granite-4.2-3b', 'the cap holds on a big PC too');
});

test('local engine: a 2 GB PC: none recommended, said plainly in one line, every model still listed and choosable with the warning', async () => {
  const e = planner({ ramGb: 2, ramFreeGb: 1, gpu: null }, 'win32', 'arm64');
  const p = await e.plan();
  assert.equal(p.recommended, null); assert.equal(p.model, null); assert.equal(p.ok, false);
  assert.match(p.reason, /2 GB of memory/); assert.match(p.reason, /1\.7 GB/); assert.match(p.reason, /none is recommended/); assert.ok(!p.reason.includes('\n'));
  assert.equal(p.choices.length, PINS.models.list.length); assert.ok(p.choices.every(c => !c.fits && c.notFit));
  const one = await e.plan('granite-4.0-1b'); assert.equal(one.ok, true); assert.equal(one.model.id, 'granite-4.0-1b'); assert.equal(one.warning, WARN);
});

test('local engine: a hardware scan that fails or reads 0 falls back to the system memory count and says so', async () => {
  for (const hw of [async () => { throw new Error('no answer'); }, { ramGb: 0, ramFreeGb: 0, gpu: null }, { ramGb: NaN, ramFreeGb: -1, gpu: null }]) {
    const p = await planner(hw, 'win32', 'arm64').plan();
    assert.equal(p.hardware.memoryFrom, 'system'); assert.match(p.hardware.memoryLine, /system/);
    assert.equal(p.hardware.ramGb, Math.round(os.totalmem() / 1024 ** 3 * 10) / 10);
    assert.ok(p.choices.length === PINS.models.list.length, 'the list is still there');
  }
  const good = await planner({ ramGb: 16, ramFreeGb: 4, gpu: null }).plan(); assert.equal(good.hardware.memoryFrom, 'scan'); assert.equal(good.hardware.memoryLine, null);
  const { readMemory } = await import('./hardware.js');
  assert.equal(readMemory({ total: 16 * 1024 ** 3, available: 2 * 1024 ** 3 }).memoryFrom, 'scan');
  assert.deepEqual(readMemory({ total: 16 * 1024 ** 3, available: 2 * 1024 ** 3 }).ramGb, 16);
  for (const odd of [null, { total: 0, available: 0 }, { total: 16 * 1024 ** 3, available: 20 * 1024 ** 3 }, { total: 'x' }]) {
    const r = readMemory(odd); assert.equal(r.memoryFrom, 'system', JSON.stringify(odd)); assert.ok(r.ramGb > 0 && r.ramFreeGb >= 0 && r.ramFreeGb <= r.ramGb); assert.match(r.memoryLine, /system/);
  }
});

test('local engine: the Models page engine card and the first-start box list every model, none greyed out, a too-large one after the warning', () => {
  const ui = fs.readFileSync(path.join(HERE, 'ui.js'), 'utf8');
  const card = ui.slice(ui.indexOf('function engineCard('), ui.indexOf('const dls ='));
  assert.ok(card.length > 100 && !/disabled: !c\.fits/.test(card), 'no option is disabled for not fitting');
  assert.match(card, /needs about \$\{c\.needsGb\} GB/); assert.match(card, /ui\.confirm\('This model needs more memory than this PC has\. It may be very slow or not start\.'/);
  assert.match(ui, /plan\.freeNote/); assert.match(ui, /plan\.warning/); assert.match(ui, /memoryLine/);
  const shell = fs.readFileSync(path.join(HERE, '..', '..', 'app', 'ui', 'shell.js'), 'utf8');
  const box = shell.slice(shell.indexOf('function localModelBox()'), shell.indexOf('async function firstStep('));
  assert.ok(!/disabled: !c\.fits/.test(box), 'no radio is disabled for not fitting');
  assert.match(box, /'Open Models'/); assert.match(box, /plan\.warning/); assert.match(box, /plan\.freeNote/); assert.match(box, /list\.hidden = false/);
});

test('local engine: the plan for the first-start box, refused without the owner, and the full flow to an answer on loopback', { skip: NO_SH }, async () => {
  const host = await startDownloadHost({}); const t = await deskWith(host, { desk: { modules: ['models'] } }); const ok = autoApprove(t.core);
  try {
    const plan = (await t.call('/api/local-engine/plan')).json;
    assert.equal(plan.ok, true); assert.equal(plan.model.id, 'test-small', 'the huge one does not fit');
    assert.equal(plan.totalBytes, plan.engine.size + plan.model.size); assert.ok(plan.totalText && plan.engine.sizeText && plan.model.sizeText);
    assert.ok(plan.licences.some(l => /llama\.cpp b-test \(MIT\)/.test(l)) && plan.licences.some(l => /Test Small by Test \(Apache-2\.0\)/.test(l)));
    assert.equal((await t.call('/api/local-engine/get', { body: {}, session: false })).status, 403, 'not without the owner');
    await assert.rejects(t.core.localEngine.get({ owner: false }), /Only the owner/);
    const huge = (await t.call('/api/local-engine/plan?model=test-huge')).json;
    assert.equal(huge.ok, true, 'a model too large for this PC can still be chosen'); assert.equal(huge.model.fits, false);
    assert.equal(huge.warning, 'This model needs more memory than this PC has. It may be very slow or not start.');
    assert.equal(t.core.localEngine.status().phase, 'none');
    const got = (await t.call('/api/local-engine/get', { body: {} })).json;
    assert.equal(got.phase, 'downloading'); assert.equal(got.downloads.length, 2);
    assert.equal((await t.call('/api/downloads')).json.summary.total, 2);
    await until(() => t.core.localEngine.status().phase === 'ready', 15000);
    assert.equal(ok.seen.length, 2, 'two install cards'); assert.ok(ok.seen.every(s => s.action === 'install'));
    assert.match(ok.seen[0].title, /llama\.cpp b-test .*\(\d/); assert.match(ok.seen[1].title, /Test Small \(64\.0 KB\)/);
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'llama', 'incoming', 'engine.tar.gz')), 'the archive is removed once unpacked');
    assert.ok(fs.existsSync(path.join(t.dataDir, 'llama', 'engine', 'test-cpu', 'llama-test', 'libx.so')), 'a link is copied from its target');
    // the door: a local provider, started on first need, with a key
    const r = await ask(t);
    assert.equal(r.text.trim(), 'ready'); assert.equal(r.provider, 'llama'); assert.equal(r.label, 'Local model on this PC · Test Small');
    const e = t.core.localEngine; const args = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'llama', 'engine', 'test-cpu', 'llama-test', 'args.json'), 'utf8'));
    assert.equal(args.argv[args.argv.indexOf('--host') + 1], '127.0.0.1'); assert.ok(args.argv.includes('--api-key-file') && args.argv.includes('--offline') && args.argv.includes('--no-webui'));
    assert.deepEqual(args.env, [], 'no LLAMA_/HF_ settings reach it');
    assert.ok(!fs.readdirSync(path.join(t.dataDir, 'llama', 'run')).length, 'the key file is gone once it started');
    const noKey = await fetch(`http://127.0.0.1:${e.port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(noKey.status, 401, 'a call without the key is refused');
    const other = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4');
    if (other) assert.equal(await freeOwnPort(e.port, other.address), false, `not reachable on ${other.address}`);
    // listed for the screen and the per-agent picker, and in the default chain where Ollama is
    assert.ok((await t.core.model.active()).some(a => a.provider === 'llama' && a.label === 'Local model on this PC'));
    const chain = t.core.model.resolve(null).whenOnline.map(c => c.provider);
    assert.ok(chain.indexOf('llama') === chain.indexOf('ollama') + 1, chain.join(','));
    const groups = (await t.call('/api/m/models/available')).json.groups;
    assert.ok(groups.some(g => g.provider === 'llama' && g.models.includes('test-small') && /Local model on this PC/.test(g.label)), 'offered in the per-agent picker');
    const tested = (await t.call('/api/m/models/test', { body: { provider: 'llama' } })).json;
    assert.equal(tested.ok, true, tested.error); assert.equal(tested.local, true, 'the fair local test');
    // Offline: downloads stop, a ready engine still answers
    t.core.settings.set('online', false);
    const off = await t.core.model.chat({ messages: [{ role: 'user', content: 'Reply with one word: ready' }], purpose: 'small' });
    assert.equal(off.provider, 'llama'); assert.equal(off.text.trim(), 'ready');
    t.core.settings.set('online', true);
  } finally { ok.stop(); await t.close(); await host.close(); }
});

test('local engine: Panic stops it at once and it does not come back by itself; it restarts if it exits; idle stops it', { skip: NO_SH }, async () => {
  const host = await startDownloadHost({}); const t = await deskWith(host); const ok = autoApprove(t.core);
  try {
    await t.core.localEngine.get({ owner: true });
    await until(() => t.core.localEngine.status().phase === 'ready', 15000);
    await ask(t); const e = t.core.localEngine; const port = e.port;
    // exits by itself: started again
    const pid1 = e.proc.pid; process.kill(pid1, 'SIGKILL');
    await until(() => e.proc && e.proc.pid !== pid1 && e.phase === 'running', 10000);
    assert.equal(e.phase, 'running', 'restarted after it exited');
    await t.call('/api/panic', { body: {} });
    assert.equal(e.proc, null); assert.equal(await freeOwnPort(e.port || port, '127.0.0.1'), false, 'the port is closed');
    await assert.rejects(ask(t), (err) => err.code === 'halted');
    await t.call('/api/panic/resume', { body: {} });
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(e.proc, null, 'not started again by itself after Panic');
    assert.equal(e.status().phase, 'stopped'); assert.match(e.status().reason, /Panic/);
    assert.equal((await ask(t)).text.trim(), 'ready', 'the next ask starts it');
    e.save({ idleMinutes: 0.0001 }); await new Promise(r => setTimeout(r, 30)); e.idleCheck();
    await until(() => !e.proc, 5000); assert.equal(e.status().phase, 'stopped'); assert.match(e.status().reason, /without use/);
  } finally { ok.stop(); await t.close(); await host.close(); }
});

test('local engine: off prevents downloads and starts; Remove frees its folder only; a wrong checksum is never run', { skip: NO_SH }, async () => {
  const host = await startDownloadHost({}); const t = await deskWith(host); const ok = autoApprove(t.core);
  try {
    const e = t.core.localEngine;
    await t.call('/api/local-engine/switch', { body: { on: false } });
    assert.equal(e.status().phase, 'off');
    assert.equal((await t.call('/api/local-engine/get', { body: {} })).status, 409, 'no downloads while off');
    await t.call('/api/local-engine/switch', { body: { on: true } });
    await e.get({ owner: true }); await until(() => e.status().phase === 'ready', 15000);
    await ask(t);
    await t.call('/api/local-engine/switch', { body: { on: false } });
    assert.equal(e.proc, null, 'switching off stops it');
    await assert.rejects(ask(t), /not available|No model/i);
    await t.call('/api/local-engine/switch', { body: { on: true } });
    fs.writeFileSync(path.join(t.dataDir, 'keep-me.txt'), 'mine');
    const rm = (await t.call('/api/local-engine/remove', { body: {} })).json;
    assert.equal(rm.phase, 'none'); assert.ok(rm.freed > modelBody.length);
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'llama')), 'its folder is gone');
    assert.ok(fs.existsSync(path.join(t.dataDir, 'keep-me.txt')) && fs.existsSync(path.join(t.dataDir, 'apd.sqlite')), 'nothing else is touched');
  } finally { ok.stop(); await t.close(); await host.close(); }

  const host2 = await startDownloadHost({}); const t2 = await deskWith(host2, { archiveSha: 'b'.repeat(64) }); const ok2 = autoApprove(t2.core);
  try {
    await t2.core.localEngine.get({ owner: true });
    await until(() => !t2.core.localEngine.status().downloads.length, 15000);
    const st = t2.core.localEngine.status();
    assert.equal(st.phase, 'failed'); assert.match(st.reason, /SHA-256/);
    assert.ok(!fs.existsSync(path.join(t2.dataDir, 'llama', 'engine')), 'nothing was unpacked');
    assert.ok(!fs.existsSync(path.join(t2.dataDir, 'llama', 'incoming', 'engine.tar.gz')) && !fs.existsSync(path.join(t2.dataDir, 'llama', 'incoming', 'engine.tar.gz.part')), 'the bad file is deleted');
    await assert.rejects(ask(t2), /not available|No model/i);
  } finally { ok2.stop(); await t2.close(); await host2.close(); }
});

test('local engine: a model that cannot call tools is skipped for a turn with tools, with a reason that names tools', { skip: NO_SH }, async () => {
  const host = await startDownloadHost({}); const t = await deskWith(host, { tools: false }); const ok = autoApprove(t.core);
  try {
    await t.core.localEngine.get({ owner: true }); await until(() => t.core.localEngine.status().phase === 'ready', 15000);
    await assert.rejects(ask(t, { tools: [{ name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } }] }), (e) => /cannot use tools/.test(e.message) && /tool/i.test(e.message));
    assert.equal((await ask(t)).text.trim(), 'ready', 'without tools it answers');
  } finally { ok.stop(); await t.close(); await host.close(); }
});

test('unpack: an entry outside the folder, an absolute path or a link out of the folder refuses the whole archive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-unpack-'));
  try {
    const zip = new AdmZip(); zip.addFile('ok.txt', Buffer.from('a')); zip.addFile('x.txt', Buffer.from('b')); zip.getEntries()[1].entryName = '../../escape.txt';
    fs.writeFileSync(path.join(dir, 'slip.zip'), zip.toBuffer());
    assert.throws(() => unpack(path.join(dir, 'slip.zip'), path.join(dir, 'out1')), /outside its folder/);
    assert.ok(!fs.existsSync(path.join(dir, 'out1')) && !fs.existsSync(path.join(dir, '..', 'escape.txt')));
    for (const [n, entries] of [['abs', [{ name: '/etc/x', body: 'x' }]], ['dots', [{ name: 'a/../../x', body: 'x' }]], ['link', [{ name: 'l', link: '../../etc/passwd' }]], ['abslink', [{ name: 'l', link: '/etc/passwd' }]]]) {
      fs.writeFileSync(path.join(dir, n + '.tar.gz'), tarGz(entries));
      assert.throws(() => unpack(path.join(dir, n + '.tar.gz'), path.join(dir, 'out-' + n)), /outside its folder|points outside/, n);
      assert.ok(!fs.existsSync(path.join(dir, 'out-' + n)), n + ': nothing written');
    }
    fs.writeFileSync(path.join(dir, 'good.tar.gz'), tarGz([{ name: 'p/a.so.1', body: 'lib' }, { name: 'p/a.so', link: 'a.so.1' }, { name: 'p/run', body: '#!/bin/sh', mode: 0o755 }]));
    unpack(path.join(dir, 'good.tar.gz'), path.join(dir, 'good'));
    assert.equal(fs.readFileSync(path.join(dir, 'good', 'p', 'a.so'), 'utf8'), 'lib'); assert.ok(!fs.lstatSync(path.join(dir, 'good', 'p', 'a.so')).isSymbolicLink());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
