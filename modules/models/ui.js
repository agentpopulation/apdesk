// Models page and the agent tab "Model".
const API = 'm/models/';
const UNSAFE = /uncensor|abliterat/i;

function css() {
  if (document.getElementById('models-css')) return;
  document.head.append(Object.assign(document.createElement('link'), { id: 'models-css', rel: 'stylesheet', href: '/modules/models/ui.css' }));
}
const initials = (s) => String(s || '?').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const secs = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(1) + ' s';
/** The last Test: a pill, and under it why it failed (or what a local model said), with the time of the test. */
function testLine(t, ui) {
  if (!t) return null;
  const when = 'tested ' + ui.fmt.when(t.at);
  if (t.ok) {
    const text = `Answers · ${secs(t.ms)} · ${t.model}`;
    return ui.h('span', { class: 'mdl-test' }, ui.h('span', { class: 'pill ok', title: `${text} · ${when}` }, text),
      t.said ? ui.h('span', { class: 'sub mdl-reason', 'data-apd': 'test-said' }, `It said: "${t.said}" · ${when}`) : null);
  }
  return ui.h('span', { class: 'mdl-test' }, ui.h('span', { class: 'pill stop' }, 'Does not answer'),
    ui.h('span', { class: 'sub mdl-reason', 'data-apd': 'test-reason' }, `${t.error || 'No reason was given.'} · ${when}`));
}

// ---------- the model picker (Models › Per agent, and the agent tab)
const enc = (p, m) => p + '\u0001' + (m || '');
function pickerSelect(ui, groups, current, { noneLabel, apd }) {
  const sel = ui.h('select', { 'aria-label': apd === 'model-main' ? 'Main model' : 'Fallback model', 'data-apd': apd });
  // The desk default names its whole chain, which does not fit a table column: the option shows the short name, the
  // full chain is its title (and the line under the table).
  const short = String(noneLabel).replace(/\s*\(.*\)$/, '');
  sel.append(ui.h('option', { value: '', title: short !== noneLabel ? noneLabel : null }, short));
  let found = !current;
  for (const g of groups) {
    const og = ui.h('optgroup', { label: g.label });
    for (const m of g.models) {
      const v = enc(g.provider, m); const on = current && current.provider === g.provider && (current.model || '') === m;
      if (on) found = true;
      const why = g.failing?.[m];
      // A model whose last real call failed is marked, and stays selectable: the quota may reset, and the door falls back anyway.
      og.append(ui.h('option', { value: v, selected: on }, (m === 'auto' ? 'auto (rotates the free models)' : m) + (why ? ` (${why})` : '')));
    }
    sel.append(og);
  }
  sel.missing = !found;
  const tip = () => { const o = sel.selectedOptions[0]; sel.title = o ? (o.title || o.textContent) : ''; };   // the whole choice, for when the box cuts it
  sel.addEventListener('change', tip); tip();
  return sel;
}
const decode = (v) => { if (!v) return null; const [provider, model] = v.split('\u0001'); return { provider, model: model || null }; };
function savedName(ui, groups, m) { if (!m) return ''; const g = groups.find(x => x.provider === m.provider); return `${g?.label || (m.provider === 'router' ? 'Free API' : m.provider.startsWith('lan:') ? 'a LAN node' : m.provider)} · ${m.model || 'auto'}`; }

function agentModelRow(ui, agent, groups, { compact = false } = {}) {
  const main = pickerSelect(ui, groups, agent.model?.main, { noneLabel: groups.defaultLabel || 'Desk default', apd: 'model-main' });
  const fb = pickerSelect(ui, groups, agent.model?.fallback, { noneLabel: 'No fallback', apd: 'model-fallback' });
  const note = ui.h('span', { class: 'sub' });
  const warn = [main.missing && `Saved main ${savedName(ui, groups, agent.model.main)} is not reachable now.`, fb.missing && `Saved fallback ${savedName(ui, groups, agent.model.fallback)} is not reachable now.`].filter(Boolean).join(' ');
  if (warn) note.textContent = warn;
  // every choice saves the moment it is made and answers with the kit's tick (or the reason, with the old choice back)
  const mark = ui.savedMark();
  const old = { main: main.value, fb: fb.value };
  const save = (sel, key) => mark.run(async () => {
    const a = await ui.api('agents/' + encodeURIComponent(agent.id), { method: 'PATCH', body: { model: { main: decode(main.value), fallback: decode(fb.value) } } });
    Object.assign(agent, a); old.main = main.value; old.fb = fb.value; if (note.textContent && !warn) note.textContent = '';
  }, { field: sel, old: old[key] });
  main.addEventListener('change', () => save(main, 'main')); fb.addEventListener('change', () => save(fb, 'fb'));
  return { main, fb, note, mark, compact };
}

async function availableGroups(ui) { const r = await ui.api(API + 'available'); const g = r.groups; g.defaultLabel = r.defaultLabel; return g; }
const groupNotes = (ui, groups) => groups.filter(g => g.note).map(g => ui.h('p', { class: 'mdl-warn', 'data-apd': 'model-note' }, g.note));

// ---------- agent tab
export const agentTabs = {
  model: {
    title: 'Model',
    async render(el, ui, agent) {
      css(); el.replaceChildren(ui.spinner());
      const groups = await availableGroups(ui);
      const r = agentModelRow(ui, agent, groups);
      const out = ui.h('div', { class: 'sub' });
      const test = ui.btn('Test this agent', { kind: 'ghost sm', onClick: async () => {
        test.disabled = true; out.textContent = 'Asking…';
        try { const t = await ui.api(API + 'test-agent', { body: { agentId: agent.id } }); out.textContent = t.ok ? `${t.label} answered in ${secs(t.ms)}${t.fallbackUsed ? ' (after a fallback)' : ''}.` : t.error; }
        catch (e) { out.textContent = e.message; } finally { test.disabled = false; }
      } });
      el.replaceChildren(ui.card({ class: 'mdl-tab' },
        ui.h('h3', null, 'Model'),
        ui.line('Main model', 'Used first for every reply', r.main),
        ui.line('Fallback', 'Used when the main model does not answer', r.fb, r.mark),
        ui.h('p', { class: 'sub' }, 'Each choice is saved as you make it.'), r.note, ...groupNotes(ui, groups), ui.h('div', { class: 'row', style: { marginTop: '8px' } }, test, out),
        ui.h('p', { class: 'sub', style: { marginTop: '8px' } }, 'Only models that answer or are installed now are offered. Every reply names the model that answered.')));
    },
  },
};

