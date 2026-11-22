// Code and Sandbox (module 25). One sandboxed run: approval (shell.run, always asks), a folder of its own under
// workspace/sandbox/<id>, a time limit, an output limit, a clean environment, killed by Panic and by switching off.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LIMITS, FILES, SANDBOX_LABEL, IMAGES, normalizeLanguage, normalizeTimeout, cleanEnv, findPython, dockerStatus, commandFor, runChild, listFolder } from './sandbox.js';

const LANG_NAME = { javascript: 'JavaScript', python: 'Python' };
// What each sandbox does NOT stop, said plainly on the approval card before the owner allows a run.
export function limitsSentence(sandbox, language) {
  if (sandbox === 'container') return 'Container: no network, read-only system, it sees only its own folder; it can use up to 512 MB of memory and 1 CPU for the time limit.';
  if (language === 'python') return 'Process sandbox: this program can read files on this PC (including the desk\u2019s own data) and use the network. Read the whole program before you allow it.';
  return 'Process sandbox: this program can use the network; files outside its folder are blocked and it cannot start other programs.';
}

export async function activate(ctx) {
  ctx.db.migrate(1, `CREATE TABLE IF NOT EXISTS m_code_runs (id TEXT PRIMARY KEY, at TEXT, agent_id TEXT, chat_id TEXT, job_id TEXT, language TEXT, sandbox TEXT,
    code TEXT, status TEXT, exit_code INTEGER, ms INTEGER, stdout TEXT, stderr TEXT, note TEXT, folder TEXT, files TEXT)`);
  const live = new Set();
  const jobIds = new Set();                                 // our running jobs, stopped when the module is switched off                                   // stop functions of running children
  const stopAllChildren = () => { const n = live.size; for (const s of [...live]) { try { s(); } catch {} } return { module: 'code', killed: n }; };
  const offPanic = ctx.panic.onStop(stopAllChildren);
  const track = (stop) => { live.add(stop); return () => live.delete(stop); };

  const rowOut = (r) => r && ({ id: r.id, at: r.at, agentId: r.agent_id, chatId: r.chat_id, jobId: r.job_id, language: r.language, sandbox: r.sandbox, sandboxLabel: SANDBOX_LABEL[r.sandbox] || r.sandbox,
    code: r.code, status: r.status, exitCode: r.exit_code, ms: r.ms, stdout: r.stdout, stderr: r.stderr, note: r.note, folder: r.folder, files: r.files ? JSON.parse(r.files) : [] });
  const save = (id, patch) => {
    const cols = Object.keys(patch); if (!cols.length) return;
    ctx.db.run(`UPDATE m_code_runs SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, ...cols.map(c => patch[c]), id);
    ctx.events.emit('code', rowOut(ctx.db.get('SELECT * FROM m_code_runs WHERE id = ?', id)));
  };

  function status({ force = false } = {}) {
    const docker = dockerStatus({ force });
    const py = findPython();
    return {
      sandboxes: [
        { id: 'process', label: SANDBOX_LABEL.process, available: true, note: 'Its own folder, a time limit, an output limit and no keys. JavaScript may touch only its folder; Python is limited by time and folder, not walled off.' },
        { id: 'container', label: SANDBOX_LABEL.container, available: !!docker.available, note: docker.available ? `Docker ${docker.version}. Images on this PC: ${Object.entries(docker.images || {}).map(([l, ok]) => `${LANG_NAME[l]} ${ok ? 'ready' : 'missing'}`).join(', ')}.` : docker.reason, images: docker.images || {} },
      ],
      languages: { javascript: { available: true, version: process.version.replace(/^v/, '') }, python: py ? { available: true, version: py.version } : { available: false, note: 'Python is not installed on this PC. Install Python 3 to run Python code, or use the container.' } },
      limits: { timeoutMs: LIMITS.defaultTimeoutMs, maxTimeoutMs: LIMITS.maxTimeoutMs, maxOutputBytes: LIMITS.maxOutputBytes, maxCodeBytes: LIMITS.maxCodeBytes },
    };
  }

  /** The run itself, inside a job. Returns the stored run. */
  async function execute({ id, language, code, sandbox, timeoutMs, agentId, chatId, job }) {
    const dir = ctx.workspacePath('sandbox', id);
    const cmd = commandFor({ language, sandbox, dir, name: 'apd-code-' + id });
    if (!cmd) { save(id, { status: 'failed', note: 'Python is not installed on this PC.' }); return get(id); }
    job?.waiting('Waiting for you to allow the run');
    save(id, { status: 'asking' });
    const d = await ctx.approval.request({ agentId: agentId || undefined, chatId: chatId || undefined, jobId: job?.id, action: 'shell.run',
      title: `Run ${code.split('\n').length} lines of ${LANG_NAME[language]}`, detail: `${limitsSentence(sandbox, language)} Time limit ${Math.round(timeoutMs / 1000)} s.`,
      payload: { command: cmd.shown, folder: path.join('sandbox', id), code }, signal: job?.signal });
    job?.resumed('Running');
    if (!d.ok) { save(id, { status: d.reason === 'denied' ? 'denied' : 'stopped', note: d.reason === 'denied' ? 'You did not allow this run.' : `Not run (${d.reason}).` }); return get(id); }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FILES[language]), code);
    save(id, { status: 'running', folder: path.join('sandbox', id) });
    const r = await runChild({ cmd: cmd.cmd, args: cmd.args, cwd: dir, env: cleanEnv(dir), timeoutMs, signal: job?.signal, container: sandbox === 'container' ? 'apd-code-' + id : null, track });
    const note = r.error ? r.error : r.timedOut ? `Stopped at the time limit (${Math.round(timeoutMs / 1000)} s).` : r.truncated ? `Output passed ${Math.round(LIMITS.maxOutputBytes / 1000)} KB, so the run was stopped.` : r.stopped ? 'Stopped.' : null;
    const st = r.stopped ? 'stopped' : r.error || r.timedOut || r.truncated ? 'failed' : r.exitCode === 0 ? 'done' : 'failed';
    save(id, { status: st, exit_code: r.exitCode, ms: r.ms, stdout: r.stdout, stderr: r.stderr, note, files: JSON.stringify(listFolder(dir).filter(f => f.name !== FILES[language])) });
    return get(id);
  }
  const get = (id) => rowOut(ctx.db.get('SELECT * FROM m_code_runs WHERE id = ?', id));

  /** Start a run as a job. Returns { runId, jobId } at once. */
  async function start({ language, code, agentId = null, chatId = null, sandbox, timeoutMs } = {}) {
    const lang = normalizeLanguage(language);
    if (!lang) throw Object.assign(new Error('Choose JavaScript or Python.'), { status: 400 });
    code = String(code ?? '');
    if (!code.trim()) throw Object.assign(new Error('There is no code to run.'), { status: 400 });
    if (Buffer.byteLength(code) > LIMITS.maxCodeBytes) throw Object.assign(new Error(`The code is longer than ${LIMITS.maxCodeBytes / 1000} KB.`), { status: 400 });
    if (/\s{501,}/.test(code)) throw Object.assign(new Error('This program has a long run of blank space (more than 500 spaces or empty lines), which can hide code from you. It was not run.'), { status: 400 });
    // Python cannot be walled off in the process sandbox: use the container by default when Docker and its image are here.
    let box = sandbox === 'container' ? 'container' : sandbox === 'process' ? 'process' : null;
    if (!box) { const d = lang === 'python' ? dockerStatus() : null; box = d?.available && d.images?.python ? 'container' : 'process'; }
    if (box === 'container') {
      const d = dockerStatus();
      if (!d.available) throw Object.assign(new Error(d.reason), { status: 409 });
      if (!d.images?.[lang]) throw Object.assign(new Error(`The ${LANG_NAME[lang]} image is not on this PC yet. Press "Get image" first.`), { status: 409 });
    } else if (lang === 'python' && !findPython()) throw Object.assign(new Error('Python is not installed on this PC.'), { status: 409 });
    const ms = normalizeTimeout(timeoutMs);
    const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex');
    ctx.db.run('INSERT INTO m_code_runs (id, at, agent_id, chat_id, language, sandbox, code, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, new Date().toISOString(), agentId, chatId, lang, box, code, 'queued');
    const job = await ctx.jobs.start({ kind: 'code.run', title: `Run ${LANG_NAME[lang]} code`, agentId, chatId, input: { runId: id, language: lang, sandbox: box },
      run: async (j) => { jobIds.add(j.id); ctx.db.run('UPDATE m_code_runs SET job_id = ? WHERE id = ?', j.id, id); const r = await execute({ id, language: lang, code, sandbox: box, timeoutMs: ms, agentId, chatId, job: j });
        if (r.status !== 'done' && r.status !== 'denied') { if (r.status === 'stopped') j.throwIfStopped(); } return { runId: id, status: r.status, exitCode: r.exitCode }; } });
    return { runId: id, jobId: job.id };
  }
  /** For other modules and the tool: start and wait for the end. */
  async function run(opts = {}, { waitMs = 10 * 60_000 } = {}) {
    const { runId, jobId } = await start(opts);
    await ctx.jobs.wait(jobId, waitMs);
    return get(runId);
  }

  ctx.route('GET', '/status', (req, res, { query }) => ctx.json(res, status({ force: query.refresh === '1' })));
  ctx.route('GET', '/runs', (req, res, { query }) => ctx.json(res, { runs: ctx.db.all('SELECT * FROM m_code_runs ORDER BY at DESC LIMIT ?', Math.min(200, Number(query.limit) || 50)).map(rowOut) }));
  ctx.route('GET', '/runs/:id', (req, res, { params }) => { const r = get(params.id); r ? ctx.json(res, r) : ctx.json(res, { error: 'Not found' }, 404); });
  ctx.route('POST', '/run', async (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Runs start from the Code page on this desk.' }, 403);
    try { ctx.json(res, await start({ ...body, agentId: null })); } catch (e) { ctx.json(res, { error: e.status < 500 ? e.message : ctx.plainFailure(e).line }, e.status || 500); }
  });
  ctx.route('POST', '/image', async (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Only the owner can get images.' }, 403);
    const lang = normalizeLanguage(body?.language); if (!lang) return ctx.json(res, { error: 'Choose JavaScript or Python.' }, 400);
    const image = IMAGES[lang];
    const job = await ctx.jobs.start({ kind: 'code.image', title: `Get the ${LANG_NAME[lang]} container image`, input: { image }, run: async (j) => {
      j.waiting('Waiting for you');
      const d = await ctx.approval.request({ action: 'install', title: `Download the ${LANG_NAME[lang]} container image`, detail: `docker pull ${image}`, from: 'Docker Hub', payload: { command: `docker pull ${image}` }, jobId: j.id, signal: j.signal });
      j.resumed('Downloading');
      if (!d.ok) return { ok: false, reason: d.reason };
      const r = await runChild({ cmd: 'docker', args: ['pull', image], cwd: ctx.workspace, env: process.env, timeoutMs: 15 * 60_000, signal: j.signal, track, maxOutputBytes: 1_000_000 });
      dockerStatus({ force: true });
      if (r.exitCode !== 0) throw new Error((r.stderr || r.error || 'docker pull failed').trim().split('\n').pop());
      return { ok: true, image };
    } });
    ctx.json(res, { jobId: job.id });
  });

  // Aider sidecar (Apache-2.0, https://github.com/Aider-AI/aider): if it is installed on this PC, it edits a workspace folder
  // through the desk's own router endpoint (/router/v1, which goes through the model door). Off until the owner presses it.
  const aiderCmd = () => process.env.APD_AIDER || 'aider';
  let aiderCache = null;
  function aiderStatus() {
    if (aiderCache && Date.now() - aiderCache.at < 60_000) return aiderCache.value;
    let value = { available: false, note: 'Aider is not installed. Optional: install it with "pip install aider-chat" (Python 3.12) and the desk can use it.' };
    try { const r = spawnSync(aiderCmd(), ['--version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true }); if (r.status === 0) value = { available: true, version: String(r.stdout).trim().replace(/^aider\s*/i, '') }; } catch {}
    aiderCache = { at: Date.now(), value }; return value;
  }
  ctx.route('GET', '/aider', (req, res) => ctx.json(res, aiderStatus()));
  ctx.route('POST', '/aider', async (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Aider starts from the Code page on this desk.' }, 403);
    const st = aiderStatus(); if (!st.available) return ctx.json(res, { error: st.note }, 409);
    const rel = String(body?.folder || '').replace(/^[\\/]+/, ''); const message = String(body?.message || '').trim();
    if (!rel || !message) return ctx.json(res, { error: 'Give a workspace folder and what to change.' }, 400);
    let dir; try { dir = ctx.workspacePath(rel); } catch { return ctx.json(res, { error: 'That folder is outside the workspace.' }, 400); }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return ctx.json(res, { error: 'That folder does not exist in the workspace.' }, 404);
    const files = (Array.isArray(body?.files) ? body.files : []).map(String).filter(f => !f.includes('..') && !path.isAbsolute(f)).slice(0, 10);
    const base = `http://${req.headers.host}/router/v1`;
    const args = ['--openai-api-base', base, '--openai-api-key', 'local', '--model', 'openai/' + (body?.model || 'auto'), '--no-stream', '--no-auto-commits', '--no-suggest-shell-commands', '--no-detect-urls', '--no-check-update', '--no-show-model-warnings', '--no-analytics', '--no-gitignore', '--no-pretty', '--edit-format', 'whole', '--message', message, ...files];
    const job = await ctx.jobs.start({ kind: 'code.aider', title: 'Aider: ' + message.slice(0, 60), input: { folder: rel, files }, run: async (j) => {
      jobIds.add(j.id); j.waiting('Waiting for you');
      const d = await ctx.approval.request({ action: 'shell.run', title: 'Let Aider edit ' + rel, detail: message.slice(0, 200), payload: { command: `aider --message "${message.slice(0, 120)}" ${files.join(' ')}`, folder: rel }, jobId: j.id, signal: j.signal });
      j.resumed('Aider is working');
      if (!d.ok) return { ok: false, reason: d.reason };
      const r = await runChild({ cmd: aiderCmd(), args, cwd: dir, env: { ...cleanEnv(dir), GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 5 * 60_000, signal: j.signal, track, maxOutputBytes: 400_000 });
      j.throwIfStopped();
      const out = (r.stdout + '\n' + r.stderr).trim().split('\n').filter(l => !/^Warning: Input is not a terminal/.test(l)).slice(-60).join('\n');
      if (r.exitCode !== 0) throw new Error(r.error || out.split('\n').pop() || 'Aider failed');
      return { ok: true, output: out, applied: /Applied edit to/.test(out) };
    } });
    ctx.json(res, { jobId: job.id });
  });

  ctx.tool({ name: 'code_run', description: 'Run a short JavaScript or Python program in a sandbox folder and return its output. The owner is always asked first. Use print/console.log for results. No network keys are available.',
    parameters: { type: 'object', properties: { language: { type: 'string', enum: ['javascript', 'python'] }, code: { type: 'string', description: 'The whole program' }, timeoutSeconds: { type: 'number', description: 'Up to 60' } }, required: ['language', 'code'] },
    async run(args, call) {
      let r;
      try { r = await run({ language: args.language, code: args.code, agentId: call.agentId, chatId: call.chatId, timeoutMs: args.timeoutSeconds ? args.timeoutSeconds * 1000 : undefined }); }
      catch (e) { return { ok: false, status: 'refused', error: e.message }; }
      if (!r) return { ok: false, error: 'The run did not finish.' };
      if (['asking', 'queued', 'running'].includes(r.status)) return { ok: false, status: 'waiting', note: 'The run is still waiting or running. Its result will show on the Code page.' };
      return { ok: r.status === 'done', status: r.status, exitCode: r.exitCode, stdout: r.stdout?.slice(0, 8000), stderr: r.stderr?.slice(0, 4000), note: r.note, sandbox: r.sandboxLabel, folder: r.folder, files: r.files, ms: r.ms };
    } });
  ctx.expose({ run, start, status, get });
  return { async deactivate() { for (const j of jobIds) { try { const x = ctx.jobs.get(j); if (x && ['running', 'waiting'].includes(x.status)) ctx.jobs.stop(j); } catch {} } stopAllChildren(); offPanic(); } };
}
