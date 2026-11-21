// Finding lists in a page: HTML tables first, then repeated blocks with the same shape. Pure functions over HTML text
// (linkedom); nothing is fetched here. Page text is data: it is only ever copied into cells, never acted on.
import { parseHTML } from 'linkedom';

export const MEANINGS = [
  { id: 'name', label: 'Name' }, { id: 'company', label: 'Company' }, { id: 'title', label: 'Title' },
  { id: 'email', label: 'Mail address' }, { id: 'country', label: 'Country' }, { id: 'operator', label: 'Network operator' },
  { id: 'site', label: 'Site' }, { id: 'other', label: 'Other' },
];
export const MEANING_IDS = MEANINGS.map(m => m.id);

// Heading words -> meaning, in this order ("company name" is a company, "job title" a title, "mail address" a mail address).
const GUESS = [
  ['email', /\be-?mail\b|\bmail\b|\bmail address\b|\bemail address\b/],
  ['operator', /\boperator\b|\bcarrier\b|\bmno\b|\btelco\b|\bnetwork\b/],
  ['company', /\bcompany\b|\borgani[sz]ation\b|\bemployer\b|\bfirm\b|\bbusiness\b|\bexhibitor\b|\bsponsor\b|\baffiliation\b|\binstitution\b|\borg\b/],
  ['title', /\btitle\b|\brole\b|\bposition\b|\bjob\b|\bdesignation\b/],
  ['country', /\bcountry\b|\bnation\b|\bterritory\b/],
  ['site', /\bweb ?site\b|\bsite\b|\burl\b|\bhomepage\b|\bdomain\b|\bweb\b/],
  ['name', /\bname\b|\battendee\b|\bparticipant\b|\bdelegate\b|\bspeaker\b|\bperson\b|\bcontact\b|\bmember\b/],
];
export function guessMeaning(heading) {
  const w = String(heading || '').toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!w) return 'other';
  for (const [id, re] of GUESS) if (re.test(w)) return id;
  return 'other';
}

// a fragment without <html> is parsed oddly by linkedom (its first element becomes the root): wrap it
const parse = (html) => { const h = String(html || ''); return parseHTML(/<html[\s>]|<body[\s>]/i.test(h) ? h : `<!doctype html><html><head></head><body>${h}</body></html>`); };
const text = (el) => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
const clip = (s, n = 300) => String(s || '').slice(0, n);
export const normHead = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9À-￿]+/g, ' ').trim();

