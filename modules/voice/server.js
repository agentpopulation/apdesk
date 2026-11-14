// Voice (module 21). The browser does dictation (Web Speech API) and read aloud (speechSynthesis) with no install; see ui.js.
// This side finds the optional local engines in a folder the owner picks: whisper.cpp for speech to text and Piper for
// text to speech, and exposes transcribe(path) and speak(text) -> an audio file in the workspace. With the owner's
// ElevenLabs key (shared key store) the hosted engine is a choice beside them.
const HOSTED = [{ id: 'elevenlabs', name: 'ElevenLabs', speak: true, listen: true }, { id: 'deepgram', name: 'Deepgram' }, { id: 'cartesia', name: 'Cartesia' }, { id: 'assemblyai', name: 'AssemblyAI' }];
import fs from 'node:fs';
import path from 'node:path';
import { scanFolder, run, killAll, wavSeconds } from './engines.js';
import { elevenSpeak, elevenTranscribe } from './hosted.js';

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export async function activate(ctx) {
  const { kv } = ctx;
  const prefs = () => ({ folder: kv.get('folder', ''), whisperModel: kv.get('whisperModel', ''), piperVoice: kv.get('piperVoice', ''), language: kv.get('language', 'auto'), dictation: kv.get('dictation', 'browser'), readAloud: kv.get('readAloud', 'browser'), voiceName: kv.get('voiceName', '') });
  let cache = null;
  const engines = (fresh = false) => {
    const p = prefs();
    if (!cache || fresh || cache.folder !== p.folder) cache = { folder: p.folder, ...scanFolder(p.folder) };
    const whisperModel = cache.whisperModels.find(m => path.basename(m) === p.whisperModel) || cache.whisperModels[0] || null;
    const piperVoice = cache.piperVoices.find(m => path.basename(m) === p.piperVoice) || cache.piperVoices[0] || null;
    return { ...cache, whisperModel, piperVoice };
  };
  const voiceDir = () => { const d = ctx.workspacePath('voice'); fs.mkdirSync(d, { recursive: true }); return d; };
  const rel = (abs) => path.relative(ctx.workspace, abs).split(path.sep).join('/');
  const offStop = ctx.panic.onStop(() => ({ voice: killAll() }));

  const elevenKey = () => (typeof ctx.serviceKey === 'function' ? ctx.serviceKey('elevenlabs') : null);
  /** Which engine the server uses: the owner's choice, else local when found, else ElevenLabs when its key is there. */
  const pick = (kind) => {
    const want = kind === 'listen' ? prefs().dictation : prefs().readAloud; const e = engines();
    const local = kind === 'listen' ? !!(e.whisper && e.whisperModel) : !!(e.piper && e.piperVoice);
    if (want === 'elevenlabs') return 'elevenlabs';
    if (want === 'local' || local) return 'local';
    return elevenKey() ? 'elevenlabs' : 'local';
  };
  const hostedOk = async (what, agentId) => {
    const d = await ctx.approval.request({ agentId, chatId: 'voice', action: 'net.post', title: `Send ${what} to ElevenLabs`, detail: 'Voice · hosted engine you chose' });
    if (!d.ok) throw err(d.reason === 'halted' ? 'Stopped.' : 'Sending audio to ElevenLabs was not allowed.', 403);
  };

  /** Speech to text: whisper.cpp on this PC, or ElevenLabs. `file` is workspace-relative (or absolute inside the workspace). */
  async function transcribe(file, { signal, language, agentId = null } = {}) {
    const absIn = path.isAbsolute(String(file)) ? path.resolve(file) : ctx.workspacePath(String(file || ''));
    if (pick('listen') === 'elevenlabs') {
      const key = elevenKey(); if (!key) throw err('No ElevenLabs key. Add one on the Models page under service keys.', 409);
      if (!absIn.startsWith(path.resolve(ctx.workspace) + path.sep) || !fs.existsSync(absIn)) throw err('That file is not in the workspace.', 404);
      await hostedOk('a recording', agentId);
      const started = Date.now();
      const text = await elevenTranscribe({ fetch: (u, i) => ctx.fetch(u, i), key, file: absIn, language: language || prefs().language, signal: ctx.panic.child(signal) });
      return { text, engine: 'ElevenLabs', model: 'scribe_v1', seconds: (Date.now() - started) / 1000 };
    }
    const e = engines();
    if (!e.whisper) throw err('whisper.cpp was not found. Pick the folder that holds whisper-cli in Settings › Voice.', 409);
    if (!e.whisperModel) throw err('No whisper model file (ggml-….bin) was found in that folder.', 409);
    const abs = absIn;
    if (!abs.startsWith(path.resolve(ctx.workspace) + path.sep)) throw err('The file must be in the workspace.', 403);
    if (!fs.existsSync(abs)) throw err('That file is not in the workspace.', 404);
    const lang = language || prefs().language;
    const args = ['-m', e.whisperModel, '-f', abs, '-nt', '-np', ...(lang && lang !== 'auto' ? ['-l', lang] : [])];
    const started = Date.now();
    const r = await run(e.whisper, args, { signal: ctx.panic.child(signal), timeoutMs: 15 * 60_000 });
    if (r.error === 'stopped') throw Object.assign(err('Stopped.', 409), { code: 'halted' });
    if (r.code !== 0) throw err(`whisper.cpp could not read the file${r.error ? ': ' + r.error : ''}. ${r.stderr.split('\n').filter(Boolean).slice(-1)[0] || ''}`.trim(), 502);
    return { text: r.stdout.replace(/\s+/g, ' ').trim(), engine: 'whisper.cpp', model: path.basename(e.whisperModel), seconds: (Date.now() - started) / 1000 };
  }

  /** Text to speech: Piper on this PC (a WAV) or ElevenLabs (an MP3), saved in workspace/voice. */
  async function speak(text, { signal, agentId = null, chatId = null } = {}) {
    const t = String(text || '').trim().slice(0, 5000);
    if (!t) throw err('Nothing to read.');
    if (pick('speak') === 'elevenlabs') {
      const key = elevenKey(); if (!key) throw err('No ElevenLabs key. Add one on the Models page under service keys.', 409);
      await hostedOk('text to read aloud', agentId);
      const name = `speech-${stamp()}-${Math.random().toString(36).slice(2, 6)}.mp3`;
      const out = path.join(voiceDir(), name);
      const d = await ctx.approval.request({ agentId, chatId: chatId || 'voice', action: 'file.write', title: `Write ${name}`, detail: 'Workspace › voice', payload: { path: 'voice/' + name } });
      if (!d.ok) throw err('Writing the audio file was not allowed.', 403);
      await elevenSpeak({ fetch: (u, i) => ctx.fetch(u, i), key, text: t, out, signal: ctx.panic.child(signal) });
      return { path: rel(out), name, seconds: null, engine: 'ElevenLabs', voice: 'ElevenLabs', url: `/api/m/voice/audio/${encodeURIComponent(name)}` };
    }
    const e = engines();
    if (!e.piper) throw err('Piper was not found. Pick the folder that holds piper in Settings › Voice.', 409);
    if (!e.piperVoice) throw err('No Piper voice (a .onnx file with its .onnx.json) was found in that folder.', 409);
    const name = `speech-${stamp()}-${Math.random().toString(36).slice(2, 6)}.wav`;
    const out = path.join(voiceDir(), name);
    const d = await ctx.approval.request({ agentId, chatId: chatId || 'voice', action: 'file.write', title: `Write ${name}`, detail: 'Workspace › voice', payload: { path: 'voice/' + name } });
    if (!d.ok) throw err(d.reason === 'halted' ? 'Stopped.' : 'Writing the audio file was not allowed.', 403);
    const r = await run(e.piper, ['-m', e.piperVoice, '-f', out], { input: t, signal: ctx.panic.child(signal), timeoutMs: 5 * 60_000 });
    if (r.error === 'stopped') { fs.rmSync(out, { force: true }); throw Object.assign(err('Stopped.', 409), { code: 'halted' }); }
    if (r.code !== 0 || !fs.existsSync(out)) throw err(`Piper could not speak${r.error ? ': ' + r.error : ''}. ${r.stderr.split('\n').filter(Boolean).slice(-1)[0] || ''}`.trim(), 502);
    return { path: rel(out), name, seconds: wavSeconds(out), engine: 'Piper', voice: path.basename(e.piperVoice, '.onnx'), url: `/api/m/voice/audio/${encodeURIComponent(name)}` };
  }

  const owner = (arg) => { if (!arg.owner) throw err('Only the owner at this desk can change voice settings.', 403); };
  const status = (fresh) => {
    const e = engines(fresh); const p = prefs();
    return {
      prefs: p,
      whisper: { found: !!e.whisper, file: e.whisper ? path.basename(e.whisper) : null, models: e.whisperModels.map(m => path.basename(m)), model: e.whisperModel ? path.basename(e.whisperModel) : null },
      piper: { found: !!e.piper, file: e.piper ? path.basename(e.piper) : null, voices: e.piperVoices.map(m => path.basename(m)), voice: e.piperVoice ? path.basename(e.piperVoice) : null },
      folderExists: !!p.folder && fs.existsSync(p.folder),
      hosted: HOSTED.map(x => ({ id: x.id, name: x.name, hasKey: typeof ctx.serviceKey === 'function' && !!ctx.serviceKey(x.id), built: !!(x.speak || x.listen) })),
      engines: {
        listen: ['Browser (Edge, Chrome)', ...(e.whisper && e.whisperModel ? ['whisper.cpp on this PC'] : []), ...(elevenKey() ? ['ElevenLabs'] : [])],
        speak: ['Browser voices', ...(e.piper && e.piperVoice ? ['Piper on this PC'] : []), ...(elevenKey() ? ['ElevenLabs'] : [])],
        server: { listen: pick('listen'), speak: pick('speak') },
      },
    };
  };
  ctx.route('GET', '/status', (req, res, arg) => ctx.json(res, status(arg.query.fresh === '1')));
  ctx.route('POST', '/settings', (req, res, arg) => {
    owner(arg); const b = arg.body || {};
    if (b.folder !== undefined) { const f = String(b.folder || '').trim(); if (f && !path.isAbsolute(f)) throw err('Enter the full folder path, for example C:\\voice.'); kv.set('folder', f); cache = null; }
    for (const k of ['whisperModel', 'piperVoice', 'language', 'voiceName']) if (b[k] !== undefined) kv.set(k, String(b[k] || ''));
    const eng = (v) => ['local', 'elevenlabs'].includes(v) ? v : 'browser';
    if (b.dictation !== undefined) kv.set('dictation', eng(b.dictation));
    if (b.readAloud !== undefined) kv.set('readAloud', eng(b.readAloud));
    ctx.json(res, status(true));
  });
  ctx.route('POST', '/transcribe', async (req, res, arg) => ctx.json(res, await transcribe(arg.body?.path, {})));
  // The mic recording from the browser (a 16 kHz WAV made in ui.js) -> text. The recording is deleted afterwards.
  ctx.route('POST', '/dictate', async (req, res, arg) => {
    if (!arg.owner) throw err('Only the owner at this desk can dictate.', 403);
    const raw = await ctx.readBody(req, 50 * 1024 * 1024);
    if (raw.length < 44 || raw.toString('ascii', 0, 4) !== 'RIFF') throw err('That is not a WAV recording.');
    const f = path.join(voiceDir(), `dictation-${stamp()}.wav`);
    fs.writeFileSync(f, raw);
    try { ctx.json(res, await transcribe(rel(f), {})); } finally { fs.rmSync(f, { force: true }); }
  });
  ctx.route('POST', '/speak', async (req, res, arg) => ctx.json(res, await speak(arg.body?.text, { agentId: arg.body?.agentId || null })));
  ctx.route('GET', '/audio/:name', (req, res, arg) => {
    const name = String(arg.params.name || '');
    if (!/^speech-[\w-]+\.(wav|mp3)$/.test(name)) return ctx.json(res, { error: 'Not found' }, 404);
    const f = path.join(voiceDir(), name);
    if (!fs.existsSync(f)) return ctx.json(res, { error: 'Not found' }, 404);
    res.writeHead(200, { 'content-type': name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', 'cache-control': 'no-store', 'content-length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  });

  ctx.expose({ transcribe, speak, status: () => status(false) });
  return { async deactivate() { offStop?.(); killAll(); } };
}
