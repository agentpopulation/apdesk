// Hosted audio beside the free local engines: ElevenLabs text to speech and speech to text, with the owner's key from the
// shared key store (ctx.serviceKey('elevenlabs')). Every call goes through ctx.fetch, so Panic and Offline apply.
// API: https://elevenlabs.io/docs/api-reference (text-to-speech/{voice_id}, speech-to-text with model scribe_v1).
import fs from 'node:fs'; import path from 'node:path';
export const ELEVEN = 'https://api.elevenlabs.io';
export const ELEVEN_VOICE = 'JBFqnCBsd6RMkjVDRZzb';      // a premade voice from the ElevenLabs docs
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
/** What the answer says about the key: 401/403 refused, 402/429 the plan's allowance is used up; else null. */
const keyWhy = (status) => status === 401 || status === 403 ? 'refused' : status === 402 || status === 429 ? 'allowance' : null;
const plain = async (r, refused) => {
  if (keyWhy(r.status)) refused?.(keyWhy(r.status));   // the key store rests that key; the next call gets the next key
  const body = await r.json().catch(() => null);
  if (r.status === 401 || r.status === 403) return fail('ElevenLabs did not accept the key. Check it on the Models page under service keys.', 409);
  if (r.status === 429) return fail('ElevenLabs says the plan limit is reached for now.', 429);
  return fail(`ElevenLabs could not do it (${r.status}${body?.detail?.message ? ': ' + String(body.detail.message).slice(0, 120) : ''}).`);
};
export async function elevenSpeak({ fetch, key, text, out, voice = ELEVEN_VOICE, signal, refused }) {
  const r = await fetch(`${ELEVEN}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, { method: 'POST', signal, headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }) });
  if (!r.ok) throw await plain(r, refused);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return out;
}
export async function elevenTranscribe({ fetch, key, file, language, signal, refused }) {
  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  if (language && language !== 'auto') form.append('language_code', language);
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  const r = await fetch(`${ELEVEN}/v1/speech-to-text`, { method: 'POST', signal, headers: { 'xi-api-key': key }, body: form });
  if (!r.ok) throw await plain(r, refused);
  const j = await r.json().catch(() => ({}));
  return String(j.text || '').trim();
}
