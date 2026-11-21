// Council (module 10): three seats and a chairman, spread across the models that answer now; one Verdict.
// Stage 1: each seat answers alone. Stage 2: each seat reviews and ranks the answers, anonymised.
// Stage 3: the chairman writes the Verdict. Method from karpathy/llm-council backend/council.py (no code copied).
import crypto from 'node:crypto';
import { FORMATS, guessFormat } from './formats.js';
import { buildBrief, ownerLine, DEFAULT_QUESTION } from './brief.js';
import { CHAT_DEADLINE_MS } from '../../app/core/model-door.js';
import { liveSlots, spread, modelNote, figuresNote } from './seats.js';
import { answerMessages, rankMessages, chairMessages, parseRanking, aggregate, parseJson, toLastSentence, wholeSentences, continueMessages, joinContinuation, agreement, rankLineFor, parseRecommendation, recommendMessages, plainText, markFigures, markSources, givenFigures, majority, belongsTo } from './stages.js';

const uid = (p) => p + crypto.randomBytes(6).toString('hex');
const nowIso = () => new Date().toISOString();
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const J = (x, f = null) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
const NO_RANK = 'the seats did not rank each other';
/** "answered by X; Y was not answering" when a seat's own model failed and another wrote its answer. */
export const fellBackNote = (a) => a?.text && a.fellBack && a.setLabel && a.label && a.setLabel !== a.label ? `answered by ${a.label}; ${a.setLabel} was not answering` : '';
/** How long a seat may take to start answering: the model door's own limit for one call, counted once across the seat's
 *  fallbacks (each used to get the whole limit again). A seat that has not started by then is skipped and the run goes on.
 *  A thinking model can be quiet for a minute before its first word, so the limit is not shorter. Tests shorten it. */
