// Plumbing: the send rule. Real delivery is proved in modules/sales/real-check.mjs against a loopback SMTP server.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { testDesk } from '../../test/helpers/desk.js';
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');

test('mail sends only with a granted approval, once', async () => {
  const got = [];
  const srv = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], logger: false, onData(s, sess, cb) { s.resume(); s.on('end', () => { got.push(sess.envelope.rcptTo[0].address); cb(); }); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const t = await testDesk({ modules: ['mail'] });
  try {
    assert.equal((await t.call('/api/m/mail/state')).status, 404);
    await t.call('/api/modules/mail/on', { method: 'POST' });
    await t.call('/api/m/mail/accounts', { body: { email: 'me@desk.test', smtp: { host: '127.0.0.1', port: srv.server.address().port, tls: 'none' } } });
    const d = (await t.call('/api/m/mail/drafts', { body: { to: 'a@example.test', subject: 's', body: 'b' } })).json.draft;
    const api = t.core.modules.api('mail');
    assert.equal(d.approvalId, null); assert.equal(t.core.approval.listPending().length, 0, 'saving a draft creates no approval');
    await t.call(`/api/m/mail/drafts/${d.id}`, { method: 'PATCH', body: { body: 'b2' } });
    assert.equal(t.core.approval.listPending().length, 0, 'editing a draft creates no approval');
    assert.equal((await t.call(`/api/m/mail/drafts/${d.id}/send`, { method: 'POST' })).status, 409, 'a press that does not carry what was shown is refused');
    const ask = (await t.call(`/api/m/mail/drafts/${d.id}/send`, { body: (await t.call(`/api/m/mail/drafts/${d.id}`)).json.send })).json;
    assert.ok(ask.approvalId); d.approvalId = ask.approvalId;
    await assert.rejects(api.send({ draftId: d.id, approvalId: d.approvalId }), /No approval/);
    t.core.settings.set('online', false);
    const off = t.core.modules.api('mail'); const acct = off.accounts()[0];
    t.core.storage.run("UPDATE m_mail_accounts SET smtp_host = 'smtp.example.test', smtp_tls = 'ssl' WHERE id = ?", acct.id);
    await assert.rejects(api.send({ draftId: d.id, approvalId: d.approvalId }), (e) => e.code === 'offline' && /offline/.test(e.message));
    t.core.storage.run("UPDATE m_mail_accounts SET smtp_host = '127.0.0.1', smtp_tls = 'none' WHERE id = ?", acct.id);
    t.core.settings.set('online', true);
    await t.call(`/api/approvals/${d.approvalId}/approve`, { method: 'POST' });
    for (let i = 0; i < 30 && !got.length; i++) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(got, ['a@example.test']);
    await assert.rejects(api.send({ to: 'a@example.test', subject: 's', body: 'b2', approvalId: d.approvalId }), /No approval/);
    await t.call('/api/modules/mail/off', { method: 'POST' });
    assert.equal((await t.call('/api/m/mail/state')).status, 404);
  } finally { await t.close(); await new Promise(r => srv.close(r)); }
});

test('a mail draft with no address cannot be sent: the press is refused and no approval is asked; the page offers "Add an address"', async () => {
  const t = await testDesk({ modules: ['mail'] });
  try {
    await t.call('/api/modules/mail/on', { method: 'POST' });
    const d = (await t.call('/api/m/mail/drafts', { body: { to: '', subject: 'Hi', body: 'Hello. Could we talk?' } })).json.draft;
    const r = await t.call(`/api/m/mail/drafts/${d.id}/send`, { method: 'POST' });
    assert.equal(r.status, 409); assert.match(r.json.error, /no address/); assert.equal(t.core.approval.listPending().length, 0);
    const fs = await import('node:fs');
    assert.match(fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8'), /!d\.to \? \{ label: 'Add an address'/);
  } finally { await t.close(); }
});

test('Mail "Approve and send": the confirm shows the draft as stored now (To, subject, full body); an edit after the confirm is shown is refused; only the shown item is sent', async () => {
  const got = [];
  const srv = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], logger: false, onData(s, sess, cb) { let raw = ''; s.on('data', c => { raw += c; }); s.on('end', () => { got.push({ to: sess.envelope.rcptTo[0].address, raw }); cb(); }); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const t = await testDesk({ modules: ['mail'] });
  try {
    await t.call('/api/modules/mail/on', { method: 'POST' });
    await t.call('/api/m/mail/accounts', { body: { email: 'me@desk.test', smtp: { host: '127.0.0.1', port: srv.server.address().port, tls: 'none' } } });
    const { confirmAndSend } = await import('./ui.js');
    const text = (n) => !n || typeof n !== 'object' ? String(n ?? '') : n.kids.map(text).join('');
    const confirms = []; let onConfirm = null;
    const ui = { h: (tag, attrs, ...kids) => ({ tag, kids: kids.flat(Infinity).filter(k => k != null) }),
      api: async (path, o = {}) => { const r = await t.call('/api/' + path, o); if (r.status >= 400) throw new Error(r.json?.error); return r.json; },
      confirm: async (node) => { confirms.push(text(node)); return onConfirm ? onConfirm() : true; },
      decide: async (id, d) => (await t.call(`/api/approvals/${id}/${d}`, { method: 'POST' })).json };
    const d = (await t.call('/api/m/mail/drafts', { body: { to: 'a@x.example', subject: 'Hi', body: 'Old body.' } })).json.draft;
    // the page's list still shows a@x; the draft is changed to b@y elsewhere
    await t.call(`/api/m/mail/drafts/${d.id}`, { method: 'PATCH', body: { to: 'b@y.example', body: 'New body, line one.\nLine two.' } });
    onConfirm = async () => { await t.call(`/api/m/mail/drafts/${d.id}`, { method: 'PATCH', body: { body: 'Changed while the confirm was open.' } }); return true; };
    await assert.rejects(confirmAndSend(ui, d.id), /The draft changed\. Look at it again\./);
    assert.match(confirms[0], /To: b@y\.example/); assert.match(confirms[0], /New body, line one\.\nLine two\./);
    assert.equal(t.core.approval.listPending().length, 0); await new Promise(r => setTimeout(r, 200)); assert.equal(got.length, 0);
    onConfirm = null;
    assert.equal((await confirmAndSend(ui, d.id)).status, 'approved');
    assert.match(confirms[1], /To: b@y\.example/); assert.match(confirms[1], /Subject: Hi/); assert.match(confirms[1], /Changed while the confirm was open\./);
    for (let i = 0; i < 30 && !got.length; i++) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(got.map(g => g.to), ['b@y.example']); assert.match(got[0].raw, /Changed while the confirm was open/);
  } finally { await t.close(); await new Promise(r => srv.close(r)); }
});
