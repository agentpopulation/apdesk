// The CRM as agent tools. The owner's customer records (contacts, companies, deals) live in this desk's own CRM, in
// Sales: reading tools answer from it only. Every tool that adds or changes a record first shows the owner the record as
// a person would say it (names, the company, the amount in his currency and number style, a day in his zone; never an
// id) through the approval door (action 'record.change', which always asks), saves exactly what he approved
// (assertGranted on the same payload), and returns what was really saved, so a reply can say only that. A no returns a
// refused result that says nothing was saved. A name that matches more than one record, or an add that matches one
// already there, is asked back ("which one?", "the same one?"), never guessed. Nothing here sends anything to anyone.
import { CHAT, okDay, monthOf, siteHost, samePhone } from './crm.js';

const flat = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const low = (v) => flat(v).toLowerCase();
/** Where every reading result says its records come from, so a reply's figure check knows they are the owner's own. */
export const FROM_CRM = "The owner's own records in this desk's CRM (Sales). Not from the web and not from a file.";
/** The door's action for an agent's change to a customer record: it asks at every level, inside an auto-approve window too. */
export const RECORD_CHANGE = 'record.change';
const WHERE = "The owner's customer records (contacts, companies, deals) live in this desk's own CRM, in Sales: not on the web and not in files.";

/** Digits after the point the currency has (yen 0, rupee 2); 2 when it is not known. */
export function fractionDigits(cur) { try { return cur ? new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits : 2; } catch { return 2; } }