export const SEAT_WAIT = { ms: CHAT_DEADLINE_MS };
const PREFER = ['gemini', 'router', 'openrouter', 'anthropic', 'openai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'cerebras', 'xai', 'custom', 'ollama'];

export async function activate(ctx) {
  ctx.db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_council_rooms (id TEXT PRIMARY KEY, question TEXT NOT NULL, format TEXT NOT NULL, seats TEXT NOT NULL, chair TEXT, chat_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS m_council_runs (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, job_id TEXT, chat_id TEXT, status TEXT NOT NULL, seats TEXT NOT NULL, chair TEXT, answers TEXT, rankings TEXT, verdict TEXT, error TEXT, created TEXT NOT NULL, finished TEXT);
    CREATE INDEX IF NOT EXISTS m_council_runs_room ON m_council_runs(room_id, created);
  `);
  ctx.db.migrate(2, `ALTER TABLE m_council_rooms ADD COLUMN brief TEXT;`);
  ctx.db.run("UPDATE m_council_runs SET status = 'interrupted', finished = ? WHERE status = 'running'", nowIso());

  // ---------- models the seats can use: whatever the door says is live, spread across providers
  async function options() {
    const act = await ctx.model.active();
    const out = [];
    for (const a of act) {
      if (!a.ok) continue;
      const models = [null, ...[...new Set([a.provider === 'router' ? null : a.model, ...(a.models || [])].filter(m => m && m !== 'auto' && !/embed|bge|minilm|nomic|whisper|tts|rerank/i.test(m)))].slice(0, 8)];
      for (const m of models) out.push({ provider: a.provider, model: m, label: m ? ctx.model.label(a.provider, m) : `${a.label} · auto`, kind: a.kind });
    }
    out.sort((x, y) => (PREFER.indexOf(x.provider) + 1 || 99) - (PREFER.indexOf(y.provider) + 1 || 99));
    return out;
  }
  const offline = () => ctx.settings.get('online') === false;
  /** The live models, spread over the seats and the chairman: other providers first, then other models of one provider. */
  async function live(seatCount = 3) { return spread(liveSlots(await ctx.model.active(), (p, m) => ctx.model.label(p, m)), seatCount, { offline: offline() }); }
  const asModel = (slot) => slot ? { provider: slot.provider, model: slot.model } : null;
  async function defaultSeats(format = 'decision') {
    const f = FORMATS[format] || FORMATS.decision; const l = await live(f.seats.length);
    return f.seats.map((s, i) => ({ ...s, model: asModel(l.seats[i]), modelLabel: l.seats[i]?.label || 'No model' }));
  }
  async function defaultChair() { return asModel((await live()).chair); }

  /** One call for one seat: its own model first; then a live model no other seat sits on, the provider's own choice, the desk's chain. */
  async function seatCall(model, messages, { signal, json = false, maxTokens = 500, spare = [], onDelta, agentId = null }) {
    const tries = model?.provider ? [model, ...spare, ...(model.model ? [{ provider: model.provider, model: null }] : []), null] : [null];
    let last;
    for (const m of tries) {
      try {
        const r = await ctx.model.chat({ purpose: 'council', messages, json, maxTokens, temperature: 0.6, signal, agentId, ...(onDelta ? { onDelta } : {}), ...(m ? { model: m } : {}) });
        return { ...r, fellBack: m !== tries[0] };
      } catch (e) { last = e; if (signal?.aborted || ['halted', 'aborted', 'offline'].includes(e.code)) throw e; }
    }
    throw last;
  }

  // a Verdict stored by an earlier build counted ranking first picks as "agreed N to M": it is shown under its true name
  const trueVerdict = (v) => v && !v.rankLine && /^(agreed \d+ to \d+|all three agreed)$/.test(v.voteLine || '') ? { ...v, rankLine: v.winner ? rankLineFor(v.winner) : '', voteLine: v.winner ? rankLineFor(v.winner) : NO_RANK } : v;
  const runRow = (r) => r && ({ id: r.id, roomId: r.room_id, jobId: r.job_id, chatId: r.chat_id, status: r.status, seats: J(r.seats, []), chair: J(r.chair), answers: J(r.answers, []), rankings: J(r.rankings, []), verdict: trueVerdict(J(r.verdict)), error: r.error, created: r.created, finished: r.finished });
  const roomRow = (r) => r && ({ id: r.id, question: r.question, format: r.format, formatLabel: FORMATS[r.format]?.label || r.format, seats: J(r.seats, []), chair: J(r.chair), chatId: r.chat_id, brief: r.brief || '', created: r.created, updated: r.updated });
  const getRun = (id) => runRow(ctx.db.get('SELECT * FROM m_council_runs WHERE id = ?', id));
  const saveRun = (id, patch) => { const sets = Object.keys(patch).map(k => `${k} = ?`).join(', '); ctx.db.run(`UPDATE m_council_runs SET ${sets} WHERE id = ?`, ...Object.values(patch).map(v => v && typeof v === 'object' ? JSON.stringify(v) : v), id); };

  function verdictText(room, run) {
    const v = run.verdict; const lines = [];
    for (const a of run.answers || []) if (a?.text) { const fb = fellBackNote(a); lines.push(`**${a.name}** (${a.stance} · ${a.label}${fb ? '; ' + fb.replace(/^answered by [^;]+; /, '') : ''}): ${wholeSentences(a.text, 240)}${a.cut ? ' (cut short)' : ''}`); }
    if (v) { lines.push('', `**Verdict · ${v.voteLine}** (written by ${v.label})`, ...(v.agreeLine && v.rankLine ? [v.rankLine] : []), v.decision, ...(v.reasons || []).map(r => '- ' + r), ...(v.agree?.length ? ['Where they agree:', ...v.agree.map(x => '- ' + x)] : []), ...(v.differ?.length ? ['Where they differ:', ...v.differ.map(x => '- ' + x)] : []), ...(v.steps?.length ? ['30-day plan (proposals):', ...v.steps.map((x, i) => `${i + 1}. ${x.text}${x.by ? ' (' + x.by + ')' : ''}`)] : []), ...(v.notes || []).map(n => `*${n}*`)); }
    return lines.join('\n');
  }
  /** The task a plan step becomes: only a proposal until the owner presses the button. */
  const stepArgs = (room, text, why = '', by = '') => FORMATS[room.format]?.plan
    ? { title: clip(text, 80), prompt: `From the Turnaround review (30-day plan)${by ? ', proposed by the ' + by : ''}: ${text}\nPlan the first move and do what you can. Nothing is sent to anyone without the owner approving that item.` }
    : { title: clip(text, 80), prompt: `The Council decided on "${room.question}": ${text}\nReasons: ${why}\nPlan and do the next steps.` };
  function verdictCard(room, run) {
    const v = run.verdict;
    return { kind: 'council.verdict', id: 'council-verdict-' + run.id, runId: run.id, roomId: room.id, title: 'Verdict · ' + v.voteLine, question: room.question, decision: v.decision, reasons: v.reasons, notes: v.notes || [], label: v.label, voteLine: v.voteLine, split: !!v.split, plan: !!FORMATS[room.format]?.plan, agreeLine: v.agreeLine || '', rankLine: v.rankLine || '', agree: v.agree || [], differ: v.differ || [],
      steps: (v.steps || []).map((x, i) => ({ text: x.text, by: x.by, action: { label: 'Turn into a task', tool: 'task_create', step: i, args: stepArgs(room, x.text, '', x.by) } })),
      seats: run.answers.map(a => ({ name: a.name, stance: a.stance, label: a.label, fellBack: fellBackNote(a), summary: wholeSentences(a.text, 240), cut: !!a.cut, ok: !!a.text, late: !!a.late })),
      text: verdictText(room, run),
      actions: [
        ...(v.steps?.length || v.split ? [] : [{ label: 'Turn into a task', tool: 'task_create', args: stepArgs(room, v.decision, (v.reasons || []).join(' ')) }]),
        ...(FORMATS[room.format]?.plan ? [] : [{ label: 'Research this', tool: 'research_deep', args: { question: room.question } }]),
        { label: 'Open the Council', go: '#/research/council/' + room.id },
      ] };
  }

  // ---------- the Turnaround review's brief: counts the Council can reach, written as "not checked" when it cannot
  function gatherFacts() {
    const about = String(ctx.settings.get('business.about') || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    const safe = (fn) => { try { const v = fn(); return Number.isFinite(v) ? v : null; } catch { return null; } };
    const sales = ctx.modules.api('sales'); const totals = (() => { try { return sales?.totals?.() || null; } catch { return null; } })();
    let tasks = null; try { const js = ctx.jobs.list({ limit: 100 }).filter(j => !j.quiet && !String(j.kind).startsWith('council.')); if (js.length) tasks = { of: js.length, running: js.filter(j => j.status === 'running' || j.status === 'waiting').length, done: js.filter(j => j.status === 'done').length, failed: js.filter(j => j.status === 'failed').length }; } catch {}
    return { about, leads: totals ? safe(() => totals.leads) : null, inTalks: totals ? safe(() => totals.inTalks) : null, draftsWaiting: totals ? safe(() => totals.draftsWaiting) : null, customers: sales?.customers ? safe(() => sales.customers().length) : null, tasks };
  }

  /** What every seat and the chairman read: the owner's country and currency and the rule for figures; for a plan, the records too. */
  const briefFor = (format) => [ownerLine({ country: ctx.settings.get('country'), currency: ctx.settings.get('currency'), locale: ctx.settings.get('locale') }), FORMATS[format]?.plan ? buildBrief(gatherFacts()) : ''].filter(Boolean).join('\n\n');

  // ---------- the run
  async function startRun(room, { chatId = null, agentId = null } = {}) {
    const runId = uid('cr_');
    const l = await live(room.seats.length);
    if (!l.distinct) throw Object.assign(new Error(l.notice), { status: 409 });
    let seats = room.seats, chair = room.chair;
    // offline: the door answers only from local models, so seats that sat on online models move to the local ones
    const local = (m) => !m?.provider || m.provider === 'ollama' || String(m.provider).startsWith('lan:');
    if (offline()) { seats = seats.map((s, i) => local(s.model) && s.model ? s : { ...s, model: asModel(l.seats[i]) }); if (!local(chair) || !chair) chair = asModel(l.chair); }
    const same = (a, b) => a && b && a.provider === b.provider && (a.model || null) === (b.model || null);
    const spare = l.spare.map(asModel).filter(x => !seats.some(s => same(s.model, x)) && !same(chair, x));
    const spareFor = (i) => spare.length ? [...spare.slice(i % spare.length), ...spare.slice(0, i % spare.length)] : [];
    ctx.db.run('INSERT INTO m_council_runs (id, room_id, chat_id, status, seats, chair, answers, rankings, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', runId, room.id, chatId, 'running', JSON.stringify(seats), JSON.stringify(chair), '[]', '[]', nowIso());
    const emit = (stage, extra = {}) => ctx.events.emit('council', { runId, roomId: room.id, stage, ...extra });
    const job = await ctx.jobs.start({ kind: 'council.ask', title: 'Council: ' + clip(room.question, 70), agentId, chatId, input: { question: room.question, roomId: room.id, runId }, async run(job) {
      const signal = job.signal; const plan = !!FORMATS[room.format]?.plan;
      const card = (detail, progress, status = 'running') => job.card({ kind: 'progress', id: 'council-' + runId, title: 'Council: ' + clip(room.question, 70), detail, progress, status, go: '#/research/council/' + room.id });
      const answers = seats.map(s => ({ seatId: s.id, name: s.name, stance: s.stance, text: null, label: null, error: null }));
      // what reaches the screen: plain text, every figure no record gave marked on that figure, in the owner's currency
      const given = givenFigures(room.question + ' ' + (room.brief || '')); const currency = ctx.settings.get('currency') || '';
      const shown = (x) => markSources(markFigures(plainText(x), { given, currency }));
      /** One seat's call with its own stop: skipped when no reply has started within the door's own first-answer limit. */
      async function inTime(fn) {
        const ac = new AbortController(); const stop = () => ac.abort('aborted'); signal.addEventListener('abort', stop, { once: true });
        let started = false, late = false;
        const timer = setTimeout(() => { if (!started) { late = true; ac.abort('late'); } }, SEAT_WAIT.ms);
        try { return await fn(ac.signal, () => { started = true; }); }
        catch (e) { if (late && !signal.aborted) throw Object.assign(new Error('did not answer in time'), { code: 'late' }); throw e; }
        finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
      }
      try {
        // stage 1: each seat on its own, in parallel
        job.progress(0.05, 'The seats are answering'); card('The seats are answering', 0.05); emit('answering');
        let done = 0;
        await Promise.all(seats.map(async (s, i) => {
          try { await inTime(async (signal, started) => {
            const msgs = answerMessages(room.question, s, FORMATS[room.format], room.brief);
            const r = await seatCall(s.model, msgs, { signal, maxTokens: 900, spare: spareFor(i), onDelta: started, agentId: s.agentId });
            let text = String(r.text || '').trim(), cut = false;
            if (text && r.cutOff === true) {
              // the model door says the reply hit its length limit: ask the same model once to finish; if that is cut off too
              // (or fails), keep the full sentences only. The last character is never the signal.
              let still = true;
              try { const c = await seatCall({ provider: r.provider, model: r.model }, continueMessages(msgs, text), { signal, maxTokens: 300, agentId: s.agentId }); text = joinContinuation(text, c.text); still = c.cutOff === true; }
              catch (e) { if (signal.aborted || e.code === 'halted' || e.code === 'aborted') throw e; }
              if (still) { text = toLastSentence(text) || text.replace(/\s+\S*$/, '') + '…'; cut = true; }
            }
            // the seat's own recommendation line; on a miss, the same model is asked once for that line alone
            let recommendation = parseRecommendation(text);
            if (text && !recommendation) {
              try { const c = await ctx.model.chat({ purpose: 'council', messages: recommendMessages(msgs, text), maxTokens: 200, temperature: 0.2, signal, agentId: s.agentId, model: { provider: r.provider, model: r.model } }); recommendation = parseRecommendation(c.text, { bare: true }); }
              catch (e) { if (signal.aborted || e.code === 'halted' || e.code === 'aborted') throw e; }
            }
            answers[i] = { ...answers[i], text: shown(text), cut, recommendation: recommendation && shown(recommendation), label: r.label, fellBack: r.fellBack, setLabel: label(s.model), ms: r.ms };
          }); } catch (e) { if (signal.aborted || e.code === 'halted' || e.code === 'aborted') throw e; answers[i].error = e.message; if (e.code === 'late') answers[i].late = true; }
          done++; saveRun(runId, { answers });
          const msg = answers[i].text ? `${s.name} answered (${answers[i].label})` : answers[i].late ? `${s.name} did not answer in time` : `${s.name} could not answer`;
          job.progress(0.05 + 0.4 * done / seats.length, msg); card(msg, 0.05 + 0.4 * done / seats.length); emit('answer', { seat: i, answer: answers[i] });
        }));
        const ok = answers.map((a, i) => ({ ...a, i })).filter(a => a.text);
        if (ok.length < 2) throw new Error('Fewer than two seats answered, so there is nothing to compare. ' + answers.filter(a => a.error).map(a => `${a.name}: ${clip(a.error, 120)}`).join(' '));
        // stage 2: each seat ranks the answers, which are shown under letters in a shuffled order
        const order = ok.map(a => a.i).sort(() => Math.random() - 0.5);
        const letters = order.map((_, k) => String.fromCharCode(65 + k));
        const byLetter = Object.fromEntries(order.map((i, k) => [letters[k], i]));
        const rankings = [];
        job.progress(0.5, 'The seats are ranking each other'); card('The seats are ranking each other, without names', 0.5); emit('ranking');
        let ranked = 0;
        await Promise.all(seats.map(async (s, i) => {
          if (!answers[i].text) return;
          try {
            const r = await inTime((signal, started) => seatCall(s.model, rankMessages(room.question, order.map((ai, k) => ({ letter: letters[k], text: answers[ai].text }))), { signal, json: true, maxTokens: 900, spare: spareFor(i), onDelta: started, agentId: s.agentId }));
            const parsed = parseRanking(r, letters);
            rankings.push({ seat: i, name: s.name, label: r.label, order: parsed.order, ranked: parsed.order.map(l => answers[byLetter[l]].name), notes: Object.fromEntries(Object.entries(parsed.notes).filter(([l]) => byLetter[l] != null).map(([l, v]) => [answers[byLetter[l]].name, v])), raw: parsed.order.length ? null : clip(r.text, 300) });
          } catch (e) { if (signal.aborted || e.code === 'halted' || e.code === 'aborted') throw e; rankings.push({ seat: i, name: s.name, error: e.message, order: [] }); }
          ranked++; saveRun(runId, { rankings });
          const last = rankings[rankings.length - 1];
          const msg = last.order.length ? `${s.name} ranked the answers (${last.label})` : `${s.name} could not rank`;
          job.progress(0.5 + 0.3 * ranked / ok.length, msg); card(msg, 0.5 + 0.3 * ranked / ok.length); emit('rank', { seat: i, ranking: last });
        }));
        const agg = aggregate(rankings, byLetter, answers);
        const recs = ok.map(a => ({ name: a.name, recommendation: a.recommendation }));
        agg.agreeLine = agreement(recs); agg.major = majority(recs);
        // stage 3: the chairman writes the Verdict
        job.progress(0.85, 'The chairman is writing the Verdict'); card('The chairman is writing the Verdict', 0.85); emit('verdict-writing');
        let r = await seatCall(chair, chairMessages(room.question, answers, seats, agg, { plan, brief: room.brief }), { signal, json: true, maxTokens: plan ? 1800 : 1200, agentId: chair?.agentId });
        const usable = (x) => x && [x.decision, x.answer].some(v => typeof v === 'string' && v.trim()) ? x : null;   // JSON without a decision is no Verdict
        let j = usable(parseJson(r));
        if (!j) { r = await seatCall(chair, chairMessages(room.question, answers, seats, agg, { plan, brief: room.brief }), { signal, json: true, maxTokens: 2400, agentId: chair?.agentId }); j = usable(parseJson(r)); }   // cut off or unreadable: once more, with more room
        if (!j) {            // still cut off: take the decision as far as its last full sentence, never half a sentence
          const m = String(r.text || '').match(/"decision"\s*:\s*"((?:[^"\\]|\\.)*)/);
          const raw = m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : String(r.text || '').replace(/[{}"]/g, ' ');
          j = { decision: toLastSentence(raw) || 'The chairman could not finish the Verdict. Run it again.' };
        }
        const whole = (x, n) => shown(wholeSentences(plainText(x), n));
        const verdict = {
          decision: whole(j.decision || j.answer, 400), reasons: (Array.isArray(j.reasons) ? j.reasons : []).map(x => whole(x, 220)).filter(Boolean).slice(0, 2),
          answer: whole(j.answer || '', 1600), label: r.label, winner: agg.winner != null ? answers[agg.winner].name : null,
          // the headline says what it counts: the seats' own recommendation lines when any seat gave one, else the ranking under its own name
          agreeLine: agg.agreeLine, rankLine: agg.rankLine, voteLine: agg.agreeLine || agg.rankLine || NO_RANK,
          vote: agg.vote, averages: agg.averages,
        };
        if (plan) {
          const lines = (x) => (Array.isArray(x) ? x : []).map(v => whole(typeof v === 'string' ? v : v?.text || '', 200)).filter(Boolean).slice(0, 5);
          verdict.agree = lines(j.agree); if (!verdict.agree.length && agg.major) verdict.agree = [agg.agreeLine];   // a "seats differ" line is no agreement
          verdict.differ = lines(j.differ);
          verdict.steps = (Array.isArray(j.steps) ? j.steps : []).map(x => typeof x === 'string' ? { text: whole(x, 200), by: '' } : { text: whole(x?.step || x?.text || '', 200), by: seats.some(s => s.name === x?.by) ? x.by : '' }).filter(x => x.text).slice(0, 6);
        }
        // the text under the Verdict belongs to its count: a decision against the seats' majority course gives way to the seats' own words
        // with no majority, it must follow one seat's own course, or the Verdict says the seats differ in their own words
        const firstOf = (n) => { const a = answers.find(x => x.name === n); return `${n}: ${wholeSentences(String(a?.text || '').split(/(?<=[.!?])\s/)[0], 220)}`; };
        const withRec = recs.filter(x => x.recommendation);
        let followed = true;
        if (agg.major && !belongsTo(verdict.decision, agg.major.course)) {
          followed = false;
          verdict.decision = agg.major.course.charAt(0).toUpperCase() + agg.major.course.slice(1) + '.';
          verdict.reasons = agg.major.names.slice(0, 2).map(firstOf);
          verdict.answer = '';
          if (verdict.steps) verdict.steps = verdict.steps.filter(x => agg.major.names.includes(x.by));
        } else if (!agg.major && withRec.length) {
          // no majority: the Verdict says the seats differ, so its text is each seat's own line, and a chairman's text that
          // follows one seat's course is shown as that seat's (the best-ranked such seat), never as the Council's decision
          verdict.split = true;
          const rank = (n) => agg.averages.find(x => x.name === n)?.avg ?? 9;
          const near = withRec.filter(x => belongsTo(verdict.decision, x.recommendation)).sort((a, b) => rank(a.name) - rank(b.name))[0];
          followed = !!near;
          verdict.decision = 'The seats differ, so there is no one course yet. ' + (near ? `The chairman's text follows the ${near.name}'s course: ${verdict.decision}` : 'Each seat\'s own line is listed below.');
          verdict.reasons = withRec.slice(0, 4).map(x => firstOf(x.name));
          verdict.answer = '';
        }
        // plain notes on the result: one model for every seat, offline, and figures no page was read for
        const noAgree = agg.agreeLine ? '' : 'No seat gave a clear recommendation, so the Verdict cannot say how far the seats agree' + (agg.rankLine ? '; the headline shows how they ranked each other instead.' : '.');
        verdict.notes = [noAgree, followed ? '' : (agg.major ? 'The chairman\'s text went against what most seats recommend' : 'The chairman\'s text followed no seat\'s own course') + ', so the Verdict shows the seats\' own words.', modelNote(answers), offline() ? 'The desk was offline, so the Council ran on local models only.' : '', figuresNote(room.question + ' ' + (room.brief || ''), answers, { ...verdict, steps: verdict.steps }, { plan })].filter(Boolean);
        saveRun(runId, { verdict, status: 'done', finished: nowIso() });
        ctx.db.run('UPDATE m_council_rooms SET updated = ? WHERE id = ?', nowIso(), room.id);
        const run = getRun(runId);
        card('Verdict ready · ' + verdict.voteLine, 1, 'done'); job.card(verdictCard(room, run)); emit('done', { verdict });
        return { runId, roomId: room.id, decision: verdict.decision, vote: verdict.voteLine, reasons: verdict.reasons, notes: verdict.notes, label: verdict.label, seats: answers.map(a => ({ name: a.name, label: a.label, answered: !!a.text })) };
      } catch (e) {
        const stopped = signal.aborted || e.code === 'halted' || e.code === 'aborted';
        saveRun(runId, { status: stopped ? 'stopped' : 'failed', error: stopped ? 'Stopped' : clip(e.message, 500), finished: nowIso() });
        card(stopped ? 'Stopped' : 'Failed: ' + clip(e.message, 160), 1, stopped ? 'stopped' : 'failed'); emit(stopped ? 'stopped' : 'failed', { error: e.message });
        throw e;
      }
    } });
    saveRun(runId, { job_id: job.id });
    return { ...job, runId, roomId: room.id };
  }

  async function makeRoom({ question, format, seats, chair, chatId }) {
    const plan = !!FORMATS[format]?.plan;
    const q = clip(question, 1000) || (plan ? DEFAULT_QUESTION : ''); if (!q) throw Object.assign(new Error('Ask the Council a question first.'), { status: 400 });
    const f = FORMATS[format] ? format : guessFormat(q);
    const base = await defaultSeats(f);
    const list = base.map((s, i) => ({ ...s, ...(seats?.[i] || {}), model: seats?.[i]?.model !== undefined ? seats[i].model : s.model }));
    const room = { id: uid('room_'), question: q, format: f, seats: list.map(({ modelLabel, ...s }) => s), chair: chair || await defaultChair(), chatId, brief: briefFor(f) };
    ctx.db.run('INSERT INTO m_council_rooms (id, question, format, seats, chair, chat_id, brief, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', room.id, room.question, room.format, JSON.stringify(room.seats), JSON.stringify(room.chair), chatId, room.brief, nowIso(), nowIso());
    return roomRow(ctx.db.get('SELECT * FROM m_council_rooms WHERE id = ?', room.id));
  }
  async function ask({ question, chatId = null, seats, format, chair, agentId = null } = {}) {
    const l = await live(); if (!l.distinct) throw Object.assign(new Error(l.notice), { status: 409 });
    const room = await makeRoom({ question, format, seats, chair, chatId });
    return startRun(room, { chatId, agentId });
  }
  async function rerun(roomId, { seats, chair, chatId } = {}) {
    const room = roomRow(ctx.db.get('SELECT * FROM m_council_rooms WHERE id = ?', roomId)); if (!room) throw Object.assign(new Error('That room is gone.'), { status: 404 });
    if (Array.isArray(seats)) room.seats = room.seats.map((s, i) => ({ ...s, ...(seats[i]?.model !== undefined ? { model: seats[i].model } : {}), ...(seats[i]?.name ? { name: clip(seats[i].name, 40) } : {}), ...(seats[i]?.stance ? { stance: clip(seats[i].stance, 60) } : {}) }));
    if (chair !== undefined) room.chair = chair;
    room.brief = briefFor(room.format); ctx.db.run('UPDATE m_council_rooms SET brief = ? WHERE id = ?', room.brief, room.id);   // the records and settings may have changed since
    ctx.db.run('UPDATE m_council_rooms SET seats = ?, chair = ?, updated = ? WHERE id = ?', JSON.stringify(room.seats), JSON.stringify(room.chair), nowIso(), room.id);
    return startRun(room, { chatId: chatId ?? null });
  }

  // ---------- routes
  const label = (m) => m?.provider ? (m.model ? ctx.model.label(m.provider, m.model) : ctx.model.label(m.provider) + ' · auto') : 'Default model';
  const decorate = (room) => room && ({ ...room, seats: room.seats.map(s => ({ ...s, modelLabel: label(s.model) })), chairLabel: label(room.chair) });
  const fail = (res, e) => ctx.json(res, { error: e.message }, e.status || (e.code === 'halted' ? 409 : 500));
  ctx.route('GET', '/formats', (req, res) => ctx.json(res, { formats: Object.values(FORMATS).map(f => ({ id: f.id, label: f.label, blurb: f.blurb, plan: !!f.plan })) }));
  ctx.route('GET', '/models', async (req, res) => ctx.json(res, { options: await options() }));
  ctx.route('GET', '/defaults', async (req, res, { query }) => { const l = await live(); ctx.json(res, { seats: await defaultSeats(query.format || 'decision'), chair: { ...asModel(l.chair), label: l.chair?.label || 'No model' }, distinct: l.distinct, notice: l.notice, offline: offline() }); });
  ctx.route('GET', '/rooms', (req, res) => {
    const rooms = ctx.db.all('SELECT * FROM m_council_rooms ORDER BY updated DESC LIMIT 100').map(roomRow);
    ctx.json(res, { rooms: rooms.map(r => { const last = runRow(ctx.db.get('SELECT * FROM m_council_runs WHERE room_id = ? ORDER BY created DESC LIMIT 1', r.id)); return { id: r.id, question: r.question, formatLabel: r.formatLabel, updated: r.updated, status: last?.status || null, voteLine: last?.verdict?.voteLine || null, decision: last?.verdict?.decision || null }; }) });
  });
  ctx.route('GET', '/rooms/:id', (req, res, { params }) => {
    const room = roomRow(ctx.db.get('SELECT * FROM m_council_rooms WHERE id = ?', params.id)); if (!room) return ctx.json(res, { error: 'Not found' }, 404);
    ctx.json(res, { room: decorate(room), runs: ctx.db.all('SELECT * FROM m_council_runs WHERE room_id = ? ORDER BY created DESC LIMIT 20', room.id).map(runRow) });
  });
  ctx.route('GET', '/runs/:id', (req, res, { params }) => { const r = getRun(params.id); r ? ctx.json(res, { run: r }) : ctx.json(res, { error: 'Not found' }, 404); });
  ctx.route('POST', '/ask', async (req, res, { body }) => { try { const j = await ask({ question: body?.question, format: body?.format, seats: body?.seats, chair: body?.chair, chatId: body?.chatId || null }); ctx.json(res, { jobId: j.id, runId: j.runId, roomId: j.roomId }); } catch (e) { fail(res, e); } });
  ctx.route('POST', '/rooms/:id/run', async (req, res, { params, body }) => { try { const j = await rerun(params.id, { seats: body?.seats, chair: body?.chair }); ctx.json(res, { jobId: j.id, runId: j.runId, roomId: j.roomId }); } catch (e) { fail(res, e); } });
  // the Verdict's buttons: hand the decision to Tasks or Research (null when that module is off)
  ctx.route('POST', '/runs/:id/action', async (req, res, { params, body }) => {
    const run = getRun(params.id); if (!run?.verdict) return ctx.json(res, { error: 'That Verdict is not ready.' }, 404);
    const room = roomRow(ctx.db.get('SELECT * FROM m_council_rooms WHERE id = ?', run.roomId));
    const card = verdictCard(room, run);
    const a = body?.step != null ? card.steps[Number(body.step)]?.action : card.actions.find(x => x.tool === (body?.action === 'research' ? 'research_deep' : 'task_create'));
    if (!a) return ctx.json(res, { error: 'That step is not in this Verdict.' }, 404);
    try {
      if (a.tool === 'task_create') { const api = ctx.modules.api('tasks'); if (!api?.create) return ctx.json(res, { error: 'Tasks is not on, so the Verdict cannot become a task yet.' }, 409); const j = await api.create({ ...a.args, agentId: 'coordinator', chatId: run.chatId }); return ctx.json(res, { ok: true, go: '#/tasks', jobId: j?.id || null }); }
      const api = ctx.modules.api('research'); if (!api?.deep) return ctx.json(res, { error: 'Research is not on yet.' }, 409);
      const j = await api.deep({ question: room.question, chatId: run.chatId, agentId: 'scout' }); return ctx.json(res, { ok: true, go: '#/research', jobId: j?.id || null });
    } catch (e) { fail(res, e); }
  });
  ctx.route('DELETE', '/rooms/:id', (req, res, { params, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can delete a room.' }, 403);
    ctx.db.run('DELETE FROM m_council_runs WHERE room_id = ?', params.id); ctx.db.run('DELETE FROM m_council_rooms WHERE id = ?', params.id); ctx.json(res, { ok: true });
  });

  ctx.tool({ name: 'council_ask', description: 'Ask the Council: three seats answer on their own (spread across the models that are answering now), rank each other without names, and a chairman gives one Verdict with the vote. The seats answer from what the models know; they do not read pages. Use for decisions (build or buy, yes or no) and hard open questions.',
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'The question or decision, in the owner\'s words' }, format: { type: 'string', enum: Object.keys(FORMATS) } }, required: ['question'] },
    async run(args, call) { const j = await ask({ question: args.question, format: args.format, chatId: call.chatId || null, agentId: call.agentId || null }); return { started: true, jobId: j.id, note: 'The Council is meeting. Each seat\'s answer and the Verdict will appear in this chat.', open: '#/research/council/' + j.roomId }; } });

  ctx.expose({ ask, rerun, defaultSeats, options, getRun, formats: () => FORMATS });
  return { async deactivate() {} };
}
