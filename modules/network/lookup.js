// Domain lookups (normalizeDomain, normalizeUrl, DNS over HTTPS, RDAP, headers) through the desk's fetch door. Public, lawful lookups only: no people search, no breach data, no port scans.
import tls from 'node:tls';

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;
const DOH_TYPES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, NS: 2, TXT: 16, SOA: 6, CAA: 257 };
const bad = (status, message) => Object.assign(new Error(message), { status });

export function normalizeDomain(input) {
  let value = String(input || '').trim().toLowerCase();
  if (!value) throw bad(400, 'Give a domain, for example example.com.');
  if (value.includes('://')) { try { value = new URL(value).hostname; } catch { throw bad(400, 'That is not a domain or a web address.'); } }
  value = value.replace(/\.$/, '').split('/')[0].split('?')[0].split('#')[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.startsWith('[')) throw bad(400, 'Use a domain name, not an IP address.');
  if (!DOMAIN_RE.test(value)) throw bad(400, 'That is not a valid domain.');
  return value;
}
export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw bad(400, 'Give a web address.');
  let u; try { u = new URL(raw.includes('://') ? raw : `https://${raw}`); } catch { throw bad(400, 'That is not a web address.'); }
  if (!/^https?:$/.test(u.protocol)) throw bad(400, 'Only http and https addresses.');
  normalizeDomain(u.hostname);
  return u;
}

export async function lookupDns(fetch, domain, types = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CAA']) {
  const name = normalizeDomain(domain);
  const records = []; const errors = [];
  await Promise.all(types.map(async (type) => {
    try {
      const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
      if (!res.ok) { errors.push(`${type}: answer ${res.status}`); return; }
      const body = await res.json();
      for (const a of body.Answer || []) records.push({ type: Object.keys(DOH_TYPES).find(k => DOH_TYPES[k] === a.type) || String(a.type), name: a.name, ttl: a.TTL, data: a.data });
    } catch (e) { errors.push(`${type}: ${e.message}`); }
  }));
  const order = Object.keys(DOH_TYPES);
  records.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return { domain: name, source: 'Cloudflare DNS over HTTPS (cloudflare-dns.com)', records, errors };
}

let bootstrap = null;
/** The registry's own RDAP server for a TLD, from IANA's bootstrap file; rdap.org only as a fallback. */
async function rdapBase(fetch, tld) {
  if (!bootstrap || Date.now() - bootstrap.at > 24 * 3600e3) {
    try { const r = await fetch('https://data.iana.org/rdap/dns.json'); const j = await r.json(); const map = new Map(); for (const [tlds, urls] of j.services || []) for (const t of tlds) map.set(t, urls.find(u => u.startsWith('https')) || urls[0]); bootstrap = { at: Date.now(), map }; } catch { bootstrap = null; }
  }
  return bootstrap?.map.get(tld) || 'https://rdap.org/';
}
export async function lookupRdap(fetch, domain) {
  const name = normalizeDomain(domain);
  const base = await rdapBase(fetch, name.split('.').pop());
  const res = await fetch(`${base.replace(/\/$/, '')}/domain/${encodeURIComponent(name)}`, { headers: { accept: 'application/rdap+json, application/json' }, redirect: 'follow' });
  if (res.status === 404) return { domain: name, found: false, source: 'RDAP (rdap.org)', note: 'The registry has no public record for this domain.' };
  if (!res.ok) throw bad(502, `The registration service answered ${res.status}.`);
  const b = await res.json();
  const ev = (k) => (b.events || []).find(e => e.eventAction === k)?.eventDate || null;
  const registrar = (b.entities || []).find(e => (e.roles || []).includes('registrar'));
  const vcardName = (ent) => { const v = ent?.vcardArray?.[1] || []; return (v.find(x => x[0] === 'fn') || [])[3] || null; };
  return { domain: name, found: true, source: `RDAP (${new URL(res.url || 'https://rdap.org').hostname})`, registered: ev('registration'), updated: ev('last changed'), expires: ev('expiration'),
    registrar: vcardName(registrar) || registrar?.handle || null, status: (b.status || []).map(String), nameservers: (b.nameservers || []).map(n => (n.ldhName || '').toLowerCase()).filter(Boolean), dnssec: b.secureDNS?.delegationSigned ?? null };
}

