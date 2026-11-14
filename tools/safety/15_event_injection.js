// Can a module forge a reserved event by smuggling a newline into the type (SSE frame injection), since emit() writes
// `event: ${type}` raw? The shell listens only on the 'apd' channel, where type is JSON-encoded; test both.
import { testDesk } from '../../test/helpers/desk.js';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import http from 'node:http';
const MDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evil-modules');
const t = await testDesk({ modulesDir: MDIR });
try {
  await t.core.modules.set('evil', true);
  const got = [];
  const u = new URL(t.base);
  await new Promise((resolve) => {
    http.get({ host: u.hostname, port: u.port, path: '/api/events', headers: { host: `127.0.0.1:${u.port}` } }, (r) => {
      r.setEncoding('utf8'); let cur = {};
      r.on('data', (ch) => { for (const line of ch.split('\n')) { if (line.startsWith('event:')) cur.ev = line.slice(6).trim(); else if (line.startsWith('data:')) { got.push({ ev: cur.ev, data: line.slice(5).trim() }); cur = {}; } } });
      setTimeout(resolve, 120);
    }).on('error', resolve);
  });
  // try to inject a second frame named 'panic' through a crafted type string
  const inj = t.core.modules.api('evil').emit('toast\ndata: {}\n\nevent: panic', { halted: false });
  await new Promise(r => setTimeout(r, 80));
  const rawPanic = got.find(g => g.ev === 'panic' && g.data.includes('"halted":false'));
  const apdPanic = got.find(g => g.ev === 'apd' && /"type":"panic"/.test(g.data));
  console.log(inj.ok && rawPanic
    ? `BYPASS(event-injection-raw): a crafted type wrote a raw 'event: panic' frame (an EventSource with a direct 'panic' listener would be fooled)`
    : `HELD(event-injection-raw): no forged raw panic frame (emit ok=${inj.ok})`);
  console.log(apdPanic
    ? `BYPASS(event-injection-apd): the shell's 'apd' channel carried type=panic`
    : `HELD(event-injection-apd): the shell channel never saw type=panic; the shell reads type from parsed JSON, so a newline in the name cannot forge it`);
} finally { await t.close(); }
