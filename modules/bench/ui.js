// Bench mode: the page (sessions and the note "While you were away"), the settings card, and the card Home shows on return.
const API = 'm/bench/';
const KIND_WORDS = { needs: 'Needs you', work: 'Unfinished work', doubt: 'Doubt', lesson: 'Lesson', profile: 'Your business', competitor: 'Competitor', skill: 'Skill draft', lead: 'Possible customer', funding: 'Money and credits', tool: 'Free tool', report: 'Market report', table: 'Pricing table', plan: '30-day plan', draft: 'Draft' };
const STATE_WORDS = { new: 'Waiting for you', kept: 'Kept', dismissed: 'Dismissed', task: 'Turned into a task' };
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const REASONS = [['wrong facts', 'Wrong facts'], ['weak sources', 'Weak sources'], ['missed the point', 'Missed the point'], ['too long', 'Too long'], ['too short', 'Too short'], ['outdated', 'Outdated'], ['other', 'Other']];
/** Today's paid spend in words (a free or local choice spends nothing: "No paid spend today"). */
export const spendWords = (g, fmt) => g.daySpendMinor > 0 ? `${fmt.money(g.daySpendMinor, g.currency)} spent today` : 'No paid spend today';
const spendLine = (ui, g) => spendWords(g, ui.fmt);
/** The owner's own name for Bench's menu place (Settings, Menu), which the shell gives a page as ui.label; else "Bench". */
export const placeName = (ui) => (typeof ui?.label === 'function' && ui.label('bench', 'Bench')) || 'Bench';
const modeName = (ui) => placeName(ui);   // one name everywhere: the menu, the settings tab, the Store card and the switch
/** The usage rows as the kit's table reads them: columns { key, label } and one object per row. */
export function usageTable(u, fmt) {
  const cols = [{ key: 'agent', label: 'Agent' }, { key: 'calls', label: 'Calls' }, { key: 'errors', label: 'Errors' }, { key: 'tokens', label: 'Tokens' }, { key: 'spend', label: 'Spend' }];
  const rows = (u.agents || []).map((a) => ({ agent: a.name || (a.agent === '(desk)' ? 'The desk' : 'An agent'), calls: String(a.calls), errors: String(a.errors), tokens: String((a.inputTokens || 0) + (a.outputTokens || 0)), spend: a.costMinor > 0 ? fmt.money(a.costMinor, u.currency) : '—' }));
  return { cols, rows };
}
const TODO_WORDS = { queued: 'Queued', running: 'Running', done: 'Done', skipped: 'Skipped' };
const leftWords = (ms) => ms == null ? '—' : ms <= 0 ? 'nothing queued now' : ms < 60000 ? 'under a minute' : `about ${Math.round(ms / 60000)} minute${Math.round(ms / 60000) === 1 ? '' : 's'}`;
const stat = (ui, value, label) => ui.h('div', null, ui.h('b', { style: { fontSize: '20px', display: 'block' } }, String(value)), ui.h('span', { class: 'sub' }, label));

/** The quiet rating controls shown under an answer or a finding. Owner-only (the route refuses others). */
export function ratingBar(ui, targetType, targetId, initial) {
  const { h, btn, toast } = ui;
  let r = { thumb: null, research: null, reasons: [], comment: '', ...(initial || {}) };
  const wrap = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'center' } });
  const chip = (label, active, onClick) => btn(label, { kind: active ? 'sm' : 'ghost sm', onClick });
  const save = async (patch) => { r = { ...r, ...patch }; try { const res = await ui.api('m/bench/ratings', { body: { targetType, targetId, thumb: r.thumb, research: r.research, reasons: r.reasons, comment: r.comment } }); r = { thumb: null, research: null, reasons: [], comment: '', ...(res.rating || {}) }; paint(); } catch (e) { toast(e.message, 'err'); } };
  function paint() {
    const open = r.thumb === 'down' || r.research === 'bad' || (r.reasons && r.reasons.length) || r.comment;
    const kids = [h('span', { class: 'sub' }, 'Answer'),
      chip('Good', r.thumb === 'up', () => save({ thumb: r.thumb === 'up' ? null : 'up' })),
      chip('Poor', r.thumb === 'down', () => save({ thumb: r.thumb === 'down' ? null : 'down' })),
      h('span', { class: 'sub' }, 'Research'),
      chip('Strong', r.research === 'good', () => save({ research: r.research === 'good' ? null : 'good' })),
      chip('Weak', r.research === 'bad', () => save({ research: r.research === 'bad' ? null : 'bad' }))];
    if (open) {
      for (const [val, lbl] of REASONS) kids.push(chip(lbl, (r.reasons || []).includes(val), () => { const set = new Set(r.reasons || []); set.has(val) ? set.delete(val) : set.add(val); save({ reasons: [...set] }); }));
      kids.push(btn(r.comment ? 'Edit note' : 'Add a note', { kind: 'ghost sm', onClick: async () => { const t = await ui.ask('What was off? (optional)', { value: r.comment || '', multiline: true }); if (t != null) save({ comment: t }); } }));
    }
    wrap.replaceChildren(...kids);
  }
  paint();
  return wrap;
}

