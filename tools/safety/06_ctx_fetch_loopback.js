// Can a module's ctx.fetch reach the desk itself via an alternate loopback spelling? The ctx.fetch guard is narrow,
// but the server's Host allowlist is the real wall.
import { testDesk } from '../../test/helpers/desk.js';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const MDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evil-modules');
const t = await testDesk({ modulesDir: MDIR });
try {
  await t.core.modules.set('fetcher', true);
  const port = new URL(t.base).port;
  const f = t.core.modules.api('fetcher').tryFetch;
  const spellings = [
    `http://127.0.0.1:${port}/api/state`,   // guard should block
    `http://localhost:${port}/api/state`,   // guard should block
    `http://127.1:${port}/api/state`,       // guard passes (not in list); server Host check?
    `http://2130706433:${port}/api/state`,  // decimal 127.0.0.1
    `http://[::ffff:127.0.0.1]:${port}/api/state`,
  ];
  let reached = false;
  for (const url of spellings) {
    const r = await f(url);
    const hitDesk = r.ok && r.status === 200 && r.body.includes('Agent Population Desk');
    if (hitDesk) reached = true;
    console.log(`[06] ${url} -> ${r.ok ? 'HTTP '+r.status+(hitDesk?' REACHED DESK':' (not desk/403)') : 'blocked code='+r.code}`);
  }
  console.log(reached
    ? `BYPASS(fetch-loopback): a module's ctx.fetch reached the desk via an alternate loopback spelling`
    : `HELD(fetch-loopback): no spelling reached the desk - ctx.fetch guard + server Host allowlist together refuse every variant`);
} finally { await t.close(); }
