// Deep research: plan -> search -> read many pages -> write with numbered sources -> check every citation -> files.
// The flow (plan sub-questions, fan out searches, gather pages, write a cited report) follows GPT Researcher's
// planner/researcher/writer split (https://github.com/assafelovic/gpt-researcher, Apache-2.0); prompts are our own words.
import { askModel, asSource, DATA_RULE, passages, verifyQuote, quoteOnPage, codeSupport, sentencesFor, listIn, host, pool, stopped, shortTitle } from './util.js';
import { writeReport } from './export.js';
import { domainIn, onDomain, anchorFromSite, namesExactly, applyScreen, screenPages, sanityPass, rivalSentences, otherValues, readOwnSite, uncorroborated, ownSiteLine, topLines, tailLines } from './entity.js';

const SKIP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|tiktok\.com|pinterest\.|quora\.com|reddit\.com)$/i;
/** A bibliography entry, not a statement of the page. Plain signs only: authors with initials, et al., "Retrieved/Accessed <date>",
 *  "Archived from the original", a quoted title then a publication and a date, "Surname, I. (year)", volume(issue), "pp.",
 *  a closing page range ", 1-10.", doi, ISBN, ISSN, or text that is mostly a URL. */
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?';
const DATE = `(?:\\d{1,2} ${MONTH},? \\d{4}|${MONTH} \\d{1,2},? \\d{4}|\\d{4}-\\d{2}-\\d{2})`;
const REF_SIGNS = [
  new RegExp(`\\b(?:Retrieved|Accessed)(?: on)? ${DATE}`, 'i'),
  /\bArchived from the original\b/i,
  new RegExp(`["“][^"”]{10,}["”]\\.?\\s+(?:[A-Z][\\w&'.-]*\\s+){0,6}?[A-Z][\\w&'-]*\\.?,?\\s+${DATE}`),   // "Title". The Economic Times. 12 January 2024
  /^\s*[A-Z][\p{L}'-]+,\s(?:[A-Z]\.\s?){1,3}[^()]{0,80}\(\d{4}[a-z]?\)/u,                                // Kumar, R. (2019).
  /\b\d+\(\d+\)/, /\bpp\.\s?\d/, /,\s?\d+[-–]\d+\.?\s*$/, /\bdoi\b/i, /\bISBN\b/, /\bISSN\b/, /\bet al\b/i, /\b\d+, \d+(?:-\d+)? \(\d{4}\)/,
];
export const looksLikeReference = (q) => {
  const t = String(q || '');
  if ((t.match(/\b[A-Z][a-zA-Z'-]+,? (?:[A-Z]\.? ?){1,3}(?:,|\(|$)/g) || []).length >= 2) return true;
  if (REF_SIGNS.some((re) => re.test(t))) return true;
  const url = (t.match(/https?:\/\/\S+|\bwww\.\S+/g) || []).join('').length;
  return url > 0 && url >= 0.5 * t.trim().length;
};
/** The page text before its reference list: a line that is only "References", "Notes", "Citations", "Bibliography",
 *  "External links" or "Further reading" ends the part whose passages may be cited. */
export const beforeReferences = (text) => {
  const t = String(text || ''); const m = /^[ \t#]*(?:references|notes|citations|bibliography|external links|further reading)[ \t]*(?:\[edit\])?[ \t]*:?[ \t]*$/im.exec(t);
  return m ? t.slice(0, m.index) : t;
};
const GOOD_TARGET = 16, MIN_SOURCES = 10, MAX_TRIES = 40, MIN_TEXT = 500, TOPUP_ROUNDS = 4, TOPUP_MS = 8 * 60_000;

export async function runDeep(ctx, job, { rid, question, agentId, chatId, store }) {
  const search = ctx.modules.api('search');
  if (!search) throw new Error('The Search module is off, so research cannot read the web.');
  if (ctx.settings.get('online') === false) throw Object.assign(new Error('The desk is offline. Research needs the internet.'), { code: 'offline' });
  const signal = job.signal; const meter = { calls: 0 }; const cache = new Map();
  const cardId = 'research-' + rid;
  let title = shortTitle(question, 80);
  const step = (p, detail, extra = {}) => {
    job.throwIfStopped();
    job.progress(p, detail);
    store.update(rid, { step: detail, progress: p, ...extra });
    job.card({ kind: 'progress', id: cardId, title: 'Deep research: ' + title, detail, progress: p, status: 'running' });
  };
  const onWait = (ms) => step(store.get(rid)?.progress || 0, `Models are busy; waiting ${Math.round(ms / 1000)} seconds`);
  const sys = (extra) => ctx.agents.systemPrompt(agentId, extra) || extra;

  // 0. the entity step: when the question names a site, its own pages say who it is, before anything else is read
  let anchor = null; let ownPage = null;
  const domain = domainIn(question);
  if (domain) {
    step(0.02, `Reading ${domain} first, to settle who it is`);
    const own = await readOwnSite(ctx, search, domain, { signal, cache });
    ownPage = own?.page || null;
    anchor = ownPage ? { ...anchorFromSite(ownPage, domain), readVia: own.via } : { name: domain, domain, description: `the organisation behind ${domain} (its own site could not be read)`, siteRead: false };
  }

  // 1. plan
  step(0.04, 'Planning the outline');
  let plan = { title, subquestions: [question], queries: [question] };
  try {
    const r = await askModel(ctx, { agentId, purpose: 'plan', json: true, signal, maxTokens: 1200, messages: [
      { role: 'system', content: sys('You plan web research. Reply with JSON only.') },
      { role: 'user', content: `Research question from the owner: "${question}"\n\n${anchor ? `The question is about ONE entity: ${anchor.name} (${anchor.domain}). ${anchor.siteRead ? `Its own site says: "${anchor.description.slice(0, 300)}"` : ''} Every search query must name it exactly ("${anchor.domain}" or "${anchor.name}" in quotes); other organisations with similar names are NOT it.\n\n` : ''}Return JSON: {"entity": ${anchor ? 'null' : '{"name": "exact name", "about": "what the question says about it"} when the question is about ONE named organisation, company, product, person or website, else null (null for topics, places and technologies in general)'}, "title": "a plain title for the report, at most 10 words", "subquestions": ["4 to 6 sub-questions that together answer it"], "queries": ["7 short web search queries, varied: facts and figures, recent news, official or statistical sources, expert analysis, criticism or risks"]}` }] }, { meter, onWait });
    const j = r.json || {};
    if (Array.isArray(j.queries) && j.queries.length) plan = { title: shortTitle(j.title || title, 120), subquestions: (j.subquestions || []).map(String).slice(0, 6), queries: j.queries.map(String).slice(0, 8) };
    if (!anchor && j.entity && typeof j.entity === 'object' && String(j.entity.name || '').trim()) anchor = { name: String(j.entity.name).trim().slice(0, 80), domain: null, description: String(j.entity.about || question).slice(0, 300), siteRead: false };
  } catch (e) { if (stopped(e, signal)) throw e; ctx.log('plan failed, using the question as the query', e.message); }
  if (anchor) plan.queries = [...new Set([`"${anchor.domain || anchor.name}"`, ...(anchor.domain ? [`site:${anchor.domain}`] : []), ...plan.queries])].slice(0, 8);
  title = plan.title || title;
  store.update(rid, { title, data: { plan } });

  // 2. search
  const cands = []; const seen = new Set(); const providers = {}; let lastAttempts = [];
  const addResults = (rows, q) => { for (const r of rows) { const k = r.url.replace(/[#?].*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, ''); if (seen.has(k) || SKIP_HOSTS.test(host(r.url))) continue; seen.add(k); cands.push({ ...r, query: q }); } };
  const runQueries = async (qs, from, to) => {
    for (let i = 0; i < qs.length; i++) {
      step(from + (to - from) * (i / qs.length), `Searching: ${qs[i]}`);
      try { const rows = await search.search(qs[i], { count: 8, signal }); if (rows.attempts?.length) lastAttempts = rows.attempts; for (const a of rows.attempts || []) { const x = providers[a.label] ||= { results: 0, failed: 0, note: '' }; if (a.ok) x.results += a.n; else { x.failed++; x.note = a.note; } } addResults(rows, qs[i]); }
      catch (e) { if (stopped(e, signal) || e.code === 'offline') throw e; }
    }
  };
  const searchFailure = () => { const bad = Object.entries(providers).filter(([, v]) => v.failed).map(([k, v]) => `${k}: ${v.note}`); return bad.length ? bad.join('; ') : (lastAttempts.length ? lastAttempts.map((a) => `${a.label}: ${a.ok ? 'no results' : a.note}`).join('; ') : 'no search provider is set up'); };
  const searched = new Set(plan.queries);
  const moreQueries = () => [...plan.subquestions, ...plan.queries.map((q) => q + ' review'), ...plan.queries.map((q) => q + ' report')].filter((q) => !searched.has(q));
  await runQueries(plan.queries, 0.08, 0.22);
  if (!cands.length && !ownPage) throw Object.assign(new Error(`No search provider answered, so there was nothing to read. ${searchFailure()}. Try again in a few minutes.`), { code: 'search_failed' });

  // 3. read, host-diverse order: round-robin by query, at most 2 pages per site
  const good = []; const tried = []; const perHost = {}; let target = GOOD_TARGET, maxTries = MAX_TRIES;
  const hostCap = (h) => (anchor?.domain && (h === anchor.domain || h.endsWith('.' + anchor.domain)) ? 5 : 2);
  if (ownPage) { good.push({ ...ownPage, provider: 'its own site' }); tried.push({ url: ownPage.url, title: ownPage.title, provider: 'its own site', ok: true, status: 200, chars: ownPage.text.length }); perHost[host(ownPage.url)] = 1; seen.add(ownPage.url.replace(/[#?].*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '')); }
  const order = () => { const byQ = new Map(); for (const c of cands) { if (c.taken) continue; if (!byQ.has(c.query)) byQ.set(c.query, []); byQ.get(c.query).push(c); } const lists = [...byQ.values()]; const out = []; for (let i = 0; lists.some((l) => l[i]); i++) for (const l of lists) if (l[i]) out.push(l[i]); return out; };
  const readSome = async (from, to) => {
    const list = order().filter((c) => (perHost[host(c.url)] || 0) < hostCap(host(c.url)));
    let done = 0;
    await pool(list, 5, async (c) => {
      if (good.length >= target || tried.length >= maxTries || signal.aborted) return;
      const h = host(c.url); if ((perHost[h] || 0) >= hostCap(h)) return;
      c.taken = true; perHost[h] = (perHost[h] || 0) + 1;
      const t = { url: c.url, title: c.title, provider: c.source };
      tried.push(t);
      try {
        const p = await search.read(c.url, { signal, cache });
        if (p.text.length < MIN_TEXT) { t.ok = false; t.note = 'too little text'; perHost[h]--; }
        else { t.ok = true; t.status = p.status; t.chars = p.text.length; good.push({ ...p, title: p.title || c.title, snippet: c.snippet, provider: c.source }); }
      } catch (e) {
        if (stopped(e, signal)) throw e;
        // a page that loads its text with scripts: read it rendered in the agent's own browser when Browser is on (never past a bot check)
        const browser = e.code === 'empty' ? ctx.modules.api('browser') : null;
        let p = null; if (browser?.readPage) { try { await search.checkUrl(c.url); p = await browser.readPage(c.url); } catch (e2) { if (stopped(e2, signal)) throw e2; } }
        if (p?.text?.length >= MIN_TEXT) { t.ok = true; t.status = 200; t.chars = p.text.length; t.note = 'read in the browser'; good.push({ url: c.url, status: 200, kind: 'rendered', title: p.title || c.title, text: p.text.slice(0, 200000), snippet: c.snippet, provider: c.source }); }
        else { t.ok = false; t.note = e.message; perHost[h]--; }
      }
      done++; step(from + (to - from) * Math.min(1, good.length / target), `Reading ${good.length} pages (${tried.length} tried)`);
    });
  };
  await readSome(0.22, 0.45);
  if (good.length < GOOD_TARGET && plan.subquestions.length) { for (const q of plan.subquestions.slice(0, 4)) searched.add(q); await runQueries(plan.subquestions.slice(0, 4), 0.45, 0.48); await readSome(0.48, 0.52); }
  if (good.length < MIN_SOURCES) {                         // still short: the references of the Wikipedia pages we read
    for (const w of good.filter((g) => /wikipedia\.org\/wiki\//.test(g.url)).slice(0, 2)) {
      try {
        const t = decodeURIComponent(w.url.split('/wiki/')[1]);
        const r = await ctx.fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extlinks&ellimit=60&format=json&titles=${encodeURIComponent(t)}`, { headers: { 'User-Agent': 'AgentPopulationDesk/0.1 (local desktop app)' }, signal });
        const links = Object.values((await r.json())?.query?.pages || {}).flatMap((p) => (p.extlinks || []).map((x) => x['*'])).filter((u) => /^https:\/\//.test(u) && !/archive\.org|doi\.org|worldcat|wikidata|google\./.test(u));
        addResults(links.map((u) => ({ url: u, title: host(u), snippet: '', source: 'Wikipedia references' })), 'refs:' + t);
      } catch (e) { if (stopped(e, signal)) throw e; }
    }
    await readSome(0.52, 0.55);
  }
  if (!good.length) throw Object.assign(new Error(`No page could be read (${tried.length} tried). Search: ${Object.entries(providers).map(([k, v]) => `${k}: ${v.results} results${v.note ? ', then ' + v.note : ''}`).join('; ')}. Try again in a few minutes.`), { code: 'search_failed' });

  // 3b. entity screening: pages about a different organisation with a similar name are left out, never merged
  let screen = null;
  if (anchor) {
    step(0.55, `Checking which pages are really about ${anchor.name}`);
    const sc = await screenPages(ctx, { anchor, question, pages: good, agentId, signal }, { meter, onWait });
    screen = applyScreen(anchor, good, sc.verdicts, sc.settled);
    good.splice(0, good.length, ...screen.kept);
  }
  const entityTop = () => topLines(anchor, screen); const entityTail = () => tailLines(anchor, screen);   // built when the report is written: later steps may still leave pages out
  if (anchor && !good.length) {                             // nothing confirmed: say so, do not write a merged report
    const top0 = entityTop(); const md0 = [`# ${title}`, '', ...top0, ...entityTail()].join('\n');
    store.update(rid, { title, markdown: md0, summary: top0[0].replace(/\*\*/g, ''), data: { plan, providers, tried, anchor, screen, claims: [], sources: [], uncited: [], counts: { read: 0, tried: tried.length, cited: 0, claims: 0, passed: 0 }, labels: [...(meter.labels || [])], modelCalls: meter.calls } });
    const files0 = await writeReport(ctx, { title, markdown: md0, jobId: job.id, agentId, chatId, signal });
    store.update(rid, { files: files0, status: 'done', progress: 1, step: 'Report ready: the entity could not be settled' });
    job.card({ kind: 'progress', id: cardId, title: 'Deep research: ' + title, detail: 'Finished: which organisation is meant could not be settled', progress: 1, status: 'done' });
    job.card({ kind: 'report', title, summary: top0[0].replace(/\*\*/g, ''), path: files0.md || null, sources: [], go: '#/research/' + rid });
    return { reportId: rid, title, sources: 0, read: 0, claims: 0, passed: 0, settled: false, files: files0, go: '#/research/' + rid };
  }
  store.update(rid, { data: { plan, providers, tried } });

  // 4. claims are written FROM quotes: for each page the model copies sentences worth citing, code checks each is on the page word
  //    for word, and the writer composes the report only from those verified sentences, each claim naming the sentence it restates.
  const ask = [question, ...plan.subquestions].join(' ');
  const srcs = good.map((g, i) => ({ n: i + 1, page: g, excerpt: passages(beforeReferences(g.text), ask, 2400) }));
  const evidence = []; let eid = 0; const pickLabels = new Set();
  const addEvidence = (n, quote, by) => {
    const on = quoteOnPage(quote, beforeReferences(srcs[n - 1].page.text)); if (!on.ok || on.q.length > 600 || looksLikeReference(quote)) return false;   // a reference-list entry is not a finding
    if (evidence.some((e) => e.n === n && e.key === on.q)) return false;
    evidence.push({ id: 'E' + (++eid), n, quote: String(quote).trim().replace(/^["'“]+|["'”]+$/g, ''), key: on.q, by }); return true;
  };
  const extract = async (list, p0, p1) => {
    const batches = []; for (let i = 0; i < list.length; i += 3) batches.push(list.slice(i, i + 3));
    let done = 0;
    await pool(batches, 2, async (batch) => {
      step(p0 + (p1 - p0) * (done / batches.length), `Picking passages to cite (${evidence.length} so far, ${good.length} pages)`);
      let rows = [];
      for (let attempt = 0; attempt < 2 && !rows.length; attempt++) try {
        const rr = await askModel(ctx, { agentId, purpose: 'research', json: true, signal, maxTokens: 3000, temperature: 0, messages: [
          { role: 'system', content: `You pick passages to cite from web pages. ${DATA_RULE} Reply with JSON only.` },
          { role: 'user', content: `Owner's question: "${question}"\nSub-questions: ${plan.subquestions.join(' | ')}\n\n${batch.map((x) => asSource(x.n, x.page, x.excerpt)).join('\n\n')}\n\nFrom EACH source above, copy 3 to 6 sentences that help answer the question: figures, dates, records, causes, limits, who did what. Copy each one exactly as it is written in the source, character for character: one or two whole sentences, no gaps, no "...", no changes, no translation. Skip menus, adverts and captions.\nJSON: {"quotes": [{"n": ${batch[0].n}, "quote": "..."}]}` }] }, { meter, onWait });
        pickLabels.add(rr.label); rows = listIn(rr.json, 'quotes');
      } catch (e) { if (stopped(e, signal)) throw e; ctx.log('passage pick failed', e.message); }
      for (const x of rows) { const n = Number(x?.n); if (batch.some((y) => y.n === n)) addEvidence(n, String(x.quote || ''), 'model'); }
      for (const x of batch) if (!evidence.some((e) => e.n === x.n)) for (const q of sentencesFor(x.excerpt, ask, 3)) addEvidence(x.n, q, 'code');   // the model gave nothing usable for this page: whole sentences picked by code
      done++;
    });
  };
  await extract(srcs, 0.55, 0.62);
  if (!evidence.length) throw new Error('No passage of the pages read could be verified, so nothing can be cited. Try again in a few minutes.');

  // 5. write: every claim restates one or two verified passages; code then checks each claim against its passage (numbers, words, negation)
  step(0.63, `Writing the report from ${evidence.length} verified passages of ${new Set(evidence.map((e) => e.n)).size} pages`);
  const evText = (list) => list.map((e) => `[${e.id}] (source ${e.n}: ${host(srcs[e.n - 1].page.url)}) "${e.quote}"`).join('\n');
  const byId = new Map(); const sync = () => { for (const e of evidence) byId.set(e.id, e); };
  sync();
  const nSrc = new Set(evidence.map((e) => e.n)).size;
  const writeOnce = () => askModel(ctx, { agentId, purpose: 'research', json: true, signal, maxTokens: 6000, temperature: 0.2, messages: [
    { role: 'system', content: sys(`You write research reports in plain words from verified passages only. ${DATA_RULE} Reply with JSON only.`) },
    { role: 'user', content: `Owner's question: "${question}"\nSub-questions: ${plan.subquestions.join(' | ')}\n${anchor ? `The report is about ONE entity: ${anchor.name}${anchor.domain ? ` (${anchor.domain})` : ''}. Say nothing about any other organisation, product or person with a similar name.\n` : ''}\nVerified passages, copied from the pages read:\n<source n="passages">\n${evText(evidence)}\n</source>\n\nWrite the report as JSON:\n{"title": "at most 10 words", "summary": [{"text": "one sentence", "evidence": ["E1"]}], "sections": [{"heading": "...", "claims": [{"text": "one sentence", "evidence": ["E2"]}]}]}\nRules:\n- Every claim restates ONE passage (two at most) and names its id in "evidence". Say only what that passage says, in the passage's own key words; no outside knowledge, no merging of facts from different passages into one sentence.\n- Keep every number, percentage and year of the claim exactly as the passage writes it, and only numbers that are in that passage. Keep "not", "no" and "less than".\n- Use passages from at least ${Math.min(MIN_SOURCES + 2, nSrc)} different sources; spread over the sources.\n- Summary: 3 or 4 claims, each also naming its passage. Then 4 to 6 sections of 3 to 5 claims each.\n- No URLs, no markdown inside the text.` }] }, { meter, onWait });
  let r = null;
  for (let attempt = 0; attempt < 2; attempt++) {          // a broken or empty answer gets one more try (often on another model)
    try { r = await writeOnce(); if (r.json && (Array.isArray(r.json.sections) || Array.isArray(r.json.summary))) break; }
    catch (e) { if (stopped(e, signal) || attempt) throw e; ctx.log('writer failed, trying again', e.message); }
    if (attempt === 0) step(0.65, 'Writing the report again (the first draft was not usable)');
  }
  const draft = r?.json || {}; const writer = r?.label || 'no model';
  const claims = []; let cid = 0;
  /** One claim, checked by code against each passage it names: the passage on the page, the claim's numbers and half its words inside it, same negation. */
  const checkClaim = (text, ids, section) => {
    const evs = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').trim().toUpperCase()))].map((x) => byId.get(x)).filter(Boolean).slice(0, 3);
    const checks = [];
    for (const e of evs) {
      const v = verifyQuote(e.quote, srcs[e.n - 1].page.text, text);
      if (v.ok) { if (!checks.some((k) => k.n === e.n && k.ok)) checks.push({ n: e.n, ok: true, why: '', quote: e.quote.slice(0, 500), by: 'model quote' }); continue; }
      const cs = codeSupport(text, srcs[e.n - 1].page.text);
      checks.push(cs.ok ? { n: e.n, ok: true, why: '', quote: cs.quote.slice(0, 500), by: 'code match' } : { n: e.n, ok: false, why: v.why, quote: null, by: 'model quote' });
    }
    if (!evs.length) checks.push({ n: 0, ok: false, why: 'the writer named no verified passage', quote: null, by: 'none' });
    const keep = checks.filter((k) => k.ok); const final = keep.length ? keep : checks.filter((k, i, a) => a.findIndex((y) => y.n === k.n) === i);
    claims.push({ id: 'c' + (++cid), section, text, cites: [...new Set(evs.map((e) => e.n))], checks: final.filter((k) => k.n) });
  };
  const take = (list, section) => { for (const c of Array.isArray(list) ? list : []) { const text = String(c?.text || '').trim(); if (text) checkClaim(text, c.evidence ?? c.sources ?? [], section); } };
  take(draft.summary, 'Summary');
  for (const s of Array.isArray(draft.sections) ? draft.sections : []) take(s?.claims, String(s?.heading || 'Findings').slice(0, 100));
  if (!claims.length) throw new Error('The model did not write a usable report (' + writer + ').');
  if (draft.title) title = shortTitle(draft.title, 120);

  // 5b. top-up: until ten distinct sources are confirmed, the pages run out, four rounds, or the time limit.
  //     Each round reads more pages when the unused verified passages cannot reach ten, then turns passages of uncited sources into findings.
  const usedNs = () => new Set(claims.flatMap((c) => c.checks.filter((k) => k.ok).map((k) => k.n)));
  const offered = new Set(); let rounds = 0; const topStart = Date.now();
  const spareEv = () => { const used = usedNs(); return evidence.filter((e) => !used.has(e.n) && !offered.has(e.id)); };
  while (usedNs().size < MIN_SOURCES && rounds < TOPUP_ROUNDS && Date.now() - topStart < TOPUP_MS) {
    rounds++;
    if (new Set(spareEv().map((e) => e.n)).size < MIN_SOURCES - usedNs().size) {   // the unread pool is the limit: read more pages first
      const before = good.length; target = good.length + 6; maxTries = tried.length + 15;
      step(0.88, `Reading more pages to confirm more sources (round ${rounds}): ${usedNs().size} of ${MIN_SOURCES} so far`);
      if (order().filter((c) => (perHost[host(c.url)] || 0) < hostCap(host(c.url))).length < 6) { const qs = moreQueries().slice(0, 2); for (const q of qs) searched.add(q); await runQueries(qs, 0.88, 0.88); }   // few candidates left: search again first
      await readSome(0.88, 0.88);
      if (anchor) for (const g of good.slice(before)) if (!onDomain(g.url, anchor.domain) && !namesExactly(g.text, anchor)) { good.splice(good.indexOf(g), 1); screen.unclear.push({ title: g.title, url: g.url, why: 'does not name it exactly' }); }
      const fresh = []; for (const g of good.slice(before)) { const x = { n: srcs.length + 1, page: g, excerpt: passages(beforeReferences(g.text), ask, 2400) }; srcs.push(x); fresh.push(x); }
      if (fresh.length) { await extract(fresh, 0.89, 0.89); sync(); }
    }
    const used = usedNs(); const per = new Map(); const pick = [];
    for (const e of spareEv()) { const k = per.get(e.n) || 0; if (k < 2 && pick.length < 16) { per.set(e.n, k + 1); pick.push(e); } }
    if (!pick.length) break;
    for (const e of pick) offered.add(e.id);
    step(0.9, `Confirming more sources (round ${rounds}): ${used.size} of ${MIN_SOURCES} so far`);
    try {
      const rr = await askModel(ctx, { agentId, purpose: 'research', json: true, signal, maxTokens: 3500, temperature: 0.1, messages: [
        { role: 'system', content: `You add cited findings to a research report. ${DATA_RULE} Reply with JSON only.` },
        { role: 'user', content: `Owner's question: "${question}"\n\nVerified passages, copied from the pages read:\n<source n="passages">\n${evText(pick)}\n</source>\n\nFor each passage that helps answer the question, write one finding: one plain sentence that says only what that passage says, in its own key words, keeping every number, year and percentage exactly as in the passage, and keeping any 'not' or 'no'. Skip passages that do not help.\nJSON: {"findings": [{"evidence": "E1", "text": "..."}]}` }] }, { meter, onWait });
      for (const f of listIn(rr.json, 'findings')) { const text = String(f?.text || '').trim(); if (text) checkClaim(text, f.evidence ?? f.id, 'Further findings'); }
    } catch (e) { if (stopped(e, signal)) throw e; ctx.log('top-up failed', e.message); }
  }

  // 5c. numbers sanity pass over the kept claims: conflicts, parts above their whole, shares above 100. A claim that fails is never printed as checked.
  for (const c of claims) c.ok = c.checks.filter((k) => k.ok).map((k) => k.n);
  const keptClaims = claims.filter((c) => c.ok.length);
  if (keptClaims.length > 1) {
    step(0.91, 'Checking that the numbers agree with each other');
    // pages that were read, cited or not, may give another value for what a kept claim states: they go into the same labelling call
    const others = rivalSentences(keptClaims.map((c) => ({ id: c.id, text: c.text, urls: c.ok.map((n) => srcs[n - 1].page.url) })), srcs.map((x) => ({ url: x.page.url, text: x.page.text, uncited: !keptClaims.some((c) => c.ok.includes(x.n)) })));
    const sp = await sanityPass(ctx, { claims: keptClaims.map((c) => ({ id: c.id, text: c.text, host: host(srcs[c.ok[0] - 1].page.url) })), others, agentId, signal }, { meter, onWait });
    for (const c of keptClaims) { if (sp.failed.has(c.id)) { c.sanity = sp.failed.get(c.id); c.ok = []; for (const k of c.checks) if (k.ok) { k.ok = false; k.why = 'numbers: ' + c.sanity; k.quote = null; } } else if (sp.notes.has(c.id)) c.note = sp.notes.get(c.id); }
    const rivals = otherValues(sp.items || [], (sp.others || []).filter((o) => others.some((x) => x.id === o.id)));
    for (const c of keptClaims) if (c.ok.length && rivals.has(c.id)) { c.rivals = rivals.get(c.id); c.note = [c.note, ...c.rivals.map((x) => `another page read gives ${x.value}${x.year ? ` (${x.year})` : ''}: [${host(x.url)}](${x.url})`)].filter(Boolean).join('; '); }
  }

  // 5d. its own site could not be read: a point from someone else's page stands only when a second, different site agrees
  const dropped = new Set();
  if (anchor?.domain && !anchor.siteRead) {
    const kept2 = claims.filter((c) => c.ok.length);
    const lone = uncorroborated(kept2.map((c) => ({ id: c.id, text: c.text, ns: c.ok })), srcs.map((x) => x.page));
    for (const c of kept2) if (lone.has(c.id)) { for (const n of c.ok) dropped.add(n); c.sanity = 'only one site says this, and its own site could not be read'; c.ok = []; for (const k of c.checks) if (k.ok) { k.ok = false; k.why = c.sanity; k.quote = null; } }
  }

  // 5e. the Summary holds verified claims only: a summary line no passage supports is left out (kept in the data), and when fewer than
  //     three remain, the first verified claim of each section stands in, with its own citation.
  const summaryLeftOut = claims.filter((c) => c.section === 'Summary' && !c.ok.length);
  for (const c of summaryLeftOut) claims.splice(claims.indexOf(c), 1);
  const summaryList = claims.filter((c) => c.section === 'Summary');
  for (const sec of [...new Set(claims.filter((c) => c.section !== 'Summary').map((c) => c.section))]) { if (summaryList.length >= 3) break; const c = claims.find((x) => x.section === sec && x.ok.length); if (c) summaryList.push(c); }

  // 6. number the sources by first verified use, build the Markdown
  const num = new Map(); const cited = [];
  for (const c of claims) { for (const n of c.ok) if (!num.has(n)) { num.set(n, cited.length + 1); cited.push(srcs[n - 1]); } }
  const passed = claims.filter((c) => c.ok.length).length;
  const sources = cited.filter((s) => /^https?:\/\//.test(s.page.url || '')).map((s, i) => ({ n: i + 1, title: String(s.page.title || '').trim() || host(s.page.url), url: s.page.url, host: host(s.page.url), kind: s.page.kind, chars: s.page.text.length, quotes: claims.flatMap((c) => c.checks.filter((k) => k.ok && k.n === s.n).map((k) => ({ quote: k.quote, claim: c.text }))) }));
  if (screen) for (const n of dropped) { const pg = srcs[n - 1].page; if (!cited.some((x) => x.page.url === pg.url) && !screen.unclear.some((u) => u.url === pg.url)) screen.unclear.push({ title: pg.title, url: pg.url, why: 'no second, independent site agrees with what it says' }); }
  const uncited = good.filter((g) => g.url && !cited.some((s) => s.page.url === g.url) && !(screen?.unclear || []).some((u) => u.url === g.url)).map((g) => ({ title: String(g.title || '').trim() || host(g.url), url: g.url }));
  const line = (c) => c.ok.length ? `${c.text} ${c.ok.map((n) => `[${num.get(n)}]`).join('')}${c.note ? ` *(${c.note})*` : ''}` : `${c.text} *(not checked${c.sanity ? ': ' + c.sanity : ''})*`;
  const sections = summaryList.length ? [{ heading: 'Summary', claims: summaryList }] : []; for (const c of claims.filter((x) => x.section !== 'Summary')) { let s = sections.find((x) => x.heading === c.section); if (!s) sections.push(s = { heading: c.section, claims: [] }); s.claims.push(c); }
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: ctx.settings.get('timeZone') || Intl.DateTimeFormat().resolvedOptions().timeZone });
  const md = [`# ${title}`, '', ...(sources.length < MIN_SOURCES ? [`**${sources.length} ${sources.length === 1 ? 'source' : 'sources'} could be confirmed** (ten were the aim; ${good.length} pages were read).`, ''] : []), ...entityTop(), `*Researched ${date}. ${good.length} pages read, ${sources.length} cited. ${passed} of ${claims.length} claims were checked against the text of their sources; the rest are marked "not checked".*`, '',
    ...sections.flatMap((s) => [`## ${s.heading}`, '', ...(s.heading === 'Summary' ? [s.claims.map(line).join(' ')] : s.claims.map((c) => '- ' + line(c))), '']),
    '## Sources', '', 'Each source is followed by the passage of its page that supports each claim citing it, copied word for word.', '',
    ...sources.flatMap((s) => [`**${s.n}. [${s.title.replace(/[[\]*]/g, '')}](${s.url})** (${s.host})`, '', ...s.quotes.flatMap((q) => [`> "${q.quote.replace(/\s+/g, ' ').trim()}" (supports: ${q.claim})`, '']) ]),
    ...(uncited.length ? ['## Also read, not cited', '', ...uncited.map((u) => `- [${u.title.replace(/[[\]]/g, '')}](${u.url})`), ''] : []),
    ...entityTail(),
    `*Written by ${writer}; passages picked by ${[...pickLabels].join(', ') || 'code (no model answered)'}; every citation checked by code against the fetched page.*`, ''].join('\n');
  const checkedText = (c) => `${c.text} ${c.ok.map((n) => `[${num.get(n)}]`).join('')}`;   // only checked claims go on the card
  const ownLine = anchor?.domain && !anchor.siteRead ? ownSiteLine(anchor) + ' ' : '';
  const summary = ownLine + (summaryList.filter((c) => c.ok.length).map(checkedText).join(' ') || claims.filter((c) => c.ok.length).slice(0, 3).map(checkedText).join(' ')).slice(0, 700);
  const data = { plan, providers, tried, anchor: anchor && { ...anchor, description: anchor.description.slice(0, 300) }, screen: screen && { settled: screen.settled, different: screen.different, unclear: screen.unclear }, claims, summaryLeftOut: summaryLeftOut.map((c) => ({ text: c.text, why: c.checks.map((k) => k.why).join('; ') })), sources, uncited, topUpRounds: rounds, counts: { read: good.length, tried: tried.length, cited: sources.length, claims: claims.length, passed }, labels: [...(meter.labels || [])], writer, modelCalls: meter.calls };
  store.update(rid, { title, markdown: md, summary, data, progress: 0.92, step: 'Saving the report files' });

  // 7. files
  step(0.93, 'Saving Markdown, PDF and Word');
  const files = await writeReport(ctx, { title, markdown: md, sources: sources.map(({ n, title: t, url }) => ({ n, title: t, url })), jobId: job.id, agentId, chatId, signal });
  store.update(rid, { files, status: 'done', progress: 1, step: 'Report ready' });
  const shortSources = sources.map(({ n, title: t, url }) => ({ n, title: t, url }));
  job.card({ kind: 'progress', id: cardId, title: 'Deep research: ' + title, detail: `Report ready: ${sources.length} sources, ${passed} of ${claims.length} claims checked`, progress: 1, status: 'done' });
  job.card({ kind: 'report', title, summary, path: files.md || null, sources: shortSources, go: '#/research/' + rid });
  job.card({ kind: 'sources', items: shortSources });
  return { reportId: rid, title, sources: sources.length, read: good.length, claims: claims.length, passed, files, go: '#/research/' + rid };
}
