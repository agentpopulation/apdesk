// The genuineness check for an AP Desk module folder: ONE copy, used by the desk's Module Store (modules/store) and by
// the module kit's tools/check-module.mjs (the kit's copy of this folder is made from this one: see README.md here).
// Plain ESM, no dependencies. Four parts: Shape, What it can do (the label), Signed by, Runs clean.
// It only READS the module's files: it never loads the module's code. It asks Node to parse each file (node --check,
// in a separate process, which does not run it). "Runs clean" runs code only when the caller hands in a runner (the
// kit's locked-down sandbox); the desk never does. It cannot prove that code is harmless; HONEST says so.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { builtinModules } from 'node:module';
import { spawn } from 'node:child_process';
import { lex, lineAt } from './jslex.mjs';
import { listAll, firstHidden } from './files.mjs';
import { unzipTo } from './zip.mjs';
import { verifyFolder, loadKeys, hashFolder, SIG_FILE } from './sig.mjs';
import { DESK_MODULES, DESK_NUMBERS, DESK_VERSION, OFFICIAL_PLACES } from './desk-facts.mjs';

export const LIMITS = { file: 256 * 1024, total: 1024 * 1024, line: 1000, depth: 8 };
const KINDS = new Set(['.js', '.mjs', '.json', '.md', '.css', '.svg', '.png']);
const FORBIDDEN = new Set(['child_process', 'worker_threads', 'net', 'dgram', 'tls', 'http', 'https', 'http2', 'vm', 'cluster', 'inspector', 'repl', 'v8', 'wasi', 'trace_events', 'dns']);
const FORBIDDEN_WHY = { sqlite: 'opens a database of its own outside ctx.db (it could open the desk\'s own file)', module: 'can load code around the module\'s imports', os: 'reads the PC\'s user, folders and network names', process: 'reaches the whole desk\'s process', timers: 'sets timers the checker cannot follow (use the plain setTimeout and setInterval, and clear them on deactivate)' };
const CTX = new Set(['id', 'manifest', 'dir', 'port', 'route', 'json', 'readBody', 'db', 'kv', 'workspace', 'workspacePath', 'dataDir', 'backupsDir', 'root', 'deskDataDir', 'houseBackupsDir', 'model', 'approval', 'jobs', 'panic', 'events', 'agents', 'settings', 'secrets', 'serviceKey', 'services', 'serviceKeyRefused', 'tool', 'untool', 'expose', 'chatCard', 'modules', 'log', 'activity', 'requestRestart', 'fetch', 'incognito', 'plainFailure']);
const CORE_TABLES = new Set(['secrets', 'settings', 'approvals', 'activity', 'kv', 'migrations', 'modules']);
const CORE_READ = new Set(['agents', 'jobs', 'calls']);
const RESERVED_EVENTS = new Set(['panic', 'security', 'approval', 'modules', 'settings', 'agents', 'job', 'restart']);
const BUILTIN_OBJECTS = 'Object|Array|String|Number|Boolean|Function|Promise|JSON|Math|Date|RegExp|Map|Set|WeakMap|WeakSet|Error|Symbol|BigInt|Reflect|Proxy|Intl|Atomics|console|process|globalThis|global|window|self|document|navigator|URL|Buffer|crypto';
const PROCESS_OK = new Set(['env', 'argv', 'execPath', 'stdout', 'stderr', 'platform', 'arch', 'version', 'versions', 'release', 'nextTick', 'hrtime', 'uptime', 'memoryUsage', 'cpuUsage', 'pid', 'cwd', 'emitWarning']);
const PROCESS_RED = new Set(['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule', 'reallyExit', '_rawDebug', 'exit', 'kill', 'abort', 'chdir', 'setuid', 'setgid', 'umask', 'exitCode']);
const GLOBAL_OK = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'crypto']);
const LOOP = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
const FS_CALLS = 'readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream|createReadStream|readdir|readdirSync|stat|statSync|lstat|lstatSync|open|openSync|symlink|symlinkSync|link|linkSync|chmod|chmodSync|existsSync|access|accessSync|truncate|truncateSync|realpath|realpathSync|watch|watchFile|opendir|opendirSync|mkdtemp|mkdtempSync|glob|globSync';
const OWN_ROOT = /^ctx\s*\.\s*(dir|dataDir|workspace)$/;
const HOST_RE = /\b(?:https?|wss?):\/\/(\[[0-9a-fA-F:.]+\]|localhost\b|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)/g;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const HONEST = [
  'A module, once added, runs inside the desk with the desk\'s own powers: your files, your keys, the network.',
  'This check reads the files and compares them with what the module says it does and with its signature. With --run it also',
  'starts the module once, and runs its tests, in a separate Node process that may read only a copy of the module and write',
  'only in a temp folder, with no programs, no workers and the network refused. It cannot prove that code is harmless: names',
  'built at run time, code that waits until it is in the real desk, and code that finds a way round those locks can all pass.',
  'A signature proves only that the files are unchanged since that key signed them. Add a module only from someone you would',
  'run a program from.',
].join('\n');
/** The same paragraph as the desk's Module Store shows it: the desk reads the files and never runs them to check. */
export const HONEST_DESK = [
  'A module, once added, runs inside the desk with the desk\'s own powers: your files, your keys, the network.',
  'This check reads the files and compares them with what the module says it does and with its signature. It does not run',
  'the module\'s code. It cannot prove that code is harmless: names built at run time, code that waits until it is in the',
  'real desk, and code that finds a way round the checks can all pass. It reads each file on its own and does not follow a',
  'value from one place to another. It refuses the uses of process, Function, globalThis, fetch or node:fs that it can see but',
  'cannot follow, and any import of the parts of Node that start programs or open connections; a member reached by a name held in a',
  'variable (x[name]) can still hide one of these, including code that starts a program. A signature proves only that the files are unchanged',
  'since that key signed them. Add a module only from someone you would run a program from.',
].join(' ');
const NOT_RUN = 'Not run. Add --run to start it once and run its tests, in a separate Node process that may read only a copy of the module and write only in a temp folder, with no programs, no workers and the network refused. Read the label above first: code that finds a way round those locks could still do harm on this PC.';

const entropy = (s) => { const f = new Map(); for (const c of s) f.set(c, (f.get(c) || 0) + 1); let e = 0; for (const n of f.values()) { const p = n / s.length; e -= p * Math.log2(p); } return e; };
const isBrowserFile = (rel) => !/\.test\.m?js$/.test(rel) && (rel === 'ui.js' || /^ui[\w.-]*\.m?js$/.test(rel) || rel.startsWith('ui/'));
const isTestFile = (rel) => /\.test\.m?js$/.test(rel);
const tablePrefix = (id) => 'm_' + String(id).replace(/-/g, '_') + '_';
/** Does Node read this text as module code? `node --check` parses it in a separate process and runs nothing.
 *  Asynchronous, so a desk that checks a module keeps answering meanwhile. -> { status, stderr } */
const nodeReads = (src) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['--input-type=module', '--check'], { stdio: ['pipe', 'ignore', 'pipe'], env: {} });
  let stderr = ''; p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
  p.on('error', (e) => resolve({ status: 1, stderr: String(e.message) }));
  p.on('close', (status) => resolve({ status, stderr }));
  p.stdin.on('error', () => {}); p.stdin.end(src);
});

/** The arguments of a call whose "(" is at `open` in code, split at top-level commas. */
function argsAt(code, open) {
  const out = []; let depth = 0, cur = '';
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) { out.push(cur.trim()); return out; } depth--; }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim()); return out;
}

