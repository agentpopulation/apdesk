// "Build it here": a short form makes a working starter module at once, with no model, in the shape of the kit's
// hello-notes sample: one table of its own, one page with a list and an add box, one tool per line of the form (each
// saves the text it is given), deactivate, a test, and the kit's test host copied unchanged. The form's text is kept
// as data (JSON strings), never as code. The result goes through the same check and the same Admin approval as a zip.

const ID_OK = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const clean = (s, n) => String(s ?? '').replace(/[\p{Cf}\p{Cc}]/gu, ' ').replace(/[<>`\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const noAddress = (s) => s.replace(/\b(?:https?|wss?|ftp):\/\/\S*/gi, '').replace(/\s+/g, ' ').trim();
const slug = (s) => clean(s, 60).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/** The form as the Store keeps it: every field cleaned, with what could not be used said in plain words. */
export function readForm(body = {}) {
  const purpose = clean(body.purpose, 400);
  const page = clean(body.page, 24);
  const keeps = noAddress(clean(body.keeps, 200));
  const toolLines = String(body.tools ?? '').split(/\r?\n|;/).map((l) => noAddress(clean(l, 120))).filter(Boolean).slice(0, 6);
  const leaves = String(body.leaves ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const hosts = []; const notHosts = [];
  for (const raw of leaves) {
    if (/^(nothing|none|no|-)$/.test(raw)) continue;
    let h = raw; try { if (/^[a-z]+:\/\//.test(raw)) h = new URL(raw).hostname; } catch { h = ''; }
    h = h.replace(/\/.*$/, '');
    if (/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && !hosts.includes(h)) hosts.push(h); else if (h !== '*') notHosts.push(raw);
  }
  const problems = [];
  if (purpose.length < 10) problems.push('Say in a sentence what the module is for.');
  if (!page) problems.push('Give its page a short name (at most 24 letters).');
  if (page && !slug(page)) problems.push('The page name needs some plain letters or digits.');
  if (notHosts.length) problems.push(`These are not addresses the desk can name: ${notHosts.slice(0, 5).join(', ')}. Write each as a host name, such as rates.example.org, or "nothing".`);
  return { purpose, page, keeps: keeps || 'notes', tools: toolLines, hosts, problems };
}

/** A tool name from its line: "add a quote from a supplier" -> "<prefix>_add_a_quote_from". */
export function toolName(prefix, line, taken = new Set()) {
  const words = line.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 4);
  let base = (prefix + '_' + (words.join('_') || 'add')).slice(0, 60).replace(/_+$/, '');
  let name = base; let n = 2;
  while (taken.has(name)) name = `${base}_${n++}`;
  taken.add(name);
  return name;
}

/** -> { id, manifest, files: { name: text } }. used: ids and numbers the desk has (built in and added). */
export function makeStarter(form, { usedIds = [], usedNumbers = [], testhost }) {
  if (form.problems?.length) throw Object.assign(new Error(form.problems.join(' ')), { status: 400 });
  if (!testhost) throw Object.assign(new Error('The kit that comes with the desk could not be read, so no starter can be made.'), { status: 500 });
  let id = slug(form.page); const ids = new Set(usedIds); let k = 2;
  if (!ID_OK.test(id)) id = 'my-module';
  const base = id; while (ids.has(id)) id = `${base}-${k++}`;
  const nums = new Set(usedNumbers); let number = 61; while (nums.has(number) && number < 999) number++;
  const prefix = id.replace(/-/g, '_');
  const table = `m_${prefix}_items`;
  const taken = new Set();
  const tools = form.tools.map((line) => ({ name: toolName(prefix, line, taken), line }));
  let description = form.purpose.replace(/[.\s]+$/, '') + '.';
  if (description.length < 30) description += ' A starter module made in the Module Store.';
  const manifest = {
    id, number, name: form.page, description: description.slice(0, 400), kind: 'switch-on', defaultOn: false,
    menu: [{ id, label: form.page, order: 160 }], pages: [id], settings: [], agentTabs: [],
    tools: tools.map((t) => t.name), requires: [], npm: {}, hosts: form.hosts, attribution: [], status: 'stub',
  };
  const J = (v) => JSON.stringify(v);
  const server = `// ${form.page}: a starter module made in the Module Store from the kit's hello-notes shape.
// It keeps ${form.keeps} as short items in one table of its own, shows them on its page, and gives the agents
// ${tools.length ? tools.length === 1 ? 'one tool' : tools.length + ' tools' : 'no tools yet'}. Each tool only saves the text it is given: the real work is still to be written.
const MAX_TEXT = 500;

export async function activate(ctx) {
  ctx.db.migrate(1, \`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      by TEXT NOT NULL,
      created TEXT NOT NULL
    );\`);
  const list = () => ctx.db.all('SELECT id, text, by, created FROM ${table} ORDER BY created DESC, rowid DESC');
  const add = (text, by) => {
    const t = String(text ?? '').trim();
    if (!t) throw Object.assign(new Error('Write something first.'), { status: 400 });
    if (t.length > MAX_TEXT) throw Object.assign(new Error('An item is at most ' + MAX_TEXT + ' characters; this one has ' + t.length + '.'), { status: 400 });
    const item = { id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: t, by, created: new Date().toISOString() };
    ctx.db.run('INSERT INTO ${table} (id, text, by, created) VALUES (?, ?, ?, ?)', item.id, item.text, item.by, item.created);
    ctx.events.emit(${J(id)}, { change: 'added', id: item.id });
    return item;
  };

  ctx.route('GET', '/items', (req, res) => ctx.json(res, { items: list() }));
  ctx.route('POST', '/items', (req, res, { body, owner }) => {
    if (!owner) return ctx.json(res, { error: 'Items are added from the desk window.' }, 403);
    if (ctx.incognito) return ctx.json(res, { error: 'Nothing is kept in Incognito, so nothing is added here.' }, 403);
    try { ctx.json(res, { item: add(body?.text, 'you'), message: 'Saved.' }); }
    catch (e) { ctx.json(res, { error: e.message }, e.status || 500); }
  });
${tools.map((t) => `
  ctx.tool({
    name: ${J(t.name)},
    description: ${J('For the ' + form.page + ' page: ' + t.line + '. It saves the text it is given as an item.')},
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'what to save, in the owner\\'s words' } }, required: ['text'] },
    async run(args, call) {
      const item = add(args.text, call.agentId || 'an agent');
      return { ok: true, text: 'Saved: ' + item.text, id: item.id };
    },
  });`).join('\n')}

  ctx.expose({ count: () => ctx.db.get('SELECT COUNT(*) AS n FROM ${table}').n, list: () => list() });
  return { async deactivate() {} };
}
`;
  const ui = `// ${form.page}: the page, built only from the shell kit (ui) and the desk's own classes.
const API = ${J('m/' + id + '/')};

export const pages = {
  ${J(id)}: {
    title: ${J(form.page)},
    async render(el, ui) {
      const { h, card, btn, line, empty, pill, savedMark, fmt, spinner } = ui;
      const box = h('textarea', { rows: 3, maxlength: 500, 'aria-label': 'New item' });
      const mark = savedMark();
      const addBtn = btn('Add', { onClick: () => addItem() });
      const listBody = h('div', null, spinner());
      const count = pill('...');
      async function addItem() {
        addBtn.disabled = true;
        const ok = await mark.run(() => ui.api(API + 'items', { body: { text: box.value } }), { word: 'Saved' });
        addBtn.disabled = false;
        if (ok) { box.value = ''; box.focus(); await paint(); }
      }
      async function paint() {
        let d;
        try { d = await ui.api(API + 'items'); }
        catch (e) { listBody.replaceChildren(empty('The items could not be read just now: ' + e.message)); return; }
        count.textContent = d.items.length === 1 ? '1 item' : d.items.length + ' items';
        listBody.replaceChildren(...(d.items.length
          ? d.items.map((n) => line(n.text, (n.by === 'you' ? 'You' : 'Added by ' + (ui.agent(n.by)?.name || 'an agent')) + ' · ' + fmt.when(n.created)))
          : [empty(${J('Nothing kept yet. Write the first one above' + (tools.length ? ', or ask an agent in Chat.' : '.'))})]));
      }
      el.append(
        h('div', { class: 'phead' }, h('div', { class: 't' }, h('h2', null, ui.label(${J(id)}, ${J(form.page)})), h('p', { class: 'sub' }, ${J('What you keep here: ' + form.keeps + '. A starter page: it saves and lists items.')}))),
        h('div', { class: 'work', style: { flexShrink: '0' } }, h('div', { class: 'work-head' }, h('h3', null, 'New item')), h('div', { class: 'work-body' }, box, h('div', { class: 'row' }, addBtn, mark))),
        card(h('div', { class: 'row' }, h('h3', null, 'Kept here'), h('span', { class: 'grow' }), count), listBody));
      ui.on(${J(id)}, () => paint());
      await paint();
    },
  },
};
`;
  const testFile = `// ${form.page}: the starter's plumbing. It runs in a real AP Desk (npm test) and in the module kit (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openHost, hostKind } from './testhost.js';

const skip = hostKind ? false : 'no desk and no kit harness next to this module';

test('add and list an item, refuse an empty one, and only from the desk window', { skip }, async () => {
  const host = await openHost();
  try {
    assert.deepEqual((await host.call('GET', '/api/m/${id}/items')).json.items, []);
    const add = await host.call('POST', '/api/m/${id}/items', { text: '  First item  ' });
    assert.equal(add.status, 200); assert.equal(add.json.item.text, 'First item');
    assert.equal((await host.call('POST', '/api/m/${id}/items', { text: '   ' })).status, 400);
    assert.equal((await host.call('POST', '/api/m/${id}/items', { text: 'from a script' }, { owner: false })).status, 403);
    assert.equal(host.api.count(), 1);
  } finally { await host.close(); }
});
${tools.length ? `
test('the tool saves the text it is given and names the agent', { skip }, async () => {
  const host = await openHost();
  try {
    const r = await host.runTool(${J(tools[0].name)}, { text: 'From an agent' }, { agentId: 'scout' });
    assert.equal(r.ok, true);
    assert.equal((await host.call('GET', '/api/m/${id}/items')).json.items[0].by, 'scout');
  } finally { await host.close(); }
});
` : ''}`;
  return { id, manifest, files: { 'module.json': JSON.stringify(manifest, null, 1) + '\n', 'server.js': server, 'ui.js': ui, [`${id}.test.js`]: testFile, 'testhost.js': testhost } };
}

/** The filled form as a task sheet for another coding agent (markdown, plain words). */
export function taskSheet(form, { deskVersion }) {
  const lines = [
    `# A module to build for AP Desk ${deskVersion}`,
    '',
    'You are given two things: this sheet and the AP Desk module kit (apdesk-module-kit-0.1.zip). Read START-HERE.md in the kit first, then GUIDE.md and CONTRACT.md.',
    'Build the module described below in the shape of samples/hello-notes. Run the kit\'s check (node tools/check-module.mjs <folder> --run) until it has no red line, then zip the module folder and hand the zip back.',
    '',
    '## What it is for',
    form.purpose || '(not said)',
    '',
    '## The name of its page',
    form.page || '(not said)',
    '',
    '## What it keeps',
    form.keeps || '(not said)',
    '',
    '## The tools it gives the agents',
    ...(form.tools.length ? form.tools.map((t) => `- ${t}`) : ['- none']),
    '',
    '## What leaves the PC',
    ...(form.hosts.length ? form.hosts.map((h) => `- ${h} (list it under "hosts" in module.json)`) : ['- nothing: the module calls no outside address (models go through ctx.model)']),
    '',
    '## Rules that are not optional',
    '- Every outside call goes through ctx.fetch, every model call through ctx.model, every action that sends, pays or changes something outside asks through ctx.approval.',
    '- The module starts off ("defaultOn": false) and is "kind": "switch-on".',
    '- Plain short words on screen; no ids, paths or raw errors; times and money in the owner\'s zone and currency from ctx.settings.',
    '- Tests beside the code (node:test), using testhost.js from the kit unchanged.',
    '',
    'When the zip comes back, the owner presses "Add a module" in the Module Store. The desk checks it again and the Admin of the PC approves it before it is added.',
  ];
  return lines.join('\n') + '\n';
}
