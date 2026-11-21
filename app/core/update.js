// Signed updates from GitHub. See contracts/UPDATES.md.
// A release carries apdesk-update.json and an Ed25519 signature over its exact bytes. The desk trusts only the public
// keys listed in update-keys.json. It checks when the owner asks (or once a day if he switched that on), installs
// only on his click through the approval door, and stages the new files; setup/apply-update.mjs swaps them in
// before the next start. Nothing here runs while Offline or halted by Panic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { SETTINGS_TOKEN } from './approval-door.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KEYS_FILE = path.join(HERE, 'update-keys.json');
export const REPO = 'https://github.com/agentpopulation/apdesk';
/** github.com answers the download address with a redirect to its own asset host. Nothing else is followed. */
export const GITHUB_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
export const UA = 'AgentPopulationDesk/0.1 (local desktop app)';
export const STAGE = 'update-staged';
/** Never replaced by an update: the owner's data, his backups, the private Node an installer may have put there. */
export const NEVER = new Set(['data', 'backups', 'runtime', '.git']);
const MAX_MANIFEST = 64 * 1024;
const MAX_FEED = 1024 * 1024;
/** Release notes: plain lines, at most this many, each at most this long (sign-release.mjs refuses more). */
export const NOTES_MAX = { lines: 30, chars: 300 };
export const CHANNELS = ['stable', 'preview'];
/** Preview also looks at this many of the newest releases in the feed (pre-releases are never the "latest" one). */
const PREVIEW_TAGS = 3;
const MAX_FILES = 100000;
const MAX_UNPACKED = 3 * 1024 ** 3;
const DAY = 24 * 3600 * 1000;
const LOOP = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const refusal = (line) => Object.assign(new Error(line), { code: 'refused' });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- versions: numbers by part ("0.1.10" is newer than "0.1.9")
export function parseVersion(v) { return /^\d{1,6}(\.\d{1,6}){0,3}$/.test(String(v ?? '')) ? String(v).split('.').map(Number) : null; }
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw refusal(`The version ${!x ? a : b} cannot be read.`);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// ---- keys and the signature
/** The trusted public keys: [{ id, added, publicKey }] where publicKey is an Ed25519 SPKI key in base64 (DER). */
export function loadKeys(list) {
  const out = [];
  for (const k of Array.isArray(list) ? list : []) {
    try { const key = crypto.createPublicKey({ key: Buffer.from(String(k.publicKey), 'base64'), format: 'der', type: 'spki' }); if (key.asymmetricKeyType === 'ed25519') out.push({ id: String(k.id || ''), key }); } catch {}
  }
  return out;
}
export function keysFromFile(file = KEYS_FILE) { return readJson(file)?.keys || []; }

/** Is this manifest signed by one of the listed keys? { ok, keyId } or { ok: false, reason }. */
export function verifyManifest(bytes, sigText, keyList) {
  const keys = loadKeys(keyList);
  if (!keys.length) return { ok: false, reason: 'Updates are not set up in this build.' };
  const sig = Buffer.from(String(sigText || '').trim(), 'base64');
  const good = sig.length === 64 ? keys.find(k => { try { return crypto.verify(null, bytes, k.key, sig); } catch { return false; } }) : null;
  if (good) return { ok: true, keyId: good.id };
  // which key the release names is inside the signed bytes, so it only chooses the words of the refusal
  let named = null; try { named = JSON.parse(bytes.toString('utf8')).key; } catch {}
  if (named && keys.some(k => k.id === named)) return { ok: false, reason: 'The release file was changed after it was signed. It was not used.' };
  return { ok: false, reason: 'The release is signed with a key this desk does not know. It was not used.' };
}

