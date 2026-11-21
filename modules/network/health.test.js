// The pure helpers for Part 1: the status strip, IP/DNS change detection, the issues list and the API-health fold.
// No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusStrip, diffAddresses, diffDns, issuesFrom, apiHealthFrom } from './health.js';

test('status strip: counts from the roster and jobs; a missing source stays null, not a made-up number', () => {
  const agents = [{ id: 'coordinator', enabled: true }, { id: 'scout', enabled: true }, { id: 'closer', enabled: true }, { id: 'coder', enabled: false }];
  const s = statusStrip({
    agents, runningJobs: [{ agentId: 'scout' }], jobSummary: { running: 1, waiting: 2 },
    failedAgentIds: ['closer'], issues: [{ muted: false }, { muted: true }, { resolved: true }], newDevices: 2, net: { ok: true, at: 't' },
  });
  assert.deepEqual(s.agents, { online: 3, midTask: 1, idle: 1, error: 1 }, 'disabled agents are not counted');
  assert.equal(s.queue, 3); assert.equal(s.openIssues, 1, 'muted and resolved issues are not open');
  assert.equal(s.newDevices, 2); assert.deepEqual(s.heartbeat, { ok: true, at: 't' });
  assert.equal(s.messagesPerMin, null, 'no messages source -> null, shown as a dash');
  const none = statusStrip({ agents, messagesPerMin: 7, net: null });
  assert.equal(none.heartbeat, null, 'no heartbeat source -> null'); assert.equal(none.messagesPerMin, 7);
});

test('IP change detection: a new, a removed and a replaced address are each logged old -> new', () => {
  const prev = [{ scope: 'local', family: 'IPv4', value: '192.168.1.20' }, { scope: 'public', family: 'IPv4', value: '203.0.113.7' }];
  const cur = [{ scope: 'local', family: 'IPv4', value: '192.168.1.21' }, { scope: 'local', family: 'IPv6', value: 'fe80::1' }, { scope: 'public', family: 'IPv4', value: '203.0.113.7' }];
  const d = diffAddresses(prev, cur);
  assert.deepEqual(d, [
    { scope: 'local', family: 'IPv4', old: '192.168.1.20', new: '192.168.1.21' },
    { scope: 'local', family: 'IPv6', old: null, new: 'fe80::1' },
  ], 'the unchanged public address is not reported');
  assert.deepEqual(diffAddresses(cur, cur), [], 'no change means no rows');
});

test('DNS change detection: records compared per type', () => {
  const prev = [{ type: 'A', data: '93.184.216.34' }, { type: 'MX', data: '10 mail.example.com' }];
  const cur = [{ type: 'A', data: '93.184.216.35' }, { type: 'MX', data: '10 mail.example.com' }, { type: 'NS', data: 'ns1.example.com' }];
  assert.deepEqual(diffDns(prev, cur), [
    { type: 'A', old: '93.184.216.34', new: '93.184.216.35' },
    { type: 'NS', old: null, new: 'ns1.example.com' },
  ]);
});

test('issues: cert expiry warns at 14 days and is critical at 3 or expired; high latency and packet loss are flagged', () => {
  const now = Date.UTC(2026, 10, 21);
  const d = (n) => new Date(now + n * 86400_000).toISOString();
  const out = issuesFrom({
    sites: [{ host: 'a.example', certTo: d(10) }, { host: 'b.example', certTo: d(2) }, { host: 'c.example', certTo: d(-1) }, { host: 'd.example', certTo: d(40) }],
    domains: [{ domain: 'mine.example', certTo: d(13) }],
    latency: 400, baseline: 40, dnsFails: ['gone.example'], loss: [{ name: '1.1.1.1', lossPct: 60 }, { name: 'gateway', lossPct: 0 }], now,
  });
  const by = Object.fromEntries(out.map(i => [i.key, i]));
  assert.equal(by['cert|a.example'].severity, 'warn'); assert.equal(by['cert|b.example'].severity, 'critical');
  assert.equal(by['cert|c.example'].severity, 'critical'); assert.equal(by['cert|mine.example'].severity, 'warn');
  assert.ok(!by['cert|d.example'], 'a cert good for 40 days is not an issue');
  assert.equal(by['latency'].severity, 'warn'); assert.equal(by['dns|gone.example'].kind, 'dns');
  assert.equal(by['loss|1.1.1.1'].severity, 'critical'); assert.ok(!by['loss|gateway'], 'no loss means no issue');
  assert.deepEqual(issuesFrom({ latency: 50, baseline: 40, now }), [], 'latency near baseline is fine');
});

test('API health fold: last state, latency and the 24h error rate per provider', () => {
  const now = Date.UTC(2026, 10, 21, 12);
  const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
  const rows = [
    { provider: 'gemini', label: 'Gemini', url: 'https://g/v1/models', ok: true, status: 200, ms: 180, at: iso(1) },
    { provider: 'gemini', ok: false, status: 503, ms: null, at: iso(30) },
    { provider: 'gemini', ok: true, status: 200, ms: 200, at: iso(60 * 30) },
    { provider: 'groq', label: 'Groq', ok: true, status: 401, ms: 1800, at: iso(2) },
  ];
  const h = apiHealthFrom(rows, now);
  const g = h.find(p => p.provider === 'gemini');
  assert.equal(g.status, 'up'); assert.equal(g.lastMs, 180); assert.equal(g.checks24h, 2);
  assert.equal(g.errors24h, 1); assert.equal(g.errorRate24h, 0.5, 'the check older than 24h is left out of the rate');
  assert.equal(h.find(p => p.provider === 'groq').status, 'slow', 'a reachable but slow endpoint is slow, not down');
});
