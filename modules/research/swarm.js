// Swarm: one model call splits the task into N parts; the parts run in parallel under a concurrency cap (queued tiles
// show "waiting", rate limits back off instead of failing), each scout on a different live model where more than one
// answers. Scouts return structured findings, each with its source. The merge is code: no finding with a source is
// dropped unless it is a duplicate, URLs are kept whole, and the count printed is the count listed.
import { askModel, asSource, DATA_RULE, passages, pool, stopped, sleep, host, words, norm, shortTitle } from './util.js';

const GENERIC = new Set('compare comparison find list best most popular main three four five several each their about what which explain describe overview guide typical strengths weaknesses pros cons give show tell research report sources latest current work works working main drawback using used'.split(' '));
/** The words a page must mention to count as on topic: names (capitals, digits, dots) when the task has any, else its content words. */
export function distinctiveWords(task) {
  const t = String(task || '');
  const names = [...new Set((t.match(/[A-Za-z0-9][\w.-]*[A-Za-z0-9]/g) || []).filter((w, i) => (/[A-Z]/.test(w.slice(1)) || /\d/.test(w) || /\w\.\w/.test(w) || (/^[A-Z]/.test(w) && t.indexOf(w) > 0 && !/[.:?!]\s*$/.test(t.slice(0, t.indexOf(w))))) && w.length > 2 && !GENERIC.has(w.toLowerCase())).map((w) => w.toLowerCase()))];
  if (names.length) return { names, need: 1 };
  const content = words(t).filter((w) => w.length > 3 && !GENERIC.has(w));
  return { names: content, need: Math.min(2, content.length) };
}
export function mentionsTopic(text, d) {
  if (!d.names.length) return true;
  const t = String(text || '').toLowerCase(); let n = 0;
  for (const w of d.names) if (t.includes(w) || (w.length > 5 && t.includes(w.slice(0, -1)))) n++;
  return n >= d.need;
}
/** The live models scouts can be spread across: every model of the router, plus each other live provider's model. */
export async function liveModels(ctx) {
  let act = []; try { act = await ctx.model.active(); } catch { return []; }
  const out = [];
  for (const a of act) {
    if (!a.ok) continue;
    const id = (m) => (typeof m === 'string' ? m : m?.id || m?.name);
    if (a.provider === 'router') for (const m of a.models || []) { if (id(m) && id(m) !== 'auto') out.push({ provider: 'router', model: id(m) }); }
    else if (a.kind === 'keyed' || a.kind === 'lan' || (a.kind === 'local' && a.model)) { if (a.model) out.push({ provider: a.provider, model: a.model }); }
  }
  const seen = new Set(); return out.filter((m) => { const k = m.provider + '|' + m.model; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
}

/**
 * tiles: [{ agent, title, status, label, findings: [{ text, url, title }] }]  ->  one answer built by code.
 * Every finding with a source is listed once; duplicates (same words, same source) are merged; URLs are never shortened.
 */
export function mergeFindings(tiles, overview = '') {
  const sources = []; const idx = new Map(); const seen = []; const groups = []; let dupes = 0;
  const same = (a, b) => { const A = new Set(words(a)), B = new Set(words(b)); const inter = [...A].filter((w) => B.has(w)).length; return norm(a) === norm(b) || (A.size > 3 && inter / Math.max(A.size, B.size) >= 0.9); };
  for (const t of tiles) {
    const items = [];
    for (const f of t.findings || []) {
      if (!f?.text || !/^https?:\/\//.test(f.url || '')) continue;
      if (seen.some((x) => x.url === f.url && same(x.text, f.text))) { dupes++; continue; }
      if (!idx.has(f.url)) { idx.set(f.url, sources.length + 1); sources.push({ n: sources.length + 1, title: String(f.title || '').trim() || host(f.url), url: f.url }); }
      seen.push(f); items.push({ text: String(f.text).trim(), n: idx.get(f.url) });
    }
    if (items.length) groups.push({ agent: t.agent, title: t.title, label: t.label, items });
  }
  const count = groups.reduce((a, g) => a + g.items.length, 0);
  const labels = [...new Set(groups.map((g) => g.label).filter(Boolean))];
  const modelsLine = !groups.length ? '' : labels.length <= 1 ? `All scouts ran on one model${labels[0] ? ` (${labels[0]})` : ''}.` : `The scouts ran on ${labels.length} different models.`;
  const text = [`**${count} ${count === 1 ? 'finding' : 'findings'} from ${groups.length} ${groups.length === 1 ? 'scout' : 'scouts'}.** ${modelsLine}${dupes ? ` ${dupes} repeated ${dupes === 1 ? 'finding was' : 'findings were'} merged.` : ''}`, '',
    ...(overview ? [overview.trim(), ''] : []),
    ...groups.flatMap((g) => [`### ${g.title}`, `*${g.agent}${g.label ? ' · ' + g.label : ''}*`, '', ...g.items.map((x) => `- ${x.text} [${x.n}]`), '']),
    '### Sources', '', ...sources.map((s) => `${s.n}. ${s.title.replace(/[[\]]/g, '')}: ${s.url}`)].join('\n');
  return { text, count, scouts: groups.length, sources, groups, dupes, oneModel: labels.length <= 1, labels };
}

export async function runSwarm(ctx, job, { sid, task, agents, agentId, chatId, store, concurrency = 4 }) {
  const search = ctx.modules.api('search');
  if (!search) throw new Error('The Search module is off, so the swarm cannot read the web.');
  if (ctx.settings.get('online') === false) throw Object.assign(new Error('The desk is offline. Research needs the internet.'), { code: 'offline' });
  const signal = job.signal; const meter = { calls: 0 }; const cache = new Map();
  const cardId = 'swarm-' + sid;
  const save = (patch) => { store.update(sid, patch); };
  const tick = (p, detail) => { job.throwIfStopped(); job.progress(p, detail); job.card({ kind: 'progress', id: cardId, title: 'Swarm: ' + shortTitle(task, 70), detail, progress: p, status: 'running' }); };
  const topic = distinctiveWords(task);

  // 1. split
  tick(0.03, `Splitting the job for ${agents} agents`);
  let parts = [{ title: shortTitle(task, 80), query: task }];
  for (let attempt = 0; agents > 1 && parts.length < 2 && attempt < 2; attempt++) {     // an unusable split gets one more try
    try {
      const r = await askModel(ctx, { agentId, purpose: 'plan', json: true, signal, maxTokens: 300 + agents * 60, messages: [
        { role: 'system', content: 'You split a job into independent parts for parallel web research agents. Reply with JSON only.' },
        { role: 'user', content: `Job: "${task}"\nSplit it into exactly ${agents} distinct parts that together cover the job, with no overlap. Every search query must keep the job's own names and key words. JSON: {"parts": [{"title": "a few words", "query": "a short web search query for this part"}]}` }] }, { meter });
      const got = (r.json?.parts || []).filter((p) => p?.query).slice(0, agents).map((p) => ({ title: shortTitle(p.title || p.query, 80), query: String(p.query).slice(0, 200) }));
      if (got.length) parts = got; else ctx.log('split gave no parts', r.label);
    } catch (e) { if (stopped(e, signal)) throw e; ctx.log('split failed', e.message); }
  }
  const models = await liveModels(ctx);
  const tiles = parts.map((p, i) => ({ i, agent: `Scout ${i + 1}`, title: p.title, query: p.query, status: 'waiting', detail: 'Waiting for a free slot', progress: 0, pick: models.length > 1 ? models[i % models.length] : null }));
  const emit = () => { save({ tiles }); ctx.events.emit('research', { kind: 'swarm', id: sid, tiles }); };
  const setTile = (t, patch) => { Object.assign(t, patch); emit(); const done = tiles.filter((x) => ['done', 'failed'].includes(x.status)).length; tick(0.08 + 0.77 * (done / tiles.length), `${done} of ${tiles.length} parts done, ${tiles.filter((x) => x.status === 'running').length} running`); };
  emit();
  let searchError = null;

  // 2. parts in parallel
  await pool(tiles, Math.max(1, concurrency), async (t) => {
    if (signal.aborted) return;
    try {
      setTile(t, { status: 'running', detail: 'Searching', progress: 0.1 });
      const rows = await search.search(t.query, { count: 8, signal });
      if (!rows.length && rows.error) { searchError = rows.error; return setTile(t, { status: 'failed', detail: rows.error.slice(0, 200), progress: 1 }); }
      const pages = []; let offTopic = 0;
      for (const r of rows) {
        if (pages.length >= 2) break;
        setTile(t, { detail: `Reading ${host(r.url)}`, progress: 0.2 + 0.2 * pages.length });
        try { const p = await search.read(r.url, { signal, cache }); if (p.text.length < 400) continue; if (!mentionsTopic(p.title + ' ' + p.text, topic)) { offTopic++; continue; } pages.push(p); } catch (e) { if (stopped(e, signal) || e.code === 'offline') throw e; }
      }
      if (!pages.length) return setTile(t, { status: 'failed', detail: offTopic ? `No page on the topic (${offTopic} off-topic pages left out)` : 'No page could be read', progress: 1 });
      setTile(t, { detail: 'Writing its findings', progress: 0.7 });
      const ask = (model) => askModel(ctx, { agentId, purpose: 'research', json: true, signal, maxTokens: 900, temperature: 0.2, ...(model ? { model } : {}), messages: [
        { role: 'system', content: `You are one agent of a research swarm. ${DATA_RULE} Reply with JSON only.` },
        { role: 'user', content: `Whole job: "${task}"\nYour part: "${t.title}"\n\n${pages.map((p, k) => asSource(k + 1, p, passages(p.text, task + ' ' + t.title, 2500))).join('\n\n')}\n\nGive 2 to 6 findings for your part, using only these sources. Each finding is one plain, specific sentence (names, numbers and dates as the source gives them) with the number of the source that states it. If the sources say nothing about your part, give an empty list.\nJSON: {"findings": [{"text": "...", "source": 1}]}` }] }, { meter, onWait: () => setTile(t, { status: 'waiting', detail: 'Models are busy; waiting' }) });
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await ask(attempt === 0 ? t.pick : null);       // the scout's own model first; the desk's default chain if that one fails
          t.label = r.label;
          t.findings = (Array.isArray(r.json?.findings) ? r.json.findings : []).map((f) => { const p = pages[Number(f?.source) - 1]; return p && String(f.text || '').trim() ? { text: String(f.text).trim(), url: p.url, title: p.title } : null; }).filter(Boolean);
          if (!t.findings.length && attempt === 0 && t.pick) { setTile(t, { detail: 'Its model gave nothing usable; trying the desk\'s default model' }); continue; }
          t.sources = pages.map((p, k) => ({ k: k + 1, title: p.title, url: p.url }));
          return setTile(t, { status: 'done', detail: `${t.findings.length} ${t.findings.length === 1 ? 'finding' : 'findings'} · ${r.label}`, progress: 1 });
        } catch (e) {
          if (stopped(e, signal) || attempt >= 2) throw e;
          if (attempt === 1 || !t.pick) { setTile(t, { status: 'waiting', detail: 'Waiting to retry' }); await sleep(20000, signal); }
          setTile(t, { status: 'running', detail: 'Writing its findings' });
        }
      }
    } catch (e) { if (stopped(e, signal) || e.code === 'offline') throw e; setTile(t, { status: 'failed', detail: e.message.slice(0, 200), progress: 1 }); }
  });
  job.throwIfStopped();

  // 3. merge in code; the model only adds a short overview
  const done = tiles.filter((t) => t.status === 'done');
  if (!done.length) throw Object.assign(new Error(searchError ? `${searchError}. Try again in a few minutes.` : 'No part of the swarm finished: ' + [...new Set(tiles.map((t) => t.detail))].join('; ')), { code: searchError ? 'search_failed' : 'failed' });
  let m = mergeFindings(done);
  tick(0.88, `Merging ${m.count} findings from ${m.scouts} scouts`);
  let label = null;
  if (m.count >= 2) {
    try {
      const r = await askModel(ctx, { agentId, purpose: 'research', signal, maxTokens: 500, temperature: 0.2, messages: [
        { role: 'system', content: 'You write a short overview of research findings in plain words. Use only the findings given; keep their source numbers like [3] on what you take from them. Never say that little or nothing was found: the findings follow your overview.' },
        { role: 'user', content: `Job: "${task}"\n\n${m.groups.map((g) => `${g.title}:\n${g.items.map((x) => `- ${x.text} [${x.n}]`).join('\n')}`).join('\n\n')}\n\nWrite 3 to 5 sentences that answer the job from these ${m.count} findings.` }] }, { meter });
      const overview = r.text.replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (x, l) => l.split(',').map((y) => `[${y.trim()}]`).join('')).replace(/\[(\d+)\]/g, (x, d) => (m.sources[Number(d) - 1] ? x : '')).replace(/https?:\/\/\S+/g, '').trim();
      if (overview && !/almost nothing|nothing (exists|was found)|no (relevant )?information|little (exists|information)/i.test(overview)) { label = r.label; m = mergeFindings(done, overview); }
    } catch (e) { if (stopped(e, signal)) throw e; ctx.log('overview failed; the findings stand on their own', e.message); }
  }
  const failed = tiles.filter((t) => t.status === 'failed').length;
  save({ status: 'done', answer: m.text, sources: m.sources, label, tiles, data: { modelCalls: meter.calls, labels: [...(meter.labels || [])], scoutModels: m.labels, oneModel: m.oneModel, findings: m.count, scouts: m.scouts, failed } });
  ctx.events.emit('research', { kind: 'swarm', id: sid, tiles, done: true });
  job.card({ kind: 'progress', id: cardId, title: 'Swarm: ' + shortTitle(task, 70), detail: `Done: ${m.count} findings from ${m.scouts} scouts, ${m.sources.length} sources`, progress: 1, status: 'done' });
  job.card({ kind: 'text', text: `**Swarm answer**\n\n${m.text}` });
  if (m.sources.length) job.card({ kind: 'sources', items: m.sources });
  return { swarmId: sid, parts: tiles.length, done: done.length, failed, findings: m.count, scouts: m.scouts, sources: m.sources.length, oneModel: m.oneModel, scoutModels: m.labels, label, go: '#/research/swarm/' + sid };
}
