// The CRM inside Sales: companies, contacts, deals and customers. Tables m_sales_companies, m_sales_contacts,
// m_sales_deals, m_sales_crm_links (which lead became which company and contact), m_sales_notes (dated notes with where
// they came from) and m_sales_imports (each file import, so it can be taken back as one set). Nothing here sends anything.
//
// Merge rules:
//   company: the same site host (www. dropped), else the same name (case and spaces ignored) when one of the two has no site.
//            A near-same name ("Pvt Ltd" and "Pvt. Ltd.") is never merged by itself: typed, the owner is asked "the same?";
//            from a file, the row says so and is added as its own company unless the owner says it is the same.
//   contact: the same mail address (case ignored), else the same name in the same company when one of the two has no
//            address, else the same phone number after tidying (spaces, dashes, the country code).
// Typed by the owner, a match whose values differ is never merged quietly: both values are shown and he picks.
// From a file or another module, a merge fills empty fields only and keeps every source the row came from; a watched list
// (sync) also updates the fields it filled itself, unless the owner has changed them by hand since.
import { guessColumns, checkMapping, rowValues, okMail, okPhone } from './columns.js';

const now = () => new Date().toISOString();
const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const j = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
const flat = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const clip = (v, n) => flat(v).slice(0, n);
const bad = (msg, extra = {}) => Object.assign(new Error(msg), { status: 400, ...extra });
const fieldBad = (msg, field) => bad(msg, { field });

export const TYPED = 'typed by you';
/** A record an agent proposed in chat and the owner approved as shown: his own, like typing it. */
export const CHAT = 'from chat, approved by you';
const OWNERS = new Set([TYPED, CHAT]);
export const LAWFUL = 'You are responsible for contacting people lawfully.';
/** The most rows one import takes. */
export const IMPORT_ROWS = 5000;
export const DEAL_STAGES = [
  { id: 'new', label: 'New' }, { id: 'contacted', label: 'Contacted' }, { id: 'replied', label: 'Replied' },
  { id: 'meeting', label: 'Meeting' }, { id: 'won', label: 'Won' }, { id: 'lost', label: 'Lost' },
];
/** The longest value kept for each field. Typed longer, it is refused with the reason; nothing is cut quietly. */
export const LIMITS = { name: 200, company: 200, email: 200, role: 120, phone: 40, city: 80, site: 300, notes: 4000, title: 200, step: 300 };
const WORDS = { name: 'A name', company: 'A company name', email: 'A mail address', role: 'A role', phone: 'A phone number', city: 'A city', site: 'A site address', notes: 'Notes', title: 'A deal name', step: 'A next step' };

