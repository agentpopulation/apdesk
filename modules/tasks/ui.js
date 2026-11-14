// Tasks: running, waiting for you, done. Right column: schedules and chains from Flows and Schedules.
const STYLE_ID = 'tasks-style';
function style() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style'); s.id = STYLE_ID;
  s.textContent = `.view.tasksv{height:100%;min-height:0;overflow:hidden}
.tk-two{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px}
.tk-col{min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;padding-right:2px}
.tk-group{display:flex;flex-direction:column;gap:8px}.tk-group>h3{margin:4px 0 0;display:flex;gap:8px;align-items:center}
.tk-job{display:flex;flex-direction:column;gap:6px}.tk-job .top{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.tk-job .what{flex:2;min-width:160px}.tk-job .what .sub{overflow-wrap:anywhere}
.tk-house>summary{cursor:pointer}.tk-house>summary h3{display:inline-flex;gap:8px;align-items:center}.tk-house>summary .sub{display:block;margin:2px 0 0 18px}.tk-house[open]>summary{margin-bottom:8px}
.tk-ans{max-height:320px;overflow:auto;border-top:1px solid var(--line);padding-top:8px}
.tk-form{display:flex;flex-direction:column;gap:10px;width:100%}.tk-form textarea{min-height:110px;width:100%;box-sizing:border-box}.tk-form label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dim)}
@media (max-width:860px){.tk-two{grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;overflow:auto}.tk-col{overflow:visible}}`;
  document.head.append(s);
}
const ACTIVE = ['running', 'waiting'];
const PILL = { running: ['Running', 'run'], waiting: ['Waiting for you', 'wait'], done: ['Done', 'ok'], failed: ['Failed', 'stop'], stopped: ['Stopped', 'stop'], interrupted: ['Interrupted', 'stop'] };

