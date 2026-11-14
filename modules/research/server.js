// Research (module 4): deep research with checked citations, and the swarm. Owns the Research page and workspace/reports.
import fs from 'node:fs';
import path from 'node:path';
import { runDeep } from './deep.js';
import { runSwarm } from './swarm.js';
import { stopped, shortTitle } from './util.js';

const now = () => new Date().toISOString();
const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const J = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };

export async function activate(ctx) {
  ctx.db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_research_reports (id TEXT PRIMARY KEY, job_id TEXT, question TEXT, title TEXT, status TEXT, step TEXT, progress REAL,
      summary TEXT, markdown TEXT, data TEXT, files TEXT, error TEXT, chat_id TEXT, agent_id TEXT, created TEXT, updated TEXT);
    CREATE TABLE IF NOT EXISTS m_research_swarms (id TEXT PRIMARY KEY, job_id TEXT, task TEXT, size INTEGER, status TEXT, tiles TEXT, answer TEXT,
      sources TEXT, label TEXT, data TEXT, error TEXT, chat_id TEXT, created TEXT, updated TEXT);`);
  // anything left running by a previous start is not resumed
  ctx.db.run("UPDATE m_research_reports SET status = 'interrupted', step = 'Stopped when the desk closed' WHERE status = 'running'");
  ctx.db.run("UPDATE m_research_swarms SET status = 'interrupted' WHERE status = 'running'");

  const table = (t, cols) => ({
    get(id) { const r = ctx.db.get(`SELECT * FROM ${t} WHERE id = ?`, id); if (!r) return null; const o = { ...r }; for (const c of cols) o[c] = J(r[c], null); return o; },
    update(id, patch) {
      const sets = []; const vals = [];
      for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(cols.includes(k) ? JSON.stringify(v ?? null) : v); }
      ctx.db.run(`UPDATE ${t} SET ${sets.join(', ')}, updated = ? WHERE id = ?`, ...vals, now(), id);
      if (t === 'm_research_reports') { const r = ctx.db.get(`SELECT id, title, status, step, progress FROM ${t} WHERE id = ?`, id); ctx.events.emit('research', { kind: 'report', ...r }); }
    },
  });
  const reports = table('m_research_reports', ['data', 'files']);
  const swarms = table('m_research_swarms', ['tiles', 'sources', 'data']);

  const OFFLINE_LINE = 'The desk is offline. Research needs the internet.';
  const refuseOffline = () => { if (ctx.settings.get('online') === false) throw Object.assign(new Error(OFFLINE_LINE), { code: 'offline' }); };
  async function deep({ question, chatId = null, agentId = 'scout' } = {}) {
    refuseOffline();                                         // no job and no fetch while Offline
    question = String(question || '').trim();
    if (!question) throw new Error('Say what to research.');
    if (!ctx.agents.get(agentId)) agentId = 'scout';
    const id = rid('rep_');
    ctx.db.run('INSERT INTO m_research_reports (id, question, title, status, step, progress, chat_id, agent_id, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)', id, question, shortTitle(question, 120), 'running', 'Starting', chatId, agentId, now(), now());
    const job = await ctx.jobs.start({ kind: 'research.deep', title: 'Research: ' + shortTitle(question, 80), agentId, chatId, input: { question, reportId: id },
      async run(j) {
        try { return await runDeep(ctx, j, { rid: id, question, agentId, chatId, store: reports }); }
        catch (e) {
          const st = stopped(e, j.signal) ? 'stopped' : 'failed';
          reports.update(id, { status: st, step: st === 'stopped' ? 'Stopped' : 'Failed', error: e.message });
          j.card({ kind: 'progress', id: 'research-' + id, title: 'Deep research', detail: st === 'stopped' ? 'Stopped' : 'Failed', progress: reports.get(id)?.progress || 0, status: st });
          if (st === 'failed') {                             // never end without a report or this message, in full, with a way to try again
            j.card({ kind: 'text', text: `**The research did not finish.** ${e.message}` });
            j.card({ kind: 'actions', actions: [{ label: 'Try again', tool: 'research_deep', args: { question } }] });
          }
          throw e;
        }
      } });
    ctx.db.run('UPDATE m_research_reports SET job_id = ? WHERE id = ?', job.id, id);
    return { ...job, reportId: id };
  }
  async function swarm({ task, agents = 5, chatId = null, agentId = 'scout' } = {}) {
    refuseOffline();
    task = String(task || '').trim(); if (!task) throw new Error('Say what the swarm should do.');
    agents = Math.max(1, Math.min(50, Math.round(Number(agents) || 5)));
    if (!ctx.agents.get(agentId)) agentId = 'scout';
    const id = rid('swm_');
    ctx.db.run('INSERT INTO m_research_swarms (id, task, size, status, chat_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)', id, task, agents, 'running', chatId, now(), now());
    const concurrency = Math.max(1, Math.min(10, Number(ctx.kv.get('swarmConcurrency', 4)) || 4));
    const job = await ctx.jobs.start({ kind: 'research.swarm', title: `Swarm of ${agents}: ${shortTitle(task, 70)}`, agentId, chatId, input: { task, agents, swarmId: id },
      async run(j) {
        try { return await runSwarm(ctx, j, { sid: id, task, agents, agentId, chatId, store: swarms, concurrency }); }
        catch (e) {
          const st = stopped(e, j.signal) ? 'stopped' : 'failed';
          const s = swarms.get(id); const tiles = (s?.tiles || []).map((t) => (['done', 'failed'].includes(t.status) ? t : { ...t, status: st === 'stopped' ? 'stopped' : 'failed', detail: st === 'stopped' ? 'Stopped' : 'Failed' }));
          swarms.update(id, { status: st, error: e.message, tiles }); ctx.events.emit('research', { kind: 'swarm', id, tiles, done: true });
          j.card({ kind: 'progress', id: 'swarm-' + id, title: 'Swarm', detail: st === 'stopped' ? 'Stopped' : 'Failed', progress: 0, status: st });
          if (st === 'failed') { j.card({ kind: 'text', text: `**The swarm did not finish.** ${e.message}` }); j.card({ kind: 'actions', actions: [{ label: 'Try again', tool: 'research_swarm', args: { task, agents } }] }); }
          throw e;
        }
      } });
    ctx.db.run('UPDATE m_research_swarms SET job_id = ? WHERE id = ?', job.id, id);
    return { ...job, swarmId: id };
  }

  const listRow = (r) => { const d = J(r.data, {}); return { id: r.id, question: r.question, title: r.title, status: r.status, step: r.step, progress: r.progress, summary: r.summary, counts: d?.counts || null, created: r.created, updated: r.updated, jobId: r.job_id }; };
  ctx.route('GET', '/reports', async (req, res) => ctx.json(res, { reports: ctx.db.all('SELECT id, question, title, status, step, progress, summary, data, created, updated, job_id FROM m_research_reports ORDER BY created DESC LIMIT 100').map(listRow) }));
  ctx.route('GET', '/reports/:id', async (req, res, { params }) => { const r = reports.get(params.id); if (!r) return ctx.json(res, { error: 'No such report.' }, 404); ctx.json(res, { id: r.id, question: r.question, title: r.title, status: r.status, step: r.step, progress: r.progress, summary: r.summary, markdown: r.markdown, sources: r.data?.sources || [], uncited: r.data?.uncited || [], counts: r.data?.counts || null, labels: r.data?.labels || [], providers: r.data?.providers || null, claims: (r.data?.claims || []).map((c) => ({ text: c.text, section: c.section, ok: !!c.ok?.length })), files: r.files || {}, error: r.error, created: r.created, updated: r.updated, jobId: r.job_id }); });
  ctx.route('GET', '/reports/:id/file/:fmt', async (req, res, { params, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can download reports.' }, 403);
    const r = reports.get(params.id); const rel = r?.files?.[params.fmt];
    if (!rel) return ctx.json(res, { error: 'That file was not made.' }, 404);
    let abs; try { abs = ctx.workspacePath(...String(rel).split('/')); } catch { return ctx.json(res, { error: 'Bad path.' }, 400); }
    if (!fs.existsSync(abs)) return ctx.json(res, { error: 'The file is no longer in the workspace.' }, 404);
    const type = { md: 'text/markdown; charset=utf-8', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[params.fmt] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="${path.basename(abs).replace(/"/g, '')}"`, 'cache-control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  });
  ctx.route('POST', '/deep', async (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can start research here.' }, 403);
    try { ctx.json(res, await deep({ question: body?.question, chatId: body?.chatId || null })); } catch (e) { ctx.json(res, { error: e.message, code: e.code }, ['halted', 'offline'].includes(e.code) ? 409 : 400); }
  });
  ctx.route('GET', '/swarms', async (req, res) => ctx.json(res, { swarms: ctx.db.all('SELECT id, task, size AS agentCount, status, label, created, updated, job_id FROM m_research_swarms ORDER BY created DESC LIMIT 50') }));
  ctx.route('GET', '/swarms/:id', async (req, res, { params }) => { const s = swarms.get(params.id); if (!s) return ctx.json(res, { error: 'No such swarm.' }, 404); ctx.json(res, { id: s.id, task: s.task, agents: s.size, status: s.status, tiles: s.tiles || [], answer: s.answer, sources: s.sources || [], label: s.label, error: s.error, created: s.created, jobId: s.job_id, oneModel: s.data?.oneModel ?? null, findings: s.data?.findings ?? null, scouts: s.data?.scouts ?? null }); });
  ctx.route('POST', '/swarm', async (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner at this desk can start a swarm here.' }, 403);
    try { ctx.json(res, await swarm({ task: body?.task, agents: body?.agents, chatId: body?.chatId || null })); } catch (e) { ctx.json(res, { error: e.message, code: e.code }, ['halted', 'offline'].includes(e.code) ? 409 : 400); }
  });
  ctx.route('POST', '/stop/:jobId', async (req, res, { params, owner }) => { if (!owner) return ctx.json(res, { error: 'Only the owner can stop this.' }, 403); ctx.json(res, ctx.jobs.stop(params.jobId)); });

  ctx.tool({
    name: 'research_deep', description: 'Research a question in depth: plans, searches, reads many web pages and writes a report where every claim has a numbered source that was checked. Runs as a background job; progress and the report appear in this chat.',
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'What to research, in the owner\'s words' } }, required: ['question'] },
    async run(args, call) { if (ctx.settings.get('online') === false) return { started: false, error: OFFLINE_LINE }; const j = await deep({ question: args.question, chatId: call.chatId, agentId: call.agentId === 'coordinator' ? 'scout' : call.agentId || 'scout' }); return { started: true, jobId: j.id, reportId: j.reportId, note: 'Deep research has started. Progress shows in this chat; the report opens on the Research page when it is ready.', go: '#/research/' + j.reportId }; },
  });
  ctx.tool({
    name: 'research_swarm', description: 'Split a research job across several agents working in parallel (1 to 50), then merge their findings into one answer with sources. Runs as a background job.',
    parameters: { type: 'object', properties: { task: { type: 'string' }, agents: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['task'] },
    async run(args, call) { if (ctx.settings.get('online') === false) return { started: false, error: OFFLINE_LINE }; const j = await swarm({ task: args.task, agents: args.agents || 5, chatId: call.chatId, agentId: call.agentId === 'coordinator' ? 'scout' : call.agentId || 'scout' }); return { started: true, jobId: j.id, swarmId: j.swarmId, note: 'The swarm has started. Each agent shows as a tile on the Research page, Swarm tab.', go: '#/research/swarm/' + j.swarmId }; },
  });
  ctx.expose({ deep, swarm, report: (id) => reports.get(id), swarmState: (id) => swarms.get(id) });
  return { async deactivate() {} };
}
