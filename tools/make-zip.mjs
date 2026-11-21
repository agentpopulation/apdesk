// Makes dist/agent-population-desk.zip for Windows: unzipped (for example into C:\) it gives an apdesk\ folder.
// Five files and seven folders: install.bat, start.bat, stop.bat, uninstall.bat, README.md; app, modules, vendor,
// node_modules, setup, data, backups. Node.js is not inside: install.bat and start.bat fetch the pinned copy into runtime\.
// No data, no secrets, no tests. Fails if anything that looks like a key or a database is about to be packed.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { execFileSync } from 'node:child_process';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist'); const STAGE = path.join(DIST, 'stage'); const OUT = path.join(STAGE, 'apdesk'); const ZIP = path.join(DIST, 'agent-population-desk.zip');
// only this script's own output is cleared: other files kept in dist (a repository bundle) stay
fs.rmSync(STAGE, { recursive: true, force: true }); fs.rmSync(ZIP, { force: true }); fs.mkdirSync(OUT, { recursive: true });
const skip = (rel) => /(^|\/)(node_modules|\.git|dist|data|backups|runtime|__pycache__|\.venv|venv)(\/|$)/.test(rel) || rel === 'setup/assets/make-icon.mjs' || rel === 'setup/installed.txt' || /\.test\.(js|mjs)$/.test(rel) || /(^|\/)(real-check|ui-check|check-)[\w.-]*\.mjs$/.test(rel) || /\.(log|sqlite|sqlite-wal|sqlite-shm|pid|pyc)$/.test(rel) || /(^|\/)\.env(\.|$)/.test(rel) || /(^|\/)(test|tests|fixtures)\//.test(rel + '/') || /(^|\/)docs\/design(\/|$)/.test(rel);
const crlf = (rel) => /\.(bat|cmd)$/i.test(rel);
function copyDir(from, to, base = '') {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name; const src = path.join(from, e.name); const dst = path.join(to, e.name);
    if (skip(rel)) continue;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyDir(src, dst, rel); }
    else if (crlf(rel)) fs.writeFileSync(dst, fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n'));
    else fs.copyFileSync(src, dst);
  }
}
// What the installed packages carry that the desk never loads on Node. Each kind is removed whole, after the install
// and before zipping. Never removed: licence and notice files, package.json files, and anything a package reads at run
// time by path (pdfkit's font data in js/data, playwright-core's lib and driver files, unpdf's bundled pdf.js).
const KEEP = /licen[cs]e|notice|copying|authors|third.?party/i;     // kept whatever its extension, also inside a removed kind
const PRUNE_FILES = [
  [/\.d\.[mc]?ts$/, 'TypeScript declarations: read by editors and compilers, never by Node'],
  [/\.[mc]?ts$/, 'TypeScript sources: Node does not run .ts files inside node_modules; every package here points at its compiled .js'],
  [/\.map$/, 'source maps: only debuggers read them'],
  [/\.(md|markdown)$/i, 'Markdown docs (readmes, changelogs); licence files are kept by KEEP'],
];
const PRUNE_DIRS = [
  [/^(test|tests|__tests__|example|examples|docs|benchmark|benchmarks)$/, 'tests, examples, docs and benchmarks that packages ship; no package entry points into them'],
  [/^(\.github|\.yarn)$/, "a package's CI settings and its own copy of yarn"],
];
// builds for browsers that Node never picks: checked against each package's "exports" (node condition) or "main"
const PRUNE_BUILDS = [
  [/^exceljs\/dist\//, 'exceljs: browser bundles; Node loads excel.js, which loads lib/'],
  [/^docx\/dist\/[^/]+\.(umd\.cjs|iife\.js)$/, 'docx: UMD and IIFE bundles; Node resolves "exports" to the .mjs and .cjs builds'],
  [/^pdfkit\/js\/pdfkit\.(standalone\.js|browser\.[mc]?js)$/, 'pdfkit: browser builds; the node condition picks pdfkit.node.mjs or pdfkit.js'],
  [/^fontkit\/dist\/browser(-module)?\.[mc]?js$/, 'fontkit: browser builds; the node condition picks module.mjs or main.cjs'],
];
function pruneNodeModules(nm) {
  const removed = new Map(); let bytes = 0;
  const drop = (p, why) => { let size = 0, n = 0; (function sum(q) { const st = fs.lstatSync(q); if (st.isDirectory()) for (const e of fs.readdirSync(q)) sum(path.join(q, e)); else { size += st.size; n++; } })(p);
    // a removed folder that holds a licence file keeps that file
    const keep = []; if (fs.lstatSync(p).isDirectory()) (function find(q) { for (const e of fs.readdirSync(q, { withFileTypes: true })) { const f = path.join(q, e.name); if (e.isDirectory()) find(f); else if (KEEP.test(e.name)) keep.push([f, fs.readFileSync(f)]); } })(p);
    fs.rmSync(p, { recursive: true, force: true });
    for (const [f, data] of keep) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); size -= data.length; n--; }
    const r = removed.get(why) || { files: 0, bytes: 0 }; r.files += n; r.bytes += size; removed.set(why, r); bytes += size; };
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); const rel = path.relative(nm, p).split(path.sep).join('/');
      if (e.name === 'package.json' || KEEP.test(e.name)) continue;
      const build = PRUNE_BUILDS.find(([re]) => re.test(rel + (e.isDirectory() ? '/' : '')));
      if (build) { drop(p, build[1]); continue; }
      // a package that is itself named docs or test (directly under node_modules or a scope) stays
      if (e.isDirectory()) { const d = PRUNE_DIRS.find(([re]) => re.test(e.name)); if (d && !/^(node_modules|@.*)$/.test(path.basename(dir))) drop(p, d[1]); else walk(p); continue; }
      const f = PRUNE_FILES.find(([re]) => re.test(e.name)); if (f) drop(p, f[1]);
    }
  })(nm);
  for (const [why, r] of removed) console.log(`pruned ${String(r.files).padStart(5)} files, ${(r.bytes / 1e6).toFixed(1).padStart(5)} MB: ${why}`);
  console.log(`pruned in all: ${(bytes / 1e6).toFixed(1)} MB from node_modules`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const d of ['app', 'modules', 'vendor', 'setup']) { fs.mkdirSync(path.join(OUT, d), { recursive: true }); if (fs.existsSync(path.join(ROOT, d))) copyDir(path.join(ROOT, d), path.join(OUT, d)); }