export function siteHost(site) {
  const s = String(site || '').trim(); if (!s || /\s/.test(s)) return '';
  try { const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return ''; return u.hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
const nameKey = (s) => flat(s).toLowerCase();
const mailKey = (s) => flat(s).toLowerCase();
/**
 * A phone number tidied for comparing. Written with a country code (+ or 00): "+" and every digit. Written without one:
 * the digits without the leading 0 that starts a number inside its country. An extension and a "(0)" after the country
 * code are not compared. '' when it has fewer than five digits.
 */
export function phoneKey(s) {
  const raw = String(s || '').replace(/(?:x|ext\.?)\s*\d+\s*$/i, '').replace(/\(\s*0\s*\)/g, '').trim();
  const lead = raw.replace(/[^\d+]/g, '');
  const coded = lead.startsWith('+') || /^00[1-9]/.test(lead);
  let d = raw.replace(/\D/g, ''); if (coded && !lead.startsWith('+')) d = d.slice(2);
  if (coded) return d.length >= 5 ? '+' + d : '';
  d = d.replace(/^0+/, '');
  return d.length >= 5 ? d : '';
}
/** The keys a stored number may have and be this number: with a country code, the same code and number, or the same
 *  number written with no code (a country code is one to three digits); with none, the same number, with or without a
 *  code. Two numbers with different country codes never match. */
function phoneKeys(pk) {
  if (!pk) return [];
  if (!pk.startsWith('+')) return [pk];
  const d = pk.slice(1); const out = new Set([pk]);
  for (let n = 0; n <= 3; n++) { const rest = d.slice(n).replace(/^0+/, ''); if (rest.length >= 5) out.add(rest); }
  return [...out];
}
/** A SQL condition (and its values) for contacts whose phone is this number by the rule above. */
function phoneWhere(pk) {
  if (!pk.startsWith('+')) return { sql: "(phone_key = ? OR (phone_key LIKE ? AND length(phone_key) BETWEEN ? AND ?))", args: [pk, '+%' + pk, pk.length + 1, pk.length + 5] };
  const keys = phoneKeys(pk); return { sql: `phone_key IN (${keys.map(() => '?').join(', ')})`, args: keys };
}
/** Is a the same phone number as b, by the rule above? */
export function samePhone(a, b) {
  const x = phoneKey(a), y = phoneKey(b); if (!x || !y) return false; if (x === y) return true;
  const [c, u] = x.startsWith('+') ? [x, y] : [y, x];
  if (!c.startsWith('+') || u.startsWith('+')) return false;
  return phoneKeys(c).includes(u);
}
/** True when only one of two numbers that match has a country code: then the code was not compared. */
export const codeNotCompared = (a, b) => phoneKey(a).startsWith('+') !== phoneKey(b).startsWith('+');
const SUFFIX = /\b(pvt|private|ltd|limited|llp|llc|inc|incorporated|co|company|corp|corporation|plc|gmbh|the|and)\b/g;
/** A company name for "near the same": lower case, & as and, no dots or commas, no Pvt / Ltd / Inc and the like. */
export function coKey(s) {
  const k = nameKey(s).replace(/&/g, ' and ').replace(/[.,'’"()\-/]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return k || nameKey(s);
}
/** A real calendar day as year-month-day (2026-02-30 is refused, not rolled over to March). */
export const okDay = (v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d = new Date(v + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === v; };
/** YYYY-MM-DD of the given moment in the owner's zone. */
export function todayIn(timeZone, at = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); } catch { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
}
/** YYYY-MM for "this month", "next month", "last month", a YYYY-MM or a YYYY-MM-DD, in the owner's zone; '' when it is none of these. */
export function monthOf(v, timeZone, at = new Date()) {
  const s = String(v || '').trim().toLowerCase(); const t = todayIn(timeZone, at); let [y, m] = [Number(t.slice(0, 4)), Number(t.slice(5, 7))];
  const step = s === 'next month' || s === 'next' ? 1 : s === 'last month' || s === 'last' ? -1 : s === 'this month' || s === 'this' ? 0 : null;
  if (step != null) { m += step; if (m > 12) { m = 1; y++; } if (m < 1) { m = 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; }
  const x = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/); return x && Number(x[2]) >= 1 && Number(x[2]) <= 12 ? `${x[1]}-${x[2]}` : '';
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
/** A file that is not CSV text, in one plain line, or '' when it reads as CSV. */
export function notCsv(text, fileName = '') {
  const s = String(text || ''); const ext = (String(fileName).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  if (/^(xlsx|xlsm|xls|ods|numbers)$/.test(ext) || s.startsWith('PK\u0003\u0004') || s.startsWith('�PNG')) return 'That file is a spreadsheet, not CSV text. An .xlsx workbook can be picked as it is; for any other kind, save it as CSV in your spreadsheet program (File, Save as, CSV) and import that file.';
  if (ext && !/^(csv|txt|tsv)$/.test(ext)) return `A .${ext} file cannot be imported. Save the list as CSV and import that file.`;
  if (/\u0000/.test(s.slice(0, 4000))) return 'That file is not plain text. Save it as CSV in your spreadsheet program and import that file.';
  return '';
}
const fileLabel = (f) => clip(String(f || '').split(/[\\/]/).pop(), 120) || 'a file you gave';

function addSource(list, from, at, fresh = false) {
  const out = list.map(s => (fresh && s.from === from ? { ...s, from, at, goneAt: undefined } : s));   // fresh: a later read of the same source moves its date forward
  if (!out.some(s => s.from === from)) out.push({ from, at }); return out.slice(-20);
}
// A source other than the owner also keeps what it gave and which empty fields it filled, so taking the source off
// takes back what it filled (or puts back what another source gave), and a later read can update what it filled.
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
const plainSources = (list) => list.map(({ from, at, goneAt }) => ({ from, at, ...(goneAt ? { goneAt } : {}) }));
const ROLLBACK = Symbol('preview');

const CONTACT_COLS = { name: 'name', email: 'email', role: 'role', phone: 'phone', city: 'city', companyId: 'company_id', notes: 'notes' };
const CONTACT_WORDS = { name: 'Name', email: 'Mail address', role: 'Role', phone: 'Phone', city: 'City', companyId: 'Company', notes: 'Notes' };
const COMPANY_WORDS = { name: 'Name', site: 'Site', phone: 'Phone', city: 'City', notes: 'Notes' };

export class CrmStore {
  constructor(db, { currency = () => '', timeZone = () => '', locale = () => '', kv = null, emit = () => {} } = {}) {
    this.db = db; this.currency = currency; this.timeZone = timeZone; this.locale = locale; this.kv = kv; this.quiet = false;
    this.emit = (d) => { if (!this.quiet) emit(d); };
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
    // 5: close dates, city and phone, the owner's last edit, look-up keys (so a 2,000-row import does not read every row
    // for every row), dated notes, and imports that can be taken back as one set
    db.migrate(5, (d) => {
      d.exec(`
        ALTER TABLE m_sales_deals ADD COLUMN close_date TEXT;
        ALTER TABLE m_sales_companies ADD COLUMN city TEXT;
        ALTER TABLE m_sales_companies ADD COLUMN phone TEXT;
        ALTER TABLE m_sales_companies ADD COLUMN edited TEXT;
        ALTER TABLE m_sales_companies ADD COLUMN name_key TEXT;
        ALTER TABLE m_sales_companies ADD COLUMN co_key TEXT;
        ALTER TABLE m_sales_contacts ADD COLUMN city TEXT;
        ALTER TABLE m_sales_contacts ADD COLUMN edited TEXT;
        ALTER TABLE m_sales_contacts ADD COLUMN name_key TEXT;
        ALTER TABLE m_sales_contacts ADD COLUMN mail_key TEXT;
        ALTER TABLE m_sales_contacts ADD COLUMN phone_key TEXT;
        CREATE TABLE IF NOT EXISTS m_sales_notes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, text TEXT NOT NULL, source TEXT, at TEXT);
        CREATE TABLE IF NOT EXISTS m_sales_imports (id TEXT PRIMARY KEY, file TEXT, at TEXT, counts TEXT, made TEXT, filled TEXT);
        CREATE INDEX IF NOT EXISTS m_sales_companies_name_key ON m_sales_companies (name_key);
        CREATE INDEX IF NOT EXISTS m_sales_companies_co_key ON m_sales_companies (co_key);
        CREATE INDEX IF NOT EXISTS m_sales_contacts_mail_key ON m_sales_contacts (mail_key);
        CREATE INDEX IF NOT EXISTS m_sales_contacts_phone_key ON m_sales_contacts (phone_key);
        CREATE INDEX IF NOT EXISTS m_sales_contacts_name_key ON m_sales_contacts (name_key);
        CREATE INDEX IF NOT EXISTS m_sales_notes_ref ON m_sales_notes (kind, ref_id);
      `);
      for (const r of d.all('SELECT id, name FROM m_sales_companies')) d.run('UPDATE m_sales_companies SET name_key = ?, co_key = ? WHERE id = ?', nameKey(r.name), coKey(r.name), r.id);
      for (const r of d.all('SELECT id, name, email, phone FROM m_sales_contacts')) d.run('UPDATE m_sales_contacts SET name_key = ?, mail_key = ?, phone_key = ? WHERE id = ?', nameKey(r.name) || null, mailKey(r.email) || null, phoneKey(r.phone) || null, r.id);
    });
    // 6: phone numbers compared with their country code (two codes never match); the stored look-up key is made again
    db.migrate(6, (d) => { for (const r of d.all('SELECT id, phone FROM m_sales_contacts WHERE phone IS NOT NULL')) d.run('UPDATE m_sales_contacts SET phone_key = ? WHERE id = ?', phoneKey(r.phone) || null, r.id); });
  }
  /** A typed value, checked: longer than the field holds is refused with the reason, never cut. */
  take(v, field, strict) {
    const s = field === 'notes' ? String(v ?? '').trim() : flat(v); const n = LIMITS[field];
    if (s.length > n) { if (strict) throw fieldBad(`${WORDS[field]} can be at most ${n} characters. This one has ${s.length}.`, field); return s.slice(0, n); }
    return s;
  }
  // ---- stages: fixed ids, names the owner may change
  stages() { const names = this.kv?.get('dealStages', {}) || {}; return DEAL_STAGES.map(s => ({ id: s.id, label: clip(names[s.id], 40) || s.label })); }
  renameStages(labels = {}) {
    const cur = this.kv?.get('dealStages', {}) || {};
    for (const s of DEAL_STAGES) if (s.id in labels) { const v = clip(labels[s.id], 40); if (v) cur[s.id] = v; }
    this.kv?.set('dealStages', cur); this.emit({ change: 'crm' });
    return this.stages();
  }
  /** Only fields no one gave are "not checked": a row the owner typed alone has nothing to check, its empty fields are "not set". */
  static fromOthers(sources) { return sources.some(s => !OWNERS.has(s.from)); }

  // ---- companies
  companyOut(r) {
    if (!r) return null;
    const unchecked = j(r.unchecked, []); const sources = j(r.sources, []); const others = CrmStore.fromOthers(sources);
    return { id: r.id, name: r.name, site: r.site || '', host: r.host || '', phone: r.phone || '', city: r.city || '', customer: !!r.customer, notes: r.notes || '', sources: plainSources(sources),
      notChecked: others ? [...(r.site ? [] : ['Site']), ...unchecked] : unchecked, created: r.created, updated: r.updated, edited: r.edited || null };
  }
  companies() { return this.db.all('SELECT * FROM m_sales_companies ORDER BY name COLLATE NOCASE').map(r => this.companyOut(r)); }
  getCompany(id) { return this.companyOut(this.db.get('SELECT * FROM m_sales_companies WHERE id = ?', id)); }
  /** The company the merge rule matches, or null; with near, a near-same name too ({ row, kind: 'site' | 'name' | 'near' }). */
  matchCompany({ name, host }, { near = false, not = null } = {}) {
    const ex = (sql, ...a) => this.db.get(`SELECT * FROM m_sales_companies WHERE ${sql}${not ? ' AND id != ?' : ''} LIMIT 1`, ...a, ...(not ? [not] : []));
    if (host) { const r = ex('host = ?', host); if (r) return { row: r, kind: 'site' }; }
    const n = ex(host ? 'name_key = ? AND host IS NULL' : 'name_key = ?', nameKey(name)); if (n) return { row: n, kind: 'name' };
    if (near) { const k = coKey(name); const r = k && ex(host ? 'co_key = ? AND host IS NULL' : 'co_key = ?', k); if (r) return { row: r, kind: 'near' }; }
    return null;
  }
  checkCompany(x, strict) {
    const name = this.take(x?.name, 'company', strict); if (!name) throw fieldBad('A company needs a name.', 'name');
    const site = this.take(x.site, 'site', strict); const host = siteHost(site);
    if (site && !host && strict) throw fieldBad('That site address does not look right. Write it like company.com.', 'site');
    const phone = this.take(x.phone, 'phone', strict); if (phone && strict && !okPhone(phone)) throw fieldBad('That phone number does not look right. Use digits, spaces, +, - and brackets.', 'phone');
    return { name, site: host ? site : '', host, phone, city: this.take(x.city, 'city', strict), notes: this.take(x.notes, 'notes', strict), customer: !!x.customer };
  }
  /**
   * Add or merge one company. from: where it came from; at: when. Typed by the owner (from TYPED), a match whose values differ,
   * or a near-same name, is refused with status 409 and both records ({ same, why, differs, canSeparate }) until he says
   * merge (x.merge = that id, x.pick = { field: 'mine' | 'theirs' }) or separate (x.separate). into: a file row the owner
   * said is the same as this company. Returns the company with merged, isNew, filled (fields this add filled in),
   * synced and left (sync: fields the list changed that were updated, or left because the owner changed them).
   */
  upsertCompany(x, { from = TYPED, at = now(), fresh = false, sync = false, into = null, track = null } = {}) {
    const strict = from === TYPED; const v = this.checkCompany(x || {}, strict);
    const unchecked = (Array.isArray(x.unchecked) ? x.unchecked : []).map(u => clip(u, 60)).filter(Boolean);
    let hit = into ? { row: this.db.get('SELECT * FROM m_sales_companies WHERE id = ?', into), kind: 'chosen' } : null;
    if (hit && !hit.row) hit = null;
    if (strict && x.merge) { const r = this.db.get('SELECT * FROM m_sales_companies WHERE id = ?', String(x.merge)); if (!r) throw bad('That company is gone. Look again.', { status: 404 }); return this.mergeTyped('co', r, v, x.pick || {}); }
    if (!hit && !x.separate) hit = this.matchCompany({ name: v.name, host: v.host }, { near: strict });
    if (x.separate && v.host) { const o = this.db.get('SELECT name FROM m_sales_companies WHERE host = ?', v.host); if (o) throw fieldBad(`${o.name} already has that site. Two companies cannot share one site.`, 'site'); }
    const t = now();
    if (hit && strict) {
      const differs = this.differs('co', hit.row, v);
      if (hit.kind === 'near' || differs.length) {
        const why = hit.kind === 'site' ? 'the same site' : hit.kind === 'near' ? 'a name that is almost the same' : 'the same name';
        throw Object.assign(new Error(`${hit.row.name} has ${why}. Is it the same company?`), { status: 409, code: 'same', same: this.companyOut(hit.row), why, differs, canSeparate: hit.kind !== 'site' });
      }
    }
    if (hit) {
      const row = hit.row;
      const gave = { site: v.site, phone: v.phone, city: v.city, notes: v.notes };
      const filled = Object.keys(gave).filter(k => gave[k] && !row[k]);
      const list = j(row.sources, []); const mine = list.find(s => s.from === from);
      const set = {}; const updated = []; const left = [];
      for (const k of filled) set[k] = gave[k];
      if (sync) for (const k of Object.keys(gave)) {
        if (!gave[k] || !row[k] || gave[k] === row[k]) continue;
        if (mine && (mine.filled || []).includes(k) && mine.gave?.[k] === row[k]) { set[k] = gave[k]; updated.push(k); } else left.push(k);
      }
      if ('site' in set) set.host = siteHost(set.site) || null;
      if (v.customer && !row.customer) { set.customer = 1; filled.push('customer'); }
      const sources = markSource(list, from, at, fresh, gave, filled.filter(k => k !== 'customer'));
      const un = [...new Set([...j(row.unchecked, []), ...unchecked])];
      const cols = Object.keys(set);
      this.db.run(`UPDATE m_sales_companies SET ${cols.map(c => c + ' = ?, ').join('')}sources = ?, unchecked = ?, updated = ?${strict ? ', edited = ?' : ''} WHERE id = ?`,
        ...cols.map(c => set[c]), JSON.stringify(strict ? ownFields(sources, cols) : sources), JSON.stringify(un), t, ...(strict ? [t] : []), row.id);
      if (track && filled.length) track.filled.push({ t: 'co', id: row.id, fields: filled });
      this.emit({ change: 'crm' });
      return { ...this.getCompany(row.id), merged: true, isNew: false, filled, synced: updated, left };
    }
    const id = rid('co_');
    const gave = { site: v.site, phone: v.phone, city: v.city, notes: v.notes };
    this.db.run('INSERT INTO m_sales_companies (id, name, site, host, phone, city, customer, notes, sources, unchecked, created, updated, edited, name_key, co_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, v.name, v.site || null, v.host || null, v.phone || null, v.city || null, v.customer ? 1 : 0, v.notes || null,
      JSON.stringify(markSource([], from, at, false, gave, Object.keys(gave).filter(k => gave[k]))), JSON.stringify(unchecked), t, t, strict ? t : null, nameKey(v.name), coKey(v.name));
    if (track) track.made.push({ t: 'co', id });
    this.emit({ change: 'crm' });
    return { ...this.getCompany(id), merged: false, isNew: true, filled: [], synced: [], left: [] };
  }
  /** Fields where the record and the typed values both have something and they differ: the owner picks one. */
  differs(kind, row, v) {
    const out = [];
    const same = (f, a, b) => (f === 'email' ? mailKey(a) === mailKey(b) : f === 'phone' ? (samePhone(a, b) || flat(a) === flat(b)) : f === 'site' ? siteHost(a) === siteHost(b) : nameKey(a) === nameKey(b));
    if (kind === 'co') {
      for (const f of ['name', 'site', 'phone', 'city']) { const a = v[f], b = row[f]; if (a && b && !same(f, a, b)) out.push({ field: f, label: COMPANY_WORDS[f], mine: a, theirs: b }); }
    } else {
      for (const f of ['name', 'email', 'role', 'phone', 'city', 'companyId']) {
        const a = v[f]; const b = row[CONTACT_COLS[f]];
        if (!a || !b || (f === 'companyId' ? a === b : same(f, a, b))) continue;
        out.push(f === 'companyId' ? { field: f, label: 'Company', mine: this.getCompany(a)?.name || '', theirs: this.getCompany(b)?.name || '', mineId: a, theirsId: b } : { field: f, label: CONTACT_WORDS[f], mine: a, theirs: b });
      }
    }
    return out;
  }
  /** The owner said "the same": every field takes his pick where both had a value; empty fields are filled; notes are joined. */
  mergeTyped(kind, row, v, pick) {
    const table = kind === 'co' ? 'm_sales_companies' : 'm_sales_contacts';
    const cols = kind === 'co' ? { name: 'name', site: 'site', phone: 'phone', city: 'city' } : { name: 'name', email: 'email', role: 'role', phone: 'phone', city: 'city', companyId: 'company_id' };
    const set = {};
    for (const [f, col] of Object.entries(cols)) {
      const a = v[f]; const b = row[col];
      if (a && (!b || pick[f] === 'mine')) set[col] = a;
    }
    if (v.notes && v.notes !== row.notes) set.notes = row.notes ? `${row.notes}\n${v.notes}` : v.notes;   // both kept
    if (kind === 'co') {
      if (v.customer && !row.customer) set.customer = 1;
      if ('site' in set) { set.host = siteHost(set.site) || null; const o = set.host && this.db.get('SELECT name FROM m_sales_companies WHERE host = ? AND id != ?', set.host, row.id); if (o) throw fieldBad(`${o.name} already has that site. Remove one of the two, or add the details to ${o.name}.`, 'site'); }
      if ('name' in set) { set.name_key = nameKey(set.name); set.co_key = coKey(set.name); }
    } else {
      if ('email' in set) { set.mail_key = mailKey(set.email); const o = this.db.get('SELECT name, email FROM m_sales_contacts WHERE mail_key = ? AND id != ?', set.mail_key, row.id); if (o) throw fieldBad(`${o.name || o.email} already has that mail address. Two contacts cannot share one.`, 'email'); }
      if ('phone' in set) set.phone_key = phoneKey(set.phone) || null;
      if ('name' in set) set.name_key = nameKey(set.name);
      if ('company_id' in set && !this.getCompany(set.company_id)) delete set.company_id;
    }
    const t = now(); const list = ownFields(addSource(j(row.sources, []), TYPED, t), Object.keys(set));
    const keys = Object.keys(set);
    this.db.run(`UPDATE ${table} SET ${keys.map(c => c + ' = ?, ').join('')}sources = ?, updated = ?, edited = ? WHERE id = ?`, ...keys.map(c => set[c]), JSON.stringify(list), t, t, row.id);
    this.emit({ change: 'crm' });
    return { ...(kind === 'co' ? this.getCompany(row.id) : this.getContact(row.id)), merged: true, isNew: false, filled: keys, synced: [], left: [] };
  }
  /** Only the fields whose value this save really changes: a field sent as it already is stays as it was, and stays the
   *  list's or the file's if one filled it. */
  changedOnly(row, p, cols) {
    const out = {};
    for (const [k, v] of Object.entries(p || {})) {
      const col = cols[k]; if (!col) { out[k] = v; continue; }
      const was = row[col]; const now = k === 'notes' ? String(v ?? '').trim() : flat(v);
      const same = k === 'customer' ? !!v === !!was : k === 'companyId' ? (v || null) === (was || null) : k === 'email' ? mailKey(now) === mailKey(was) : now === (k === 'notes' ? String(was ?? '').trim() : flat(was));
      if (!same) out[k] = v;
    }
    return out;
  }
  updateCompany(id, p = {}, { by = TYPED } = {}) {
    const row = this.db.get('SELECT * FROM m_sales_companies WHERE id = ?', id); if (!row) return null;
    p = this.changedOnly(row, p, { name: 'name', site: 'site', phone: 'phone', city: 'city', notes: 'notes', customer: 'customer' });
    const sets = []; const vals = []; let typed = false;
    if ('name' in p) { const v = this.take(p.name, 'company', true); if (!v) throw fieldBad('A company needs a name.', 'name'); sets.push('name = ?', 'name_key = ?', 'co_key = ?'); vals.push(v, nameKey(v), coKey(v)); typed = true; }
    if ('site' in p) {
      const v = this.take(p.site, 'site', true); const host = siteHost(v); if (v && !host) throw fieldBad('That site address does not look right. Write it like company.com.', 'site');
      const other = host && this.db.get('SELECT name FROM m_sales_companies WHERE host = ? AND id != ?', host, id);
      if (other) throw fieldBad(`${other.name} already has that site. Remove one of the two, or add the details to ${other.name}.`, 'site');
      sets.push('site = ?', 'host = ?'); vals.push(host ? v : null, host || null); typed = true; }
    if ('phone' in p) { const v = this.take(p.phone, 'phone', true); if (v && !okPhone(v)) throw fieldBad('That phone number does not look right. Use digits, spaces, +, - and brackets.', 'phone'); sets.push('phone = ?'); vals.push(v || null); typed = true; }
    if ('city' in p) { sets.push('city = ?'); vals.push(this.take(p.city, 'city', true) || null); typed = true; }
    if ('notes' in p) { sets.push('notes = ?'); vals.push(this.take(p.notes, 'notes', true) || null); }
    if ('customer' in p) { sets.push('customer = ?'); vals.push(p.customer ? 1 : 0); }
    if (!sets.length) return this.getCompany(id);
    const owned = ['site', 'notes', 'phone', 'city'].filter(k => k in p);
    if (typed || owned.length) { sets.push('sources = ?'); vals.push(JSON.stringify(ownFields(typed ? addSource(j(row.sources, []), by, now()) : j(row.sources, []), owned))); }
    const t = now(); sets.push('updated = ?', 'edited = ?'); vals.push(t, t);
    this.db.run(`UPDATE m_sales_companies SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.emit({ change: 'crm' });
    return this.getCompany(id);
  }
  removeCompany(id) {
    this.db.run('UPDATE m_sales_contacts SET company_id = NULL WHERE company_id = ?', id);
    this.db.run('UPDATE m_sales_deals SET company_id = NULL WHERE company_id = ?', id);
    this.db.run('DELETE FROM m_sales_crm_links WHERE company_id = ?', id);
    this.db.run("DELETE FROM m_sales_notes WHERE kind = 'company' AND ref_id = ?", id);
    this.db.run('DELETE FROM m_sales_companies WHERE id = ?', id); this.emit({ change: 'crm' });
  }
  customers() { return this.db.all('SELECT name, host FROM m_sales_companies WHERE customer = 1 ORDER BY name COLLATE NOCASE').map(r => ({ name: r.name, host: r.host || '' })); }
  /** Customer companies with their contacts' names and mail addresses, for other modules that write to them. */
  customerContacts() {
    return this.db.all('SELECT id, name, host FROM m_sales_companies WHERE customer = 1 ORDER BY name COLLATE NOCASE').map(c => ({ name: c.name, host: c.host || '',
      contacts: this.db.all('SELECT name, email FROM m_sales_contacts WHERE company_id = ? ORDER BY name COLLATE NOCASE', c.id).map(x => ({ name: x.name || '', email: x.email || '' })) }));
  }

  // ---- contacts
  contactOut(r) {
    if (!r) return null;
    const unchecked = j(r.unchecked, []); const sources = j(r.sources, []); const others = CrmStore.fromOthers(sources);
    return { id: r.id, name: r.name || '', email: r.email || '', role: r.role || '', phone: r.phone || '', city: r.city || '', companyId: r.company_id || null, notes: r.notes || '', sources: plainSources(sources),
      notChecked: others ? [...(r.name ? [] : ['Name']), ...(r.email ? [] : ['Mail address']), ...(r.role ? [] : ['Role']), ...unchecked] : unchecked, created: r.created, updated: r.updated, edited: r.edited || null };
  }
  contacts() { return this.db.all("SELECT * FROM m_sales_contacts ORDER BY CASE WHEN COALESCE(name, '') = '' THEN 1 ELSE 0 END, name COLLATE NOCASE, email").map(r => this.contactOut(r)); }
  getContact(id) { return this.contactOut(this.db.get('SELECT * FROM m_sales_contacts WHERE id = ?', id)); }
  /** The contact the merge rule matches ({ row, kind: 'mail' | 'name' | 'phone' }), or null. typed: also a same name with no company. */
  matchContact({ name, email, phone, companyId }, { typed = false, not = null } = {}) {
    const ex = (sql, ...a) => this.db.get(`SELECT * FROM m_sales_contacts WHERE ${sql}${not ? ' AND id != ?' : ''} LIMIT 1`, ...a, ...(not ? [not] : []));
    const m = mailKey(email); const nk = nameKey(name); const pk = phoneKey(phone);
    if (m) { const r = ex('mail_key = ?', m); if (r) return { row: r, kind: 'mail' }; }
    if (nk && companyId) { const r = ex(`name_key = ? AND company_id = ?${m ? ' AND mail_key IS NULL' : ''}`, nk, companyId); if (r) return { row: r, kind: 'name' }; }
    if (pk) {
      const w = phoneWhere(pk);
      const rows = this.db.all(`SELECT * FROM m_sales_contacts WHERE ${w.sql}${typed ? '' : " AND (name_key IS NULL OR name_key = '' OR name_key = ? OR ? = '')"}${not ? ' AND id != ?' : ''} LIMIT 20`, ...w.args, ...(typed ? [] : [nk, nk]), ...(not ? [not] : []));
      const r = rows.find(x => samePhone(x.phone, phone)); if (r) return { row: r, kind: 'phone', codeNotCompared: codeNotCompared(r.phone, phone) };
    }
    if (typed && nk && !m) { const r = ex(`name_key = ? AND ${companyId ? '(company_id IS NULL OR company_id = ?)' : '1 = 1'}`, nk, ...(companyId ? [companyId] : [])); if (r) return { row: r, kind: 'samename' }; }
    return null;
  }
  checkContact(x, strict) {
    const name = this.take(x?.name, 'name', strict); const email = this.take(x?.email, 'email', strict);
    if (!name && !email) throw fieldBad('A contact needs a name or a mail address.', 'name');
    if (email && !okMail(email)) throw fieldBad('That mail address does not look right.', 'email');
    const phone = this.take(x.phone, 'phone', strict);
    if (phone && strict && !okPhone(phone)) throw fieldBad('That phone number does not look right. Use digits, spaces, +, - and brackets.', 'phone');
    const companyId = x.companyId && this.getCompany(x.companyId) ? x.companyId : null;
    return { name, email, phone, companyId, role: this.take(x.role, 'role', strict), city: this.take(x.city, 'city', strict), notes: this.take(x.notes, 'notes', strict) };
  }
  /** Add or merge one contact; the same rules and answers as upsertCompany. */
  upsertContact(x, { from = TYPED, at = now(), fresh = false, sync = false, track = null } = {}) {
    const strict = from === TYPED; const v = this.checkContact(x || {}, strict);
    if (strict && x.merge) { const r = this.db.get('SELECT * FROM m_sales_contacts WHERE id = ?', String(x.merge)); if (!r) throw bad('That contact is gone. Look again.', { status: 404 }); return this.mergeTyped('ct', r, v, x.pick || {}); }
    let hit = x.separate ? null : this.matchContact(v, { typed: strict });
    if (x.separate && v.email) { const o = this.db.get('SELECT name, email FROM m_sales_contacts WHERE mail_key = ?', mailKey(v.email)); if (o) throw fieldBad(`${o.name || o.email} already has that mail address. Two contacts cannot share one.`, 'email'); }
    const t = now();
    if (hit && strict) {
      const differs = this.differs('ct', hit.row, v);
      if (hit.kind === 'samename' || differs.length) {
        const why = hit.kind === 'mail' ? 'the same mail address' : hit.kind === 'phone' ? `the same phone number${hit.codeNotCompared ? ' (only one of the two has a country code, so the code was not compared)' : ''}` : 'the same name';
        throw Object.assign(new Error(`${hit.row.name || hit.row.email} has ${why}. Is it the same person?`), { status: 409, code: 'same', same: this.contactOut(hit.row), why, differs, canSeparate: hit.kind !== 'mail' });
      }
    }
    const gaveOf = () => ({ name: v.name, email: v.email, role: v.role, phone: v.phone, city: v.city, notes: v.notes, company_id: v.companyId || '' });
    if (hit) {
      const row = hit.row; const gave = gaveOf();
      const filled = Object.keys(gave).filter(k => gave[k] && !row[k]);
      const list = j(row.sources, []); const mine = list.find(s => s.from === from);
      const set = {}; const updated = []; const left = [];
      for (const k of filled) set[k] = gave[k];
      if (sync) for (const k of Object.keys(gave)) {
        if (!gave[k] || !row[k] || gave[k] === row[k] || (k === 'email' && mailKey(gave[k]) === mailKey(row[k]))) continue;
        if (mine && (mine.filled || []).includes(k) && mine.gave?.[k] === row[k]) { set[k] = gave[k]; updated.push(k); } else left.push(k);
      }
      if ('email' in set) { set.mail_key = mailKey(set.email); if (this.db.get('SELECT 1 AS x FROM m_sales_contacts WHERE mail_key = ? AND id != ?', set.mail_key, row.id)) { delete set.email; delete set.mail_key; } }
      if ('phone' in set) set.phone_key = phoneKey(set.phone) || null;
      if ('name' in set) set.name_key = nameKey(set.name);
      const sources = markSource(list, from, at, fresh, gave, filled);
      const cols = Object.keys(set);
      this.db.run(`UPDATE m_sales_contacts SET ${cols.map(c => c + ' = ?, ').join('')}sources = ?, updated = ?${strict ? ', edited = ?' : ''} WHERE id = ?`,
        ...cols.map(c => set[c]), JSON.stringify(strict ? ownFields(sources, cols) : sources), t, ...(strict ? [t] : []), row.id);
      if (track && filled.length) track.filled.push({ t: 'ct', id: row.id, fields: filled });
      this.emit({ change: 'crm' });
      return { ...this.getContact(row.id), merged: true, isNew: false, filled, synced: updated, left, matchedBy: hit.kind };
    }
    const id = rid('ct_'); const gave = gaveOf();
    this.db.run('INSERT INTO m_sales_contacts (id, name, email, role, phone, city, company_id, notes, sources, unchecked, created, updated, edited, name_key, mail_key, phone_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, v.name || null, v.email || null, v.role || null, v.phone || null, v.city || null, v.companyId, v.notes || null,
      JSON.stringify(markSource([], from, at, false, gave, Object.keys(gave).filter(k => gave[k]))), '[]', t, t, strict ? t : null, nameKey(v.name) || null, mailKey(v.email) || null, phoneKey(v.phone) || null);
    if (track) track.made.push({ t: 'ct', id });
    this.emit({ change: 'crm' });
    return { ...this.getContact(id), merged: false, isNew: true, filled: [], synced: [], left: [] };
  }
  /** The owner's edit. The same mail address as another contact is refused; the same phone is saved and named in samePhone. */
  updateContact(id, p = {}, { by = TYPED } = {}) {
    const row = this.db.get('SELECT * FROM m_sales_contacts WHERE id = ?', id); if (!row) return null;
    p = this.changedOnly(row, p, { ...CONTACT_COLS });
    const sets = []; const vals = []; let typed = false;
    for (const [k, col, f] of [['name', 'name', 'name'], ['role', 'role', 'role'], ['city', 'city', 'city']]) if (k in p) { const v = this.take(p[k], f, true); sets.push(`${col} = ?`); vals.push(v || null); if (k === 'name') { sets.push('name_key = ?'); vals.push(nameKey(v) || null); } typed = true; }
    let samePhone = null;
    if ('phone' in p) {
      const v = this.take(p.phone, 'phone', true); if (v && !okPhone(v)) throw fieldBad('That phone number does not look right. Use digits, spaces, +, - and brackets.', 'phone');
      const pk = phoneKey(v); const w = pk && phoneWhere(pk);
      const o = w && this.db.all(`SELECT name, email, phone FROM m_sales_contacts WHERE ${w.sql} AND id != ? LIMIT 20`, ...w.args, id).find(x => samePhone(x.phone, v)); if (o) samePhone = o.name || o.email;
      sets.push('phone = ?', 'phone_key = ?'); vals.push(v || null, pk || null); typed = true;
    }
    if ('email' in p) {
      const v = this.take(p.email, 'email', true); if (v && !okMail(v)) throw fieldBad('That mail address does not look right.', 'email');
      const o = v && this.db.get('SELECT name, email FROM m_sales_contacts WHERE mail_key = ? AND id != ?', mailKey(v), id);
      if (o) throw fieldBad(`${o.name || o.email} already has that mail address. Two contacts cannot share one.`, 'email');
      sets.push('email = ?', 'mail_key = ?'); vals.push(v || null, mailKey(v) || null); typed = true;
    }
    if ('companyId' in p) { sets.push('company_id = ?'); vals.push(p.companyId && this.getCompany(p.companyId) ? p.companyId : null); }
    if ('notes' in p) { sets.push('notes = ?'); vals.push(this.take(p.notes, 'notes', true) || null); }
    if (!sets.length) return this.getContact(id);
    const name = 'name' in p ? flat(p.name) : row.name; const email = 'email' in p ? flat(p.email) : row.email;
    if (!name && !email) throw fieldBad('A contact needs a name or a mail address.', 'name');
    const owned = [['name', 'name'], ['email', 'email'], ['role', 'role'], ['phone', 'phone'], ['city', 'city'], ['notes', 'notes'], ['companyId', 'company_id']].filter(([k]) => k in p).map(([, f]) => f);
    if (typed || owned.length) { sets.push('sources = ?'); vals.push(JSON.stringify(ownFields(typed ? addSource(j(row.sources, []), by, now()) : j(row.sources, []), owned))); }
    const t = now(); sets.push('updated = ?', 'edited = ?'); vals.push(t, t);
    this.db.run(`UPDATE m_sales_contacts SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.emit({ change: 'crm' });
    return { ...this.getContact(id), ...(samePhone ? { samePhone } : {}) };
  }
  removeContact(id) {
    this.db.run('UPDATE m_sales_deals SET contact_id = NULL WHERE contact_id = ?', id);
    this.db.run('UPDATE m_sales_crm_links SET contact_id = NULL WHERE contact_id = ?', id);
    this.db.run("DELETE FROM m_sales_notes WHERE kind = 'contact' AND ref_id = ?", id);
    this.db.run('DELETE FROM m_sales_contacts WHERE id = ?', id); this.emit({ change: 'crm' });
  }

  // ---- a watched list: a row no longer on it is marked with the date, never deleted
  /** Mark the contact (or, for a row with no person, the company) a source gave as no longer on it. True when one was marked. */
  markGone({ name, email, company } = {}, { from, at = now() } = {}) {
    const co = company ? this.matchCompany({ name: company, host: '' })?.row : null;
    let row = null; let table = 'm_sales_contacts';
    if (email) row = this.db.get('SELECT * FROM m_sales_contacts WHERE mail_key = ?', mailKey(email));
    if (!row && name) row = co ? this.db.get('SELECT * FROM m_sales_contacts WHERE name_key = ? AND company_id = ?', nameKey(name), co.id) : this.db.get('SELECT * FROM m_sales_contacts WHERE name_key = ? AND company_id IS NULL', nameKey(name));
    if (!row && !name && !email && co) { row = co; table = 'm_sales_companies'; }
    if (!row) return false;
    const list = j(row.sources, []); if (!list.some(s => s.from === from)) return false;
    this.db.run(`UPDATE ${table} SET sources = ?, updated = ? WHERE id = ?`, JSON.stringify(list.map(s => (s.from === from && !s.goneAt ? { ...s, goneAt: at } : s))), now(), row.id);
    this.emit({ change: 'crm' });
    return true;
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
        const set = this.takeBack(table, r, mine, rest, mine.filled || []);
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
  /** The fields a source filled, given back to another source's value or emptied, as a column set (keys kept in step). */
  takeBack(table, r, mine, rest, fields) {
    const set = {};
    for (const f of fields) {
      if (f === 'customer') { set.customer = 0; continue; }
      if (!(f in r)) continue;
      const other = rest.find(s => s.gave?.[f]);
      set[f] = other ? other.gave[f] : null;
      if (other) other.filled = [...new Set([...(other.filled || []), f])];
    }
    if (table === 'm_sales_contacts' && !('name' in set ? set.name : r.name) && !('email' in set ? set.email : r.email)) { if (r.name) delete set.name; else delete set.email; }
    if ('site' in set) set.host = set.site ? siteHost(set.site) || null : null;
    if ('company_id' in set && set.company_id && !this.getCompany(set.company_id)) set.company_id = null;
    if ('email' in set) set.mail_key = mailKey(set.email) || null;
    if ('phone' in set) set.phone_key = phoneKey(set.phone) || null;
    if ('name' in set) set.name_key = nameKey(set.name) || null;
    return set;
  }

  // ---- a lead becomes a company and a contact
  leadIds() { return this.db.all('SELECT lead_id FROM m_sales_crm_links').map(r => r.lead_id); }
  fromLead(lead) {
    const link = this.db.get('SELECT * FROM m_sales_crm_links WHERE lead_id = ?', lead.id);
    if (link && this.getCompany(link.company_id)) return { already: true, company: this.getCompany(link.company_id), contact: this.getContact(link.contact_id) };
    const urls = (lead.sources || []).map(s => s.url).filter(u => /^https?:\/\//i.test(u || ''));
    const at = lead.created || now();
    const froms = urls.length ? urls : ['the lead in your pipeline'];
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

  // ---- dated notes, with where each came from
  addNote(kind, id, text, source = TYPED) {
    const k = kind === 'company' ? 'company' : kind === 'contact' ? 'contact' : null; if (!k) throw bad('A note goes on a contact or a company.');
    const exists = k === 'company' ? this.getCompany(id) : this.getContact(id); if (!exists) throw bad(`That ${k} is not in the CRM.`, { status: 404 });
    const v = this.take(text, 'notes', true); if (!v) throw fieldBad('Write the note first.', 'text');
    const from = clip(source, 120) || TYPED; const t = now(); const nid = rid('nt_');
    this.db.run('INSERT INTO m_sales_notes (id, kind, ref_id, text, source, at) VALUES (?, ?, ?, ?, ?, ?)', nid, k, id, v, from, t);
    if (OWNERS.has(from)) this.db.run(`UPDATE ${k === 'company' ? 'm_sales_companies' : 'm_sales_contacts'} SET edited = ? WHERE id = ?`, t, id);
    this.emit({ change: 'crm' });
    return { id: nid, kind: k, refId: id, text: v, source: from, at: t };
  }
  notes(kind, id) { return this.db.all('SELECT * FROM m_sales_notes WHERE kind = ? AND ref_id = ? ORDER BY at DESC', kind, id).map(n => ({ id: n.id, text: n.text, source: n.source || TYPED, at: n.at })); }
  removeNote(id) { this.db.run('DELETE FROM m_sales_notes WHERE id = ?', id); this.emit({ change: 'crm' }); }
  /** A contact's or a company's own page: the record, its deals, its notes and where it came from, newest first. */
  page(kind, id) {
    const rec = kind === 'company' ? this.getCompany(id) : this.getContact(id); if (!rec) return null;
    const deals = this.deals().filter(d => (kind === 'company' ? d.companyId === id : d.contactId === id));
    const history = [...rec.sources.map(s => ({ at: s.at, what: s.from === TYPED ? 'Typed by you' : s.from === CHAT ? 'From chat, approved by you' : `From ${s.from}`, from: s.from })),
      ...rec.sources.filter(s => s.goneAt).map(s => ({ at: s.goneAt, what: `No longer on the list at ${s.from}`, from: s.from }))].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { [kind]: rec, deals, notes: this.notes(kind, id), history, ...(kind === 'company' ? { contacts: this.db.all('SELECT * FROM m_sales_contacts WHERE company_id = ? ORDER BY name COLLATE NOCASE', id).map(r => this.contactOut(r)) } : {}) };
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
      closeDate: r.close_date || '', closeLate: open && !!r.close_date && r.close_date < today,
      nextStep: r.next_step || '', nextDate: r.next_date || '', due: open && r.next_date ? (r.next_date < today ? 'overdue' : r.next_date === today ? 'today' : '') : '', notes: r.notes || '', created: r.created, updated: r.updated };
  }
  deals() { const s = this.stages(); const t = todayIn(this.timeZone()); return this.db.all('SELECT * FROM m_sales_deals ORDER BY created').map(r => this.dealOut(r, s, t)); }
  /** Deals by stage (id or name), close month (YYYY-MM, "this month", "next month"), contact, company, or words in the title. */
  dealsWhere({ stage, closing, query, contactId, companyId } = {}) {
    const st = this.stages(); const want = String(stage || '').trim().toLowerCase();
    const sid = want ? (st.find(s => s.id === want || s.label.toLowerCase() === want)?.id || (want === 'open' ? 'open' : '?')) : '';
    const month = closing ? monthOf(closing, this.timeZone()) : '';
    if (closing && !month) throw bad('Say the month as this month, next month or year-month (2026-11).');
    const q = nameKey(query);
    return this.deals().filter(d => (!sid || (sid === 'open' ? !['won', 'lost'].includes(d.stage) : d.stage === sid)) && (!month || d.closeDate.startsWith(month)) && (!contactId || d.contactId === contactId) && (!companyId || d.companyId === companyId)
      && (!q || [d.title, d.companyName, d.contactName].some(x => nameKey(x).includes(q))));
  }
  getDeal(id) { return this.dealOut(this.db.get('SELECT * FROM m_sales_deals WHERE id = ?', id)); }
  dealFields(p, sets, vals) {
    if ('stage' in p) { if (!this.stageOk(p.stage)) throw fieldBad('That stage does not exist.', 'stage'); sets.push('stage = ?'); vals.push(p.stage); }
    if ('valueMinor' in p) { const v = p.valueMinor == null || p.valueMinor === '' ? null : Math.round(Number(p.valueMinor)); if (v != null && (!Number.isFinite(v) || v < 0)) throw fieldBad('A value is a number of zero or more.', 'value'); sets.push('value_minor = ?'); vals.push(v); }
    if ('nextDate' in p) { const v = String(p.nextDate || ''); if (v && !okDay(v)) throw fieldBad('That date does not exist. A date is year-month-day.', 'nextDate'); sets.push('next_date = ?'); vals.push(v || null); }
    if ('closeDate' in p) { const v = String(p.closeDate || ''); if (v && !okDay(v)) throw fieldBad('That close date does not exist. A date is year-month-day.', 'closeDate'); sets.push('close_date = ?'); vals.push(v || null); }
    if ('nextStep' in p) { sets.push('next_step = ?'); vals.push(this.take(p.nextStep, 'step', true) || null); }
    if ('notes' in p) { sets.push('notes = ?'); vals.push(this.take(p.notes, 'notes', true) || null); }
    if ('companyId' in p) { sets.push('company_id = ?'); vals.push(p.companyId && this.getCompany(p.companyId) ? p.companyId : null); }
    if ('contactId' in p) { sets.push('contact_id = ?'); vals.push(p.contactId && this.getContact(p.contactId) ? p.contactId : null); }
    if ('title' in p) { const v = this.take(p.title, 'title', true); if (!v) throw fieldBad('A deal needs a name.', 'title'); sets.push('title = ?'); vals.push(v); }
  }
  addDeal(p = {}) {
    const co = p.companyId ? this.getCompany(p.companyId) : null;
    const title = this.take(p.title, 'title', true) || co?.name || '';
    if (!title) throw fieldBad('A deal needs a name or a company.', 'title');
    const id = rid('dl_'); const t = now();
    this.db.transaction(() => {
      this.db.run('INSERT INTO m_sales_deals (id, title, stage, currency, created, updated) VALUES (?, ?, ?, ?, ?, ?)', id, title, 'new', clip(p.currency, 3).toUpperCase() || this.currency() || null, t, t);
      const sets = []; const vals = []; const { title: _t, ...rest } = p; this.dealFields({ ...rest, stage: p.stage || 'new' }, sets, vals);
      if (sets.length) this.db.run(`UPDATE m_sales_deals SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    });
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

  // ---- CSV in: the columns guessed and shown, a preview that saves nothing (the same work, rolled back), then saved in parts
  /**
   * { header, headings, columns, rows } of a file: CSV text, or the rows of cells a spreadsheet gave. A file with more
   * than IMPORT_ROWS rows is refused with both numbers: nothing is cut quietly.
   */
  readFile(file, columns = null) {
    const rows = Array.isArray(file) ? file.map(r => (Array.isArray(r) ? r : []).map(c => (c == null ? '' : String(c)))).filter(r => r.some(x => x.trim() !== '')) : parseCsv(file);
    if (!rows.length) throw bad('The file is empty.');
    const g = guessColumns(rows);
    const cols = columns ? checkMapping(columns, g.headings.length) : g.columns;
    const body = rows.slice(g.header ? 1 : 0);
    if (body.length > IMPORT_ROWS) { const n = (x) => { try { return x.toLocaleString(this.locale() || undefined); } catch { return x.toLocaleString(); } }; throw bad(`This file has ${n(body.length)} rows. One import takes at most ${n(IMPORT_ROWS)} rows. Split it into files of ${n(IMPORT_ROWS)} rows or fewer and import each one.`, { status: 413 }); }
    return { header: g.header, headings: g.headings, columns: cols, guessed: g.columns, body };
  }
  /** One file row through the merge rules. Returns what happens to it in words the page shows. */
  importRow(v, { from, at, track, into }) {
    const warn = []; const notes = v.notes ? [v.notes] : [];
    const keep = (field, word) => { notes.push(`${word} as given: ${v[field]}`); v[field] = ''; };
    if (v.email && !okMail(v.email)) { warn.push(`The mail address "${v.email}" does not look right: it is kept in the notes.`); keep('email', 'Mail address'); }
    if (v.phone && !okPhone(v.phone)) { warn.push(`"${v.phone}" does not look like a phone number: it is kept in the notes.`); keep('phone', 'Phone'); }
    if (v.site && !siteHost(v.site)) { warn.push(`"${v.site}" does not look like a site address: it is kept in the notes.`); keep('site', 'Site'); }
    for (const [f, w] of [['role', 'Role'], ['city', 'City'], ['phone', 'Phone']]) if (v[f].length > LIMITS[f]) { warn.push(`The ${w.toLowerCase()} is longer than ${LIMITS[f]} characters: it is kept in the notes.`); keep(f, w); }
    if (v.company.length > LIMITS.company) return { action: 'skip', why: `the company name is longer than ${LIMITS.company} characters` };
    if (v.name.length > LIMITS.name) return { action: 'skip', why: `the contact name is longer than ${LIMITS.name} characters` };
    const note = notes.join('\n').slice(0, LIMITS.notes);
    const person = !!(v.name || v.email);
    if (!v.company && !person) return { action: 'skip', why: v.phone || note ? 'no company, name or mail address to put it under' : 'nothing in this row' };
    if (!v.company && !v.email && !v.phone && !note && !v.city && !v.role) return { action: 'skip', why: 'only a name, nothing else to save' };
    let co = null; let near = null;
    if (v.company) {
      const bare = !person && !v.site && !v.phone && !note && !v.city;
      if (bare && !into && !this.matchCompany({ name: v.company, host: '' })) return { action: 'skip', why: 'only a company name, nothing else to save' };
      if (!into) { const m = this.matchCompany({ name: v.company, host: siteHost(v.site) }, { near: true }); if (m?.kind === 'near') near = { id: m.row.id, name: m.row.name }; }
      co = this.upsertCompany({ name: v.company, site: v.site, city: v.city, phone: person ? '' : v.phone, notes: person ? '' : note, customer: true }, { from, at, track, into });
    }
    let ct = null;
    if (person) ct = this.upsertContact({ name: v.name, email: v.email, phone: v.phone, role: v.role, city: co ? '' : v.city, notes: note, companyId: co?.id || null }, { from, at, track });
    const parts = [co, ct].filter(Boolean);
    const action = parts.some(p => p.isNew) ? 'new' : parts.some(p => p.filled.length) ? 'merge' : 'same';
    const kept = [];   // a merge keeps what the CRM has; a different value in the file is said, not dropped quietly
    if (co?.merged && v.company && nameKey(co.name) !== nameKey(v.company)) kept.push(`name ${co.name} (the file says ${v.company})`);
    if (ct?.merged) for (const [f, w] of [['name', 'name'], ['phone', 'phone'], ['role', 'role']]) if (v[f] && ct[f] && (f === 'phone' ? !samePhone(v[f], ct[f]) : nameKey(v[f]) !== nameKey(ct[f]))) kept.push(`${w} ${ct[f]} (the file says ${v[f]})`);
    if (kept.length) warn.push(`Kept what you have: ${kept.join('; ')}.`);
    return { action, with: (co?.merged ? co.name : '') || (action === 'new' ? '' : ct?.name || ct?.email || ''), warn, ...(near && co?.isNew ? { near } : {}), companyId: co?.id || null };
  }
  /**
   * Run the file's rows from start to end through the merge rules. save false: everything is done inside a transaction that
   * is rolled back, so the preview says exactly what Save will do. same: { line: companyId } rows the owner said are the
   * same company as a near-same name. Returns the columns and one line per row.
   */
  importRun(csv, { fileName, columns = null, save = false, start = 0, end = Infinity, importId = null, same = {} } = {}) {
    const f = this.readFile(csv, columns); const from = fileLabel(fileName); const at = now();
    const track = { made: [], filled: [] }; const rows = [];
    const first = f.header ? 2 : 1;   // the line number in the file, as a spreadsheet shows it
    const work = () => {
      for (let i = Math.max(0, start); i < Math.min(f.body.length, end); i++) {
        const v = rowValues(f.body[i], f.columns, f.headings); const line = i + first;
        const into = same[line] && this.getCompany(same[line]) ? same[line] : null;
        rows.push({ line, ...v, ...this.importRow({ ...v }, { from, at, track, into }) });
      }
    };
    if (save) this.db.transaction(work);
    else { this.quiet = true; try { this.db.transaction(() => { work(); throw ROLLBACK; }); } catch (e) { if (e !== ROLLBACK) throw e; } finally { this.quiet = false; } }
    let id = importId;
    if (save) {
      const cnt = (a) => rows.filter(r => r.action === a).length;
      const old = id && this.db.get('SELECT * FROM m_sales_imports WHERE id = ?', id);
      if (old) {
        const c = j(old.counts, {}); const add = { added: cnt('new'), merged: cnt('merge'), already: cnt('same'), skipped: cnt('skip') };
        this.db.run('UPDATE m_sales_imports SET counts = ?, made = ?, filled = ? WHERE id = ?', JSON.stringify(Object.fromEntries(Object.keys(add).map(k => [k, (c[k] || 0) + add[k]]))), JSON.stringify([...j(old.made, []), ...track.made]), JSON.stringify([...j(old.filled, []), ...track.filled]), id);
      } else {
        id = rid('im_');
        this.db.run('INSERT INTO m_sales_imports (id, file, at, counts, made, filled) VALUES (?, ?, ?, ?, ?, ?)', id, from, at, JSON.stringify({ added: cnt('new'), merged: cnt('merge'), already: cnt('same'), skipped: cnt('skip') }), JSON.stringify(track.made), JSON.stringify(track.filled));
      }
      this.emit({ change: 'crm' });
    }
    return { header: f.header, columns: f.headings.map((heading, i) => ({ heading, field: f.columns[i], guess: f.guessed[i], example: (f.body.find(r => String(r[i] ?? '').trim()) || [])[i] || '' })), total: f.body.length, rows, from, importId: save ? id : null };
  }
  imports() {
    return this.db.all('SELECT * FROM m_sales_imports ORDER BY at DESC').map(r => { const c = j(r.counts, {}); return { id: r.id, file: r.file, at: r.at, added: c.added || 0, merged: c.merged || 0, already: c.already || 0, skipped: c.skipped || 0, rows: j(r.made, []).length }; });
  }
  /**
   * Take one import back as a set. A row it added goes, unless something else also supports it: the owner changed it since
   * (edited, a note, a deal, or a contact of his under that company), or another import, a watched list, chat or the owner
   * has it too. Those stay and are counted; on one another source has, the fields only this file gave are taken back.
   * Fields it filled in on rows that were already there are taken back (or given another source's value).
   * While another import of a file with the same name is still there, that file still supports its rows: nothing it
   * marked is taken back until the last import of that name goes.
   */
  removeImport(id) {
    const imp = this.db.get('SELECT * FROM m_sales_imports WHERE id = ?', id); if (!imp) return null;
    const removed = { companies: 0, contacts: 0 }; const kept = { companies: 0, contacts: 0 }; const shared = { companies: 0, contacts: 0 }; let undone = 0;
    const sameFile = !!this.db.get('SELECT 1 AS x FROM m_sales_imports WHERE id != ? AND file = ?', id, imp.file);
    const changed = (r) => r && r.edited && r.edited > imp.at;
    const others = (r) => j(r.sources, []).filter(s => s.from !== imp.file);
    const key = (table) => (table === 'm_sales_companies' ? 'companies' : 'contacts');
    /** This file's mark taken off one row, and the fields only it gave taken back (or given another source's value). */
    const files = new Set(this.db.all('SELECT file FROM m_sales_imports WHERE id != ?', id).map(x => x.file));
    const unmark = (table, r, extra = []) => {
      const list = j(r.sources, []); const mine = list.find(s => s.from === imp.file); if (!mine) return 0;
      const rest = list.filter(s => s.from !== imp.file);
      // an import marks a company as a customer: that mark goes too, unless another import also gave it or the owner changed the row
      const customer = table === 'm_sales_companies' && r.customer && !changed(r) && !rest.some(s => files.has(s.from)) ? ['customer'] : [];
      const fields = [...(mine.filled || []).filter(f => f !== 'customer' && mine.gave?.[f] === r[f]), ...customer.filter(() => extra.includes('customer') || made.some(m => m.id === r.id))];
      const set = this.takeBack(table, r, mine, rest, fields); const cols = Object.keys(set);
      this.db.run(`UPDATE ${table} SET ${cols.map(c => c + ' = ?, ').join('')}sources = ?, updated = ? WHERE id = ?`, ...cols.map(c => set[c]), JSON.stringify(rest), now(), r.id);
      return fields.length;
    };
    const made = j(imp.made, []);
    this.db.transaction(() => {
      const one = (x) => { const table = x.t === 'co' ? 'm_sales_companies' : 'm_sales_contacts'; return { table, r: this.db.get(`SELECT * FROM ${table} WHERE id = ?`, x.id) }; };
      const owners = (table, r) => changed(r) || !!this.db.get(`SELECT 1 AS x FROM m_sales_deals WHERE ${table === 'm_sales_contacts' ? 'contact_id' : 'company_id'} = ?`, r.id);
      for (const x of [...made.filter(m => m.t === 'ct'), ...made.filter(m => m.t === 'co')]) {   // contacts first: a company left empty can go
        const { table, r } = one(x); if (!r) continue;
        if (sameFile) { shared[key(table)]++; continue; }
        if (owners(table, r)) { kept[key(table)]++; continue; }
        if (others(r).length) {
          shared[key(table)]++; undone += unmark(table, r);
          // an import that also had this row now holds it: taking that one back later removes it, if nothing else has it
          for (const o of this.db.all('SELECT id, made FROM m_sales_imports WHERE id != ?', id)) {
            const om = j(o.made, []); const f = this.db.get('SELECT file FROM m_sales_imports WHERE id = ?', o.id).file;
            if (others(r).some(s => s.from === f) && !om.some(m => m.t === x.t && m.id === x.id)) this.db.run('UPDATE m_sales_imports SET made = ? WHERE id = ?', JSON.stringify([...om, { t: x.t, id: x.id }]), o.id);
          }
          continue;
        }
        if (table === 'm_sales_companies' && this.db.get('SELECT 1 AS x FROM m_sales_contacts WHERE company_id = ?', r.id)) { kept[key(table)]++; continue; }   // a contact that stays keeps its company
        if (table === 'm_sales_contacts') this.removeContact(r.id); else this.removeCompany(r.id);
        removed[key(table)]++;
      }
      if (!sameFile) for (const x of j(imp.filled, [])) { const { table, r } = one(x); if (r) undone += unmark(table, r, x.fields || []); }
      this.db.run('DELETE FROM m_sales_imports WHERE id = ?', id);
    });
    this.emit({ change: 'crm' });
    return { file: imp.file, removed, kept, shared, undone };
  }

  // ---- CSV out: a byte-order mark first, so spreadsheet programs read every script right; every column
  exportCsv(what) {
    const day = (iso) => (iso ? todayIn(this.timeZone(), new Date(iso)) : '');
    const srcs = (l) => l.map(s => `${s.from} (${day(s.at)})${s.goneAt ? `, no longer on it since ${day(s.goneAt)}` : ''}`).join('; ');
    const cos = Object.fromEntries(this.companies().map(c => [c.id, c.name]));
    const BOM = '﻿';
    if (what === 'companies') return BOM + toCsv([['Name', 'Site', 'Phone', 'City', 'Customer', 'Notes', 'Sources', 'Not checked', 'Added'], ...this.companies().map(c => [c.name, c.site, c.phone, c.city, c.customer ? 'yes' : 'no', c.notes, srcs(c.sources), c.notChecked.join('; '), day(c.created)])]);
    if (what === 'contacts') return BOM + toCsv([['Name', 'Mail address', 'Phone', 'Role', 'Company', 'City', 'Notes', 'Sources', 'Not checked', 'Added'], ...this.contacts().map(c => [c.name, c.email, c.phone, c.role, cos[c.companyId] || '', c.city, c.notes, srcs(c.sources), c.notChecked.join('; '), day(c.created)])]);
    if (what === 'deals') return BOM + toCsv([['Title', 'Company', 'Contact', 'Stage', 'Value', 'Currency', 'Close date', 'Next step', 'Next date', 'Notes', 'Added'], ...this.deals().map(d => [d.title, d.companyName, d.contactName, d.stageLabel, d.value == null ? '' : d.value / 100, d.currency, d.closeDate, d.nextStep, d.nextDate, d.notes, day(d.created)])]);
    throw bad('Export contacts, companies or deals.');
  }
}
