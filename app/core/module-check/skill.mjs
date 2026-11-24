// Reading and checking a skill: a folder with SKILL.md (a small header naming it and saying when to use it, then the
// instructions, sometimes with scripts and other files beside it), or a single .md file.
// AP Desk keeps skills as text only and never runs anything that comes with one (modules/agents/skills.json).
import fs from 'node:fs';
import path from 'node:path';
import { listAll, firstHidden, stripHidden } from './files.mjs';
import { verifyFolder, SKILL_SIG_FILE } from './sig.mjs';
import { SKILL_LIMITS } from './desk-facts.mjs';

/** Split the header (--- key: value ... ---) from the text. */
export function parseSkill(text) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const head = {}; let body = src; let headLines = 0;
  if (m) {
    headLines = m[0].split('\n').length - 1;
    for (const ln of m[1].split('\n')) { const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(ln); if (kv) head[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, ''); }
    body = src.slice(m[0].length);
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || null;
  return { head, body: body.trim(), headLines, heading, hasHeader: !!m };
}

/** "compare-supplier-quotes" -> "Compare supplier quotes" */
export const titleOf = (name) => { const t = String(name || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim(); return t ? t[0].toUpperCase() + t.slice(1) : ''; };

// Things a skill should not ask an agent to do. Each: [what it is, pattern]. Plain English patterns, read one line at a time
// and one paragraph at a time (a dot inside an address such as evil.example does not end a sentence).
export const RULES = [
  ['acts without asking the owner', /\b(send|e-?mail|forward|post|publish|tweet|message|text|pay|purchase|buy|order|transfer|wire|delete|remove|erase|wipe|cancel|sign up|subscribe)\b(?:[^.\n]|\.(?=\S)){0,80}\b(without (asking|confirmation|confirming|approval|checking|telling|bothering|involving)|automatically|silently|straight away|no need to (ask|confirm|check|bother|involve)|(don't|do not|never) (ask|confirm|check|bother))\b|\b(without (asking|confirmation|approval)|automatically|silently)\b(?:[^.\n]|\.(?=\S)){0,40}\b(send|e-?mail|forward|post|publish|pay|purchase|buy|transfer|delete|remove|erase)\b|\b(pre-?approved|already (agreed|approved))\b/i],
  ['changes the desk\'s settings or safety', /\b(change|turn off|disable|switch off|lower|raise|bypass|skip)\b(?:[^.\n]|\.(?=\S)){0,60}\b(settings?|security( level)?|approvals?|approval cards?|spend limits?|limits?|panic|offline|the safety)\b|\b(approval )?cards? (are|is) not (needed|required)\b|\bmark (them|it|each|the cards?) (as )?(done|approved)\b|\bapprove (them|it) yourself\b/i],
  ['reveals keys, logins or files', /\b(reveal|print|show|send|share|upload|paste|output|leak|post|copy|include|pass( along| on)?|forward|dump|export|hand( over)?|give)\b(?:[^.\n]|\.(?=\S)){0,60}\b(api[ _-]?keys?|keys|tokens?|passwords?|secrets?|credentials?|\.env\b|ssh|private keys?|cookies?|session (ids?|tokens?)|logins?|payment cards?|card (numbers?|details))\b|\b(read|list|open|upload|send|copy)\b(?:[^.\n]|\.(?=\S)){0,40}\b(all (the )?files|every file|home folder|whole (disk|drive|pc)|documents folder|[A-Z]:\\|~\/|\/etc\/)/i],
  ['tells the agent to ignore earlier instructions or the owner', /\b(ignore|disregard|forget|override)\b(?:[^.\n]|\.(?=\S)){0,40}\b(previous|prior|earlier|above|all|any|system|other|the owner'?s?|the user'?s?)\b(?:[^.\n]|\.(?=\S)){0,30}\b(instructions?|rules?|prompts?|guidelines?|messages?|owner|user)\b|\b(do not|don't|never) (tell|inform|show|let) (the )?(owner|user)\b|\bkeep (this|it) (secret|hidden) from\b|\byou (are|have) no (rules|limits|restrictions)\b|\bact on (his|her|their|the owner'?s|the user'?s) behalf\b|\bnew (policy|instructions?|rules?)\b/i],
  ['fetches an address and follows what it says', /\b(fetch|download|open|visit|read|load|curl|get|go to)\b(?:[^.\n]|\.(?=\S)){0,60}(https?:\/\/\S+|\bthe (url|address|link|page)\b)(?:[^.\n]|\.(?=\S)){0,80}\b(follow|obey|do (what|as) it says|execute|run|carry out|apply) ?(the |its |any )?(instructions?|steps|commands?|it)?\b|https?:\/\/\S+(?:[^.\n]|\.(?=\S)){0,60}\binstructions?\b/i],
];
// a line spoken to the agent as if by the owner or the system ("Note to the assistant:", "SYSTEM:")
const ADDRESSED = /^\s*(?:[>*_#-]+\s*)*(?:\*\*)?(?:(?:a )?note (?:to|for) (?:the )?)?(?:assistant|system|ai|the model|model|the agent|agent|llm|chatbot|bot)(?:\*\*)?\s*(?:\*\*)?\s*[:,]/i;
const MD_COMMENT = /^\s*\[[^\]]*\]:\s*(?:#|<>)\s*[("']/;     // [//]: # (text the page never shows)
const LETTERS_OTHER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const OTHER_SCRIPT = /[Ͱ-ϿЀ-ԯ԰-֏Ⴀ-ჿᎠ-᏿]/;   // Greek, Cyrillic, Armenian, Georgian, Cherokee
const mixedWord = (ln) => ln.split(/[^\p{L}]+/u).find((w) => /[A-Za-z]/.test(w) && OTHER_SCRIPT.test(w)) || null;

/** Check a skill folder or .md file. -> { name, title, description, body, lines: [{ level, text }], red, yellow, files } */
export function checkSkill(target, { trusted = [] } = {}) {
  const abs = path.resolve(target);
  const isDir = fs.statSync(abs).isDirectory();
  const mdFile = isDir ? path.join(abs, 'SKILL.md') : abs;
  const lines = []; const say = (level, text) => lines.push({ level, text });
  if (!fs.existsSync(mdFile)) { say('red', isDir ? 'There is no SKILL.md in the folder.' : 'There is no such file.'); return finish({ lines }); }
  const raw = fs.readFileSync(mdFile, 'utf8');
  const sk = parseSkill(raw);
  const name = sk.head.name || (isDir ? path.basename(abs) : path.basename(abs, path.extname(abs)));
  const title = titleOf(sk.head.name || sk.heading || name);
  const description = sk.head.description || sk.body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
  if (!sk.hasHeader) say('yellow', 'There is no header (--- name: ... description: ... ---); the name comes from the ' + (sk.heading ? 'first heading.' : 'file name.'));
  if (!sk.head.description) say('yellow', 'The header says nothing about when to use it ("description"); the first line of the text is used.');
  say('info', `Name: ${title}. When to use it: ${description.slice(0, 200).replace(/[.\s]+$/, '') || 'not said'}.`);

  // the text, line by line (line numbers are those of SKILL.md); the header counts as text too. Hidden characters are
  // taken out before the words are read, so a soft hyphen inside a word does not hide it.
  const all = raw.replace(/\r\n/g, '\n').split('\n');
  const plain = all.map(stripHidden);
  const otherScript = [];
  plain.forEach((ln, i) => {
    const n = i + 1;
    for (const [what, re] of RULES) if (re.test(ln)) say('red', `Line ${n} ${what}: "${ln.trim().slice(0, 140)}"`);
    const hid = firstHidden(all[i]); if (hid && !(i === 0 && hid.code === 'FEFF')) say('red', `Line ${n} holds invisible characters (U+${hid.code}${/^E00/.test(hid.code) ? ', the invisible "tag" letters that can spell a whole hidden sentence' : ''}). The import takes them out; read the line again without them.`);
    const w = mixedWord(ln); if (w) say('red', `Line ${n} mixes letters from another alphabet into the word "${w}" (text that looks like one thing and reads as another).`);
    if (ADDRESSED.test(ln)) say('red', `Line ${n} speaks to the agent as if it were the owner or the system: "${ln.trim().slice(0, 140)}". A skill gives steps; it does not give the agent new rules.`);
    if (MD_COMMENT.test(ln)) say('red', `Line ${n} is a markdown comment, text a page never shows: "${ln.trim().slice(0, 140)}"`);
    if (LETTERS_OTHER.test(ln.replace(/[^\p{L}]/gu, ''))) otherScript.push(n);
    for (const e of ln.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) say('yellow', `Line ${n} names the e-mail address ${e[0]}. A skill rarely needs one: see what the line asks.`);
  });
  if (otherScript.length) say('yellow', `Line${otherScript.length > 1 ? 's' : ''} ${otherScript.slice(0, 12).join(', ')} ${otherScript.length > 1 ? 'are' : 'is'} written in another script. This check reads English words only: read ${otherScript.length > 1 ? 'those lines' : 'that line'} yourself, or have ${otherScript.length > 1 ? 'them' : 'it'} read to you.`);
  // the same rules over each paragraph with its line breaks joined, so a sentence split over lines is read whole
  const paras = []; let start = null;
  plain.forEach((ln, i) => { if (ln.trim()) { if (start == null) start = i; } else if (start != null) { paras.push([start, i - 1]); start = null; } });
  if (start != null) paras.push([start, plain.length - 1]);
  for (const [a, b] of paras) {
    if (a === b) continue;
    const joined = plain.slice(a, b + 1).map((l) => l.trim()).join(' ');
    for (const [what, re] of RULES) if (re.test(joined) && !plain.slice(a, b + 1).some((l) => re.test(l))) say('red', `Lines ${a + 1} to ${b + 1}, read together, ${what}: "${joined.slice(0, 160)}"`);
  }
  for (const c of raw.matchAll(/<!--([\s\S]*?)-->/g)) say('red', `Line ${raw.slice(0, c.index).split('\n').length} hides text in an HTML comment: "${c[1].trim().slice(0, 100)}"`);

  // files that came with it: never run, never imported
  const extra = isDir ? listAll(abs).filter((x) => x.kind !== 'dir' && x.rel !== 'SKILL.md' && x.rel !== SKILL_SIG_FILE) : [];
  for (const x of extra) {
    if (x.kind === 'link') { say('red', `${x.rel} is a link; it is left out.`); continue; }
    const base = x.rel.split('/').pop(); const top = x.rel.includes('/') ? x.rel.split('/')[0] + '/' : null;
    const mentions = all.map((ln, i) => [ln, i + 1]).filter(([ln]) => ln.includes(base) || (top && ln.includes(top))).map(([, n]) => n);
    say('yellow', `Left out: ${x.rel}. The desk does not run files that come with a skill.${mentions.length ? ` Line${mentions.length > 1 ? 's' : ''} ${mentions.join(', ')} mention${mentions.length > 1 ? '' : 's'} it; ${mentions.length > 1 ? 'those steps' : 'that step'} will not work as written.` : ''}`);
    for (const n of mentions) if (/\b(follow|obey|do (what|as) it says|carry out|execute|run|apply|use the (steps|instructions))\b/i.test(plain[n - 1])) say('red', `Line ${n} tells the agent to follow ${x.rel}, text this check did not read as part of the skill: "${plain[n - 1].trim().slice(0, 140)}"`);
    // a bundled text file is read with the same rules, though it is never imported
    if (/\.(md|txt|json|ya?ml|csv)$/i.test(x.rel) && x.size <= 256 * 1024) {
      fs.readFileSync(x.abs, 'utf8').split(/\r?\n/).map(stripHidden).forEach((ln, i) => { for (const [what, re] of RULES) if (re.test(ln)) say('red', `${x.rel} line ${i + 1} ${what}: "${ln.trim().slice(0, 140)}"`); });
    }
  }

  // size against the desk's limits for an owner's own skill
  const body = sk.body;
  if (title.length > SKILL_LIMITS.title) say('yellow', `The name has ${title.length} characters; the desk keeps ${SKILL_LIMITS.title}.`);
  if (description.length > SKILL_LIMITS.description) say('yellow', `"When to use it" has ${description.length} characters; the desk keeps ${SKILL_LIMITS.description}.`);
  if (body.length > SKILL_LIMITS.body) {
    const cutLine = sk.headLines + body.slice(0, SKILL_LIMITS.body).split('\n').length;
    say('yellow', `The text has ${body.length} characters; the desk keeps ${SKILL_LIMITS.body}. It will be cut on line ${cutLine}, after "…${body.slice(SKILL_LIMITS.body - 40, SKILL_LIMITS.body).replace(/\s+/g, ' ')}".`);
  } else say('ok', `Size: ${body.length} characters of text, inside the desk's limit of ${SKILL_LIMITS.body}.`);

  // signed?
  if (isDir) { const v = verifyFolder(abs, trusted, SKILL_SIG_FILE); say(v.state === 'signed' ? 'ok' : v.state === 'changed' ? 'red' : 'yellow', v.line); }
  else say('yellow', 'Not signed: a single file carries no signature. You are trusting this text as it is.');
  return finish({ name, title, description, body, lines, files: extra.map((x) => x.rel) });
}
function finish(r) { const c = { red: 0, yellow: 0 }; for (const l of r.lines) if (l.level in c) c[l.level]++; return { ...r, ...c }; }

/** The object the desk's "add a custom skill" route takes (POST /api/m/agents/skills): { title, body, description },
 *  with every hidden character taken out. */
export function deskSkill(r) {
  return { title: stripHidden(r.title).slice(0, SKILL_LIMITS.title), body: stripHidden(r.body).slice(0, SKILL_LIMITS.body), description: stripHidden(r.description).slice(0, SKILL_LIMITS.description) };
}
export const SKILL_LIMIT = 'What this check is: a list of English words and phrases, read line by line and paragraph by paragraph. It misses other languages, other wording, and instructions spread out over the text. Only you, reading the text, can judge it.';
export const SKILL_HONEST = 'A skill is text an agent reads and follows. This check reads that text for things a skill should not ask, hidden characters, comments and bundled files, and checks a signature if there is one. It cannot tell whether advice in the text is good, and words can be written to slip past it. Read the whole text yourself before you add it.';
export function printSkill(r, out = console.log) {
  const mark = { red: 'RED   ', yellow: 'YELLOW', ok: 'ok    ', info: '      ' };
  out(`Skill check: ${r.title || r.name || 'unknown'}`); out(''); out(SKILL_LIMIT); out('');
  for (const l of r.lines) out(`  ${mark[l.level]} ${l.text}`);
  out(''); out(r.red ? `Result: ${r.red} red line${r.red === 1 ? '' : 's'}, ${r.yellow} yellow. Do not add this skill as it is.` : `Result: no red line, ${r.yellow} yellow line${r.yellow === 1 ? '' : 's'}.`);
  out(''); out(SKILL_HONEST);
}
