// The owner's model keys through a real module door: only the Models module (named in the core) may add, switch or
// remove them. Any other module, and an added module whose folder is called "models", gets the list of keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDesk } from './helpers/desk.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAB = fs.readFileSync(path.join(HERE, '..', 'tools', 'safety', 'fixtures', 'keygrab-modules', 'keygrab', 'server.js'), 'utf8');

function folderWith(ids, { shipped = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-keys-'));
  for (const id of ids) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'module.json'), JSON.stringify({ id, number: 900 + ids.indexOf(id), name: 'Key grab ' + id, description: 'A test module that tries the owner\'s model keys.', kind: 'switch-on', status: 'works' }));
    fs.writeFileSync(path.join(dir, id, 'server.js'), GRAB);
  }
  if (shipped) fs.writeFileSync(path.join(dir, 'shipped.json'), JSON.stringify({ entries: shipped }));
  return dir;
}

test('a module that is not Models gets the key list only, and plants nothing', async () => {
  const dir = folderWith(['keygrab']);
  const t = await testDesk({ modulesDir: dir });
  try {
    await t.core.modules.set('keygrab', true);
    const r = t.core.modules.api('keygrab').tryKeys();
    assert.equal(r.list, true);
    assert.deepEqual([r.add, r.toggle, r.remove, r.tier, r.added], [false, false, false, false, false]);
    assert.ok(!JSON.stringify(t.core.model.listKeys()).includes('PLANTED'));
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an added module whose folder is called models is not the Models module', async () => {
  const dir = folderWith(['models'], { shipped: [] });   // not in shipped.json: custom
  const t = await testDesk({ modulesDir: dir });
  try {
    assert.equal(t.core.modules.list().find(m => m.id === 'models').custom, true);
    await t.core.modules.set('models', true);
    const r = t.core.modules.api('models').tryKeys();
    assert.deepEqual([r.add, r.toggle, r.remove, r.tier], [false, false, false, false]);
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the built-in Models module gets the key changes; a caller that names no module gets none', async () => {
  const dir = folderWith(['models'], { shipped: ['models'] });
  const t = await testDesk({ modulesDir: dir });
  try {
    await t.core.modules.set('models', true);
    const r = t.core.modules.api('models').tryKeys();
    assert.deepEqual([r.add, r.toggle, r.remove, r.tier], [true, true, true, true]);
    assert.equal(t.core.model.forModule().keys.add, undefined);
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
