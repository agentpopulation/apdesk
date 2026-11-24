// Approve from your phone (contracts/PHONE.md). OFF by default. When the Admin switches it on, the house opens a SECOND
// small listener on this PC's home network address. That listener knows only the phone page and its own few routes; it
// never reaches the desk's routes, which stay on the loopback listener in app/server.js. A phone is linked once with a
// one-time code shown on the desk's own screen; it then keeps its own token. The desk keeps only a hash of that token.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isLocalAddress } from '../offline.js';
import { redact, ownerTime } from '../approval-door.js';
import { CORE_ROLES } from '../agents.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** Decided at the desk unless the Admin chose otherwise: installs and removals (the Store asks with `install`), and module switches. */
export const AT_DESK = new Set(['install', 'module.toggle']);
const ACTION_WORDS = { 'file.write': 'Write a file', 'file.delete': 'Delete a file', 'file.read.outside': 'Open a folder', 'shell.run': 'Run a command', 'browser.open': 'Open a site', 'browser.act': 'Act in the browser', 'net.post': 'Send data', 'send.person': 'Send to a person', spend: 'Spend money', 'module.toggle': 'Switch a module', install: 'Install', login: 'Sign in', 'calendar.write': 'Change the calendar', 'record.change': 'Change your customer records', 'schedule.repeat': 'Make a repeating schedule', 'memory.lesson': 'Save a standing instruction', custom: 'Action' };
const ROW_WORDS = { url: 'From', file: 'Saved as', size: 'Size', to: 'To', cc: 'Copy to', subject: 'Subject', body: 'Text', text: 'Text', path: 'File', folder: 'Folder', cmd: 'Command', command: 'Command', cwd: 'In the folder', amount: 'Amount', currency: 'Currency' };
const rowWords = (key) => { const last = String(key).split('.').pop(); return ROW_WORDS[last] || last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()); };

/** The first private IPv4 address of this PC (10/8, 172.16/12, 192.168/16): the home network. Null when there is none. */
export function homeAddress(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces || {})) for (const a of list || []) {
    if (a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
    const [x, y] = String(a.address).split('.').map(Number);
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return a.address;
  }
  return null;
}

