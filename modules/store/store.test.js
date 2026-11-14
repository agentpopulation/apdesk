// The Module Store's catalog matches the manifests in this build and the 16 / 13 / 1 grouping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { CATALOG, merge } from './ui-catalog.js';
const MODS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('catalog: 30 modules, 16 core, 13 switch-on, 1 parked, numbers 1 to 30', () => {
  assert.equal(CATALOG.length, 30);
  assert.deepEqual(CATALOG.map(c => c.number), Array.from({ length: 30 }, (_, i) => i + 1));
  const count = (k) => CATALOG.filter(c => c.kind === k).length;
  assert.equal(count('core'), 16); assert.equal(count('switch-on'), 13); assert.equal(count('parked'), 1);
});

test('catalog agrees with every module.json in this build', () => {
  for (const c of CATALOG) {
    const f = path.join(MODS, c.id, 'module.json');
    if (!fs.existsSync(f)) continue;          // a catalog entry without a module folder
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(m.number, c.number, `${c.id} number`);
    assert.equal(m.kind, c.kind, `${c.id} kind`);
  }
});

test('merge shows every catalog module once and marks missing ones', () => {
  const out = merge([{ id: 'mail', number: 17, name: 'Mail', kind: 'switch-on', on: true }, { id: 'demo', number: 99, name: 'Demo' }]);
  assert.equal(out.length, 31);
  assert.equal(out.find(m => m.id === 'mail').installed, true);
  assert.equal(out.find(m => m.id === 'chat').installed, false);
});
