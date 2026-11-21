// Packs: the gzipped CSV lists from the public AgentPopulation repositories, searched here on this PC.
// Every field comes from the pack. A field the pack leaves empty is "not checked"; nothing is filled in.
// Pack text is untrusted data: it is shown as plain text and never followed.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

export const NC = 'not checked';
export const CREDIT = 'List © 2026 AgentPopulation, CC BY 4.0, agentpopulation.com';
export const TERMS = 'The terms of each API were not reviewed.';

const STOP = new Set('a an and any about api apis are as at be data do for from get give i in into is it me my need needs of on or our please show some that the this to want what which with you your find build app agent'.split(' '));

/** One CSV line into fields ("" is a quote inside a quoted field). */
export function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const openQuote = (s) => { let n = 0; for (const c of s) if (c === '"') n++; return n % 2 === 1; };
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);

/** The words of a need, lower case, without filler words; a plural "s" is dropped so "levels" finds "level". */
export function needWords(q) {
  const ws = String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2 && !STOP.has(w)).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return [...new Set(ws)].slice(0, 12);
}

/** What the screen and the agents see for one pack row. */
export function rowOut(r, pack) {
  const tags = clean(r.tags, 400).split('|').map(t => t.trim()).filter(Boolean);
  const day = clean(r.last_tested, 10);
  return {
    url: clean(r.url, 2000), title: clean(r.title, 300) || NC, service: clean(r.service, 200) || NC, host: clean(r.host, 253) || NC,
    country: clean(r.country, 8) || NC, category: clean(r.category, 80) || NC, format: clean(r.format, 20) || NC,
    key: tags.includes('no-key') ? 'No key' : NC, lastTested: /^\d{4}-\d\d-\d\d$/.test(day) ? day : null, tags: tags.slice(0, 12),
    pack, credit: CREDIT, terms: TERMS,
  };
}

function score(r, words) {
  let total = 0;
  for (const w of words) {
    let s = 0;
    if (r.title.toLowerCase().includes(w)) s += 3;
    if (r.tags.toLowerCase().includes(w)) s += 2;
    if ((r.category + ' ' + r.subcategory).toLowerCase().includes(w)) s += 2;
    if (r.service.toLowerCase().includes(w)) s += 2;
    if (r.host.toLowerCase().includes(w)) s += 1;
    if (w.length === 2 && r.country.toLowerCase() === w) s += 2;
    if (!s) return 0;                 // every word of the need must be found somewhere
    total += s;
  }
  return total;
}

/** Read a pack row by row. onRow(row) returns true to stop early. */
export async function eachRow(file, onRow, { signal } = {}) {
  const stopped = () => Object.assign(new Error('Stopped'), { code: 'aborted' });
  if (signal?.aborted) throw stopped();
  const raw = fs.createReadStream(file); const input = raw.pipe(zlib.createGunzip());
  raw.on('error', (e) => input.destroy(e));
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let head = null; let buf = ''; let n = 0;
  try {
    for await (const line of rl) {
      if (signal?.aborted) throw stopped();
      buf = buf ? buf + '\n' + line : line;
      if (openQuote(buf)) { if (buf.length < 20000) continue; buf = ''; continue; }   // a quoted field spans lines; a runaway one is dropped
      const f = parseCsvLine(buf); buf = '';
      if (!head) { head = f.map(x => x.trim().toLowerCase().replace(/^﻿/, '')); continue; }
      const r = {}; head.forEach((k, i) => { r[k] = f[i] ?? ''; });
      for (const k of ['url', 'title', 'service', 'host', 'country', 'category', 'subcategory', 'format', 'tags', 'last_tested']) r[k] = String(r[k] ?? '');
      n++;
      if (onRow(r)) break;
    }
  } finally { rl.close(); input.destroy(); raw.destroy(); }
  return n;
}

/** Search one pack for a need. Filters: country (two letters), format. Best matches first, then the most recently tested. */
export async function searchPack(file, q, { pack, limit = 50, country = '', format = '', signal } = {}) {
  const words = needWords(q); const cc = String(country || '').trim().toUpperCase(); const fm = String(format || '').trim().toLowerCase();
  let hits = [];
  const trim = () => { hits.sort((a, b) => b.s - a.s || b.r.last_tested.localeCompare(a.r.last_tested)); hits.length = Math.min(hits.length, limit); };
  const scanned = await eachRow(file, (r) => {
    if (cc && r.country.toUpperCase() !== cc) return false;
    if (fm && r.format.toLowerCase() !== fm) return false;
    const s = words.length ? score(r, words) : 1;
    if (!s) return false;
    hits.push({ s, r });
    if (hits.length > limit * 4) trim();
    return !words.length && hits.length >= limit;
  }, { signal });
  trim();
  return { scanned, rows: hits.map(h => rowOut(h.r, pack)), score: hits.map(h => h.s) };
}

/** The pack row for one exact address, or null. */
export async function findRow(file, url, { pack, signal } = {}) {
  let hit = null;
  await eachRow(file, (r) => { if (r.url === url) { hit = r; return true; } return false; }, { signal });
  return hit ? rowOut(hit, pack) : null;
}

/** Topics that fit a need, best first (from the pack titles and blurbs only). */
export function suggestPacks(q, packs, n = 4) {
  const words = needWords(q); if (!words.length) return [];
  return packs.map(p => {
    const text = `${p.title} ${p.short} ${p.blurb} ${p.forBuilders}`.toLowerCase();
    return { p, s: words.reduce((a, w) => a + (text.includes(w) ? 1 : 0), 0) };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.p.bytes - b.p.bytes).slice(0, n).map(x => x.p);
}
