// A research question in the chat, in steps: a model plans the parts, each part is searched and read, one answer covers every
// part, and a part no page supported is listed plainly. Plumbing tests against the fake model; never proof (see real-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { parsePlan, names, supported, dropUnsupported, notAnsweredLine, SMALL_WRITER_LINE } from './research.js';

const ASK = 'can you find more details about VR200 and hows it different from GB200 or H100 ?';
const kvSet = (t, k, v) => t.core.storage.kvScope('m:chat').set(k, v);
const isPlan = (b) => /You plan how the desk answers/.test(String(b.messages?.[0]?.content || ''));
const isWriter = (b) => /The pages read in this turn/.test(String(b.messages?.at(-1)?.content || ''));
const PAGES = {
  vr200: 'NVIDIA Vera Rubin VR200 NVL144 is the next rack after Blackwell. The VR200 pairs a Vera CPU with Rubin GPUs and HBM4 memory. ' + 'More text about the rack and its cooling. '.repeat(8),
  gb200: 'The GB200 Grace Blackwell Superchip joins one Grace CPU and two Blackwell GPUs. GB200 NVL72 links 72 GPUs in one rack. ' + 'More text about the rack. '.repeat(8),
  other: 'A page about data centre power and cooling in general, with nothing on any one chip by name. ' + 'Filler sentence. '.repeat(12),
};
const waitReply = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    const last = r.json.messages.filter(m => m.role === 'assistant').at(-1);
    if (last && last.status !== 'streaming' && !r.json.chat.running) return { last, all: r.json.messages };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no reply');
};
/** A desk with stand-in search and page tools. order: every tool call and model call in turn, to check what came before what. */
async function researchDesk({ plan = { needsFacts: true, parts: ['VR200', 'GB200', 'H100'], compare: 'how they differ' }, answer, readDelay = 0 } = {}) {
  const order = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    if (isPlan(b)) { order.push('plan'); return typeof plan === 'string' ? plan : JSON.stringify(plan); }
    if (isWriter(b)) { order.push('write'); return answer || 'VR200 pairs a Vera CPU with Rubin GPUs [1].\nGB200 joins one Grace CPU and two Blackwell GPUs [3].\nH100 has 80 GB of HBM3 memory.\nSo VR200 is the newer rack.'; }
    order.push('model'); return 'A plain answer.';
  } });
  const searched = []; const read = [];
  t.core.modules.tools.set('web_search', { module: 'search', name: 'web_search', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } }, async run(a) {
    searched.push(a.query); order.push('search:' + a.query);
    const k = /vr200/i.test(a.query) ? 'vr200' : /gb200/i.test(a.query) ? 'gb200' : 'h100';
    return { results: [1, 2, 3].map(i => ({ title: `${k} ${i}`, url: `https://example.com/${k}/${i}`, snippet: 'a snippet' })) };
  } });
  t.core.modules.tools.set('web_read', { module: 'search', name: 'web_read', description: 'read', parameters: { type: 'object', properties: { url: { type: 'string' } } }, async run(a, call) {
    if (readDelay) await new Promise((r, no) => { const tm = setTimeout(r, readDelay); call.signal?.addEventListener('abort', () => { clearTimeout(tm); no(Object.assign(new Error('Stopped'), { code: 'aborted' })); }); });
    read.push(a.url); order.push('read:' + a.url.split('/')[3]);
    const k = a.url.split('/')[3];
    return { url: a.url, title: k === 'h100' ? 'Data centre cooling' : k + ' page', text: k === 'h100' ? PAGES.other : PAGES[k] };
  } });
  return { t, order, searched, read };
}

test('the plan: a model\'s JSON only; parts cleaned and capped; anything else is no plan', () => {
  assert.deepEqual(parsePlan({ needsFacts: true, parts: ['VR200', 'GB200', 'gb200', ' H100 '], compare: 'how they differ' }), { needsFacts: true, parts: ['VR200', 'GB200', 'H100'], compare: 'how they differ' });
  assert.deepEqual(parsePlan({ needsFacts: false, parts: ['x'] }), { needsFacts: false, parts: [], compare: '' });
  assert.equal(parsePlan({ parts: ['a'] }), null); assert.equal(parsePlan(null), null); assert.equal(parsePlan('yes'), null);
  assert.equal(parsePlan({ needsFacts: true, parts: ['a', 'b', 'c', 'd', 'e', 'f'] }).parts.length, 4);
  assert.deepEqual(parsePlan({ needsFacts: true, parts: [] }, 'gold price today').parts, ['gold price today']);
});

