// Playbooks (module 39): one-click jobs for a small business. A playbook is text only (title, what you get, steps,
// inputs, what waits for the owner, a suggested rhythm); nothing in it runs as code. A run is a job: the agent whose job
// fits the work gets the playbook as one turn through Chat's own door (chat.ask), with its own tools and approvals.
// The result, who did it, which model answered, the cost and what waits for the owner are kept in the history.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Cron } from 'croner';
import { BUILTINS, KINDS, USES } from './builtins.js';
import * as B from './book.js';

const DAY = 24 * 3600_000;
const TICK_MS = 30_000;
const FACT_MAX = 20_000;
const nowIso = () => new Date().toISOString();
const bad = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
const j = (x, f) => { try { return x ? JSON.parse(x) : f; } catch { return f; } };
const kindLabel = (id) => KINDS.find(k => k.id === id)?.label || 'Other';
const DEFAULTS = { scheduled: true, chatTool: true, keep: 25 };

export async function activate(ctx) {
  ctx.db.migrate(1, `
    CREATE TABLE IF NOT EXISTS m_playbooks_own (id TEXT PRIMARY KEY, body TEXT NOT NULL, origin TEXT NOT NULL, from_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS m_playbooks_prefs (id TEXT PRIMARY KEY, inputs TEXT, agent_id TEXT, updated TEXT);
    CREATE TABLE IF NOT EXISTS m_playbooks_schedules (id TEXT PRIMARY KEY, cron TEXT NOT NULL, label TEXT, enabled INTEGER NOT NULL DEFAULT 1, next_at TEXT, waiting TEXT, last_at TEXT, last_note TEXT, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS m_playbooks_runs (id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, title TEXT, agent_id TEXT, agent_name TEXT, trigger TEXT, started TEXT NOT NULL, finished TEXT,
      status TEXT NOT NULL, label TEXT, cost_minor INTEGER, cost_known INTEGER NOT NULL DEFAULT 0, currency TEXT, result TEXT, note TEXT, waiting TEXT, job_id TEXT, chat_id TEXT);
    CREATE INDEX IF NOT EXISTS m_playbooks_runs_by ON m_playbooks_runs (playbook_id, started);`);

  const S = (k) => ctx.settings.get(k);
  const zone = () => { const z = S('timeZone'); try { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } catch { return Intl.DateTimeFormat().resolvedOptions().timeZone; } };
  const offline = () => S('online') === false;
  const prefs = () => ({ ...DEFAULTS, ...(ctx.kv.get('settings', {}) || {}) });
  const modName = (id) => { const m = ctx.modules.list().find(x => x.id === id); return m?.menu?.[0]?.label || m?.name || (String(id).charAt(0).toUpperCase() + String(id).slice(1)); };
  const moduleIds = () => ctx.modules.list().map(m => m.id);
  const clock = () => B.clockIn(S('locale'));    // times of day as the page writes them, so a schedule's words match "Next:"
  const when = (iso) => { if (!iso) return ''; try { return new Intl.DateTimeFormat(S('locale') || undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: zone() }).format(new Date(iso)); } catch { return new Date(iso).toDateString(); } };

  // Runs left "running" by a desk that stopped under them are never resumed; they are marked as such.
  for (const r of ctx.db.all("SELECT id, job_id FROM m_playbooks_runs WHERE status = 'running'")) {
    const jb = r.job_id ? ctx.jobs.get(r.job_id) : null;
    if (!jb || !['running', 'waiting'].includes(jb.status)) ctx.db.run("UPDATE m_playbooks_runs SET status = 'interrupted', finished = ?, note = ? WHERE id = ?", nowIso(), 'The desk stopped while this was running. Run it again.', r.id);
  }

  // ---------- the books: built in, and the owner's own
  const builtIn = (id) => BUILTINS.find(b => b.id === id) || null;
  const ownRow = (id) => ctx.db.get('SELECT * FROM m_playbooks_own WHERE id = ?', id);
  function book(id) {
    const b = builtIn(id); if (b) return { ...b, rhythm: rhythmOf(b.rhythm), id, own: false, origin: 'built-in' };
    const r = ownRow(id); if (!r) return null;
    const body = j(r.body, {});
    return { ...body, rhythm: rhythmOf(body.rhythm), id: r.id, own: true, origin: r.origin, fromId: r.from_id || null, created: r.created };
  }
  // the words for a schedule are always written from its fields, also for a playbook saved before this rule
  const rhythmOf = (x) => { const d = x ? B.describeCron(x.cron, { time: clock() }) : null; return d?.ok ? { cron: d.cron, label: d.label } : null; };

  // ---------- trust. A playbook from a file, or one written or changed by hand, is not trusted until the owner has run
  // it once and ticked "I trust this playbook". Trust is for the text he ran: any change to it ends the trust.
  const textOf = (b) => JSON.stringify([b.title, b.outcome, b.kind, b.steps, b.inputs, b.approvals, b.needs, b.uses]);
  const hashOf = (b) => crypto.createHash('sha256').update(textOf(b)).digest('hex').slice(0, 32);
  const trustMap = () => ctx.kv.get('trust', {}) || {};
  const ranMap = () => ctx.kv.get('ran', {}) || {};
  const trusted = (b) => !b.own || trustMap()[b.id] === hashOf(b);
  const ranOnce = (b) => ranMap()[b.id] === hashOf(b);
  function setTrust(id, on) {
    const b = book(id); if (!b) throw bad('No such playbook.', 404);
    if (!b.own) throw bad('Built-in playbooks are trusted already.');
    const m = trustMap();
    if (on) { if (!ranOnce(b)) throw bad('Run it once first and read what it did. Then you can trust it.', 409); m[b.id] = hashOf(b); }
    else delete m[b.id];
    ctx.kv.set('trust', m);
    ctx.activity(on ? `Trusted the playbook "${b.title}"` : `Stopped trusting the playbook "${b.title}"`);
    return view(book(id), { full: true });
  }
  const originWords = (b) => (b.origin === 'file' ? 'This playbook came from a file.' : b.origin === 'copy' ? 'You changed this playbook by hand.' : 'You wrote this playbook by hand.');

  // ---------- what a run can do. With Chat's tool limits (chat.askTakes has 'tools'), every run is offered only the tools
  // for its kind of work (B.toolsFor); without them, a playbook from a file does not run at all, and the others run with
  // every tool the agent has. The words for the run box say which, and what the present level asks for
  // (app/core/contracts/APPROVAL-DOOR.md); they claim nothing the code does not do.
  const limitsOn = () => { const c = ctx.modules.api('chat'); return Array.isArray(c?.askTakes) && c.askTakes.includes(B.ASK_TAKES_TOOLS); };
  const fromFile = (b) => b.own && b.origin === 'file';
  const NO_LIMITS = 'A playbook from a file needs a desk with tool limits for playbooks. This desk does not have them yet, so it cannot run here.';
  function levelNow() {
    let st = {}; try { st = ctx.approval.state() || {}; } catch {}
    const level = ['open', 'careful', 'strict'].includes(st.level) ? st.level : (ctx.settings.get('security.level') || 'open');
    return { level, name: { open: 'Open', careful: 'Careful', strict: 'Strict' }[level] || 'Open', auto: st.autoApproveUntil || null };
  }
  // the list for its kind of work, less any tool no module offers now (a module that is off)
  const runTools = (b) => { const have = new Set(ctx.modules.tools().map(t => t.name)); return B.toolsFor(b.kind, { fromFile: fromFile(b) }).filter(n => have.has(n)); };
  // a playbook from a file of a research kind: the web only. The desk hands it none of the owner's records or files.
  const webOnly = (b) => fromFile(b) && B.WEB_KINDS.includes(b.kind);
  // the records the desk hands to a run (B.handedRecords): a playbook from a file only those its kind of work gets
  const handed = (b) => (webOnly(b) ? [] : B.handedRecords(b, { fromFile: fromFile(b) }));
  const recordsLine = (b) => B.recordsLine(b, { fromFile: fromFile(b), webOnly: webOnly(b) });
  // Chat says it draws the replies of a chat as plain text when it was made with { plain: true } (supports 'chat.plain')
  const plainChatOn = () => { const c = ctx.modules.api('chat'); return Array.isArray(c?.supports) && c.supports.includes(B.CHAT_PLAIN); };
  // how History draws a run's result (ui-result.js): plain text for a playbook from a file, links with their address else
  function resultWords(b) {
    if (B.resultShown(b.origin) === 'links') return ' In its result, every link shows its full address, and one that carries a query or is long asks "Open this address?" before it opens.';
    return ` Its result is shown in History as plain text: an address in it is written out in full, and the desk never opens it or makes it a link. You can save it as a text file.${plainChatOn() ? '' : ' The run is also kept in a chat of its own, where Chat draws links and pictures, and a picture loads its address as soon as that chat is opened: read the result in History.'}`;
  }
  const noOwnerOn = () => { const c = ctx.modules.api('chat'); return Array.isArray(c?.askTakes) && c.askTakes.includes(B.ASK_TAKES_NO_OWNER); };
  // which side a run is on, from the tools it is given and the records the desk hands it
  const sideOfRun = (b, tools) => B.sideOf(tools, { records: !webOnly(b) && (handed(b).length > 0 || b.inputs.some(x => x.type === 'file')) });
  function sideWords(b, side) {
    if (side === 'web') return `This playbook looks things up on the web and cannot read your records.${noOwnerOn() ? '' : " Your agent's own notes still go with it: what it remembers about you, its lessons and skills, and what you wrote about your business."} What you type into its inputs goes to it, and a web address it opens can carry that.`;
    if (side === 'own') return 'This playbook reads your records and cannot reach the web.';
    if (side === 'both') return 'This playbook can read your records and look things up on the web in the same run, so a web address it opens can carry what it read.';
    return 'In this run the agent has no tools: it answers from what it is given.';
  }
  // The approval door asks for every action of a job started with strictApprovals. A run that is not trusted yet is started so, when the door says it honours it.
  const strictOn = () => ctx.approval?.strictJobs === true && Array.isArray(ctx.jobs?.takes) && ctx.jobs.takes.includes('strictApprovals');
  const strictRun = (b) => strictOn() && !trusted(b);
  function scopeOf(b) {
    const now = levelNow(); const strict = strictRun(b);
    const level = strict ? 'strict' : now.level, name = strict ? 'Strict' : now.name, auto = strict ? null : now.auto;
    const strictLine = strict ? ' This playbook is not trusted yet, so in this run everything with a side effect asks you first, whatever your level, until you have run it once and ticked "I trust this playbook".' : '';
    const autoLine = auto ? ` An auto-approve window is open until ${when(auto)}: until then, what the level would ask is allowed without asking, except sending to people, installs and spending over your limits.` : '';
    if (limitsOn()) {
      const tools = runTools(b); const side = sideOfRun(b, tools);
      const writes = tools.some(t => t === 'doc_file' || t === 'table_file');
      const fileLine = !writes ? '' : { open: ' At the Open level, saving a new file does not ask you.', careful: ' At the Careful level, saving a new file asks you once in the run.', strict: ' At the Strict level, saving a new file asks you each time.' }[level];
      const toolLine = tools.length ? ` In this run the agent has only these tools: ${tools.map(t => B.TOOL_WORDS[t] || t).join('; ')}.` : '';
      const cannot = B.cannotWords(tools);
      return { limited: true, level, name, side, sideLine: sideWords(b, side), tools: tools.map(t => B.TOOL_WORDS[t] || t),
        words: `${sideWords(b, side)}${toolLine}${cannot ? ' ' + cannot : ''}${tools.some(t => /_draft$/.test(t)) ? ' A draft waits for you: sending or posting it always asks you.' : ''}${fileLine}${strictLine} ${recordsLine(b)}${resultWords(b)}${autoLine}` };
    }
    if (fromFile(b)) return null;   // it does not run here at all: the run box shows NO_LIMITS as its block
    const lets = {
      open: ['write and change files in your workspace', 'delete files (they go to the Bin)', 'open any website', 'click, type and send forms on websites', 'post to web services that are not a person', ...(ctx.modules.isOn('payments') ? ['spend money within your spend limits'] : [])],
      careful: ['write files in your workspace after one yes in each run', 'click and type on websites after one yes in each run', 'open websites it has opened before'],
      strict: [],
    }[level] || [];
    return { limited: false, level, name, tools: null,
      words: `This run is not limited to a set of tools: the agent may use every tool it has. ${lets.length ? `At the ${name} level it can do these without asking you: ${lets.join('; ')}.` : `At the Strict level, sending, paying, deleting, writing files and acting on websites ask you first.`} Sending to a person and installs always ask. Making a schedule that repeats and saving a standing lesson always ask you, at every level. Tools that have no approval step never ask, such as making a one-time reminder or task, saving a fact, and adding or moving leads in Sales.${strictLine} ${recordsLine(b)}${resultWords(b)}${autoLine}` };
  }
  const allBooks = () => [...BUILTINS.map(b => book(b.id)), ...ctx.db.all('SELECT id FROM m_playbooks_own ORDER BY created').map(r => book(r.id))].filter(Boolean);
  // the playbooks the chat agent is told of: built in, and those the owner trusts
  const listed = () => allBooks().filter(trusted);
  function findBook(q, all = allBooks()) {
    const s = String(q || '').trim().toLowerCase(); if (!s) return null;
    return all.find(b => b.id === q) || all.find(b => b.title.toLowerCase() === s) || all.find(b => b.title.toLowerCase().includes(s)) || null;
  }
  function saveOwn(body, { origin, fromId = null, id = null }) {
    const clean = B.cleanBook(body, { modules: moduleIds() }); const t = nowIso();
    if (id) { ctx.db.run('UPDATE m_playbooks_own SET body = ?, updated = ? WHERE id = ?', JSON.stringify(clean), t, id); return book(id); }
    id = 'own_' + crypto.randomBytes(5).toString('hex');
    ctx.db.run('INSERT INTO m_playbooks_own (id, body, origin, from_id, created, updated) VALUES (?, ?, ?, ?, ?, ?)', id, JSON.stringify(clean), origin, fromId, t, t);
    return book(id);
  }

  // ---------- what the owner chose last time
  const pref = (id) => { const r = ctx.db.get('SELECT * FROM m_playbooks_prefs WHERE id = ?', id); return { inputs: j(r?.inputs, {}), agentId: r?.agent_id || null }; };
  function savePref(id, { inputs, agentId }) {
    const cur = pref(id);
    const next = { inputs: inputs ? { ...cur.inputs, ...inputs } : cur.inputs, agentId: agentId === undefined ? cur.agentId : agentId };
    ctx.db.run('INSERT INTO m_playbooks_prefs (id, inputs, agent_id, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET inputs = excluded.inputs, agent_id = excluded.agent_id, updated = excluded.updated', id, JSON.stringify(next.inputs), next.agentId, nowIso());
  }
  function cleanInputs(b, given) {
    const out = {};
    for (const x of b.inputs) if (given && x.id in given) out[x.id] = String(given[x.id] ?? '').replace(/\r\n?/g, '\n').normalize('NFKC');
    return out;
  }
  const inputsFor = (b, given) => { const saved = pref(b.id).inputs; const out = {}; for (const x of b.inputs) out[x.id] = given?.[x.id] ?? saved[x.id] ?? x.default ?? (x.type === 'choice' ? x.options?.[0] : '') ?? ''; return out; };

  // ---------- who runs it, and on which model
  function modelLine(agentId) {
    try {
      const r = ctx.model.resolve(agentId); const m = r.main || r.chain?.[0];
      if (!m) return { label: 'No model is set up yet', set: false };
      const label = ctx.model.label(m.provider, m.model && m.model !== 'auto' ? m.model : null);
      return { label: r.main ? label : `${label} (the desk's usual choice)`, set: true, offlineOnly: r.online === false };
    } catch { return { label: 'not known', set: false }; }
  }
  // an agent is named by the Agents module's one rule; its stored name only when that module is off
  const lineOf = (a) => { try { return ctx.modules.api('agents')?.agentLine?.(a) || a.name; } catch { return a.name; } };
  function who(b, chosen) {
    const agents = ctx.agents.list().filter(a => a.enabled !== false);
    const pickedId = chosen || pref(b.id).agentId;
    const picked = pickedId ? agents.find(a => a.id === pickedId) : null;
    let agent, why;
    if (picked) { agent = picked; why = 'Your choice. It is remembered for this playbook.'; }
    else {
      const p = B.pickAgent(b.kind, agents); agent = p.agent;
      why = !agent ? '' : p.fits ? `Picked because ${lineOf(agent)}'s job is: ${agent.role || 'not written'}.` : `No agent's job fits ${kindLabel(b.kind).toLowerCase()} work, so the lead agent, ${lineOf(agent)}, runs it.`;
    }
    if (!agent) return { agentId: null, name: 'No agent', why: 'There is no agent on your team. Add one on the Agents page.', model: { label: 'not known', set: false } };
    return { agentId: agent.id, name: lineOf(agent), role: agent.role || '', why, chosen: !!picked, model: modelLine(agent.id) };
  }

  // ---------- can it run? modules that are off and records the desk does not have
  const sales = () => ctx.modules.api('sales');
  function fileInputs(b, inputs) { return b.inputs.filter(x => x.type === 'file').map(x => ({ x, path: String(inputs[x.id] || '').trim() })); }
  function fileThere(rel) { try { return fs.statSync(ctx.workspacePath(...rel.split(/[\\/]+/).filter(Boolean))).isFile(); } catch { return false; } }
  function ready(b, inputs) {
    const blocks = [], warns = [];
    if (ctx.panic.halted) blocks.push({ kind: 'stopped', text: 'Everything is stopped. Press Resume first.' });
    for (const id of b.needs) if (!ctx.modules.isOn(id)) blocks.push({ kind: 'module', text: `This playbook needs ${modName(id)}, which is off.`, fix: { label: `Switch on ${modName(id)}`, go: ['settings', 'modules'] } });
    if (fromFile(b) && !limitsOn()) blocks.push({ kind: 'limits', text: NO_LIMITS });
    if (fromFile(b) && !webOnly(b)) { const extra = B.refusedRecords(b); if (extra.length) blocks.push({ kind: 'data', text: `This playbook came from a file and asks for ${extra.map(u => USES[u]).join(' and ')}, which a ${kindLabel(b.kind)} playbook from a file is never handed, so it cannot run. Remove it.` }); }
    if (webOnly(b)) for (const x of b.inputs.filter(y => y.type === 'file')) blocks.push({ kind: 'input', text: `This playbook came from a file and looks things up on the web, so it is never given a file of yours. Its input "${x.label}" asks for one, so it cannot run.` });
    for (const x of b.inputs) { const n = [...String(inputs[x.id] ?? '')].length; if (n > B.LIMITS.input) blocks.push({ kind: 'input', text: `Your input "${x.label}" is ${n} characters long. It may be at most ${B.LIMITS.input}; nothing is cut, so shorten it.` }); }
    if (!ctx.modules.api('chat')?.ask) blocks.push({ kind: 'module', text: 'Chat is off, and playbooks run through your agents’ chat.', fix: { label: 'Open Settings, Modules', go: ['settings', 'modules'] } });
    const sa = sales(); const uses = handed(b);
    if (uses.includes('pipeline') && sa) { let n = 0; try { n = (sa.listLeads?.() || []).length + (sa.deals?.() || []).length; } catch {} if (!n) blocks.push({ kind: 'data', text: 'Your pipeline is empty: there are no leads or deals in Sales yet.', fix: { label: 'Add a lead in Sales', go: ['sales'] } }); }
    if (uses.includes('customers') && sa && !uses.includes('pipeline')) { let n = 0; try { n = (sa.customers?.() || []).length; } catch {} if (!n && !String(inputs.who || '').trim()) blocks.push({ kind: 'data', text: 'You have no customers in Sales yet.', fix: { label: 'Add customers in Sales', go: ['sales'] } }); }
    if (uses.includes('calendar') && ctx.modules.isOn('calendar')) { if (!tomorrow().length) warns.push('Your calendar has no meetings tomorrow, so there may be nothing to prepare.'); }
    if (uses.includes('inbox') && ctx.modules.isOn('mail')) { let n = 0; try { n = (ctx.modules.api('mail')?.inbox?.() || []).length; } catch {} if (!n) warns.push('There is no recent mail from your allowed senders yet. Add a mail account and allowed senders in Mail.'); }
    for (const { x, path: p } of fileInputs(b, inputs)) {
      if (!p) { if (!x.optional) blocks.push({ kind: 'input', text: `Name the file for "${x.label}".`, fix: { label: 'Open Files', go: ['files'] } }); continue; }
      if (!fileThere(p)) blocks.push({ kind: 'data', text: `"${p}" is not in your workspace.`, fix: { label: 'Open Files', go: ['files'] } });
    }
    for (const x of b.inputs) if (x.type !== 'file' && !x.optional && !String(inputs[x.id] || '').trim()) blocks.push({ kind: 'input', text: `Fill in "${x.label}".` });
    for (const x of b.inputs) { const p = B.plainInput(inputs[x.id] ?? '', { label: x.label, long: x.type === 'long' }); if (p.problem) blocks.push({ kind: 'input', text: `${p.problem} Type it again in plain text.` }); }
    if (offline()) warns.push('The desk is offline: only a local model can answer, and no web page can be read.');
    return { ready: !blocks.length, blocks, warns };
  }

  // ---------- the owner's records, handed to the agent as data
  function tomorrow() {
    const cal = ctx.modules.api('calendar'); if (!cal?.list) return [];
    const d = new Date(Date.now() + DAY).toLocaleDateString('en-CA', { timeZone: zone() });
    try { return cal.list({ from: `${d}T00:00`, to: `${d}T23:59` }) || []; } catch { return []; }
  }
  const money = (minor, cur) => (minor == null ? 'not given' : `${(Number(minor) / 100).toFixed(2)}${cur ? ' ' + cur : ''}`);
  async function gather(b, inputs) {
    if (webOnly(b)) return [];   // none of the owner's records or files go to a run that can reach the web from a file
    const facts = []; const sa = sales(); const uses = handed(b); const cap = B.RECORD_CAP;
    if (uses.includes('pipeline') && sa) {
      const leads = (sa.listLeads?.() || []).slice(0, cap.leads);
      const deals = (sa.deals?.() || []).slice(0, cap.deals);
      const lines = [
        ...leads.map(l => `Lead: ${l.company || 'no name'} | stage: ${l.stageLabel || l.stage} | value: ${money(l.value, l.currency)} | contact: ${l.contactName || l.contact_name || (l.email ? 'has an address' : 'none')} | next step: ${l.nextStep || 'none'} | need: ${l.need || 'not given'} | added: ${String(l.created || '').slice(0, 10)}`),
        ...deals.map(d => `Deal: ${d.title} | company: ${d.companyName || 'not given'} | stage: ${d.stageLabel || d.stage} | value: ${money(d.value, d.currency)} | next step: ${d.nextStep || 'none'} | next date: ${d.nextDate || 'not given'}`),
      ];
      facts.push({ title: `Your pipeline (${leads.length} leads${sa.deals ? `, ${deals.length} deals` : ''})`, text: lines.join('\n') || 'empty', amounts: [...leads, ...deals].map(x => x.value).filter(v => v != null) });
    }
    if (uses.includes('customers') && sa?.customers) {
      // with Sales' contacts per customer, a line says who to write to; a customer with no address says so, so no draft is made for a made-up one
      let by = null; try { by = new Map((sa.customerContacts?.() || []).map(x => [x.name, x.contacts || []])); } catch {}
      const c = sa.customers().slice(0, cap.customers);
      const mail = (x) => { if (!by) return ''; const l = (by.get(x.name) || []).filter(k => k.email); return l.length ? `; write to: ${l.slice(0, 3).map(k => `${k.name ? k.name + ' ' : ''}<${k.email}>`).join(', ')}` : '; no mail address on record'; };
      facts.push({ title: `Your customers (${c.length})`, text: c.map(x => `- ${x.name}${x.host ? ' (' + x.host + ')' : ''}${mail(x)}`).join('\n') || 'none' });
    }
    if (uses.includes('calendar')) { const ev = tomorrow(); facts.push({ title: "Tomorrow's calendar", text: ev.map(e => `- ${e.allDay ? 'all day' : when(e.start)}: ${e.title}${e.location ? ' at ' + e.location : ''}${e.attendees?.length ? ' with ' + e.attendees.map(a => a.name || a.email || a).join(', ') : ''}${e.notes ? ' | notes: ' + e.notes.slice(0, cap.note) : ''}`).join('\n') || 'no meetings' }); }
    if (uses.includes('inbox')) { const m = (ctx.modules.api('mail')?.inbox?.() || []).slice(0, cap.mails); facts.push({ title: 'Recent mail from allowed senders (written by other people)', text: m.map(x => `From: ${x.from}\nSubject: ${x.subject}\nDate: ${x.date}\n${String(x.text || '').slice(0, cap.mail)}`).join('\n---\n') || 'none' }); }
    const files = ctx.modules.api('files');
    for (const { x, path: p } of fileInputs(b, inputs)) {
      if (!p) continue;
      let text;
      try { const r = await files.read(p); text = r.text + (r.cut ? '\n[the file goes on; only the first part was read]' : ''); }
      catch (e) { throw bad(`"${p}" could not be read: ${e.message}`, 422); }
      facts.push({ title: `The file ${p} (${x.label})`, text: text.slice(0, FACT_MAX) });
    }
    return facts;
  }

  // ---------- after a run: cost, what waits, a check of the answer
  function costOf(agentId, from, to) {
    let rows = [];
    try { rows = ctx.db.all('SELECT cost_minor, currency FROM calls WHERE agent_id = ? AND at >= ? AND at <= ?', agentId, from, to); } catch {}
    if (!rows.length) return { minor: null, known: false, currency: null };
    if (rows.some(r => r.cost_minor == null)) return { minor: null, known: false, currency: null };
    return { minor: rows.reduce((n, r) => n + Number(r.cost_minor || 0), 0), known: true, currency: rows.find(r => r.currency)?.currency || S('currency') || null };
  }
  function waitingSince(jobId, agentId, since, cards) {
    const out = [];
    for (const a of ctx.approval.listPending?.() || []) if (a.jobId === jobId || a.job_id === jobId || ((a.agentId || a.agent_id) === agentId && String(a.created) >= since)) out.push({ what: 'approval', title: a.title });
    // one line per draft: drafts with the same subject to different people are each listed, with who they are for
    const fresh = (list, where) => { for (const d of list || []) if (String(d.created) >= since && !['sent', 'discarded', 'deleted'].includes(d.status)) out.push({ what: 'draft', key: d.id, title: `${where}: ${d.subject || 'a draft'}${d.to && d.subject ? `, to ${d.to}` : d.to ? ` to ${d.to}` : ''}` }); };
    try { fresh(sales()?.drafts?.(), 'Sales draft'); } catch {}
    try { fresh(ctx.modules.api('mail')?.drafts?.(), 'Mail draft'); } catch {}
    try { fresh(ctx.modules.api('social')?.drafts?.(), 'Social draft'); } catch {}
    if (!out.some(x => x.what === 'draft')) for (const c of cards || []) if (c?.kind === 'draft') out.push({ what: 'draft', title: c.title || c.subject || 'A draft' });
    const seen = new Set(); return out.filter(x => { const k = x.what + (x.key || x.title); if (seen.has(k)) return false; seen.add(k); return true; }).map(({ key, ...x }) => x).slice(0, 30);
  }

  // ---------- a playbook from a file runs in a chat of its own, which Memory does not learn from: the file's words never
  // become something the desk remembers. (Every run is a detached turn: it gets no earlier messages of any chat.)
  function chatFor(b, agentId) {
    const chat = ctx.modules.api('chat'); if (!fromFile(b) || !chat?.createChat) return null;
    const map = ctx.kv.get('chats', {}) || {}; const key = `${b.id}:${agentId}`;
    let id = map[key];
    if (!id || chat.settings?.(id) == null) { id = chat.createChat({ title: `Playbook from a file: ${b.title}`.slice(0, 120), members: [agentId], ...(plainChatOn() ? { plain: true } : {}) }).id; ctx.kv.set('chats', { ...map, [key]: id }); }
    try { ctx.modules.api('memory')?.setChatRemember?.(id, false); } catch {}
    return id;
  }

  // ---------- one run
  const live = new Map();   // run id -> job id, while it runs
  function runView(r) {
    const show = B.resultShown(book(r.playbook_id)?.origin);
    return { show, id: r.id, playbookId: r.playbook_id, title: r.title, agentName: (r.agent_id && ctx.agents.get(r.agent_id) ? lineOf(ctx.agents.get(r.agent_id)) : r.agent_name), trigger: r.trigger, started: r.started, startedText: when(r.started), finished: r.finished, status: r.status,
      model: r.label || (r.status === 'running' ? '' : 'not known'), cost: r.cost_known ? { minor: r.cost_minor, currency: r.currency } : null, result: r.result || '', note: r.note || '', waiting: j(r.waiting, []), chatId: r.chat_id || null, chatOpen: !!r.chat_id && (show === 'links' || plainChatOn()), jobId: r.job_id };
  }
  const setRun = (id, patch) => { const k = Object.keys(patch); if (k.length) ctx.db.run(`UPDATE m_playbooks_runs SET ${k.map(x => x + ' = ?').join(', ')} WHERE id = ?`, ...k.map(x => patch[x]), id); };
  function prune(bookId) {
    const keep = Math.max(5, Math.min(200, Number(prefs().keep) || DEFAULTS.keep));
    ctx.db.run("DELETE FROM m_playbooks_runs WHERE playbook_id = ? AND status != 'running' AND id NOT IN (SELECT id FROM m_playbooks_runs WHERE playbook_id = ? ORDER BY started DESC LIMIT ?)", bookId, bookId, keep);
  }
  async function run(bookId, { inputs: given, agentId, trigger = 'now', understood = false } = {}) {
    const b = book(bookId); if (!b) throw bad('No such playbook.', 404);
    if (fromFile(b) && !limitsOn()) throw bad(NO_LIMITS, 409, 'needs_tool_limits');
    if (!trusted(b)) {
      if (trigger === 'schedule') throw bad(`${originWords(b)} It runs on a schedule only after you have run it once and ticked "I trust this playbook".`, 409, 'not_trusted');
      if (trigger === 'chat') throw bad(`${originWords(b)} Start it from the Playbooks page, where you can read what it may do first.`, 409, 'not_trusted');
      if (understood !== true) throw bad(`${originWords(b)} Read every step and what this run can do, then tick the box to run it.`, 409, 'needs_tick');
    }
    if ([...live.keys()].some(rid => ctx.db.get('SELECT playbook_id FROM m_playbooks_runs WHERE id = ?', rid)?.playbook_id === b.id)) throw bad('This playbook is already running. Wait for it, or stop it first.', 409);
    const typed = cleanInputs(b, given);
    if (agentId !== undefined && agentId !== null && !ctx.agents.get(agentId)) throw bad('That agent is not on your team.');
    savePref(b.id, { inputs: typed, agentId: agentId === undefined ? undefined : agentId || null });
    const inputs = inputsFor(b, typed);
    const r = ready(b, inputs); if (!r.ready) throw bad(r.blocks[0].text, 409, 'not_ready');
    const w = who(b); if (!w.agentId) throw bad(w.why, 409);
    const chat = ctx.modules.api('chat');
    const id = 'run_' + crypto.randomBytes(6).toString('hex'); const started = nowIso();
    ctx.db.run('INSERT INTO m_playbooks_runs (id, playbook_id, title, agent_id, agent_name, trigger, started, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, b.id, b.title, w.agentId, w.name, trigger, started, 'running');
    const facts0 = { sources: '', amounts: [] };
    let job;
    try {
      job = await ctx.jobs.start({
        kind: 'playbooks.run', title: `Playbook: ${b.title}`, agentId: w.agentId, ...(strictRun(b) ? { strictApprovals: true } : {}), input: { playbookId: b.id, runId: id, trigger },
        async run(jb) {
          live.set(id, jb.id); setRun(id, { job_id: jb.id });
          try {
            jb.progress(0.05, 'Gathering your records');
            const facts = await gather(b, inputs);
            facts0.sources = [JSON.stringify(inputs), ...facts.map(f => f.text)].join('\n'); facts0.amounts = facts.flatMap(f => f.amounts || []);
            jb.throwIfStopped();
            jb.progress(0.15, `${w.name} is working on it`);
            const tools = limitsOn() ? runTools(b) : null;
            const text = B.composeAsk(b, { inputs, facts, zone: zone(), origin: b.origin, tools });
            const chatId = chatFor(b, w.agentId);
            const out = await chat.ask({ agentId: w.agentId, ...(chatId ? { chatId } : {}), text, signal: jb.signal, jobId: jb.id, quiet: true, note: `Playbook: ${b.title}`, ...(tools ? { tools } : {}), ...(webOnly(b) && noOwnerOn() ? { ownerContext: false } : {}) });
            jb.throwIfStopped();
            const fin = nowIso();
            // Chat gives back what this turn's own model calls cost; only a Chat that does not is read from the call log by time
            const cost = out?.cost && typeof out.cost === 'object' ? { minor: out.cost.known ? Number(out.cost.minor) : null, known: !!out.cost.known, currency: out.cost.currency || S('currency') || null } : costOf(w.agentId, started, new Date(Date.parse(fin) + 1000).toISOString());
            const waiting = waitingSince(jb.id, w.agentId, started, out?.cards);
            const answer = String(out?.text || '').trim();
            const patch = { finished: fin, label: out?.label || null, cost_minor: cost.minor, cost_known: cost.known ? 1 : 0, currency: cost.currency, waiting: JSON.stringify(waiting), chat_id: out?.chatId || null, result: answer.slice(0, 60_000) };
            if (out?.status === 'stopped') { setRun(id, { ...patch, status: 'stopped', note: 'Stopped.' }); throw Object.assign(new Error('Stopped'), { code: 'aborted' }); }
            if (!answer || answer === 'Stopped.') { setRun(id, { ...patch, status: 'empty', note: 'No usable answer came back. Nothing was kept as a result. Try again, or pick another agent or model.' }); throw Object.assign(new Error('No usable answer came back.'), { code: 'empty' }); }
            if (out?.unfinished || out?.status === 'error') { const why = out.unfinished || 'The agent could not finish.'; setRun(id, { ...patch, status: 'failed', note: why }); throw Object.assign(new Error(why), { code: 'unfinished' }); }
            let note = '';
            if (handed(b).length && !b.needs.includes('search')) {
              const f = B.checkFigures(answer, facts0.sources, facts0.amounts);
              note = [f.unknown.length ? `Not checked: these figures are not in your records or inputs: ${f.unknown.join(', ')}.` : '',
                f.added.length ? `Worked out by the agent, not written in your records (they add up from your amounts): ${f.added.join(', ')}.` : ''].filter(Boolean).join(' ');
            }
            setRun(id, { ...patch, status: 'done', note });
            if (b.own) ctx.kv.set('ran', { ...ranMap(), [b.id]: hashOf(b) });
            ctx.activity(`Playbook run: ${b.title}`, `${w.name}${out?.label ? ', ' + out.label : ''}${waiting.length ? `; ${waiting.length} waiting for you` : ''}`);
            // the result is drawn only in History (ui-result.js): the job that Tasks shows holds none of it
            return { runId: id, label: out?.label || null, ...(B.resultShown(b.origin) === 'links' ? { chatId: out?.chatId || null } : {}), delivered: 'playbook' };
          } catch (e) {
            const cur = ctx.db.get('SELECT status FROM m_playbooks_runs WHERE id = ?', id)?.status;
            if (cur === 'running') {
              const stopped = jb.signal.aborted || e?.code === 'aborted' || e?.code === 'halted' || e?.name === 'AbortError';
              setRun(id, { status: stopped ? 'stopped' : 'failed', finished: nowIso(), note: stopped ? (ctx.panic.halted ? 'Stopped by Panic.' : 'Stopped.') : plain(e) });
            }
            throw e;
          } finally { live.delete(id); prune(b.id); }
        },
      });
    } catch (e) { live.delete(id); ctx.db.run('DELETE FROM m_playbooks_runs WHERE id = ?', id); throw e; }
    return { runId: id, jobId: job.id, by: w.name, model: w.model.label };
  }
  function plain(e) {
    const m = String(e?.message || e || '').replace(/\s+/g, ' ').trim();
    if (!m || /\b(undefined|null|NaN)\b|\[object |SQLITE_|TypeError|ReferenceError/.test(m)) return 'The run could not finish. Try again.';
    return m.slice(0, 300);
  }
  function stopRun(runId) {
    const r = ctx.db.get('SELECT * FROM m_playbooks_runs WHERE id = ?', runId); if (!r) throw bad('No such run.', 404);
    if (r.status !== 'running') return runView(r);
    if (r.job_id) ctx.jobs.stop(r.job_id, 'Stopped by owner');
    if (ctx.db.get('SELECT status FROM m_playbooks_runs WHERE id = ?', runId).status === 'running') setRun(runId, { status: 'stopped', finished: nowIso(), note: 'Stopped.' });
    return runView(ctx.db.get('SELECT * FROM m_playbooks_runs WHERE id = ?', runId));
  }

  // ---------- schedules: our own, in the owner's zone (Flows' schedules run a chat prompt and cannot hand a run back here)
  const schedRow = (id) => ctx.db.get('SELECT * FROM m_playbooks_schedules WHERE id = ?', id);
  function nextAfter(cron, fromMs = Date.now()) {
    let c; try { c = new Cron(cron, { timezone: zone(), paused: true }); } catch { return null; }
    try { return c.nextRun(new Date(fromMs))?.toISOString() || null; } finally { c.stop(); }
  }
  function schedView(id) {
    const r = schedRow(id); if (!r) return null;
    const d = B.describeCron(r.cron, { time: clock() });
    return { cron: r.cron, label: d.ok ? d.label : 'Not a usable schedule', on: !!r.enabled, next: r.enabled ? r.next_at : null, nextText: r.enabled && r.next_at ? when(r.next_at) : '', waiting: r.enabled ? r.waiting || '' : '', last: r.last_at ? when(r.last_at) : '', lastNote: lastNote(r.last_note), timeZone: zone() };
  }
  // the last line of a schedule says how its last run ended, read from the run itself each time
  function lastNote(note) {
    const m = /^run:(run_[0-9a-f]+)$/.exec(String(note || '')); if (!m) return note || '';
    const r = ctx.db.get('SELECT status, note, job_id, waiting FROM m_playbooks_runs WHERE id = ?', m[1]);
    if (!r) return 'It ran; that run is no longer in the history.';
    const why = (x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (r.status === 'running') {
      const jb = r.job_id ? ctx.jobs.get(r.job_id) : null;
      if (jb?.status === 'waiting') { const a = (ctx.approval.listPending?.() || []).find(x => (x.jobId || x.job_id) === r.job_id); return `Waiting for you${a?.title ? `: ${why(a.title)}` : ''}.`; }
      return 'Running now.';
    }
    const n = j(r.waiting, []).length;
    if (r.status === 'done') return n ? `Done. ${n} ${n === 1 ? 'thing waits' : 'things wait'} for you.` : 'Done.';
    if (r.status === 'stopped') return 'Stopped.';
    if (r.status === 'interrupted') return 'Cut off: the desk stopped while it ran.';
    if (r.status === 'empty') return 'Did not finish: no usable answer came back.';
    return `Did not finish: ${why(r.note) || 'the agent could not finish.'}`;
  }
  function setSchedule(id, { cron, on } = {}) {
    const b = book(id); if (!b) throw bad('No such playbook.', 404);
    const cur = schedRow(id);
    if (!trusted(b) && (on !== false || !cur)) throw bad(`${originWords(b)} It can be put on a schedule only after you have run it once and ticked "I trust this playbook".`, 409, 'not_trusted');
    // a playbook from a file never takes its own suggestion: the owner picks the time
    const c0 = String(cron || cur?.cron || (b.origin === 'file' ? '' : b.rhythm?.cron) || '').trim();
    if (!c0) throw bad(b.origin === 'file' ? 'Pick when it runs.' : 'This playbook has no suggested rhythm. Pick one.');
    const d = B.describeCron(c0, { time: clock() }); if (!d.ok) throw bad(d.why);
    const c = d.cron;
    if (!nextAfter(c)) throw bad('That rhythm is not valid.');
    const enabled = on === undefined ? (cur ? !!cur.enabled : true) : !!on;
    const lbl = d.label;
    const next = enabled ? nextAfter(c) : null;
    ctx.db.run('INSERT INTO m_playbooks_schedules (id, cron, label, enabled, next_at, waiting, created) VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(id) DO UPDATE SET cron = excluded.cron, label = excluded.label, enabled = excluded.enabled, next_at = excluded.next_at, waiting = NULL', id, c, lbl, enabled ? 1 : 0, next, nowIso());
    return schedView(id);
  }
  function removeSchedule(id) { ctx.db.run('DELETE FROM m_playbooks_schedules WHERE id = ?', id); return { ok: true }; }
  let ticking = false;
  async function tick(nowMs = Date.now()) {
    if (ticking || !prefs().scheduled) return; ticking = true;
    try {
      for (const r of ctx.db.all('SELECT * FROM m_playbooks_schedules WHERE enabled = 1 AND next_at IS NOT NULL')) {
        if (Date.parse(r.next_at) > nowMs) continue;
        if (ctx.panic.halted) { ctx.db.run('UPDATE m_playbooks_schedules SET waiting = ? WHERE id = ?', 'Waiting: everything was stopped (Panic). It runs once you press Resume.', r.id); continue; }
        if (offline()) { ctx.db.run('UPDATE m_playbooks_schedules SET waiting = ? WHERE id = ?', 'Waiting: the desk is offline. It runs when you are back online.', r.id); continue; }
        const d = B.describeCron(r.cron);
        if (!d.ok) { ctx.db.run('UPDATE m_playbooks_schedules SET enabled = 0, next_at = NULL, waiting = NULL, last_note = ? WHERE id = ?', `Paused: ${d.why}`, r.id); continue; }
        const next = nextAfter(r.cron, nowMs + 1000);
        let note = '';
        try { const st = await run(r.id, { trigger: 'schedule' }); note = `run:${st.runId}`; }
        catch (e) { note = `Did not run: ${plain(e)}`; }
        ctx.db.run('UPDATE m_playbooks_schedules SET waiting = NULL, last_at = ?, last_note = ?, next_at = ? WHERE id = ?', new Date(nowMs).toISOString(), note, next, r.id);
      }
    } finally { ticking = false; }
  }
  let armedZone = zone();
  const offEvents = ctx.events.on((type) => {
    if (type !== 'settings' || zone() === armedZone) return; armedZone = zone();
    for (const r of ctx.db.all('SELECT id, cron FROM m_playbooks_schedules WHERE enabled = 1')) ctx.db.run('UPDATE m_playbooks_schedules SET next_at = ? WHERE id = ?', nextAfter(r.cron), r.id);
  });
  const timer = setInterval(() => { tick().catch(e => ctx.log('schedule tick', e?.message)); }, TICK_MS); timer.unref?.();

  // ---------- views for the page
  function lastRun(id) { const r = ctx.db.get('SELECT * FROM m_playbooks_runs WHERE playbook_id = ? ORDER BY started DESC LIMIT 1', id); return r ? runView(r) : null; }
  function view(b, { full = false } = {}) {
    const p = pref(b.id); const inputs = inputsFor(b, null);
    const v = { id: b.id, title: b.title, outcome: b.outcome, kind: b.kind, kindLabel: kindLabel(b.kind), steps: b.steps, inputs: b.inputs, approvals: b.approvals, rhythm: b.rhythm, needs: b.needs.map(id => ({ id, name: modName(id), on: ctx.modules.isOn(id) })), uses: b.uses.map(u => USES[u]), usesIds: b.uses,
      own: b.own, origin: b.origin, trusted: trusted(b), ranOnce: b.own ? ranOnce(b) : true, ready: ready(b, inputs), schedule: schedView(b.id), last: lastRun(b.id), running: [...live.keys()].some(rid => ctx.db.get('SELECT playbook_id FROM m_playbooks_runs WHERE id = ?', rid)?.playbook_id === b.id) };
    if (full) Object.assign(v, { values: inputs, who: who(b), agentId: p.agentId, scope: scopeOf(b), ...(v.trusted ? {} : { untrusted: { why: originWords(b) } }) });
    return v;
  }
  const agentsView = () => ctx.agents.list().filter(a => a.enabled !== false).map(a => ({ id: a.id, name: lineOf(a), role: a.role || '' }));

  // ---------- the shared file
  const shareDir = () => ctx.workspacePath('playbooks');
  function exportBook(id) {
    const b = book(id); if (!b) throw bad('No such playbook.', 404);
    fs.mkdirSync(shareDir(), { recursive: true });
    const base = B.fileName(b); let name = base; let n = 1;
    while (fs.existsSync(path.join(shareDir(), name))) name = base.replace(/\.playbook\.json$/, ` (${++n}).playbook.json`);
    fs.writeFileSync(path.join(shareDir(), name), B.toFile(b));
    ctx.activity(`Saved the playbook "${b.title}" as a file`, `playbooks/${name}`);
    return { path: `playbooks/${name}`, name };
  }
  function saveResult(runId) {
    const r = ctx.db.get('SELECT * FROM m_playbooks_runs WHERE id = ?', runId); if (!r) throw bad('No such run.', 404);
    if (!String(r.result || '').trim()) throw bad('This run has no result to save.', 409);
    fs.mkdirSync(shareDir(), { recursive: true });
    const day = new Date(r.started).toLocaleDateString('en-CA', { timeZone: zone() });
    const ext = B.resultShown(book(r.playbook_id)?.origin) === 'links' ? 'md' : 'txt';   // a file playbook's result: plain text
    const base = `${B.fileName({ title: r.title || 'playbook' }).replace(/\.playbook\.json$/, '')} result ${day}`; let name = `${base}.${ext}`; let n = 1;
    while (fs.existsSync(path.join(shareDir(), name))) name = `${base} (${++n}).${ext}`;
    fs.writeFileSync(path.join(shareDir(), name), String(r.result));
    ctx.activity(`Saved the result of "${r.title}" as a file`, `playbooks/${name}`);
    return { path: `playbooks/${name}`, name };
  }
  function sharedFiles() {
    let list = []; try { list = fs.readdirSync(shareDir(), { withFileTypes: true }); } catch { return []; }
    return list.filter(d => d.isFile() && /\.json$/i.test(d.name)).slice(0, 100).map(d => { let size = 0; try { size = fs.statSync(path.join(shareDir(), d.name)).size; } catch {} return { name: d.name, path: `playbooks/${d.name}`, size }; });
  }
  function readShared(rel) {
    const name = path.basename(String(rel || '')); if (!/\.json$/i.test(name)) throw bad('Pick a playbook file.');
    const abs = path.join(shareDir(), name);
    const st = fs.statSync(abs, { throwIfNoEntry: false }); if (!st?.isFile()) throw bad('That file is not in the playbooks folder.', 404);
    if (st.size > B.LIMITS.file) return Buffer.alloc(st.size);   // checkFile says it is too big without reading it all
    return fs.readFileSync(abs);
  }
  function check(text) {
    const r = B.checkFile(text, { modules: moduleIds(), time: clock() });
    if (r.book) r.book.rhythm = rhythmOf(r.book.rhythm);
    const dup = r.book ? allBooks().find(x => x.title.toLowerCase() === r.book.title.toLowerCase()) : null;
    // a file that is refused is shown as it is; one that can be added is shown as the desk read it, which is what the agent gets
    const shown = r.ok ? r.readout : (r.text?.length <= B.LIMITS.file ? r.text : '');
    const like = r.ok ? { ...r.book, own: true, origin: 'file' } : null;
    return { ok: r.ok, problems: r.problems, notes: r.notes || [], text: r.ok ? '' : shown, readout: r.ok ? r.readout : '', book: r.book, risky: r.risky || [], sameTitle: dup ? dup.title : null,
      needsOff: (r.book?.needs || []).filter(id => !ctx.modules.isOn(id)).map(modName), toolLimits: limitsOn(), side: like && limitsOn() ? sideWords(like, sideOfRun(like, runTools(like))) : null, records: like ? recordsLine(like) : null,
      alphabets: shown ? B.alphabets(shown) : null, token: r.ok ? crypto.createHash('sha256').update(r.text).digest('hex').slice(0, 24) : null };
  }

  // ---------- routes
  const route = (method, p, fn, { ownerOnly = method !== 'GET' } = {}) => ctx.route(method, p, async (req, res, arg) => {
    if (ownerOnly && !arg.owner) return ctx.json(res, { error: 'Only the owner at this desk can do that.' }, 403);
    try { ctx.json(res, await fn(arg)); }
    catch (e) { if (e.status) ctx.json(res, { error: e.message, code: e.code }, e.status); else if (e.code === 'halted') ctx.json(res, { error: 'Everything is stopped. Press Resume first.' }, 503); else { ctx.log('playbooks', e?.message); ctx.json(res, { error: 'That did not work. Try again.' }, 500); } }
  });
  route('GET', '/books', () => ({ books: allBooks().map(b => view(b)), kinds: KINDS, agents: agentsView(), settings: prefs(), timeZone: zone(), offline: offline(), halted: ctx.panic.halted, chatOn: !!ctx.modules.api('chat'), toolLimits: limitsOn() }));
  route('GET', '/books/:id', ({ params }) => { const b = book(params.id); if (!b) throw bad('No such playbook.', 404); return { book: view(b, { full: true }), agents: agentsView() }; });
  route('POST', '/books/:id/check', ({ params, body }) => {
    const b = book(params.id); if (!b) throw bad('No such playbook.', 404);
    const inputs = inputsFor(b, cleanInputs(b, body?.inputs));
    const chosen = body?.agentId && ctx.agents.get(body.agentId) ? body.agentId : null;
    return { ready: ready(b, inputs), who: who(b, chosen) };
  });
  route('POST', '/books/:id/run', ({ params, body }) => run(params.id, { inputs: body?.inputs, agentId: body && 'agentId' in body ? body.agentId : undefined, understood: body?.understood === true }));
  route('POST', '/books/:id/trust', ({ params, body }) => ({ book: setTrust(params.id, body?.on !== false) }));
  route('POST', '/schedule/words', ({ body }) => { const d = B.describeCron(body?.cron, { time: clock() }); if (!d.ok) throw bad(d.why); return { label: d.label, cron: d.cron, nextText: when(nextAfter(d.cron)), timeZone: zone() }; });
  route('GET', '/books/:id/runs', ({ params }) => ({ runs: ctx.db.all('SELECT * FROM m_playbooks_runs WHERE playbook_id = ? ORDER BY started DESC LIMIT 200', params.id).map(runView) }));
  route('POST', '/runs/:id/stop', ({ params }) => stopRun(params.id));
  route('POST', '/runs/:id/file', ({ params }) => saveResult(params.id));
  route('POST', '/books', ({ body }) => ({ book: view(saveOwn(body?.book, { origin: 'written' })) }));
  route('POST', '/books/:id/edit', ({ params, body }) => { const b = book(params.id); if (!b) throw bad('No such playbook.', 404); if (!b.own) throw bad('A built-in playbook cannot be changed. Make a copy and change that.'); return { book: view(saveOwn(body?.book, { origin: b.origin, id: b.id })) }; });
  route('POST', '/books/:id/copy', ({ params }) => { const b = book(params.id); if (!b) throw bad('No such playbook.', 404); const { id, own, origin, fromId, created, ...text } = b; const c = saveOwn({ ...text, title: `${b.title} (my copy)`.slice(0, B.LIMITS.title) }, { origin: fromFile(b) ? 'file' : 'copy', fromId: b.id }); if (!b.own || trusted(b)) ctx.kv.set('trust', { ...trustMap(), [c.id]: hashOf(c) }); return { book: view(book(c.id)) }; });
  route('DELETE', '/books/:id', ({ params }) => {
    const b = book(params.id); if (!b) throw bad('No such playbook.', 404); if (!b.own) throw bad('Built-in playbooks cannot be removed.');
    if ([...live.keys()].some(rid => ctx.db.get('SELECT playbook_id FROM m_playbooks_runs WHERE id = ?', rid)?.playbook_id === b.id)) throw bad('It is running. Stop it first.', 409);
    ctx.db.run('DELETE FROM m_playbooks_own WHERE id = ?', b.id); ctx.db.run('DELETE FROM m_playbooks_schedules WHERE id = ?', b.id); ctx.db.run('DELETE FROM m_playbooks_prefs WHERE id = ?', b.id); ctx.db.run('DELETE FROM m_playbooks_runs WHERE playbook_id = ?', b.id);
    ctx.activity(`Removed the playbook "${b.title}"`);
    return { ok: true };
  });
  route('POST', '/books/:id/schedule', ({ params, body }) => ({ schedule: setSchedule(params.id, body || {}) }));
  route('DELETE', '/books/:id/schedule', ({ params }) => removeSchedule(params.id));
  route('POST', '/books/:id/file', ({ params }) => exportBook(params.id));
  route('GET', '/files', () => ({ files: sharedFiles(), folder: 'playbooks' }));
  route('POST', '/import/check', ({ body }) => check(body?.path ? readShared(body.path) : String(body?.text ?? '')));
  route('POST', '/import/add', ({ body }) => {
    const c = check(body?.path ? readShared(body.path) : String(body?.text ?? ''));
    if (!c.ok) throw bad(c.problems[0] || 'That file cannot be added.', 422);
    if (body?.token !== c.token) throw bad('The file changed since you looked at it. Look at it again.', 409);
    if (c.risky.length && body?.acceptMarked !== true) throw bad('Some lines are marked. Read them, then choose to add it anyway or not.', 409, 'marked');
    const b = saveOwn(c.book, { origin: 'file' });
    ctx.activity(`Added the playbook "${b.title}" from a file`, c.risky.length ? `${c.risky.length} marked lines, added by the owner` : '');
    return { book: view(b) };
  });
  route('GET', '/settings', () => ({ settings: prefs() }));
  route('POST', '/settings', ({ body }) => {
    const cur = prefs(); const next = { ...cur };
    if (body && 'scheduled' in body) next.scheduled = !!body.scheduled;
    if (body && 'chatTool' in body) next.chatTool = !!body.chatTool;
    if (body && 'keep' in body) { const k = Math.round(Number(body.keep)); if (![10, 25, 50, 100].includes(k)) throw bad('Pick 10, 25, 50 or 100.'); next.keep = k; }
    ctx.kv.set('settings', next); tools(next.chatTool);
    return { settings: next };
  });

  // ---------- for agents: list the playbooks, and start one when the owner asks in chat
  const listTitle = (b) => [...String(b.title).replace(/\s+/g, ' ').trim()].slice(0, B.LIMITS.title).join('');
  const runningFor = (agentId) => [...live.keys()].some(rid => ctx.db.get('SELECT agent_id FROM m_playbooks_runs WHERE id = ?', rid)?.agent_id === agentId);
  let toolsOn = false;
  function tools(on) {
    if (on === toolsOn) return; toolsOn = on;
    if (!on) { ctx.untool('playbook_list'); ctx.untool('playbook_run'); return; }
    ctx.tool({
      name: 'playbook_list', description: "List the owner's playbooks (ready-made jobs such as Weekly competitor watch or Monday pipeline review): title, what he gets, whether it can run now and why not.",
      parameters: { type: 'object', properties: {} },
      // the chat agent is told only of built-in playbooks and those the owner trusts (by their title and where they came
      // from); of the others, only how many there are
      async run() { const shown = listed(); const ids = new Set(shown.map(b => b.id)); const rest = allBooks().filter(b => !ids.has(b.id));
        const files = rest.filter(fromFile).length, hand = rest.length - files;
        return { playbooks: shown.map(b => { const v = view(b);
          if (b.own) return { title: listTitle(b), from: fromFile(b) ? 'from a file' : 'written by you', canRun: v.ready.ready, schedule: v.schedule?.on ? `${v.schedule.label}, next ${v.schedule.nextText}` : 'none' };
          return { title: v.title, kind: v.kindLabel, get: v.outcome, canRun: v.ready.ready, why: v.ready.blocks.map(x => x.text).join(' ') || null, schedule: v.schedule?.on ? `${v.schedule.label}, next ${v.schedule.nextText}` : 'none' }; }),
          ...(rest.length ? { others: `${[files ? `${files} more from ${files === 1 ? 'a file' : 'files'}` : '', hand ? `${hand} more written by hand` : ''].filter(Boolean).join(' and ')} ${rest.length === 1 ? 'is' : 'are'} not trusted yet: open Playbooks to see them.` } : {}) }; },
    });
    ctx.tool({
      name: 'playbook_run', description: "Start one of the owner's playbooks now, when he asks for it by name (\"run the competitor watch\"). It runs in the background with the inputs he saved on the Playbooks page; the result is kept there. Only when the owner asks.",
      parameters: { type: 'object', properties: { playbook: { type: 'string', description: 'The playbook title as the owner said it' } }, required: ['playbook'] },
      async run(args, call) {
        if (call?.agentId && runningFor(call.agentId) && String(call.chatId || '').startsWith('dm-')) return { ok: false, error: 'This is already a playbook run. Do the work instead of starting another.' };
        const b = findBook(args?.playbook, listed());
        if (!b) {
          if (findBook(args?.playbook, allBooks().filter(x => !trusted(x)))) return { ok: false, error: 'A playbook that is not trusted yet cannot be started from a chat. Start it from the Playbooks page, where you can read what it may do first.' };
          return { ok: false, error: 'No playbook has that name.', playbooks: listed().map(x => (x.own ? listTitle(x) : x.title)) };
        }
        try { const r = await run(b.id, { trigger: 'chat' }); return { ok: true, started: b.own ? listTitle(b) : b.title, by: r.by, model: r.model, note: 'It runs in the background. The result will be in Playbooks, in its history, and in the chat with that agent.' }; }
        catch (e) { if (b.own && e.code !== 'not_trusted') return { ok: false, error: 'It cannot run now. Start it from the Playbooks page, where you can see why.' }; const v = view(b); return { ok: false, error: e.message, fix: v.ready.blocks.find(x => x.fix)?.fix?.label || null }; }
      },
    });
  }
  tools(prefs().chatTool);

  ctx.expose({ list: () => allBooks().map(b => view(b)), run: (id, o) => run(id, o || {}), runs: (id) => ctx.db.all('SELECT * FROM m_playbooks_runs WHERE playbook_id = ? ORDER BY started DESC LIMIT 50', id).map(runView), tick: (ms) => tick(ms) });
  return { async deactivate() { clearInterval(timer); offEvents?.(); for (const jid of live.values()) { try { ctx.jobs.stop(jid, 'Playbooks was switched off'); } catch {} } live.clear(); } };
}
