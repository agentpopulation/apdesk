// The shared module check (one copy for the desk and the kit): the kit's samples pass, every hostile sample is refused
// or marked for its own reason, zips that climb out are refused, and skills are checked as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModule, openTarget, HONEST, HONEST_DESK } from './check.mjs';
import { readZip, unzipTo } from './zip.mjs';
import { copyFolder } from './files.mjs';
import { checkSkill, deskSkill } from './skill.mjs';
import { REFUSED, MARKED, RUN_ONLY, SKILLS } from './hostile.mjs';
import { makeZip } from './fixtures/zip-writer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAD = path.join(HERE, 'fixtures', 'bad');
const KIT_ZIP = path.join(HERE, '..', '..', '..', 'modules', 'store', 'kit', 'apdesk-module-kit-0.1.zip');
const lines = (rep) => rep.sections.flatMap((s) => s.lines);
const reds = (rep) => lines(rep).filter((l) => l.level === 'red').map((l) => l.text);

/** The kit's samples, unpacked from the kit zip the Store hands out (the same files an outside agent gets). */
function samples() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-mc-'));
  unzipTo(KIT_ZIP, tmp);
  return { dir: path.join(tmp, 'samples'), testhost: path.join(tmp, 'samples', 'hello-notes', 'testhost.js'), done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
const sha = (f) => import('node:crypto').then((c) => c.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));

test('every hostile sample folder is in exactly one list', () => {
  const dirs = fs.readdirSync(BAD).filter((n) => n !== 'skills').sort();
  const listed = [...Object.keys(REFUSED), ...Object.keys(MARKED), ...Object.keys(RUN_ONLY)].sort();
  assert.deepEqual(listed, dirs);
  assert.deepEqual(Object.keys(SKILLS).sort(), fs.readdirSync(path.join(BAD, 'skills')).sort());
});

for (const [name, why] of Object.entries(REFUSED)) {
  test(`hostile module ${name} is refused for the right reason`, async () => {
    const rep = await checkModule(path.join(BAD, name));
    assert.ok(rep.red > 0, `${name} should have a red line`);
    assert.ok(reds(rep).some((t) => why.test(t)), `${name}: ${reds(rep).join(' | ')}`);
  });
}
for (const [name, why] of Object.entries(MARKED)) {
  test(`hostile module ${name} is marked with a yellow line`, async () => {
    const rep = await checkModule(path.join(BAD, name));
    assert.ok(lines(rep).some((l) => l.level === 'yellow' && why.test(l.text)), lines(rep).map((l) => l.level + ' ' + l.text).join(' | '));
  });
}