/** The manifest, read strictly. Throws a plain refusal. */
export function readManifest(bytes) {
  let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { throw refusal('The release file cannot be read.'); }
  if (!m || m.product !== 'apdesk') throw refusal('This is not an AP Desk release.');
  if (!parseVersion(m.version)) throw refusal('The release has a version number the desk cannot read.');
  if (m.minFrom != null && !parseVersion(m.minFrom)) throw refusal('The release says which versions it can update, in a way the desk cannot read.');
  if (!Number.isFinite(Date.parse(m.date))) throw refusal('The release has no date the desk can read.');
  const files = (Array.isArray(m.files) ? m.files : []).filter(f => f && /^[A-Za-z0-9._-]{1,100}\.zip$/.test(String(f.name)) && ['windows-zip', 'source-zip'].includes(f.kind) && Number.isSafeInteger(f.size) && f.size > 0 && /^[a-f0-9]{64}$/.test(String(f.sha256)));
  if (!files.length) throw refusal('The release lists no file the desk can use.');
  // the channel is inside the signed bytes, so a mirror cannot relabel a preview as stable; an older manifest has none: stable
  if (m.channel != null && !CHANNELS.includes(m.channel)) throw refusal('The release names a channel the desk does not know.');
  const notes = (Array.isArray(m.notes) ? m.notes : []).slice(0, NOTES_MAX.lines).map(n => String(n ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, NOTES_MAX.chars)).filter(Boolean);
  return { product: m.product, version: m.version, date: m.date, minFrom: m.minFrom || null, channel: m.channel || 'stable', notes, files };
}

// ---- this install
/** 'git' (a Git checkout: never changed), 'zip' (the unzipped app), 'source' (a source download), or 'unknown'. */
export function layoutOf(root) {
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  if (fs.existsSync(path.join(root, 'package.json'))) return 'source';
  if (fs.existsSync(path.join(root, 'setup', 'package.json'))) return 'zip';
  return 'unknown';
}
/** The installed version and, for a zip, its build date (app/version.json). */
export function installedOf(root) {
  const v = readJson(path.join(root, 'app', 'version.json'));
  const p = readJson(path.join(root, 'package.json'));
  return { version: v?.version || p?.version || '0.0.0', built: v?.built || null };
}

// ---- unpacking
/** Why a zip entry may not be unpacked, or null. Same rule as the Backup module's entryOk, plus links and odd names. */
export function entryProblem(e) {
  const n = String(e.entryName ?? '');
  const mode = ((e.header?.attr ?? 0) >>> 16) & 0o170000;
  if (mode === 0o120000) return `The download holds a link (${n.slice(0, 80)}), which an update may not carry.`;
  if (!n || n.includes('\0') || n.startsWith('/') || n.startsWith('\\') || /^[a-zA-Z]:/.test(n)) return `The download holds an absolute path (${n.slice(0, 80)}).`;
  if (n.replace(/\\/g, '/').split('/').some(p => p === '..')) return `The download tries to write outside the update folder (${n.slice(0, 80)}).`;
  return null;
}
/** Unpack into dest (made empty first). Every entry must land inside dest; caps on count and size. */
export function unpackZip(zipFile, dest) {
  let zip; try { zip = new AdmZip(zipFile); } catch { throw refusal('The download is not a zip.'); }
  const entries = zip.getEntries();
  if (entries.length > MAX_FILES) throw refusal('The download holds too many files.');
  let total = 0;
  for (const e of entries) { const p = entryProblem(e); if (p) throw refusal(p); total += Number(e.header?.size) || 0; }
  if (total > MAX_UNPACKED) throw refusal('The download unpacks to more than 3 GB.');
  fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
  const base = fs.realpathSync(dest);
  let written = 0;
  for (const e of entries) {
    const target = path.resolve(base, e.entryName.replace(/\\/g, '/'));
    if (!target.startsWith(base + path.sep)) throw refusal('The download tries to write outside the update folder.');
    if (e.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue; }
    const data = e.getData(); written += data.length;
    if (written > MAX_UNPACKED) throw refusal('The download unpacks to more than 3 GB.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
  }
}
/** The folder in the unpacked tree that is the desk: the tree itself, or its one top folder (apdesk/, apdesk-0.1.1/). */
export function findAppRoot(dir) {
  if (fs.existsSync(path.join(dir, 'app', 'server.js'))) return dir;
  const tops = fs.readdirSync(dir, { withFileTypes: true });
  if (tops.length === 1 && tops[0].isDirectory() && fs.existsSync(path.join(dir, tops[0].name, 'app', 'server.js'))) return path.join(dir, tops[0].name);
  return null;
}
/** One hash over every file of the named top-level entries: "path, size, sha256" lines, sorted. Also in apply-update.mjs. */
export function treeHash(root, names) {
  const lines = [];
  const add = (abs, rel) => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) throw refusal(`A link is in the update (${rel}).`);
    if (st.isDirectory()) { for (const n of fs.readdirSync(abs).sort()) add(path.join(abs, n), rel + '/' + n); return; }
    lines.push(`${rel}\0${st.size}\0${sha256(fs.readFileSync(abs))}`);
  };
  for (const n of [...names].sort()) add(path.join(root, n), n);
  lines.sort();
  return { hash: sha256(lines.join('\n')), files: lines.length };
}

