// The Doctor's checks as plain functions: each takes what it needs and returns one row
// { id, name, state: 'fine'|'problem'|'skipped', line, details?: [text], todo?, place?: { page, section? } }.
// Nothing here changes a setting, a key or a file.

const PURPOSE = { chat: 'chat', research: 'research', plan: 'plans', draft: 'drafts', council: 'the council', code: 'code', vision: 'pictures', embed: 'memory search', small: 'quick checks' };
export const purposeWord = (p) => PURPOSE[p] || String(p || 'chat').replace(/[_-]+/g, ' ');
const GB = 1024 ** 3;
export const LOW_DISK = 2 * GB;
export const USUAL_PORT = 3445;

export function bytesText(n) { n = Number(n) || 0; const u = ['bytes', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : String(Math.round(n))) + ' ' + u[i]; }
export function secondsText(ms) {
  if (ms == null) return null;
  if (ms < 1000) return 'under a second';
  const s = Math.round(ms / 1000); return s === 1 ? '1 second' : `${s} seconds`;
}
const row = (id, name, state, line, extra = {}) => ({ id, name, state, line, ...extra });
const stopped = (halted, online, what) => halted ? `Not checked: everything is stopped. Press Resume first, then check again.` : !online ? `Not checked: the desk is Offline, so ${what}.` : null;

/** The door's last call with a provider, read apart: a refused key (401, 403), a busy provider (429), no connection
 *  (a timeout or a network error) or anything else (the provider's own short message). last: { ok, at, error } or none. */
