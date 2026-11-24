// The Module Store's dialogs: Add a module (a zip), Build your own module (here, or with another agent), Write the rest
// with a model, Remove an added module, and Add a skill from a file. Every check result is shown as a label in plain
// words, with every red and yellow line and the closing paragraph; nothing is added until the Admin approves it.
const API = 'm/store/';
/** A dialog body that scrolls inside the dialog, so its buttons stay on a small screen. */
const SCROLL = { maxHeight: 'min(58vh, 600px)', overflowY: 'auto', paddingRight: '4px' };

/** The label of a check: what it can do, the outside addresses, the tools, the signature, every red and yellow line. */
export function labelView(ui, r, { honest }) {
  const { h } = ui;
  const rep = r.request || r.report || {};
  const label = rep.label || {};
  const sections = rep.lines || rep.sections || [];
  const reds = sections.flatMap((s) => s.lines.filter((l) => l.level === 'red'));
  const yellows = sections.flatMap((s) => s.lines.filter((l) => l.level === 'yellow'));
  const row = (title, text) => h('div', { class: 'line' }, h('div', null, h('span', null, title), h('span', { class: 'd' }, text)));
  const list = (items, empty) => (items && items.length ? items.join(', ') : empty);
  return h('div', { class: 'stack', 'data-label': '', style: { maxHeight: 'min(48vh, 520px)', overflowY: 'auto', paddingRight: '4px' } },
    h('h3', null, label.name || 'This module'),
    label.description ? h('p', { class: 'sub' }, label.description) : null,
    r.refused ? h('p', { 'data-refused': '', style: { color: 'var(--fail)', margin: 0 } }, 'Refused: the check found a red line. Nothing was added.') : null,
    row('What it can do', list(label.can, 'nothing the check could see')),
    row('Outside addresses it names', list(label.hosts, 'none')),
    row('Tools it adds for agents', list(label.tools, 'none')),
    row('Signed', label.signed || 'Not signed.'),
    r.request?.replaces ? h('p', { class: 'sub' }, `A module called ${label.name || 'this'} is already here. Adding this one keeps the old one beside it, asleep.${r.request.replacesOn ? ' The old one is on, so the desk needs a restart to run the new one.' : ''}`) : null,
    reds.length ? h('div', { class: 'stack', 'data-red': '' }, h('b', null, `Red lines (${reds.length})`), ...reds.map((l) => h('p', { class: 'sub', style: { color: 'var(--fail)' } }, l.text))) : null,
    yellows.length ? h('div', { class: 'stack', 'data-yellow': '' }, h('b', null, `Yellow lines to read (${yellows.length})`), ...yellows.map((l) => h('p', { class: 'sub' }, l.text))) : h('p', { class: 'sub' }, 'No yellow lines.'),
    h('p', { class: 'sub', 'data-honest': '', style: { borderTop: '1px solid var(--line)', paddingTop: '8px' } }, honest));
}

/** Save a file the desk hands out (the page fetches it with its session, then gives it to the browser). */
async function saveFile(ui, blob, name) {
  const url = URL.createObjectURL(blob);
  const a = ui.h('a', { download: name, style: { display: 'none' } }); a.href = url;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function ask(ui, rid, done) {
  try { const r = await ui.api(API + `requests/${rid}/ask`, { method: 'POST' }); ui.toast(r.message, 'ok'); done?.(); return true; }
  catch (e) { ui.toast(e.message, 'err'); return false; }
}

/** The result of a check in a dialog, with "Ask to add it" when there is no red line. */
export function showResult(ui, r, st, after) {
  const actions = [{ label: 'Close' }];
  if (!r.refused && r.request) actions.push({ label: 'Ask to add it', kind: '', onClick: () => ask(ui, r.request.rid, after) });
  ui.modal({ title: r.refused ? 'Not added' : 'The check', wide: true, body: labelView(ui, r, st), actions });
}

export function addModule(ui, st, after) {
  const { h } = ui;
  const input = h('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': 'Choose a module zip' });
  const said = h('p', { class: 'sub' }, `A module comes as one zip file, at most ${Math.round(st.limits.zip / 1048576)} MB. The desk unpacks it in its own temp folder and checks it. Nothing is added until the Admin approves it.`);
  const m = ui.modal({ title: 'Add a module', body: h('div', { class: 'stack' }, h('p', { class: 'sub' }, st.onlyFrom), said, input), actions: [{ label: 'Cancel' }] });
  input.addEventListener('change', async () => {
    const f = input.files?.[0]; if (!f) return;
    said.textContent = 'Checking ' + f.name + '...';
    let r;
    try { r = await ui.api(API + 'check', { body: new Blob([f], { type: 'application/zip' }) }); }   // the type says it is a file, not JSON
    catch (e) { said.textContent = e.message; return; }
    m.close(); showResult(ui, r, st, after);
  });
}

