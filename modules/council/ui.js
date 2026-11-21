// The Council panel: rendered as the Council tab of the Research page (the Research module calls pages.council.render), or on its own at #/council.
const CSS = `
.cn-root{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0}
.cn{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:14px;flex:1;min-height:0}
.cn-main{display:flex;flex-direction:column;gap:12px;min-height:0;overflow:auto;padding:2px}
.cn-side{display:flex;flex-direction:column;gap:6px;min-height:0;overflow:auto}
.cn-side .card{padding:9px 12px;width:100%}
.cn-side .cn-vote{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;min-width:0;border-radius:10px}
.cn-ans{max-height:min(240px,24vh);overflow:auto;white-space:pre-wrap}
.cn-q{flex:1;min-width:220px}
.cn select{max-width:100%;font-size:12.5px}
.cn-seat>.row:first-child>div{min-width:0;flex:1}
.cn-verdict ul{margin:4px 0 0;padding-left:18px}
.cn-note{border-left:3px solid var(--warn);padding-left:8px}
.cn .seats.four{grid-template-columns:repeat(2,minmax(0,1fr))}
.cn-steps{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.cn-steps li{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}.cn-steps li span{flex:1;min-width:180px}
@media (max-width:860px){.cn{grid-template-columns:minmax(0,1fr)}.cn .seats{grid-template-columns:minmax(0,1fr)}}
`;
const API = 'm/council/';
/** The Verdict's lists for a plan: where the advisors agree and differ, and the proposed steps, each with its own task button. */
function planBits(v, runId, ui) {
  const { h, btn, toast } = ui;
  const list = (title, items) => items?.length ? h('div', { class: 'sub' }, h('b', null, title), h('ul', { style: { margin: '2px 0 0', paddingLeft: '18px' } }, items.map(x => h('li', null, x)))) : null;
  const steps = (v.steps || []).length ? h('div', null, h('b', { class: 'sub' }, '30-day plan: proposals, nothing has started'), h('ol', { class: 'cn-steps' }, v.steps.map((x, i) => h('li', null, h('span', { class: 'sub' }, x.text + (x.by ? ` (${x.by})` : '')),
    btn('Turn into a task', { kind: 'ghost sm', onClick: async (ev) => { const b = ev.currentTarget; b.disabled = true; try { const r = await ui.api(API + `runs/${runId}/action`, { body: { action: 'task', step: i } }); toast('Task created', 'ok'); if (r.go) location.hash = r.go; } catch (e) { b.disabled = false; toast(e.message, 'err'); } } }))))) : null;
  return [list('Where they agree', v.agree), list('Where they differ', v.differ), steps].filter(Boolean);
}
let draft = '';                 // the question being typed survives a re-render of the panel
const optKey = (m) => m?.provider ? JSON.stringify({ provider: m.provider, model: m.model ?? null }) : '';

function routeRoom(route) {
  const parts = route?.parts || [];
  const i = parts.indexOf('council');
  if (i >= 0) return parts[i + 1] || null;
  return route?.page === 'council' ? parts[0] || null : null;
}

