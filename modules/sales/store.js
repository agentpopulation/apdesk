// Sales data: leads, outreach drafts, activity. One SQLite file through ctx.db; tables m_sales_*.
export const CHANNELS = ['email', 'linkedin', 'whatsapp', 'text'];
export const STAGES = [
  { id: 'new', label: 'New' }, { id: 'researched', label: 'Researched' }, { id: 'drafted', label: 'Drafted' }, { id: 'talks', label: 'In talks' },
];
export const stageLabel = (id) => STAGES.find(s => s.id === id)?.label || 'New';
export function stageId(x) {
  const s = String(x || '').toLowerCase().trim();
  const hit = STAGES.find(t => t.id === s || t.label.toLowerCase() === s) || (/talk|negot|reply|call/.test(s) ? STAGES[3] : /draft/.test(s) ? STAGES[2] : /research/.test(s) ? STAGES[1] : /new/.test(s) ? STAGES[0] : null);
  return hit?.id || null;
}
const now = () => new Date().toISOString();
const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const j = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
import { wordClip } from './parse.js';
import { sameNameKey } from './rules.js';
const clip = (v, n) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n));

export function migrate(db) {
  db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_sales_leads (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, contact_name TEXT, contact_role TEXT, email TEXT, contact_other TEXT,
      website TEXT, value_minor INTEGER, currency TEXT, need TEXT, stage TEXT NOT NULL DEFAULT 'new', next_step TEXT,
      findings TEXT, sources TEXT, notes TEXT, query TEXT, found_by TEXT, created TEXT, updated TEXT);
    CREATE TABLE IF NOT EXISTS m_sales_drafts (
      id TEXT PRIMARY KEY, lead_id TEXT, to_addr TEXT, subject TEXT, body TEXT, status TEXT NOT NULL DEFAULT 'waiting',
      note TEXT, approval_id TEXT, model_label TEXT, agent_id TEXT, chat_id TEXT, created TEXT, updated TEXT, sent_at TEXT);
    CREATE TABLE IF NOT EXISTS m_sales_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, lead_id TEXT, who TEXT, text TEXT);
    CREATE INDEX IF NOT EXISTS m_sales_drafts_lead ON m_sales_drafts (lead_id);
  `);  db.migrate(2, `ALTER TABLE m_sales_drafts ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'`);
  // what no page read said about a found lead, as plain labels ("Country: not checked"); empty for a checked lead
  db.migrate(3, `ALTER TABLE m_sales_leads ADD COLUMN unchecked TEXT`);
}

