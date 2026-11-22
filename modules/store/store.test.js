// The Module Store's catalog matches the module folders and manifests in this build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { CATALOG, merge } from './ui-catalog.js';
const MODS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every module folder that has a manifest.
const FOLDERS = fs.readdirSync(MODS, { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(MODS, d.name, 'module.json'))).map(d => d.name);
const manifest = (id) => JSON.parse(fs.readFileSync(path.join(MODS, id, 'module.json'), 'utf8'));

test('catalog lists every module folder in this build, once, and nothing else', () => {
  assert.deepEqual(CATALOG.map(c => c.id).sort(), [...FOLDERS].sort());
  assert.equal(new Set(CATALOG.map(c => c.number)).size, CATALOG.length, 'numbers are unique');
});

test('catalog groups match the manifests (counted, not typed)', () => {
  for (const kind of ['core', 'switch-on', 'parked']) {
    assert.equal(CATALOG.filter(c => c.kind === kind).length, FOLDERS.filter(id => manifest(id).kind === kind).length, kind);
  }
});

test('no module text carries a typed module count', () => {
  for (const id of FOLDERS) assert.doesNotMatch(manifest(id).description || '', /\b\d+ modules\b/, id);
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
  assert.equal(out.length, CATALOG.length + 1);
  assert.equal(out.find(m => m.id === 'mail').installed, true);
  assert.equal(out.find(m => m.id === 'chat').installed, false);
});
