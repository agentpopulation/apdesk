// Real check for Voice: switch on; whisper.cpp transcribes a real recording; Piper speaks a sentence to a WAV (and whisper
// reads it back); Panic kills a running transcription; in a real browser the mic and read-aloud buttons appear and
// speechSynthesis.speak is called; switch off: the buttons and routes go.
// The engines are not shipped: point VOICE_FOLDER at a folder holding whisper-cli + a ggml model and piper + a voice.
// Run:  VOICE_FOLDER=/path/to/voice-folder node modules/voice/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { createRequire } from 'node:module'; import { execFileSync } from 'node:child_process';
import { testDesk } from '../../test/helpers/desk.js';
const results = []; const check = (name, ok, ev = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(ev).replace(/\s+/g, ' ').slice(0, 300)}`); };
const note = (name, ev) => console.log(`NOT CHECKED  ${name}  ${ev}`);
const FOLDER = process.env.VOICE_FOLDER || '';
const t = await testDesk({ real: true, modules: ['voice'] });
let browser;
try {
  let r = await t.call('/api/m/voice/status');
  check('off at first: routes answer 404', r.status === 404, `status ${r.status}`);
  r = await t.call('/api/modules/voice/on', { method: 'POST' });
  check('switches on: settings section "voice"', r.json?.on && r.json.settings?.[0]?.id === 'voice', `on=${r.json?.on}`);

  // ---- local engines in the owner's folder
  r = await t.call('/api/m/voice/settings', { body: { folder: FOLDER } });
  const st = r.json;
  if (!FOLDER || !st.whisper?.found) note('whisper.cpp', 'no engines folder given (VOICE_FOLDER)');
  else {
    const inbox = path.join(t.dataDir, 'workspace', 'inbox'); fs.mkdirSync(inbox, { recursive: true });
    const sample = fs.readdirSync(FOLDER).find(f => /\.wav$/i.test(f));
    fs.copyFileSync(path.join(FOLDER, sample), path.join(inbox, sample));
    r = await t.call('/api/m/voice/transcribe', { body: { path: 'inbox/' + sample } });
    check('whisper.cpp transcribes a real recording', r.status === 200 && /ask not what your country/i.test(r.json?.text || '') , `${st.whisper.file} · ${r.json?.model} · ${r.json?.seconds?.toFixed(1)} s: "${r.json?.text || r.json?.error}"`);
    const raw = fs.readFileSync(path.join(inbox, sample));
    const dz = await fetch(t.base + '/api/m/voice/dictate', { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-apd-session': t.desk.session }, body: raw }).then(x => x.json());
    const left = fs.readdirSync(path.join(t.dataDir, 'workspace', 'voice')).filter(f => f.startsWith('dictation-'));
    check('local dictation: a WAV from the browser is transcribed on this PC and then deleted', /ask not what your country/i.test(dz.text || '') && left.length === 0, `"${(dz.text || dz.error || '').slice(0, 60)}…"; recordings left: ${left.length}`);
    // Panic kills a running transcription (a long file made from the sample)
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '30', '-i', path.join(inbox, sample), '-ar', '16000', '-ac', '1', path.join(inbox, 'long.wav')]);
      const started = Date.now();
      const p = t.call('/api/m/voice/transcribe', { body: { path: 'inbox/long.wav' } });
      await new Promise(res => setTimeout(res, 1200));
      await t.call('/api/panic', { body: {} });
      const pr = await p; const ms = Date.now() - started;
      check('Panic stops a running transcription', pr.status !== 200 && ms < 5000, `answer ${pr.status} "${pr.json?.error}" after ${ms} ms (the 5-minute file would take far longer)`);
      await t.call('/api/panic/resume', { method: 'POST' });
    } catch (e) { note('Panic during transcription', 'ffmpeg not available: ' + e.message); }
  }
  if (!FOLDER || !st.piper?.found) note('Piper', 'no engines folder given (VOICE_FOLDER)');
  else {
    r = await t.call('/api/m/voice/speak', { body: { text: 'Good morning. Two jobs finished overnight and one draft is waiting for you.' } });
    const wavOk = r.status === 200 && fs.existsSync(path.join(t.dataDir, 'workspace', r.json.path)) && r.json.seconds > 1;
    check('Piper speaks a sentence to a WAV in the workspace', wavOk, `${r.json?.path} · ${r.json?.voice} · ${r.json?.seconds?.toFixed(2)} s${r.json?.error || ''}`);
    const audio = await fetch(t.base + r.json.url);
    check('the WAV is served to the browser', audio.status === 200 && audio.headers.get('content-type') === 'audio/wav', `${audio.status} ${audio.headers.get('content-type')}`);
    if (st.whisper?.found && wavOk) {
      const back = await t.call('/api/m/voice/transcribe', { body: { path: r.json.path } });
      check('round trip: whisper.cpp reads back what Piper said', /two jobs finished/i.test(back.json?.text || ''), `"${back.json?.text}"`);
    }
  }

  // ---- ElevenLabs: no real key here; a missing key and a bad key must give plain messages
  await t.call('/api/m/voice/settings', { body: { readAloud: 'elevenlabs' } });
  r = await t.call('/api/m/voice/speak', { body: { text: 'Hello.' } });
  check('ElevenLabs without a key: a plain message', r.status === 409 && /No ElevenLabs key/.test(r.json?.error), `${r.status} "${r.json?.error}"`);
  await t.call('/api/keys/services/elevenlabs', { body: { value: 'sk_this_is_not_a_real_key_0000' } });
  r = await t.call('/api/m/voice/speak', { body: { text: 'Hello.' } });
  check('ElevenLabs with a bad key (real API call): a plain message, no file', r.status === 409 && /did not accept the key/.test(r.json?.error) && !fs.readdirSync(path.join(t.dataDir, 'workspace', 'voice')).some(f => f.endsWith('.mp3')), `${r.status} "${r.json?.error}"`);
  const eng = (await t.call('/api/m/voice/status')).json;
  check('Voice lists the engines it can use', eng.engines?.speak?.includes('ElevenLabs') && eng.hosted?.length === 4, `listen: ${eng.engines?.listen?.join(', ')}; speak: ${eng.engines?.speak?.join(', ')}`);
  await t.call('/api/keys/services/elevenlabs', { body: { enabled: false } });
  await t.call('/api/m/voice/settings', { body: { readAloud: 'browser' } });

  // ---- in a real browser
  const { chromium } = createRequire(import.meta.url)('playwright');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { window.__spoken = []; if (window.speechSynthesis) { const orig = speechSynthesis.speak.bind(speechSynthesis); speechSynthesis.speak = (u) => { window.__spoken.push(u.text); try { orig(u); } catch {} }; } });
  await page.goto(t.base); await page.waitForSelector('#menu .nav');
  if (await page.locator('#onb-skip').isVisible()) { await page.click('#onb-skip'); await page.waitForTimeout(800); }
  await page.waitForTimeout(800);
  check('browser: the buttons appear on the first screen without opening Settings (boot)', await page.locator('#apd-voice .mic').isVisible(), '');
  await page.evaluate(() => { location.hash = '#/settings/voice'; }); await page.waitForTimeout(800);
  const shown = await page.locator('#apd-voice .mic').isVisible() && await page.locator('#apd-voice .read').isVisible();
  check('browser: the mic and read-aloud buttons appear while Voice is on', shown && await page.evaluate(() => typeof window.apdVoice?.speak === 'function'), `window.apdVoice: ${await page.evaluate(() => Object.keys(window.apdVoice || {}).join(', '))}`);
  await page.getByRole('button', { name: 'Read a test sentence' }).click(); await page.waitForTimeout(300);
  const spoken = await page.evaluate(() => window.__spoken);
  const env = await page.evaluate(() => ({ voices: speechSynthesis.getVoices().length, rec: !!(window.SpeechRecognition || window.webkitSpeechRecognition) }));
  check('browser: read aloud calls speechSynthesis.speak', spoken.length === 1 && /reading aloud/.test(spoken[0]), `spoken: "${spoken[0]}"; voices in headless Chromium: ${env.voices} (no sound can be heard here)`);
  note('browser dictation', `SpeechRecognition present: ${env.rec}; recognising speech needs a microphone and Edge/Chrome online, not possible headless`);
  await page.evaluate(() => { location.hash = '#/home'; }); await page.waitForTimeout(400);
  check('browser: the buttons stay on other screens', await page.locator('#apd-voice .mic').isVisible(), '');
  await page.click('#panic'); await page.waitForTimeout(400);
  check('browser: Panic hides the buttons and stops speech', !(await page.locator('#apd-voice .mic').isVisible()) && await page.evaluate(() => !speechSynthesis.speaking), '');
  await page.click('#resume'); await page.waitForTimeout(300);

  // ---- switch off
  await t.call('/api/modules/voice/off', { method: 'POST' });
  await page.waitForTimeout(1500);
  const gone = await page.evaluate(() => !document.getElementById('apd-voice') && typeof window.apdVoice === 'undefined');
  r = await t.call('/api/m/voice/status');
  check('switches off: the buttons go, routes answer 404', gone && r.status === 404, `buttons gone: ${gone}; route ${r.status}`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('no crash', false, e.stack); }
finally { await browser?.close(); await t.close(); }
process.exit(results.every(Boolean) ? 0 : 1);
