// Plain PDF text reader.
// SPDX-License-Identifier: Apache-2.0
/**
 * Plain PDF text reader for when anydoc's native core is not loaded. It inflates the page content
 * streams (FlateDecode or unfiltered) and collects the text drawn with Tj, TJ, ' and ". Fonts with a
 * ToUnicode map are decoded through it. No layout, no images, no OCR: a scanned PDF has no text to
 * find, and the caller says so plainly instead of guessing. Pure JavaScript; nothing leaves the PC.
 */
import zlib from 'node:zlib';

const MAX_STREAMS = 5000;
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const cp1252 = new TextDecoder('windows-1252');

function pdfError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Every stream in the file: its dictionary text and its decoded bytes (null when not decodable). */
function inflate(raw) {
  try {
    return zlib.inflateSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
  } catch {
    try { return zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: MAX_INFLATED_BYTES }); } catch { return null; }
  }
}

/** ASCII85 (PDF /ASCII85Decode): groups of 5 chars in '!'..'u', 'z' = four zero bytes, ends at '~>'. */
export function ascii85(raw) {
  const s = Buffer.from(raw).toString('latin1').replace(/^\s*<~/, '');
  const endAt = s.indexOf('~>');
  const body = (endAt >= 0 ? s.slice(0, endAt) : s).replace(/\s+/g, '');
  const out = [];
  let group = [];
  for (const ch of body) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) return null;
    group.push(c);
    if (group.length === 5) {
      let n = 0;
      for (const d of group) n = n * 85 + d;
      out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
      group = [];
    }
  }
  if (group.length) {
    const k = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const d of group) n = n * 85 + d;
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...bytes.slice(0, k - 1));
  }
  return Buffer.from(out);
}

/** ASCIIHex (PDF /ASCIIHexDecode): hex pairs, whitespace ignored, ends at '>'. */
export function asciiHex(raw) {
  const s = Buffer.from(raw).toString('latin1');
  const hex = (s.split('>')[0] || '').replace(/[^0-9a-fA-F]/g, '');
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
}

function streams(buf) {
  const src = buf.toString('latin1');
  const out = [];
  let total = 0;
  const re = /\bstream\r?\n/g;
  let m;
  while ((m = re.exec(src)) && out.length < MAX_STREAMS) {
    const start = m.index + m[0].length;
    const objAt = src.lastIndexOf(' obj', m.index);
    const dict = objAt >= 0 ? src.slice(objAt, m.index) : '';
    const num = objAt >= 0 ? Number((/(\d+)\s+\d+$/.exec(src.slice(Math.max(0, objAt - 24), objAt)) || [])[1]) : NaN;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let end = len ? start + Number(len[1]) : -1;
    if (end < start || end > src.length || !/^\s*endstream/.test(src.slice(end, end + 20))) {
      end = src.indexOf('endstream', start);
      if (end < 0) break;
      while (end > start && (src[end - 1] === '\n' || src[end - 1] === '\r')) end -= 1;
    }
    re.lastIndex = end;
    if (/\/Subtype\s*\/Image|\/Type\s*\/(?:XRef|ObjStm|Metadata|EmbeddedFile)|\/FontFile|\/Length[123]\b/.test(dict)) continue;
    const raw = buf.subarray(start, end);
    let data = null;
    const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] || '';
    // ReportLab writes [/ASCII85Decode /FlateDecode]; the filters are
    // applied in the order the file lists them. Unknown filters skip the stream, as before.
    const chain = (filters.match(/\/\w+/g) || []).map((f) => f.slice(1));
    data = raw;
    for (const f of chain) {
      if (!data) break;
      if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
      else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
      else if (f === 'FlateDecode' || f === 'Fl') data = inflate(data);
      else data = null;
    }
    if (!data) continue;
    total += data.length;
    if (total > MAX_INFLATED_BYTES) break;
    out.push(Object.assign(data, { num }));
  }
  return out;
}

function hexBytes(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  return Buffer.from(clean.length % 2 ? `${clean}0` : clean, 'hex');
}

/** Merged ToUnicode maps (code hex → text). Fonts rarely clash, and a clash only garbles a glyph. */
function toUnicodeMaps(list) {
  const map = new Map();
  let width = 0;
  for (const data of list) {
    const text = data.toString('latin1');
    if (!text.includes('begincmap')) continue;
    const utf16 = (h) => {
      const b = hexBytes(h);
      let s = '';
      for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
      return s;
    };
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
        map.set(p[1].toLowerCase(), utf16(p[2]));
        width = Math.max(width, p[1].length / 2);
      }
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
        const lo = parseInt(p[1], 16);
        const hi = Math.min(parseInt(p[2], 16), lo + 0xffff);
        const digits = p[1].length;
        width = Math.max(width, digits / 2);
        if (p[3].startsWith('[')) {
          const items = [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
          items.forEach((s, i) => { if (lo + i <= hi) map.set((lo + i).toString(16).padStart(digits, '0'), s); });
        } else {
          const first = utf16(p[3].slice(1, -1));
          if (!first) continue;
          const head = first.slice(0, -1);
          const tail = first.charCodeAt(first.length - 1);
          for (let c = lo; c <= hi; c += 1) map.set(c.toString(16).padStart(digits, '0'), head + String.fromCharCode(tail + (c - lo)));
        }
      }
    }
  }
  return { map, width };
}

