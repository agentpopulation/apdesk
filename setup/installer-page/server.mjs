// The installer page: a small web server on 127.0.0.1 that only its own page can use, for install.bat.
// The page is a face for setup/install.mjs: the folder check, the copy, the packages, the shortcuts and the list of
// apps all run through install() and checkFolder() there, on this side, with the same checks as the console path.
//   - the address holds a one-time random token; any other address, Host or Origin is refused
//   - only the files named in FILES are served, never a path taken from the request
//   - a folder from the page goes through checkFolder() before install() sees it, and install() checks it again
//   - it closes once the install has ended and the page has said so, or after a while with no page asking;
//     the end screens ask now and then, so their buttons keep working while the page is open
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { spawnSync } from 'node:child_process';
import { install, checkFolder, version, cmdBrowse, cmdStart, realRunner, deskAnswers, defaultFolder, APP, KEPT_NOTE } from '../install.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.dirname(path.dirname(HERE));
const FILES = { '': ['index.html', 'text/html; charset=utf-8'], 'page.css': ['page.css', 'text/css; charset=utf-8'], 'page.js': ['page.js', 'text/javascript; charset=utf-8'], 'logo.svg': ['logo.svg', 'image/svg+xml'] };
export const STEPS = ['copy', 'packages', 'shortcuts', 'done'];
const HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
};

