// A desk with a screen-lock PIN, restarted, always opens on a way in: the page can learn who is at the desk and draw the
// lock, the chooser lists the people (looks only, nothing that waits for them), and everything else stays shut.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createDesk } from '../app/server.js';

async function open(dataDir) {
  const desk = await createDesk({ dataDir, port: 0, quiet: true, env: {}, modules: ['accounts'] });
  desk.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1'); desk.core.settings.set('router.enabled', false);
  await desk.start();
  const call = async (p, { body, token = desk.session } = {}) => {
    const r = await fetch(desk.url() + p, { method: body !== undefined ? 'POST' : 'GET', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-apd-session': token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return { desk, call };
}
/** A fresh desk with the lock on and a PIN set, set up by `before` (with the page's token), then restarted. */
async function restartedLocked(before = async () => {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-lock-'));
  const a = await open(dataDir);
  assert.equal((await a.call('/api/modules/accounts/on', { body: {} })).status, 200);
  assert.equal((await a.call('/api/m/accounts/pin', { body: { pin: '4826' } })).json.hasPin, true);
  await before(a);
  await a.desk.stop();
  const b = await open(dataDir);
  return { ...b, async close() { await b.desk.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
const shut = async (call, token) => { for (const p of ['/api/approvals', '/api/agents', '/api/jobs', '/api/model/usage']) assert.equal((await call(p, { token })).status, 423, p); };

test('one person, no own PIN: after a restart the page learns who it is and the lock is drawn, not an empty chooser', async () => {
  const d = await restartedLocked();
  try {
    const me = await d.call('/api/people/me');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.person.keeper, true);
    assert.equal((await d.call('/api/m/accounts/state')).json.locked, true, 'the lock screen has what it needs');
    const st = await d.call('/api/state');
    assert.equal(st.json.locked, true); assert.ok('country' in st.json.settings, 'the place row behind the lock has its country');
    const ppl = await d.call('/api/people');
    assert.equal(ppl.status, 200); assert.equal(ppl.json.people.length, 1);
    await shut(d.call);
    assert.equal((await d.call('/api/m/accounts/unlock', { body: { pin: '4826' } })).json.locked, false);
    assert.equal((await d.call('/api/agents')).status, 200, 'open after the PIN');
  } finally { await d.close(); }
});

test('one person with their own PIN, and two people: the chooser lists them, entering works, then the lock asks for its PIN', async () => {
  for (const two of [false, true]) {
    const d = await restartedLocked(async (a) => {
      assert.equal((await a.call('/api/people/me/pin', { body: { pin: '2468' } })).status, 200);
      if (two) assert.equal((await a.call('/api/people', { body: { name: 'Second', pin: '1357' } })).status, 200);
    });
    try {
      const list = await d.call('/api/people', { token: null });
      assert.equal(list.status, 200, list.text);
      assert.deepEqual(list.json.people.map(p => p.name), two ? ['Keeper', 'Second'] : ['Keeper']);
      assert.ok(list.json.people.every(p => p.hasPin), 'the chooser knows to show the PIN box');
      const keeper = list.json.people[0];
      const ent = await d.call('/api/people/enter', { token: null, body: { id: keeper.id, pin: '2468' } });
      assert.equal(ent.status, 200, ent.text);
      const token = ent.json.token;
      d.desk.core.approval.request({ action: 'send.person', title: 'Mail the supplier', payload: { body: 'PRIVATE-BODY' } });
      const me = await d.call('/api/people/me', { token });
      assert.equal(me.status, 200, me.text); assert.equal(me.json.person.id, keeper.id);
      const locked = await d.call('/api/people', { token });
      assert.equal(locked.status, 200);
      assert.ok(locked.json.people.every(p => p.waiting === 0), 'nothing that waits is told while locked');
      assert.ok(!locked.text.includes('PRIVATE-BODY'));
      assert.equal((await d.call('/api/m/accounts/state', { token })).json.locked, true);
      await shut(d.call, token);
      assert.equal((await d.call('/api/m/accounts/unlock', { token, body: { pin: '4826' } })).json.locked, false);
      assert.equal((await d.call('/api/people', { token })).json.people[0].waiting, 1, 'unlocked: the waiting count is back');
    } finally { await d.close(); }
  }
});
