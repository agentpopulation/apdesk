// Bench mode: the page (sessions and the note "While you were away"), the settings card, and the card Home shows on return.
const API = 'm/bench/';
const KIND_WORDS = { needs: 'Needs you', work: 'Unfinished work', doubt: 'Doubt', lesson: 'Lesson', profile: 'Your business', competitor: 'Competitor', skill: 'Skill draft', lead: 'Possible customer', funding: 'Money and credits', tool: 'Free tool', report: 'Market report', table: 'Pricing table', plan: '30-day plan' };
const STATE_WORDS = { new: 'Waiting for you', kept: 'Kept', dismissed: 'Dismissed', task: 'Turned into a task' };
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

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
  const go = it.data?.go ? btn('Open', { kind: 'ghost sm', onClick: () => { const [p, ...rest] = String(it.data.go).split('/'); ui.go(p, ...rest); } }) : null;
  const decided = it.state !== 'new';
  return card({ class: 'bench-item', 'data-kind': it.kind },
    h('div', { class: 'row' }, pill(KIND_WORDS[it.kind] || it.kind, it.kind === 'needs' ? 'wait' : ''), h('span', { class: 'grow' }),
      it.kind === 'needs' ? null : pill(it.complete ? 'Every line has its source' : 'Some lines not checked', it.complete ? 'ok' : '')),
    h('b', { style: { display: 'block', marginTop: '6px', overflowWrap: 'anywhere' } }, it.title),
    it.body ? h('p', { class: 'sub', style: { whiteSpace: 'pre-wrap', marginTop: '6px', overflowWrap: 'anywhere' } }, it.body) : null,
    (it.evidence || []).length ? h('div', { style: { marginTop: '6px' } }, it.evidence.map((e) => h('div', { class: 'sub', style: { marginTop: '4px', overflowWrap: 'anywhere' } },
      e.url ? h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, e.title || hostOf(e.url)) : h('span', null, e.title || 'Your desk'),
      e.quote ? h('span', null, `: "${e.quote}"`) : e.url ? h('span', null, ' (no quote kept)') : null))) : null,
    h('div', { class: 'row', style: { marginTop: '8px' } },
      decided ? h('span', { class: 'sub' }, `${STATE_WORDS[it.state]}${it.decided ? ' ' + fmt.when(it.decided) : ''}${it.result ? ': ' + it.result : ''}`) : null,
      h('span', { class: 'grow' }), go,
      decided ? null : [it.kind === 'needs' ? null : btn('Keep', { kind: 'sm', onClick: act('keep') }), btn('Dismiss', { kind: 'ghost sm', onClick: act('dismiss') }), btn('Turn into a task', { kind: 'ghost sm', onClick: act('task') })]));
}

/** The note: built on the server by code from the items; shown here as it came. */
function noteView(ui, data, { filter, onChange }) {
  const { h, card, fmt, seg } = ui;
  const { session, note, items } = data;
  const kinds = [...new Set(items.map((i) => i.kind))];
  const kindSeg = seg(['All', ...kinds.map((k) => KIND_WORDS[k] || k)], filter.kind ? kinds.indexOf(filter.kind) + 1 : 0, (_, i) => onChange({ ...filter, kind: i ? kinds[i - 1] : '' }));
  const states = ['new', 'kept', 'dismissed', 'task', ''];
  const stateSeg = seg(['Waiting', 'Kept', 'Dismissed', 'Tasks', 'All'], Math.max(0, states.indexOf(filter.state ?? 'new')), (_, i) => onChange({ ...filter, state: states[i] }));
  const want = items.filter((i) => (!filter.kind || i.kind === filter.kind) && (filter.state === '' || i.state === (filter.state ?? 'new')));
  const bestIds = new Set(note.best.map((i) => i.id));
  const showBest = !filter.kind && (filter.state ?? 'new') === 'new' && note.best.length;
  const rest = want.filter((i) => !(showBest && bestIds.has(i.id)));
  const byKind = new Map(); for (const i of rest) { if (!byKind.has(i.kind)) byKind.set(i.kind, []); byKind.get(i.kind).push(i); }
  const refresh = () => onChange(filter);
  return h('div', { class: 'stack', 'data-apd': 'bench-note' },
    card(h('h3', null, session.state === 'running' ? 'Working now' : 'While you were away'), h('p', { class: 'sub' }, `${fmt.when(session.started)} to ${session.ended ? fmt.when(session.ended) : 'now'}`), ...note.head.map((l) => h('p', null, l))),
    h('div', { class: 'row' }, kinds.length > 1 ? kindSeg : null, stateSeg),
    showBest ? h('div', { class: 'stack' }, h('h3', { style: { margin: 0 } }, 'Best first'), h('p', { class: 'sub' }, note.rule), ...note.best.map((i) => itemCard(ui, i, refresh))) : null,
    ...[...byKind.entries()].sort((a, b) => (a[0] === 'needs' ? -1 : b[0] === 'needs' ? 1 : 0)).map(([k, list]) => h('div', { class: 'stack' }, h('h3', { style: { margin: 0 } }, `${KIND_WORDS[k] || k} (${list.length})`), ...list.map((i) => itemCard(ui, i, refresh)))),
    !want.length ? ui.empty('Nothing here with this filter.') : null,
    note.notDone.length ? card(h('h3', null, 'What Bench could not do'), ...note.notDone.map((l) => h('p', { class: 'sub' }, l))) : null);
}