const FIELDS = [
  ['purpose', 'What it is for', 'Keep the quotes my suppliers send and compare them', true],
  ['page', 'The name of its page', 'Supplier quotes', false],
  ['keeps', 'What it keeps', 'quotes: supplier, item, price, date', false],
  ['tools', 'The tools it gives the agents (one a line)', 'add a quote\nlist the quotes for an item', true],
  ['leaves', 'What leaves the PC (addresses it calls, or nothing)', 'nothing', false],
];
function formFields(ui, values = {}) {
  const { h } = ui;
  const inputs = {};
  const rows = FIELDS.map(([k, label, ph, multi]) => {
    inputs[k] = multi ? h('textarea', { rows: 2, placeholder: ph, 'aria-label': label }) : h('input', { type: 'text', placeholder: ph, 'aria-label': label, style: { width: '100%' } });
    if (values[k]) inputs[k].value = values[k];
    return h('label', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'sub' }, label), inputs[k]);
  });
  return { el: h('div', { class: 'stack' }, ...rows), value: () => Object.fromEntries(Object.entries(inputs).map(([k, x]) => [k, x.value])) };
}

/** One entry, two equal choices. */
export function buildOwn(ui, st, after) {
  const { h, btn } = ui;
  const choice = (title, text, label, go) => h('div', { class: 'card', style: { flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: '8px' } }, h('h3', null, title), h('p', { class: 'sub' }, text), h('span', { class: 'grow' }), btn(label, { onClick: go }));
  const m = ui.modal({ title: 'Build your own module', wide: true, actions: [{ label: 'Cancel' }], body: h('div', { class: 'stack', style: SCROLL },
    h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', alignItems: 'stretch' } },
      choice('Build it here', 'Answer five short questions. The desk makes a working starter module at once, with no model, and checks it. Then, if you like, a model you choose writes the rest.', 'Build it here', () => { m.close(); buildHere(ui, st, after); }),
      choice('Build it with another agent', 'Download the module kit and a task sheet made from your answers. Hand both to any coding agent, get a zip back, and add it here.', 'Build it with another agent', () => { m.close(); withAgent(ui, st); })),
    h('p', { class: 'sub' }, 'Both end at the same check, and the Admin of this PC approves the module before it is added.')) });
}

function buildHere(ui, st, after) {
  const { h } = ui;
  const form = formFields(ui);
  const said = h('p', { class: 'sub' });
  ui.modal({ title: 'Build it here', wide: true, body: h('div', { class: 'stack', style: SCROLL }, form.el, said), actions: [{ label: 'Cancel' }, { label: 'Make the starter', kind: '', onClick: async () => {
    let r;
    try { r = await ui.api(API + 'build', { body: form.value() }); }
    catch (e) { said.textContent = e.message; return false; }
    setTimeout(() => showStarter(ui, r, st, after));   // after this dialog has closed
    return true;
  } }] });
}

function showStarter(ui, r, st, after) {
  const { h } = ui;
  const actions = [{ label: 'Close' }];
  // The model step has not yet made a module that passes the check on a free model, so it is not a main button: a small
  // link, under its honest label, for an owner who wants to try it.
  let tryModel = null;
  if (!r.refused && r.request) {
    actions.push({ label: 'Ask to add it', kind: '', onClick: () => ask(ui, r.request.rid, after) });
    tryModel = h('p', { class: 'sub' }, h('a', { href: '#', 'data-model-step': '', onclick: (e) => { e.preventDefault(); writeWithModel(ui, r.request, st, after); } }, 'Try the new model step'),
      ' (a model writes the rest; its work may not pass the check, and the starter stays as it is either way).');
  }
  ui.modal({ title: 'Your starter module', wide: true, body: h('div', { class: 'stack' },
    h('p', { class: 'sub' }, 'A working starter: a page that saves and lists items, and the tools you named, each saving the text it is given. The rest of what you asked for is not written yet.'),
    labelView(ui, r, st), tryModel), actions });
}

