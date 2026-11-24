// What the doors say on screen: the real reason with a next step, times in the owner's zone, plain words on the
// download card, and wording that fits the system the desk runs on.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { testDesk } from './helpers/desk.js';
import { startDownloadHost, sha, until } from './helpers/download-host.js';
import { reachLine } from '../app/core/update.js';
import { ownerTime } from '../app/core/approval-door.js';
import { dayWords } from '../modules/memory/dream.js';

const netErr = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

test('update check: no internet, no answer in time and a refused connection are each said as they are', () => {
  assert.match(reachLine(netErr('ENOTFOUND')), /this PC is not online/);
  assert.match(reachLine(netErr('EAI_AGAIN')), /this PC is not online/);
  assert.match(reachLine(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), /did not answer in time/);
  assert.match(reachLine(netErr('ECONNREFUSED')), /refused/);
  assert.doesNotMatch(reachLine(netErr('ENOTFOUND')), /in time/, 'not "no answer in time" for a name that does not resolve');
  for (const e of [netErr('ENOTFOUND'), new TypeError('fetch failed'), netErr('ECONNRESET')]) assert.doesNotMatch(reachLine(e), /fetch failed|ENOTFOUND|ECONN/);
});

test('auto-approve end time in the activity log is in the owner\'s zone, never a raw UTC stamp', async () => {
  const t = await testDesk();
  try {
    t.core.settings.set('timeZone', 'Asia/Kolkata'); t.core.settings.set('locale', 'en-IN');
    await t.call('/api/settings/auto-approve', { body: { window: 30 } });
    const row = t.core.storage.get("SELECT title FROM activity WHERE action = 'security.autoApprove' ORDER BY id DESC LIMIT 1");
    assert.doesNotMatch(row.title, /\d{4}-\d{2}-\d{2}T|Z$/);
    assert.match(row.title, /^Auto-approve until .*(IST|GMT\+5:30)/);
    const fixed = { get: (k) => ({ timeZone: 'America/New_York', locale: 'en-US' })[k] };
    assert.match(ownerTime('2026-11-22T18:29:00.000Z', fixed), /Nov 22.*1:29.*PM.*EST/);
    assert.doesNotMatch(ownerTime('2026-11-22T18:29:00.000Z', { get: () => 'Not/AZone' }), /T18:29|undefined|null/);
  } finally { await t.close(); }
});

test('the memory summary is dated in the owner\'s zone: 3:17 at night in Kolkata is still that day there', () => {
  const at = new Date('2026-11-21T21:47:00Z');   // 03:17 on 22 Nov in Kolkata, 21 Nov in UTC
  assert.equal(dayWords(at, { timeZone: 'Asia/Kolkata', locale: 'en-GB' }), '22 November 2026');
  assert.equal(dayWords(at, { timeZone: 'America/New_York', locale: 'en-US' }), 'November 21, 2026');
  assert.match(dayWords(at, { timeZone: 'Not/AZone' }), /2026/);
});

test('download card: plain size, the file and where it comes from; no internal kind or hash. A broken network says so', async () => {
  const body = crypto.randomBytes(30 * 1024); const host = await startDownloadHost({ '/m.gguf': { body } });
  const t = await testDesk();
  try {
    const d = await t.core.downloads.start({ title: 'Granite model', url: host.url('/m.gguf'), allowHosts: ['127.0.0.1'], size: body.length, sha256: sha(body), to: path.join(t.dataDir, 'dl', 'm.gguf'), kind: 'local-engine' });
    const card = await until(() => t.core.approval.listPending()[0]);
    // what a screen is given holds no raw address: the host is named in the detail line
    assert.deepEqual(Object.keys(card.payload).sort(), ['file', 'size']);
    assert.ok(!JSON.stringify(card).includes(host.url('/m.gguf')), 'no raw address on the card');
    assert.equal(card.payload.size, '30.0 KB'); assert.equal(card.payload.file, 'm.gguf');
    assert.doesNotMatch(JSON.stringify(card.payload), /local-engine|[0-9a-f]{64}|"download"/);
    assert.match(card.detail, /^From 127\.0\.0\.1\. The desk checks the file is the one published before it is used\.$/); assert.doesNotMatch(card.title + card.detail, /SHA|hash/i);
    // the network goes away mid-way: the reason names it and what to do
    t.core.downloads.fetchImpl = async () => { throw netErr('ENOTFOUND'); };
    t.core.approval.decide(card.id, 'approve');
    const paused = await until(() => { const x = t.core.downloads.list().downloads.find(y => y.id === d.id); return x?.state === 'paused' ? x : null; });
    assert.match(paused.reason, /^This PC is not online\. Press Resume when it is back/);
    assert.equal(t.core.downloads.summary().stuck, 1, 'the top bar can tell a stuck download from a moving one');
  } finally { await t.close(); await host.close(); }
});