/** The value of one cell: its text; a mail link gives its address, a link with no text its address. */
function cellValue(el) {
  let v = text(el);
  const a = el.querySelector?.('a[href]');
  const href = a?.getAttribute('href') || '';
  if (/^mailto:/i.test(href) && !/@/.test(v)) v = decodeURIComponent(href.slice(7).split('?')[0]);
  else if (!v && /^https?:\/\//i.test(href)) v = href;
  return clip(v);
}

function tableCandidates(document) {
  const out = [];
  [...document.querySelectorAll('table')].forEach((tb, position) => {
    if (tb.querySelector('table')) return;                                  // a table holding tables is page layout
    const trs = [...tb.querySelectorAll('tr')];
    let headings = null; let body = trs;
    const thead = tb.querySelector('thead tr');
    if (thead) { headings = [...thead.children].map(text); body = trs.filter(r => r !== thead && !r.closest('thead')); }
    else if (trs[0] && [...trs[0].children].length && [...trs[0].children].every(c => c.tagName === 'TH')) { headings = [...trs[0].children].map(text); body = trs.slice(1); }
    const rows = body.map(r => [...r.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH').map(cellValue)).filter(r => r.some(Boolean));
    const width = Math.max(headings?.length || 0, ...rows.map(r => r.length), 0);
    if (width < 2 || rows.length < (headings ? 1 : 2)) return;                 // with a header row one row is a list
    headings = Array.from({ length: width }, (_, i) => clip(headings?.[i] || '', 120) || `Column ${i + 1}`);
    out.push({ kind: 'table', position, headings, rows: rows.map(r => Array.from({ length: width }, (_, i) => r[i] || '')) });
  });
  return out;
}

const shape = (el) => el.tagName + '.' + [...(el.classList || [])].sort().join('.');
const nth = (e) => { const s = shape(e); let n = 0; for (let x = e.previousElementSibling; x; x = x.previousElementSibling) if (shape(x) === s) n++; return n ? `${s}:${n}` : s; };
const keyOf = (el, root) => { const parts = []; for (let e = el; e && e !== root; e = e.parentElement) parts.unshift(nth(e)); return parts.join('>'); };
const LABEL = /^([A-Za-z][A-Za-z &/.-]{0,30}):\s+(.+)$/;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'NAV', 'HEADER', 'FOOTER', 'FORM', 'SELECT', 'TABLE', 'TBODY', 'THEAD', 'TR']);

/** The fields of one block: each leaf with text, keyed by its tag and class path inside the block. */
function blockFields(member) {
  const f = new Map();
  for (const el of member.querySelectorAll('*')) {
    if ([...el.children].some(c => text(c))) continue;                       // not a leaf: its children carry the text
    const v = cellValue(el); if (!v) continue;
    const k = keyOf(el, member); if (!f.has(k)) f.set(k, v);
  }
  if (!f.size && text(member)) f.set('', cellValue(member));
  return f;
}
function headingFor(key, values) {
  const labels = values.map(v => LABEL.exec(v)?.[1]).filter(Boolean);
  if (labels.length >= Math.max(2, values.length * 0.6) && labels.every(l => l === labels[0])) return { heading: labels[0], strip: true };
  const last = key.split('>').pop() || '';
  const cls = last.replace(/:\d+$/, '').split('.').slice(1).join(' ').replace(/[_-]+/g, ' ').trim();
  return { heading: cls || '', strip: false };
}

function blockCandidates(document) {
  const out = []; let position = 0;
  const root = document.body || document.documentElement;
  for (const parent of root.querySelectorAll('*')) {
    if (SKIP.has(parent.tagName) || parent.closest('table,nav,header,footer,form')) continue;
    const kids = [...parent.children]; if (kids.length < 3) continue;
    const groups = new Map(); for (const k of kids) { const s = shape(k); groups.set(s, [...(groups.get(s) || []), k]); }
    const members = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (members.length < 3 || members.length < kids.length * 0.6) continue;
    const fields = members.map(blockFields);
    const counts = new Map(); const order = [];
    for (const f of fields) for (const k of f.keys()) { if (!counts.has(k)) order.push(k); counts.set(k, (counts.get(k) || 0) + 1); }
    const cols = order.filter(k => counts.get(k) >= members.length * 0.5);
    if (cols.length < 2) continue;
    const heads = cols.map(k => headingFor(k, fields.map(f => f.get(k)).filter(Boolean)));
    const headings = heads.map((h, i) => clip(h.heading, 120) || `Column ${i + 1}`);
    const rows = fields.map(f => cols.map((k, i) => { const v = f.get(k) || ''; return heads[i].strip ? (LABEL.exec(v)?.[2] || v) : v; })).filter(r => r.some(Boolean));
    if (rows.length < 3) continue;
    out.push({ kind: 'blocks', position: position++, headings, rows, path: keyOf(parent, root) });
  }
  // a block list nested inside another found list is the same list seen twice: keep the outer one
  return out.filter(c => !out.some(o => o !== c && c.path.startsWith(o.path + '>') && o.rows.length >= c.rows.length * 0.8)).map(({ path, ...c }) => c);
}

/** Every candidate list in a page, tables first. */
export function candidates(html) {
  const { document } = parse(html);
  for (const el of document.querySelectorAll('script,style,noscript,template,iframe,svg')) el.remove();
  return [...tableCandidates(document), ...blockCandidates(document)];
}

/** How alike two heading lists are: shared words over all words (0..1). */
export function similarity(a, b) {
  const A = new Set(a.map(normHead).filter(Boolean)), B = new Set(b.map(normHead).filter(Boolean));
  if (!A.size && !B.size) return 1;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

/**
 * The candidate a stored signature names: { cand, exact, score, added, gone } or null.
 * exact: the same headings in the same order. Otherwise the most alike list of the same kind, if at least half alike.
 */
export function findBySignature(cands, sig, { min = 0.5 } = {}) {
  const same = cands.filter(c => c.kind === sig.kind);
  const key = (h) => h.map(normHead).join('|');
  const exact = same.filter(c => key(c.headings) === key(sig.headings));
  if (exact.length) { const cand = exact.find(c => c.position === sig.position) || exact[0]; return { cand, exact: true, score: 1, added: [], gone: [] }; }
  let best = null;
  for (const c of same) { const s = similarity(c.headings, sig.headings) + (c.position === sig.position ? 0.01 : 0); if (!best || s > best.score) best = { cand: c, score: s }; }
  if (!best || best.score < min) return null;
  const old = new Set(sig.headings.map(normHead)), now = new Set(best.cand.headings.map(normHead));
  return { cand: best.cand, exact: false, score: Math.min(1, best.score), added: best.cand.headings.filter(h => !old.has(normHead(h))), gone: sig.headings.filter(h => !now.has(normHead(h))) };
}

const sameSite = (a, b) => a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');
const NEXT = /^(next|next page|next ?[›»>]+|[›»]|more results|older)$/i;
/** A plain "next" link on the same site, or null. rel="next" first, then a link whose words say next. */
export function nextPage(html, baseUrl) {
  const { document } = parse(html);
  const base = new URL(baseUrl);
  const tries = [...document.querySelectorAll('link[rel~="next"][href], a[rel~="next"][href]'), ...[...document.querySelectorAll('a[href]')].filter(a => NEXT.test(text(a)) || NEXT.test(String(a.getAttribute('aria-label') || '').trim()))];
  for (const a of tries) {
    let u; try { u = new URL(a.getAttribute('href'), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u, base)) continue;
    u.hash = ''; if (u.href === base.href) continue;
    return u.href;
  }
  return null;
}
