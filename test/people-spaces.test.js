// Work and Personal (contracts/PEOPLE.md, section 5): a person has two named spaces, each its own data folder with its
// own chats, memory, leads and jobs. The switcher offers Work and Personal after the PIN is given for that person. A
// person with only Work sees no choice and behaves exactly as today. Keys are each space's own (see the report: the full
// move to a shared keys.sqlite was deferred to keep the backup keeper-gate intact), never seen by another person or Incognito.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { testDesk } from './helpers/desk.js';
import { createBackup } from '../modules/backup/archive.js';

test('a person with only Work sees no Work/Personal choice and behaves as today', async () => {
  const t = await testDesk();   // one person (the keeper), no PIN: the open desk
  try {
    const me = await t.call('/api/people/me');
    assert.equal(me.json.space, 'work');
    assert.deepEqual(me.json.spaces, ['work'], 'only Work is offered');
    assert.equal(me.json.incognito, false, 'no Incognito mark');
    assert.deepEqual((await t.call('/api/people')).json.people[0].spaces, ['work']);
  } finally { await t.close(); }
});

test('Work and Personal are separate spaces; keys work in each and are seen by neither another person nor Incognito; Panic stops both', async () => {
  const t = await testDesk({ modules: ['chat', 'sales'] });
  const call = (p, o = {}, token) => t.call(p, { ...o, session: false, headers: token ? { 'x-apd-session': token } : {} });
  try {
    for (const id of ['chat', 'sales']) await call('/api/modules/' + id + '/on', { method: 'POST' }, t.desk.session);
    await call('/api/people/me/pin', { body: { pin: '2468' } }, t.desk.session);   // the keeper sets a PIN so people can be added
    const aId = (await call('/api/people', { body: { name: 'Person A', pin: '1111' } }, t.desk.session)).json.person.id;
    const bId = (await call('/api/people', { body: { name: 'Person B', pin: '2222' } }, t.desk.session)).json.person.id;

    // Person A enters (Work), makes a lead and adds a key in Work.
    let tA = (await call('/api/people/enter', { body: { id: aId, pin: '1111' } })).json.token;
    assert.deepEqual((await call('/api/people/me', {}, tA)).json.spaces, ['work'], 'before a Personal space exists, only Work is offered');
    assert.equal((await call('/api/m/sales/leads', { body: { company: 'Work Lead A', site: 'work-a.example' } }, tA)).status, 200);
    assert.equal((await call('/api/keys/services/serper', { body: { value: 'serper-work-key-of-A-12345' } }, tA)).status, 200);

    // A switches to Personal (no PIN: already entered for A). It starts empty: the Work lead and the Work key are not there.
    const sw = await call('/api/people/me/space', { body: { space: 'personal' } }, tA);
    assert.equal(sw.status, 200); assert.equal(sw.json.space, 'personal'); const tAp = sw.json.token;
    assert.deepEqual((await call('/api/people/me', {}, tAp)).json.spaces, ['work', 'personal'], 'now both are offered');
    assert.ok(!(await call('/api/m/sales/leads', {}, tAp)).json.leads.some(l => l.company === 'Work Lead A'), 'the Work lead is not in Personal');
    assert.equal(t.desk.spaceOf(aId, 'personal').core.services.get('serper'), null, 'the Work key is not in Personal');

    // A makes a lead and adds a key in Personal.
    assert.equal((await call('/api/m/sales/leads', { body: { company: 'Personal Lead A', site: 'personal-a.example' } }, tAp)).status, 200);
    assert.equal((await call('/api/keys/services/serper', { body: { value: 'serper-personal-key-of-A-67890' } }, tAp)).status, 200);

    // Back in Work: the Work lead and key are still there; the Personal lead is not. Keys work in each space.
    const back = await call('/api/people/me/space', { body: { space: 'work' } }, tAp); const tA2 = back.json.token;
    const workLeads = (await call('/api/m/sales/leads', {}, tA2)).json.leads.map(l => l.company);
    assert.ok(workLeads.includes('Work Lead A') && !workLeads.includes('Personal Lead A'), 'Work keeps its own lead only: ' + workLeads);
    assert.equal(t.desk.spaceOf(aId, 'work').core.services.get('serper'), 'serper-work-key-of-A-12345', 'the key works in Work');
    assert.equal(t.desk.spaceOf(aId, 'personal').core.services.get('serper'), 'serper-personal-key-of-A-67890', 'the key works in Personal');

    // Another person (B) sees none of A's keys, in neither of A's spaces.
    const tB = (await call('/api/people/enter', { body: { id: bId, pin: '2222' } })).json.token;
    assert.equal(t.desk.spaceOf(bId).core.services.get('serper'), null, 'B has no key of A');
    const bDump = JSON.stringify(t.desk.spaceOf(bId).core.storage.all('SELECT value FROM secrets'));
    assert.ok(!bDump.includes('serper-work-key-of-A') && !bDump.includes('serper-personal-key-of-A'), 'A\'s keys are nowhere in B\'s space');

    // Backup is per space: each space has its own database and its own backups folder, and a backup carries that space's keys.
    const wsp = t.desk.spaceOf(aId, 'work'), psp = t.desk.spaceOf(aId, 'personal');
    assert.notEqual(wsp.core.storage.file, psp.core.storage.file);
    assert.notEqual(wsp.core.storage.backupsDir, psp.core.storage.backupsDir);
    const zip = createBackup({ db: wsp.core.storage, workspace: wsp.core.storage.workspace, backupsDir: wsp.core.storage.backupsDir, includeKeys: true, version: '0.0.0' });
    assert.ok(fs.existsSync(zip.path), 'a per-space backup of A\'s Work was written');
    fs.rmSync(zip.path, { force: true });

    // Panic is the house's: one stop halts both of A's spaces.
    await call('/api/panic', { body: { reason: 'test' } });
    assert.ok(wsp.core.panic.halted && psp.core.panic.halted, 'Panic stopped both Work and Personal');
    await call('/api/panic/resume', { method: 'POST' }, tA2);
    assert.ok(!wsp.core.panic.halted && !psp.core.panic.halted);

    // Incognito of A reads none of A's keys either. (Opening Incognito ends this window's token, so it comes last.)
    const inc = await call('/api/people/incognito', { method: 'POST' }, tA2);
    assert.equal(t.desk.spaceForToken(inc.json.token).core.services.get('serper'), null, 'Incognito has no key of A');
    await call('/api/people/leave', { method: 'POST' }, inc.json.token);
  } finally { await t.close(); }
});