export function lastResult(last, when) {
  if (!last) return { kind: 'none', text: 'Not used yet.' };
  const w = when(last.at);
  if (last.ok) return { kind: 'ok', text: `The last call worked (${w}).` };
  const msg = String(last.error || '').trim().replace(/[.!?\s]+$/, '');
  const status = Number((msg.match(/^HTTP (\d{3})\b/) || [])[1]);
  if (status === 401 || status === 403) return { kind: 'refused', text: `The provider refused the key (${w}).` };
  if (status === 429) return { kind: 'busy', text: `Busy right now (${w}): the provider is limiting requests; nothing to change, try again later.` };
  if (!status && /no answer within|timed? ?out|timeout|fetch failed|network|socket|ECONN|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return { kind: 'unreached', text: `The last call did not reach the provider (${w}); see The internet line.` };
  return { kind: 'other', text: `The last call did not work (${w})${msg ? ': ' + msg : ''}.` };
}

/** One tiny call through the door to the free or local route. chat(provider) returns the door's answer or throws.
 *  free: { name, on } for the built-in Free API, listed with its own last result read after the call. */
export async function modelCheck({ halted, online, routes, chat, free, lastCalls = () => ({}), when = (x) => x }) {
  const why = stopped(halted, online, 'no model is called');
  if (why) return row('model', 'A model answers', 'skipped', why);
  const freeLine = () => free ? [`${free.name}: ${free.on ? lastResult(lastCalls().router, when).text : 'switched off.'}`] : [];
  const tried = [];
  for (const provider of routes) {
    try { const r = await chat(provider); return row('model', 'A model answers', 'fine', `${r.label} answered in ${secondsText(r.ms)}.`, { details: ['This was one real call; it shows in your model calls.', ...freeLine()] }); }
    catch (e) { if (e?.code === 'halted' || e?.code === 'aborted') return row('model', 'A model answers', 'skipped', 'Not checked: it was stopped.'); tried.push(e?.message ? String(e.message).split('. ')[0] : 'no answer'); }
  }
  return row('model', 'A model answers', 'problem', routes.length ? 'No free or local model answered.' : 'No free or local model is switched on.', { details: [...freeLine(), ...tried.slice(0, 3)], todo: 'Open Models and press Test beside the Free API, or get a local model.', place: { page: 'models' } });
}

/** Which providers have a key and whether the door's last call with it worked. Never a key, not even masked. */
export function keysCheck({ keys, lastCalls, names, when }) {
  const have = Object.entries(keys || {}).map(([pid, list]) => ({ pid, on: (list || []).filter(k => k.enabled).length, all: (list || []).length })).filter(x => x.all);
  if (!have.length) return row('keys', 'Keys', 'fine', 'No model keys are added. The Free API works without one.', { todo: 'A free key in Models gives faster, steadier answers.', place: { page: 'models' } });
  const details = []; let bad = 0, refused = 0;
  for (const h of have) {
    const name = names[h.pid] || h.pid;
    const count = `${h.on} of ${h.all} ${h.all === 1 ? 'key' : 'keys'} on`;
    if (!h.on) { details.push(`${name}: ${count}.`); continue; }
    const r = lastResult(lastCalls[h.pid], when);
    if (r.kind === 'refused') refused++;
    if (r.kind === 'refused' || r.kind === 'other') bad++;
    details.push(`${name}: ${count}. ${r.text}`);
  }
  return bad
    ? row('keys', 'Keys', 'problem', `${bad} ${bad === 1 ? 'provider' : 'providers'} failed on the last call.`, { details, todo: refused ? 'Open Models, press Test beside that key, and replace or re-enter the key.' : 'Open Models and press Test beside that key.', place: { page: 'models' } })
    : row('keys', 'Keys', 'fine', `${have.length} ${have.length === 1 ? 'provider has' : 'providers have'} a key.`, { details });
}

/** probe() -> { ok, ms, status? } through the desk's door. */
export async function internetCheck({ halted, online, probe, networkOn }) {
  const place = networkOn ? { page: 'settings', section: 'network' } : { page: 'settings', section: 'modules' };
  const why = stopped(halted, online, 'nothing goes out');
  if (why) return row('internet', 'The internet', 'skipped', why, online ? {} : { todo: 'Go Online from the chip under the message box when you want the internet.', place });
  try {
    const r = await probe();
    if (r.ok) return row('internet', 'The internet', 'fine', `Reachable in ${secondsText(r.ms)}.`);
    return row('internet', 'The internet', 'problem', `The check page answered ${r.status || 'with an error'}.`, { todo: 'Check your Wi-Fi or cable, then check again.', place });
  } catch (e) { return row('internet', 'The internet', 'problem', 'Not reachable.', { details: [String(e?.message || e).slice(0, 120)], todo: 'Check your Wi-Fi or cable, or a firewall that blocks the desk, then check again.', place }); }
}

export function diskCheck({ free, total, dbBytes, workspaceBytes, workspaceMore }) {
  const details = [`The database: ${bytesText(dbBytes)}.`, `The workspace: ${workspaceMore ? 'more than ' : ''}${bytesText(workspaceBytes)}.`];
  if (free == null) return row('disk', 'Disk space', 'skipped', 'Not checked: this computer did not say how much space is free.', { details });
  details.unshift(`${bytesText(free)} free of ${bytesText(total)} on the drive with your data.`);
  if (free < LOW_DISK) return row('disk', 'Disk space', 'problem', `Only ${bytesText(free)} free where your data lives.`, { details, todo: 'Free some space on this drive, or move old files out of the workspace in Files.', place: { page: 'files' } });
  return row('disk', 'Disk space', 'fine', `${bytesText(free)} free.`, { details });
}

/** From what the door knows (Active now and its last calls); models: the Models module's own view, when it offers one. */
export function localCheck({ active, lastCalls, when }) {
  const ol = (active || []).find(a => a.provider === 'ollama'); const ll = (active || []).find(a => a.provider === 'llama');
  const details = [];
  const lastLine = (p) => { const l = lastCalls[p]; return !l ? 'No answer yet.' : l.ok ? `Last answer ${when(l.at)}.` : `The last call did not work (${when(l.at)}).`; };
  if (ll) details.push(`Local model on this PC: installed, model ${ll.name || ll.model}${ll.ok ? '' : ', switched off'}. ${lastLine('llama')}`);
  else details.push('Local model on this PC: not installed.');
  if (ol?.ok) details.push(`Ollama: running, ${(ol.models || []).length} ${(ol.models || []).length === 1 ? 'model' : 'models'}. ${lastLine('ollama')}`);
  else details.push('Ollama: not running.');
  const any = !!(ll || (ol?.ok && (ol.models || []).length));
  if (!any) return row('local', 'Local model', 'fine', 'No local model is set up. It is optional; it lets the desk answer while Offline.', { details, todo: 'Get a local model in Models if you want answers while Offline.', place: { page: 'models' } });
  const failed = (ll && lastCalls.llama && !lastCalls.llama.ok) || (ol?.ok && lastCalls.ollama && !lastCalls.ollama.ok);
  if (failed) return row('local', 'Local model', 'problem', 'The local model did not answer on its last call.', { details, todo: 'Open Models and press Test beside the local model.', place: { page: 'models' } });
  if (ll && !ll.ok) return row('local', 'Local model', 'problem', 'The local model is installed but switched off.', { details, todo: 'Switch it on in Models.', place: { page: 'models' } });
  return row('local', 'Local model', 'fine', 'A local model is ready.', { details });
}

export function updatesCheck({ setUp, layout, version, last, daily, channel, when }) {
  const place = { page: 'settings', section: 'backup' };
  const details = [`Version ${version}.`, `Channel: ${channel === 'preview' ? 'Preview' : 'Stable'}.`, `Daily check: ${daily ? 'on' : 'off'}.`, last?.at ? `Last check ${when(last.at)}.` : 'Never checked.'];
  if (!setUp) return row('updates', 'Updates', 'fine', 'Updates are not set up in this build.', { details });
  if (layout === 'git') return row('updates', 'Updates', 'fine', 'This copy is a Git checkout. Update it with git pull.', { details });
  if (last?.result === 'error') return row('updates', 'Updates', 'problem', 'The last update check did not work.', { details: [...details, last.line].filter(Boolean), todo: 'Press Check for updates in Settings, Backup.', place });
  if (last?.result === 'ready') return row('updates', 'Updates', 'problem', 'A new version is ready to install.', { details, todo: 'Install it from Settings, Backup.', place });
  return row('updates', 'Updates', 'fine', last?.at ? 'Set up and checked.' : 'Set up, not checked yet.', { details, ...(last?.at ? {} : { todo: 'Press Check for updates in Settings, Backup.', place }) });
}

/** A proxy set on this PC (HTTPS_PROXY or HTTP_PROXY): where it points (host and port only, never a name or password) and
 *  whether the desk's web calls use it. null when none is set. failing: the internet check did not pass. */
export function proxyCheck({ env = process.env, failing = false } = {}) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) return null;
  let where; try { where = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'http://' + raw).host; } catch { where = null; }
  if (!where) return row('proxy', 'A proxy', failing ? 'problem' : 'fine', 'A proxy is set on this PC, but its address could not be read.', { todo: failing ? 'Check the proxy setting of this PC, then check again.' : undefined });
  const used = env.NODE_USE_ENV_PROXY === '1';
  const line = used
    ? `A proxy is set on this PC: the desk's web calls go through ${where}. The desk itself, Ollama and the local engine never go through it.`
    : 'A proxy is set on this PC, but the desk was not started with it, so its web calls go straight out. Start the desk with start.bat (start.sh on Linux, start.command on a Mac) to use it.';
  return row('proxy', 'A proxy', failing ? 'problem' : 'fine', line, failing ? { todo: used ? 'Check that the proxy is reachable, then check again.' : 'If calls fail only here, start the desk with start.bat (start.sh on Linux, start.command on a Mac).' } : {});
}

