// The door other modules use to make a mail draft: it makes a draft and nothing else.
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';

test('makeDraft stores a waiting draft; it never sends, asks, deletes or touches another draft', async () => {
  const t = await testDesk({ modules: ['mail'] });
  try {
    await t.call('/api/modules/mail/on', { method: 'POST' });
    const mail = t.core.modules.api('mail');
    const other = mail.makeDraft({ to: 'old@x.example', subject: 'Old', text: 'Old text' });
    const d = mail.makeDraft({ to: 'ravi@x.example', subject: 'Check-in', text: 'Hello Ravi.', from: 'Playbooks' });
    assert.equal(d.status, 'waiting'); assert.equal(d.approvalId, null); assert.equal(d.source, 'Playbooks'); assert.equal(d.to, 'ravi@x.example');
    assert.equal(t.core.approval.listPending().length, 0, 'no approval is asked');
    assert.equal(mail.drafts().length, 2); assert.equal(mail.drafts().find(x => x.id === other.id).body, 'Old text');
    assert.equal(mail.drafts().filter(x => x.status !== 'waiting').length, 0, 'nothing is sent');
    // the old name works the same and also accepts body
    assert.equal(mail.draft({ to: '', subject: 'S', body: 'B' }).to, '');
    assert.equal(typeof mail.makeDraft, 'function');
  } finally { await t.close(); }
});

test('makeDraft refuses a bare domain and an empty text, and turns a typed \\n into a line break', async () => {
  const t = await testDesk({ modules: ['mail'] });
  try {
    await t.call('/api/modules/mail/on', { method: 'POST' });
    const mail = t.core.modules.api('mail');
    assert.throws(() => mail.makeDraft({ to: 'kestrel-print.example', subject: 'x', text: 'y' }), /not a mail address/);
    assert.throws(() => mail.makeDraft({ to: 'a@b.example, nope', subject: 'x', text: 'y' }), /"nope" is not a mail address/);
    assert.throws(() => mail.makeDraft({ to: 'a@b.example', subject: 'x', text: '  ' }), /no text/);
    assert.equal(mail.drafts().length, 0, 'a refused draft stores nothing');
    const d = mail.makeDraft({ to: 'a@b.example; c@d.example', subject: 'x', text: 'Hi,\\n\\nThanks.' });
    assert.equal(d.body, 'Hi,\n\nThanks.'); assert.equal(d.to, 'a@b.example, c@d.example');
    assert.equal(mail.makeDraft({ subject: 'x', text: 'Line one\nstays \\n as typed' }).body, 'Line one\nstays \\n as typed', 'real line breaks are left alone');
    // the model's tool refuses the same way and says so
    const r = await t.core.modules.runTool('mail_draft', { to: 'kestrel-print.example', subject: 'x', body: 'y' }, { agentId: 'coordinator' });
    assert.equal(r.ok, false); assert.match(r.error, /not a mail address/);
    const ok = await t.core.modules.runTool('mail_draft', { to: 'a@b.example', subject: 'x', body: 'a\\nb' }, { agentId: 'coordinator' });
    assert.equal(ok.ok, true); assert.equal(mail.drafts().find(x => x.id === ok.draftId).body, 'a\nb');
  } finally { await t.close(); }
});