test('the kit samples come out with no red line; the kit test host copy is recognised by its hash', async () => {
  const s = samples();
  try {
    const testhost = await sha(s.testhost);
    for (const n of ['hello-notes', 'advisor']) {
      const rep = await checkModule(path.join(s.dir, n), { testhost });
      assert.equal(rep.red, 0, n + ': ' + reds(rep).join(' | '));
      assert.ok(lines(rep).some((l) => /testhost\.js is the kit's test host, unchanged/.test(l.text)));
      assert.equal(rep.label.name, n === 'hello-notes' ? 'Hello notes' : rep.manifest.name);
    }
    const hn = await checkModule(path.join(s.dir, 'hello-notes'), { testhost });
    assert.deepEqual(hn.label.tools, ['notes_add']); assert.deepEqual(hn.label.hosts, []); assert.equal(hn.label.signed, 'Not signed.');
    assert.ok(hn.label.can.some((c) => /menu: Notes/.test(c)) && hn.label.can.some((c) => /asks a model/.test(c)), hn.label.can.join('; '));
    // without the kit's hash the test host is read as code, and its look for the kit's harness is red
    assert.ok((await checkModule(path.join(s.dir, 'hello-notes'))).red > 0);
  } finally { s.done(); }
});

test('nothing runs without a runner: the report says it was not run, in the words the caller gives', async () => {
  const rep = await checkModule(path.join(BAD, 'run-timer-chain'), { notRun: 'Not run here.' });
  assert.equal(rep.red, 0);
  assert.ok(lines(rep).some((l) => l.text === 'Not run here.'));
  assert.match(HONEST, /cannot prove that code is harmless/); assert.match(HONEST_DESK, /It does not run the module's code\. It cannot prove that code is harmless/);
  assert.match(HONEST_DESK, /Add a module only from someone you would run a program from\.$/);
});

test('shape: a taken id, number or official place, core kind and a folder that does not match are red', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-mc-shape-'));
  try {
    const d = path.join(tmp, 'mail'); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'module.json'), JSON.stringify({ id: 'mail', number: 17, name: 'M', description: 'A module that takes names the desk already uses.', kind: 'core', status: 'works', menu: [{ id: 'chat', label: 'Chat' }], pages: [] }));
    const r = reds(await checkModule(d, { deskModules: ['mail', 'chat'], deskNumbers: [17] })).join(' | ');
    assert.match(r, /already a module of the desk/); assert.match(r, /number 17 is already used/); assert.match(r, /cannot be "core"/); assert.match(r, /official places/);
    const h = path.join(tmp, 'other'); copyFolder(path.join(BAD, 'bad-eval'), h);
    assert.match(reds(await checkModule(h)).join(' '), /folder is called "other" but the id is "bad-eval"/);
    fs.writeFileSync(path.join(h, '.hidden'), 'x'); fs.symlinkSync('/etc/hostname', path.join(h, 'link.md')); fs.writeFileSync(path.join(h, 'run.exe'), 'MZ');
    const r2 = reds(await checkModule(h)).join(' | ');
    assert.match(r2, /hidden file/); assert.match(r2, /is a link/); assert.match(r2, /may hold only js, mjs, json, md, css, svg and png/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a zip: unpacked only under the temp folder it is given; climbing, absolute, backslash, link and twin names are refused', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-mc-zip-'));
  try {
    const own = path.join(tmp, 'own-tmp');
    const ok = path.join(tmp, 'ok.zip'); fs.writeFileSync(ok, makeZip([{ name: 'x1/module.json', data: '{"id":"x1"}' }, { name: 'x1/server.js', data: 'export function activate() {}' }]));
    const t = openTarget(ok, { tmpRoot: own });
    assert.ok(t.dir.startsWith(own + path.sep) && path.basename(t.dir) === 'x1' && fs.existsSync(path.join(t.dir, 'server.js')));
    t.cleanup(); assert.deepEqual(fs.readdirSync(own), [], 'nothing left behind');
    for (const [name, re] of [['x/../../evil.js', /would be written outside the folder/], ['/etc/evil.js', /outside the folder/], ['C:/evil.js', /outside the folder/], ['x\\..\\evil.js', /outside the folder/]]) {
      const f = path.join(tmp, 'bad.zip'); fs.writeFileSync(f, makeZip([{ name: 'x/module.json', data: '{}' }, { name, data: 'x' }]));
      assert.throws(() => openTarget(f, { tmpRoot: own }), re, name);
      assert.deepEqual(fs.readdirSync(own), [], 'a refused zip leaves no temp folder');
    }
    assert.throws(() => readZip(makeZip([{ name: 'x/a.js', data: 'x', link: true }])), /is a link/);
    assert.throws(() => readZip(makeZip([{ name: 'x/Server.js', data: 'a' }, { name: 'x/server.js', data: 'b' }])), /same name on Windows/);
    assert.throws(() => readZip(Buffer.from('not a zip at all')), /not a zip file/);
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'evil.js')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

for (const [name, why] of Object.entries(SKILLS)) test(`hostile skill ${name} is red for the right reason`, () => {
  const r = checkSkill(path.join(BAD, 'skills', name));
  assert.ok(r.lines.some((l) => l.level === 'red' && why.test(l.text)), r.lines.map((l) => l.level + ' ' + l.text).join('\n'));
});

test('a skill is text only: bundled scripts are left out, hidden characters are taken out', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-mc-skill-'));
  try {
    const d = path.join(tmp, 'tidy'); fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: tidy\ndescription: Use when tidying a list.\n---\n# Tidy\n\n1. Sort the list.\u00AD\n2. Remove repeats.\u200B\n');
    fs.writeFileSync(path.join(d, 'scripts', 'run.sh'), 'echo hi\n');
    const k = checkSkill(d);
    assert.ok(k.lines.some((l) => l.level === 'yellow' && /Left out: scripts\/run\.sh/.test(l.text)));
    assert.ok(k.red > 0, 'hidden characters are red');
    const s = deskSkill(k);
    assert.deepEqual(Object.keys(s).sort(), ['body', 'description', 'title']);
    assert.doesNotMatch(s.body, /[\u00AD\u200B]/); assert.match(s.body, /Sort the list\.\n2\. Remove repeats\.$/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a manifest written with objects where names belong gets plain lines, never [object Object]', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-mc-obj-'));
  try {
    const d = path.join(tmp, 'objs'); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'module.json'), JSON.stringify({ id: 'objs', number: 70, name: 'Objs', description: 'A module whose manifest has objects in its lists.', kind: 'switch-on', status: 'stub', tools: [{ name: 'objs_add' }], requires: [{ id: 'x' }], menu: [{ id: 'objs', label: { text: 'x' } }], pages: ['objs'] }));
    const rep = await checkModule(d);
    const all = lines(rep).map((l) => l.text).join(' | ');
    assert.doesNotMatch(all, /\[object Object\]/);
    assert.match(all, /"tools" must list tool names as text/); assert.match(all, /"requires" must be a list of names/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