function decodeBytes(bytes, cmap) {
  if (cmap.map.size) {
    const w = cmap.width === 2 && bytes.length % 2 === 0 ? 2 : 1;
    let s = '';
    let hits = 0;
    for (let i = 0; i < bytes.length; i += w) {
      const key = bytes.subarray(i, i + w).toString('hex');
      const hit = cmap.map.get(key);
      if (hit !== undefined) { s += hit; hits += 1; } else s += w === 1 ? cp1252.decode(bytes.subarray(i, i + 1)) : '';
    }
    if (hits) return s;
  }
  return cp1252.decode(bytes);
}

/** Literal string starting at src[i] === '('; returns [bytes, next index]. */
function literal(src, i) {
  const bytes = [];
  let depth = 1;
  i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const n = src[i + 1];
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }[n];
      if (esc !== undefined) { bytes.push(esc); i += 2; continue; }
      if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4))[0];
        bytes.push(parseInt(oct, 8) & 0xff);
        i += 1 + oct.length;
        continue;
      }
      if (n === '\r' || n === '\n') { i += n === '\r' && src[i + 2] === '\n' ? 3 : 2; continue; }
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (!depth) return [Buffer.from(bytes), i + 1]; }
    bytes.push(src.charCodeAt(i) & 0xff);
    i += 1;
  }
  return [Buffer.from(bytes), i];
}

/** Text drawn by one content stream. */
function contentTextOnce(data, cmap, glyphRuns) {
  const src = data.toString('latin1');
  if (!/\bBT\b/.test(src) || !/T[jJ]|['"]/.test(src)) return '';
  let out = '';
  let operands = [];
  let i = 0;
  let fontSize = 0;
  let lastShown = 0;
  const pushText = (s) => { out += s; };
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  while (i < src.length && out.length < MAX_TEXT_CHARS) {
    const ch = src[i];
    if (ch === '%') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1; continue; }
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(') { const [b, next] = literal(src, i); operands.push({ str: b }); i = next; continue; }
    if (ch === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i);
      operands.push({ str: hexBytes(src.slice(i + 1, end < 0 ? src.length : end)) });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === '[') { operands.push({ open: true }); i += 1; continue; }
    if (ch === ']') {
      const at = operands.map((o) => Boolean(o.open)).lastIndexOf(true);
      const items = at >= 0 ? operands.slice(at + 1) : operands;
      operands = at >= 0 ? operands.slice(0, at) : [];
      operands.push({ arr: items });
      i += 1;
      continue;
    }
    const tok = /^(?:<<|>>|[^\s()<>[\]{}/%]+|\/[^\s()<>[\]{}/%]*|[{}])/.exec(src.slice(i, i + 256))?.[0] || src[i];
    i += tok.length;
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(tok)) { operands.push({ num: Number(tok) }); continue; }
    if (tok.startsWith('/') || tok === '<<' || tok === '>>') { operands.push({ name: tok }); continue; }
    switch (tok) {
      case 'Tf': { const n = operands.at(-1)?.num; if (typeof n === 'number') fontSize = Math.abs(n); break; }
      case 'Tj': { const s = operands.at(-1)?.str; if (s) { const t = decodeBytes(s, cmap); pushText(t); lastShown = t.length; } break; }
      case "'": case '"': { newline(); const s = operands.at(-1)?.str; if (s) pushText(decodeBytes(s, cmap)); break; }
      case 'TJ': {
        for (const item of operands.at(-1)?.arr || []) {
          if (item.str) { const t = decodeBytes(item.str, cmap); pushText(t); lastShown = t.length; }
          else if (typeof item.num === 'number' && item.num < -200 && !out.endsWith(' ')) pushText(' ');
        }
        break;
      }
      case 'Td': case 'TD': {
        const ty = operands.at(-1)?.num;
        const tx = operands.at(-2)?.num;
        // glyphRuns: a step no wider than the run just drawn (about one em per glyph) is the next
        // run of the same word, not a word gap.
        const nextGlyph = glyphRuns && lastShown > 0 && fontSize > 0 && typeof tx === 'number' && tx >= 0 && tx <= fontSize * Math.max(1, lastShown);
        if (ty) newline(); else if (out && !/\s$/.test(out) && !nextGlyph) pushText(' ');
        break;
      }
      case 'T*': case 'ET': case 'Tm': newline(); break;
      case 'ID': { const end = src.indexOf('EI', i); i = end < 0 ? src.length : end + 2; break; }
      default: break;
    }
    operands = [];
  }
  return out;
}

/**
 * Text drawn by one content stream. Chrome/Skia PDFs place each glyph (or short run) with its own
 * "advance 0 Td" and draw the spaces as glyphs, so a Td there is not a word gap ("D I S T R I B U T
 * I O N" before). Read both ways; when the glyph-run reading still has spaces between words (the file
 * draws its own), it is the right one.
 */
