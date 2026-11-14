// Plumbing tests with the fake model (never evidence that the feature works; see real-check.mjs).
import test from 'node:test'; import assert from 'node:assert/strict';
import { testDesk } from '../../test/helpers/desk.js';
import { checkRow } from './find.js';
import { textNames, isPublisher, looksLikeSeller, buyerAsk, companyKey } from './rules.js';
import { unsupportedClaims } from './claims.js';
// the owner's press on "Approve and send" as the page makes it: fetch the stored draft, show it, post back what was shown
const shownSend = async (t, id) => (await t.call(`/api/m/sales/drafts/${id}`)).json.send;
const pressSend = async (t, id) => t.call(`/api/m/sales/drafts/${id}/send`, { body: await shownSend(t, id) });

test('code checks on extracted rows: never keeps what the page did not say', () => {
  const page = { url: 'https://example.com/a', title: 'Makers', text: 'Acme Controls Pvt Ltd builds PLC panels in Pune. Call Ravi Kumar, plant head.' };
  const ok = checkRow({ company: 'Acme Controls Pvt Ltd', contact_name: 'Ravi Kumar', contact_role: 'plant head', email: 'ravi@acme.in', need: 'PLC panels', kind: 'company', fits: true }, page, { query: 'x' });
  assert.equal(ok.company, 'Acme Controls Pvt Ltd'); assert.equal(ok.contactName, 'Ravi Kumar'); assert.equal(ok.email, '', 'an email not on the page is dropped');
  assert.equal(checkRow({ company: 'Invented Industries', kind: 'company', fits: true }, page, {}).reject, 'not named on the page');
  assert.match(checkRow({ company: 'Acme Controls', kind: 'brand', fits: true }, page, {}).reject, /brand/);
  assert.equal(checkRow({ company: 'Acme Controls', fits: true }, page, {}).reject, 'not described as a company');
  for (const [a, b] of [['Kestrel India', 'Kestrel Ltd.'], ['Orion Drives India Ltd.', 'Orion Drives'], ['Marlow Automation India Pvt. Ltd.', 'Marlow Automation'], ['T&K Industrial Automation (A member of Orion Group)', 'T&K Industrial Automation GmbH']]) assert.equal(companyKey(a), companyKey(b), a);
  assert.notEqual(companyKey('Orion'), companyKey('T&K Industrial Automation'));
  assert.deepEqual(unsupportedClaims("Hello, I am Arun. I saw your new plant in Pune. Could we have 15 minutes next week?", ''), []);
  assert.equal(unsupportedClaims("We've helped other companies streamline operations.", '').length, 1);
  assert.deepEqual(unsupportedClaims('We have helped 40 plants cut changeover time.', 'We have helped 40 plants cut changeover time.'), []);
  assert.equal(checkRow({ company: 'Acme Controls', fits: false }, page, {}).reject, 'does not fit');
  assert.ok(textNames('Harlow &amp; Penn Limited is', 'Harlow & Penn Ltd.'));
  assert.ok(isPublisher('Harbour Times', 'https://harbourtimes.example/x'));
  assert.equal(buyerAsk('Find buyers of tile adhesive in Kochi'), 'tile adhesive');
  assert.ok(looksLikeSeller('Tile adhesive manufacturers in Kochi', 'tile adhesive'));
});

test('drafts wait, no approval until the press, deny keeps, Mail off never sends, one draft per lead', async () => {
  const t = await testDesk({ modules: ['sales'], script: () => ({ text: JSON.stringify({ subject: 'Hello', body: 'A short note about your line sensors. Would a call help?' }) }) });
  try {
    const a = (await t.call('/api/m/sales/leads', { body: { company: 'Orbit Components', email: 'v.rao@orbit.example', contactOther: 'Contact page: https://orbit.example/contact ' + 'word '.repeat(400) } })).json.lead;
    assert.ok(a.contactOther.length > 200 && a.contactOther.length <= 1000 && /word$/.test(a.contactOther), 'contact text holds 1,000 characters and is never cut mid-word');
    assert.equal((await t.call('/api/m/sales/leads', { body: { company: 'Orbit Components' } })).json.lead.duplicate, true);
    const r = await t.core.modules.runTool('outreach_draft', { top: 5 }, { agentId: 'coordinator' });
    assert.equal(r.drafts.length, 1); const d = r.drafts[0];
    assert.equal(t.core.approval.listPending().length, 0, 'saving a draft creates no send approval');
    assert.equal((await t.call(`/api/m/sales/leads/${a.id}`)).json.lead.stage, 'drafted');
    const again2 = await t.core.modules.runTool('outreach_draft', { leadIds: [a.id] }, {});
    assert.equal(again2.drafts.length, 0); assert.match(again2.text, /Orbit Components already has a draft waiting/);
    assert.equal((await t.call('/api/m/sales/state')).json.drafts.length, 1, 'one open draft per lead and channel');
    await t.call(`/api/m/sales/drafts/${d.draftId}`, { method: 'PATCH', body: { body: 'Edited text. Would a call help?' } });
    assert.equal(t.core.approval.listPending().length, 0, 'editing a draft creates no send approval');
    const press = (await pressSend(t, d.draftId)).json;
    assert.equal(t.core.approval.listPending().length, 1, 'the press asks');
    assert.equal(t.core.approval.listPending()[0].payload.body, 'Edited text. Would a call help?');
    assert.equal((await t.call(`/api/approvals/${press.approvalId}/deny`, { method: 'POST' })).status, 200);
    await new Promise(r => setTimeout(r, 100));
    assert.equal((await t.call('/api/m/sales/state')).json.drafts[0].status, 'not sent');
    const again = await pressSend(t, d.draftId);
    await t.call(`/api/approvals/${again.json.approvalId}/approve`, { method: 'POST' }); await new Promise(r => setTimeout(r, 100));
    const dr = (await t.call('/api/m/sales/state')).json.drafts[0];
    assert.equal(dr.status, 'approved'); assert.match(dr.note, /switch on Mail/);
    assert.equal((await t.call('/api/m/sales/leads', { body: { company: 'X' }, session: false })).status, 403, 'only the owner changes data');
    await t.call(`/api/m/sales/leads/${a.id}/move`, { body: { stage: 'In talks' } });
    assert.equal((await t.call('/api/m/sales/state')).json.totals.inTalks, 1);
    const f = await t.core.modules.runTool('leads_find', { query: 'x' }, {});
    assert.equal(f.ok, false); assert.match(f.text, /Search is switched off/);
    t.core.settings.set('online', false);
    const jobsBefore = t.core.jobs.list().length;
    const off = await t.core.modules.runTool('leads_find', { query: 'x' }, {});
    assert.equal(off.text, 'The desk is offline. Finding leads needs the internet.'); assert.equal(t.core.jobs.list().length, jobsBefore, 'no search job starts offline');
  } finally { await t.close(); }
});

test('draft replies: subject and body kept apart for fenced, raw, prose-wrapped and truncated replies', async () => {
  const { parseDraftReply, bodyProblem } = await import('./parse.js');
  const fenced = parseDraftReply('```json\n{"subject": "A note for Kavya Labs", "body": "Hello,\\nI saw your plant in Pune. Could we talk?"}\n```');
  assert.equal(fenced.subject, 'A note for Kavya Labs'); assert.equal(fenced.body, 'Hello,\nI saw your plant in Pune. Could we talk?');
  const raw = parseDraftReply('{"subject":"S one","body":"Hello there. A question?"}');
  assert.equal(raw.subject, 'S one'); assert.equal(raw.body, 'Hello there. A question?');
  const prose = parseDraftReply("Here is your draft:\n{'subject': 'S two', 'body': 'Hello. Would a call help?',}\nLet me know!");
  assert.equal(prose.subject, 'S two'); assert.equal(prose.body, 'Hello. Would a call help?');
  const plain = parseDraftReply('Subject: Quick note\n\nHello, I saw your plant. Could we talk?');
  assert.equal(plain.subject, 'Quick note'); assert.equal(plain.body, 'Hello, I saw your plant. Could we talk?');
  for (const cut of ['{"subject": "S", "body": "Hello, I saw', '```json\n{"subject": "S",', '{"subject":"S","body":"{\\"subject\\": \\"x\\", \\"body\\": \\"y\\"}"}']) assert.ok(parseDraftReply(cut).error, cut);
  for (const b of ['{"subject": "x"', 'Subject: hi\nHello', 'Hello "body": "x"', 'Hello,\\nline']) assert.ok(bodyProblem(b), b);
  assert.equal(bodyProblem('Hello,\n\nI saw your plant: it is large. Could we talk?'), '');
  // truncation is known only from the model door's cutOff, never guessed from letters or end punctuation
  assert.match(parseDraftReply('Hello, I saw that Kavya Labs has grown into a leading company focusing on generic drugs', null, { cutOff: true }).error, /cut off/);
  assert.equal(parseDraftReply('Hello, I saw that Kavya Labs has grown. Could we talk?', null, { cutOff: false }).body, 'Hello, I saw that Kavya Labs has grown. Could we talk?');
  assert.equal(bodyProblem('Hello,\n\nCould we talk next week?\n\nBest regards,\nArun Rao'), '');
  assert.ok(parseDraftReply('{"subject": "S", "body": "Hello, I saw', { subject: 'S', body: 'Hello, I saw' }).error, 'a repaired cut-off reply is not trusted');
});

test('draft parser is script-agnostic: Indian languages, lower-case starts, emoji, sign-offs, quotes and To:/From: inside the text', async () => {
  const { parseDraftReply, bodyProblem } = await import('./parse.js');
  const good = [
    'नमस्ते रवि जी, क्या हम अगले हफ़्ते बात कर सकते हैं?',
    'वणक्कम் ரவி, அடுத்த வாரம் பேசலாமா?'.replace('वणक्कम्', 'வணக்கம்'),
    'നമസ്കാരം രവി, അടുത്ത ആഴ്ച സംസാരിക്കാമോ?',
    'hello Ravi, could we talk next week?',
    'Hi Ravi, saw your new plant in Pune. Free for a quick call? 🙏',
    'Hello Ravi, can we talk? Thanks',
    'Hello Ravi, you wrote "we need faster changeovers"',
    'Hello Ravi,\nI saw this note on your site:\nTo: all suppliers\nFrom: the plant office\nCould we talk about it?',
    '15 minutes next week would be enough. Could we talk?',
    '👋 Ravi, a quick question about your line sensors?',
    '"Faster changeovers" was the line on your site. Could we talk?',
    'Hello Ravi (plant head)',
  ];
  for (const b of good) {
    assert.equal(bodyProblem(b), '', b);
    assert.equal(parseDraftReply(JSON.stringify({ body: b }), null, { needSubject: false }).body, b, b);
  }
  const hi = parseDraftReply(JSON.stringify({ subject: 'एक छोटा सवाल', body: good[0] }));
  assert.equal(hi.subject, 'एक छोटा सवाल'); assert.equal(hi.body, good[0]);
  // still refused: raw JSON, braces-and-quotes, code fence, header-only, leading header block, empty, unclosed JSON, cutOff
  for (const b of ['{"subject": "x"', '[1, 2]', 'Hello "body": "x"', 'Hello {"a": "b"} there', '```\nHello\n```', 'Subject: hi', 'To: ravi@acme.in\nFrom: me', 'Subject: hi\nHello', 'To: ravi@acme.in\nHello Ravi, could we talk?', '', '   ', 'Hello,\\nline']) assert.ok(bodyProblem(b), JSON.stringify(b));
  assert.match(parseDraftReply('{"body": "नमस्ते रवि जी, क्या').error, /cut off/);
  assert.match(parseDraftReply(JSON.stringify({ body: good[0] }), null, { cutOff: true }).error, /cut off/);
});

