// The installer page's server (setup/installer-page/server.mjs), on Linux with a fake Windows and a fake command
// runner: it answers only its own page, serves only its own files, and installs through the same install() as the
// console path, with the same folder checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { installerServer, pageInstall } from '../setup/installer-page/server.mjs';
import { install } from '../setup/install.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apd-page-'));
function fakeDownload() {
  const src = tmp(); const w = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), text); };
  w('app/server.js', '// desk'); w('app/version.json', JSON.stringify({ version: '9.8.7' })); w('start.bat'); w('stop.bat'); w('install.bat'); w('uninstall.bat');
  w('setup/assets/apdesk.ico'); w('setup/package.json', JSON.stringify({ dependencies: { marked: '1' } })); w('data/desk.sqlite', 'theirs');
  return src;
}
function fakeWindows({ npmFails = false } = {}) {
  const home = tmp(); const env = { LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'), USERPROFILE: home, OneDrive: path.join(home, 'OneDrive') };
  const folders = { programs: path.join(env.APPDATA, 'Programs'), desktop: path.join(home, 'Desktop'), startup: path.join(env.APPDATA, 'Startup') };
  const ran = [];
  const run = async (c) => {
    ran.push(c);
    if (c.cmd === 'powershell.exe' && c.args.at(-1).includes('GetFolderPath')) return { code: 0, stdout: `${folders.programs}\r\n${folders.desktop}\r\n${folders.startup}\r\n` };
    if (c.cmd === 'powershell.exe' && c.args.at(-1).includes('FolderBrowserDialog')) return { code: 0, stdout: path.join(home, 'Picked') + '\r\n' };
    if (c.quiet) {   // the stand-in npm: a moment of work, then the packages (or an error)
      await new Promise(r => setTimeout(r, 60));
      if (npmFails) { fs.mkdirSync(path.dirname(c.log), { recursive: true }); fs.appendFileSync(c.log, 'npm warn deprecated x\nnpm error code ENOTFOUND\n'); return { code: 1, stdout: '', errors: ['npm error code ENOTFOUND'] }; }
      fs.mkdirSync(path.join(c.cwd, 'node_modules', 'marked'), { recursive: true }); fs.writeFileSync(path.join(c.cwd, 'node_modules', 'marked', 'package.json'), '{}'); return { code: 0, stdout: '' };
    }
    if (c.env?.APD_LNK) { fs.writeFileSync(c.env.APD_LNK, 'lnk'); return { code: 0, stdout: '' }; }
    return { code: 0, stdout: '' };
  };
  return { home, env, folders, ran, run };
}

// a raw request, so the path, Host and Origin are sent exactly as given
function req(url, { method = 'GET', path: p, host, origin, site, body, type = 'application/json' } = {}) {
  const u = new URL(url);
  const headers = { host: host ?? u.host };
  if (origin !== null) headers.origin = origin ?? (method === 'POST' ? u.origin : undefined);
  if (headers.origin === undefined) delete headers.origin;
  if (site) headers['sec-fetch-site'] = site;
  if (body !== undefined) headers['content-type'] = type;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: u.port, method, path: p ?? u.pathname, headers }, (res) => {
      const parts = []; res.on('data', d => parts.push(d)); res.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject); if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body)); r.end();
  });
}
const api = (url, name, body) => req(url + 'api/' + name, body === undefined ? {} : { method: 'POST', body });
async function untilDone(url) { for (let i = 0; i < 200; i++) { const s = (await api(url, 'progress')).json; if (s.phase !== 'running') return s; await new Promise(r => setTimeout(r, 20)); } throw new Error('the install never ended'); }

