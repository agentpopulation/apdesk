// ntfy push: settings in ctx.kv, the optional access token in ctx.secrets, the post through ctx.fetch.
// ntfy pushes only to the owner's own topic, never to anyone else.
import crypto from 'node:crypto';
export const NTFY_SERVER = 'https://ntfy.sh';
const TOPIC_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';
export const validTopic = (t) => TOPIC_RE.test(String(t || ''));
export function randomTopic(bytes = crypto.randomBytes(20)) { let out = 'apdesk-'; for (let i = 0; i < 20; i++) out += ALPHABET[bytes[i] % ALPHABET.length]; return out; }
const privateHost = (h) => h === 'localhost' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local') || h.endsWith('.lan');
/** https always; plain http only for a server on this PC or the home network. */
export function cleanServerUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '') || NTFY_SERVER;
  let u; try { u = new URL(raw); } catch { throw Object.assign(new Error('Enter a server address like https://ntfy.sh.'), { status: 400 }); }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw Object.assign(new Error('Enter only the server address, like https://ntfy.sh.'), { status: 400 });
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && privateHost(u.hostname))) throw Object.assign(new Error('Use https, or http only for a server on your home network.'), { status: 400 });
  return `${u.protocol}//${u.host}`;
}
export async function ntfyPush({ fetch, server, topic, token, title, text, tags = 'robot', signal }) {
  if (!validTopic(topic)) return { ok: false, error: 'No topic yet.' };
  // HTTP headers must be plain ASCII; ntfy reads a UTF-8 title from the body-less X-Title only when encoded, so keep it simple
  const headers = { 'content-type': 'text/plain; charset=utf-8', Title: String(title || 'AP Desk').replace(/[^\x20-\x7e]/g, '').slice(0, 120), Tags: tags };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const r = await fetch(`${server}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body: String(text).slice(0, 4000), signal });
    return r.ok ? { ok: true } : { ok: false, error: `The ntfy server answered ${r.status}.` };
  } catch (e) { return { ok: false, error: e.code === 'offline' ? 'The desk is offline.' : 'Could not reach the ntfy server.' }; }
}
