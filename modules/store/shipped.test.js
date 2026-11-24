// modules/shipped.json is the one list of the modules that ship with the desk. It is written by a tool
// (node tools/make-zip.mjs --shipped, and again into every zip) and this test keeps it true: every module folder here is
// in it unless the Module Store added it (it carries .apd-added.json) or it is an old copy kept asleep (<id>.old-<date>).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shippedFolders, writeShipped } from '../../tools/make-zip.mjs';
import { ADDED_FILE } from '../../app/core/modules.js';

const MODS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('modules/shipped.json names exactly the built-in module folders of this copy', () => {
  const rec = JSON.parse(fs.readFileSync(path.join(MODS, 'shipped.json'), 'utf8'));
  assert.deepEqual(rec.entries, [...shippedFolders(MODS), 'shipped.json'], 'run: node tools/make-zip.mjs --shipped');
  for (const n of rec.entries.filter(e => e !== 'shipped.json')) assert.ok(fs.existsSync(path.join(MODS, n, 'module.json')), `${n} has a module.json`);
});

test('the tool leaves out a module the Store added and an old copy kept asleep', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-shipped-'));
  try {
    for (const d of ['chat', 'mine', 'mine.old-2026-11-22']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'mine', ADDED_FILE), '{}');
    assert.deepEqual(writeShipped(dir, '0.1.2').entries, ['chat', 'shipped.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