/** "21 Nov 2026" in the owner's zone (a date without a time is shown as written). */
function dayOf(iso, settings) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(iso));
  const opt = { day: 'numeric', month: 'short', year: 'numeric', timeZone: dateOnly ? 'UTC' : (settings.get('timeZone') || undefined) };
  try { return new Date(iso).toLocaleDateString(settings.get('locale') || 'en-GB', opt); } catch { return new Date(iso).toLocaleDateString('en-GB', { ...opt, timeZone: 'UTC' }); }
}

export class Updater {
  /** core: the desk's core. Options are for tests and the probe: the install folder, the release address, the hosts it may reach, the keys. */
  constructor(core, { root = core.root, repo = REPO, hosts = GITHUB_HOSTS, keys = null } = {}) {
    this.core = core; this.root = root; this.repo = repo.replace(/\/$/, ''); this.hosts = [...hosts];
    this.keyList = keys || keysFromFile();
    this.dir = path.join(core.storage.dataDir, STAGE);
    this.last = null; this.busy = null; this.note = null; this.backup = null; this.timers = [];
    this.confirmStart();
    // the last check is kept (when, what it found); a "ready" for a version this desk now has is out of date
    const kept = core.settings.get('update.last');
    if (kept && typeof kept === 'object' && kept.at) {
      const v = kept.release?.version; let stale = false;
      try { stale = kept.result === 'ready' && compareVersions(v, installedOf(this.root).version) <= 0; } catch { stale = true; }
      this.last = stale ? { result: 'newest', at: kept.at, line: `You have the newest version (${installedOf(this.root).version}).` } : kept;
    }
  }
  get setUp() { return loadKeys(this.keyList).length > 0; }
  get channel() { return this.core.settings.get('update.channel') === 'preview' ? 'preview' : 'stable'; }
  /** On unless the owner switched it off. No key in the build, Offline or Panic: no check at all. */
  get daily() { return this.core.settings.get('update.daily') !== false; }
  get backgroundOn() { return this.core.settings.get('update.background') === true; }
  remember(last) { this.last = last; try { this.core.settings.set('update.last', last); } catch {} }
  emit() { try { this.core.events.emit('update', this.state()); } catch {} }

  /** The new desk started: the previous files go, and the card says so once. A failed apply is said once too. */
  confirmStart() {
    const f = path.join(this.dir, 'applied.json'); const a = readJson(f);
    this.justUpdated = null; this.failed = null;
    try {
      if (a && !a.confirmed && parseVersion(a.to) && compareVersions(installedOf(this.root).version, a.to) === 0) {
        fs.rmSync(path.join(this.dir, 'previous'), { recursive: true, force: true });
        a.confirmed = true; fs.writeFileSync(f, JSON.stringify(a, null, 1));
        this.core.approval.activity({ action: 'update.applied', title: `AP Desk was updated from ${a.from} to ${a.to}`, how: 'owner' });
      }
      if (a?.confirmed && !a.shown) this.justUpdated = { from: a.from, to: a.to, notes: a.notes || [], line: `AP Desk was updated to ${a.to}. You were on ${a.from}.` };
      const r = readJson(path.join(this.dir, 'result.json'));
      if (r?.line) this.failed = String(r.line);
    } catch {}
  }
  /** Take the once-only lines off (after the card has shown them). */
  shown() {
    if (this.justUpdated) { const f = path.join(this.dir, 'applied.json'); const a = readJson(f); if (a) { a.shown = true; try { fs.writeFileSync(f, JSON.stringify(a, null, 1)); } catch {} } this.justUpdated = null; }
    if (this.failed) { try { fs.rmSync(path.join(this.dir, 'result.json'), { force: true }); } catch {} this.failed = null; }
  }