test('a part is supported only by a page that names it; lines about an unsupported part go; the line for it is plain', () => {
  assert.ok(names('The GB200 NVL72 rack', 'GB200')); assert.ok(!names('The GB2000 rack', 'GB200')); assert.ok(names('nvidia h100 sxm', 'NVIDIA H100'));
  assert.ok(supported('VR200', [{ text: PAGES.vr200 }])); assert.ok(!supported('H100', [{ text: PAGES.other }, { text: PAGES.gb200 }]));
  const d = dropUnsupported('VR200 is new.\nH100 has 80 GB.\n| H100 | 80 GB |\nH100: not checked.', ['H100']);
  assert.equal(d.text, 'VR200 is new.\nH100: not checked.'); assert.equal(d.dropped, 2);
  assert.equal(notAnsweredLine(['H100']), 'Not answered: H100: no page read said it.');
});

test('with "Deep research in chat" on, the owner\'s question runs in steps: plan shown, each part searched and read, one answer, H100 listed as not answered', async () => {
  const { t, order, searched, read } = await researchDesk();
  try {
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: ASK } });
    const { last } = await waitReply(t, 'dm-scout');
    assert.equal(order[0], 'plan', 'one planning call first');
    assert.deepEqual(searched, ['VR200', 'GB200', 'H100'], 'each part searched once');
    for (const k of ['vr200', 'gb200']) assert.ok(read.filter(u => u.includes('/' + k + '/')).length >= 2, 'two pages read for ' + k);
    assert.ok(order.indexOf('write') > order.lastIndexOf(order.find(x => x.startsWith('read:h100'))), 'pages read before the answer');
    assert.equal(order.filter(x => x === 'write').length, 1, 'one answer');
    const card = last.cards.find(c => c.kind === 'progress');
    assert.match(card.title, /VR200 · GB200 · H100/); assert.equal(card.status, 'done'); assert.match(card.detail, /pages read for 3 parts/);
    assert.match(last.text, /VR200 pairs a Vera CPU/); assert.match(last.text, /GB200 joins/);
    assert.match(last.text, /Not answered: H100: no page read said it\./);
    assert.doesNotMatch(last.text, /80 GB/, 'nothing no page said is stated');
    assert.deepEqual(last.meta.research.notAnswered, ['H100']);
    assert.ok(last.cards.some(c => c.kind === 'sources' && c.items.length >= 4));
    assert.ok(last.meta.steps.filter(s => s.tool === 'web_read' && s.status === 'done').length >= 4);
    assert.doesNotMatch(last.text, new RegExp(SMALL_WRITER_LINE.replace(/[.;]/g, '.')));
  } finally { await t.close(); }
});

test('with the switch off, or with no plan back, or a plan that needs no facts, the turn is today\'s turn', async () => {
  for (const [what, setup] of [['off', async (t) => t.call('/api/m/chat/chats/dm-scout', { method: 'PATCH', body: { settings: { deepResearch: false } } })], ['junk', null], ['no facts', null]]) {
    const { t, order, searched } = await researchDesk({ plan: what === 'junk' ? 'I think so' : what === 'no facts' ? { needsFacts: false, parts: [] } : undefined });
    try {
      if (setup) await setup(t);
      await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: ASK } });
      const { last } = await waitReply(t, 'dm-scout');
      assert.equal(order.includes('plan'), what !== 'off', what);
      assert.deepEqual(searched, [], what); assert.equal(last.text, 'A plain answer.', what); assert.equal(last.meta.research, undefined, what);
    } finally { await t.close(); }
  }
});

test('a research answer written by a small local model says so plainly', async () => {
  const { t } = await researchDesk();
  try {
    const door = t.core.model; const orig = door.chat.bind(door);
    door.chat = async (o) => { const r = await orig(o); return o.purpose === 'research' ? { ...r, small: true } : r; };
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: ASK } });
    const { last } = await waitReply(t, 'dm-scout');
    assert.ok(last.text.endsWith(SMALL_WRITER_LINE), last.text); assert.equal(last.meta.smallWriter, true);
  } finally { await t.close(); }
});