// ---------- the page
// The control-room look: Active now cards in one row, then one full-width area with tabs. The page's own layout lives
// here (the shell gives the tokens and the shared parts: .card.live, .group, .work, .box, .tabbar, .schip, .mono, .metric).
const LOOK = `
.view.mdlc{gap:14px}
.mdlc .phead h2{margin:0}
.mdl-lead{margin:0;color:var(--dim)}
.mdl-retest{display:flex;align-items:center;gap:12px;padding:6px 6px 6px 16px;background:var(--surface);border:1px solid var(--line);border-radius:99px;box-shadow:var(--shadow)}
.mdl-retest .say{font-size:13.5px;color:var(--dim)}.mdl-retest .say b{font-weight:600;color:var(--live)}.mdl-retest .say b.bad{color:var(--slow)}
.mdl-noans{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px}.mdl-noans .lbl{margin:0}.mdl-noans .pill{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.mdl-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.mdl-ac{display:flex;flex-direction:column;gap:10px;padding:14px 14px 12px;min-width:0}
.mdl-ac .top{display:flex;gap:11px;align-items:flex-start}
.mdl-ac .grow{flex:1;min-width:0}
.mdl-ac h3{margin:0;font-size:15px;line-height:1.25;overflow-wrap:anywhere}
.mdl-ac .sub{font-size:13px;margin-top:2px;overflow-wrap:anywhere}
.mdl-speed{display:flex;align-items:center;gap:10px}
.mdl-speed .k{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}
.mdl-speed .k>span{font-size:12.5px;font-weight:600;color:var(--live)}
.mdl-ac.slow .mdl-speed .k>span{color:var(--slow)}.mdl-ac.fail .mdl-speed .k>span{color:var(--fail)}.mdl-ac.off .mdl-speed .k>span{color:var(--dim)}
.mdl-gauge{height:6px;border-radius:99px;background:var(--line);overflow:hidden}
.mdl-gauge b{display:block;height:100%;border-radius:99px;background:var(--live)}
:root:not([data-theme="light"]) .mdl-gauge b{box-shadow:0 0 8px var(--live-glow)}
.mdl-ac.slow .mdl-gauge b{background:var(--slow);box-shadow:none}
.mdl-ft{margin-top:auto;display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:13px;color:var(--dim)}
.mdl-ft code{color:var(--fg);overflow-wrap:anywhere;min-width:0}.mdl-ft .said q{color:var(--fg);font-weight:600}
.mdl-ft .why{color:var(--fail);overflow-wrap:anywhere;min-width:0}
.mdl-area{padding:0;display:flex;flex-direction:column;min-width:0}
.mdl-tabbody{padding:14px;min-width:0}
.mdl-split{display:grid;grid-template-columns:minmax(280px,360px) minmax(0,1fr);gap:14px;align-items:start}
.mdl-list{display:flex;flex-direction:column;gap:12px;min-width:0}
.mdl-grp h4{margin:0 0 6px 4px;font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.mdl-pv{display:flex;align-items:center;gap:11px;width:100%;text-align:left;min-width:0}
.mdl-pv .n{flex:1;min-width:0;font-size:14px;font-weight:500;overflow-wrap:anywhere}
.mdl-pv .n small{display:block;font-weight:400;color:var(--dim);font-size:12.5px}
.mdl-pv .chev{color:var(--faint);flex-shrink:0}
.mdl-work .work-head .grow{flex:1;min-width:0}.mdl-work .work-head .sub{font-size:13px}
.mdl-wb{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px;align-items:start}
.mdl-wb .box h5{margin:0;font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.mdl-keyrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 11px;padding:10px 12px;border-radius:var(--r-s);background:var(--well);border:1px solid var(--line)}
.mdl-keyrow.ok{background:var(--live-soft);border-color:color-mix(in srgb,var(--live) 35%,transparent)}
.mdl-keyrow.fail{background:var(--stop-soft);border-color:color-mix(in srgb,var(--fail) 35%,transparent)}
.mdl-tick{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;flex-shrink:0;background:var(--line-strong);color:var(--surface)}
.mdl-tick svg{width:14px;height:14px}
.mdl-keyrow.ok .mdl-tick{background:var(--live)}.mdl-keyrow.fail .mdl-tick{background:var(--fail)}
:root:not([data-theme="light"]) .mdl-keyrow.ok .mdl-tick{color:#04261a;box-shadow:0 0 12px var(--live-glow)}
.mdl-keyrow .n{flex:1 1 200px;min-width:0;font-size:13.5px;overflow-wrap:anywhere}
.mdl-keyrow .n b{display:block;font-size:14px;font-weight:600}.mdl-keyrow .n span{color:var(--dim)}
.mdl-keyrow .n em{font-style:normal;font-weight:600;color:var(--dim)}
.mdl-keyrow.ok .n em{color:var(--live)}.mdl-keyrow.fail .n em{color:var(--fail)}.mdl-keyrow.run .n em{color:var(--info)}
.mdl-kact{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.mdl-kact .seg button{padding:3px 9px;font-size:12.5px}
.mdl-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) auto;gap:10px;align-items:end}
.mdl-fields.wide{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr)}
.mdl-f{display:flex;flex-direction:column;gap:5px;min-width:0}
.mdl-f>span{font-size:12.5px;font-weight:500;color:var(--dim)}
.mdl-f input{width:100%;min-width:0}
.mdl-save{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mdl-opt{display:flex;align-items:center;gap:12px}.mdl-opt .n{flex:1;min-width:0}.mdl-opt .n b{display:block;font-size:14px;font-weight:600}.mdl-opt .n span{color:var(--dim);font-size:13px}
.mdl-def{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.mdl-def>span{color:var(--dim);font-size:13px}.mdl-def code{overflow-wrap:anywhere;min-width:0}
.mdlc .mdl-mlist{max-width:none;background:var(--well);max-height:260px}
.mdlc .mdl-mq{max-width:none}
.mdlc .mdl-mopt{padding:7px 10px}.mdlc .mdl-mopt .mdl-mid{font-family:var(--mono);font-size:13px}
.mdlc .mdl-mopt[aria-selected=true]{background:var(--brand-soft);font-weight:600}.mdlc .mdl-mopt[aria-selected=true] .mdl-mid{color:var(--brand)}
.mdl-note{font-size:13px;color:var(--dim);margin:0}
.mdl-agents{width:100%}.mdl-agents td{vertical-align:middle}.mdl-agents select{width:100%;max-width:340px}
.mdl-agents td.mk{width:90px}
@media (min-width:1700px){.mdl-split{grid-template-columns:600px minmax(0,1fr)}.mdl-list{display:block;columns:2;column-gap:14px}.mdl-list .mdl-grp{break-inside:avoid;margin-bottom:14px}.mdl-ac h3{font-size:16.5px}.mdl-ac{padding:18px 18px 14px}}
@media (max-width:1240px){.mdl-wb{grid-template-columns:1fr}}
@media (max-width:820px){.mdl-split{grid-template-columns:1fr}}
@media (max-width:600px){.mdl-retest{width:100%;border-radius:var(--r);flex-wrap:wrap;padding:10px 12px}.mdl-retest .say{flex:1}.mdl-cards{grid-template-columns:1fr}.mdl-tabbody{padding:10px}.mdl-fields,.mdl-fields.wide{grid-template-columns:1fr}.mdl-work>.work-body{padding:10px}.mdl-keyrow .n{flex:1 1 150px}.mdl-inrow{padding:6px!important}.mdl-agents td.mk{width:auto}}
`;
function look() {
  if (document.getElementById('models-look')) return;
  document.head.append(Object.assign(document.createElement('style'), { id: 'models-look', textContent: LOOK }));
}
// a provider's mark: its letters on its own gradient (never a real logo)
const MONO = { router: '', ollama: 'ol', llama: 'ol', openrouter: 'or', gemini: 'gg', groq: 'gq', mistral: 'mi', cerebras: 'cb', serper: 'se', tavily: 'ta' };
const HUES = ['or', 'gg', 'gq', 'mi', 'cb', 'se', 'ta', 'ol'];
const monoClass = (id) => id in MONO ? MONO[id] : HUES[[...String(id)].reduce((s, c) => s + c.charCodeAt(0), 0) % HUES.length];
// two letters always: a one-word name gives its first two ("Groq" GR), a known one its usual pair ("OpenRouter" OR)
const LETTERS = { router: 'AP', openrouter: 'OR', groq: 'GQ', gemini: 'GG', mistral: 'MI', cerebras: 'CB', ollama: 'OL', llama: 'LC', serper: 'SE', tavily: 'TA', lan: 'LN' };
const letters = (id, name) => LETTERS[id] || (initials(name).length > 1 ? initials(name) : String(name || id).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase());
const mono = (ui, id, name, small) => ui.h('span', { class: 'mono ' + (small ? 's ' : '') + monoClass(id), 'aria-hidden': 'true' }, letters(id, name));
const SLOW_MS = 8000;
const OK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.4 6.6 11.3 12.5 4.9"/></svg>';
const NO_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
/** What a key's last test says, in the words on its row. */
function keyWords(t, testing) {
  if (testing) return { kind: 'run', text: 'Testing this key…' };
  if (!t) return { kind: '', text: 'Not tested yet' };
  if (t.ok) return { kind: 'ok', text: `Key works, answered in ${secs(t.ms)}` };
  if (t.skipped) return { kind: '', text: t.error };
  return { kind: 'fail', text: t.error || 'It did not answer.' };
}
function keyRow(ui, { label, sub, test, testing, actions }) {
  const w = keyWords(test, testing);
  const mark = ui.h('span', { class: 'mdl-tick', 'aria-hidden': 'true' });
  if (w.kind === 'run') mark.append(ui.spinner()); else mark.innerHTML = w.kind === 'fail' ? NO_SVG : w.kind === 'ok' ? OK_SVG : '';
  return ui.h('div', { class: 'mdl-keyrow ' + w.kind, 'data-apd': 'key-row' }, mark,
    ui.h('div', { class: 'n' }, ui.h('b', null, label), ui.h('span', null, sub + ' · '), ui.h('em', { 'data-apd': 'key-result', title: test?.at ? 'tested ' + ui.fmt.when(test.at) : null }, w.text)),
    ui.h('div', { class: 'mdl-kact' }, ...actions.filter(Boolean)));
}
/** Whether another key on the same service is on and not resting, so a resting one is covered. */
const otherKey = (k, keys) => (keys || []).some(o => o.id !== k.id && o.enabled && !o.resting);
const restWords = (k, keys) => !k.resting ? '' : (k.resting === 'refused' ? ' · refused' : ' · resting') + (otherKey(k, keys) ? ', the next key is used' : ', no other key to use');
/** A key's last test, without the sentence about the next key when there is none. */
const lastKeyTest = (k, keys) => k.test && !otherKey(k, keys) && /next key/i.test(k.test.error || '') ? { ...k.test, error: k.test.error.replace(/\s*The next key is used[^.]*\.?/i, '') } : k.test;
const field = (ui, label, input) => ui.h('label', { class: 'mdl-f' }, ui.h('span', null, label), input);

