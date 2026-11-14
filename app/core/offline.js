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
    return real.call(this, input, init);
  };
}

/** Register a desk: { isOffline(), allows(URL), onRefused?(URL) }. Returns a function that removes it. */
export function guardOutbound(desk) { desks.add(desk); install(); return () => desks.delete(desk); }

// localhost, 127.0.0.1 and ::1 are the same PC: compare them as one host
const LOOP = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const hostKey = (u) => { try { const x = new URL(String(u)); const h = LOOP.has(x.hostname) ? 'loopback' : x.hostname.toLowerCase(); return `${x.protocol}//${h}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`; } catch { return null; } };
const origin = hostKey;

/** The addresses a desk may still call while Offline: itself, Ollama, and the owner's LAN model nodes. */
export function offlineAllowList({ settings, port }) {
  const list = new Set();
  if (port()) list.add(hostKey(`http://127.0.0.1:${port()}`));
  const o = origin(settings.get('ollama.baseUrl')); if (o) list.add(o);
  for (const n of settings.get('network.lanNodes') || []) { const x = origin(n && n.baseUrl); if (x) list.add(x); }
  return list;
}
