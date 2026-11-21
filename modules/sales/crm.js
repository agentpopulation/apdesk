// The CRM inside Sales: companies, contacts, deals and customers. Tables m_sales_companies, m_sales_contacts,
// m_sales_deals, m_sales_crm_links (which lead became which company and contact). Nothing here sends anything.
//
// Merge rules (the same for typing, Add to CRM and a CSV import):
//   company: the same site host (www. dropped), else the same name (case and spaces ignored) when one of the two has no site.
//   contact: the same mail address (case ignored), else the same name in the same company when one of the two has no address.
// A merge fills empty fields only, and keeps every source the row came from.
const now = () => new Date().toISOString();
const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const j = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
const clip = (v, n) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n));
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export const TYPED = 'typed by you';
export const LAWFUL = 'You are responsible for contacting people lawfully.';
export const DEAL_STAGES = [
  { id: 'new', label: 'New' }, { id: 'contacted', label: 'Contacted' }, { id: 'replied', label: 'Replied' },
  { id: 'meeting', label: 'Meeting' }, { id: 'won', label: 'Won' }, { id: 'lost', label: 'Lost' },
];

export function siteHost(site) {
  const s = String(site || '').trim(); if (!s || /\s/.test(s)) return '';
  try { const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return ''; return u.hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
const nameKey = (s) => clip(s, 200).toLowerCase();
const mailKey = (s) => clip(s, 200).toLowerCase();
const okMail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
/** A real calendar day as year-month-day (2026-02-30 is refused, not rolled over to March). */
export const okDay = (v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d = new Date(v + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === v; };
/** YYYY-MM-DD of the given moment in the owner's zone. */
export function todayIn(timeZone, at = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); } catch { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
}

// ---- CSV (RFC 4180: quotes, doubled quotes, commas and new lines inside quotes)
export function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false; const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
/** A cell a spreadsheet would run as a formula gets a leading quote. */
const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCsv = (rows) => rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';

const HEAD = { name: /^(company|company name|name|customer|business|organisation|organization)$/, site: /^(site|website|web site|web|url|domain|host)$/, contact: /^(contact|contact name|person|full name)$/, email: /^(email|e-mail|mail|email address|mail address)$/ };
function csvRecords(text) {
  const rows = parseCsv(text); if (!rows.length) return [];
  const head = rows[0].map(x => x.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(HEAD).map(([k, re]) => [k, head.findIndex(x => re.test(x))]));
  const hasHead = col.name >= 0 || col.site >= 0;
  if (!hasHead) Object.assign(col, { name: 0, site: 1, contact: 2, email: 3 });   // no header row: name, site, contact, email
  return rows.slice(hasHead ? 1 : 0).slice(0, 5000).map(r => ({ name: clip(r[col.name], 160), site: clip(r[col.site], 300), contact: clip(r[col.contact], 120), email: clip(r[col.email], 200) }));
}
const fileLabel = (f) => clip(String(f || '').split(/[\\/]/).pop(), 120) || 'a file you gave';

function addSource(list, from, at, fresh = false) {
  const out = list.map(s => (fresh && s.from === from ? { from, at } : s));   // fresh: a later read of the same source moves its date forward
  if (!out.some(s => s.from === from)) out.push({ from, at }); return out.slice(-20);
}
// A source other than the owner also keeps what it gave and which empty fields it filled, so taking the source off
// takes back what it filled (or puts back what another source gave).
function markSource(list, from, at, fresh, gave, filled) {
  const out = addSource(list, from, at, fresh);
  if (from === TYPED) return out;
  return out.map(s => {
    if (s.from !== from) return s;
    const g = { ...(s.gave || {}) }; for (const [k, v] of Object.entries(gave)) if (v) g[k] = v;
    const f = [...new Set([...(s.filled || []), ...filled])];
    return { ...s, ...(Object.keys(g).length ? { gave: g } : {}), ...(f.length ? { filled: f } : {}) };
  });
}
/** The owner typed these fields: no source filled them any more. */
const ownFields = (list, fields) => list.map(s => (s.filled ? { ...s, filled: s.filled.filter(f => !fields.includes(f)) } : s));
const plainSources = (list) => list.map(({ from, at }) => ({ from, at }));

export class CrmStore {
  constructor(db, { currency = () => '', timeZone = () => '', kv = null, emit = () => {} } = {}) {
    this.db = db; this.currency = currency; this.timeZone = timeZone; this.kv = kv; this.emit = emit;
    db.migrate(4, `
      CREATE TABLE IF NOT EXISTS m_sales_companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, site TEXT, host TEXT, customer INTEGER NOT NULL DEFAULT 0,
        notes TEXT, sources TEXT, unchecked TEXT, created TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS m_sales_contacts (id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT, phone TEXT, company_id TEXT,
        notes TEXT, sources TEXT, unchecked TEXT, created TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS m_sales_deals (id TEXT PRIMARY KEY, title TEXT NOT NULL, company_id TEXT, contact_id TEXT, stage TEXT NOT NULL DEFAULT 'new',
        value_minor INTEGER, currency TEXT, next_step TEXT, next_date TEXT, notes TEXT, created TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS m_sales_crm_links (lead_id TEXT PRIMARY KEY, company_id TEXT, contact_id TEXT, at TEXT);
      CREATE INDEX IF NOT EXISTS m_sales_companies_host ON m_sales_companies (host);
      CREATE INDEX IF NOT EXISTS m_sales_contacts_company ON m_sales_contacts (company_id);
    `);
  }
  // ---- stages: fixed ids, names the owner may change
  stages() { const names = this.kv?.get('dealStages', {}) || {}; return DEAL_STAGES.map(s => ({ id: s.id, label: clip(names[s.id], 40) || s.label })); }
  renameStages(labels = {}) {
    const cur = this.kv?.get('dealStages', {}) || {};
    for (const s of DEAL_STAGES) if (s.id in labels) { const v = clip(labels[s.id], 40); if (v) cur[s.id] = v; }
    this.kv?.set('dealStages', cur); this.emit({ change: 'crm' });
    return this.stages();
  }

  // ---- companies
  companyOut(r) {
    if (!r) return null;
    const unchecked = j(r.unchecked, []);
    return { id: r.id, name: r.name, site: r.site || '', host: r.host || '', customer: !!r.customer, notes: r.notes || '', sources: plainSources(j(r.sources, [])),
      notChecked: [...(r.site ? [] : ['Site']), ...unchecked], created: r.created, updated: r.updated };
  }
  companies() { return this.db.all('SELECT * FROM m_sales_companies ORDER BY name COLLATE NOCASE').map(r => this.companyOut(r)); }
  getCompany(id) { return this.companyOut(this.db.get('SELECT * FROM m_sales_companies WHERE id = ?', id)); }
  /** The company the merge rule matches in a list, or null. */
  static matchCompany(list, { name, host }) {
    return (host && list.find(c => c.host === host)) || list.find(c => nameKey(c.name) === nameKey(name) && (!host || !c.host)) || null;
  }
  /** Add or merge one company. from: where it came from; at: when. */
  upsertCompany(x, { from = TYPED, at = now(), fresh = false } = {}) {
    const name = clip(x?.name, 160); if (!name) throw bad('A company needs a name.');
    const site = clip(x.site, 300); const host = siteHost(site);
    const unchecked = (Array.isArray(x.unchecked) ? x.unchecked : []).map(u => clip(u, 60)).filter(Boolean);
    const hit = CrmStore.matchCompany(this.companies(), { name, host });
    const t = now();
    if (hit) {
      const row = this.db.get('SELECT * FROM m_sales_companies WHERE id = ?', hit.id);
      const gave = { site: host ? site : '', notes: clip(x.notes, 2000) };
      const sources = markSource(j(row.sources, []), from, at, fresh, gave, Object.keys(gave).filter(k => gave[k] && !row[k]));
      const un = [...new Set([...j(row.unchecked, []), ...unchecked])];
      this.db.run('UPDATE m_sales_companies SET site = ?, host = ?, customer = ?, notes = ?, sources = ?, unchecked = ?, updated = ? WHERE id = ?',
        row.site || (host ? site : null), row.host || host || null, row.customer || (x.customer ? 1 : 0), row.notes || clip(x.notes, 2000) || null, JSON.stringify(sources), JSON.stringify(un), t, hit.id);
      this.emit({ change: 'crm' });
      return { ...this.getCompany(hit.id), merged: true };
    }
    const id = rid('co_');
    this.db.run('INSERT INTO m_sales_companies (id, name, site, host, customer, notes, sources, unchecked, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, host ? site : null, host || null, x.customer ? 1 : 0, clip(x.notes, 2000) || null, JSON.stringify(markSource([], from, at, false, { site: host ? site : '', notes: clip(x.notes, 2000) }, ['site', 'notes'].filter(k => k === 'site' ? host : clip(x.notes, 2000)))), JSON.stringify(unchecked), t, t);
    this.emit({ change: 'crm' });
    return this.getCompany(id);
  }
  updateCompany(id, p = {}) {
    const row = this.db.get('SELECT * FROM m_sales_companies WHERE id = ?', id); if (!row) return null;
    const sets = []; const vals = []; let typed = false;
    if ('name' in p) { const v = clip(p.name, 160); if (!v) throw bad('A company needs a name.'); sets.push('name = ?'); vals.push(v); typed = true; }
    if ('site' in p) {
      const v = clip(p.site, 300); const host = siteHost(v); if (v && !host) throw bad('That site address does not look right.');
      const other = host && this.db.get('SELECT name FROM m_sales_companies WHERE host = ? AND id != ?', host, id);
      if (other) throw bad(`${other.name} already has that site. Remove one of the two, or add the details to ${other.name}.`);
      sets.push('site = ?', 'host = ?'); vals.push(host ? v : null, host || null); typed = true; }
    if ('notes' in p) { sets.push('notes = ?'); vals.push(clip(p.notes, 2000) || null); }
    if ('customer' in p) { sets.push('customer = ?'); vals.push(p.customer ? 1 : 0); }
    if (!sets.length) return this.getCompany(id);
    const owned = ['site', 'notes'].filter(k => k in p);
    if (typed || owned.length) { sets.push('sources = ?'); vals.push(JSON.stringify(ownFields(typed ? addSource(j(row.sources, []), TYPED, now()) : j(row.sources, []), owned))); }
    sets.push('updated = ?'); vals.push(now());
    this.db.run(`UPDATE m_sales_companies SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.emit({ change: 'crm' });
    return this.getCompany(id);
  }
  removeCompany(id) {
    this.db.run('UPDATE m_sales_contacts SET company_id = NULL WHERE company_id = ?', id);
    this.db.run('UPDATE m_sales_deals SET company_id = NULL WHERE company_id = ?', id);
    this.db.run('DELETE FROM m_sales_crm_links WHERE company_id = ?', id);
    this.db.run('DELETE FROM m_sales_companies WHERE id = ?', id); this.emit({ change: 'crm' });
  }
  customers() { return this.db.all('SELECT name, host FROM m_sales_companies WHERE customer = 1 ORDER BY name COLLATE NOCASE').map(r => ({ name: r.name, host: r.host || '' })); }

  // ---- contacts
  contactOut(r) {
    if (!r) return null;
    const unchecked = j(r.unchecked, []);
    return { id: r.id, name: r.name || '', email: r.email || '', role: r.role || '', phone: r.phone || '', companyId: r.company_id || null, notes: r.notes || '', sources: plainSources(j(r.sources, [])),
      notChecked: [...(r.name ? [] : ['Name']), ...(r.email ? [] : ['Mail address']), ...(r.role ? [] : ['Role']), ...unchecked], created: r.created, updated: r.updated };
  }
  contacts() { return this.db.all('SELECT * FROM m_sales_contacts ORDER BY name COLLATE NOCASE').map(r => this.contactOut(r)); }
  getContact(id) { return this.contactOut(this.db.get('SELECT * FROM m_sales_contacts WHERE id = ?', id)); }
  static matchContact(list, { name, email, companyId }) {
    const m = mailKey(email);
    return (m && list.find(c => mailKey(c.email) === m)) || (name && companyId && list.find(c => c.companyId === companyId && nameKey(c.name) === nameKey(name) && (!m || !c.email))) || null;
  }
  upsertContact(x, { from = TYPED, at = now(), fresh = false } = {}) {
    const name = clip(x?.name, 120); const email = clip(x?.email, 200);
    if (!name && !email) throw bad('A contact needs a name or a mail address.');
    if (email && !okMail(email)) throw bad('That mail address does not look right.');
    const companyId = x.companyId && this.getCompany(x.companyId) ? x.companyId : null;
    const role = clip(x.role, 120); const phone = clip(x.phone, 60);
    const hit = CrmStore.matchContact(this.contacts(), { name, email, companyId });
    const t = now();
    if (hit) {
      const row = this.db.get('SELECT * FROM m_sales_contacts WHERE id = ?', hit.id);
      const gave = { name, email, role, phone, company_id: companyId || '' };
      const sources = markSource(j(row.sources, []), from, at, fresh, gave, Object.keys(gave).filter(k => gave[k] && !row[k]));
      this.db.run('UPDATE m_sales_contacts SET name = ?, email = ?, role = ?, phone = ?, company_id = ?, sources = ?, updated = ? WHERE id = ?',
        row.name || name || null, row.email || email || null, row.role || role || null, row.phone || phone || null, row.company_id || companyId, JSON.stringify(sources), t, hit.id);
      this.emit({ change: 'crm' });
      return { ...this.getContact(hit.id), merged: true };
    }
    const id = rid('ct_');
    this.db.run('INSERT INTO m_sales_contacts (id, name, email, role, phone, company_id, notes, sources, unchecked, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, name || null, email || null, role || null, phone || null, companyId, clip(x.notes, 2000) || null,
      JSON.stringify((() => { const gave = { name, email, role, phone, company_id: companyId || '' }; return markSource([], from, at, false, gave, Object.keys(gave).filter(k => gave[k])); })()), '[]', t, t);
    this.emit({ change: 'crm' });
    return this.getContact(id);
  }
  updateContact(id, p = {}) {
    const row = this.db.get('SELECT * FROM m_sales_contacts WHERE id = ?', id); if (!row) return null;
    const sets = []; const vals = []; let typed = false;
    for (const [k, col, n] of [['name', 'name', 120], ['role', 'role', 120], ['phone', 'phone', 60]]) if (k in p) { sets.push(`${col} = ?`); vals.push(clip(p[k], n) || null); typed = true; }
    if ('email' in p) { const v = clip(p.email, 200); if (v && !okMail(v)) throw bad('That mail address does not look right.'); sets.push('email = ?'); vals.push(v || null); typed = true; }
    if ('companyId' in p) { sets.push('company_id = ?'); vals.push(p.companyId && this.getCompany(p.companyId) ? p.companyId : null); }
    if ('notes' in p) { sets.push('notes = ?'); vals.push(clip(p.notes, 2000) || null); }
    if (!sets.length) return this.getContact(id);
    const name = 'name' in p ? clip(p.name, 120) : row.name; const email = 'email' in p ? clip(p.email, 200) : row.email;
    if (!name && !email) throw bad('A contact needs a name or a mail address.');
    const owned = [['name', 'name'], ['email', 'email'], ['role', 'role'], ['phone', 'phone'], ['companyId', 'company_id']].filter(([k]) => k in p).map(([, f]) => f);
    if (typed || owned.length) { sets.push('sources = ?'); vals.push(JSON.stringify(ownFields(typed ? addSource(j(row.sources, []), TYPED, now()) : j(row.sources, []), owned))); }
    sets.push('updated = ?'); vals.push(now());
    this.db.run(`UPDATE m_sales_contacts SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.emit({ change: 'crm' });
    return this.getContact(id);
  }
  removeContact(id) {
    this.db.run('UPDATE m_sales_deals SET contact_id = NULL WHERE contact_id = ?', id);
    this.db.run('UPDATE m_sales_crm_links SET contact_id = NULL WHERE contact_id = ?', id);
    this.db.run('DELETE FROM m_sales_contacts WHERE id = ?', id); this.emit({ change: 'crm' });
  }

  // ---- one source taken off: its mark leaves every company and contact, and the fields it filled are taken back (or
  // given the value another remaining source gave). A row left with no source is removed, except a company or a contact
  // on a deal (the owner's own work): it stays without the mark and without the source's data, a contact keeping its name.
  removeSource(from) {
    let companies = 0, contacts = 0, kept = 0;
    const strip = (table, remove, onDeal) => {
      for (const r of this.db.all(`SELECT * FROM ${table}`)) {
        const list = j(r.sources, []); const mine = list.find(s => s.from === from); if (!mine) continue;
        const rest = list.filter(s => s.from !== from);
        if (!rest.length && !onDeal(r.id)) { remove(r.id); continue; }
        const set = {};
        for (const f of mine.filled || []) {
          const other = rest.find(s => s.gave?.[f]);
          set[f] = other ? other.gave[f] : null;
          if (other) other.filled = [...new Set([...(other.filled || []), f])];
        }
        if (table === 'm_sales_contacts' && !('name' in set ? set.name : r.name) && !('email' in set ? set.email : r.email)) { if (r.name) delete set.name; else delete set.email; }
        if ('site' in set) set.host = set.site ? siteHost(set.site) || null : null;
        if ('company_id' in set && set.company_id && !this.getCompany(set.company_id)) set.company_id = null;
        const cols = Object.keys(set);
        this.db.run(`UPDATE ${table} SET ${cols.map(c => c + ' = ?, ').join('')}sources = ?, updated = ? WHERE id = ?`, ...cols.map(c => set[c]), JSON.stringify(rest), now(), r.id);
        kept++;
      }
    };
    this.db.transaction(() => {
      strip('m_sales_contacts', (id) => { this.removeContact(id); contacts++; }, (id) => !!this.db.get('SELECT id FROM m_sales_deals WHERE contact_id = ?', id));
      strip('m_sales_companies', (id) => { this.removeCompany(id); companies++; }, (id) => !!this.db.get('SELECT id FROM m_sales_deals WHERE company_id = ?', id));
    });
    this.emit({ change: 'crm' });
    return { companies, contacts, kept };
  }

  // ---- a lead becomes a company and a contact
  leadIds() { return this.db.all('SELECT lead_id FROM m_sales_crm_links').map(r => r.lead_id); }
  fromLead(lead) {
    const link = this.db.get('SELECT * FROM m_sales_crm_links WHERE lead_id = ?', lead.id);
    if (link && this.getCompany(link.company_id)) return { already: true, company: this.getCompany(link.company_id), contact: this.getContact(link.contact_id) };
    const urls = (lead.sources || []).map(s => s.url).filter(u => /^https?:\/\//i.test(u || ''));
    const at = lead.created || now();
    const froms = urls.length ? urls : [TYPED];
    let company = this.upsertCompany({ name: lead.company, site: lead.website, unchecked: lead.unchecked }, { from: froms[0], at });
    for (const f of froms.slice(1)) company = this.upsertCompany({ name: company.name, site: company.site }, { from: f, at });
    let contact = null;
    if (lead.contactName || lead.email) {
      contact = this.upsertContact({ name: lead.contactName, email: lead.email && okMail(lead.email) ? lead.email : '', role: lead.contactRole, companyId: company.id }, { from: froms[0], at });
    }
    this.db.run('INSERT OR REPLACE INTO m_sales_crm_links (lead_id, company_id, contact_id, at) VALUES (?, ?, ?, ?)', lead.id, company.id, contact?.id || null, now());
    this.emit({ change: 'crm' });
    return { already: false, company: this.getCompany(company.id), contact: contact && this.getContact(contact.id) };
  }

  // ---- deals
  stageOk(s) { return DEAL_STAGES.some(x => x.id === s); }
  dealOut(r, stages = this.stages(), today = todayIn(this.timeZone())) {
    if (!r) return null;
    const co = r.company_id ? this.db.get('SELECT name FROM m_sales_companies WHERE id = ?', r.company_id) : null;
    const ct = r.contact_id ? this.db.get('SELECT name, email FROM m_sales_contacts WHERE id = ?', r.contact_id) : null;
    const open = !['won', 'lost'].includes(r.stage);
    return { id: r.id, title: r.title, companyId: r.company_id || null, companyName: co?.name || '', contactId: r.contact_id || null, contactName: ct?.name || ct?.email || '',
      stage: r.stage, stageLabel: stages.find(s => s.id === r.stage)?.label || r.stage, value: r.value_minor == null ? null : Number(r.value_minor), currency: r.currency || this.currency(),
      nextStep: r.next_step || '', nextDate: r.next_date || '', due: open && r.next_date ? (r.next_date < today ? 'overdue' : r.next_date === today ? 'today' : '') : '', notes: r.notes || '', created: r.created, updated: r.updated };
  }
  deals() { const s = this.stages(); const t = todayIn(this.timeZone()); return this.db.all('SELECT * FROM m_sales_deals ORDER BY created').map(r => this.dealOut(r, s, t)); }
  getDeal(id) { return this.dealOut(this.db.get('SELECT * FROM m_sales_deals WHERE id = ?', id)); }
  dealFields(p, sets, vals) {
    if ('stage' in p) { if (!this.stageOk(p.stage)) throw bad('That stage does not exist.'); sets.push('stage = ?'); vals.push(p.stage); }
    if ('valueMinor' in p) { const v = p.valueMinor == null || p.valueMinor === '' ? null : Math.round(Number(p.valueMinor)); if (v != null && (!Number.isFinite(v) || v < 0)) throw bad('A value is a number.'); sets.push('value_minor = ?'); vals.push(v); }
    if ('nextDate' in p) { const v = String(p.nextDate || ''); if (v && !okDay(v)) throw bad('That date does not exist. A date is year-month-day.'); sets.push('next_date = ?'); vals.push(v || null); }
    if ('nextStep' in p) { sets.push('next_step = ?'); vals.push(clip(p.nextStep, 300) || null); }
    if ('notes' in p) { sets.push('notes = ?'); vals.push(String(p.notes || '').slice(0, 4000) || null); }
    if ('companyId' in p) { sets.push('company_id = ?'); vals.push(p.companyId && this.getCompany(p.companyId) ? p.companyId : null); }
    if ('contactId' in p) { sets.push('contact_id = ?'); vals.push(p.contactId && this.getContact(p.contactId) ? p.contactId : null); }
    if ('title' in p) { const v = clip(p.title, 160); if (!v) throw bad('A deal needs a name.'); sets.push('title = ?'); vals.push(v); }
  }
  addDeal(p = {}) {
    const co = p.companyId ? this.getCompany(p.companyId) : null;
    const title = clip(p.title, 160) || co?.name || '';
    if (!title) throw bad('A deal needs a name or a company.');
    const id = rid('dl_'); const t = now();
    this.db.run('INSERT INTO m_sales_deals (id, title, stage, currency, created, updated) VALUES (?, ?, ?, ?, ?, ?)', id, title, 'new', clip(p.currency, 3).toUpperCase() || this.currency() || null, t, t);
    try { const sets = []; const vals = []; const { title: _t, ...rest } = p; this.dealFields({ ...rest, stage: p.stage || 'new' }, sets, vals); if (sets.length) this.db.run(`UPDATE m_sales_deals SET ${sets.join(', ')} WHERE id = ?`, ...vals, id); }
    catch (e) { this.db.run('DELETE FROM m_sales_deals WHERE id = ?', id); throw e; }
    this.emit({ change: 'crm' });
    return this.getDeal(id);
  }
  updateDeal(id, p = {}) {
    if (!this.db.get('SELECT id FROM m_sales_deals WHERE id = ?', id)) return null;
    const sets = []; const vals = []; this.dealFields(p, sets, vals);
    if (!sets.length) return this.getDeal(id);
    sets.push('updated = ?'); vals.push(now());
    this.db.run(`UPDATE m_sales_deals SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.emit({ change: 'crm' });
    return this.getDeal(id);
  }
  removeDeal(id) { this.db.run('DELETE FROM m_sales_deals WHERE id = ?', id); this.emit({ change: 'crm' }); }

  // ---- CSV in: a preview that saves nothing, then the same plan saved
  plan(csv) {
    const recs = csvRecords(csv);
    const list = this.companies().map(c => ({ ...c }));
    return recs.map(r => {
      if (!r.name) return { ...r, action: 'skip', why: 'no company name' };
      const host = siteHost(r.site);
      const hit = CrmStore.matchCompany(list, { name: r.name, host });
      if (hit) { if (!hit.host && host) hit.host = host; return { ...r, host, action: 'merge', with: hit.name }; }
      if (!host && !r.contact && !okMail(r.email)) return { ...r, host, action: 'skip', why: 'only a name, no site, contact or mail address' };
      list.push({ name: r.name, host });
      return { ...r, host, action: 'new' };
    });
  }
  importCsv(csv, fileName) {
    const from = fileLabel(fileName); const at = now();
    const rows = this.plan(csv); let saved = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        if (r.action === 'skip') continue;
        const co = this.upsertCompany({ name: r.name, site: r.host ? r.site : '', customer: true }, { from, at });
        if (r.contact || (r.email && okMail(r.email))) this.upsertContact({ name: r.contact, email: okMail(r.email) ? r.email : '', companyId: co.id }, { from, at });
        saved++;
      }
    });
    this.emit({ change: 'crm' });
    return { saved, skipped: rows.length - saved, from };
  }

  // ---- CSV out
  exportCsv(what) {
    const day = (iso) => (iso ? todayIn(this.timeZone(), new Date(iso)) : '');
    const srcs = (l) => l.map(s => `${s.from} (${day(s.at)})`).join('; ');
    const cos = Object.fromEntries(this.companies().map(c => [c.id, c.name]));
    if (what === 'companies') return toCsv([['Name', 'Site', 'Customer', 'Sources', 'Not checked', 'Added'], ...this.companies().map(c => [c.name, c.site, c.customer ? 'yes' : 'no', srcs(c.sources), c.notChecked.join('; '), day(c.created)])]);
    if (what === 'contacts') return toCsv([['Name', 'Mail address', 'Role', 'Phone', 'Company', 'Sources', 'Not checked', 'Added'], ...this.contacts().map(c => [c.name, c.email, c.role, c.phone, cos[c.companyId] || '', srcs(c.sources), c.notChecked.join('; '), day(c.created)])]);
    if (what === 'deals') return toCsv([['Title', 'Company', 'Contact', 'Stage', 'Value', 'Currency', 'Next step', 'Next date', 'Notes'], ...this.deals().map(d => [d.title, d.companyName, d.contactName, d.stageLabel, d.value == null ? '' : d.value / 100, d.currency, d.nextStep, d.nextDate, d.notes])]);
    throw bad('Export contacts, companies or deals.');
  }
}
