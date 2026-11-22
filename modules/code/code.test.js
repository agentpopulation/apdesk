// Plumbing tests for the Code module (no model needed: a run is a real child process).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testDesk } from '../../test/helpers/desk.js';

async function approveNext(t) {
  for (let i = 0; i < 100; i++) { const a = await t.call('/api/approvals'); const p = a.json.pending.find(x => x.action === 'shell.run'); if (p) return t.call(`/api/approvals/${p.id}/approve`, { method: 'POST' }); await new Promise(r => setTimeout(r, 50)); }
  throw new Error('no approval came');
}
const waitRun = async (t, id) => { for (let i = 0; i < 200; i++) { const r = await t.call('/api/m/code/runs/' + id); if (!['queued', 'asking', 'running'].includes(r.json.status)) return r.json; await new Promise(r => setTimeout(r, 50)); } };

test('a JavaScript run asks, runs in its folder, has no keys, and the module switches off', async () => {
  const t = await testDesk({ modules: ['code'] });
  try {
    assert.equal((await t.call('/api/m/code/status')).status, 404);
    await t.call('/api/modules/code/on', { method: 'POST' });
    process.env.APD_TEST_SECRET = 'should-not-leak';
    const s = await t.call('/api/m/code/run', { body: { language: 'javascript', code: 'console.log(6*7, process.env.APD_TEST_SECRET || "none"); require("fs").writeFileSync("out.txt", "hi")' } });
    assert.equal(s.status, 200, s.text);
    await approveNext(t);
    const r = await waitRun(t, s.json.runId);
    assert.equal(r.status, 'done', JSON.stringify(r));
    assert.match(r.stdout, /42 none/);
    assert.ok(fs.existsSync(path.join(t.dataDir, 'workspace', 'sandbox', s.json.runId, 'out.txt')));
    // time limit
    const s2 = await t.call('/api/m/code/run', { body: { language: 'javascript', code: 'while(true){}', timeoutMs: 500 } });
    await approveNext(t);
    const r2 = await waitRun(t, s2.json.runId);
    assert.equal(r2.status, 'failed'); assert.match(r2.note, /time limit/);
    // denied
    const s3 = await t.call('/api/m/code/run', { body: { language: 'javascript', code: 'console.log(1)' } });
    for (let i = 0; i < 100; i++) { const a = await t.call('/api/approvals'); const p = a.json.pending[0]; if (p) { await t.call(`/api/approvals/${p.id}/deny`, { method: 'POST' }); break; } await new Promise(r => setTimeout(r, 50)); }
    assert.equal((await waitRun(t, s3.json.runId)).status, 'denied');
    // panic kills a running child
    const s4 = await t.call('/api/m/code/run', { body: { language: 'javascript', code: 'setInterval(()=>{}, 1000)', timeoutMs: 30000 } });
    await approveNext(t);
    for (let i = 0; i < 100; i++) { if ((await t.call('/api/m/code/runs/' + s4.json.runId)).json.status === 'running') break; await new Promise(r => setTimeout(r, 50)); }
    await t.call('/api/panic', { method: 'POST' });
    const r4 = await waitRun(t, s4.json.runId);
    assert.equal(r4.status, 'stopped');
    await t.call('/api/panic/resume', { method: 'POST' });
    await t.call('/api/modules/code/off', { method: 'POST' });
    assert.equal((await t.call('/api/m/code/status')).status, 404);
  } finally { delete process.env.APD_TEST_SECRET; await t.close(); }
});

test('the container image card says it comes from Docker Hub', async () => {
  const t = await testDesk({ modules: ['code'] });
  try {
    await t.call('/api/modules/code/on', { method: 'POST' });
    const s = await t.call('/api/m/code/image', { body: { language: 'python' } });
    assert.equal(s.status, 200, s.text);
    let card;
    for (let i = 0; i < 100 && !card; i++) { card = t.core.approval.listPending().find(a => a.action === 'install'); if (!card) await new Promise(r => setTimeout(r, 30)); }
    assert.ok(card, 'the owner is asked');
    assert.match(card.detail, /From Docker Hub\./);
    t.core.approval.decide(card.id, 'deny');
  } finally { await t.close(); }
});

test('"Docker is not running" names the app only where there is one', async () => {
  const { dockerNotRunning } = await import('./sandbox.js');
  assert.match(dockerNotRunning('win32'), /Start Docker Desktop/);
  assert.match(dockerNotRunning('darwin'), /Start Docker Desktop/);
  assert.match(dockerNotRunning('linux'), /Start the Docker service/);
  assert.doesNotMatch(dockerNotRunning('linux'), /Desktop/);
});