export function portCheck({ port, usual = USUAL_PORT, usualTaken }) {
  if (Number(port) === Number(usual)) return row('port', 'Port', 'fine', `The desk uses port ${port}, the usual one.`);
  if (usualTaken) return row('port', 'Port', 'problem', `Another program is using port ${usual}. The desk uses port ${port}.`, { todo: `Close the other program if you want port ${usual} back; the desk works on port ${port} meanwhile.`, place: { page: 'settings', section: 'general' } });
  return row('port', 'Port', 'fine', `The desk uses port ${port}. Port ${usual} is free.`);
}

export function switchesCheck({ online, halted, benchOn, benchEnabled, networkOn }) {
  const details = [
    `Online: ${online ? 'on' : 'off (Offline: only local models are used)'}.`,
    `Bench: ${!benchOn ? 'module off' : benchEnabled ? 'Bench mode on' : 'module on, Bench mode off'}.`,
    `Network: ${networkOn ? 'module on' : 'module off'}.`,
  ];
  if (halted) details.unshift('Panic: everything is stopped.');
  return row('switches', 'Your switches', 'fine', 'As you set them.', { details, place: { page: 'settings', section: 'modules' } });
}

/** The learned table in plain words: "For research, Free API · x answered 19 of 20 times, usually in 4 seconds." */
export function learnedLines(view) {
  return (view?.rows || []).map(r => ({
    purpose: r.purpose, enough: !!r.enough, free: !!r.free,
    line: `For ${purposeWord(r.purpose)}, ${r.label} answered ${r.ok} of ${r.calls} ${r.calls === 1 ? 'time' : 'times'}${r.ok && r.medianMs != null ? `, usually in ${secondsText(r.medianMs)}` : ''}.`,
  }));
}