/** "How I got this": the desk's own record of what ran, loaded when opened. Factual, not a model's stated reason. */
export function stepsBlock(ui, jobId) {
  const { h, btn } = ui;
  if (!jobId) return null;
  const body = h('div', { class: 'stack', style: { marginTop: '6px', gap: '2px' }, hidden: true });
  let loaded = false;
  const toggle = btn('How I got this', { kind: 'ghost sm', onClick: async () => {
    body.hidden = !body.hidden;
    if (!body.hidden && !loaded) { loaded = true;
      try { const r = await ui.api(`m/bench/steps/${encodeURIComponent(jobId)}`);
        body.replaceChildren(h('p', { class: 'sub' }, "The desk's record of what ran — times, models and pages. Not a model's own reason."),
          ...(r.steps.length ? r.steps.map((s, i) => h('div', { class: 'sub', style: { overflowWrap: 'anywhere' } }, `${i + 1}. ${s.action}${s.model ? ' · ' + s.model : ''}${s.ms ? ' · ' + Math.round(s.ms) + ' ms' : ''}${s.outcome ? ' — ' + s.outcome : ''}`)) : [h('p', { class: 'sub' }, 'Nothing was recorded for this one.')]));
      } catch (e) { body.replaceChildren(h('p', { class: 'sub' }, ui.plainError(e))); }
    }
  } });
  return h('div', null, toggle, body);
}

function itemCard(ui, it, onDone) {
  const { h, btn, pill, toast, card, fmt } = ui;
  const act = (a) => async () => {
    try {
      const r = await ui.api(`${API}items/${it.id}/${a}`, { body: {} });
      if (r.apply?.setting === 'business.about') {
        // a profile is saved into Settings by the owner's own click, through the shell's own settings route
        const ok = await ui.confirm(`Save this as "What you do" in Settings › General?\n\n${r.apply.text}`, { ok: 'Save', title: 'Your business' });
        if (ok) { const s = await ui.api('settings', { body: { 'business.about': r.apply.text } }); ui.state.settings = s.settings; toast('Saved in Settings › General', 'ok'); }
      } else if (r.result) toast(r.result, 'ok');
      onDone?.();
    } catch (e) { toast(e.message, 'err'); }
  };
  const draftAct = (a, body = {}) => async () => {
    try { const r = await ui.api(`${API}items/${it.id}/${a}`, { body }); toast(a === 'handover' ? r.item?.result || 'Handed over.' : 'Draft ready.', 'ok'); onDone?.(); } catch (e) { toast(e.message, 'err'); }
  };
  const editDraft = async () => {
    const d = it.data?.draft; if (!d) return;
    if (d.type === 'onepager') {
      const summary = await ui.ask('Summary', { value: d.summary, multiline: true }); if (summary == null) return;
      const points = await ui.ask('Key points, one per line', { value: d.points.join('\n'), multiline: true }); if (points == null) return;
      const recommendation = await ui.ask('Recommendation', { value: d.recommendation || '', multiline: true }); if (recommendation == null) return;
      return draftAct('edit', { draft: { summary, points: points.split('\n'), recommendation } })();
    }
    const lines = await ui.ask('One action per line: action | effort | why', { value: d.actions.map((x) => `${x.action} | ${x.effort} | ${x.why}`).join('\n'), multiline: true }); if (lines == null) return;
    return draftAct('edit', { draft: { actions: lines.split('\n').map((l) => { const [action, effort, ...why] = l.split('|').map((x) => x.trim()); return { action, effort, why: why.join(' | ') }; }) } })();
  };
  const handover = async () => { const to = await ui.ask('Hand this to Mail drafts. Who is it for? (optional e-mail address)', { value: '' }); if (to == null) return; draftAct('handover', { to })(); };
  const isDraft = it.kind === 'draft';
  const draftRow = it.state !== 'new' ? null : isDraft
    ? h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap', gap: '6px' } }, h('span', { class: 'sub' }, 'A rough draft, not checked line by line.'), h('span', { class: 'grow' }),
      btn('Edit', { kind: 'ghost sm', onClick: editDraft }), btn('Make again', { kind: 'ghost sm', onClick: draftAct('redo') }), btn('Hand to Mail drafts', { kind: 'ghost sm', onClick: handover }))
    : it.kind === 'needs' || !it.draftable ? null
    : h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap', gap: '6px' } }, h('span', { class: 'sub' }, 'Make a draft:'), btn('One-pager', { kind: 'ghost sm', onClick: draftAct('draft', { type: 'onepager' }) }), btn('Next actions', { kind: 'ghost sm', onClick: draftAct('draft', { type: 'actions' }) }));
  const go = it.data?.go ? btn('Open', { kind: 'ghost sm', onClick: () => { const [p, ...rest] = String(it.data.go).split('/'); ui.go(p, ...rest); } }) : null;
  const decided = it.state !== 'new';
  return card({ class: 'bench-item', 'data-kind': it.kind },
    h('div', { class: 'row' }, pill(KIND_WORDS[it.kind] || it.kind, it.kind === 'needs' ? 'wait' : ''), h('span', { class: 'grow' }),
      it.kind === 'needs' ? null : isDraft ? pill(it.data?.handedOver ? 'Draft, handed to Mail' : 'Draft', 'wait') : pill(it.complete ? 'Every line has its source' : 'Some lines not checked', it.complete ? 'ok' : '')),
    h('b', { style: { display: 'block', marginTop: '6px', overflowWrap: 'anywhere' } }, it.title),
    it.body ? h('p', { class: 'sub', style: { whiteSpace: 'pre-wrap', marginTop: '6px', overflowWrap: 'anywhere' } }, it.body) : null,
    (it.evidence || []).length ? h('div', { style: { marginTop: '6px' } }, it.evidence.map((e) => h('div', { class: 'sub', style: { marginTop: '4px', overflowWrap: 'anywhere' } },
      e.url ? h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, e.title || hostOf(e.url)) : h('span', null, e.title || 'Your desk'),
      e.quote ? h('span', null, `: "${e.quote}"`) : e.url ? h('span', null, ' (no quote kept)') : null))) : null,
    h('div', { class: 'row', style: { marginTop: '8px' } },
      decided ? h('span', { class: 'sub' }, `${STATE_WORDS[it.state]}${it.decided ? ' ' + fmt.when(it.decided) : ''}${it.result ? ': ' + it.result : ''}`) : null,
      h('span', { class: 'grow' }), go,
      decided ? null : isDraft ? [btn('Accept', { kind: 'sm', onClick: act('keep') }), btn('Discard', { kind: 'ghost sm', onClick: act('dismiss') })]
        : [it.kind === 'needs' ? null : btn('Keep', { kind: 'sm', onClick: act('keep') }), btn('Dismiss', { kind: 'ghost sm', onClick: act('dismiss') }), btn('Turn into a task', { kind: 'ghost sm', onClick: act('task') })]),
    draftRow,
    stepsBlock(ui, it.data?._jobId),
    ratingBar(ui, 'bench_item', it.id, it.rating));
}