for (const f of ['install.bat', 'start.bat', 'stop.bat', 'uninstall.bat']) fs.writeFileSync(path.join(OUT, f), fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r?\n/g, '\r\n'));
// the zip gets its own plain README; the repository README has pictures that are not in the zip
fs.copyFileSync(path.join(ROOT, 'tools', 'zip-readme.md'), path.join(OUT, 'README.md'));
for (const f of ['ATTRIBUTION.md', 'LICENSE', 'NOTICE']) if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, 'app', 'docs', f));
fs.writeFileSync(path.join(OUT, 'app', 'version.json'), JSON.stringify({ version: pkg.version, built: new Date().toISOString() }, null, 1));
for (const d of ['app', 'modules', 'vendor']) fs.writeFileSync(path.join(OUT, d, 'package.json'), '{ "type": "module" }\n');
// the package list lives in setup\; packages are installed once here so the zip runs without the internet
const shipPkg = { name: pkg.name, private: true, version: pkg.version, type: 'module', license: pkg.license, engines: pkg.engines, dependencies: pkg.dependencies };
fs.writeFileSync(path.join(OUT, 'setup', 'package.json'), JSON.stringify(shipPkg, null, 1));
fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(OUT, 'setup', 'package-lock.json'));
console.log('installing production packages ...');
try { execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(OUT, 'setup'), stdio: ['ignore', 'ignore', 'inherit'] }); }
catch { execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(OUT, 'setup'), stdio: ['ignore', 'ignore', 'inherit'] }); }
fs.renameSync(path.join(OUT, 'setup', 'node_modules'), path.join(OUT, 'node_modules'));
pruneNodeModules(path.join(OUT, 'node_modules'));
// Windows: no symlinks, no .bin shims, and say loudly if a Linux-built binary slipped in
const native = []; let files = 0;
(function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isSymbolicLink() || (e.isDirectory() && e.name === '.bin')) { fs.rmSync(p, { recursive: true, force: true }); continue; } if (e.isDirectory()) walk(p); else { files++; if (/\.node$/.test(e.name)) native.push(path.relative(OUT, p)); } } })(OUT);
for (const [d, note] of [['data', 'Your data lives here: the database, the workspace, agent browser profiles. It is made on first start. Back it up from Settings, Backup.'], ['backups', 'Backup zips from Settings, Backup are kept here, outside the data folder, so you can delete data and restore.']]) { fs.mkdirSync(path.join(OUT, d), { recursive: true }); fs.writeFileSync(path.join(OUT, d, 'README.txt'), note + '\r\n'); }
// secret scan over everything that is ours (packages are public code)
const KEY = [/sk-or-v1-[a-f0-9]{20,}/, /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/, /AIza[0-9A-Za-z_-]{33}/, /gsk_[A-Za-z0-9]{40,}/, /xox[baprs]-[A-Za-z0-9-]{20,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /ghp_[A-Za-z0-9]{36}/, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/];
const hits = [];
(function scan(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name === 'node_modules') continue; scan(p); continue; } if (/\.(sqlite|db|pem|key|p12|pfx)$/i.test(e.name) || /^\.env/.test(e.name)) { hits.push(path.relative(OUT, p) + ' (file type)'); continue; } const st = fs.statSync(p); if (st.size > 4e6 || /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|wasm|pdf|zip|onnx|bin|wav|mp3)$/i.test(e.name)) continue; const txt = fs.readFileSync(p, 'utf8'); for (const re of KEY) { const m = txt.match(re); if (m) hits.push(`${path.relative(OUT, p)} (${m[0].slice(0, 12)}…)`); } } })(OUT);
if (hits.length) { console.error('REFUSING TO ZIP: these look like secrets or data:\n  ' + hits.join('\n  ')); process.exit(1); }
const top = fs.readdirSync(OUT, { withFileTypes: true });
const dirs = top.filter(e => e.isDirectory()).map(e => e.name).sort(); const fl = top.filter(e => e.isFile()).map(e => e.name).sort();
console.log(`top level: ${fl.length} files (${fl.join(', ')}), ${dirs.length} folders (${dirs.join(', ')})`);
if (fl.length !== 5 || dirs.length !== 7) { console.error('The layout must be exactly five files and seven folders.'); process.exit(1); }
execFileSync('zip', ['-r', '-q', '-X', ZIP, 'apdesk'], { cwd: STAGE });
console.log(`zip: ${ZIP}  ${(fs.statSync(ZIP).size / 1e6).toFixed(1)} MB, ${files} files, modules: ${fs.readdirSync(path.join(OUT, 'modules')).filter(n => fs.existsSync(path.join(OUT, 'modules', n, 'module.json'))).length}`);
if (native.length) console.log('WARNING: native binaries built on this computer are in the zip and will not load on Windows:\n  ' + native.join('\n  '));
