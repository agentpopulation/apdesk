// Section A: the connection in use, read from this PC only (systeminformation and the system resolver's settings),
// and the public address with its network operator, looked up only when the owner asks or a schedule he set runs.
import dns from 'node:dns';

const WIFI = /wireless|wi-?fi|wlan|802\.11/i;

/** si = the systeminformation module (or a stand-in). Nothing here leaves this PC. */
export async function localConnection(si, { servers = () => dns.getServers() } = {}) {
  const [ifaces, gateway, wifi] = await Promise.all([
    si.networkInterfaces().catch(() => []),
    si.networkGatewayDefault().catch(() => ''),
    (si.wifiConnections ? si.wifiConnections() : Promise.resolve([])).catch(() => []),
  ]);
  const list = (Array.isArray(ifaces) ? ifaces : [ifaces]).filter(i => i && !i.internal);
  const up = list.filter(i => (i.ip4 || i.ip6) && i.operstate !== 'down');
  const main = up.find(i => i.default) || up.find(i => i.ip4) || null;
  const w = (Array.isArray(wifi) ? wifi : []).find(x => !main || x.iface === main.iface || x.iface === main.ifaceName) || (main && (main.type === 'wireless' || WIFI.test(main.ifaceName || main.iface)) ? (wifi || [])[0] : null);
  const kind = !main ? null : (main.type === 'wireless' || WIFI.test(`${main.ifaceName} ${main.iface}`) || w) ? 'wifi' : main.type === 'wired' ? 'cable' : main.type === 'virtual' ? 'virtual' : 'other';
  const speed = main && Number(main.speed) > 0 ? Number(main.speed) : null;
  let dnsServers = []; try { dnsServers = servers().filter(Boolean).slice(0, 6); } catch {}
  return {
    connected: !!main,
    kind,
    adapter: main ? (main.ifaceName || main.iface) : null,
    linkMbps: speed,
    signal: w ? { ssid: w.ssid || null, dBm: Number.isFinite(Number(w.signalLevel)) ? Number(w.signalLevel) : null, quality: Number.isFinite(Number(w.quality)) ? Number(w.quality) : null, txMbps: Number(w.txRate) > 0 ? Number(w.txRate) : null } : null,
    localIPv4: main?.ip4 || null, subnet: main?.ip4subnet || null, localIPv6: main?.ip6 || null, mac: main?.mac || null,
    mtu: main && Number(main.mtu) > 0 ? Number(main.mtu) : null,
    dhcp: typeof main?.dhcp === 'boolean' ? main.dhcp : null,
    gateway: typeof gateway === 'string' && gateway ? gateway : null,
    dnsServers,
    others: up.filter(i => i !== main).slice(0, 6).map(i => ({ adapter: i.ifaceName || i.iface, address: i.ip4 || i.ip6, kind: i.type === 'wireless' ? 'wifi' : i.type === 'wired' ? 'cable' : i.type || 'other' })),
  };
}

/** Plain words for a Wi-Fi signal in dBm. */
export function signalWords(dBm) {
  if (dBm == null) return null;
  if (dBm >= -55) return 'Strong'; if (dBm >= -67) return 'Good'; if (dBm >= -75) return 'Fair'; return 'Weak';
}

export const PUBLIC_IP_SOURCES = {
  ip: 'Cloudflare (www.cloudflare.com/cdn-cgi/trace)',
  asn: 'RIPEstat (stat.ripe.net)',
};
/**
 * The public address and its network: three ordinary requests. The address and country from Cloudflare's trace page,
 * the AS number and prefix from RIPEstat network-info, the operator's name from RIPEstat as-overview.
 */
export async function publicAddress(fetch) {
  const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
  if (!r.ok) throw Object.assign(new Error(`Cloudflare answered ${r.status}.`), { status: 502 });
  const t = await r.text();
  const field = (k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(t) || [])[1]?.trim() || null;
  const ip = field('ip');
  if (!ip || !/^[0-9a-f.:]+$/i.test(ip)) throw Object.assign(new Error('Cloudflare did not say the address.'), { status: 502 });
  const out = { at: new Date().toISOString(), ip, country: field('loc'), asn: null, prefix: null, operator: null, sources: [PUBLIC_IP_SOURCES.ip], note: null };
  try {
    const n = await (await fetch(`https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(ip)}`)).json();
    const asn = (n?.data?.asns || [])[0];
    out.prefix = typeof n?.data?.prefix === 'string' ? n.data.prefix : null;
    if (asn && /^\d+$/.test(String(asn))) {
      out.asn = Number(asn);
      const o = await (await fetch(`https://stat.ripe.net/data/as-overview/data.json?resource=AS${out.asn}`)).json();
      out.operator = typeof o?.data?.holder === 'string' ? o.data.holder.slice(0, 120) : null;
    }
    out.sources.push(PUBLIC_IP_SOURCES.asn);
  } catch (e) { out.note = 'The network operator could not be looked up just now.'; }
  return out;
}
