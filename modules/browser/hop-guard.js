// The agent's browser reaches the network only through this small proxy on this PC, so every request is checked
// before it leaves: the first page, each redirect hop, frames, scripts, images, fetch, WebSockets. The proxy looks
// the name up itself and connects to exactly the address it checked, so a public name that points at this PC or the
// home network (DNS rebinding) is stopped too. The browser itself resolves no names (see browserArgs).
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { checkUrl, leavesThisPc, OFFLINE_LINE } from './guard.js';
import { privateHost } from '../search/guard.js';
import { ruleFor } from '../network/rules.js';

export const PRIVATE_LINE = 'That page tried to open an address on this PC or your home network, so it was stopped.';
const NEVER_LINE = (d) => `You set a rule: agents never open ${d} or any name under it.`;
const CACHE_MS = 30_000;

const clean = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
const loopName = (h) => h === 'localhost' || h.endsWith('.localhost');
const loopAddr = (a) => /^127\./.test(a) || a === '::1' || /^::ffff:127\./.test(a) || a === '0.0.0.0' || a === '::';

/** The proxy this PC already uses (HTTPS_PROXY or HTTP_PROXY, http only), or null. */
export function upstreamFromEnv(env = process.env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw); if (u.protocol !== 'http:') return null;
    const auth = u.username ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64') : null;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 80, auth };
  } catch { return null; }
}

/** Chromium switches: send every request (loopback too) to the proxy, and resolve no names itself. */
export const browserArgs = (port) => [
  `--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',   // WebRTC: no direct UDP; TURN over TCP goes through the guard
];

/**
 * opts(): the browser's guard options, read at every request ({ allowHosts, deskPort, offline, who }).
 * onRefuse({ host, port, why }): told about each stopped request.
 * Tests only (set in code, never from a tool or a request): lookup (a stand-in DNS) and publicAddr(address, port)
 * (a stand-in site on loopback that plays a public one).
 */
export async function startHopGuard({ opts, onRefuse = () => {}, lookup = dns.promises.lookup, publicAddr = null, upstream = upstreamFromEnv() }) {
  const cache = new Map();   // host -> { at, p: Promise<addresses | null> }
  const resolve = (host) => {
    if (net.isIP(host)) return Promise.resolve([host]);
    if (loopName(host)) return Promise.resolve(['127.0.0.1']);
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
    const p = Promise.race([lookup(host, { all: true, verbatim: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2500))])
      .then((a) => (a || []).map((x) => x.address)).catch(() => null);
    cache.set(host, { at: Date.now(), p });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return p;
  };

  /** -> { why } or { address, direct }. address null: let the upstream proxy connect by name (no local DNS answer). */
  async function decide(rawHost, port, scheme) {
    const host = clean(rawHost);
    const o = opts() || {};
    const url = `${scheme}://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}/`;
    if (o.offline && leavesThisPc(url)) return { why: OFFLINE_LINE };
    const never = ruleFor(host); if (never?.kind === 'never') return { why: NEVER_LINE(never.domain) };   // for every driver, as before
    const named = checkUrl(url, o); if (named) return { why: privateHost(host) ? PRIVATE_LINE : named };
    const allowed = (o.allowHosts || []).map((h) => String(h).toLowerCase()).includes(host);
    const addrs = await resolve(host);
    if (!addrs?.length) return upstream && !o.offline ? { address: null, direct: false } : { why: null };
    for (const a of addrs) {
      if (loopAddr(a) && o.deskPort && String(port) === String(o.deskPort)) return { why: PRIVATE_LINE };
      if (o.offline && !loopAddr(a)) return { why: OFFLINE_LINE };
      if (privateHost(a) && !allowed && !publicAddr?.(a, Number(port))) return { why: PRIVATE_LINE };
    }
    return { address: addrs[0], direct: privateHost(addrs[0]) || !upstream };   // an allowed home address never goes out through the upstream
  }
  const refused = (host, port, why) => { if (why) { try { onRefuse({ host: clean(host), port: Number(port), why }); } catch {} } };

  const server = http.createServer(async (req, res) => {
    let u; try { u = new URL(req.url); } catch { return res.destroy(); }
    if (u.protocol !== 'http:') return res.destroy();
    const port = Number(u.port) || 80;
    const d = await decide(u.hostname, port, 'http');
    if (!d.address && d.direct !== false) { refused(u.hostname, port, d.why); return res.destroy(); }
    const headers = { ...req.headers }; delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const target = d.direct ? { host: d.address, port, path: u.pathname + u.search } : { host: upstream.host, port: upstream.port, path: u.href };
    if (!d.direct && upstream.auth) headers['proxy-authorization'] = upstream.auth;
    const out = http.request({ ...target, method: req.method, headers, agent: false }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    out.on('error', () => res.destroy());
    req.pipe(out);
  });

  // HTTPS and WebSockets come as CONNECT host:port
  const tunnels = new Set();   // CONNECT sockets leave the http server's books: closed by hand
  server.on('connect', async (req, sock, head) => {
    sock.on('error', () => {}); tunnels.add(sock); sock.on('close', () => tunnels.delete(sock));
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || ''); if (!m) return sock.destroy();
    const [, host, port] = m;
    const d = await decide(host, port, Number(port) === 80 ? 'http' : 'https');
    if (!d.address && d.direct !== false) { refused(host, port, d.why); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(d.direct ? { host: d.address, port: Number(port) } : { host: upstream.host, port: upstream.port });
    up.on('error', () => sock.destroy()); sock.on('close', () => up.destroy()); up.on('close', () => sock.destroy());
    up.once('connect', () => {
      if (d.direct) { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(sock); sock.pipe(up); return; }
      up.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${upstream.auth ? `Proxy-Authorization: ${upstream.auth}\r\n` : ''}\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (c) => {
        buf = Buffer.concat([buf, c]); const end = buf.indexOf('\r\n\r\n'); if (end < 0) { if (buf.length > 16384) sock.destroy(); return; }
        up.off('data', onData);
        if (!/^HTTP\/1\.[01] 2\d\d/.test(buf.subarray(0, end).toString('latin1'))) { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); up.destroy(); return; }
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (buf.length > end + 4) sock.write(buf.subarray(end + 4));
        if (head?.length) up.write(head);
        up.pipe(sock); sock.pipe(up);
      };
      up.on('data', onData);
    });
  });
  // a plain ws:// upgrade sent to the proxy as an absolute address (Chromium normally tunnels with CONNECT instead)
  server.on('upgrade', (req, sock) => { sock.on('error', () => {}); sock.destroy(); });

  await new Promise((r, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', r); });
  return {
    port: server.address().port,
    decide,
    close: () => new Promise((r) => { for (const t of tunnels) t.destroy(); server.closeAllConnections?.(); server.close(() => r()); setTimeout(r, 1000).unref?.(); }),
  };
}