test('installer page: refuses requests without the token, with another Host or Origin, and paths outside its folder', async (t) => {
  const s = installerServer({ source: fakeDownload(), env: fakeWindows().env, run: () => { throw new Error('no command may run'); } });
  const url = await s.listen(); t.after(() => s.close());
  const u = new URL(url); const tok = s.token;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/$/, 'a one-time random token in the address');
  const ok = await req(url); assert.equal(ok.status, 200); assert.match(ok.text, /<title>Install AP Desk<\/title>/);
  assert.match(ok.headers['content-security-policy'], /default-src 'none'/); assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  for (const f of ['page.js', 'page.css', 'logo.svg']) assert.equal((await req(url + f)).status, 200, f);
  for (const p of ['/', '/index.html', '/api/state', `/${tok.slice(0, -1)}x/`, `/${tok}`, `/x${tok}/`]) assert.equal((await req(url, { path: p })).status, 403, `no token: ${p}`);
  assert.equal((await req(url, { host: `localhost:${u.port}` })).status, 403, 'another Host');
  assert.equal((await req(url, { host: `evil.example:${u.port}` })).status, 403, 'another Host');
  assert.equal((await req(url, { origin: 'http://evil.example' })).status, 403, 'another Origin');
  assert.equal((await req(url + 'api/state', { origin: `http://localhost:${u.port}` })).status, 403);
  assert.equal((await req(url + 'api/browse', { method: 'POST', body: {}, origin: null })).status, 403, 'a POST must say where it comes from');
  assert.equal((await req(url + 'api/browse', { method: 'POST', body: {}, origin: 'http://evil.example' })).status, 403);
  assert.equal((await req(url + 'api/state', { site: 'cross-site' })).status, 403);
  assert.equal((await req(url + 'api/browse', { method: 'POST', body: 'folder=x', type: 'application/x-www-form-urlencoded' })).status, 415, 'only JSON from its own script');
  const secret = fs.readFileSync(path.join(ROOT, 'setup', 'install.mjs'), 'utf8').slice(0, 60);
  for (const p of [`/${tok}/../install.mjs`, `/${tok}/..%2finstall.mjs`, `/${tok}/%2e%2e/install.mjs`, `/${tok}/server.mjs`, `/${tok}/..\\install.mjs`, `/${tok}/index.html/../../package.json`, `/${tok}//etc/passwd`, `/${tok}/page.js%00.css`]) {
    const r = await req(url, { path: p }); assert.notEqual(r.status, 200, p); assert.equal(r.text.includes(secret), false, p);
  }
  // the page itself loads nothing from outside and keeps the token out of other sites' sight
  for (const f of ['index.html', 'page.js', 'page.css']) {
    const text = fs.readFileSync(path.join(ROOT, 'setup', 'installer-page', f), 'utf8');
    assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(text), false, `${f}: no outside address`);
    assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(text), false, `${f}: no emoji`);
  }
});