export const pages = {
  bench: {
    title: 'Bench',
    async render(el, ui, route) {
      const { h, card, line, btn, pill, fmt, empty, toast } = ui;
      el.classList.add('scroll');
      const now = h('div', { class: 'stack' }); const list = h('div'); const main = h('div', { class: 'stack' });
      let filter = { kind: '', state: 'new' }; let picked = route?.parts?.[0] || null;
      el.append(h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Bench'), h('span', { class: 'grow' }), btn('Bench settings', { kind: 'ghost sm', onClick: () => ui.go('settings', 'bench') })),
        h('div', { class: 'cols' }, main, h('div', { class: 'stack' }, card(h('h3', null, 'Now'), now), card(h('h3', null, 'Sessions'), list))));
      async function paintNow() {
        const v = await ui.api(API + 'state');
        const r = v.running;
        put(now, !v.settings.enabled ? line('Bench mode is off', 'Switch it on in Bench settings.', btn('Settings', { kind: 'ghost sm', onClick: () => ui.go('settings', 'bench') }))
          : r ? [line(`Running since ${fmt.when(r.started)}`, `Stage ${r.tier} of 4${r.now ? ' · ' + r.now : ''}${r.waiting ? ' · ' + r.waiting : ''}`, pill('Working', 'run')),
            line('Used so far', `${r.used.calls} model calls, ${r.used.pages} pages read, ${Math.round((r.used.ms || 0) / 60000)} minutes of work`),
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
        if (!picked) return put(main, card(h('h3', null, 'While you were away'), empty('When you leave the desk for a while, Bench looks back at its own work and looks up your market. The note waits here.')));
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
};

export const settings = {
  bench: {
    title: 'Bench mode',
    async render(el, ui) {
      const { h, card, line, btn, sw, seg, toast } = ui;
      const box = h('div', { class: 'stack' }); el.append(box);
      const save = async (patch) => { await ui.api(API + 'settings', { body: patch }); paint(); };
      async function paint() {
        const v = await ui.api(API + 'state'); const c = v.settings;
        const modes = ['local', 'free', 'paid'];
        const models = seg(['Local only', 'Local then free', 'Also paid'], modes.indexOf(c.models), (_, i) => { if (i === 2 && !v.paidAllowed) { toast('Paid models are not allowed for any provider in Models, so Bench cannot use them.', 'err'); paint(); return; } save({ models: modes[i] }).catch((e) => toast(e.message, 'err')); });
        const battery = h('select', { 'aria-label': 'Stop on battery below', onchange: (e) => save({ battery: Number(e.target.value) }).catch((er) => toast(er.message, 'err')) }, [0, 10, 20, 30, 40, 50, 60].map((n) => h('option', { value: String(n), selected: n === c.battery }, n ? `${n}%` : 'Never')));
        const site = h('input', { type: 'text', value: c.site, placeholder: 'yourbusiness.example', 'aria-label': 'Your site address', onchange: (e) => save({ site: e.target.value }).catch((er) => toast(er.message, 'err')) });
        put(box,
          card(h('h3', null, 'Bench mode'),
            h('p', { class: 'sub' }, 'While you are away from this window, Bench looks back at the desk\'s own work and looks up your business, its market, possible customers and funding, from public pages. It leaves a note. It never sends, signs up, applies or changes a setting, and nothing is saved anywhere until you press Keep.'),
            line('Bench mode', c.enabled ? 'On' : 'Off', sw(c.enabled, 'Bench mode', (on) => save({ enabled: on }))),
            line('Start after I have been away for', 'Away means no click or key in this window. The desk cannot see the rest of your PC.', seg(['15 minutes', '30 minutes', '60 minutes'], [15, 30, 60].indexOf(c.startAfter), (_, i) => save({ startAfter: [15, 30, 60][i] }).catch((e) => toast(e.message, 'err')))),
            line('Models', v.paidAllowed ? 'Local models first. "Also paid" uses a paid model only where paid use is already allowed in Models.' : 'Local models first, then free ones. Paid models are not allowed for any provider in Models, so "Also paid" is not offered.', models),
            line('Stop on battery below', 'A PC with no battery, or on mains power, is never stopped.', h('span', { class: 'field' }, battery)),
            line('Your site address', 'Optional. Bench reads your own pages to propose a short profile.', h('span', { class: 'field' }, site)),
            line('Start a bench session now', 'To try it. It stops when you next use the desk, after one minute.', btn('Start now', { kind: 'ghost sm', disabled: !c.enabled || v.halted, onClick: async () => { try { const r = await ui.api(API + 'start', { body: {} }); toast(r.text || 'Bench is already running.', 'ok'); } catch (e) { toast(e.message, 'err'); } } }))),
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
