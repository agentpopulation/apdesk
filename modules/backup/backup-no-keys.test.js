// A backup made "without keys" holds no secret at all: every value the desk stores as a secret, wherever it sits
// (the secrets table, the router key in settings, a LAN node's key), is absent from the zip. The About card counts
// the modules from the module list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { testDesk } from '../../test/helpers/desk.js';
import { restartHelp } from './ui-restart.js';

test('a backup without keys: no stored secret value anywhere in the zip; with keys they are all there', async () => {
  const t = await testDesk({ modules: ['backup'] });
  try {
    const S = { provider: 'sk-provider-SECRET-111111', router: 'ROUTER-SECRET-222222', lan: 'LAN-NODE-SECRET-333333', module: 'MAIL-PASSWORD-SECRET-444444' };
    t.core.model.addKey('openai', S.provider, 'test');
    assert.equal((await t.call('/api/settings', { body: { 'router.apiKey': S.router } })).status, 200);
    t.core.settings.set('network.lanNodes', [{ id: 'n1', name: 'Den PC', baseUrl: 'http://192.168.1.20:11434/v1', apiKey: S.lan, enabled: true }]);
    t.core.storage.run("INSERT INTO secrets (id, kind, provider, label, value, created, enabled) VALUES ('sec_mail_x', 'module:mail', 'mail', 'pass_x', ?, ?, 1)", S.module, new Date().toISOString());
    // every stored secret value: the secrets table, and the settings that hold a key
    const stored = [...t.core.storage.all('SELECT value FROM secrets').map(r => r.value), t.core.settings.get('router.apiKey'), ...t.core.settings.get('network.lanNodes').map(n => n.apiKey)];
    assert.deepEqual(new Set(stored), new Set(Object.values(S)));

    const zipOf = async (includeKeys) => { const made = (await t.call('/api/m/backup/now', { body: { includeKeys } })).json; return new AdmZip(path.join(t.core.storage.backupsDir, made.name)); };
    const without = await zipOf(false);
    for (const e of without.getEntries()) { const raw = e.getData(); for (const v of stored) assert.ok(!raw.includes(Buffer.from(v)), `${e.entryName} holds a secret`); }
    // the LAN node itself is kept, only its key is left out
    assert.ok(without.getEntry('apd.sqlite').getData().includes(Buffer.from('Den PC')));
    const withKeys = (await zipOf(true)).getEntry('apd.sqlite').getData();
    for (const v of stored) assert.ok(withKeys.includes(Buffer.from(v)), 'a backup with keys keeps ' + v);
  } finally { await t.close(); }
});

const raw = (t, key) => { const r = t.core.storage.get('SELECT value FROM settings WHERE key = ?', key); return r ? JSON.parse(r.value) : undefined; };
const keysHere = (t) => ({ router: raw(t, 'router.apiKey'), nodes: (raw(t, 'network.lanNodes') || []).map(n => [n.id, n.apiKey ?? null]), secrets: t.core.storage.all('SELECT value FROM secrets ORDER BY value').map(r => r.value) });
async function restoreNamed(t, name, extra = {}) {
  const prev = (await t.call(`/api/m/backup/preview/${name}`)).json;
  const r = await t.call(`/api/m/backup/restore/${name}`, { body: { previewId: prev.previewId, ...extra } });
  assert.equal(r.status, 200, r.text); return r.json;
}
async function setKeys(t, { router, lan, provider }) {
  assert.equal((await t.call('/api/settings', { body: { 'router.apiKey': router } })).status, 200);
  t.core.settings.set('network.lanNodes', [{ id: 'n1', name: 'Box', baseUrl: 'http://127.0.0.1:9999/v1', apiKey: lan }]);
  if (provider) t.core.model.addKey('openai', provider, 'test');
}

