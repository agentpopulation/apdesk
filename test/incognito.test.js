// Incognito (contracts/PEOPLE.md, section 5): a full space on an in-memory database with a scratch folder. The owner's
// rule is that Incognito remembers NOTHING. These tests prove it: the canary test (every durable file's hash is the same
// after an Incognito session, apart from the one amount-only spend row; the canary string is nowhere durable; the scratch
// folder is gone), that Incognito reads none of the person's real data, that Bench/schedules/downloads are refused, and
// that spend still counts toward the person's own limit so a reached limit stops it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { testDesk } from './helpers/desk.js';

const CANARY = 'canaryzqmarker';   // short plain word: distinctive to grep, and not flagged as a secret by Memory
const now = () => new Date().toISOString();

/** Every file (not dir) under root, as abs path -> sha256 of its bytes. */
function treeHashes(root) {
  const out = new Map();
  const walk = (dir) => { let names = []; try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) { const abs = path.join(dir, n); let st; try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs); else if (st.isFile()) out.set(abs, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')); } };
  walk(root); return out;
}
/** Does any file under root contain the needle (bytes)? */
function anyFileHas(root, needle) {
  const nb = Buffer.from(needle);
  for (const abs of treeHashes(root).keys()) { try { if (fs.readFileSync(abs).includes(nb)) return abs; } catch {} }
  return null;
}
/** A full dump of every table of a SQLite db (through the storage door), to compare contents before and after. */
function dumpDb(storage) {
  const tables = storage.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
  const out = {};
  for (const t of tables) { try { out[t] = storage.all(`SELECT * FROM "${t}"`); } catch { out[t] = null; } }
  return out;
}

test('canary: an Incognito session leaves nothing durable but the one amount-only spend row', async () => {
  const t = await testDesk({ modules: ['chat', 'memory', 'bench'] });
  const dataDir = t.dataDir; const backupsDir = t.core.storage.backupsDir;
  const keeper = t.desk.people.keeper();
  const call = (p, o = {}, token) => t.call(p, { ...o, session: false, headers: token ? { 'x-apd-session': token } : {} });
  try {
    // Modules are the house's choice; turn them on before the baseline so Incognito (which reads the house) starts them too.
    for (const id of ['chat', 'memory', 'bench']) await call('/api/modules/' + id + '/on', { method: 'POST' }, t.desk.session);
    // Seed the person's REAL space, to later prove Incognito reads none of it, and to give the keeper a real spend ledger.
    await t.call('/api/m/chat/chats', { body: { title: 'real chat of the person' } });
    await t.core.modules.api('memory').remember({ text: 'the real office opens at nine', wait: true });   // wait so its embedding call is logged before the baseline
    t.core.storage.run("INSERT INTO calls (at, cost_minor, currency, provider, model, ok) VALUES (?, 1500, 'INR', 'x', 'y', 1)", now());
    await new Promise(r => setTimeout(r, 50));   // let any trailing async writes to the real desk settle before the baseline

    const before = new Map([...treeHashes(dataDir), ...treeHashes(backupsDir)]);
    const beforeDb = dumpDb(t.core.storage);
    const tmp = os.tmpdir(); const tmpBefore = new Set(fs.readdirSync(tmp));   // only entries Incognito newly creates in the OS temp folder are checked

    // Enter Incognito from the keeper's open window.
    const inc = await call('/api/people/incognito', { method: 'POST' }, t.desk.session);
    assert.equal(inc.status, 200, JSON.stringify(inc.json));
    const incToken = inc.json.token; assert.ok(incToken);
    assert.ok(Array.isArray(inc.json.cautions) && inc.json.cautions.some(c => /spend still counts/i.test(c)), 'the screen says spend still counts');
    const space = t.desk.spaceForToken(incToken);
    assert.ok(space?.core.incognito, 'the window answers from an Incognito space');
    const scratch = space.core.incognito.scratch;
    assert.ok(fs.existsSync(scratch), 'the scratch folder exists while in Incognito');

    // It reads none of the person's real data: their real chat and their learned memory are not there.
    const incChats = (await call('/api/m/chat/chats', {}, incToken)).json.chats.map(c => c.title);
    assert.ok(!incChats.includes('real chat of the person'), 'the real chat is not carried in: ' + incChats.join(', '));
    assert.equal(space.core.modules.api('memory').list().length, 0, 'no memory carried in');

    // The canary writes: a chat, a learned memory, a Finder page read (stand-in file), a fake browser visit (profile
    // stand-in file), a rating, an approved fake mail, and a paid spend.
    await space.run(async () => {
      space.core.modules.api('chat').createChat({ title: CANARY + ' chat' });
      await space.core.modules.api('memory').remember({ text: 'the note to remember is ' + CANARY, wait: true });
      const ask = space.core.approval.request({ action: 'send.person', title: 'Mail about ' + CANARY, agentId: 'closer', payload: { to: 'x@example.com', subject: CANARY, text: CANARY } });
      await new Promise(r => setTimeout(r, 20));
      space.core.approval.decide(space.core.approval.listPending()[0].id, 'approve', 'owner');
      await ask;
    });
    fs.writeFileSync(path.join(scratch, 'workspace', 'reports', 'canary-finder.txt'), CANARY + ' finder');
    fs.writeFileSync(path.join(scratch, 'profiles', 'canary-visit.txt'), CANARY + ' visit');
    assert.equal((await call('/api/m/bench/ratings', { body: { targetType: 'answer', targetId: 'c1', thumb: 'up', comment: CANARY } }, incToken)).status, 200);
    space.core.storage.run("INSERT INTO calls (at, cost_minor, currency, provider, model, ok) VALUES (?, 700, 'INR', 'paid', 'gpt', 1)", now());

    // The canary really is in the Incognito space (in RAM and the scratch folder) while it is open.
    assert.ok(anyFileHas(scratch, CANARY), 'the canary is in the scratch folder while open');

    // Leave: the in-memory db is dropped, the scratch folder deleted, the spend carried back as one amount-only row.
    const left = await call('/api/people/leave', { method: 'POST' }, incToken);
    assert.equal(left.status, 200);
    assert.ok(!fs.existsSync(scratch), 'the scratch folder is gone after leaving');
    assert.equal(t.desk.spaceForToken(incToken), null, 'the Incognito window is gone');

    // 1) The canary is nowhere durable: not under data/, not under backups/, and in nothing Incognito created in the OS temp folder.
    assert.equal(anyFileHas(dataDir, CANARY), null, 'canary not under data/');
    assert.equal(anyFileHas(backupsDir, CANARY), null, 'canary not under backups/');
    for (const n of fs.readdirSync(tmp)) if (!tmpBefore.has(n)) assert.equal(anyFileHas(path.join(tmp, n), CANARY), null, 'canary not in a new OS temp entry: ' + n);

    // 2) The file listing and hashes are identical, apart from the person's own apd.sqlite (which gained the one spend row).
    const after = new Map([...treeHashes(dataDir), ...treeHashes(backupsDir)]);
    const keeperDb = new Set([t.core.storage.file, t.core.storage.file + '-wal', t.core.storage.file + '-shm']);
    const changed = [];
    for (const [f, h] of after) if (before.get(f) !== h) changed.push(f);
    for (const f of before.keys()) if (!after.has(f)) changed.push(f);
    const notAllowed = changed.filter(f => !keeperDb.has(f));
    assert.deepEqual(notAllowed, [], 'the only durable file that changed is the person\'s own database: ' + notAllowed.join(', '));

    // 3) The person's database changed by exactly one row: an approved spend, amount only, no content, no canary.
    const afterDb = dumpDb(t.core.storage);
    for (const tbl of Object.keys(afterDb)) {
      if (tbl === 'approvals') continue;
      assert.deepEqual(afterDb[tbl], beforeDb[tbl] ?? [], `table ${tbl} is unchanged by the Incognito session`);
    }
    const newRows = afterDb.approvals.filter(r => !(beforeDb.approvals || []).some(b => b.id === r.id));
    assert.equal(newRows.length, 1, 'exactly one new approvals row');
    const row = newRows[0];
    assert.equal(row.action, 'spend'); assert.equal(row.status, 'approved'); assert.equal(row.how, 'incognito');
    assert.equal(row.amount, 700, 'the row holds the amount spent in Incognito'); assert.equal(row.currency, t.core.settings.get('currency'), 'in the person\'s own currency');
    assert.equal(row.payload, 'null'); assert.equal(row.detail, null);
    assert.ok(!JSON.stringify(row).includes(CANARY), 'the spend row holds no content');
  } finally { await t.close(); }
});

test('Incognito spend counts toward the person\'s own limit, and a reached limit stops it', async () => {
  const t = await testDesk();
  const call = (p, o = {}, token) => t.call(p, { ...o, session: false, headers: token ? { 'x-apd-session': token } : {} });
  try {
    // The person's own day limit is 100 (minor units), and they have already spent 60 on their real desk.
    t.core.settings.set('spend.perDay', 100); t.core.settings.set('spend.perMonth', 100000); t.core.settings.set('currency', 'INR');
    t.core.storage.run("INSERT INTO calls (at, cost_minor, currency, provider, model, ok) VALUES (?, 60, 'INR', 'x', 'y', 1)", now());
    assert.equal(t.core.approval.spent('day'), 60);

    const inc = await call('/api/people/incognito', { method: 'POST' }, t.desk.session);
    const space = t.desk.spaceForToken(inc.json.token);
    // Incognito reads the person's own limit, and the person's day total is already counted inside it.
    assert.equal(space.core.approval.limits().perDay, 100, 'Incognito reads the person\'s own limit');
    assert.equal(space.core.approval.spent('day'), 60, 'the person\'s day total is counted inside Incognito');
    // Spending 30 more in Incognito is under the limit; 50 would pass it.
    assert.equal(space.core.approval.overLimit(30), null);
    assert.equal(space.core.approval.overLimit(50), 'daily limit');
    space.core.storage.run("INSERT INTO calls (at, cost_minor, currency, provider, model, ok) VALUES (?, 30, 'INR', 'paid', 'm', 1)", now());
    assert.equal(space.core.approval.spent('day'), 90, 'now 60 real + 30 Incognito');
    // At the limit, Incognito is stopped: a further spend is over the limit and the model door\'s spend guard trips.
    assert.equal(space.core.approval.overLimit(20), 'daily limit');
    assert.equal(space.core.model.spendGuard(), null);   // 90 < 100 still
    space.core.storage.run("INSERT INTO calls (at, cost_minor, currency, provider, model, ok) VALUES (?, 10, 'INR', 'paid', 'm', 1)", now());
    assert.equal(space.core.model.spendGuard(), 'daily spend limit', 'at 100% the model door stops the call');

    await call('/api/people/leave', { method: 'POST' }, inc.json.token);
    // On leaving, the 40 spent in Incognito is added to the person\'s own day total as one row.
    assert.equal(t.core.approval.spent('day'), 100, '60 real + 40 carried back from Incognito');
  } finally { await t.close(); }
});

test('Bench, schedules and downloads are refused in Incognito, with plain words', async () => {
  const t = await testDesk({ modules: ['bench', 'flows'] });
  const call = (p, o = {}, token) => t.call(p, { ...o, session: false, headers: token ? { 'x-apd-session': token } : {} });
  try {
    for (const id of ['bench', 'flows']) await call('/api/modules/' + id + '/on', { method: 'POST' }, t.desk.session);
    const inc = await call('/api/people/incognito', { method: 'POST' }, t.desk.session);
    const tok = inc.json.token;
    const bench = await call('/api/m/bench/start', { method: 'POST' }, tok);
    assert.equal(bench.status, 403); assert.match(bench.json.error, /Bench does not run in Incognito/);
    const sched = await call('/api/m/flows/schedules', { body: { when: 'every day at 8', prompt: 'brief me' } }, tok);
    assert.equal(sched.status, 403); assert.match(sched.json.error, /Schedules do not run in Incognito/);
    const dl = await call('/api/local-engine/get', { method: 'POST' }, tok);
    assert.equal(dl.status, 403); assert.match(dl.json.error, /Downloads do not run in Incognito/);
    // The schedule tool is refused on the agent path too.
    await assert.rejects(() => t.desk.spaceForToken(tok).core.modules.runTool('schedule_create', { when: 'daily', prompt: 'x' }, {}), /Incognito/);
    await call('/api/people/leave', { method: 'POST' }, tok);
  } finally { await t.close(); }
});
