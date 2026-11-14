// Council (module 10): three seats and a chairman, spread across the models that answer now; one Verdict.
// Stage 1: each seat answers alone. Stage 2: each seat reviews and ranks the answers, anonymised.
// Stage 3: the chairman writes the Verdict. Method from karpathy/llm-council backend/council.py (no code copied).
import crypto from 'node:crypto';
import { FORMATS, guessFormat } from './formats.js';
import { liveSlots, spread, modelNote, figuresNote } from './seats.js';
import { answerMessages, rankMessages, chairMessages, parseRanking, aggregate, parseJson, toLastSentence, wholeSentences, continueMessages, joinContinuation, agreeMessages, agreement, rankLineFor } from './stages.js';

const uid = (p) => p + crypto.randomBytes(6).toString('hex');
const nowIso = () => new Date().toISOString();
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const J = (x, f = null) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
const NO_RANK = 'the seats did not rank each other';
/** "answered by X; Y was not answering" when a seat's own model failed and another wrote its answer. */
export const fellBackNote = (a) => a?.text && a.fellBack && a.setLabel && a.label && a.setLabel !== a.label ? `answered by ${a.label}; ${a.setLabel} was not answering` : '';
const PREFER = ['gemini', 'router', 'openrouter', 'anthropic', 'openai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'cerebras', 'xai', 'custom', 'ollama'];

export async function activate(ctx) {
  ctx.db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_council_rooms (id TEXT PRIMARY KEY, question TEXT NOT NULL, format TEXT NOT NULL, seats TEXT NOT NULL, chair TEXT, chat_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS m_council_runs (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, job_id TEXT, chat_id TEXT, status TEXT NOT NULL, seats TEXT NOT NULL, chair TEXT, answers TEXT, rankings TEXT, verdict TEXT, error TEXT, created TEXT NOT NULL, finished TEXT);
    CREATE INDEX IF NOT EXISTS m_council_runs_room ON m_council_runs(room_id, created);
  `);
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
  async function seatCall(model, messages, { signal, json = false, maxTokens = 500, spare = [] }) {
    const tries = model?.provider ? [model, ...spare, ...(model.model ? [{ provider: model.provider, model: null }] : []), null] : [null];
    let last;
    for (const m of tries) {
      try {
        const r = await ctx.model.chat({ purpose: 'council', messages, json, maxTokens, temperature: 0.6, signal, ...(m ? { model: m } : {}) });
        return { ...r, fellBack: m !== tries[0] };
      } catch (e) { last = e; if (signal?.aborted || ['halted', 'aborted', 'offline'].includes(e.code)) throw e; }
    }
    throw last;
  }

  // a Verdict stored by an earlier build counted ranking first picks as "agreed N to M": it is shown under its true name
  const trueVerdict = (v) => v && !v.rankLine && /^(agreed \d+ to \d+|all three agreed)$/.test(v.voteLine || '') ? { ...v, rankLine: v.winner ? rankLineFor(v.winner) : '', voteLine: v.winner ? rankLineFor(v.winner) : NO_RANK } : v;
  const runRow = (r) => r && ({ id: r.id, roomId: r.room_id, jobId: r.job_id, chatId: r.chat_id, status: r.status, seats: J(r.seats, []), chair: J(r.chair), answers: J(r.answers, []), rankings: J(r.rankings, []), verdict: trueVerdict(J(r.verdict)), error: r.error, created: r.created, finished: r.finished });
  const roomRow = (r) => r && ({ id: r.id, question: r.question, format: r.format, formatLabel: FORMATS[r.format]?.label || r.format, seats: J(r.seats, []), chair: J(r.chair), chatId: r.chat_id, created: r.created, updated: r.updated });
  const getRun = (id) => runRow(ctx.db.get('SELECT * FROM m_council_runs WHERE id = ?', id));
  const saveRun = (id, patch) => { const sets = Object.keys(patch).map(k => `${k} = ?`).join(', '); ctx.db.run(`UPDATE m_council_runs SET ${sets} WHERE id = ?`, ...Object.values(patch).map(v => v && typeof v === 'object' ? JSON.stringify(v) : v), id); };

  function verdictText(room, run) {
    const v = run.verdict; const lines = [];
    for (const a of run.answers || []) if (a?.text) { const fb = fellBackNote(a); lines.push(`**${a.name}** (${a.stance} · ${a.label}${fb ? '; ' + fb.replace(/^answered by [^;]+; /, '') : ''}): ${wholeSentences(a.text, 240)}${a.cut ? ' (cut short)' : ''}`); }
    if (v) { lines.push('', `**Verdict · ${v.voteLine}** (written by ${v.label})`, ...(v.agreeLine && v.rankLine ? [v.rankLine] : []), v.decision, ...(v.reasons || []).map(r => '- ' + r), ...(v.notes || []).map(n => `*${n}*`)); }
    return lines.join('\n');
  }
  function verdictCard(room, run) {
    const v = run.verdict;
    return { kind: 'council.verdict', id: 'council-verdict-' + run.id, runId: run.id, roomId: room.id, title: 'Verdict · ' + v.voteLine, question: room.question, decision: v.decision, reasons: v.reasons, notes: v.notes || [], label: v.label, voteLine: v.voteLine, agreeLine: v.agreeLine || '', rankLine: v.rankLine || '',
      seats: run.answers.map(a => ({ name: a.name, stance: a.stance, label: a.label, fellBack: fellBackNote(a), summary: wholeSentences(a.text, 240), cut: !!a.cut, ok: !!a.text })),
      text: verdictText(room, run),
      actions: [
        { label: 'Turn into a task', tool: 'task_create', args: { title: clip(v.decision, 80), prompt: `The Council decided on "${room.question}": ${v.decision}\nReasons: ${(v.reasons || []).join(' ')}\nPlan and do the next steps.` } },
        { label: 'Research this', tool: 'research_deep', args: { question: room.question } },
        { label: 'Open the Council', go: '#/research/council/' + room.id },
      ] };
  }

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
      const signal = job.signal;
      const card = (detail, progress, status = 'running') => job.card({ kind: 'progress', id: 'council-' + runId, title: 'Council: ' + clip(room.question, 70), detail, progress, status, go: '#/research/council/' + room.id });
      const answers = seats.map(s => ({ seatId: s.id, name: s.name, stance: s.stance, text: null, label: null, error: null }));
      try {
        // stage 1: each seat on its own, in parallel
        job.progress(0.05, 'The seats are answering'); card('The seats are answering', 0.05); emit('answering');
        let done = 0;
        await Promise.all(seats.map(async (s, i) => {
          try {
            const msgs = answerMessages(room.question, s, FORMATS[room.format]);
            const r = await seatCall(s.model, msgs, { signal, maxTokens: 900, spare: spareFor(i) });
            let text = String(r.text || '').trim(), cut = false;
            if (text && r.cutOff === true) {
              // the model door says the reply hit its length limit: ask the same model once to finish; if that is cut off too
              // (or fails), keep the full sentences only. The last character is never the signal.
              let still = true;
              try { const c = await seatCall({ provider: r.provider, model: r.model }, continueMessages(msgs, text), { signal, maxTokens: 300 }); text = joinContinuation(text, c.text); still = c.cutOff === true; }
              catch (e) { if (signal.aborted || e.code === 'halted' || e.code === 'aborted') throw e; }
              if (still) { text = toLastSentence(text) || text.replace(/\s+\S*$/, '') + '…'; cut = true; }
            }
            answers[i] = { ...answers[i], text, cut, label: r.label, fellBack: r.fellBack, setLabel: label(s.model), ms: r.ms };
          } catch (e) { if (signal.aborted || e.code === 'halted' || e.code === 'aborted') throw e; answers[i].error = e.message; }
          done++; saveRun(runId, { answers });
          const msg = answers[i].text ? `${s.name} answered (${answers[i].label})` : `${s.name} could not answer`;
          job.progress(0.05 + 0.4 * done / seats.length, msg); card(msg, 0.05 + 0.4 * done / seats.length); emit('answer', { seat: i, answer: answers[i] });
        }));
        const ok = answers.map((a, i) => ({ ...a, i })).filter(a => a.text);
        if (ok.length < 2) throw new Error('Fewer than two seats answered, so there is nothing to compare. ' + answers.filter(a => a.error).map(a => `${a.name}: ${clip(a.error, 120)}`).join(' '));
        // stage 2: each seat ranks the answers, which are shown under letters in a shuffled order
        const order = ok.map(a => a.i).sort(() => Math.random() - 0.5);
        const letters = order.map((_, k) => String.fromCharCode(65 + k));
        const byLetter = Object.fromEntries(order.map((i, k) => [letters[k], i]));
        const rankings = [];
        // alongside the ranking: one call labels what each seat recommends and which pairs recommend the same course
        const agreeP = (async () => {
          try { const r = await seatCall(chair, agreeMessages(room.question, ok), { signal, json: true, maxTokens: 400 }); return { line: agreement(parseJson(r), ok.map(a => a.name)), label: r.label }; }
          catch (e) { if (signal.aborted || e.code === 'halted' || e.code === 'aborted') throw e; return { line: '', label: null }; }
        })();
        agreeP.catch(() => {});
        job.progress(0.5, 'The seats are ranking each other'); card('The seats are ranking each other, without names', 0.5); emit('ranking');
        let ranked = 0;
        await Promise.all(seats.map(async (s, i) => {
          if (!answers[i].text) return;
          try {
            const r = await seatCall(s.model, rankMessages(room.question, order.map((ai, k) => ({ letter: letters[k], text: answers[ai].text }))), { signal, json: true, maxTokens: 900, spare: spareFor(i) });
            const parsed = parseRanking(r, letters);
            rankings.push({ seat: i, name: s.name, label: r.label, order: parsed.order, ranked: parsed.order.map(l => answers[byLetter[l]].name), notes: Object.fromEntries(Object.entries(parsed.notes).filter(([l]) => byLetter[l] != null).map(([l, v]) => [answers[byLetter[l]].name, v])), raw: parsed.order.length ? null : clip(r.text, 300) });
          } catch (e) { if (signal.aborted || e.code === 'halted' || e.code === 'aborted') throw e; rankings.push({ seat: i, name: s.name, error: e.message, order: [] }); }
          ranked++; saveRun(runId, { rankings });
          const last = rankings[rankings.length - 1];
          const msg = last.order.length ? `${s.name} ranked the answers (${last.label})` : `${s.name} could not rank`;
          job.progress(0.5 + 0.3 * ranked / ok.length, msg); card(msg, 0.5 + 0.3 * ranked / ok.length); emit('rank', { seat: i, ranking: last });
        }));
        const agg = aggregate(rankings, byLetter, answers);
        const agree = await agreeP; agg.agreeLine = agree.line;
        // stage 3: the chairman writes the Verdict
        job.progress(0.85, 'The chairman is writing the Verdict'); card('The chairman is writing the Verdict', 0.85); emit('verdict-writing');
        let r = await seatCall(chair, chairMessages(room.question, answers, seats, agg), { signal, json: true, maxTokens: 1200 });
        const usable = (x) => x && [x.decision, x.answer].some(v => typeof v === 'string' && v.trim()) ? x : null;   // JSON without a decision is no Verdict
        let j = usable(parseJson(r));
        if (!j) { r = await seatCall(chair, chairMessages(room.question, answers, seats, agg), { signal, json: true, maxTokens: 2000 }); j = usable(parseJson(r)); }   // cut off or unreadable: once more, with more room
        if (!j) {            // still cut off: take the decision as far as its last full sentence, never half a sentence
          const m = String(r.text || '').match(/"decision"\s*:\s*"((?:[^"\\]|\\.)*)/);
          const raw = m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : String(r.text || '').replace(/[{}"]/g, ' ');
          j = { decision: toLastSentence(raw) || 'The chairman could not finish the Verdict. Run it again.' };
        }
        const whole = (x, n) => wholeSentences(x, n);
        const verdict = {
          decision: whole(j.decision || j.answer, 400), reasons: (Array.isArray(j.reasons) ? j.reasons : []).map(x => whole(x, 220)).filter(Boolean).slice(0, 2),
          answer: whole(j.answer || '', 1600), label: r.label, winner: agg.winner != null ? answers[agg.winner].name : null,
          // the headline says what it counts: the seats' recommendations when they could be labelled, else the ranking under its own name
          agreeLine: agree.line, agreeLabel: agree.label, rankLine: agg.rankLine, voteLine: agree.line || agg.rankLine || NO_RANK,
          vote: agg.vote, averages: agg.averages,
        };
        // plain notes on the result: one model for every seat, offline, and figures no page was read for
        verdict.notes = [modelNote(answers), offline() ? 'The desk was offline, so the Council ran on local models only.' : '', figuresNote(room.question, answers, verdict)].filter(Boolean);
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
    const q = clip(question, 1000); if (!q) throw Object.assign(new Error('Ask the Council a question first.'), { status: 400 });
    const f = FORMATS[format] ? format : guessFormat(q);
    const base = await defaultSeats(f);
    const list = base.map((s, i) => ({ ...s, ...(seats?.[i] || {}), model: seats?.[i]?.model !== undefined ? seats[i].model : s.model }));
    const room = { id: uid('room_'), question: q, format: f, seats: list.map(({ modelLabel, ...s }) => s), chair: chair || await defaultChair(), chatId };
    ctx.db.run('INSERT INTO m_council_rooms (id, question, format, seats, chair, chat_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', room.id, room.question, room.format, JSON.stringify(room.seats), JSON.stringify(room.chair), chatId, nowIso(), nowIso());
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
    ctx.db.run('UPDATE m_council_rooms SET seats = ?, chair = ?, updated = ? WHERE id = ?', JSON.stringify(room.seats), JSON.stringify(room.chair), nowIso(), room.id);
    return startRun(room, { chatId: chatId ?? null });
  }

  // ---------- routes
  const label = (m) => m?.provider ? (m.model ? ctx.model.label(m.provider, m.model) : ctx.model.label(m.provider) + ' · auto') : 'Default model';
  const decorate = (room) => room && ({ ...room, seats: room.seats.map(s => ({ ...s, modelLabel: label(s.model) })), chairLabel: label(room.chair) });
  const fail = (res, e) => ctx.json(res, { error: e.message }, e.status || (e.code === 'halted' ? 409 : 500));
  ctx.route('GET', '/formats', (req, res) => ctx.json(res, { formats: Object.values(FORMATS).map(f => ({ id: f.id, label: f.label, blurb: f.blurb })) }));
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
    const a = verdictCard(room, run).actions.find(x => x.tool === (body?.action === 'research' ? 'research_deep' : 'task_create'));
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
