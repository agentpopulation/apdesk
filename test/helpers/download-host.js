// A stand-in download host on loopback, for tests: serves files with Range support, can send slowly, lie about the
// size, or redirect. Reach it as 127.0.0.1 or as localhost (two host names, so a redirect to "another host" can be tested).
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** files: { '/path': { body: Buffer, slowMs?, chunk?, noRange?, noLength?, redirect?: url, extra?: Buffer } } */
export async function startDownloadHost(files = {}) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const f = files[req.url.split('?')[0]];
    hits.push({ url: req.url, range: req.headers.range || null });
    if (!f) { res.writeHead(404); return res.end('no'); }
    if (f.redirect) { res.writeHead(302, { location: typeof f.redirect === 'function' ? f.redirect() : f.redirect }); return res.end(); }
    let body = f.extra ? Buffer.concat([f.body, f.extra]) : f.body; let status = 200; const headers = { 'accept-ranges': f.noRange ? 'none' : 'bytes' };
    const m = !f.noRange && /bytes=(\d+)-/.exec(req.headers.range || '');
    if (m) { const from = Number(m[1]); headers['content-range'] = `bytes ${from}-${body.length - 1}/${body.length}`; body = body.subarray(from); status = 206; }
    if (!f.noLength) headers['content-length'] = String(body.length);
    res.writeHead(status, headers);
    const step = f.chunk || 65536;
    for (let i = 0; i < body.length; i += step) {
      if (res.destroyed) return;
      res.write(body.subarray(i, i + step));
      if (f.slowMs) await new Promise(r => setTimeout(r, f.slowMs));
    }
    res.end();
  });
  server.on('connection', (s) => s.unref());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, url: (p) => `http://127.0.0.1:${port}${p}`, other: (p) => `http://localhost:${port}${p}`, files, hits, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** A .tar.gz made in memory: entries [{ name, body?, mode?, link? }] (link makes a symlink). */
export function tarGz(entries) {
  const blocks = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    const body = e.link ? Buffer.alloc(0) : Buffer.from(e.body ?? '');
    h.write(e.name, 0, 100, 'utf8');
    h.write(((e.mode ?? 0o644).toString(8)).padStart(7, '0') + '\0', 100);
    h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148);
    h.write(e.link ? '2' : (e.dir ? '5' : '0'), 156);
    if (e.link) h.write(e.link, 157, 100, 'utf8');
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** Approve every install card the door shows, until stop() is called. */
export function autoApprove(core, { deny = false } = {}) {
  let on = true; const seen = [];
  const tick = () => { if (!on) return; for (const p of core.approval.listPending()) { seen.push(p); core.approval.decide(p.id, deny ? 'deny' : 'approve'); } setTimeout(tick, 30); };
  tick();
  return { seen, stop() { on = false; } };
}

export async function until(fn, ms = 10000, step = 40) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, step)); }
  return fn();
}
