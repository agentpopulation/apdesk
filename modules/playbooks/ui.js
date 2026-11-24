// The Playbooks page: one-click jobs. Each card says what you get, whether it can run now (and how to fix it when not),
// its schedule and its last run. Run now opens a small box with the inputs, who runs it, on which model, and what waits
// for you. Text from a playbook file is shown as text nodes only, never as markup; a run's result is drawn by
// ui-result.js (plain text for a playbook from a file; links with their full address for the others).
import { drawResult } from './ui-result.js';
const CSS = `
.view.pbv{display:flex;flex-direction:column;min-height:0;height:100%;padding:0}
.pbv .pb-top{padding:14px 18px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.pbv .pb-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pbv .pb-head h2{margin:0;font-size:18px}
.pbv .pb-top .tabbar{padding:0;margin-top:2px}
.pbv .pb-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 28px;display:flex;flex-direction:column;gap:12px}
.pbv .pb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px}
.pbv .pb-card{display:flex;flex-direction:column;gap:8px;min-width:0}
.pbv .pb-card h3{margin:0;font-size:15px;overflow-wrap:anywhere}
.pbv .pb-title{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.pbv .pb-kind{font-size:12px;color:var(--faint)}
.pbv .pb-out{margin:0;font-size:13.5px;color:var(--dim);overflow-wrap:anywhere}
.pbv .pb-line{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--dim);min-width:0;overflow-wrap:anywhere}
.pbv .pb-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:4px}
.pb-tag{display:inline-block;font-size:11.5px;font-weight:400;color:var(--dim);border:1px solid var(--line-strong);border-radius:99px;padding:0 7px;line-height:18px}
.pb-box{display:flex;flex-direction:column;gap:10px;min-width:0}
.pb-box label.pb-f{display:flex;flex-direction:column;gap:4px;font-size:13px;min-width:0}
.pb-box label.pb-f>span.d{color:var(--dim);font-size:12.5px}
.pb-box input[type=text],.pb-box input[type=time],.pb-box select,.pb-box textarea{width:100%;min-width:0}
.pb-box textarea{min-height:64px}
.pb-box .pb-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pb-box .pb-irow{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,.8fr) minmax(0,1.3fr) auto;gap:6px;align-items:center}
.pb-box ul{margin:0;padding-left:18px;font-size:13px;display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
.pb-box .pb-block{border:1px solid color-mix(in srgb,var(--stop) 35%,var(--line));background:color-mix(in srgb,var(--stop) 8%,transparent);border-radius:var(--r-s);padding:8px 10px;display:flex;flex-direction:column;gap:6px;font-size:13px}
.pb-box .pb-block>div{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pb-box pre.pb-text{margin:0;max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono);font-size:12px;background:var(--well);border:1px solid var(--line);border-radius:var(--r-s);padding:8px 10px}
.pb-box .pb-mark{border-left:3px solid var(--slow);padding:4px 8px;background:color-mix(in srgb,var(--slow) 8%,transparent);border-radius:0 var(--r-xs) var(--r-xs) 0;font-size:13px;overflow-wrap:anywhere}
.pb-box .pb-words{margin:0;font-size:13.5px;overflow-wrap:anywhere}
.pb-box mark.pb-abc{background:color-mix(in srgb,var(--slow) 22%,transparent);color:inherit;border-radius:3px;outline:1px solid color-mix(in srgb,var(--slow) 60%,transparent)}
.pb-box mark.pb-abc::after{content:" " attr(data-abc);font-family:var(--sans,system-ui);font-size:10.5px;font-weight:600;color:var(--dim);padding:0 3px}
.pb-box .pb-scope{border:1px solid var(--line);border-radius:var(--r-s);padding:8px 10px;font-size:13px;display:flex;flex-direction:column;gap:6px;overflow-wrap:anywhere}
.pb-box label.pb-tick{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;font-size:13.5px;font-weight:400;cursor:pointer}
.pb-box label.pb-tick input{margin-top:3px;flex:0 0 auto}
.pb-box .pb-trust{border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:4px}
.pb-run{border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:6px;min-width:0}
.pb-run:first-child{border-top:0;padding-top:0}
.pb-run .md{font-size:13.5px;overflow-wrap:anywhere}
.pb-run details summary{cursor:pointer;color:var(--dim);font-size:13px}
.pb-run .pb-plain{margin:0;font-size:13.5px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.pb-run .pb-addr{color:var(--dim);overflow-wrap:anywhere;word-break:break-all}
.pb-run .pb-ask-link{cursor:pointer;text-decoration:underline}
.pb-run .pb-ask{border:1px solid var(--line-strong);border-radius:var(--r-s);padding:8px 10px;margin:6px 0;display:flex;flex-direction:column;gap:4px}
.pb-run .pb-ask p{margin:0}
@media (max-width:600px){.pbv .pb-top .tabbar{flex-wrap:wrap;gap:0 2px}.pbv .pb-top .tabbar>button{padding:7px 10px 8px}.pbv .pb-top,.pbv .pb-body{padding-left:16px;padding-right:16px}.pbv .pb-grid{grid-template-columns:minmax(0,1fr)}.pb-box .pb-two{grid-template-columns:1fr}.pb-box .pb-irow{grid-template-columns:1fr 1fr}}
`;
const STATUS = { running: ['Running', 'run'], done: ['Done', 'live'], failed: ['Did not finish', 'fail'], empty: ['No usable answer', 'fail'], stopped: ['Stopped', 'off'], interrupted: ['Interrupted', 'slow'] };
const NEED = { input: 'Fill in first', module: 'Needs a module', data: 'Needs your data', stopped: 'Stopped' };
const TRIGGER = { now: 'Run now', schedule: 'On schedule', chat: 'Asked in chat' };
const DAYS = [['*', 'Every day'], ['1-5', 'Every weekday'], ['1', 'Every Monday'], ['2', 'Every Tuesday'], ['3', 'Every Wednesday'], ['4', 'Every Thursday'], ['5', 'Every Friday'], ['6', 'Every Saturday'], ['0', 'Every Sunday'], ['month', 'On the 1st of each month']];
const ensureCss = (h) => { if (!document.getElementById('pbv-css')) document.head.append(h('style', { id: 'pbv-css' }, CSS)); };

