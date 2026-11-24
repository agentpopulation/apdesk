// The Module Store's own routes: add a module from a zip, build one here (a starter, then optionally a model writes the
// rest), hand the kit to another agent, remove an added module, and check a skill from a file. Anyone may ask to add or
// remove a module; the Admin of the PC (the keeper) approves it, as an install, every time, at every level.
// The work happens in the house's data folder (module-store/), never in a person's space, and never in Incognito.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkModule, HONEST_DESK, LIMITS } from '../../app/core/module-check/check.mjs';
import { readZip, unzipTo } from '../../app/core/module-check/zip.mjs';
import { hashFolder } from '../../app/core/module-check/sig.mjs';
import { checkSkill, deskSkill, SKILL_LIMIT, SKILL_HONEST } from '../../app/core/module-check/skill.mjs';
import { HIDDEN_CHARS } from '../../app/core/module-check/files.mjs';
import { OFFICIAL_PLACES } from '../../app/core/module-check/desk-facts.mjs';
import { install, takeOut, changedSince } from './house.js';
import { readForm, makeStarter, taskSheet } from './starter.js';
import { buildPrompt, readAnswer, changes, costWords } from './writer.js';

const KIT_FILE = 'apdesk-module-kit-0.1.zip';
const KIT_TOP = 'apdesk-module-kit/';
const MAX_ZIP = 5 * 1024 * 1024;
const MAX_SKILL = 512 * 1024;
const RESERVED = ['panic', 'security', 'approval', 'modules', 'settings', 'agents', 'job', 'restart', 'store', 'm', 'api', 'ui'];
const ONLY_FROM = 'Add a module only from someone you would run a program from.';
const INCOGNITO_NO = 'Modules are not added, built or removed in Incognito: it keeps nothing, and a module is added for the whole desk.';
const STATES = { checked: 'Checked. Not asked yet.', waiting: 'Waiting for the Admin to approve it.', added: 'Added. It is off until someone with the right switches it on.', denied: 'The Admin said no. Nothing was added.', ended: 'The desk restarted before the Admin decided. Ask again.', failed: 'It could not be added.', removed: 'Removed.' };