async function render(el, ui, routeArg) {
  const { h, api, btn, pill, card, toast, fmt, empty, seg, spinner } = ui;
  if (!document.getElementById('cn-css')) document.head.append(h('style', { id: 'cn-css' }, CSS));
  const standalone = (routeArg || ui.state.route)?.page === 'council';
  const st = { roomId: routeRoom(routeArg || ui.state.route), room: null, runs: [], run: null, format: 'decision', seats: [], options: [], formats: [], question: '' };
  const root = h('div', { class: 'cn-root' }); el.replaceChildren(root);   // one panel per render, even when the shell renders twice
  if (standalone) el.style.overflow = 'hidden';
  const main = h('div', { class: 'cn-main' }); const side = h('div', { class: 'cn-side' });
  if (standalone) root.append(h('div', { class: 'row' }, h('h2', null, 'Council'), h('span', { class: 'sub' }, 'Three seats, one Verdict. Each seat names the model that wrote it.')));
  root.append(h('div', { class: 'cn' }, main, side));

  const load = async () => {
    const [m, f] = await Promise.all([api(API + 'models').catch(() => ({ options: [] })), api(API + 'formats').catch(() => ({ formats: [] }))]);
    st.options = m.options; st.formats = f.formats;
  };
  const loadDefaults = async () => { const d = await api(API + 'defaults?format=' + st.format); st.seats = d.seats; st.chair = d.chair; st.notice = d.notice || ''; };
  const loadNotice = async () => { try { st.notice = (await api(API + 'defaults?format=' + st.format)).notice || ''; } catch {} };
  const loadRoom = async (id, runId) => {
    const r = await api(API + 'rooms/' + id); st.room = r.room; st.runs = r.runs; st.seats = r.room.seats.map(s => ({ ...s })); st.format = r.room.format;
    st.run = (runId && r.runs.find(x => x.id === runId)) || r.runs[0] || null;
  };
  const paintSide = async () => {
    const r = await api(API + 'rooms').catch(() => ({ rooms: [] }));
    side.replaceChildren(h('div', { class: 'row' }, h('b', null, 'Past Verdicts'), h('span', { class: 'grow' }), btn('New question', { kind: 'ghost sm', onClick: async () => { st.roomId = null; st.room = null; st.run = null; await loadDefaults(); paint(); paintSide(); } })),
      ...(r.rooms.length ? r.rooms.map(rm => h('button', { class: 'card hov', 'aria-current': rm.id === st.roomId ? 'true' : null, style: rm.id === st.roomId ? { borderColor: 'var(--accent)' } : null, onclick: async () => { st.roomId = rm.id; await loadRoom(rm.id); paint(); paintSide(); } },
        h('b', { style: { display: 'block', fontSize: '13px' } }, rm.question.length > 90 ? rm.question.slice(0, 89) + '…' : rm.question),
        h('div', { class: 'row', style: { marginTop: '4px' } }, rm.voteLine ? h('span', { class: 'pill ok cn-vote', 'data-vote': '', title: rm.voteLine }, rm.voteLine) : pill(STATUS[rm.status] || 'Not run', rm.status === 'running' ? 'run' : rm.status === 'failed' ? 'stop' : ''), h('span', { class: 'sub' }, fmt.when(rm.updated))))) : [empty('No Council has met yet.')]));
  };
  const STATUS = { running: 'Meeting', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };

  const modelSelect = (seat, i) => {
    const sel = h('select', { 'aria-label': `Model for ${seat.name}`, onchange: (e) => { st.seats[i].model = e.target.value ? JSON.parse(e.target.value) : null; } },
      h('option', { value: '' }, 'Desk default'),
      st.options.map(o => h('option', { value: optKey(o), selected: optKey(o) === optKey(seat.model) }, o.label)));
    return sel;
  };

  function seatCard(seat, i) {
    const run = st.run; const a = run?.answers?.[i]; const running = run?.status === 'running';
    const v = run?.verdict; const firsts = v ? (v.vote?.voters || []).filter(x => x.pick === seat.name).length : 0; const avg = v?.averages?.find(x => x.name === seat.name);
    const rk = run?.rankings?.find(x => x.seat === i);
    const on = !run || !!a?.text || !!a?.error;
    const label = a?.label || seat.modelLabel || 'Desk default';
    return h('div', { class: 'card seat2 cn-seat' + (on ? ' on' : '') },
      h('div', { class: 'row' }, h('span', { class: 'av' + (i === 2 ? ' g' : '') }, seat.name[0]), h('div', null, h('b', null, seat.name), h('div', { class: 'sub' }, `${seat.stance} · ${label}`)),
        running && !a?.text && !a?.error ? pill('Answering', 'run') : a?.cut ? pill('Cut short', 'wait') : null),
      a?.text && a.fellBack && a.setLabel && a.label && a.setLabel !== a.label ? h('div', { class: 'sub cn-note' }, `answered by ${a.label}; ${a.setLabel} was not answering`) : null,
      a?.text ? h('div', { class: 'sub cn-ans' }, a.text) : a?.error ? h('p', { class: 'sub' }, 'Could not answer: ' + a.error) : run ? h('p', { class: 'sub' }, running ? 'Thinking on its own…' : 'No answer.') : h('p', { class: 'sub' }, seat.brief || ''),
      rk?.ranked?.length ? h('div', { class: 'sub' }, `Ranked the answers: ${rk.ranked.join(' › ')}${rk.label && rk.label !== a?.label ? ' (' + rk.label + ')' : ''}`) : running && a?.text ? h('div', { class: 'sub' }, 'Reviewing the others…') : null,
      v ? h('div', { class: 'row' }, firsts ? pill(firsts === 1 ? 'First choice of 1 seat' : `First choice of ${firsts} seats`, 'ok') : null, avg ? pill(`Average place ${avg.avg}`) : null) : null,
      !running ? h('div', { class: 'row' }, h('span', { class: 'sub' }, 'Seat\'s model setting'), modelSelect(seat, i)) : null);
  }

  function verdictCard() {
    const run = st.run; const v = run?.verdict;
    if (!run) return h('div', { class: 'card seat2 verdict' }, h('b', null, 'Verdict'), h('p', { class: 'sub' }, 'Ask a question and the three seats will answer, rank each other without names, and give one Verdict.'));
    if (!v) {
      const txt = run.status === 'running' ? (run.rankings?.length ? 'The seats are ranking each other. The chairman writes next.' : 'Waiting for the seats.') : run.status === 'stopped' ? 'Stopped before a Verdict.' : run.status === 'interrupted' ? 'The desk restarted during this run. Run it again.' : 'No Verdict: ' + (run.error || 'the run failed.');
      return h('div', { class: 'card seat2 verdict' + (run.status !== 'running' ? ' on' : '') }, h('div', { class: 'row' }, h('b', null, 'Verdict'), run.status === 'running' ? spinner() : pill(STATUS[run.status] || run.status, run.status === 'failed' ? 'stop' : '')), h('p', { class: 'sub' }, txt));
    }
    const full = h('div', { class: 'sub cn-ans', hidden: true }, v.answer || '');
    const act = (action) => async () => { try { const r = await api(API + `runs/${run.id}/action`, { body: { action } }); toast(action === 'research' ? 'Research started' : 'Task created', 'ok'); if (r.go) location.hash = r.go; } catch (e) { toast(e.message, 'err'); } };
    return h('div', { class: 'card seat2 verdict on cn-verdict' },
      h('b', null, 'Verdict · ' + v.voteLine), h('p', null, v.decision),
      v.reasons?.length ? h('ul', { class: 'sub' }, v.reasons.map(r => h('li', null, r))) : null,
      ...planBits(v, run.id, ui),
      (v.notes || []).map(n => h('div', { class: 'sub cn-note' }, n)),
      v.agreeLine && v.rankLine ? h('div', { class: 'sub' }, v.rankLine) : null,
      h('div', { class: 'sub' }, `Written by ${v.label}`),
      v.answer ? full : null,
      h('div', { class: 'row' }, v.steps?.length ? null : btn('Turn into a task', { kind: 'ghost', onClick: act('task') }), v.steps?.length ? null : btn('Research this', { kind: 'ghost', onClick: act('research') }), v.answer ? btn('Full answer', { kind: 'ghost sm', onClick: () => { full.hidden = !full.hidden; } }) : null));
  }

  function paint() {
    const run = st.run; const running = run?.status === 'running';
    const q = h('input', { type: 'text', class: 'cn-q', placeholder: st.formats.find(f => f.id === st.format)?.plan ? 'Optional: what to focus on. Leave empty for a 30-day plan.' : 'Ask the Council: build or buy? Open a sales office? …', value: st.room ? st.room.question : draft, 'aria-label': 'Question for the Council', oninput: (e) => { draft = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') go(); } });
    const fmtIdx = Math.max(0, st.formats.findIndex(f => f.id === st.format));
    const head = st.room
      ? h('div', { class: 'row' }, h('h3', { style: { flex: '1', minWidth: '0' } }, st.room.question), pill(st.room.formatLabel),
          running ? btn('Stop', { kind: 'stop', onClick: async () => { try { await api(`jobs/${run.jobId}/stop`, { method: 'POST' }); } catch (e) { toast(e.message, 'err'); } } }) : btn(run ? 'Run again with these models' : 'Run the debate', { onClick: () => rerun() }))
      : h('div', { class: 'row' }, q, st.formats.length ? seg(st.formats.map(f => f.label), fmtIdx, async (_, i) => { st.format = st.formats[i].id; await loadDefaults(); paint(); }) : null, btn('Run the debate', { onClick: () => go() }));
    const runs = st.runs.length > 1 ? h('div', { class: 'row' }, h('span', { class: 'sub' }, 'Runs of this room:'), st.runs.map(r => btn(`${fmt.when(r.created)} · ${r.verdict?.voteLine || STATUS[r.status] || r.status}`, { kind: r.id === run?.id ? 'sm' : 'ghost sm', onClick: () => { st.run = r; paint(); } }))) : null;
    const blurb = !st.room ? h('p', { class: 'sub' }, (st.formats.find(f => f.id === st.format)?.blurb || '') + (st.chair?.label ? ` The Verdict is written by ${st.chair.label}.` : '')) : null;
    const notice = st.notice && !running ? h('div', { class: 'sub cn-note', role: 'status' }, st.notice) : null;
    main.replaceChildren(...[head, blurb, notice, runs].filter(Boolean), h('div', { class: 'seats' + (st.seats.length === 4 ? ' four' : '') }, st.seats.map(seatCard)), verdictCard());
  }

  async function go() {
    const question = (draft || '').trim(); if (!question && !st.formats.find(f => f.id === st.format)?.plan) return toast('Type a question first.', 'err');
    try {
      const r = await api(API + 'ask', { body: { question, format: st.format, seats: st.seats.map(s => ({ model: s.model })) } });
      st.roomId = r.roomId; await loadRoom(r.roomId, r.runId); draft = ''; paint(); paintSide();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function rerun() {
    try { const r = await api(API + `rooms/${st.roomId}/run`, { body: { seats: st.seats.map(s => ({ model: s.model })) } }); await loadRoom(st.roomId, r.runId); paint(); paintSide(); }
    catch (e) { toast(e.message, 'err'); }
  }

  await load();
  if (st.roomId) { try { await loadRoom(st.roomId); } catch { st.roomId = null; } }
  if (!st.room) await loadDefaults(); else await loadNotice();
  paint(); paintSide();
  let pending = null;
  ui.on('council', (ev) => {
    if (!ev || ev.runId !== st.run?.id) { if (ev?.stage === 'done' || ev?.stage === 'stopped' || ev?.stage === 'failed') paintSide(); return; }
    clearTimeout(pending);
    pending = setTimeout(async () => { try { const r = await api(API + 'runs/' + st.run.id); const i = st.runs.findIndex(x => x.id === r.run.id); if (i >= 0) st.runs[i] = r.run; st.run = r.run; paint(); if (['done', 'stopped', 'failed'].includes(ev.stage)) paintSide(); } catch {} }, 120);
  });
  ui.on('panic', () => setTimeout(async () => { if (st.roomId) { await loadRoom(st.roomId, st.run?.id).catch(() => {}); paint(); paintSide(); } }, 600));
}

export const pages = { council: { title: 'Council', render } };

/** The Verdict card in chat: seat summaries, the Verdict and its actions. */
export const chatCards = {
  'council.verdict': (c, ui) => {
    const { h, btn, toast } = ui;
    const act = (action) => async () => { try { const r = await ui.api(`m/council/runs/${c.runId}/action`, { body: { action } }); toast(action === 'research' ? 'Research started' : 'Task created', 'ok'); if (r.go) location.hash = r.go; } catch (e) { toast(e.message, 'err'); } };
    return h('div', { class: 'card verdict' },
      h('div', { class: 'stack', style: { gap: '6px', marginBottom: '8px' } }, (c.seats || []).map(s => h('div', { class: 'sub' }, h('b', null, s.name), ` · ${s.stance} · ${s.fellBack || s.label || 'no answer'}: `, (s.summary || 'Could not answer.') + (s.cut ? ' (cut short)' : '')))),
      h('b', null, c.title || 'Verdict'), c.agreeLine && c.rankLine ? h('div', { class: 'sub' }, c.rankLine) : null, h('p', null, c.decision),
      c.reasons?.length ? h('ul', { class: 'sub', style: { margin: '4px 0', paddingLeft: '18px' } }, c.reasons.map(r => h('li', null, r))) : null,
      ...planBits({ agree: c.agree, differ: c.differ, steps: c.steps }, c.runId, ui),
      (c.notes || []).map(n => h('div', { class: 'sub', style: { borderLeft: '3px solid var(--warn)', paddingLeft: '8px', margin: '4px 0' } }, n)),
      h('div', { class: 'sub' }, 'Written by ' + c.label),
      h('div', { class: 'row', style: { marginTop: '8px' } }, c.steps?.length ? null : btn('Turn into a task', { kind: 'ghost sm', onClick: act('task') }), c.steps?.length ? null : btn('Research this', { kind: 'ghost sm', onClick: act('research') }), btn('Open the Council', { kind: 'ghost sm', onClick: () => { location.hash = '#/research/council/' + c.roomId; } })));
  },
};