/**
 * Check a module folder. Returns { id, manifest, sections: [{ title, lines: [{ level, text }] }], red, yellow, doors, hashes, label }.
 * Options:
 *   trusted      public keys to trust ([{ id, publicKey }]); or `keys`, a file that holds them (the kit's --key)
 *   deskModules  ids the desk already has (refused as an id, a menu place or a wanted module); deskNumbers likewise
 *   deskVersion  the desk version named in the lines
 *   testhost     the sha256 (hex) of the kit's samples/hello-notes/testhost.js: a copy that matches is skipped
 *   runner       (dir, id) => { lines, doors, tests: { pass, fail, skipped, files } } : the kit's locked-down run.
 *                With no runner nothing runs; notRun is the line that says so.
 */
export async function checkModule(dir, { keys = null, trusted = null, runner = null, notRun = NOT_RUN, deskModules = DESK_MODULES, deskNumbers = DESK_NUMBERS, deskVersion = DESK_VERSION, testhost = null } = {}) {
  const sections = []; let cur = null;
  const section = (title) => { cur = { title, lines: [] }; sections.push(cur); };
  const say = (level, text) => cur.lines.push({ level, text });
  const red = (t) => say('red', t), yellow = (t) => say('yellow', t), ok = (t) => say('ok', t), info = (t) => say('info', t);
  // every file's hash, taken first: add-module copies only files that still match these
  const hashes = hashFolder(dir, '');

  // ---------------- 1. Shape
  section('Shape');
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')); ok('module.json reads as JSON.'); }
  catch (e) { red(fs.existsSync(path.join(dir, 'module.json')) ? `module.json is not valid JSON: ${e.message}` : 'There is no module.json in the folder.'); }
  const id = m?.id;
  if (m) {
    for (const f of ['id', 'number', 'name', 'description', 'kind', 'status']) if (m[f] == null || m[f] === '') red(`module.json has no "${f}".`);
    if (id != null && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(id))) red(`The id "${id}" must be lower-case letters, digits and single dashes.`);
    if (id && path.basename(dir) !== id && !dir.includes(`${path.sep}apd-check-`)) red(`The folder is called "${path.basename(dir)}" but the id is "${id}"; they must match.`);
    if (id && deskModules.includes(id)) red(`The id "${id}" is already a module of the desk.`);
    if (m.number != null && (!Number.isInteger(m.number) || m.number < 1 || m.number > 999)) red('"number" must be a whole number from 1 to 999.');
    else if (deskNumbers.includes(m.number)) red(`The number ${m.number} is already used by a module of the desk (used: ${deskNumbers.join(', ')}).`);
    if (m.kind === 'core') red('An added module cannot be "core": the owner could not switch it off. Use "switch-on".');
    else if (m.kind && m.kind !== 'switch-on') red(`"kind" must be "switch-on" for an added module, not "${m.kind}".`);
    if (m.defaultOn === true) yellow('It asks to be on from the first run ("defaultOn": true). An added module should wait for the owner\'s switch.');
    if (m.status && !['works', 'partial', 'stub'].includes(m.status)) red(`"status" is works, partial or stub, not "${m.status}".`);
    if (typeof m.description === 'string' && (m.description.length < 30 || m.description.length > 400)) yellow(`The description has ${m.description.length} characters; 30 to 400 read well in the Module Store.`);
    for (const it of Array.isArray(m.menu) ? m.menu : m.menu == null ? [] : (red('"menu" must be a list.'), [])) {
      if (OFFICIAL_PLACES.includes(it?.id)) red(`The menu place "${it.id}" is one of the official places; a module adds its own place and never takes one.`);
      else if (deskModules.includes(it?.id)) red(`The menu place "${it.id}" belongs to a module of the desk.`);
      if (typeof it?.label !== 'string' || !it.label || it.label.length > 24) yellow(`The menu label "${typeof it?.label === 'string' ? it.label.slice(0, 40) : ''}" should be 1 to 24 characters of text.`);
      if (!(m.pages || []).includes(it?.id)) yellow(`The menu place "${it?.id}" is not listed in "pages", so it would open "not part of the desk".`);
    }
    if (m.tools != null && !Array.isArray(m.tools)) red('"tools" must be a list of tool names.');
    else for (const t of m.tools || []) if (typeof t !== 'string') red('"tools" must list tool names as text, such as "notes_add"; one entry is not a name.');
    else if (!/^[A-Za-z0-9_]{1,64}$/.test(t)) red(`The tool name "${t.slice(0, 80)}" may use letters, digits and underscores only.`);
    for (const f of ['requires', 'pages']) if (m[f] != null && (!Array.isArray(m[f]) || m[f].some((x) => typeof x !== 'string'))) red(`"${f}" must be a list of names.`);
    if (m.npm && Object.keys(m.npm).length) yellow(`It needs npm packages: ${Object.keys(m.npm).join(', ')}. This kit installs nothing; the desk must already have them.`);
    for (const r of Array.isArray(m.requires) ? m.requires.filter((x) => typeof x === 'string') : []) if (!deskModules.includes(r)) yellow(`It needs the module "${r}", which is not part of the desk ${deskVersion}.`);
    if (m.hosts != null && (!Array.isArray(m.hosts) || m.hosts.some((h) => typeof h !== 'string' || !h))) red('"hosts" must be a list of host names (or ["*"] for addresses the owner types in).');
    if (m.commands) info(`It lists chat commands: ${(Array.isArray(m.commands) ? m.commands : []).map((c) => '/' + String(c?.name || '').slice(0, 24)).join(', ') || 'none it could read'}. The owner runs one by typing it at the start of a message in Chat, while the module is on.`);
  }
  const all = listAll(dir); let total = 0; let deep = 0;
  for (const x of all) {
    const base = x.rel.split('/').pop();
    const nest = x.rel.split('/').length - (x.kind === 'dir' ? 0 : 1);
    if (nest > LIMITS.depth) { if (!deep++) red(`${x.rel.slice(0, 80)}...: folders nested ${nest} deep; at most ${LIMITS.depth}. (A long path can also stop the copy into the desk on Windows.)`); continue; }
    if (x.rel.split('/').includes('node_modules')) { red(`It holds a node_modules folder (${x.rel}). Packages are never shipped inside a module.`); continue; }
    if (x.kind === 'link') { red(`${x.rel} is a link. Links are refused: they can point anywhere on the PC.`); continue; }
    if (base.startsWith('.')) { red(`${x.rel} is a hidden file or folder.`); continue; }
    if (x.kind === 'other') { red(`${x.rel} is not a plain file.`); continue; }
    if (x.kind !== 'file') continue;
    const ext = path.extname(base).toLowerCase();
    if (!KINDS.has(ext)) { red(`${x.rel}: a module may hold only js, mjs, json, md, css, svg and png files.`); continue; }
    total += x.size;
    if (x.size > LIMITS.file) red(`${x.rel} is ${Math.round(x.size / 1024)} KB; the limit is ${LIMITS.file / 1024} KB a file.`);
    if (ext === '.png') { if (!fs.readFileSync(x.abs).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) red(`${x.rel} says it is a picture but is not a PNG file.`); continue; }
    const text = fs.readFileSync(x.abs, 'utf8');
    const hid = firstHidden(text); if (hid) red(`${x.rel} holds invisible or direction-changing characters (line ${hid.line}, U+${hid.code}). They can make text read differently from how it runs.`);
    const code = ext === '.js' || ext === '.mjs' || ext === '.css';
    text.split('\n').forEach((ln, i) => {
      if (ln.length > LIMITS.line) (code ? red : yellow)(`${x.rel} line ${i + 1} is ${ln.length} characters long: packed or minified code cannot be read and is ${code ? 'refused' : 'worth a look'}.`);
      else if (code && ln.length > 200 && entropy(ln) > 5.3) red(`${x.rel} line ${i + 1} looks packed (high-entropy text).`);
    });
    if (code) {
      const b64 = text.match(/[A-Za-z0-9+/]{300,}={0,2}/); if (b64) red(`${x.rel} holds a long base64 string (${b64[0].length} characters, line ${text.slice(0, b64.index).split('\n').length}).`);
      const hex = text.match(/(?:[0-9a-fA-F]{2}){100,}/); if (hex) red(`${x.rel} holds a long hex string (${hex[0].length} characters).`);
      const esc = (text.match(/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}/g) || []).length; if (esc > 40) red(`${x.rel} holds ${esc} escaped characters: a common way to hide code.`);
    }
    if (ext === '.css') {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const k of css.matchAll(/url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)/gi)) red(`${x.rel} line ${css.slice(0, k.index).split('\n').length}: loads ${k[1].slice(0, 80)} from outside. A page that loads an outside picture tells that host when the owner opens it.`);
      for (const k of css.matchAll(/@import\b/gi)) red(`${x.rel} line ${css.slice(0, k.index).split('\n').length}: @import loads another style sheet.`);
    }
    if (ext === '.svg' && /<script|\son\w+\s*=|javascript:|href\s*=\s*["']https?:/i.test(text)) red(`${x.rel} is a picture with script or outside links in it.`);
  }
  if (total > LIMITS.total) red(`The files add up to ${Math.round(total / 1024)} KB; the limit is ${LIMITS.total / 1024} KB.`);
  if (!all.some((x) => x.rel === 'server.js') && !all.some((x) => x.rel === 'ui.js')) yellow('There is no server.js and no ui.js: the module does nothing.');
  if (!cur.lines.some((l) => l.level === 'red')) ok(`${all.filter((x) => x.kind === 'file').length} files, ${Math.round(total / 1024)} KB, all of kinds a module may hold.`);

  // ---------------- 2. What it can do (the label)
  section('What it can do');
  info('Read from the code with comments and strings set apart (found by text match on that code; Node has no parser for module code without a package). Each file is read by Node too (node --check), and so is the checker\'s own reading of it.');
  info('Names built at run time (brackets, joins, escapes) cannot be followed by a text check; where code does that on the risky objects, the line is red.');
  const used = new Set(); const routes = []; const tools = new Set(); const tables = new Map(); const hosts = new Map(); const testHosts = new Map(); const actions = new Set(); const envs = new Set(); const fsLines = []; const sqlLines = [];
  let modelCalls = 0, jobs = 0, approvals = 0, intervals = 0, clears = 0, hasDeactivate = false, secretsNamed = new Set(), sendPerson = false, asserts = 0;
  const kitHost = testhost || null;
  for (const x of all.filter((f) => f.kind === 'file' && /\.m?js$/.test(f.rel))) {
    const src = fs.readFileSync(x.abs, 'utf8');
    if (x.rel === 'testhost.js' && kitHost) {
      if (crypto.createHash('sha256').update(src).digest('hex') === kitHost) { ok('testhost.js is the kit\'s test host, unchanged (used by its tests only; the desk never loads it).'); continue; }
      red('testhost.js is not this kit\'s test host. Copy samples/hello-notes/testhost.js unchanged (an older copy does not give ctx.fetch the same test options in a desk).'); continue;
    }
    const syn = await nodeReads(src);
    if (syn.status !== 0) { red(`${x.rel} does not parse: ${(syn.stderr.split('\n').find((l) => /Error/.test(l)) || 'syntax error').trim()}`); continue; }
    const L = lex(src); const S = (n) => L.strings[Number(n)]?.value ?? '';
    // the checker's own reading must be one Node also reads; if not, the reader was fooled and its rules cannot be trusted
    if ((await nodeReads(L.code)).status !== 0) { red(`${x.rel}: the checker could not read this file the way Node does (a slash or a quote that can be read two ways). Write it plainly; the file is refused.`); continue; }
    // optional chaining reaches the same member: read a?.b as a.b and f?.() as f() (same length, so lines stay right)
    const code = L.code.replace(/\?\.(?=\s*[([])/g, '  ').replace(/\?\.(?!\d)/g, ' .');
    const where = (re) => { const out = []; let k; const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while ((k = g.exec(code))) out.push(k); return out; };
    const at = (k) => `${x.rel} line ${lineAt(code, k.index)}`;
    const browser = isBrowserFile(x.rel), testFile = isTestFile(x.rel);
    // names written with escapes (eval is eval) and computed members of the risky objects
    for (const k of where(/\\/)) { red(`${at(k)}: a name written with escaped letters (such as \\u0065val for eval). What it names cannot be read.`); break; }
    for (const k of where(/(?<![.\w$])(?:const|let|var)?\s*[\w$]+\s*=\s*(globalThis|global|process|Reflect|Function|eval)\s*(?=[;,)\n]|$)|\{[^{}]*\}\s*=\s*(globalThis|global|process|Reflect)\b/)) red(`${at(k)}: holds ${k[1] || k[2]} in another name. What is reached through that name cannot be read.`);
    for (const k of where(new RegExp(`(?<![.\\w$])(globalThis|global|process|window|self|Reflect|Function)\\s*\\[`))) red(`${at(k)}: reaches into ${k[1]} with a name built at run time (${k[1]}[...]). What it reaches cannot be read.`);
    // a member reached by a name the reader can work out: x["constructor"], x["constr" + "uctor"], x[k] where k holds
    // such text. A name joined from text and a variable cannot be worked out; those places are counted on the label.
    {
      const RISKY_KEY = new Set(['constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'getBuiltinModule', 'binding', 'mainModule', 'dlopen']);
      const textOf = (e) => {                                  // the text an expression of plain strings gives, or null
        let t = e.trim().replace(/[,\s]+$/, ''); while (/^\(.*\)$/.test(t)) t = t.slice(1, -1).trim();
        const list = /^\[\s*((?:"S\d+"\s*,?\s*)+)\]\s*\.\s*join\s*\(\s*(?:"S(\d+)")?\s*\)$/.exec(t);
        if (list) return [...list[1].matchAll(/"S(\d+)"/g)].map((q) => S(q[1])).join(list[2] != null ? S(list[2]) : ',');
        return /^"S\d+"(?:\s*\+\s*"S\d+")*$/.test(t) ? [...t.matchAll(/"S(\d+)"/g)].map((q) => S(q[1])).join('') : null;
      };
      let held = 0; const seen = new Set();
      for (const k of where(/(?<=[\w$)\]]\s*)\[\s*([^\[\]\n]{1,160}?)\s*\]/)) {
        const e = k[1]; if (/^\d+$/.test(e)) continue;
        let name = textOf(e); const nm = /^[A-Za-z_$][\w$]*$/.exec(e)?.[0];
        if (name == null) held++;
        if (name == null && nm) for (const a of where(new RegExp(`(?<![.\\w$])${nm.replace(/\$/g, '\\$')}\\s*=(?!=)\\s*([^;\\n]*)`))) { const t = textOf(a[1]); if (t != null && RISKY_KEY.has(t)) { name = t; break; } }
        if (name != null && RISKY_KEY.has(name) && !seen.has(lineAt(code, k.index))) { seen.add(lineAt(code, k.index)); red(`${at(k)}: reaches the member "${name}" by a name in brackets${nm ? ` (${nm})` : ''}. This is how code reaches the Function constructor or the inside of Node without naming them.`); }
      }
      if (held) info(`${x.rel}: reaches members by a name worked out while it runs in ${held} ${held === 1 ? 'place' : 'places'} (x[name]). The checker cannot see which members those are.`);
    }
    // imports
    const specs = [...where(/\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?"S(\d+)"/), ...where(/\bimport\s*\(\s*"S(\d+)"\s*\)/)].map((k) => ({ k, spec: S(k[1]) }));
    for (const k of where(/\bimport\s*\((?!\s*"S\d+"\s*\))/)) red(`${at(k)}: a dynamic import of a computed path. What it loads cannot be read.`);
    const fsNames = new Set(); const fsNs = new Set();
    for (const { k, spec } of specs) {
      const bare = spec.replace(/^node:/, ''); const top = bare.split('/')[0];
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = path.resolve(path.dirname(x.abs), spec);
        if (!target.startsWith(path.resolve(dir) + path.sep)) red(`${at(k)}: imports ${spec}, which is outside the module's own folder (the desk's own code is reached only through ctx).`);
      } else if (/^[a-z]+:/i.test(spec) && !spec.startsWith('node:')) red(`${at(k)}: loads code from ${spec}.`);
      else if (FORBIDDEN.has(top)) red(`${at(k)}: imports ${spec}. A module may not start programs, open sockets or run code by itself; everything goes through ctx.`);
      else if (FORBIDDEN_WHY[top] && (spec.startsWith('node:') || builtinModules.includes(bare) || builtinModules.includes(top))) { if (!(testFile && top === 'os')) red(`${at(k)}: imports ${spec}, which ${FORBIDDEN_WHY[top]}.`); }
      else if (bare === 'fs' || bare === 'fs/promises') { used.add('node:fs'); const line = code.slice(k.index, code.indexOf('\n', k.index) < 0 ? code.length : code.indexOf('\n', k.index)); const nm = line.match(/import\s+(?:\*\s+as\s+)?([\w$]+)/); if (nm && nm[1] !== 'from') fsNs.add(nm[1]); if (/^import\s*\(/.test(line)) red(`${at(k)}: imports ${spec} while it runs. Import it at the top of the file, so the checker can follow which files it touches.`); for (const part of (line.match(/^(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}/)?.[1] || '').split(',')) { const p = part.trim().split(/\s+as\s+/); if (p[0]) (p[0].trim() === 'promises' || p[0].trim() === 'default' ? fsNs : fsNames).add((p[1] || p[0]).trim()); } if (/^\s*export\b/.test(line)) red(`${at(k)}: hands ${spec} on to another file. The checker reads each file alone and cannot follow it there; import it where it is used.`); }
      else if (spec.startsWith('node:') || builtinModules.includes(bare) || builtinModules.includes(top)) { if (browser) red(`${at(k)}: a page file imports ${spec}.`); }
      else if (!m?.npm?.[top.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : top]) red(`${at(k)}: imports the npm package "${spec}", which module.json does not list under "npm".`);
      else yellow(`${at(k)}: uses the npm package "${spec}" (listed under "npm").`);
    }
    for (const k of where(/\brequire\s*\(|\bcreateRequire\b/)) red(`${at(k)}: require or createRequire loads code around the module's imports.`);
    for (const k of where(/(?<![.\w$])eval\b|\bnew\s+Function\b|(?<![.\w$])Function\s*\(/)) red(`${at(k)}: eval or new Function runs text as code.`);
    // the risky globals by any other spelling: held, passed on, spread, destructured or reached as a member of the global
    // object. Only the plain members below are read; any other use of these names is red, because the reader cannot
    // follow a value from one place to another.
    for (const k of where(/(?<![\w$])(?:(?<=\.\.\.\s*)|(?<!\.\s*))(process|Function|globalThis|global)(?![\w$])/)) {
      const name = k[1]; const after = code.slice(k.index + k[0].length, k.index + k[0].length + 60); const before = code.slice(Math.max(0, k.index - 30), k.index);
      if (/^\s*:(?!:)/.test(after) && /[{,]\s*$/.test(before)) continue;                       // a key in an object: { process: 1 }
      const mem = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(after)?.[1];
      if (name === 'process' && mem && (PROCESS_OK.has(mem) || PROCESS_RED.has(mem))) continue;     // plain, or red with its own line below
      if ((name === 'globalThis' || name === 'global') && mem && GLOBAL_OK.has(mem)) continue;
      if (name === 'Function' && (/^\s*\(/.test(after) || /\bnew\s+$/.test(before))) continue;      // red as eval or new Function
      if (/^\s*\[/.test(after)) continue;                                                       // red as a name built at run time
      red(`${at(k)}: uses ${name}${mem ? '.' + mem : ''} in a way the checker cannot follow (held, passed on, spread or reached another way). A module may not reach ${name === 'Function' ? 'the Function constructor' : name === 'process' ? 'the desk\'s process' : 'the global object'} except by the plain uses the checker reads; everything else goes through ctx.`);
    }
    for (const k of where(/(?<![\w$])(?:(?<=\.\.\.\s*)|(?<!\.\s*))fetch(?![\w$])(?!\s*\()/)) { if (/^\s*:(?!:)/.test(code.slice(k.index + 5, k.index + 20)) && /[{,]\s*$/.test(code.slice(Math.max(0, k.index - 30), k.index))) continue; red(`${at(k)}: holds fetch in a name or passes it on. Outside calls go through ctx.fetch${browser ? ' (pages talk only to the desk, through ui.api)' : ''}.`); }
    for (const k of where(/\.\s*constructor\b(?!\s*\.\s*name\b|\s*[!=]==?)/)) red(`${at(k)}: reaches a constructor through .constructor, the way code reaches the Function constructor and runs text as code.`);
    for (const k of where(/\bReflect\s*\.\s*construct\b/)) red(`${at(k)}: Reflect.construct can build the Function constructor and run text as code.`);
    for (const k of where(/\bset(?:Timeout|Interval)\s*\(\s*"S\d+"/)) red(`${at(k)}: a timer given text runs it as code.`);
    for (const k of where(/\bprocess\s*\.\s*(getBuiltinModule|binding|_linkedBinding|dlopen|mainModule|reallyExit|_rawDebug)\b/)) red(`${at(k)}: process.${k[1]} reaches the inside of Node${k[1] === 'getBuiltinModule' ? ' (any of its modules: programs, files, the network)' : ''}.`);
    for (const k of where(/\bprocess\s*\.\s*(exit|kill|abort|chdir|setuid|setgid|umask|exitCode)\b/)) red(`${at(k)}: process.${k[1]} changes or stops the whole desk.`);
    for (const k of where(/\bprocess\s*\.\s*env\b(?:\s*\.\s*([A-Za-z_]\w*)|\s*\[\s*"S(\d+)"\s*\])?/)) envs.add(k[1] || (k[2] ? S(k[2]) : '(a name built at run time)'));
    for (const k of where(/\bprocess\s*\.\s*env\s*\.\s*(APD_KIT_\w*)/)) red(`${at(k)}: reads ${k[1]}, which only the kit's stand-in desk sets. Code that checks whether it is being checked can behave well only then.`);
    for (const s of L.strings) if (/APD_KIT_HARNESS|apd-harness-|apd-sandbox-/.test(s.value)) red(`${x.rel} line ${s.line}: looks for the kit's stand-in desk ("${s.value.slice(0, 40)}"). Code that checks whether it is being checked can behave well only then.`);
    // built-ins changed for everyone: prototypes, held prototypes, members of the shared objects
    for (const k of where(/\b([A-Z][\w$]*)\s*\.\s*prototype\b/)) { const rest = code.slice(k.index + k[0].length, k.index + k[0].length + 80); const before = code.slice(Math.max(0, k.index - 40), k.index); if (/^\s*(\.\s*[\w$]+\s*=[^=]|\[)/.test(rest)) red(`${at(k)}: changes ${k[1]}.prototype, which every module and the desk share.`); else if (/^\s*[;,)\n]/.test(rest) && /(=|\(|,)\s*$/.test(before)) red(`${at(k)}: holds ${k[1]}.prototype in a name or passes it on; changing it through that name would change it for every module.`); }
    for (const k of where(new RegExp(`(?<![.\\w$])(${BUILTIN_OBJECTS})\\s*\\.\\s*([\\w$]+)\\s*(=(?!=)|\\+=|-=|\\|\\|=|\\?\\?=|&&=)`))) if (!(browser && k[1] === 'document' && k[2] === 'title')) red(`${at(k)}: sets ${k[1]}.${k[2]}, which every module and the desk share.`);
    for (const k of where(new RegExp(`\\bObject\\s*\\.\\s*(defineProperty|defineProperties|setPrototypeOf|assign)\\s*\\(\\s*(${BUILTIN_OBJECTS}|[A-Z][\\w$]*\\s*\\.\\s*prototype)\\b`))) red(`${at(k)}: changes a built-in object (${k[2]}).`);
    for (const k of where(/__proto__|\b(?:Object|Reflect)\s*\.\s*setPrototypeOf\b/)) red(`${at(k)}: changes what objects inherit.`);
    if (browser) {
      for (const k of where(/\bcreateElement\s*\(\s*"S(\d+)"/)) if (/^(script|iframe|frame|object|embed|base|meta|img)$/i.test(S(k[1]))) red(`${at(k)}: the page adds a <${S(k[1])}>, which can load code or pages from outside.`);
      for (const s of L.strings) if (/<\s*(script|iframe|object|embed|base|meta|img)\b/i.test(s.value)) red(`${x.rel} line ${s.line}: markup with a <script>, frame, link or picture in it.`);
      for (const k of where(/\b(localStorage|sessionStorage)\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*(?:"S(\d+)")?/)) { const key = k[3] != null ? S(k[3]) : null; if (key == null) yellow(`${at(k)}: reads or writes browser storage with a key built at run time.`); else if (!(id && (key.startsWith(id + '.') || key.startsWith(id + ':') || key.startsWith('apd-' + id)))) red(`${at(k)}: uses the browser storage key "${key}", which is not its own (its keys start with "${id}." or "apd-${id}").`); }
      for (const k of where(/\b(localStorage|sessionStorage)\s*(\[|\.\s*(key|clear)\b)|Object\s*\.\s*(keys|entries)\s*\(\s*(localStorage|sessionStorage)/)) red(`${at(k)}: lists or clears all of the browser's storage, which holds the desk's own keys.`);
      for (const k of where(/\bdocument\s*\.\s*cookie\b/)) red(`${at(k)}: reads the browser's cookies.`);
      for (const k of where(/(?<![.\w$])fetch\s*\(/)) red(`${at(k)}: the page calls fetch itself. Pages talk only to the desk, through ui.api.`);
      for (const k of where(/\bnavigator\s*\.\s*sendBeacon\b|\bnew\s+(WebSocket|EventSource|XMLHttpRequest|Image|Audio|Worker|SharedWorker)\b|\bwindow\s*\.\s*open\s*\(/)) red(`${at(k)}: the page opens its own connection (${k[1] || 'sendBeacon or window.open'}). Pages talk only to the desk.`);
      // an address the page sets on an element can carry what is on the screen to another host
      for (const k of where(/\blocation\s*(\.\s*(href|assign|replace)\b|=(?!=))/)) red(`${at(k)}: the page sends the window to another address (location). Pages stay in the desk.`);
      for (const k of where(/\.\s*href\s*=(?!=)\s*([^;\n]*)/)) if (!/^"S\d+"\s*$/.test(k[1].trim()) && !/\blocation\s*\.\s*$/.test(code.slice(Math.max(0, k.index - 12), k.index))) yellow(`${at(k)}: the page sets a link address built at run time; where it points is seen only when the owner clicks it.`);
      for (const k of where(/\.\s*(src|action|formAction|srcset|poster)\s*=(?!=)\s*([^;\n]*)/)) if (!/^"S\d+"\s*$/.test(k[2].trim()) || /^[a-z]+:\/\//i.test(S(k[2].trim().slice(2, -1)))) red(`${at(k)}: the page sets .${k[1]} to ${/^"S\d+"/.test(k[2].trim()) ? 'an outside address' : 'an address built at run time'}. A picture or link address can carry what is on the screen to another host.`);
      for (const k of where(/\bsetAttribute\s*\(\s*"S(\d+)"/)) if (/^(src|action|formaction|srcset|poster|data)$/i.test(S(k[1]))) red(`${at(k)}: the page sets the "${S(k[1])}" attribute; the same risk as setting .${S(k[1])}.`);
      for (const k of where(/(?<![\w$])(src|action|formaction|srcset|poster)\s*:\s*(?!"S\d+"\s*[,}])/)) red(`${at(k)}: the page gives an element a ${k[1]} built at run time. A picture or link address can carry what is on the screen to another host.`);
      // a module's page runs with the owner's own session: it must not press the owner's buttons for him
      for (const k of where(/\bui\s*\.\s*(decide|setLevel|setAutoApprove|setOnline|saveMenu|lockWindow|openChooser)\s*\(/)) red(`${at(k)}: the page calls ui.${k[1]}, which only the owner's own controls may use.`);
      for (const s of L.strings) {
        const v = s.value.replace(/^\/?(api\/)?/, '');
        if (/^(approvals|settings\/(security|auto-approve|paid-models|spend)|panic\/resume|modules\/[^/]+\/(on|off)|people|update|keys|downloads|local-engine)\b/.test(v)) red(`${x.rel} line ${s.line}: the page calls the desk's own route "${s.value}". A module's page calls only its own routes (m/${id}/...).`);
      }
    } else {
      for (const k of where(/(?<![.\w$])fetch\s*\(|\b(?:globalThis|global)\s*\.\s*fetch\b|\bwindow\s*\.\s*fetch\b/)) red(`${at(k)}: calls fetch directly. Outside calls go through ctx.fetch, which holds Offline and Panic.`);
      for (const k of where(/\b(XMLHttpRequest|WebSocket|EventSource)\b/)) red(`${at(k)}: opens a connection of its own (${k[1]}).`);
      // node:fs and the paths it touches: "inside" only when every piece is ctx.dir / ctx.dataDir / ctx.workspace or ctx.workspacePath(...) plus plain words
      const show = (e) => e.replace(/"S(\d+)"/g, (_, n) => JSON.stringify(S(n)));
      const pathOf = (expr, depth = 0) => {
        const e = expr.trim(); const lit = /^"S(\d+)"$/.exec(e);
        if (lit) { const v = S(lit[1]); return path.isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v) ? 'red:an absolute path ' + v : v.split(/[\\/]/).includes('..') ? 'red:a path that climbs out (' + v + ')' : 'red:a path relative to wherever the desk was started (' + v + ')'; }
        if (OWN_ROOT.test(e) || /^ctx\s*\.\s*workspacePath\s*\(/.test(e)) return 'inside the module\'s own folders';
        const j = /^path\s*\.\s*(join|resolve)\s*\(/.exec(e);
        if (j) {
          const parts = argsAt(e, j[0].length - 1);
          if (!OWN_ROOT.test(parts[0] || '')) return 'a path the checker could not follow (' + show(e).slice(0, 60) + ')';
          for (const p of parts.slice(1)) { const pl = /^"S(\d+)"$/.exec(p); if (!pl) return 'a path the checker could not follow (' + show(e).slice(0, 60) + ')'; const v = S(pl[1]); if (v.split(/[\\/]/).includes('..')) return 'red:a path that climbs out of the module\'s folder (' + v + ')'; if (path.isAbsolute(v) || /^[A-Za-z]:/.test(v)) return 'red:an absolute path ' + v; }
          return 'inside the module\'s own folders';
        }
        if (/^[\w$]+$/.test(e) && depth === 0) { const def = code.match(new RegExp(`(?:const|let|var)\\s+${reEsc(e)}\\s*=\\s*([^;\\n]+)`)); if (def) return pathOf(def[1], 1); }
        const climb = [...e.matchAll(/"S(\d+)"/g)].map((q) => S(q[1])).find((v) => v.split(/[\\/]/).includes('..'));
        if (climb != null) return 'red:a path that climbs out (' + climb + ')';
        return 'a path the checker could not follow (' + show(e).slice(0, 60) + ')';
      };
      const names = [...fsNs].map(reEsc), fns = [...fsNames].map(reEsc);
      if (names.length || fns.length) {
        const fsCall = new RegExp(`(?:\\b(?:${names.join('|') || '\\u0000'})\\s*\\.\\s*(?:promises\\s*\\.\\s*)?(${FS_CALLS})|(?<![.\\w$])(${fns.join('|') || '\\u0000'}))\\s*\\(`, 'g');
        for (const k of where(fsCall)) {
          const fn = k[1] || k[2]; const verdict = pathOf(argsAt(code, k.index + k[0].length - 1)[0] || '');
          if (verdict.startsWith('red:')) red(`${at(k)}: node:fs ${fn} on ${verdict.slice(4)}. Files go inside ctx.workspacePath, ctx.dir or ctx.dataDir only.`);
          else fsLines.push(`${fn}: ${verdict}`);
        }
        for (const n of [...fsNs, ...fsNames]) for (const k of where(new RegExp(`(?<![.\\w$])${reEsc(n)}(?![\\w$])(?!\\s*[.(])`))) if (!/import|from/.test(code.slice(Math.max(0, k.index - 60), k.index))) red(`${at(k)}: passes node:fs (${n}) on as a value. The checker cannot follow where it is used, so it cannot see which files it touches.`);
        // a member of the fs namespace that is not called where it stands is held or passed on, just the same
        for (const n of fsNs) for (const k of where(new RegExp(`(?<![.\\w$])${reEsc(n)}\\s*\\.\\s*(?:promises\\s*\\.\\s*)?([\\w$]+)(?![\\w$])(?!\\s*\\()`))) if (k[1] !== 'constants' && !(k[1] === 'promises' && /^\s*\.\s*[\w$]+\s*\(/.test(code.slice(k.index + k[0].length, k.index + k[0].length + 60)))) red(`${at(k)}: holds node:fs ${k[1]} in a name or passes it on. The checker cannot follow which files it touches.`);
      }
      for (const k of where(/\bctx\s*\.\s*([A-Za-z_$][\w$]*)/)) { used.add('ctx.' + k[1]); if (!CTX.has(k[1])) yellow(`${at(k)}: uses ctx.${k[1]}, which the desk does not give a module.`); }
      for (const k of where(/\bctx\s*\[/)) red(`${at(k)}: reaches into ctx with a name built at run time.`);
      // the owner's model keys, by any spelling the reader can see: a member, a name that holds it, or a destructure
      for (const k of [...where(/\bmodel\s*\.\s*keys\b(?!\s*\.\s*list\s*\()|\bkeys\s*\.\s*(?:add|remove|toggle|tier)\b|\{[^{}]*\bkeys\b[^{}]*\}\s*=\s*[\w$.\s]*\bmodel\b|\bmodel\s*:\s*\{[^{}]*\bkeys\b|\{[^{}]*\b(?:add|remove|toggle|tier)\b[^{}]*\}\s*=\s*[\w$.\s]*\bkeys\b|\bmodel\s*\[/), ...where(/\[\s*"S(\d+)"\s*\]/).filter((k) => S(k[1]) === 'keys')]) red(`${at(k)}: reaches the owner's model keys (ctx.model.keys). Only the Models module does that; the desk does not give the keys to an added module.`);
      for (const k of where(/\bctx\s*\.\s*agents\s*\.\s*(update|create|remove)\s*\(/)) yellow(`${at(k)}: changes the owner's agents (ctx.agents.${k[1]}); the route that calls it must refuse when owner is false.`);
      for (const k of where(/\bctx\s*\.\s*(requestRestart|deskDataDir|houseBackupsDir|serviceKey|services)\b/)) yellow(`${at(k)}: uses ctx.${k[1]}${k[1] === 'deskDataDir' ? ', the whole desk\'s data folder with every person\'s space' : k[1] === 'requestRestart' ? ', which restarts the whole desk' : ''}.`);
      for (const k of where(/\bctx\s*\.\s*settings\s*\.\s*setOwnerText\s*\(/)) yellow(`${at(k)}: writes the owner's business text (the one setting a module may write).`);
      for (const k of where(/\bctx\s*\.\s*modules\s*\.\s*runTool\s*\(/)) yellow(`${at(k)}: runs another module's tool directly.`);
      for (const k of where(/\{([^{}]*)\}\s*=\s*ctx\b/)) for (const p of k[1].split(',')) { const n = p.trim().split(/\s*:\s*/)[0]; if (n) used.add('ctx.' + n); }
      for (const k of where(/\bctx\s*\.\s*route\s*\(\s*"S(\d+)"\s*,\s*"S(\d+)"/)) routes.push(`${S(k[1]).toUpperCase()} ${S(k[2])}`);
      for (const k of where(/\bctx\s*\.\s*tool\s*\(/)) { const body = code.slice(k.index, k.index + 600); const nm = body.match(/\bname\s*:\s*("S(\d+)"\s*[,}])?/); if (nm?.[2] != null) tools.add(S(nm[2])); else red(`${at(k)}: registers a tool whose name the checker could not read. The owner must see every tool before he switches the module on.`); }
      // SQL whose table name is built at run time: the checker cannot say which table it opens (the desk does not stop a read of another module's tables)
      for (const k of where(/\bdb\s*\.\s*(all|get|run|exec|prepare|migrate)\s*\(/)) {
        const args = argsAt(code, k.index + k[0].length - 1); const first = k[1] === 'migrate' ? args[1] || '' : args[0] || '';
        const pieces = first.split(/\s*\+\s*/);
        const lits = pieces.map((p) => /^\(?"S(\d+)"\)?$/.exec(p.trim())?.[1]);
        if (pieces.length === 1 && lits[0] == null && first) { sqlLines.push(`${at(k)} (a statement held in a name)`); continue; }
        for (let n = 0; n < pieces.length - 1; n++) if (lits[n] != null && lits[n + 1] == null && /\b(from|join|into|update|table(\s+if\s+(not\s+)?exists)?)\s*["`[]?\s*$/i.test(S(lits[n]))) sqlLines.push(`${at(k)} (a table name built at run time)`);
      }
      modelCalls += where(/\.\s*model\s*\.\s*chat\s*\(/).length + where(/\.\s*model\s*\.\s*embed\s*\(/).length;
      approvals += where(/\.\s*approval\s*\.\s*request\s*\(/).length; asserts += where(/\.\s*assertGranted\s*\(/).length;
      for (const k of where(/\baction\s*:\s*"S(\d+)"/)) { actions.add(S(k[1])); if (S(k[1]) === 'send.person') sendPerson = true; }
      jobs += where(/\.\s*jobs\s*\.\s*start\s*\(/).length;
      intervals += where(/\bsetInterval\s*\(/).length; clears += where(/\bclearInterval\s*\(/).length;
      if (/\bdeactivate\b/.test(code)) hasDeactivate = true;
      for (const k of where(/\.\s*secrets\s*\.\s*(?:get|set|has)\s*\(\s*"S(\d+)"/)) secretsNamed.add(S(k[1]));
      for (const k of where(/\.\s*events\s*\.\s*emit\s*\(\s*"S(\d+)"/)) if (RESERVED_EVENTS.has(S(k[1]))) red(`${at(k)}: emits "${S(k[1])}" events, which only the desk itself may send.`);
      // module-level state: let/var, or a const holding a Map, Set, list or object, outside every function
      if (!testFile) {
        let depth = 0;
        code.split('\n').forEach((ln, i) => {
          if (depth === 0) {
            const st = ln.match(/^\s*(?:export\s+)?(?:(let|var)\s+([\w$]+)|const\s+([\w$]+)\s*=\s*(new\s+(?:Map|Set|WeakMap|Array)\b|\[|\{))/);
            const name = st && (st[2] || st[3]);
            const changed = st && !st[1] && !/^new/.test(st[4]) ? new RegExp(`\\b${reEsc(name)}\\s*(\\.\\s*(push|set|add|splice|unshift|pop|shift|delete|clear)\\s*\\(|\\[[^\\]]*\\]\\s*=[^=]|\\.\\s*[\\w$]+\\s*=[^=])`).test(code) : true;
            if (st && changed) yellow(`${x.rel} line ${i + 1}: module-level state (${name}). It is shared by every space the module is on in; keep state inside activate.`);
          }
          for (const c of ln) { if (c === '{' || c === '(' || c === '[') depth++; else if (c === '}' || c === ')' || c === ']') depth--; }
        });
      }
    }
    // strings: hosts, tables, the desk's own folders
    for (const s of [...L.strings, ...L.templates]) {
      for (const h of s.value.matchAll(HOST_RE)) { const host = h[1].toLowerCase(); const into = testFile ? testHosts : hosts; if (!into.has(host)) into.set(host, `${x.rel} line ${s.line}`); }
      if (/(^|[\\/])app[\\/](core|ui)([\\/]|$)|(^|[\\/])app[\\/]server\.js/.test(s.value)) red(`${x.rel} line ${s.line}: names the desk's own code folder (${s.value.slice(0, 60)}). A module never touches app/.`);
    }
    if (!browser) for (const s of [...L.strings.filter((s) => !L.templates.some((t) => t.value.includes(s.value) && s.value.length < t.value.length)), ...L.templates]) {
      if (!/^\s*(select|insert|update|delete|create|alter|drop|with|replace)\b/i.test(s.value) && !/create\s+table/i.test(s.value)) continue;
      for (const t of s.value.matchAll(/\b(create\s+(?:temp\w*\s+)?table(?:\s+if\s+not\s+exists)?|alter\s+table|drop\s+table(?:\s+if\s+exists)?|insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from|from|join)\s+["`[]?([A-Za-z_][\w]*)/gi)) {
        const verb = t[1].toLowerCase().split(/\s+/)[0]; const name = t[2].toLowerCase(); const write = verb !== 'from' && verb !== 'join';
        const e = tables.get(name) || { name, write: false, create: false, where: `${x.rel} line ${s.line}` };
        e.write ||= write; e.create ||= verb === 'create'; tables.set(name, e);
      }
    }
  }
  const own = id ? tablePrefix(id) : null;
  for (const t of tables.values()) {
    if (own && t.name.startsWith(own)) continue;
    if (CORE_TABLES.has(t.name)) red(`${t.where}: names the desk's "${t.name}" table. Core data is reached only through ctx.`);
    else if (CORE_READ.has(t.name)) (t.write ? red : yellow)(`${t.where}: ${t.write ? 'writes to' : 'reads'} the desk's "${t.name}" table${t.write ? ', which is read-only for modules' : ' directly; prefer the ctx helpers, the core may change it'}.`);
    else if (/^m_/.test(t.name)) red(`${t.where}: names the table "${t.name}", which belongs to another module. Talk to it through ctx.modules.api.`);
    else if (t.create || t.write) red(`${t.where}: ${t.create ? 'creates' : 'writes to'} the table "${t.name}"; a module's tables are named ${own}...`);
    else if (!/^sqlite_/.test(t.name)) yellow(`${t.where}: names "${t.name}" in SQL, which the checker could not place.`);
  }
  for (const l of [...new Set(sqlLines)]) yellow(`${l}: SQL the checker cannot read. The desk itself does not stop a module from reading another module's tables, so this is worth a look.`);
  const declared = new Set((Array.isArray(m?.hosts) ? m.hosts : []).map((x) => String(x).toLowerCase()));
  const anyHost = declared.has('*');
  for (const [h, w] of hosts) {
    if (LOOP.has(h)) yellow(`${w}: names a program on this PC (${h}).`);
    else if (anyHost || declared.has(h) || [...declared].some((d) => d.startsWith('*.') && h.endsWith(d.slice(1)))) ok(`Reaches ${h} (declared under "hosts").`);
    else red(`${w}: names the outside host ${h}, which module.json does not declare under "hosts". Declare it; or, if this is not an address the module calls (a sentence on screen, say), reword it so it does not read as an address.`);
  }
  for (const [h, w] of testHosts) if (!hosts.has(h)) info(`${w}: a test names ${h} (tests run with no network).`);
  for (const d of declared) if (d !== '*' && ![...hosts.keys()].includes(d)) info(`Declares the host ${d}; no address for it was found in the code.`);
  const listed = new Set((Array.isArray(m?.tools) ? m.tools : []).filter((t) => typeof t === 'string'));
  for (const t of tools) if (!listed.has(t)) red(`It registers the tool "${t}", which module.json does not list under "tools". The owner must see every tool before he switches it on.`);
  for (const t of listed) if (!tools.has(t)) yellow(`module.json lists the tool "${t}", but no ctx.tool for it was found.`);
  const outside = [...hosts.keys()].filter((h) => !LOOP.has(h));
  if (used.has('ctx.fetch')) {
    if (anyHost) yellow('It may reach any address ("hosts": ["*"]), such as pages you type in. Each call still goes through ctx.fetch, so Offline and Panic hold.');
    else if (!declared.size && !outside.length) red('It calls ctx.fetch but declares no hosts: it sends to addresses it does not declare. List them under "hosts", or ["*"] if it reads addresses the owner types in.');
    else if (!outside.length) yellow('It calls ctx.fetch with addresses built at run time; the checker cannot see where they go.');
  }
  if (envs.size) yellow(`Reads environment variables: ${[...envs].join(', ')}.`);
  if (fsLines.length) yellow(`Uses node:fs: ${[...new Set(fsLines)].join('; ')}.`);
  if (intervals > clears) yellow(`Starts ${intervals} repeating timer${intervals === 1 ? '' : 's'} and clears ${clears}: a timer with no clear on deactivate keeps running.`);
  if (all.some((x) => x.rel === 'server.js') && !hasDeactivate) yellow('server.js returns no deactivate(): what it starts cannot be stopped when it is switched off.');
  if (sendPerson && asserts === 0) yellow('It asks to send to a person but never calls ctx.approval.assertGranted before sending. (An approval that sends nothing uses the action "custom".)');
  info(`ctx members it uses: ${[...used].filter((u) => u.startsWith('ctx.')).sort().join(', ') || 'no ctx members'}.`);
  info(`Routes: ${routes.length ? routes.join(', ') : 'none'}. Tools: ${tools.size ? [...tools].join(', ') : 'none'}. Tables: ${[...tables.keys()].filter((t) => own && t.startsWith(own)).join(', ') || 'none of its own'}.`);
  info(`Model calls in the code: ${modelCalls}. Approvals asked: ${approvals}${actions.size ? ' (' + [...actions].join(', ') + ')' : ''}. Jobs: ${jobs}. Secrets: ${secretsNamed.size ? [...secretsNamed].join(', ') : 'none'}. Outside hosts: ${anyHost ? 'any (hosts: *)' : outside.join(', ') || 'none'}.`);

  // ---------------- 3. Signed by
  section('Signed by');
  let keyList = Array.isArray(trusted) ? trusted : [];
  if (keys) { try { keyList = loadKeys(keys); } catch { red('That is not a public key file. Give the file that ends in .pub.json (never the .key file).'); } }
  const sig = verifyFolder(dir, keyList, SIG_FILE);
  say(sig.state === 'signed' ? 'ok' : sig.state === 'changed' ? 'red' : 'yellow', sig.line);

  // ---------------- 4. Runs clean
  section('Runs clean');
  const redSoFar = sections.some((s) => s.lines.some((l) => l.level === 'red'));
  const doors = [];
  if (!runner) info(notRun);
  else if (redSoFar) red('Not run: the checker does not run code that has a red line above.');
  else if (!fs.existsSync(path.join(dir, 'server.js'))) info('There is no server.js to run.');
  else {
    info('Run in a separate, locked-down Node process. What it reports comes from that process, where the module\'s own code ran; code written to hide can change it.');
    const r = await runner(dir, id);
    for (const l of r.lines || []) say(l.level, l.text);
    doors.push(...(r.doors || []));
    info(`Doors it really called while starting and answering: ${doors.join(', ') || 'none'}.`);
    const testFiles = listAll(dir).filter((x) => x.kind === 'file' && isTestFile(x.rel));
    if (!testFiles.length) yellow('It has no tests of its own (*.test.js).');
    else if (r.tests) {
      const t = r.tests;
      if (!t.fail) ok(`Its own tests pass in the stand-in desk, in the same locked-down process: ${t.pass} passed${t.skipped ? ', ' + t.skipped + ' skipped' : ''}.`);
      else red(`Its own tests failed in the stand-in desk: ${t.pass} passed, ${t.fail} failed (${t.files.filter((f) => !f.ok).map((f) => f.rel + ': ' + f.why).join('; ')}).`);
    }
  }
  const counts = { red: 0, yellow: 0 };
  for (const s of sections) for (const l of s.lines) if (l.level in counts) counts[l.level]++;
  return { id, manifest: m, sections, ...counts, doors, hashes, label: labelOf(m, { tools, hosts: [...new Set([...[...declared].filter((d) => d !== '*'), ...outside])], anyHost, routes, tables: [...tables.keys()].filter((t) => own && t.startsWith(own)), modelCalls, approvals, actions: [...actions], jobs, secrets: [...secretsNamed], used: [...used], sig }) };
}

/** The label in plain words, for a screen: what it can do, what leaves the PC, the tools it adds, who signed it. */
function labelOf(m, x) {
  const can = [];
  const pages = (Array.isArray(m?.menu) ? m.menu : []).map((it) => it?.label).filter(Boolean);
  if (pages.length) can.push(`adds ${pages.length === 1 ? 'a place' : 'places'} in the menu: ${pages.join(', ')}`);
  if (x.tables.length) can.push('keeps its own records in the desk\'s database');
  if (x.modelCalls) can.push('asks a model (through the desk\'s model door)');
  if (x.approvals) can.push(`asks you before it acts (${x.actions.join(', ') || 'custom'})`);
  if (x.jobs) can.push('runs work in the background as tasks');
  if (x.secrets.length) can.push('keeps a password or key of its own');
  if (x.used.includes('node:fs')) can.push('reads or writes files');
  if (x.used.includes('ctx.fetch')) can.push('reaches addresses on the internet');
  const signed = x.sig.state === 'signed' ? `Signed by "${x.sig.publisher || 'unnamed'}", with a key this desk trusts.` : x.sig.state === 'untrusted' ? 'Signed, but with a key this desk has not been told to trust. Treat it as not signed.' : x.sig.state === 'changed' ? 'The signature does not match the files.' : 'Not signed.';
  return {
    name: m?.name || null, id: m?.id || null, description: m?.description || '',
    can: can.length ? can : ['nothing the checker could see beyond showing a page'],
    hosts: x.anyHost ? ['any address you type in'] : x.hosts, tools: [...x.tools], signed, signedBy: x.sig.state === 'signed' ? (x.sig.publisher || 'unnamed') : null,
  };
}

/** A folder or a zip: a zip is unpacked into a fresh folder first (refused entries stop the check, and nothing is left behind). */
export function openTarget(target, { tmpRoot = os.tmpdir() } = {}) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new Error(`There is nothing at ${abs}.`);
  if (fs.statSync(abs).isDirectory()) return { dir: abs, cleanup: () => {} };
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'apd-check-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const r = unzipTo(abs, path.join(tmp, 'x'));
    const dir = path.join(tmp, r.folder || 'x');
    if (r.folder) fs.renameSync(path.join(tmp, 'x'), dir);
    return { dir, cleanup };
  } catch (e) { cleanup(); throw e; }
}

export function printReport(rep, out = console.log) {
  out(`Module check: ${rep.manifest?.name || rep.id || 'unknown'}${rep.id ? ' (' + rep.id + ')' : ''}`);
  const mark = { red: 'RED   ', yellow: 'YELLOW', ok: 'ok    ', info: '      ' };
  for (const s of rep.sections) { out(''); out(s.title); for (const l of s.lines) out(`  ${mark[l.level]} ${l.text}`); }
  out('');
  out(rep.red ? `Result: ${rep.red} red line${rep.red === 1 ? '' : 's'}, ${rep.yellow} yellow. Do not add this module as it is.` : `Result: no red line, ${rep.yellow} yellow line${rep.yellow === 1 ? '' : 's'}${rep.yellow ? ' to read before adding it' : ''}.`);
}