  state() {
    const installed = installedOf(this.root); const layout = layoutOf(this.root); const setUp = this.setUp;
    const BUSY = { checking: 'Checking GitHub for a new version…', asking: 'Waiting for your approval. Look for the card at the top of the desk.', downloading: 'Downloading the new version…', unpacking: 'Checking the downloaded files…', 'backing up': 'Making a backup of your data first…', restarting: 'The update is ready. The desk is restarting to put it in place.' };
    let line;
    if (!setUp) line = 'Updates are not set up in this build.';
    else if (layout === 'git') line = 'This copy is a Git checkout. Update it with git pull.';
    else if (this.busy) line = BUSY[this.busy];
    else if (this.last) line = this.last.line;
    else line = 'Press Check for updates to see if there is a new version.';
    const ready = setUp && layout !== 'git' && this.last?.result === 'ready';
    return {
      setUp, layout, installed, daily: this.daily, channel: this.channel, background: this.backgroundOn, download: this.downloadState(), busy: this.busy, line,
      checkedAt: this.last?.at || null, release: ready || (this.last?.release && this.last.result !== 'newest') ? this.last.release : null,
      canInstall: ready && !this.busy && (layout === 'zip' || layout === 'source'), canCheck: setUp && layout !== 'git' && !this.busy,
      note: this.note, backup: this.backup, justUpdated: this.justUpdated, failed: this.failed,
    };
  }

