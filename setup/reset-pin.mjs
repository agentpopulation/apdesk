// Forgot the keeper's PIN: run this at the PC, with the desk stopped (stop.bat), as  node setup/reset-pin.mjs
// It clears the PIN of the keeper of this PC, so the keeper enters with no PIN and sets a new one, and writes that to
// the keeper's activity log. It needs no PIN because the PIN protects nothing on disk (contracts/PEOPLE.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { People } from '../app/core/people.js';
import { openStorage } from '../app/core/storage.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = process.env.APD_DATA || path.join(ROOT, 'data');

/** The desk leaves desk.pid in the data folder while it runs. */
function deskRunning() {
  let pid = 0; try { pid = Number(fs.readFileSync(path.join(DATA, 'desk.pid'), 'utf8')); } catch { return false; }
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

if (!fs.existsSync(path.join(DATA, 'desk.sqlite'))) { console.log('This desk has no people yet, so there is no PIN to clear.'); process.exit(0); }
if (deskRunning()) { console.error('Stop the desk first (stop.bat), then run this again.'); process.exit(1); }
const people = new People({ dataDir: DATA });
try {
  const k = people.keeper();
  people.clearPin(k.id, 'the tool at this PC');
  const s = openStorage(people.folderOf(k.id));
  try { s.run('INSERT INTO activity (at, agent_id, action, title, how, detail) VALUES (?, ?, ?, ?, ?, ?)', new Date().toISOString(), null, 'people.pin.reset', 'The keeper\'s PIN was cleared at this PC (setup/reset-pin.mjs)', 'tool', null); }
  finally { s.close(); }
  console.log(`The PIN of ${k.name}, the keeper of this PC, is cleared. Start the desk: ${k.name} enters with no PIN, then sets a new one.`);
} finally { people.close(); }