/** Money in hundredths, as the owner reads it (his currency and number style). */
function money(minor, currency, locale) {
  const n = (Number(minor) || 0) / 100;
  // small amounts keep the currency's own small unit; a currency with none (yen) shows none
  let own = 2; try { if (currency) own = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch {}
  const digits = Math.abs(n) < 100 ? Math.min(2, own) : 0;
  for (const l of [locale || undefined, undefined]) { try { return new Intl.NumberFormat(l, currency ? { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits } : {}).format(n); } catch { /* next */ } }
  return String(n);
}

/**
 * The house's phone part. house: { settings, kv } of the main space (where the switch and the linked phones are kept);
 * people; spacesOf(personId) -> [core] (that person's Work and Personal, never Incognito); isLocked(core); panic; note(core, a)
 * writes one activity line in a space; host/port: where to listen (default: the home address, the desk's port + 2).
 */
export function createPhone({ settings, kv, people, spacesOf, isLocked = () => false, panic, note, log = () => {}, host = null, port = null, deskPort = () => 3445 }) {
  const limits = { codeMs: 5 * 60000, tries: 5, lockMs: 5 * 60000 };
  const codes = new Map();   // code -> { personId, until }
  const tries = { wrong: 0, lockedUntil: 0 };
  let server = null; let listening = null;   // { host, port }

  const on = () => settings.get('phone.on') === true;
  const adminDecides = () => settings.get('phone.adminDecides') === true;
  const devices = () => { const v = kv.get('devices', []); return Array.isArray(v) ? v : []; };
  const saveDevices = (list) => kv.set('devices', list.slice(-20));
  const deviceView = (d) => ({ id: d.id, name: d.name, person: people.get(d.personId)?.name || 'Someone who left', personId: d.personId, linked: d.created, lastUsed: d.lastUsed || null });
  const where = () => host || homeAddress();

  // ---------------- the routes the desk's own Settings page uses (served by app/server.js on loopback)
  function state(personId, keeper) {
    const mine = devices().filter(d => keeper || d.personId === personId).map(deviceView);
    const addr = where();
    return { on: on(), adminDecides: adminDecides(), listening: !!listening, address: listening ? `http://${listening.host}:${listening.port}` : null,
      network: !!addr, note: addr ? null : 'No home network was found on this PC, so the phone page cannot open. Connect the PC to your Wi-Fi or router first.', devices: mine };
  }
  async function setOn(value) {
    settings.set('phone.on', value === true);
    if (value === true) await start(); else await stop();
    return listening;
  }
  function newCode(personId) {
    for (const [c, v] of codes) if (v.personId === personId) codes.delete(c);
    let code; do { code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); } while (codes.has(code));
    codes.set(code, { personId, until: Date.now() + limits.codeMs });
    return { code, seconds: Math.round(limits.codeMs / 1000) };
  }
  function removeDevice(id, personId, keeper) {
    const d = devices().find(x => x.id === id);
    if (!d || (!keeper && d.personId !== personId)) return null;
    saveDevices(devices().filter(x => x.id !== id));
    return d;
  }
  function dropPerson(personId) { saveDevices(devices().filter(d => d.personId !== personId)); for (const [c, v] of codes) if (v.personId === personId) codes.delete(c); }

  // ---------------- the phone's own listener
  const page = (f) => fs.readFileSync(path.join(HERE, f));
  const HEAD = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
  const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const json = (res, status, body) => { res.writeHead(status, { ...HEAD, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const deviceOf = (req) => {
    const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const h = sha(m[1]);
    const d = devices().find(x => x.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
    if (!d || !people.get(d.personId)) return null;
    if (!d.lastUsed || Date.now() - new Date(d.lastUsed).getTime() > 60000) saveDevices(devices().map(x => (x.id === d.id ? { ...x, lastUsed: new Date().toISOString() } : x)));
    return d;
  };
  /** One waiting approval as the phone shows it: the desk card's own line, never the payload until "show" is tapped. */
  const itemOf = (core, a, keeper) => {
    const who = a.agentId ? `${CORE_ROLES.agentLine(core.agents.get(a.agentId))} asks` : 'The desk asks';
    const atDesk = AT_DESK.has(a.action) && !(adminDecides() && keeper);
    const st = core.settings;
    return { id: a.id, title: a.title, who, what: ACTION_WORDS[a.action] || 'Action', detail: a.detail || null,
      amount: a.amount ? money(a.amount, a.currency || st.get('currency'), st.get('locale')) : null,
      asked: ownerTime(a.created, st), more: a.payload != null && (typeof a.payload !== 'object' || Object.keys(a.payload).length > 0), atDesk };
  };
  const findRow = (personId, id) => { for (const core of spacesOf(personId)) { const r = core.approval.forModule().get(id); if (r) return { core, row: r }; } return null; };
  const why = (personId) => panic.halted ? 'halted' : spacesOf(personId).some(c => isLocked(c)) ? 'locked' : null;
  const WHY = { halted: 'Everything is stopped by Panic. Nothing can be decided until you press Resume at the desk.', locked: 'The desk is locked. Unlock it at the desk to see what waits for you.' };

  async function handle(req, res) {
    // the home address only: a Host header that is not this listener's (DNS rebinding), or a caller from outside the
    // home network, gets nothing
    const self = listening ? `${listening.host}:${listening.port}` : '';
    if (String(req.headers.host || '').toLowerCase() !== self) { res.writeHead(403, HEAD); return res.end(); }
    const from = String(req.socket.remoteAddress || '');
    if (!isLocalAddress(`http://${from.includes(':') ? `[${from}]` : from}/`)) { res.writeHead(403, HEAD); return res.end(); }
    let url; try { url = new URL(req.url, `http://${self}`); } catch { res.writeHead(400, HEAD); return res.end(); }
    const method = String(req.method || '').toUpperCase(); const p = url.pathname;
    if (method === 'POST') {
      const origin = req.headers.origin; const site = req.headers['sec-fetch-site'];
      if ((origin && origin !== `http://${self}`) || (site && site !== 'same-origin' && site !== 'none')) return json(res, 403, { error: 'Only the phone page can do this.' });
    }
    if (method === 'GET' && p === '/') { res.writeHead(200, { ...HEAD, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP }); return res.end(page('page.html')); }
    if (method === 'GET' && p === '/phone.js') { res.writeHead(200, { ...HEAD, 'content-type': 'text/javascript; charset=utf-8' }); return res.end(page('page.js')); }
    if (method === 'GET' && p === '/phone.css') { res.writeHead(200, { ...HEAD, 'content-type': 'text/css; charset=utf-8' }); return res.end(page('page.css')); }
    const body = async () => { let n = 0; const parts = []; for await (const c of req) { n += c.length; if (n > 4096) throw Object.assign(new Error('too big'), { status: 413 }); parts.push(c); } try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { return {}; } };

    if (method === 'POST' && p === '/link') {
      const b = await body();
      if (Date.now() < tries.lockedUntil) return json(res, 429, { error: 'Too many wrong codes. Wait five minutes, then make a new code at the desk.' });
      const code = String(b.code || '').replace(/\D/g, ''); const hit = codes.get(code);
      if (!hit || hit.until < Date.now()) {
        if (hit) codes.delete(code);
        if (++tries.wrong >= limits.tries) { tries.wrong = 0; tries.lockedUntil = Date.now() + limits.lockMs; codes.clear(); }   // a lock ends every live code too
        return json(res, 403, { error: 'That code is not right, or it is too old. Make a new code at the desk.' });
      }
      codes.delete(code); tries.wrong = 0;
      const person = people.get(hit.personId); if (!person) return json(res, 403, { error: 'That code is not right, or it is too old. Make a new code at the desk.' });
      const token = crypto.randomBytes(32).toString('base64url');
      const name = String(b.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Phone';
      const d = { id: 'ph_' + crypto.randomBytes(6).toString('hex'), name, personId: person.id, hash: sha(token), created: new Date().toISOString(), lastUsed: new Date().toISOString() };
      saveDevices([...devices(), d]);
      try { note(spacesOf(person.id)[0], { action: 'phone.link', title: `A phone was linked: ${name}`, how: 'owner' }); } catch {}
      return json(res, 200, { token, name, person: person.name });
    }
    const d = deviceOf(req);
    if (!d) return json(res, 401, { error: 'This phone is not linked to the desk. Make a code at the desk and type it here.', code: 'not_linked' });
    const person = people.get(d.personId); const keeper = !!person.keeper;
    if (method === 'POST' && p === '/unlink') { removeDevice(d.id, d.personId, false); try { note(spacesOf(d.personId)[0], { action: 'phone.unlink', title: `A phone was unlinked: ${d.name}`, how: 'owner' }); } catch {} return json(res, 200, { ok: true }); }
    if (method === 'GET' && p === '/list') {
      const stop = why(d.personId);
      const items = stop ? [] : spacesOf(d.personId).flatMap(core => core.approval.listPending().map(a => itemOf(core, a, keeper)));
      return json(res, 200, { person: person.name, device: d.name, stopped: stop ? WHY[stop] : null, items });
    }
    const m = /^\/(show|decide)\/(ap_[A-Za-z0-9_-]{1,64})$/.exec(p);
    if (m) {
      const stop = why(d.personId); if (stop) return json(res, 409, { error: WHY[stop] });
      const f = findRow(d.personId, m[2]);
      if (!f) return json(res, 404, { error: 'This is not waiting for you.' });
      if (m[1] === 'show' && method === 'GET') {
        if (f.row.status !== 'pending') return json(res, 409, { error: 'This was already decided.' });
        // never a secret over plain http: the fields that name a key, a password or a PIN are hidden here, whatever the action
        const rows = []; const walk = (o, pre) => { for (const [k, v] of Object.entries(o || {})) { if (v == null) continue; if (typeof v === 'object') walk(v, pre + k + '.'); else rows.push([rowWords(pre + k), String(v)]); } };
        // an install's raw address stays off when the detail line already names where it comes from ("From <host>."), and a
        // download's own bookkeeping (kind, what, hash) always does: the owner reads the host, the desk checks the rest
        const src = f.row.payload && typeof f.row.payload === 'object' ? f.row.payload : null;
        const drop = new Set(src?.kind === 'download' ? ['kind', 'what', 'sha256'] : []);
        if (f.row.action === 'install' && /^From \S/.test(String(f.row.detail || ''))) drop.add('url');
        const pl = redact(src ? Object.fromEntries(Object.entries(src).filter(([k]) => !drop.has(k))) : f.row.payload);
        if (pl && typeof pl === 'object') walk(pl, ''); else if (pl != null) rows.push(['', String(pl)]);
        return json(res, 200, { rows });
      }
      if (m[1] === 'decide' && method === 'POST') {
        const b = await body(); const decision = b.decision === 'approve' ? 'approve' : b.decision === 'deny' ? 'deny' : null;
        if (!decision) return json(res, 400, { error: 'Yes or no.' });
        if (f.row.status !== 'pending') return json(res, 409, { error: f.row.status === 'approved' ? 'This was already approved.' : f.row.status === 'denied' ? 'This was already declined.' : 'This is no longer waiting.', status: f.row.status, already: true });
        if (AT_DESK.has(f.row.action) && !(adminDecides() && keeper)) return json(res, 403, { error: 'Decide this at the desk.', code: 'at_desk' });
        const r = f.core.approval.decide(f.row.id, decision, 'owner', d.name);
        if (!r || r.already) return json(res, 409, { error: 'This was already decided.', status: r?.status, already: true });
        return json(res, 200, { status: r.status, said: r.status === 'approved' ? 'Approved.' : 'Declined.' });
      }
    }
    return json(res, 404, { error: 'Not found' });
  }

  async function start() {
    if (server || !on()) return listening;
    const h = where(); if (!h) { log('phone', 'no home network address'); return null; }
    const want = port != null ? port : deskPort() + 2;
    const s = http.createServer((req, res) => { handle(req, res).catch((e) => { log('phone', e?.message || e); if (!res.headersSent) json(res, e?.status || 500, { error: 'Something went wrong. Try again.' }); else try { res.end(); } catch {} }); });
    s.headersTimeout = 10000; s.requestTimeout = 15000;
    try { await new Promise((resolve, reject) => { s.once('error', reject); s.listen(want, h, resolve); }); }
    catch (e) { log('phone', 'could not listen', e.code || e.message); return null; }
    server = s; listening = { host: h, port: s.address().port };
    log('phone', `phone page on http://${h}:${listening.port}`);
    return listening;
  }
  async function stop() {
    const s = server; server = null; listening = null; codes.clear();
    if (s) await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  }
  return { state, setOn, setAdminDecides: (v) => settings.set('phone.adminDecides', v === true), newCode, removeDevice, dropPerson, start, stop, limits,
    get listening() { return listening; }, deviceView, devices: () => devices().map(deviceView) };
}
