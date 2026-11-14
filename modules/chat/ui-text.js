// Reply text the owner sees: no tool-call narration, no tool markup, no job lines the model wrote, no internal ids.
// Used by the server (stored replies) and the browser (streamed text). Plain ES module, no imports.

/** Internal ids (job_..., ap_..., lead_...) never reach the owner's screen. */
export function hideIds(t) {
  return String(t || '').replace(/\s*\(?\b(?:with |and )?(?:the )?(?:job |task |approval )?(?:id|ID)[:\s]+`?[a-z]{1,6}_[a-z0-9]{6,}`?\)?/g, '').replace(/`?\b(?:job|ap|lead|call|key|sec|draft|task|run)_[a-z0-9]{8,}\b`?/g, '').replace(/\s*\(\s*\)/g, '').replace(/\s*(?:“”|‘’|(?<!`)``(?!`))/g, '').replace(/\b(?:Check|Use|Note) the (?:job|task) ID\b[^.!?\n]*[.!?]?/gi, '').replace(/ {2,}/g, ' ').replace(/ ([.,])/g, '$1');
}

/** Strip what a model writes about tools instead of calling them, and job or card lines only real cards may show. */
const TOOL_JSON = /^\s*\{\s*"(?:tool|function)"\s*:|^\s*\{\s*"name"\s*:\s*"[\w.-]+"\s*,\s*"(?:arguments|parameters|args)"\s*:/;
/** Tool-call markup a model may write: <tool_call> blocks, <function=...> blocks, <|call|>-style blocks and stray <|token|> marks. */
const stripMarkup = (s) => s.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, '').replace(/<function[=\s][\s\S]*?(<\/function>|$)/gi, '').replace(/<\|?(?:tool_calls?|python_tag|call)\|?>[\s\S]*?(<\|?\/?(?:tool_calls?|eom|eot|call)\|?>|$)/gi, '');
const HARMONY = /<\|(?:start|channel|message|constrain|call|end|return)\|>[^\n]*/g;   // gpt-oss style tool-call lines
// a line that is a function call addressed to one of our tools ({"name": "web_search", "arguments": ...}, {"tool": "file_write", ...})
const TOOL_JSON_LINE = /^\s*\{\s*"(?:tool|function|name)"\s*:\s*"[a-z]+_[a-z_]+"\s*,\s*"(?:args|arguments|parameters|input)"\s*:.*\}\s*$/gm;
const FENCE_IDS = /\b(?:job|ap|lead|call|key|sec|draft|task|run)_(?=[a-z0-9]{0,11}\d)[a-z0-9]{12}\b/g;   // the desk's own ids (prefix + 12 base-36 characters)
export function cleanReply(t) {
  // fenced code blocks keep the code as the model wrote it; tool-call markup and the desk's ids are stripped even inside a fence
  const parts = String(t || '').split(/(```[\s\S]*?```)/);
  const out = parts.map((seg, i) => {
    if (i % 2) {
      if (TOOL_JSON.test(seg.replace(/^```[\w+-]*[^\n]*\n?/, ''))) return '';
      const open = seg.match(/^```[^\n]*\n?/)[0]; const body = seg.slice(open.length, -3);
      const b = stripMarkup(body.replace(HARMONY, '')).replace(TOOL_JSON_LINE, '').replace(FENCE_IDS, '');
      if (b === body) return seg;
      return b.trim() ? open + b.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') + (b.endsWith('\n') ? '' : '\n') + '```' : '';
    }
    let s = seg;
    s = stripMarkup(s.replace(HARMONY, ''));
    s = s.replace(/^\s*\{\s*"(?:tool|function)"\s*:\s*"[^"]+"[\s\S]*?\}\s*$/gm, '').replace(/^\s*\{\s*"name"\s*:\s*"[\w.-]+"\s*,\s*"(?:arguments|parameters|args)"\s*:[\s\S]*?\}\s*$/gm, '');
    s = s.replace(/\(?\s*I (?:called|used|ran|will call|am calling|'ll call) `?\w+`? with \{[\s\S]*?\}\s*\.?\s*\)?/gi, '');
    s = s.replace(/\(?\s*(?:Calling|Using) (?:the )?`?\w+_\w+`? (?:tool )?with \{[\s\S]*?\}\s*\.?\s*\)?/g, '');
    s = s.replace(/\[\s*(?:Job|Task|Table shown|Table|File|Draft(?: waiting for the owner)?|Report|Sources|Progress)\s*:[^\]\n]*\]/gi, '');
    return hideIds(s);
  });
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// A file name: a word with a dot and a 1 to 5 letter extension, no spaces; never a web address or a product name like Node.js.
const FILE_RE = /(?<![\w.@\/:\\-])[\w-]+(?:[\/\\][\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}\b(?![\/@])/g;
const KNOWN_EXT = new Set('html htm js mjs cjs ts tsx jsx css scss json jsonl py sh bat ps1 svg xml yaml yml sql md txt csv tsv pdf doc docx xls xlsx ppt pptx rtf odt ods ini cfg conf toml env log c h cpp hpp cs java kt go rs rb php pl r lua swift ipynb tex zip png jpg jpeg gif webp ico mp3 mp4 wav ics eml vcf'.split(' '));
const TLDS = new Set('com org net io co in ai dev app gov edu uk us de fr info biz me tv xyz cloud tech online site ca au eu jp cn ru nl es it ch se no'.split(' '));
const NOT_FILES = new Set(['node.js', 'vue.js', 'react.js', 'next.js', 'nuxt.js', 'express.js', 'three.js', 'd3.js', 'angular.js', 'ember.js', 'backbone.js', 'chart.js', 'asp.net', 'ado.net', 'vb.net', 'socket.io', 'e.g', 'i.e', 'a.m', 'p.m']);
const WORD_EXT = new Set('the and it is to in we you this that here now then so but if for with please next i a an my your our its they he she there what when how why'.split(' '));
/** File names mentioned in a piece of text (as written, with any folder), web addresses and product names left out. */
export function fileNames(text) {
  const out = [];
  for (const m of String(text || '').matchAll(FILE_RE)) {
    const name = m[0]; const low = name.toLowerCase(); const ext = low.split('.').pop(); const base = name.split(/[\\/]/).pop();
    if (NOT_FILES.has(base.toLowerCase())) continue;
    if (KNOWN_EXT.has(ext)) { out.push(name); continue; }
    if (TLDS.has(ext) || WORD_EXT.has(ext) || ext.length < 2) continue;                 // example.com, "done.the", "Ph.D"
    if (/[a-z]$/.test(base.split('.')[0]) && /^[A-Z][a-z]+$/.test(name.split('.').pop())) continue;   // "ready.Next": a missing space, not a file
    out.push(name);
  }
  return out;
}
const SAVED_RE = /\b(?:saved|updated|generated|created|attached|written|exported|stored|uploaded|wrote)\b|\bstatus\s*:\s*saved\b/i;
const straight = (t) => String(t).replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"');   // curly quotes read as straight ones
const baseOf = (p) => String(p).split(/[\\/]/).pop().toLowerCase();
/** File names a reply says were saved, generated, created or attached that nothing in this turn or job wrote. */
export function unwrittenFileClaims(text, writtenPaths = []) {
  const written = new Set([...writtenPaths].filter(Boolean).map(baseOf)); const out = [];
  for (const line of String(text || '').replace(/```[\s\S]*?```/g, ' ').split('\n')) for (const part of line.split(/(?<=[.!?])\s+|\s+·\s+/)) {
    if (!SAVED_RE.test(straight(part))) continue;
    for (const f of fileNames(part)) if (!written.has(baseOf(f)) && !out.includes(f)) out.push(f);
  }
  return out;
}
/** Fenced code blocks in a reply: [{ lang, code }]. */
export function codeBlocks(text) {
  return [...String(text || '').matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)].map(m => ({ lang: (m[1] || '').toLowerCase(), code: m[2].replace(/\s+$/, '') + '\n' })).filter(b => b.code.trim());
}
/** In text a model wrote: a sentence or line that says a named file was saved, updated, written, created, generated, exported or
 *  attached (active or passive) is removed when no write step in this turn or job wrote that file, whether or not an older file
 *  of that name exists. A sentence that only names a file ("the figures are in phones.xlsx") stays. Text the desk builds by code
 *  from its own records is never passed here. */
export function dropFileClaims(text, writtenPaths = []) {
  const written = new Set([...writtenPaths].filter(Boolean).map(baseOf));
  let removed = 0; let inCode = false;
  const lines = String(text || '').split('\n').map(line => {
    if (/^\s*```/.test(line)) { inCode = !inCode; return line; }
    if (inCode) return line;
    const parts = line.split(/(?<=[.!?])\s+|\s+·\s+/);
    const kept = parts.filter(part => {
      const files = fileNames(part);
      if (!files.length || !SAVED_RE.test(straight(part))) return true;
      if (files.every(f => written.has(baseOf(f)))) return true;
      removed++; return false;
    });
    const dropped = kept.length < parts.length;
    return (dropped ? kept.filter(p => !/^\s*status\s*:|saved to (?:the |your )?workspace/i.test(p)) : kept).join(' ');
  });
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (removed) out += (out ? '\n\n' : '') + (written.size ? 'Only the files shown as cards here were saved.' : 'No file was saved.');
  return { text: out, removed };
}

/** The tag under a reply: Stopped, Offline (the desk said it is offline: that reply finished), Did not finish, or none. */
export function footTag(m) {
  if (m?.status === 'stopped') return 'Stopped';
  if (m?.meta?.offline) return 'Offline';
  if (m?.status === 'error') return 'Did not finish';
  return null;
}
/** Why a step did not do its work, in plain words, from what the desk recorded. */
export function stepReason(st) {
  const r = st?.result?.refused;
  if (r === 'read pages first') return 'no page was read yet';
  if (r === 'binary file through the plain file tool') return 'plain text cannot make that kind of file';
  if (r) return String(r);
  if (st?.result?.skipped) return String(st.result.skipped);
  if (st?.status === 'stopped') return 'stopped';
  return st?.error ? String(st.error).replace(/\s+/g, ' ').trim().slice(0, 160) : 'it did not work';
}
export const TOOL_WORDS = { web_search: 'searched the web', web_read: 'read a page', research_deep: 'started deep research', research_swarm: 'started a swarm', browser_task: 'started a browser task', file_write: 'wrote a file', file_read: 'read a file', file_list: 'listed files', table_file: 'made a table file', doc_file: 'made a document', task_create: 'made a task', schedule_create: 'made a schedule', leads_find: 'looked for leads', outreach_draft: 'drafted outreach', memory_remember: 'remembered something', memory_recall: 'looked in memory', council_ask: 'asked the Council', agent_update: 'asked to change an agent' };
const BASE = { searched: 'search', read: 'read', started: 'start', wrote: 'write', listed: 'list', made: 'make', looked: 'look', drafted: 'draft', remembered: 'remember', asked: 'ask', used: 'use' };
/** Step chips by outcome: a done step says what was done; a refused, failed or stopped one says it was tried and what came of it.
 *  The same chip in a row is shown once with a count. replyStatus: the reply's own status (a step still "running" in a stopped reply was stopped). */
export function stepChips(steps, nameOf = (id) => id || '', replyStatus = 'done') {
  const out = [];
  for (const s of (steps || []).filter(x => x && x.tool)) {
    const words = TOOL_WORDS[s.tool] || 'used ' + s.tool.replace(/_/g, ' ');
    const status = s.status === 'running' && replyStatus !== 'streaming' ? 'stopped' : s.status;
    const tried = () => 'tried to ' + words.replace(/^(\w+)/, (w) => BASE[w] || w);
    const head = `${nameOf(s.agentId)} ` + (status === 'done' ? words : status === 'running' ? words.replace(/^(\w+)/, (w) => (BASE[w] || w).replace(/e$/, '') + 'ing') : tried());
    const tail = status === 'done' ? '' : status === 'running' ? '…' : status === 'refused' ? `: refused (${stepReason(s)})` : status === 'stopped' ? ': stopped' : status === 'skipped' ? ': not run again (already started)' : ': did not work';
    const last = out.at(-1);
    if (last && last.head === head && last.tail === tail) last.n++; else out.push({ head, tail, n: 1 });
  }
  return out.map(c => `${c.head}${c.n > 1 ? ` ${c.n} times` : ''}${c.tail}`);
}

/** Plain one-line preview of a reply for the chat list: no markdown marks. */
export function previewText(t) {
  return String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/^\s{0,3}#{1,6}\s*/gm, '').replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '').replace(/^\s*>\s?/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|\*|_|~~|`)(\S(?:[\s\S]*?\S)?)\1/g, '$2').replace(/\|/g, ' ').replace(/^\s*:?-{3,}:?\s*$/gm, '').replace(/\s+/g, ' ').trim();
}

/** Files made in a chat, one row per path, newest first. */
export function uniqueOutputs(messages) {
  const seen = new Set(); const out = [];
  for (const m of [...(messages || [])].reverse()) for (const c of [...(m.cards || [])].reverse()) {
    if (!(c && (c.kind === 'file' || (c.kind === 'report' && c.path)) && c.path)) continue;
    const k = String(c.path).toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    out.push({ ...c, by: m.agentId, at: m.updated || m.at });
  }
  return out;
}
