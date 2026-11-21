// Sales CRM (module 13): leads with sources, a four-stage pipeline, outreach drafts that wait for the owner.
// Nothing is sent from here: an approved draft is handed to Mail, which asserts the send.person approval right before sending.
import { SalesStore, STAGES, CHANNELS, stageId, stageLabel } from './store.js';
import { parseDraftReply } from './parse.js';
import { findLeads, closingLine, leadCounts, groupLine, cutWords, purposeLine } from './find.js';
import { companyKey, sameCompany, askCountry, buyerAsk, textNames } from './rules.js';
import { unsupportedClaims, removeSentences, senderNameProblems, stripSenderNames, greetingNameProblems, fillerSentences, plainDefault, languageOf, scriptProblem } from './claims.js';

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function activate(ctx) {
  const currency = () => ctx.settings.get('currency') || '';
  const sysLocale = () => { try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return undefined; } };
  const store = new SalesStore(ctx.db, { currency, emit: (d) => ctx.events.emit('sales', d) });
  const waiting = new Map();       // draftId -> AbortController of its pending send.person request
  const pendingId = new Map();     // draftId -> approval id still pending in this run

  const contactPage = (l) => (String(l.contactOther || '').match(/https?:\/\/\S+/) || [])[0] || '';
  const contactText = (l) => l.contactName ? `${l.contactName}${l.contactRole ? ' · ' + l.contactRole : ''}` : (l.email || (contactPage(l) ? `[Contact page](${contactPage(l)})` : 'not checked'));
  const CHANNEL_WORDS = { email: 'Email', linkedin: 'LinkedIn message', whatsapp: 'WhatsApp message', text: 'Text' };
  // no currency set: the plain number, with no symbol
  const money = (minor, cur) => { if (minor == null) return 'not checked'; const loc = ctx.settings.get('locale') || sysLocale(); const c = cur || currency(); try { return new Intl.NumberFormat(loc, c ? { style: 'currency', currency: c, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 }).format(minor / 100); } catch { return String(minor / 100); } };
  const mdLink = (s) => s ? `[${String(s.title || s.url).replace(/[[\]]/g, '')}](${s.url})` : 'not checked';

  const OPEN_GROUP = 'Not checked: no page read said where these are or what they sell';
  /** One table card. all: every row shown (both groups), for the title and the buttons; open: this card is the not-checked group. */
  function leadsCard(leads, { query, reason, asked, where = '', all = leads, open = false, first = true, last = true, forWhat = '', looked = '' } = {}) {
    const placedNote = where && !all.some(l => l.unchecked?.length) ? ` that could be placed in ${where}` : '';   // only when every row shown was placed there
    const notIn = all.filter(l => !store.getLead(l.id));        // rows not (or no longer) in the pipeline
    const scroll = leads.length > 8 ? ` (all ${leads.length} rows: scroll inside the table)` : '';
    const short = asked && all.length < asked;
    // what the search was for, said by code: the owner's saved "What you do" text, or his own words quoted
    const forText = forWhat ? ` for ${forWhat}` : query ? ` for "${cutWords(query, 80)}"` : '';
    const head = short ? `${all.length} of ${asked} found${placedNote}${forText}: ${reason}. Find more continues from here.`
      : `${all.length} lead${all.length === 1 ? '' : 's'}${forText}`;
    return {
      kind: 'table',
      title: (open ? (first ? `${head}. ${OPEN_GROUP}` : OPEN_GROUP) : head) + scroll,
      note: !last ? '' : (looked ? looked + ' ' : '') + (short ? `${all.length} of ${asked} found${placedNote}: ${reason}. Saved in the pipeline as New. Nothing is sent.` : 'Saved in the pipeline as New. Nothing is sent.'),
      columns: ['Company', 'Contact', 'Value', 'Need', ...(open ? ['Not checked'] : []), 'Source'],
      rows: leads.map(l => [l.company, contactText(l), money(l.value, l.currency), (l.unchecked || []).some(x => /^What it sells/.test(x)) ? 'not checked' : l.need || 'not checked', ...(open ? [(l.unchecked || []).join('; ')] : []), mdLink(l.sources?.[0])]),
      rowIds: leads.map(l => l.id),
      rowActions: [{ label: 'Draft', tool: 'outreach_draft', args: { leadIds: ['$row'] } }],
      actions: !last ? [] : [
        ...(notIn.length ? [{ label: 'Add all to pipeline', tool: 'lead_add', args: { leadIds: notIn.map(l => l.id) } }] : []),
        { label: 'Draft outreach for all', tool: 'outreach_draft', args: { leadIds: all.map(l => l.id) } },
        { label: 'Find more', tool: 'leads_find', args: { query, count: short ? asked - all.length : 10, more: true } },
        { label: 'Open Sales', go: '#/sales' },
      ],
    };
  }
  /** The leads shown as two groups kept apart: checked rows in the first table, then a labelled table of not-checked ones. */
  function leadsCards(leads, opts = {}) {
    const checked = leads.filter(l => !l.unchecked?.length); const open = leads.filter(l => l.unchecked?.length);
    const cards = [];
    if (checked.length || !open.length) cards.push(leadsCard(checked, { ...opts, all: leads, last: !open.length }));
    if (open.length) cards.push(leadsCard(open, { ...opts, all: leads, open: true, first: !cards.length }));
    return cards;
  }
  // Our own card (ui.js chatCards 'sales.draft'): an email shows "Approve and send" (the approval is asked only on that press);
  // any other channel is copy-only: the text and a Copy button, no approval, nothing can send it.
  const draftCard = (d, lead) => d.channel === 'email'
    ? { kind: 'sales.draft', draftId: d.id, channel: 'email', title: `Draft to ${lead.contactName || lead.company}${lead.contactName ? ' at ' + lead.company : ''}`, to: d.to || '', noAddress: !d.to, subject: d.subject, body: d.body, label: d.label, note: d.note, actions: [{ label: 'Open Sales', go: '#/sales' }] }
    : { kind: 'sales.draft', draftId: d.id, channel: d.channel, copyOnly: true, title: `${CHANNEL_WORDS[d.channel]} for ${lead.contactName || lead.company}: copy and paste`, body: d.body, label: d.label, note: d.note, actions: [{ label: 'Open Sales', go: '#/sales' }] };

  // ---------------- finding leads (a job)
  async function startFind({ query, count = 20, agentId = 'closer', chatId = null, more = false }) {
    query = clip(query, 300);
    if (!query) throw Object.assign(new Error('Say what kind of companies to find.'), { status: 400 });
    count = Math.max(1, Math.min(50, Number(count) || 20));
    if (ctx.settings.get('online') === false) return { ok: false, offline: true, text: 'The desk is offline. Finding leads needs the internet.' };
    const search = ctx.modules.api('search');
    if (!search?.search || !search?.read) return { ok: false, text: 'Search is switched off, so I cannot look for new leads on the web. Switch on Search in Settings › Modules, or add a lead by hand.' };
    // one lead search per chat at a time: a repeat (however it is worded) while one from this chat runs gets that job back
    const running = chatId && ['running', 'waiting'].flatMap(status => ctx.jobs.list({ status, limit: 50 })).find(j => j.kind === 'sales.find' && j.chatId === chatId);
    const about = clip(ctx.settings.get('business.about') || '', 600);
    const asked = purposeLine({ query, about, country: askCountry(query), buyerProduct: buyerAsk(query) });
    const forWhat = purposeLine({ query, about }).replace(/^Leads for: /, '').replace(/\.$/, '');
    if (running) return { ok: true, already: true, jobId: running.id, title: running.title, text: `A lead search is already running for this chat: "${running.title}". Its progress and table will appear here; no second search was started.` };
    const job = await ctx.jobs.start({ kind: 'sales.find', title: `Find ${count} leads: ${cutWords(query, 60)}`, agentId: 'closer', chatId, input: { query, count },
      async run(job) {
        const card = (detail, progress, status = 'running') => job.card({ kind: 'progress', id: 'sales-find-' + job.id, title: `Finding ${count} leads`, detail, progress, status, jobId: job.id });
        card('Planning searches', 0.02);
        const memKey = 'find:' + companyKey(query).slice(0, 120);
        const mem = more ? ctx.kv.get(memKey, { queries: [], urls: [] }) : { queries: [], urls: [] };
        const r = await findLeads({ query, count, search: ctx.modules.api('search') || search, model: ctx.model, agentId: 'closer', signal: job.signal,
          skipQueries: mem.queries, skipUrls: mem.urls,
          existing: store.listLeads(),
          known: (name, key, askWords) => !!store.findByName(name) || store.listLeads().some(l => sameCompany(l.company, name, askWords)),
          fetchHtml: async (u, { signal } = {}) => { const r = await ctx.fetch(u, { signal, headers: { accept: 'text/html' } }); if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) return ''; return (await r.text()).slice(0, 400000); },
          onProgress: ({ p, detail }) => { job.progress(p, detail); card(detail, p); } });
        job.throwIfStopped();
        // the store's own duplicate rule: a lead it already held before this job is "already in your pipeline"; one it took
        // earlier in this same job is the same company found twice, never called "already in your pipeline"
        const before = new Set(store.listLeads().map(l => l.id));
        let wasThere = 0, twice = 0;
        const saved0 = r.leads.map(l => store.addLead({ ...l, stage: 'new', foundBy: 'Closer' }, { who: 'Closer' })).filter(l => { if (!l.duplicate) return true; if (before.has(l.id)) wasThere++; else twice++; return false; });
        const saved = [...saved0.filter(l => !l.unchecked?.length), ...saved0.filter(l => l.unchecked?.length)];   // checked first: "top n" takes them first
        const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
        ctx.kv.set(memKey, { queries: [...mem.queries, ...r.queries].slice(-200), urls: [...mem.urls, ...r.readUrls].slice(-600) });
        const reason = saved.length < count ? [r.reason || `${r.pagesRead} pages read from ${r.searches} searches`, twice && plural(twice, 'was the same company found twice', 'were the same companies found twice'), wasThere && plural(wasThere, 'was already in your pipeline', 'were already in your pipeline')].filter(Boolean).join('; ') : '';
        const where = r.country?.label || '';
        const purpose = purposeLine({ query, about, country: r.country, buyerProduct: r.buyerProduct, queries: r.queries });
        const looked = purposeLine({ country: r.country, buyerProduct: r.buyerProduct });
        const cards = leadsCards(saved, { query, reason, asked: count, where, forWhat, looked });
        card(`read ${r.pagesRead} pages, ${saved.length} leads`, 1, 'done');
        for (const c of cards) job.card(c);
        // every number in this line is counted over the rows saved and shown now (closingLine), never over candidates checked
        const siteLine = saved.length ? ' ' + closingLine(saved) : '';
        const sites = { ...(r.sites || {}), ...leadCounts(saved) };
        // two groups: both numbers, never blurred; "places it in" only when every row shown was placed there
        const allPlaced = where && !saved.some(l => l.unchecked?.length);
        const groups = saved.length ? groupLine(saved, { country: r.country, kindAsk: r.kindAsk, asked: count }) : '';
        const text = purpose + '\n\n' + (saved.length >= count ? `Found ${saved.length} leads, each with a page that names it${allPlaced ? ` and places it in ${where}` : ''}.${groups ? ' ' + groups : ''} They are in the pipeline as New. Nothing is sent.`
          : `${saved.length} of ${count} found${allPlaced ? ` that could be placed in ${where}` : ''}: ${reason}.${groups ? ' ' + groups : ''} They are in the pipeline as New. Nothing is sent. Press Find more to keep looking from here.`) + siteLine;
        return { purpose, leadIds: saved.map(l => l.id), sites, searches: r.searches, ms: r.ms, rounds: r.rounds, extraRounds: r.extraRounds, found: saved.length, asked: count, pagesRead: r.pagesRead, queries: r.queries, rejected: r.rejected, reason, label: r.label, text, card: cards[0], tables: cards };
      } });
    return { ok: true, jobId: job.id, purpose: asked, text: `${asked ? asked + ' ' : ''}Looking for ${count} leads now. Progress and the table will appear here.` };
  }

  // ---------------- drafts and the send rule
  // What a press on "Approve and send" sends: the stored draft as it is now. The page shows exactly this, and the
  // approval's payload is exactly this; the send happens only while all three still match.
  const sendable = (d) => ({ to: String(d.to || store.getLead(d.leadId)?.email || ''), subject: String(d.subject ?? ''), body: String(d.body ?? '') });
  const sameItem = (a, b) => !!a && !!b && ['to', 'subject', 'body'].every(k => typeof a[k] === 'string' && a[k] === b[k]);
  function withdraw(draftId) { waiting.get(draftId)?.abort('edited'); waiting.delete(draftId); pendingId.delete(draftId); }
  function lookupPendingId(title, before) { return ctx.approval.listPending().filter(a => a.action === 'send.person' && a.title === title && !before.has(a.id)).pop()?.id || null; }
  /** Ask the owner to send this draft. Returns the pending approval id. The send happens only in onDecision, through Mail. */
  function askToSend(draftId, { chatId } = {}) {
    const d = store.getDraft(draftId); const lead = store.getLead(d?.leadId);
    if (!d || !lead) throw Object.assign(new Error('That draft is gone.'), { status: 404 });
    if (d.channel !== 'email') throw Object.assign(new Error('This text is for copying. It cannot be sent from here.'), { status: 409 });
    waiting.get(draftId)?.abort('replaced');
    const ac = new AbortController(); waiting.set(draftId, ac);
    const item = sendable(d); const to = item.to;
    const title = `Send to ${lead.contactName || 'the contact'} at ${lead.company}`;
    const before = new Set(ctx.approval.listPending().map(a => a.id));
    const p = ctx.approval.request({ agentId: 'closer', chatId: chatId || d.chatId || null, action: 'send.person', title, detail: to ? `Mail to ${to}` : 'No address yet: it will not be sent', payload: item, signal: ac.signal });
    const id = lookupPendingId(title, before);
    if (id) { pendingId.set(draftId, id); store.updateDraft(draftId, { approvalId: id, status: 'waiting', note: String(d.note || '').startsWith('Check this') ? d.note : null }); }
    p.then((dec) => onDecision(draftId, dec, ac)).catch((e) => ctx.log('send decision failed', e.message));
    return id;
  }
  async function onDecision(draftId, dec, ac) {
    if (waiting.get(draftId) === ac) waiting.delete(draftId);
    if (pendingId.get(draftId) === dec.id) pendingId.delete(draftId);
    const d = store.getDraft(draftId); if (!d) return;
    const lead = store.getLead(d.leadId);
    if (!dec.ok) {
      if (dec.reason === 'aborted') return;                       // replaced by an edit or a fresh ask
      if (dec.reason === 'denied') { store.updateDraft(draftId, { status: 'not sent', note: 'You said no. The draft is kept.' }); store.log(d.leadId, 'You', 'Draft not sent'); }
      else store.updateDraft(draftId, { status: 'waiting', approvalId: null, note: dec.reason === 'halted' ? 'Stopped by Panic. Press Approve and send again.' : 'The approval lapsed. Press Approve and send again.' });
      return;
    }
    const item = ctx.approval.get?.(dec.id)?.payload;
    if (!sameItem(item, sendable(d))) { store.updateDraft(draftId, { status: 'waiting', approvalId: null, note: 'The draft changed. Look at it again.' }); store.log(d.leadId, 'You', 'Not sent: the draft changed after the approval'); return; }
    const to = item.to;
    if (!to) { store.updateDraft(draftId, { status: 'approved', note: 'Approved, not sent: no address' }); store.log(d.leadId, 'You', 'Approved, not sent: no address'); return; }
    const mail = ctx.modules.api('mail');
    if (!mail?.send) { store.updateDraft(draftId, { status: 'approved', note: 'Approved, not sent: switch on Mail' }); store.log(d.leadId, 'You', 'Approved, not sent: Mail is off'); return; }
    try {
      // Mail asserts the grant against exactly this { to, subject, body }; it must match what the owner approved.
      const r = await mail.send({ to, subject: item.subject, body: item.body, approvalId: dec.id, source: 'sales', ref: draftId });
      store.updateDraft(draftId, { status: 'sent', sentAt: new Date().toISOString(), note: r?.messageId ? 'Sent by Mail' : 'Sent' });
      store.log(d.leadId, 'You', `Sent to ${to}`);
    } catch (e) { store.updateDraft(draftId, { status: 'approved', note: `Approved, not sent: ${e.message}` }); store.log(d.leadId, 'Mail', `Not sent: ${e.message}`); }
  }

  const CHANNEL_RULES = {
    email: 'Write one short first outreach email',
    linkedin: 'Write one short LinkedIn message (under 60 words, no subject line, no formal sign-off) for the owner to paste himself',
    whatsapp: 'Write one short WhatsApp message (under 50 words, no subject line, plain and polite) for the owner to paste himself',
    text: 'Write one short plain message (under 80 words, no subject line) for the owner to paste himself',
  };
  async function writeDraft(lead, { signal, channel = 'email', language = '' }) {
    const owner = ctx.settings.get('ownerName') || '';
    const business = clip(ctx.settings.get('companyName') || '', 120);
    const closer = ctx.agents.get('closer');
    // his offer text from the Sales page; with none, what he wrote under "What you do" in Settings (his own words either way)
    const offer = clip(ctx.kv.get('offer', '') || ctx.settings.get('business.about') || '', 600);
    const support = [offer, business].filter(Boolean).join(' ');     // what the owner gave about himself: his offer text and business name
    const lang = languageOf(language);
    const langRule = lang && lang.name !== 'English' ? ` Write the whole message${channel === 'email' ? ', subject and body,' : ''} in ${lang.name}${lang.script ? `, in ${lang.script} script` : ''}; only names of companies and people, numbers and addresses may stay as they are.` : '';
    const email = channel === 'email';
    // a not-checked lead: what no page said is passed as "not checked" and its need and findings (which name the ask's place
    // or product) are left out, so the draft cannot state them; the contact is handled the same way
    const placeOpen = (lead.unchecked || []).some(x => /^Country/.test(x)); const sellsOpen = (lead.unchecked || []).some(x => /^What it sells/.test(x));
    const open = placeOpen || sellsOpen;
    const facts = [offer ? `What the owner offers, in his words (the only claims you may make about him): ${offer}` : 'What the owner offers: not given.', business && `The owner's business: ${business}`, `Company: ${lead.company}`, lead.contactName && `Contact: ${lead.contactName}${lead.contactRole ? ', ' + lead.contactRole : ''}`,
      placeOpen && 'Where the company is based: not checked. No page read said it: do not say or suggest where they are.', sellsOpen && 'What the company sells: not checked. No page read said it: do not say or suggest what they sell or make.',
      !open && lead.need && `Why they may fit: ${lead.need}`, !open && lead.findings && `What a page said: ${clip(lead.findings, 700)}`, lead.sources?.[0] && `Source: ${open ? 'a page that names them' : lead.sources[0].title}`, lead.notes && `Owner's notes: ${clip(lead.notes, 400)}`].filter(Boolean).join('\n');
    const rules = offer
      ? 'Use only the facts given. About the owner, say only what his offer text says: never add clients, results, numbers, awards, experience or "we have helped".'
      : 'The owner gave no offer text, so the message does three things only: introduce the owner by name, say why this company (from what the page said about them), and ask for a short call. Nothing else: no claims about the owner, no clients, results, numbers, awards, experience, relationships, products, "I work with" or "we have helped", and no filler such as "see how you approach" or "since you are working with this product".';
    const shape = email ? 'Reply with JSON only: {"subject": "...", "body": "..."}. The body is the message text only: no subject line, no headers, no JSON inside it.' : 'Reply with JSON only: {"body": "..."}. The body is the message text only.';
    const sys = ctx.agents.systemPrompt(closer ? 'closer' : 'coordinator', `${CHANNEL_RULES[channel]} in the owner's name${owner ? ` (${owner})` : ''}, in your manner.${email ? ' 60 to 120 words.' : ''} ${rules} Greet the contact by name if one is given, else just "Hello". Never write placeholders in brackets such as [Contact Name] or [Your Name], and never describe the owner's company unless his offer text does. End with one simple question and ${owner ? `sign as ${owner}` : 'no signature: the owner has not given his name, so never write a name for him and never leave a placeholder like [Your Name]; he signs it himself'}.${langRule} ${shape}`);
    // The reply is read strictly: the subject goes to its own field, the body holds message text only. A reply that is raw or
    // cut-off JSON is never saved as the body: one retry, then the draft is refused with a plain reason.
    const ask = async (extra) => {
      let why = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await ctx.model.chat({ agentId: closer ? 'closer' : undefined, purpose: 'draft', json: true, maxTokens: 1500, temperature: attempt ? 0.2 : 0.4, signal, messages: [{ role: 'system', content: sys }, { role: 'user', content: facts + (extra ? '\n\n' + extra : '') + (attempt ? `\n\nYour last reply could not be used (${why}). ${shape}` : '') }] });
        const p = parseDraftReply(r.text, r.json, { needSubject: email, cutOff: r.cutOff === true });
        // the language the owner asked for: the body must be mostly in its script (names, numbers and addresses aside); one retry
        const wrong = !p.error && lang ? scriptProblem(p.body, lang.name, [lead.company, lead.contactName, owner, business]) : '';
        if (!p.error && !wrong) return { subject: email ? (p.subject || `A quick question for ${lead.company}`) : '', body: p.body, label: r.label };
        why = p.error || `${wrong}; write all of it in ${lang.name}${lang.script ? ` (${lang.script} script)` : ''}`;
        if (wrong && attempt === 1) throw Object.assign(new Error(`The model did not write in ${lang.name}; try again or pick another model`), { code: 'bad_reply', language: true });
      }
      throw Object.assign(new Error(`the model's reply could not be read as ${email ? 'a subject and a message' : 'a message'} (${why}), twice`), { code: 'bad_reply' });
    };
    let w = await ask('');
    // the country no page placed them in: a sentence that names it anyway is treated like a claim nobody gave (checked in code)
    const askedIn = placeOpen ? askCountry(lead.query) : null;
    const placeClaims = (text) => askedIn ? String(text || '').split(/(?<=[.!?])\s+/).filter(x => askCountry(x)?.tld === askedIn.tld) : [];
    const problems = (x) => [...unsupportedClaims(`${x.subject}. ${x.body}`, support), ...fillerSentences(x.body), ...senderNameProblems(x.body, owner), ...greetingNameProblems(x.body, lead.contactName), ...placeClaims(`${x.subject}. ${x.body}`)];
    let bad = problems(w); let regenerated = false; let removed = [];
    if (bad.length) {
      regenerated = true;
      try { w = await ask(`Your last draft said things the owner never gave you, or said nothing useful. Do not say anything like these again:\n${bad.map(x => `- "${x}"`).join('\n')}`); } catch (e) { if (e.code !== 'bad_reply' || e.language) throw e; }
      bad = problems(w);
      if (bad.length) {
        removed = bad;
        if (unsupportedClaims(w.subject, support).length || placeClaims(w.subject).length) w.subject = `A quick question for ${lead.company}`;
        const left = [...unsupportedClaims(w.body, support), ...fillerSentences(w.body), ...placeClaims(w.body)];
        if (left.length && (!lang || lang.name === 'English')) {
          // in English the plain default replaces the whole message: who the owner is, why this company, a short call
          w.body = plainDefault({ owner, business, company: lead.company, contactName: lead.contactName, need: open ? '' : lead.need, channel });
        } else {
          w.body = stripSenderNames(removeSentences(w.body, left), senderNameProblems(w.body, owner), owner);
          for (const g of greetingNameProblems(w.body, lead.contactName)) w.body = w.body.replace(g, 'Hello,');
        }
      }
    }
    if (!w.body.trim()) throw Object.assign(new Error('nothing true was left to say after the checks'), { code: 'bad_reply' });
    return { ...w, regenerated, removed, note: removed.length ? 'Check this before sending: something you did not give was removed.' : null };
  }
  /**
   * "The top n" means the same leads every time: the first n rows of the leads table last produced in this chat (the last
   * finished find job whose card went to chatId), in that table's order; with none, the first n of the New lane in the order
   * the Sales page shows it. Returns { leads, why }.
   */
  function topLeads(n, chatId = null) {
    const job = chatId ? ctx.jobs.list({ status: 'done', limit: 300 }).find(j => j.kind === 'sales.find' && j.chatId === chatId && Array.isArray(j.output?.leadIds) && j.output.leadIds.length) : null;
    if (job) {
      const rows = job.output.leadIds.map(id => store.getLead(id)).filter(Boolean);
      if (rows.length) {
        const leads = rows.slice(0, n);
        return { leads, why: leads.length < n ? `the table above has only ${leads.length} lead${leads.length === 1 ? '' : 's'} left` : leads.length === 1 ? 'the first row of the table above' : `the first ${leads.length} of the table above` };
      }
    }
    const leads = store.listLeads({ stage: 'new' }).sort((a, b) => !!a.unchecked?.length - !!b.unchecked?.length).slice(0, n);   // as the page shows it: checked first
    return { leads, why: !leads.length ? '' : leads.length < n ? `the New lane of the Sales page has only ${leads.length}` : leads.length === 1 ? 'the first lead in the New lane of the Sales page' : `the first ${leads.length} in the New lane of the Sales page` };
  }
  async function startDrafts({ leadIds, top, chatId = null, wait = true, channel = 'email', language = '' }) {
    channel = CHANNELS.includes(String(channel || '').toLowerCase()) ? String(channel).toLowerCase() : 'email';
    language = clip(language, 40);
    let leads; let why = '';
    if (Array.isArray(leadIds) && leadIds.length) leads = leadIds.map(id => store.getLead(id) || store.findByName(id)).filter(Boolean);
    else ({ leads, why } = topLeads(Math.max(1, Math.min(20, Number(top) || 5)), chatId));
    if (!leads.length) return { ok: false, text: 'There are no leads to draft for. Find or add leads first.' };
    const taken = why ? `Taken: ${leads.map(l => l.company).join(', ')} (${why}).` : '';
    const job = await ctx.jobs.start({ kind: 'sales.drafts', title: `Draft outreach to ${leads.length} lead${leads.length > 1 ? 's' : ''}`, agentId: 'closer', chatId, input: { leadIds: leads.map(l => l.id) },
      async run(job) {
        const made = []; const failed = []; const skipped = [];
        for (const [i, lead] of leads.entries()) {
          job.throwIfStopped();
          job.progress(i / leads.length, `Writing ${i + 1} of ${leads.length}: ${lead.company}`);
          try {
            // one open draft per lead and channel: a second request is refused with a plain line
            if (store.openDraft(lead.id, channel)) { skipped.push(lead.company); continue; }
            const w = await writeDraft(lead, { signal: job.signal, channel, language });
            // No approval is created here: an email asks for it only when the owner presses "Approve and send" on that draft.
            const d = store.addDraft({ leadId: lead.id, channel, to: lead.email || '', subject: w.subject, body: w.body, label: w.label, agentId: 'closer', chatId, note: w.note });
            store.moveLead(lead.id, 'drafted', { who: 'Closer' });
            store.updateLead(lead.id, { nextStep: channel !== 'email' ? `Copy the ${channel === 'text' ? 'text' : CHANNEL_WORDS[channel]} and send it yourself` : lead.email ? 'Approve the draft to send it' : 'Find an address, then approve the draft' }, { who: 'Closer' });
            job.card(draftCard(d, lead));
            made.push({ draftId: d.id, leadId: lead.id, company: lead.company, channel, approvalId: null, status: d.status, label: w.label, regenerated: w.regenerated, removed: w.removed });
          } catch (e) {
            if (job.signal.aborted || e?.code === 'halted' || e?.code === 'aborted') throw e;
            failed.push({ company: lead.company, error: e.message });
            job.card({ kind: 'text', text: `No draft for ${lead.company}: ${e.message}. Nothing was saved. Ask again to retry.` });
          }
        }
        const n = made.length;
        const text = (channel === 'email' ? `${n} draft${n === 1 ? '' : 's'} waiting for you in Outreach. Nothing is sent until you press Approve and send.`
          : `${n} ${channel === 'text' ? 'text' : CHANNEL_WORDS[channel]}${n === 1 ? '' : 's'} ready to copy. ${n === 1 ? 'It is' : 'They are'} for pasting: nothing can be sent from here.`)
          + (skipped.length ? ` ${skipped.join(', ')} already ${skipped.length === 1 ? 'has' : 'have'} a draft waiting: edit it in Outreach.` : '')
          + (failed.length ? ` ${failed.length} could not be written (${failed.map(f => `${f.company}: ${f.error}`).join('; ')}).` : '')
          + (taken ? ' ' + taken : '');
        return { drafts: made, failed, skipped, channel, language: language || null, taken: leads.map(l => ({ leadId: l.id, company: l.company })), why, text };
      } });
    if (!wait) return { ok: true, jobId: job.id, text: `Writing ${leads.length} draft${leads.length === 1 ? '' : 's'}.${taken ? ' ' + taken : ''}` };
    const done = await ctx.jobs.wait(job.id, 240000);
    return done?.status === 'done' ? { ok: true, jobId: job.id, ...done.output } : { ok: done?.status !== 'failed', jobId: job.id, text: (done?.status === 'failed' ? `Drafting failed: ${done.error}` : 'Still writing; the drafts will appear in Outreach.') + (taken ? ' ' + taken : '') };
  }

  // ---------------- coach note
  async function coach({ signal } = {}) {
    const t = store.totals(); const leads = store.listLeads();
    const lines = leads.slice(0, 30).map(l => `${l.company} · ${stageLabel(l.stage)} · ${l.value == null ? 'value not set' : money(l.value, l.currency)} · next: ${l.nextStep || 'none'}`).join('\n');
    const r = await ctx.model.chat({ agentId: 'closer', purpose: 'small', maxTokens: 160, temperature: 0.4, signal, messages: [
      { role: 'system', content: ctx.agents.systemPrompt('closer', 'Give the owner one or two plain sentences on what to do next with this pipeline. Name a lead when it helps. Use only the facts in the list below: never mention news, expansions, people, roles or numbers that are not in it. No lists, no greetings.') },
      { role: 'user', content: `Leads: ${t.leads}. In talks: ${t.inTalks}. Drafts waiting: ${t.draftsWaiting}. By stage: ${STAGES.map(s => `${s.label} ${t.byStage[s.id]}`).join(', ')}.\n${lines || 'No leads yet.'}` }] });
    const note = { text: clip(r.text, 400), label: r.label, at: new Date().toISOString() };
    ctx.kv.set('coach', note);
    return note;
  }

  // ---------------- tools
  ctx.tool({ name: 'leads_find', description: 'Find real companies that fit a sales ask, each with a source page that names it. Runs as a job; posts a table of leads in the chat and saves them in the pipeline as New. Never sends anything.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What kind of companies, where, for what need' }, count: { type: 'integer', description: 'How many leads (default 20)' }, more: { type: 'boolean', description: 'Continue an earlier search for the same ask, skipping searches and pages already used' } }, required: ['query'] },
    async run(args, call) { return startFind({ query: args.query, count: args.count, more: !!args.more, chatId: call.chatId, agentId: call.agentId }); } });
  ctx.tool({ name: 'lead_add', description: 'Add a lead to the Sales pipeline (or confirm that found leads are in it with leadIds). Value is in whole units of the owner\'s currency.',
    parameters: { type: 'object', properties: { company: { type: 'string' }, contactName: { type: 'string' }, contactRole: { type: 'string' }, email: { type: 'string' }, value: { type: 'number' }, need: { type: 'string' }, nextStep: { type: 'string' }, sourceUrl: { type: 'string' }, stage: { type: 'string', enum: STAGES.map(s => s.label) }, leadIds: { type: 'array', items: { type: 'string' } } } },
    async run(args) {
      if (Array.isArray(args.leadIds) && args.leadIds.length) { const ls = args.leadIds.map(id => store.getLead(id)).filter(Boolean); return { ok: true, text: `${ls.length} lead${ls.length === 1 ? ' is' : 's are'} in the pipeline.`, leadIds: ls.map(l => l.id) }; }
      const l = store.addLead({ ...args, value: args.value == null ? null : Math.round(Number(args.value) * 100), sources: args.sourceUrl ? [{ title: args.sourceUrl, url: args.sourceUrl }] : [], foundBy: 'Closer' }, { who: 'Closer' });
      return { ok: true, lead: { id: l.id, company: l.company, stage: l.stageLabel }, text: l.duplicate ? `${l.company} is already in the pipeline (${l.stageLabel}).` : `Added ${l.company} to the pipeline as ${l.stageLabel}.`, cards: [{ kind: 'actions', actions: [{ label: 'Open Sales', go: '#/sales' }] }] };
    } });
  ctx.tool({ name: 'outreach_draft', description: 'Write outreach drafts in the owner\'s name for leads (by id or company), or for the top n leads. Email drafts wait for the owner; LinkedIn, WhatsApp and plain text are copy-only. Nothing is sent.',
    parameters: { type: 'object', properties: { leadIds: { type: 'array', items: { type: 'string' } }, top: { type: 'integer', description: 'Draft for the top n leads without a draft' }, offer: { type: 'string', description: 'What the owner sells, in his words, if he said it (saved for later drafts)' }, channel: { type: 'string', enum: CHANNELS, description: 'email (default) makes a draft the owner can approve and send. linkedin, whatsapp or text make copy-only text: no subject, no approval, nothing can send it. Use the channel the owner named.' }, language: { type: 'string', description: 'The language the owner asked for, as a plain name (Hindi, Tamil, Malayalam, Marathi, Bengali, English). Leave out when he named none.' }, chatId: { type: 'string', description: 'The chat the ask came from: "top n" means the first n rows of the leads table last shown there' } } },
    async run(args, call) { if (args.offer) ctx.kv.set('offer', clip(args.offer, 600)); return startDrafts({ leadIds: args.leadIds, top: args.top, channel: args.channel, language: args.language, chatId: args.chatId || call.chatId }); } });
  ctx.tool({ name: 'pipeline_move', description: 'Move a lead to another stage: New, Researched, Drafted or In talks.',
    parameters: { type: 'object', properties: { leadId: { type: 'string' }, company: { type: 'string' }, stage: { type: 'string', enum: STAGES.map(s => s.label) } }, required: ['stage'] },
    async run(args) {
      const lead = (args.leadId && store.getLead(args.leadId)) || (args.company && store.findByName(args.company));
      if (!lead) return { ok: false, text: 'I could not find that lead.' };
      const l = store.moveLead(lead.id, args.stage, { who: 'Closer' });
      return { ok: true, text: `${l.company} is now ${l.stageLabel}.` };
    } });

  // ---------------- routes (owner-only for anything that changes data)
  const ownerOnly = (res, owner) => { if (!owner) { ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403); return true; } return false; };
  const view = () => ({ leads: store.listLeads(), drafts: store.drafts(), totals: store.totals(), stages: STAGES, coach: ctx.kv.get('coach', null), mailOn: !!ctx.modules.api('mail'), offer: ctx.kv.get('offer', ''), searchOn: !!ctx.modules.api('search'), pending: Object.fromEntries(pendingId) });
  ctx.route('GET', '/state', (req, res) => ctx.json(res, view()));
  ctx.route('GET', '/leads', (req, res) => ctx.json(res, { leads: store.listLeads() }));
  ctx.route('GET', '/leads/:id', (req, res, { params }) => { const l = store.getLead(params.id); l ? ctx.json(res, { lead: l, drafts: store.drafts({ leadId: l.id }), activity: store.activity(l.id) }) : ctx.json(res, { error: 'Not found' }, 404); });
  ctx.route('POST', '/leads', (req, res, { body, owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, { lead: store.addLead({ ...body, value: body?.valueMinor ?? body?.value ?? null }) }); });
  ctx.route('PATCH', '/leads/:id', (req, res, { params, body, owner }) => { if (ownerOnly(res, owner)) return; const p = { ...body }; if ('valueMinor' in p) { p.value = p.valueMinor; delete p.valueMinor; } const old = store.getLead(params.id); const l = store.updateLead(params.id, p);
    // an open ask to the lead's address showed the old address: withdrawn
    if (l && old && l.email !== old.email) for (const d of store.drafts({ leadId: l.id })) if (!d.to && d.status !== 'sent') { withdraw(d.id); store.updateDraft(d.id, { status: d.channel === 'email' ? 'waiting' : 'copy', approvalId: null }); }
    l ? ctx.json(res, { lead: l }) : ctx.json(res, { error: 'Not found' }, 404); });
  ctx.route('DELETE', '/leads/:id', (req, res, { params, owner }) => { if (ownerOnly(res, owner)) return; store.removeLead(params.id); ctx.json(res, { ok: true }); });
  ctx.route('POST', '/leads/:id/move', (req, res, { params, body, owner }) => { if (ownerOnly(res, owner)) return; const l = store.moveLead(params.id, body?.stage); l ? ctx.json(res, { lead: l }) : ctx.json(res, { error: 'Not found' }, 404); });
  ctx.route('POST', '/find', async (req, res, { body, owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, await startFind({ query: body?.query, count: body?.count })); });
  ctx.route('POST', '/draft', async (req, res, { body, owner }) => { if (ownerOnly(res, owner)) return; ctx.json(res, await startDrafts({ leadIds: body?.leadIds, top: body?.top, channel: body?.channel, language: body?.language, wait: false })); });
  ctx.route('PATCH', '/drafts/:id', (req, res, { params, body, owner }) => {
    if (ownerOnly(res, owner)) return;
    const d = store.getDraft(params.id); if (!d) return ctx.json(res, { error: 'Not found' }, 404);
    if (d.status === 'sent') return ctx.json(res, { error: 'This one is already sent.' }, 409);
    withdraw(d.id);    // an open ask showed the old text: withdrawn
    store.updateDraft(d.id, { ...(body?.subject != null ? { subject: clip(body.subject, 200) } : {}), ...(body?.body != null ? { body: String(body.body).slice(0, 8000) } : {}), ...(body?.to != null ? { to: clip(body.to, 200) } : {}), status: d.channel === 'email' ? 'waiting' : 'copy', approvalId: null, note: null });
    ctx.json(res, { draft: store.getDraft(d.id) });
  });
  // The draft as a press would send it now: the page fetches this and shows all of it before the owner presses Send.
  ctx.route('GET', '/drafts/:id', (req, res, { params }) => { const d = store.getDraft(params.id); d ? ctx.json(res, { draft: d, send: d.channel === 'email' ? sendable(d) : null, mailOn: !!ctx.modules.api('mail') }) : ctx.json(res, { error: 'Not found' }, 404); });
  // "Send" in that confirm: the body carries the { to, subject, body } the owner was shown. Refused unless the stored draft
  // still matches; then returns the pending approval with exactly that payload. The page resolves it with the same click
  // through the core approval route; the send happens in onDecision through Mail, which asserts the same payload.
  ctx.route('POST', '/drafts/:id/send', (req, res, { params, body, owner }) => {
    if (ownerOnly(res, owner)) return;
    const d = store.getDraft(params.id); if (!d) return ctx.json(res, { error: 'Not found' }, 404);
    if (d.status === 'sent') return ctx.json(res, { error: 'This one is already sent.' }, 409);
    if (d.channel !== 'email') return ctx.json(res, { error: 'This text is for copying. It cannot be sent from here.' }, 409);
    const item = sendable(d);
    if (!item.to) return ctx.json(res, { error: 'This draft has no address yet. Add an address first.' }, 409);
    if (!sameItem(body, item)) return ctx.json(res, { error: 'The draft changed. Look at it again.', send: item }, 409);
    const live = pendingId.get(d.id); const la = live && ctx.approval.get?.(live);
    const id = la?.status === 'pending' && sameItem(la.payload, item) ? live : askToSend(d.id);
    ctx.json(res, { approvalId: id });
  });
  ctx.route('POST', '/offer', (req, res, { body, owner }) => { if (ownerOnly(res, owner)) return; ctx.kv.set('offer', clip(body?.offer, 600)); ctx.json(res, { offer: ctx.kv.get('offer', '') }); });
  ctx.route('POST', '/coach', async (req, res, { owner }) => { if (ownerOnly(res, owner)) return; try { ctx.json(res, await coach()); } catch (e) { ctx.json(res, { error: e.message }, e.code === 'halted' ? 503 : 502); } });

  ctx.expose({
    listLeads: () => store.listLeads(),
    offer: () => ctx.kv.get('offer', ''),
    addLead: (lead) => store.addLead(lead, { who: 'Closer' }),
    moveLead: (id, stage) => store.moveLead(id, stage, { who: 'Closer' }),
    drafts: () => store.drafts(),
    totals: () => store.totals(),
    /** A lead search with every evidence rule that saves nothing: Bench shows the leads as proposals; the owner's Keep adds one. */
    async searchLeads({ query, count = 10, signal, budget = {}, model = ctx.model } = {}) {
      query = clip(query, 300); if (!query) throw new Error('Say what kind of companies to find.');
      const search = ctx.modules.api('search'); if (!search?.search || !search?.read) throw Object.assign(new Error('Search is switched off.'), { code: 'no_search' });
      const r = await findLeads({ query, count, search, model, agentId: 'closer', signal, budget, existing: [] });   // leads already in the pipeline come back too: Bench marks them so
      const purpose = purposeLine({ query, about: clip(ctx.settings.get('business.about') || '', 600), country: r.country, buyerProduct: r.buyerProduct, queries: r.queries });
      return { leads: r.leads, purpose, label: r.label, pagesRead: r.pagesRead, searches: r.searches, reason: r.reason };
    },
    sameCompany: (a, b) => sameCompany(a, b),
    pageNames: (text, company) => textNames(text, company),
  });
  return { async deactivate() { for (const ac of waiting.values()) ac.abort('module off'); waiting.clear(); } };
}
export { stageId };