async function writeWithModel(ui, req, st, after) {
  const { h } = ui;
  const sel = h('select', { 'aria-label': 'Model' }, h('option', { value: '' }, 'Loading the models you have...'));
  const cost = h('p', { class: 'sub' });
  const said = h('p', { class: 'sub' });
  let models = [];
  ui.modal({ title: 'Write the rest with a model', wide: true, body: h('div', { class: 'stack', style: SCROLL },
    h('p', { class: 'sub', 'data-new': '' }, 'New: what a model writes may not work, and may not pass the check. The desk checks it the same way and shows what changed. Your starter stays as it is either way, and nothing is added until the Admin approves it.'),
    h('label', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'sub' }, 'The model that writes it'), sel), cost,
    h('p', { class: 'sub', 'data-advice': '' }), said),
  actions: [{ label: 'Cancel' }, { label: 'Start writing', kind: '', onClick: async () => {
    const pick = models[Number(sel.value)]; if (!pick) { said.textContent = 'Choose a model first.'; return false; }
    try {
      const r = await ui.api(API + `requests/${req.rid}/write`, { body: { provider: pick.provider, model: pick.model } });
      ui.toast(r.message);
      ui.on('job', async (j) => {
        if (j?.id !== r.jobId || ['running', 'waiting'].includes(j.status)) return;
        if (j.status !== 'done') { ui.toast(j.status === 'stopped' ? 'Stopped.' : 'The model did not finish: ' + (j.error || 'no reason was given'), 'err'); return; }
        const o = j.output || {};
        after?.();
        const fresh = o.rid ? (await ui.api(API + 'state')).requests.find((x) => x.rid === o.rid) : null;
        const body = h('div', { class: 'stack', style: { maxHeight: 'min(55vh, 560px)', overflowY: 'auto' } },
          h('p', { class: 'sub' }, o.by ? `Written by ${o.by}. ${o.text || ''}` : (o.text || '')),
          ...((o.changes || []).length ? [h('b', null, 'What changed'), ...o.changes.map((c) => h('p', { class: 'sub' }, c))] : []),
          fresh?.skipped?.length ? h('p', { class: 'sub' }, fresh.skipped.join(' ')) : null,
          labelView(ui, fresh ? { request: fresh } : { refused: true, report: o.report || {} }, st));
        const actions = [{ label: 'Close' }];
        if (fresh) actions.push({ label: 'Ask to add it', kind: '', onClick: () => ask(ui, fresh.rid, after) });
        ui.modal({ title: o.refused || !o.rid ? 'Not kept' : 'What the model wrote', wide: true, body, actions });
      });
      return true;
    } catch (e) { said.textContent = e.message; return false; }
  } }] });
  try {
    const d = await ui.api(API + 'models');
    models = d.models;
    sel.replaceChildren(...(models.length ? models.map((x, i) => h('option', { value: String(i) }, x.label)) : [h('option', { value: '' }, 'No model answers yet: add one in Models.')]));
    const show = () => { const x = models[Number(sel.value)]; cost.textContent = x ? (x.cost === 'free' ? 'Free.' : 'Cost: ' + x.cost) : ''; };
    sel.addEventListener('change', show); show();
    const adv = document.querySelector('[data-advice]'); if (adv) adv.textContent = d.advice;
  } catch (e) { sel.replaceChildren(h('option', { value: '' }, 'The models could not be read just now.')); }
}

function withAgent(ui, st) {
  const { h, btn } = ui;
  const form = formFields(ui);
  const said = h('p', { class: 'sub' });
  const kit = btn('Download the kit', { kind: 'ghost', onClick: async () => {
    try { const r = await ui.api(API + 'kit', { raw: true }); if (!r.ok) throw new Error('The kit could not be downloaded.'); await saveFile(ui, await r.blob(), 'apdesk-module-kit-0.1.zip'); said.textContent = 'The kit is in your downloads.'; }
    catch (e) { said.textContent = e.message; }
  } });
  const sheet = btn('Download the task sheet', { kind: 'ghost', onClick: async () => {
    try { const r = await ui.api(API + 'task-sheet', { body: form.value() }); await saveFile(ui, new Blob([r.text], { type: 'text/markdown' }), r.name); said.textContent = 'The task sheet is in your downloads.'; }
    catch (e) { said.textContent = e.message; }
  } });
  ui.modal({ title: 'Build it with another agent', wide: true, actions: [{ label: 'Close' }], body: h('div', { class: 'stack', style: SCROLL },
    h('ol', { class: 'sub', style: { margin: 0, paddingLeft: '20px' } },
      h('li', null, 'Hand the kit and the task sheet to any coding agent.'),
      h('li', null, 'Get a zip of the module back.'),
      h('li', null, 'Press Add a module here and choose that zip.')),
    form.el, h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, kit, sheet), said,
    h('p', { class: 'sub' }, st.kit ? `The kit is ${ui.fmt.bytes(st.kit.size)}: a guide, the rules, sample modules and the same check the desk runs.` : 'The kit is not in this copy of the desk.')) });
}

