// Accounts and Lock (module 23): a screen lock for the desk's browser window. PIN as a scrypt hash in ctx.secrets,
// optional TOTP (RFC 6238), lock after a quiet time. While locked the core refuses the desk's HTTP API (423) except
// state, events, Panic and this module's state, unlock and lock routes; isLocked() below is what it asks.
import crypto from 'node:crypto';
import { newSecret, otpauthUri, verifyTotp } from './totp.js';

const SCRYPT = { N: 2 ** 14, r: 8, p: 1 };
const hashPin = (pin, salt) => new Promise((resolve, reject) => crypto.scrypt(String(pin), Buffer.from(salt, 'base64'), 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k.toString('base64')))));

export async function activate(ctx) {
  const opts = () => ({ idleMinutes: 10, lockOnStart: true, ...(ctx.kv.get('options', {}) || {}) });
  const hasPin = () => ctx.secrets.has('pin');
  const totpOn = () => ctx.secrets.has('totp');
  let locked = hasPin() && opts().lockOnStart;
  let lastActive = Date.now();
  let failures = 0, waitUntil = 0;
  const state = () => ({ hasPin: hasPin(), locked, totp: totpOn(), idleMinutes: opts().idleMinutes, lockOnStart: opts().lockOnStart, waitSeconds: Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000)) });
  const setLocked = (v, why) => { locked = !!v; if (!v) lastActive = Date.now(); ctx.events.emit('accounts', { locked, why }); };
  const activity = (title, detail) => ctx.activity(title, detail);
  const pinOk = async (pin) => { const s = ctx.secrets.get('pin'); if (!s) return false; const { salt, hash } = JSON.parse(s); const h = await hashPin(pin, salt); return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)); };
  const guard = (res, owner, { allowLocked = false } = {}) => {
    if (!owner) { ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403); return true; }
    if (locked && !allowLocked) { ctx.json(res, { error: 'The desk is locked.', locked: true }, 423); return true; }
    return false;
  };

  const timer = setInterval(() => {
    const idle = Number(opts().idleMinutes) || 0;
    if (hasPin() && !locked && idle > 0 && Date.now() - lastActive > idle * 60000) { setLocked(true, 'idle'); activity('Desk locked', `After ${idle} quiet minutes`); }
  }, 15000);

  ctx.route('GET', '/state', (req, res) => ctx.json(res, state()));
  ctx.route('POST', '/ping', (req, res, { owner }) => { if (owner && !locked) lastActive = Date.now(); ctx.json(res, state()); });
  ctx.route('POST', '/lock', (req, res, { owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403);
    if (!hasPin()) return ctx.json(res, { error: 'Set a PIN first.' }, 409);
    setLocked(true, 'owner'); activity('Desk locked', 'Lock now'); ctx.json(res, state());
  });
  ctx.route('POST', '/unlock', async (req, res, { body, owner }) => {
    if (guard(res, owner, { allowLocked: true })) return;
    if (Date.now() < waitUntil) return ctx.json(res, { error: `Too many wrong tries. Wait ${state().waitSeconds} seconds.`, ...state() }, 429);
    const okPin = await pinOk(String(body?.pin || ''));
    const okCode = !totpOn() || verifyTotp(ctx.secrets.get('totp'), body?.code);
    if (!okPin || !okCode) {
      failures++; if (failures >= 5) { waitUntil = Date.now() + 30000 * 2 ** Math.min(4, failures - 5); }
      activity('Wrong unlock attempt', !okPin ? 'Wrong PIN' : 'Wrong two-step code');
      await new Promise(r => setTimeout(r, 400));
      return ctx.json(res, { error: !okPin ? 'That PIN is wrong.' : 'That code is wrong or too old.', ...state() }, 403);
    }
    failures = 0; waitUntil = 0; setLocked(false, 'owner'); activity('Desk unlocked'); ctx.json(res, state());
  });
  ctx.route('POST', '/pin', async (req, res, { body, owner }) => {
    if (guard(res, owner)) return;
    const pin = String(body?.pin || '');
    if (!/^\d{4,12}$/.test(pin)) return ctx.json(res, { error: 'A PIN is 4 to 12 digits.' }, 400);
    if (hasPin() && !(await pinOk(String(body?.current || '')))) return ctx.json(res, { error: 'The current PIN is wrong.' }, 403);
    const had = hasPin(); const salt = crypto.randomBytes(16).toString('base64');
    ctx.secrets.set('pin', JSON.stringify({ salt, hash: await hashPin(pin, salt), alg: 'scrypt', ...SCRYPT }));
    activity(had ? 'Screen lock PIN changed' : 'Screen lock PIN set');
    lastActive = Date.now(); ctx.json(res, state());
  });
  ctx.route('POST', '/pin/remove', async (req, res, { body, owner }) => {
    if (guard(res, owner)) return;
    if (!(await pinOk(String(body?.pin || '')))) return ctx.json(res, { error: 'That PIN is wrong.' }, 403);
    ctx.secrets.set('pin', null); ctx.secrets.set('totp', null); ctx.secrets.set('totp-pending', null);
    activity('Screen lock removed'); ctx.json(res, state());
  });
  ctx.route('POST', '/totp/setup', (req, res, { owner }) => {
    if (guard(res, owner)) return;
    if (!hasPin()) return ctx.json(res, { error: 'Set a PIN first.' }, 409);
    const secret = newSecret(); ctx.secrets.set('totp-pending', secret);
    ctx.json(res, { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri: otpauthUri(secret, { account: ctx.settings.get('ownerName') || 'Owner' }) });
  });
  ctx.route('POST', '/totp/confirm', (req, res, { body, owner }) => {
    if (guard(res, owner)) return;
    const s = ctx.secrets.get('totp-pending'); if (!s) return ctx.json(res, { error: 'Start the set-up first.' }, 409);
    if (!verifyTotp(s, body?.code)) return ctx.json(res, { error: 'That code does not match. Check the time on your phone and try the next code.' }, 403);
    ctx.secrets.set('totp', s); ctx.secrets.set('totp-pending', null); activity('Two-step codes switched on'); ctx.json(res, state());
  });
  ctx.route('POST', '/totp/off', async (req, res, { body, owner }) => {
    if (guard(res, owner)) return;
    if (!(await pinOk(String(body?.pin || '')))) return ctx.json(res, { error: 'That PIN is wrong.' }, 403);
    ctx.secrets.set('totp', null); activity('Two-step codes switched off'); ctx.json(res, state());
  });
  ctx.route('POST', '/options', (req, res, { body, owner }) => {
    if (guard(res, owner)) return;
    const o = opts();
    if (body?.idleMinutes != null) o.idleMinutes = Math.max(0, Math.min(240, Math.round(Number(body.idleMinutes) || 0)));
    if (typeof body?.lockOnStart === 'boolean') o.lockOnStart = body.lockOnStart;
    ctx.kv.set('options', o); ctx.json(res, state());
  });
  ctx.expose({ isLocked: () => locked });
  return { async deactivate() { clearInterval(timer); if (locked) ctx.events.emit('accounts', { locked: false, why: 'off' }); } };
}
