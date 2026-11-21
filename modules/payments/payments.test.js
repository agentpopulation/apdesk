// Plumbing tests for Payments and Spend (no model). real-check.mjs has the real proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testDesk } from '../../test/helpers/desk.js';

test('the spend page names today\'s calls whose cost cannot be known, counted toward the limit at the list price', async () => {
  const t = await testDesk({ modules: ['payments'] });
  try {
    await t.call('/api/modules/payments/on', { body: {} });
    t.core.settings.set('currency', 'INR');
    // a model call today whose cost the desk cannot know (NULL): it still counts toward the limit at the providers' list price
    t.core.storage.run("INSERT INTO calls (at, purpose, provider, model, ok, ms, input_tokens, output_tokens, cost_minor, currency) VALUES (?, 'chat', 'gemini', 'gemini-3.5-flash-lite', 1, 10, 1000000, 1000000, NULL, 'INR')", new Date().toISOString());
    const r = (await t.call('/api/m/payments/log')).json;
    assert.equal(r.unknownToday.calls, 1);
    assert.ok(r.unknownToday.minor >= 1, 'the unknown part is named at the list price, never silently zero');
    const src = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
    assert.match(src, /cost the desk cannot know/, 'the Today line names the unknown part');
    assert.match(src, /counted toward your daily limit/);
    // the Spent box must not feed a bare null to replaceChildren (it would render the word "null" on screen when no call has an unknown cost)
    assert.match(src, /spentBox\.replaceChildren\(\s*\.\.\.\[[\s\S]*?\]\.filter\(Boolean\)\)/, 'the Spent box drops empty children instead of rendering "null"');
  } finally { await t.close(); }
});

test('on: Open level within limits is allowed and logged; record() and limits() work; off removes the tool', async () => {
  const t = await testDesk({ modules: ['payments'] });
  try {
    await t.call('/api/modules/payments/on', { body: {} });
    const api = t.core.modules.api('payments');
    assert.equal(api.limits().perItem, 200000);
    const r = await t.core.modules.runTool('spend_request', { what: 'Cable', price: 100 }, { agentId: 'operator' });
    assert.equal(r.decision, 'approved');
    assert.equal(api.list()[0].how, 'level');
    api.record({ what: 'Bought by the owner', amount: 5000, currency: 'INR' });
    assert.equal(api.list()[0].decision, 'recorded');
    const w = await t.core.modules.runTool('spend_request', { what: 'Laptop', price: 90000 }, { agentId: 'operator' });
    assert.equal(w.decision, 'waiting');
    assert.equal(w.overLimit, 'per item limit');
    await assert.rejects(t.core.modules.runTool('spend_request', { what: 'x', price: 0 }, {}));
    await t.call('/api/modules/payments/off', { body: {} });
    assert.equal(t.core.modules.tools.has('spend_request'), false);
  } finally { await t.close(); }
});
