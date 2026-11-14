// Which addresses agents may read. Refuses this PC, the home network, the desk itself, other schemes and credentials.
// privateHost: the same rule as modules/browser/guard.js.
import net from 'node:net';
import dns from 'node:dns';

export function privateHost(host) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'host-gateway' || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  const kind = net.isIP(host);
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (kind === 6) {
    const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host) || /^::(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (dotted) return privateHost(dotted[1]);
    const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return privateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    const full = host.replace(/^0+(?=[0-9a-f])/, '');
    return full === '::' || full === '::1' || /^(0{1,4}:){7}0{0,3}1$/.test(host) || /^(0{1,4}:){7}0{1,4}$/.test(host) || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host);
  }
  return false;
}

const err = (code, message) => Object.assign(new Error(message), { code });

/** Text-only check. Throws { code: 'bad_url' | 'private' | 'desk' } or returns the URL. */
export function checkUrl(raw, { deskPort = null } = {}) {
  let u; try { u = new URL(String(raw)); } catch { throw err('bad_url', 'That is not a web address.'); }
  if (!/^https?:$/.test(u.protocol)) throw err('bad_url', 'Only http and https pages can be read.');
  if (u.username || u.password) throw err('bad_url', 'Addresses with a user name or password in them are not read.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (deskPort && String(port) === String(deskPort) && privateHost(host)) throw err('desk', 'Agents cannot read the desk itself.');
  if (privateHost(host)) throw err('private', 'Pages on this computer or the local network are not read by agents.');
  return u;
}

/**
 * The same, plus a DNS look-up: a name that resolves to this PC or the home network is refused.
 * A failed look-up passes (a proxy may resolve public names; then the fetch cannot reach the LAN either).
 */
export async function checkUrlDeep(raw, { deskPort = null, lookup = dns.promises.lookup } = {}) {
  const u = checkUrl(raw, { deskPort });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return u;
  let addrs = null;
  try { addrs = await Promise.race([lookup(host, { all: true, verbatim: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2500))]); } catch { return u; }
  const bad = (addrs || []).find((a) => privateHost(a.address));
  if (bad) throw err('private', `${host} points at ${bad.address}, which is on this computer or the local network; not read.`);
  return u;
}
