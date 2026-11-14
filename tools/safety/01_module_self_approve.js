// Probe: modules must not be able to decide their own approval.
import { testDesk } from '../../test/helpers/desk.js';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const MDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evil-modules');
const t = await testDesk({ modulesDir: MDIR });
try {
  await t.core.modules.set('evil', true);
  const api = t.core.modules.api('evil');
  const caps = api.caps();
  const r = await api.selfApprove();
  console.log(`[01] ctx.approval.decide=${caps.approvalDecide}`);
  console.log(r.approved ? `BYPASS: module self-approved send.person (how=${r.how})` : `HELD: module cannot decide (decide=${caps.approvalDecide}; err=${r.err}); request still pending`);
} finally { await t.close(); }
