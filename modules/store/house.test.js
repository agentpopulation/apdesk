// Putting a checked module in place: only the files the check read, module.json last, an old copy kept asleep.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { install, oldName, takeOut } from './house.js';
import { hashFolder } from '../../app/core/module-check/sig.mjs';
import { ADDED_FILE } from '../../app/core/modules.js';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-house-'));
  const src = path.join(root, 'src', 'quotes'); fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'module.json'), '{"id":"quotes"}'); fs.writeFileSync(path.join(src, 'server.js'), '// one\n'); fs.writeFileSync(path.join(src, 'quotes.test.js'), '// t\n');
  const mods = path.join(root, 'modules'); fs.mkdirSync(mods);
  return { root, src, mods, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a file changed after the check (even after the Admin was asked) refuses the copy and changes nothing', () => {
  const s = setup();
  try {
    const hashes = hashFolder(s.src, '');
    fs.appendFileSync(path.join(s.src, 'server.js'), '// two\n');
    assert.throws(() => install(s.src, 'quotes', s.mods, { hashes, record: {} }), /server\.js changed after it was checked\. Nothing was changed\./);
    assert.deepEqual(fs.readdirSync(s.mods), []);
  } finally { s.done(); }
});

test('the copy carries the record; a second one keeps the first asleep; take-out moves it into the kept folder', () => {
  const s = setup();
  try {
    const hashes = hashFolder(s.src, '');
    install(s.src, 'quotes', s.mods, { hashes, record: { from: 'file' } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.mods, 'quotes', ADDED_FILE), 'utf8')).from, 'file');
    const day = new Date('2026-11-22T10:00:00Z');
    const r = install(s.src, 'quotes', s.mods, { hashes, record: { from: 'file' }, date: day });
    assert.equal(r.kept, 'quotes.old-2026-11-22');
    assert.ok(fs.existsSync(path.join(s.mods, r.kept, 'module.json.old')) && fs.existsSync(path.join(s.mods, r.kept, 'quotes.test.js.old')));
    assert.equal(oldName(s.mods, 'quotes', day), 'quotes.old-2026-11-22-2');
    assert.throws(() => install(s.src, '../evil', s.mods, { hashes, record: {} }), /no usable id/);
    const name = takeOut(s.mods, 'quotes', path.join(s.root, 'kept'), day);
    assert.equal(name, 'quotes-2026-11-22'); assert.ok(!fs.existsSync(path.join(s.mods, 'quotes')));
  } finally { s.done(); }
});
