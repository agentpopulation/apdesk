// Plumbing: while the desk is Offline the agent's browser reaches nothing outside this PC. Stub page, no browser, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Computer } from './computer.js';
import { leavesThisPc, loopbackHost, OFFLINE_LINE } from './guard.js';
import { testDesk } from '../../test/helpers/desk.js';

const stubRoute = (url, { nav = false } = {}) => { const r = { did: null, request: () => ({ url: () => url, isNavigationRequest: () => nav, frame: () => null }), abort: async (why) => { r.did = 'abort:' + why; }, continue: async () => { r.did = 'continue'; } }; return r; };

test('which addresses leave this PC', () => {
  for (const u of ['https://example.com/', 'http://192.168.1.10/', 'http://10.0.0.5:8080/x', 'wss://chat.example.com/s', 'not a url']) assert.equal(leavesThisPc(u), true, u);
  for (const u of ['http://127.0.0.1:8080/', 'http://localhost:3000/a', 'http://[::1]:9000/', 'about:blank', 'data:text/html,hi', 'blob:http://localhost/1']) assert.equal(leavesThisPc(u), false, u);
  assert.equal(loopbackHost('127.0.0.1.example.com'), false);
});

test('a page that asks for an outside URL while Offline is blocked at request time; the setting is read at every request', async () => {
  let online = true;
  const c = new Computer({ agentId: 'operator', dataDir: '/tmp/none', guardOpts: () => ({ allowHosts: ['127.0.0.1'], deskPort: 3960, offline: online === false }) });
  const a = stubRoute('https://example.com/app.js'); await c.onRoute(a);
  assert.equal(a.did, 'continue', 'online: the request goes out');
  online = false;                                    // the owner switches Offline in the middle of a task
  const b = stubRoute('https://example.com/app.js'); await c.onRoute(b);
  assert.equal(b.did, 'abort:internetdisconnected', 'the very next request is blocked');
  const nav = stubRoute('https://en.wikipedia.org/wiki/Lima', { nav: true }); await c.onRoute(nav);
  assert.equal(nav.did, 'abort:internetdisconnected');
  const lan = stubRoute('http://192.168.1.10/status'); await c.onRoute(lan);
  assert.equal(lan.did, 'abort:internetdisconnected', 'the home network is not this PC');
  const own = stubRoute('http://127.0.0.1:8080/page.js'); await c.onRoute(own);
  assert.equal(own.did, 'continue', 'a page on this PC that the owner allowed still loads');
  const data = stubRoute('data:text/plain,x'); await c.onRoute(data);
  assert.equal(data.did, 'continue');
  const steps = c.steps.map(s => s.text);
  assert.equal(steps.filter(t => /^Blocked: the desk is offline/.test(t)).length, 1, 'one plain step for the burst, not one per file: ' + steps.join(' | '));
  assert.equal(c.offlineBlocked, 3);
  assert.equal(c.status().offline, true);
  await assert.rejects(c.goto('https://example.com/'), (e) => e.code === 'refused' && e.offline === true && e.message === OFFLINE_LINE);
  online = true;
  const again = stubRoute('https://example.com/app.js'); await c.onRoute(again);
  assert.equal(again.did, 'continue', 'back Online: requests go out again');
  assert.equal(c.status().offline, false);
});

test('Offline: a browser task that is not on this PC is refused at once and no browser starts; the status says Offline', async () => {
  const t = await testDesk({ modules: ['browser'] });
  try {
    const api = t.core.modules.api('browser');
    t.core.settings.set('online', false);
    const jobsBefore = t.core.jobs.list().length;
    await assert.rejects(api.runTask({ agentId: 'operator', goal: 'Read the page', startUrl: 'https://en.wikipedia.org/wiki/Lima' }), (e) => e.message === 'The desk is offline. Browsing needs the internet.');
    await assert.rejects(api.runTask({ agentId: 'operator', goal: 'Find the population of Lima' }), (e) => e.message === OFFLINE_LINE, 'no start address means the internet');
    await assert.rejects(api.runTask({ agentId: 'operator', goal: 'Read it', startUrl: 'http://192.168.1.10/' }), (e) => e.message === OFFLINE_LINE);
    await assert.rejects(api.readPage('https://example.com/'), (e) => e.message === OFFLINE_LINE);
    const viaRoute = await t.call('/api/m/browser/operator/task', { body: { goal: 'Read the page', startUrl: 'en.wikipedia.org' } });
    assert.equal(viaRoute.status, 409); assert.equal(viaRoute.json.error, OFFLINE_LINE);
    assert.equal(t.core.jobs.list().length, jobsBefore, 'no job was started');
    assert.deepEqual(api.computers(), [], 'no browser was started');
    const st = (await t.call('/api/m/browser/operator/status')).json;
    assert.equal(st.offline, true); assert.equal(st.open, false);
    t.core.settings.set('online', true);
    assert.equal((await t.call('/api/m/browser/operator/status')).json.offline, false, 'read at each check, not once at start');
  } finally { await t.close(); }
});