/** Our own five-field forms only: "m h * * d" or "m h 1 * *". */
function readCron(cron) {
  const f = String(cron || '').split(' '); if (f.length !== 5) return { day: '1', time: '08:00' };
  const time = `${String(f[1]).padStart(2, '0')}:${String(f[0]).padStart(2, '0')}`;
  return { day: f[2] === '1' ? 'month' : (DAYS.some(d => d[0] === f[4]) ? f[4] : '*'), time: /^\d\d:\d\d$/.test(time) ? time : '08:00' };
}
function makeCron(day, time) {
  const [hh, mm] = String(time || '08:00').split(':').map(Number);
  const H = Number.isFinite(hh) ? hh : 8, M = Number.isFinite(mm) ? mm : 0;
  return { cron: day === 'month' ? `${M} ${H} 1 * *` : `${M} ${H} * * ${day}` };
}

export const pages = {
  playbooks: {
    title: 'Playbooks',
    async render(el, ui) {
      const { h, api, btn, card, empty, toast, modal, confirm, fmt, statusChip, md } = ui;
      const plural = (n, one) => `${n} ${n === 1 ? one : one + 's'}`;
      ensureCss(h); el.classList.add('pbv');
      let data = { books: [], kinds: [], agents: [], settings: {}, timeZone: '' };
      let filter = 'all'; let alive = true;
      const note = h('p', { class: 'sub', 'aria-live': 'polite' });
      const tabs = h('div', { class: 'tabbar', role: 'tablist', 'aria-label': 'Kinds of work' });
      const grid = h('div', { class: 'pb-grid' });
      const body = h('div', { class: 'pb-body' }, grid);
      el.replaceChildren(h('div', { class: 'pb-top' },
        h('div', { class: 'pb-head' }, h('h2', null, 'Playbooks'), h('span', { class: 'grow' }), btn('Write a playbook', { kind: 'ghost sm', onClick: () => editor() }), btn('Add from a file', { kind: 'ghost sm', onClick: () => importer() })),
        h('p', { class: 'sub' }, 'Ready-made jobs. Run one now or on a schedule; the agent whose work fits does it. Each run box says what that run can do.'),
        note, tabs), body);

      const go = (fix) => fix?.go && ui.go(...fix.go);
      const tag = (b) => (b.own ? h('span', { class: 'pb-tag', title: b.origin === 'file' ? 'Added from a file' : b.origin === 'copy' ? 'Your copy of a built-in playbook' : 'Written by you' }, 'Custom') : null);
      const plainWhen = (r) => r?.startedText || '';
      function paintTabs() {
        const kinds = data.kinds.filter(k => data.books.some(b => b.kind === k.id));
        const opts = [['all', 'All'], ...kinds.map(k => [k.id, k.label]), ['own', 'Yours']];
        tabs.replaceChildren(...opts.map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(filter === id), onclick: () => { filter = id; paintTabs(); paintGrid(); } }, label)));
      }
      function bookCard(b) {
        const s = b.schedule; const last = b.last; const block = b.ready.blocks[0];
        return card({ class: 'pb-card', 'data-book': b.id },
          h('div', { class: 'pb-title' }, h('h3', null, b.title), tag(b), h('span', { class: 'pb-kind' }, b.kindLabel)),
          h('p', { class: 'pb-out' }, b.outcome || 'No description.'),
          block ? h('div', { class: 'pb-line' }, statusChip(NEED[block.kind] || 'Needs something', block.kind === 'input' ? 'off' : 'slow'), h('span', null, block.text), block.fix ? btn(block.fix.label, { kind: 'ghost sm', onClick: () => go(block.fix) }) : null) : null,
          s ? h('div', { class: 'pb-line' }, s.on ? (s.waiting ? statusChip('Waiting', 'slow') : statusChip('Scheduled', 'live')) : statusChip('Schedule paused', 'off'), h('span', null, `${s.on ? (s.waiting || `${s.label}. Next: ${s.nextText || 'not set'}.`) : s.label + '.'}${s.lastNote ? ` Last: ${s.lastNote}` : ''}`)) : b.rhythm && b.trusted ? h('div', { class: 'pb-line' }, h('span', null, `Suggested: ${b.rhythm.label}`)) : null,
          b.trusted ? null : h('div', { class: 'pb-line' }, h('span', null, b.origin === 'file' ? 'From a file, not trusted yet: you tick before each run, and it cannot run on a schedule.' : 'Not trusted yet: you tick before each run, and it cannot run on a schedule.')),
          b.running ? h('div', { class: 'pb-line' }, statusChip('Running', 'run'), h('span', null, `${last?.agentName || 'An agent'} is working on it`))
            : last ? h('div', { class: 'pb-line' }, statusChip(...(STATUS[last.status] || STATUS.done)), h('span', null, `Last run ${plainWhen(last)} by ${last.agentName}`)) : h('div', { class: 'pb-line' }, h('span', null, 'Not run yet')),
          h('div', { class: 'pb-acts' },
            btn('Run now', { kind: 'sm', onClick: () => runBox(b.id) }),
            btn(s ? 'Schedule' : 'Set a schedule', { kind: 'ghost sm', onClick: () => scheduleBox(b) }),
            btn('History', { kind: 'ghost sm', onClick: () => history(b) }),
            btn('More', { kind: 'ghost sm', 'aria-label': `More for ${b.title}`, onClick: () => more(b) })));
      }
      function paintGrid() {
        const list = data.books.filter(b => filter === 'all' || (filter === 'own' ? b.own : b.kind === filter));
        if (!list.length) {
          grid.replaceChildren(h('div', { style: { gridColumn: '1/-1' } }, empty(filter === 'own' ? 'You have no playbooks of your own yet. Write one, make a copy of a built-in one under More, or add one from a file.' : 'No playbooks of this kind.'),
            filter === 'own' ? h('div', { class: 'row', style: { justifyContent: 'center' } }, btn('Write a playbook', { kind: 'ghost sm', onClick: () => editor() }), btn('Add from a file', { kind: 'ghost sm', onClick: () => importer() })) : null));
          return;
        }
        grid.replaceChildren(...list.map(bookCard));
      }
      async function load() {
        try { data = await api('m/playbooks/books'); }
        catch (e) { grid.replaceChildren(empty('The playbooks could not be loaded. ' + ui.plainError(e))); return; }
        if (!alive) return;
        note.textContent = data.halted ? 'Everything is stopped. Press Resume to run playbooks again.' : data.offline ? 'The desk is offline: scheduled runs wait, and only a local model can answer.' : '';
        note.hidden = !note.textContent;
        paintTabs(); paintGrid();
      }
      let soonT = null; const soon = () => { clearTimeout(soonT); soonT = setTimeout(load, 300); };
      ui.on('job', (j) => { if (String(j?.kind || '').startsWith('playbooks.')) soon(); });
      ui.on('panic', soon); ui.on('settings', soon); ui.on('modules', soon);

      // ---- the run box
      async function runBox(id) {
        let b, agents;
        try { ({ book: b, agents } = await api(`m/playbooks/books/${encodeURIComponent(id)}`)); } catch (e) { toast(e.message, 'err'); return; }
        const fields = {};
        const inputs = b.inputs.map(x => {
          const v = b.values[x.id] ?? '';
          const f = x.type === 'long' ? h('textarea', { placeholder: x.example || '', 'aria-label': x.label }, v)
            : x.type === 'choice' ? h('select', { 'aria-label': x.label }, (x.options || []).map(o => h('option', { value: o, selected: o === v ? true : null }, o)))
            : h('input', { type: 'text', value: v, placeholder: x.example || (x.type === 'file' ? 'reports/list.xlsx' : ''), 'aria-label': x.label, autocomplete: 'off', spellcheck: x.type === 'file' ? 'false' : null });
          fields[x.id] = f; f.addEventListener('change', () => recheck());
          const fromFileValue = b.origin === 'file' && (x.default || x.type === 'choice') ? (x.type === 'choice' ? 'These choices were written in the file.' : 'The first value was written in the file, not by you.') : '';
          const help = [x.hint && !/[.!?]$/.test(x.hint) ? x.hint + '.' : x.hint, x.type === 'file' ? 'The path inside your workspace, as Files shows it.' : '', fromFileValue].filter(Boolean).join(' ');
          return h('label', { class: 'pb-f' }, x.label, f, help ? h('span', { class: 'd' }, help) : null);
        });
        const agentSel = h('select', { 'aria-label': 'Who runs it' }, agents.map(a => h('option', { value: a.id, selected: a.id === b.who.agentId ? true : null }, `${(ui.agentLine && ui.agentLine(a.id)) || a.name}${a.role ? ' · ' + a.role : ''}`)));
        const whyEl = h('span', { class: 'd' }); const modelEl = h('span', { class: 'd' });
        const state = h('div', { 'aria-live': 'polite' });
        let runBtn = null; let chosen = b.agentId ? b.who.agentId : null;
        agentSel.addEventListener('change', () => { chosen = agentSel.value; recheck(); });
        const paintWho = (w) => { whyEl.textContent = w.why; modelEl.textContent = `Model: ${w.model.label}`; };
        const paintReady = (r) => {
          state.replaceChildren(...[
            r.blocks.some(x => x.kind !== 'limits') ? h('div', { class: 'pb-block', role: 'alert' }, ...r.blocks.filter(x => x.kind !== 'limits').map(x => h('div', null, h('span', null, x.text), x.fix ? btn(x.fix.label, { kind: 'ghost sm', onClick: () => { box.close(); go(x.fix); } }) : null))) : null,
            r.warns.length ? h('div', { class: 'caution' }, ...r.warns.map(w => h('div', { class: 'sub' }, w))) : null].filter(Boolean));
          blocked = !!r.blocks.length;
          if (runBtn) runBtn.disabled = blocked || (tick ? !tick.checked : false);
        };
        const values = () => Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.value]));
        // what this run can do, in the desk's words (they come from the code that sets it); not trusted: one more tick
        const u = b.untrusted; const sc = b.scope; let blocked = false;
        const noLimits = b.ready.blocks.find(x => x.kind === 'limits');   // it cannot run on this desk at all: no tick
        const tick = u && !noLimits ? h('input', { type: 'checkbox', 'aria-label': 'I have read every step and what this run can do, and want it to run' }) : null;
        tick?.addEventListener('change', () => { if (runBtn) runBtn.disabled = blocked || !tick.checked; });
        const warn = sc || u ? h('div', { class: u ? 'pb-block' : 'pb-scope', role: 'note' },
          u ? h('div', null, h('span', null, u.why)) : null,
          sc?.sideLine && sc.words.startsWith(sc.sideLine) ? h('div', null, h('b', null, sc.sideLine)) : null,
          sc ? h('div', null, h('span', null, sc.sideLine && sc.words.startsWith(sc.sideLine) ? sc.words.slice(sc.sideLine.length).trim() : sc.words)) : noLimits ? h('div', null, h('span', null, noLimits.text)) : null,
          tick ? h('label', { class: 'pb-tick' }, tick, h('span', null, 'I have read every step and what this run can do, and want it to run.')) : null) : null;
        async function recheck() { try { const r = await api(`m/playbooks/books/${encodeURIComponent(id)}/check`, { body: { inputs: values(), agentId: chosen } }); paintWho(r.who); paintReady(r.ready); } catch {} }
        paintWho(b.who);
        const content = h('div', { class: 'pb-box' },
          b.outcome ? h('p', { class: 'sub' }, b.outcome) : null,
          warn,
          ...inputs,
          h('label', { class: 'pb-f' }, 'Who runs it', agentSel, whyEl, modelEl),
          h('div', null, h('div', { class: 'sub' }, 'Waits for your approval'), b.approvals.length ? h('ul', null, b.approvals.map(a => h('li', null, a))) : h('p', { class: 'sub' }, 'Not stated.')),
          state);
        const box = modal({ title: `Run: ${b.title}`, body: content, actions: [{ label: 'Cancel' }, { label: 'Run', kind: '', onClick: async () => {
          const missing = b.inputs.find(x => !x.optional && x.type !== 'file' && !String(fields[x.id].value).trim());
          if (missing) { ui.needs(fields[missing.id], `Fill in ${missing.label.toLowerCase()} first.`); return false; }
          try {
            if (tick && !tick.checked) { ui.needs(tick, 'Tick the box first.'); return false; }
            const r = await api(`m/playbooks/books/${encodeURIComponent(id)}/run`, { body: { inputs: values(), ...(chosen ? { agentId: chosen } : {}), ...(tick?.checked ? { understood: true } : {}) } });
            toast(`Started. ${r.by} is working on it; the result will be under History.`, 'ok'); soon(); return true;
          } catch (e) { paintReady({ blocks: [{ text: ui.plainError(e) }], warns: [] }); return false; }
        } }] });
        runBtn = [...box.box.querySelectorAll('.row .btn')].find(x => x.textContent === 'Run') || null;
        paintReady(b.ready);
      }

      // ---- schedule
      function scheduleBox(b) {
        const s = b.schedule;
        if (!b.trusted) {
          const actions = [{ label: 'Close' }];
          if (s) actions.push({ label: 'Remove the schedule', onClick: async () => { await api(`m/playbooks/books/${encodeURIComponent(b.id)}/schedule`, { method: 'DELETE' }).catch(e => toast(e.message, 'err')); soon(); } });
          modal({ title: `Schedule: ${b.title}`, body: h('div', { class: 'pb-box' },
            h('p', null, `${b.origin === 'file' ? 'This playbook came from a file' : 'You wrote or changed this playbook by hand'}, so it cannot run on a schedule yet.`),
            h('p', { class: 'sub' }, 'Run it once with Run now and read what it did. Then tick "I trust this playbook" under More, and come back here.')), actions });
          return;
        }
        const start = readCron(s?.cron || (b.origin === 'file' ? '' : b.rhythm?.cron) || '0 8 * * 1');
        const day = h('select', { 'aria-label': 'How often' }, DAYS.map(([v, l]) => h('option', { value: v, selected: v === start.day ? true : null }, l)));
        const time = h('input', { type: 'time', value: start.time, 'aria-label': 'At what time' });
        // the words are written by the desk from the schedule itself, and shown before he saves
        const words = h('p', { class: 'pb-words', 'aria-live': 'polite' });
        const sayWords = async () => {
          try { const w = await api('m/playbooks/schedule/words', { body: { cron: makeCron(day.value, time.value).cron } }); words.textContent = `It will run: ${w.label}, in your time zone, ${w.timeZone}. Next: ${w.nextText}.`; }
          catch (e) { words.textContent = ui.plainError(e); }
        };
        day.addEventListener('change', sayWords); time.addEventListener('change', sayWords); sayWords();
        const info = h('p', { class: 'sub' }, b.rhythm && b.origin !== 'file' ? `Suggested: ${b.rhythm.label}.` : 'Pick when it runs.');
        const nowText = [s?.on ? s.waiting : s ? 'Paused.' : '', s?.last ? `Last: ${s.last}. ${s.lastNote}` : ''].filter(Boolean).join(' ');
        const now = nowText ? h('p', { class: 'sub' }, nowText) : null;
        const save = (patch) => api(`m/playbooks/books/${encodeURIComponent(b.id)}/schedule`, { body: patch }).then((r) => { toast(r.schedule.on ? `Scheduled: ${r.schedule.label}. Next run: ${r.schedule.nextText}.` : 'Paused.', 'ok'); soon(); }).catch(e => { toast(e.message, 'err'); return false; });
        const actions = [{ label: 'Cancel' }];
        if (s) actions.push({ label: 'Remove', onClick: async () => { if (!(await confirm('Remove this schedule? The playbook stays.', { ok: 'Remove' }))) return false; await api(`m/playbooks/books/${encodeURIComponent(b.id)}/schedule`, { method: 'DELETE' }).catch(e => toast(e.message, 'err')); soon(); } });
        if (s) actions.push({ label: s.on ? 'Pause' : 'Resume', onClick: () => save({ on: !s.on }) });
        actions.push({ label: 'Save', kind: '', onClick: () => save({ cron: makeCron(day.value, time.value).cron, on: true }) });
        modal({ title: `Schedule: ${b.title}`, body: h('div', { class: 'pb-box' }, h('div', { class: 'pb-two' }, h('label', { class: 'pb-f' }, 'How often', day), h('label', { class: 'pb-f' }, 'At', time)), words, info, now,
          h('p', { class: 'sub' }, 'A schedule set here starts a run at most once an hour. While the desk is offline or everything is stopped, a due run waits and says why. It uses the inputs you saved in Run now.')), actions });
      }

      // ---- history
      async function history(b) {
        const list = h('div', { class: 'pb-box', 'aria-live': 'polite' }, empty('Loading…'));
        let t = null; let open = true;
        const runEl = (r, i) => {
          const [word, kind] = STATUS[r.status] || STATUS.done;
          const cost = !r.cost ? 'not known' : r.cost.minor === 0 ? 'nothing (a free model)' : fmt.money(r.cost.minor, r.cost.currency || undefined);
          return h('div', { class: 'pb-run' },
            h('div', { class: 'pb-line', style: { color: 'var(--fg)' } }, statusChip(word, kind), h('span', null, `${r.startedText} · ${r.agentName} · ${TRIGGER[r.trigger] || ''}`)),
            h('div', { class: 'sub' }, `Model: ${r.model || 'not known yet'} · Cost: ${r.status === 'running' ? 'counted at the end' : cost}`),
            r.note ? h('p', { class: r.status === 'done' ? 'sub caution' : 'sub' }, r.note) : null,
            r.result ? h('details', i === 0 ? { open: true } : null, h('summary', null, r.show === 'links' ? 'The result' : 'The result, as plain text'), drawResult(r.result, r.show, { h, md, btn })) : null,
            r.waiting?.length ? h('div', null, h('div', { class: 'sub' }, 'Waiting for you'), h('ul', null, r.waiting.map(w => h('li', null, w.title)))) : r.status === 'done' ? h('p', { class: 'sub' }, 'Nothing is waiting for you from this run.') : null,
            h('div', { class: 'row' }, r.status === 'running' ? btn('Stop', { kind: 'ghost sm', onClick: async () => { try { await api(`m/playbooks/runs/${r.id}/stop`, { body: {} }); paint(); soon(); } catch (e) { toast(e.message, 'err'); } } }) : null,
              r.chatOpen ? btn('Open the chat', { kind: 'ghost sm', onClick: () => { box.close(); ui.go('chat', r.chatId); } }) : null,
              r.result && r.status !== 'running' ? btn(r.show === 'links' ? 'Save the result as a file' : 'Save the result as a text file', { kind: 'ghost sm', onClick: async () => { try { const f = await api(`m/playbooks/runs/${r.id}/file`, { body: {} }); toast(`Saved in your workspace as ${f.path}.`, 'ok'); } catch (e) { toast(e.message, 'err'); } } }) : null,
              r.waiting?.length ? btn('See what waits', { kind: 'ghost sm', onClick: () => { box.close(); ui.go('tasks'); } }) : null));
        };
        async function paint() {
          if (!open) return;
          try {
            const { runs } = await api(`m/playbooks/books/${encodeURIComponent(b.id)}/runs`);
            list.replaceChildren(...(runs.length ? runs.map(runEl) : [empty('Not run yet. Press Run now; each run is kept here with who did it, the model, the cost and the result.')]));
            clearTimeout(t); if (runs.some(r => r.status === 'running')) t = setTimeout(paint, 2000);
          } catch (e) { list.replaceChildren(empty(ui.plainError(e))); }
        }
        const box = modal({ title: `History: ${b.title}`, body: list, wide: true, actions: [{ label: 'Close' }], onClose: () => { open = false; clearTimeout(t); } });
        paint();
      }

      // ---- more: steps, copy, file, edit, remove
      function more(b) {
        const acts = [{ label: 'Close' },
          { label: 'Make a copy', onClick: async () => { try { const r = await api(`m/playbooks/books/${encodeURIComponent(b.id)}/copy`, { body: {} }); toast(`Copied as "${r.book.title}". Change it with More, Change.`, 'ok'); filter = 'own'; await load(); } catch (e) { toast(e.message, 'err'); } } },
          { label: 'Save as a file', onClick: async () => { try { const r = await api(`m/playbooks/books/${encodeURIComponent(b.id)}/file`, { body: {} }); toast(`Saved in your workspace as ${r.path}.`, 'ok'); } catch (e) { toast(e.message, 'err'); } } }];
        if (b.own) acts.push({ label: 'Change', onClick: () => { setTimeout(() => editor(b), 0); } }, { label: 'Remove', kind: 'stop', onClick: async () => {
          if (!(await confirm(`Remove "${b.title}"? Its schedule and history go with it. Built-in playbooks stay.`, { ok: 'Remove', kind: 'stop' }))) return;
          try { await api(`m/playbooks/books/${encodeURIComponent(b.id)}`, { method: 'DELETE' }); toast('Removed.', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); }
        } });
        const body = stepsView(h, b);
        if (b.own) {
          const tk = h('input', { type: 'checkbox', checked: b.trusted ? true : null, disabled: !b.ranOnce && !b.trusted ? true : null, 'aria-label': 'I trust this playbook' });
          const said = h('span', { class: 'sub', 'aria-live': 'polite' });
          tk.addEventListener('change', async () => {
            try { await api(`m/playbooks/books/${encodeURIComponent(b.id)}/trust`, { body: { on: tk.checked } }); said.textContent = tk.checked ? 'Trusted.' : 'No longer trusted.'; soon(); }
            catch (e) { tk.checked = !tk.checked; said.textContent = ui.plainError(e); }
          });
          body.append(h('div', { class: 'pb-trust' },
            h('label', { class: 'pb-tick' }, tk, h('span', null, 'I trust this playbook')), said,
            h('p', { class: 'sub' }, b.ranOnce || b.trusted ? 'Trusted: it runs without the extra tick and can run on a schedule. Any change to it ends the trust.' : 'Run it once and read what it did. Then you can tick this. Until then you tick before each run, and it cannot run on a schedule.')));
        }
        modal({ title: b.title, wide: true, body, actions: acts });
      }

      // ---- write or change your own
      function editor(b = null) {
        const val = (v) => v ?? '';
        const title = h('input', { type: 'text', value: val(b?.title), maxlength: '80', 'aria-label': 'Title', placeholder: 'For example: Friday cash check' });
        const kind = h('select', { 'aria-label': 'Kind of work' }, data.kinds.map(k => h('option', { value: k.id, selected: b?.kind === k.id ? true : null }, k.label)));
        const outcome = h('input', { type: 'text', value: val(b?.outcome), maxlength: '240', 'aria-label': 'What you get', placeholder: 'One line on what you get' });
        const steps = h('textarea', { 'aria-label': 'Steps', placeholder: 'One step per line, in plain words' }, (b?.steps || []).join('\n'));
        const waits = h('textarea', { 'aria-label': 'What waits for you', placeholder: 'For example: Each reminder is a draft for you to read.' }, (b?.approvals || []).join('\n'));
        const rows = h('div', { class: 'pb-box', style: { gap: '6px' } });
        const addRow = (x = {}) => {
          if (rows.children.length >= 8) return toast('At most 8 inputs.', 'err');
          const label = h('input', { type: 'text', value: val(x.label), placeholder: 'Input name', 'aria-label': 'Input name', maxlength: '60' });
          const type = h('select', { 'aria-label': 'Input type' }, [['text', 'One line'], ['long', 'Several lines'], ['file', 'A file'], ['choice', 'A choice']].map(([v, l]) => h('option', { value: v, selected: (x.type || 'text') === v ? true : null }, l)));
          const hint = h('input', { type: 'text', value: x.type === 'choice' ? (x.options || []).join(', ') : val(x.hint), placeholder: 'Hint, or the choices with commas', 'aria-label': 'Hint or choices', maxlength: '160' });
          const row = h('div', { class: 'pb-irow' }, label, type, hint, btn('Remove', { kind: 'ghost sm', onClick: () => row.remove() }));
          row._get = () => ({ label: label.value, type: type.value, ...(type.value === 'choice' ? { options: hint.value.split(',').map(s => s.trim()).filter(Boolean) } : { hint: hint.value }), ...(x.id ? { id: x.id } : {}), ...(x.optional ? { optional: true } : {}), ...(x.default ? { default: x.default } : {}), ...(x.example ? { example: x.example } : {}) });
          rows.append(row);
        };
        (b?.inputs || []).forEach(addRow);
        const r0 = b?.rhythm ? readCron(b.rhythm.cron) : null;
        const day = h('select', { 'aria-label': 'Suggested rhythm' }, [h('option', { value: '' }, 'No suggested rhythm'), ...DAYS.map(([v, l]) => h('option', { value: v, selected: r0?.day === v ? true : null }, l))]);
        const time = h('input', { type: 'time', value: r0?.time || '08:00', 'aria-label': 'At what time' });
        const err = h('div', { 'aria-live': 'polite' });
        const content = h('div', { class: 'pb-box' },
          h('p', { class: 'sub' }, 'A playbook is text only: your agent reads it as a job. Its run box says what a run can do.'),
          h('div', { class: 'pb-two' }, h('label', { class: 'pb-f' }, 'Title', title), h('label', { class: 'pb-f' }, 'Kind of work', kind)),
          h('label', { class: 'pb-f' }, 'What you get', outcome),
          h('label', { class: 'pb-f' }, 'Steps', steps),
          h('div', null, h('div', { class: 'row' }, h('span', { class: 'sub' }, 'Inputs you fill once'), h('span', { class: 'grow' }), btn('Add an input', { kind: 'ghost sm', onClick: () => addRow() })), rows),
          h('label', { class: 'pb-f' }, 'What waits for your approval', waits),
          h('div', { class: 'pb-two' }, h('label', { class: 'pb-f' }, 'Suggested rhythm', day), h('label', { class: 'pb-f' }, 'At', time)),
          err);
        modal({ title: b ? `Change: ${b.title}` : 'Write a playbook', wide: true, body: content, actions: [{ label: 'Cancel' }, { label: 'Save', kind: '', onClick: async () => {
          if (!title.value.trim()) { ui.needs(title, 'Give it a title.'); return false; }
          if (!steps.value.trim()) { ui.needs(steps, 'Write at least one step.'); return false; }
          const book = { title: title.value, kind: kind.value, outcome: outcome.value, steps: steps.value.split('\n').filter(x => x.trim()), approvals: waits.value.split('\n').filter(x => x.trim()), inputs: [...rows.children].map(r => r._get()).filter(x => x.label.trim()),
            rhythm: day.value ? { cron: makeCron(day.value, time.value).cron } : null, needs: b?.needs?.map(n => n.id || n) || [], uses: b?.usesIds || [] };
          try { await api(b ? `m/playbooks/books/${encodeURIComponent(b.id)}/edit` : 'm/playbooks/books', { body: { book } }); toast('Saved.', 'ok'); filter = 'own'; await load(); return true; }
          catch (e) { err.replaceChildren(h('div', { class: 'pb-block', role: 'alert' }, ui.plainError(e))); return false; }
        } }] });
      }

      // ---- add from a file: look at the whole text first; marked lines need the owner's choice
      async function importer() {
        const area = h('div', { class: 'pb-box', 'aria-live': 'polite' });
        const picker = h('input', { type: 'file', accept: '.json,application/json,text/plain', 'aria-label': 'A playbook file' });
        const shared = h('div', { class: 'pb-box', style: { gap: '6px' } });
        let current = null; let box = null;
        const look = async (src) => {
          try {
            const r = await api('m/playbooks/import/check', { body: src });
            current = { ...src, token: r.token, r };
            area.replaceChildren(...[
              r.problems.length ? h('div', { class: 'pb-block', role: 'alert' }, ...r.problems.map(p => h('div', null, p))) : null,
              r.ok ? h('p', { class: 'sub' }, `"${r.book.title}": ${plural(r.book.steps.length, 'step')}, ${plural(r.book.inputs.length, 'input')}.${r.sameTitle ? ` You already have one called "${r.sameTitle}"; this one is added beside it.` : ''}${r.needsOff.length ? ` It needs ${r.needsOff.join(', ')}, which is off.` : ''}`) : null,
              ...(r.notes || []).map(n => h('p', { class: 'sub' }, n)),
              r.ok ? h('p', { class: 'pb-words' }, r.toolLimits
                ? `${r.side} ${r.records} A playbook from a file runs only after you tick its run box, and is put on a schedule here only after you trust it. Its run box names every tool it has, and its result is shown as plain text.`
                : `This desk cannot run a playbook from a file yet: it needs a desk with tool limits for playbooks. You can still add it and read it. ${r.records}`) : null,
              r.ok && r.book.rhythm ? h('p', { class: 'sub' }, `It suggests a schedule (${r.book.rhythm.label}). A playbook from a file is never put on its own suggestion: you pick the time.`) : null,
              r.risky.length ? h('div', null, h('div', { class: 'sub' }, `A reading help: ${r.risky.length} ${r.risky.length === 1 ? 'line has' : 'lines have'} words about sending, paying, deleting, approving, secrets or setting you aside. It is only a word match: it misses lines written in other words or languages, so read every line.`),
                ...r.risky.map(x => h('div', { class: 'pb-mark' }, h('div', { class: 'sub' }, `${x.where}: ${x.why.join(', ')}`), x.text))) : null,
              (r.ok ? r.readout : r.text) ? h('div', null, h('div', { class: 'sub' }, r.ok ? 'The playbook as the desk read it. Your agent is given exactly these lines, with the records named above; nothing else in the file reaches it.' : 'The whole file, as it is (it was not added)'),
                h('p', { class: 'sub' }, `Letters from other alphabets can look like English letters. Every word with letters that are not in the main alphabet${r.alphabets?.main ? ` (${r.alphabets.main})` : ''} is shown with the name of its alphabet${r.alphabets?.words?.length ? `: ${r.alphabets.words.length} ${r.alphabets.words.length === 1 ? 'word' : 'words'} here` : ': none here'}.`),
                h('pre', { class: 'pb-text' }, ...withAlphabets(h, r.ok ? r.readout : r.text, r.alphabets?.words || []))) : null].filter(Boolean));
            paintActs();
          } catch (e) { area.replaceChildren(h('div', { class: 'pb-block', role: 'alert' }, ui.plainError(e))); current = null; paintActs(); }
        };
        picker.addEventListener('change', async () => {
          const f = picker.files?.[0]; if (!f) return;
          if (f.size > 32 * 1024) { area.replaceChildren(h('div', { class: 'pb-block', role: 'alert' }, `The file is ${Math.ceil(f.size / 1024)} KB. A playbook file may be at most 32 KB.`)); current = null; paintActs(); return; }
          look({ text: await f.text() });
        });
        try {
          const { files } = await api('m/playbooks/files');
          shared.replaceChildren(...(files.length ? [h('div', { class: 'sub' }, 'Or one in your workspace, in the playbooks folder:'), ...files.map(f => h('div', { class: 'row' }, h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, f.name), h('span', { class: 'grow' }), btn('Look at it', { kind: 'ghost sm', onClick: () => look({ path: f.path }) })))] : [h('p', { class: 'sub' }, 'Playbooks you save as a file go into the playbooks folder of your workspace.')]));
        } catch {}
        const add = async (acceptMarked) => {
          if (!current?.r?.ok) return false;
          try { const r = await api('m/playbooks/import/add', { body: { ...(current.path ? { path: current.path } : { text: current.text }), token: current.token, acceptMarked } }); toast(`Added "${r.book.title}".`, 'ok'); filter = 'own'; await load(); return true; }
          catch (e) { area.prepend(h('div', { class: 'pb-block', role: 'alert' }, ui.plainError(e))); return false; }
        };
        const paintActs = () => {
          const row = box?.box.querySelector(':scope > .row'); if (!row) return;
          for (const b of row.querySelectorAll('.btn[data-pb]')) b.remove();
          if (!current?.r?.ok) return;
          const marked = current.r.risky.length > 0;
          if (marked) row.append(btn('Do not add', { kind: 'ghost', 'data-pb': '1', onClick: () => box.close() }));
          row.append(btn(marked ? 'Add it anyway' : 'Add it', { 'data-pb': '1', onClick: async () => { if (await add(marked)) box.close(); } }));
        };
        box = modal({ title: 'Add a playbook from a file', wide: true, body: h('div', { class: 'pb-box' },
          h('p', { class: 'sub' }, 'A playbook file is a small text file someone shared. Before anything is added, the desk shows you the playbook as it read it, field by field: that is the text your agent is given. Nothing in it is cut or changed; a file with anything over a limit, a name written twice or a field a playbook does not have is refused. It is never run as code.'),
          h('label', { class: 'pb-f' }, 'Pick a file', picker), shared, area), actions: [{ label: 'Cancel' }] });
      }

      await load();
      return () => { alive = false; clearTimeout(soonT); };
    },
    unmount() {},
  },
};

