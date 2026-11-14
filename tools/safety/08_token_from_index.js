// Any client that can GET / on loopback (no auth) receives the shell page with a live session token embedded.
import { testDesk } from '../../test/helpers/desk.js';
const t = await testDesk({ pairing: true });
try {
  await t.call('/', { session: false });                        // the owner's own browser opens the desk first and is remembered (its cookie is not ours)
  const page = await t.call('/', { session: false });          // the attacker: another program on this PC, no cookie
  const m = page.text.match(/name="apd-session" content="([0-9a-f]+)"/);
  const tok = m?.[1];
  if (!tok) { console.log('HELD: no token in page'); }
  else {
    // use the scraped token to change the security level (a privileged, session-gated route)
    const r = await t.call('/api/settings/security', { body: { level: 'strict' }, session: false, headers: { 'x-apd-session': tok } });
    console.log(r.status === 200 && t.core.approval.level === 'strict'
      ? `BYPASS(token-scrape): GET / (no auth) returned a working session token; using it changed the level to '${t.core.approval.level}'. Any local process that can reach loopback gets full owner power.`
      : `HELD(token-scrape): scraped token did not work (status ${r.status})`);
  }
} finally { await t.close(); }
