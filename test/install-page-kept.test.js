// The installer page with the folder an uninstall left: the folder is taken, and the page says the data is kept.
// A copy that stops half-way: the page gives the real cause, not disk space. Linux, fake Windows, fake runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { installerServer } from '../setup/installer-page/server.mjs';
import { KEPT_NOTE } from '../setup/install.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apd-pagekept-'));
const put = (root, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
function setup() {
  const src = tmp(); for (const rel of ['app/server.js', 'start.bat', 'uninstall.bat', 'setup/assets/apdesk.ico']) put(src, rel);
  put(src, 'package.json', JSON.stringify({ dependencies: { marked: '1' } })); put(src, 'node_modules/marked/package.json', '{}');
  const home = tmp(); const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming'), USERPROFILE: home };
  const run = async (c) => {
    if (c.cmd === 'powershell.exe' && c.args.at(-1).includes('GetFolderPath')) return { code: 0, stdout: `${home}\\p\r\n${home}\\d\r\n${home}\\s\r\n` };
    if (c.env?.APD_LNK) { fs.mkdirSync(path.dirname(c.env.APD_LNK), { recursive: true }); fs.writeFileSync(c.env.APD_LNK, 'lnk'); }
    return { code: 0, stdout: '' };
  };
  return { src, home, env, run };
}
async function call(url, name, body) {
  const r = await fetch(url + 'api/' + name, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(url).origin }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}
async function untilEnd(url) { for (let i = 0; i < 300; i++) { const s = (await call(url, 'progress')).json; if (s.phase !== 'running') return s; await new Promise(r => setTimeout(r, 20)); } throw new Error('never ended'); }

test('47 on the page: the folder with the kept data is accepted, and the ready screen says the data is kept', async (t) => {
  const w = setup(); const dir = path.join(w.home, 'AP Desk'); put(dir, 'data/apd.sqlite', 'my chats'); put(dir, 'backups/b.zip');
  const s = installerServer({ source: w.src, env: w.env, run: w.run, isRunning: async () => false });
  const url = await s.listen(); t.after(() => s.close());
  const r = await call(url, 'install', { folder: dir, start: false });
  assert.equal(r.status, 202); assert.equal(r.json.kept, KEPT_NOTE.kept);
  const end = await untilEnd(url);
  assert.equal(end.phase, 'done'); assert.equal(end.kept, KEPT_NOTE.kept);
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'apd.sqlite'), 'utf8'), 'my chats');
  const html = fs.readFileSync(new URL('../setup/installer-page/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="ready-kept"/); assert.match(html, /or the folder AP Desk was in before/);
  assert.match(fs.readFileSync(new URL('../setup/installer-page/page.js', import.meta.url), 'utf8'), /\$\('ready-kept'\)\.textContent = s\.kept \|\| ''/);
});

test('48 on the page: the fallback for an unexpected stop no longer puts it down to disk space alone', () => {
  const t = fs.readFileSync(new URL('../setup/installer-page/server.mjs', import.meta.url), 'utf8');
  assert.match(t, /Close any folder window that shows the AP Desk folder and check that the disk has space, then try again\./);
});
