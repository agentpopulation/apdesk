// Files and Knowledge (module 6): the workspace explorer, the Bin, outside folders behind the approval door,
// agent file tools and the Knowledge index. The path logic is in explorer.js.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import {
  ExplorerError, fail, explorerEnv, listRoots, listFolder, statEntry, setEntryMeta, listStarred, listRecent, makeFolder,
  renameEntry, moveEntries, recycleEntries, restoreEntry, uploadFile, locate, outsideDir, cleanRel, isInside, isBlocked,
  insideGranted, metaSet, metaKey, MIME, extOf,
} from './explorer.js';
import { Knowledge, KNOWLEDGE_SQL, extractText } from './knowledge.js';

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'js', 'mjs', 'ts', 'py', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'sh', 'ps1', 'sql', 'ini', 'toml']);
const MAX_READ = 200 * 1024;
const MAX_UPLOAD = 200 * 1024 * 1024;

export async function activate(ctx) {
  ctx.db.migrate(1, `CREATE TABLE IF NOT EXISTS m_files_meta (key TEXT PRIMARY KEY, starred INTEGER DEFAULT 0, agent_id TEXT, chat_id TEXT, job_id TEXT, at TEXT);` + KNOWLEDGE_SQL);
  const knowledgeDir = path.join(ctx.workspace, 'knowledge');
  await fs.mkdir(knowledgeDir, { recursive: true });

  // A folder outside the workspace is open only when the owner approved it through this module (kv) AND it is still
  // in the door's remembered list (Settings). Either one alone is not enough.
  const grants = () => { const mine = ctx.kv.get('grants', []); const door = ctx.settings.get('files.allowedFolders') || []; return mine.filter((g) => door.includes(g)); };
  const env = explorerEnv({ workspace: ctx.workspace, dataDir: ctx.dataDir, db: ctx.db, agents: () => ctx.agents.list(), grants });
  const kb = new Knowledge({ db: ctx.db, dir: knowledgeDir, workspace: ctx.workspace });
  kb.reindex().catch((e) => ctx.log('knowledge index', e.message));
  const changed = (data) => ctx.events.emit('files', data);

  // ---- the agent side: workspace-relative paths, or an absolute path inside a folder the owner opened ----
  function agentTarget(p, { write = false } = {}) {
    const raw = String(p ?? '').trim();
    const winAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
    if (path.isAbsolute(raw) || winAbs) {
      if (write) throw fail(403, 'outside', 'Agents write only inside the workspace. Use a path like reports/notes.md.');
      const abs = path.resolve(raw);
      if (isBlocked(env, abs)) throw fail(403, 'protected', 'The desk keeps its own records there.');
      if (isInside(ctx.workspace, abs)) return { abs, rel: path.relative(ctx.workspace, abs).split(path.sep).join('/'), outside: false };
      if (!insideGranted(abs, grants())) throw fail(403, 'locked', 'That folder is locked. Only the owner can open it, in Files.');
      return { abs, rel: abs, outside: true };
    }
    const parts = cleanRel(raw);
    const abs = path.resolve(ctx.workspace, ...parts);
    if (!isInside(ctx.workspace, abs)) throw fail(400, 'bad_path', 'That path leaves the workspace.');
    return { abs, rel: parts.join('/'), outside: false };
  }
  async function checkReal(t) {
    const real = await fs.realpath(t.abs).catch(() => null);
    if (!real) return t;
    const okRoot = t.outside ? insideGranted(real, grants()) : isInside(await fs.realpath(ctx.workspace), real);
    if (!okRoot || isBlocked(env, real)) throw fail(403, 'symlink_escape', 'That link points outside the folder, so it stays closed.');
    return t;
  }
  const cardFor = (r, who) => ({ kind: 'file', path: r.path, name: r.name, size: r.size, note: who?.agentId ? `Written by ${ctx.agents.get(who.agentId)?.name || who.agentId}` : 'Saved in the workspace' });

  /** Write a file in the workspace after the approval door says yes (ask 15). content: string or Buffer. */
  async function write(p, content, who = {}) {
    const t = await checkReal(agentTarget(p, { write: true }));
    if (!t.rel) throw fail(400, 'bad_path', 'Give the file a name.');
    const name = path.basename(t.abs);
    const dirLabel = ['Workspace', ...t.rel.split('/').slice(0, -1)].join(' › ');
    const d = await ctx.approval.request({ action: 'file.write', agentId: who.agentId || null, jobId: who.jobId || undefined, chatId: who.chatId || undefined, title: `Write ${name}`, detail: dirLabel, payload: { path: t.rel }, signal: who.signal });
    if (!d.ok) throw Object.assign(fail(403, 'not_approved', d.reason === 'denied' ? `You said no to writing ${name}.` : `Writing ${name} did not go ahead (${d.reason}).`), { decision: d });
    await fs.mkdir(path.dirname(t.abs), { recursive: true });
    await checkReal({ ...t });   // the parent may be a link made after the first check
    const buf = Buffer.isBuffer(content) || content instanceof Uint8Array ? Buffer.from(content) : Buffer.from(String(content ?? ''), 'utf8');
    await fs.writeFile(t.abs, buf);
    metaSet(env, metaKey(env, 'home', t.rel), { agent_id: who.agentId || null, chat_id: who.chatId || null, job_id: who.jobId || null });
    if (isInside(knowledgeDir, t.abs)) kb.ingest(t.abs).catch(() => {});
    changed({ path: t.rel, action: 'write' });
    return { path: t.rel, name, size: buf.length, how: d.how, approvalId: d.id };
  }

  async function read(p) {
    const t = await checkReal(agentTarget(p));
    const st = await fs.stat(t.abs).catch(() => null);
    if (!st) throw fail(404, 'not_found', 'Nothing is there.');
    if (st.isDirectory()) throw fail(400, 'is_folder', 'That is a folder. List it instead.');
    const ext = extOf(t.abs);
    let text;
    if (TEXT_EXT.has(ext)) { const fh = await fs.open(t.abs); try { const b = Buffer.alloc(Math.min(st.size, MAX_READ)); await fh.read(b, 0, b.length, 0); text = b.toString('utf8'); } finally { await fh.close(); } }
    else text = await extractText(t.abs);
    const cut = text.length > MAX_READ;
    return { path: t.rel, name: path.basename(t.abs), size: st.size, text: cut ? text.slice(0, MAX_READ) : text, cut: cut || st.size > MAX_READ && TEXT_EXT.has(ext) };
  }

  async function list(dir = '') {
    const t = await checkReal(agentTarget(dir || ''));
    const entries = await fs.readdir(t.abs, { withFileTypes: true }).catch(() => { throw fail(404, 'not_found', 'That folder is not there.'); });
    const out = [];
    for (const d of entries.slice(0, 1000)) {
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
      const abs = path.join(t.abs, d.name); if (isBlocked(env, abs)) continue;
      const st = await fs.stat(abs).catch(() => null); if (!st) continue;
      out.push({ name: d.name, kind: st.isDirectory() ? 'folder' : 'file', size: st.isDirectory() ? null : st.size, modified: st.mtime.toISOString() });
    }
    return { dir: t.rel || '', items: out };
  }

  async function trash(p, who = {}) {
    const t = agentTarget(p, { write: true });
    const d = await ctx.approval.request({ action: 'file.delete', agentId: who.agentId || null, jobId: who.jobId || undefined, chatId: who.chatId || undefined, title: `Move ${path.basename(t.abs)} to the Bin`, payload: { path: t.rel }, signal: who.signal });
    if (!d.ok) throw fail(403, 'not_approved', `Moving ${path.basename(t.abs)} to the Bin did not go ahead (${d.reason}).`);
    const r = await recycleEntries(env, 'home', [t.rel]);
    if (isInside(knowledgeDir, t.abs)) kb.forget(t.rel);
    changed({ path: t.rel, action: 'trash' });
    return r.items[0];
  }

  const knowledgeSearch = async (query, opts) => kb.search(query, opts);

  ctx.expose({ list, write, read, trash, knowledgeSearch, knowledgeReindex: (o) => kb.reindex(o), cardFor });

  // ---- Coordinator tools ----
  const who = (call) => ({ agentId: call?.agentId || null, jobId: call?.jobId || null, chatId: call?.chatId || null, signal: call?.signal });
  const plain = (e) => ({ ok: false, error: e.message });
  ctx.tool({
    name: 'file_write', description: 'Write a text file in the workspace (for example reports/notes.md). The owner may be asked first.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path, e.g. drafts/plan.md' }, content: { type: 'string' } }, required: ['path', 'content'] },
    async run(args, call) {
      try { const r = await write(args.path, args.content, who(call)); const card = cardFor(r, who(call)); call?.emitCard?.(card); return { ok: true, path: r.path, name: r.name, size: r.size, cards: [card] }; } catch (e) { return plain(e); }
    },
  });
  ctx.tool({
    name: 'file_read', description: 'Read a file from the workspace (text, Markdown, CSV, PDF, Word, Excel), or from a folder the owner opened.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async run(args) { try { return { ok: true, ...(await read(args.path)) }; } catch (e) { return plain(e); } },
  });
  ctx.tool({
    name: 'file_list', description: 'List a folder in the workspace ("" is the top).',
    parameters: { type: 'object', properties: { dir: { type: 'string' } } },
    async run(args) { try { return { ok: true, ...(await list(args.dir || '')) }; } catch (e) { return plain(e); } },
  });
  ctx.tool({
    name: 'knowledge_search', description: "Search the owner's Knowledge folder. Returns passages with the file they came from.",
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run(args) { const hits = await knowledgeSearch(args.query); return { ok: true, passages: hits.map((h) => ({ file: h.file, page: h.page, text: h.text })) }; },
  });

  // ---- owner routes (the Files page). Every one needs the desk's session. ----
  const route = (method, p, fn) => ctx.route(method, p, async (req, res, arg) => {
    if (!arg.owner) return ctx.json(res, { error: 'Only the owner at this desk can use Files.' }, 403);
    try { const out = await fn(arg, req, res); if (out !== undefined) ctx.json(res, out); }
    catch (err) {
      const status = err instanceof ExplorerError ? err.status : (err.code === 'ENOENT' ? 404 : err.code === 'EEXIST' ? 409 : err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 500);
      ctx.json(res, { error: err.message || 'Something went wrong.', code: err.code || 'failed' }, status);
    }
  });
  const b = (arg) => arg.body || {};

  route('GET', '/roots', async () => ({ roots: await listRoots(env) }));
  route('GET', '/list', async ({ query }) => {
    if (query.root === 'recent') return { root: 'recent', path: '', crumbs: [{ label: 'Recent', path: '' }], items: await listRecent(env), mixed: true };
    if (query.root === 'starred') return { root: 'starred', path: '', crumbs: [{ label: 'Starred', path: '' }], items: await listStarred(env), mixed: true };
    return listFolder(env, query.root || 'home', query.path || '', { q: query.q || '' });
  });
  route('GET', '/stat', async ({ query }) => statEntry(env, query.root || 'home', query.path || ''));
  route('GET', '/text', async ({ query }) => {
    const hit = await locate(env, query.root || 'home', query.path || '');
    if (!(await fs.stat(hit.abs)).isFile()) throw fail(400, 'not_file', 'That is a folder.');
    const text = await extractText(hit.abs);
    return { root: hit.root.id, path: hit.rel, text: text.slice(0, MAX_READ), cut: text.length > MAX_READ };
  });
  route('GET', '/raw', async ({ query }, req, res) => {
    const hit = await locate(env, query.root || 'home', query.path || '');
    const st = await fs.stat(hit.abs);
    if (!st.isFile()) throw fail(400, 'not_file', 'That is a folder.');
    const name = hit.parts[hit.parts.length - 1] || 'file';
    const mime = MIME[extOf(name)] || 'application/octet-stream';
    const headers = { 'content-type': mime, 'content-length': String(st.size), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-disposition': `${query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}` };
    if (mime !== 'application/pdf') headers['content-security-policy'] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
    res.writeHead(200, headers);
    await new Promise((resolve) => { const s = createReadStream(hit.abs); s.on('end', resolve); s.on('error', () => { res.destroy(); resolve(); }); s.pipe(res); });
    return undefined;
  });
  route('POST', '/meta', async (arg) => setEntryMeta(env, b(arg).root, b(arg).path, b(arg)));
  route('POST', '/mkdir', async (arg) => { const r = await makeFolder(env, b(arg).root, b(arg).path || '', b(arg).name); changed(r); return r; });
  route('POST', '/rename', async (arg) => { const r = await renameEntry(env, b(arg).root, b(arg).path, b(arg).name); changed(r); return r; });
  route('POST', '/move', async (arg) => { const x = b(arg); const r = await moveEntries(env, x.root, x.paths, x.toRoot || x.root, x.toPath || '', { copy: false }); changed(r); return r; });
  route('POST', '/copy', async (arg) => { const x = b(arg); const r = await moveEntries(env, x.root, x.paths, x.toRoot || x.root, x.toPath || '', { copy: true }); changed(r); return r; });
  route('POST', '/recycle', async (arg) => { const r = await recycleEntries(env, b(arg).root, b(arg).paths); changed(r); kb.reindex().catch(() => {}); return r; });
  route('POST', '/restore', async (arg) => { const r = await restoreEntry(env, b(arg).id); changed(r); kb.reindex().catch(() => {}); return r; });
  // Upload: the raw file is the body (any content type but JSON); name and folder ride in the query.
  route('POST', '/upload', async ({ query }, req) => {
    const bytes = await ctx.readBody(req, MAX_UPLOAD);
    const r = await uploadFile(env, query.root || 'home', query.path || '', query.name, bytes);
    const hit = await locate(env, r.root, r.path);
    if (isInside(knowledgeDir, hit.abs)) await kb.ingest(hit.abs).catch(() => {});
    changed(r); return r;
  });

  // Allow access to a folder outside the workspace: the owner's click raises a file.read.outside approval.
  const waitingGrants = new Map();   // folder -> promise
  route('POST', '/grants', async (arg) => {
    const rootId = String(b(arg).root || '');
    const o = outsideDir(env, rootId);
    if (!o) throw fail(400, 'bad_root', 'Only Downloads, Documents, Desktop and drives need access.');
    if (grants().includes(o.dir)) return { granted: true, root: rootId };
    if (!waitingGrants.has(o.dir)) {
      const p = ctx.approval.request({ action: 'file.read.outside', agentId: null, title: `Open ${o.label} in Files`, detail: 'Agents can read it too once you open it.', payload: { folder: o.dir } })
        .then((d) => { if (d.ok) { const mine = ctx.kv.get('grants', []); if (!mine.includes(o.dir)) ctx.kv.set('grants', [...mine, o.dir]); changed({ root: rootId, granted: true }); } return d; })
        .finally(() => waitingGrants.delete(o.dir));
      waitingGrants.set(o.dir, p);
    }
    const d = await Promise.race([waitingGrants.get(o.dir) || Promise.resolve(null), new Promise((r) => setTimeout(() => r(null), 250))]);
    if (d) return { granted: !!d.ok, root: rootId, reason: d.ok ? null : d.reason };
    const pending = ctx.approval.listPending().find((a) => a.action === 'file.read.outside' && a.payload?.folder === o.dir);
    return { granted: false, pending: true, root: rootId, approvalId: pending?.id || null };
  });
  route('POST', '/grants/revoke', async (arg) => {
    const o = outsideDir(env, String(b(arg).root || ''));
    if (!o) throw fail(400, 'bad_root', 'Unknown folder.');
    ctx.kv.set('grants', ctx.kv.get('grants', []).filter((g) => g !== o.dir));
    changed({ root: b(arg).root, granted: false });
    return { revoked: true, root: b(arg).root };
  });

  route('GET', '/knowledge', async () => ({ dir: 'knowledge', ...kb.status() }));
  route('POST', '/knowledge/reindex', async () => { const r = await kb.reindex({ force: true }); changed({ knowledge: true }); return { files: r.files, indexed: r.indexed.length, ...r.status }; });
  route('GET', '/knowledge/search', async ({ query }) => ({ passages: kb.search(query.q || '') }));

  return { async deactivate() {} };
}
