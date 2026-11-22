// Studio (module 29): a model writes a small static site (index.html + style.css) into workspace/sites/<name> through
// the approval door, shown in a sandboxed preview; and eval replay: one saved ask, two models, side by side.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { slugifyTitle, parseSite } from './site.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon' };
// The preview runs nothing: no scripts, no forms, no connections; only its own files, inline styles, images and web fonts.
const PREVIEW_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src 'self' data: https:; sandbox; frame-ancestors 'self'";

export async function activate(ctx) {
  ctx.db.migrate(1, `CREATE TABLE IF NOT EXISTS m_studio_sites (name TEXT PRIMARY KEY, at TEXT, brief TEXT, label TEXT, ms INTEGER, files TEXT);
    CREATE TABLE IF NOT EXISTS m_studio_asks (id TEXT PRIMARY KEY, at TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS m_studio_replays (id TEXT PRIMARY KEY, at TEXT, ask TEXT, results TEXT)`);
  const jobIds = new Set();
  const siteDir = (name) => ctx.workspacePath('sites', name);

  async function buildSite({ brief, name, agentId = null, chatId = null }, job) {
    brief = String(brief || '').trim().slice(0, 2000);
    if (!brief) throw Object.assign(new Error('Write a short brief first.'), { status: 400 });
    let slug = slugifyTitle(name || brief.split(/[.,\n]/)[0].split(/\s+/).slice(0, 5).join(' '));
    if (!name) { let n = 2; const base = slug; while (fs.existsSync(siteDir(slug))) slug = `${base}-${n++}`; }
    job?.progress(0.1, 'Writing the page');
    const t0 = Date.now();
    const r = await ctx.model.chat({ agentId: agentId || undefined, purpose: 'code', maxTokens: 6000, signal: job?.signal, messages: [
      { role: 'system', content: 'You write small, clean, static websites. Reply with exactly two fenced blocks: ```html (a complete index.html that links style.css, no JavaScript, no external scripts) then ```css (style.css). Responsive, accessible, readable in light colours. Use only facts given in the brief; mark placeholders clearly.' },
      { role: 'user', content: `Brief: ${brief}` }] });
    const site = parseSite(r.text);
    if (!site) throw new Error(`The model (${r.label}) did not return a page. Try again or pick another model.`);
    job?.progress(0.7, 'Saving the files');
    const files = [['index.html', site.html], ['style.css', site.css]];
    for (const [file, content] of files) {
      const rel = path.join('sites', slug, file);
      const d = await ctx.approval.request({ agentId: agentId || undefined, chatId: chatId || undefined, jobId: job?.id, action: 'file.write', title: `Write ${file} for the site ${slug}`, detail: 'Workspace › sites › ' + slug, payload: { path: rel, bytes: Buffer.byteLength(content) }, signal: job?.signal });
      if (!d.ok) throw new Error(d.reason === 'denied' ? 'You did not allow the files to be written.' : `Not written (${d.reason}).`);
      fs.mkdirSync(siteDir(slug), { recursive: true });
      fs.writeFileSync(path.join(siteDir(slug), file), content);
    }
    const meta = files.map(([f, c]) => ({ name: f, size: Buffer.byteLength(c) }));
    ctx.db.run('INSERT INTO m_studio_sites (name, at, brief, label, ms, files) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET at = excluded.at, brief = excluded.brief, label = excluded.label, ms = excluded.ms, files = excluded.files', slug, new Date().toISOString(), brief, r.label, Date.now() - t0, JSON.stringify(meta));
    if (chatId) ctx.chatCard(chatId, { kind: 'file', path: `sites/${slug}/index.html`, name: `${slug}/index.html`, size: meta[0].size, note: `A one-page site written by ${r.label}. Preview it in Studio.` });
    ctx.events.emit('studio', { site: slug });
    return { name: slug, folder: `sites/${slug}`, files: meta, label: r.label };
  }
  const siteOut = (r) => r && ({ name: r.name, at: r.at, brief: r.brief, label: r.label, ms: r.ms, files: JSON.parse(r.files || '[]'), folder: `sites/${r.name}`, exists: fs.existsSync(path.join(siteDir(r.name), 'index.html')) });
  async function startBuild(args) {
    return ctx.jobs.start({ kind: 'studio.site', title: 'Build a site: ' + String(args.brief || '').slice(0, 50), agentId: args.agentId, chatId: args.chatId, input: { brief: args.brief }, run: async (j) => { jobIds.add(j.id); return buildSite(args, j); } });
  }

  async function replay({ ask, a, b }, job) {
    ask = String(ask || '').trim(); if (!ask) throw Object.assign(new Error('Pick or write an ask.'), { status: 400 });
    const one = async (pick) => {
      const t0 = Date.now();
      try { const r = await ctx.model.chat({ model: pick, purpose: 'chat', maxTokens: 1200, signal: job?.signal, messages: [{ role: 'user', content: ask }] }); return { ok: true, label: r.label, text: r.text, ms: Date.now() - t0, asked: pick }; }
      catch (e) { return { ok: false, label: [pick?.provider, pick?.model].filter(Boolean).join(' · '), error: e.message, ms: Date.now() - t0, asked: pick }; }
    };
    const results = await Promise.all([one(a), one(b)]);
    const id = crypto.randomBytes(5).toString('hex');
    ctx.db.run('INSERT INTO m_studio_replays (id, at, ask, results) VALUES (?, ?, ?, ?)', id, new Date().toISOString(), ask, JSON.stringify(results));
    return { id, ask, results };
  }

  ctx.route('GET', '/sites', (req, res) => ctx.json(res, { sites: ctx.db.all('SELECT * FROM m_studio_sites ORDER BY at DESC LIMIT 50').map(siteOut) }));
  ctx.route('POST', '/sites', async (req, res, { body }) => { try { const j = await startBuild({ brief: body?.brief, name: body?.name }); ctx.json(res, { jobId: j.id }); } catch (e) { ctx.json(res, { error: e.status < 500 ? e.message : ctx.plainFailure(e).line }, e.status || 500); } });
  ctx.route('GET', '/preview/:name/*', (req, res, { params }) => {
    const rel = params.rest || 'index.html';
    let file; try { file = ctx.workspacePath('sites', params.name, rel || 'index.html'); } catch { return ctx.json(res, { error: 'Not found' }, 404); }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-security-policy': PREVIEW_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  ctx.route('GET', '/models', async (req, res) => {
    const active = (await ctx.model.active()).filter(x => x.ok);
    ctx.json(res, { models: active.flatMap(x => [...new Set([x.model, ...(x.models || [])].filter(m => m && m !== 'auto'))].slice(0, 8).map(m => ({ provider: x.provider, model: m, label: `${x.label} · ${m}` }))) });
  });
  ctx.route('GET', '/asks', (req, res) => {
    const saved = ctx.db.all('SELECT * FROM m_studio_asks ORDER BY at DESC LIMIT 30').map(r => ({ id: r.id, at: r.at, text: r.text }));
    let recent = []; try { recent = (ctx.modules.api('chat')?.recent?.(10) || []).map(c => c?.lastAsk || c?.text || c?.title).filter(x => typeof x === 'string').slice(0, 10); } catch {}
    ctx.json(res, { saved, recent });
  });
  ctx.route('POST', '/asks', (req, res, { body }) => { const text = String(body?.text || '').trim().slice(0, 4000); if (!text) return ctx.json(res, { error: 'Write the ask.' }, 400); const id = crypto.randomBytes(4).toString('hex'); ctx.db.run('INSERT INTO m_studio_asks (id, at, text) VALUES (?, ?, ?)', id, new Date().toISOString(), text); ctx.json(res, { id, text }); });
  ctx.route('DELETE', '/asks/:id', (req, res, { params }) => { ctx.db.run('DELETE FROM m_studio_asks WHERE id = ?', params.id); ctx.json(res, { ok: true }); });
  ctx.route('POST', '/replay', async (req, res, { body }) => {
    try { const j = await ctx.jobs.start({ kind: 'studio.replay', title: 'Replay an ask on two models', input: { ask: String(body?.ask || '').slice(0, 200) }, run: async (job) => { jobIds.add(job.id); return replay(body || {}, job); } }); ctx.json(res, { jobId: j.id }); }
    catch (e) { ctx.json(res, { error: e.status < 500 ? e.message : ctx.plainFailure(e).line }, e.status || 500); }
  });
  ctx.route('GET', '/replays', (req, res) => ctx.json(res, { replays: ctx.db.all('SELECT * FROM m_studio_replays ORDER BY at DESC LIMIT 20').map(r => ({ id: r.id, at: r.at, ask: r.ask, results: JSON.parse(r.results) })) }));

  ctx.tool({ name: 'site_build', description: 'Build a small one-page static website (index.html and style.css) in the workspace from a short brief.',
    parameters: { type: 'object', properties: { brief: { type: 'string' }, name: { type: 'string', description: 'Folder name (optional)' } }, required: ['brief'] },
    async run(a, c) { const j = await startBuild({ ...a, agentId: c.agentId, chatId: c.chatId }); const done = await ctx.jobs.wait(j.id, 10 * 60_000); return done.status === 'done' ? { ok: true, ...done.output, go: '#/studio' } : { ok: false, status: done.status, error: done.error }; } });
  ctx.expose({ buildSite: startBuild, replay });
  return { async deactivate() { for (const j of jobIds) { const x = ctx.jobs.get(j); if (x && ['running', 'waiting'].includes(x.status)) ctx.jobs.stop(j); } } };
}