  // ---- the guarded fetch: only GitHub (and its asset host), a plain GET with the desk's User-Agent, redirects checked hop by hop
  allowed(href) {
    let u; try { u = new URL(href); } catch { throw refusal('The update address cannot be read.'); }
    const secure = u.protocol === 'https:' || (u.protocol === 'http:' && LOOP.has(u.hostname));
    if (!secure || !this.hosts.includes(u.host.toLowerCase()) || u.username || u.password) throw refusal(`The download was sent on to ${u.hostname}, which is not GitHub. Nothing was downloaded from there.`);
    return u;
  }
  stopIfNeeded() {
    if (this.core.panic.halted) throw refusal('Everything is stopped. Press Resume first.');
    if (this.core.settings.get('online') === false) throw refusal('The desk is Offline. Go Online to check for updates.');
  }
  async get(href, cap, { toFile = null, what = 'file' } = {}) {
    let u = this.allowed(href);
    const signal = AbortSignal.any([this.core.panic.child(), AbortSignal.timeout(toFile ? 30 * 60000 : 20000)]);
    for (let hop = 0; hop < 6; hop++) {
      this.stopIfNeeded();
      let res;
      try { res = await fetch(u, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'application/octet-stream, application/json, */*' }, signal }); }
      catch (e) { if (this.core.panic.halted) throw refusal('Stopped by Panic. Nothing was changed.'); if (e.code === 'offline') throw refusal('The desk is Offline. Go Online to check for updates.'); throw refusal(`Could not reach GitHub (${e.cause?.code || e.name === 'TimeoutError' ? 'no answer in time' : e.message}).`); }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location'); try { await res.body?.cancel(); } catch {}
        if (!loc) throw refusal('GitHub answered with a redirect to nowhere.');
        u = this.allowed(new URL(loc, u).href); continue;
      }
      if (res.status === 404) { try { await res.body?.cancel(); } catch {} throw refusal(what === 'manifest' ? 'No release has been published on GitHub yet.' : 'GitHub does not have the file this release names.'); }
      if (res.status !== 200) { try { await res.body?.cancel(); } catch {} throw refusal(`GitHub answered ${res.status}. Try again later.`); }
      const big = () => refusal(what === 'manifest' ? 'The release file on GitHub is too large to be one.' : 'The download is larger than the release says. It was deleted and nothing was changed.');
      if (Number(res.headers.get('content-length') || 0) > cap) { try { await res.body?.cancel(); } catch {} throw big(); }
      const reader = res.body.getReader(); const chunks = []; let n = 0;
      const fd = toFile ? fs.openSync(toFile, 'w') : null;
      try {
        for (;;) {
          let r; try { r = await reader.read(); } catch (e) { throw this.core.panic.halted ? refusal('Stopped by Panic. Nothing was changed.') : refusal(`The download stopped (${e.message}).`); }
          if (r.done) break;
          n += r.value.length;
          if (n > cap) { try { await reader.cancel(); } catch {} throw big(); }
          if (fd != null) fs.writeSync(fd, r.value); else chunks.push(r.value);
        }
      } finally { if (fd != null) fs.closeSync(fd); }
      return toFile ? n : Buffer.concat(chunks);
    }
    throw refusal('GitHub sent the download on too many times.');
  }

  /** Look for a new version. Nothing about the user is sent. Returns the card's state. */
  async check() {
    if (this.busy) return this.state();
    this.busy = 'checking'; this.note = null; this.emit();
    try { this.remember(await this.look()); } finally { this.busy = null; }
    try { this.background(); } catch (e) { this.core.log?.('update', 'background download not started', e.message); }
    this.emit();
    return this.state();
  }
  async look() {
    const at = new Date().toISOString(); const inst = installedOf(this.root); const layout = layoutOf(this.root);
    const r = (result, line, extra = {}) => ({ result, line, at, ...extra });
    if (!this.setUp) return r('not-set-up', 'Updates are not set up in this build.');
    if (layout === 'git') return r('git', 'This copy is a Git checkout. Update it with git pull.');
    const quiet = (e) => /^(Everything is stopped|The desk is Offline|Stopped by Panic)/.test(e.message);
    const channel = this.channel;
    // Stable: GitHub's latest full release. Preview: that one and the newest few releases in the feed (pre-releases too).
    const bases = [`${this.repo}/releases/latest/download`];
    try { this.stopIfNeeded(); if (channel === 'preview') for (const t of await this.previewTags()) bases.push(`${this.repo}/releases/download/${t}`); }
    catch (e) { return r('error', quiet(e) ? e.message : `Could not check for updates: ${e.message}`); }
    const found = [];
    for (const base of bases) {
      let bytes, sig;
      try {
        bytes = await this.get(`${base}/apdesk-update.json`, MAX_MANIFEST, { what: 'manifest' });
        sig = (await this.get(`${base}/apdesk-update.json.sig`, 4096, { what: 'manifest' })).toString('utf8');
      } catch (e) {
        if (quiet(e)) return r('error', e.message);
        if (!found.length) found.push(r('error', `Could not check for updates: ${e.message}`));
        continue;
      }
      found.push(this.judge(bytes, sig, { inst, layout, channel, r }));
    }
    const ready = found.filter(x => x.result === 'ready').sort((a, b) => compareVersions(b.release.version, a.release.version));
    return ready[0] || found.find(x => x.result !== 'error') || found[0];
  }
  /** The tags of the newest releases in the project's release feed (github.com/<repo>/releases.atom). [] if it cannot be read. */
  async previewTags() {
    let text; try { text = (await this.get(`${this.repo}/releases.atom`, MAX_FEED, { what: 'feed' })).toString('utf8'); } catch (e) { if (/^(Everything is stopped|The desk is Offline|Stopped by Panic)/.test(e.message)) throw e; return []; }
    const tags = [];
    for (const m of text.matchAll(/\/releases\/tag\/(v\d{1,6}(?:\.\d{1,6}){0,3})["<]/g)) if (!tags.includes(m[1]) && tags.length < PREVIEW_TAGS) tags.push(m[1]);
    return tags;
  }
  /** One release file and its signature, judged for this desk. */
  judge(bytes, sig, { inst, layout, channel, r }) {
    const v = verifyManifest(bytes, sig, this.keyList);
    if (!v.ok) return r('refused', v.reason);
    let m; try { m = readManifest(bytes); } catch (e) { return r('refused', e.message); }
    const release = { version: m.version, date: m.date, published: dayOf(m.date, this.core.settings), channel: m.channel, notes: m.notes };
    const cmp = compareVersions(m.version, inst.version);
    if (cmp === 0) return r('newest', `You have the newest version (${inst.version}).`);
    if (cmp < 0) return r('older', `The release on GitHub (${m.version}) is older than this desk (${inst.version}), so there is nothing to install.`, { release });
    if (m.channel !== 'stable' && channel === 'stable') return r('preview', `Version ${m.version} is a preview. You get stable versions only, so it is not offered.`, { release });
    if (m.minFrom && compareVersions(inst.version, m.minFrom) < 0) return r('refused', `Version ${m.version} can only be installed over version ${m.minFrom} or newer, and you have ${inst.version}. Download it from GitHub and unzip it over this folder.`, { release });
    if (inst.built && Date.parse(m.date) < Date.parse(inst.built) - DAY) return r('refused', `The release on GitHub is dated before the version you have, so it was not offered.`, { release });
    const kind = layout === 'zip' ? 'windows-zip' : layout === 'source' ? 'source-zip' : null;
    if (!kind) return r('refused', 'The desk cannot tell how it was installed, so it cannot update itself. Download the new version from GitHub.', { release });
    const file = m.files.find(f => f.kind === kind);
    if (!file) return r('refused', `Version ${m.version} has no download for this kind of install.`, { release });
    const what = m.channel === 'preview' ? `Preview version ${m.version}` : `Version ${m.version}`;
    return r('ready', `${what} is ready, published ${release.published}.`, { release, file, manifestSha: sha256(bytes), from: inst.version });
  }

  // ---- "Download updates in the background" (off by default, owner-only). The owner's switch is his yes for these
  // downloads, so no card is shown for them; each one is written to the activity log. The file goes through the
  // downloads service (listed, pausable, paused by Panic and Offline, checked against the signed SHA-256), and is only
  // ever used by install(), which still asks the owner every time.
  bgFile(file) { return path.join(this.dir, 'download', file.name); }
  background() {
    const dl = this.core.downloads; const c = this.last;
    if (!dl || !this.backgroundOn || c?.result !== 'ready' || !c.file) return null;
    const id = `upd-${c.release.version}-${c.file.kind}`;
    const prev = this.core.settings.get('update.bg');
    if (prev?.id && prev.id !== id) this.dropBackground();               // an older one: a newer release replaces it
    const have = dl.get(id);
    // cancelled by the owner in the downloads list: not fetched again for this version (a newer one is)
    if (have && have.sha256 === c.file.sha256 && have.state !== 'failed') return have;
    if (have) dl.forget(id);
    const host = (h) => new URL('http://' + h).hostname;
    const to = path.resolve(this.bgFile(c.file));
    if (dl.all().some(x => x.to === to && x.id !== id && ['waiting', 'queued', 'running', 'paused'].includes(x.state))) return null;
    try { fs.rmSync(to, { force: true }); } catch {}
    // the downloads service checks the switch, records it in place of an approval and writes the activity line
    dl.start({ id, title: `AP Desk ${c.release.version} (update)`, url: `${this.repo}/releases/download/v${c.release.version}/${c.file.name}`, allowHosts: this.hosts.map(host), size: c.file.size, sha256: c.file.sha256, to, kind: 'desk-update' }, { standingYes: 'update.background' })
      .catch((e) => this.core.log?.('update', 'background download not started', e.message));
    const rec = dl.get(id); if (!rec) return null;                      // refused: start() checks before it stores
    this.core.settings.set('update.bg', { id, version: c.release.version, name: c.file.name, size: c.file.size, sha256: c.file.sha256 });
    dl.whenDone(id).then(() => this.emit(), () => {});
    return rec;
  }
  /** Cancel and forget the background download (the switch went off, or a newer release replaces it). */
  dropBackground() {
    const dl = this.core.downloads; const b = this.core.settings.get('update.bg');
    if (dl && b?.id) { try { const d = dl.get(b.id); if (d) { dl.cancel(b.id); dl.forget(b.id); if (d.to) fs.rmSync(d.to, { force: true }); } } catch {} }
    this.core.settings.set('update.bg', null); this.bgChecked = null;
  }
  /** The background download as the card shows it, or null. 'ready' only once the file on disk matches the signed hash. */
  downloadState() {
    const dl = this.core.downloads; const b = this.core.settings.get('update.bg');
    if (!dl || !b?.id) return null;
    const d = dl.get(b.id); if (!d) return null;
    if (d.state === 'done') {
      const f = this.readyFile(b);
      return f ? { state: 'ready', version: b.version, line: `Version ${b.version} is downloaded and checked. Installing it still asks you.` } : { state: 'failed', version: b.version, line: `The download of ${b.version} did not match the signed release. It was not kept.` };
    }
    const LINES = { waiting: 'is waiting to download', queued: 'is waiting to download', running: 'is downloading', paused: 'is paused', failed: 'could not be downloaded', cancelled: 'was cancelled' };
    return { state: d.state, version: b.version, line: `Version ${b.version} ${LINES[d.state] || d.state}${d.reason ? `: ${d.reason}` : '.'}` };
  }
  /** The background file, if it is there and matches its signed size and SHA-256 (hashed once per file). */
  readyFile(b) {
    const dl = this.core.downloads; const d = dl?.get(b?.id);
    if (!d || d.state !== 'done' || d.sha256 !== b.sha256) return null;
    let st; try { st = fs.statSync(d.to); } catch { return null; }
    const key = `${d.to}|${st.size}|${st.mtimeMs}`;
    if (this.bgChecked?.key !== key) this.bgChecked = { key, ok: st.size === b.size && sha256(fs.readFileSync(d.to)) === b.sha256 };
    if (!this.bgChecked.ok) { try { fs.rmSync(d.to, { force: true }); } catch {} return null; }
    return d.to;
  }

  /**
   * Install the newest release: only from the owner's own window (settings-routes.js holds the token), only after the
   * owner approves the card, and only what verifies. Resolves { ok, line } once the files are staged or refused.
   */
  async install(token) {
    if (token !== SETTINGS_TOKEN) throw Object.assign(new Error('Updates are installed only from Settings on this desk.'), { code: 'forbidden', status: 403 });
    if (this.busy) return { ok: false, line: 'An update step is already running. Wait a moment.' };
    const refuse = (line) => { this.note = line; this.core.approval.activity({ action: 'update.refused', title: 'Update not installed', how: 'owner', detail: line }); return { ok: false, line }; };
    this.note = null; this.backup = null; this.busy = 'checking'; this.emit();
    const next = path.join(this.dir, 'next');
    let zipFile = null, staged = false;
    try {
      this.stopIfNeeded();
      const c = await this.look(); this.remember(c);
      if (c.result !== 'ready') return refuse(c.line);
      const { release, file } = c;
      const payload = { kind: 'desk-update', from: c.from, version: release.version, file: file.name, size: file.size, sha256: file.sha256, manifest: c.manifestSha };
      this.busy = 'asking'; this.emit();
      const d = await this.core.approval.request({ action: 'install', title: `Update AP Desk from ${c.from} to ${release.version}`, from: 'github.com/agentpopulation/apdesk', detail: 'A signed release from GitHub. A backup of your data is made first; then the desk restarts.', payload, signal: this.core.panic.child() });
      if (!d.ok) return refuse(d.reason === 'denied' ? 'You said no, so nothing was changed.' : d.reason === 'halted' ? 'Stopped by Panic. Nothing was changed.' : 'The update was not approved, so nothing was changed.');
      if (d.how !== 'owner') return refuse('An update needs your own approval. Nothing was changed.');
      this.core.approval.assertGranted(d.id, 'install', payload);

      this.busy = 'downloading'; this.emit();
      fs.mkdirSync(this.dir, { recursive: true });
      for (const n of fs.readdirSync(this.dir)) if (/\.(zip|part)$/.test(n)) fs.rmSync(path.join(this.dir, n), { force: true });
      fs.rmSync(next, { recursive: true, force: true }); fs.rmSync(path.join(this.dir, 'ready.json'), { force: true });
      zipFile = path.join(this.dir, file.name);
      // a file downloaded in the background is used only when it is this exact signed file; it is checked again below
      const bg = this.core.settings.get('update.bg'); const pre = bg && bg.name === file.name && bg.sha256 === file.sha256 && bg.size === file.size ? this.readyFile(bg) : null;
      if (pre) { fs.renameSync(pre, zipFile + '.part'); try { this.core.downloads.forget(bg.id); } catch {} this.core.settings.set('update.bg', null); this.bgChecked = null; }
      const got = pre ? fs.statSync(zipFile + '.part').size : await this.get(`${this.repo}/releases/download/v${release.version}/${file.name}`, file.size, { toFile: zipFile + '.part' });
      if (got !== file.size) throw refusal('The download is smaller than the release says. It was deleted and nothing was changed.');
      if (sha256(fs.readFileSync(zipFile + '.part')) !== file.sha256) throw refusal('The download does not match the signed release. It was deleted and nothing was changed.');
      fs.renameSync(zipFile + '.part', zipFile);

      this.stopIfNeeded(); this.busy = 'unpacking'; this.emit();
      unpackZip(zipFile, next);
      const appRoot = findAppRoot(next);
      if (!appRoot) throw refusal('The download does not look like AP Desk. Nothing was changed.');
      const got2 = installedOf(appRoot).version;
      if (got2 !== release.version) throw refusal(`The download holds version ${got2}, not ${release.version}. Nothing was changed.`);
      const replace = fs.readdirSync(appRoot).filter(n => !NEVER.has(n)).sort();
      const tree = treeHash(appRoot, replace);

      this.stopIfNeeded(); this.busy = 'backing up'; this.emit();
      let b = null; try { b = await this.core.modules?.api('backup')?.backupNow({ includeKeys: false }); } catch (e) { b = null; }
      if (!b?.name) throw refusal('A backup of your data could not be made first, so nothing was changed.');
      this.backup = b.name;

      this.stopIfNeeded();
      fs.writeFileSync(path.join(this.dir, 'ready.json'), JSON.stringify({ version: release.version, from: c.from, staged: path.relative(this.dir, appRoot).split(path.sep).join('/'), replace, tree: tree.hash, files: tree.files, manifest: c.manifestSha, notes: release.notes, backup: b.name, at: new Date().toISOString() }, null, 1));
      fs.rmSync(zipFile, { force: true });
      staged = true;
      this.core.approval.activity({ action: 'update.ready', title: `Update to ${release.version} downloaded and checked`, how: 'owner', detail: `Backup first: ${b.name}` });
      this.busy = 'restarting'; this.emit();
      this.core.restart?.('update');
      return { ok: true, line: `Version ${release.version} is ready. The desk is restarting.`, version: release.version, backup: b.name };
    } catch (e) {
      if (e.code === 'not_granted') return refuse('The approval did not match this update. Nothing was changed.');
      return refuse(e.code === 'refused' ? e.message : `The update stopped: ${e.message}. Nothing was changed.`);
    } finally {
      if (!staged) {
        try { if (zipFile) { fs.rmSync(zipFile, { force: true }); fs.rmSync(zipFile + '.part', { force: true }); } fs.rmSync(next, { recursive: true, force: true }); } catch {}
        this.busy = null;
      }
      this.emit();
    }
  }

  /** "Check once a day": on unless the owner switched it off; one quiet check a day while the desk runs, never while
   *  Offline or halted, never without a key in the build. */
  async tick() {
    const p = this.core.panic;
    if (p.halted) { if (p.reason === 'Shutting down') this.stopDaily(); return; }
    const s = this.core.settings;
    if (!this.daily || s.get('online') === false || !this.setUp || layoutOf(this.root) === 'git' || this.busy) return;
    const lastAt = Date.parse(s.get('update.lastDailyCheck') || '');
    if (Number.isFinite(lastAt) && Date.now() - lastAt < DAY - 30 * 60000) return;
    s.set('update.lastDailyCheck', new Date().toISOString());
    await this.check();
  }
  startDaily() {
    const run = () => { this.tick().catch(() => {}); };
    const a = setTimeout(run, 2 * 60000); const b = setInterval(run, 3600000);
    a.unref?.(); b.unref?.(); this.timers.push(a, b);
    return this;
  }
  stopDaily() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
}
