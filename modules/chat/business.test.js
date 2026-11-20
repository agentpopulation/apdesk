// The owner's business text: the desk asks for it when an ask leans on it, and carries on. Plumbing tests against the fake
// model only; never evidence that a real model does the right thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { onlyOwnBusiness, ASK_ABOUT } from './business.js';
import { waitLine } from './ui-text.js';

const CHIP = 'Find 20 leads with sources for my product';
const ABOUT = 'Payroll software for small firms; HR heads buy it; India.';
const settle = async (t, chatId, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await t.call(`/api/m/chat/chats/${chatId}/messages`);
    const last = r.json.messages.filter(m => m.role === 'assistant').at(-1);
    if (last && last.status !== 'streaming' && !r.json.chat.running) return { last, all: r.json.messages, chat: r.json.chat };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('no reply');
};
/** A fake leads tool and a script that fills the query from the ask: "my product" from the chip, a named subject otherwise. */
const leadsDesk = async (prompts) => {
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => {
    prompts.push(b.messages);
    const offered = (b.tools || []).map(x => x.function.name);
    if (b.messages.at(-1).role === 'tool') return 'The lead search has started.';
    const ask = String(b.messages.filter(m => m.role === 'user').at(-1)?.content || '');
    if (!offered.includes('leads_find')) return 'no tools';
    const named = ask.match(/leads?:\s*(.+)$/i);
    return { toolCalls: [{ name: 'leads_find', args: { query: named ? named[1] : 'companies that need my product', count: 20 } }] };
  } });
  const ran = [];
  t.core.modules.tools.set('leads_find', { module: 'sales', name: 'leads_find', description: 'find leads', parameters: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'integer' } } }, async run(args) { ran.push(args); return { ok: true, jobId: 'job_abcdefgh', text: 'Looking for leads now.' }; } });
  return { t, ran };
};

test('the structural test: "my product" with nothing else names no business; a named subject does', () => {
  for (const q of [CHIP, 'companies that need my product', 'potential customers for our product', 'buyers of my service', 'leads for our company']) assert.equal(onlyOwnBusiness(q), true, q);
  for (const q of ['Indian companies that sell payroll software', 'dental clinics in Pune for my product', 'leads for our CRM software', 'Find 20 leads with sources', 'bakeries in Pune', '']) assert.equal(onlyOwnBusiness(q), false, q);
});

test('empty profile + the "my product" chip: no job, the desk asks; the answer is saved and the ask runs once with it', async () => {
  const prompts = []; const { t, ran } = await leadsDesk(prompts);
  try {
    let r = await t.call('/api/m/chat/chats/sales-room/send', { body: { text: CHIP, chip: true, needsBusiness: true } });
    assert.equal(r.json.asked, true);
    let s = await settle(t, 'sales-room');
    assert.equal(s.last.text, ASK_ABOUT); assert.equal(ran.length, 0); assert.equal(prompts.length, 0, 'no model was asked');
    assert.equal(s.chat.settings.awaitBusiness.text, CHIP);
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: '  ' + ABOUT + '  ' } });
    s = await settle(t, 'sales-room');
    assert.equal(t.core.settings.get('business.about'), ABOUT);
    assert.ok(s.all.some(m => m.role === 'assistant' && m.text === `Saved: "${ABOUT.slice(0, -1)}". You can change it in Settings › General.`));
    assert.equal(ran.length, 1, 'the original ask ran once');
    assert.match(ran[0].query, /Payroll software for small firms/, 'the lead search topic comes from his words');
    assert.ok(prompts.at(-1)[0].content.includes(`About the owner's business, in his own words`) && prompts.at(-1)[0].content.includes(ABOUT));
    assert.equal(s.all.filter(m => m.role === 'user' && m.text === CHIP).length, 1, 'he did not have to repeat the ask');
    assert.equal(s.chat.settings.awaitBusiness, null);
  } finally { await t.close(); }
});

test('empty profile + the same ask typed: the model fills "my product", the desk asks first; a typed ask with its own subject just runs', async () => {
  const prompts = []; const { t, ran } = await leadsDesk(prompts);
  try {
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: CHIP } });
    let s = await settle(t, 'sales-room');
    assert.equal(s.last.text, ASK_ABOUT); assert.equal(ran.length, 0); assert.ok(s.chat.settings.awaitBusiness);
    await t.call('/api/m/chat/chats/dm-closer/send', { body: { text: 'Find 20 leads: Indian companies that sell payroll software' } });
    s = await settle(t, 'dm-closer');
    assert.equal(ran.length, 1); assert.equal(ran[0].query, 'Indian companies that sell payroll software');
    assert.notEqual(s.last.text, ASK_ABOUT); assert.ok(!s.chat.settings.awaitBusiness);
    assert.equal(t.core.settings.get('business.about'), '');
  } finally { await t.close(); }
});

