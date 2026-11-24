// Module Store: Add a module (a zip chosen in the browser), Build it here (the starter), Ask to add it (the Admin
// approves, as an install), replace, remove, Incognito, and the kit's hostile samples refused or marked exactly as the
// kit's own check does (one shared list: app/core/module-check/hostile.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDesk } from '../../test/helpers/desk.js';
import { makeZip } from '../../app/core/module-check/fixtures/zip-writer.mjs';
import { readZip } from '../../app/core/module-check/zip.mjs';
import { REFUSED, MARKED, RUN_ONLY } from '../../app/core/module-check/hostile.mjs';
import { ADDED_FILE } from '../../app/core/modules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAD = path.join(HERE, '..', '..', 'app', 'core', 'module-check', 'fixtures', 'bad');
const KIT = path.join(HERE, 'kit', 'apdesk-module-kit-0.1.zip');

/** A zip of a folder (its files under <name>/), or of the kit's sample. */
function zipOf(dir, name = path.basename(dir)) {
  const out = [];
  (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(p, r); else out.push({ name: name + '/' + r, data: fs.readFileSync(p) }); } })(dir, '');
  return makeZip(out);
}
function sampleZip(id) {
  const pre = `apdesk-module-kit/samples/${id}/`;
  return makeZip(readZip(KIT).filter((e) => !e.dir && e.name.startsWith(pre)).map((e) => ({ name: id + '/' + e.name.slice(pre.length), data: e.data })));
}
/** A desk on its own modules folder: the real Store (linked) and one built-in stand-in, with the record of what shipped. */
async function storeDesk({ script } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-store-'));
  fs.symlinkSync(HERE, path.join(dir, 'store'));
  fs.mkdirSync(path.join(dir, 'alpha')); fs.writeFileSync(path.join(dir, 'alpha', 'module.json'), JSON.stringify({ id: 'alpha', number: 17, name: 'Alpha', kind: 'switch-on', status: 'stub' }));
  fs.writeFileSync(path.join(dir, 'shipped.json'), JSON.stringify({ version: '0.1.2', entries: ['alpha', 'store', 'shipped.json'] }));
  const t = await testDesk({ modulesDir: dir, script });
  const send = async (zip, token = t.desk.session) => { const r = await fetch(t.base + '/api/m/store/check', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-apd-session': token }, body: zip }); return { status: r.status, json: await r.json() }; };
  const pending = async (core = t.core, ms = 3000) => { for (let i = 0; i < ms / 20; i++) { const p = core.approval.listPending().find((a) => a.action === 'install'); if (p) return p; await new Promise((r) => setTimeout(r, 20)); } return null; };
  const until = async (fn, ms = 3000) => { for (let i = 0; i < ms / 20; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
  return { t, dir, send, pending, until, async close() { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const allLines = (j) => (j.report?.sections || j.request?.lines || []).flatMap((s) => s.lines);

test('every hostile sample is refused or marked by Add a module exactly as by the kit check', async () => {
  const s = await storeDesk();
  try {
    for (const [name, why] of Object.entries(REFUSED)) {
      const r = await s.send(zipOf(path.join(BAD, name)));
      assert.equal(r.status, 200, name); assert.equal(r.json.refused, true, name);
      assert.ok(allLines(r.json).some((l) => l.level === 'red' && why.test(l.text)), name + ': ' + allLines(r.json).map((l) => l.text).join(' | '));
      assert.match(r.json.honest, /cannot prove that code is harmless/);
    }
    for (const [name, why] of Object.entries(MARKED)) {
      const r = await s.send(zipOf(path.join(BAD, name)));
      assert.equal(r.json.refused, false, name);
      assert.ok(allLines(r.json).some((l) => l.level === 'yellow' && why.test(l.text)), name);
    }
    for (const name of Object.keys(RUN_ONLY)) {
      const r = await s.send(zipOf(path.join(BAD, name)));
      assert.equal(r.json.refused, false, name + ' is seen only by the kit\'s locked-down run');
      assert.ok(allLines(r.json).some((l) => /never runs its code to check it/.test(l.text)), 'the Store says it did not run it');
    }
    const kept = fs.readdirSync(path.join(s.t.dataDir, 'module-store', 'requests'));
    assert.equal(kept.length, Object.keys(MARKED).length + Object.keys(RUN_ONLY).length, 'a refused module leaves nothing behind');
    assert.deepEqual(fs.readdirSync(path.join(s.t.dataDir, 'module-store', 'tmp')), [], 'and no temp folder');
  } finally { await s.close(); }
});

test('a zip that climbs out, a file that is not a zip, and one that is too large are refused in plain words', async () => {
  const s = await storeDesk();
  try {
    const climb = await s.send(makeZip([{ name: 'x/module.json', data: '{}' }, { name: 'x/../../../escaped.js', data: 'x' }]));
    assert.equal(climb.status, 400); assert.match(climb.json.error, /^Refused: the entry .*outside the folder\. Nothing was added\.$/);
    assert.ok(!fs.existsSync(path.join(s.t.dataDir, 'module-store', 'escaped.js')) && !fs.existsSync(path.join(s.t.dataDir, 'escaped.js')));
    assert.match((await s.send(Buffer.from('hello'))).json.error, /not a zip file/);
    const big = await s.send(Buffer.alloc(6 * 1024 * 1024));
    assert.equal(big.status, 413); assert.match(big.json.error, /larger than 5 MB/);
    assert.deepEqual(fs.readdirSync(path.join(s.t.dataDir, 'module-store', 'tmp')), []);
  } finally { await s.close(); }
});

test('add a module: checked, asked, the Admin approves, found without a restart, custom and off; a second copy replaces it and keeps the old one asleep', async () => {
  const s = await storeDesk();
  try {
    const r = await s.send(sampleZip('hello-notes'));
    assert.equal(r.json.refused, false, JSON.stringify(r.json).slice(0, 400));
    const q = r.json.request;
    assert.equal(q.red, 0); assert.deepEqual(q.label.tools, ['notes_add']); assert.equal(q.label.signed, 'Not signed.');
    const ask = await s.t.call(`/api/m/store/requests/${q.rid}/ask`, { method: 'POST' });
    assert.equal(ask.status, 200); assert.match(ask.json.message, /waits until the Admin approves it/);
    const card = await s.pending();
    assert.ok(card, 'an install approval waits'); assert.equal(card.title, 'Add the module Hello notes'); assert.match(card.detail, /^From a zip file chosen in the Module Store\./);
    assert.equal(card.payload.kind, 'custom-module'); assert.equal(card.payload.id, 'hello-notes');
    assert.ok(!fs.existsSync(path.join(s.dir, 'hello-notes')), 'nothing is added before the Admin says yes');
    s.t.core.approval.decide(card.id, 'approve', 'owner');
    assert.ok(await s.until(() => s.t.core.modules.manifests.has('hello-notes')), 'found without a restart');
    const m = (await s.t.call('/api/modules')).json.modules.find((x) => x.id === 'hello-notes');
    assert.equal(m.custom, true); assert.equal(m.on, false); assert.equal(m.added.from, 'file'); assert.equal(m.added.label.tools[0], 'notes_add');
    assert.ok(fs.existsSync(path.join(s.dir, 'hello-notes', ADDED_FILE)));
    { const on = await s.t.call('/api/modules/hello-notes/on', { method: 'POST' }); assert.equal(on.status, 200, on.text); }
    assert.equal((await s.t.call('/api/m/hello-notes/notes')).status, 200, 'it works once switched on');
    // the same module again: it replaces the one that is on, keeps the old one asleep and says a restart is needed
    const again = (await s.send(sampleZip('hello-notes'))).json.request;
    assert.equal(again.replaces, true); assert.equal(again.replacesOn, true);
    await s.t.call(`/api/m/store/requests/${again.rid}/ask`, { method: 'POST' });
    const card2 = await s.pending(); assert.match(card2.detail, /the old one is kept beside it, asleep/);
    s.t.core.approval.decide(card2.id, 'approve', 'owner');
    assert.ok(await s.until(async () => (await s.t.call('/api/m/store/state')).json.requests.find((x) => x.rid === again.rid)?.state === 'added'));
    const st = (await s.t.call('/api/m/store/state')).json.requests.find((x) => x.rid === again.rid);
    assert.equal(st.restart, true);
    const old = fs.readdirSync(s.dir).find((n) => n.startsWith('hello-notes.old-'));
    assert.ok(old && fs.existsSync(path.join(s.dir, old, 'module.json.old')) && !fs.existsSync(path.join(s.dir, old, 'module.json')));
    assert.equal((await s.t.call('/api/modules')).json.modules.find((x) => x.id === 'hello-notes').restart, true);
  } finally { await s.close(); }
});

test('the Admin says no: nothing is added; a built-in module cannot be replaced or removed', async () => {
  const s = await storeDesk();
  try {
    const q = (await s.send(sampleZip('advisor'))).json.request;
    await s.t.call(`/api/m/store/requests/${q.rid}/ask`, { method: 'POST' });
    s.t.core.approval.decide((await s.pending()).id, 'deny', 'owner');
    assert.ok(await s.until(async () => (await s.t.call('/api/m/store/state')).json.requests.find((x) => x.rid === q.rid)?.state === 'denied'));
    assert.ok(!fs.existsSync(path.join(s.dir, 'advisor')));
    const same = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-alpha-')); fs.mkdirSync(path.join(same, 'alpha'));
    fs.writeFileSync(path.join(same, 'alpha', 'module.json'), JSON.stringify({ id: 'alpha', number: 70, name: 'Alpha again', description: 'A module that takes the id of a built-in one.', kind: 'switch-on', status: 'stub' }));
    const clash = await s.send(zipOf(path.join(same, 'alpha'))); fs.rmSync(same, { recursive: true, force: true });
    assert.equal(clash.json.refused, true); assert.ok(allLines(clash.json).some((l) => /already a module of the desk/.test(l.text)));
    const rm = await s.t.call('/api/m/store/remove/alpha', { body: {} });
    assert.equal(rm.status, 409); assert.match(rm.json.error, /come with the desk stay/);
  } finally { await s.close(); }
});

test('another person may ask; the request waits in the Admin\'s approvals, not theirs, and only the Admin\'s yes adds it', async () => {
  const s = await storeDesk();
  const call = (p, o, token) => s.t.call(p, { ...o, session: false, headers: { 'x-apd-session': token } });
  try {
    await s.t.call('/api/people/me/pin', { body: { pin: '2468' } });
    const pid = (await s.t.call('/api/people', { body: { name: 'Person A', pin: '1111' } })).json.person.id;
    const tok = (await s.t.call('/api/people/enter', { session: false, body: { id: pid, pin: '1111' } })).json.token;
    const r = await s.send(sampleZip('hello-notes'), tok);
    assert.equal(r.json.refused, false);
    await call(`/api/m/store/requests/${r.json.request.rid}/ask`, { method: 'POST' }, tok);
    const card = await s.pending();
    assert.ok(card, 'the keeper\'s door holds it');
    const theirs = s.t.desk.spaceOf(pid).core.approval.listPending();
    assert.equal(theirs.length, 0, 'the person has nothing to approve');
    assert.equal((await call(`/api/approvals/${card.id}/approve`, { method: 'POST' }, tok)).status, 404, 'the person cannot decide it');
    s.t.core.approval.decide(card.id, 'approve', 'owner');
    assert.ok(await s.until(() => s.t.desk.spaceOf(pid).core.modules.manifests.has('hello-notes')), 'found in the person\'s space too, without a restart');
  } finally { await s.close(); }
});

test('Incognito: no adding, building or removing, said plainly', async () => {
  const s = await storeDesk();
  try {
    const tok = (await s.t.call('/api/people/incognito', { method: 'POST' })).json.token;
    const r = await s.send(sampleZip('hello-notes'), tok);
    assert.equal(r.status, 403); assert.match(r.json.error, /^Modules are not added, built or removed in Incognito/);
    const b = await s.t.call('/api/m/store/build', { session: false, headers: { 'x-apd-session': tok }, body: { purpose: 'Keep a list of things', page: 'Things' } });
    assert.equal(b.status, 403);
    assert.equal((await s.t.call('/api/m/store/state', { session: false, headers: { 'x-apd-session': tok } })).json.incognito, true);
  } finally { await s.close(); }
});

test('build it here: the form makes a starter with no red line, it goes through the same approval, works once on, and can be removed with or without its data', async () => {
  const s = await storeDesk();
  try {
    const bad = await s.t.call('/api/m/store/build', { body: { purpose: 'x', page: '' } });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /Say in a sentence what the module is for\. Give its page a short name/);
    const b = await s.t.call('/api/m/store/build', { body: { purpose: 'Keep quotes from suppliers and compare them', page: 'Supplier quotes', keeps: 'quotes <script>', tools: 'add a quote\nhttps://evil.example list quotes', leaves: 'https://rates.example.org/api' } });
    assert.equal(b.status, 200); assert.equal(b.json.refused, false, JSON.stringify(b.json.report || {}).slice(0, 600));
    const q = b.json.request;
    assert.equal(q.red, 0); assert.equal(q.id, 'supplier-quotes'); assert.deepEqual(q.label.hosts, ['rates.example.org']);
    assert.deepEqual(q.label.tools, ['supplier_quotes_add_a_quote', 'supplier_quotes_list_quotes']);
    await s.t.call(`/api/m/store/requests/${q.rid}/ask`, { method: 'POST' });
    const card = await s.pending(); assert.match(card.detail, /^From the Module Store form\./);
    s.t.core.approval.decide(card.id, 'approve', 'owner');
    assert.ok(await s.until(() => s.t.core.modules.manifests.has('supplier-quotes')));
    await s.t.call('/api/modules/supplier-quotes/on', { method: 'POST' });
    assert.equal((await s.t.call('/api/m/supplier-quotes/items', { body: { text: 'Paper, 12 a box' } })).status, 200);
    const tool = await s.t.core.modules.runTool('supplier_quotes_add_a_quote', { text: 'Ink' }, { agentId: 'scout' });
    assert.equal(tool.ok, true);
    assert.equal((await s.t.call('/api/m/supplier-quotes/items')).json.items.length, 2);
    // remove, keeping the data: the table stays
    await s.t.call('/api/m/store/remove/supplier-quotes', { body: { data: false } });
    s.t.core.approval.decide((await s.pending()).id, 'approve', 'owner');
    assert.ok(await s.until(() => !s.t.core.modules.manifests.has('supplier-quotes')));
    assert.ok(!fs.existsSync(path.join(s.dir, 'supplier-quotes')), 'out of the modules folder');
    assert.equal(fs.readdirSync(path.join(s.t.dataDir, 'module-store', 'removed')).length, 1, 'its files are kept in the data folder');
    assert.ok(s.t.core.storage.get("SELECT name FROM sqlite_master WHERE name = 'm_supplier_quotes_items'"), 'its data stays');
    // add it again, then remove it with its data
    const b2 = await s.t.call('/api/m/store/build', { body: { purpose: 'Keep quotes from suppliers and compare them', page: 'Supplier quotes' } });
    await s.t.call(`/api/m/store/requests/${b2.json.request.rid}/ask`, { method: 'POST' });
    s.t.core.approval.decide((await s.pending()).id, 'approve', 'owner');
    assert.ok(await s.until(() => s.t.core.modules.manifests.has('supplier-quotes')));
    const rm = await s.t.call('/api/m/store/remove/supplier-quotes', { body: { data: true } });
    const card3 = await s.pending(); assert.match(card3.detail, /Its data is removed too/);
    s.t.core.approval.decide(card3.id, 'approve', 'owner'); void rm;
    assert.ok(await s.until(() => !s.t.core.storage.get("SELECT name FROM sqlite_master WHERE name = 'm_supplier_quotes_items'")), 'its data went');
  } finally { await s.close(); }
});

test('build it with another agent: the kit zip downloads and the task sheet carries the form', async () => {
  const s = await storeDesk();
  try {
    const r = await fetch(s.t.base + '/api/m/store/kit', { headers: { 'x-apd-session': s.t.desk.session } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.equal(Buffer.from(await r.arrayBuffer()).length, fs.statSync(KIT).size);
    const sheet = await s.t.call('/api/m/store/task-sheet', { body: { purpose: 'Keep quotes from suppliers and compare them', page: 'Supplier quotes', tools: 'add a quote', leaves: 'nothing' } });
    assert.equal(sheet.status, 200);
    assert.match(sheet.json.text, /## What it is for\nKeep quotes from suppliers and compare them/); assert.match(sheet.json.text, /- add a quote/); assert.match(sheet.json.text, /- nothing: the module calls no outside address/);
  } finally { await s.close(); }
});

test('a person who is not the Admin hears the outcome of his request at once, as an event and a toast', async () => {
  const s = await storeDesk();
  const call = (p, o, token) => s.t.call(p, { ...o, session: false, headers: { 'x-apd-session': token } });
  try {
    await s.t.call('/api/people/me/pin', { body: { pin: '2468' } });
    const pid = (await s.t.call('/api/people', { body: { name: 'Person A', pin: '1111' } })).json.person.id;
    const tok = (await s.t.call('/api/people/enter', { session: false, body: { id: pid, pin: '1111' } })).json.token;
    const heard = []; s.t.desk.spaceOf(pid).core.events.on((type, data) => { if (type === 'store' || type === 'toast') heard.push([type, data]); });
    for (const [answer, state, words] of [['deny', 'denied', /^The Admin said no to Hello notes\. Nothing was added\.$/], ['approve', 'added', /^The Admin added Hello notes\. It is off until it is switched on\.$/]]) {
      heard.length = 0;
      const r = await s.send(sampleZip('hello-notes'), tok);
      await call(`/api/m/store/requests/${r.json.request.rid}/ask`, { method: 'POST' }, tok);
      const card = await s.pending();
      s.t.core.approval.decide(card.id, answer, 'owner');
      assert.ok(await s.until(() => heard.some(([t, d]) => t === 'store' && d.state === state)), answer + ': a store event');
      assert.ok(heard.some(([t, d]) => t === 'toast' && words.test(d.text)), JSON.stringify(heard));
    }
  } finally { await s.close(); }
});

test('write the rest with a model: a try that fails leaves the starter as it was and says plainly what came back', async () => {
  let answer = null;
  const s = await storeDesk({ script: (body) => (JSON.stringify(body.messages || []).includes('You write a module for AP Desk') ? answer : null) });
  const hashOf = (d) => { const out = []; (function walk(x) { for (const e of fs.readdirSync(x, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(x, e.name); if (e.isDirectory()) walk(p); else out.push(e.name + ':' + fs.readFileSync(p, 'utf8')); } })(d); return out.join('\n'); };
  try {
    const b = await s.t.call('/api/m/store/build', { body: { purpose: 'Keep quotes from suppliers and compare them', page: 'Supplier quotes' } });
    const q = b.json.request;
    const starterDir = path.join(s.t.dataDir, 'module-store', 'requests', q.rid);
    const before = hashOf(starterDir);
    const count = () => s.t.core.modules.api ? fs.readdirSync(path.join(s.t.dataDir, 'module-store', 'requests')).length : 0;
    const n0 = count();
    const run = async () => { const r = await s.t.call(`/api/m/store/requests/${q.rid}/write`, { body: { provider: 'router' } }); assert.equal(r.status, 200, r.text); return s.t.core.jobs.wait(r.json.jobId, 20000); };
    answer = 'Sorry, I cannot write that module.';
    let j = await run();
    assert.equal(j.status, 'done');
    assert.equal(j.output.text, 'The model sent back no file the desk could use, so nothing changed. It said: Sorry, I cannot write that module. A bigger model may do better.');
    answer = '=== FILE: server.js ===\nexport async function activate(ctx) { const cp = process?.getBuiltinModule(\'child_process\'); return { deactivate() {} }; }\n=== END FILE ===';
    j = await run();
    assert.equal(j.status, 'done'); assert.equal(j.output.refused, true);
    assert.match(j.output.text, /^The model's work has a red line, so it was not kept: server\.js line 1: process\.getBuiltinModule reaches the inside of Node/);
    answer = { status: 500, text: 'upstream exploded at 0x7f' };
    j = await run();
    assert.equal(j.status, 'done', 'a model that does not answer is said plainly, not a raw failure');
    assert.match(j.output.text, /^The model did not answer, so nothing changed\. /);
    assert.doesNotMatch(j.output.text, /0x7f|exploded/);
    assert.equal(hashOf(starterDir), before, 'the starter is as it was');
    assert.equal(count(), n0, 'no new request was kept');
  } finally { await s.close(); }
});