function contentText(data, cmap) {
  const plain = contentTextOnce(data, cmap, false);
  if (!/\d\s+0\s+Td\s*[<(]/.test(data.toString('latin1'))) return plain;
  const runs = contentTextOnce(data, cmap, true);
  const letters = (runs.match(/[\p{L}\p{N}]/gu) || []).length;
  const spaces = (runs.match(/ /g) || []).length;
  return letters && spaces / letters >= 0.05 ? runs : plain;
}

/**
 * Text of a PDF, one line per drawn line where the file makes that clear.
 * @throws code 'encrypted' (password-protected), 'malformed' (not a PDF), 'pdfNoText' (no text found)
 */
export function pdfToText(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.subarray(0, 1024).indexOf('%PDF') < 0) throw pdfError('malformed', 'This is not a readable PDF.');
  if (/\/Encrypt\b/.test(buf.toString('latin1'))) {
    throw pdfError('encrypted', 'The document is password-protected.');
  }
  const list = streams(buf);
  const cmap = toUnicodeMaps(list);
  const parts = [];
  let streamsWithText = 0;
  for (const data of list) {
    const text = contentText(data, cmap);
    if (text.trim()) { parts.push(text); streamsWithText += 1; }
  }
  // Owner real-world test, 8 Nov 2026: answers about a PDF cite pages. Pages are marked only when
  // each page has exactly one text stream (stream count = page count), so a page number is never a guess.
  const pageCount = (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  if (pageCount > 1 && streamsWithText === pageCount && list.length >= pageCount) {
    for (let i = 0; i < parts.length; i += 1) parts[i] = `[page ${i + 1}]\n${parts[i]}`;
  }
  const text = parts.join('\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const readable = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  if (!text || readable < 3 || /�/.test(text) && (text.match(/�/g) || []).length > readable) {
    throw pdfError('pdfNoText', 'Could not read the text of this PDF (it may be a scan, or its fonts hide the text). Nothing was sent off this PC.');
  }
  return text;
}

function cleanText(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Object number → its dictionary text (stream data skipped), for walking the page tree. */
function objectDicts(src) {
  const map = new Map();
  const re = /(?:^|[\s>\]])(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(src))) {
    const start = re.lastIndex;
    const endObj = src.indexOf('endobj', start);
    if (endObj < 0) break;
    const st = src.indexOf('stream', start);
    if (st >= 0 && st < endObj) {
      map.set(Number(m[1]), src.slice(start, st));
      const es = src.indexOf('endstream', st);
      const after = es < 0 ? -1 : src.indexOf('endobj', es);
      if (after < 0) break;
      re.lastIndex = after;
    } else {
      map.set(Number(m[1]), src.slice(start, endObj));
      re.lastIndex = endObj;
    }
  }
  return map;
}

const refsIn = (text) => [...String(text || '').matchAll(/(\d+)\s+\d+\s+R\b/g)].map((x) => Number(x[1]));

/**
 * Text of each page, in page order (index 0 = page 1), by walking the page tree to each page's
 * content streams. Null when the file hides its page tree (object streams) or most text sits
 * outside the page streams, so the caller can fall back to pdfToText and page markers.
 * @throws like pdfToText
 */
export function pdfPages(bytes) {
  const buf = Buffer.from(bytes);
  const full = pdfToText(buf);
  const src = buf.toString('latin1');
  const dicts = objectDicts(src);
  const list = streams(buf);
  const cmap = toUnicodeMaps(list);
  const data = new Map(list.filter((d) => Number.isFinite(d.num)).map((d) => [d.num, d]));
  let root = null;
  for (const d of dicts.values()) {
    if (/\/Type\s*\/Catalog\b/.test(d)) { root = Number((/\/Pages\s+(\d+)\s+\d+\s+R/.exec(d) || [])[1]); break; }
  }
  if (!Number.isFinite(root)) return null;
  const pages = [];
  const seen = new Set();
  const walk = (n, depth) => {
    if (depth > 32 || seen.has(n) || pages.length > 5000) return;
    seen.add(n);
    const d = dicts.get(n) || '';
    if (/\/Type\s*\/Pages\b/.test(d)) {
      for (const k of refsIn((/\/Kids\s*\[([^\]]*)\]/.exec(d) || [])[1])) walk(k, depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(d)) {
      const c = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(d)?.[1] || '';
      let refs = refsIn(c);
      if (!c.startsWith('[') && refs.length === 1 && !data.has(refs[0])) refs = refsIn((/^\s*\[([^\]]*)\]/.exec(dicts.get(refs[0]) || '') || [])[1]);
      pages.push(cleanText(refs.map((r) => (data.has(r) ? contentText(data.get(r), cmap) : '')).join('\n')));
    }
  };
  walk(root, 0);
  if (!pages.length) return null;
  const got = pages.reduce((n, p) => n + p.length, 0);
  if (got < full.length * 0.8) return null;
  return pages;
}
