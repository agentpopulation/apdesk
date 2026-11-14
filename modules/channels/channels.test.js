import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanApiBase, tokenRefused } from './telegram.js';
import { cleanServerUrl, randomTopic, validTopic } from './ntfy.js';
import { testDesk } from '../../test/helpers/desk.js';

test('addresses: https, or http only on this PC (Telegram) or the home network (ntfy)', () => {
  assert.equal(cleanApiBase(''), 'https://api.telegram.org');
  assert.equal(cleanApiBase('http://127.0.0.1:5000/'), 'http://127.0.0.1:5000');
  assert.throws(() => cleanApiBase('http://evil.example'));
  assert.equal(cleanServerUrl('http://192.168.1.5'), 'http://192.168.1.5');
  assert.throws(() => cleanServerUrl('http://ntfy.example.com'));
  assert.ok(validTopic(randomTopic()));
  assert.ok(tokenRefused({ status: 401 }) && tokenRefused({ status: 404 }) && !tokenRefused({ status: 200 }));
});
test('plumbing (fake model): a stranger is listed, never answered; send needs a grant', async () => {
  const t = await testDesk({ modules: ['channels'] });
  try {
    await t.call('/api/modules/channels/on', { method: 'POST' });
    const api = t.desk.modules.api('channels');
    await assert.rejects(() => api.send({ channel: 'telegram', to: '5', text: 'x', approvalId: 'nope' }), /token|approval/i);
    assert.equal((await t.call('/api/m/channels/telegram/settings', { body: { allowed: ['1'] }, session: false })).status, 403);
    const r = await t.call('/api/m/channels/send', { body: { channel: 'whatsapp', to: '5', text: 'x' } });
    assert.equal(r.status, 409);
  } finally { await t.close(); }
});