test('pairing page and the people note fit the system and how the desk was started', async () => {
  const real = process.platform;
  const t = await testDesk({ pairing: true });
  const page = async () => { await fetch(t.base + '/'); return (await fetch(t.base + '/')).text(); };   // the first browser is the owner's; the next one is asked
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    let html = await page();
    assert.match(html, /the terminal where start\.sh runs/); assert.doesNotMatch(html, /\.bat/);
    Object.defineProperty(process, 'platform', { value: 'win32' });
    html = await page();
    assert.match(html, /the one start\.bat opened/); assert.match(html, /stop\.bat/);
  } finally { Object.defineProperty(process, 'platform', { value: real }); await t.close(); }
  const hidden = await testDesk({ pairing: true, env: { APD_BACKGROUND: '1' } });
  try {
    await fetch(hidden.base + '/'); const html = await (await fetch(hidden.base + '/')).text();
    assert.match(html, /Type the six-digit code shown under Show code in Settings › Security/);
    assert.doesNotMatch(html, /own window/, 'a desk started hidden has no window to point at');
  } finally { await hidden.close(); }
});

test('adding a person: the honest limit of the PIN names this system\'s own way to keep people apart', async () => {
  const real = process.platform;
  const t = await testDesk();
  try {
    assert.equal((await t.call('/api/people/me/pin', { body: { pin: '4826' } })).status, 200);
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const r = await t.call('/api/people', { body: { name: 'Ravi', pin: '1357' } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.note, /their own user account on this computer and turn on disk encryption\.$/);
    assert.doesNotMatch(r.json.note, /Windows|BitLocker/);
  } finally { Object.defineProperty(process, 'platform', { value: real }); await t.close(); }
});

test('auto-approve "today" ends at midnight where the owner is, not where the PC clock is', async () => {
  const { endOfDay } = await import('../app/core/approval-door.js');
  const at = Date.parse('2026-11-22T20:00:00Z');   // 01:30 on 23 Nov in Kolkata, 15:00 on 22 Nov in New York
  assert.equal(new Date(endOfDay(at, 'Asia/Kolkata')).toISOString(), '2026-11-23T18:29:59.999Z');
  assert.equal(new Date(endOfDay(at, 'America/New_York')).toISOString(), '2026-11-23T04:59:59.999Z');
  assert.equal(new Date(endOfDay(Date.parse('2026-11-01T12:00:00Z'), 'America/New_York')).toISOString(), '2026-11-02T04:59:59.999Z', 'the day the clocks go back');
  const t = await testDesk();
  try {
    t.core.settings.set('timeZone', 'Pacific/Kiritimati');   // 14 hours ahead of UTC: far from any test machine's own zone
    await t.call('/api/settings/auto-approve', { body: { window: 'today' } });
    const until = Date.parse(t.core.settings.get('security.autoApproveUntil'));
    assert.equal(until, endOfDay(Date.now(), 'Pacific/Kiritimati'));
    const wall = new Intl.DateTimeFormat('en-GB', { timeZone: 'Pacific/Kiritimati', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(until));
    assert.equal(wall, '23:59');
  } finally { await t.close(); }
});
