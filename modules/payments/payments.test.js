// Plumbing tests for Payments and Spend (no model). real-check.mjs has the real proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

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
