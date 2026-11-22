// A second install into the folder an uninstall left (data kept), and an upgrade whose copy stops half-way.
// Run on Linux with a fake Windows: the copy and the moves are the real file steps, with a fault put in on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { install, checkFolder, copyProgram, keptData, KEPT_NOTE, STAGE, OLD } from '../setup/install.mjs';
import { uninstall } from '../setup/uninstall.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apd-retry-'));
const put = (root, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
function download(tag = 'new') {
  const src = tmp();
  for (const rel of ['app/server.js', 'modules/chat/module.json', 'setup/check.mjs', 'start.bat', 'stop.bat', 'uninstall.bat', 'README.md']) put(src, rel, `${tag} ${rel}`);
  put(src, 'package.json', JSON.stringify({ version: '9.8.7', dependencies: { marked: '1' } })); put(src, 'node_modules/marked/package.json', '{}');
  return src;
}
function windows() {
  const home = tmp(); const env = { LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'), USERPROFILE: home };
  const folders = { programs: path.join(env.APPDATA, 'Programs'), desktop: path.join(home, 'Desktop'), startup: path.join(env.APPDATA, 'Startup') };
  const run = (c) => {
    if (c.cmd === 'powershell.exe' && c.args.at(-1).includes('GetFolderPath')) return { code: 0, stdout: `${folders.programs}\r\n${folders.desktop}\r\n${folders.startup}\r\n` };
    if (c.env?.APD_LNK) { fs.writeFileSync(c.env.APD_LNK, 'lnk'); return { code: 0, stdout: '' }; }
    return { code: 0, stdout: '' };
  };
  return { home, env, run };
}
const quiet = () => { const lines = []; const say = (l) => lines.push(String(l)); say.lines = lines; return say; };
const opts = (w, dir, src, more = {}) => ({ argv: ['--folder', dir, '--yes'], env: w.env, source: src, run: w.run, say: quiet(), isRunning: async () => false, ...more });
const busy = (code) => Object.assign(new Error(`${code}: resource busy or locked`), { code });

test('47: a folder that holds only the data an uninstall kept is accepted, the install says so and keeps the data', async () => {
  const w = windows(); const dir = path.join(w.env.LOCALAPPDATA, 'Programs', 'AP Desk');
  await install(opts(w, dir, download('old')));
  put(dir, 'data/apd.sqlite', 'my chats'); put(dir, 'backups/b.zip', 'my backup');
  const u = await uninstall({ dir, run: w.run, ask: async () => '', say: quiet() });
  assert.equal(u.ok, true); assert.equal(u.delData, false);
  fs.rmSync(path.join(dir, 'uninstall.bat'), { force: true });                   // uninstall.bat removes itself last
  assert.deepEqual(fs.readdirSync(dir).sort(), ['backups', 'data'], 'what an uninstall that kept the data leaves');

  const c = checkFolder(dir, { env: w.env, source: tmp() });
  assert.equal(c.problem, undefined, 'not refused as a folder with other files');
  assert.equal(c.kept, 'kept'); assert.equal(c.installed, false);
  const say = quiet();
  const r = await install(opts(w, dir, download('new'), { say }));
  assert.equal(r.ok, true);
  assert.ok(say.lines.some(l => l.includes(KEPT_NOTE.kept)), 'the install says it found the data and keeps it');
  assert.equal(read(dir, 'data/apd.sqlite'), 'my chats'); assert.equal(read(dir, 'backups/b.zip'), 'my backup');
  assert.equal(read(dir, 'app/server.js'), 'new app/server.js');
});

test('47: a folder with the person\'s own files is still refused, also one with a bare data folder of another program', () => {
  const w = windows(); const src = tmp();
  const own = path.join(w.home, 'Docs'); put(own, 'data/notes.txt', 'mine'); put(own, 'letter.txt', 'mine');
  assert.match(checkFolder(own, { env: w.env, source: src }).problem, /other files/);
  const other = path.join(w.home, 'Other'); put(other, 'data/cache.bin', 'theirs');
  assert.match(checkFolder(other, { env: w.env, source: src }).problem, /other files/, 'a data folder without the desk\'s own files is not ours');
  assert.equal(keptData(path.join(w.home, 'none')), false);
});

test('47: a half-way folder or a lone log or port file is ours only when nothing else in it is the person\'s', () => {
  const w = windows(); const src = download();
  const at = (name, files) => { const d = path.join(w.home, name); for (const [rel, text] of Object.entries(files)) put(d, rel, text); return d; };
  const refused = (d) => assert.match(checkFolder(d, { env: w.env, source: src }).problem || '', /other files/, d);
  refused(at('Mine', { 'Thesis.docx': 'mine', 'Photos/a.jpg': 'mine', [`${OLD}/x`]: 'x' }));   // the person's files beside an .apdesk-old
  refused(at('Log', { 'data/install.log': 'Setup of another program, 1 May' }));                // another program's install log
  refused(at('Port', { 'data/port.txt': '8080' }));                                               // a port file alone
  // what this installer leaves when it stops half-way is still taken up
  assert.equal(keptData(at('Half', { [`${STAGE}/app/server.js`]: 'new', 'modules/chat/module.json': 'new', 'data/install.log': '  AP Desk 9.8.7 install, 22 Nov 2026 10:00 IST, into C:\\x' }), { source: src }), 'unfinished');
  assert.equal(keptData(at('Logged', { 'data/install.log': '  AP Desk 9.8.7 install, 22 Nov 2026 10:00 IST, into C:\\x\r\n  Copying the program ...' }), { source: src }), 'unfinished');
  assert.equal(keptData(at('Kept', { 'data/apd.sqlite': 'db', 'data/port.txt': '3445' }), { source: src }), 'kept');
});

test('48: a copy that stops half-way changes nothing: the old desk is whole, and the next try works', async () => {
  const w = windows(); const dir = path.join(w.home, 'AP Desk');
  await install(opts(w, dir, download('old')));
  put(dir, 'data/apd.sqlite', 'my chats');
  const src = download('new');
  let n = 0;
  const copy = (a, b) => { if (++n === 3) throw busy('EBUSY'); fs.cpSync(a, b, { recursive: true }); };
  const r = await install(opts(w, dir, src, { files: { copy } }));
  assert.equal(r.ok, false);
  assert.match(r.message, /in use by another program/); assert.match(r.message, /Nothing in the folder was changed/);
  assert.equal(/disk has space/.test(r.message), false, 'the cause is not put down to disk space');
  assert.equal(read(dir, 'app/server.js'), 'old app/server.js', 'the old program is untouched');
  assert.equal(read(dir, 'modules/chat/module.json'), 'old modules/chat/module.json');
  assert.equal(fs.existsSync(path.join(dir, STAGE)), false, 'the half copy is gone');
  assert.match(read(dir, 'data/install.log'), /Copy stopped: copy: EBUSY/, 'what Windows said goes to the install log');
  assert.equal(checkFolder(dir, { env: w.env, source: src }).installed, true, 'the folder is still an install');
  const again = await install(opts(w, dir, src));
  assert.equal(again.ok, true); assert.equal(read(dir, 'app/server.js'), 'new app/server.js'); assert.equal(read(dir, 'data/apd.sqlite'), 'my chats');
});

test('48: a swap that fails puts every old file back; a file held for a moment is tried again', async () => {
  const w = windows(); const dir = path.join(w.home, 'AP Desk');
  await install(opts(w, dir, download('old')));
  const src = download('new');
  // the old setup folder cannot be moved aside (held open the whole time): the swap stops there
  const move = (a, b) => { if (a === path.join(dir, 'setup')) throw busy('EPERM'); fs.renameSync(a, b); };
  const r = await install(opts(w, dir, src, { files: { move } }));
  assert.equal(r.ok, false); assert.match(r.message, /The program that was there is back in place/);
  for (const rel of ['app/server.js', 'modules/chat/module.json', 'README.md', 'setup/check.mjs', 'start.bat']) assert.equal(read(dir, rel), `old ${rel}`, `${rel} is the old one again`);
  for (const x of [STAGE, OLD]) assert.equal(fs.existsSync(path.join(dir, x)), false, `${x} is cleared`);
  // held for a moment: the second attempt to move it works, and the install goes through
  let held = 1;
  const once = (a, b) => { if (a === path.join(dir, 'app') && held-- > 0) throw busy('EBUSY'); fs.renameSync(a, b); };
  const ok = await install(opts(w, dir, src, { files: { move: once } }));
  assert.equal(ok.ok, true); assert.equal(read(dir, 'app/server.js'), 'new app/server.js');
});

test('48: a PC that stopped in the middle of a swap: the folder is accepted and the old files come back before the copy', () => {
  const w = windows(); const dir = path.join(w.home, 'AP Desk'); const src = download('new');
  put(dir, 'data/apd.sqlite', 'my chats'); put(dir, `${OLD}/app/server.js`, 'old app'); put(dir, 'modules/chat/module.json', 'new');
  const c = checkFolder(dir, { env: w.env, source: src });
  assert.equal(c.problem, undefined); assert.equal(c.kept, 'unfinished');
  // putting back only: a copy that fails at once still leaves the old app in place
  assert.throws(() => copyProgram(src, dir, { copy: () => { throw busy('EBUSY'); } }));
  assert.equal(read(dir, 'app/server.js'), 'old app', 'the old app is back where it was');
  assert.equal(fs.existsSync(path.join(dir, OLD)), false);
  copyProgram(src, dir);
  assert.equal(read(dir, 'app/server.js'), 'new app/server.js');
});

test('48: a first install whose copy failed leaves only its log, and the folder is accepted for the next try', async () => {
  const w = windows(); const dir = path.join(w.home, 'Fresh'); const src = download('new');
  const r = await install(opts(w, dir, src, { files: { copy: () => { throw busy('ENOSPC'); } } }));
  assert.equal(r.ok, false); assert.match(r.message, /disk is full/);
  assert.deepEqual(fs.readdirSync(dir), ['data']);
  assert.equal(checkFolder(dir, { env: w.env, source: src }).kept, 'unfinished');
  const say = quiet(); const again = await install(opts(w, dir, src, { say }));
  assert.equal(again.ok, true); assert.ok(say.lines.some(l => l.includes(KEPT_NOTE.unfinished)));
});

test('uninstall also clears what an install that stopped half-way left', async () => {
  const w = windows(); const dir = path.join(w.home, 'AP Desk');
  await install(opts(w, dir, download('old')));
  put(dir, `${STAGE}/app/x.js`); put(dir, `${OLD}/README.md`);
  await uninstall({ dir, run: w.run, ask: async () => '', say: quiet() });
  for (const x of [STAGE, OLD]) assert.equal(fs.existsSync(path.join(dir, x)), false);
});
