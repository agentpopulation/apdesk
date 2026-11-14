// Telegram Bot API client: no SDK, the base URL is a setting, and every call goes through ctx.fetch so Panic and Offline
// apply. The token stays inside the client and is never logged or returned.
export const TELEGRAM_API = 'https://api.telegram.org';

/** https always; plain http only for a server on this PC (the stand-in used by the checks). */
export function cleanApiBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '') || TELEGRAM_API;
  let u; try { u = new URL(raw); } catch { throw Object.assign(new Error('Enter an address like https://api.telegram.org.'), { status: 400 }); }
  const local = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw Object.assign(new Error('Use https, or http only for a server on this PC.'), { status: 400 });
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

export function telegramClient({ fetch, token, base = TELEGRAM_API }) {
  async function call(method, body, signal) {
    const r = await fetch(`${base}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal });
    const data = await r.json().catch(() => ({}));
    return { ok: !!data.ok, status: r.status, result: data.result, description: data.description || null };
  }
  return {
    getMe: (signal) => call('getMe', {}, signal),
    deleteWebhook: (signal) => call('deleteWebhook', { drop_pending_updates: false }, signal),
    getUpdates: ({ offset = 0, timeout = 25 } = {}, signal) => call('getUpdates', { offset, timeout, allowed_updates: ['message'] }, signal),
    sendMessage: (chatId, text, signal) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000) }, signal),
  };
}

/** 401 (bad token) and 404 (a token in the wrong shape) both mean Telegram did not accept it. */
export const tokenRefused = (r) => r && (r.status === 401 || r.status === 404);
