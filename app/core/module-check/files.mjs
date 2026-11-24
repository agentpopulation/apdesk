// Listing a folder for the checks: every entry with its kind, without following links.
import fs from 'node:fs';
import path from 'node:path';

/** Every file under dir (links and hidden entries included, so the checker can refuse them). Paths in `rel` use '/'. */
export function listAll(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) { out.push({ rel: r, abs, kind: 'link', size: 0 }); continue; }
      if (st.isDirectory()) { out.push({ rel: r, abs, kind: 'dir', size: 0 }); walk(abs, r); continue; }
      out.push({ rel: r, abs, kind: st.isFile() ? 'file' : 'other', size: st.size });
    }
  };
  walk(dir, '');
  return out;
}
export const listFiles = (dir) => listAll(dir).filter((x) => x.kind === 'file');

/** Copy a folder's plain files (no links) into a new folder that must not exist yet. */
export function copyFolder(from, to) {
  fs.mkdirSync(to, { recursive: false });
  for (const x of listAll(from)) {
    const target = path.join(to, ...x.rel.split('/'));
    if (x.kind === 'dir') fs.mkdirSync(target, { recursive: true });
    else if (x.kind === 'file') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(x.abs, target, fs.constants.COPYFILE_EXCL); }
  }
}

/** The desk's modules folder from the --desk path, for either kind of path (C:\apdesk or /home/me/apdesk). */
export function deskModulesDir(desk, p = path) {
  if (!desk) throw new Error('Say where the desk is: --desk <path to the AP Desk folder>.');
  return p.join(p.resolve(desk), 'modules');
}

/** Characters that show nothing or change the reading direction: every Unicode "format" character (zero-width marks,
 *  direction controls, soft hyphens, the invisible tag letters U+E0000 to U+E007F) and the blank letters that look like
 *  nothing (U+034F, U+115F, U+1160, U+3164, U+FFA0). A byte-order mark at the very start of a file is allowed. */
export const HIDDEN_CHARS = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/u;
const HIDDEN_ALL = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0]/gu;
/** The first hidden character in a text: { line, code } (code in hex), or null. */
export function firstHidden(text) {
  for (const k of String(text).matchAll(HIDDEN_ALL)) {
    if (k.index === 0 && k[0] === '\uFEFF') continue;
    return { line: text.slice(0, k.index).split('\n').length, code: k[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0') };
  }
  return null;
}
/** The text with every hidden character taken out (a byte-order mark at the start included). */
export const stripHidden = (text) => String(text).replace(HIDDEN_ALL, '');
