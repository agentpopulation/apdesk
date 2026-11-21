// The downloads service (app/core/downloads.js) against a stand-in download host on loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import crypto from 'node:crypto';
import { testDesk } from './helpers/desk.js';
import { createDesk } from '../app/server.js';
import { startDownloadHost, sha, autoApprove, until } from './helpers/download-host.js';

const ALLOW = ['127.0.0.1'];
const spec = (t, host, p, body, extra = {}) => ({ title: 'Test file', url: host.url(p), allowHosts: ALLOW, size: body.length, sha256: sha(body), to: path.join(t.dataDir, 'dl', p.replace(/\W/g, '') + '.bin'), kind: 'test', ...extra });

test('downloads: a good file is asked for, fetched, verified and saved; the list has a summary for the top bar', async () => {
  const body = crypto.randomBytes(300 * 1024); const host = await startDownloadHost({ '/good': { body } });
  const t = await testDesk(); const ok = autoApprove(t.core);
  try {
    const d = await t.core.downloads.start(spec(t, host, '/good', body));
    assert.equal(d.state, 'waiting', 'the owner is asked first');
    const r = await t.core.downloads.whenDone(d.id);
    assert.equal(r.state, 'done', r.reason);
    assert.equal(ok.seen.length, 1); assert.equal(ok.seen[0].action, 'install'); assert.match(ok.seen[0].title, /Test file \(300\.0 KB\)/);
    assert.ok(fs.readFileSync(path.join(t.dataDir, 'dl', 'good.bin')).equals(body));
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'dl', 'good.bin.part')));
    const list = (await t.call('/api/downloads')).json;
    assert.equal(list.downloads[0].state, 'done'); assert.equal(list.downloads[0].done, body.length);
    assert.deepEqual({ active: list.summary.active, total: list.summary.total }, { active: 0, total: 0 });
  } finally { ok.stop(); await t.close(); await host.close(); }
});

test('downloads: a wrong checksum deletes the file; a file larger than stated is stopped and deleted', async () => {
  const body = crypto.randomBytes(200 * 1024);
  const host = await startDownloadHost({ '/bad': { body }, '/big': { body, extra: Buffer.alloc(5000) }, '/grows': { body, extra: Buffer.alloc(5000), noLength: true } });
  const t = await testDesk(); const ok = autoApprove(t.core);
  try {
    const bad = await t.core.downloads.whenDone((await t.core.downloads.start(spec(t, host, '/bad', body, { sha256: sha(Buffer.from('other')) }))).id);
    assert.equal(bad.state, 'failed'); assert.match(bad.reason, /did not match its SHA-256/);
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'dl', 'bad.bin')) && !fs.existsSync(path.join(t.dataDir, 'dl', 'bad.bin.part')), 'nothing of it is kept');
    for (const p of ['/big', '/grows']) {
      const r = await t.core.downloads.whenDone((await t.core.downloads.start(spec(t, host, p, body))).id);
      assert.equal(r.state, 'failed', p); assert.match(r.reason, /larger than stated|grew past its stated size/, p);
      assert.ok(!fs.existsSync(path.join(t.dataDir, 'dl', p.slice(1) + '.bin.part')), p + ': half file deleted');
    }
  } finally { ok.stop(); await t.close(); await host.close(); }
});

