// Installs always ask (contracts/APPROVAL-DOOR.md), and the one standing yes the downloads service knows: the owner's
// "Download updates in the background" switch, for desk updates only (contracts/UPDATES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { testDesk } from './helpers/desk.js';
import { startDownloadHost, sha, until } from './helpers/download-host.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const spec = (t, host, p, body, extra = {}) => ({ title: 'Test file', url: host.url(p), allowHosts: ['127.0.0.1'], size: body.length, sha256: sha(body), to: path.join(t.dataDir, 'dl', p.replace(/\W/g, '') + '.bin'), kind: 'test', ...extra });

test('install: asks the owner at every level and inside an auto-approve window, and the card says what and from where', async () => {
  const t = await testDesk();
  try {
    for (const [level, win] of [['open', 0], ['careful', 0], ['strict', 0], ['open', 60], ['careful', 'today'], ['strict', 15]]) {
      await t.call('/api/settings/security', { body: { level } });
      await t.call('/api/settings/auto-approve', { body: { window: win } });
      const title = `Install a thing (${level} ${win})`;
      const p = t.core.approval.request({ action: 'install', title, detail: 'From example.org', payload: { kind: 'program', what: 'thing', url: 'https://example.org/thing.zip' } });
      await sleep(30);
      const card = t.core.approval.listPending().find(a => a.title === title);
      assert.ok(card, `${level}${win ? ' + auto-approve ' + win : ''}: the owner is asked`);
      assert.equal(card.payload.url, 'https://example.org/thing.zip', 'the card shows where it comes from');
      t.core.approval.decide(card.id, 'deny');
      assert.equal((await p).reason, 'denied');
    }
    // the window still covers what it covered before (a file write at Strict)
    const w = await t.core.approval.request({ action: 'file.write', title: 'Write a note', payload: { path: 'x.txt' } });
    assert.equal(w.how, 'auto');
  } finally { await t.close(); }
});

test('install: the card names where it comes from, and says so plainly when the asker did not', async () => {
  const t = await testDesk();
  try {
    await t.call('/api/settings/auto-approve', { body: { window: 60 } });
    const ask = async (req) => {
      const p = t.core.approval.request({ action: 'install', ...req });
      const card = await until(() => t.core.approval.listPending().find(a => a.title === req.title));
      t.core.approval.decide(card.id, 'deny'); await p; return card;
    };
    // named by the asker: the card says it, once
    const named = await ask({ title: 'Download the local model qwen3:4b', detail: 'Ollama on this PC', from: 'registry.ollama.ai', payload: { model: 'qwen3:4b' } });
    assert.match(named.detail, /From registry\.ollama\.ai\./);
    assert.match(named.detail, /Ollama on this PC/);
    assert.equal(named.payload.from, undefined, 'the payload the asker binds to is unchanged');
    const already = await ask({ title: 'Get it', detail: 'From example.org, a list.', from: 'example.org', payload: { url: 'https://example.org/x.zip' } });
    assert.equal(already.detail.match(/example\.org/g).length, 1, 'not said twice');
    // not named at all: the card does not pass it over in silence
    const blind = await ask({ title: 'Start the MCP server Tools', detail: 'This may download the server package first.', payload: { command: 'npx -y some-server' } });
    assert.match(blind.detail, /Where it comes from was not stated\./);
    const noDetail = await ask({ title: 'Download an image', payload: { command: 'docker pull node:22-alpine' } });
    assert.match(noDetail.detail, /Where it comes from was not stated\./);
    // an address in the payload is the source: the card shows its host
    const url = await ask({ title: 'Get a file', payload: { url: 'https://files.example.net/a.bin' } });
    assert.match(url.detail, /From files\.example\.net\./);
  } finally { await t.close(); }
});