test('installer page: a full install through its routes does what the console path does', async (t) => {
  const src = fakeDownload();
  // the console path
  const wc = fakeWindows(); const dirC = path.join(wc.home, 'Apps', 'AP Desk');
  const rc = await install({ argv: ['--folder', dirC], env: wc.env, source: src, run: wc.run, ask: async () => '', say: () => {}, isRunning: async () => false });
  assert.equal(rc.ok, true);
  // the page
  const wp = fakeWindows(); const dirP = path.join(wp.home, 'Apps', 'AP Desk');
  const s = installerServer({ source: src, env: wp.env, run: wp.run, isRunning: async () => false, endAfter: 10 }); const url = await s.listen(); t.after(() => s.close());
  const st = (await api(url, 'state')).json;
  assert.equal(st.version, '9.8.7'); assert.equal(st.defaultFolder, path.join(wp.env.LOCALAPPDATA, 'Programs', 'AP Desk')); assert.equal(st.phase, 'ready');
  const b = await api(url, 'browse', {}); assert.equal(b.json.folder, path.join(wp.home, 'Picked'), 'Browse is the console\'s folder picker');
  const go = await api(url, 'install', { folder: dirP, desktop: true, apps: true, autostart: false, start: true });
  assert.equal(go.status, 202);
  assert.equal((await api(url, 'install', { folder: dirP })).status, 409, 'one install at a time');
  const mid = (await api(url, 'progress')).json; assert.ok(['running', 'done'].includes(mid.phase));
  const end = await untilDone(url);
  assert.equal(end.phase, 'done'); assert.deepEqual(end.done, ['copy', 'packages', 'shortcuts', 'done']); assert.equal(end.started, true); assert.equal(end.problems, 0);
  assert.equal(end.dir, dirP); assert.match(end.line, /Starting AP Desk/);
  // the same files and the same commands, with each fake home put back to one name
  const tree = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? tree(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]).sort();
  assert.deepEqual(tree(wp.home).filter(f => f !== path.join('Picked', '.keep')), tree(wc.home));
  assert.equal(fs.readFileSync(path.join(dirP, 'setup', 'installed.txt'), 'utf8'), fs.readFileSync(path.join(dirC, 'setup', 'installed.txt'), 'utf8'));
  const norm = (ran, home) => ran.filter(c => !/FolderBrowserDialog/.test(c.args.at(-1))).map(c => JSON.stringify({ cmd: c.cmd, args: c.args, env: c.env, cwd: c.cwd, log: c.log }).split(JSON.stringify(home).slice(1, -1)).join('HOME'));
  assert.deepEqual(norm(wp.ran, wp.home), norm(wc.ran, wc.home));
  assert.equal(wp.ran.at(-1).what, 'start AP Desk');
  // Open AP Desk: the desk is already starting, so nothing more runs; then the installer ends
  const before = wp.ran.length; const o = await api(url, 'open', {}); assert.equal(o.status, 200); assert.match(o.json.note, /opens in its own window/);
  assert.equal(wp.ran.length, before);
  const r = await s.ended; assert.equal(r.ok, true); assert.equal(r.dir, dirP);
});

test('installer page: the folder rules hold (empty or new, whole path, OneDrive asks first), and a failure says what and where the log is', async (t) => {
  const src = fakeDownload(); const w = fakeWindows();
  const s = installerServer({ source: src, env: w.env, run: w.run, isRunning: async () => false, endAfter: 10 }); const url = await s.listen(); t.after(() => s.close());
  const mine = path.join(w.home, 'Documents'); fs.mkdirSync(mine); fs.writeFileSync(path.join(mine, 'mine.txt'), 'mine');
  const r1 = await api(url, 'install', { folder: mine }); assert.equal(r1.status, 400); assert.match(r1.json.problem, /already has other files in it\. Pick an empty folder or a new one/);
  assert.deepEqual(fs.readdirSync(mine), ['mine.txt'], 'nothing is put in a folder that has other files');
  for (const bad of ['relative\\AP Desk', '', 42, null, 'C'.repeat(300)]) assert.equal((await api(url, 'install', { folder: bad })).status, 400, String(bad).slice(0, 20));
  assert.match((await api(url, 'install', { folder: path.join(w.home, 'A & B') })).json.problem, /none of these characters/);
  assert.match((await api(url, 'install', { folder: path.join(src, 'inside') })).json.problem, /outside the one you unpacked/);
  const one = path.join(w.env.OneDrive, 'AP Desk'); const r2 = await api(url, 'install', { folder: one });
  assert.equal(r2.status, 409); assert.match(r2.json.warn, /inside OneDrive/);
  assert.equal(w.ran.length, 0, 'nothing ran while the folder was being checked');
  assert.equal((await api(url, 'open', {})).status, 409, 'nothing to open before the install ends');
  assert.equal((await api(url, 'install', { folder: one, anyway: true, start: false })).status, 202);
  const end = await untilDone(url); assert.equal(end.phase, 'done'); assert.equal(end.started, false);
  assert.equal(w.ran.some(c => c.what === 'start AP Desk'), false);
  await api(url, 'open', {}); assert.equal(w.ran.at(-1).what, 'start AP Desk', 'Open AP Desk starts it when the install did not');
  await s.ended;

  const wf = fakeWindows({ npmFails: true }); const sf = installerServer({ source: src, env: wf.env, run: wf.run, isRunning: async () => false, endAfter: 10 });
  const uf = await sf.listen(); t.after(() => sf.close());
  const dir = path.join(wf.home, 'AP Desk');
  assert.equal((await api(uf, 'install', { folder: dir })).status, 202);
  const f = await untilDone(uf);
  assert.equal(f.phase, 'failed'); assert.equal(f.step, 'packages'); assert.deepEqual(f.done, ['copy']);
  assert.equal(f.message, 'The packages could not be installed. Check your internet connection, then press Try again.', 'the page gives one next step, the button on the same screen');
  assert.equal(f.log, path.join(dir, 'data', 'install.log')); assert.match(fs.readFileSync(f.log, 'utf8'), /npm warn deprecated x/);
  assert.equal((await api(uf, 'install', { folder: dir })).status, 202, 'Try again runs the install again in the same folder');
  await untilDone(uf);
  assert.equal((await api(uf, 'close', {})).status, 200); assert.equal((await sf.ended).ok, false);
});

