// Section K: passive lookups about a domain. Public data about domains and companies only, one ordinary request each,
// the source named on every result. Nothing here probes a host: no port scans, no login attempts, no vulnerability checks.

export const SOURCES = {
  crtsh: { name: 'crt.sh (public certificate logs)', home: 'https://crt.sh' },
  page: { name: 'One ordinary request to the site itself', home: null },
  wayback: { name: 'Internet Archive Wayback Machine (archive.org)', home: 'https://archive.org/help/wayback_api.php' },
  shodan: { name: 'Shodan (your own key)', home: 'https://developer.shodan.io/api' },
};

/** Subdomains seen in public certificate logs. One request to crt.sh's JSON output. */
export async function certSubdomains(fetch, domain, { max = 200 } = {}) {
  const r = await fetch(`https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`, { headers: { accept: 'application/json' }, timeoutMs: 45000 });
  if (!r.ok) throw Object.assign(new Error(`crt.sh answered ${r.status}. It is often busy; try again in a few minutes.`), { status: 502 });
  const text = await r.text();
  let rows; try { rows = JSON.parse(text); } catch { throw Object.assign(new Error('crt.sh did not answer with data.'), { status: 502 }); }
  const names = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const n of String(row.name_value || '').split(/\s+/)) {
      const name = n.toLowerCase().replace(/^\*\./, '');
      if (!name || !(name === domain || name.endsWith('.' + domain)) || !/^[a-z0-9.-]+$/.test(name)) continue;
      const prev = names.get(name); const last = String(row.not_after || '');
      if (!prev || last > prev.lastCertEnds) names.set(name, { name, wildcard: n.startsWith('*.') || prev?.wildcard || false, lastCertEnds: last.slice(0, 10), issuer: String(row.issuer_name || '').replace(/^.*CN=/, '').slice(0, 80) });
    }
  }
  const list = [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { domain, source: SOURCES.crtsh.name, certificates: Array.isArray(rows) ? rows.length : 0, subdomains: list.slice(0, max), more: Math.max(0, list.length - max), note: 'Names that ever had a public certificate. Some may no longer exist.' };
}

