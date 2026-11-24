// A module's SQL touches its own m_<id>_ tables. Another module's tables are never written, and read only where a
// shipped module depends on it today (Memory reads Chat's chat options), by position and by what SQLite really opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openStorage } from '../app/core/storage.js';

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-tables-'));
  const s = openStorage(dir, path.join(dir, 'b'));
  s.exec("CREATE TABLE m_mail_accounts (id TEXT, email TEXT, smtp_host TEXT); INSERT INTO m_mail_accounts VALUES ('a', 'me@desk.test', '127.0.0.1')");
  s.exec("CREATE TABLE m_chat_chats (id TEXT, opts TEXT); INSERT INTO m_chat_chats VALUES ('c1', '{\"remember\":false}')");
  return { s, done: () => { s.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const refused = (fn, what) => assert.throws(fn, (e) => e.code === 'sql_forbidden' && /another module/.test(e.message), what);

test("a module cannot write another module's tables, in any form", () => {
  const { s, done } = store();
  try {
    const w = s.scope('weather');
    refused(() => w.run("UPDATE m_mail_accounts SET smtp_host = 'mail.attacker.example'"), 'update');
    refused(() => w.run("INSERT INTO m_mail_accounts VALUES ('b', 'x', 'y')"), 'insert');
    refused(() => w.run('DELETE FROM m_mail_accounts'), 'delete');
    refused(() => w.exec('DROP TABLE m_mail_accounts'), 'drop');
    refused(() => w.exec('CREATE TABLE m_weather_copy AS SELECT * FROM m_mail_accounts'), 'copy out through create-as-select');
    refused(() => w.run('INSERT INTO m_weather_x SELECT * FROM (SELECT * FROM m_mail_accounts)'), 'read inside a write');
    assert.equal(s.get('SELECT smtp_host FROM m_mail_accounts').smtp_host, '127.0.0.1', 'nothing changed');
    // even Memory, which may read one of Chat's tables, may not write it
    refused(() => s.scope('memory').run("UPDATE m_chat_chats SET opts = '{}'"), 'memory writes chat');
  } finally { done(); }
});

test("a module cannot read another module's tables, except the one read a shipped module depends on", () => {
  const { s, done } = store();
  try {
    const w = s.scope('weather');
    refused(() => w.all('SELECT email, smtp_host FROM m_mail_accounts'), 'plain select');
    refused(() => w.all('SELECT * FROM (SELECT email FROM m_mail_accounts)'), 'subquery');
    refused(() => w.all('SELECT 1 FROM sqlite_master, m_mail_accounts'), 'comma join');
    refused(() => w.all('WITH x AS (SELECT * FROM "m_mail_accounts") SELECT * FROM x'), 'quoted, in a with');
    refused(() => s.scope('memory').get('SELECT opts FROM m_chat_chats WHERE id = ?', 'c1'), 'Memory asks Chat for its options; it reads no table of Chat\'s');
    refused(() => s.scope('memory').all('SELECT * FROM m_mail_accounts'), 'Memory reads nothing else');
    // its own tables, the core tables a module may read, and its own migrations still work
    w.migrate(1, 'CREATE TABLE IF NOT EXISTS m_weather_days (day TEXT PRIMARY KEY, temp REAL)');
    w.run("INSERT INTO m_weather_days VALUES ('mon', 21)");
    assert.equal(w.get('SELECT temp FROM m_weather_days').temp, 21);
    assert.ok(Array.isArray(w.all('SELECT id FROM agents')));
    assert.ok(s.scope('mail').all('SELECT * FROM m_mail_accounts').length === 1, 'Mail reads its own');
  } finally { done(); }
});

test('a module whose id has a dash uses its own tables, and still not another module\'s', () => {
  const { s, done } = store();
  try {
    const h = s.scope('hello-notes');
    h.exec('CREATE TABLE IF NOT EXISTS m_hello_notes_items (id TEXT, text TEXT)');
    h.run("INSERT INTO m_hello_notes_items VALUES ('1', 'hi')");
    assert.equal(h.get('SELECT text FROM m_hello_notes_items').text, 'hi');
    h.migrate(1, 'CREATE TABLE IF NOT EXISTS m_hello_notes_more (id TEXT)');
    refused(() => h.all('SELECT * FROM m_mail_accounts'), 'another module, read');
  } finally { done(); }
});
