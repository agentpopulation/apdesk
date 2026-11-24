// Import customers: what each column of a CSV file is. Guessed from the header and the first rows, changed by the owner
// before anything is saved. A column nobody recognises goes to the notes (with its heading), never dropped unasked.
export const FIELDS = [
  { id: 'company', label: 'Company' }, { id: 'name', label: 'Contact name' }, { id: 'email', label: 'Mail address' },
  { id: 'phone', label: 'Phone' }, { id: 'site', label: 'Site' }, { id: 'role', label: 'Role' }, { id: 'city', label: 'City' },
  { id: 'notes', label: 'Notes' }, { id: 'skip', label: 'Leave out' },
];
export const FIELD_IDS = FIELDS.map(f => f.id);
const ONE = new Set(['company', 'email', 'phone', 'site', 'role', 'city']);   // one column each; name and notes may repeat (joined)

const norm = (s) => String(s || '').toLowerCase().replace(/[._:#*()/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();
const HEAD = [
  ['email', /^(e ?mail|mail|e ?mail address|e ?mail id|mail address|mail id|email ids?)$/],
  ['phone', /^(phone|phones|mobile|mobile no|mobile number|phone no|phone number|tel|telephone|cell|cell phone|whatsapp|whatsapp no|contact no|contact number|ph|ph no|landline)$/],
  ['site', /^(site|website|web site|web|url|domain|host|homepage|web address)$/],
  ['role', /^(role|title|job title|designation|position|post|job)$/],
  ['city', /^(city|town|place|location|district)$/],
  ['notes', /^(notes?|remarks?|comments?|description|memo|details)$/],
  ['company', /^(company|company name|business|business name|organisation|organization|org|firm|firm name|account|shop|shop name|store|party|party name|trade name)$/],
  ['name', /^(contact|contact name|contact person|person|full name|first name|last name|surname|given name|owner|owner name|proprietor|person name)$/],
  ['either', /^(name|customer|customer name|client|client name)$/],   // a company or a person: decided with the other columns
];
export const okMail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
/** A phone number as people write it: digits with spaces, +, -, dots, brackets, and an optional extension. */
export const okPhone = (s) => { const v = String(s || '').trim(); return /^\+?[\d\s().\-/]+(?:\s*(?:x|ext\.?)\s*\d{1,6})?$/i.test(v) && (v.replace(/(?:x|ext\.?)\s*\d+$/i, '').match(/\d/g) || []).length >= 5 && (v.match(/\d/g) || []).length <= 20; };
const siteLike = (s) => /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(String(s || '').trim()) && !/@/.test(s);

function byContent(cells) {
  const v = cells.map(c => String(c || '').trim()).filter(Boolean); if (!v.length) return null;
  const share = (fn) => v.filter(fn).length / v.length;
  if (share(okMail) >= 0.6) return 'email';
  if (share(okPhone) >= 0.6) return 'phone';
  if (share(siteLike) >= 0.6) return 'site';
  return null;
}
/** Does the first row look like data (a mail address, site or phone in it) rather than headings? */
function firstRowIsData(rows) {
  const r = rows[0] || []; if (r.some(c => HEAD.some(([, re]) => re.test(norm(c))))) return false;
  return r.some(c => okMail(c) || okPhone(c) || siteLike(c));
}

/**
 * The guess for a parsed CSV (rows of cells): { header: bool, headings: [...], columns: [fieldId...] }.
 * Unknown headings go to notes; a second phone or mail column goes to notes too, so nothing is lost.
 */
export function guessColumns(rows) {
  const width = Math.max(0, ...rows.slice(0, 50).map(r => r.length));
  const header = rows.length > 0 && !firstRowIsData(rows);
  const headings = Array.from({ length: width }, (_, i) => header ? String(rows[0][i] || '').trim() || `Column ${i + 1}` : `Column ${i + 1}`);
  const body = rows.slice(header ? 1 : 0, (header ? 1 : 0) + 20);
  let cols = headings.map((h, i) => {
    const hit = header ? HEAD.find(([, re]) => re.test(norm(h))) : null;
    return hit ? hit[0] : byContent(body.map(r => r[i])) || null;
  });
  // "Name" or "Customer": a company when the file has no company column and reads like a list of firms (a site, no mail
  // address); otherwise a person's name. Without a header, the first unknown column is the company and the next the name.
  const has = (f) => cols.includes(f);
  const either = (c) => {
    if (has('company')) return 'name';
    if (has('name')) return 'company';
    if (has('site') && !has('email')) return 'company';
    return has('email') || has('phone') ? 'name' : 'company';
  };
  cols = cols.map(c => (c === 'either' ? either() : c));
  if (!header) { const open = cols.map((c, i) => (c ? null : i)).filter(i => i != null); if (open[0] != null && !has('company')) cols[open[0]] = 'company'; if (open[1] != null && !cols.includes('name')) cols[open[1]] = 'name'; }
  cols = cols.map(c => c || 'notes');
  const seen = new Set();
  cols = cols.map(c => { if (ONE.has(c)) { if (seen.has(c)) return 'notes'; seen.add(c); } return c; });
  return { header, headings, columns: cols };
}

/** The owner's column choice, checked: one of the fields per column; only name and notes may repeat. */
export function checkMapping(cols, width) {
  if (!Array.isArray(cols) || cols.length !== width) throw Object.assign(new Error('Say what each column is.'), { status: 400 });
  const out = cols.map(c => String(c || ''));
  const badOne = out.find(c => !FIELD_IDS.includes(c)); if (badOne != null) throw Object.assign(new Error('A column can be company, contact name, mail address, phone, site, role, city, notes or leave out.'), { status: 400 });
  for (const f of ONE) if (out.filter(c => c === f).length > 1) throw Object.assign(new Error(`Only one column can be the ${FIELDS.find(x => x.id === f).label.toLowerCase()}.`), { status: 400 });
  if (!out.some(c => ['company', 'name', 'email'].includes(c))) throw Object.assign(new Error('Pick at least one column that is a company, a contact name or a mail address.'), { status: 400 });
  return out;
}

/** One row's values by field. Name columns are joined with a space; notes columns keep their heading. */
export function rowValues(cells, columns, headings) {
  const v = { company: '', name: '', email: '', phone: '', site: '', role: '', city: '', notes: '' }; const notes = [];
  columns.forEach((f, i) => {
    const c = String(cells[i] ?? '').trim(); if (!c || f === 'skip') return;
    if (f === 'name') v.name = [v.name, c].filter(Boolean).join(' ');
    else if (f === 'notes') notes.push(/^Column \d+$/.test(headings[i] || '') || /^notes?$/i.test(headings[i] || '') ? c : `${headings[i]}: ${c}`);
    else v[f] = c;
  });
  v.notes = notes.join('\n');
  return v;
}
