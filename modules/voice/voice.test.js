import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { scanFolder, wavSeconds, run, killAll } from './engines.js';

test('wavSeconds reads a WAV header', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apdv-')), 'a.wav');
  const n = 16000; const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(f, b); assert.equal(wavSeconds(f), 1);
});
test('scanFolder finds engines and model files a few levels down', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'apdv-'));
  const win = process.platform === 'win32';
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  const w = path.join(d, 'a', 'b', win ? 'whisper-cli.exe' : 'whisper-cli'); fs.writeFileSync(w, ''); fs.chmodSync(w, 0o755);
  fs.writeFileSync(path.join(d, 'ggml-base.bin'), 'x'); fs.writeFileSync(path.join(d, 'v.onnx'), 'x'); fs.writeFileSync(path.join(d, 'v.onnx.json'), '{}');
  const s = scanFolder(d);
  assert.equal(s.whisper, w); assert.equal(s.piper, null); assert.equal(s.whisperModels.length, 1); assert.equal(s.piperVoices.length, 1);
});

test('killAll stops only the engines of the set it is given (one set per space)', async () => {
  const mineA = new Set(), mineB = new Set();
  const args = ['-e', 'setTimeout(() => {}, 20000)'];
  const a = run(process.execPath, args, { track: mineA, timeoutMs: 15000 });
  const b = run(process.execPath, args, { track: mineB, timeoutMs: 15000 });
  assert.equal(mineA.size, 1); assert.equal(mineB.size, 1);
  assert.equal(killAll(mineA), 1);
  assert.equal((await a).code, null);
  assert.equal(mineB.size, 1, 'the other set still runs');
  assert.equal(killAll(mineB), 1); await b;
});

test('ElevenLabs: a refused key or a used-up plan is said back, so the key store rests that key and hands out the next', async () => {
  const { elevenSpeak, elevenTranscribe } = await import('./hosted.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-eleven-')); const file = path.join(dir, 'a.wav'); fs.writeFileSync(file, 'x');
  try {
    for (const [status, want] of [[401, 'refused'], [403, 'refused'], [402, 'allowance'], [429, 'allowance'], [500, null]]) {
      const said = []; const fetch = async () => new Response('{}', { status });
      await assert.rejects(elevenSpeak({ fetch, key: 'k', text: 'hi', out: path.join(dir, 'o.mp3'), refused: (why) => said.push(why) }));
      await assert.rejects(elevenTranscribe({ fetch, key: 'k', file, refused: (why) => said.push(why) }));
      assert.deepEqual(said, want ? [want, want] : [], `HTTP ${status}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
