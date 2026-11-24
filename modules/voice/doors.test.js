// The Voice door: which engine would turn a recording into words, and a plain refusal when none can.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { testDesk } from '../../test/helpers/desk.js';

test('listenPlan and transcribe refuse plainly when no engine is set up (Browser only)', async () => {
  const t = await testDesk({ modules: ['voice'] });
  try {
    await t.call('/api/modules/voice/on', { method: 'POST' });
    const voice = t.core.modules.api('voice');
    const p = voice.listenPlan();
    assert.equal(p.available, false); assert.equal(p.engine, null); assert.equal(p.leavesPc, false); assert.equal(p.cost, 'not known');
    assert.match(p.why, /No speech engine is set up for recordings/); assert.match(p.why, /Settings, Voice/);
    await assert.rejects(voice.transcribe('meetings/a.wav'), (e) => e.code === 'no_engine' && e.status === 409 && /No speech engine/.test(e.message));
  } finally { await t.close(); }
});

test('listenPlan says a hosted engine sends the sound out and the cost is not known; the approval door is asked first', async () => {
  const t = await testDesk({ modules: ['voice'] });
  try {
    await t.call('/api/modules/voice/on', { method: 'POST' });
    const voice = t.core.modules.api('voice');
    assert.equal((await t.call('/api/keys/services/elevenlabs', { body: { value: 'el-test-key-not-real-123456' } })).status, 200);
    assert.equal((await t.call('/api/m/voice/settings', { body: { dictation: 'elevenlabs' } })).status, 200);
    const p = voice.listenPlan();
    assert.deepEqual([p.available, p.engine, p.leavesPc, p.cost], [true, 'ElevenLabs', true, 'not known']);
    assert.match(p.why, /asked before/);
    // the desk goes through its approval door before any sound leaves: the request is recorded with what and where
    const f = path.join(t.core.storage.workspace, 'a.wav'); fs.writeFileSync(f, 'x');
    const before = fs.readdirSync(t.core.storage.workspace).sort();
    const e = await voice.transcribe('a.wav', { signal: AbortSignal.abort() }).catch(x => x);   // never reaches the network
    const asked = t.core.storage.all("SELECT action, title FROM approvals");
    assert.ok(asked.some(a => a.action === 'net.post' && /Send a recording to ElevenLabs/.test(a.title)), 'the approval door was asked first: ' + JSON.stringify(asked) + ' / ' + e?.message);
    assert.deepEqual(fs.readdirSync(t.core.storage.workspace).sort(), before, 'nothing written or deleted');
  } finally { await t.close(); }
});

test('listenPlan for a local engine: free, the sound stays on this PC; transcribe reports the same', async () => {
  const t = await testDesk({ modules: ['voice'] });
  try {
    await t.call('/api/modules/voice/on', { method: 'POST' });
    const voice = t.core.modules.api('voice');
    const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'apdv-'));
    const win = process.platform === 'win32';
    const exe = path.join(dir, win ? 'whisper-cli.exe' : 'whisper-cli');
    fs.writeFileSync(exe, win ? '' : '#!/bin/sh\necho "hello world"\n'); fs.chmodSync(exe, 0o755);
    fs.writeFileSync(path.join(dir, 'ggml-base.bin'), 'x');
    assert.equal((await t.call('/api/m/voice/settings', { body: { folder: dir, dictation: 'local' } })).status, 200);
    const p = voice.listenPlan();
    assert.deepEqual([p.available, p.engine, p.leavesPc], [true, 'whisper.cpp', false]); assert.match(p.cost, /^Free/);
    if (!win) {
      fs.writeFileSync(path.join(t.core.storage.workspace, 'r.wav'), 'x');
      const r = await voice.transcribe('r.wav');
      assert.equal(r.text, 'hello world'); assert.equal(r.leavesPc, false); assert.match(r.cost, /^Free/);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { await t.close(); }
});
