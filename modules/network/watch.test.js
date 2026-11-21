// Section C: website watch. One request per check against a stand-in site on loopback; backoff on a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { siteUrl, robotsAllows, checkOnce, nextCheckAt, transition, diffSummary, textHash, clampEvery, UA } from './watch.js';
import { standIn } from './standin.js';
import { testDesk } from '../../test/helpers/desk.js';

test('addresses: http(s) only, no passwords; checks never more often than every 5 minutes', () => {
  assert.equal(siteUrl('example.com').href, 'https://example.com/');
  assert.throws(() => siteUrl('ftp://example.com'), /Only http and https/);
  assert.throws(() => siteUrl('https://a:b@example.com'), /user name and password/);
  assert.equal(clampEvery(1), 5); assert.equal(clampEvery('x'), 30); assert.equal(clampEvery(60), 60);
});

test('robots.txt: the most specific group and the longest rule decide', () => {
  const txt = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: AgentPopulationDesk\nDisallow: /desk-no\n';
  assert.equal(robotsAllows(txt, '/private/x', 'Other/1'), false);
  assert.equal(robotsAllows(txt, '/private/ok/1', 'Other/1'), true);
  assert.equal(robotsAllows(txt, '/private/x', UA), true, 'our own group replaces *');
  assert.equal(robotsAllows(txt, '/desk-no', UA), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow:\n', '/', UA), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$\n', '/a.pdf', UA), false);
});

test('one request per check: up, slow, down, refused and 429 are told apart', async () => {
  let mode = 'up';
  const s = await standIn(async ({ res }) => {
    if (mode === 'slow') await new Promise(r => setTimeout(r, 120));
    const code = { up: 200, slow: 200, down: 503, refused: 403, busy: 429, missing: 404 }[mode];
    res.writeHead(code, mode === 'busy' ? { 'retry-after': '600' } : {}); res.end('<html>hi</html>');
  });
  try {
    assert.equal((await checkOnce(s.fetch, 'https://site.example/')).state, 'up');
    assert.equal(s.seen.length, 1); assert.match(s.seen[0].ua, /AgentPopulationDesk/);
    mode = 'slow'; const sl = await checkOnce(s.fetch, 'https://site.example/', { slowMs: 50 }); assert.equal(sl.state, 'slow'); assert.match(sl.note, /Slow/);
    mode = 'down'; const d = await checkOnce(s.fetch, 'https://site.example/'); assert.equal(d.state, 'down'); assert.equal(d.status, 503);
    mode = 'refused'; const b = await checkOnce(s.fetch, 'https://site.example/'); assert.equal(b.state, 'blocked'); assert.match(b.note, /not retried another way/);
    mode = 'busy'; const z = await checkOnce(s.fetch, 'https://site.example/'); assert.equal(z.state, 'blocked'); assert.equal(z.retryAfterMin, 10);
    mode = 'missing'; assert.equal((await checkOnce(s.fetch, 'https://site.example/')).state, 'down');
    assert.equal(s.seen.length, 6, 'exactly one request per check');
    const gone = await checkOnce(async () => { throw new TypeError('fetch failed'); }, 'https://site.example/');
    assert.equal(gone.state, 'down'); assert.equal(gone.note, 'Could not connect.');
  } finally { await s.close(); }
});

test('backoff on a fake clock: 5xx and 429 wait longer each time, capped at 6 hours; Retry-After is honoured', () => {
  const now = Date.UTC(2026, 10, 21, 10, 0);
  const site = { every_min: 30, fail_count: 0 };
  assert.equal(nextCheckAt(site, { state: 'up', status: 200 }, now), now + 30 * 60_000);
  assert.equal(nextCheckAt({ ...site, fail_count: 3 }, { state: 'down', status: 503 }, now), now + 80 * 60_000, 'the fourth failure in a row waits 5 x 2^4 minutes');
  assert.equal(nextCheckAt({ ...site, fail_count: 20 }, { state: 'down', status: 500 }, now), now + 360 * 60_000);
  assert.equal(nextCheckAt(site, { state: 'blocked', status: 429, retryAfterMin: 90 }, now), now + 90 * 60_000);
});

test('one notice per change of state; text changes summarised as plain lines', () => {
  assert.equal(transition('up', 'down'), 'down'); assert.equal(transition('down', 'down'), null); assert.equal(transition('down', 'up'), 'back');
  assert.equal(transition('up', 'slow'), 'slow'); assert.equal(transition(null, 'down'), null); assert.equal(transition('up', 'blocked'), null);
  const d = diffSummary('Price 10\nOpen daily\nContact', 'Price 12\nOpen daily\nContact\n' + 'x'.repeat(300));
  assert.deepEqual(d.removed, ['Price 10']); assert.equal(d.added[0], 'Price 12'); assert.equal(d.added[1].length, 160);
  assert.equal(textHash('a  b\n\n c'), textHash('a b\nc'), 'spacing alone is not a change');
});

test('desk: watching needs the owner; an address on this PC or the LAN is refused by the address guard', async () => {
  const t = await testDesk({ modules: ['search', 'network'] });
  try {
    await t.call('/api/modules/network/on', { method: 'POST' });
    assert.equal((await t.call('/api/m/network/sites', { body: { url: 'example.com' }, session: false })).status, 403);
    const s = (await t.call('/api/m/network/sites', { body: { url: 'http://192.168.1.1/' } })).json;
    const c = await t.call(`/api/m/network/sites/${s.id}/check`, { body: {} });
    assert.equal(c.json.state, 'blocked'); assert.match(c.json.note, /local network/);
    const again = await t.call(`/api/m/network/sites/${s.id}/check`, { body: {} });
    assert.equal(again.status, 429, 'a second check within 5 minutes is refused');
    t.core.settings.set('online', false);
    const off = await t.call(`/api/m/network/sites/${s.id}/change`, { body: {} });
    assert.equal(off.status, 409); assert.match(off.json.error, /offline/);
  } finally { await t.close(); }
});