export class SalesStore {
  constructor(db, { currency = () => null, emit = () => {} } = {}) { this.db = db; this.currency = currency; this.emit = emit; migrate(db); }
  leadOut(r) {
    if (!r) return null;
    return { id: r.id, company: r.company, contactName: r.contact_name || '', contactRole: r.contact_role || '', email: r.email || '', contactOther: r.contact_other || '', website: r.website || '',
      value: r.value_minor == null ? null : Number(r.value_minor), currency: r.currency || this.currency(), need: r.need || '', stage: r.stage || 'new', stageLabel: stageLabel(r.stage),
      nextStep: r.next_step || '', findings: r.findings || '', sources: j(r.sources, []), notes: r.notes || '', query: r.query || '', foundBy: r.found_by || '', unchecked: j(r.unchecked, []), created: r.created, updated: r.updated };
  }
  draftOut(r) {
    if (!r) return null;
    return { id: r.id, leadId: r.lead_id, to: r.to_addr || '', channel: r.channel || 'email', subject: r.subject || '', body: r.body || '', status: r.status, note: r.note || '', approvalId: r.approval_id || null, label: r.model_label || '', agentId: r.agent_id || '', chatId: r.chat_id || null, created: r.created, updated: r.updated, sentAt: r.sent_at || null };
  }
  listLeads({ stage } = {}) {
    const rows = stage ? this.db.all('SELECT * FROM m_sales_leads WHERE stage = ? ORDER BY created', stage) : this.db.all('SELECT * FROM m_sales_leads ORDER BY created');
    return rows.map(r => this.leadOut(r));
  }
  getLead(id) { return this.leadOut(this.db.get('SELECT * FROM m_sales_leads WHERE id = ?', id)); }
  findByName(company) { return this.listLeads().find(l => sameNameKey(l.company, company)) || null; }   // the search's sameCompany uses the same key
  addLead(lead, { who = 'You' } = {}) {
    const company = clip(lead?.company, 160);
    if (!company) throw Object.assign(new Error('A lead needs a company name.'), { status: 400 });
    const dup = this.findByName(company);
    if (dup) return { ...dup, duplicate: true };
    const id = rid('ld_'); const t = now();
    const sources = (Array.isArray(lead.sources) ? lead.sources : []).filter(s => /^https?:\/\//i.test(s?.url || '')).map(s => ({ title: clip(s.title || s.url, 200), url: String(s.url).slice(0, 1000) })).slice(0, 12);
    const value = lead.value == null || lead.value === '' ? null : Math.round(Number(lead.value));
    this.db.run(`INSERT INTO m_sales_leads (id, company, contact_name, contact_role, email, contact_other, website, value_minor, currency, need, stage, next_step, findings, sources, notes, query, found_by, unchecked, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, company, clip(lead.contactName, 120) || null, clip(lead.contactRole, 120) || null, clip(lead.email, 200) || null, wordClip(lead.contactOther, 1000) || null,
      clip(lead.website, 300) || null, Number.isFinite(value) ? value : null, lead.currency || this.currency(), clip(lead.need, 400) || null, stageId(lead.stage) || 'new', clip(lead.nextStep, 300) || null,
      String(lead.findings || '').slice(0, 4000) || null, JSON.stringify(sources), String(lead.notes || '').slice(0, 4000) || null, clip(lead.query, 300) || null, clip(lead.foundBy, 60) || null, JSON.stringify((Array.isArray(lead.unchecked) ? lead.unchecked : []).map(x => clip(x, 60)).filter(Boolean).slice(0, 4)), t, t);
    this.log(id, who, sources.length ? `Lead found · ${sources.length} source${sources.length > 1 ? 's' : ''}` : 'Lead added');
    this.emit({ change: 'lead', id });
    return this.getLead(id);
  }
  updateLead(id, patch = {}, { who = 'You' } = {}) {
    const cur = this.getLead(id); if (!cur) return null;
    const map = { company: 'company', contactName: 'contact_name', contactRole: 'contact_role', email: 'email', contactOther: 'contact_other', website: 'website', need: 'need', nextStep: 'next_step', findings: 'findings', notes: 'notes', currency: 'currency' };
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) if (k in patch) { sets.push(`${col} = ?`); vals.push(patch[k] == null ? null : k === 'contactOther' ? wordClip(patch[k], 1000) : String(patch[k]).slice(0, 4000)); }
    if ('value' in patch) { const v = patch.value == null || patch.value === '' ? null : Math.round(Number(patch.value)); sets.push('value_minor = ?'); vals.push(Number.isFinite(v) ? v : null); }
    if ('sources' in patch && Array.isArray(patch.sources)) { sets.push('sources = ?'); vals.push(JSON.stringify(patch.sources.filter(s => /^https?:\/\//i.test(s?.url || '')).slice(0, 12))); }
    if (!sets.length) return cur;
    sets.push('updated = ?'); vals.push(now());
    this.db.run(`UPDATE m_sales_leads SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.log(id, who, 'Lead edited');
    this.emit({ change: 'lead', id });
    return this.getLead(id);
  }
  moveLead(id, stage, { who = 'You' } = {}) {
    const s = stageId(stage);
    if (!s) throw Object.assign(new Error('Stages are New, Researched, Drafted and In talks.'), { status: 400 });
    const cur = this.getLead(id); if (!cur) return null;
    if (cur.stage === s) return cur;
    this.db.run('UPDATE m_sales_leads SET stage = ?, updated = ? WHERE id = ?', s, now(), id);
    this.log(id, who, `Moved from ${stageLabel(cur.stage)} to ${stageLabel(s)}`);
    this.emit({ change: 'lead', id });
    return this.getLead(id);
  }
  removeLead(id) { this.db.run('DELETE FROM m_sales_leads WHERE id = ?', id); this.db.run('DELETE FROM m_sales_drafts WHERE lead_id = ?', id); this.emit({ change: 'lead', id }); }
  log(leadId, who, text) { this.db.run('INSERT INTO m_sales_activity (at, lead_id, who, text) VALUES (?, ?, ?, ?)', now(), leadId, who, text); }
  activity(leadId, limit = 30) { return this.db.all('SELECT at, who, text FROM m_sales_activity WHERE lead_id = ? ORDER BY id DESC LIMIT ?', leadId, limit); }

  addDraft(d) {
    const id = rid('dr_'); const t = now();
    const channel = CHANNELS.includes(d.channel) ? d.channel : 'email';
    this.db.run('INSERT INTO m_sales_drafts (id, lead_id, to_addr, subject, body, status, note, approval_id, model_label, agent_id, chat_id, created, updated, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, d.leadId, channel === 'email' ? d.to || null : null, channel === 'email' ? clip(d.subject, 200) : '', String(d.body || '').slice(0, 8000), channel === 'email' ? 'waiting' : 'copy', d.note || null, null, d.label || null, d.agentId || null, d.chatId || null, t, t, channel);
    this.emit({ change: 'draft', id });
    return this.getDraft(id);
  }
  /** The one open draft a lead may have per channel (not sent, not refused). */
  openDraft(leadId, channel = 'email') { return this.drafts({ leadId }).find(d => d.channel === channel && ['waiting', 'approved', 'copy'].includes(d.status)) || null; }
  getDraft(id) { return this.draftOut(this.db.get('SELECT * FROM m_sales_drafts WHERE id = ?', id)); }
  drafts({ leadId, status } = {}) {
    let sql = 'SELECT * FROM m_sales_drafts'; const w = []; const v = [];
    if (leadId) { w.push('lead_id = ?'); v.push(leadId); }
    if (status) { w.push('status = ?'); v.push(status); }
    if (w.length) sql += ' WHERE ' + w.join(' AND ');
    return this.db.all(sql + ' ORDER BY created DESC', ...v).map(r => this.draftOut(r));
  }
  updateDraft(id, patch) {
    const map = { to: 'to_addr', subject: 'subject', body: 'body', status: 'status', note: 'note', approvalId: 'approval_id', sentAt: 'sent_at' };
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(map)) if (k in patch) { sets.push(`${col} = ?`); vals.push(patch[k] ?? null); }
    if (!sets.length) return this.getDraft(id);
    sets.push('updated = ?'); vals.push(now());
    this.db.run(`UPDATE m_sales_drafts SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.emit({ change: 'draft', id });
    return this.getDraft(id);
  }
  totals() {
    const leads = this.listLeads();
    const cur = this.currency();
    return { leads: leads.length, pipelineMinor: leads.filter(l => (l.currency || cur) === cur).reduce((a, l) => a + (l.value || 0), 0), currency: cur,
      valued: leads.filter(l => l.value != null).length, draftsWaiting: this.db.get("SELECT COUNT(*) AS c FROM m_sales_drafts WHERE status = 'waiting'").c, inTalks: leads.filter(l => l.stage === 'talks').length,
      byStage: Object.fromEntries(STAGES.map(s => [s.id, leads.filter(l => l.stage === s.id).length])) };
  }
}
