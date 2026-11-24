// A small zip reader with no dependencies (node:zlib only). It reads the central directory, accepts only stored (0) and
// deflated (8) entries, and refuses anything else: encrypted entries, other methods, links, and entry names that climb
// out of the folder (".." parts, absolute paths, drive letters, backslash tricks).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const fail = (msg) => { throw Object.assign(new Error(msg), { code: 'bad_zip' }); };

/** Is this entry name safe to write under a folder? Works for names made on Windows or elsewhere. */
export function safeEntryName(name) {
  const n = String(name);
  if (!n || n.includes('\0')) return false;
  if (n.includes('\\')) return false;                       // zip names use '/'; a backslash is a Windows path smuggled in
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return false;
  return !n.split('/').some((p) => p === '..');
}

/** Read every entry: [{ name, dir, data: Buffer }]. Throws a plain sentence when the zip is refused. */
export function readZip(fileOrBuffer, { maxBytes = 20 * 1024 * 1024, maxEntries = 2000 } = {}) {
  const buf = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  let eocd = -1;
  for (let k = buf.length - 22; k >= Math.max(0, buf.length - 65557); k--) if (buf.readUInt32LE(k) === 0x06054b50) { eocd = k; break; }
  if (eocd < 0) fail('This is not a zip file (no end record).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) fail('Zip64 files are not read by this tool.');
  if (count > maxEntries) fail(`The zip holds ${count} entries; at most ${maxEntries} are read.`);
  const out = []; let p = cdOffset; let total = 0; const seen = new Map();
  for (let e = 0; e < count; e++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail('The zip directory is damaged.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8, ext = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nlen + xlen + clen;
    if (!safeEntryName(name)) fail(`Refused: the entry "${name}" would be written outside the folder.`);
    if (flags & 1) fail(`Refused: the entry "${name}" is encrypted.`);
    const unixMode = madeBy === 3 ? (ext >>> 16) : 0;
    if ((unixMode & 0o170000) === 0o120000) fail(`Refused: the entry "${name}" is a link.`);
    const dir = name.endsWith('/');
    const key = name.replace(/\/+$/, '').toLowerCase();   // Windows does not tell Server.js from server.js
    if (seen.has(key)) fail(seen.get(key) === name ? `Refused: the zip holds two entries named "${name}".` : `Refused: the zip holds "${seen.get(key)}" and "${name}", which are the same name on Windows.`);
    seen.set(key, name);
    if (dir) { out.push({ name, dir: true, data: Buffer.alloc(0) }); continue; }
    if (method !== 0 && method !== 8) fail(`Refused: the entry "${name}" uses a packing method this tool does not read (${method}).`);
    if (buf.readUInt32LE(local) !== 0x04034b50) fail('The zip is damaged (local header).');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(start, start + csize);
    total += usize; if (total > maxBytes) fail(`The zip unpacks to more than ${Math.round(maxBytes / 1048576)} MB; refused.`);
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
    if (data.length !== usize) fail(`The entry "${name}" did not unpack to its stated size.`);
    out.push({ name, dir: false, data });
  }
  return out;
}

/** Unpack into an empty folder. If every entry sits in one top folder, that folder's contents land in `dest`. */
export function unzipTo(file, dest) {
  const entries = readZip(file);
  const files = entries.filter((e) => !e.dir);
  const tops = new Set(files.map((e) => e.name.split('/')[0]));
  const strip = tops.size === 1 && files.every((e) => e.name.includes('/')) ? [...tops][0] + '/' : '';
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  for (const e of files) {
    const rel = e.name.slice(strip.length);
    const target = path.resolve(root, ...rel.split('/'));
    if (!target.startsWith(root + path.sep)) fail(`Refused: the entry "${e.name}" would be written outside the folder.`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data, { flag: 'wx' });
  }
  return { folder: strip ? strip.slice(0, -1) : null, files: files.length };
}