test('install: a download the owner starts is one card, inside an auto-approve window too, naming the file, its size and its host', async () => {
  const body = crypto.randomBytes(40 * 1024); const host = await startDownloadHost({ '/one': { body } });
  const t = await testDesk();
  try {
    await t.call('/api/settings/auto-approve', { body: { window: 60 } });
    const d = await t.core.downloads.start(spec(t, host, '/one', body, { title: 'Download the test model' }));
    assert.equal(d.state, 'waiting');
    const card = await until(() => t.core.approval.listPending()[0]);
    assert.equal(t.core.approval.listPending().length, 1, 'one card, not two');
    assert.match(card.title, /Download the test model \(40\.0 KB\)/);
    assert.match(card.detail, /From 127\.0\.0\.1/);
    assert.equal(card.payload.url, host.url('/one')); assert.equal(card.payload.file, 'one.bin');
    t.core.approval.decide(card.id, 'approve');
    assert.equal((await t.core.downloads.whenDone(d.id)).state, 'done');
    assert.equal(t.core.approval.listPending().length, 0, 'nothing else asked');
  } finally { await t.close(); await host.close(); }
});

test('standing yes: only "update.background", only for a desk update, only while the owner\'s switch is on; logged in place of a card', async () => {
  const body = crypto.randomBytes(20 * 1024); const host = await startDownloadHost({ '/u': { body }, '/v': { body } });
  const t = await testDesk();
  const dl = t.core.downloads;
  try {
    const upd = (p, extra = {}) => spec(t, host, p, body, { title: 'AP Desk 9.9.9 (update)', kind: 'desk-update', ...extra });
    // switch off: refused, nothing stored, nothing fetched
    await assert.rejects(dl.start(upd('/u'), { standingYes: 'update.background' }), (e) => e.code === 'forbidden');
    assert.equal(dl.all().length, 0); assert.equal(host.hits.length, 0);
    t.core.settings.set('update.background', true);
    // another kind, another name, or any other value: refused
    await assert.rejects(dl.start(upd('/u', { kind: 'test' }), { standingYes: 'update.background' }), (e) => e.code === 'forbidden');
    await assert.rejects(dl.start(upd('/u'), { standingYes: 'local-engine' }), (e) => e.code === 'forbidden');
    await assert.rejects(dl.start(upd('/u'), { standingYes: true }), (e) => e.code === 'forbidden');
    assert.equal(dl.all().length, 0);
    // the switch on and a desk update: queued without a card, the marker in place of an approval, one activity line
    const d = await dl.start(upd('/u'), { standingYes: 'update.background' });
    assert.notEqual(d.state, 'waiting');
    assert.equal(dl.get(d.id).approvalId, 'owner switch: update.background');
    assert.equal((await dl.whenDone(d.id)).state, 'done');
    assert.equal(t.core.approval.listPending().length, 0, 'no card');
    assert.equal(t.core.storage.get("SELECT COUNT(*) AS n FROM approvals").n, 0, 'no approval row is made up');
    const act = t.core.approval.activityList(20).find(a => a.action === 'update.download');
    assert.ok(act); assert.equal(act.how, 'owner switch'); assert.match(act.title, /AP Desk 9\.9\.9 \(update\)/);
    // a module never passes a standing yes
    await assert.rejects(dl.forModule('evil').start({ ...upd('/v'), file: 'v.bin' }, { standingYes: 'update.background' }), (e) => e.code === 'forbidden');
    assert.equal(dl.all().length, 1);
    // without the standing yes a desk update asks like any other download
    const asked = await dl.start(upd('/v'));
    assert.equal(asked.state, 'waiting');
    const card = await until(() => t.core.approval.listPending()[0]); t.core.approval.decide(card.id, 'deny');
  } finally { await t.close(); await host.close(); }
});

test('standing yes: a paused update download whose switch went off asks again on Resume', async () => {
  const body = crypto.randomBytes(200 * 1024); const host = await startDownloadHost({ '/slow': { body, slowMs: 20, chunk: 4096 } });
  const t = await testDesk(); const dl = t.core.downloads;
  try {
    t.core.settings.set('update.background', true);
    const d = await dl.start(spec(t, host, '/slow', body, { title: 'AP Desk 9.9.9 (update)', kind: 'desk-update' }), { standingYes: 'update.background' });
    assert.notEqual(d.state, 'waiting');
    assert.ok(await until(() => dl.get(d.id).state === 'running'));
    dl.pause(d.id);
    t.core.settings.set('update.background', false);
    assert.equal(dl.resume(d.id).state, 'waiting', 'the switch is off: the owner is asked');
    const card = await until(() => t.core.approval.listPending()[0]); assert.equal(card.action, 'install');
    dl.cancel(d.id); t.core.approval.decide(card.id, 'deny');
  } finally { await t.close(); await host.close(); }
});