test('installer page: it stays up while its page is open after the install, and ends on its own once the page is gone', async (t) => {
  const src = fakeDownload(); const w = fakeWindows();
  const s = installerServer({ source: src, env: w.env, run: w.run, isRunning: async () => false, endAfter: 10, idleAfterEnd: 150 }); const url = await s.listen(); t.after(() => s.close());
  let gone = false; s.ended.then(() => { gone = true; });
  await api(url, 'install', { folder: path.join(w.home, 'AP Desk'), start: false }); assert.equal((await untilDone(url)).phase, 'done');
  for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 60)); assert.equal((await api(url, 'progress')).status, 200, 'the open page keeps the installer up'); }
  assert.equal(gone, false);
  const o = await api(url, 'open', {}); assert.equal(o.status, 200, 'Open AP Desk still works long after the install ended');
  assert.equal(w.ran.at(-1).what, 'start AP Desk');
  await s.ended;
  const w2 = fakeWindows(); const s2 = installerServer({ source: src, env: w2.env, run: w2.run, isRunning: async () => false, endAfter: 10, idleAfterEnd: 100 }); const u2 = await s2.listen(); t.after(() => s2.close());
  await api(u2, 'install', { folder: path.join(w2.home, 'AP Desk'), start: false }); await untilDone(u2);
  assert.equal((await s2.ended).ok, true, 'with no page asking, it still ends');
  // the page pings while it shows the end screens, and if the installer has ended it says how to start AP Desk
  const page = fs.readFileSync(path.join(ROOT, 'setup', 'installer-page', 'page.js'), 'utf8');
  assert.match(page, /function keepAlive/); assert.match(page, /Start menu/);
});

test('installer page: one line in the console, and the console asks when no browser opens', async () => {
  const src = fakeDownload(); const w = fakeWindows(); const lines = [];
  const none = await pageInstall({ source: src, env: w.env, run: w.run, say: (l) => lines.push(l), openBrowser: () => false });
  assert.equal(none, null); assert.deepEqual(lines, [], 'no browser: the console path takes over');
  let opened = '';
  const p = pageInstall({ source: src, env: w.env, run: w.run, isRunning: async () => false, endAfter: 10, say: (l) => lines.push(l), openBrowser: (u) => { opened = u; return true; } });
  while (!opened) await new Promise(r => setTimeout(r, 5));
  const said = lines.filter(Boolean); assert.equal(said.length, 1);
  assert.equal(said[0], `  The AP Desk installer opened in your browser. Keep this window open until it is done. If it did not open, go to ${opened}`);
  await api(opened, 'install', { folder: path.join(w.home, 'AP Desk'), start: false }); await untilDone(opened); await api(opened, 'open', {});
  const r = await p; assert.equal(r.ok, true); assert.match(lines.at(-1), /The install is done/);
});
