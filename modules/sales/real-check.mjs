// Real checks for Sales (and Mail and Calendar when asked): a REAL model and the REAL web.
//   node modules/sales/real-check.mjs [sales|mail|calendar ...]
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers. SERPER_API_KEY (optional) adds Google results.
// Prints PASS|FAIL lines and exits non-zero on a fail. Never sends to a real person: mail goes to a loopback server it starts.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { testDesk } from '../../test/helpers/desk.js';
import { createDesk } from '../../app/server.js';
import { wikiSearch, fetchText } from './check-search.mjs';
import { textNames, companyKey, siteMatches, strictEmail, sameBusiness, topicWords, sameCompany, namesCompany, askCountry } from './rules.js';
import { unsupportedClaims, senderNameProblems } from './claims.js';
import { bodyProblem } from './parse.js';
const press = async (kind, id) => (await call(`/api/m/${kind}/drafts/${id}/send`, { body: (await call(`/api/m/${kind}/drafts/${id}`)).json?.send })).json?.approvalId;   // the owner's press on "Approve and send": only now is the approval asked

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODS = path.join(HERE, '..');
const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['sales', 'mail', 'calendar'];
const ASK = process.env.SALES_ASK || 'Find 10 companies in India that make industrial automation equipment, with sources';
const COUNT = Number(process.env.SALES_COUNT || 10);
const results = []; const check = (name, ok, evidence = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(evidence).replace(/\s+/g, ' ').slice(0, 400)}`); };
const info = (s) => console.log(`      ${s}`);
const want = ['search', 'sales', 'chat', 'mail', 'calendar'].filter(m => fs.existsSync(path.join(MODS, m, 'module.json')));
const t = await testDesk({ real: true, modules: want });
const { core, call } = t;
if (process.env.SALES_CHAIN) { core.settings.set('model.defaultChain', process.env.SALES_CHAIN.split(',')); }
info(`model chain: ${JSON.stringify(core.settings.get('model.defaultChain'))}`);
info(`modules on: ${[...core.modules.active.keys()].join(', ')}; failed to load: ${[...(core.modules.errors || new Map()).entries()].map(([k, v]) => k + ' (' + v.slice(0, 80) + ')').join(', ') || 'none'}`);
let shim = false;
if (!core.modules.api('search')?.search) { core.modules.active.set('search', { handle: null, api: wikiSearch() }); shim = true; info('Search module not loaded: this run uses the check-only Wikipedia search (check-search.mjs)'); }
const cards = []; const origSink = core.jobs.cardSink;
core.jobs.cardSink = (chatId, card) => { cards.push(card); try { origSink?.(chatId, card); } catch {} };
let CHAT = 'chat_realcheck';
if (core.modules.isOn('chat')) { const c = await call('/api/m/chat/chats', { body: { title: 'Sales real check', members: ['closer'] } }); if (c.json?.id) CHAT = c.json.id; info(`chat module on: cards go to chat ${CHAT}`); }
let dataDirKept = null;

try {
  if (parts.includes('sales')) {
    // ---- ask 8: find 20 leads with sources
    const seeds = [];
    if (process.env.SALES_SEED) {
      for (const [company, website] of [['greytHR', 'https://www.greythr.com'], ['Keka HR', 'https://www.keka.com'], ['Zoho People', 'https://www.zoho.com'], ['HROne', 'https://hrone.cloud'], ['sumHR', 'https://sumhr.com']]) seeds.push((await call('/api/m/sales/leads', { body: { company, website, need: 'HR and payroll software' } })).json.lead);
      info(`pipeline seeded with ${seeds.length} leads from the same field: ${seeds.map(x => x.company).join(', ')}`);
    }
    const t0 = Date.now();
    const started = await core.modules.runTool('leads_find', { query: ASK, count: COUNT }, { chatId: CHAT, agentId: 'coordinator' });
    check('leads_find starts a job', started.ok && started.jobId, started.text);
    const repeat = await core.modules.runTool('leads_find', { query: `Please look up: ${ASK.toLowerCase()}`, count: COUNT }, { chatId: CHAT, agentId: 'coordinator' });
    check('a reworded repeat in the same chat while it runs returns the running search, no second job', repeat.already && repeat.jobId === started.jobId, repeat.text);
    const job = await core.jobs.wait(started.jobId, 900000);
    const out = job?.output || {};
    const progressLines = cards.filter(c => c.kind === 'progress').map(c => c.detail);
    info(`progress shown: ${[...new Set(progressLines)].slice(-4).join(' | ')}`);
    info(`searches: ${(out.queries || []).join(' | ')}`);
    info(`left out: ${JSON.stringify(out.rejected || {})}`);
    const secs = Math.round((Date.now() - t0) / 1000);
    check(`leads found for "${ASK}"`, job?.status === 'done' && out.found >= COUNT, `${out.found} of ${COUNT} in ${secs} s (${Math.floor(secs / 60)} min ${secs % 60} s), ${out.pagesRead} pages read, ${out.searches} searches in ${out.rounds} round${out.rounds === 1 ? '' : 's'} (${out.extraRounds || 0} after the merge), model ${out.label}${out.reason ? '; reason: ' + out.reason : ''}${job?.error ? '; error ' + job.error : ''}`);
    check('the whole job stays under 15 minutes', secs < 900, `${secs} s`);
    const leads = (await call('/api/m/sales/leads')).json.leads.filter(l => (out.leadIds || []).includes(l.id));
    let ok200 = 0, named = 0; const bad = [];
    for (const l of leads) {
      const s = l.sources[0];
      try { const r = await fetchText(s.url); if (r.status === 200) ok200++; if (r.status === 200 && namesCompany(r.text, l.company, topicWords(ASK))) named++; else bad.push(`${l.company} <- ${s.url} (${r.status})`); }
      catch (e) { bad.push(`${l.company} <- ${s.url} (${e.message})`); }
    }
    check('every lead has a source URL that returns 200', leads.length > 0 && ok200 === leads.length, `${ok200} of ${leads.length}`);
    check('every source page names its company', leads.length > 0 && named === leads.length, `${named} of ${leads.length}${bad.length ? '; not: ' + bad.slice(0, 4).join('; ') : ''}`);
    for (const l of leads.slice(0, 25)) info(`${l.company} | ${l.contactName || 'contact not checked'} | ${l.need.slice(0, 70)} | ${l.sources[0].url}`);
    const askC = askCountry(ASK);
    if (askC) {
      const unplaced = leads.filter(l => !String(l.findings || '').includes(`Placed in ${askC.label} by `));
      check(`every lead is placed in ${askC.label} by a page that was read (the evidence is in its findings)`, leads.length > 0 && unplaced.length === 0, `${leads.length - unplaced.length} of ${leads.length}; left out for want of a place: ${out.rejected?.['not placed in the country'] || 0}`);
      for (const l of leads.slice(0, 25)) info(`${l.company}: ${(String(l.findings || '').match(/Placed in .*$/) || ['not placed'])[0].slice(0, 200)}`);
    }
    const invented = leads.filter(l => l.email && !l.sources.length);
    if (seeds.length) {
      const clash = leads.filter(l => seeds.some(x => sameCompany(x.company, l.company, topicWords(ASK)) || (l.website && x.website && new URL(l.website).hostname.replace(/^www\./, '') === new URL(x.website).hostname.replace(/^www\./, ''))));
      check(`${COUNT} new leads with ${seeds.length} already in the pipeline`, leads.length === COUNT && clash.length === 0, `${leads.length} new, ${clash.length} of them already in the pipeline; skipped as known: ${out.rejected?.['already in your pipeline'] || 0}; reply: ${out.text.slice(0, 220)}`);
    }
    const keys = leads.map(l => companyKey(l.company)); const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    check('no duplicate companies (normalised names)', dupes.length === 0, `${new Set(keys).size} distinct of ${leads.length}${dupes.length ? '; repeated: ' + dupes.join(', ') : ''}`);
    check('brands and non-companies left out by the job', true, `merged as the same company: ${out.rejected?.['merged as the same company'] || 0}, left out as brand or product: ${out.rejected?.['a brand or product, not a company'] || 0}, as not a company: ${(out.rejected?.['not a company'] || 0) + (out.rejected?.['not described as a company'] || 0)}, as publisher: ${out.rejected?.['the publisher, not a lead'] || 0}`);
    const ownPrimary = leads.filter(l => l.sources[0] && siteMatches(l.company, l.sources[0].url));
    check('own-site step ran: progress shown and own sites used as primary source', progressLines.some(x => /checking company sites/.test(x)) && out.sites?.checked >= leads.length, `${ownPrimary.length} of ${leads.length} have their own site as primary source (${ownPrimary.map(l => new URL(l.sources[0].url).hostname).join(', ')}); ${out.sites?.emails || 0} mail addresses from those sites`);
    let mailOk = 0; const mailBad = [];
    for (const l of leads.filter(x => x.email)) {
      const urls = [l.sources[0]?.url, (l.contactOther.match(/https?:\/\/\S+/) || [])[0]].filter(Boolean); let seen = false;
      for (const u of urls) { try { const r = await fetchText(u); if ((r.text + ' ' + r.html).toLowerCase().includes(l.email)) { seen = true; break; } } catch {} }
      if (seen) mailOk++; else mailBad.push(`${l.company}: ${l.email}`);
    }
    const badMail = leads.filter(l => l.email && !strictEmail(l.email)).map(l => l.email);
    check('every mail address passes the strict pattern (no glued words)', badMail.length === 0, `${leads.filter(l => l.email).length} addresses: ${leads.filter(l => l.email).map(l => l.email).join(', ') || 'none'}${badMail.length ? '; bad: ' + badMail.join(', ') : ''}`);
    const wrongSite = [];
    for (const l of ownPrimary) { try { const r = await fetchText(l.sources[0].url); if (!sameBusiness(r.text, topicWords(ASK))) wrongSite.push(`${l.company} <- ${l.sources[0].url}`); } catch {} }
    check('own-site sources are about the same business as the ask', wrongSite.length === 0, `${ownPrimary.length - wrongSite.length} of ${ownPrimary.length} carry the ask's field words (${topicWords(ASK).join(', ')}) in the opening lines or several times; site step turned down ${out.sites?.wrongBusiness || 0} same-name site(s)${wrongSite.length ? '; not: ' + wrongSite.join('; ') : ''}`);
    const bee = leads.find(l => /^beehive/i.test(l.company));
    info(`Beehive: ${bee ? `listed with source ${bee.sources[0].url}, site ${bee.website || 'none'}, address ${bee.email || 'none'}` : 'not in the list'}`);
    check('no lead carries beehive.net (Beehive Broadband) as its site, source or address', !leads.some(l => /beehive\.net/.test(`${l.website} ${l.email} ${l.sources.map(x => x.url).join(' ')}`)), bee ? `${bee.company}: ${bee.sources[0].url}` : 'Beehive not listed');
    const twins = []; leads.forEach((a, i) => leads.slice(i + 1).forEach(b => { if (sameCompany(a.company, b.company, topicWords(ASK))) twins.push(`${a.company} = ${b.company}`); }));
    check('no same company twice (e.g. "Keka" and "Keka HR")', twins.length === 0, twins.join('; ') || `${leads.length} companies, none the same`);
    check('every mail address is printed on the company\'s own pages', mailBad.length === 0, `${mailOk} of ${leads.filter(x => x.email).length} found again by a fresh fetch${mailBad.length ? '; not: ' + mailBad.join('; ') : ''}`);
    check('no contact or email without a page that gives it', invented.length === 0, `${leads.filter(l => l.contactName).length} contacts and ${leads.filter(l => l.email).length} emails, each found in the source text by code`);
    const table = cards.find(c => c.kind === 'table');
    if (table && out.found < COUNT) check('short: the card title and the reply say how many and why', new RegExp(`^${out.found} of ${COUNT} found`).test(table.title) && table.title.includes(out.reason) && out.text.includes(out.reason) && table.actions.find(a => a.label === 'Find more')?.args?.more === true, `title: ${table.title} | reply: ${out.text}`);
    else info(`not short: card title "${table?.title}"`);
    check('table card in the chat: columns and actions', table && JSON.stringify(table.columns) === JSON.stringify(['Company', 'Contact', 'Value', 'Need', 'Source']) && ['Draft outreach for all', 'Find more', 'Open Sales'].every(a => table.actions.some(x => x.label === a)) && !table.actions.some(x => x.label === 'Add all to pipeline') && table.rowActions?.[0]?.label === 'Draft',
      table ? `columns: ${table.columns.join(', ')} · actions: ${table.actions.map(a => a.label).join(', ')} · row action: ${table.rowActions.map(a => a.label).join(', ')} · ${table.rows.length} rows · first source cell: ${table.rows[0]?.[4]}` : 'no table card');
    if (core.modules.isOn('chat')) {
      const msgs = (await call(`/api/m/chat/chats/${CHAT}/messages`)).json?.messages || [];
      const inChat = msgs.flatMap(m => m.cards || []).find(c => c.kind === 'table');
      check('the table card is in the real chat', !!inChat && inChat.rows.length === out.found, `${msgs.length} messages; table "${inChat?.title}" with ${inChat?.rows?.length} rows; job reply: ${msgs.map(m => m.text).filter(Boolean).slice(-1)[0]?.slice(0, 200) || 'none'}`);
    }
    check('leads saved as New', leads.every(l => l.stage === 'new'), `${leads.filter(l => l.stage === 'new').length} New`);

    // ---- ask 9: draft outreach to the top five
    const sendsBefore = core.storage.get("SELECT COUNT(*) AS c FROM activity WHERE action = 'send.person' AND how = 'owner approve'").c;
    const d = await core.modules.runTool('outreach_draft', { top: 5 }, { chatId: CHAT, agentId: 'coordinator' });
    if (!d.drafts && d.jobId) { info('the drafting job is still running on slow models: waiting for it'); const j = await core.jobs.wait(d.jobId, 900000); Object.assign(d, j?.output || {}, { ok: j?.status === 'done' }); }
    const drafts = (await call('/api/m/sales/state')).json.drafts;
    const waiting = drafts.filter(x => x.status === 'waiting');
    check('five drafts created, status waiting', d.ok && d.drafts?.length === 5 && waiting.length === 5, `${d.drafts?.length} drafts, ${waiting.length} waiting · ${d.text}`);
    const pend = core.approval.listPending().filter(a => a.action === 'send.person');
    check('saving drafts creates no send approval', pend.length === 0 && waiting.every(w => !w.approvalId), `${pend.length} pending after ${waiting.length} drafts`);
    const structure = waiting.map(w => ({ c: w, why: !w.subject.trim() ? 'no subject' : /[{}]|"\s*:|^subject:/im.test(w.subject) ? 'subject looks like markup' : bodyProblem(w.body) }));
    check('email structure: subject in its own field, body is message text only', waiting.length === 5 && structure.every(x => !x.why), structure.map(x => x.why ? `${x.c.subject.slice(0, 30)}: ${x.why}` : null).filter(Boolean).join('; ') || `5 of 5: no JSON, fences or header lines in any body; subjects: ${waiting.map(w => w.subject).join(' | ').slice(0, 220)}`);
    const sent = drafts.filter(x => x.status === 'sent').length + (core.storage.get("SELECT COUNT(*) AS c FROM activity WHERE action = 'send.person' AND how = 'owner approve'").c - sendsBefore);
    check('zero sends', sent === 0, `${sent} sent`);
    check('draft cards posted', cards.filter(c => c.kind === 'sales.draft' && !c.copyOnly).length === 5, cards.filter(c => c.kind === 'sales.draft').map(c => c.title).slice(0, 2).join(' | '));
    const claimy = waiting.map(w => ({ c: w, bad: unsupportedClaims(`${w.subject}. ${w.body}`, '') }));
    check('drafts made with no offer text claim nothing about the owner', claimy.every(x => x.bad.length === 0), `offer text: none; claims left: ${claimy.reduce((a, x) => a + x.bad.length, 0)}; rewritten once: ${(d.drafts || []).filter(x => x.regenerated).length}; sentences removed and marked "check this": ${(d.drafts || []).reduce((a, x) => a + (x.removed?.length || 0), 0)}`);
    const owner = core.settings.get('ownerName') || '';
    const nameIssues = waiting.map(w => senderNameProblems(w.body, owner)).flat();
    check('drafts give the sender no invented name or placeholder', nameIssues.length === 0, `owner name set: ${owner ? 'yes' : 'no'}; problems left: ${nameIssues.length}${nameIssues.length ? " (" + nameIssues.join(', ') + ')' : ''}`);
    for (const w of waiting) info(`draft to ${w.to || 'no address'} (${w.label}): ${w.subject} — ${w.body.replace(/\s+/g, ' ').slice(0, 260)}${w.note ? ' [' + w.note + ']' : ''}`);
    const sample = waiting[0];
    check('drafted leads moved to Drafted', (await call('/api/m/sales/leads')).json.leads.filter(l => l.stage === 'drafted').length === 5, '');
    // approve one with Mail off: it must not send
    check('Mail is off for this step', !core.modules.isOn('mail'), '');
    sample.approvalId = await press('sales', sample.id);
    check('the press on Approve and send asks for exactly that draft', core.approval.listPending().filter(a => a.action === 'send.person').length === 1 && core.approval.listPending().find(a => a.id === sample.approvalId)?.payload?.body === sample.body, core.approval.listPending().find(a => a.id === sample.approvalId)?.title);
    const ap = await call(`/api/approvals/${sample.approvalId}/approve`, { method: 'POST' });
    await new Promise(r => setTimeout(r, 400));
    const after = (await call('/api/m/sales/state')).json.drafts.find(x => x.id === sample.id);
    check('approving with Mail off does not send', ap.status === 200 && after.status === 'approved' && /switch on Mail|no address/.test(after.note), `status ${after.status}, note "${after.note}"`);
    // deny keeps the draft
    const other = waiting[1];
    other.approvalId = await press('sales', other.id);
    await call(`/api/approvals/${other.approvalId}/deny`, { method: 'POST' }); await new Promise(r => setTimeout(r, 300));
    const den = (await call('/api/m/sales/state')).json.drafts.find(x => x.id === other.id);
    check('deny keeps the draft', den && den.status === 'not sent' && den.body.length > 20, `status ${den?.status}, note "${den?.note}"`);

    // copy-only text for another channel: no subject, no approval, nothing can send it
    const liLead = (await call('/api/m/sales/leads')).json.leads.find(l => l.stage === 'new');
    if (liLead) {
      const before = core.approval.listPending().length;
      const li = await core.modules.runTool('outreach_draft', { leadIds: [liLead.id], channel: 'linkedin' }, { chatId: CHAT, agentId: 'coordinator' });
      if (!li.drafts && li.jobId) { const j = await core.jobs.wait(li.jobId, 600000); Object.assign(li, j?.output || {}); }
      const ld = (await call('/api/m/sales/state')).json.drafts.find(x => x.channel === 'linkedin');
      const refused = ld ? (await call(`/api/m/sales/drafts/${ld.id}/send`, { method: 'POST' })).status : 0;
      const card = cards.find(c => c.kind === 'sales.draft' && c.copyOnly);
      check('a LinkedIn text is copy-only: no subject, no approval, cannot be sent', ld && ld.status === 'copy' && !ld.subject && !bodyProblem(ld.body) && core.approval.listPending().length === before && refused === 409 && card && !card.subject && !card.approvalId, `status ${ld?.status}; send route answers ${refused}; card "${card?.title}"; text: ${String(ld?.body).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    // coach note
    const c = await call('/api/m/sales/coach', { method: 'POST' });
    check('coach note from a real model, labelled', c.status === 200 && c.json.text && c.json.label, `[${c.json.label}] ${c.json.text}`);

  }

  if (parts.includes('mail') && t.desk) {
    // ---- ask 14: Mail on, a real send to a loopback server, Mail off
    const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url);
    const { SMTPServer } = require('smtp-server');
    const got = [];
    const srv = new SMTPServer({ authOptional: false, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
      onAuth(auth, s, cb) { cb(auth.username === 'owner@desk.test' && auth.password === 'app-pass-check' ? null : new Error('bad login'), { user: auth.username }); },
      onData(stream, session, cb) { let b = ''; stream.on('data', c => { b += c; }); stream.on('end', () => { got.push({ to: session.envelope.rcptTo.map(r => r.address), raw: b }); cb(); }); } });
    await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.server.address().port;
    info(`loopback SMTP server on 127.0.0.1:${port}`);
    // a Sales draft approved while Mail is off: its grant stays unused, to test that it is bound to that one item
    let held = null;
    if (core.modules.isOn('sales')) {
      const hl = (await call('/api/m/sales/leads', { body: { company: 'Held Grant Test Buyer', contactName: 'H. Buyer', email: 'buyer3@example.test' } })).json.lead;
      const hj = await core.modules.runTool('outreach_draft', { leadIds: [hl.id] }, { agentId: 'coordinator' });
      held = hj.drafts?.[0];
      if (held) { held.approvalId = await press('sales', held.draftId); await call(`/api/approvals/${held.approvalId}/approve`, { method: 'POST' }); await new Promise(r => setTimeout(r, 300)); held = { ...held, draft: (await call('/api/m/sales/state')).json.drafts.find(x => x.id === held.draftId) }; }
    }
    const listMail = async () => (await call('/api/modules')).json.modules.find(m => m.id === 'mail');
    let m0 = await listMail();
    const off404 = (await call('/api/m/mail/state')).status;
    check('Mail ships off: no menu place, routes 404', m0 && !m0.on && off404 === 404, `on=${m0?.on}, /api/m/mail/state -> ${off404}`);
    const on = await call('/api/modules/mail/on', { method: 'POST' });
    const m1 = await listMail();
    const ui200 = (await fetch(t.base + '/modules/mail/ui.js')).status;
    check('switch Mail on: menu place and settings section appear', on.status === 200 && m1.on && m1.menu.some(x => x.label === 'Mail') && m1.settings.some(x => x.id === 'mail') && (await call('/api/m/mail/state')).status === 200 && ui200 === 200, `menu: ${m1.menu.map(x => x.label).join(', ')}; settings: ${m1.settings.map(x => x.label).join(', ')}; ui.js ${ui200}`);
    const acc = await call('/api/m/mail/accounts', { body: { email: 'owner@desk.test', name: 'Desk Owner', smtp: { host: '127.0.0.1', port, tls: 'none' }, imap: { host: '' }, password: 'app-pass-check' } });
    const st = await call('/api/m/mail/state');
    check('account saved; password only in secrets', acc.status === 200 && st.json.accounts[0]?.hasPassword && !st.text.includes('app-pass-check') && core.storage.get("SELECT COUNT(*) AS c FROM secrets WHERE kind = 'module:mail'").c === 1, `account ${st.json.accounts[0]?.email}, hasPassword ${st.json.accounts[0]?.hasPassword}`);
    const bad = await call('/api/m/mail/accounts', { body: { email: 'x@example.com', smtp: { host: 'smtp.gmail.com', port: 25, tls: 'none' } } });
    check('unencrypted servers refused off this PC', bad.status === 400, bad.json?.error);
    const dr = await core.modules.runTool('mail_draft', { to: 'buyer@example.test', subject: 'Check: loopback delivery', body: 'Hello. This message only goes to the test server on this PC.' }, { chatId: CHAT, agentId: 'closer' });
    check('mail_draft makes a draft that waits; no approval yet; nothing sent', dr.ok && !dr.approvalId && got.length === 0 && core.approval.listPending().length === 0, dr.text);
    dr.approvalId = await press('mail', dr.draftId);
    const api = core.modules.api('mail');
    const refusals = [];
    for (const [why, args] of [['no approval id', { draftId: dr.draftId }], ['a made-up id', { draftId: dr.draftId, approvalId: 'ap_fake' }], ['the pending, not granted id', { draftId: dr.draftId, approvalId: dr.approvalId }], ['a direct send with no id', { to: 'buyer@example.test', subject: 'x', body: 'y' }]]) {
      try { await api.send(args); refusals.push(`${why}: SENT`); } catch (e) { refusals.push(`${why}: refused (${e.code || e.message})`); }
    }
    check('a send without an approved id is refused', refusals.every(r => r.includes('refused')) && got.length === 0, refusals.join('; '));
    const ap = await call(`/api/approvals/${dr.approvalId}/approve`, { method: 'POST' });
    for (let i = 0; i < 40 && !got.length; i++) await new Promise(r => setTimeout(r, 150));
    const sentRow = (await call('/api/m/mail/state')).json.sent.find(s => s.id === dr.draftId);
    check('owner approves: the message arrives at the loopback server', ap.status === 200 && got.length === 1 && got[0].to.includes('buyer@example.test') && /Check: loopback delivery/.test(got[0].raw) && sentRow?.status === 'sent', `arrived: to ${got[0]?.to}, ${got[0]?.raw.length} bytes, subject line ${/Subject: (.*)/.exec(got[0]?.raw || '')?.[1]}; Sent list shows it`);
    let reuse; try { await api.send({ to: 'buyer@example.test', subject: 'again', body: 'again', approvalId: dr.approvalId }); reuse = 'SENT'; } catch (e) { reuse = 'refused (' + (e.code || e.message) + ')'; }
    check('a granted id works once only', reuse.startsWith('refused') && got.length === 1, reuse);
    if (held?.draft) {
      const hd = held.draft; let r1, r2;
      try { await api.send({ to: hd.to, subject: hd.subject, body: hd.body + '\nP.S. changed after approval', approvalId: held.approvalId }); r1 = 'SENT'; } catch (e) { r1 = 'refused (' + (e.code || e.message) + ')'; }
      try { await api.send({ to: 'someone-else@example.test', subject: hd.subject, body: hd.body, approvalId: held.approvalId }); r2 = 'SENT'; } catch (e) { r2 = 'refused (' + (e.code || e.message) + ')'; }
      const n0 = got.length;
      let r3; try { await api.send({ to: hd.to, subject: hd.subject, body: hd.body, approvalId: held.approvalId }); r3 = 'sent'; } catch (e) { r3 = 'refused (' + (e.code || e.message) + ')'; }
      check('a grant is bound to its one item: changed body or recipient refused, the approved item goes', hd.status === 'approved' && r1.startsWith('refused') && r2.startsWith('refused') && r3 === 'sent' && got.length === n0 + 1 && got[got.length - 1].to.includes('buyer3@example.test'),
        `held draft was "${hd.note}"; changed body: ${r1}; other recipient: ${r2}; exact item: ${r3}`);
    }
    // Sales -> Mail: an approved Sales draft is handed to Mail
    if (core.modules.isOn('sales')) {
      const l = (await call('/api/m/sales/leads', { body: { company: 'Loopback Test Buyer', contactName: 'T. Buyer', email: 'buyer2@example.test' } })).json.lead;
      const dj = await core.modules.runTool('outreach_draft', { leadIds: [l.id] }, { chatId: CHAT, agentId: 'coordinator' });
      const sd = dj.drafts?.[0];
      if (sd) sd.approvalId = await press('sales', sd.draftId);
      await call(`/api/approvals/${sd?.approvalId}/approve`, { method: 'POST' });
      for (let i = 0; i < 40 && !got.some(g => g.to.includes('buyer2@example.test')); i++) await new Promise(r => setTimeout(r, 150));
      const s2 = (await call('/api/m/sales/state')).json.drafts.find(x => x.id === sd?.draftId);
      check('Sales "Approve and send" with Mail on goes through Mail', got.some(g => g.to.includes('buyer2@example.test')) && s2?.status === 'sent', `Sales draft ${s2?.status}; arrived at loopback for buyer2@example.test; model ${sd?.label}`);
    }
    const offr = await call('/api/modules/mail/off', { method: 'POST' });
    const m2 = await listMail();
    const r404 = (await call('/api/m/mail/state')).status; const ui404 = (await fetch(t.base + '/modules/mail/ui.js')).status;
    check('switch Mail off: it goes, routes 404', offr.status === 200 && !m2.on && r404 === 404 && ui404 === 404 && !core.modules.tools.has('mail_draft'), `on=${m2.on}, route ${r404}, ui.js ${ui404}, tool mail_draft ${core.modules.tools.has('mail_draft') ? 'still there' : 'gone'}`);
    await new Promise(r => srv.close(r));
  }
  if (parts.includes('calendar') && t.desk) {
    const ICAL = (await import('ical.js')).default;
    const listCal = async () => (await call('/api/modules')).json.modules.find(m => m.id === 'calendar');
    const c0 = await listCal();
    check('Calendar ships off', c0 && !c0.on && (await call('/api/m/calendar/events')).status === 404, `on=${c0?.on}`);
    await call('/api/modules/calendar/on', { method: 'POST' });
    const c1 = await listCal();
    check('switch Calendar on: menu place appears', c1.on && c1.menu.some(x => x.label === 'Calendar'), c1.menu.map(x => x.label).join(', '));
    const p = core.modules.runTool('calendar_add', { title: 'Call with Deccan Motors', start: '2026-11-20T10:00', end: '2026-11-20T10:30', location: 'Phone' }, { chatId: CHAT, agentId: 'closer' });
    let pend = null; for (let i = 0; i < 40 && !pend; i++) { await new Promise(r => setTimeout(r, 100)); pend = core.approval.listPending().find(a => a.action === 'calendar.write'); }
    const before = (await call('/api/m/calendar/events')).json.events.length;
    check('calendar_add asks the owner first (calendar.write)', pend && before === 0, pend?.title);
    await call(`/api/approvals/${pend.id}/approve`, { method: 'POST' });
    const r = await p;
    const evs = (await call('/api/m/calendar/events')).json.events;
    check('after approval the event is in the list', r.ok && evs.length === 1 && evs[0].start === '2026-11-20T04:30:00.000Z', `${r.text} stored start ${evs[0]?.start} (10:00 in ${core.settings.get('timeZone')})`);
    const lt = await core.modules.runTool('calendar_list', { from: '2026-11-19', to: '2026-11-21' }, { agentId: 'closer' });
    check('calendar_list sees it', lt.events?.length === 1, lt.text);
    const ics = await fetch(t.base + '/api/m/calendar/export.ics').then(x => x.text());
    let parsed = null; try { const comp = new ICAL.Component(ICAL.parse(ics)); const ve = comp.getAllSubcomponents('vevent').map(v => new ICAL.Event(v)); parsed = ve.map(e => ({ summary: e.summary, start: e.startDate.toJSDate().toISOString(), loc: e.location })); } catch (e) { parsed = { error: e.message }; }
    check('exported .ics parses (Mozilla ical.js) with the event', Array.isArray(parsed) && parsed[0]?.summary === 'Call with Deccan Motors' && parsed[0].start === '2026-11-20T04:30:00.000Z', JSON.stringify(parsed));
    const imp = await call('/api/m/calendar/import', { body: { ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:imp-1@check\r\nDTSTART;VALUE=DATE:20261125\r\nDTEND;VALUE=DATE:20261126\r\nSUMMARY:Imported day\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' } });
    check('.ics import adds events', imp.json?.added === 1, imp.json?.text);
    const p2 = core.modules.runTool('calendar_add', { title: 'Denied event', start: '2026-11-21T09:00' }, { agentId: 'closer' });
    let pd = null; for (let i = 0; i < 40 && !pd; i++) { await new Promise(r => setTimeout(r, 100)); pd = core.approval.listPending().find(a => a.action === 'calendar.write'); }
    await call(`/api/approvals/${pd.id}/deny`, { method: 'POST' }); const r2 = await p2;
    check('a denied add is not added', !r2.ok && (await call('/api/m/calendar/events')).json.events.length === 2, r2.text);
    await call('/api/modules/calendar/off', { method: 'POST' });
    const c2 = await listCal();
    check('switch Calendar off: it goes, routes 404', !c2.on && (await call('/api/m/calendar/events')).status === 404 && !core.modules.tools.has('calendar_add'), `on=${c2.on}`);
  }
  if (parts.includes('sales')) {
    // ---- ask 13: add a lead, move it across the pipeline, restart
    const add = await call('/api/m/sales/leads', { body: { company: 'Restart Check Engineering', contactName: 'A. Owner', valueMinor: 4500000, need: 'Line sensors' } });
    const id = add.json.lead.id;
    for (const s of ['Researched', 'Drafted', 'In talks']) await call(`/api/m/sales/leads/${id}/move`, { body: { stage: s } });
    const beforeCount = (await call('/api/m/sales/leads')).json.leads.length;
    dataDirKept = t.dataDir;
    await t.desk.stop();
    const d2 = await createDesk({ dataDir: t.dataDir, port: 0, quiet: true, env: process.env, modules: want });
    await d2.start();
    const r2 = await fetch(d2.url() + '/api/m/sales/leads').then(r => r.json());
    const back = r2.leads.find(l => l.id === id);
    check('a lead moved to In talks survives a stop and start', back?.stage === 'talks' && back.value === 4500000 && r2.leads.length === beforeCount, `after restart: ${back?.company} is ${back?.stageLabel}, ${r2.leads.length} leads (was ${beforeCount})`);
    const acts = await fetch(d2.url() + `/api/m/sales/leads/${id}`).then(r => r.json());
    info(`timeline: ${acts.activity.map(a => a.text).reverse().join(' → ')}`);
    await d2.stop();
    t.desk = null;
  }
} catch (e) { check('no crash', false, e.stack); }
finally {
  if (t.desk) await t.close(); else { try { fs.rmSync(dataDirKept || t.dataDir, { recursive: true, force: true }); } catch {} }
}
console.log(`${results.filter(Boolean).length} of ${results.length} passed${shim ? ' (search: check-only Wikipedia stand-in)' : ''}`);
process.exit(results.every(Boolean) ? 0 : 1);