export const pages = {
  tasks: {
    title: 'Tasks',
    async render(el, ui, route) {
      style();
      const { h, api, btn, pill, meter, empty, fmt, toast, md } = ui;
      el.classList.add('tasksv');
      const jobs = new Map(); let approvals = []; let showAll = false; const open = new Set(); let house = null;
      const left = h('div', { class: 'tk-col' }); const right = h('div', { class: 'tk-col' });
      el.append(
        h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, ui.label('tasks', 'Tasks')), h('span', { class: 'grow' }), btn('New task', { onClick: newTask })),
        h('div', { class: 'tk-two' }, left, right));

      const who = (id) => ui.agent(id)?.name || 'Coordinator';
      const isRepeatable = (j) => j.kind === 'tasks.run' || String(j.kind).startsWith('flows.');
      function results(j) {
        const o = j.output && typeof j.output === 'object' ? j.output : {};
        const out = [];
        const chatId = o.chatId || j.chatId;
        if (chatId && ui.moduleOn('chat')) out.push(btn('Open the chat', { kind: 'ghost sm', onClick: () => ui.go('chat', chatId) }));
        const files = [...(Array.isArray(o.files) ? o.files : []), ...(Array.isArray(o.cards) ? o.cards.filter(c => c?.kind === 'file' || c?.kind === 'report') : [])];
        for (const p of [o.path, o.reportPath, o.file?.path].filter(Boolean)) files.push({ kind: 'file', path: p, name: String(p).split(/[\\/]/).pop() });
        const seen = new Set();
        for (const f of files.slice(0, 4)) {
          const key = f.go || f.path; if (!key || seen.has(key)) continue; seen.add(key);
          if (f.kind === 'report' && f.go) out.push(btn('Open the report', { kind: 'ghost sm', onClick: () => { location.hash = f.go; } }));
          else out.push(btn('Open ' + (f.name || 'the file'), { kind: 'ghost sm', onClick: () => (ui.openFile ? ui.openFile(f.path) : (location.hash = '#/files?path=' + encodeURIComponent(f.path))) }));
        }
        if (o.go) out.push(btn('Open', { kind: 'ghost sm', onClick: () => { location.hash = o.go; } }));
        return out;
      }
      function answerOf(j) { const o = j.output; if (!o || typeof o !== 'object') return typeof o === 'string' ? o : ''; return o.answer || o.text || o.summary || ''; }
      function jobCard(j) {
        const [word, kind] = PILL[j.status] || [j.status, ''];
        const active = ACTIVE.includes(j.status);
        const label = j.output?.label;
        const when = active ? `started ${fmt.ago(j.created)}` : `${word.toLowerCase()} ${fmt.when(j.finished || j.updated)}`;
        const detail = j.status === 'failed' ? (j.error || 'Failed') : j.status === 'interrupted' ? 'The desk restarted while this ran. It was not resumed.' : active ? (j.detail || 'Working') : (label ? `answered by ${label}` : (j.detail || ''));
        const ans = answerOf(j);
        const card = h('div', { class: 'card tk-job' },
          h('div', { class: 'top' },
            h('div', { class: 'what' }, h('b', null, j.title), h('div', { class: 'sub', title: detail }, `${j.quiet ? 'The desk' : who(j.agentId)} · ${when}${detail ? ' · ' + detail : ''}`)),
            active ? meter(j.progress || 0, { live: j.status === 'running' }) : null,
            pill(active && j.status === 'running' ? fmt.pct(j.progress) : word, kind),
            active ? btn('Stop', { kind: 'ghost sm', onClick: async () => { try { await api(`jobs/${j.id}/stop`, { method: 'POST' }); } catch (e) { toast(e.message, 'err'); } } }) : null),
          !active ? h('div', { class: 'row' },
            ans ? btn(open.has(j.id) ? 'Hide the answer' : 'Read the answer', { kind: 'ghost sm', onClick: () => { open.has(j.id) ? open.delete(j.id) : open.add(j.id); paint(); } }) : null,
            ...results(j),
            j.status !== 'done' && isRepeatable(j) ? btn('Run again', { kind: 'sm', onClick: () => again(j) }) : null) : null,
          !active && ans && open.has(j.id) ? h('div', { class: 'tk-ans' }, md(ans), label ? h('div', { class: 'sub' }, label) : null) : null);
        return card;
      }
      async function again(j) { try { const n = await api(`m/tasks/jobs/${j.id}/again`, { body: {} }); jobs.set(n.id, n); toast(`Started again: ${j.title}`); paint(); } catch (e) { toast(e.message, 'err'); } }
      const group = (title, n, items, emptyText) => h('div', { class: 'tk-group' }, h('h3', null, title, n ? pill(String(n)) : null), items.length ? items : [empty(emptyText)]);
      function paint() {
        const all = [...jobs.values()].sort((a, b) => String(b.created).localeCompare(String(a.created)));
        // the desk's own upkeep (quiet jobs, such as the nightly Dream) goes under Housekeeping, closed; one that failed stays with the owner's work
        const upkeep = all.filter(j => j.quiet && j.status !== 'failed');
        const owners = all.filter(j => !upkeep.includes(j));
        const running = owners.filter(j => j.status === 'running');
        const waiting = owners.filter(j => j.status === 'waiting');
        const done = owners.filter(j => !ACTIVE.includes(j.status));
        const shown = showAll ? done : done.slice(0, 12);
        const stopped = ui.stoppedSection?.();
        const keepOpen = !!house?.open;
        house = upkeep.length ? h('details', { class: 'tk-group tk-house', open: keepOpen },
          h('summary', null, h('h3', null, 'Housekeeping', pill(String(upkeep.length))), h('span', { class: 'sub' }, 'Upkeep the desk does by itself, such as tidying memory at night.')),
          ...upkeep.slice(0, 20).map(jobCard)) : null;
        left.replaceChildren(
          group('Running', running.length, running.map(jobCard), 'Nothing is running.'),
          group('Waiting for you', approvals.length + waiting.length, [...approvals.map(a => ui.approvalCard ? ui.approvalCard(a) : h('div', { class: 'card' }, a.title)), ...waiting.map(jobCard), stopped].filter(Boolean), 'Nothing waits for you.'),
          group('Done', done.length, [...shown.map(jobCard), done.length > shown.length ? btn(`Show all ${done.length}`, { kind: 'ghost sm', onClick: () => { showAll = true; paint(); } }) : null].filter(Boolean), 'Finished work waits here, even when the browser was closed.'),
          ...[house].filter(Boolean));
      }
      let t = null; const soon = () => { clearTimeout(t); t = setTimeout(paint, 120); };
      async function loadJobs() { const r = await api('m/tasks/jobs?limit=150'); jobs.clear(); for (const j of r.jobs) jobs.set(j.id, j); }
      async function loadApprovals() { try { approvals = (await api('approvals')).pending || []; } catch { approvals = []; } await ui.refreshStopped?.(); }
      ui.on('job', (j) => { if (j?.id) { jobs.set(j.id, { ...(jobs.get(j.id) || {}), ...j }); soon(); } });
      ui.on('approval', async () => { await loadApprovals(); soon(); });
      ui.on('panic', async () => { await Promise.all([loadJobs(), loadApprovals()]); paint(); });
      ui.onLeave?.(() => clearTimeout(t));
      await Promise.all([loadJobs(), loadApprovals()]);
      paint();

      // right column: schedules and chains of agents
      if (ui.moduleOn('flows')) {
        try { const f = await ui.moduleUi('flows'); if (f?.pages?.flows) await f.pages.flows.render(right, ui); else right.append(empty('Schedules could not open.')); }
        catch (e) { right.append(empty('Schedules could not open: ' + e.message)); }
      } else right.append(ui.card(h('h3', null, 'Schedules'), empty('Flows and Schedules is switched off.')));

      function newTask() {
        const text = h('textarea', { placeholder: 'What should be done? For example: compare three rack suppliers and make a table.' });
        const agent = h('select', null, (ui.state.agents || []).map(a => h('option', { value: a.id }, `${a.name}${a.role ? ' · ' + a.role : ''}`)));
        const body = h('div', { class: 'tk-form' }, h('label', null, 'What you want', text), h('label', null, 'Who does it', agent), h('p', { class: 'sub' }, 'It keeps working when you close the browser. The result waits here.'));
        ui.modal({ title: 'New task', body, actions: [{ label: 'Cancel' }, { label: 'Start', kind: ' ', onClick: async () => {
          if (!text.value.trim()) { toast('Say what the task should do.', 'err'); return false; }
          try { const j = await api('m/tasks/create', { body: { prompt: text.value, agentId: agent.value } }); jobs.set(j.id, j); paint(); toast(`Started: ${j.title}`, 'ok'); return true; } catch (e) { toast(e.message, 'err'); return false; }
        } }] });
        setTimeout(() => text.focus(), 30);
      }
      if (route?.params?.new === '1') newTask();
    },
  },
};