test('Stop stops a research turn while it reads; the time limit ends the reading and the answer is still written', async () => {
  const { t, read } = await researchDesk({ readDelay: 2000 });
  try {
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: ASK } });
    const t0 = Date.now(); while (!read.length && Date.now() - t0 < 400) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 300));
    await t.call('/api/m/chat/chats/dm-scout/stop', { method: 'POST' });
    const { last } = await waitReply(t, 'dm-scout');
    assert.equal(last.status, 'stopped');
    await new Promise(r => setTimeout(r, 300));
    const m = (await t.call('/api/m/chat/chats/dm-scout/messages')).json.messages.filter(x => x.role === 'assistant').at(-1);
    assert.equal(m.cards.find(c => c.kind === 'progress')?.status, 'stopped');
  } finally { await t.close(); }
  const d = await researchDesk({ readDelay: 400 });
  try {
    kvSet(d.t, 'researchTurnMs', 16500);   // room for about one part: the rest is not read, and the answer is still written
    await d.t.call('/api/m/chat/chats/dm-scout/send', { body: { text: ASK } });
    const { last } = await waitReply(d.t, 'dm-scout', 30000);
    assert.ok(d.order.includes('write')); assert.ok(last.meta.research.ms < 17000, String(last.meta.research.ms));
    assert.ok(last.meta.research.notAnswered.length >= 1);
  } finally { await d.t.close(); }
});

test('a table file still wins over the research turn', async () => {
  const { t, order } = await researchDesk();
  try {
    t.core.modules.tools.set('table_file', { module: 'office', name: 'table_file', description: 'table', parameters: { type: 'object', properties: {} }, async run() { return { ok: true, path: 'tables/x.xlsx', name: 'x.xlsx' }; } });
    await t.call('/api/m/chat/chats/dm-coder/send', { body: { text: 'Compare VR200, GB200 and H100 into a table file.' } });
    await waitReply(t, 'dm-coder');
    assert.ok(!order.includes('plan'));
  } finally { await t.close(); }
});

/** An Ollama stand-in with one small model (sizes and capabilities as Ollama reports them). */
async function fakeOllama(answer) {
  const http = await import('node:http'); const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/tags') return json({ models: [{ name: 'llama3.2:1b', size: 1, details: { parameter_size: '1.2B' } }] });
    if (req.url === '/api/show') return json({ capabilities: ['completion', 'tools'] });
    calls.push(body); const text = answer(body);
    if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`); res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return res.end(); }
    json({ model: body.model, choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

test('on the owner\'s chain (Free API busy, a 1B local fallback, a free key) the key writes the research answer; with the key off the 1B model writes it and says so', async () => {
  const plan = JSON.stringify({ needsFacts: true, parts: ['VR200', 'GB200'], compare: 'how they differ' });
  const answer = (b) => isPlan(b) ? plan : isWriter(b) ? `VR200 pairs a Vera CPU with Rubin GPUs [1]. GB200 joins one Grace CPU and two Blackwell GPUs [3]. (${b.model})` : 'A plain answer.';
  const ol = await fakeOllama(answer);
  const t = await testDesk({ modules: ['chat', 'agents'], chain: 'owner', fallback: { provider: 'ollama', model: 'llama3.2:1b' }, script: (b) => b.model === 'gemini-test' ? answer(b) : { status: 429, text: 'rate limit exceeded' } });
  try {
    t.core.settings.set('ollama.baseUrl', ol.url); t.core.model.cache.clear();
    t.core.model.addKey('gemini', 'gm-test-12345678', 'test', { baseUrl: t.fake.baseUrl, model: 'gemini-test' });
    t.core.modules.tools.set('web_search', { module: 'search', name: 'web_search', description: 's', parameters: { type: 'object', properties: {} }, async run(a) { const k = /vr/i.test(a.query) ? 'vr200' : 'gb200'; return { results: [1, 2].map(i => ({ url: `https://example.com/${k}/${i}` })) }; } });
    t.core.modules.tools.set('web_read', { module: 'search', name: 'web_read', description: 'r', parameters: { type: 'object', properties: {} }, async run(a) { const k = a.url.split('/')[3]; return { url: a.url, title: k, text: PAGES[k] }; } });
    assert.deepEqual(t.core.model.resolve('scout').chain.map(c => c.provider), ['router', 'ollama', 'ollama', 'gemini'], 'the owner\'s chain: one router step, his fallback, the default Ollama step, the key');
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: ASK } });
    let { last } = await waitReply(t, 'dm-scout');
    assert.ok(last.meta.research, 'a research turn ran'); assert.match(last.label, /Gemini/, 'the key wrote it: ' + last.label);
    assert.doesNotMatch(last.text, /small local model/); assert.ok(!ol.calls.some(isWriter), 'the 1B model did not write');
    for (const k of t.core.model.keysFor('gemini')) t.core.model.toggleKey(k.id, false);
    await t.call('/api/m/chat/chats/dm-scout/send', { body: { text: ASK + ' Again please.' } });
    ({ last } = await waitReply(t, 'dm-scout'));
    assert.match(last.label, /Ollama · llama3\.2:1b/); assert.ok(last.text.endsWith(SMALL_WRITER_LINE)); assert.equal(last.meta.smallWriter, true);
  } finally { await t.close(); await ol.close(); }
});
