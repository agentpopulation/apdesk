// The last picture of an agent's browser: kept in the agent's own profile folder, served to the owner's window only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { keepLastShot, lastShot } from './server.js';
import { testDesk } from '../../test/helpers/desk.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);   // a stand-in picture

test('keepLastShot writes the picture and its time beside the profile; lastShot reads them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-shot-'));
  try {
    assert.equal(lastShot(dir, 'scout'), null, 'no pages opened yet');
    const at = Date.parse('2026-11-22T06:30:00Z');
    assert.equal(keepLastShot(dir, 'scout', { frame: JPEG, frameAt: at }), true);
    const s = lastShot(dir, 'scout');
    assert.deepEqual(s.jpeg, JPEG); assert.equal(s.at, new Date(at).toISOString());
    assert.ok(fs.existsSync(path.join(dir, 'profiles', 'scout', 'last-shot.jpg')));
    assert.equal(keepLastShot(dir, 'scout', { frame: null, frameAt: 0 }), false, 'nothing to keep');
    assert.equal(lastShot(dir, '../x'), null, 'an odd id stays inside its own folder');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the route gives the last picture with when it was taken, to the owner only', async () => {
  const t = await testDesk({ modules: ['browser'] });
  try {
    assert.equal((await t.call('/api/m/browser/scout/last-shot')).status, 204, 'none yet');
    keepLastShot(t.core.storage.dataDir, 'scout', { frame: JPEG, frameAt: Date.parse('2026-11-22T06:30:00Z') });
    assert.equal((await t.call('/api/m/browser/scout/last-shot', { session: false })).status, 403);
    const r = await fetch(t.base + '/api/m/browser/scout/last-shot', { headers: { 'x-apd-session': t.desk.session } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal(r.headers.get('x-taken'), '2026-11-22T06:30:00.000Z');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), JPEG);
  } finally { await t.close(); }
});
