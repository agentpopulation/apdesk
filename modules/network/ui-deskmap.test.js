// Desk view: agent states, the dependency numbers, the layout and the shared selection. Pure code, no desk needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentStates, dependencyModel, layoutDeps, related, strokeWidth } from './ui-deskmap.js';

const NOW = Date.parse('2026-11-21T10:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const agents = [{ id: 'a', name: 'Scout', role: 'Research', enabled: true }, { id: 'b', name: 'Clerk', role: 'Files', enabled: true }, { id: 'c', name: 'Pilot', role: 'Web', enabled: true }, { id: 'd', name: 'Mute', role: 'x', enabled: true }, { id: 'e', name: 'Off', role: 'x', enabled: false }];

test('state: waiting beats working, working beats a recent failure, a failure in the last day shows red, else idle; disabled agents are left out', () => {
  const jobs = [
    { agentId: 'a', status: 'running', title: 'Find venues', detail: 'Reading pages', updated: iso(1) },
    { agentId: 'a', status: 'waiting', title: 'Send note', detail: 'Waiting for you', updated: iso(2) },
    { agentId: 'b', status: 'running', title: 'Sort files', detail: '', updated: iso(1) },
    { agentId: 'c', status: 'failed', title: 'Open site', error: 'Timed out', finished: iso(60) },
    { agentId: 'd', status: 'failed', title: 'Old', error: 'x', finished: iso(60 * 30) },
  ];
  const s = Object.fromEntries(agentStates({ agents, jobs, now: NOW }).map(x => [x.id, x]));
  assert.equal(s.a.state, 'waiting'); assert.equal(s.a.doing, 'Send note');
  assert.equal(s.b.state, 'working'); assert.equal(s.b.doing, 'Sort files');
  assert.equal(s.c.state, 'failed'); assert.match(s.c.doing, /Open site/);
  assert.equal(s.d.state, 'idle'); assert.equal(s.d.doing, null);
  assert.equal(s.e, undefined);
});

const calls = [
  { agent_id: 'a', provider: 'gemini', ok: 1 }, { agent_id: 'a', provider: 'gemini', ok: 1 }, { agent_id: 'a', provider: 'gemini', ok: 0 },
  { agent_id: 'b', provider: 'gemini', ok: 1 }, { agent_id: 'b', provider: 'router', ok: 1 }, { agent_id: null, provider: 'router', ok: 1 },
];
const health = [{ provider: 'gemini', status: 'down' }, { provider: 'router', status: 'up' }];

test('dependencies: counts per agent and provider, the table has the same numbers, a failed health check marks the provider and its callers', () => {
  const m = dependencyModel({ agents, calls, health, label: (p) => p.toUpperCase() });
  const e = (a, p) => m.edges.find(x => x.agentId === a && x.provider === p)?.count;
  assert.equal(e('a', 'gemini'), 3); assert.equal(e('b', 'gemini'), 1); assert.equal(e('b', 'router'), 1);
  assert.equal(m.providers.find(p => p.provider === 'router').calls, 2, 'a call with no agent still counts for the provider');
  assert.equal(m.providers.find(p => p.provider === 'gemini').down, true);
  assert.equal(m.providers.find(p => p.provider === 'router').down, false);
  assert.deepEqual(m.agents.filter(a => a.affected).map(a => a.id).sort(), ['a', 'b']);
  assert.equal(m.agents.find(a => a.id === 'c'), undefined, 'an agent with no calls is not drawn');
  assert.deepEqual(m.table.map(r => [r.agent, r.provider, r.calls]), [['Scout', 'GEMINI', 3], ['Clerk', 'GEMINI', 1], ['Clerk', 'ROUTER', 1], ['The desk (Other)', 'ROUTER', 1]]);
});

test('dependencies: calls no agent made go to one node, The desk, split by purpose, so the picture adds up to the call log', () => {
  const log = [
    ...calls,
    { agent_id: null, provider: 'router', ok: 1, purpose: 'council' }, { agent_id: null, provider: 'router', ok: 1, purpose: 'council' },
    { agent_id: null, provider: 'gemini', ok: 1, purpose: 'draft' }, { agent_id: 'gone', provider: 'router', ok: 1, purpose: 'small' },
  ];
  const m = dependencyModel({ agents, calls: log, health });
  const sum = (xs) => xs.reduce((s, x) => s + x.calls, 0);
  assert.equal(m.edges.reduce((s, e) => s + e.count, 0), log.length, 'every call is on a line');
  assert.equal(sum(m.agents), log.length); assert.equal(sum(m.providers), log.length); assert.equal(sum(m.table), log.length);
  const desk = m.agents.find(a => a.name === 'The desk'); assert.equal(desk.calls, 5); assert.equal(m.agents.at(-1), desk, 'drawn after the agents');
  assert.deepEqual(m.table.filter(r => r.agent.startsWith('The desk')).map(r => [r.agent, r.provider, r.calls]),
    [['The desk (Council)', 'router', 2], ['The desk (Other)', 'router', 1], ['The desk (Small jobs)', 'router', 1], ['The desk (Drafts)', 'gemini', 1]]);
  assert.equal(desk.affected, true, 'it called a provider whose last check failed');
});

test('dependencies: every purpose under The desk is written the same way, first letter capital', () => {
  const log = ['chat', 'council', 'research', 'draft', 'small', 'bench-find', null].map(purpose => ({ agent_id: null, provider: 'router', ok: 1, purpose }));
  const words = dependencyModel({ calls: log }).table.map(r => r.agent.replace(/^The desk \((.*)\)$/, '$1'));
  assert.equal(words.length, log.length);
  for (const w of words) assert.equal(w[0], w[0].toUpperCase(), w);
  assert.ok(words.includes('Chat') && words.includes('Council') && words.includes('Other'));
});

test('dependencies: no provider health row means not checked, never down', () => {
  const m = dependencyModel({ agents, calls, health: [] });
  assert.ok(m.providers.every(p => p.down === false && p.health === null));
});

test('layout: agents left, providers right, line width grows with calls and stays bounded, empty input gives an empty picture', () => {
  const m = dependencyModel({ agents, calls, health });
  const g = layoutDeps(m, { width: 600 });
  assert.ok(g.agents.every(n => n.x < g.providers[0].x));
  const w = (a, p) => g.lines.find(l => l.agentId === a && l.provider === p).w;
  assert.ok(w('a', 'gemini') > w('b', 'gemini'));
  assert.ok(g.lines.every(l => l.w >= 1 && l.w <= 10));
  assert.equal(strokeWidth(100000, 100000), 10);
  assert.equal(layoutDeps(dependencyModel({ agents, calls: [], health }), {}).empty, true);
});

test('selection: a provider marks itself and its callers; a domain marks the agents that went there; nothing selected marks nothing', () => {
  const m = dependencyModel({ agents, calls, health, visits: [{ agentId: 'c', host: 'example.com' }] });
  const p = related(m, { kind: 'provider', key: 'router' });
  assert.deepEqual([...p.providers], ['router']); assert.deepEqual([...p.agents].sort(), ['(desk)', 'b'], 'the desk node is marked too: it called the router');
  const d = related(m, { kind: 'domain', key: 'Example.com' });
  assert.deepEqual([...d.agents], ['c']);
  const n = related(m, null); assert.equal(n.providers.size + n.agents.size, 0);
});

test('link side: a row of text gives a provider or a domain choice, and a choice marks matching rows only', async () => {
  const { pickFromText, textMatches } = await import('./ui-deskmap.js');
  const m = dependencyModel({ agents, calls, health, label: (p) => ({ gemini: 'Google Gemini', router: 'Free router' })[p] });
  assert.deepEqual(pickFromText('Google Gemini  12 calls  340 ms', m), { kind: 'provider', key: 'gemini' });
  assert.deepEqual(pickFromText('Checked wikipedia.org via https', m), { kind: 'domain', key: 'wikipedia.org' });
  assert.equal(pickFromText('Nothing useful here', m), null);
  assert.equal(textMatches('Google Gemini 12 calls', { kind: 'provider', key: 'gemini' }, m), true);
  assert.equal(textMatches('Free router 3 calls', { kind: 'provider', key: 'gemini' }, m), false);
  assert.equal(textMatches('en.wikipedia.org opened', { kind: 'domain', key: 'wikipedia.org' }, m), true);
  assert.equal(textMatches('anything', null, m), false);
});

test('drawing: the SVG has one node per agent, a line per edge, a failed provider is marked, and a choice dims the rest', async () => {
  const { drawAgentMap, drawDeps } = await import('./ui-desk.js');
  const mk = (tag) => ({ tag, attrs: {}, kids: [], text: '', listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.kids.push(...c); }, before() {}, get firstChild() { return this.kids[0]; }, set textContent(v) { this.text = v; }, get textContent() { return this.text; }, addEventListener(e, f) { this.listeners[e] = f; } });
  const doc = { createElementNS: (_, tag) => mk(tag) };
  const all = (n) => [n, ...n.kids.flatMap(all)];
  const states = agentStates({ agents, jobs: [], now: NOW });
  assert.equal(all(drawAgentMap(doc, states, { width: 640 })).filter(n => n.attrs['data-agent']).length, 4);
  const m = dependencyModel({ agents, calls, health });
  const svg = drawDeps(doc, m, { width: 600 });
  assert.equal(all(svg).filter(n => n.tag === 'line').length, 4, 'one more: the desk to the router');
  assert.ok(all(svg).some(n => n.text.includes('check failed')));
  let picked; const svg2 = drawDeps(doc, m, { width: 600, sel: { kind: 'provider', key: 'router' }, onSelect: (x) => { picked = x; } });
  const gem = all(svg2).find(n => n.attrs['data-provider'] === 'gemini'); assert.equal(Number(gem.attrs.opacity), 0.3);
  all(svg2).find(n => n.attrs['data-provider'] === 'router').listeners.click(); assert.equal(picked, null, 'a second click clears the mark');
});

test('link side: a decimal or an IP address is not a domain choice', async () => {
  const { pickFromText, textMatches } = await import('./ui-deskmap.js');
  const m = dependencyModel({ agents, calls, health });
  assert.equal(pickFromText('Download 94.3 Mbit/s at 10:42', m), null);
  assert.equal(pickFromText('Public address 203.0.113.5', m), null);
  assert.deepEqual(pickFromText('Checked en.wikipedia.org', m), { kind: 'domain', key: 'en.wikipedia.org' });
  assert.equal(textMatches('Latency 94.3 ms', { kind: 'domain', key: 'wikipedia.org' }, m), false);
});

test('table rows carry the last check: failed, passed, or not checked', () => {
  const m = dependencyModel({ agents, calls, health: [{ provider: 'gemini', status: 'down' }, { provider: 'router', status: 'up' }] });
  assert.deepEqual([...new Set(m.table.map(r => r.health))].sort(), ['down', 'up']);
  assert.equal(dependencyModel({ agents, calls, health: [] }).table.every(r => r.health === null), true);
});
