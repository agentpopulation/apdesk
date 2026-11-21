// Throw-away keys, release zips, a loopback stand-in for GitHub and a fake install folder, for the update tests and probe.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const APPLY = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'setup', 'apply-update.mjs');

export function makeKeys(id = 'test-key') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { id, privateKey, entry: { id, added: '2026-11-21', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } };
}
export const sign = (bytes, key) => crypto.sign(null, bytes, key.privateKey).toString('base64');

/** A release zip laid out like dist/agent-population-desk.zip: one apdesk/ folder. extra: [name, data, attr?] */
export function releaseZip(version, { extra = [], marker = 'new' } = {}) {
  const z = new AdmZip();
  z.addFile('apdesk/app/server.js', Buffer.from(`// ${marker} server ${version}\n`));
  z.addFile('apdesk/app/version.json', Buffer.from(JSON.stringify({ version, built: '2026-11-21T10:00:00.000Z' })));
  z.addFile('apdesk/app/package.json', Buffer.from('{ "type": "module" }\n'));
  z.addFile('apdesk/modules/alpha/module.json', Buffer.from(JSON.stringify({ id: 'alpha', marker })));
  z.addFile('apdesk/setup/package.json', Buffer.from(JSON.stringify({ name: 'agent-population-desk', version })));
  z.addFile('apdesk/setup/apply-update.mjs', fs.readFileSync(APPLY));
  z.addFile('apdesk/start.bat', Buffer.from(`rem ${marker} ${version}\r\n`));
  z.addFile('apdesk/README.md', Buffer.from(`${marker} readme\n`));
  z.addFile('apdesk/data/README.txt', Buffer.from('a release must never write into data\n'));
  z.addFile('apdesk/backups/README.txt', Buffer.from('nor into backups\n'));
  // the name is set after adding: adm-zip cleans names on add, and an attacker's zip would not be cleaned
  extra.forEach(([name, data, attr], i) => { const tmp = `apdesk/extra-${i}.txt`; z.addFile(tmp, Buffer.from(data)); const e = z.getEntry(tmp); if (attr != null) e.header.attr = attr; e.entryName = name; });
  return z.toBuffer();
}

/** The manifest and its signature for one zip. */
export function release(version, zip, key, { minFrom = '0.1.0', date = '2026-11-21T10:00:00.000Z', size, sha, kind = 'windows-zip', product = 'apdesk', name = 'agent-population-desk.zip', channel, notes = ['Updates are signed now.', 'Smaller fixes.'] } = {}) {
  const manifest = { product, version, date, key: key.id, ...(channel ? { channel } : {}), notes, minFrom, files: [{ name, kind, size: size ?? zip.length, sha256: sha ?? crypto.createHash('sha256').update(zip).digest('hex') }] };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 1));
  return { manifest, bytes, sig: sign(bytes, key) };
}

/** A loopback stand-in for GitHub: latest/download redirects like GitHub does; the zip is served under its tag.
 *  publishTag() adds a release under its own tag (a pre-release too) and lists it in releases.atom, newest first;
 *  latest/download stays the latest full release. slowMs: zips are sent in small pieces this far apart. */
export async function standIn() {
  const s = { files: new Map(), tags: new Map(), hits: [], tagOf: null, slowMs: 0 };
  s.server = http.createServer(async (req, res) => {
    s.hits.push({ url: req.url, ua: req.headers['user-agent'], cookie: req.headers.cookie || null, auth: req.headers.authorization || null });
    if (req.url === '/agentpopulation/apdesk/releases.atom') {
      const entries = [...s.tags.keys()].reverse().map(t => `<entry><id>tag:github.com,2008:Repository/1/${t}</id><link rel="alternate" type="text/html" href="https://github.com/agentpopulation/apdesk/releases/tag/${t}"/><title>${t}</title></entry>`).join('');
      res.writeHead(200, { 'content-type': 'application/atom+xml' }); return res.end(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`);
    }
    const m = /^\/agentpopulation\/apdesk\/releases\/(?:latest\/download|download\/(v[\d.]+))\/([\w.-]+)$/.exec(req.url);
    if (m && !m[1]) { res.writeHead(302, { location: `/assets/${m[2]}` }); return res.end(); }
    const name = m ? m[2] : (/^\/assets\/([\w.-]+)$/.exec(req.url) || [])[1];
    const body = name && ((m?.[1] && s.tags.get(m[1])?.get(name)) || s.files.get(name));
    if (!body) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    if (!s.slowMs || !name.endsWith('.zip')) return res.end(body);
    for (let i = 0; i < body.length && !res.destroyed; i += 4096) { res.write(body.subarray(i, i + 4096)); await new Promise(r => setTimeout(r, s.slowMs)); }
    res.end();
  });
  await new Promise(r => s.server.listen(0, '127.0.0.1', r));
  s.host = `127.0.0.1:${s.server.address().port}`;
  s.repo = `http://${s.host}/agentpopulation/apdesk`;
  s.publish = (r, zip, name = 'agent-population-desk.zip') => { s.files.set('apdesk-update.json', r.bytes); s.files.set('apdesk-update.json.sig', Buffer.from(r.sig + '\n')); if (zip) s.files.set(name, zip); };
  s.publishTag = (tag, r, zip, name = 'agent-population-desk.zip') => { const t = new Map([['apdesk-update.json', r.bytes], ['apdesk-update.json.sig', Buffer.from(r.sig + '\n')]]); if (zip) t.set(name, zip); s.tags.delete(tag); s.tags.set(tag, t); };
  s.close = () => { s.server.closeAllConnections?.(); return new Promise(r => s.server.close(r)); };
  return s;
}

/** A fake zip install of version 0.1.0 in the temp folder, with the owner's data inside it. shipped: its modules
 *  folder carries the record of what the release shipped (modules/shipped.json), as an updated install does. */
export function fakeInstall({ version = '0.1.0', git = false, source = false, shipped = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-upd-root-'));
  const w = (rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  w('app/server.js', '// old server\n');
  if (!source) w('app/version.json', JSON.stringify({ version, built: '2026-11-14T18:22:00.000Z' }));
  w('modules/alpha/module.json', JSON.stringify({ id: 'alpha', marker: 'old' }));
  w('modules/beta/module.json', JSON.stringify({ id: 'beta', marker: 'old' }));
  if (shipped) w('modules/shipped.json', JSON.stringify({ version, entries: ['alpha', 'beta', 'shipped.json'] }));
  if (source) w('package.json', JSON.stringify({ name: 'agent-population-desk', version })); else w('setup/package.json', JSON.stringify({ version }));
  w('setup/apply-update.mjs', fs.readFileSync(APPLY));
  w('start.bat', 'rem old\r\n'); w('README.md', 'old readme\n');
  w('runtime/node.txt', 'a private Node the installer put here\n');
  w('data/keep.txt', 'the owner\'s own file\n');
  if (git) fs.mkdirSync(path.join(root, '.git'));
  return root;
}

