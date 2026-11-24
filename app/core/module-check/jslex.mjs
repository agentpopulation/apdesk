// A small JavaScript reader for the checker. It is NOT a full parser: Node offers no parser for module code without a
// dependency. It walks the text once and separates code from comments, strings, template text and regular expressions,
// so the checker's rules look at real code (a word inside a comment or a string is not code) and at real strings
// (a URL or a table name inside a string is found). Syntax itself is checked separately with `node --check`.
//
// A slash after `}` or `)` can start a regular expression or mean division. The reader decides as JavaScript does in
// ordinary code: after the `}` of an object literal or the `)` of a call it is division; after the `}` of a block or the
// `)` of if, while, for or with it starts a regular expression. Because a wrong guess could hide code inside a "string",
// the checker also runs `node --check` on `code` itself : if Node cannot read the reader's version of
// the file, the file is refused. This makes a wrong guess very unlikely to pass, not impossible.
//
// Result: { code, strings, regexes, comments }
//   code     the source with every comment blanked and every string, template chunk and regex replaced by "S<n>" or "R<n>";
//            line breaks are kept, so a position in `code` has the same line number as in the file
//   strings  [{ value, line }] string literal values and template text chunks, in order (n in "S<n>")
//   regexes  [{ value, line }]
//   comments [{ value, line }]
//   templates [{ value, line }] each template literal whole, with every ${...} written as ?
const ID = /[A-Za-z0-9_$\u0080-￿]/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

export function lex(src) {
  const s = String(src);
  const strings = [], regexes = [], comments = [], templates = [];
  const tpl = [];               // the template literals being read, innermost last
  let out = '';
  let line = 1;
  let i = 0;
  const stack = [];            // template nesting: each entry is the brace depth at which a ${ ... } started
  let depth = 0;
  let prev = '';               // the last significant code token (for regex or division)
  const braces = [];           // for each open {: was it an object literal ('obj') or a block?
  const parens = [];           // for each open (: was it the ( of if / while / for / with?
  let lastBrace = 'block', lastParen = false;
  const nl = (t) => { for (const c of t) if (c === '\n') line++; };
  const keepLines = (t) => t.replace(/[^\n]/g, ' ');
  const regexAllowed = () => {
    if (!prev) return true;
    if (/^[A-Za-z_$][\w$]*$/.test(prev)) return REGEX_AFTER_WORD.has(prev);
    if (/^[0-9]/.test(prev)) return false;
    if (prev === '}') return lastBrace !== 'obj';
    if (prev === ')') return lastParen;
    return prev !== ']';
  };
  // a { starts an object literal where an expression is expected, otherwise a block
  const braceKind = () => {
    if (!prev || prev === '=>' || prev === ')' || prev === '{' || prev === '}' || prev === ';') return 'block';
    if (/^[A-Za-z_$][\w$]*$/.test(prev)) return REGEX_AFTER_WORD.has(prev) && prev !== 'else' && prev !== 'do' ? 'obj' : 'block';
    return /^[(,=:[?!~+\-*%&|^<>]$/.test(prev) ? 'obj' : 'block';
  };
  const readTemplate = () => {          // at a backtick or after the } that closes ${ }: read text up to ` or ${
    let v = ''; const at = line;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { v += s.slice(i, i + 2); nl(s.slice(i, i + 2)); i += 2; continue; }
      if (c === '`') { i++; strings.push({ value: v, line: at }); const t = tpl.pop(); t.value += v; templates.push(t); out += '"S' + (strings.length - 1) + '"' + (t.tagged ? ')' : '') + keepLines(v).replace(/ /g, ''); return 'end'; }
      if (c === '$' && s[i + 1] === '{') { i += 2; strings.push({ value: v, line: at }); tpl[tpl.length - 1].value += v + '?'; out += '"S' + (strings.length - 1) + '"+(' + keepLines(v).replace(/ /g, ''); stack.push(depth); depth++; prev = '('; return 'expr'; }
      if (c === '\n') line++;
      v += c; i++;
    }
    strings.push({ value: v, line: at }); out += '"S' + (strings.length - 1) + '"'; { const t = tpl.pop(); if (t) { t.value += v; templates.push(t); } } return 'end';
  };
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === '/' && n === '/') { const e = s.indexOf('\n', i); const t = e < 0 ? s.slice(i) : s.slice(i, e); comments.push({ value: t.slice(2), line }); out += keepLines(t); i += t.length; continue; }
    if (c === '/' && n === '*') { const e = s.indexOf('*/', i + 2); const t = e < 0 ? s.slice(i) : s.slice(i, e + 2); comments.push({ value: t.slice(2, -2), line }); out += keepLines(t); nl(t); i += t.length; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, v = '';
      while (j < s.length && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') { v += s.slice(j, j + 2); j += 2; } else { v += s[j]; j++; } }
      strings.push({ value: unescape(v), line }); out += '"S' + (strings.length - 1) + '"'; i = j + 1; prev = 'S'; continue;
    }
    if (c === '`') {
      // a template right after a name, ) or ] is a tagged template (a call): written as ( "S<n>" ) so Node can read it
      const tagged = !!prev && (prev === ')' || prev === ']' || (/^[A-Za-z_$][\w$]*$/.test(prev) && !REGEX_AFTER_WORD.has(prev)));
      i++; tpl.push({ value: '', line, tagged }); if (tagged) out += '('; const r = readTemplate(); if (r === 'end') prev = 'S'; continue;
    }
    if (c === '}' && stack.length && depth - 1 === stack[stack.length - 1]) { stack.pop(); depth--; out += ')+'; i++; const r = readTemplate(); if (r === 'end') prev = 'S'; continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, cls = false, v = '';
      while (j < s.length && s[j] !== '\n') { const d = s[j]; if (d === '\\') { v += s.slice(j, j + 2); j += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; v += d; j++; }
      if (s[j] === '/') { j++; while (j < s.length && /[a-z]/.test(s[j])) j++; regexes.push({ value: v, line }); out += 'R' + (regexes.length - 1); i = j; prev = 'R'; continue; }
    }
    if (c === '{') { depth++; braces.push(braceKind()); }
    if (c === '}') { depth--; lastBrace = braces.pop() || 'block'; }
    if (c === '(') parens.push(/^(if|while|for|with)$/.test(prev));
    if (c === ')') lastParen = parens.pop() || false;
    if (c === '>' && s[i - 1] === '=') { prev = '=>'; out += c; i++; continue; }
    if (c === '\n') line++;
    if (ID.test(c)) { let j = i; while (j < s.length && ID.test(s[j])) j++; prev = s.slice(i, j); out += prev; i = j; continue; }
    if (!/\s/.test(c)) prev = c;
    out += c; i++;
  }
  return { code: out, strings, regexes, comments, templates };
}

function unescape(v) {
  return v.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' })[e] ?? e;
  });
}

/** The line number of a position in `code`. */
export const lineAt = (code, pos) => { let n = 1; for (let k = 0; k < pos && k < code.length; k++) if (code[k] === '\n') n++; return n; };
/** The string value behind a placeholder "S<n>" (with or without the quotes), or null. */
export const strOf = (lexed, token) => { const m = /^"?S(\d+)"?$/.exec(String(token || '').trim()); return m ? lexed.strings[Number(m[1])]?.value ?? null : null; };
