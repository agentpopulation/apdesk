// Section H: the health of a domain the owner says is his. DNS records and mail set-up (SPF, DMARC, DKIM for the
// selectors he names) over DNS over HTTPS, the certificate's last day, and the registration's last day from RDAP.
// Each result has a plain "what this means" line. Reminders at 30 and 7 days before an expiry.

export const daysUntil = (iso, now = Date.now()) => (iso ? Math.floor((Date.parse(iso) - now) / 86400_000) : null);
const unquote = (s) => String(s || '').replace(/"\s+"/g, '').replace(/^"|"$/g, '');
export const validSelector = (s) => /^[a-z0-9](?:[a-z0-9_-]{0,62})$/i.test(String(s || ''));

/** From TXT answers: { spf, dmarc, dkim: { selector: record|null } } with what each means. */
export function mailHealth({ rootTxt = [], dmarcTxt = [], dkimTxt = {} }) {
  const spfs = rootTxt.map(unquote).filter(t => /^v=spf1\b/i.test(t));
  const dmarc = dmarcTxt.map(unquote).find(t => /^v=DMARC1\b/i.test(t)) || null;
  const out = { spf: null, dmarc: null, dkim: [] };
  if (!spfs.length) out.spf = { ok: false, record: null, means: 'No SPF record: other servers cannot tell which machines may send mail for this domain, so your mail is more likely to land in spam.' };
  else if (spfs.length > 1) out.spf = { ok: false, record: spfs.join(' | '), means: 'There are two SPF records. Receivers treat that as an error; keep exactly one.' };
  else {
    const r = spfs[0]; const all = (/[~?+-]all\b/.exec(r) || [])[0] || null;
    out.spf = { ok: !!all && all !== '+all', record: r, means: all === '-all' ? 'SPF is set and strict: mail from servers not listed is refused.' : all === '~all' ? 'SPF is set: mail from servers not listed is marked as suspect.' : all === '+all' ? 'SPF allows every server in the world to send as you. Change +all to ~all or -all.' : 'SPF is set but has no ending rule (~all or -all), so it protects little.' };
  }
  if (!dmarc) out.dmarc = { ok: false, record: null, means: 'No DMARC record: receivers get no instruction for mail that fails SPF or DKIM, and you get no reports.' };
  else {
    const p = (/\bp=(\w+)/i.exec(dmarc) || [])[1]?.toLowerCase() || null;
    out.dmarc = { ok: p === 'quarantine' || p === 'reject' || p === 'none', policy: p, record: dmarc, means: p === 'reject' ? 'DMARC is set to reject mail that fails the checks: the strongest setting.' : p === 'quarantine' ? 'DMARC sends mail that fails the checks to spam.' : p === 'none' ? 'DMARC only watches (p=none): failing mail is still delivered. Fine to start, then move to quarantine.' : 'DMARC is present but its policy (p=) is missing or unknown.' };
  }
  for (const [sel, list] of Object.entries(dkimTxt)) {
    const rec = (list || []).map(unquote).find(t => /\bp=/.test(t)) || null;
    out.dkim.push({ selector: sel, ok: !!rec && !/\bp=\s*(;|$)/.test(rec), record: rec ? rec.slice(0, 200) + (rec.length > 200 ? '…' : '') : null, means: !rec ? `No DKIM key at ${sel}._domainkey. If your mail service uses this selector, add the key it gave you.` : /\bp=\s*(;|$)/.test(rec) ? `The DKIM key at ${sel} is empty (revoked).` : `A DKIM key is published for selector ${sel}: receivers can check your signatures.` });
  }
  return out;
}

export function expiryLine(kind, days) {
  if (days == null) return kind === 'cert' ? 'The certificate could not be read.' : 'The registry does not publish an expiry date for this domain.';
  const what = kind === 'cert' ? 'The certificate' : 'The domain registration';
  if (days < 0) return `${what} expired ${-days} day${days === -1 ? '' : 's'} ago.${kind === 'cert' ? ' Visitors see a warning.' : ' Renew it now or you may lose the name.'}`;
  if (days <= 7) return `${what} ends in ${days} day${days === 1 ? '' : 's'}. Renew it now.`;
  if (days <= 30) return `${what} ends in ${days} days. Plan the renewal.`;
  return `${what} is good for ${days} more days.`;
}

/** Which reminders are due now: one at 30 days and one at 7 days before each expiry, each said once per expiry date. */
export function remindersDue({ certTo, regTo }, said = {}, now = Date.now()) {
  const out = [];
  for (const [kind, iso] of [['cert', certTo], ['registration', regTo]]) {
    const d = daysUntil(iso, now); if (d == null) continue;
    const k7 = `${kind}|7|${iso}`, k30 = `${kind}|30|${iso}`;
    if (d < 0) continue;
    if (d <= 7 && !said[k7]) out.push({ keys: [k7, k30], kind, days: d, at: 7 });
    else if (d <= 30 && d > 7 && !said[k30]) out.push({ keys: [k30], kind, days: d, at: 30 });
  }
  return out;
}
