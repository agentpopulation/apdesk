// The house's store of people (contracts/PEOPLE.md): data/desk.sqlite. PIN hashes, wrong tries and waits kept on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { People, waitAfter, SCRYPT } from '../app/core/people.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'apd-people-'));

test('the first person is made once, with no PIN, and is the keeper; the store has a version', () => {
  const dir = tmp();
  try {
    const p = new People({ dataDir: dir });
    const first = p.ensureFirst();
    assert.deepEqual(Object.keys(first).sort(), ['colour', 'emoji', 'hasPin', 'id', 'keeper', 'name']);
    assert.equal(first.keeper, true); assert.equal(first.hasPin, false);
    assert.equal(p.folderOf(first.id), dir, 'person 1 is the existing data folder as it is');
    p.close();
    const again = new People({ dataDir: dir }); again.ensureFirst();
    assert.equal(again.list().length, 1, 'made once');
    assert.equal(again.version(), 1);
    again.close();
    assert.ok(fs.existsSync(path.join(dir, 'desk.sqlite')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a PIN is a scrypt hash (N=2^15, r=8, p=1) with a 16-byte salt, compared with timingSafeEqual, and never leaves the store', async () => {
  const dir = tmp();
  const real = crypto.timingSafeEqual; let compares = 0;
  try {
    assert.deepEqual(SCRYPT, { N: 2 ** 15, r: 8, p: 1 });
    const p = new People({ dataDir: dir }); const k = p.ensureFirst();
    const b = await p.add({ name: 'Person B', emoji: '🙂', colour: '#336699', pin: '4821' });
    await assert.rejects(() => p.add({ name: 'Person C', pin: '12' }), /4 to 12 digits/);
    await assert.rejects(() => p.add({ name: 'Person C', pin: '1234567890123' }), /4 to 12 digits/);
    const row = new DatabaseSync(path.join(dir, 'desk.sqlite')).prepare('SELECT pin_hash, pin_salt FROM people WHERE id = ?').get(b.id);
    assert.equal(Buffer.from(row.pin_salt, 'base64').length, 16);
    assert.equal(Buffer.from(row.pin_hash, 'base64').length, 32);
    const again = await new Promise((r, j) => crypto.scrypt('4821', Buffer.from(row.pin_salt, 'base64'), 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 }, (e, x) => e ? j(e) : r(x.toString('base64'))));
    assert.equal(again, row.pin_hash);
    crypto.timingSafeEqual = (a, c) => { compares++; return real(a, c); };
    assert.equal((await p.verify(b.id, '0000')).ok, false);
    assert.equal((await p.verify(b.id, '4821')).ok, true);
    assert.equal(compares, 2, 'every PIN check goes through timingSafeEqual');
    const shown = JSON.stringify([p.list(), p.get(b.id), p.get(k.id)]);
    assert.ok(!shown.includes(row.pin_hash) && !shown.includes(row.pin_salt), 'the hash and salt are never in what a page is given');
    p.close();
  } finally { crypto.timingSafeEqual = real; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wrong tries: after 5 a wait of 30 seconds that doubles up to 15 minutes, kept on disk; the wait only ever refuses a wrong PIN', async () => {
  const dir = tmp(); let now = 1_000_000;
  try {
    assert.deepEqual([1, 4, 5, 6, 7, 8, 9, 10, 11, 50].map(waitAfter), [0, 0, 30000, 60000, 120000, 240000, 480000, 900000, 900000, 900000]);
    let p = new People({ dataDir: dir, now: () => now }); p.ensureFirst();
    const b = await p.add({ name: 'Person B', pin: '4821' });
    for (let i = 1; i <= 4; i++) { const r = await p.verify(b.id, '1111'); assert.equal(r.ok, false); assert.equal(r.waitSeconds, 0, 'try ' + i); }
    assert.equal((await p.verify(b.id, '1111')).waitSeconds, 30, 'the fifth wrong try starts the wait');
    const during = await p.verify(b.id, '1111');
    assert.equal(during.ok, false); assert.equal(during.waiting, true, 'a wrong PIN during the wait is refused'); assert.equal(during.waitSeconds, 30);
    assert.equal(p.waitSeconds(b.id), 30, 'a wrong PIN during the wait does not push the wait out further');
    p.close();
    p = new People({ dataDir: dir, now: () => now });                 // a restart does not reset it
    assert.equal((await p.verify(b.id, '1111')).waiting, true);
    now += 30000;
    assert.equal((await p.verify(b.id, '1111')).waitSeconds, 60, 'the next wrong try after the wait doubles it');
    for (let i = 0; i < 8; i++) { now += 15 * 60000; await p.verify(b.id, '1111'); }
    assert.equal(p.waitSeconds(b.id), 900, 'never more than 15 minutes');
    // No permanent lock: the right PIN enters even while a wait runs, so one person's wrong tries cannot lock another out.
    const r = await p.verify(b.id, '4821');
    assert.equal(r.ok, true, 'the right PIN works even during the wait: no permanent lock');
    assert.equal(r.wrongTries, 14, 'the person is told how many wrong tries there were');
    assert.equal(p.waitSeconds(b.id), 0, 'a right PIN clears the wait');
    assert.equal((await p.verify(b.id, '1111')).waitSeconds, 0, 'the count starts again after a right PIN');
    assert.equal(p.takeNotice(b.id).wrongTries, 15); assert.equal(p.takeNotice(b.id).wrongTries, 0, 'told once');
    p.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a wait set by one caller never locks another out: the right PIN always enters, even mid-wait', async () => {
  const dir = tmp(); const now = 2_000_000;
  try {
    const p = new People({ dataDir: dir, now: () => now }); p.ensureFirst();
    const b = await p.add({ name: 'Person B', pin: '4821' });
    for (let i = 0; i < 9; i++) await p.verify(b.id, '0000');      // a rival floods wrong tries
    assert.ok(p.waitSeconds(b.id) > 0, 'the rival armed a wait');
    const r = await p.verify(b.id, '4821');                        // the holder, who knows the PIN, is never shut out
    assert.equal(r.ok, true, 'the right PIN enters while the wait runs');
    assert.equal(p.waitSeconds(b.id), 0);
    p.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wrong tries sent all at once are checked one after another, so none skips the wait', async () => {
  const dir = tmp();
  try {
    const p = new People({ dataDir: dir }); p.ensureFirst();
    const b = await p.add({ name: 'Person B', pin: '4821' });
    const all = await Promise.all(Array.from({ length: 12 }, (_, i) => p.verify(b.id, String(1000 + i))));
    assert.equal(all.filter(r => !r.waiting).length, 5, 'only five PINs were checked');
    assert.equal(all.filter(r => r.waiting).length, 7);
    p.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reset by the keeper, the looks, and removal that only detaches the folder', async () => {
  const dir = tmp(); let now = Date.parse('2026-11-21T10:00:00Z');
  try {
    const p = new People({ dataDir: dir, now: () => now }); const k = p.ensureFirst();
    const b = await p.add({ name: 'Person B', pin: '4821' });
    assert.equal(p.folderOf(b.id), path.join(dir, 'people', b.id, 'work'));
    for (let i = 0; i < 5; i++) await p.verify(b.id, '0000');
    await p.resetPin(b.id, '7777', k.id);
    assert.equal(p.waitSeconds(b.id), 0, 'a reset ends the wait');
    assert.equal((await p.verify(b.id, '7777')).ok, true);
    const n = p.takeNotice(b.id);
    assert.equal(n.resetBy, k.name); assert.equal(n.resetAt, new Date(now).toISOString());
    assert.equal(p.takeNotice(b.id).resetBy, null, 'told once');
    assert.deepEqual(p.setLook(b.id, { name: 'Person B2', emoji: '🌻', colour: '#aa5500' }), { ...p.get(b.id) });
    assert.throws(() => p.setLook(b.id, { colour: 'red; background: url(x)' }), /colour/);
    assert.throws(() => p.setLook(b.id, { name: '' }), /name/);
    assert.throws(() => p.remove(k.id), /keeper/);
    const gone = p.remove(b.id);
    assert.equal(gone.folder, path.join(dir, 'people', b.id));
    assert.equal(p.get(b.id), null);
    p.clearPin(k.id, 'this PC');
    assert.equal(p.get(k.id).hasPin, false);
    p.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