/** The note: built on the server by code from the items; shown here as it came. */
function noteView(ui, data, { filter, onChange }) {
  const { h, card, fmt, seg } = ui;
  const { session, note, items } = data;
  const kinds = [...new Set(items.map((i) => i.kind))];
  const kindSeg = seg(['All', ...kinds.map((k) => KIND_WORDS[k] || k)], filter.kind ? kinds.indexOf(filter.kind) + 1 : 0, (_, i) => onChange({ ...filter, kind: i ? kinds[i - 1] : '' }));
  const states = ['new', 'kept', 'dismissed', 'task', ''];
  const stateSeg = seg(['Waiting', 'Kept', 'Dismissed', 'Tasks', 'All'], Math.max(0, states.indexOf(filter.state ?? 'new')), (_, i) => onChange({ ...filter, state: states[i] }));
  const byId = new Map(items.map((i) => [i.id, i]));   // items carry rating and _jobId; the note's best/groups are raw, so look them up
  const full = (i) => byId.get(i.id) || i;
  const want = items.filter((i) => (!filter.kind || i.kind === filter.kind) && (filter.state === '' || i.state === (filter.state ?? 'new')));
  const bestIds = new Set(note.best.map((i) => i.id));
  const showBest = !filter.kind && (filter.state ?? 'new') === 'new' && note.best.length;
  const rest = want.filter((i) => !(showBest && bestIds.has(i.id)));
  const byKind = new Map(); for (const i of rest) { if (!byKind.has(i.kind)) byKind.set(i.kind, []); byKind.get(i.kind).push(i); }
  const refresh = () => onChange(filter);
  return h('div', { class: 'stack', 'data-apd': 'bench-note' },
    card(h('h3', null, session.state === 'running' ? 'Working now' : 'While you were away'), h('p', { class: 'sub' }, `${fmt.when(session.started)} to ${session.ended ? fmt.when(session.ended) : 'now'}`), ...note.head.map((l) => h('p', null, l))),
    h('div', { class: 'row' }, kinds.length > 1 ? kindSeg : null, stateSeg),
    showBest ? h('div', { class: 'stack' }, h('h3', { style: { margin: 0 } }, 'Best first'), h('p', { class: 'sub' }, note.rule), ...note.best.map((i) => itemCard(ui, full(i), refresh))) : null,
    ...[...byKind.entries()].sort((a, b) => (a[0] === 'needs' ? -1 : b[0] === 'needs' ? 1 : 0)).map(([k, list]) => h('div', { class: 'stack' }, h('h3', { style: { margin: 0 } }, `${KIND_WORDS[k] || k} (${list.length})`), ...list.map((i) => itemCard(ui, i, refresh)))),
    !want.length ? ui.empty('Nothing here with this filter.') : null,
    note.notDone.length ? card(h('h3', null, `What ${placeName(ui)} could not do`), ...note.notDone.map((l) => h('p', { class: 'sub' }, l))) : null,
    data.todo ? card(todoView(ui, data.todo, { ended: session.state !== 'running' })) : null);
}

