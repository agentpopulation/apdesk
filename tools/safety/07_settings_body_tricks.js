// The plain POST /api/settings route uses an allow-list, so body tricks to set security/spend keys should all fail.
import { testDesk } from '../../test/helpers/desk.js';
const t = await testDesk();
try {
  const tries = {
    'security.level': 'strict',
    'security.level ': 'strict',                 // trailing space
    ' security.level': 'strict',                 // leading space
    'SECURITY.LEVEL': 'strict',                  // case
    'security.autoApproveUntil': '2099-01-01T00:00:00Z',
    'spend.perItem': 1,
    '__proto__': { 'security.level': 'strict' }, // prototype pollution attempt
    'constructor': { 'prototype': { level: 'strict' } },
    'ui.security.level': 'strict',               // ui.* is allowed but this is a nonsense key, not the real setting
  };
  await t.call('/api/settings', { body: tries });
  const sec = (await t.call('/api/security')).json;
  const polluted = ({}).level !== undefined;     // did prototype pollution take globally?
  const ok = sec.level === 'open' && sec.autoApproveUntil == null && sec.limits.perItem !== 1 && !polluted;
  console.log(ok
    ? `HELD(body-tricks): none of 9 key tricks (trailing/leading space, case, __proto__, constructor, ui.*) changed level/auto/limits; level=${sec.level}, perItem=${sec.limits.perItem}, protoPolluted=${polluted}`
    : `BYPASS(body-tricks): level=${sec.level} auto=${sec.autoApproveUntil} perItem=${sec.limits.perItem} proto=${polluted}`);
} finally { await t.close(); }
