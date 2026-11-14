// Voice in the browser: a floating mic button (dictation into the message box) and a read-aloud button, plus
// window.apdVoice = { listen(onText), speak(text), stop(), state() } for the chat. Edge and Chrome need no install.
// Dictation uses the Web Speech API (the browser sends the audio to Microsoft or Google to recognise it) or, when the owner
// chose it and whisper.cpp was found, records a 16 kHz WAV here and transcribes it on this PC. Read aloud uses
// speechSynthesis or Piper. Panic and switching Voice off stop everything and remove the buttons.
const API = '/api/m/voice';
const session = () => document.querySelector('meta[name="apd-session"]')?.content || '';
const call = async (p, { method = 'GET', body, raw } = {}) => {
  const r = await fetch(API + p, { method, headers: { 'x-apd-session': session(), ...(raw ? { 'content-type': 'audio/wav' } : body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Voice request failed (${r.status})`);
  return d;
};
const Rec = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
const say = (t, k) => { try { window.apd?.toast?.(t, k); } catch {} };

let status = null; let el = null; let lastField = null;
const live = { rec: null, recorder: null, audio: null, listening: false };

async function loadStatus() { try { status = await call('/status'); } catch { status = null; } return status; }
const elevenKey = () => !!status?.hosted?.find(x => x.id === 'elevenlabs')?.hasKey;
// "local" or "elevenlabs": the browser records or sends text to this desk and the server engine does the work
const useLocalDictation = () => (status?.prefs?.dictation === 'local' && status?.whisper?.found && status?.whisper?.model) || (status?.prefs?.dictation === 'elevenlabs' && elevenKey());
const useLocalVoice = () => (status?.prefs?.readAloud === 'local' && status?.piper?.found && status?.piper?.voice) || (status?.prefs?.readAloud === 'elevenlabs' && elevenKey());

// ---------- dictation
function listen(onText, { onEnd, lang } = {}) {
  stopListening();
  if (useLocalDictation()) return listenLocal(onText, onEnd);
  const R = Rec();
  if (!R) { say('This browser has no dictation. Use Edge or Chrome, or pick local dictation in Settings › Voice.', 'err'); onEnd?.(); return false; }
  const rec = new R();
  rec.lang = lang || (status?.prefs?.language && status.prefs.language !== 'auto' ? status.prefs.language : (navigator.language || 'en-IN'));
  rec.interimResults = false; rec.continuous = true;
  rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onText?.(e.results[i][0].transcript.trim()); };
  rec.onerror = (e) => { if (e.error === 'not-allowed') say('The browser was not allowed to use the microphone.', 'err'); else if (e.error !== 'aborted' && e.error !== 'no-speech') say('Dictation stopped: ' + e.error, 'err'); };
  rec.onend = () => { live.rec = null; live.listening = false; paint(); onEnd?.(); };
  live.rec = rec; live.listening = true; paint();
  try { rec.start(); } catch { live.listening = false; paint(); return false; }
  return true;
}
async function listenLocal(onText, onEnd) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }); }
  catch { say('The browser was not allowed to use the microphone.', 'err'); onEnd?.(); return false; }
  const ac = new AudioContext({ sampleRate: 16000 });
  const src = ac.createMediaStreamSource(stream); const proc = ac.createScriptProcessor(4096, 1, 1); const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(ac.destination);
  live.listening = true; paint();
  live.recorder = { stop: async (send = true) => {
    live.recorder = null; live.listening = false; paint();
    proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop()); const rate = ac.sampleRate; await ac.close().catch(() => {});
    if (!send || !chunks.length) { onEnd?.(); return; }
    try { el?.classList.add('busy'); const r = await call('/dictate', { method: 'POST', raw: wav(chunks, rate) }); if (r.text) onText?.(r.text); }
    catch (e) { say(e.message, 'err'); } finally { el?.classList.remove('busy'); onEnd?.(); }
  } };
  return true;
}
function wav(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0); const b = new DataView(new ArrayBuffer(44 + n * 2));
  const s = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); s(36, 'data'); b.setUint32(40, n * 2, true);
  let o = 44; for (const c of chunks) for (const v of c) { b.setInt16(o, Math.max(-1, Math.min(1, v)) * 0x7fff, true); o += 2; }
  return new Blob([b.buffer], { type: 'audio/wav' });
}
function stopListening(send = true) { if (live.rec) { try { live.rec.stop(); } catch {} } if (live.recorder) live.recorder.stop(send); live.listening = false; paint(); }

// ---------- read aloud
async function speak(text) {
  const t = String(text || '').replace(/[*_`#>|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  stopSpeaking();
  if (useLocalVoice()) {
    try { const r = await call('/speak', { method: 'POST', body: { text: t } }); live.audio = new Audio(r.url); live.audio.onended = () => { live.audio = null; paint(); }; await live.audio.play(); paint(); return true; }
    catch (e) { say(e.message + ' Using the browser voice.', 'err'); }
  }
  if (!window.speechSynthesis) { say('This browser cannot read aloud.', 'err'); return false; }
  const u = new SpeechSynthesisUtterance(t.slice(0, 8000));
  const want = status?.prefs?.voiceName; const v = want && speechSynthesis.getVoices().find(x => x.name === want);
  if (v) u.voice = v;
  u.onend = u.onerror = () => paint();
  speechSynthesis.speak(u); paint();
  return true;
}
function stopSpeaking() { try { window.speechSynthesis?.cancel(); } catch {} if (live.audio) { live.audio.pause(); live.audio = null; } paint(); }
const speaking = () => !!live.audio || !!window.speechSynthesis?.speaking;
function stop() { stopListening(false); stopSpeaking(); }

// ---------- the floating buttons
const isField = (n) => n && (n.tagName === 'TEXTAREA' || (n.tagName === 'INPUT' && /^(text|search|)$/.test(n.type))) && !n.closest('#apd-voice');
const onFocus = (e) => { if (isField(e.target)) lastField = e.target; };
function target() { return [lastField, document.querySelector('.compose textarea'), document.querySelector('#view textarea')].find(n => n && n.isConnected) || null; }
function insert(field, text) {
  if (!field || !text) return;
  const a = field.selectionStart ?? field.value.length, b = field.selectionEnd ?? field.value.length;
  const pre = field.value.slice(0, a); const sep = pre && !/\s$/.test(pre) ? ' ' : '';
  field.value = pre + sep + text + field.value.slice(b);
  const pos = (pre + sep + text).length; try { field.setSelectionRange(pos, pos); } catch {}
  field.dispatchEvent(new Event('input', { bubbles: true })); field.focus();
}
function lastReply() { const m = [...document.querySelectorAll('.msg.it')].pop(); if (!m) return ''; const c = m.cloneNode(true); c.querySelectorAll('.who, button, .card').forEach(x => x.remove()); return c.textContent.trim(); }
function paint() {
  if (!el) return;
  el.querySelector('.mic').setAttribute('aria-pressed', String(live.listening));
  el.querySelector('.mic').title = live.listening ? 'Stop dictation' : 'Dictate into the message box';
  el.querySelector('.read').setAttribute('aria-pressed', String(speaking()));
  el.querySelector('.read').title = speaking() ? 'Stop reading' : 'Read aloud the selected text or the last reply';
}
const CSS = `#apd-voice{position:fixed;right:26px;bottom:22px;z-index:40;display:flex;gap:6px;padding:4px;border-radius:24px;background:var(--card);border:1px solid var(--line);box-shadow:0 2px 12px rgba(0,0,0,.14)}
#apd-voice button{width:34px;height:34px;border-radius:50%;color:inherit;display:grid;place-items:center}#apd-voice button:hover{background:var(--line)}
#apd-voice button svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
#apd-voice button[aria-pressed=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
#apd-voice.busy .mic{opacity:.6;cursor:progress}
body.halted #apd-voice{display:none}`;
const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const SPK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>';
let unsub = [];
function subscribe() {
  for (const f of unsub.splice(0)) { try { f(); } catch {} }
  const apd = window.apd; if (!apd?.on || !el) return;
  unsub.push(apd.on('panic', (s) => { if (s?.halted) stop(); }));
  unsub.push(apd.on('modules', (m) => { if (m?.id === 'voice' && m.on === false) uninstall(); }));
}
const onHash = () => setTimeout(subscribe, 0);     // the shell clears page listeners on every page change
const onPanicClick = () => stop();

export function install() {
  if (el?.isConnected) return el;
  const style = document.createElement('style'); style.id = 'apd-voice-css'; style.textContent = CSS;
  el = document.createElement('div'); el.id = 'apd-voice';
  el.innerHTML = `<button type="button" class="mic" aria-label="Dictate" aria-pressed="false">${MIC}</button><button type="button" class="read" aria-label="Read aloud" aria-pressed="false">${SPK}</button>`;
  el.querySelector('.mic').addEventListener('mousedown', (e) => e.preventDefault());           // keep the caret in the message box
  el.querySelector('.mic').onclick = () => { if (live.listening) return stopListening(true); const f = target(); if (!f) return say('Click into the message box first.'); listen((t) => insert(f, t)); };
  el.querySelector('.read').onclick = () => { if (speaking()) return stopSpeaking(); const sel = String(window.getSelection?.() || '').trim(); const t = sel || lastReply(); if (!t) return say('Select some text, or open a chat with a reply.'); speak(t); };
  document.head.append(style); document.body.append(el);
  document.addEventListener('focusin', onFocus); window.addEventListener('hashchange', onHash);
  document.getElementById('panic')?.addEventListener('click', onPanicClick);
  window.apdVoice = { listen, speak, stop, stopListening, state: () => ({ listening: live.listening, speaking: speaking(), dictation: useLocalDictation() ? status.prefs.dictation : Rec() ? 'browser' : 'none', readAloud: useLocalVoice() ? status.prefs.readAloud : window.speechSynthesis ? 'browser' : 'none' }) };
  subscribe(); loadStatus();
  return el;
}
export function uninstall() {
  stop();
  for (const f of unsub.splice(0)) { try { f(); } catch {} }
  document.removeEventListener('focusin', onFocus); window.removeEventListener('hashchange', onHash);
  document.getElementById('panic')?.removeEventListener('click', onPanicClick);
  el?.remove(); document.getElementById('apd-voice-css')?.remove(); el = null;
  delete window.apdVoice;
}
// The shell imports this file when Voice is on (Settings, or a page that uses voice): put the buttons up at once.
if (typeof document !== 'undefined') install();
export const boot = install;
export const unload = uninstall;

// ---------- Settings › Voice
export const settings = {
  voice: { title: 'Voice', async render(host, ui) {
    install();
    const { h, card, line, btn, toast, seg } = ui;
    const body = h('div', { class: 'stack' }); host.append(body);
    const save = async (patch) => { try { status = await call('/settings', { method: 'POST', body: patch }); paintAll(); } catch (e) { toast(e.message, 'err'); } };
    const pill = (ok, yes, no) => ui.pill(ok ? yes : no, ok ? 'ok' : '');
    const ENG = ['Browser', 'On this PC', 'ElevenLabs']; const ENG_ID = ['browser', 'local', 'elevenlabs'];
    const paintAll = () => {
      const s = status || { prefs: {}, whisper: {}, piper: {}, hosted: [], engines: { listen: [], speak: [] } }; const p = s.prefs;
      const voices = (window.speechSynthesis?.getVoices() || []);
      const folder = h('input', { type: 'text', value: p.folder || '', placeholder: 'For example C:\\voice', style: { minWidth: '320px' }, onchange: (e) => save({ folder: e.target.value }) });
      const wsel = h('select', { onchange: (e) => save({ whisperModel: e.target.value }), disabled: !s.whisper.models?.length }, (s.whisper.models || []).map(m => h('option', { value: m, selected: m === s.whisper.model }, m)));
      const psel = h('select', { onchange: (e) => save({ piperVoice: e.target.value }), disabled: !s.piper.voices?.length }, (s.piper.voices || []).map(m => h('option', { value: m, selected: m === s.piper.voice }, m.replace(/\.onnx$/, ''))));
      const vsel = h('select', { onchange: (e) => save({ voiceName: e.target.value }) }, h('option', { value: '' }, voices.length ? 'Browser default' : 'No browser voices found'), voices.map(v => h('option', { value: v.name, selected: v.name === p.voiceName }, `${v.name} (${v.lang})`)));
      const lang = h('select', { onchange: (e) => save({ language: e.target.value }) }, [['auto', 'Same as the browser'], ['en', 'English'], ['hi', 'Hindi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['bn', 'Bengali']].map(([v, l]) => h('option', { value: v, selected: v === (p.language || 'auto') }, l)));
      const testOut = h('span', { class: 'sub' });
      const file = h('input', { type: 'text', placeholder: 'A file in the workspace, for example inbox/meeting.wav', style: { minWidth: '320px' } });
      body.replaceChildren(
        card(h('h3', null, 'In the browser'), h('p', { class: 'sub' }, 'The mic and speaker buttons sit at the bottom right of every screen while Voice is on. Edge and Chrome need no install.'),
          line('Dictation', 'Browser: Edge or Chrome send the sound to Microsoft or Google. On this PC: whisper.cpp, nothing leaves the PC. ElevenLabs: your key, sent to ElevenLabs.', seg(ENG, ENG_ID.indexOf(p.dictation || 'browser'), (_, i) => save({ dictation: ENG_ID[i] }))),
          line('Read aloud', 'Browser voices, Piper on this PC, or ElevenLabs voices with your key.', seg(ENG, ENG_ID.indexOf(p.readAloud || 'browser'), (_, i) => save({ readAloud: ENG_ID[i] }))),
          line('Browser voice', 'Used when reading aloud in the browser', vsel),
          line('Language', 'For dictation', lang),
          h('div', { class: 'row' }, btn('Read a test sentence', { kind: 'ghost sm', onClick: () => speak('Hello. This is your desk reading aloud.') }), btn('Stop', { kind: 'ghost sm', onClick: stop }), testOut)),
        card(h('h3', null, 'Engines you can use now'),
          line('Speech to text', (s.engines?.listen || []).join(' · ') || 'Browser'),
          line('Read aloud', (s.engines?.speak || []).join(' · ') || 'Browser voices'),
          ...(s.hosted || []).map(x => line(x.name, x.built ? (x.hasKey ? 'Key added on the Models page' : 'Add a key on the Models page to use it') : (x.hasKey ? 'Key added, but this version does not use it yet' : 'Not used by this version'), pill(x.built && x.hasKey, 'Ready', x.built ? 'No key' : 'Not built')))),
        card(h('h3', null, 'On this PC (optional)'), h('p', { class: 'sub' }, 'Put whisper-cli.exe with a ggml model file, and piper.exe with a voice (.onnx and .onnx.json), in one folder. The desk looks there.'),
          line('Folder', s.folderExists ? 'Found' : (p.folder ? 'This folder does not exist' : 'Not chosen yet'), folder, btn('Look again', { kind: 'ghost sm', onClick: async () => { status = await call('/status?fresh=1'); paintAll(); } })),
          line('whisper.cpp (speech to text)', s.whisper.found ? `${s.whisper.file} · ${s.whisper.models.length} model file${s.whisper.models.length === 1 ? '' : 's'}` : 'Not found in the folder', pill(s.whisper.found && s.whisper.model, 'Ready', 'Not found'), wsel),
          line('Piper (text to speech)', s.piper.found ? `${s.piper.file} · ${s.piper.voices.length} voice${s.piper.voices.length === 1 ? '' : 's'}` : 'Not found in the folder', pill(s.piper.found && s.piper.voice, 'Ready', 'Not found'), psel),
          h('div', { class: 'row' }, file, btn('Transcribe', { kind: 'ghost sm', disabled: !s.whisper.found && !elevenKey(), onClick: async () => { testOut.textContent = 'Listening to the file…'; try { const r = await call('/transcribe', { method: 'POST', body: { path: file.value } }); testOut.textContent = `${r.engine} · ${r.model}: ${r.text}`; } catch (e) { testOut.textContent = e.message; } } }),
            btn('Speak on the desk', { kind: 'ghost sm', disabled: !s.piper.found && !elevenKey(), onClick: async () => { try { const r = await call('/speak', { method: 'POST', body: { text: 'This sentence was spoken by the desk.' } }); testOut.textContent = `Saved ${r.path}${r.seconds ? ', ' + r.seconds.toFixed(1) + ' seconds' : ''} · ${r.engine}`; live.audio = new Audio(r.url); live.audio.play().catch(() => {}); } catch (e) { testOut.textContent = e.message; } } })))
      );
    };
    await loadStatus(); paintAll();
    if (window.speechSynthesis) { speechSynthesis.onvoiceschanged = () => paintAll(); ui.onLeave?.(() => { speechSynthesis.onvoiceschanged = null; }); }
  } },
};
