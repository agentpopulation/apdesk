// The written records say what the build holds today: counted from the folders and manifests, not typed.
// Run: node --test docs/records.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const README = read('README.md'), ZIP = read('tools', 'zip-readme.md'), CHANGES = read('CHANGELOG.md'), ATTR = read('ATTRIBUTION.md');
const PKG = JSON.parse(read('package.json'));
const MODS = fs.readdirSync(path.join(ROOT, 'modules'), { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(ROOT, 'modules', d.name, 'module.json')))
  .map(d => JSON.parse(read('modules', d.name, 'module.json')));
const on = MODS.filter(m => m.kind === 'core' || (m.kind !== 'parked' && m.defaultOn));
const optional = MODS.filter(m => m.kind !== 'core' && m.kind !== 'parked' && !m.defaultOn);
const parked = MODS.filter(m => m.kind === 'parked');
const section = (text, from, to) => { const a = text.indexOf(from); const b = to ? text.indexOf(to, a + 1) : -1; return a < 0 ? '' : text.slice(a, b < 0 ? undefined : b); };
const known = section(CHANGES, '### Known weak points');

test('README badge and text carry the package version', () => {
  assert.match(README, new RegExp(`alt="Version ${PKG.version.replace(/\./g, '\\.')}"`));
  assert.match(README, new RegExp(`badge/version-${PKG.version.replace(/\./g, '\\.')}-`));
  assert.match(README, new RegExp(`This is version \\*\\*${PKG.version.replace(/\./g, '\\.')}\\*\\*`));
});

test('module counts in README, the zip page and STORAGE.md are the counted ones', () => {
  const total = MODS.length;
  assert.match(README, new RegExp(`\\*\\*${total} modules, switch on what you need\\*\\*`));
  assert.match(README, new RegExp(`${on.length} are on from the first run\\. ${optional.length} more wait in the Module Store`));
  assert.match(README, new RegExp(`## 🧩 The ${total} modules`));
  assert.match(README, new RegExp(`\\*\\*On from the first run \\(${on.length}\\)\\*\\*`));
  assert.match(README, new RegExp(`\\*\\*Switch on when you want them \\(${optional.length}\\)\\*\\*`));
  assert.match(README, new RegExp(`\\*\\*Parked \\(${parked.length}\\):\\*\\*`));
  assert.match(ZIP, new RegExp(`The ${total} modules, one folder each\\. ${on.length} are on from the first run`));
  assert.match(read('app', 'core', 'contracts', 'STORAGE.md'), new RegExp(`the ${total} modules, one folder each`));
  for (const text of [README, ZIP, read('app', 'core', 'contracts', 'STORAGE.md')]) assert.doesNotMatch(text, /\b30 modules\b|The 30 modules/);
});

test('every module that is not parked is a row of the README tables, under the right heading', () => {
  const first = section(README, '**On from the first run', '**Switch on when you want them');
  const second = section(README, '**Switch on when you want them', '**Parked');
  const rows = (t) => [...t.matchAll(/^\| (\d+) \| ([^|]+) \|/gm)].map(r => Number(r[1]));
  assert.deepEqual(rows(first).sort((a, b) => a - b), on.map(m => m.number).sort((a, b) => a - b));
  assert.deepEqual(rows(second).sort((a, b) => a - b), optional.map(m => m.number).sort((a, b) => a - b));
  for (const m of parked) assert.ok(README.includes(m.name), m.name);
});

test('Windows facts: the ARM64 run, the visual installer and the macOS starter are stated as they are', () => {
  assert.doesNotMatch(README, /Windows on ARM64 \| Not tested/);
  assert.match(README, /Windows 11 on ARM64[^\n]*22 Nov 2026/);
  assert.match(README, /20 Nov 2026/);
  assert.doesNotMatch(ZIP, /\*\*untested\*\*|There is no start script/);
  assert.match(ZIP, /start\.command/);
  assert.match(ZIP, /22 Nov 2026/);
  assert.ok(fs.existsSync(path.join(ROOT, 'start.command')));
  // the installer opens in the browser; the console questions are the fallback
  assert.match(README, /opens in your browser/);
  assert.match(README, /install\.bat \/console/);
  assert.match(ZIP, /opens in your browser/);
  assert.doesNotMatch(README, /Not tested yet\. `start\.command`/);
});

test('README and zip page name only what was run on Windows, with the date', () => {
  for (const t of [README, ZIP]) {
    assert.match(t, /visual installer/i);
    assert.match(t, /not been run on Windows/i);
  }
});

test('records say no e-mail address, no person names and no tool names', () => {
  for (const [n, t] of [['README', README], ['zip-readme', ZIP], ['ATTRIBUTION', ATTR], ['CHANGELOG', CHANGES]]) {
    assert.doesNotMatch(t, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, n + ' has an e-mail address');
  }
  assert.match(README, /@agentpopulation/);
});

test('every online service the code calls is credited in ATTRIBUTION.md', () => {
  for (const k of ['Firecrawl', 'Jina Reader', 'RIPEstat', 'crt.sh', 'Wayback', 'Shodan', 'GitHub']) assert.ok(ATTR.includes(k), k);
});

test('contracts: spend limits, module kinds, reserved events and the ctx members match the code', () => {
  const door = read('app', 'core', 'contracts', 'APPROVAL-DOOR.md');
  assert.doesNotMatch(door, /default INR/);
  assert.match(door, /hundredths/);
  const mods = read('app', 'core', 'contracts', 'MODULES.md');
  assert.match(mods, /"parked"|`parked`/);
  const code = read('app', 'core', 'modules.js');
  const reserved = [...code.match(/RESERVED_EVENTS = new Set\(\[([^\]]*)\]/)[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(reserved.length >= 5);
  for (const e of reserved) assert.ok(mods.includes('`' + e + '`'), 'reserved event ' + e);
  for (const member of ['ctx.readBody', 'ctx.services', 'ctx.serviceKeyRefused', 'ctx.agents.create', 'ctx.agents.remove', 'ctx.agents.systemPrompt', 'ctx.modules.list', 'ctx.modules.tools', 'ctx.modules.runTool', 'ctx.events.on', 'ctx.panic.child', 'ctx.expose'])
    assert.ok(mods.includes(member) || (mods.includes(member.replace(/\.[a-zA-Z]+$/, '')) && mods.includes(member.split('.').pop() + '(')), member);
  assert.doesNotMatch(mods, /Types the shell knows: `job`, `approval`, `chat`, `panic`, `modules`, `toast`/);
  assert.doesNotMatch(read('app', 'core', 'contracts', 'STORAGE.md'), /core\/, ui\/, docs\//);
});

test('Known weak points: dated, and no line the Windows runs or the change of 22 Nov have made untrue', () => {
  assert.ok(known.length > 500, 'section found');
  assert.doesNotMatch(known, /none has run on Windows yet/);
  assert.doesNotMatch(known, /In the run on this code \(15 Nov 2026\)/);
  assert.match(known, /20 Nov 2026/);
  assert.match(known, /22 Nov 2026/);
  // each result named in a line carries its date
  for (const line of known.split('\n').filter(l => /\b(passed|failed|answered|got no answer)\b/.test(l))) assert.match(line, /\b\d{1,2} Nov 2026\b/, line.slice(0, 60));
});

test('Known weak points name the limits a user should know', () => {
  for (const k of [/proxy/i, /patterns over the owner's words/, /Offline/, /visual installer/, /macOS/]) assert.match(known, k, String(k));
});
