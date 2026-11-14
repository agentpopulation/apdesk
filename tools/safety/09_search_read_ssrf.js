// search's GET /api/m/search/read?url= : reachable with no session (any web page can fire it with <img>), and
// its address check (modules/search/reader.js publicUrl) is a string check: no DNS look-up, no IPv4-mapped IPv6,
// and redirects are followed by fetch before the final address is checked.
// LOOPNAME: a host name that resolves to 127.0.0.1 here (default: this PC's own name, which does on Windows).
import { testDesk } from '../../test/helpers/desk.js';
import { publicUrl } from '../../modules/search/reader.js';
import { checkUrlDeep } from '../../modules/browser/guard.js';
import http from 'node:http';
import os from 'node:os';
const LOOPNAME = process.env.LOOPNAME || os.hostname();
const hits = [];
const inner = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/go') { res.writeHead(302, { location: `http://127.0.0.1:${inner.address().port}/reboot?confirm=1` }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>router admin</title></head><body><main><p>INTERNAL-SECRET-PAGE. ' + 'Router admin console with the WiFi password and device list. '.repeat(20) + '</p></main></body></html>');
});
await new Promise(r => inner.listen(0, '127.0.0.1', r));
const ip = inner.address().port;
const t = await testDesk({ modules: ['search'] });
try {
  const a = await t.call(`/api/m/search/read?url=${encodeURIComponent(`http://${LOOPNAME}:${ip}/admin`)}`, { session: false, headers: { 'sec-fetch-site': 'cross-site' } });
  console.log(a.text.includes('INTERNAL-SECRET-PAGE')
    ? `BYPASS(read-name->loopback): a cross-site GET with no session made the desk fetch http://${LOOPNAME}:${ip}/admin (a name that resolves to 127.0.0.1) and returned the page text`
    : `HELD(read-name): ${a.status} ${a.text.slice(0, 100)}`);
  hits.length = 0;
  const b = await t.call(`/api/m/search/read?url=${encodeURIComponent(`http://${LOOPNAME}:${ip}/go`)}`, { session: false });
  console.log(hits.includes('/reboot?confirm=1')
    ? `BYPASS(read-redirect): the redirect to http://127.0.0.1:${ip}/reboot?confirm=1 was followed (request sent) before any check (answer ${b.json?.code || b.status})`
    : `HELD(read-redirect)`);
  let mapped = 'refused'; try { publicUrl('http://[::ffff:127.0.0.1]:11434/api/tags'); mapped = 'accepted'; } catch {}
  console.log(mapped === 'accepted' ? `BYPASS(guard-mapped-v6): publicUrl accepts http://[::ffff:127.0.0.1]:11434 (connect not runnable here: no IPv6 in this sandbox; Windows 11 has it)` : `HELD(guard-mapped-v6)`);
  const c = await t.call(`/api/m/search/read?url=${encodeURIComponent(`http://127.0.0.1:${ip}/x`)}`, { session: false });
  console.log(c.json?.code === 'private' ? `HELD(read-literal): http://127.0.0.1 refused as private` : `BYPASS(read-literal): ${c.status}`);
  const deep = await checkUrlDeep(`http://${LOOPNAME}:${ip}/`, {});
  console.log(deep ? `HELD(browser-guard): the browser's checkUrlDeep refuses the same name (${deep.slice(0, 60)}...) - search should reuse it` : `BYPASS(browser-guard): checkUrlDeep passed ${LOOPNAME}`);
} finally { await t.close(); inner.close(); }