test('downloads: pause, resume with a range request, cancel; a redirect to a host that is not allowed is refused', async () => {
  const body = crypto.randomBytes(1024 * 1024);
  const host = await startDownloadHost({ '/slow': { body, slowMs: 15, chunk: 16 * 1024 }, '/slow2': { body, slowMs: 15, chunk: 16 * 1024 } });
  host.files['/away'] = { redirect: host.other('/slow') };   // same server, other host name: not on the list
  const t = await testDesk(); const ok = autoApprove(t.core); const D = t.core.downloads;
  try {
    const d = await D.start(spec(t, host, '/slow', body));
    await until(() => D.get(d.id).state === 'running' && fs.existsSync(D.get(d.id).to + '.part') && fs.statSync(D.get(d.id).to + '.part').size > 100 * 1024);
    assert.equal((await t.call(`/api/downloads/${d.id}/pause`, { body: {}, session: false })).status, 403, 'pause needs the owner');
    assert.equal((await t.call(`/api/downloads/${d.id}/pause`, { body: {} })).json.state, 'paused');
    await new Promise(r => setTimeout(r, 150));
    const had = fs.statSync(D.get(d.id).to + '.part').size; assert.ok(had > 0 && had < body.length);
    assert.equal((await t.call(`/api/downloads/${d.id}/resume`, { body: {} })).json.state, 'queued');
    const r = await D.whenDone(d.id);
    assert.equal(r.state, 'done', r.reason);
    assert.ok(host.hits.some(h => h.url === '/slow' && h.range === `bytes=${had}-`), 'resumed with a range request');
    assert.ok(fs.readFileSync(D.get(d.id).to).equals(body));
    const c = await D.start(spec(t, host, '/slow2', body));
    await until(() => D.get(c.id).state === 'running');
    assert.equal((await t.call(`/api/downloads/${c.id}/cancel`, { body: {} })).json.state, 'cancelled');
    await new Promise(r => setTimeout(r, 100));
    assert.ok(!fs.existsSync(D.get(c.id).to + '.part') && !fs.existsSync(D.get(c.id).to), 'cancel leaves nothing');
    const away = await D.whenDone((await D.start(spec(t, host, '/away', body))).id);
    assert.equal(away.state, 'failed'); assert.match(away.reason, /sent on to localhost, which is not allowed/);
    await assert.rejects(D.start({ ...spec(t, host, '/slow', body), url: 'http://localhost:1/x' }), /not on the list of hosts/);
    await assert.rejects(D.start({ ...spec(t, host, '/slow', body), to: path.join(os.tmpdir(), 'outside.bin') }), /only inside the desk's own folder/);
  } finally { ok.stop(); await t.close(); await host.close(); }
});

test('downloads: Panic pauses and they stay paused after Resume; Offline pauses with a plain reason and goes on when online', async () => {
  const body = crypto.randomBytes(1024 * 1024);
  const host = await startDownloadHost({ '/a': { body, slowMs: 15, chunk: 16 * 1024 }, '/b': { body, slowMs: 15, chunk: 16 * 1024 } });
  const t = await testDesk(); const ok = autoApprove(t.core); const D = t.core.downloads;
  try {
    const a = await D.start(spec(t, host, '/a', body));
    await until(() => D.get(a.id).state === 'running');
    await t.call('/api/panic', { body: {} });
    assert.equal(D.get(a.id).state, 'paused'); assert.match(D.get(a.id).reason, /Panic/);
    await t.call('/api/panic/resume', { body: {} });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(D.get(a.id).state, 'paused', 'not resumed by itself after Panic');
    D.resume(a.id);
    assert.equal((await D.whenDone(a.id)).state, 'done');

    const b = await D.start(spec(t, host, '/b', body));
    await until(() => D.get(b.id).state === 'running');
    t.core.settings.set('online', false);
    assert.equal(D.get(b.id).state, 'paused'); assert.match(D.get(b.id).reason, /the desk is offline/);
    assert.equal((await t.call(`/api/downloads/${b.id}/resume`, { body: {} })).status, 409, 'cannot resume while offline');
    t.core.settings.set('online', true);
    assert.equal((await D.whenDone(b.id)).state, 'done');
  } finally { ok.stop(); await t.close(); await host.close(); }
});

test('downloads: at most two run at once, and a download survives a desk restart (its half file is resumed)', async () => {
  const body = crypto.randomBytes(1024 * 1024);
  const host = await startDownloadHost({ '/1': { body, slowMs: 10, chunk: 16 * 1024 }, '/2': { body, slowMs: 10, chunk: 16 * 1024 }, '/3': { body, slowMs: 10, chunk: 16 * 1024 } });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-dl-'));
  let desk = await createDesk({ dataDir, port: 0, quiet: true, env: {}, modules: [] }); await desk.start();
  let ok = autoApprove(desk.core);
  try {
    const t = { dataDir };
    const ids = [];
    for (const p of ['/1', '/2', '/3']) ids.push((await desk.core.downloads.start(spec(t, host, p, body))).id);
    await until(() => desk.core.downloads.summary().running === 2);
    assert.equal(desk.core.downloads.summary().running, 2); assert.equal(desk.core.downloads.summary().total, 3);
    await until(() => fs.existsSync(path.join(dataDir, 'dl', '1.bin.part')) && fs.statSync(path.join(dataDir, 'dl', '1.bin.part')).size > 64 * 1024);
    ok.stop(); await desk.stop();
    const half = fs.statSync(path.join(dataDir, 'dl', '1.bin.part')).size;
    desk = await createDesk({ dataDir, port: 0, quiet: true, env: {}, modules: [] }); await desk.start(); ok = autoApprove(desk.core);
    for (const id of ids) assert.equal((await desk.core.downloads.whenDone(id)).state, 'done');
    assert.ok(host.hits.some(h => h.url === '/1' && h.range && Number(h.range.match(/\d+/)[0]) >= half - 1), 'resumed after the restart');
    assert.ok(fs.readFileSync(path.join(dataDir, 'dl', '3.bin')).equals(body));
  } finally { ok.stop(); await desk.stop(); await host.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
