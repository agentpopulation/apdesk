// Registrar history for the owner's own domains: one RDAP reading at a time (registrar, name servers, status, created
// and expiry dates), what changed between readings, and the issues that come from it. Pure; server.js stores the
// readings and gives lookupRdap the guarded fetch.

const DAY = 86400_000;
const sorted = (a) => [...new Set((Array.isArray(a) ? a : []).map(x => String(x).toLowerCase().trim()).filter(Boolean))].sort();

/** One reading from what lookupRdap returned. */
export function readingFrom(r, at = new Date().toISOString()) {
  return { at, domain: r.domain, registrar: r.registrar ? String(r.registrar).slice(0, 200) : null, nameservers: sorted(r.nameservers), status: sorted(r.status),
    created: r.registered || null, expires: r.expires || null, source: r.source || null };
}

const FIELDS = [['registrar', 'Registrar', (x) => x.registrar || null], ['nameservers', 'Name servers', (x) => (x.nameservers || []).join(', ') || null], ['expires', 'Expiry date', (x) => x.expires || null]];
/** What changed from one reading to the next: registrar, name servers and expiry. [{ field, label, old, new }] */
export function readingChanges(prev, cur) {
  if (!prev || !cur) return [];
  const out = [];
  for (const [field, label, get] of FIELDS) { const a = get(prev), b = get(cur); if (a !== b) out.push({ field, label, old: a, new: b }); }
  return out;
}

/** The timeline of one domain: readings oldest first -> [{ at, changes }] newest first, only where something changed. */
export function timeline(readings = []) {
  const out = [];
  for (let i = 1; i < readings.length; i++) { const c = readingChanges(readings[i - 1], readings[i]); if (c.length) out.push({ at: readings[i].at, changes: c }); }
  return out.reverse();
}

/** A date as the owner reads it: day, short month and year in his zone (the page's fmt.date). */
export function dateIn(iso, { timeZone, locale } = {}) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return String(iso);
  try { return new Date(t).toLocaleDateString(locale || 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }); }
  catch { return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
}
/** The changes in one line for the issues list, the notice and the activity log; expiry dates in the owner's zone. */
export function changeText(changes = [], place = {}) {
  const v = (c, x) => (x ? (c.field === 'expires' ? dateIn(x, place) : x) : 'none');
  return changes.map(c => `${c.label}: ${v(c, c.old)} → ${v(c, c.new)}`).join('; ');
}

/**
 * Issues for the issues list. domains: [{ domain, expires, lastChange: { at, changes } | null }].
 * Expiry within 30 days warns, within 7 (or past) is critical. A change seen in the last 7 days warns.
 * place: { timeZone, locale } of the owner, for the dates in the detail.
 */
export function registrarIssues(domains = [], now = Date.now(), place = {}) {
  const out = [];
  for (const d of domains) {
    if (!d?.domain) continue;
    if (d.expires) {
      const days = Math.floor((Date.parse(d.expires) - now) / DAY);
      if (Number.isFinite(days) && days <= 30) out.push({ key: 'reg|' + d.domain, kind: 'registration', severity: days <= 7 ? 'critical' : 'warn',
        title: days < 0 ? `${d.domain}: registration expired` : `${d.domain}: registration ends in ${days} day${days === 1 ? '' : 's'}`, detail: days < 0 ? 'Renew it with your registrar now, or the domain can be lost.' : 'Renew it with your registrar.' });
    }
    if (d.lastChange && now - Date.parse(d.lastChange.at) <= 7 * DAY)
      out.push({ key: 'regchange|' + d.domain, kind: 'registration', severity: 'warn', title: `${d.domain}: the registration record changed`,
        detail: changeText(d.lastChange.changes, place).slice(0, 500) });
  }
  return out;
}