test('a draft reply cut off at the length limit is retried, a whole one without end punctuation is saved', async () => {
  let calls = 0;
  const t = await testDesk({ modules: ['sales'], script: () => { calls++; return calls === 1 ? { text: JSON.stringify({ body: 'Hello Ravi, I saw your plant and wanted to ask whether' }), finish: 'length' } : { text: JSON.stringify({ body: 'Hi Ravi, free for a quick call this week? 🙏' }) }; } });
  try {
    const a = (await t.call('/api/m/sales/leads', { body: { company: 'Kavya Labs', contactName: 'Ravi', phone: '+91 98450 00000' } })).json.lead;
    const r = await t.core.modules.runTool('outreach_draft', { leadIds: [a.id], channel: 'whatsapp' }, {});
    assert.equal(calls, 2, 'the cut-off reply was retried once');
    assert.equal(r.drafts.length, 1, r.text);
    const d = (await t.call('/api/m/sales/state')).json.drafts[0];
    assert.equal(d.body, 'Hi Ravi, free for a quick call this week? 🙏');
  } finally { await t.close(); }
});

test('a reply that is raw JSON twice is refused, not saved; fenced replies save cleanly; LinkedIn text is copy-only', async () => {
  let mode = 'cut'; let calls = 0;
  const t = await testDesk({ modules: ['sales'], script: () => { calls++; return { text: mode === 'cut' ? '{"subject": "Hello Kavya Labs", "body": "Hello, I saw' : mode === 'fenced' ? 'Sure!\n```json\n{"subject": "A note for Kavya Labs", "body": "Hello,\\nI saw your plant. Could we talk?"}\n```' : '{"body": "Hello, I saw your plant. Open to a quick chat?"}' }; } });
  try {
    const a = (await t.call('/api/m/sales/leads', { body: { company: 'Kavya Labs', email: 'x@kavyalabs.example' } })).json.lead;
    const bad = await t.core.modules.runTool('outreach_draft', { leadIds: [a.id] }, {});
    assert.equal(bad.drafts.length, 0); assert.equal(calls, 2, 'one retry'); assert.match(bad.text, /could not be read as a subject and a message/);
    assert.equal((await t.call('/api/m/sales/state')).json.drafts.length, 0, 'nothing saved');
    mode = 'fenced';
    const ok = await t.core.modules.runTool('outreach_draft', { leadIds: [a.id] }, {});
    const d = (await t.call('/api/m/sales/state')).json.drafts[0];
    assert.equal(ok.drafts.length, 1); assert.equal(d.subject, 'A note for Kavya Labs'); assert.equal(d.body, 'Hello,\nI saw your plant. Could we talk?'); assert.ok(!/subject|[{}"]/i.test(d.body));
    mode = 'li';
    const li = await t.core.modules.runTool('outreach_draft', { leadIds: [a.id], channel: 'linkedin' }, {});
    const l = (await t.call('/api/m/sales/state')).json.drafts.find(x => x.channel === 'linkedin');
    assert.equal(li.drafts.length, 1); assert.equal(l.status, 'copy'); assert.equal(l.subject, ''); assert.equal(l.to, ''); assert.equal(l.approvalId, null);
    assert.match(li.text, /ready to copy/); assert.equal(t.core.approval.listPending().length, 0, 'no approval for copy-only text');
    assert.equal((await t.call(`/api/m/sales/drafts/${l.id}/send`, { body: { to: 'a@x.example', subject: '', body: l.body } })).status, 409, 'nothing can send it');
    assert.equal((await t.call('/api/m/sales/state')).json.totals.draftsWaiting, 1, 'copy-only text is not a draft waiting to be sent');
  } finally { await t.close(); }
});

test('lead quality: Wikipedia alone is not enough, no wrong-country site, the need comes from the page', async () => {
  const { findLeads, checkSites, checkRow } = await import('./find.js');
  const { wrongCountrySite, askCountry, needOnPage } = await import('./rules.js');
  const pad = ' More about the firm and its work in India.'.repeat(8);
  const pages = { 'https://en.wikipedia.org/wiki/Acme_Pharma': 'Acme Pharma is an Indian pharmaceutical company.' + pad, 'https://list.example/pharma': 'Beta Labs is an Indian pharmaceutical company making generics.' + pad };
  const search = { async search(q) { return /official website/.test(q) ? [] : [{ url: 'https://en.wikipedia.org/wiki/Acme_Pharma' }, { url: 'https://list.example/pharma' }]; }, async read(u) { if (!pages[u]) throw new Error('404'); return { url: u, title: 'Page', text: pages[u] }; } };
  const model = { async chat({ purpose, messages }) { if (purpose === 'plan') return { json: { queries: ['q'] } }; const t = messages[1].content; return { json: { leads: ['Acme Pharma', 'Beta Labs'].filter(n => t.includes(n)).map(n => ({ page: 0, company: n, kind: 'company', fits: true, need: 'pharmaceutical company' })) } }; } };
  const r = await findLeads({ query: 'Indian pharmaceutical companies', count: 2, search, model, budget: { extraRounds: 0, firstRounds: 1 } });
  assert.deepEqual(r.leads.map(l => l.company), ['Beta Labs']);
  assert.match(r.reason, /1 was left out because only a Wikipedia page named it/);
  // wrong country: northwind-pharma.de is never taken for an Indian company; northwind-pharma.com is
  const country = askCountry('Indian pharmaceutical companies');
  assert.ok(wrongCountrySite('https://www.northwind-pharma.de/', country)); assert.ok(!wrongCountrySite('https://northwind-pharma.com/', country)); assert.ok(!wrongCountrySite('https://www.kestrel-controls.com/in/en/', country));
  const sites = { 'https://www.northwind-pharma.de/': 'Northwind Pharma Deutschland. Pharmaceutical products.' + pad, 'https://northwind-pharma.com/': 'Northwind Pharma is a pharmaceutical company headquartered in Mumbai.' + pad };
  const s2 = { async search() { return [{ url: 'https://www.northwind-pharma.de/' }, { url: 'https://northwind-pharma.com/' }]; }, async read(u) { if (!sites[u]) throw new Error('404'); return { url: u, title: 'Northwind Pharma', text: sites[u] }; } };
  const leads = [{ company: 'Northwind Pharma', need: 'pharmaceutical company', sources: [{ url: 'https://list.example/pharma', title: 'List' }], findings: '' }];
  const cs = await checkSites({ leads, search: s2, query: 'Indian pharmaceutical companies' });
  assert.equal(leads[0].website, 'https://northwind-pharma.com'); assert.equal(cs.wrongCountry, 1);
  const { siteCountry, emailCountry } = await import('./rules.js');
  assert.ok(wrongCountrySite('https://kavyalabsusa.com/', country), 'a US site is not taken for an Indian company'); assert.equal(siteCountry('https://www.tarangpharma.co.in/'), 'in'); assert.equal(siteCountry('https://www.kavyalabs.com/'), '');
  assert.equal(emailCountry('info.de@northwind-pharma.com'), 'de'); assert.equal(emailCountry('info@kavyalabs.com'), '');
  const sites3 = { 'https://northwind-pharma.com/': 'Northwind Pharma is a pharmaceutical company headquartered in Mumbai. Germany: info.de@northwind-pharma.com. India: corpcomm@northwind-pharma.com.' + pad };
  const s3 = { async search() { return [{ url: 'https://northwind-pharma.com/' }]; }, async read(u) { const o = new URL(u).origin + '/'; if (!sites3[o]) throw new Error('404'); return { url: u, title: 'Northwind Pharma', text: sites3[o] }; } };
  const l3 = [{ company: 'Northwind Pharma', need: 'pharmaceutical company', sources: [{ url: 'https://list.example/pharma', title: 'List' }], findings: '' }];
  await checkSites({ leads: l3, search: s3, query: 'Indian pharmaceutical companies' });
  assert.equal(l3[0].email, 'corpcomm@northwind-pharma.com', 'the German desk address is not taken');
  // the need must be on the page that names the company
  const page = { url: 'https://list.example/x', title: 'Builders', text: 'Stonebridge Projects is a construction and engineering company building marine structures.' };
  assert.equal(checkRow({ company: 'Stonebridge Projects', kind: 'company', fits: true, need: 'Cement manufacturer and exporter' }, page, {}).need, '', 'a sector the page did not say is left empty');
  assert.equal(checkRow({ company: 'Stonebridge Projects', kind: 'company', fits: true, need: 'Construction and engineering company' }, page, {}).need, 'Construction and engineering company');
  assert.ok(needOnPage('HR software', 'x'));
});

test('short of the count: more rounds, then a plain reason (stub search and model, plumbing only)', async () => {
  const { findLeads } = await import('./find.js');
  const pages = { 'https://a.example/list': 'Acme Controls Pvt Ltd, based in Pune, makes PLC panels. Beta Drives Ltd is an Indian maker of motor drives. Beta Drives India is the same company.', 'https://b.example/more': 'Gamma Robotics is a Chennai-based maker of robot cells. Delta Sensors, based in Pune, makes sensors.' };
  const searched = [];
  const search = { async search(q) { searched.push(q); return searched.length === 1 ? [{ url: 'https://a.example/list', title: 'List' }] : searched.length === 4 ? [{ url: 'https://b.example/more', title: 'More' }] : []; },
    async read(u) { if (!pages[u]) throw new Error('404'); return { url: u, title: 'Page', text: pages[u] + ' '.repeat(10) + 'x'.repeat(200) }; } };
  const model = { async chat({ purpose, messages }) {
    if (purpose === 'plan') return { json: { queries: ['q one', 'q two'] }, label: 'stub' };
    const txt = messages[1].content; const rows = [];
    for (const [n, name] of [['1', 'Acme Controls Pvt Ltd'], ['1', 'Beta Drives Ltd'], ['1', 'Beta Drives India'], ['1', 'Invented Corp'], ['1', 'Gamma Robotics'], ['1', 'Delta Sensors']]) if (name === 'Invented Corp' || txt.includes(name.split(' ')[0])) rows.push({ page: 0, company: name, kind: 'company', fits: true, need: 'automation' });
    return { json: { leads: rows }, label: 'stub' };
  } };
  const r = await findLeads({ query: 'Find 6 automation companies in India', count: 6, search, model, budget: { siteMinutes: 0 } });
  assert.ok(r.rounds >= 2, 'searched new ways when dry'); assert.ok(r.searches > 3);
  assert.equal(r.leads.length, 4);
  assert.match(r.reason, /pages read from \d+ searches/); assert.match(r.reason, /duplicate/); assert.match(r.reason, /did not name/);
});

test('own-site step: a same-name site about something else is not taken; glued addresses are dropped (fixture pages)', async () => {
  const { checkSites } = await import('./find.js');
  const { emailsOn, strictEmail, sameCompany, topicWords } = await import('./rules.js');
  const site = {
    'https://www.kitebird.io/': { title: 'Kitebird: the macOS file archiver', text: 'Kitebird is the macOS file archiver. Compress and extract 7z, zip, rar files. Download Kitebird for Mac, free and open source. '.repeat(3) },
    'https://www.acmepay.in/': { title: 'Acme Pay: payroll for small firms', text: 'Acme Pay runs payroll and HR for small businesses in India. Write to cn-sales@acmepay.inwebsite or sales@acmepay.in today. '.repeat(2) },
  };
  const search = { async search(q) { return q.startsWith('Kitebird') ? [{ url: 'https://www.kitebird.io/' }] : [{ url: 'https://www.acmepay.in/' }]; }, async read(u) { const p = site[u]; if (!p) throw new Error('404'); return { url: u, ...p }; } };
  const list = { title: 'Top HR software in India', url: 'https://list.example/hr' };
  const leads = [{ company: 'Kitebird', need: 'HR and payroll software', sources: [list], findings: '' }, { company: 'Acme Pay', need: 'payroll software', sources: [list], findings: '' }];
  const r = await checkSites({ leads, search, query: 'Indian companies selling HR or payroll software to small businesses', fetchHtml: async (u) => u.includes('acmepay') ? '<a href="mailto:hello@acmepay.in">Mail us</a>' : '' });
  assert.equal(leads[0].sources[0].url, list.url, 'the archiver site is not taken for Kitebird');
  assert.equal(r.wrongBusiness, 1);
  assert.equal(leads[1].sources[0].url, 'https://www.acmepay.in/');
  assert.equal(leads[1].email, 'hello@acmepay.in', 'a mailto: link wins');
  assert.deepEqual(emailsOn('Contact cn-sales@nimbuscorp.comwebsite for more'), [], 'an address glued to a word is dropped');
  assert.deepEqual(emailsOn('noreply@tealbirdhr.ai or sales@quillpayhr.com'), ['sales@quillpayhr.com'], 'no-reply addresses are not contacts');
  const { unsupportedClaims } = await import('./claims.js');
  const { greetingNameProblems } = await import('./claims.js');
  assert.equal(greetingNameProblems('Hello Meera, I came across Northwind HR.', '').length, 1, 'a greeting name the lead did not give');
  assert.equal(greetingNameProblems('Hello Ravi, I saw your plant.', 'Ravi Kumar').length, 0);
  assert.equal(greetingNameProblems('Hello, I came across X.', '').length, 0);
  assert.equal(unsupportedClaims('Hello, I\u2019m the founder of a SaaS company that builds tools for HR teams.', '').length, 1, 'curly apostrophe and founder claims are caught');
  assert.equal(strictEmail('cn-sales@nimbuscorp.comwebsite'), '');
  assert.deepEqual(emailsOn('Mail <b>sales@nimbuscorp.com</b>website', '', '<p>Mail <b>sales@nimbuscorp.com</b>website</p>'), ['sales@nimbuscorp.com'], 'tags turned into spaces');
  const { sameBusiness } = await import('./rules.js');
  assert.ok(!sameBusiness('Hivelink Broadband: fibre internet plans, 24 hrs support, call us.', ['hr', 'payroll']), 'a broadband namesake with "hrs" is not an HR business');
  assert.ok(sameBusiness('Hivelink HR: HR software for multi-location teams.', ['hr', 'payroll']));
  const ask = topicWords('Indian companies selling HR or payroll software to small businesses');
  assert.ok(sameCompany('Kolam', 'Kolam HR', ask)); assert.ok(sameCompany('quillHR', 'quillHR Payroll Software', ask));
  assert.ok(!sameCompany('Orion', 'T&K Industrial Automation'));
  const { mergeSellers } = await import('./find.js');
  const nimbus = [
    { company: 'Nimbus People', need: 'HR system with attendance', findings: '', ownSite: true, website: 'https://www.nimbus.example', sources: [{ url: 'https://www.nimbus.example/people/' }] },
    { company: 'Nimbus Payroll', need: 'payroll software for small businesses', findings: '', ownSite: true, website: 'https://www.nimbus.example', sources: [{ url: 'https://www.nimbus.example/payroll/' }] },
    { company: 'Kolam HR', need: 'payroll and attendance', findings: '', ownSite: true, website: 'https://www.kolam.example', sources: [{ url: 'https://www.kolam.example/' }] }];
  assert.equal(mergeSellers(nimbus, 'Indian companies selling HR or payroll software to small businesses'), 1);
  assert.equal(nimbus.length, 2, 'one Nimbus row');
  assert.ok(nimbus.some(l => /^Nimbus/.test(l.company) && /Also listed as Nimbus/.test(l.need) && l.sources.length === 2), JSON.stringify(nimbus));
  const listed = [
    { company: 'Acme Payroll', need: 'payroll', findings: '', ownSite: false, website: 'https://leadsdir.example', sources: [{ url: 'https://leadsdir.example/companies/hr' }] },
    { company: 'Beta HR', need: 'HR', findings: '', ownSite: false, website: 'https://leadsdir.example', sources: [{ url: 'https://leadsdir.example/companies/hr' }] },
    { company: 'Gamma HRMS', need: 'HRMS', findings: '', sources: [{ url: 'https://www.listhub.example/list/best-hr-software/' }] }];
  assert.equal(mergeSellers(listed, 'HR or payroll software'), 0, 'companies on a shared directory or list page stay separate');
  assert.equal(listed.length, 3);
});

test('one seller by name alone: a brand word plus only product or field words merges even without own sites; distinct remainders stay apart', async () => {
  const { mergeSellers } = await import('./find.js');
  const { sameSeller } = await import('./rules.js');
  const ask = 'Indian companies that sell HR or payroll software to small businesses';
  const nimbus = [
    { company: 'Nimbus People', need: 'HR system with attendance', findings: '', ownSite: false, website: '', sources: [{ url: 'https://blog.example/best-hr-software-india/' }] },
    { company: 'Kolam HR', need: 'payroll and attendance', findings: '', ownSite: false, website: '', sources: [{ url: 'https://top.example/top-hr-software/' }] },
    { company: 'Nimbus Payroll', need: 'payroll software for small businesses', findings: '', ownSite: false, website: '', sources: [{ url: 'https://top.example/top-hr-software/' }] }];
  assert.equal(mergeSellers(nimbus, ask), 1);
  assert.equal(nimbus.length, 2, JSON.stringify(nimbus));
  const z = nimbus.find(l => /^Nimbus/.test(l.company));
  assert.match(z.need, /\. Also listed as Nimbus (People|Payroll)\.$/); assert.equal(z.sources.length, 2);
  const lead = (company) => ({ company, need: '', findings: '', ownSite: false, website: '', sources: [{ url: 'https://list.example/x' }] });
  assert.equal(sameSeller(lead('quillHR'), lead('quillHR Payroll'), ['hr', 'payroll']), true);
  for (const [a, b] of [['Varma Consultancy', 'Varma Motors'], ['Kestrel India', 'Kestrel Healthcare'], ['Nimbus People', 'Nimbus Expense'], ['HR One', 'HR Mantra'], ['Payroll Pro', 'Payroll Cloud']]) assert.equal(sameSeller(lead(a), lead(b), ['hr', 'payroll']), false, `${a} / ${b}`);
  const pair = [lead('Varma Consultancy'), lead('Varma Motors')];
  assert.equal(mergeSellers(pair, ask), 0); assert.equal(pair.length, 2);
});

test('a merge removes two rows; a refill round restores the count (stubs, plumbing only)', async () => {
  const { findLeads } = await import('./find.js');
  const pad = ' Trusted by teams across India.'.repeat(10);
  const pages = {
    'https://list.example/a': 'Nimbus People is HR software. Nimbus Payroll runs payroll. Nimbus Expense handles HR expenses. Acme HR sells HR software.' + pad,
    'https://list.example/b': 'Beta Payroll sells payroll software to small firms. Gamma HR sells HR software. Delta HRMS sells HR software.' + pad,
    'https://www.nimbus.example/': 'Nimbus HR and payroll software: Nimbus People, Nimbus Payroll and Nimbus Expense for small businesses.' + pad,
    'https://www.acmehr.example/': 'Acme HR builds HR software for small teams.' + pad,
  };
  let listCalls = 0;
  const search = {
    async search(q) {
      if (/official website/.test(q)) return /^Nimbus/.test(q) ? [{ url: 'https://www.nimbus.example/' }] : /^Acme/.test(q) ? [{ url: 'https://www.acmehr.example/' }] : [];
      listCalls++;
      if (/alternatives to|association|exhibitors|companies (Pune|Chennai|Bengaluru)/.test(q)) return [{ url: 'https://list.example/b' }];
      return listCalls === 1 ? [{ url: 'https://list.example/a' }] : [];
    },
    async read(u) { const o = new URL(u).origin + '/'; const t = pages[u] || pages[o]; if (!t) throw new Error('404'); return { url: u, title: 'Indian HR software companies', text: t }; },
  };
  const names = ['Nimbus People', 'Nimbus Payroll', 'Nimbus Expense', 'Acme HR', 'Beta Payroll', 'Gamma HR', 'Delta HRMS'];
  const model = { async chat({ purpose, messages }) {
    if (purpose === 'plan') return { json: { queries: ['hr software india'] } };
    const t = messages[1].content;
    return { json: { leads: names.filter(n => t.includes(n)).map(n => ({ page: 0, company: n, kind: 'company', fits: true, need: 'HR and payroll software' })) } };
  } };
  const r = await findLeads({ query: 'Find 4 Indian companies selling HR or payroll software', count: 4, search, model, budget: { firstRounds: 1 } });   // first pass: one round only, so the gap must come from the refill
  assert.equal(r.leads.length, 4, `count holds: ${r.leads.map(l => l.company).join(', ')}; ${r.reason}`);
  assert.equal(r.rejected['merged as the same company'], 2, 'two Nimbus rows merged into one');
  assert.ok(r.extraRounds >= 1, 'a refill round ran');
  assert.ok(r.leads.some(l => /^Nimbus/.test(l.company) && /Also listed as Nimbus/.test(l.need)));
  assert.ok(r.leads.some(l => l.company === 'Beta Payroll') && r.leads.some(l => l.company === 'Gamma HR'), 'refills came from the new round');
  assert.equal(r.reason, '');
  // a lead already in the pipeline is skipped, does not count and leaves no gap
  listCalls = 0;
  const r2 = await findLeads({ query: 'Find 4 Indian companies selling HR or payroll software', count: 4, search, model, budget: { firstRounds: 1 }, existing: [{ company: 'Acme HR', website: 'https://www.acmehr.example' }] });
  assert.equal(r2.leads.length, 4, r2.leads.map(l => l.company).join(', '));
  assert.ok(!r2.leads.some(l => l.company === 'Acme HR'));
  assert.equal(r2.rejected['already in your pipeline'], 1);
});
test('reason wording for one and many already in the pipeline', async () => {
  const { findLeads } = await import('./find.js');
  const search = { async search() { return [{ url: 'https://l.example/x' }]; }, async read(u) { return { url: u, title: 'x', text: 'Acme HR and Beta HR sell HR software.' + ' Padding text.'.repeat(30) }; } };
  const model = { async chat({ purpose }) { return purpose === 'plan' ? { json: { queries: ['a'] } } : { json: { leads: [{ page: 0, company: 'Acme HR', kind: 'company', fits: true }, { page: 0, company: 'Beta HR', kind: 'company', fits: true }] } }; } };
  const one = await findLeads({ query: 'HR software', count: 3, search, model, budget: { siteMinutes: 0, extraRounds: 0 }, known: (n) => n === 'Acme HR' });
  assert.match(one.reason, /1 was already in your pipeline and skipped/);
  const many = await findLeads({ query: 'HR software', count: 3, search, model, budget: { siteMinutes: 0, extraRounds: 0 }, known: () => true });
  assert.match(many.reason, /2 were already in your pipeline and skipped/);
});

test('a broadband namesake (a home page fixture) is refused as the site of an HR software lead', async () => {
  const fs = await import('node:fs'); const { fileURLToPath } = await import('node:url');
  const page = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/broadband-namesake.json', import.meta.url)), 'utf8'));
  const { checkSites } = await import('./find.js');
  const { aboutSameBusiness, fieldHits, topicWords } = await import('./rules.js');
  const ASK = 'Find 20 leads with sources: Indian companies that sell HR or payroll software to small businesses.';
  assert.deepEqual(topicWords(ASK), ['hr', 'payroll']);
  assert.equal(aboutSameBusiness(page, topicWords(ASK)).ok, false, 'an internet provider is not an HR software business');
  const list = { title: 'Best HR software for small business', url: 'https://www.listhub.example/list/best-hr-software-small-business/' };
  for (const need of ['HR software for multi-location SMBs.', 'Suitable for multi-location SMBs with time tracking focus.']) {
    const leads = [{ company: 'Hivelink', need, sources: [list], findings: '' }];
    const r = await checkSites({ leads, search: { async search() { return [{ url: 'https://www.hivelink.net/' }]; }, async read(u) { return { ...page, url: u }; } }, query: ASK, fetchHtml: async () => '<a href="mailto:support@hivelink.net">Support</a>' });
    assert.equal(r.wrongBusiness, 1); assert.equal(leads[0].sources[0].url, list.url, 'the list source stays');
    assert.ok(!leads[0].website && !leads[0].email && !leads[0].ownSite, 'no site and no address from hivelink.net');
  }
  // the next candidate is tried: the real HR software company's site is taken instead of the namesake
  const l2 = [{ company: 'Hivelink', need: 'HR software for multi-location SMBs.', sources: [list], findings: '' }];
  const hr = { title: 'Top Payroll & Human Resource Software India | Hivelink HRMS', text: 'Hivelink HRMS is HR and payroll software for Indian companies. '.repeat(5) };
  const r2 = await checkSites({ leads: l2, query: ASK, search: { async search() { return [{ url: 'https://www.hivelink.net/' }, { url: 'https://www.hivelinksoftware.in/' }]; }, async read(u) { return u.includes('hivelink.net') ? { ...page, url: u } : { ...hr, url: u }; } } });
  assert.equal(l2[0].website, 'https://www.hivelinksoftware.in'); assert.equal(r2.own, 1);
  const { siteRoot } = await import('./rules.js');
  assert.equal(siteRoot('https://payroll.hrdesk-stage.in/login'), '', 'a staging host is never a company site');
  assert.equal(siteRoot('https://payroll.hivelinksoftware.in/'), 'https://www.hivelinksoftware.in'); assert.equal(siteRoot('https://in.paycorner.example/x'), 'https://in.paycorner.example'); assert.equal(siteRoot('https://www.kolam.example/hr'), 'https://www.kolam.example');
  // one stray mention is not enough; the title, the opening lines or several mentions are
  const stray = { title: 'Fast fibre internet', text: 'We sell broadband and home phone plans across the county. '.repeat(8) + 'Careers: we are hiring a payroll clerk.' };
  assert.equal(aboutSameBusiness(stray, ['hr', 'payroll']).ok, false);
  assert.ok(aboutSameBusiness({ title: 'Hivelink HRMS | HR and payroll software', text: 'x' }, ['hr', 'payroll']).ok);
  assert.ok(aboutSameBusiness({ title: 'Home', text: 'Welcome. '.repeat(60) + 'Our payroll module runs payroll for 500 firms. HR teams like it.' }, ['hr', 'payroll']).ok);
  assert.equal(fieldHits('open 24 hrs, 100 times faster, multiple devices', 'hr'), 0); assert.equal(fieldHits('HRMS and HR software', 'hr'), 2);
});
test('channel names are written properly in replies', async () => {
  const t = await testDesk({ modules: ['sales'], script: () => ({ text: '{"body": "Hello, I saw your plant. Open to a quick chat?"}' }) });
  try {
    const ids = []; for (const c of ['Alpha Works', 'Bravo Works']) ids.push((await t.call('/api/m/sales/leads', { body: { company: c } })).json.lead.id);
    assert.match((await t.core.modules.runTool('outreach_draft', { leadIds: ids, channel: 'linkedin' }, {})).text, /^2 LinkedIn messages ready to copy/);
    assert.match((await t.core.modules.runTool('outreach_draft', { leadIds: [ids[0]], channel: 'whatsapp' }, {})).text, /^1 WhatsApp message ready to copy/);
  } finally { await t.close(); }
});

// ---- regressions: the 20-lead case, language and count of drafts, no-address drafts, claims, the leads card, fit
const pad5 = ' Trusted by small teams across India for HR and payroll.'.repeat(8);
function stubSearch(t, pages, route) {
  const api = { async search(q) { return route(q); }, async read(u) { const p = pages[u]; if (!p) throw new Error('404'); return { url: u, title: 'HR software list', text: p }; } };
  t.core.modules.active.set('search', { handle: null, api });
}
const sys = (body) => String(body?.messages?.[0]?.content || '');
const usr = (body) => String(body?.messages?.slice(-1)[0]?.content || '');
function findScript(names) {
  return (body) => {
    const s = sys(body);
    if (/plan web searches/.test(s)) return { text: JSON.stringify({ queries: ['hr payroll software india'] }) };
    if (/list the real companies/.test(s)) { const u = usr(body); return { text: JSON.stringify({ leads: names.filter(n => u.includes(n)).map(n => ({ page: 0, company: n, kind: 'company', fits: true, need: 'HR and payroll software for small businesses' })) }) }; }
    return { text: '{"body": "Hello, I saw your page. Could we have a short call?"}' };
  };
}

test('the stored 20-lead case: "Quokka Payroll" and "QuokkaPayroll" are one company, merged and refilled; never "already in your pipeline" on an empty pipeline', async () => {
  const names = ['Acme HR', 'Quokka Payroll', 'QuokkaPayroll', 'Beta HR', 'Gamma HR', 'Delta HRMS'];
  const t = await testDesk({ modules: ['sales'], script: findScript(names) });
  try {
    stubSearch(t, { 'https://list.example/a': 'HR software companies based in India: Acme HR, Quokka Payroll, QuokkaPayroll and Beta HR sell HR software.' + pad5, 'https://list.example/b': 'Payroll software companies based in India: Gamma HR and Delta HRMS sell payroll software.' + pad5 },
      (q) => /official website/.test(q) ? [] : /alternatives to|association|exhibitors|companies (Pune|Chennai|Bengaluru)/.test(q) ? [{ url: 'https://list.example/b' }] : /^hr payroll/.test(q) || /sell HR/.test(q) ? [{ url: 'https://list.example/a' }] : []);
    assert.equal((await t.call('/api/m/sales/leads')).json.leads.length, 0, 'the pipeline is empty before the ask');
    const s = await t.core.modules.runTool('leads_find', { query: 'Indian companies that sell HR or payroll software to small businesses', count: 4 }, { chatId: 'c1' });
    const job = await t.core.jobs.wait(s.jobId, 60000);
    const out = job.output;
    assert.equal(out.found, 4, `asked count restored: ${out.text}`);
    assert.doesNotMatch(out.text, /already in your pipeline/, out.text);
    assert.equal(out.reason, '', 'no reason line when the count is met');
    assert.ok(out.rejected['merged as the same company'] >= 1);
    const leads = (await t.call('/api/m/sales/leads')).json.leads;
    assert.equal(leads.filter(l => /^quokka ?payroll$/i.test(l.company)).length, 1);
    assert.ok(!out.card.actions.some(a => a.label === 'Add all to pipeline'), 'every row is already in the pipeline: no "Add all to pipeline"');
    // a second ask in the same field: the four known ones are skipped and counted truthfully
    const s2 = await t.core.modules.runTool('leads_find', { query: 'Indian companies that sell HR or payroll software to small businesses', count: 4 }, { chatId: 'c1' });
    const o2 = (await t.core.jobs.wait(s2.jobId, 60000)).output;
    if (o2.found < 4) assert.match(o2.reason, /already in your pipeline/); else assert.equal(o2.reason, '');
  } finally { await t.close(); }
});

test('fit: an ask about small businesses leaves out a lead its page describes as for enterprises only; both or neither is kept', async () => {
  const { segmentClash } = await import('./rules.js');
  const ASK = 'Find 20 leads with sources: Indian companies that sell HR or payroll software to small businesses.';
  assert.ok(segmentClash(ASK, 'Provides payroll software for large enterprises with compliance features.'));
  assert.ok(!segmentClash(ASK, 'Provides payroll software for Indian enterprises with compliance features.'), 'not a plain "for (large) enterprises": left to the model');
  // a case the earlier rule got wrong: a company name and "enterprise-grade" are not about who it serves
  assert.ok(!segmentClash('accounting software for small businesses in Pune', 'Sharma Enterprises is a family-run trading firm in Pune.'));
  assert.ok(!segmentClash(ASK, 'Offers enterprise-grade security for growing teams'));
  for (const x of ['Enterprise-class payroll', 'Enterprise-level reporting', 'Gupta Enterprises sells payroll software', 'Payroll for enterprises and small businesses', 'Built for enterprises, from MSMEs to large groups'])
    assert.ok(!segmentClash(ASK, x), x);
  for (const x of ['Payroll for enterprises', 'Enterprise customers only.', 'Trusted by Fortune 500 companies', 'Serves large corporations across Asia', 'HR built for large companies'])
    assert.ok(segmentClash(ASK, x), x);
  assert.ok(segmentClash(ASK, 'HR suite built for large organisations'));
  assert.ok(!segmentClash(ASK, 'Payroll for startups and enterprises alike'));
  assert.ok(!segmentClash(ASK, 'Payroll software with compliance features'));
  assert.ok(!segmentClash(ASK, 'HR software for small and medium enterprises'));
  assert.ok(!segmentClash('Indian HR software companies', 'for enterprises'), 'the ask names no size');
  const page = { url: 'https://list.example/x', title: 'HR software', text: 'Pinnacle HR provides payroll software for large enterprises with compliance features. Tidalpay provides payroll software for Indian startups.' };
  assert.equal(checkRow({ company: 'Pinnacle HR', kind: 'company', fits: true, need: 'Provides payroll software for large enterprises' }, page, { query: ASK }).reject, 'does not fit');
  assert.equal(checkRow({ company: 'Tidalpay', kind: 'company', fits: true, need: 'Provides payroll software for Indian startups' }, page, { query: ASK }).reject, undefined);
});

test('claims: first-person experience, clients, results and relationships are caught unless the offer says them; filler gets the plain default', async () => {
  const { fillerSentences, plainDefault } = await import('./claims.js');
  for (const x of ['I work closely with companies in this space.', 'We have helped many startups grow.', 'Our clients include large banks.', "I've seen how teams struggle with payroll.", 'We specialise in payroll outsourcing.', 'I help companies like yours.'])
    assert.equal(unsupportedClaims(x, '').length, 1, x);
  assert.deepEqual(unsupportedClaims("I've seen your page on payroll. Could we talk?", ''), []);
  assert.deepEqual(unsupportedClaims('We specialise in payroll outsourcing.', 'We specialise in payroll outsourcing for small firms.'), []);
  assert.equal(fillerSentences('Since you are working with this product, I wanted to connect. I would love to see how you approach your outreach.').length, 2);
  const d = plainDefault({ owner: 'Arun Rao', business: 'Rao Tech', company: 'Tidalpay', need: 'Provides low-cost payroll software for Indian startups. Also listed as Tidalpay HR.' });
  assert.match(d, /I am Arun Rao from Rao Tech\. I came across Tidalpay\. What I read about you: Provides low-cost payroll software for Indian startups\./);
  // a case the earlier rule got wrong: "I came across Acme: gST filing for 40 staff." The need's case is never changed.
  assert.match(plainDefault({ company: 'Acme', need: 'GST filing for 40 staff.' }), /I came across Acme\. What I read about you: GST filing for 40 staff\./);
  assert.match(plainDefault({ company: 'Acme', need: 'iPhone repair shops in Pune' }), /What I read about you: iPhone repair shops in Pune\./);
  assert.match(plainDefault({ company: 'Acme', need: 'provides payroll' }), /What I read about you: provides payroll\./); assert.match(d, /short call/); assert.doesNotMatch(d, /Also listed/);
  // in a real draft: a claim twice and filler twice -> the plain default, marked "check this"
  const t = await testDesk({ modules: ['sales'], script: () => ({ text: JSON.stringify({ subject: 'Hello', body: 'Hello,\n\nI work closely with companies in this space. Since you are working with this product, I wanted to connect.\n\nCould we talk?' }) }) });
  try {
    t.core.settings.set('ownerName', 'Arun Rao'); t.core.settings.set('companyName', 'Rao Tech');
    const a = (await t.call('/api/m/sales/leads', { body: { company: 'Tidalpay', need: 'Provides low-cost payroll software for Indian startups.' } })).json.lead;
    await t.core.modules.runTool('outreach_draft', { leadIds: [a.id] }, {});
    const dr = (await t.call('/api/m/sales/state')).json.drafts[0];
    assert.doesNotMatch(dr.body, /work closely|this product/); assert.match(dr.body, /I am Arun Rao from Rao Tech\. I came across Tidalpay/); assert.match(dr.note, /Check this/);
  } finally { await t.close(); }
});

test('drafts: language and script are checked, one retry then a plain refusal; "top 1" is the first row of the table in this chat', async () => {
  const { scriptProblem } = await import('./claims.js');
  assert.equal(scriptProblem('नमस्ते, मैं Kolam के बारे में लिख रहा हूँ। क्या हम कल बात कर सकते हैं?', 'Hindi', ['Kolam']), '');
  assert.match(scriptProblem('Hello, I am writing about Kolam. Could we talk?', 'Hindi', ['Kolam']), /not in Hindi/);
  assert.equal(scriptProblem('வணக்கம், நாம் பேசலாமா?', 'Tamil'), ''); assert.equal(scriptProblem('നമസ്കാരം, നമുക്ക് സംസാരിക്കാമോ?', 'Malayalam'), ''); assert.equal(scriptProblem('নমস্কার, আমরা কি কথা বলতে পারি?', 'Bengali'), '');
  assert.equal(scriptProblem('नमस्कार, आपण बोलू शकतो का?', 'Marathi'), ''); assert.equal(scriptProblem('Hello there', ''), '', 'no language: no check');
  let mode = 'hindi'; const prompts = [];
  const t = await testDesk({ modules: ['sales'], script: (body) => { prompts.push(sys(body) + '\n' + usr(body)); return { text: JSON.stringify({ body: mode === 'hindi' ? 'नमस्ते, मैंने आपकी वेबसाइट देखी। क्या हम छोटी सी बात कर सकते हैं?' : 'Hello, I saw your website. Could we talk?' }) }; } });
  try {
    const ids = []; for (const c of ['Alpha Works', 'Bravo Works', 'Charlie Works']) ids.push((await t.call('/api/m/sales/leads', { body: { company: c } })).json.lead.id);
    // the table last produced in chat c9 lists Charlie first, then Alpha
    await t.core.jobs.start({ kind: 'sales.find', title: 'Find', chatId: 'c9', input: {}, async run() { return { leadIds: [ids[2], ids[0]], found: 2 }; } });
    await new Promise(r => setTimeout(r, 100));
    const r = await t.core.modules.runTool('outreach_draft', { top: 1, channel: 'whatsapp', language: 'Hindi', chatId: 'c9' }, {});
    assert.equal(r.drafts.length, 1, 'top 1 makes exactly one draft'); assert.equal(r.drafts[0].company, 'Charlie Works', 'the first row of the table above');
    assert.match(r.text, /Taken: Charlie Works \(the first row of the table above\)/);
    assert.match(prompts[0], /in Hindi, in Devanagari script/);
    const d = (await t.call('/api/m/sales/state')).json.drafts[0]; assert.match(d.body, /[ऀ-ॿ]/);
    const again = await t.core.modules.runTool('outreach_draft', { top: 2, chatId: 'c9' }, {});
    assert.deepEqual(again.drafts.map(x => x.company), ['Charlie Works', 'Alpha Works'], 'top 2: the same table, in its order');
    // English twice for a Hindi ask: one retry, then refused with a plain line
    mode = 'english'; const n0 = prompts.length;
    const bad = await t.core.modules.runTool('outreach_draft', { leadIds: [ids[1]], channel: 'whatsapp', language: 'Hindi' }, {});
    assert.equal(bad.drafts.length, 0); assert.equal(prompts.length - n0, 2, 'one retry');
    assert.match(prompts[prompts.length - 1], /not in Hindi/); assert.match(bad.text, /The model did not write in Hindi; try again or pick another model/);
    // no chat table: the New lane in page order
    const fresh = await t.core.modules.runTool('outreach_draft', { top: 1, channel: 'linkedin' }, {});
    assert.equal(fresh.drafts[0].company, 'Bravo Works'); assert.match(fresh.text, /first lead in the New lane/);
  } finally { await t.close(); }
});

test('a draft with no address cannot be sent: the card says "Add an address" and the send press is refused', async () => {
  const t = await testDesk({ modules: ['sales'], script: () => ({ text: JSON.stringify({ subject: 'Hello', body: 'Hello, I saw your page. Could we talk?' }) }) });
  try {
    const a = (await t.call('/api/m/sales/leads', { body: { company: 'Nomail Works' } })).json.lead;
    const cards = []; const sink = t.core.jobs.cardSink; t.core.jobs.cardSink = (chatId, c) => { cards.push(c); try { sink?.(chatId, c); } catch {} };
    const r = await t.core.modules.runTool('outreach_draft', { leadIds: [a.id] }, { chatId: 'c1' });
    const card = cards.find(c => c.kind === 'sales.draft');
    assert.equal(card.to, ''); assert.equal(card.noAddress, true);
    const press = await pressSend(t, r.drafts[0].draftId);
    assert.equal(press.status, 409); assert.match(press.json.error, /no address/); assert.equal(t.core.approval.listPending().length, 0);
    await t.call(`/api/m/sales/drafts/${r.drafts[0].draftId}`, { method: 'PATCH', body: { to: 'hello@nomail.example' } });
    assert.equal((await pressSend(t, r.drafts[0].draftId)).status, 200, 'with an address the press asks');
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
    assert.match(src, /addr\(\) \? btn\('Approve and send'[^)]*\) : btn\('Add an address'/, 'chat card: Approve and send only with an address');
    assert.match(src, /dr\.to \|\| l\.email \? btn\('Approve and send'.*?: btn\('Add an address'/, 'Sales page: the same rule');
  } finally { await t.close(); }
});

// A tiny stand-in for the page: just enough DOM for the chat card and the confirm, wired to the test desk.
function fakeUi(t, { onConfirm } = {}) {
  const flat = (k) => k.flat(Infinity).filter(x => x != null && x !== false);
  const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs || {}, kids: flat(kids),
    replaceChildren(...k) { this.kids = flat(k); }, set textContent(v) { this.kids = [String(v)]; },
    get textContent() { return this.kids.map(k => typeof k === 'object' ? k.textContent : String(k)).join(''); } });
  const seen = { confirms: [], toasts: [] };
  const ui = { h, btn: (label, o = {}) => h('button', { onClick: o.onClick }, label), pill: (w) => h('span', null, w),
    api: async (path, o = {}) => { const r = await t.call('/api/' + path, o); if (r.status >= 400) throw Object.assign(new Error(r.json?.error || 'failed'), { status: r.status }); return r.json; },
    toast: (m) => seen.toasts.push(m), modal() {}, go() {},
    confirm: async (node) => { seen.confirms.push(node.textContent); return onConfirm ? onConfirm(node) : true; },
    decide: async (id, d) => (await t.call(`/api/approvals/${id}/${d}`, { method: 'POST' })).json };
  const find = (n, label) => !n || typeof n !== 'object' ? null : (n.tag === 'button' && n.textContent === label ? n : n.kids.map(k => find(k, label)).find(Boolean) || null);
  return { ui, seen, find };
}
async function mailDesk(script) {
  const { SMTPServer } = (await import('node:module')).createRequire(import.meta.url)('smtp-server');
  const got = [];
  const srv = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], logger: false, onData(s, sess, cb) { let raw = ''; s.on('data', c => { raw += c; }); s.on('end', () => { got.push({ to: sess.envelope.rcptTo[0].address, raw }); cb(); }); } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const t = await testDesk({ modules: ['sales', 'mail'], script });
  await t.call('/api/modules/mail/on', { method: 'POST' });
  await t.call('/api/m/mail/accounts', { body: { email: 'me@desk.test', smtp: { host: '127.0.0.1', port: srv.server.address().port, tls: 'none' } } });
  return { t, got, async close() { await t.close(); await new Promise(r => srv.close(r)); } };
}
const until = async (f) => { for (let i = 0; i < 40 && !f(); i++) await new Promise(r => setTimeout(r, 50)); };

test('approval integrity: a chat card made to a@x, the address changed to b@y in Sales: the confirm shows b@y and the new body, and only that Send sends, to b@y', async () => {
  const m = await mailDesk(() => ({ text: JSON.stringify({ subject: 'Hello', body: 'Old text. Could we talk?' }) }));
  const { t, got } = m;
  try {
    const { chatCards } = await import('./ui.js');
    const lead = (await t.call('/api/m/sales/leads', { body: { company: 'Asha Traders', email: 'a@x.example' } })).json.lead;
    const cards = []; const sink = t.core.jobs.cardSink; t.core.jobs.cardSink = (chatId, c) => { cards.push(c); try { sink?.(chatId, c); } catch {} };
    const r = await t.core.modules.runTool('outreach_draft', { leadIds: [lead.id] }, { chatId: 'c1' });
    const c = cards.find(x => x.kind === 'sales.draft'); assert.equal(c.to, 'a@x.example');
    await t.call(`/api/m/sales/drafts/${r.drafts[0].draftId}`, { method: 'PATCH', body: { to: 'b@y.example', body: 'New text for b. Could we talk?' } });
    let atConfirm = null;
    const { ui, seen, find } = fakeUi(t, { onConfirm: () => { atConfirm = { pending: t.core.approval.listPending().length, sent: got.length }; return true; } });
    const card = chatCards['sales.draft'](c, ui);
    assert.match(card.textContent, /To a@x\.example/, 'the old card as it was posted');
    await find(card, 'Approve and send').attrs.onClick({ currentTarget: {} });
    assert.equal(seen.confirms.length, 1);
    assert.match(seen.confirms[0], /To: b@y\.example/); assert.match(seen.confirms[0], /Subject: Hello/); assert.match(seen.confirms[0], /New text for b\. Could we talk\?/);
    assert.ok(!/a@x/.test(seen.confirms[0]) && !/Old text/.test(seen.confirms[0]), 'nothing of the old card in what is confirmed');
    assert.deepEqual(atConfirm, { pending: 0, sent: 0 }, 'nothing is asked or sent before the confirm\'s Send');
    assert.match(card.textContent, /To b@y\.example/, 'the card is repainted from the stored draft'); assert.match(card.textContent, /New text for b/);
    await until(() => got.length);
    assert.deepEqual(got.map(g => g.to), ['b@y.example']); assert.match(got[0].raw, /New text for b/);
    assert.deepEqual(seen.toasts, []);
  } finally { await m.close(); }
});

test('approval integrity: a draft edited between the confirm being shown and Send being pressed is refused; a bare press is refused; an address change on the lead withdraws the open ask', async () => {
  const m = await mailDesk(() => ({ text: JSON.stringify({ subject: 'Hello', body: 'First text. Could we talk?' }) }));
  const { t, got } = m;
  try {
    const { confirmAndSend } = await import('./ui.js');
    const lead = (await t.call('/api/m/sales/leads', { body: { company: 'Gupta Works', email: 'a@x.example' } })).json.lead;
    const id = (await t.core.modules.runTool('outreach_draft', { leadIds: [lead.id] }, {})).drafts[0].draftId;
    const { ui, seen } = fakeUi(t, { onConfirm: async () => { await t.call(`/api/m/sales/drafts/${id}`, { method: 'PATCH', body: { body: 'Edited while the confirm was open.' } }); return true; } });
    await assert.rejects(confirmAndSend(ui, id), /The draft changed\. Look at it again\./);
    assert.match(seen.confirms[0], /First text/);
    assert.equal(t.core.approval.listPending().length, 0, 'no approval asked'); await new Promise(r => setTimeout(r, 200)); assert.equal(got.length, 0, 'nothing sent');
    const stale = await t.call(`/api/m/sales/drafts/${id}/send`, { body: { to: 'a@x.example', subject: 'Hello', body: 'First text. Could we talk?' } });
    assert.equal(stale.status, 409); assert.equal(stale.json.error, 'The draft changed. Look at it again.');
    assert.equal((await t.call(`/api/m/sales/drafts/${id}/send`, { method: 'POST' })).status, 409, 'a press without what was shown is refused');
    // a draft with no own To goes to the lead's address. The ask is open; the lead's address changes: withdrawn.
    await t.call(`/api/m/sales/drafts/${id}`, { method: 'PATCH', body: { to: '' } });
    const shown = (await t.call(`/api/m/sales/drafts/${id}`)).json.send; assert.equal(shown.to, 'a@x.example');
    const ask = (await t.call(`/api/m/sales/drafts/${id}/send`, { body: shown })).json;
    assert.deepEqual(t.core.approval.forModule().get(ask.approvalId).payload, shown, 'the approval is for exactly what was shown');
    await t.call(`/api/m/sales/leads/${lead.id}`, { method: 'PATCH', body: { email: 'b@y.example' } });
    assert.equal(t.core.approval.forModule().get(ask.approvalId).status, 'aborted');
    assert.notEqual((await t.call(`/api/approvals/${ask.approvalId}/approve`, { method: 'POST' })).json.status, 'approved');
    await new Promise(r => setTimeout(r, 200)); assert.equal(got.length, 0, 'nothing sent to either address');
    // the same confirm again: now b@y with the edited text, and that sends
    const ok = fakeUi(t);
    assert.equal((await confirmAndSend(ok.ui, id)).status, 'approved');
    assert.match(ok.seen.confirms[0], /To: b@y\.example/); assert.match(ok.seen.confirms[0], /Edited while the confirm was open\./);
    await until(() => got.length); assert.deepEqual(got.map(g => g.to), ['b@y.example']);
  } finally { await m.close(); }
});

test('names: one key for the pipeline and the search; letters of every script are kept; an empty key matches nothing; "&" distinguishes', async () => {
  const { sameCompany, nameKey } = await import('./rules.js');
  assert.ok(!sameCompany('शर्मा ट्रेडर्स', 'गुप्ता एंटरप्राइजेज'), 'two Devanagari names are not one company');
  assert.ok(!sameCompany('कमल ट्रेडर्स', 'कोमल ट्रेडर्स'), 'vowel signs count');
  assert.ok(sameCompany('शर्मा ट्रेडर्स', 'शर्मा  ट्रेडर्स'));
  assert.ok(!sameCompany('A&B Traders', 'AB Traders')); assert.ok(sameCompany('A&B Traders', 'A and B Traders')); assert.ok(sameCompany('Quokka Payroll', 'QuokkaPayroll'));
  assert.ok(!sameCompany('!!!', '???')); assert.equal(nameKey('— —'), '');
  const t = await testDesk({ modules: ['sales'], script: () => ({ text: JSON.stringify({ subject: 'नमस्ते', body: 'नमस्ते, क्या हम बात कर सकते हैं?' }) }) });
  try {
    const a = (await t.call('/api/m/sales/leads', { body: { company: 'शर्मा ट्रेडर्स', email: 'a@sharma.example' } })).json.lead;
    const b = (await t.call('/api/m/sales/leads', { body: { company: 'गुप्ता एंटरप्राइजेज', email: 'b@gupta.example' } })).json.lead;
    assert.ok(!b.duplicate, 'a second Devanagari-named lead is saved'); assert.notEqual(a.id, b.id);
    assert.equal((await t.call('/api/m/sales/leads', { body: { company: 'शर्मा  ट्रेडर्स' } })).json.lead.duplicate, true, 'the same name is still one lead');
    assert.ok(!(await t.call('/api/m/sales/leads', { body: { company: 'AB Traders' } })).json.lead.duplicate);
    assert.ok(!(await t.call('/api/m/sales/leads', { body: { company: 'A&B Traders' } })).json.lead.duplicate);
    assert.equal((await t.call('/api/m/sales/leads', { body: { company: 'A and B Traders' } })).json.lead.duplicate, true);
    assert.equal((await t.call('/api/m/sales/leads', { body: { company: '!!!' } })).json.lead.duplicate, undefined);
    assert.ok(!(await t.call('/api/m/sales/leads', { body: { company: '???' } })).json.lead.duplicate, 'an empty key never equals anything');
    const r = await t.core.modules.runTool('outreach_draft', { leadIds: ['गुप्ता एंटरप्राइजेज'] }, {});
    assert.equal(r.drafts.length, 1); assert.equal(r.drafts[0].company, 'गुप्ता एंटरप्राइजेज', 'drafting by name picks that lead');
    await t.core.modules.runTool('pipeline_move', { company: 'गुप्ता एंटरप्राइजेज', stage: 'In talks' }, {});
    assert.equal((await t.call(`/api/m/sales/leads/${b.id}`)).json.lead.stage, 'talks'); assert.equal((await t.call(`/api/m/sales/leads/${a.id}`)).json.lead.stage, 'new');
  } finally { await t.close(); }
});

test('country fit: an ask about Indian companies leaves out a company when their own site or source page plainly places them elsewhere; silence keeps', async () => {
  const { checkSites, checkRow, findLeads } = await import('./find.js');
  const { placedElsewhere, askCountry } = await import('./rules.js');
  const ASK = 'Find 5 leads with sources: Indian companies that sell HR or payroll software to small businesses.';
  const IN = askCountry(ASK);
  assert.ok(placedElsewhere('Cedarline HR is an HR software company headquartered in Lehi, Utah.', 'Cedarline HR', IN));
  assert.ok(placedElsewhere('Farway Pay is headquartered in San Francisco, California.', 'Farway Pay', IN));
  assert.ok(placedElsewhere('We are based in Austin, Texas. Payroll for small teams.', 'Acme', IN));
  assert.ok(!placedElsewhere('Kolam is an HR software company headquartered in Hyderabad.', 'Kolam', IN));
  assert.ok(!placedElsewhere('Farway Pay is headquartered in San Francisco and has an office in Bengaluru, India.', 'Farway Pay', IN), 'a sign of India keeps it');
  assert.ok(!placedElsewhere('Cedarline HR makes HR software for small businesses.', 'Cedarline HR', IN), 'silence keeps');
  assert.ok(!placedElsewhere('Acme helps customers based in the USA.', 'Acme', IN), 'about its customers, not about the company');
  assert.ok(!placedElsewhere('Acme serves firms headquartered in Japan.', 'Acme', IN));
  assert.ok(!placedElsewhere('Cedarline HR is headquartered in Lehi, Utah.', 'Cedarline HR', askCountry('HR software companies')), 'the ask names no country');
  // the source page: only its sentences about this company count
  const page = { url: 'https://list.example/hr', title: 'Top HR software for small businesses in India', text: 'Top HR software for Indian small businesses. Cedarline HR is an HR software company headquartered in Lehi, Utah. Kolam is an HR software company for small businesses. Zinnia HR, based in Mumbai, runs payroll.' };
  assert.equal(checkRow({ company: 'Cedarline HR', kind: 'company', fits: true }, page, { query: ASK }).reject, 'does not fit');
  assert.equal(checkRow({ company: 'Kolam', kind: 'company', fits: true }, page, { query: ASK }).reject, undefined, 'the page says nothing about where Kolam is: kept');
  assert.equal(checkRow({ company: 'Zinnia HR', kind: 'company', fits: true }, page, { query: ASK }).reject, undefined);
  // the own-site step: Farway Pay's site says San Francisco and nothing of India; Acme Pay's names no place, only an Indian phone number
  const site = {
    'https://www.farwaypay.example/': { title: 'Farway Pay: global payroll and HR', text: 'Farway Pay runs global payroll and HR software for teams. Farway Pay is headquartered in San Francisco, California. Hire anyone, anywhere, with payroll and HR in one place. '.repeat(2) },
    'https://www.acmepay.example/': { title: 'Acme Pay: payroll for small firms', text: 'Acme Pay runs payroll and HR software for small businesses. Simple payroll for small teams, with HR built in. '.repeat(2) + 'Sales: +91 22 4000 1234.' },
  };
  const search = { async search(q) { return q.startsWith('Farway') ? [{ url: 'https://www.farwaypay.example/' }] : [{ url: 'https://www.acmepay.example/' }]; }, async read(u) { const p = site[u]; if (!p) throw new Error('404'); return { url: u, ...p }; } };
  const list = { title: 'HR software', url: 'https://list.example/hr' };
  const leads = [{ company: 'Farway Pay', need: 'payroll and HR software', sources: [list], findings: '' }, { company: 'Acme Pay', need: 'payroll software', sources: [list], findings: '' }];
  await checkSites({ leads, search, query: ASK });
  assert.equal(leads[0].elsewhere, true); assert.ok(!leads[1].elsewhere, 'silence keeps');
  // through the whole search (stubs): Farway Pay is left out as "does not fit", Acme Pay is kept
  const pad = ' Payroll and HR software for small businesses, compared.'.repeat(6);
  const pages = { 'https://list.example/hr': 'Farway Pay offers payroll and HR software. Acme Pay offers payroll and HR software for small businesses.' + pad };
  const s2 = { async search(q) { return /official website/.test(q) ? (q.startsWith('Farway') ? [{ url: 'https://www.farwaypay.example/' }] : [{ url: 'https://www.acmepay.example/' }]) : [{ url: 'https://list.example/hr' }]; },
    async read(u) { const k = u.replace(/\/$/, '') + '/'; if (site[k]) return { url: k, ...site[k] }; if (pages[u]) return { url: u, title: 'HR software', text: pages[u] }; throw new Error('404'); } };
  const model = { async chat({ purpose, messages }) { if (purpose === 'plan') return { json: { queries: ['q'] } }; const t = messages[1].content; return { json: { leads: ['Farway Pay', 'Acme Pay'].filter(n => t.includes(n)).map(n => ({ page: 0, company: n, kind: 'company', fits: true, need: 'payroll and HR software' })) } }; } };
  const r = await findLeads({ query: ASK, count: 2, search: s2, model, budget: { extraRounds: 0, firstRounds: 1 } });
  assert.deepEqual(r.leads.map(l => l.company), ['Acme Pay']); assert.equal(r.rejected['does not fit'], 1);
});

test('one lead search per chat at a time: a reworded repeat while the first runs returns the running job; after it ends a new one starts', async () => {
  const t = await testDesk({ modules: ['sales'], script: () => ({ text: '{}' }) });
  try {
    let release; const gate = new Promise(r => { release = r; });
    t.core.modules.active.set('search', { handle: null, api: { async search() { await gate; return []; }, async read() { throw new Error('404'); } } });
    const first = await t.core.modules.runTool('leads_find', { query: 'Indian companies that sell payroll software', count: 5 }, { chatId: 'c1' });
    assert.equal(first.ok, true); assert.ok(first.jobId);
    const jobsBefore = t.core.jobs.list().length;
    const again = await t.core.modules.runTool('leads_find', { query: 'payroll software makers based in India', count: 5 }, { chatId: 'c1' });
    assert.equal(t.core.jobs.list().length, jobsBefore, 'no second job for the same chat');
    assert.equal(again.jobId, first.jobId); assert.equal(again.already, true);
    assert.match(again.text, /A lead search is already running for this chat/); assert.match(again.text, /Find 5 leads: Indian companies that sell payroll software/);
    const other = await t.core.modules.runTool('leads_find', { query: 'payroll software makers based in India', count: 5 }, { chatId: 'c2' });
    assert.notEqual(other.jobId, first.jobId, 'another chat starts its own search');
    release();
    await t.core.jobs.wait(first.jobId, 60000); await t.core.jobs.wait(other.jobId, 60000);
    const later = await t.core.modules.runTool('leads_find', { query: 'payroll software makers based in India', count: 5 }, { chatId: 'c1' });
    assert.ok(later.jobId && later.jobId !== first.jobId && !later.already, 'a new search after the first has finished is allowed');
    await t.core.jobs.wait(later.jobId, 60000);
  } finally { await t.close(); }
});

test('country evidence: for an ask that names a country a lead is kept only when a page that was read places it there; the shortfall is plain', async () => {
  const { placedIn, listPlaces, askCountry } = await import('./rules.js');
  const { findLeads } = await import('./find.js');
  const IN = askCountry('Indian companies that sell payroll software');
  assert.equal(IN.label, 'India');
  // what places a company in the ask's country
  for (const [text, name] of [
    ['Quillpay is an Indian payroll company.', 'Quillpay'], ['Quillpay is a leading Indian payroll provider.', 'Quillpay'],
    ['Quillpay is a Pune-based payroll firm.', 'Quillpay'], ['Quillpay, a Bengaluru based HR startup, runs payroll.', 'Quillpay'],
    ['Quillpay, based in Mumbai, runs payroll.', 'Quillpay'], ['Quillpay is an HR software company headquartered in Hyderabad.', 'Quillpay'],
  ]) assert.ok(placedIn(text, name, IN), text);
  // a phone number on someone else's page is the publisher's, even in a sentence that names the company
  assert.equal(placedIn('For a free consultation call us today at: +91 98100 00000Visit: Quillpay help.', 'Quillpay', IN), '');
  assert.ok(placedIn('Call Quillpay on +91 20 4000 1234 for a demo.', 'Quillpay', IN, { own: true }), 'on its own site the phone counts');
  assert.ok(placedIn('We run payroll for small firms. Write to us or call +91-80-4000-1234.', 'Harbor HR', IN, { own: true }), 'its own site: a phone with the country code');
  assert.ok(placedIn('We are headquartered in Chennai.', 'Harbor HR', IN, { own: true }), 'its own site: "we" is the company');
  assert.ok(placedIn('Harbor HR runs payroll. Registered office: 4 Mill Road, Pune 411001.', 'Harbor HR', IN, { own: true }), 'its own site: an address');
  // nearby cases that do not place it
  for (const text of ['Lumen Payroll is popular among Indian startups.', 'Lumen Payroll is a favourite of Indian startups.', 'Lumen Payroll serves customers in India.',
    'Lumen Payroll is headquartered in Austin and has an office in Bengaluru, India.', 'Lumen Payroll works with Mumbai-based clients.', 'Lumen Payroll is a cloud-based payroll tool.',
    'Lumen Payroll makes payroll software for small businesses.', 'Lumen Payroll is an American payroll company.', 'Lumen Payroll: call +1 415 555 0100.'])
    assert.equal(placedIn(text, 'Lumen Payroll', IN), '', text);
  assert.equal(placedIn('We are headquartered in Chennai.', 'Lumen Payroll', IN), '', 'on a page that is not its own, "we" is someone else');
  assert.equal(placedIn('Quillpay is an Indian payroll company.', 'Quillpay', null), '', 'the ask names no country');
  // a list page that is itself about companies of that country, not a list of what is sold or used there
  assert.ok(listPlaces({ title: 'Top 10 Indian HR software companies', text: 'x' }, IN));
  assert.ok(listPlaces({ title: 'Payroll software', text: 'Payroll software companies based in India, compared. ' }, IN));
  for (const title of ['Best HR software in India', 'Top HR software for Indian small businesses', 'HR tools popular with Indian startups', 'Top 10 HR software companies', 'Indian startups pick these HR tools'])
    assert.equal(listPlaces({ title, text: 'x' }, IN), '', title);
  assert.equal(listPlaces({ title: 'HRMS with payroll', text: 'Indian startups and Indian companies alike need simple payroll. Here are ten tools.' }, IN), '', 'the opening text names the audience, not the makers');
  // through the whole search (stubs): only the leads a page places in India are kept, and the reason says why the rest are missing
  const pad = ' Payroll software for small businesses, compared side by side.'.repeat(6);
  const pages = {
    'https://list.example/in': { title: 'Best payroll software in India', text: 'Northwind People offers payroll software. Quillpay is a Pune-based payroll software company. Harbor HR offers payroll software. Lumen Payroll offers payroll software.' + pad },
    'https://www.harborhr.in/': { title: 'Harbor HR: payroll software', text: 'Harbor HR runs payroll software for small businesses. Payroll and HR in one place. '.repeat(3) },
    'https://www.lumenpayroll.example/': { title: 'Lumen Payroll: payroll software', text: 'Lumen Payroll runs payroll software for small teams everywhere. Call +1 415 555 0100. '.repeat(3) },
  };
  const search = { async search(q) { if (!/official website/.test(q)) return [{ url: 'https://list.example/in' }]; return q.startsWith('Harbor') ? [{ url: 'https://www.harborhr.in/' }] : q.startsWith('Lumen') ? [{ url: 'https://www.lumenpayroll.example/' }] : []; },
    async read(u) { const k = /list\.example/.test(u) ? u : new URL(u).origin + '/'; const p = pages[k]; if (!p) throw new Error('404'); return { url: u, ...p }; } };
  const names = ['Northwind People', 'Quillpay', 'Harbor HR', 'Lumen Payroll'];
  const model = { async chat({ purpose, messages }) { if (purpose === 'plan') return { json: { queries: ['q'] } }; const t = messages[1].content; return { json: { leads: names.filter(n => t.includes(n)).map(n => ({ page: 0, company: n, kind: 'company', fits: true, need: 'payroll software' })) } }; } };
  const r = await findLeads({ query: 'Find 4 Indian companies that sell payroll software', count: 4, search, model, budget: { extraRounds: 0, firstRounds: 1 } });
  assert.deepEqual(r.leads.map(l => l.company).sort(), ['Harbor HR', 'Quillpay'], 'placed by the list sentence and by its own .in site');
  assert.equal(r.rejected['not placed in the country'], 2);
  assert.match(r.reason, /2 were left out because no page read placed them in India/);
  assert.equal(r.country.label, 'India');
  assert.match(r.leads.find(l => l.company === 'Quillpay').findings, /Placed in India by "is a Pune-based" \(https:\/\/list\.example\/in\)\./, 'the evidence is said in the findings');
  assert.match(r.leads.find(l => l.company === 'Harbor HR').findings, /Placed in India by "its own site www\.harborhr\.in"/);
  // with no country in the ask, nothing is held back for want of a place
  const r2 = await findLeads({ query: 'Find 4 companies that sell payroll software', count: 4, search, model, budget: { extraRounds: 0, firstRounds: 1 } });
  assert.equal(r2.leads.length, 4);
});

test('country shortfall in the reply: "2 of 4 found that could be placed in India", and why the rest are missing', async () => {
  const names = ['Northwind People', 'Quillpay', 'Lumen Payroll', 'Tarang HR'];
  const t = await testDesk({ modules: ['sales'], script: findScript(names) });
  try {
    stubSearch(t, { 'https://list.example/a': 'Northwind People offers HR software. Quillpay is a Pune-based payroll software company. Lumen Payroll offers HR software. Tarang HR, based in Chennai, runs payroll software.' + pad5 },
      (q) => /official website/.test(q) ? [] : [{ url: 'https://list.example/a' }]);
    const s = await t.core.modules.runTool('leads_find', { query: 'Indian companies that sell HR or payroll software to small businesses', count: 4 }, { chatId: 'c1' });
    const out = (await t.core.jobs.wait(s.jobId, 60000)).output;
    assert.equal(out.found, 2, out.text);
    assert.match(out.text, /^2 of 4 found that could be placed in India: /, out.text);
    assert.match(out.text, /2 were left out because no page read placed them in India/);
    assert.match(out.card.title, /^2 of 4 found that could be placed in India/);
    assert.deepEqual(out.card.rows.map(r => r[0]).sort(), ['Quillpay', 'Tarang HR']);
  } finally { await t.close(); }
});

// ---- the closing line counts the leads shown; fit needs a read page that says what the company sells
const ofPairs = (s) => [...String(s).matchAll(/(\d+) of (\d+)/g)].map(m => [Number(m[1]), Number(m[2])]);
test('closing line: every count is taken over the leads shown, never over candidates checked or merged away', async () => {
  const pad = ' Trusted by small teams across India for their monthly pay runs.'.repeat(8);
  const pages = {
    'https://list.example/a': 'Nimbus People sells HR software. Nimbus Payroll sells payroll software. Nimbus Expense sells HR software. Acme HR sells HR software.' + pad,
    'https://www.nimbus-fakeco.in/': 'Nimbus People, Nimbus Payroll and Nimbus Expense: HR and payroll software for small businesses. Write to sales@nimbus-fakeco.in.' + pad,
    'https://www.acmehr-fakeco.in/': 'Acme HR builds HR software for small teams. Write to hello@acmehr-fakeco.in.' + pad,
  };
  const names = ['Nimbus People', 'Nimbus Payroll', 'Nimbus Expense', 'Acme HR'];
  const t = await testDesk({ modules: ['sales'], script: findScript(names) });
  try {
    t.core.modules.active.set('search', { handle: null, api: {
      async search(q) { if (/official website/.test(q)) return /^Nimbus/.test(q) ? [{ url: 'https://www.nimbus-fakeco.in/' }] : /^Acme/.test(q) ? [{ url: 'https://www.acmehr-fakeco.in/' }] : []; return [{ url: 'https://list.example/a' }]; },
      async read(u) { const p = pages[u]; if (!p) throw new Error('404'); return { url: u, title: /list/.test(u) ? 'HR software list' : 'HR and payroll software', text: p }; } } });
    const s = await t.core.modules.runTool('leads_find', { query: 'Companies that sell HR or payroll software to small businesses', count: 2 }, { chatId: 'c1' });
    const out = (await t.core.jobs.wait(s.jobId, 60000)).output;
    assert.equal(out.found, 2, out.text);
    assert.match(out.text, /\b2 of 2 have their own site as the main source/, out.text);
    for (const [n, m] of ofPairs(out.text)) assert.ok(n <= m, `"${n} of ${m}" in: ${out.text}`);
    for (const [n, m] of ofPairs(out.card.title + ' ' + out.card.note)) assert.ok(n <= m, out.card.title);
    assert.ok(out.sites.own <= out.found && out.sites.emails <= out.found, JSON.stringify(out.sites));
    const mails = Number((out.text.match(/(\d+) carr(?:y|ies) a mail address/) || [0, 0])[1]);
    assert.ok(mails >= 1 && mails <= 2, out.text);
  } finally { await t.close(); }
  const { closingLine, countClause } = await import('./find.js');
  assert.equal(countClause(5, 2, 'have their own site as the main source'), '', 'a count over the number of leads is left out');
  assert.equal(countClause(0, 2, 'x'), '');
  assert.equal(countClause(1, 2, 'carry a mail address'), '1 of 2 carry a mail address');
  const shown = [{ company: 'A', website: 'https://a.example', email: 'x@a.example', contactName: 'R. Rao', sources: [{ url: 'https://www.a.example/' }] }, { company: 'B', website: 'https://b.example', sources: [{ url: 'https://list.example/x' }] }];
  const line = closingLine(shown);
  assert.match(line, /1 of 2 have their own site as the main source/); assert.match(line, /1 of 2 carry a mail address/); assert.match(line, /1 of 2 name a contact person/);
  assert.equal(closingLine([]), '');
});

test('fit: kept only when a read page says what the company itself sells; staffing, IT services and list-only names are left out', async () => {
  const { checkRow, checkSites, findLeads } = await import('./find.js');
  const { siteFits, sellsIn, sameBusiness } = await import('./rules.js');
  const ASK = 'Indian companies that sell HR or payroll software to small businesses';
  const pad = ' We are headquartered in Pune.'.repeat(8);
  // a staffing firm with "HR" in its name: its own words say staffing, so the site is not taken as a fit
  const staff = { url: 'https://www.tarnwellhr.example/', title: 'Tarnwell HR | Recruitment & Staffing Company', text: 'Tarnwell HR finds people for your teams. We are a recruitment and staffing company. HR support, HR hiring, HR advice.' + pad };
  const sf = siteFits(staff, { query: ASK, company: 'Tarnwell HR' });
  assert.equal(sf.ok, false, sf.why); assert.match(sf.other, /recruitment|staffing/);
  // a payroll software maker: the title says it, the opening is marketing words; the job and the real check use this one function
  const maker = { url: 'https://www.brindlepay.example/', title: 'Payroll software for small businesses | Brindle Pay', text: 'Grow faster. Delight your people. Work smarter, every single day, with less stress and more joy for everyone.' + pad };
  const mf = siteFits(maker, { query: ASK, company: 'Brindle Pay' });
  assert.equal(mf.ok, true, mf.why); assert.match(mf.sells, /Payroll software/);
  assert.equal(sameBusiness(maker.text, ['hr', 'payroll']), false, 'text alone misses it: why the real check must use siteFits');
  const fs = await import('node:fs');
  const rc = fs.readFileSync(new URL('./real-check.mjs', import.meta.url), 'utf8');
  assert.ok(/siteFits\(/.test(rc) && !/sameBusiness\(/.test(rc), 'the real check re-checks a site with the same function the job uses');
  // a list page: a name in a "Top 25" heading list says nothing about what it sells; a sentence about the company does
  const list = { url: 'https://toplists.example/top-25-hr-software', title: 'Top 25 HR software companies in India', text: 'Top 25 HR software companies in India: Orvane Infotech, Kelmora Systems, Brindle Pay, Tarnwell HR. Orvane Infotech is a global software and solutions company. Tarnwell HR is a recruitment and staffing company. Brindle Pay sells payroll software to small firms.' + pad };
  const row = (company) => checkRow({ company, kind: 'company', fits: true, need: 'HR software' }, list, { query: ASK });
  assert.ok(!row('Orvane Infotech').sells, 'a general software company: nothing read says it sells HR or payroll software');
  assert.ok(!row('Kelmora Systems').sells, 'named in the list only');
  assert.match(row('Tarnwell HR').otherKind, /recruitment|staffing/);
  assert.match(row('Brindle Pay').sells.words, /sells payroll software/);
  assert.equal(sellsIn('Ciel Payroll, Orvane Infotech and Kelmora Systems are listed below.', 'Kelmora Systems', ASK), '');
  assert.ok(sellsIn('Acme HR, Quokka Payroll and Beta HR sell HR software.', 'Acme HR', ASK));
  // the whole search: the real fit named only on the list is confirmed by its own site; the other two are left out with a reason
  const sites = {
    'https://www.orvane.example/': { title: 'Orvane Infotech | IT services and software development', text: 'Orvane Infotech delivers IT services, cloud and software development for global clients, including HR departments.' + pad },
    'https://www.kelmora.example/': { title: 'Kelmora | HR and payroll software for growing teams', text: 'Kelmora Systems runs your HR and payroll in one place.' + pad },
    'https://www.tarnwellhr.example/': staff, 'https://www.brindlepay.example/': maker,
  };
  const search = {
    async search(q) {
      if (/official website/.test(q)) { const k = q.split(' ')[0].toLowerCase(); const u = Object.keys(sites).find(x => x.includes(k)); return u ? [{ url: u }] : []; }
      return [{ url: list.url }];
    },
    async read(u) { if (u === list.url) return list; const p = sites[u]; if (!p) throw new Error('404'); return { url: u, ...p }; },
  };
  const names = ['Orvane Infotech', 'Kelmora Systems', 'Brindle Pay', 'Tarnwell HR'];
  const model = { async chat({ purpose, messages }) { if (purpose === 'plan') return { json: { queries: ['hr software india'] } }; const txt = messages[1].content; return { json: { leads: names.filter(n => txt.includes(n)).map(n => ({ page: 1, company: n, kind: 'company', fits: true, need: 'HR software' })) } }; } };
  const r = await findLeads({ query: ASK, count: 4, search, model, budget: { extraRounds: 0, firstRounds: 1 } });
  assert.deepEqual(r.leads.map(l => l.company).sort(), ['Brindle Pay', 'Kelmora Systems'], r.reason);
  assert.ok(r.leads.every(l => /What it sells, from https?:\/\/\S+: "/.test(l.findings)), r.leads.map(l => l.findings).join(' | '));
  assert.equal(r.rejected['another kind of business'], 2, JSON.stringify(r.rejected));
  assert.match(r.reason, /2 were another kind of business than the ask/);
  void checkSites;
});