export const pages = {
  models: {
    title: 'Models',
    async render(el, ui) {
      css(); look();
      el.classList.add('mdlc', 'scroll');
      const st = { tab: 0, open: null, data: null, groups: [], hw: null, ollama: null, loras: null, ll: null, usage: null, jobs: {}, testing: {}, autoDone: new Set(), many: false };
      const head = ui.h('div', { class: 'phead' });
      const act = ui.h('div', { class: 'mdl-cards', 'data-apd': 'active-cards' });
      const body = ui.h('div', { class: 'mdl-tabbody' });
      body.addEventListener('focusout', () => setTimeout(() => { if (st.dirty && st.tab === 0 && !body.contains(document.activeElement)) { st.dirty = false; drawProviders(); } }, 0));
      const TABS = ['Providers and keys', 'Per agent', 'Router', 'Local models', 'LoRAs', 'Nodes', 'Usage'];
      const tabs = ui.h('div', { class: 'tabbar', role: 'tablist' }, TABS.map((t, i) => ui.h('button', { type: 'button', role: 'tab', 'aria-selected': String(i === 0), onclick: () => goTab(i) }, t)));
      const goTab = (i) => { st.tab = i; [...tabs.children].forEach((b, k) => b.setAttribute('aria-selected', String(k === i))); drawTab(); };
      el.replaceChildren(head, ui.h('div', { class: 'lbl' }, 'Active now'), act, ui.card({ class: 'mdl-area' }, tabs, body));

      const set = async (patch) => { await ui.api('settings', { body: patch }); Object.assign(ui.state.settings, patch); };
      async function load() {
        const [d, g, sv] = await Promise.all([ui.api(API + 'overview'), availableGroups(ui), ui.api(API + 'services').catch(() => ({ services: [], many: false }))]);
        st.data = d; st.groups = g; st.services = sv.services || []; st.many = !!sv.many;
        if (!st.open) st.open = d.providers.find(p => p.keys.length)?.id || 'openrouter';
        drawHead(); drawActive();
        // never redraw under the owner's typing: a field being filled in waits until he leaves it
        if (st.tab === 0) { if (body.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) st.dirty = true; else drawProviders(); }
        autoLocal();
      }
      /** One test with the footer line saying what runs; the page is drawn again when it ends. */
      async function testing(text, fn) { const end = ui.announce(text); try { return await fn(); } finally { end(); } }

      // ----- header: the page title, and Test all with how the last one went
      function drawHead() {
        const d = st.data; const live = d.active.filter(a => a.ok).length; const s = d.testAll;
        const say = ui.h('span', { class: 'say', 'data-apd': 'test-all-result' });
        if (s) say.append(ui.h('b', { class: s.ok === s.total ? '' : 'bad' }, s.ok === s.total ? `All ${s.total} answered` : `${s.ok} of ${s.total} answered, ${s.total - s.ok} did not`), ` · tested ${ui.fmt.when(s.at)}`);
        else say.textContent = 'Not tested yet';
        const testAll = ui.btn(s ? 'Test again' : 'Test all', { 'data-apd': 'test-all', onClick: async () => {
          testAll.disabled = true; testAll.textContent = 'Testing…';
          try { await testing('Testing every active model…', () => ui.api(API + 'test-all', { method: 'POST' })); await load(); }
          catch (e) { ui.toast(e.message, 'err'); testAll.disabled = false; testAll.textContent = s ? 'Test again' : 'Test all'; }
        } });
        head.replaceChildren(
          ui.h('div', { class: 't' },
            ui.h('div', { class: 'row' }, ui.h('h2', null, 'Models'), ui.statusChip(`${live} active`, live ? 'live' : 'off'), ui.statusChip(d.online ? 'Online' : 'Offline', d.online ? 'live' : 'slow')),
            ui.h('p', { class: 'mdl-lead' }, d.online ? 'Only models that answer or are installed now are offered. Every reply names the model that answered.' : 'Offline: only models on this PC and LAN nodes answer. Nothing leaves your network.')),
          ui.h('div', { class: 'mdl-retest' }, say, testAll));
      }
      function testBtn(args, after, { label } = {}) {
        const b = ui.btn('Test', { kind: 'ghost sm', onClick: async () => {
          b.disabled = true; b.textContent = 'Testing…';
          // a local model that is not in memory yet is loaded by its first call, which can take a minute or two
          if (args.provider === 'llama') ui.api('local-engine').then(r => { if (r.phase !== 'running' && b.disabled) { b.textContent = 'Starting the local model…'; b.title = 'Its first call loads it into memory. This can take a minute or two on a laptop.'; } }).catch(() => {});
          if (args.provider === 'ollama') ui.api(API + 'ollama/loaded' + (args.model ? '?model=' + encodeURIComponent(args.model) : '')).then(r => { if (!r.loaded && b.disabled) { b.textContent = 'Loading the model…'; b.title = 'A local model\'s first call loads it into memory. This can take a minute or two on a laptop.'; } }).catch(() => {});
          if (args.keyId) { st.testing[args.keyId] = true; }
          try { const r = await testing(`Testing ${label || 'the model'}…`, () => ui.api(API + 'test', { body: args })); if (!args.keyId) ui.toast(r.ok ? `${r.label} answered in ${secs(r.ms)}` : `${r.label}: ${r.error}`, r.ok ? 'ok' : 'err'); }
          catch (e) { ui.toast(e.message, 'err'); } finally { delete st.testing[args.keyId]; b.disabled = false; b.textContent = 'Test'; b.title = ''; await (after || load)(); }
        } });
        return b;
      }
      // a local model that is found or installed tests itself once, so its card shows whether it answers
      function autoLocal() {
        for (const a of st.data.active) {
          if (!(a.provider === 'ollama' || a.provider === 'llama') || !a.ok || a.test || st.autoDone.has(a.provider)) continue;
          if (a.provider === 'ollama' && !(a.models || []).length) continue;
          st.autoDone.add(a.provider);
          testing('Testing the local model…', () => ui.api(API + 'test', { body: { provider: a.provider, auto: true } })).then(() => load()).catch(() => {});
        }
      }

      // ----- Active now: one card each, the answer time large, a speed bar, slow shown apart from fast
      function drawActive() {
        const d = st.data; const rs = d.router;
        const cards = d.active.filter(a => !a.refused);
        const noAnswer = d.active.filter(a => a.refused);
        act.replaceChildren(...cards.map(a => {
          let sub;
          if (a.provider === 'router') sub = rs.mode === 'owner' ? `Your own router · ${rs.models.length} model${rs.models.length === 1 ? '' : 's'}` : rs.mode === 'builtin' ? `Built-in, no sign-in · ${rs.upstreams.filter(u => u.enabled).length} free hosts` : rs.line;
          else if (a.provider === 'llama') sub = a.ok ? `${a.name} · ${a.running ? 'running now' : 'starts when needed'}` : 'Switched off on the Local models tab.';
          else if (a.kind === 'local') sub = a.ok ? `${a.models.length} installed${a.model ? ' · ' + a.model : ''}` : 'Not running. Start Ollama on this PC.';
          else if (a.kind === 'lan') sub = `LAN node · ${a.model || 'auto'}`;
          else sub = `${a.keys} key${a.keys === 1 ? '' : 's'} on · ${a.model}`;
          if (!d.online && a.kind !== 'local' && a.kind !== 'lan') sub = 'Off while the desk is offline';
          const t = a.test; const slow = t?.ok && t.ms >= SLOW_MS;
          const kind = !a.ok ? 'off' : !t ? 'off' : !t.ok ? (t.skipped ? 'off' : 'fail') : slow ? 'slow' : 'live';
          const word = !a.ok ? 'Not available now' : !t ? 'Not tested yet' : t.ok ? (slow ? 'Answers · slow' : 'Answers') : t.skipped ? 'Not tested' : 'Does not answer';
          const name = a.provider === 'ollama' ? 'Ollama on this PC' : a.label;
          const foot = t?.ok ? (t.said ? ui.h('span', { class: 'said', 'data-apd': 'test-said' }, 'It said: ', ui.h('q', null, t.said)) : ui.h('code', null, t.model || a.model || ''))
            : t ? ui.h('span', { class: t.skipped ? '' : 'why', 'data-apd': 'test-reason' }, t.error || 'No reason was given.') : ui.h('code', null, a.model || '');
          return ui.card({ class: 'mdl-ac ' + kind, 'data-apd': 'active-card', 'data-provider': a.provider },
            ui.h('div', { class: 'top' }, mono(ui, a.provider === 'llama' || a.provider === 'ollama' ? a.provider : a.provider.startsWith('lan:') ? 'lan' : a.provider, name),
              ui.h('div', { class: 'grow' }, ui.h('h3', null, name), ui.h('div', { class: 'sub' }, sub)),
              a.provider === 'router' ? ui.sw(rs.enabled, 'Free models', async (on) => { await set({ 'router.enabled': on }); await load(); }) : slow ? ui.statusChip('Slow', 'slow') : null),
            ui.h('div', { class: 'well mdl-speed', title: t?.at ? 'tested ' + ui.fmt.when(t.at) : null },
              t?.ok ? ui.h('span', { class: 'metric' }, (Math.max(0, t.ms) / 1000).toFixed(1), ui.h('small', null, 's')) : null,
              ui.h('div', { class: 'k' }, ui.h('span', null, word), ui.h('div', { class: 'mdl-gauge', 'aria-hidden': 'true' }, ui.h('b', { style: { width: t?.ok ? Math.round(Math.max(0.04, Math.min(1, t.ms / 15000)) * 100) + '%' : '0%' } })))),
            ui.h('div', { class: 'mdl-ft' }, foot, a.ok || a.provider !== 'ollama' ? testBtn({ provider: a.provider }, null, { label: name }) : null));
        }), ...(noAnswer.length ? [ui.h('div', { class: 'mdl-noans', 'data-apd': 'not-answering' }, ui.h('span', { class: 'lbl' }, 'Does not answer'),
          ...noAnswer.map(a => ui.h('span', { class: 'pill stop', 'data-provider': a.provider, title: a.test?.error || null }, `${a.label} · ${a.test?.error || 'The key was refused.'}`)))] : []));
      }

      // ----- Providers and keys: the grouped list, and the open one's work panel
      function drawProviders() {
        const d = st.data; const rs = d.router; const svcs = st.services || [];
        const narrow = window.matchMedia('(max-width:820px)').matches;
        const work = st.open?.startsWith('svc:') ? serviceWork(svcs.find(v => 'svc:' + v.id === st.open)) : providerWork(d.providers.find(p => p.id === st.open));
        const chev = () => ui.h('span', { class: 'chev', 'aria-hidden': 'true', html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 3 5 5-5 5"/></svg>' });
        const row = (key, id, name, small, chip) => {
          const open = st.open === key;
          const b = ui.h('button', { type: 'button', class: 'mdl-pv' + (open ? ' open' : ''), 'aria-expanded': String(open), 'data-apd': 'provider-row', onclick: () => { st.open = key; drawProviders(); showWork(); } },
            mono(ui, id, name, true), ui.h('span', { class: 'n' }, name, small ? ui.h('small', null, small) : null), chip, open ? chev() : null);
          return open && narrow && work ? [b, ui.h('div', { class: 'mdl-inrow', style: { padding: '10px', background: 'var(--work)' } }, work)] : [b];
        };
        const keyChip = (keys) => { const on = keys.filter(k => k.enabled); const good = on.some(k => k.test?.ok); const bad = on.length && on.every(k => k.test && !k.test.ok && !k.test.skipped);
          return !keys.length ? ui.pill('No key') : bad ? ui.pill('Key refused', 'stop') : ui.pill(`${keys.length} key${keys.length > 1 ? 's' : ''}`, good || !on.length ? (on.length ? 'ok' : '') : ''); };
        const provRow = (p) => row(p.id, p.id, p.name, p.paidOn ? 'Paid models are on' : p.paid === 'always' ? 'Paid API' : null, keyChip(p.keys));
        const svcRow = (v) => row('svc:' + v.id, v.id, v.name, null, v.keys?.length ? keyChip(v.keys) : ui.pill(v.fromEnvironment ? 'From environment' : 'No key', v.fromEnvironment ? 'ok' : ''));
        const grp = (title, rows) => rows.length ? ui.h('div', { class: 'mdl-grp' }, ui.h('h4', null, title), ui.h('div', { class: 'group' }, ...rows)) : null;
        const free = d.providers.filter(p => p.tier === 'free-signup'); const paid = d.providers.filter(p => p.tier !== 'free-signup');
        const list = ui.h('div', { class: 'mdl-list' },
          grp('Free, no sign-in', [ui.h('div', { class: 'mdl-pv' }, mono(ui, 'router', 'AP', true), ui.h('span', { class: 'n' }, rs.shortName || 'Free API', ui.h('small', null, rs.mode === 'owner' ? 'your own router' : rs.mode === 'builtin' ? 'built-in free hosts' : 'off')),
            ui.btn('Settings', { kind: 'ghost sm', onClick: () => goTab(2) }), ui.sw(rs.enabled, 'Free models', async (on) => { await set({ 'router.enabled': on }); await load(); }))]),
          grp('Free with sign-up', free.flatMap(provRow)),
          grp('Paid', paid.flatMap(provRow)),
          grp('Search and reading', svcs.filter(v => v.kind === 'search').flatMap(svcRow)),
          grp('Voice and audio', svcs.filter(v => v.kind !== 'search').flatMap(svcRow)));
        body.replaceChildren(ui.h('div', { class: 'mdl-split' }, list, narrow ? null : work));
      }
      // the open one's work panel is brought into sight when its row is far down the list
      const showWork = () => { const w = body.querySelector('[data-apd="work-panel"]'); if (!w) return; const r = w.getBoundingClientRect(); if (r.top < 0 || r.top > window.innerHeight - 120) w.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
      /** Save a new key, then test it by itself at once; the footer says so while it runs. */
      async function saveThenTest(btn, mark, save, test, name) {
        btn.disabled = true;
        const ok = await mark.run(save, { word: 'Saved. Testing it now…' });
        btn.disabled = false;
        if (!ok) return;
        await load();
        const k = ok && mark._key;
        if (k) { st.testing[k] = true; drawProviders(); }
        try { await testing(`Testing the ${name} key…`, test); } catch (e) { ui.toast(e.message, 'err'); }
        finally { if (k) delete st.testing[k]; await load(); }
      }
      function workPanel(id, name, sub, chip, boxes) {
        return ui.h('div', { class: 'work mdl-work', 'data-apd': 'work-panel' },
          ui.h('div', { class: 'work-head' }, mono(ui, id, name), ui.h('div', { class: 'grow' }, ui.h('h3', null, name), ui.h('div', { class: 'sub' }, sub)), chip),
          ui.h('div', { class: 'work-body' }, ui.h('div', { class: 'mdl-wb' }, ...boxes)));
      }
      // the head says whether the provider answers: any key that works says yes; else the newest result
      const headChip = (keys) => { const all = keys.filter(k => k.enabled && k.test).map(k => k.test).sort((a, b) => String(b.at).localeCompare(String(a.at))); const t = all.find(x => x.ok) || all[0];
        return !t ? null : t.ok ? ui.statusChip(`Answers · ${secs(t.ms)}`, t.ms >= SLOW_MS ? 'slow' : 'live') : t.skipped ? ui.statusChip('Not tested', 'off') : ui.statusChip('Does not answer', 'fail'); };
      function providerWork(p) {
        if (!p) return null;
        const label = ui.h('input', { type: 'text', placeholder: 'Work key', 'aria-label': 'Label' });
        const value = ui.h('input', { type: 'password', placeholder: 'Paste the key', autocomplete: 'off', 'aria-label': 'Key' });
        const base = p.id === 'cloudflare' ? ui.h('input', { type: 'text', placeholder: 'Base URL with your account id' }) : p.id === 'custom' ? ui.h('input', { type: 'text', placeholder: 'http://127.0.0.1:4000/v1' }) : null;
        const cmodel = p.id === 'custom' ? ui.h('input', { type: 'text', placeholder: 'Model name' }) : null;
        const mark = ui.savedMark();
        const add = ui.btn('Save key', { 'data-apd': 'save-key', onClick: () => saveThenTest(add, mark, async () => {
          const k = await ui.api(API + 'keys', { body: { provider: p.id, value: value.value, label: label.value, baseUrl: base?.value, model: cmodel?.value } });
          value.value = ''; label.value = ''; mark._key = k.id; return true;
        }, () => ui.api(API + 'test', { body: { provider: p.id, keyId: mark._key, auto: true } }), p.name) });
        // the owner tells the desk whether a key is free: then its calls cost nothing; paid prices them at the list price; not sure leaves the cost unknown
        const TIERS = [['Free tier', 'free'], ['Paid', 'paid'], ['Not sure', null]];
        const tierChoice = (k) => ui.h('span', { class: 'ktier', title: 'Is this key charged?' },
          ui.seg(TIERS.map(o => o[0]), Math.max(0, TIERS.findIndex(([, v]) => v === (k.tier || null))), async (_, i) => { try { await ui.api(API + `keys/${encodeURIComponent(k.id)}/tier`, { body: { tier: TIERS[i][1] } }); await load(); } catch (e) { ui.toast(e.message, 'err'); } }));
        const rows = p.keys.map(k => keyRow(ui, { label: k.fromEnv ? 'Key from the environment' : k.label, sub: k.fromEnv ? 'this run only, not saved' : 'added ' + ui.fmt.date(k.created), test: k.test, testing: st.testing[k.id],
          actions: [tierChoice(k), k.fromEnv ? null : ui.sw(k.enabled, k.label, async (on) => { await ui.api(API + `keys/${encodeURIComponent(k.id)}/toggle`, { body: { on } }); await load(); }),
            testBtn({ provider: p.id, keyId: k.id }, null, { label: `the ${p.name} key` }),
            k.fromEnv ? null : ui.btn('Remove', { kind: 'ghost sm', onClick: async () => { if (!await ui.confirm(`Remove ${k.label} from ${p.name}?`, { ok: 'Remove' })) return; await ui.api(API + 'keys/' + encodeURIComponent(k.id), { method: 'DELETE' }); await load(); } })] }));
        const paid = p.paid === 'switch' ? ui.h('div', { class: 'mdl-opt', 'data-apd': 'paid-switch' }, ui.h('div', { class: 'n' }, ui.h('b', null, 'Paid models'), ui.h('span', null, p.paidOn ? 'On: every model is listed and may be used; paid ones are marked Paid. Your spend limits still apply.' : 'Off: only free models are listed and used.')),
          ui.sw(p.paidOn, 'Paid models', async (on) => {
            if (on && !await ui.confirm(`This key may be charged by ${p.name}. Your spend limits still apply.`, { title: 'Switch on paid models?', ok: 'Switch on' })) return false;
            await ui.api('settings/paid-models', { body: { provider: p.id, on } }); ui.state.settings['openrouter.allowPaid'] = on; await load();
          }))
          : p.paid === 'always' ? ui.h('p', { class: 'mdl-note', 'data-apd': 'paid-api' }, ui.pill('Paid API'), ' Adding a key means paying for what it uses. Your spend limits still apply.')
          : p.paid === 'account' ? ui.h('p', { class: 'mdl-note', 'data-apd': 'billing-note' }, `Free or paid depends on your own account with ${p.name}. The desk cannot see or control its billing.`) : null;
        return workPanel(p.id, p.name, `${p.tier === 'free-signup' ? 'Free with sign-up' : 'Paid'} · ${p.keys.length ? `${p.keys.length} key${p.keys.length > 1 ? 's' : ''}` : 'no key yet'}`, headChip(p.keys), [
          ui.h('div', { class: 'box' }, ui.h('h5', null, 'Keys'),
            ...(rows.length ? rows : [ui.h('p', { class: 'mdl-note' }, 'No key yet. A key is tested by itself the moment you save it.')]),
            ui.h('div', { class: 'mdl-fields' + (base ? ' wide' : '') }, field(ui, 'Label', label), field(ui, 'Key', value), base ? field(ui, 'Base URL', base) : null, cmodel ? field(ui, 'Model', cmodel) : null, base ? null : add),
            ui.h('div', { class: 'mdl-save' }, base ? add : null, mark),
            ui.h('p', { class: 'mdl-note' }, 'Your data: ', p.terms, p.signup ? [' ', ui.h('a', { href: p.signup, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key')] : null)),
          ui.h('div', { class: 'box' }, ui.h('h5', null, 'Models'), paid, modelBox(p))]);
      }
      function serviceWork(v) {
        if (!v) return null;
        const label = ui.h('input', { type: 'text', placeholder: 'Work account', 'aria-label': 'Label' });
        const value = ui.h('input', { type: 'password', placeholder: v.hasKey ? 'Paste another key' : 'Paste the key', autocomplete: 'off', 'aria-label': 'Key' });
        const mark = ui.savedMark();
        const svc = (p, o) => ui.api(API + 'services/' + p, o);
        const add = ui.btn('Save key', { 'data-apd': 'save-service-key', onClick: () => {
          if (!value.value.trim()) { mark.fail('paste the key first'); return; }
          if (!st.many) return mark.run(async () => { await ui.api('keys/services/' + encodeURIComponent(v.id), { body: { value: value.value.trim() } }); value.value = ''; await load(); });
          return saveThenTest(add, mark, async () => { const k = await svc(encodeURIComponent(v.id) + '/keys', { body: { value: value.value.trim(), label: label.value } }); value.value = ''; label.value = ''; mark._key = k.id; return true; },
            () => svc(`${encodeURIComponent(v.id)}/keys/${encodeURIComponent(mark._key)}/test`, { method: 'POST' }), v.name.replace(/\s*\(.*\)$/, ''));
        } });
        const name = v.name.replace(/\s*\(.*\)$/, '');
        const tBtn = (k) => { const b = ui.btn('Test', { kind: 'ghost sm', onClick: async () => {
          b.disabled = true; st.testing[k.id] = true; drawProviders();
          try { await testing(`Testing the ${name} key…`, () => svc(`${encodeURIComponent(v.id)}/keys/${encodeURIComponent(k.id)}/test`, { method: 'POST' })); } catch (e) { ui.toast(e.message, 'err'); }
          finally { delete st.testing[k.id]; await load(); }
        } }); return b; };
        const rows = (v.keys || []).map(k => keyRow(ui, { label: k.label, sub: 'added ' + ui.fmt.date(k.created) + restWords(k, v.keys), test: lastKeyTest(k, v.keys), testing: st.testing[k.id],
          actions: st.many ? [ui.sw(k.enabled, k.label, async (on) => { await svc('keys/' + encodeURIComponent(k.id) + '/toggle', { body: { on } }); await load(); }), tBtn(k),
            ui.btn('Remove', { kind: 'ghost sm', onClick: async () => { if (!await ui.confirm(`Remove ${k.label} from ${name}?`, { ok: 'Remove' })) return; await svc('keys/' + encodeURIComponent(k.id), { method: 'DELETE' }); await load(); } })]
            : [ui.sw(v.enabled, v.name, async (on) => { await ui.api('keys/services/' + encodeURIComponent(v.id), { body: { enabled: on } }); await load(); }),
              ui.btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm(`Remove the ${name} key?`, { ok: 'Remove' })) { await ui.api('keys/services/' + encodeURIComponent(v.id), { method: 'DELETE' }); await load(); } } })] }));
        if (v.fromEnvironment) rows.push(keyRow(ui, { label: 'Key from the environment', sub: 'this run only, not saved', test: null, actions: [] }));
        return workPanel(v.id, v.name, `${v.kind === 'search' ? 'Search and reading' : 'Voice and audio'} · ${(v.keys || []).length ? `${v.keys.length} key${v.keys.length > 1 ? 's' : ''}` : v.fromEnvironment ? 'key from the environment' : 'no key yet'}`, headChip(v.keys || []), [
          ui.h('div', { class: 'box' }, ui.h('h5', null, 'Keys'),
            ...(rows.length ? rows : [ui.h('p', { class: 'mdl-note' }, st.many ? 'No key yet. A key is tested by itself the moment you save it.' : 'No key yet.')]),
            ui.h('div', { class: 'mdl-fields' }, st.many ? field(ui, 'Label', label) : null, field(ui, 'Key', value), add),
            ui.h('div', { class: 'mdl-save' }, mark),
            st.many ? ui.h('p', { class: 'mdl-note', 'data-apd': 'several-keys' }, 'Several keys help when they come from accounts or plans you are allowed to hold; a provider\'s terms may forbid extra free accounts.') : null),
          ui.h('div', { class: 'box' }, ui.h('h5', null, 'About'),
            ui.h('p', { class: 'mdl-note' }, v.kind === 'search' ? 'Used by search and page reading, not by chat. Search works without it.' : 'Used by the voice module, not by chat.'),
            v.free ? ui.h('p', { class: 'mdl-note' }, 'Free allowance: ', v.free, '.') : null,
            st.many && v.spends ? ui.h('p', { class: 'mdl-note', 'data-apd': 'test-spends' }, v.spends, ' When a key is refused or its allowance runs out, the next key is used.') : null,
            st.many ? null : ui.h('p', { class: 'mdl-note' }, 'One key per service on this desk.'),
            v.signup ? ui.h('p', { class: 'mdl-note' }, ui.h('a', { href: v.signup, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key')) : null)]);
      }
      /** The Default model box: every model the provider gives, searchable, marked Free or Paid where it says. */
      function modelBox(p) {
        const q = ui.h('input', { type: 'search', placeholder: 'Type to filter', 'aria-label': `Filter ${p.name} models`, class: 'mdl-mq' });
        const list = ui.h('div', { class: 'mdl-mlist', role: 'listbox', 'aria-label': `${p.name} models`, 'data-apd': 'model-list' });
        const info = ui.h('div', { class: 'sub mdl-minfo', 'data-apd': 'model-info' }, 'Reading the list…');
        const cur = ui.h('code', { class: 'mdl-mcur' }, p.defaultModel || 'none');
        const mark = ui.savedMark();
        let all = [];
        const choose = (id) => mark.run(async () => { await set({ [`provider.${p.id}.model`]: id || null }); p.defaultModel = id; cur.textContent = id || 'none'; paint(); });
        const paint = () => {
          const f = q.value.trim().toLowerCase();
          const hits = f ? all.filter(m => m.id.toLowerCase().includes(f)) : all;
          const rows = hits.map(m => ui.h('button', { type: 'button', class: 'mdl-mopt', role: 'option', 'aria-selected': String(m.id === p.defaultModel), title: m.id, onclick: () => choose(m.id) },
            ui.h('span', { class: 'mdl-mid' }, m.id), m.price ? ui.h('span', { class: 'pill' + (m.price === 'free' ? ' ok' : ' wait') }, m.price === 'free' ? 'Free' : 'Paid') : null));
          const typed = q.value.trim();
          if (typed && !all.some(m => m.id === typed)) rows.push(ui.h('button', { type: 'button', class: 'mdl-mopt', onclick: () => choose(typed) }, ui.h('span', { class: 'mdl-mid' }, `Use "${typed}"`)));
          list.replaceChildren(...(rows.length ? rows : [ui.h('div', { class: 'sub' }, 'No model matches.')]));
          list.dataset.count = String(hits.length);
        };
        q.oninput = paint;
        ui.api(API + 'catalog/' + encodeURIComponent(p.id)).then(c => {
          all = c.models || [];
          info.textContent = c.source === 'live'
            ? `${c.total} models from ${p.name}, read ${ui.fmt.when(c.at)}${c.hiddenPaid ? ` · ${c.hiddenPaid} paid ones hidden while Paid models is off` : ''}.`
            : c.needsKey ? `Suggested default only. Add a key to see every model.` : `Suggested models only. ${c.error || 'The list did not answer.'}`;
          if (c.needsKey) info.classList.add('mdl-needkey');
          paint();
        }).catch(e => { info.textContent = e.message; });
        return ui.h('div', { class: 'mdl-mbox' }, ui.h('div', { class: 'well mdl-def' }, ui.h('span', null, 'Default model'), ui.h('span', { class: 'row', style: { gap: '8px' } }, cur, mark)), info, q, list);
      }

      // ----- tabs
      async function drawTab() {
        const i = st.tab;
        if (i === 0) { if (st.data) drawProviders(); return; }
        body.replaceChildren(ui.spinner());
        try {
          const el2 = await [null, tabAgents, tabRouter, tabLocal, tabLoras, tabNodes, tabUsage][i]();
          if (st.tab === i) body.replaceChildren(...[].concat(el2));
        } catch (e) { body.replaceChildren(ui.empty(e.message)); }
      }
      let wasNarrow = window.matchMedia('(max-width:820px)').matches;
      const onResize = () => { if (!el.isConnected) return window.removeEventListener('resize', onResize); const n = window.matchMedia('(max-width:820px)').matches; if (n !== wasNarrow) { wasNarrow = n; if (st.tab === 0 && st.data) drawProviders(); } };
      window.addEventListener('resize', onResize);
      async function tabAgents() {
        st.groups = await availableGroups(ui);
        const agents = (await ui.api('agents')).agents;
        const rows = agents.map(a => { const r = agentModelRow(ui, a, st.groups); return ui.h('tr', null, ui.h('td', null, ui.h('b', null, a.name), r.note.textContent ? ui.h('div', null, r.note) : null), ui.h('td', null, r.main), ui.h('td', null, r.fb), ui.h('td', { class: 'mk' }, r.mark)); });
        return [...groupNotes(ui, st.groups), ui.h('div', { class: 'scroll' }, ui.h('table', { class: 'mdl-agents' }, ui.h('thead', null, ui.h('tr', null, ui.h('th', null, 'Agent'), ui.h('th', null, 'Main model'), ui.h('th', null, 'Fallback'), ui.h('th', null, ''))), ui.h('tbody', null, rows))),
          ui.h('p', { class: 'mdl-note', 'data-apd': 'saved-as-made', style: { marginTop: '8px' } }, 'Each choice is saved as you make it.'),
          ui.h('p', { class: 'sub', style: { marginTop: '4px' } }, `Main model, then fallback, then the ${(st.groups.defaultLabel || 'desk default').replace(/^Desk default/, 'desk default')}. Only models that answer or are installed now are offered.`)];
      }
      const coolWords = (c) => c.why === 'unavailable' ? 'Unavailable at the host' : c.why === 'busy' ? `busy, tried again after ${ui.fmt.time(c.until)}` : c.why === 'timeout' ? `slow, tried again after ${ui.fmt.time(c.until)}` : `skipped until ${ui.fmt.time(c.until)}`;
      async function tabRouter() {
        const rs = await ui.api(API + 'router');
        const url = ui.h('input', { type: 'text', value: rs.baseUrl, style: { width: '260px' }, 'aria-label': 'Router address' });
        const saveUrl = ui.btn('Save', { kind: 'ghost sm', onClick: async () => { await set({ 'router.baseUrl': url.value.trim().replace(/\/$/, '') }); await load(); drawTab(); } });
        const raw = rs.raw;
        return [
          ui.line(rs.name, 'Free models that need no sign-in. On by default. Off means none of these is used.', ui.sw(rs.enabled, 'Free models', async (on) => { await set({ 'router.enabled': on }); await load(); drawTab(); })),
          ui.line('Your own router', (rs.ownerAnswers ? `Answers with ${rs.models.length} models. ` : 'Nothing answers at this address now. ') + 'Only if you run a router program on this PC: the desk uses it first, then the built-in free hosts below.', url, saveUrl),
          ui.line('Built-in free hosts', 'Used when no router of your own answers: free hosts that need no sign-in', ui.sw(rs.builtin, 'Built-in free hosts', async (on) => { await set({ 'router.builtin': on }); await load(); drawTab(); })),
          ui.h('p', { class: 'sub' }, rs.line),
          ui.h('h6', { style: { marginLeft: 0 } }, 'Built-in free hosts'),
          ...rs.upstreams.map(u => ui.h('div', { class: 'line' },
            ui.h('div', null, ui.h('b', null, u.name), ui.h('span', { class: 'd' }, u.models.length ? u.models.map(m => m + (rs.cooling?.[u.id]?.[m] ? ` (${coolWords(rs.cooling[u.id][m])})` : '')).join(', ') : (u.liveModels ? 'Model names are read from the host once you switch it on.' : 'No models listed.')), !u.models.length ? null : ui.h('span', { class: 'd' }, u.noTools?.length ? `Can use tools: ${u.models.filter(x => !u.noTools.includes(x)).join(', ') || 'none'}. Chat only, skipped when an agent uses tools: ${u.noTools.join(', ')}.` : 'All its models can use tools.'), ui.h('span', { class: 'd' }, `Limit: ${u.limit}`), ui.h('span', { class: 'd' }, `Your data: ${u.terms}`)),
            testLine(rs.tests?.[u.id], ui),
            ui.sw(u.enabled, u.name, async (on) => { await set({ 'router.upstreams': raw.map(x => x.id === u.id ? { ...x, enabled: on } : x) }); await load(); drawTab(); }),
            u.enabled ? testBtn({ provider: 'router', upstream: u.id }, async () => { await load(); drawTab(); }) : null)),
          ui.h('p', { class: 'sub' }, 'Terms and limits from Agent Population\'s list, checked 12 Nov 2026. Limits are estimates, not promises.'),
        ];
      }
      async function tabLocal() {
        const [o, hw] = await Promise.all([ui.api(API + 'ollama'), st.hw ? st.hw : ui.api(API + 'hardware')]);
        st.hw = hw;
        st.engineEl = ui.h('div', { class: 'mdl-eng-wrap' }); await drawEngine();
        const installed = new Set(o.models.map(m => m.name));
        const prog = (tag) => { const j = Object.values(st.jobs).find(x => x.input?.model === tag && ['running', 'waiting'].includes(x.status)); return j ? ui.h('span', { class: 'row', style: { minWidth: '160px' } }, ui.meter(j.progress || 0, { live: true }), ui.h('span', { class: 'sub' }, j.status === 'waiting' ? 'Waiting for you' : ui.fmt.pct(j.progress))) : null; };
        const pull = async (tag) => { try { const j = await ui.api(API + 'ollama/pull', { body: { model: tag } }); st.jobs[j.id] = j; ui.toast(`Download of ${tag} is waiting for your approval.`); drawTab(); } catch (e) { ui.toast(e.message, 'err'); } };
        const other = ui.h('input', { type: 'text', placeholder: 'Any Ollama model, for example qwen3:14b', style: { flex: 1 } });
        return [
          st.engineEl,
          ui.h('h6', { style: { marginLeft: 0 } }, 'Ollama'),
          ui.h('p', { class: o.ok ? 'sub' : 'mdl-warn' }, o.line),
          ...o.models.map(m => ui.line(m.name, [ui.fmt.bytes(m.size), m.parameters, m.quant, UNSAFE.test(m.name) ? 'never picked by default' : null].filter(Boolean).join(' · '), ui.pill('Installed', 'ok'),
            ui.btn('Remove', { kind: 'ghost sm', onClick: async () => { await ui.api(API + 'ollama/delete', { body: { model: m.name } }); ui.toast('Removal is waiting for your approval.'); } }))),
          ui.h('h6', { style: { marginLeft: 0 } }, 'Download for this PC'),
          ui.h('p', { class: 'sub' }, hw.line),
          ...hw.picks.filter(p => !installed.has(p.tag)).map(p => ui.line(p.tag, `about ${p.gb} GB · ${p.why} · ${p.fits ? 'fits this PC' : 'too large for this PC'}`,
            prog(p.tag) || (p.fits ? ui.btn('Download', { kind: 'ghost sm', disabled: !o.ok, title: o.ok ? null : 'Start Ollama first', onClick: () => pull(p.tag) }) : ui.h('span', { class: 'val' }, 'Not for this PC')))),
          ui.h('div', { class: 'row', style: { marginTop: '8px' } }, other, ui.btn('Download', { kind: 'ghost sm', disabled: !o.ok, onClick: () => other.value.trim() && pull(other.value.trim()) })),
          ui.h('p', { class: 'sub', style: { marginTop: '6px' } }, 'Every download asks you first and can be stopped with Panic. Sizes are about, from the Ollama library.'),
        ];
      }
      // ----- the desk's own local model (llama.cpp's llama-server and one model, fetched in the background)
      async function drawEngine() {
        if (!st.engineEl) return;
        let e, plan;
        try { [e, plan] = await Promise.all([ui.api('local-engine'), st.plan && Date.now() - st.planAt < 60000 ? st.plan : ui.api('local-engine/plan')]); }
        catch (err) { st.engineEl.replaceChildren(ui.card({ class: 'mdl-eng' }, ui.h('b', null, 'Local model on this PC'), ui.h('p', { class: 'mdl-warn' }, err.message))); return; }
        st.plan = plan; st.planAt = Date.now();
        st.engineEl.replaceChildren(engineCard(e, plan));
      }
      const PHASE = { none: ['Not downloaded', ''], downloading: ['Downloading', 'wait'], ready: ['Ready', 'ok'], starting: ['Starting', 'wait'], running: ['Running', 'ok'], stopped: ['Stopped', ''], off: ['Switched off', ''], failed: ['Did not work', 'stop'] };
      const left = (s) => s == null ? '' : s < 90 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s left` : s < 5400 ? `about ${Math.round(s / 60)} min left` : `about ${Math.round(s / 3600)} h left`;
      function engineCard(e, plan) {
        const act = (path, body, msg) => async () => { try { const r = await ui.api('local-engine/' + path, { body: body || {} }); if (msg) ui.toast(typeof msg === 'function' ? msg(r) : msg, 'ok'); st.plan = null; await drawEngine(); await load(); } catch (err) { ui.toast(err.message, 'err'); } };
        const [word, kind] = PHASE[e.phase] || [e.phase, ''];
        const m = e.model || plan.model; const here = e.phase === 'ready' || e.phase === 'running' || e.phase === 'stopped' || e.phase === 'starting';
        // every model in the list, with its size and the memory it needs; one too large for this PC can be chosen after one warning
        const pick = ui.h('select', { 'aria-label': 'Model for this PC', 'data-apd': 'engine-model' }, plan.model ? null : ui.h('option', { value: '', selected: true, disabled: true }, 'Choose a model'),
          ...(plan.choices || []).map(c => ui.h('option', { value: c.id, 'data-fits': String(!!c.fits), selected: c.id === (plan.model?.id) }, `${c.name} · ${c.sizeText} · needs about ${c.needsGb} GB${c.fits ? (c.id === plan.recommended ? ' · best fit' : '') : ' · more than this PC has'}`)));
        pick.onchange = async () => {
          const c = (plan.choices || []).find(x => x.id === pick.value);
          if (c && !c.fits && !await ui.confirm('This model needs more memory than this PC has. It may be very slow or not start.', { title: `Choose ${c.name}?`, ok: 'Choose it' })) { pick.value = plan.model?.id || ''; return; }
          try { await ui.api('local-engine/choose', { body: { model: pick.value } }); st.plan = null; await drawEngine(); } catch (err) { ui.toast(err.message, 'err'); }
        };
        const get = ui.btn(here && e.model && plan.model && e.model.id !== plan.model.id ? `Get ${plan.model.name} (${plan.totalText})` : e.phase === 'failed' ? `Try again (${plan.totalText})` : `Get a local model (${plan.totalText})`, { kind: 'sm', 'data-apd': 'engine-get', disabled: !plan.ok || !e.on, title: plan.ok ? null : plan.reason, onClick: act('get', { model: pick.value }, 'Each download asks you first. You can keep working meanwhile.') });
        const dls = (e.downloads || []).map(d => ui.h('div', { class: 'mdl-dl', 'data-apd': 'engine-download' },
          ui.h('b', { class: 'mdl-dl-title', title: d.title }, d.title), ui.h('span', { class: 'sub', 'data-apd': 'engine-progress' }, d.state === 'waiting' ? 'Waiting for your approval' : d.state === 'paused' ? 'Paused' : d.state === 'queued' ? 'Next in line' : `${d.doneText} of ${d.totalText}${d.speedText ? ' · ' + d.speedText : ''}${d.secondsLeft != null ? ' · ' + left(d.secondsLeft) : ''}`),
          ui.meter(d.total ? d.done / d.total : 0, { live: d.state === 'running' }),
          d.reason && d.state !== 'waiting' ? ui.h('span', { class: 'sub mdl-reason' }, d.reason) : null,
          ui.h('div', { class: 'row' }, d.state === 'paused' ? ui.btn('Resume', { kind: 'ghost sm', onClick: () => ui.api(`downloads/${d.id}/resume`, { body: {} }).then(drawEngine).catch(err => ui.toast(err.message, 'err')) }) : d.state === 'running' || d.state === 'queued' ? ui.btn('Pause', { kind: 'ghost sm', onClick: () => ui.api(`downloads/${d.id}/pause`, { body: {} }).then(drawEngine).catch(err => ui.toast(err.message, 'err')) }) : null,
            ui.btn('Cancel', { kind: 'ghost sm', onClick: () => ui.api(`downloads/${d.id}/cancel`, { body: {} }).then(drawEngine).catch(err => ui.toast(err.message, 'err')) }))));
        const hwLine = plan.hardware?.line ? `${plan.hardware.line}${plan.hardware.budgetGb != null ? ` About ${plan.hardware.budgetGb} GB of its memory can go to a model.` : ''}${plan.hardware.memoryLine ? ' ' + plan.hardware.memoryLine : ''}` : null;
        const facts = m ? `${m.name} · ${m.sizeText} · ${m.licence}${m.publisher ? ' · by ' + m.publisher : ''} · ${m.tools ? 'can use tools' : 'chat only, no tools'}` : 'No model is recommended for this PC. One can still be chosen from the list.';
        const eng = e.engine ? `llama.cpp ${e.engine.release} (${e.engine.licence}) · ${e.engine.label}` : plan.engine ? `llama.cpp ${plan.engine.name.replace('llama.cpp ', '')} (${plan.engine.licence}) · ${plan.engine.label} · ${plan.engine.sizeText}` : null;
        return ui.card({ class: 'mdl-eng', 'data-apd': 'engine-card', 'data-phase': e.phase },
          ui.h('div', { class: 'row' }, ui.h('b', null, 'Local model on this PC'), ui.pill(word, kind), ui.h('span', { class: 'grow' }),
            ui.sw(e.on, 'Local engine', async (on) => { await act('switch', { on }, on ? 'Local engine on.' : 'Local engine off: it is stopped and nothing is downloaded.')(); })),
          ui.h('div', { class: 'sub' }, facts),
          eng ? ui.h('div', { class: 'sub' }, eng) : null,
          hwLine ? ui.h('div', { class: 'sub' }, hwLine) : null,
          plan.note ? ui.h('p', { class: 'sub', 'data-apd': 'engine-note' }, plan.note) : null,
          plan.freeNote && !here ? ui.h('p', { class: 'sub', 'data-apd': 'engine-free' }, plan.freeNote) : null,
          plan.warning && !here ? ui.h('p', { class: 'mdl-warn', 'data-apd': 'engine-warning' }, plan.warning) : null,
          e.reason ? ui.h('p', { class: e.phase === 'failed' || e.phase === 'off' ? 'mdl-warn' : 'sub', 'data-apd': 'engine-reason' }, e.reason) : null,
          !plan.ok && plan.reason && !here ? ui.h('p', { class: 'mdl-warn' }, plan.reason) : null,
          ...dls,
          ui.h('div', { class: 'row mdl-eng-acts' },
            e.phase === 'downloading' ? null : [pick, (!here || (e.model && plan.model && e.model.id !== plan.model.id)) ? get : null],
            here && e.on ? testBtn({ provider: 'llama' }, async () => { await drawEngine(); await load(); }) : null,
            e.phase === 'running' ? ui.btn('Stop', { kind: 'ghost sm', onClick: act('stop', null, 'Stopped. It starts again when a local model is needed.') }) : null,
            here || e.downloads?.length || e.used ? ui.btn('Remove', { kind: 'ghost sm', 'data-apd': 'engine-remove', onClick: async () => { if (!await ui.confirm(`Remove the local model and its program from this PC? This frees ${ui.fmt.bytes(e.used || 0)}. It can be downloaded again.`, { title: 'Remove the local model?', ok: 'Remove' })) return; await act('remove', null, (r) => `Removed. ${r.freedText} freed.`)(); } }) : null),
          here ? ui.line('Keep the local model loaded', `Start it when the desk starts and keep it in memory. Off: it starts when needed and stops after ${e.idleMinutes} minutes without use.`, ui.sw(e.keepLoaded, 'Keep the local model loaded', (on) => act('keep-loaded', { on })())) : null,
          ui.h('p', { class: 'sub' }, 'Runs only on this PC, on its own address 127.0.0.1, and works while the desk is offline. Each download asks you first, is checked against its SHA-256 before use, and stops with Panic.'));
      }
      async function tabLoras() {
        const l = await ui.api(API + 'loras');
        const folder = ui.h('input', { type: 'text', value: l.folder?.folder || '', placeholder: 'A folder with adapters, for example D:\\Models\\loras', style: { flex: 1 } });
        return [
          ui.h('h6', { style: { marginLeft: 0 } }, 'Adapters inside Ollama models'),
          ...(l.ollama.ok ? (l.ollama.items.length ? l.ollama.items.map(x => ui.line(x.adapter, `Built into ${x.model} (Modelfile ADAPTER)`, ui.pill('In use', 'ok'))) : [ui.h('p', { class: 'sub' }, 'None of the installed Ollama models has an adapter.')]) : [ui.h('p', { class: 'sub' }, 'Ollama is not running, so its models cannot be read.')]),
          ui.h('h6', { style: { marginLeft: 0 } }, 'A folder you pick'),
          ui.h('div', { class: 'row' }, folder, ui.btn('Look', { kind: 'ghost sm', onClick: async () => { try { await ui.api(API + 'loras/scan', { body: { folder: folder.value } }); ui.toast('Opening a folder outside the workspace asks you first.'); } catch (e) { ui.toast(e.message, 'err'); } } })),
          ...(l.folder ? (l.folder.items.length ? l.folder.items.map(x => ui.line(x.name, `${x.kind} · ${ui.fmt.bytes(x.size)}`)) : [ui.h('p', { class: 'sub' }, `No adapters found in ${l.folder.folder}.`)]) : []),
          ui.h('p', { class: 'sub', style: { marginTop: '8px' } }, 'Not supported: the desk does not train LoRAs, does not switch adapters while a model runs, and cannot add adapters to router or keyed models. To use a GGUF adapter, build an Ollama model with a Modelfile that has an ADAPTER line, then pick that model.'),
        ];
      }
      async function tabNodes() {
        const [hw, ll] = await Promise.all([st.hw ? st.hw : ui.api(API + 'hardware'), ui.api(API + 'litellm')]);
        st.hw = hw;
        const nodes = ui.state.settings['network.lanNodes'] || (await ui.api('settings'))['network.lanNodes'] || [];
        const saveNodes = async (list) => { await set({ 'network.lanNodes': list }); await load(); drawTab(); };
        const scan = ui.btn('Scan', { kind: 'ghost sm', onClick: async () => { scan.disabled = true; scan.textContent = 'Scanning…'; try { st.hw = await ui.api(API + 'hardware?force=1'); drawTab(); } catch (e) { ui.toast(e.message, 'err'); } } });
        const name = ui.h('input', { type: 'text', placeholder: 'Name, for example Ryzen PC', style: { flex: '1 1 120px' } });
        const addr = ui.h('input', { type: 'text', placeholder: 'Address, for example 192.168.1.20:11434', style: { flex: '2 1 180px' } });
        const model = ui.h('input', { type: 'text', placeholder: 'Model on that PC', style: { flex: '1 1 120px' } });
        const llKey = ui.h('input', { type: 'password', placeholder: 'LiteLLM key (master key)', class: 'mdl-pw' });
        const tests = st.data?.active || [];
        return [
          ui.line('This PC', `${hw.gpu ? `${hw.gpu.name} · ${hw.gpu.vramGb} GB` : 'No graphics card found'} · ${hw.cpu.name} · ${hw.ramGb} GB RAM`, scan),
          ui.h('p', { class: 'sub' }, hw.line + ` Scanned ${ui.fmt.when(hw.at)}.`),
          ui.h('h6', { style: { marginLeft: 0 } }, 'Other PCs on your network'),
          ...nodes.map(n => ui.h('div', { class: 'line' }, ui.h('div', null, ui.h('b', null, n.name || n.baseUrl), ui.h('span', { class: 'd' }, `${n.baseUrl} · ${n.model || 'auto'}`)),
            testLine(tests.find(a => a.provider === 'lan:' + n.id)?.test, ui),
            ui.sw(n.enabled !== false, n.name || 'Node', (on) => saveNodes(nodes.map(x => x.id === n.id ? { ...x, enabled: on } : x))),
            n.enabled !== false ? testBtn({ provider: 'lan:' + n.id, model: n.model || null }, async () => { await load(); drawTab(); }) : null,
            ui.btn('Remove', { kind: 'ghost sm', onClick: () => saveNodes(nodes.filter(x => x.id !== n.id)) }))),
          ui.h('div', { class: 'row' }, name, addr, model, ui.btn('Add', { kind: 'ghost sm', onClick: async () => {
            if (!addr.value.trim()) return ui.toast('Type the address of the other PC.', 'err');
            let base = addr.value.trim().replace(/\/$/, ''); if (!/^https?:\/\//.test(base)) base = 'http://' + base; if (/:11434$/.test(base)) base += '/v1';
            const probe = await ui.api(API + 'lan/probe', { body: { baseUrl: base } });
            const id = (name.value || 'node').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) + '-' + Date.now().toString(36).slice(-4);
            await saveNodes([...nodes, { id, name: name.value.trim() || base, baseUrl: base, model: model.value.trim() || probe.models?.[0] || '', enabled: true }]);
            ui.toast(probe.ok ? `It answers with ${probe.models.length} models.` : `Saved, but it does not answer yet (${probe.error}).`, probe.ok ? 'ok' : 'err');
          } })),
          ui.h('p', { class: 'sub' }, 'Another PC running Ollama or a router. Offline, the desk still uses these, because they are on your own network.'),
          ui.h('h6', { style: { marginLeft: 0 } }, 'LiteLLM proxy (optional)'),
          ll.found ? (ll.added ? ui.line('LiteLLM on this PC', `Added as a Custom provider · ${ll.models.join(', ')}`, ui.pill('Added', 'ok'))
            : ui.h('div', null, ui.line('LiteLLM on this PC', `Answers at ${ll.url}${ll.models.length ? ' · ' + ll.models.join(', ') : ' · its model list needs your LiteLLM key'}`), ui.h('div', { class: 'row' }, llKey, ui.btn('Add as a provider', { kind: 'ghost sm', onClick: async () => {
              try { await ui.api(API + 'keys', { body: { provider: 'custom', value: llKey.value || 'sk-no-key-needed', label: 'LiteLLM on this PC', baseUrl: ll.url, model: ll.models[0] || '' } }); ui.toast('LiteLLM added. Test it under Providers and keys.', 'ok'); await load(); drawTab(); } catch (e) { ui.toast(e.message, 'err'); }
            } }))))
            : ui.h('p', { class: 'sub' }, `No LiteLLM proxy answers at ${ll.url}. If you run one, it shows here and can be added as a provider.`),
        ];
      }
      async function tabUsage() {
        const u = await ui.api(API + 'usage');
        const tot = u.today.reduce((s, r) => ({ calls: s.calls + r.calls, failed: s.failed + r.failed, cost: s.cost + r.cost, unknown: s.unknown + (r.unknown || 0) }), { calls: 0, failed: 0, cost: 0, unknown: 0 });
        // a call whose cost the desk cannot know is shown as "not known", with its tokens, never as ₹0
        const costCell = (r) => r.unknown ? (r.cost ? `${ui.fmt.money(r.cost, u.currency)} + not known` : 'not known') : ui.fmt.money(r.cost, u.currency);
        return [ui.h('p', { class: 'sub' }, `Today: ${tot.calls} calls, ${tot.failed} failed, about ${ui.fmt.money(tot.cost, u.currency)}${tot.unknown ? `, and ${tot.unknown} call${tot.unknown === 1 ? '' : 's'} whose cost is not known` : ''}. Free API and local models cost nothing.`),
          ui.table([{ label: 'Model', render: r => r.label }, { label: 'Calls', render: r => String(r.calls) }, { label: 'Failed', render: r => String(r.failed) }, { label: 'Tokens', render: r => String(r.tokens) }, { label: 'Cost (about)', render: costCell }], u.today, { empty: 'No model calls yet today.' })];
      }

      ui.on('models', (c) => { load().catch(() => {}); if (c?.change === 'local-engine' && st.tab === 3) drawEngine().catch(() => {}); });
      let dlTimer = null;
      ui.on('downloads', () => { if (st.tab !== 3 || dlTimer) return; dlTimer = setTimeout(() => { dlTimer = null; drawEngine().catch(() => {}); }, 400); });
      ui.on('settings', (c) => { if (c && ('online' in c || 'openrouter.allowPaid' in c)) load().catch(() => {}); });
      ui.on('job', (j) => {
        if (!j || !String(j.kind || '').startsWith('models.')) return;
        st.jobs[j.id] = j;
        if (j.kind === 'models.pull' && st.tab === 3) drawTab();
        // a model just installed tests itself, so its card shows whether it answers
        if (j.kind === 'models.pull' && j.status === 'done' && j.input?.model) testing('Testing the local model…', () => ui.api(API + 'test', { body: { provider: 'ollama', model: j.input.model, auto: true } })).then(() => load()).catch(() => {});
        if (j.kind === 'models.lora' && st.tab === 4 && j.status !== 'running' && j.status !== 'waiting') drawTab();
        if (j.status === 'failed') ui.toast(`${j.title}: ${j.error}`, 'err');
      });
      await load();
      drawTab();
    },
  },
};
