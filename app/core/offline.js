// Offline is held inside the desk process, not only in the browser.
// While a desk is Offline, every fetch from this process is refused unless it goes to a local model server
// the owner set up (Ollama, a LAN model node) or to the desk itself. A router or search engine on this PC is
// NOT local for this purpose: it forwards to the internet.
const desks = new Set();
let installed = false;

function install() {
  if (installed) return; installed = true;
  const real = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    let url = null;
    try { url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input)); } catch { return real.call(this, input, init); }
    for (const d of desks) {
      let blocked = false;
      try { blocked = d.isOffline() && !d.allows(url); } catch { blocked = false; }
      if (blocked) {
        try { d.onRefused?.(url); } catch {}
        return Promise.reject(Object.assign(new Error(`The desk is offline, so ${url.hostname} was not called.`), { code: 'offline' }));
      }
    }
    // an allowed local address must not hand the call on to an outside one while Offline
    for (const d of desks) { let off = false; try { off = d.isOffline(); } catch {} if (off && !(init && init.redirect)) { init = { ...(init || {}), redirect: 'error' }; break; } }
    return byteSinks.size ? real.call(this, input, init).then((res) => counted(url, init, res)) : real.call(this, input, init);
  };
}

// Data use: what the desk itself sends and receives, per host. The Network module registers a sink; nothing else changes.
const byteSinks = new Set();
/** fn(host, sentBytes, receivedBytes) for every outbound call. Returns a function that removes it. */
export function onOutboundBytes(fn) { byteSinks.add(fn); return () => byteSinks.delete(fn); }
function bodySize(b) {
  if (b == null) return 0;
  if (typeof b === 'string') return Buffer.byteLength(b);
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return b.byteLength;
  if (b instanceof URLSearchParams) return Buffer.byteLength(String(b));
  if (typeof Blob !== 'undefined' && b instanceof Blob) return b.size;
  return 0;                                   // a stream or form: not counted
}
function counted(url, init, res) {
  const host = url.hostname.toLowerCase();
  const sent = bodySize(init && init.body) + url.href.length;
  let told = false;
  const tell = (received) => { if (told) return; told = true; for (const fn of byteSinks) { try { fn(host, sent, received); } catch {} } };
  if (!res.body || [101, 103, 204, 205, 304].includes(res.status)) { tell(0); return res; }
  let n = 0;
  const body = res.body.pipeThrough(new TransformStream({ transform(chunk, c) { n += chunk.byteLength; c.enqueue(chunk); }, flush() { tell(n); }, cancel() { tell(n); } }));
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  for (const k of ['url', 'redirected', 'type']) Object.defineProperty(out, k, { value: res[k] });
  return out;
}

/** Register a desk: { isOffline(), allows(URL), onRefused?(URL) }. Returns a function that removes it. */
export function guardOutbound(desk) { desks.add(desk); install(); return () => desks.delete(desk); }

// localhost, 127.0.0.1 and ::1 are the same PC: compare them as one host
const LOOP = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const hostKey = (u) => { try { const x = new URL(String(u)); const h = LOOP.has(x.hostname) ? 'loopback' : x.hostname.toLowerCase(); return `${x.protocol}//${h}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`; } catch { return null; } };
const origin = hostKey;

// The desk's own local engine (llama-server, started by the desk on a loopback port it picked). Only loopback http
// addresses are accepted here: the engine never forwards anything online.
const localEngines = new Set();
/** Register the local engine's address while it runs. Returns a function that removes it. */
export function allowLocalEngine(url) {
  let u; try { u = new URL(String(url)); } catch { throw new Error('Not an address'); }
  if (u.protocol !== 'http:' || !LOOP.has(u.hostname) || !u.port) throw new Error('Only a loopback address can be a local engine.');
  const k = hostKey(u.href); localEngines.add(k);
  return () => localEngines.delete(k);
}

/** The addresses a desk may still call while Offline: itself, Ollama, the desk's local engine, and the owner's LAN model nodes. */
export function offlineAllowList({ settings, port }) {
  const list = new Set(localEngines);
  if (port()) list.add(hostKey(`http://127.0.0.1:${port()}`));
  const o = origin(settings.get('ollama.baseUrl')); if (o) list.add(o);
  for (const n of settings.get('network.lanNodes') || []) { const x = origin(n && n.baseUrl); if (x) list.add(x); }
  return list;
}
