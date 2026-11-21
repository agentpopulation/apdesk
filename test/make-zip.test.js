// The zip's record of what it shipped (tools/make-zip.mjs); the zip itself is built only by the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { writeShipped } from '../tools/make-zip.mjs';

test('make-zip: modules/shipped.json names every shipped module folder, sorted, plus itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-zip-'));
  try {
    for (const d of ['tables', 'chat', 'bench']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
    const rec = writeShipped(dir, '0.2.0');
    assert.deepEqual(rec, { version: '0.2.0', entries: ['bench', 'chat', 'tables', 'shipped.json'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'shipped.json'), 'utf8')), rec);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