// What a site appears to be built with: a small rule list of our own over one page's headers and HTML.
const TECH = [
  ['WordPress', (h, b) => /wp-content|wp-includes/i.test(b) || /wordpress/i.test(h['x-powered-by'] || '')],
  ['Shopify', (h, b) => /cdn\.shopify\.com|Shopify\.theme/i.test(b) || !!h['x-shopify-stage']],
  ['Wix', (h, b) => /static\.wixstatic\.com/i.test(b) || !!h['x-wix-request-id']],
  ['Squarespace', (h, b) => /squarespace/i.test(b)],
  ['Drupal', (h, b) => /drupal/i.test(h['x-generator'] || '') || /Drupal\.settings|\/sites\/default\/files/i.test(b)],
  ['Joomla', (h, b) => /joomla/i.test(b)],
  ['Ghost', (h, b) => /ghost/i.test((/<meta[^>]+generator[^>]+content="([^"]+)"/i.exec(b) || [])[1] || '')],
  ['Next.js', (h, b) => /__NEXT_DATA__|\/_next\/static/i.test(b) || /next\.js/i.test(h['x-powered-by'] || '')],
  ['Nuxt', (h, b) => /__NUXT__|\/_nuxt\//i.test(b)],
  ['Gatsby', (h, b) => /___gatsby/i.test(b)],
  ['React', (h, b) => /data-reactroot|react-dom/i.test(b)],
  ['Vue', (h, b) => /data-v-[0-9a-f]{6,}|vue(\.min)?\.js/i.test(b)],
  ['Angular', (h, b) => /ng-version=/i.test(b)],
  ['jQuery', (h, b) => /jquery(\.min)?\.js|jquery-\d/i.test(b)],
  ['Bootstrap', (h, b) => /bootstrap(\.min)?\.(css|js)/i.test(b)],
  ['Tailwind CSS', (h, b) => /tailwind/i.test(b)],
  ['Google Analytics', (h, b) => /googletagmanager\.com\/gtag|google-analytics\.com\/analytics\.js|gtag\('config'/i.test(b)],
  ['Google Tag Manager', (h, b) => /googletagmanager\.com\/gtm\.js/i.test(b)],
  ['Meta Pixel', (h, b) => /connect\.facebook\.net\/[^"']*fbevents\.js/i.test(b)],
  ['Hotjar', (h, b) => /static\.hotjar\.com/i.test(b)],
  ['Cloudflare', (h) => /cloudflare/i.test(h.server || '') || !!h['cf-ray']],
  ['Fastly', (h) => /fastly/i.test(h['x-served-by'] || '') || !!h['x-fastly-request-id']],
  ['Amazon CloudFront', (h) => /cloudfront/i.test(h.via || '') || !!h['x-amz-cf-id']],
  ['Vercel', (h) => /vercel/i.test(h.server || '') || !!h['x-vercel-id']],
  ['Netlify', (h) => /netlify/i.test(h.server || '') || !!h['x-nf-request-id']],
  ['nginx', (h) => /nginx/i.test(h.server || '')],
  ['Apache', (h) => /apache/i.test(h.server || '')],
  ['Microsoft IIS', (h) => /iis/i.test(h.server || '')],
  ['PHP', (h) => /php/i.test(h['x-powered-by'] || '')],
  ['ASP.NET', (h) => /asp\.net/i.test(h['x-powered-by'] || '') || !!h['x-aspnet-version']],
];
const TRACKERS = new Set(['Google Analytics', 'Google Tag Manager', 'Meta Pixel', 'Hotjar']);
// Security headers: what each does, in plain words, and how it is scored.
const HEADERS = [
  ['strict-transport-security', 'HTTPS only (HSTS)', 'Browsers always use the secure address.', (v) => /max-age=(\d+)/i.test(v) && Number(/max-age=(\d+)/i.exec(v)[1]) >= 15552000],
  ['content-security-policy', 'Content Security Policy', 'Limits which scripts may run, which blunts injected code.', (v) => !!v],
  ['x-content-type-options', 'No type guessing', 'Stops the browser guessing file types.', (v) => /nosniff/i.test(v)],
  ['x-frame-options', 'No framing', 'Stops other sites showing this one inside theirs (clickjacking).', (v) => /deny|sameorigin/i.test(v)],
  ['referrer-policy', 'Referrer policy', 'Limits what address is passed on when a visitor clicks away.', (v) => !!v && !/unsafe-url/i.test(v)],
  ['permissions-policy', 'Permissions policy', 'Switches off camera, microphone and other features the site does not use.', (v) => !!v],
];

/** One GET of the page: what it seems built with, which trackers it loads, and a grade of its security headers. */
export async function siteProfile(fetch, url) {
  const res = await fetch(url, { headers: { accept: 'text/html' }, redirect: 'follow', timeoutMs: 20000 });
  const h = {}; res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  let body = '';
  if (/html/i.test(h['content-type'] || '')) { const buf = await res.arrayBuffer(); body = Buffer.from(buf).subarray(0, 600_000).toString('utf8'); } else { try { await res.body?.cancel(); } catch {} }
  const frameAncestors = /frame-ancestors/i.test(h['content-security-policy'] || '');
  const checks = HEADERS.map(([k, label, what, good]) => {
    const v = h[k] || null;
    const ok = k === 'x-frame-options' && !v && frameAncestors ? true : !!v && good(v);
    return { header: k, label, what, present: !!v || (k === 'x-frame-options' && frameAncestors), ok, value: v ? v.slice(0, 200) : null };
  });
  const https = String(res.url || url).startsWith('https:');
  const score = checks.filter(c => c.ok).length + (https ? 1 : 0);
  const grade = !https ? 'F' : score >= 7 ? 'A' : score >= 5 ? 'B' : score >= 4 ? 'C' : score >= 3 ? 'D' : 'E';
  const found = TECH.filter(([, test]) => { try { return test(h, body); } catch { return false; } }).map(([n]) => n);
  const leaks = ['server', 'x-powered-by', 'x-aspnet-version'].filter(k => h[k] && /\d/.test(h[k])).map(k => `${k}: ${h[k].slice(0, 60)}`);
  return { url, finalUrl: res.url || url, status: res.status, source: SOURCES.page.name, https, grade, score, outOf: 7, checks,
    builtWith: found.filter(n => !TRACKERS.has(n)), trackers: found.filter(n => TRACKERS.has(n)), versionLeaks: leaks,
    gradeMeans: grade === 'A' ? 'Well protected by its headers.' : grade === 'B' ? 'Mostly protected; one or two headers missing.' : grade === 'F' ? 'The site does not use HTTPS.' : 'Several protective headers are missing.',
    note: 'Seen from one ordinary page request and our own rule list; a site can hide what it uses.' };
}

const TS = /^\d{14}$/;
/** The capture closest to a date (YYYY-MM-DD) from the Wayback availability API. */
export async function waybackClosest(fetch, url, date) {
  const stamp = String(date || '').replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(stamp)) throw Object.assign(new Error('Give a date, for example 2020-01-31.'), { status: 400 });
  const r = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${stamp}`, { headers: { accept: 'application/json' }, timeoutMs: 30000 });
  if (!r.ok) throw Object.assign(new Error(`The Internet Archive answered ${r.status}.`), { status: 502 });
  const j = await r.json();
  const c = j?.archived_snapshots?.closest;
  if (!c || !c.available || !TS.test(String(c.timestamp)) || !/^https?:\/\/web\.archive\.org\/web\//.test(String(c.url))) return { found: false, asked: date, source: SOURCES.wayback.name };
  const t = String(c.timestamp);
  return { found: true, asked: date, timestamp: t, at: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`, status: String(c.status || ''), url: String(c.url).replace(/^http:/, 'https:'), source: SOURCES.wayback.name };
}
/** Up to `limit` captures, one per month, from the CDX API (documented in the Wayback CDX server README). */
export async function waybackList(fetch, url, { limit = 60 } = {}) {
  const q = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,statuscode&filter=statuscode:200&collapse=timestamp:6&limit=${limit}`;
  const r = await fetch(q, { headers: { accept: 'application/json' }, timeoutMs: 30000 });
  if (!r.ok) throw Object.assign(new Error(`The Internet Archive answered ${r.status}.`), { status: 502 });
  const rows = await r.json();
  const head = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0] : [];
  const ti = head.indexOf('timestamp');
  return { source: SOURCES.wayback.name, captures: (Array.isArray(rows) ? rows.slice(1) : []).map(x => String(x[ti >= 0 ? ti : 0])).filter(t => TS.test(t)).map(t => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`) };
}

/** Subdomains and DNS entries Shodan has for a domain. Only with the owner's own key; never called without one. */
export async function shodanDomain(fetch, domain, key) {
  if (!key) throw Object.assign(new Error('Add your Shodan key first.'), { status: 400, code: 'no_key' });
  const r = await fetch(`https://api.shodan.io/dns/domain/${encodeURIComponent(domain)}?key=${encodeURIComponent(key)}`, { headers: { accept: 'application/json' }, timeoutMs: 30000 });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Shodan did not accept the key.'), { status: 502 });
  if (!r.ok) throw Object.assign(new Error(`Shodan answered ${r.status}.`), { status: 502 });
  const j = await r.json();
  return { domain, source: SOURCES.shodan.name, subdomains: (j.subdomains || []).map(String).slice(0, 200), tags: (j.tags || []).map(String).slice(0, 20),
    records: (j.data || []).slice(0, 200).map(d => ({ name: d.subdomain ? `${d.subdomain}.${domain}` : domain, type: String(d.type || ''), value: String(d.value || '').slice(0, 200), lastSeen: d.last_seen ? String(d.last_seen).slice(0, 10) : null })) };
}
