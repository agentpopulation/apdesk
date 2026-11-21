// Section E: "Is it me or them?" Each step is one small check; verdict() turns the results into one plain sentence.
import net from 'node:net';
import dns from 'node:dns';

export const WELL_KNOWN = ['https://www.wikipedia.org/', 'https://www.cloudflare.com/', 'https://example.com/'];
export const PUBLIC_RESOLVER = { name: 'Cloudflare 1.1.1.1 (DNS over HTTPS, by address)', url: 'https://1.1.1.1/dns-query' };

/** Does the gateway answer? One TCP knock on 53, then 80, then 443: a connect or a refusal both mean "it is there". */
export function knock(host, ports = [53, 80, 443], { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= ports.length) return resolve({ ok: false, port: null });
      const port = ports[i++]; const s = net.connect({ host, port });
      const done = (ok) => { s.destroy(); ok ? resolve({ ok: true, port }) : next(); };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true)); s.once('error', (e) => done(e.code === 'ECONNREFUSED'));
    };
    next();
  });
}
export async function systemResolves(name = 'example.com', { lookup = dns.promises.lookup, timeoutMs = 4000 } = {}) {
  try { const r = await Promise.race([lookup(name), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), timeoutMs))]); return { ok: !!r?.address, address: r?.address || null }; }
  catch (e) { return { ok: false, error: e.code || e.message }; }
}

/**
 * steps = { adapter: bool, gateway: bool|null (null: no gateway known), systemDns: bool, publicDns: bool,
 *           sites: [{ url, ok }], target: { url, ok, status } | null }
 * -> { where: 'adapter'|'gateway'|'dns'|'internet'|'site'|'none', line }
 */
export function verdict(s) {
  const sitesOk = (s.sites || []).filter(x => x.ok).length, sitesN = (s.sites || []).length;
  const host = (u) => { try { return new URL(u).hostname; } catch { return u; } };
  if (!s.adapter) return { where: 'adapter', line: 'This PC is not connected to any network. Check the Wi-Fi or the cable.' };
  if (s.gateway === false) return { where: 'gateway', line: 'Your Wi-Fi or cable is connected but your router does not answer. Restart the router.' };
  if (sitesOk && s.target && !s.target.ok) return { where: 'site', line: `Everything here works; ${host(s.target.url)} is down or refusing${s.target.status ? ` (it answered ${s.target.status})` : ''}.` };
  if (!s.systemDns && !sitesOk && s.publicDns) return { where: 'dns', line: 'DNS is failing; sites by address work. Change the DNS server on this PC or restart the router.' };
  if (!s.systemDns && sitesOk) return { where: 'dns', line: 'Websites answer, but this PC’s own DNS did not resolve a test name. With a proxy or VPN that is normal; otherwise change the DNS server.' };
  if (!s.systemDns && !s.publicDns && !sitesOk) return { where: 'internet', line: s.gateway ? 'Your router answers, but nothing beyond it does. The internet line or your provider is down.' : 'Nothing on the internet answers from here. The line or your provider may be down.' };
  if (sitesN && !sitesOk) return { where: 'internet', line: 'Names resolve but no website answers. Your provider or a firewall may be blocking traffic.' };
  if (s.target && !s.target.ok) return { where: 'site', line: `Everything here works; ${host(s.target.url)} is down or refusing${s.target.status ? ` (it answered ${s.target.status})` : ''}.` };
  if (sitesN && sitesOk < sitesN) return { where: 'site', line: `Your connection works; ${(s.sites || []).filter(x => !x.ok).map(x => host(x.url)).join(' and ')} did not answer just now.` };
  return { where: 'none', line: s.target ? `Everything works, and ${host(s.target.url)} answers too.` : 'Everything here works.' };
}
