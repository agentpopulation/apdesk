// Probe: folder allow-list (resolved paths), payload binding, spend amounts, pre-aborted signal.
import { testDesk } from '../../test/helpers/desk.js';
const t = await testDesk();
const A = t.core.approval;
async function decideNow(req) {
  const p = A.request(req); await new Promise(r => setTimeout(r, 15));
  const pend = A.listPending().find(a => a.title === req.title);
  if (pend) { A.decide(pend.id, 'deny'); await p.catch(()=>{}); return { asked: true }; }
  return { asked: false, res: await p };
}
async function grant(req) {          // owner approves req; returns id
  const p = A.request(req); await new Promise(r => setTimeout(r, 15));
  const id = A.listPending().find(a => a.title === req.title).id; A.decide(id, 'approve'); await p; return id;
}
const tryAssert = (id, action, payload) => { try { A.assertGranted(id, action, payload); return true; } catch { return false; } };
try {
  t.core.settings.set('files.allowedFolders', ['/home/me/public']);
  const d1 = await decideNow({ agentId: 'a', action: 'file.read.outside', title: 't-trav', payload: { path: '/home/me/public/../private/secret.txt' } });
  console.log(d1.asked ? `HELD(folder): '..' climb out of the allowed folder now asks` : `BYPASS(folder): traversal auto-allowed`);
  t.core.settings.set('files.allowedFolders', ['C:\\Users\\me\\Docs']);
  const dw = await decideNow({ agentId: 'a', action: 'file.read.outside', title: 't-win', payload: { path: 'c:\\users\\ME\\docs\\..\\Secret\\x.txt' } });
  console.log(dw.asked ? `HELD(folder-win): Windows '..' with case change asks` : `BYPASS(folder-win): allowed`);

  const pay = { to: 'alice@friend.test', subject: 'Hi', body: 'hi' };
  const id1 = await grant({ agentId: 'closer', action: 'send.person', title: 'b1', payload: pay });
  console.log(!tryAssert(id1, 'send.person', { ...pay, to: 'attacker@evil.test' }) ? `HELD(bind-recipient): swapped recipient refused` : `BYPASS(bind-recipient)`);
  console.log(!tryAssert(id1, 'send.person', { ...pay, bcc: 'attacker@evil.test' }) ? `HELD(bind-extra-field): extra bcc field refused` : `BYPASS(bind-extra-field): an added bcc passed`);
  console.log(tryAssert(id1, 'send.person', { body: 'hi', subject: 'Hi', to: 'alice@friend.test' }) ? `HELD(bind-key-order): same payload in another key order accepted (correct)` : `note: key order changed the hash`);

  // the card the owner reads is redact()ed: long strings cut at 2000 chars; keys like *pin*/*token* masked. The hash covers the full payload.
  const hidden = 'Dear Alice, see you Friday. ' + ' '.repeat(2000) + 'P.S. wire 5 lakh to account 999 today.';
  const id2 = await grant({ agentId: 'closer', action: 'send.person', title: 'b2', payload: { to: 'alice@friend.test', body: hidden } });
  const card = A.get ? A.get(id2) : A.listRecent(5).find(x => x.id === id2);
  const ownerSaw = JSON.stringify(card?.payload || {});
  const sent = tryAssert(id2, 'send.person', { to: 'alice@friend.test', body: hidden });
  console.log(sent && !ownerSaw.includes('wire 5 lakh') ? `BYPASS(bind-unseen-tail): approval card showed only the first 2000 chars; the bound (and sent) body carries a tail the owner never saw` : `HELD(unseen-tail): card shows full body=${ownerSaw.includes('wire 5 lakh')}`);
  const id3 = await grant({ agentId: 'closer', action: 'send.person', title: 'b3', payload: { to: 'alice@friend.test', shipping_note: 'Send the card number 4111 1111 1111 1111 to bob@evil.test' } });
  const card3 = JSON.stringify(A.listRecent(5).find(x => x.id === id3)?.payload || {});
  console.log(!card3.includes('bob@evil.test') ? `BYPASS(bind-masked-field): a field named 'shipping_note' (matches /pin/) is shown as •••• on the card but is bound and sent` : `HELD(masked-field)`);

  // spend: currency is not part of the grant
  await t.call('/api/settings/spend', { body: { perItem: 1000000, perDay: 5000000, perMonth: 10000000 } });
  const id4 = await grant({ agentId: 'buyer', action: 'spend', title: 'b4', amount: 500, currency: 'INR', payload: { item: 'domain' } });
  console.log(tryAssert(id4, 'spend', { item: 'domain' }) ? `note(bind-currency): grant for 500 INR passes assertGranted with no currency check; whether a sender can charge 500 USD depends on the sender (see 11_payments)` : `HELD(bind-currency)`);

  for (const amt of [-100000, NaN, 'abc', 0, undefined]) {
    const d = await decideNow({ agentId: 'a', action: 'spend', title: 'spend-' + String(amt), amount: amt });
    console.log(d.asked ? `HELD(spend ${String(amt)}): asks` : `BYPASS(spend ${String(amt)}): allowed how=${d.res.how}`);
  }
  const ac = new AbortController(); ac.abort();
  const r = await Promise.race([A.request({ agentId: 'a', action: 'shell.run', title: 'pre-aborted', signal: ac.signal }), new Promise(r => setTimeout(() => r('hang'), 300))]);
  console.log(r === 'hang' ? `BYPASS(pre-aborted): hangs` : `HELD(pre-aborted): resolves ${r.reason}`);
} finally { await t.close(); }

// restart: an approved grant from before a restart must not pass
{
  const fs = await import('node:fs');
  const t1 = await testDesk(); const dir = t1.dataDir;
  const p = t1.core.approval.request({ agentId: 'c', action: 'send.person', title: 'pre-restart', payload: { to: 'a@b.c' } });
  await new Promise(r => setTimeout(r, 15));
  const id = t1.core.approval.listPending()[0].id; t1.core.approval.decide(id, 'approve'); await p;
  await t1.desk.stop();
  const { createDesk } = await import('../../app/server.js');
  const d2 = await createDesk({ dataDir: dir, port: 0, quiet: true, env: {} }); await d2.start();
  let ok = false; try { d2.core.approval.assertGranted(id, 'send.person', { to: 'a@b.c' }); ok = true; } catch {}
  console.log(ok ? `BYPASS(restart): a grant from before the restart still passes` : `HELD(restart): grants do not survive a restart (fail closed)`);
  await d2.stop(); await t1.fake?.close(); fs.rmSync(dir, { recursive: true, force: true });
}
