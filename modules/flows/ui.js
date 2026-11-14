// Flows and Schedules panel: chains of agents (the row of nodes with moving dots) and the schedule list.
// Rendered inside Tasks (right column) and on its own at #/flows.
const STYLE_ID = 'flows-style';
function style() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style'); s.id = STYLE_ID;
  s.textContent = `.wire.idle::after{display:none}.node.cur{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}.node.cur small{color:var(--accent)}
.fl-form{display:flex;flex-direction:column;gap:10px;width:100%}.fl-form label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dim)}
.fl-form input,.fl-form textarea,.fl-form select{width:100%;box-sizing:border-box}.fl-form textarea{min-height:70px}
.fl-chain{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}.fl-step{display:grid;grid-template-columns:150px minmax(0,1fr) auto;gap:8px;align-items:center}.fl-hint{font-size:12.5px;color:var(--dim);min-height:1.2em}`;
  document.head.append(s);
}

const statusWord = { running: ['Running', 'run'], waiting: ['Waiting for you', 'wait'], done: ['Done', 'ok'], failed: ['Did not finish', 'stop'], stopped: ['Stopped', 'stop'], interrupted: ['Interrupted', 'stop'], missed: ['Missed', 'wait'], skipped: ['Skipped', 'wait'] };

export const pages = {
  flows: {
    title: 'Flows and Schedules',
    async render(el, ui) {
      style();
      const { h, api, btn, pill, sw, line, empty, fmt, toast } = ui;
      const root = h('div', { class: 'stack' });
      el.append(root);
      let data = { schedules: [], chains: [], agents: [] };

      async function load() {
        try {
          const [s, c] = await Promise.all([api('m/flows/schedules'), api('m/flows/chains')]);
          data = { ...s, chains: c.chains, agents: ui.state.agents || [] };
          paint();
        } catch (e) { root.replaceChildren(empty('Schedules could not load: ' + e.message)); }
      }
      let timer = null; const soon = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
      ui.on('schedule', soon); ui.on('flow', soon);
      ui.on('job', (j) => { if (String(j?.kind || '').startsWith('flows.')) soon(); });
      ui.onLeave?.(() => clearTimeout(timer));

      const agentName = (id) => ui.agent(id)?.name || 'Coordinator';
      /** Shorten at a word, never in the middle of one; the full text stays on hover. */
      const short = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); if (s.length <= n) return s; const cut = s.slice(0, n + 1); const i = cut.lastIndexOf(' '); return (i > n * 0.4 ? cut.slice(0, i) : s.slice(0, n)).replace(/[\s,;:.-]+$/, '') + '…'; };
      const node = (title, small, cls = '', full = null) => h('div', { class: 'node ' + cls, title: full }, title, h('small', null, small));
      const wire = (live) => h('div', { class: 'wire' + (live ? '' : ' idle') });
      function chainRow(nodes, cur, live) {
        const out = [];
        nodes.forEach((n, i) => { if (i) out.push(wire(live && (cur == null || i <= cur + 1))); out.push(node(n[0], n[1], live && cur === i ? 'cur' : '', n[2])); });
        return h('div', { class: 'flow' }, out);
      }
      const clockFor = (s) => s.nextRun ? fmt.time(s.nextRun) : s.when;

      function briefCard(s) {
        const nodes = [['Clock', clockFor(s)], ['Tasks', 'running, waiting']];
        if (data.salesOn) nodes.push(['Pipeline', 'changes']);
        if (s.topics?.length) nodes.push(['News', s.topics.slice(0, 2).join(', ')]);
        nodes.push([s.agentName, 'writes the brief']);
        return h('div', { class: 'card' },
          h('div', { class: 'row', style: { marginBottom: '8px' } }, h('b', null, s.title), pill(s.enabled ? s.when : 'Paused'), h('span', { class: 'grow' }),
            btn('Run now', { kind: 'ghost sm', onClick: () => runSchedule(s) }), btn('Edit', { kind: 'ghost sm', onClick: () => editSchedule(s) })),
          chainRow(nodes, s.running ? nodes.length - 1 : null, s.running));
      }
      function chainCard(c) {
        const sched = data.schedules.find(s => s.chainId === c.id);
        const nodes = [...(sched ? [['Clock', clockFor(sched)]] : []), ...c.steps.map(st => [st.agentName, short(st.instruction, 28), st.instruction])];
        const cur = c.running && c.currentStep != null ? c.currentStep + (sched ? 1 : 0) : null;
        const st = statusWord[c.lastStatus];
        return h('div', { class: 'fl-chain', dataset: { chain: c.id } },
          h('div', { class: 'row', style: { marginBottom: '8px' } }, h('b', null, c.title), sched ? pill(sched.enabled ? sched.when : 'Paused') : pill('Run by hand'),
            st && c.lastRun ? h('span', { class: 'sub' }, `${st[0]} ${fmt.ago(c.lastRun)}`) : null, h('span', { class: 'grow' }),
            btn('Run now', { kind: 'ghost sm', disabled: c.running, onClick: async () => { try { await api(`m/flows/chains/${c.id}/run`, { body: {} }); toast(`Started: ${c.title}`); load(); } catch (e) { toast(e.message, 'err'); } } }),
            btn('Edit', { kind: 'ghost sm', onClick: () => editChain(c) })),
          chainRow(nodes, cur, c.running));
      }
      function schedLine(s) {
        const st = statusWord[s.lastStatus];
        const what = s.chainTitle ? `Runs the chain ${s.chainTitle}` : s.kind === 'brief' ? 'Brief' : (s.what || '');
        const bits = [short(what, 90)];
        bits.push(s.enabled ? (s.nextRun ? `next ${fmt.when(s.nextRun)}` : 'not armed') : 'paused');
        if (s.lastRun) bits.push(`last ${fmt.when(s.lastRun)}${st ? ', ' + st[0].toLowerCase() : ''}`);
        const row = line(s.title, `${s.when} · ${bits.join(' · ')}${s.lastNote && s.lastStatus !== 'missed' ? ' · ' + s.lastNote : ''}`,
          s.missedAt ? pill(`Missed ${fmt.when(s.missedAt)}`, 'wait') : s.running ? pill('Running', 'run') : null,
          btn('Run now', { kind: 'ghost sm', disabled: s.running, onClick: () => runSchedule(s) }),
          btn('Edit', { kind: 'ghost sm', onClick: () => editSchedule(s) }),
          sw(s.enabled, (s.enabled ? 'Pause ' : 'Switch on ') + s.title, async (on) => { await api(`m/flows/schedules/${s.id}`, { method: 'PATCH', body: { enabled: on } }); load(); }));
        const d = row.querySelector('.d'); if (d) { d.title = what; d.style.overflowWrap = 'anywhere'; }
        return row;
      }
      function paint() {
        const briefs = data.schedules.filter(s => s.kind === 'brief');
        const hasMorning = briefs.length > 0;
        root.replaceChildren(
          ...briefs.slice(0, 2).map(briefCard),
          h('div', { class: 'card' },
            h('div', { class: 'row', style: { marginBottom: '4px' } }, h('h3', { style: { margin: 0 } }, 'Schedules'), h('span', { class: 'grow' }),
              hasMorning ? null : btn('Add the morning brief', { kind: 'ghost sm', onClick: () => editSchedule({ ...data.template, agentId: 'coordinator' }, true) }),
              btn('New schedule', { kind: 'sm', onClick: () => editSchedule({ title: '', when: '', prompt: '', agentId: 'coordinator', topics: [] }, true) })),
            data.schedules.length ? h('div', null, data.schedules.map(schedLine)) : empty('Nothing is scheduled. Ask in Chat, for example "Every morning at 8, brief me".'),
            h('div', { class: 'sub', style: { marginTop: '6px' } }, 'Times are in your zone. A run that was due while the desk was off is shown as missed; it is not run by itself.')),
          h('div', { class: 'card' },
            h('div', { class: 'row', style: { marginBottom: '8px' } }, h('h3', { style: { margin: 0 } }, 'Chains of agents'), h('span', { class: 'grow' }),
              btn('New chain', { kind: 'sm', onClick: () => editChain({ title: '', steps: [{ agentId: 'scout', instruction: '' }, { agentId: 'coordinator', instruction: '' }] }) })),
            h('p', { class: 'sub' }, 'Each agent gets the work of the one before it.'),
            ...data.chains.map(chainCard)));
      }
      async function runSchedule(s) { try { await api(`m/flows/schedules/${s.id}/run`, { body: {} }); toast(`Started: ${s.title}`); load(); } catch (e) { toast(e.message, 'err'); } }

      const field = (label, input) => h('label', null, label, input);
      const agentSelect = (value) => h('select', null, (ui.state.agents || []).map(a => h('option', { value: a.id, selected: a.id === value }, a.name)));

      function editSchedule(s, isNew = false) {
        const title = h('input', { type: 'text', value: s.title || '', placeholder: 'Morning brief' });
        const when = h('input', { type: 'text', value: s.words || (isNew ? s.when || '' : s.when) || '', placeholder: 'every morning at 8, every weekday at 9, in 20 minutes, tomorrow at 7' });
        const hint = h('div', { class: 'fl-hint' }, s.nextRun ? `Next run ${fmt.when(s.nextRun)}` : '');
        const prompt = s.builtIn ? h('textarea', { disabled: true }, s.what || '') : h('textarea', { placeholder: 'What should happen, in your words' }, s.work ?? s.prompt ?? '');
        // the note Chat kept with the ask: shown read-only, never edited here; the server keeps it after the work part
        const context = s.context ? field('Context from the chat', h('div', { class: 'sub', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, s.context)) : null;
        const agent = agentSelect(s.agentId || 'coordinator');
        const runs = h('select', null, h('option', { value: '' }, 'Its own instruction'), h('option', { value: 'brief', selected: s.kind === 'brief' }, 'The morning brief'),
          data.chains.map(c => h('option', { value: 'chain:' + c.id, selected: s.chainId === c.id }, 'The chain ' + c.title)));
        const topics = h('input', { type: 'text', value: (s.topics || []).join(', '), placeholder: data.searchOn ? 'data centres, monsoon' : 'Search is off: news is not checked' });
        let t = null;
        when.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { try { const p = await api('m/flows/parse', { body: { when: when.value } }); hint.textContent = p.ok ? `${p.text} · next run ${fmt.when(p.next)}` : when.value ? 'The desk will ask a model to read this when you save.' : ''; } catch {} }, 300); });
        const body = h('div', { class: 'fl-form' }, field('Name', title), field('When', when), hint, field('What to do', prompt), context, field('Who does it', agent), field('Runs', runs), field('News topics for a brief (comma between them)', topics));
        const save = async () => {
          const r = runs.value;
          const payload = { title: title.value, when: when.value, prompt: prompt.value, agentId: agent.value, chainId: r.startsWith('chain:') ? r.slice(6) : null, kind: r === 'brief' ? 'brief' : 'prompt', topics: topics.value.split(',').map(x => x.trim()).filter(Boolean) };
          try {
            if (isNew) await api('m/flows/schedules', { body: payload });
            else { if (when.value === s.when || when.value === s.words) delete payload.when; if (s.builtIn) { delete payload.prompt; delete payload.kind; } await api(`m/flows/schedules/${s.id}`, { method: 'PATCH', body: payload }); }
            toast('Saved', 'ok'); load(); return true;
          } catch (e) { toast(e.message, 'err'); return false; }
        };
        const actions = [...(isNew ? [] : [{ label: 'Delete', kind: 'ghost', onClick: async () => { if (!await ui.confirm(`Delete the schedule "${s.title}"?`, { ok: 'Delete', kind: 'stop' })) return false; await api(`m/flows/schedules/${s.id}`, { method: 'DELETE' }); load(); } }]), { label: 'Cancel' }, { label: isNew ? 'Schedule it' : 'Save', kind: ' ', onClick: save }];
        ui.modal({ title: isNew ? 'New schedule' : 'Edit schedule', body, actions });
        setTimeout(() => (isNew && !s.title ? when : title).focus(), 30);
      }

      function editChain(c) {
        const title = h('input', { type: 'text', value: c.title || '', placeholder: 'Weekly market note' });
        const rows = h('div', { class: 'stack', style: { gap: '8px' } });
        const addRow = (st) => {
          const sel = agentSelect(st.agentId); const ins = h('input', { type: 'text', value: st.instruction || '', placeholder: 'What this agent does' });
          const row = h('div', { class: 'fl-step' }, sel, ins, btn('Remove', { kind: 'ghost sm', onClick: () => row.remove() }));
          row.get = () => ({ agentId: sel.value, instruction: ins.value }); rows.append(row);
        };
        (c.steps || []).forEach(addRow);
        const when = h('input', { type: 'text', value: '', placeholder: c.id ? 'Leave empty to keep its schedule' : 'Optional: every Monday at 10' });
        const body = h('div', { class: 'fl-form' }, field('Name', title), h('div', { class: 'sub' }, 'Steps, in order'), rows, h('div', null, btn('Add a step', { kind: 'ghost sm', onClick: () => addRow({ agentId: 'coordinator', instruction: '' }) })), field('Schedule it (plain words)', when));
        const save = async () => {
          const steps = [...rows.children].map(r => r.get()).filter(s => s.instruction.trim());
          try {
            const saved = c.id ? await api(`m/flows/chains/${c.id}`, { method: 'PATCH', body: { title: title.value, steps } }) : await api('m/flows/chains', { body: { title: title.value || 'Chain', steps } });
            if (when.value.trim()) { const ex = data.schedules.find(s => s.chainId === saved.id); if (ex) await api(`m/flows/schedules/${ex.id}`, { method: 'PATCH', body: { when: when.value } }); else await api('m/flows/schedules', { body: { title: saved.title, when: when.value, chainId: saved.id, agentId: steps[0]?.agentId } }); }
            toast('Saved', 'ok'); load(); return true;
          } catch (e) { toast(e.message, 'err'); return false; }
        };
        const actions = [...(c.id ? [{ label: 'Delete', kind: 'ghost', onClick: async () => { if (!await ui.confirm(`Delete the chain "${c.title}" and its schedule?`, { ok: 'Delete', kind: 'stop' })) return false; await api(`m/flows/chains/${c.id}`, { method: 'DELETE' }); load(); } }] : []), { label: 'Cancel' }, { label: 'Save', kind: ' ', onClick: save }];
        ui.modal({ title: c.id ? 'Edit chain' : 'New chain of agents', body, actions, wide: true });
      }
      await load();
    },
  },
};
