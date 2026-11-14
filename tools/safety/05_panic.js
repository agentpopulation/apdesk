// Panic probes: stop is unauthenticated (by design), resume is gated, module timers survive stopAll, fake SSE spoofing, streaming cut.
import { testDesk } from '../../test/helpers/desk.js';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import http from 'node:http';
const MDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evil-modules');
const t = await testDesk({ modulesDir: MDIR, script: (b,n)=>({ text: 'one two three four five six seven eight', chunkDelayMs: 40 }) });
try {
  await t.core.modules.set('evil', true);

  // ---- 5a: resume requires the session; stop does not (contract: easy to stop, hard to resume)
  await t.call('/api/panic', { body: { reason: 'test' }, session: false });
  console.log(t.core.panic.halted ? `HELD(stop): POST /api/panic halts with no session (intended: easy to stop)` : `note: panic did not halt`);
  const res1 = await t.call('/api/panic/resume', { method: 'POST', session: false });
  console.log(res1.status === 403 && t.core.panic.halted ? `HELD(resume): resume without the session refused (403), still halted` : `BYPASS(resume): resumed without session (status ${res1.status})`);
  const res2 = await t.call('/api/panic/resume', { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  console.log(res2.status === 403 ? `HELD(resume-xsite): cross-site resume refused` : `BYPASS(resume-xsite): ${res2.status}`);

  // ---- 5b: a module's bare timer keeps running after Panic AND can push a spoofed 'panic' SSE to the owner's screen
  const got = [];
  const u = new URL(t.base);
  await new Promise((resolve) => {
    const req = http.get({ host: u.hostname, port: u.port, path: '/api/events', headers: { host: `127.0.0.1:${u.port}` } }, (r) => {
      r.setEncoding('utf8'); let cur = {};
      r.on('data', (chunk) => { for (const line of chunk.split('\n')) { if (line.startsWith('event:')) cur.ev = line.slice(6).trim(); else if (line.startsWith('data:')) { got.push({ ev: cur.ev, data: line.slice(5).trim() }); cur = {}; } } });
      setTimeout(resolve, 150);
    });
    req.on('error', resolve);
  });
  const ticksA = t.core.modules.api('evil').ticks();
  await new Promise(r => setTimeout(r, 80));
  const ticksB = t.core.modules.api('evil').ticks();
  console.log(ticksB > ticksA ? `BYPASS(timer): a module setInterval kept running AFTER Panic (${ticksA}->${ticksB}); stopAll never kills timers that ignore signal/onStop` : `HELD(timer): module timer stopped`);
  const er = t.core.modules.api('evil').emit('panic', { halted: false, reason: null, at: null }); const er2 = t.core.modules.api('evil').emit('security', { level: 'strict' }); console.log('[05] emit panic: ' + (er.ok ? 'accepted' : er.err) + ' | emit security: ' + (er2.ok ? 'accepted' : er2.err));
  await new Promise(r => setTimeout(r, 60));
  const spoof = got.find(g => g.ev === 'panic' && g.data.includes('"halted":false'));
  console.log(spoof ? `BYPASS(spoof): a module pushed a fake 'panic' {halted:false} SSE while backend halted=${t.core.panic.halted} -> owner's screen can be made to show the wrong Panic/security state` : `HELD(spoof): no fake panic event delivered`);

  // ---- 5c: streaming reply is actually cut by Panic
  await t.call('/api/panic/resume', { method: 'POST' });        // with session
  let lines = 0, aborted = false;
  const base = t.base;
  const streamDone = (async () => {
    const r = await fetch(base + '/api/model/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-apd-session': t.desk.session }, body: JSON.stringify({ prompt: 'count', stream: true }) });
    const reader = r.body.getReader(); const dec = new TextDecoder();
    try { while (true) { const { value, done } = await reader.read(); if (done) break; const s = dec.decode(value); lines += (s.match(/\n/g)||[]).length; if (lines >= 1 && !aborted) { aborted = true; await t.core.panic.stopAll('cut'); } } } catch {}
  })();
  await streamDone;
  console.log(t.core.panic.halted ? `HELD(stream): Panic during a streaming reply halted it and halted=true (reply did not complete normally)` : `note(stream): inconclusive`);
} finally { await t.close(); }
