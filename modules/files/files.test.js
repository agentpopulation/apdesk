// Plumbing tests for Files (no model). Windows paths are checked with path.win32 on any OS.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { cleanRel, validName, joinInside, isInside, isBlocked, insideGranted, listDrives } from './explorer.js';
import { chunkText, pageRegions } from './knowledge.js';
import { testDesk } from '../../test/helpers/desk.js';

const W = path.win32;

test('Windows paths: drive letters, backslashes, case, escapes', () => {
  const root = 'C:\\apdesk\\data\\workspace';
  assert.equal(joinInside(root, 'reports\\q3.pdf', W).abs, 'C:\\apdesk\\data\\workspace\\reports\\q3.pdf');
  assert.equal(joinInside(root, 'reports/q3.pdf', W).abs, 'C:\\apdesk\\data\\workspace\\reports\\q3.pdf');
  for (const bad of ['..\\apd.sqlite', 'C:\\Windows', 'c:/x', '\\\\server\\share', '/etc', 'a/../../b', '~/x', 'a\0b']) assert.throws(() => joinInside(root, bad, W), /path|folder|allowed|relative/i, bad);
  assert.ok(isInside('C:\\Users\\Owner\\Downloads', 'c:\\users\\owner\\downloads\\a.txt', W), 'case-insensitive on Windows');
  assert.ok(!isInside('C:\\Users\\Owner\\Downloads', 'C:\\Users\\Owner\\Downloads2\\a.txt', W), 'a sibling with the same prefix is outside');
  assert.ok(isInside('C:\\', 'C:\\Users', W), 'a drive root holds its folders');
  const env = { dataDir: 'C:\\apdesk\\data', workspace: 'C:\\apdesk\\data\\workspace' };
  assert.ok(isBlocked(env, 'C:\\apdesk\\data\\apd.sqlite', W));
  assert.ok(isBlocked(env, 'c:\\APDESK\\data\\profiles\\scout', W));
  assert.ok(!isBlocked(env, 'C:\\apdesk\\data\\workspace\\x.md', W));
  assert.ok(insideGranted('C:\\Users\\Owner\\Downloads\\a.pdf', ['C:\\Users\\Owner\\Downloads'], W));
  assert.ok(!insideGranted('C:\\Users\\Owner\\Documents\\a.pdf', ['C:\\Users\\Owner\\Downloads'], W));
  assert.deepEqual(listDrives('win32', ['C', 'D']).map((d) => d.dir), ['C:\\', 'D:\\']);
});

test('names and paths', () => {
  assert.deepEqual(cleanRel('a//b/c'), ['a', 'b', 'c']);
  for (const n of ['a/b', 'CON', 'x.', 'a:b', '']) assert.throws(() => validName(n));
  assert.equal(validName(' report.xlsx '), 'report.xlsx');
});

test('knowledge chunking keeps pages', () => {
  const r = pageRegions('[page 1]\nalpha\n[page 2]\nbeta');
  assert.deepEqual(r.map((x) => x.page), [1, 2]);
  assert.ok(chunkText('x '.repeat(2000)).length > 1);
});

test('files: write asks the door, list/read, owner-only routes, Bin', async () => {
  const t = await testDesk({ modules: ['files'] });
  try {
    const files = t.core.modules.api('files');
    const w = await files.write('notes/a.md', '# hi', { agentId: 'scout', jobId: 'j' });
    assert.equal(w.how, 'level');
    assert.equal((await files.read('notes/a.md')).text, '# hi');
    assert.deepEqual((await files.list('notes')).items.map((i) => i.name), ['a.md']);
    await assert.rejects(() => files.write('../x', 'y'), /leaves/);
    await assert.rejects(() => files.write(path.join(t.dataDir, 'x.txt'), 'y'), /only inside the workspace/);
    assert.equal((await t.call('/api/m/files/list?root=home', { session: false })).status, 403);
    const listed = (await t.call('/api/m/files/list?root=home&path=notes')).json;
    assert.equal(listed.items[0].madeBy, 'Scout');
    await files.trash('notes/a.md', { agentId: 'scout' });
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'workspace', 'notes', 'a.md')));
    assert.equal((await t.call('/api/m/files/list?root=bin')).json.items.length, 1);
    const mk = await t.call('/api/m/files/mkdir', { body: { root: 'home', path: '', name: 'New folder' } });
    assert.equal(mk.json.name, 'New folder');
    const mv = await t.call('/api/m/files/rename', { body: { root: 'home', path: 'New folder', name: 'Plans' } });
    assert.equal(mv.json.path, 'Plans');
  } finally { await t.close(); }
});
