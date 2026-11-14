// Module 5: Browser and Computer. Each agent has its own browser with its own profile; the owner watches and can take over.
import { Computer } from './computer.js';
import { runLoop, shortUrl } from './agent-loop.js';
import { launchChoice } from './launch.js';
import { leavesThisPc, OFFLINE_LINE } from './guard.js';

export async function activate(ctx) {
  const computers = new Map();     // agentId -> Computer
  let deskPort = Number(process.env.APD_PORT) || 3960;
  const allowHosts = () => ctx.kv.get('allowHosts', []);
  const offline = () => ctx.settings.get('online') === false;   // read at every check, never cached
  const guardOpts = () => ({ allowHosts: allowHosts(), deskPort, offline: offline() });
  const refuseOffline = (url) => { if (offline() && (!url || leavesThisPc(/^[a-z]+:/i.test(url) ? url : 'https://' + url))) throw Object.assign(new Error(OFFLINE_LINE), { code: 'offline' }); };
  const emit = (st) => ctx.events.emit('browser', { agentId: st.agentId, mode: st.mode, url: st.url, steps: st.steps.slice(-1), frames: st.frames, goal: st.goal, jobId: st.jobId, open: st.open, offline: st.offline });
  const computer = (agentId) => {
    if (!computers.has(agentId)) computers.set(agentId, new Computer({ agentId, dataDir: ctx.dataDir, log: ctx.log, emit, guardOpts }));
    return computers.get(agentId);
  };
  const closeAll = async () => { await Promise.all([...computers.values()].map(c => c.close().catch(() => {}))); for (const c of computers.values()) { c.mode = 'idle'; c.jobId = null; } };
  const offPanic = ctx.panic.onStop(async () => { await closeAll(); return { browser: 'closed' }; });

  const ask = (r) => ctx.approval.request({ signal: ctx.panic.signal, ...r });
  const modelFor = (agentId) => (messages, signal) => ctx.model.chat({ agentId, messages, json: true, purpose: 'small', temperature: 0.1, maxTokens: 900, signal });

  async function runTask({ agentId = 'operator', goal, startUrl = null, chatId = null, maxSteps = 25, model = null }) {
    if (!goal) throw new Error('Say what the agent should do in the browser.');
    refuseOffline(startUrl);   // Offline: only a task that starts on this PC may run, and no browser is started otherwise
    const c = computer(agentId);
    if (c.jobId && ctx.jobs.get(c.jobId)?.status === 'running') throw Object.assign(new Error(`${ctx.agents.get(agentId)?.name || agentId} is already busy in the browser. Stop that task first.`), { code: 'busy' });
    const name = ctx.agents.get(agentId)?.name || agentId;
    const cardId = 'browser-' + Date.now().toString(36);
    return ctx.jobs.start({
      kind: 'browser.task', title: `${name} in the browser: ${String(goal).slice(0, 70)}`, agentId, chatId, input: { goal, startUrl },
      async run(job) {
        const card = (status, detail, progress) => job.card({ kind: 'progress', id: cardId, title: `${name} is using the browser`, detail, progress, status, actions: [{ label: 'Watch', go: `#/agents/${agentId}/computer` }] });
        c.goal = goal; c.jobId = job.id; c.result = null; c.steps = []; c.mode = 'agent'; c.driving = 'agent';
        c.approveNav = async (url) => (await ask({ agentId, jobId: job.id, chatId, action: 'browser.open', title: `Open ${shortUrl(url)}`, payload: { url } })).ok;
        const onStop = () => c.close();
        job.signal.addEventListener('abort', onStop, { once: true });
        card('running', 'Starting the browser', 0.02);
        c.onModeChange = null;
        const prevTake = c.takeOver.bind(c), prevBack = c.handBack.bind(c);
        c.takeOver = () => { prevTake(); job.waiting('You are driving the browser'); card('waiting', 'You are driving', null); };
        c.handBack = () => { const n = prevBack(); job.resumed('Running again'); card('running', 'Running again', null); return n; };
        try {
          await c.start();
          c.step('step', `Started ${c.browserName} with ${name}'s own profile`);
          const out = await runLoop(c, {
            goal, startUrl, maxSteps, signal: job.signal,
            model: model || modelFor(agentId),
            approveAct: async () => (await ask({ agentId, jobId: job.id, chatId, action: 'browser.act', title: `${name} acts in the browser`, detail: String(goal).slice(0, 160), payload: { goal: String(goal).slice(0, 300) } })).ok,
            onStep: (kind, text) => { c.step(kind, text); if (kind === 'owner' && c.mode === 'needs_owner') { job.waiting(text); card('waiting', text, null); } },
            onProgress: (line, p) => { job.progress(p ?? null, line); card('running', line, p ?? null); },
          });
          c.result = out.result; c.mode = 'idle';
          const notChecked = out.missing?.length || 0;
          c.step('done', out.limit ? 'Stopped at the step limit.' : notChecked ? `Finished, but ${notChecked} part${notChecked === 1 ? '' : 's'} of the task could not be found: ${out.missing.join('; ').slice(0, 200)}.` : 'Finished.');
          const sources = out.visited.filter(u => /^https?:/.test(u));
          job.card({ kind: 'progress', id: cardId, title: notChecked ? `${name} finished part of the task in the browser` : `${name} finished in the browser`, detail: `${out.steps} steps, ${sources.length} pages${notChecked ? `, ${notChecked} part${notChecked === 1 ? '' : 's'} not checked` : ''}`, progress: 1, status: 'done', actions: [{ label: 'Watch', go: `#/agents/${agentId}/computer` }] });
          job.card({ kind: 'text', text: `**What ${name} found in the browser** (${out.labels.join(', ') || 'model'})\n\n${out.result}` });
          if (sources.length) job.card({ kind: 'sources', items: sources.slice(0, 20).map((u, i) => ({ n: i + 1, title: shortUrl(u), url: u })) });
          return { result: out.result, steps: out.steps, pages: sources, labels: out.labels, modelCalls: out.modelCalls, frames: c.frameNo, limit: !!out.limit, complete: !!out.complete, checked: !!out.checked, missing: out.missing || [], parts: out.parts || null };
        } catch (e) {
          c.mode = 'idle';
          if (job.signal.aborted || e.code === 'aborted') { c.step('stopped', 'Stopped.'); card('stopped', 'Stopped', null); throw Object.assign(new Error('Stopped'), { code: 'aborted' }); }
          c.step('failed', e.message); card('failed', e.message, null); throw e;
        } finally {
          c.takeOver = prevTake; c.handBack = prevBack; c.approveNav = null;
          job.signal.removeEventListener('abort', onStop);
          if (c.jobId === job.id) c.jobId = null;
        }
      },
    });
  }

  /** A page that needs a real browser (plain fetch got nothing). Opens, reads, closes the tab. */
  async function readPage(url, { agentId = 'reader', signal } = {}) {
    refuseOffline(url);
    const d = await ask({ agentId, action: 'browser.open', title: `Read ${shortUrl(url)}`, payload: { url } });
    if (!d.ok) throw Object.assign(new Error('You did not allow opening this page.'), { code: 'denied' });
    const c = computer('_reader');
    await c.start();
    if (signal?.aborted) throw Object.assign(new Error('Stopped'), { code: 'aborted' });
    await c.goto(url);
    await c.page.waitForTimeout(800);
    const out = await c.page.evaluate(() => { const root = document.querySelector('main, article, #content, [role="main"]') || document.body; return { title: document.title, text: String(root?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 60000) }; });
    const finalUrl = c.page.url();
    await c.page.goto('about:blank').catch(() => {});
    return { url: finalUrl, ...out };
  }

  const status = (agentId) => computers.get(agentId)?.status() || { agentId, open: false, offline: offline(), mode: 'idle', steps: [], frames: 0, canOpenWindow: process.platform === 'win32' };

  // ---- routes (the live view)
  const port = (req) => { const p = req?.socket?.localPort; if (p) deskPort = p; };
  const ownerOnly = (res, owner) => { if (!owner) { ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403); return false; } return true; };
  ctx.route('GET', '/info', (req, res) => { port(req); const c = launchChoice({ agentId: 'x', dataDir: ctx.dataDir }); ctx.json(res, { browser: c.ok ? c.browser : null, error: c.ok ? null : c.error, allowHosts: allowHosts() }); });
  ctx.route('GET', '/:agentId/status', (req, res, { params }) => { port(req); ctx.json(res, status(params.agentId)); });
  ctx.route('GET', '/:agentId/frame', (req, res, { params, query, owner }) => {
    if (!ownerOnly(res, owner)) return;
    const c = computers.get(params.agentId);
    if (!c?.frame || Number(query.after || -1) >= c.frameNo) { res.writeHead(204, { 'cache-control': 'no-store', 'x-frame': String(c?.frameNo || 0) }); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-frame': String(c.frameNo) }); res.end(c.frame);
  });
  ctx.route('POST', '/:agentId/takeover', async (req, res, { params, owner }) => { if (!ownerOnly(res, owner)) return; const c = computer(params.agentId); if (!c.open) await c.start(); c.takeOver(); await c.snap(); ctx.json(res, c.status()); });
  ctx.route('POST', '/:agentId/handback', (req, res, { params, owner }) => { if (!ownerOnly(res, owner)) return; const c = computer(params.agentId); const note = c.handBack(); ctx.json(res, { ...c.status(), note }); });
  ctx.route('POST', '/:agentId/input', async (req, res, { params, body, owner }) => { if (!ownerOnly(res, owner)) return; try { ctx.json(res, await computer(params.agentId).input(body || {})); } catch (e) { ctx.json(res, { error: e.message }, e.code === 'not_owner' ? 409 : 400); } });
  ctx.route('POST', '/:agentId/stop', async (req, res, { params, owner }) => { if (!ownerOnly(res, owner)) return; const c = computers.get(params.agentId); if (c?.jobId) ctx.jobs.stop(c.jobId, 'Stopped by owner'); await c?.close(); if (c) c.mode = 'idle'; ctx.json(res, status(params.agentId)); });
  ctx.route('POST', '/:agentId/window', async (req, res, { params, body, owner }) => { if (!ownerOnly(res, owner)) return; if (process.platform !== 'win32') return ctx.json(res, { error: 'The real window is offered on the Windows PC only.' }, 409); const c = computer(params.agentId); await c.setHeaded(!!body?.on); ctx.json(res, c.status()); });
  ctx.route('POST', '/:agentId/task', async (req, res, { params, body, owner }) => { if (!ownerOnly(res, owner)) return; port(req); try { const j = await runTask({ agentId: params.agentId, goal: body?.goal, startUrl: body?.startUrl || null, chatId: body?.chatId || null }); ctx.json(res, j); } catch (e) { ctx.json(res, { error: e.message }, 409); } });
  ctx.route('POST', '/allow-host', (req, res, { body, owner }) => {
    if (!ownerOnly(res, owner)) return;
    const h = String(body?.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
    let list = allowHosts().filter(x => x !== h); if (h && body?.allow !== false) list = [...list, h];
    ctx.kv.set('allowHosts', list); ctx.json(res, { allowHosts: list });
  });

  ctx.tool({
    name: 'browser_task',
    description: 'Give an agent a task to do in its own web browser (several steps on real websites: open pages, click, search, read). Read-only research works best. Returns at once with a job; the owner can watch it on the agent\'s Computer tab.',
    parameters: { type: 'object', properties: { goal: { type: 'string', description: 'What to do and what to report back' }, startUrl: { type: 'string', description: 'Optional first page' }, agentId: { type: 'string', description: 'Which agent; default operator' } }, required: ['goal'] },
    async run(args, call) {
      const agentId = args.agentId || 'operator';
      const job = await runTask({ agentId, goal: args.goal, startUrl: args.startUrl, chatId: call.chatId });
      return { started: true, jobId: job.id, note: `${ctx.agents.get(agentId)?.name || agentId} is working in the browser. Watch it on the agent's Computer tab.`, cards: [{ kind: 'actions', actions: [{ label: 'Watch', go: `#/agents/${agentId}/computer` }] }] };
    },
  });
  ctx.expose({ runTask, readPage, status, computers: () => [...computers.keys()] });
  return { async deactivate() { offPanic?.(); await closeAll(); } };
}