/** The session's activities as a to-do list, with the time left from earlier measured durations (a dash when none). */
function todoView(ui, todo, { ended = false } = {}) {
  const { h } = ui;
  if (!todo) return null;
  return h('div', { class: 'stack', 'data-apd': 'bench-todo', style: { gap: '2px' } },
    h('div', { class: 'row' }, h('b', null, ended ? 'To do, as it was left' : 'To do'), h('span', { class: 'grow' }), ended ? null : h('span', { class: 'sub' }, `Time left: ${leftWords(todo.leftMs)}`)),
    ...todo.items.map((i) => h('div', { class: 'sub', style: { overflowWrap: 'anywhere' } }, `${TODO_WORDS[i.status] || i.status} · ${i.title}${i.why ? ' (' + i.why + ')' : ''}`)),
    !ended && todo.leftMs == null ? h('p', { class: 'sub' }, 'No earlier work has been timed yet, so there is no estimate.') : null);
}

/** The Rulebook tab: rules proposed from your own files (read only), each with its file and line; you confirm, edit or reject. */
async function rulebookView(el, ui) {
  const { h, card, btn, line, empty, toast } = ui;
  const paint = async () => {
    let r; try { r = await ui.api(API + 'rules'); } catch (e) { return put(el, empty(ui.plainError(e))); }
    const act = (id, a, body = {}) => async () => { try { await ui.api(`${API}rules/${id}/${a}`, { body }); paint(); } catch (e) { toast(e.message, 'err'); } };
    const edit = (x) => async () => { const t = await ui.ask('Edit the rule', { value: x.text, multiline: true }); if (t != null) act(x.id, 'edit', { text: t })(); };
    const where = (x) => `${x.kindWord} · ${x.file}, line ${x.line}`;
    put(el, card({ 'data-apd': 'bench-rulebook' },
      h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Rulebook'), h('span', { class: 'grow' }),
        btn('Look in my files', { kind: 'sm', onClick: async () => { try { const s = await ui.api(API + 'rules/scan', { body: {} }); toast(`${s.filesRead} file${s.filesRead === 1 ? '' : 's'} read`, 'ok'); paint(); } catch (e) { toast(e.message, 'err'); } } })),
      h('p', { class: 'sub' }, 'Rules are proposed from the text files you put in your workspace, word for word, with the file and line. Your files are only read, never changed. ' + r.later)),
      card(h('h3', null, `Proposed (${r.proposed.length})`), ...(r.proposed.length ? r.proposed.map((x) => line(x.text, where(x), h('span', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, btn('Confirm', { kind: 'sm', onClick: act(x.id, 'confirm') }), btn('Edit', { kind: 'ghost sm', onClick: edit(x) }), btn('Reject', { kind: 'ghost sm', onClick: act(x.id, 'reject') })))) : [empty('Nothing waiting. Press "Look in my files" to look again.')])),
      card(h('h3', null, `Confirmed (${r.confirmed.length})`), ...(r.confirmed.length ? r.confirmed.map((x) => line(x.text, where(x) + (x.text !== x.original ? ' · edited by you' : ''))) : [empty('No confirmed rules yet.')])));
  };
  await paint();
}

