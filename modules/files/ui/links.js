// A rendered Markdown preview shows where each link goes: the address beside the link's words (shortened when long) and
// in full as its hover text, so words that say one thing cannot hide an address that is another.
const short = (href) => { const s = String(href).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, ''); return s.length > 60 ? s.slice(0, 57) + '…' : s; };

/** Adds the address after every link in el whose words are not already that address. Returns el. */
export function showWhereLinksGo(el) {
  for (const a of el?.querySelectorAll?.('a[href]') || []) {
    const href = a.getAttribute('href') || '';
    a.setAttribute('title', href);
    const words = (a.textContent || '').trim();
    if (!href || short(words) === short(href) || words === href) continue;
    const doc = a.ownerDocument;
    const where = doc.createElement('span'); where.className = 'sub link-where'; where.textContent = ` (${short(href)})`;
    a.after(where);
  }
  return el;
}