test('waiting + another chip or a typed ask of its own: that ask runs, nothing is saved; a plain line is taken as the answer', async () => {
  const prompts = []; const { t, ran } = await leadsDesk(prompts);
  try {
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: CHIP, chip: true, needsBusiness: true } }); await settle(t, 'sales-room');
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: 'Research this company before my call', chip: true } });
    let s = await settle(t, 'sales-room');
    assert.equal(t.core.settings.get('business.about'), ''); assert.ok(!s.chat.settings.awaitBusiness);
    assert.equal(prompts.length, 1, 'the other chip went to the model'); assert.equal(ran.length, 0);
    // typed asks of their own, and nearby answers on the other side
    for (const [ask, isAsk] of [['find 20 leads: clinics in Pune', true], ['Who are you?', true], ['We sell schedule software to clinics in Pune', false], ['Dental clinic software, sold to clinic owners in Pune', false]]) {
      await t.call('/api/m/chat/chats/sales-room/send', { body: { text: CHIP, chip: true, needsBusiness: true } }); s = await settle(t, 'sales-room');
      if (t.core.settings.get('business.about')) { t.core.settings.set('business.about', ''); }
      assert.ok(s.chat.settings.awaitBusiness, 'waiting again: ' + ask);
      await t.call('/api/m/chat/chats/sales-room/send', { body: { text: ask } }); s = await settle(t, 'sales-room');
      assert.equal(t.core.settings.get('business.about'), isAsk ? '' : ask, ask);
      t.core.settings.set('business.about', '');
    }
  } finally { await t.close(); }
});

test('profile set: the chip runs at once, the prompt carries the fact block, and "my product" becomes his words', async () => {
  const prompts = []; const { t, ran } = await leadsDesk(prompts);
  try {
    t.core.settings.set('business.about', ABOUT);
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: CHIP, chip: true, needsBusiness: true } });
    const s = await settle(t, 'sales-room');
    assert.notEqual(s.last.text, ASK_ABOUT); assert.equal(ran.length, 1);
    assert.equal(ran[0].query, 'Companies that would buy this: ' + ABOUT);
    assert.match(prompts[0][0].content, /do not add to it\):\n"""\nPayroll software/);
    assert.doesNotMatch(prompts[0][0].content, /UNTRUSTED CONTENT[^\n]*\n[^\n]*Payroll/, 'his own words are not wrapped as page data');
  } finally { await t.close(); }
});

test('Stop and "Not now" drop the wait; a new chat never waits; Panic drops it too', async () => {
  const prompts = []; const { t, ran } = await leadsDesk(prompts);
  try {
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: CHIP, chip: true, needsBusiness: true } });
    let s = await settle(t, 'sales-room'); assert.ok(s.chat.settings.awaitBusiness);
    assert.deepEqual(s.last.cards, [{ kind: 'actions', actions: [{ label: 'Not now', stopAsk: true }] }]);
    assert.equal((await t.call('/api/m/chat/chats/sales-room/stop', { method: 'POST' })).json.stopped, true);
    s = await settle(t, 'sales-room'); assert.ok(!s.chat.settings.awaitBusiness);
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: 'Payroll software' } }); await settle(t, 'sales-room');
    assert.equal(t.core.settings.get('business.about'), '', 'after Stop his next message is a message, not the profile');
    await t.call('/api/m/chat/chats/sales-room/send', { body: { text: CHIP, chip: true, needsBusiness: true } }); await settle(t, 'sales-room');
    const c = (await t.call('/api/m/chat/chats', { body: { title: 'New chat', members: ['coordinator'] } })).json;
    assert.ok(!c.settings.awaitBusiness);
    await t.call('/api/panic', { body: { reason: 'test' } });
    s = await settle(t, 'sales-room'); assert.ok(!s.chat.settings.awaitBusiness);
    await t.call('/api/panic/resume', { method: 'POST' });
    assert.equal(ran.length, 0);
  } finally { await t.close(); }
});

test('the waiting line points at Models only when the free router is all there is', () => {
  const since = new Date(Date.now() - 25000).toISOString();
  assert.match(waitLine({ text: 'Waiting for a model to answer', since, limitS: 150, freeOnly: true }), /Some models are slow \(a free key or a local model in Models is faster\); the desk stops waiting at 150 s\.$/);
  assert.match(waitLine({ text: 'Waiting for a model to answer', since, limitS: 150 }), /Some models are slow; the desk stops waiting at 150 s\.$/);
  assert.doesNotMatch(waitLine({ text: 'Waiting', since: new Date().toISOString(), limitS: 150, freeOnly: true }), /Models/);
});

test('drafts: an offer of only "my product" is never saved; with no profile the desk asks, with one the drafts run without it', async () => {
  const got = [];
  const t = await testDesk({ modules: ['chat', 'agents'], script: (b) => b.messages.at(-1).role === 'tool' ? 'Drafts are waiting for you.' : ((b.tools || []).some(x => x.function.name === 'outreach_draft') ? { toolCalls: [{ name: 'outreach_draft', args: { top: 5, offer: 'my product' } }] } : 'no tool') });
  try {
    t.core.modules.tools.set('outreach_draft', { module: 'sales', name: 'outreach_draft', description: 'drafts', parameters: { type: 'object', properties: { top: { type: 'integer' }, offer: { type: 'string' } } }, async run(args) { got.push(args); return { ok: true, text: 'drafts' }; } });
    await t.call('/api/m/chat/chats/dm-closer/send', { body: { text: 'Draft outreach to the top five leads' } });
    let s = await settle(t, 'dm-closer');
    assert.equal(s.last.text, ASK_ABOUT); assert.equal(got.length, 0);
    await t.call('/api/m/chat/chats/dm-closer/send', { body: { text: ABOUT } });
    s = await settle(t, 'dm-closer');
    assert.equal(got.length, 1); assert.equal(got[0].offer, undefined, 'the empty offer is dropped'); assert.equal(got[0].top, 5);
  } finally { await t.close(); }
});