export const pages = {
  bench: {
    title: 'Bench',
    async render(el, ui, route) {
      const { h, card, line, btn, pill, fmt, empty, toast, seg } = ui;
      el.classList.add('scroll');
      const now = h('div', { class: 'stack' }); const list = h('div'); const main = h('div', { class: 'stack' }); const gateEl = h('div');
      let filter = { kind: '', state: 'new' }; let picked = route?.parts?.[0] || null; let tab = 0;
      const tabs = h('div'); const B = placeName(ui); const BM = modeName(ui);
      el.append(h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, B), h('span', { class: 'grow' }), btn('While you were away', { kind: 'ghost sm', onClick: () => ui.go('bench-return') }), btn(`${B} settings`, { kind: 'ghost sm', onClick: () => ui.go('settings', 'bench') })),
        gateEl, tabs,
        h('div', { class: 'cols' }, main, h('div', { class: 'stack' }, card(h('h3', null, 'Now'), now), card(h('h3', null, 'Sessions'), list))));
      function paintGate(v) {
        const g = v.gate;
        put(gateEl, card({ 'data-apd': 'bench-gate' }, line(g.ready ? `Spend: ${g.optionWord}` : 'Spend: not chosen',
          g.ready ? `${spendLine(ui, g)} · session ${g.limitStatus.used.sources} of ${ui.plural(g.limits.sources, 'source')}, ${g.limitStatus.used.steps} of ${ui.plural(g.limits.steps, 'step')}${g.invalid ? ' · cap reached, winding to free' : g.limitStatus.winding ? ' · winding down' : ''}` : `${B} will not run until you choose how it may spend.`,
          btn(g.ready ? 'Change' : 'Choose', { kind: g.ready ? 'ghost sm' : 'sm', onClick: () => ui.go('settings', 'bench') }))));
      }
      async function paintNow() {
        const v = await ui.api(API + 'state');
        paintGate(v);
        const r = v.running;
        put(now, !v.settings.enabled ? line(`${BM} is off`, `Switch it on in ${B} settings.`, btn('Settings', { kind: 'ghost sm', onClick: () => ui.go('settings', 'bench') }))
          : !v.gate.ready ? line('Waiting for your spend choice', `Choose Local only, Free, or Paid, capped in ${B} settings.`, btn('Choose', { kind: 'sm', onClick: () => ui.go('settings', 'bench') }))
          : r ? [line(`Running since ${fmt.when(r.started)}`, `Stage ${r.tier} of 4${r.now ? ' · ' + r.now : ''}${r.waiting ? ' · ' + r.waiting : ''}`, pill('Working', 'run')),
            line('Used so far', `${ui.plural(r.used.calls, 'model call')}, ${ui.plural(r.used.pages, 'page')} read, ${ui.plural(Math.round((r.used.ms || 0) / 60000), 'minute')} of work`),
            todoView(ui, r.todo),
            v.keepAwake?.held ? h('p', { class: 'sub' }, 'Keeping this PC awake while work is queued.') : null,
            h('p', { class: 'sub' }, 'It stops as soon as you use the desk.')]
            : line('Waiting for you to be away', `Starts after ${v.settings.startAfter} minutes without a click or a key in this window.`, pill('Idle')));
        return v;
      }
      async function paintList() {
        const { sessions } = await ui.api(API + 'sessions');
        if (!picked && sessions[0]) picked = sessions[0].id;
        put(list, sessions.length ? sessions.slice(0, 20).map((s) => h('button', { class: 'line', style: { width: '100%', textAlign: 'left', background: s.id === picked ? 'var(--bubble)' : null, borderRadius: '8px', padding: '8px' }, onclick: () => { picked = s.id; paintAll(); } },
          h('div', null, h('b', null, fmt.when(s.started)), h('span', { class: 'd' }, `${s.state === 'running' ? 'Running' : s.state === 'stopped' ? 'Stopped' : 'Finished'}${s.endWhy ? ': ' + s.endWhy : ''} · ${Object.values(s.counts).reduce((a, b) => a + b, 0)} findings`)))) : [empty('No sessions yet.')]);
      }
      async function paintMain() {
        put(tabs, seg(['Findings', 'Rulebook'], tab, (_, i) => { tab = i; paintMain().catch((e) => toast(e.message, 'err')); }));
        if (tab === 1) return rulebookView(main, ui);
        if (!picked) return put(main, card(h('h3', null, 'While you were away'), empty(`When you leave the desk for a while, ${B} looks back at its own work and looks up your market. The note waits here.`)));
        const qs = new URLSearchParams(); if (filter.kind) qs.set('kind', filter.kind);
        const data = await ui.api(`${API}sessions/${picked}`);
        put(main, noteView(ui, data, { filter, onChange: (f) => { filter = f; paintMain().catch((e) => toast(e.message, 'err')); paintList().catch(() => {}); } }));
        if (data.session.state !== 'running' && !data.session.seen) ui.api(`${API}sessions/${picked}/seen`, { body: {} }).catch(() => {});
      }
      const paintAll = () => Promise.all([paintNow(), paintList().then(paintMain)]).catch((e) => toast(e.message, 'err'));
      await paintAll();
      ui.on('bench', () => paintAll());
    },
  },
  'bench-return': {
    title: 'While you were away',
    async render(el, ui) {
      const { h, card, btn, fmt, line, empty, toast, table } = ui;
      const B = placeName(ui);
      el.classList.add('scroll');
      const wrap = h('div', { class: 'stack' }); el.append(wrap);
      const downloadCsv = async () => {
        try {
          const sess = document.querySelector('meta[name="apd-session"]')?.content || '';
          const r = await fetch('/api/m/bench/usage.csv', { headers: { 'x-apd-session': sess } });
          if (!r.ok) throw new Error('Could not export.');
          const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = 'usage-today.csv'; a.click(); URL.revokeObjectURL(url);
        } catch (e) { toast(e.message, 'err'); }
      };
      const resultCard = (c) => card({ 'data-apd': 'return-result' },
        h('b', { style: { display: 'block', overflowWrap: 'anywhere' } }, c.title),
        c.summary ? h('p', { class: 'sub', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, c.summary) : null,
        (c.sources || []).length ? h('div', { class: 'sub', style: { overflowWrap: 'anywhere' } }, 'Sources: ', ...c.sources.flatMap((s, i) => [i ? ', ' : '', s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title || hostOf(s.url)) : h('span', null, s.title || 'Your desk')])) : null,
        h('div', { class: 'row', style: { marginTop: '6px' } },
          c.chatId ? btn('Open', { kind: 'ghost sm', onClick: () => ui.go('chat', c.chatId) }) : c.kind === 'bench' ? btn('Open the note', { kind: 'ghost sm', onClick: () => ui.go('bench') }) : null),
        stepsBlock(ui, c.jobId),
        ratingBar(ui, c.kind === 'bench' ? 'bench_item' : 'job', c.id, c.rating));
      async function paint() {
        let p, u; try { [p, u] = await Promise.all([ui.api(API + 'return'), ui.api(API + 'usage')]); } catch (e) { return put(wrap, empty(ui.plainError(e))); }
        const hl = p.headline;
        const spend = hl.spendTodayMinor > 0 ? fmt.money(hl.spendTodayMinor, hl.currency) : 'No paid spend';
        const usageCard = u.agents.length ? card(h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Usage today'), h('span', { class: 'grow' }), btn('Download CSV', { kind: 'ghost sm', onClick: downloadCsv })),
          (({ cols, rows }) => table(cols, rows))(usageTable(u, fmt)),
          u.benchSteps.length ? h('p', { class: 'sub' }, `${B} steps: ` + u.benchSteps.map((s) => `${s.action} ${s.count}`).join(', ')) : null) : null;
        const srcLine = (list) => (list || []).length ? h('div', { class: 'sub', style: { overflowWrap: 'anywhere' } }, 'Sources: ', ...list.flatMap((s, i) => [i ? ', ' : '', s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title || hostOf(s.url)) : h('span', null, s.title || 'Your desk')])) : h('div', { class: 'sub' }, 'Sources: none');
        const f = p.find;
        const findCard = f ? card({ 'data-apd': 'bench-find' }, h('h3', null, "Today's find"), h('b', { style: { display: 'block', overflowWrap: 'anywhere' } }, f.question),
          h('p', { class: 'sub' }, `Why this one: ${f.why}`),
          h('p', { style: { overflowWrap: 'anywhere' } }, f.answer || f.status), f.answer ? srcLine(f.sources) : null,
          h('p', { class: 'sub' }, `Picked by the desk from your own tasks, ratings and ${B} findings. Change it in ${B} settings.`))
          : p.findWhy ? card({ 'data-apd': 'bench-find' }, h('h3', null, "Today's find"), h('p', { class: 'sub' }, p.findWhy)) : null;
        const w = p.weekly;
        const weeklyCard = w && w.rated ? card({ 'data-apd': 'bench-weekly' }, h('h3', null, 'What I learned this week'),
          h('p', { class: 'sub' }, `From ${w.rated} rating${w.rated === 1 ? '' : 's'} you left in the last 7 days.`),
          w.good.length ? h('div', null, h('b', null, 'Rated good'), ...w.good.map((x) => h('div', { class: 'sub', style: { overflowWrap: 'anywhere' } }, `• ${x.title}`))) : null,
          w.poor.length ? h('div', null, h('b', null, 'Rated poor'), ...w.poor.map((x) => h('div', { class: 'sub', style: { overflowWrap: 'anywhere' } }, `• ${x.title}${x.reasons.length ? ': ' + x.reasons.join(', ') : ''}${x.comment ? ` ("${x.comment}")` : ''}`))) : null,
          w.suggestions.length ? h('div', null, h('b', null, 'Suggested changes'), ...w.suggestions.map((x) => h('div', { class: 'sub', style: { overflowWrap: 'anywhere' } }, `• ${x.change} (${x.reason}, ${x.times} time${x.times === 1 ? '' : 's'})`))) : null,
          h('p', { class: 'sub' }, w.note)) : null;
        const gapCard = (p.gaps || []).length ? card({ 'data-apd': 'bench-gaps' }, h('h3', null, 'When the desk was not running'), ...p.gaps.map((g) => h('p', { class: 'sub' }, g.text))) : null;
        put(wrap,
          card(h('h2', { style: { margin: '0 0 8px' } }, 'While you were away'),
            h('div', { class: 'row', style: { gap: '20px', flexWrap: 'wrap' } },
              stat(ui, hl.finished, 'finished'), stat(ui, hl.needsYou, 'need you'), stat(ui, Math.round((hl.workedMs || 0) / 60000) + 'm', 'worked'), stat(ui, spend, 'spent today'))),
          gapCard, findCard,
          usageCard,
          p.results.length ? card(h('h3', null, "What I did"), ...p.results.map(resultCard)) : null,
          p.needs.length ? card(h('h3', null, 'Needs you'), ...p.needs.map((n) => line(n.title, n.detail || '', n.kind === 'job' ? btn('Open', { kind: 'ghost sm', onClick: () => ui.go('home') }) : null))) : null,
          p.didntGetTo.length ? card(h('h3', null, "What I didn't get to"), ...p.didntGetTo.map((d) => h('div', { style: { marginTop: '6px' } }, h('b', { style: { display: 'block', overflowWrap: 'anywhere' } }, d.title), d.why ? h('span', { class: 'sub' }, d.why) : null, d.next ? h('p', { class: 'sub', style: { margin: '2px 0 0' } }, 'Next: ' + d.next) : null))) : null,
          weeklyCard,
          !p.results.length && !p.needs.length && !p.didntGetTo.length && !f && !gapCard ? empty(`Nothing to show yet. When ${B} runs or a job finishes, it shows up here.`) : null);
      }
      await paint();
      ui.on('bench', () => paint().catch((e) => toast(e.message, 'err')));
      ui.on('job', () => paint().catch(() => {}));
    },
  },
};