// the file's text as text nodes; a word with letters outside the main alphabet is wrapped and carries its alphabet's name,
// drawn beside it by CSS, so the text itself stays exactly as it is
function withAlphabets(h, text, words) {
  const out = []; let at = 0;
  for (const w of words) { if (w.start < at) continue; out.push(text.slice(at, w.start), h('mark', { class: 'pb-abc', 'data-abc': w.alphabets.join(' and '), title: `Letters: ${w.alphabets.join(' and ')}` }, text.slice(w.start, w.end))); at = w.end; }
  out.push(text.slice(at));
  return out.filter(x => x !== '');
}

function stepsView(h, b) {
  return h('div', { class: 'pb-box' },
    b.outcome ? h('p', { class: 'sub' }, b.outcome) : null,
    h('div', null, h('div', { class: 'sub' }, 'Steps'), h('ol', { style: { margin: 0, paddingLeft: '20px', fontSize: '13.5px', display: 'flex', flexDirection: 'column', gap: '3px' } }, b.steps.map(s => h('li', null, s)))),
    b.inputs.length ? h('div', null, h('div', { class: 'sub' }, 'Inputs you fill once'), h('ul', null, b.inputs.map(x => h('li', null, x.label + (x.hint ? ` (${x.hint})` : ''))))) : null,
    h('div', null, h('div', { class: 'sub' }, 'Waits for your approval'), h('ul', null, (b.approvals.length ? b.approvals : ['Not stated.']).map(a => h('li', null, a)))),
    b.needs.length ? h('p', { class: 'sub' }, `Needs: ${b.needs.map(n => `${n.name}${n.on ? '' : ' (off)'}`).join(', ')}.`) : null,
    b.uses.length ? h('p', { class: 'sub' }, `Reads: ${b.uses.join(', ')}.`) : null,
    h('p', { class: 'sub' }, b.rhythm ? `Suggested rhythm: ${b.rhythm.label}.` : 'No suggested rhythm: run it when you need it.'));
}