export function removeModule(ui, m, after) {
  const { h } = ui;
  const box = h('input', { type: 'checkbox', id: 'store-rm-data' });
  ui.modal({ title: `Remove ${m.name}`, body: h('div', { class: 'stack' },
    h('p', { class: 'sub' }, 'The Admin of this PC approves this first. The module is switched off everywhere and its files are kept in the desk\'s data folder.'),
    h('label', { class: 'row', style: { gap: '6px' } }, box, h('span', null, 'Also remove its data')),
    h('p', { class: 'sub' }, 'Without the tick, what it saved stays, in case you add it again.')),
  actions: [{ label: 'Cancel' }, { label: 'Ask to remove it', kind: 'stop', onClick: async () => {
    try { const r = await ui.api(API + `remove/${encodeURIComponent(m.id)}`, { body: { data: box.checked } }); ui.toast(r.message, 'ok'); after?.(); }
    catch (e) { ui.toast(e.message, 'err'); return false; }
  } }] });
}

/** A skill from a file: a SKILL.md, a folder that holds one, or one .md file. Text only; the Agents module adds it. */
export function addSkill(ui, st) {
  const { h } = ui;
  const one = h('input', { type: 'file', accept: '.md,text/markdown', 'aria-label': 'Choose a SKILL.md or one .md file' });
  const folder = h('input', { type: 'file', webkitdirectory: true, 'aria-label': 'Choose a skill folder' });
  const said = h('p', { class: 'sub' });
  const m = ui.modal({ title: 'Add a skill from a file', wide: true, actions: [{ label: 'Cancel' }], body: h('div', { class: 'stack', style: SCROLL },
    h('p', { class: 'sub' }, 'A skill is text an agent reads and follows. The desk keeps the text only: scripts and other files that come with it are left out and never run.'),
    h('label', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'sub' }, 'A SKILL.md or one .md file'), one),
    h('label', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'sub' }, 'Or a skill folder'), folder), said) });
  const go = async (files) => {
    if (!files.length) return;
    said.textContent = 'Reading...';
    const list = [];
    for (const f of files) { if (f.size > 512 * 1024) { said.textContent = `${f.name} is too large for a skill.`; return; } list.push({ path: f.webkitRelativePath || f.name, text: /\.(md|txt|json|ya?ml|csv)$/i.test(f.name) ? await f.text() : '' }); }
    let r; try { r = await ui.api(API + 'skill-check', { body: { files: list } }); } catch (e) { said.textContent = e.message; return; }
    m.close(); showSkill(ui, r);
  };
  one.addEventListener('change', () => go([...one.files]));
  folder.addEventListener('change', () => go([...folder.files]));
}

function showSkill(ui, r) {
  const { h } = ui;
  const reds = r.lines.filter((l) => l.level === 'red'); const yellows = r.lines.filter((l) => l.level === 'yellow');
  const body = h('div', { class: 'stack', style: { maxHeight: 'min(55vh, 560px)', overflowY: 'auto', paddingRight: '4px' } },
    h('h3', null, r.title || 'This skill'),
    h('p', { class: 'sub' }, r.limit),
    reds.length ? h('p', { 'data-refused': '', style: { color: 'var(--fail)', margin: 0 } }, 'Not added: the check found a red line.') : null,
    reds.length ? h('div', { class: 'stack' }, h('b', null, `Red lines (${reds.length})`), ...reds.map((l) => h('p', { class: 'sub', style: { color: 'var(--fail)' } }, l.text))) : null,
    yellows.length ? h('div', { class: 'stack' }, h('b', null, `Yellow lines to read (${yellows.length})`), ...yellows.map((l) => h('p', { class: 'sub' }, l.text))) : null,
    h('p', { class: 'sub' }, r.hiddenRemoved ? `${r.hiddenRemoved} hidden character${r.hiddenRemoved === 1 ? ' was' : 's were'} taken out.` : 'No hidden characters.'),
    r.leftOut.length ? h('p', { class: 'sub' }, 'Left out, never run: ' + r.leftOut.join(', ') + '.') : null,
    r.cut ? h('p', { class: 'sub' }, 'The text is longer than a skill holds; it is cut where the line above says.') : null,
    h('b', null, 'The whole text, as it would be added'),
    h('pre', { 'data-skill-text': '', style: { whiteSpace: 'pre-wrap', margin: 0, padding: '8px', background: 'var(--well)', borderRadius: '8px', fontSize: '12.5px' } }, r.body),
    h('p', { class: 'sub' }, r.honest));
  const actions = [{ label: 'Close' }];
  if (!reds.length) actions.push({ label: 'Add this skill', kind: '', onClick: async () => {
    if (!ui.moduleOn('agents')) { ui.toast('Switch on Agents and Skills first.', 'err'); return false; }
    try { await ui.api('m/agents/skills', { body: { title: r.title, body: r.body, description: r.description } }); ui.toast('Skill added. Tick it on an agent\'s page to use it.', 'ok'); }
    catch (e) { ui.toast(e.message, 'err'); return false; }
  } });
  ui.modal({ title: 'The skill check', wide: true, body, actions });
}