export const settings = {
  bench: {
    title: 'Bench',
    async render(el, ui) {
      const { h, card, line, btn, sw, seg, toast } = ui;
      const box = h('div', { class: 'stack' }); el.append(box);
      const save = async (patch) => { await ui.api(API + 'settings', { body: patch }); ui.toast('Saved.', 'ok'); paint(); };
      const saveGate = async (patch) => { try { await ui.api(API + 'spendgate', { body: patch }); ui.toast('Saved.', 'ok'); } finally { paint(); } };
      async function paint() {
        const v = await ui.api(API + 'state'); const c = v.settings; const g = v.gate; const cur = g.currency; const B = placeName(ui); const BM = modeName(ui);
        const optSeg = seg(['Local only', 'Free', 'Paid, capped'], g.options.indexOf(g.option), (_, i) => { if (g.options[i] === 'paid' && !v.paidAllowed) { toast('Paid models are not allowed for any provider in Models, so Bench cannot use them.', 'err'); paint(); return; } saveGate({ option: g.options[i] }).catch((e) => toast(e.message, 'err')); });
        // A number box saves only a number it can keep: an empty box or a typo is refused beside the box with the reason,
        // the old value stays, and "Saved." shows only after the desk saved it.
        const numInput = (label, shown, { min, width, aria, words, patch }) => {
          const f = h('input', { type: 'number', min: String(min), value: String(shown), style: { width }, 'aria-label': aria });
          f.addEventListener('change', async () => {
            const raw = f.value.trim(); const n = Number(raw);
            if (f.validity?.badInput || raw === '' || !Number.isFinite(n) || n < min) { f.value = String(shown); return ui.needs(f, words); }
            try { await ui.api(API + 'spendgate', { body: patch(n) }); } catch (e) { f.value = String(shown); return ui.needs(f, ui.plainError(e)); }
            toast('Saved.', 'ok'); paint();
          });
          return h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'sub' }, label), f);
        };
        const capInput = (label, minorVal, key) => numInput(label, (minorVal || 0) / 100, { min: 0, width: '110px', aria: `${label} cap in ${cur}`, words: 'Type an amount, 0 or more. 0 means no cap.', patch: (n) => ({ [key]: Math.round(n * 100) }) });
        const limInput = (label, val, key) => numInput(label, val, { min: 1, width: '90px', aria: `${label} limit`, words: 'Type a whole number, 1 or more.', patch: (n) => ({ limits: { [key]: Math.round(n) } }) });
        const battery = h('select', { 'aria-label': 'Stop on battery below', onchange: (e) => save({ battery: Number(e.target.value) }).catch((er) => toast(er.message, 'err')) }, [0, 10, 20, 30, 40, 50, 60].map((n) => h('option', { value: String(n), selected: n === c.battery }, n ? `${n}%` : 'Never')));
        const site = h('input', { type: 'text', value: c.site, placeholder: 'yourbusiness.example', 'aria-label': 'Your site address', onchange: (e) => save({ site: e.target.value }).catch((er) => toast(er.message, 'err')) });
        put(box,
          card(h('h3', null, BM),
            h('p', { class: 'sub' }, `While you are away from this window, ${B} looks back at the desk's own work and looks up your business, its market, possible customers and funding, from public pages. It leaves a note. It never sends, signs up, applies or changes a setting, and nothing is saved anywhere until you press Keep.`),
            line(BM, c.enabled ? 'On' : 'Off', sw(c.enabled, BM, (on) => save({ enabled: on }))),
            line('Start after I have been away for', 'Away means no click or key in this window. The desk cannot see the rest of your PC.', seg(['15 minutes', '30 minutes', '60 minutes'], [15, 30, 60].indexOf(c.startAfter), (_, i) => save({ startAfter: [15, 30, 60][i] }).catch((e) => toast(e.message, 'err')))),
            line('Stop on battery below', 'A PC with no battery, or on mains power, is never stopped.', h('span', { class: 'field' }, battery)),
            line('Your site address', `Optional. ${B} reads your own pages to propose a short profile.`, h('span', { class: 'field' }, site)),
            line(`Keep this PC awake while ${B} works`, v.keepAwake.note + (v.keepAwake.error ? ` Not working here: ${v.keepAwake.error}.` : ''), sw(v.keepAwake.on, `Keep this PC awake while ${B} works`, (on) => save({ keepAwake: on }).catch((e) => toast(e.message, 'err')))),
            line(B === 'Bench' ? 'Start a bench session now' : `Start ${B} now`, 'To try it. It stops when you next use the desk, after one minute.', btn('Start now', { kind: 'ghost sm', disabled: !c.enabled || v.halted || !g.ready, onClick: async () => { try { const r = await ui.api(API + 'start', { body: {} }); toast(r.text || `${B} is already running.`, 'ok'); } catch (e) { toast(e.message, 'err'); } } }))),
          card(h('h3', null, 'Spending'),
            h('p', { class: 'sub' }, `${B} must have a money choice before it runs. Keys and paid switching stay in Models; "Paid, capped" only lets ${B} prefer a paid route where you already allow paid use there.`),
            line(`How ${B} may spend`, g.ready ? g.optionWord : `Not chosen yet. ${B} will not run until you choose.`, optSeg),
            g.option === 'paid' ? line('Caps', (g.capSessionMinor || g.capDayMinor) ? `Local first; paid only when it clearly helps, up to these caps in ${cur}. 0 means no cap. At a cap ${B} winds down to free.` : `No cap is set, so only the spend limits you set in Models apply. Type a cap in ${cur} to add one; 0 means no cap.`, h('div', { class: 'row', style: { gap: '12px', flexWrap: 'wrap' } }, capInput('Per session', g.capSessionMinor, 'capSessionMinor'), capInput('Per day', g.capDayMinor, 'capDayMinor'))) : null,
            line('Session limits', `Whatever the money choice: at 80% of any limit ${B} winds down to cheaper or local routes; at 100% it stops, checkpoints and lists what is left.`, h('div', { class: 'row', style: { gap: '12px', flexWrap: 'wrap' } }, limInput('Tasks', g.limits.tasks, 'tasks'), limInput('Sources', g.limits.sources, 'sources'), limInput('Steps', g.limits.steps, 'steps'), limInput('Minutes', g.limits.minutes, 'minutes'))),
            g.ready ? line('Today', `${spendLine(ui, g)}. This session so far: ${ui.plural(g.limitStatus.used.sources, 'source')}, ${ui.plural(g.limitStatus.used.steps, 'step')}, ${ui.plural(g.limitStatus.used.minutes, 'minute')}.`) : null),
          card(h('h3', null, "Today's find"),
            h('p', { class: 'sub' }, `Once a day while ${B} works, the desk picks one question from your own tasks, ratings and ${B} findings in the desk (not your browser), and answers it from pages within your spend choice.`),
            line("Today's find", c.find.off ? 'Off' : 'On', sw(!c.find.off, "Today's find", (on) => save({ findOff: !on }).catch((e) => toast(e.message, 'err')))),
            line('Topics to avoid', 'Separate with commas.', h('span', { class: 'field' }, h('input', { type: 'text', value: c.find.avoid.join(', '), placeholder: 'salaries, health', 'aria-label': 'Topics to avoid', onchange: (e) => save({ findAvoid: e.target.value }).catch((er) => toast(er.message, 'err')) }))),
            line('One pinned topic', 'Asked about first, every day, until you clear it.', h('span', { class: 'field' }, h('input', { type: 'text', value: c.find.pin, placeholder: 'Optional', 'aria-label': 'Pinned topic', onchange: (e) => save({ findPin: e.target.value }).catch((er) => toast(er.message, 'err')) })))),
          card(h('h3', null, 'Stages'), h('p', { class: 'sub' }, 'What runs depends on how long you have been away. Earlier stages that have not run go first.'),
            ...v.tiers.map((t) => line(`After ${t.hours} hour${t.hours === 1 ? '' : 's'}`, v.activities.filter((a) => a.tier === t.n).map((a) => a.title).join(', ')))));
      }
      await paint();
    },
  },
};

/** The card at the top of Home when Bench left a note. */
export async function homeCard(el, ui) {
  const { h, card, btn } = ui;
  let v; try { v = await ui.api(API + 'state'); } catch { return put(el); }
  const n = v.note; if (!n) return put(el);
  put(el, card({ 'data-apd': 'bench-home' }, h('div', { class: 'row' }, h('h3', { style: { margin: 0, flex: '1' } }, 'While you were away'), btn('Later', { kind: 'ghost sm', onClick: async () => { await ui.api(`${API}sessions/${n.session.id}/seen`, { body: {} }).catch(() => {}); put(el); } }), btn('Open the note', { kind: 'sm', onClick: () => ui.go('bench', n.session.id) })),
    ...n.note.head.map((l) => h('p', { class: 'sub' }, l)),
    n.note.best.length ? h('div', null, h('b', null, 'Best first'), ...n.note.best.map((i) => h('div', { class: 'sub', style: { overflowWrap: 'anywhere' } }, `• ${i.title}`))) : null,
    n.note.needs.length ? h('div', null, h('b', null, 'Needs you'), ...n.note.needs.map((i) => h('div', { class: 'sub' }, `• ${i.title}`))) : null));
}
