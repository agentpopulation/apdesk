// The people of this PC (contracts/PEOPLE.md), kept by the house in data/desk.sqlite: names and looks, PIN hashes and
// salts, wrong tries and waits, who the keeper is, and a version. Person 1 is the existing data folder as it is; a new
// person's space is data/people/<id>/work/. The PIN keeps people at this desk apart. It encrypts nothing.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });
const VERSION = 1;
const FREE_TRIES = 5, FIRST_WAIT = 30000, LONGEST_WAIT = 15 * 60000;
/** The wait after this many wrong tries in a row: none for the first four, then 30 seconds doubling up to 15 minutes. */
export const waitAfter = (wrong) => wrong < FREE_TRIES ? 0 : Math.min(LONGEST_WAIT, FIRST_WAIT * 2 ** Math.min(20, wrong - FREE_TRIES));
const hashPin = (pin, salt) => new Promise((resolve, reject) => crypto.scrypt(String(pin), salt, 32, { ...SCRYPT, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const pinRule = (pin) => { if (!/^\d{4,12}$/.test(String(pin ?? ''))) throw bad('A PIN is 4 to 12 digits.'); return String(pin); };
const LOOK = {
  name: (v) => { const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim(); if (!s || s.length > 40) throw bad('A name is 1 to 40 characters.'); return s; },
  emoji: (v) => { const s = String(v ?? '').trim(); if (s.length > 16 || /[\u0000-\u001f<>"'&]/.test(s)) throw bad('An emoji is one short picture.'); return s; },
  colour: (v) => { const s = String(v ?? '').trim().toLowerCase(); if (!/^#[0-9a-f]{6}$/.test(s)) throw bad('A colour is written like #3366aa.'); return s; },
};

export class People {
  constructor({ dataDir, now = Date.now }) {
    this.dataDir = dataDir; this.now = now; this.locks = new Map();
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'desk.sqlite');
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', colour TEXT NOT NULL DEFAULT '#5b6270',
        keeper INTEGER NOT NULL DEFAULT 0, folder TEXT NOT NULL, pin_hash TEXT, pin_salt TEXT, wrong INTEGER NOT NULL DEFAULT 0, wait_until INTEGER NOT NULL DEFAULT 0,
        missed INTEGER NOT NULL DEFAULT 0, reset_by TEXT, reset_at TEXT, created TEXT NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('version', ?)").run(String(VERSION));
  }
  version() { return Number(this.db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value) || 0; }
  row(id) { return this.db.prepare('SELECT * FROM people WHERE id = ?').get(String(id ?? '')) || null; }
  /** What a page may see of a person: never the hash, the salt or the tries. */
  shown(r) { return r ? { id: r.id, name: r.name, emoji: r.emoji, colour: r.colour, keeper: !!r.keeper, hasPin: !!r.pin_hash } : null; }
  /** At first start after this change: person 1, made from the existing desk, with no PIN, the keeper of this PC. */
  ensureFirst(name = '') {
    if (!this.db.prepare('SELECT 1 AS x FROM people LIMIT 1').get()) this.db.prepare("INSERT INTO people (id, name, keeper, folder, created) VALUES ('p1', ?, 1, '', ?)").run(String(name || 'Keeper').slice(0, 40), new Date(this.now()).toISOString());
    return this.keeper();
  }
  list() { return this.db.prepare('SELECT * FROM people ORDER BY keeper DESC, created, id').all().map(r => this.shown(r)); }
  get(id) { return this.shown(this.row(id)); }
  keeper() { return this.shown(this.db.prepare('SELECT * FROM people WHERE keeper = 1').get()); }
  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM people').get().n; }
  /** The space folder of a person: the data folder itself for person 1. */
  folderOf(id) { const r = this.row(id); return r ? (r.folder ? path.join(this.dataDir, r.folder) : this.dataDir) : null; }
  async add({ name, emoji = '', colour = '#5b6270', pin }) {
    const look = { name: LOOK.name(name), emoji: LOOK.emoji(emoji), colour: LOOK.colour(colour) };
    pinRule(pin);
    const id = 'p' + crypto.randomBytes(5).toString('hex');
    const salt = crypto.randomBytes(16); const hash = await hashPin(pin, salt);
    const folder = path.join('people', id, 'work');
    fs.mkdirSync(path.join(this.dataDir, folder), { recursive: true });
    this.db.prepare('INSERT INTO people (id, name, emoji, colour, keeper, folder, pin_hash, pin_salt, created) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)').run(id, look.name, look.emoji, look.colour, folder, hash.toString('base64'), salt.toString('base64'), new Date(this.now()).toISOString());
    return this.get(id);
  }
  /** Take a person off this desk. Their folder stays where it is; the answer says where. */
  remove(id) {
    const r = this.row(id); if (!r) throw bad('No such person.', 404);
    if (r.keeper) throw bad('The keeper of this PC stays.', 409);
    this.db.prepare('DELETE FROM people WHERE id = ?').run(r.id);
    return { id: r.id, folder: path.dirname(path.join(this.dataDir, r.folder)) };
  }
  waitSeconds(id) { const r = this.row(id); return r ? Math.max(0, Math.ceil((r.wait_until - this.now()) / 1000)) : 0; }
  /** Check a person's PIN. One check at a time per person, so tries sent together cannot skip the wait. A person with no
   *  PIN passes. The right PIN is honoured even while a wait runs: a wait only ever refuses a wrong PIN, so one person's
   *  wrong tries can never lock another out (contracts/PEOPLE.md). */
  verify(id, pin) {
    const key = String(id ?? '');
    const run = (this.locks.get(key) || Promise.resolve()).then(() => this.check(key, pin));
    const tail = run.catch(() => {}); this.locks.set(key, tail); tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }
  async check(id, pin) {
    const r = this.row(id); if (!r) throw bad('No such person.', 404);
    if (!r.pin_hash) return { ok: true, wrongTries: r.missed };
    const waiting = r.wait_until > this.now();
    const want = Buffer.from(r.pin_hash, 'base64');
    const got = await hashPin(String(pin ?? '').slice(0, 64), Buffer.from(r.pin_salt, 'base64'));
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) {   // the right PIN always enters, wait or no wait
      this.db.prepare('UPDATE people SET wrong = 0, wait_until = 0 WHERE id = ?').run(id);
      return { ok: true, wrongTries: r.missed };
    }
    // A wrong PIN while a wait runs is refused but does not push the wait out further, so an outsider cannot hold the
    // wait open for ever by sending one wrong try per window. The person is told, once, only of tries that were checked.
    if (waiting) return { ok: false, waiting: true, waitSeconds: this.waitSeconds(id) };
    const wrong = r.wrong + 1; const wait = waitAfter(wrong);
    this.db.prepare('UPDATE people SET wrong = ?, wait_until = ?, missed = missed + 1 WHERE id = ?').run(wrong, wait ? this.now() + wait : 0, id);
    return { ok: false, waiting: false, waitSeconds: Math.ceil(wait / 1000) };
  }
  /** What a person is told once, on their next entry: wrong tries since then, and who reset their PIN and when. */
  takeNotice(id) {
    const r = this.row(id); if (!r) return { wrongTries: 0, resetBy: null, resetAt: null };
    this.db.prepare('UPDATE people SET missed = 0, reset_by = NULL, reset_at = NULL WHERE id = ?').run(id);
    return { wrongTries: r.missed, resetBy: r.reset_by || null, resetAt: r.reset_at || null };
  }
  async setPin(id, pin) {
    pinRule(pin); if (!this.row(id)) throw bad('No such person.', 404);
    const salt = crypto.randomBytes(16); const hash = await hashPin(pin, salt);
    this.db.prepare('UPDATE people SET pin_hash = ?, pin_salt = ?, wrong = 0, wait_until = 0 WHERE id = ?').run(hash.toString('base64'), salt.toString('base64'), id);
  }
  /** The keeper gives a person a new PIN; the person is told who did it and when. */
  async resetPin(id, pin, byId) {
    const by = this.row(byId); await this.setPin(id, pin);
    this.db.prepare('UPDATE people SET reset_by = ?, reset_at = ? WHERE id = ?').run(by?.name || 'The keeper', new Date(this.now()).toISOString(), id);
  }
  /** The tool at the PC (setup/reset-pin.mjs): the person enters with no PIN until they set a new one. */
  clearPin(id, by) {
    if (!this.row(id)) throw bad('No such person.', 404);
    this.db.prepare('UPDATE people SET pin_hash = NULL, pin_salt = NULL, wrong = 0, wait_until = 0, reset_by = ?, reset_at = ? WHERE id = ?').run(String(by), new Date(this.now()).toISOString(), id);
  }
  /** A person's own name, emoji and colour. Nothing else changes here. */
  setLook(id, look) {
    if (!this.row(id)) throw bad('No such person.', 404);
    const keys = Object.keys(look || {});
    if (keys.some(k => !Object.hasOwn(LOOK, k))) throw bad('Only a name, an emoji and a colour change here.');
    const clean = Object.fromEntries(keys.map(k => [k, LOOK[k](look[k])]));   // all checked before any is written
    for (const k of keys) this.db.prepare(`UPDATE people SET ${k} = ? WHERE id = ?`).run(clean[k], id);
    return this.get(id);
  }
  close() { try { this.db.close(); } catch {} }
}