test('restoring a backup without keys leaves the keys on this desk as they are; the rest comes back', async () => {
  const t = await testDesk({ modules: ['backup'] });
  try {
    await setKeys(t, { router: 'sk-ROUTERKEY-123456', lan: 'sk-LANKEY-456789', provider: 'sk-provider-KEY-000111' });
    t.core.settings.set('ownerName', 'Asha');
    const before = keysHere(t);
    const made = (await t.call('/api/m/backup/now', { body: { includeKeys: false } })).json;
    t.core.settings.set('ownerName', 'Changed');
    const r = await restoreNamed(t, made.name);
    assert.equal(r.madeHere, true); assert.equal(r.keptSecrets, true);
    assert.deepEqual(keysHere(t), before, 'the router key, the node key and the secrets are all still here');
    assert.equal(raw(t, 'ownerName'), 'Asha', 'the settings themselves came back from the backup');
    assert.equal(raw(t, 'network.lanNodes')[0].name, 'Box');
  } finally { await t.close(); }
});

test('restoring a backup with keys brings back the keys it holds', async () => {
  const t = await testDesk({ modules: ['backup'] });
  try {
    await setKeys(t, { router: 'sk-ROUTER-OLD-123456', lan: 'sk-LAN-OLD-456789' });
    const made = (await t.call('/api/m/backup/now', { body: { includeKeys: true } })).json;
    await setKeys(t, { router: 'sk-ROUTER-NEW-999999', lan: 'sk-LAN-NEW-888888' });
    await restoreNamed(t, made.name);
    const k = keysHere(t);
    assert.equal(k.router, 'sk-ROUTER-OLD-123456'); assert.deepEqual(k.nodes, [['n1', 'sk-LAN-OLD-456789']]);
  } finally { await t.close(); }
});

test('a backup without keys restored onto a fresh desk: no key appears, and the fresh desk keeps its own', async () => {
  const a = await testDesk({ modules: ['backup'] });
  const b = await testDesk({ modules: ['backup'] });
  try {
    await setKeys(a, { router: 'sk-ROUTER-A-123456', lan: 'sk-LAN-A-456789' });
    a.core.settings.set('ownerName', 'Asha');
    const made = (await a.call('/api/m/backup/now', { body: { includeKeys: false } })).json;
    const zip = fs.readFileSync(path.join(a.core.storage.backupsDir, made.name));
    const up = await fetch(b.base + '/api/m/backup/upload', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-apd-session': b.desk.session }, body: zip }).then(r => r.json());
    await restoreNamed(b, up.name, { trustAll: true });
    const k = keysHere(b);
    assert.equal(k.router, undefined, 'no router key is made up'); assert.deepEqual(k.nodes, [['n1', null]]);
    assert.equal(raw(b, 'ownerName'), 'Asha');
    // the same restore onto a desk that has its own router key keeps that key
    assert.equal((await b.call('/api/settings', { body: { 'router.apiKey': 'sk-ROUTER-B-777777' } })).status, 200);
    await restoreNamed(b, up.name, { trustAll: true });
    assert.equal(keysHere(b).router, 'sk-ROUTER-B-777777');
  } finally { await a.close(); await b.close(); }
});

test('About: the module count is the module list, not a typed number', async () => {
  const t = await testDesk({ modules: ['backup', 'mail', 'memory'] });
  try {
    const about = (await t.call('/api/m/backup/about')).json;
    const row = about.layout.find(r => r[0] === 'modules');
    assert.equal(row[1], `The ${t.core.modules.list().length} modules, one folder each`);
    assert.equal(t.core.modules.list().length, 3);
  } finally { await t.close(); }
});

test('restart help names the files of the system it runs on', () => {
  assert.match(restartHelp('Win32'), /stop\.bat and then start\.bat/);
  assert.match(restartHelp('Windows'), /stop\.bat/);
  for (const p of ['Linux x86_64', 'linux']) { assert.match(restartHelp(p), /start\.sh/); assert.doesNotMatch(restartHelp(p), /\.bat|\.command/); }
  for (const p of ['MacIntel', 'macOS']) { assert.match(restartHelp(p), /start\.command/); assert.doesNotMatch(restartHelp(p), /\.bat/); }
});
