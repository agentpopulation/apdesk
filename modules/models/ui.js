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
  const tip = () => { sel.title = sel.selectedOptions[0]?.title || ''; };
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
  const save = async () => {
    try {
      const a = await ui.api('agents/' + encodeURIComponent(agent.id), { method: 'PATCH', body: { model: { main: decode(main.value), fallback: decode(fb.value) } } });
      Object.assign(agent, a); note.textContent = 'Saved.'; ui.toast(`${agent.name}: ${main.value ? savedName(ui, groups, decode(main.value)) : (groups.defaultLabel || 'desk default')}`, 'ok');
    } catch (e) { ui.toast(e.message, 'err'); }
  };
  main.onchange = save; fb.onchange = save;
  return { main, fb, note, compact };
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
        ui.line('Fallback', 'Used when the main model does not answer', r.fb),
        r.note, ...groupNotes(ui, groups), ui.h('div', { class: 'row', style: { marginTop: '8px' } }, test, out),
        ui.h('p', { class: 'sub', style: { marginTop: '8px' } }, 'Only models that answer or are installed now are offered. Every reply names the model that answered.')));
    },
  },
};

// ---------- the page
export const pages = {
  models: {
    title: 'Models',
    async render(el, ui) {
      css();
      el.classList.add('mdl');
      const st = { tab: 0, open: null, data: null, groups: [], hw: null, ollama: null, loras: null, ll: null, usage: null, jobs: {} };
      const head = ui.h('div', { class: 'row' });
      const act = ui.h('div', { class: 'active mdl-active' });
      const prov = ui.h('div', { class: 'mdl-scroll' });
      const body = ui.h('div', { class: 'mdl-scroll' });
      const TABS = ['Per agent', 'Router', 'Local models', 'LoRAs', 'Nodes', 'Usage'];
      const tabs = ui.seg(TABS, 0, (o, i) => { st.tab = i; drawTab(); });
      el.replaceChildren(head, ui.h('div', null, ui.h('h6', { style: { marginLeft: 0 } }, 'Active now'), act),
        ui.h('div', { class: 'two mdl-body' },
          ui.card({ class: 'mdl-col' }, ui.h('div', { class: 'row' }, ui.h('h3', null, 'Providers and keys'), ui.h('span', { class: 'grow' }), ui.h('span', { class: 'sub' }, 'Several keys per provider')), prov),
          ui.card({ class: 'mdl-col' }, ui.h('div', { class: 'row', style: { marginBottom: '4px' } }, ui.h('h3', null, 'On this PC'), tabs), body)));

      const set = async (patch) => { await ui.api('settings', { body: patch }); Object.assign(ui.state.settings, patch); };
      async function load() {
        const [d, g, sv] = await Promise.all([ui.api(API + 'overview'), availableGroups(ui), ui.api('keys/services').catch(() => ({ services: [] }))]);
        st.data = d; st.groups = g; st.services = sv.services || []; drawHead(); drawActive(); drawProviders();
      }

      // ----- header and Active now
      function drawHead() {
        const d = st.data; const live = d.active.filter(a => a.ok).length;
        const testAll = ui.btn('Test all', { kind: 'ghost', onClick: async () => {
          testAll.disabled = true; testAll.textContent = 'Testing…';
          try { const r = await ui.api(API + 'test-all', { method: 'POST' }); const ok = r.results.filter(x => x.ok).length; testAll.textContent = `${ok} of ${r.results.length} answered`; await load(); }
          catch (e) { ui.toast(e.message, 'err'); testAll.textContent = 'Test all'; } finally { testAll.disabled = false; }
        } });
        head.replaceChildren(ui.h('h2', null, 'Models'), ui.pill(`${live} active`, live ? 'ok' : 'wait'),
          ui.pill(d.online ? 'Online' : 'Offline', d.online ? '' : 'wait'),
          ui.h('span', { class: 'sub mdl-why' }, d.online ? 'Online: the Free API, keyed providers, models on this PC and LAN nodes can answer. Offline: only models on this PC and LAN nodes; nothing leaves your network.' : 'Offline: only models on this PC and LAN nodes answer. Nothing leaves your network.'),
          ui.h('span', { class: 'grow' }), testAll);
      }
      function testBtn(args, after) {
        const b = ui.btn('Test', { kind: 'ghost sm', onClick: async () => {
          b.disabled = true; b.textContent = 'Testing…';
          // a local model that is not in memory yet is loaded by its first call, which can take a minute or two
          if (args.provider === 'llama') ui.api('local-engine').then(r => { if (r.phase !== 'running' && b.disabled) { b.textContent = 'Starting the local model…'; b.title = 'Its first call loads it into memory. This can take a minute or two on a laptop.'; } }).catch(() => {});
          if (args.provider === 'ollama') ui.api(API + 'ollama/loaded' + (args.model ? '?model=' + encodeURIComponent(args.model) : '')).then(r => { if (!r.loaded && b.disabled) { b.textContent = 'Loading the model…'; b.title = 'A local model\'s first call loads it into memory. This can take a minute or two on a laptop.'; } }).catch(() => {});
          try { const r = await ui.api(API + 'test', { body: args }); ui.toast(r.ok ? `${r.label} answered in ${secs(r.ms)}` : `${r.label}: ${r.error}`, r.ok ? 'ok' : 'err'); await (after || load)(); }
          catch (e) { ui.toast(e.message, 'err'); } finally { b.disabled = false; b.textContent = 'Test'; b.title = ''; }
        } });
        return b;
      }
      function drawActive() {
        const d = st.data; const rs = d.router;
        act.replaceChildren(...d.active.map(a => {
          let sub;
          if (a.provider === 'router') sub = rs.mode === 'owner' ? `Your own router · ${rs.models.length} model${rs.models.length === 1 ? '' : 's'}` : rs.mode === 'builtin' ? `Built-in, no sign-in · ${rs.upstreams.filter(u => u.enabled).length} free hosts` : rs.line;
          else if (a.provider === 'llama') sub = a.ok ? `${a.name} · ${a.running ? 'running now' : 'starts when needed'}` : 'Switched off on the Local models tab.';
          else if (a.kind === 'local') sub = a.ok ? `${a.models.length} installed${a.model ? ' · ' + a.model : ''}` : 'Not running. Start Ollama on this PC.';
          else if (a.kind === 'lan') sub = `LAN node · ${a.model || 'auto'}`;
          else sub = `${a.keys} key${a.keys === 1 ? '' : 's'} on · ${a.model}`;
          if (!d.online && a.kind !== 'local' && a.kind !== 'lan') sub = 'Off while the desk is offline';
          const dim = !a.ok;
          return ui.card({ class: 'api' + (dim ? ' mdl-dim' : '') },
            ui.h('span', { class: 'av big g' }, a.provider === 'router' ? 'AP' : initials(a.label)),
            ui.h('div', { style: { flex: 1, minWidth: 0 } }, ui.h('b', { class: 'mdl-name' }, a.provider === 'ollama' ? 'Ollama on this PC' : a.label), ui.h('div', { class: 'sub mdl-ell', title: sub }, sub), testLine(a.test, ui)),
            ui.h('div', { class: 'mdl-acts' }, a.provider === 'router' ? ui.sw(rs.enabled, 'Free models', async (on) => { await set({ 'router.enabled': on }); await load(); }) : null,
              a.ok || a.provider !== 'ollama' ? testBtn({ provider: a.provider }) : null));
        }));
      }

      // ----- providers and keys
      function drawProviders() {
        const d = st.data; const rs = d.router;
        const provRow = (p) => {
          const on = p.keys.filter(k => k.enabled).length;
          const row = ui.h('button', { class: 'prow', 'aria-expanded': String(st.open === p.id), onclick: () => { st.open = st.open === p.id ? null : p.id; drawProviders(); } },
            ui.h('span', { class: 'dot' + (on ? ' on' : '') }), ui.h('span', { style: { flex: 1, minWidth: 0 } }, ui.h('b', null, p.name), ' ', ui.h('span', { class: 'sub' }, p.paidOff ? 'Free models only; paid models are off' : p.paidOn ? 'Paid models are on' : (p.freeNote || p.terms.split('.')[0]))),
            p.paid === 'always' ? ui.h('span', { class: 'pill', 'data-apd': 'paid-api' }, 'Paid API') : null,
            ui.pill(p.keys.length ? `${p.keys.length} key${p.keys.length > 1 ? 's' : ''}` : 'No key'));
          return st.open === p.id ? [row, keysPanel(p)] : [row];
        };
        const svcRow = (v) => {
          const row = ui.h('button', { class: 'prow', 'aria-expanded': String(st.open === 'svc:' + v.id), onclick: () => { st.open = st.open === 'svc:' + v.id ? null : 'svc:' + v.id; drawProviders(); } },
            ui.h('span', { class: 'dot' + (v.hasKey && v.enabled ? ' on' : '') }), ui.h('span', { style: { flex: 1, minWidth: 0 } }, ui.h('b', null, v.name), ' ', ui.h('span', { class: 'sub' }, `${v.kind === 'search' ? 'search' : 'voice and audio'}${v.free ? ' · ' + v.free : ''}`)),
            ui.pill(v.hasKey ? (v.fromEnvironment ? 'From environment' : 'Key saved') : 'No key'));
          if (st.open !== 'svc:' + v.id) return [row];
          const val = ui.h('input', { type: 'password', placeholder: v.hasKey ? 'Paste a new key to replace it' : 'Paste the key', autocomplete: 'off', class: 'mdl-pw' });
          const svc = (body, method) => ui.api('keys/services/' + encodeURIComponent(v.id), { method, body }).then(async () => { await load(); }).catch(e => ui.toast(e.message, 'err'));
          return [row, ui.h('div', { class: 'keys' },
            ui.h('div', { class: 'sub' }, 'Used by the search and voice modules, not by chat. Not tested from this page.', v.signup ? [' ', ui.h('a', { href: v.signup, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key')] : null),
            ui.h('div', { class: 'row' }, val, ui.btn('Save key', { kind: 'sm', onClick: () => { if (!val.value.trim()) return; svc({ value: val.value.trim() }).then(() => ui.toast('Key saved. It will not be shown again.', 'ok')); } }),
              v.hasKey && !v.fromEnvironment ? ui.sw(v.enabled, v.name, (on) => svc({ enabled: on })) : null,
              v.hasKey && !v.fromEnvironment ? ui.btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm(`Remove the ${v.name} key?`, { ok: 'Remove' })) svc(undefined, 'DELETE'); } }) : null))];
        };
        const free = d.providers.filter(p => p.tier === 'free-signup'); const paid = d.providers.filter(p => p.tier !== 'free-signup');
        const svcs = st.services || [];
        prov.replaceChildren(
          ui.h('h6', { style: { marginLeft: 0 } }, 'Free, no sign-in'),
          ui.h('div', { class: 'prow mdl-static' }, ui.h('span', { class: 'dot' + (rs.enabled && rs.mode !== 'none' ? ' on' : '') }),
            ui.h('span', { style: { flex: 1, minWidth: 0 } }, ui.h('b', null, rs.name), ' ', ui.h('span', { class: 'sub' }, rs.mode === 'owner' ? 'your own router' : rs.mode === 'builtin' ? 'built-in free hosts' : 'off')),
            ui.btn('Settings', { kind: 'ghost sm', onClick: () => { st.tab = 1; tabs.set(1); drawTab(); } }),
            ui.sw(rs.enabled, 'Free models', async (on) => { await set({ 'router.enabled': on }); await load(); })),
          ui.h('h6', { style: { marginLeft: 0 } }, 'Free with sign-up'), ...free.flatMap(provRow),
          ui.h('h6', { style: { marginLeft: 0 } }, 'Paid'), ...paid.flatMap(provRow),
          ...(svcs.length ? [ui.h('h6', { style: { marginLeft: 0 } }, 'Search, voice and audio'), ...svcs.flatMap(svcRow)] : []));
      }
      function keysPanel(p) {
        const label = ui.h('input', { type: 'text', placeholder: 'Label, for example Work key', style: { flex: '1 1 140px' } });
        const value = ui.h('input', { type: 'password', placeholder: 'Paste the key', autocomplete: 'off', class: 'mdl-pw' });
        const base = p.id === 'cloudflare' ? ui.h('input', { type: 'text', placeholder: 'Base URL with your account id', style: { flex: '2 1 220px' } }) : p.id === 'custom' ? ui.h('input', { type: 'text', placeholder: 'Base URL, for example http://127.0.0.1:4000/v1', style: { flex: '2 1 220px' } }) : null;
        const cmodel = p.id === 'custom' ? ui.h('input', { type: 'text', placeholder: 'Model name', style: { flex: '1 1 120px' } }) : null;
        const add = ui.btn('Save key', { kind: 'sm', onClick: async () => {
          try { await ui.api(API + 'keys', { body: { provider: p.id, value: value.value, label: label.value, baseUrl: base?.value, model: cmodel?.value } }); value.value = ''; ui.toast('Key saved. It will not be shown again.', 'ok'); await load(); }
          catch (e) { ui.toast(e.message, 'err'); }
        } });
        const paid = p.paid === 'switch' ? ui.h('div', { class: 'line mdl-paid', 'data-apd': 'paid-switch' }, ui.h('div', null, ui.h('b', null, 'Paid models'), ui.h('span', { class: 'd' }, p.paidOn ? 'On: every model is listed and may be used; paid ones are marked Paid. Your spend limits still apply.' : 'Off: only free models are listed and used.')),
          ui.sw(p.paidOn, 'Paid models', async (on) => {
            if (on && !await ui.confirm(`This key may be charged by ${p.name}. Your spend limits still apply.`, { title: 'Switch on paid models?', ok: 'Switch on' })) return false;
            await ui.api('settings/paid-models', { body: { provider: p.id, on } }); ui.state.settings['openrouter.allowPaid'] = on; await load();
          }))
          : p.paid === 'always' ? ui.h('div', { class: 'sub' }, ui.h('span', { class: 'pill' }, 'Paid API'), ' Adding a key means paying for what it uses. Your spend limits still apply.')
          : p.paid === 'account' ? ui.h('div', { class: 'sub', 'data-apd': 'billing-note' }, `Free or paid depends on your own account with ${p.name}. The desk cannot see or control its billing.`) : null;
        // the owner tells the desk whether a key is free: then its calls cost nothing; paid prices them at the list price; not sure leaves the cost unknown
        const TIERS = [['Free tier', 'free'], ['Paid', 'paid'], ['Not sure', null]];
        const tierChoice = (k) => ui.h('label', { class: 'ktier', title: 'Is this key charged?' }, ui.h('span', { class: 'sub' }, 'Cost'),
          ui.seg(TIERS.map(o => o[0]), Math.max(0, TIERS.findIndex(([, v]) => v === (k.tier || null))), async (_, i) => { try { await ui.api(API + `keys/${encodeURIComponent(k.id)}/tier`, { body: { tier: TIERS[i][1] } }); await load(); } catch (e) { ui.toast(e.message, 'err'); } }));
        return ui.h('div', { class: 'keys' },
          ui.h('div', { class: 'sub' }, 'Your data: ', p.terms, p.signup ? [' ', ui.h('a', { href: p.signup, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key')] : null),
          paid,
          ...p.keys.map(k => ui.h('div', { class: 'k' },
            ui.h('span', { style: { flex: 1, minWidth: 0, fontFamily: 'var(--ui)' } }, ui.h('b', null, k.fromEnv ? 'Key from the environment' : k.label), ' ', ui.h('span', { class: 'sub' }, k.fromEnv ? 'this run only, not saved' : 'added ' + ui.fmt.date(k.created))),
            testLine(k.test, ui),
            k.fromEnv ? null : ui.sw(k.enabled, k.label, async (on) => { await ui.api(API + `keys/${encodeURIComponent(k.id)}/toggle`, { body: { on } }); await load(); }),
            tierChoice(k),
            testBtn({ provider: p.id, keyId: k.id }),
            k.fromEnv ? null : ui.btn('Remove', { kind: 'ghost sm', onClick: async () => { if (!await ui.confirm(`Remove ${k.label} from ${p.name}?`, { ok: 'Remove' })) return; await ui.api(API + 'keys/' + encodeURIComponent(k.id), { method: 'DELETE' }); await load(); } }))),
          ui.h('div', { class: 'row' }, label, value, base, cmodel, add),
          modelBox(p));
      }
      /** The Default model box: every model the provider gives, searchable, marked Free or Paid where it says. */
      function modelBox(p) {
        const q = ui.h('input', { type: 'search', placeholder: 'Type to filter', 'aria-label': `Filter ${p.name} models`, class: 'mdl-mq' });
        const list = ui.h('div', { class: 'mdl-mlist', role: 'listbox', 'aria-label': `${p.name} models`, 'data-apd': 'model-list' });
        const info = ui.h('div', { class: 'sub mdl-minfo', 'data-apd': 'model-info' }, 'Reading the list…');
        const cur = ui.h('b', { class: 'mdl-mcur' }, p.defaultModel || 'none');
        let all = [];
        const choose = async (id) => { try { await set({ [`provider.${p.id}.model`]: id || null }); p.defaultModel = id; cur.textContent = id || 'none'; ui.toast('Default model saved.', 'ok'); paint(); } catch (e) { ui.toast(e.message, 'err'); } };
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
        return ui.h('div', { class: 'mdl-mbox' }, ui.h('div', { class: 'row' }, ui.h('span', { class: 'sub' }, 'Default model'), cur), info, q, list);
      }

      // ----- tabs
      async function drawTab() {
        const i = st.tab; body.replaceChildren(ui.spinner());
        try {
          const el2 = await [tabAgents, tabRouter, tabLocal, tabLoras, tabNodes, tabUsage][i]();
          if (st.tab === i) body.replaceChildren(...[].concat(el2));
        } catch (e) { body.replaceChildren(ui.empty(e.message)); }
      }
      async function tabAgents() {
        st.groups = await availableGroups(ui);
        const agents = (await ui.api('agents')).agents;
        const rows = agents.map(a => { const r = agentModelRow(ui, a, st.groups); return ui.h('tr', null, ui.h('td', null, ui.h('b', null, a.name), r.note.textContent ? ui.h('div', null, r.note) : null), ui.h('td', null, r.main), ui.h('td', null, r.fb)); });
        return [...groupNotes(ui, st.groups), ui.h('div', { class: 'scroll' }, ui.h('table', { class: 'mdl-agents' }, ui.h('thead', null, ui.h('tr', null, ui.h('th', null, 'Agent'), ui.h('th', null, 'Main model'), ui.h('th', null, 'Fallback'))), ui.h('tbody', null, rows))),
          ui.h('p', { class: 'sub', style: { marginTop: '6px' } }, `Main model, then fallback, then the ${(st.groups.defaultLabel || 'desk default').replace(/^Desk default/, 'desk default')}. Only models that answer or are installed now are offered.`)];
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

      ui.on('models', (c) => { load().catch(() => {}); if (c?.change === 'local-engine' && st.tab === 2) drawEngine().catch(() => {}); });
      let dlTimer = null;
      ui.on('downloads', () => { if (st.tab !== 2 || dlTimer) return; dlTimer = setTimeout(() => { dlTimer = null; drawEngine().catch(() => {}); }, 400); });
      ui.on('settings', (c) => { if (c && ('online' in c || 'openrouter.allowPaid' in c)) load().catch(() => {}); });
      ui.on('job', (j) => {
        if (!j || !String(j.kind || '').startsWith('models.')) return;
        st.jobs[j.id] = j;
        if (j.kind === 'models.pull' && st.tab === 2) drawTab();
        if (j.kind === 'models.lora' && st.tab === 3 && j.status !== 'running' && j.status !== 'waiting') drawTab();
        if (j.status === 'failed') ui.toast(`${j.title}: ${j.error}`, 'err');
      });
      await load();
      drawTab();
    },
  },
};
