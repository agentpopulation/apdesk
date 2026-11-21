// Section I: website rules for the agents. Pure rule matching, the two address guards, and the owner-only routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registrable, ruleDomain, covers, setRules, setAsker, clearRules, ruleFor, siteRuleSync, resolverRules, withWho, callerModule } from './rules.js';
import { checkUrl as searchCheck, checkUrlDeep as searchDeep } from '../search/guard.js';
import { readPage } from '../search/reader.js';
import { checkUrl as browserCheck, checkUrlDeep as browserDeep } from '../browser/guard.js';
import { testDesk } from '../../test/helpers/desk.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('a rule covers the registrable domain and every name under it, nothing else', () => {
  assert.equal(registrable('www.news.example.co.uk'), 'example.co.uk');
  assert.equal(registrable('A.B.Example.COM.'), 'example.com');
  assert.equal(ruleDomain('https://Shop.Example.com/x?y'), 'example.com');
  assert.equal(ruleDomain('example.com.'), 'example.com');
  assert.throws(() => ruleDomain('com'), /site name/);
  assert.throws(() => ruleDomain('not a site'), /not a site name/);
  assert.match(covers('example.com'), /example\.com and every name under it/);
  setRules({ never: ['example.com'], ask: ['wikipedia.org'] });
  for (const h of ['example.com', 'EXAMPLE.com', 'example.com.', 'www.example.com', 'a.b.example.com', '[example.com]']) assert.equal(ruleFor(h)?.kind, 'never', h);
  for (const h of ['notexample.com', 'example.com.evil.net', 'example.org', 'example.co']) assert.equal(ruleFor(h), null, h);
  assert.equal(ruleFor('de.wikipedia.org').kind, 'ask');
  clearRules();
});

test('never: the search guard refuses a direct read, any spelling, a subdomain and a redirect to it', async () => {
  setRules({ never: ['blocked.example'] });
  for (const u of ['https://blocked.example/', 'https://BLOCKED.example/x', 'https://blocked.example./', 'https://www.blocked.example/', 'http://deep.sub.blocked.example:8080/']) assert.throws(() => searchCheck(u), (e) => e.code === 'rule_never', u);
  assert.equal(searchCheck('https://fine.example/').hostname, 'fine.example');
  const sent = [];
  const fetchFn = async (u) => { sent.push(String(u)); return new Response(null, { status: 302, headers: { location: 'https://Www.Blocked.Example./secret' } }); };
  await assert.rejects(readPage(fetchFn, 'https://fine.example/go', { lookup: publicLookup }), (e) => e.code === 'rule_never');
  assert.deepEqual(sent, ['https://fine.example/go'], 'the blocked hop was never requested');
  clearRules();
});

test('never: the browser guard refuses it too; its browser gets a resolver rule so redirects cannot reach it', async () => {
  setRules({ never: ['blocked.example'] });
  assert.match(browserCheck('https://sub.blocked.example/'), /never open blocked\.example/);
  assert.match(await browserDeep('https://BLOCKED.example./'), /never open/);
  assert.equal(browserCheck('https://fine.example/'), null);
  assert.equal(resolverRules(), '--host-resolver-rules=MAP blocked.example ~NOTFOUND, MAP *.blocked.example ~NOTFOUND');
  assert.equal(browserCheck('https://blocked.example/', { who: { owner: true } }), null, 'the owner driving is not bound by the agents’ rules');
  clearRules();
  assert.equal(resolverRules(), null);
});

test('ask first: one approval per job, a no is final for that job, another job asks again', async () => {
  setRules({ ask: ['careful.example'] });
  const asked = []; let answer = false;
  setAsker(async ({ domain, url, who }) => { asked.push([domain, who?.jobId]); return answer; });
  assert.throws(() => searchCheck('https://careful.example/'), (e) => e.code === 'rule_ask', 'the text-only check never opens it unasked');
  const job1 = { agentId: 'scout', jobId: 'j1' };
  await assert.rejects(searchDeep('https://careful.example/a', { lookup: publicLookup, who: job1 }), (e) => e.code === 'rule_denied');
  await assert.rejects(searchDeep('https://www.careful.example/b', { lookup: publicLookup, who: job1 }), (e) => e.code === 'rule_denied');
  assert.equal(asked.length, 1, 'asked once; the no held for the rest of the job');
  assert.throws(() => siteRuleSync('careful.example', { who: job1 }), (e) => e.code === 'rule_denied');
  answer = true;
  const job2 = { agentId: 'scout', jobId: 'j2' };
  assert.equal((await withWho(job2, () => searchDeep('https://careful.example/', { lookup: publicLookup }))).hostname, 'careful.example');
  assert.equal(asked.length, 2);
  assert.equal(await browserDeep('https://careful.example/', { who: job2 }), null, 'the yes holds in the browser for the same job');
  assert.equal(browserCheck('https://img.careful.example/x.png', { who: job2 }), null);
  assert.match(browserCheck('https://careful.example/', { who: { jobId: 'j3' } }), /asked to be asked/);
  clearRules();
});

test('callerModule names the module that asked for a read', () => {
  assert.equal(callerModule('Error\n at read (/x/modules/search/server.js:1)\n at run (/x/modules/research/deep.js:9)'), 'research');
  assert.equal(callerModule('Error\n at x (C:\\apd\\modules\\sales\\find.js:3)'), 'sales');
  assert.equal(callerModule('Error\n at y (/x/app/core/jobs.js:1)'), null);
});

test('desk: only the owner changes the rules; agents meet them in web_read; no tool edits them', async () => {
  const t = await testDesk({ modules: ['search', 'browser', 'network'] });
  try {
    await t.call('/api/modules/network/on', { method: 'POST' });
    assert.equal((await t.call('/api/m/network/rules', { body: { kind: 'never', entry: 'blocked.example' }, session: false })).status, 403);
    const r = await t.call('/api/m/network/rules', { body: { kind: 'never', entry: 'https://www.Blocked.example/x' } });
    assert.equal(r.status, 200); assert.equal(r.json.never[0].domain, 'blocked.example'); assert.match(r.json.never[0].covers, /every name under it/);
    const out = await t.core.modules.runTool('web_read', { url: 'https://news.blocked.example/' }, { agentId: 'scout', chatId: 'c1' });
    assert.match(out.error, /never open blocked\.example/);
    const v = (await t.call('/api/m/network/visits')).json.visits;
    assert.equal(v[0].host, 'news.blocked.example'); assert.equal(v[0].result, 'blocked');
    const tools = [...t.core.modules.tools.keys()];
    assert.ok(!tools.some(n => /rule|allow|block/i.test(n)), 'no Coordinator tool can change the lists: ' + tools.join(', '));
    assert.equal((await t.call('/api/m/network/rules', { method: 'DELETE', body: { domain: 'blocked.example' }, session: false })).status, 403);
    await t.call('/api/modules/network/off', { method: 'POST' });
    assert.equal(ruleFor('blocked.example'), null, 'switched off: the module takes its rules with it');
    await t.call('/api/modules/network/on', { method: 'POST' });
    assert.equal(ruleFor('blocked.example')?.kind, 'never', 'switched on again: the stored rules are back');
  } finally { await t.close(); clearRules(); }
});
