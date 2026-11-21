// Backup (module 15): back up, restore, activity log, updates and about.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createBackup, listBackups, openBackup, planRestore, restoreDatabase, restoreWorkspace, reviewRestore, recordMadeHere, madeHere, NAME_RE, backupName } from './archive.js';

const LAYOUT = [
  ['start.bat, stop.bat, README.md', 'Start and stop the desk; how to use it'],
  ['app', 'The shell and the four doors'],
  ['modules', 'The 30 modules, one folder each'],
  ['vendor', 'Open-source code copied in, with licences'],
  ['node_modules', 'Installed packages (made by setup)'],
  ['setup', 'Setup and reinstall'],
  ['data', 'Everything you own: the database, the workspace, agents\' browser profiles, the bin'],
  ['backups', 'Zips made here. Outside data on purpose: delete data, restore, and it is back'],
];

export async function activate(ctx) {
  let busy = null;
  const version = () => { for (const f of [path.join(ctx.root, 'app', 'version.json'), path.join(ctx.root, 'package.json')]) { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')).version; if (v) return v; } catch {} } return '0.0.0'; };
  const once = async (what, fn) => {
    if (busy) throw Object.assign(new Error(`A ${busy} is already running. Try again in a moment.`), { status: 409 });
    busy = what;
    try { return await fn(); } finally { busy = null; }
  };
  const fileOf = (name) => {
    if (!NAME_RE.test(String(name)) || path.basename(name) !== name) throw Object.assign(new Error('No such backup.'), { status: 404 });
    const f = path.join(ctx.backupsDir, name);
    if (!fs.existsSync(f)) throw Object.assign(new Error('No such backup.'), { status: 404 });
    return f;
  };
  const ownerOnly = (res, owner, what) => { if (owner) return false; ctx.json(res, { error: `Only the owner at this desk can ${what}.` }, 403); return true; };

  async function backupNow({ includeKeys = false, suffix = '' } = {}) {
    return once('backup', async () => {
      const r = createBackup({ db: ctx.db, workspace: ctx.workspace, backupsDir: ctx.backupsDir, includeKeys: !!includeKeys, version: version(), timeZone: ctx.settings.get('timeZone') || 'UTC', suffix });
      recordMadeHere(ctx.backupsDir, r.path);           // "made on this desk": the ledger lives in the backups folder and survives deleting data
      ctx.events.emit('backup', { made: r.name });
      ctx.log('backup made', r.name, r.size);
      return r;
    });
  }

  /** Restore from a zip path. Called only from the owner-only routes below; not exposed to other modules or agents. */
  async function restore(zipPath, { wipeExtra = false, safetyCopy = true, trustAll = false } = {}) {
    const opened = openBackup(zipPath);                 // refuses zips that are not ours, zip slip, a database that does not open
    try {
      let safety = null;
      if (safetyCopy) { try { safety = (await backupNow({ includeKeys: false, suffix: '-before-restore' })).name; } catch (e) { ctx.log('safety copy failed', e.message); } }
      return await once('restore', async () => {
        const plan = planRestore({ db: ctx.db, opened, workspace: ctx.workspace });
        const ours = madeHere(ctx.backupsDir, zipPath);
        const trusted = ours || !!trustAll;
        const db = restoreDatabase(ctx.db, opened.dbFile, { trusted });
        const files = restoreWorkspace({ fromDir: opened.workspaceDir, workspace: ctx.workspace, wipeExtra: !!wipeExtra, binDir: path.join(ctx.dataDir, 'bin') });
        ctx.db.run('INSERT INTO activity (at, agent_id, action, title, how, detail) VALUES (?, ?, ?, ?, ?, ?)', new Date().toISOString(), null, 'backup.restore', `Restored the backup ${path.basename(zipPath)}${ours ? '' : ' (from elsewhere)'}`, 'owner', `${Object.keys(db.tables).length} tables, ${files.copied} files${db.heldBack.length ? '; held back: ' + db.heldBack.join('; ') : trusted && !ours ? '; everything brought in: you trusted where it came from' : ''}`);
        ctx.events.emit('backup', { restored: path.basename(zipPath) });
        ctx.log('restored', path.basename(zipPath));
        ctx.requestRestart('restore');
        return { ok: true, restarting: true, madeHere: ours, trusted, heldBack: db.heldBack, safetyCopy: safety, tables: db.tables, createdTables: db.created, keptSecrets: db.keptSecrets, files, plan };
      });
    } finally { fs.rmSync(opened.dir, { recursive: true, force: true }); }
  }

  ctx.route('GET', '/list', (req, res) => ctx.json(res, { items: listBackups(ctx.backupsDir), folder: ctx.backupsDir, busy }));

  ctx.route('POST', '/now', async (req, res, { body, owner }) => {
    if (!owner) {
      // another program on this PC: the same as an agent asking; never with keys
      const d = await ctx.approval.request({ action: 'custom', title: 'Make a backup', detail: 'Without keys and logins', payload: { includeKeys: false } });
      if (!d.ok) return ctx.json(res, { error: 'The backup was not approved.', reason: d.reason }, 403);
      return ctx.json(res, await backupNow({ includeKeys: false }));
    }
    ctx.json(res, await backupNow({ includeKeys: !!body?.includeKeys }));
  });

  ctx.route('GET', '/download/:name', (req, res, { params, owner }) => {
    if (ownerOnly(res, owner, 'download a backup')) return;
    const f = fileOf(params.name);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size, 'content-disposition': `attachment; filename="${params.name}"`, 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });

  ctx.route('DELETE', '/:name', (req, res, { params, owner }) => {
    if (ownerOnly(res, owner, 'delete a backup')) return;
    fs.rmSync(fileOf(params.name), { force: true });
    ctx.db.run('INSERT INTO activity (at, agent_id, action, title, how) VALUES (?, ?, ?, ?, ?)', new Date().toISOString(), null, 'backup.delete', `Deleted the backup ${params.name}`, 'owner');
    ctx.json(res, { ok: true });
  });

  ctx.route('POST', '/upload', async (req, res, { owner }) => {
    if (ownerOnly(res, owner, 'upload a backup')) return;
    const raw = await ctx.readBody(req, 4 * 1024 ** 3);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apd-upload-')), 'upload.zip');
    try {
      fs.writeFileSync(tmp, raw);
      const opened = openBackup(tmp);                    // refuse before keeping it
      fs.rmSync(opened.dir, { recursive: true, force: true });
      let name = backupName(new Date(), ctx.settings.get('timeZone') || 'UTC', '-uploaded');
      for (let i = 2; fs.existsSync(path.join(ctx.backupsDir, name)); i++) name = name.replace(/(-\d+)?\.zip$/, `-${i}.zip`);
      fs.mkdirSync(ctx.backupsDir, { recursive: true });
      fs.copyFileSync(tmp, path.join(ctx.backupsDir, name));
      ctx.json(res, { ok: true, name, created: opened.manifest.created });
    } finally { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
  });

  // The preview is the approval: a restore needs the id of a preview the owner was shown in the last 15 minutes.
  const previews = new Map();          // previewId -> { name, at }
  ctx.route('GET', '/preview/:name', (req, res, { params, owner }) => {
    if (ownerOnly(res, owner, 'look inside a backup')) return;
    const file = fileOf(params.name);
    const opened = openBackup(file);
    try {
      const previewId = crypto.randomBytes(12).toString('hex');
      previews.set(previewId, { name: params.name, at: Date.now() });
      ctx.json(res, { name: params.name, previewId, madeHere: madeHere(ctx.backupsDir, file), sensitive: reviewRestore(ctx.db, opened.dbFile), ...planRestore({ db: ctx.db, opened, workspace: ctx.workspace }) });
    } finally { fs.rmSync(opened.dir, { recursive: true, force: true }); }
  });

  ctx.route('POST', '/restore/:name', async (req, res, { params, body, owner }) => {
    if (ownerOnly(res, owner, 'restore a backup')) return;
    const p = previews.get(String(body?.previewId || ''));
    if (!p || p.name !== params.name || Date.now() - p.at > 15 * 60000) return ctx.json(res, { error: 'Look at what this backup will change first: press Restore beside it again.' }, 409);
    previews.delete(String(body.previewId));
    ctx.json(res, await restore(fileOf(params.name), { wipeExtra: !!body?.wipeExtra, trustAll: body?.trustAll === true }));
  });

  ctx.route('GET', '/about', (req, res) => {
    const read = (name) => { for (const f of [path.join(ctx.root, name), path.join(ctx.root, 'app', 'docs', name)]) { try { return fs.readFileSync(f, 'utf8'); } catch {} } return null; };
    ctx.json(res, {
      version: version(), node: process.version, platform: process.platform,
      folders: { install: ctx.root, data: ctx.dataDir, workspace: ctx.workspace, backups: ctx.backupsDir },
      layout: LAYOUT, attribution: read('ATTRIBUTION.md'),
      updates: 'Signed updates from GitHub: see the Updates card. Your data folder is never changed by an update.',
    });
  });

  ctx.tool({
    name: 'backup_now',
    description: 'Make a backup of the desk (database and workspace, without keys and logins) into the backups folder. The owner is asked first. Agents cannot restore.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'One line: why a backup now' } } },
    async run(args, call) {
      const d = await ctx.approval.request({ agentId: call.agentId, chatId: call.chatId, action: 'custom', title: 'Make a backup', detail: args?.reason ? String(args.reason).slice(0, 200) : 'Without keys and logins', payload: { includeKeys: false }, signal: call.signal });
      if (!d.ok) return { ok: false, reason: d.reason, text: 'The backup was not made: the owner did not approve it.' };
      const r = await backupNow({ includeKeys: false });
      return { ok: true, name: r.name, size: r.size, text: `Backup ${r.name} is in the backups folder.` };
    },
  });

  // No restore here: only the owner's own click in Settings › Backup restores.
  ctx.expose({ backupNow: (o) => backupNow({ includeKeys: !!o?.includeKeys }), list: () => listBackups(ctx.backupsDir) });
  return { async deactivate() {} };
}