// ---- Settings › Playbooks
export const settings = {
  playbooks: {
    title: 'Playbooks',
    async render(el, ui) {
      const { h, api, sw, empty } = ui;
      ensureCss(h);
      let s;
      try { s = (await api('m/playbooks/settings')).settings; } catch (e) { el.replaceChildren(empty('These settings could not be loaded. ' + ui.plainError(e))); return; }
      const mark = (m) => m;
      const save = (patch, m) => m.run(() => api('m/playbooks/settings', { body: patch }).then(r => { s = r.settings; }));
      const m1 = ui.savedMark(), m2 = ui.savedMark(), m3 = ui.savedMark();
      const keep = h('select', { 'aria-label': 'Runs kept per playbook' }, [10, 25, 50, 100].map(n => h('option', { value: String(n), selected: n === s.keep ? true : null }, `The last ${n}`)));
      keep.addEventListener('change', () => { const old = String(s.keep); m3.run(() => api('m/playbooks/settings', { body: { keep: Number(keep.value) } }).then(r => { s = r.settings; }), { field: keep, old }); });
      el.replaceChildren(ui.card(
        h('h3', null, 'Playbooks'),
        ui.line('Scheduled runs', 'Playbooks with a schedule start on time. Off: nothing starts by itself; Run now still works.', h('span', { class: 'field' }, mark(m1), sw(s.scheduled, 'Scheduled runs', (on) => save({ scheduled: on }, m1)))),
        ui.line('Start from chat', 'The lead agent may start one of your playbooks when you ask for it by name in a chat.', h('span', { class: 'field' }, mark(m2), sw(s.chatTool, 'Start from chat', (on) => save({ chatTool: on }, m2)))),
        ui.line('History', 'How many runs each playbook keeps.', h('span', { class: 'field' }, m3, keep))));
    },
  },
};