export function installerServer({ source = SOURCE, env = process.env, run = realRunner, isRunning = deskAnswers, endAfter = 1500, idleAfterEnd = 120000 } = {}) {
  const token = crypto.randomBytes(24).toString('base64url');
  const state = { phase: 'ready', step: null, done: [], line: '', message: '', log: '', dir: '', problems: 0, started: false, kept: '' };
  let port = 0; let url = ''; let closing = null; let idle = 0; let leaving = false; let endResult = { ok: false };
  let finish; const ended = new Promise((r) => { finish = r; });

  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { ...HEADERS, 'Content-Type': type });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  const refuse = (res) => send(res, 403, 'This address is for the AP Desk installer only. Use the address shown in the install window.', 'text/plain; charset=utf-8');

  const readJson = (req) => new Promise((resolve) => {
    let size = 0; const parts = [];
    req.on('data', (d) => { size += d.length; if (size > 8192) { req.destroy(); resolve(null); } else parts.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });

  const closeSoon = (ms) => {
    if (closing) clearTimeout(closing);
    closing = setTimeout(() => { server.close(); server.closeAllConnections?.(); finish(endResult); }, ms);
    closing.unref?.();
  };

  async function runInstall(dir, a) {
    if (closing) { clearTimeout(closing); closing = null; } idle = 0;
    Object.assign(state, { phase: 'running', step: null, done: [], line: 'Getting ready ...', message: '', log: '', dir, problems: 0, started: false, kept: KEPT_NOTE[a.kept] || '' });
    const say = (l) => { const t = String(l ?? '').trim(); if (t && !/^(would |Folder:|Start it from|Stop it with|\(The program)/.test(t)) state.line = t; };
    const step = (id) => { if (state.step && !state.done.includes(state.step)) state.done.push(state.step); state.step = id; };
    let r;
    try {
      r = await install({ argv: ['--folder', dir], env, source, run, isRunning, say, step, banner: false, tick: () => {}, ask: async () => '',
        answers: { desktop: a.desktop, apps: a.apps, autostart: a.autostart, start: a.start, anyway: a.anyway } });
    } catch (e) {
      const log = path.join(dir, 'data', 'install.log');
      try { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, `  Stopped: ${e && e.message}\r\n`); } catch {}
      r = { ok: false, message: 'Something went wrong on this PC while ' + ({ copy: 'copying the program', packages: 'getting the packages', shortcuts: 'making the shortcuts' }[state.step] || 'installing') + '. Close any folder window that shows the AP Desk folder and check that the disk has space, then try again.', log };
    }
    if (r.ok) { if (state.step && !state.done.includes(state.step)) state.done.push(state.step); }
    Object.assign(state, { phase: r.ok ? 'done' : 'failed', message: r.ok ? '' : pageWords(r.message), log: r.log && fs.existsSync(r.log) ? r.log : '', problems: (r.problems || []).length, started: !!r.started });
    endResult = { ok: r.ok, dir, result: r };
    idle = r.ok ? idleAfterEnd : idleAfterEnd * 5;
    closeSoon(idle);     // a page that was closed: the installer still ends on its own
  }
  // install() words its failures for the console ("run install.bat again"); the page's next step is its Try again button
  const pageWords = (m) => String(m || '').replace(/ The install log is .*$/, '').replace(/(,? then| and) run install\.bat again\./, ', then press Try again.').trim();

  async function api(req, res, name) {
    const post = req.method === 'POST';
    if (name === 'state' && !post) return send(res, 200, { app: APP, version: version(source), defaultFolder: defaultFolder(env, source), ...state });
    if (name === 'progress' && !post) { if (idle && !leaving) closeSoon(idle); return send(res, 200, state); }   // an open page: wait on
    if (!post) return send(res, 405, { problem: 'Not here.' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { problem: 'Not here.' });
    const body = await readJson(req);
    if (!body || typeof body !== 'object') return send(res, 400, { problem: 'The installer could not read that. Reload the page and try again.' });
    if (name === 'browse') {
      if (state.phase === 'running') return send(res, 409, { problem: 'The install is running.' });
      const r = await run(cmdBrowse());
      return send(res, 200, { folder: String(r.stdout || '').trim() });
    }
    if (name === 'install') {
      if (state.phase === 'running' || state.phase === 'done') return send(res, 409, { problem: 'The install has already started.' });
      const folder = body.folder;
      if (typeof folder !== 'string' || !folder.trim() || folder.length > 240) return send(res, 400, { problem: 'Type the whole folder, starting with the drive, for example C:\\Users\\you\\AP Desk.' });
      const dir = folder.trim().replace(/^"|"$/g, '');
      const check = checkFolder(dir, { env, source });
      if (check.problem) return send(res, 400, { problem: check.problem });
      if (check.warn && body.anyway !== true) return send(res, 409, { warn: check.warn });
      const pick = (k, def) => typeof body[k] === 'boolean' ? body[k] : def;
      runInstall(path.resolve(dir), { desktop: pick('desktop', true), apps: pick('apps', true), autostart: pick('autostart', false), start: pick('start', true), anyway: body.anyway === true, kept: check.kept });
      return send(res, 202, { ok: true, kept: KEPT_NOTE[check.kept] || '' });
    }
    if (name === 'open') {
      if (state.phase !== 'done') return send(res, 409, { problem: 'The install has not finished yet.' });
      if (!state.started) { await run(cmdStart(state.dir)); state.started = true; }
      leaving = true; closeSoon(endAfter);
      return send(res, 200, { ok: true, note: 'AP Desk is starting. It opens in its own window in a moment.' });
    }
    if (name === 'close') { if (state.phase === 'running') return send(res, 409, { problem: 'The install is running.' }); leaving = true; closeSoon(endAfter); return send(res, 200, { ok: true }); }
    return send(res, 404, { problem: 'Not here.' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const self = `127.0.0.1:${port}`;
      if (req.headers.host !== self) return refuse(res);
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${self}`) return refuse(res);
      if (req.method === 'POST' && origin === undefined) return refuse(res);
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return refuse(res);
      const raw = String(req.url || '').split('?')[0];
      const prefix = `/${token}/`;
      if (raw.length < prefix.length || !crypto.timingSafeEqual(Buffer.from(raw.slice(0, prefix.length)), Buffer.from(prefix))) return refuse(res);
      const rest = raw.slice(prefix.length);
      if (rest.startsWith('api/')) return await api(req, res, rest.slice(4));
      if (req.method !== 'GET' || !Object.hasOwn(FILES, rest)) return send(res, 404, 'Not here.', 'text/plain; charset=utf-8');
      const [file, type] = FILES[rest];
      return send(res, 200, fs.readFileSync(path.join(HERE, file)), type);
    } catch { try { send(res, 500, { problem: 'The installer had a problem. Reload the page.' }); } catch {} }
  });

  return {
    token, state, ended,
    get url() { return url; },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; url = `http://127.0.0.1:${port}/${token}/`; resolve(url); });
    }),
    close: () => { if (closing) clearTimeout(closing); server.close(); server.closeAllConnections?.(); finish(endResult); },
  };
}

// Opens the address in this user's default browser. False when that could not be done.
export function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  return !r.error && r.status === 0;
}

// install.bat's default: the page. Null when no browser could be opened, so the console asks instead.
export async function pageInstall({ say = console.log, openBrowser = openInBrowser, ...opts } = {}) {
  const s = installerServer(opts);
  let url;
  try { url = await s.listen(); } catch { return null; }
  if (!(await openBrowser(url))) { s.close(); await s.ended; return null; }
  say('');
  say(`  The AP Desk installer opened in your browser. Keep this window open until it is done. If it did not open, go to ${url}`);
  const r = await s.ended;
  say(r.ok ? '  The install is done. This window can be closed.' : '  The installer was closed before the install was done.');
  return r.ok ? r.result : { ok: false, message: 'The install did not finish.', ...(r.result || {}) };
}
