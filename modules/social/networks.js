// The six networks, their limits, and the two posting adapters with a simple documented API (Reddit, X).
// postReddit and postX: X is signed by OAuth 1.0a user keys (long-lived) instead of a 2-hour bearer token, and every request through ctx.fetch.
// An adapter runs only after the owner approved that one draft; server.js asserts the grant right before calling it.
import crypto from 'node:crypto';

export const NETWORKS = {
  linkedin:  { name: 'LinkedIn', limit: 3000, tone: 'professional, first person, short paragraphs, no more than three hashtags at the end', open: 'https://www.linkedin.com/feed/' },
  x:         { name: 'X', limit: 280, tone: 'one punchy thought, plain words, at most two hashtags', open: 'https://x.com/compose/post', api: true },
  facebook:  { name: 'Facebook', limit: 5000, tone: 'friendly and conversational, a question at the end invites replies', open: 'https://www.facebook.com/' },
  instagram: { name: 'Instagram', limit: 2200, tone: 'a caption for a picture: a strong first line, line breaks, hashtags at the end', open: 'https://www.instagram.com/' },
  reddit:    { name: 'Reddit', limit: 40000, title: 300, tone: 'no marketing voice; first line is the title; helpful and specific; no hashtags', open: 'https://www.reddit.com/submit', api: true },
  youtube:   { name: 'YouTube community', limit: 1500, tone: 'short update for subscribers, one call to action', open: 'https://www.youtube.com/' },
};
export const NETWORK_IDS = Object.keys(NETWORKS);

/** Which secrets each adapter needs (names in ctx.secrets). */
export const CONNECT = {
  x: { fields: [['consumerKey', 'API key'], ['consumerSecret', 'API key secret'], ['accessToken', 'Access token'], ['accessSecret', 'Access token secret']], help: 'From the X developer portal: an app with Read and write permission, then its four user keys.' },
  reddit: { fields: [['clientId', 'App id'], ['clientSecret', 'App secret'], ['username', 'Reddit user name'], ['password', 'Reddit password'], ['subreddit', 'Subreddit to post in']], help: 'At reddit.com/prefs/apps make a "script" app for your own account.' },
};

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** OAuth 1.0a header (RFC 5849, HMAC-SHA1). A JSON body is not part of the signature. */
export function oauth1Header({ method, url, consumerKey, consumerSecret, accessToken, accessSecret, nonce = crypto.randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) }) {
  const u = new URL(url);
  const params = { oauth_consumer_key: consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(timestamp), oauth_token: accessToken, oauth_version: '1.0' };
  const all = [...Object.entries(params), ...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : 1);
  const base = [method.toUpperCase(), enc(u.origin + u.pathname), enc(all.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const sig = crypto.createHmac('sha1', `${enc(consumerSecret)}&${enc(accessSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...params, oauth_signature: sig }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}

const fail = (message, status = 502) => Object.assign(new Error(message), { status });

export async function postX({ fetch, keys, text, signal, base = 'https://api.x.com' }) {
  const url = `${base}/2/tweets`;
  const r = await fetch(url, { method: 'POST', signal, headers: { authorization: oauth1Header({ method: 'POST', url, ...keys }), 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  const body = await r.json().catch(() => null);
  if (r.status === 401 || r.status === 403) throw fail('X refused the keys. Connect the account again.', 409);
  const id = body?.data?.id;
  if (!r.ok || !id) throw fail(String(body?.detail || body?.title || 'X did not confirm the post.').slice(0, 200));
  return { url: `https://x.com/i/web/status/${encodeURIComponent(id)}` };
}

export async function postReddit({ fetch, keys, title, text, link, subreddit, signal }) {
  const sr = String(subreddit || keys.subreddit || '').replace(/^\/?r\//i, '').trim();
  if (!/^[A-Za-z0-9_]{2,21}$/.test(sr)) throw fail('Choose a subreddit for this post.', 400);
  const ua = `desktop:agent-population-desk:1.0 (by /u/${keys.username})`;
  const tok = await fetch('https://www.reddit.com/api/v1/access_token', { method: 'POST', signal, headers: { authorization: 'Basic ' + Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded', 'user-agent': ua }, body: new URLSearchParams({ grant_type: 'password', username: keys.username, password: keys.password }).toString() });
  const t = await tok.json().catch(() => null);
  if (!tok.ok || !t?.access_token) throw fail('Reddit refused the login. Connect the account again.', 409);
  const form = new URLSearchParams({ sr, title: String(title).slice(0, 300), api_type: 'json' });
  if (link) { form.set('kind', 'link'); form.set('url', link); } else { form.set('kind', 'self'); form.set('text', text); }
  const r = await fetch('https://oauth.reddit.com/api/submit', { method: 'POST', signal, headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': ua }, body: form.toString() });
  const body = await r.json().catch(() => null);
  const errors = body?.json?.errors; const data = body?.json?.data;
  if (!r.ok || (Array.isArray(errors) && errors.length) || !(data?.id || data?.name)) throw fail(String(errors?.[0]?.[1] || 'Reddit did not confirm the post.').slice(0, 200));
  return { url: typeof data.url === 'string' ? data.url : `https://www.reddit.com/r/${sr}/` };
}