export async function activate(ctx) {
  const door = ctx.moduleFolder;                       // the house-wide door (app/core/modules.js folderDoor)
  const home = path.join(ctx.deskDataDir, 'module-store');
  const reqDir = path.join(home, 'requests'); const tmpDir = path.join(home, 'tmp'); const keptDir = path.join(home, 'removed');
  const kitPath = path.join(ctx.dir, 'kit', KIT_FILE);
  const deskVersion = (() => { try { return JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8')).version; } catch { return 'this version'; } })();

  // ---- the kit that ships inside the desk: its test host (for the check) and its guide and contract (for a model)
  let kitCache = null;
  const kit = () => {
    if (kitCache) return kitCache;
    const entries = readZip(kitPath); const get = (n) => entries.find((e) => e.name === KIT_TOP + n)?.data?.toString('utf8') || null;
    const testhost = get('samples/hello-notes/testhost.js');
    kitCache = { testhost, testhostSha: testhost ? crypto.createHash('sha256').update(testhost).digest('hex') : null, guide: get('GUIDE.md') || '', contract: get('CONTRACT.md') || '', size: fs.statSync(kitPath).size };
    return kitCache;
  };
  const trusted = () => { try { return JSON.parse(fs.readFileSync(path.join(ctx.root, 'app', 'core', 'update-keys.json'), 'utf8')).keys || []; } catch { return []; } };

  // ---- requests: one folder each, request.json beside files/<id>/ (the checked copy)
  const rid = () => 'r' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const ridOk = (r) => /^r[a-z0-9]{6,20}$/.test(String(r || ''));
  const recFile = (r) => path.join(reqDir, r, 'request.json');
  const readReq = (r) => { if (!ridOk(r)) return null; try { return JSON.parse(fs.readFileSync(recFile(r), 'utf8')); } catch { return null; } };
  const writeReq = (rec) => { fs.mkdirSync(path.join(reqDir, rec.rid), { recursive: true }); fs.writeFileSync(recFile(rec.rid), JSON.stringify(rec, null, 1)); return rec; };
  const filesOf = (rec) => path.join(reqDir, rec.rid, 'files', rec.id);
  const dropReq = (r) => { if (ridOk(r)) fs.rmSync(path.join(reqDir, r), { recursive: true, force: true }); };
  const allReqs = () => { try { return fs.readdirSync(reqDir).filter(ridOk).map(readReq).filter(Boolean).sort((a, b) => (b.created || '').localeCompare(a.created || '')); } catch { return []; } };
  // the approvals of a desk that stopped are expired by the core at the next start; their requests say so
  if (door?.isMainSpace()) for (const r of allReqs()) if (r.state === 'waiting') writeReq({ ...r, state: 'ended' });

  /** The person who asked hears the outcome at once: a 'store' event for his open page and one plain toast. */
  const ENDED = { halted: 'Panic stopped it before the Admin decided. Ask again after Resume.', timeout: 'Nobody decided within a day. Ask again.' };
  const tell = (rec, state, words) => {
    try { ctx.events.emit('store', { rid: rec.rid || null, id: rec.id, state }); ctx.events.emit('toast', { text: words, kind: state === 'added' || state === 'removed' ? 'ok' : state === 'failed' ? 'err' : '' }); } catch {}
  };
  const builtIn = () => new Set(door.builtIn());
  const present = () => door.present();
  /** Check a folder for adding, with what this desk already has. A custom module of the same id may be replaced. */
  async function check(dir) {
  const b = builtIn(); const pres = present();
    let idHere = null; try { idHere = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'))?.id; } catch {}
    const numbers = pres.filter((p) => p.id !== idHere && p.number != null).map((p) => p.number);
    return checkModule(dir, { trusted: trusted(), testhost: kit().testhostSha, deskVersion, deskModules: [...b, ...OFFICIAL_PLACES, 'settings'], deskNumbers: numbers,
      notRun: 'Not run: the desk reads a module\'s files and never runs its code to check it. The kit\'s own check can also run its tests in a locked-down process.' });
  }
  const view = (rec) => {
    const p = present().find((x) => x.id === rec.id);
    return { rid: rec.rid, id: rec.id, name: rec.name, from: rec.from, created: rec.created, state: rec.state, words: STATES[rec.state] || '', replaces: !!p, replacesOn: !!p?.on, red: rec.report?.red ?? 0, yellow: rec.report?.yellow ?? 0, label: rec.report?.label || null, lines: lines(rec.report), changes: rec.changes || null, note: rec.note || null, skipped: rec.skipped || [], base: rec.base || null, restart: !!rec.restart, why: rec.why || null };
  };
  const lines = (rep) => (rep?.sections || []).map((s) => ({ title: s.title, lines: s.lines.filter((l) => l.level !== 'info' || s.title === 'Runs clean').map((l) => ({ level: l.level, text: l.text })) }));
  /** Keep a checked folder as a request (or refuse it on a red line, keeping nothing). */
  async function keep(dir, { from, base = null, extra = {} }) {
    const report = await check(dir);
    if (!report.id || report.red) return { refused: true, report: { red: report.red, yellow: report.yellow, label: report.label, sections: lines(report) }, honest: HONEST_DESK };
    // a new check of the same module takes the place of one that was checked and never asked
    for (const old of allReqs()) if (old.id === report.id && old.state === 'checked' && old.from === from) dropReq(old.rid);
    const r = rid(); fs.mkdirSync(path.join(reqDir, r, 'files'), { recursive: true });
    fs.cpSync(dir, path.join(reqDir, r, 'files', report.id), { recursive: true, verbatimSymlinks: true });
    const rec = writeReq({ rid: r, id: report.id, name: report.manifest?.name || report.id, from, base, created: new Date().toISOString(), state: 'checked', hashes: hashFolder(path.join(reqDir, r, 'files', report.id), ''), report: { red: report.red, yellow: report.yellow, label: report.label, sections: report.sections }, ...extra });
    return { refused: false, request: view(rec), honest: HONEST_DESK };
  }
  const tmp = () => { fs.mkdirSync(tmpDir, { recursive: true }); return fs.mkdtempSync(path.join(tmpDir, 'apd-check-')); };
  const no = (res, status, error) => ctx.json(res, { error }, status);
  const refuseIncognito = (res) => (ctx.incognito ? (no(res, 403, INCOGNITO_NO), true) : false);

  ctx.route('GET', '/state', (req, res) => {
    let k = null; try { k = kit(); } catch {}
    ctx.json(res, { incognito: !!ctx.incognito, requests: allReqs().filter((r) => r.state !== 'removed').map(view), honest: HONEST_DESK, onlyFrom: ONLY_FROM, kit: k ? { size: k.size } : null, limits: { zip: MAX_ZIP, module: LIMITS.total } });
  });

  // ---- Add a module: a zip chosen in the browser, sent as the request body
  ctx.route('POST', '/check', async (req, res, { owner }) => {
    if (!owner) return no(res, 403, 'Modules are added from the desk window.');
    if (refuseIncognito(res)) return;
    const tooBig = `That file is larger than ${MAX_ZIP / 1048576} MB. A module zip is much smaller; check that you chose the right file.`;
    if (Number(req.headers['content-length']) > MAX_ZIP) { req.resume(); return no(res, 413, tooBig); }
    let buf;
    try { buf = await ctx.readBody(req, MAX_ZIP); } catch { return no(res, 413, tooBig); }
    if (!buf.length) return no(res, 400, 'Choose a zip file first.');
    const t = tmp();
    try {
      let r;
      try { r = unzipTo(buf, path.join(t, 'x')); } catch (e) { return no(res, 400, `Refused: ${e.code === 'bad_zip' ? e.message.replace(/^Refused:\s*/, '') : 'this file could not be read as a zip.'} Nothing was added.`); }
      const dir = path.join(t, r.folder || 'x');
      if (r.folder) fs.renameSync(path.join(t, 'x'), dir);
      ctx.json(res, await keep(dir, { from: 'file' }));
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
  });

  // ---- Build it here: the form makes a starter at once (no model)
  const usedIds = () => [...builtIn(), ...present().map((p) => p.id), ...OFFICIAL_PLACES, ...RESERVED];
  ctx.route('POST', '/build', async (req, res, { body, owner }) => {
    if (!owner) return no(res, 403, 'Modules are built from the desk window.');
    if (refuseIncognito(res)) return;
    const form = readForm(body);
    if (form.problems.length) return ctx.json(res, { error: form.problems.join(' '), problems: form.problems }, 400);
    const st = makeStarter(form, { usedIds: usedIds(), usedNumbers: present().map((p) => p.number).filter((n) => n != null), testhost: kit().testhost });
    const t = tmp();
    try {
      const dir = path.join(t, st.id); fs.mkdirSync(dir);
      for (const [n, text] of Object.entries(st.files)) fs.writeFileSync(path.join(dir, n), text);
      ctx.json(res, await keep(dir, { from: 'built here', extra: { form } }));
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
  });

  // ---- the models the owner may pick to write the rest, each with its cost in plain words
  ctx.route('GET', '/models', async (req, res) => {
    let act = []; try { act = await ctx.model.active(); } catch {}
    const prov = ctx.model.providers();
    const models = act.filter((a) => a.ok && (a.models || []).length).flatMap((a) => (a.provider === 'router' ? [{ provider: 'router', model: null, label: a.label }] : (a.models || []).slice(0, 8).map((mm) => ({ provider: a.provider, model: mm, label: `${a.label} · ${mm}` }))))
      .map((x) => ({ ...x, cost: costWords(x), paid: (prov[x.provider]?.tier || (['router', 'ollama', 'llama'].includes(x.provider) || /^lan:/.test(x.provider) ? 'free' : 'paid')) !== 'free' && costWords(x) !== 'free' }));
    ctx.json(res, { models, advice: 'A big model writes a module best: a large online model, or a local one of 14B or more. Small models often break the rules and the check refuses their work.' });
  });

  // ---- Write the rest with a model: a job; the result is a new request beside the starter's, checked the same way
  ctx.route('POST', '/requests/:rid/write', async (req, res, { params, body, owner }) => {
    if (!owner) return no(res, 403, 'Ask from the desk window.');
    if (refuseIncognito(res)) return;
    const base = readReq(params.rid);
    if (!base || !base.form) return no(res, 404, 'Make a starter with "Build it here" first.');
    const pick = body?.provider ? { provider: String(body.provider), model: body.model ? String(body.model) : null } : null;
    const starterFiles = {}; for (const f of fs.readdirSync(filesOf(base))) if (fs.statSync(path.join(filesOf(base), f)).isFile()) starterFiles[f] = fs.readFileSync(path.join(filesOf(base), f), 'utf8');
    const job = await ctx.jobs.start({
      kind: 'store.write', title: `Write the rest of ${base.name} with a model`, input: { base: base.rid },
      async run(job) {
        job.progress(0.1, 'Asking the model you chose');
        const k = kit();
        let r;
        try { r = await ctx.model.chat({ ...(pick ? { model: pick } : {}), purpose: 'plan', signal: job.signal, maxTokens: 8000, messages: buildPrompt({ form: base.form, starter: { files: starterFiles }, guide: k.guide, contract: k.contract }) }); }
        catch (e) {
          if (job.signal?.aborted) throw e;   // stopped: the job says so
          return { text: `The model did not answer, so nothing changed. ${ctx.plainFailure(e).line}`, by: null, refused: false, rid: null, changes: [], report: null, skipped: [] };
        }
        job.progress(0.7, 'Checking what came back');
        const got = readAnswer(r.text);
        if (!Object.keys(got.files).length) return { text: `The model sent back no file the desk could use, so nothing changed.${got.note ? ' It said: ' + got.note : ''} A bigger model may do better.`, by: r.label, refused: false, rid: null, changes: [], report: null, skipped: got.skipped };
        const after = { ...starterFiles, ...got.files };
        const t = tmp();
        try {
          const dir = path.join(t, base.id); fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
          for (const [n, text] of Object.entries(after)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), text); }
          if (!fs.readdirSync(path.join(dir, 'lib')).length) fs.rmdirSync(path.join(dir, 'lib'));
          const out = await keep(dir, { from: 'built with a model', base: base.rid, extra: { form: base.form, changes: changes(starterFiles, after), note: got.note, skipped: got.skipped, by: r.label } });
          return { text: out.refused ? `The model's work has a red line, so it was not kept: ${out.report.sections.flatMap((s) => s.lines).find((l) => l.level === 'red')?.text || ''}` : `Checked: ${out.request.yellow} yellow line${out.request.yellow === 1 ? '' : 's'}. Nothing is added until the Admin approves it.`, by: r.label, refused: out.refused, rid: out.request?.rid || null, changes: changes(starterFiles, after), report: out.refused ? out.report : null };
        } finally { fs.rmSync(t, { recursive: true, force: true }); }
      },
    });
    ctx.json(res, { jobId: job.id, message: 'The model is writing. This can take a few minutes; it shows here when it is checked.' });
  });

  // ---- Ask to add it: the Admin approves, as an install, every time
  ctx.route('POST', '/requests/:rid/ask', async (req, res, { params, owner }) => {
    if (!owner) return no(res, 403, 'Ask from the desk window.');
    if (refuseIncognito(res)) return;
    const rec = readReq(params.rid);
    if (!rec) return no(res, 404, 'That request is not here any more.');
    if (rec.state === 'waiting') return no(res, 409, 'It is already waiting for the Admin.');
    if (rec.state === 'added') return no(res, 409, 'It was added already.');
    if (builtIn().has(rec.id)) return no(res, 409, 'A module that comes with the desk cannot be replaced from here.');
    const diff = changedSince(filesOf(rec), rec.hashes);
    if (diff) { writeReq({ ...rec, state: 'failed', why: `${diff} changed after it was checked.` }); return no(res, 409, `Not asked: ${diff} changed after it was checked. Check it again.`); }
    const p = present().find((x) => x.id === rec.id);
    const sha = crypto.createHash('sha256').update(JSON.stringify(rec.hashes)).digest('hex');
    const payload = { kind: 'custom-module', id: rec.id, name: rec.name, from: rec.from, files: rec.hashes.length, sha256: sha, red: rec.report.red, yellow: rec.report.yellow, signed: rec.report.label?.signed || 'Not signed.', replaces: !!p };
    const detail = [`${rec.report.yellow} yellow line${rec.report.yellow === 1 ? '' : 's'} in its check.`, rec.report.label?.signed || 'Not signed.', p ? 'It replaces the module of that name; the old one is kept beside it, asleep.' : null, 'It starts off.'].filter(Boolean).join(' ');
    writeReq({ ...rec, state: 'waiting' });
    const fromWords = rec.from === 'file' ? 'a zip file chosen in the Module Store' : rec.from === 'built here' ? 'the Module Store form' : 'a model chosen in the Module Store';
    door.askKeeper({ title: `Add the module ${rec.name}`, detail, from: fromWords, payload }).then(async (d) => {
      const now = readReq(rec.rid); if (!now || now.state !== 'waiting') return;
      if (!d.ok) {
        const state = d.reason === 'denied' ? 'denied' : 'ended';
        writeReq({ ...now, state });
        return tell(now, state, state === 'denied' ? `The Admin said no to ${now.name}. Nothing was added.` : `The request to add ${now.name} ended. ${ENDED[d.reason] || 'Ask again.'}`);
      }
      try {
        door.assertKeeperGranted(d.id, payload);
        const wasOn = !!present().find((x) => x.id === rec.id)?.on;
        const r = install(filesOf(now), now.id, door.dir, { hashes: now.hashes, record: { from: now.from, at: new Date().toISOString(), signedBy: now.report.label?.signedBy || null, label: { ...now.report.label, red: now.report.red, yellow: now.report.yellow } } });
        door.rediscover();
        writeReq({ ...now, state: 'added', restart: !!r.kept && wasOn, files: undefined });
        fs.rmSync(path.join(reqDir, now.rid, 'files'), { recursive: true, force: true });
        ctx.activity(`Added the module ${now.name}${r.kept ? ' (the old one is kept beside it)' : ''}`);
        tell(now, 'added', `The Admin added ${now.name}. It is off until it is switched on.`);
      } catch (e) {
        ctx.log('add failed', e?.message || e);
        const why = e.status ? e.message : 'The files could not be copied into the modules folder.';
        writeReq({ ...now, state: 'failed', why });
        tell(now, 'failed', `${now.name} could not be added: ${why}`);
      }
    }).catch((e) => { ctx.log('ask failed', e?.message || e); });
    ctx.json(res, { request: view(readReq(rec.rid)), message: 'Asked. It waits until the Admin approves it under Waiting for you.' });
  });
  ctx.route('POST', '/requests/:rid/drop', (req, res, { params, owner }) => {
    if (!owner) return no(res, 403, 'From the desk window only.');
    const rec = readReq(params.rid); if (!rec) return no(res, 404, 'That request is not here any more.');
    if (rec.state === 'waiting') return no(res, 409, 'It is waiting for the Admin; the Admin can say no to it.');
    dropReq(rec.rid); ctx.json(res, { ok: true, message: 'Taken off the list.' });
  });

  // ---- Remove an added module: the Admin approves; its data stays unless "also remove its data" is ticked
  ctx.route('POST', '/remove/:id', async (req, res, { params, body, owner }) => {
    if (!owner) return no(res, 403, 'From the desk window only.');
    if (refuseIncognito(res)) return;
    const m = ctx.modules.list().find((x) => x.id === params.id);
    if (!m) return no(res, 404, 'There is no such module.');
    if (!m.custom || builtIn().has(m.id)) return no(res, 409, 'Modules that come with the desk stay. You can switch them off.');
    const data = body?.data === true;
    const payload = { kind: 'remove-custom-module', id: m.id, name: m.name, removeData: data };
    door.askKeeper({ title: `Remove the module ${m.name}`, detail: data ? 'Its data is removed too: its tables and settings in every space open now.' : 'Its data stays, in case it is added again.', from: 'the Module Store', payload }).then(async (d) => {
      if (!d.ok) return tell(m, d.reason === 'denied' ? 'denied' : 'ended', d.reason === 'denied' ? `The Admin said no: ${m.name} stays.` : `The request to remove ${m.name} ended. ${ENDED[d.reason] || 'Ask again.'}`);
      try {
        door.assertKeeperGranted(d.id, payload);
        await door.stopEverywhere(m.id);
        if (data) door.dropData(m.id);
        takeOut(door.dir, m.id, keptDir);
        door.rediscover();
        ctx.activity(`Removed the module ${m.name}${data ? ' and its data' : ' (its data stays)'}`);
        tell(m, 'removed', `The Admin removed ${m.name}${data ? ' and its data' : '. Its data stays'}.`);
      } catch (e) { ctx.log('remove failed', e?.message || e); tell(m, 'failed', `${m.name} could not be removed. It stays as it was.`); }
    }).catch((e) => ctx.log('remove ask failed', e?.message || e));
    ctx.json(res, { message: 'Asked. It is removed once the Admin approves it under Waiting for you.' });
  });

  // ---- Build it with another agent: the kit zip and the filled task sheet
  ctx.route('GET', '/kit', (req, res) => {
    let st; try { st = fs.statSync(kitPath); } catch { return no(res, 404, 'The kit is not in this copy of the desk.'); }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': st.size, 'content-disposition': `attachment; filename="${KIT_FILE}"`, 'cache-control': 'no-store' });
    fs.createReadStream(kitPath).pipe(res);
  });
  ctx.route('POST', '/task-sheet', (req, res, { body }) => {
    const form = readForm(body);
    if (form.problems.length) return ctx.json(res, { error: form.problems.join(' '), problems: form.problems }, 400);
    ctx.json(res, { name: 'task-sheet.md', text: taskSheet(form, { deskVersion }) });
  });

  // ---- Add a skill from a file: the kit's skill check, text only; the Agents module's own route adds it
  ctx.route('POST', '/skill-check', (req, res, { body, owner }) => {
    if (!owner) return no(res, 403, 'From the desk window only.');
    if (ctx.incognito) return no(res, 403, 'Skills are not added in Incognito: it keeps nothing.');
    const files = Array.isArray(body?.files) ? body.files : [];
    const total = files.reduce((n, f) => n + String(f?.text ?? '').length, 0);
    if (!files.length) return no(res, 400, 'Choose a SKILL.md, a folder that holds one, or one .md file.');
    if (total > MAX_SKILL || files.length > 200) return no(res, 413, 'That is more than a skill holds. Choose the skill\'s own folder or its SKILL.md.');
    const t = tmp();
    try {
      const names = files.map((f) => String(f?.path || '').replace(/\\/g, '/').replace(/^\/+/, ''));
      const single = files.length === 1 && /\.md$/i.test(names[0]) && !/(^|\/)SKILL\.md$/.test(names[0]);
      // a folder's files keep their place under the skill folder (its top folder is dropped); nothing climbs out
      const root = path.join(t, 'skill'); fs.mkdirSync(root);
      const top = names.every((n) => n.includes('/')) && new Set(names.map((n) => n.split('/')[0])).size === 1 ? names[0].split('/')[0] + '/' : '';
      for (let i = 0; i < files.length; i++) {
        const rel = single ? path.basename(names[i]) : names[i].slice(top.length);
        if (!rel || rel.split('/').some((p) => p === '..' || p === '') || /^[A-Za-z]:/.test(rel)) return no(res, 400, 'Refused: a file name in it would land outside the skill folder.');
        const to = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, String(files[i]?.text ?? ''));
      }
      const target = single ? path.join(root, path.basename(names[0])) : root;
      if (!single && !fs.existsSync(path.join(root, 'SKILL.md'))) return no(res, 400, 'There is no SKILL.md in what you chose. Choose the skill\'s folder or its SKILL.md, or one .md file.');
      const r = checkSkill(target, { trusted: trusted() });
      const raw = fs.readFileSync(single ? target : path.join(root, 'SKILL.md'), 'utf8');
      const hidden = [...raw.matchAll(new RegExp(HIDDEN_CHARS.source, 'gu'))].length;
      const skill = deskSkill(r);
      ctx.json(res, { title: skill.title, description: skill.description, body: skill.body, lines: r.lines, red: r.red, yellow: r.yellow, hiddenRemoved: hidden, leftOut: r.files || [], cut: (r.body || '').length > skill.body.length, limit: SKILL_LIMIT, honest: SKILL_HONEST });
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
  });

  return { deactivate() { kitCache = null; } };
}
