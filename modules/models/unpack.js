// Unpack a verified llama.cpp archive (.zip for Windows, .tar.gz for Linux and macOS) into one folder.
// The same protections the Backup module uses: an entry with an absolute path, a drive letter, '..' or a NUL is
// refused before anything is written, and every target is checked to land inside the folder. Links in a tar are
// never created as links: once every file is written, a link whose target is a file inside the folder is copied
// from it; any other link refuses the archive. Sizes and entry counts are capped.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_ENTRIES = 5000;
const refuse = (m) => Object.assign(new Error(m), { code: 'bad_archive' });

/** An entry name we accept: relative, no drive letter, no '..', no NUL. */
export function entryOk(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes('\0')) return false;
  return !n.split('/').some(p => p === '..');
}
function target(dir, name) {
  const t = path.resolve(dir, String(name).replace(/\\/g, '/'));
  if (t !== dir && !t.startsWith(dir + path.sep)) throw refuse(`The archive tries to write outside its folder (${String(name).slice(0, 80)}).`);
  return t;
}

/** Unpack `file` into `dest` (created; must not exist). Throws bad_archive and leaves nothing behind on refusal. */
export function unpack(file, dest, { kind = /\.zip$/i.test(file) ? 'zip' : 'tar.gz' } = {}) {
  dest = path.resolve(dest);
  if (fs.existsSync(dest)) throw refuse('The engine folder is already there.');
  const entries = kind === 'zip' ? readZip(file) : readTarGz(file);
  if (entries.length > MAX_ENTRIES) throw refuse('The archive has too many entries.');
  let total = 0;
  for (const e of entries) {
    if (!entryOk(e.name)) throw refuse(`The archive tries to write outside its folder (${String(e.name).slice(0, 80)}).`);
    target(dest, e.name);
    if (e.type === 'link' && (!entryOk(e.link) || path.isAbsolute(e.link))) throw refuse(`The archive has a link that points outside its folder (${String(e.name).slice(0, 80)}).`);
    total += e.size || 0; if (total > MAX_BYTES) throw refuse('The archive unpacks to more than 2 GB.');
  }
  fs.mkdirSync(dest, { recursive: true });
  try {
    for (const e of entries) {
      const t = target(dest, e.name);
      if (e.type === 'dir') { fs.mkdirSync(t, { recursive: true }); continue; }
      if (e.type !== 'file') continue;
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, e.data(), { mode: e.mode & 0o111 ? 0o755 : 0o644 });
    }
    // links last, copied from their targets (a chain like libx.so -> libx.so.1 -> libx.so.1.0.0 is followed)
    const links = entries.filter(e => e.type === 'link');
    for (let pass = 0; pass < 8 && links.length; pass++) {
      for (let i = links.length - 1; i >= 0; i--) {
        const e = links[i]; const t = target(dest, e.name);
        const src = target(dest, path.posix.join(path.posix.dirname(e.name.replace(/\\/g, '/')), e.link));
        if (!fs.existsSync(src)) continue;
        const st = fs.lstatSync(src); if (!st.isFile()) throw refuse('The archive has a link to something that is not a file.');
        fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(src, t); fs.chmodSync(t, st.mode & 0o777);
        links.splice(i, 1);
      }
    }
    if (links.length) throw refuse('The archive has a link to a file it does not contain.');
  } catch (e) { fs.rmSync(dest, { recursive: true, force: true }); throw e; }
  return dest;
}

function readZip(file) {
  let zip; try { zip = new AdmZip(file); } catch { throw refuse('This file is not a zip.'); }
  return zip.getEntries().map(e => {
    const mode = (e.attr >>> 16) & 0o177777;
    if ((mode & 0o170000) === 0o120000) throw refuse('The archive has a link, which is not accepted in a zip.');
    return { name: e.entryName, type: e.isDirectory ? 'dir' : 'file', size: e.header.size, mode: mode || 0o644, data: () => e.getData() };
  });
}

/** A tar reader: ustar, GNU long names (L, K) and pax headers (x, g). Hard links and devices refuse the archive. */
export function readTarGz(file) {
  let buf; try { buf = zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: MAX_BYTES + 512 * 1024 * 1024 }); } catch { throw refuse('This file is not a .tar.gz archive.'); }
  const out = []; let off = 0; let longName = null; let longLink = null; let pax = {};
  const str = (a, b) => { const s = buf.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString('utf8'); };
  const oct = (a, b) => parseInt(str(a, b).trim() || '0', 8) || 0;
  while (off + 512 <= buf.length) {
    const h = off;
    if (buf.subarray(h, h + 512).every(x => x === 0)) break;
    const size = oct(h + 124, h + 136); const type = String.fromCharCode(buf[h + 156] || 48);
    const dataAt = h + 512; const next = dataAt + Math.ceil(size / 512) * 512;
    if (next > buf.length + 512) throw refuse('The archive is cut short.');
    const body = () => buf.subarray(dataAt, dataAt + size);
    if (type === 'L') { longName = body().toString('utf8').replace(/\0+$/, ''); off = next; continue; }
    if (type === 'K') { longLink = body().toString('utf8').replace(/\0+$/, ''); off = next; continue; }
    if (type === 'x' || type === 'g') { if (type === 'x') pax = parsePax(body()); off = next; continue; }
    const prefix = str(h + 345, h + 500);
    let name = pax.path || longName || (prefix ? prefix + '/' : '') + str(h, h + 100);
    const link = pax.linkpath || longLink || str(h + 157, h + 257);
    const mode = oct(h + 100, h + 108);
    longName = null; longLink = null; pax = {};
    name = name.replace(/^\.\//, '');
    if (!name || name === '.') { off = next; continue; }
    if (type === '0' || type === '\0' || type === '7') out.push({ name, type: 'file', size, mode, data: () => Buffer.from(body()) });
    else if (type === '5') out.push({ name, type: 'dir', size: 0, mode });
    else if (type === '2') out.push({ name, type: 'link', link, size: 0, mode });
    else throw refuse('The archive holds a hard link or a device, which is not accepted.');
    off = next;
  }
  return out;
}
function parsePax(b) {
  const o = {}; let i = 0; const s = b.toString('utf8');
  while (i < s.length) { const sp = s.indexOf(' ', i); if (sp < 0) break; const len = Number(s.slice(i, sp)); if (!len) break; const rec = s.slice(sp + 1, i + len - 1); const eq = rec.indexOf('='); if (eq > 0) o[rec.slice(0, eq)] = rec.slice(eq + 1); i += len; }
  return o;
}
