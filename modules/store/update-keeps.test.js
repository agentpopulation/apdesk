// The update step keeps a module the Module Store added (contracts/UPDATES.md "Module folders the owner added stay"):
// tried here for a module added the Store's way, with its record, through a real staged update and its rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeKeys, releaseZip, release, standIn, fakeInstall } from '../../test/helpers/update.js';
import { createDesk } from '../../app/server.js';
import { Updater } from '../../app/core/update.js';
import { SETTINGS_TOKEN } from '../../app/core/approval-door.js';
import { shippedIn, addedRecord, ADDED_FILE } from '../../app/core/modules.js';
import { install } from './house.js';
import { hashFolder } from '../../app/core/module-check/sig.mjs';

const runApply = (root) => spawnSync(process.execPath, [path.join(root, 'setup', 'apply-update.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, APD_DATA: '' } });

test('an update keeps a module the Store added, record and all, and a rollback keeps it too', async () => {
  const s = await standIn(); const k = makeKeys(); const root = fakeInstall();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-added-'));
  try {
    // the Store's way: a checked folder copied in with its record
    const dir = path.join(src, 'quotes'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({ id: 'quotes', number: 61, name: 'Quotes', kind: 'switch-on', status: 'stub' }));
    fs.writeFileSync(path.join(dir, 'server.js'), 'export async function activate() { return { deactivate() {} }; }\n');
    install(dir, 'quotes', path.join(root, 'modules'), { hashes: hashFolder(dir, ''), record: { from: 'file', at: '2026-11-22T10:00:00.000Z', signedBy: null, label: { can: [], hosts: [], tools: [], signed: 'Not signed.', red: 0, yellow: 1 } } });
    assert.ok(!shippedIn(path.join(root, 'modules')).has('quotes'), 'custom: not in the record of what shipped');

    const zip = releaseZip('0.1.1'); s.publish(release('0.1.1', zip, k), zip);
    const desk = await createDesk({ dataDir: path.join(root, 'data'), port: 0, quiet: true, env: {}, modules: ['backup'] });
    await desk.start();
    try {
      desk.core.updater = new Updater(desk.core, { root, repo: s.repo, hosts: [s.host], keys: [k.entry] });
      const run = desk.core.updater.install(SETTINGS_TOKEN);
      for (let i = 0; i < 200; i++) { const p = desk.core.approval.listPending().find(a => a.payload?.kind === 'desk-update'); if (p) { desk.core.approval.decide(p.id, 'approve', 'owner'); break; } await new Promise(r => setTimeout(r, 10)); }
      assert.equal((await run).ok, true);
    } finally { await desk.stop(); }

    const out = runApply(root);
    assert.match(out.stdout, /updated from 0\.1\.0 to 0\.1\.1/, out.stdout + out.stderr);
    assert.match(out.stdout, /Kept the module folder you added: quotes\./);
    const here = path.join(root, 'modules', 'quotes');
    assert.ok(fs.existsSync(path.join(here, 'server.js')) && fs.existsSync(path.join(here, ADDED_FILE)));
    assert.equal(addedRecord(here).from, 'file', 'its record came with it');
    assert.ok(!shippedIn(path.join(root, 'modules')).has('quotes'), 'still custom after the update');
    const back = runApply(root);
    assert.match(back.stdout, /did not start\. The desk is back on 0\.1\.0\./, back.stdout + back.stderr);
    assert.ok(fs.existsSync(path.join(here, ADDED_FILE)), 'and after the rollback');
  } finally { await s.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});