export async function lookupHeaders(fetch, input) {
  const u = normalizeUrl(input);
  let res = await fetch(u.href, { method: 'HEAD', redirect: 'follow' });
  let method = 'HEAD';
  if (res.status === 405 || res.status === 501) { res = await fetch(u.href, { method: 'GET', redirect: 'follow' }); method = 'GET'; try { await res.body?.cancel(); } catch {} }
  const keep = ['server', 'content-type', 'strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cache-control', 'via', 'x-powered-by'];
  const headers = []; for (const k of keep) { const v = res.headers.get(k); if (v) headers.push({ name: k, value: v.slice(0, 300) }); }
  return { url: u.href, finalUrl: res.url || u.href, status: res.status, method, headers };
}

/** The certificate a site presents on port 443 (one TLS handshake, nothing else sent). */
export async function lookupTls(host, { signal, timeoutMs = 8000, fetch } = {}) {
  const name = normalizeDomain(host);
  try { return await tlsOnce(name, name, { signal, timeoutMs }); }
  catch (e) {
    if (!fetch || !/ENOTFOUND|EAI_AGAIN/.test(e.message)) throw e;
    // this PC's own DNS failed: resolve over HTTPS and connect to the address, still asking for the name
    const a = (await lookupDns(fetch, name, ['A'])).records.find(r => r.type === 'A');
    if (!a) throw e;
    return { ...(await tlsOnce(name, a.data, { signal, timeoutMs })), address: a.data };
  }
}
function tlsOnce(name, addr, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: addr, port: 443, servername: name, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const c = sock.getPeerCertificate(); const ok = sock.authorized; const why = sock.authorizationError; const proto = sock.getProtocol();
      sock.end();
      resolve({ host: name, trusted: ok, problem: ok ? null : String(why || ''), subject: c.subject?.CN || null, issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(' · ') || null,
        validFrom: c.valid_from ? new Date(c.valid_from).toISOString() : null, validTo: c.valid_to ? new Date(c.valid_to).toISOString() : null, names: String(c.subjectaltname || '').split(',').map(s => s.trim().replace(/^DNS:/, '')).filter(Boolean).slice(0, 20), protocol: proto });
    });
    sock.on('timeout', () => { sock.destroy(); reject(bad(504, 'The site did not answer in time.')); });
    sock.on('error', (e) => reject(bad(502, 'Could not reach the site: ' + e.message)));
    signal?.addEventListener('abort', () => { sock.destroy(); reject(Object.assign(new Error('Stopped'), { code: 'aborted' })); }, { once: true });
  });
}

export async function lookupRobots(fetch, domain) {
  const name = normalizeDomain(domain);
  const res = await fetch(`https://${name}/robots.txt`, { redirect: 'follow' });
  const text = res.ok ? (await res.text()).slice(0, 6000) : '';
  return { domain: name, status: res.status, found: res.ok && !!text.trim(), text, sitemaps: [...text.matchAll(/^sitemap:\s*(\S+)/gim)].map(m => m[1]).slice(0, 10) };
}

/** A company's own public pages: its home and about page (title and description), plus search results if Search is on. */
export async function lookupCompany(fetch, domain, search) {
  const name = normalizeDomain(domain);
  const pages = [];
  for (const p of ['/', '/about', '/about-us']) {
    try {
      const res = await fetch(`https://${name}${p}`, { redirect: 'follow', headers: { accept: 'text/html' } });
      if (!res.ok || !String(res.headers.get('content-type')).includes('html')) { try { await res.body?.cancel(); } catch {} continue; }
      const html = (await res.text()).slice(0, 400_000);
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim();
      const desc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i) || html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)/i) || [])[1];
      if (title || desc) pages.push({ url: res.url || `https://${name}${p}`, title: decode(title || ''), description: decode(desc || '') });
      if (pages.length >= 2) break;
    } catch {}
  }
  let results = null;
  if (search?.search) { try { results = (await search.search(`${name} company about`, { count: 5 })).map(r => ({ title: r.title, url: r.url, snippet: r.snippet })); } catch { results = null; } }
  return { domain: name, pages, search: results, searchNote: search ? null : 'Search is switched off, so only the site itself was read.' };
}
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
