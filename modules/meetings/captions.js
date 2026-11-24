// Reading the words of a meeting from what the owner gives: pasted text, a plain text or Markdown file, or a caption file
// (.vtt, .srt). Caption readers drop cue numbers, time codes and styling, keep speaker names as written, as part of the
// line ("Name: words"), drop the repeated lines that rolling captions make, and join one speaker's cues into one line.
// A speaker name is never trusted or treated apart from the line: it is shown with it. No model is used here.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const entities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
  if (ENT[e.toLowerCase()] != null) return ENT[e.toLowerCase()];
  if (/^#x/i.test(e)) { const n = parseInt(e.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  if (/^#\d+$/.test(e)) { const n = Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return m;
});
const tidy = (s) => String(s ?? '').replace(/[ \t ]+/g, ' ').trim();
const TIME = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}([.,]\d{1,3})?/;

/** Text with Windows or old Mac line ends, a byte-order mark and stray control characters made plain. */
export function plainLines(raw) {
  return String(raw ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').split('\n');
}

/** "KIM:", ">> Kim Tan:", "[Kim]", "- Kim:" at the start of a caption line -> { speaker, words }. */
export function speakerOf(line) {
  const s = tidy(line).replace(/^(>>|-|–|—)\s*/, '');
  let m = s.match(/^\[([^\]]{1,40})\]\s*:?\s*(.*)$/);
  if (m && !/^\d/.test(m[1]) && !/^(music|applause|laughter|inaudible|crosstalk|silence|noise)$/i.test(m[1])) return { speaker: tidy(m[1]), words: m[2] };
  m = s.match(/^([A-Za-zÀ-ɏ][\wÀ-ɏ.'’ -]{0,38}?)\s*:\s+(.+)$/);
  if (m && m[1].split(/\s+/).length <= 4 && !/^(https?|note|re|fw|fwd)$/i.test(m[1])) return { speaker: tidy(m[1]), words: m[2] };
  return { speaker: null, words: s };
}

/** Join cues into lines: one line per turn of a speaker, repeated rolling lines dropped. */
function joinCues(cues) {
  const out = []; let last = null; let lastWords = '';
  for (const c of cues) {
    const words = tidy(c.words); if (!words) continue;
    if (words === lastWords) continue;                                  // a rolling caption repeats its line
    if (lastWords && words.startsWith(lastWords) && (c.speaker || null) === (last?.speaker || null)) {   // a rolling caption grows its line
      last.words = tidy(last.words.slice(0, last.words.length - lastWords.length) + ' ' + words); lastWords = words; continue;
    }
    lastWords = words;
    const speaker = c.speaker || (c.continues && last ? last.speaker : null);
    if (last && speaker && speaker === last.speaker && last.words.length + words.length < 600) { last.words += ' ' + words; continue; }
    if (last && !speaker && !last.speaker && last.words.length + words.length < 300 && !/[.?!]$/.test(last.words)) { last.words += ' ' + words; continue; }
    last = { speaker, words }; out.push(last);
  }
  return out.map(c => (c.speaker ? `${c.speaker}: ${c.words}` : c.words));
}

/** WebVTT: header, NOTE, STYLE and REGION blocks, cue ids, time lines and tags out; <v Name> kept as "Name: ". */
export function readVtt(raw) {
  const lines = plainLines(raw); const cues = []; let i = 0; let skipBlock = false; let inCue = false; let speaker = null;
  if (/^WEBVTT/.test(lines[0] || '')) { i = 1; while (i < lines.length && lines[i].trim()) i++; }
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { skipBlock = false; inCue = false; speaker = null; continue; }
    if (skipBlock) continue;
    if (!inCue && /^(NOTE|STYLE|REGION)(\s|$)/.test(l)) { skipBlock = true; continue; }
    if (TIME.test(l)) { inCue = true; continue; }
    if (!inCue) continue;                                                   // a cue id line before the time line
    let text = l; let sp = null;
    const v = text.match(/<v(?:\.[\w.-]+)?\s+([^>]+)>/i);
    if (v) { sp = tidy(entities(v[1])); speaker = sp; }
    text = entities(text.replace(/<\d{1,2}:\d{2}(:\d{2})?[.,]\d{1,3}>/g, '').replace(/<\/?[^>]*>/g, ''));
    const s = sp ? { speaker: sp, words: text } : speakerOf(text);
    cues.push({ speaker: s.speaker || speaker, words: s.words, continues: !s.speaker && !!speaker });
  }
  return joinCues(cues);
}

/** SubRip: numbers and time lines out; <i>, <b>, <font> and {\an8} out. */
export function readSrt(raw) {
  const lines = plainLines(raw); const cues = []; let inCue = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { inCue = false; continue; }
    if (TIME.test(l)) { inCue = true; continue; }
    if (!inCue) { if (/^\d+$/.test(l.trim())) continue; inCue = true; }       // a file without numbers still reads
    const text = entities(l.replace(/\{\\[^}]*\}/g, '').replace(/<\/?[^>]*>/g, ''));
    cues.push(speakerOf(text));
  }
  return joinCues(cues);
}

/** Markdown: headings, list marks, emphasis and links made plain; the words stay. */
export function readMd(raw) {
  return plainLines(raw).map(l => tidy(l
    .replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, '').replace(/^\s*([-*+•]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_]/g, '$1$2').replace(/`([^`]+)`/g, '$1')))
    .filter(l => l && !/^(-{3,}|\*{3,}|_{3,}|\|?[\s:|-]+\|?)$/.test(l));
}

export function readPlain(raw) { return plainLines(raw).map(tidy).filter(Boolean); }

export const KINDS = { txt: 'plain text', text: 'plain text', md: 'Markdown', markdown: 'Markdown', vtt: 'captions (WebVTT)', srt: 'captions (SubRip)' };

/** What kind a file is, by its name, else by its first lines. */
export function kindOf(name, raw) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (ext && KINDS[ext]) return ext === 'text' ? 'txt' : ext === 'markdown' ? 'md' : ext;
  const head = String(raw || '').replace(/^﻿/, '').slice(0, 400);
  if (/^WEBVTT/.test(head)) return 'vtt';
  if (/^\s*\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return 'srt';
  return ext ? null : 'txt';
}

/** read(name, raw) -> { kind, kindText, lines, text, speakers } or throws a plain sentence for a file it cannot read. */
export function read(name, raw) {
  const kind = kindOf(name, raw);
  if (!kind) throw Object.assign(new Error('That kind of file cannot be read here. Use plain text, Markdown, or captions (.vtt, .srt).'), { status: 400 });
  if (/\u0000/.test(String(raw).slice(0, 2000))) throw Object.assign(new Error('That file is not text. Use plain text, Markdown, or captions (.vtt, .srt).'), { status: 400 });
  const lines = kind === 'vtt' ? readVtt(raw) : kind === 'srt' ? readSrt(raw) : kind === 'md' ? readMd(raw) : readPlain(raw);
  const speakers = [...new Set(lines.map(l => speakerOf(l).speaker).filter(Boolean))];
  return { kind, kindText: KINDS[kind], lines, text: lines.join('\n'), speakers };
}