export function crmTools(ctx, crm, { currency }) {
  const locale = () => ctx.settings.get('locale') || undefined;
  const zone = () => ctx.settings.get('timeZone') || undefined;
  /** Money in the owner's currency and number style; a part of one unit only for a currency that has one; nothing set reads "not set". */
  const money = (minor, cur = currency()) => {
    if (minor == null) return 'not set';
    const n = Number(minor) / 100; const d = fractionDigits(cur); const small = d > 0 && Math.abs(n) < 100 && n !== Math.round(n);
    try { return new Intl.NumberFormat(locale(), { ...(cur ? { style: 'currency', currency: cur } : {}), minimumFractionDigits: small ? d : 0, maximumFractionDigits: small ? d : 0 }).format(n); } catch { return String(n); }
  };
  const amount = (minor) => (minor == null ? null : Number(minor) / 100);
  const day = (d) => { if (!d) return 'not set'; try { return new Date(d + 'T00:00:00Z').toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
  const monthWords = (m) => { try { return new Date(m + '-01T00:00:00Z').toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch { return m; } };
  const fail = (error, extra = {}) => ({ ok: false, saved: false, error, text: error, ...extra });
  const card = (title, columns, rows) => ({ kind: 'table', title, columns, rows, actions: [{ label: 'Open Sales', go: '#/sales' }] });
  /** The agent as the screen names it (own name and role), for a note's source. */
  const agentLine = (id) => { try { const l = ctx.modules.api('agents')?.agentLine?.(id); if (l) return l; } catch {} return ctx.agents.get(id || '')?.name || 'An agent'; };

  // ---- finding records the way the owner names them: one match, several (asked back), or none
  const contactsBy = (q) => {
    const v = flat(q); if (!v) return [];
    const all = crm.contacts(); const id = all.filter(c => c.id === v); if (id.length) return id;
    const mail = all.filter(c => low(c.email) === low(v)); if (mail.length) return mail;
    return all.filter(c => low(c.name) === low(v));
  };
  const companiesBy = (q) => {
    const v = flat(q); if (!v) return [];
    const all = crm.companies(); const host = siteHost(v); const id = all.filter(c => c.id === v); if (id.length) return id;
    const named = all.filter(c => low(c.name) === low(v)); if (named.length) return named;
    return host ? all.filter(c => c.host === host) : [];
  };
  const dealsBy = (q) => { const v = flat(q); if (!v) return []; const all = crm.deals(); const id = all.filter(d => d.id === v); return id.length ? id : all.filter(d => low(d.title) === low(v)); };
  const stageBy = (q) => { const v = low(q); if (!v) return null; return crm.stages().find(s => s.id === v || low(s.label) === v) || null; };
  const coName = (id) => (id ? crm.getCompany(id)?.name || '' : '');
  const said = {
    contact: (c) => [c.name || c.email, [coName(c.companyId), c.name && c.email, c.phone].filter(Boolean).join(', ')].filter(Boolean).join(': '),
    company: (c) => [c.name, [c.site, c.city].filter(Boolean).join(', ')].filter(Boolean).join(': '),
    deal: (d) => `${d.title}: ${[d.companyName, d.contactName, money(d.value, d.currency), d.stageLabel, d.closeDate && `closes ${day(d.closeDate)}`].filter(Boolean).join(', ')}`,
  };
  /** Several records answer to one name: the tool asks back which one, with each told apart, and saves nothing. */
  const which = (kind, name, list, arg) => fail(`${list.length} ${kind === 'company' ? 'companies' : kind + 's'} in the CRM are called ${name}: ${list.map(said[kind]).join('; ')}. Nothing was saved. Ask the owner which one he means, then call again with ${arg} set to the id of that one (from choices).`,
    { ask: 'which', choices: list.map(x => ({ id: x.id, is: said[kind](x) })) });

  /** Ask the owner with the record in plain words (show); on yes, check the grant against the same words and run save(). */
  async function asked(call, title, show, save, detail = '') {
    const payload = Object.fromEntries(Object.entries(show).filter(([, v]) => v != null && v !== ''));
    const d = await ctx.approval.request({ agentId: call.agentId || 'closer', chatId: call.chatId, jobId: call.jobId || undefined, action: RECORD_CHANGE, title, detail: detail || undefined, payload, signal: call.signal });
    if (!d.ok) {
      const why = d.reason === 'denied' ? 'The owner said no' : d.reason === 'halted' ? 'Stopped by Panic' : 'The owner did not approve it in time';
      return fail(`${why}. Nothing was saved in the CRM: do not say it was added or changed.`, { refused: true, decision: d.reason === 'denied' ? 'no' : d.reason === 'halted' ? 'stopped' : 'not answered', notDone: title });
    }
    // a door that does not know the name yet files it as 'custom' (which also always asks): check the grant as it was filed
    const filed = (() => { try { return ctx.approval.get?.(d.id)?.action; } catch { return null; } })() || RECORD_CHANGE;
    try { ctx.approval.assertGranted(d.id, filed, payload); } catch { return fail('The approval did not match the record. Nothing was saved in the CRM.', { refused: true }); }
    try { return await save(); } catch (e) { if (e.status) return fail(`Not saved: ${e.message}`); throw e; }
  }

  // ---------------- reading
  ctx.tool({
    name: 'crm_find',
    description: `${WHERE} Read them with this tool: contacts, companies and deals, by words to search for, a deal stage, or deals closing in a month ("this month", "next month" or YYYY-MM, in the owner's time zone). Answers from the CRM only; nothing is read from the web. Amounts are the owner's own records.`,
    parameters: { type: 'object', properties: {
      what: { type: 'string', enum: ['contacts', 'companies', 'deals'] },
      query: { type: 'string', description: 'Words to find in names, mail addresses, phones, companies or deal names. Leave out to list all.' },
      stage: { type: 'string', description: 'Deals only: a stage name, or "open" for every deal not won or lost' },
      closing: { type: 'string', description: 'Deals only: the month they close, "this month", "next month" or YYYY-MM' },
      limit: { type: 'integer', description: 'At most this many rows (default 50)' } }, required: ['what'] },
    async run(args) {
      const what = ['contacts', 'companies', 'deals'].includes(args?.what) ? args.what : 'deals';
      const limit = Math.max(1, Math.min(200, Number(args?.limit) || 50)); const q = low(args?.query);
      const base = { ok: true, what, records: true, source: FROM_CRM, note: FROM_CRM };
      if (what === 'deals') {
        if (args?.stage && low(args.stage) !== 'open' && !stageBy(args.stage)) return fail(`There is no stage called ${args.stage}. The stages are: ${crm.stages().map(s => s.label).join(', ')}.`);
        const month = args?.closing ? monthOf(args.closing, zone()) : '';
        if (args?.closing && !month) return fail('Say the month as this month, next month or year-month, like 2026-11.');
        const ds = crm.dealsWhere({ stage: args?.stage ? (stageBy(args.stage)?.id || 'open') : '', closing: month, query: args?.query });
        const scope = [month && `closing in ${monthWords(month)}`, args?.stage && `at ${stageBy(args.stage)?.label || 'an open stage'}`, q && `matching "${flat(args.query)}"`].filter(Boolean).join(', ');
        const rows = ds.slice(0, limit).map(d => ({ id: d.id, title: d.title, company: d.companyName || 'not set', contact: d.contactName || 'not set', stage: d.stageLabel, value: money(d.value, d.currency), amount: amount(d.value), currency: d.currency || null, closeDate: day(d.closeDate), nextStep: d.nextStep || 'not set' }));
        const text = ds.length ? `${ds.length} deal${ds.length === 1 ? '' : 's'} in the CRM${scope ? ' ' + scope : ''}: ${rows.map(r => `${r.title} (${r.company}, ${r.value}, closes ${r.closeDate}, ${r.stage})`).join('; ')}.` : `No deal in the CRM${scope ? ' ' + scope : ''}. The CRM has ${crm.deals().length} deal${crm.deals().length === 1 ? '' : 's'} in all.`;
        return { ...base, count: ds.length, deals: rows, more: ds.length > limit, text, cards: ds.length ? [card(`Deals${scope ? ' ' + scope : ''}`, ['Deal', 'Company', 'Contact', 'Stage', 'Value', 'Closes'], rows.map(r => [r.title, r.company, r.contact, r.stage, r.value, r.closeDate]))] : [] };
      }
      if (what === 'contacts') {
        const cos = Object.fromEntries(crm.companies().map(c => [c.id, c.name]));
        const cs = crm.contacts().filter(c => !q || [c.name, c.email, c.role, cos[c.companyId], c.city].some(x => low(x).includes(q)) || samePhone(c.phone, args?.query));
        const rows = cs.slice(0, limit).map(c => ({ id: c.id, name: c.name || 'not set', email: c.email || 'not set', phone: c.phone || 'not set', role: c.role || 'not set', company: cos[c.companyId] || 'not set' }));
        return { ...base, count: cs.length, contacts: rows, more: cs.length > limit, text: cs.length ? `${cs.length} contact${cs.length === 1 ? '' : 's'}${q ? ` matching "${flat(args.query)}"` : ''}: ${rows.slice(0, 20).map(r => `${r.name} (${r.company}, ${r.email}, ${r.phone})`).join('; ')}.` : `No contact in the CRM${q ? ` matches "${flat(args.query)}"` : ' yet'}.` };
      }
      const all = crm.companies(); const n = (id) => crm.contacts().filter(c => c.companyId === id).length;
      const cs = all.filter(c => !q || [c.name, c.host, c.city].some(x => low(x).includes(q)));
      const rows = cs.slice(0, limit).map(c => ({ id: c.id, name: c.name, site: c.site || 'not set', city: c.city || 'not set', customer: c.customer, contacts: n(c.id) }));
      return { ...base, count: cs.length, companies: rows, more: cs.length > limit, text: cs.length ? `${cs.length} compan${cs.length === 1 ? 'y' : 'ies'}${q ? ` matching "${flat(args.query)}"` : ''}: ${rows.slice(0, 20).map(r => r.name).join(', ')}.` : `No company in the CRM${q ? ` matches "${flat(args.query)}"` : ' yet'}.` };
    },
  });

  // ---------------- contacts
  ctx.tool({
    name: 'crm_contact_save',
    description: `${WHERE} Add a contact (a person) to that CRM, or change one that is there: this is how "add to my CRM" is done, not with a file. The owner approves the exact record first; the result says what was saved. Give the company by name: a company not in the CRM is added with the contact.`,
    parameters: { type: 'object', properties: {
      contact: { type: 'string', description: 'To change a contact that is already there: its name or mail address (or its id from an earlier answer). Leave out to add one.' },
      name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, role: { type: 'string' }, city: { type: 'string' },
      company: { type: 'string', description: 'The company name' }, notes: { type: 'string' },
      separate: { type: 'boolean', description: 'Only when the owner said a contact with the same name is a different person: add a second one' } } },
    async run(args, call) {
      const fields = {}; for (const k of ['name', 'email', 'phone', 'role', 'city', 'notes']) if (typeof args?.[k] === 'string' && args[k].trim()) fields[k] = args[k].trim();
      let target = null;
      if (args?.contact) { const m = contactsBy(args.contact); if (!m.length) return fail(`There is no contact called ${args.contact} in the CRM. Leave out "contact" to add a new one.`); if (m.length > 1) return which('contact', flat(args.contact), m, 'contact'); target = m[0]; }
      if (!target && fields.email) target = contactsBy(fields.email).find(c => low(c.email) === low(fields.email)) || null;   // the same mail address is the same person: a change, not a second contact
      if (!target && !fields.name && !fields.email) return fail('A contact needs a name or a mail address.');
      if (!target && fields.name && !args?.separate) {
        const same = contactsBy(fields.name).filter(c => low(c.name) === low(fields.name));
        if (same.length) return fail(`The CRM already has ${same.length === 1 ? 'a contact' : same.length + ' contacts'} called ${fields.name}: ${same.map(said.contact).join('; ')}. Nothing was saved. Ask the owner: is it the same one? If yes, call again with contact set to that one's id (from choices) to change it. If it is a different person, call again with separate: true.`, { ask: 'same', choices: same.map(c => ({ id: c.id, is: said.contact(c) })) });
      }
      let co = null; let newCompany = '';
      if (flat(args?.company)) { const m = companiesBy(args.company); if (m.length > 1) return which('company', flat(args.company), m, 'company'); co = m[0] || null; if (!co) newCompany = flat(args.company); }
      try { crm.checkContact({ ...(target || {}), ...fields }, true); if (newCompany) crm.checkCompany({ name: newCompany }, true); } catch (e) { return fail(`Not saved: ${e.message}`); }
      const samePerson = !target && fields.phone && crm.contacts().find(c => samePhone(c.phone, fields.phone));
      const who = fields.name || target?.name || fields.email || target?.email;
      const title = target ? `Change the contact ${target.name || target.email} in your CRM` : `Add the contact ${who} to your CRM`;
      const show = { ...(target ? { Contact: said.contact(target) } : {}), Name: fields.name, 'Mail address': fields.email, Phone: fields.phone, Role: fields.role, City: fields.city,
        Company: co ? co.name : newCompany ? `${newCompany} (new company)` : '', Notes: fields.notes };
      const detail = samePerson ? `${samePerson.name || samePerson.email} already has this phone number; this adds a separate contact.` : '';
      return asked(call, title, show, () => {
        if (target && !crm.getContact(target.id)) return fail('That contact was removed meanwhile. Nothing was saved in the CRM.');
        const companyId = newCompany ? crm.upsertCompany({ name: newCompany }, { from: CHAT }).id : co?.id || undefined;
        const saved = target ? crm.updateContact(target.id, { ...fields, ...(companyId ? { companyId } : {}) }, { by: CHAT }) : crm.upsertContact({ ...fields, companyId, separate: true }, { from: CHAT });
        const cName = saved.companyId ? crm.getCompany(saved.companyId)?.name : '';
        const text = `Saved in the CRM: ${target ? 'changed' : 'added'} the contact ${saved.name || saved.email}${[saved.email && saved.name ? saved.email : '', saved.phone, saved.role, cName && `${cName}${newCompany ? ' (new company)' : ''}`].filter(Boolean).map(x => ', ' + x).join('')}.`;
        return { ok: true, saved: { kind: 'contact', id: saved.id, name: saved.name, email: saved.email, phone: saved.phone, role: saved.role, city: saved.city, company: cName || null }, text,
          cards: [card('Saved in the CRM', ['Name', 'Mail address', 'Phone', 'Role', 'Company'], [[saved.name || 'not set', saved.email || 'not set', saved.phone || 'not set', saved.role || 'not set', cName || 'not set']])] };
      }, detail);
    },
  });

  // ---------------- companies
  ctx.tool({
    name: 'crm_company_save',
    description: `${WHERE} Add a company to that CRM, or change one that is there. The owner approves the exact record first; the result says what was saved.`,
    parameters: { type: 'object', properties: {
      company: { type: 'string', description: 'To change a company that is already there: its name (or its id from an earlier answer). Leave out to add one.' },
      name: { type: 'string' }, site: { type: 'string' }, phone: { type: 'string' }, city: { type: 'string' }, notes: { type: 'string' }, customer: { type: 'boolean', description: 'Mark it as a customer' } } },
    async run(args, call) {
      const fields = {}; for (const k of ['name', 'site', 'phone', 'city', 'notes']) if (typeof args?.[k] === 'string' && args[k].trim()) fields[k] = args[k].trim();
      if (typeof args?.customer === 'boolean') fields.customer = args.customer;
      let target = null;
      if (args?.company) { const m = companiesBy(args.company); if (!m.length) return fail(`There is no company called ${args.company} in the CRM. Leave out "company" to add a new one.`); if (m.length > 1) return which('company', flat(args.company), m, 'company'); target = m[0]; }
      if (!target && fields.name) { const m = companiesBy(fields.name); if (m.length > 1) return which('company', fields.name, m, 'company'); target = m[0] || (fields.site && companiesBy(fields.site)[0]) || null; }
      if (!target && !fields.name) return fail('A company needs a name.');
      try { crm.checkCompany({ ...(target || {}), ...fields }, true); } catch (e) { return fail(`Not saved: ${e.message}`); }
      if (fields.site && siteHost(fields.site)) { const o = crm.companies().find(c => c.host === siteHost(fields.site) && c.id !== target?.id); if (o) return fail(`Not saved: ${o.name} already has that site.`); }
      const title = target ? `Change the company ${target.name} in your CRM` : `Add the company ${fields.name} to your CRM`;
      const show = { ...(target ? { Company: said.company(target) } : {}), Name: fields.name, Site: fields.site, Phone: fields.phone, City: fields.city, Customer: 'customer' in fields ? (fields.customer ? 'yes' : 'no') : '', Notes: fields.notes };
      return asked(call, title, show, () => {
        if (target && !crm.getCompany(target.id)) return fail('That company was removed meanwhile. Nothing was saved in the CRM.');
        const saved = target ? crm.updateCompany(target.id, fields, { by: CHAT }) : crm.upsertCompany({ ...fields, separate: true }, { from: CHAT });
        return { ok: true, saved: { kind: 'company', id: saved.id, name: saved.name, site: saved.site, phone: saved.phone, city: saved.city, customer: saved.customer },
          text: `Saved in the CRM: ${target ? 'changed' : 'added'} the company ${saved.name}${[saved.site, saved.phone, saved.city, saved.customer ? 'a customer' : ''].filter(Boolean).map(x => ', ' + x).join('')}.`,
          cards: [card('Saved in the CRM', ['Company', 'Site', 'Phone', 'City', 'Customer'], [[saved.name, saved.site || 'not set', saved.phone || 'not set', saved.city || 'not set', saved.customer ? 'yes' : 'no']])] };
      });
    },
  });

  // ---------------- deals
  ctx.tool({
    name: 'crm_deal_save',
    description: `${WHERE} Add a deal to that CRM, or change one that is there (stage, value, close date, next step). The owner approves the exact deal first; the result says what was saved. value is in whole units of the owner's currency. Dates are YYYY-MM-DD. Link it to a contact (name or mail address) and a company that are in the CRM.`,
    parameters: { type: 'object', properties: {
      deal: { type: 'string', description: 'To change a deal that is already there: its name (or its id from an earlier answer). Leave out to add one.' },
      title: { type: 'string', description: 'The deal name' }, value: { type: 'number' }, closeDate: { type: 'string', description: 'When it is expected to close, YYYY-MM-DD' },
      stage: { type: 'string' }, contact: { type: 'string', description: 'Name or mail address of a contact in the CRM' }, company: { type: 'string', description: 'Company name' },
      nextStep: { type: 'string' }, nextDate: { type: 'string', description: 'YYYY-MM-DD' }, notes: { type: 'string' },
      separate: { type: 'boolean', description: 'Only when the owner said a deal with the same name is a different deal: add a second one' } } },
    async run(args, call) {
      let target = null;
      if (args?.deal) { const m = dealsBy(args.deal); if (!m.length) return fail(`There is no deal called ${args.deal} in the CRM. Leave out "deal" to add a new one.`); if (m.length > 1) return which('deal', flat(args.deal), m, 'deal'); target = m[0]; }
      const p = {};
      if (flat(args?.title)) p.title = flat(args.title);
      if (!target && p.title && !args?.separate) {
        const same = dealsBy(p.title);
        if (same.length) return fail(`The CRM already has ${same.length === 1 ? 'a deal' : same.length + ' deals'} called ${p.title}: ${same.map(said.deal).join('; ')}. Nothing was saved. Ask the owner: is it the same one? If yes, call again with deal set to that one's id (from choices) to change it. If he wants a second deal with that name, call again with separate: true.`, { ask: 'same', choices: same.map(d => ({ id: d.id, is: said.deal(d) })) });
      }
      if (args?.value != null && args.value !== '') {
        const v = Number(args.value); if (!Number.isFinite(v) || v < 0) return fail('The value is a number of zero or more, in whole units of the owner\'s currency.');
        const fd = fractionDigits(currency()); const scaled = v * 10 ** fd;
        if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return fail(fd === 0 ? `Amounts in ${currency()} have no smaller unit: give a whole number.` : `Give the value with at most ${fd} digits after the point.`);
        p.valueMinor = Math.round(v * 100);
      }
      for (const k of ['closeDate', 'nextDate']) if (flat(args?.[k])) { if (!okDay(flat(args[k]))) return fail(`${k === 'closeDate' ? 'The close date' : 'The next step date'} must be a real day written YYYY-MM-DD, like 2026-11-28.`); p[k] = flat(args[k]); }
      if (flat(args?.stage)) { const s = stageBy(args.stage); if (!s) return fail(`There is no stage called ${args.stage}. The stages are: ${crm.stages().map(x => x.label).join(', ')}.`); p.stage = s.id; }
      if (flat(args?.nextStep)) p.nextStep = flat(args.nextStep);
      if (typeof args?.notes === 'string' && args.notes.trim()) p.notes = args.notes.trim();
      let ct = null;
      if (flat(args?.contact)) { const m = contactsBy(args.contact); if (!m.length) return fail(`There is no contact called ${args.contact} in the CRM. Add the contact first with crm_contact_save, then the deal.`); if (m.length > 1) return which('contact', flat(args.contact), m, 'contact'); ct = m[0]; p.contactId = ct.id; }
      let co = null; let newCompany = '';
      if (flat(args?.company)) { const m = companiesBy(args.company); if (m.length > 1) return which('company', flat(args.company), m, 'company'); co = m[0] || null; if (!co) newCompany = flat(args.company); }
      else if (ct?.companyId) co = crm.getCompany(ct.companyId);
      if (co) p.companyId = co.id;
      if (!target && !p.title && !co && !newCompany) return fail('A deal needs a name or a company.');
      if (!Object.keys(p).length && !newCompany) return fail('Nothing to change.');
      const stage = crm.stages().find(s => s.id === (p.stage || target?.stage || 'new'));
      const title = target ? `Change the deal ${target.title} in your CRM` : `Add the deal ${p.title || co?.name || newCompany} to your CRM`;
      const show = { ...(target ? { 'The deal': said.deal(target) } : {}), Deal: p.title, Value: 'valueMinor' in p ? money(p.valueMinor) : '', Closes: p.closeDate ? day(p.closeDate) : '', Stage: p.stage || !target ? stage?.label : '',
        Contact: ct ? ct.name || ct.email : '', Company: co ? co.name : newCompany ? `${newCompany} (new company)` : '', 'Next step': p.nextStep, 'Next step date': p.nextDate ? day(p.nextDate) : '', Notes: p.notes };
      return asked(call, title, show, () => {
        if (target && !crm.getDeal(target.id)) return fail('That deal was removed meanwhile. Nothing was saved in the CRM.');
        const fields = { ...p }; if (newCompany) fields.companyId = crm.upsertCompany({ name: newCompany }, { from: CHAT }).id;
        const d = target ? crm.updateDeal(target.id, fields) : crm.addDeal(fields);
        const row = { title: d.title, value: money(d.value, d.currency), closeDate: day(d.closeDate), stage: d.stageLabel, contact: d.contactName || 'not set', company: d.companyName || 'not set' };
        return { ok: true, records: true, source: FROM_CRM, saved: { kind: 'deal', id: d.id, ...row, amount: amount(d.value), currency: d.currency || null }, text: `Saved in the CRM: ${target ? 'changed' : 'added'} the deal ${d.title} (${row.value}, closes ${row.closeDate}, ${row.stage}, contact ${row.contact}, company ${row.company}).`,
          cards: [card('Saved in the CRM', ['Deal', 'Value', 'Closes', 'Stage', 'Contact', 'Company'], [[row.title, row.value, row.closeDate, row.stage, row.contact, row.company]])] };
      });
    },
  });

  // ---------------- notes
  ctx.tool({
    name: 'crm_note_add',
    description: `${WHERE} Add a dated note to a contact or a company in that CRM. The owner approves the note first.`,
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['contact', 'company'] }, to: { type: 'string', description: 'The contact\'s name or mail address, or the company name (or its id from an earlier answer)' }, text: { type: 'string' } }, required: ['kind', 'to', 'text'] },
    async run(args, call) {
      const kind = args?.kind === 'company' ? 'company' : 'contact';
      const m = kind === 'company' ? companiesBy(args?.to) : contactsBy(args?.to);
      if (!m.length) return fail(`There is no ${kind} called ${args?.to || 'that'} in the CRM.`);
      if (m.length > 1) return which(kind, flat(args.to), m, 'to');
      const rec = m[0];
      const text = String(args?.text || '').trim(); if (!text) return fail('Write the note first.');
      if (text.length > 4000) return fail('A note can be at most 4000 characters.');
      const name = rec.name || rec.email; const from = `${agentLine(call.agentId)} in chat`;
      return asked(call, `Add a note to ${name} in your CRM`, { [kind === 'company' ? 'Company' : 'Contact']: said[kind](rec), Note: text }, () => {
        if (!(kind === 'company' ? crm.getCompany(rec.id) : crm.getContact(rec.id))) return fail(`That ${kind} was removed meanwhile. Nothing was saved in the CRM.`);
        const n = crm.addNote(kind, rec.id, text, from);
        return { ok: true, saved: { kind: 'note', on: name, text: n.text }, text: `Saved in the CRM: a note on ${name}.` };
      });
    },
  });
}
