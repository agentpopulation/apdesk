// Scorecard page, the agent tab and the Settings section. Everything on it is counted from the desk's own records; a figure the
// records cannot give says "not known", and a count another door cannot offer yet says "not available yet".
const API = 'm/scorecard/';

const CSS = `
.view.scv{display:flex;flex-direction:column;min-height:0;height:100%;padding:0}
.scv .sc-top{padding:14px 18px 10px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.scv .sc-top h2{margin:0;font-size:18px}
.scv .sc-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 28px;display:flex;flex-direction:column;gap:12px}
.scv .sc-sortsel{display:none}
.scv .sc-note{margin:0;font-size:13px;color:var(--dim);overflow-wrap:anywhere}
.scv .sc-sug{display:flex;gap:10px 14px;align-items:center;flex-wrap:wrap}
.scv .sc-sug p{margin:0;flex:1 1 320px;min-width:0;font-size:14px;overflow-wrap:anywhere}
.scv .sc-sug .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.scv h3{margin:6px 0 0;font-size:15px}
.scv .sc-wrap{overflow-x:auto}
.scv table{width:100%}
.scv th,.scv td{padding:8px 10px;vertical-align:top}
.scv thead .sc-grp th{text-transform:none;letter-spacing:0;font-size:12px;font-weight:500;color:var(--dim);border-bottom:0;padding-bottom:0}
.scv thead .sc-grp th.sc-gl{border-bottom:1px solid var(--line-strong);text-align:left}
.scv th button{color:inherit;font:inherit;text-transform:inherit;letter-spacing:inherit;font-weight:700;padding:0;display:inline-flex;align-items:center;gap:4px;text-align:left;cursor:pointer}
.scv th button:hover{color:var(--fg)}
.scv th[aria-sort] button{color:var(--fg)}
.scv th .sc-arrow{width:10px;height:10px;display:inline-block}
.scv .sc-agent{display:flex;gap:2px 8px;align-items:center;flex-wrap:wrap;min-width:150px}
.scv .sc-agent .sc-sub{flex-basis:100%}
.scv .sc-agent a,.scv .sc-agent .sc-name{font-weight:600;color:var(--fg);text-decoration:none;cursor:pointer;background:none;padding:0;text-align:left}
.scv .sc-agent a:hover{text-decoration:underline}
.scv .sc-sub{display:block;font-size:12.5px;color:var(--dim);font-weight:400;overflow-wrap:anywhere}
.scv .sc-nk{color:var(--faint);font-size:12.5px}
.scv .sc-trend{display:inline-flex;align-items:center;gap:3px;color:var(--dim);font-size:12px}
.scv .sc-trend svg{width:14px;height:14px}
.scv td.sc-idle{color:var(--dim);font-size:13.5px}
.scv tr.sc-models td{border-bottom:1px solid var(--line);padding-top:0}
.scv tbody.sc-hasmodels tr.sc-main td{padding-bottom:3px}
.scv .sc-ml{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;font-size:12.5px;color:var(--dim)}
.scv .sc-ml ul{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:2px 14px}
@media (max-width:1400px){.scv th,.scv td{padding-left:6px;padding-right:6px}.scv .sc-nk{font-size:12px}}
.scv tr.sc-models li{overflow-wrap:anywhere}
.scv tbody.sc-agentrow:last-child tr.sc-models td{border-bottom:0}
.scv tbody.sc-agentrow tr.sc-main td{border-bottom:0}
.scv .sc-bars{display:flex;gap:8px;align-items:flex-end;height:132px;padding-top:4px}
.scv .sc-bar{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px}
.scv .sc-bar i{display:block;width:100%;max-width:46px;background:var(--brand);border-radius:6px 6px 2px 2px;min-height:2px}
.scv .sc-bar i.sc-none{background:var(--line-strong)}
.scv .sc-bar .v{font-size:12px;font-variant-numeric:tabular-nums}
.scv .sc-bar .d{font-size:11px;color:var(--faint);white-space:nowrap}
.scv .sc-back{align-self:flex-start}
.scv .sc-set{display:flex;flex-direction:column;gap:12px;max-width:640px}
@media (max-width:820px){
  .scv .sc-sortsel{display:inline-flex;gap:6px;align-items:center}
  .scv table,.scv tbody,.scv .sc-wrap{display:block;overflow:visible}
  .scv thead{display:none}
  .scv tbody.sc-agentrow{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);margin-bottom:10px;overflow:hidden}
  .scv tr.sc-main{display:grid;grid-template-columns:1fr 1fr;gap:2px 14px;padding:10px 12px 4px}
  .scv tr.sc-main td{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:3px 0;border:0}
  .scv tr.sc-main td::before{content:attr(data-label);color:var(--dim);font-size:12.5px}
  .scv tr.sc-main td.sc-first{grid-column:1/-1;display:block;padding-bottom:6px}
  .scv tr.sc-main td.sc-first::before{content:none}
  .scv tr.sc-main td.sc-idle{grid-column:1/-1;display:block}
  .scv tr.sc-main td.sc-idle::before{content:none}
  .scv tr.sc-main td.sc-costcell{grid-column:1/-1}
  .scv tr.sc-main td.sc-wide{grid-column:1/-1}
  .scv tr.sc-models{display:block;padding:0 12px 10px}
  .scv tr.sc-models td{display:block;padding:4px 0 0;border:0}
  .scv .sc-bars{gap:5px}
  .scv .sc-bar .d{font-size:10.5px}
}
@media (max-width:600px){.scv .sc-top,.scv .sc-body{padding-left:16px;padding-right:16px}}
`;
const css = (h) => { if (!document.getElementById('scv-css')) document.head.append(h('style', { id: 'scv-css' }, CSS)); };

const SVG = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = { up: SVG('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'), down: SVG('<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>'), same: SVG('<path d="M3 6h10M3 10h10"/>') };
const ARROW = { up: SVG('<path d="M3 10l5-5 5 5"/>'), down: SVG('<path d="M3 6l5 5 5-5"/>') };

const secs = (ms) => ms == null ? null : ms >= 60000 ? (ms / 60000).toFixed(1) + ' min' : (ms / 1000).toFixed(1) + ' s';
/** What a week's cost cell may say, and only one thing: a sum (every call's cost known), a sum and how many calls are left out, or not known. */
export function costState(c) {
  const known = c.calls - c.unknownCalls;
  if (!c.calls) return { kind: 'sum', unknown: 0 };
  if (!known) return { kind: 'unknown', unknown: c.unknownCalls };
  return { kind: c.unknownCalls ? 'partial' : 'sum', unknown: c.unknownCalls };
}
const short = (label) => String(label || '').split(' to ')[0];

/** What one week's figures look like in a cell. `av` says which counts the desk can give at all. */
export function cellsFor(ui, cell, av, currency) {
  const { h, fmt, plural } = ui;
  const nk = (words = 'not known') => h('span', { class: 'sc-nk' }, words);
  const na = () => nk('not available yet');
  const r = cell.ratings; const ap = cell.approvals;
  const cost = () => {
    const c = cell.cost; const st = costState(c);
    if (st.kind === 'unknown') return nk();
    return h('span', null, fmt.money(c.minor, currency), st.kind === 'partial' ? h('span', { class: 'sc-sub' }, `plus ${plural(st.unknown, 'call')} of unknown cost`) : null);
  };
  return {
    replies: av.replies ? h('span', null, String(cell.replies), cell.failedReplies ? h('span', { class: 'sc-sub' }, `${plural(cell.failedReplies, 'answer')} failed`) : null) : na(),
    done: String(cell.jobs.done), failed: String(cell.jobs.failed), stopped: String(cell.jobs.stopped),
    asked: ap ? String(ap.asked) : na(), refused: ap ? String(ap.refused) : na(),
    good: r ? String(r.good) : na(), poor: r ? String(r.poor) : na(), share: r ? (r.share == null ? nk('none rated') : fmt.pct(r.share)) : na(),
    time: cell.timeMs == null ? nk() : secs(cell.timeMs), cost: cost(),
  };
}
function modelsList(ui, cell, av) {
  const { h, fmt, plural } = ui;
  if (!cell.models.length) return cell.replies && av.replies ? h('span', { class: 'sc-nk' }, 'Which model answered is not known.') : null;
  return h('div', { class: 'sc-ml' }, h('span', null, 'Models used'), h('ul', null, cell.models.map(m => h('li', null,
    `${m.label}${m.share != null ? ' ' + fmt.pct(m.share) : ''}`,
    m.failed ? `, ${plural(m.failed, 'call')} failed` : '', m.skipped ? `, skipped ${plural(m.skipped, 'time')}` : ''))));
}
function trendMark(ui, t) {
  if (!t) return null;
  const words = t.dir === 'up' ? `More work than last week: ${t.now} against ${t.before}.` : t.dir === 'down' ? `Less work than last week: ${t.now} against ${t.before}.` : `The same work as last week: ${t.now}.`;
  return ui.h('span', { class: 'sc-trend', title: words, 'aria-label': words, role: 'img', html: ICON[t.dir] });
}

// ---------- the suggestions and the last switch
function suggestionCard(ui, s, reload) {
  const { h, card, btn, api, savedMark } = ui; const mark = savedMark();
  const body = h('div', { class: 'sc-sug' });
  const ask = () => {
    let r = null;
    const go = btn('Switch', { onClick: async () => { go.disabled = true; box.dataset.acting = '1'; const ok = await mark.run(async () => { r = await api(API + 'switch', { method: 'POST', body: { agentId: s.agentId, provider: s.to.provider, model: s.to.model } }); }, { word: 'Saved' }); if (ok) done(r); else go.disabled = false; } });
    body.replaceChildren(h('p', null, s.text), h('div', { class: 'row' }, go, mark));
  };
  const done = (r) => {
    const undo = btn('Undo', { kind: 'ghost', onClick: async () => { undo.disabled = true; const ok = await mark.run(async () => { await api(API + 'undo', { method: 'POST', body: { agentId: s.agentId } }); }, { word: 'Saved' }); if (ok) { body.replaceChildren(h('p', null, `${r.agentName} is back on ${r.fromLabel || 'the desk default'}.`), h('div', { class: 'row' }, mark)); } else undo.disabled = false; } });
    body.replaceChildren(h('p', null, `${r.agentName} now uses ${r.toLabel}. It was ${r.fromLabel || 'the desk default'}.`), h('div', { class: 'row' }, undo, mark));
  };
  const box = card({ class: 'sc-card', 'data-sug': s.agentId }, body);
  ask();
  return box;
}
function switchCard(ui, s) {
  const { h, card, btn, api, savedMark, fmt } = ui; const mark = savedMark(); const body = h('div', { class: 'sc-sug' });
  const undo = btn('Undo', { kind: 'ghost', onClick: async () => { undo.disabled = true; const ok = await mark.run(async () => { await api(API + 'undo', { method: 'POST', body: { agentId: s.agentId } }); }, { word: 'Saved' }); if (ok) body.replaceChildren(h('p', null, `${s.agentName} is back on ${s.fromLabel || 'the desk default'}.`), h('div', { class: 'row' }, mark)); else undo.disabled = false; } });
  body.append(h('p', null, `${s.agentName} was switched to ${s.toLabel} on ${fmt.date(s.at)}. It was ${s.fromLabel || 'the desk default'}.`), h('div', { class: 'row' }, undo, mark));
  const box = card({ class: 'sc-card', 'data-switched': s.agentId }, body);
  undo.addEventListener('click', () => { box.dataset.acting = '1'; });
  return box;
}
function notices(ui, rep) {
  const { h, empty } = ui; const out = [];
  if (!rep.suggestionsOn) out.push(h('p', { class: 'sc-note' }, 'Model suggestions are switched off in Settings, Scorecard.'));
  else if (!rep.available.ratings) out.push(h('p', { class: 'sc-note' }, 'Ratings are not available yet, so no model can be suggested.'));
  else {
    for (const n of rep.needs || []) out.push(h('p', { class: 'sc-note' }, `${n.name} has ${n.rated} rated ${n.rated === 1 ? 'reply' : 'replies'} on its model in two weeks. The desk needs ${n.more} more before it can suggest a model. Rate answers with the thumbs under a reply.`));
    for (const x of rep.heldBack || []) { const a = (rep.rows || []).find(r => r.agent.id === x.agentId)?.agent; out.push(h('p', { class: 'sc-note' }, `A paid model did better for ${a ? who(ui, a) : 'this agent'}, but paid models are switched off, so none is suggested.`)); }
  }
  if (!rep.available.approvals) out.push(h('p', { class: 'sc-note' }, 'Approvals asked and refused are not available yet: the approval records are not open to modules.'));
  return out;
}

// ---------- the page
/** An agent is named by the Agents module's one rule, through the shell; the stored name only when the shell has none. */
const who = (ui, a) => (a && a.id && typeof ui.agentLine === 'function' ? ui.agentLine(a.id) : a?.name) || 'This agent';
const COLS = [
  { k: 'agent', label: 'Agent', group: null, val: (r) => String(r.agent.name || '').toLowerCase(), text: true },
  { k: 'replies', label: 'Replies', group: null, gl: 'Replies', val: (r, c) => c.replies },
  { k: 'done', label: 'Done', group: 'Jobs', gl: 'Jobs done', val: (r, c) => c.jobs.done },
  { k: 'failed', label: 'Failed', group: 'Jobs', gl: 'Jobs failed', val: (r, c) => c.jobs.failed },
  { k: 'stopped', label: 'Stopped', group: 'Jobs', gl: 'Jobs stopped', val: (r, c) => c.jobs.stopped },
  { k: 'asked', label: 'Asked', group: 'Approvals', gl: 'Approvals asked', val: (r, c) => c.approvals?.asked ?? null },
  { k: 'refused', label: 'Refused', group: 'Approvals', gl: 'Approvals refused', val: (r, c) => c.approvals?.refused ?? null },
  { k: 'good', label: 'Good', group: 'Your ratings', gl: 'Rated good', val: (r, c) => c.ratings?.good ?? null },
  { k: 'poor', label: 'Poor', group: 'Your ratings', gl: 'Rated poor', val: (r, c) => c.ratings?.poor ?? null },
  { k: 'share', label: 'Share good', group: 'Your ratings', gl: 'Share good', val: (r, c) => c.ratings?.share ?? null },
  { k: 'time', label: 'Time to answer', group: null, gl: 'Time to answer', val: (r, c) => c.timeMs },
  { k: 'cost', label: 'Cost', group: null, gl: 'Cost', val: (r, c) => costState(c.cost).kind === 'unknown' ? null : c.cost.minor },
];

async function renderPage(el, ui, route) {
  const { h, api, btn, card, empty, seg, toast, announce } = ui;
  css(h); el.classList.add('scv');
  const agentId = route?.parts?.[0];
  if (agentId) {
    const agent = ui.agent(agentId);
    const body = h('div', { class: 'sc-body' });
    el.replaceChildren(h('div', { class: 'sc-top' }, btn('Back to all agents', { kind: 'ghost sm', onClick: () => ui.go('scorecard') }), h('h2', null, agent ? who(ui, agent) : 'Agent')), body);
    await renderAgent(body, ui, agent || { id: agentId, name: 'This agent' });
    return;
  }
  let rep = null; let week = 0; let sort = { k: 'work', dir: -1 };
  const dates = h('span', { class: 'sub', 'aria-live': 'polite' });
  const weekSeg = seg(['This week', 'Last week'], 0, (_, i) => { week = i; paint(); });
  const save = btn('Save this week as a file', { kind: 'ghost sm', id: 'sc-save', onClick: async () => {
    save.disabled = true; const end = announce('Saving the scorecard file'); const was = save.textContent; save.textContent = 'Saving…';
    try {
      const r = await api(API + 'save', { method: 'POST', body: { week } });
      toast(h('span', null, `Saved ${r.name} in the workspace, in reports. `, btn('Show in Files', { kind: 'ghost sm', onClick: () => ui.openFile(r.path) })), 'ok');
    } catch (e) { toast(e.message, 'err'); } finally { end(); save.disabled = false; save.textContent = was; }
  } });
  const sortSel = h('label', { class: 'sc-sortsel' }, 'Sort by', h('select', { 'aria-label': 'Sort by', onchange: (e) => { sort = { k: e.target.value, dir: e.target.value === 'agent' ? 1 : -1 }; paint(); } },
    [{ k: 'work', gl: 'Most work' }, ...COLS].map(c => h('option', { value: c.k }, c.gl || c.label))));
  const body = h('div', { class: 'sc-body' });
  el.replaceChildren(h('div', { class: 'sc-top' }, h('h2', null, 'Scorecard'), dates, h('span', { class: 'grow' }), weekSeg, sortSel, save), body);

  const paint = () => {
    if (!rep) return;
    const w = rep.weeks[week]; dates.textContent = w.label;
    save.textContent = week === 0 ? 'Save this week as a file' : 'Save last week as a file';
    const av = rep.available;
    const rows = rep.rows.map(r => ({ r, c: week === 0 ? r.this : r.last }));
    const work = (x) => x.c.work;
    const col = COLS.find(c => c.k === sort.k);
    const key = (x) => sort.k === 'work' ? work(x) : col.val(x.r, x.c);
    const cmp = (a, b) => { const x = key(a), y = key(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir || a.r.agent.name.localeCompare(b.r.agent.name); };
    rows.sort(cmp);
    sortSel.querySelector('select').value = sort.k;
    const none = rows.every(x => !x.c.any);
    const nodes = [];
    for (const s of rep.suggestions) nodes.push(suggestionCard(ui, s));
    for (const s of rep.switches) nodes.push(switchCard(ui, s));
    nodes.push(...notices(ui, rep));
    if (none) nodes.push(card(empty(week === 0 ? `Nothing counted for ${w.label} yet. The scorecard fills as your agents answer and run jobs. Ask an agent something in Chat, then come back.` : `Nothing was counted for ${w.label}.`), week === 0 ? h('div', { style: { display: 'flex', justifyContent: 'center' } }, btn('Open Chat', { kind: 'ghost sm', onClick: () => ui.go('chat') })) : null));
    nodes.push(table(rows, w, av));
    body.replaceChildren(...nodes);
  };
  const table = (rows, w, av) => {
    const th = (c) => h('th', { scope: 'col', 'aria-sort': sort.k === c.k ? (sort.dir > 0 ? 'ascending' : 'descending') : null },
      h('button', { type: 'button', title: `Sort by ${String(c.gl || c.label).toLowerCase()}`, onclick: () => { sort = { k: c.k, dir: sort.k === c.k ? -sort.dir : (c.k === 'agent' ? 1 : -1) }; paint(); } },
        c.label, sort.k === c.k ? h('span', { class: 'sc-arrow', html: sort.dir > 0 ? ARROW.up : ARROW.down }) : null));
    const groups = []; for (const c of COLS) { const last = groups.at(-1); if (c.group && last && last.group === c.group) last.n++; else groups.push({ group: c.group, n: 1 }); }
    const head = h('thead', null,
      h('tr', { class: 'sc-grp' }, groups.map(g => h('th', { colspan: g.n, class: g.group ? 'sc-gl' : '' }, g.group || ''))),
      h('tr', null, COLS.map(th)));
    const bodies = rows.map(({ r, c }) => {
      const f = cellsFor(ui, c, av, rep.currency);
      const first = h('td', { class: 'sc-first', 'data-label': 'Agent' }, h('div', { class: 'sc-agent' },
        h('a', { href: '#/scorecard/' + encodeURIComponent(r.agent.id), title: `${who(ui, r.agent)}: the last eight weeks` }, who(ui, r.agent)), week === 0 ? trendMark(ui, r.trend) : null,
        h('span', { class: 'sc-sub' }, r.agent.model ? 'Set to ' + r.agent.model : 'Uses the desk default')));
      const main = c.any
        ? h('tr', { class: 'sc-main' }, first, COLS.slice(1).filter(k => av.approvals || k.k !== 'refused').map(k => h('td', k.k === 'asked' && !av.approvals ? { 'data-label': 'Approvals', colspan: 2, class: 'sc-wide' } : { 'data-label': k.gl, class: k.k === 'cost' ? 'sc-costcell' : '' }, f[k.k])))
        : h('tr', { class: 'sc-main' }, first, h('td', { colspan: COLS.length - 1, class: 'sc-idle' }, week === 0 ? 'No work this week.' : 'No work last week.'));
      const ml = c.any ? modelsList(ui, c, av) : null;
      return h('tbody', { class: 'sc-agentrow' + (ml ? ' sc-hasmodels' : ''), 'data-agent': r.agent.id }, main, ml ? h('tr', { class: 'sc-models' }, h('td', { colspan: COLS.length }, ml)) : null);
    });
    return h('div', { class: 'sc-wrap' }, h('table', null, head, bodies));
  };

  const load = async () => { try { rep = await api(API + 'report'); paint(); } catch (e) { body.replaceChildren(empty('The scorecard could not be read just now. Open the page again in a moment.')); console.error(e); } };
  ui.on('agents', () => { if (!body.querySelector('[data-acting]')) load(); });   // a switch made from a card here keeps its card, with the tick and Undo
  await load();
}

// ---------- one agent over eight weeks (the agent tab, and the page when you pick an agent)
async function renderAgent(el, ui, agent) {
  const { h, api, card, empty, fmt, plural } = ui; css(h);
  let hist;
  try { hist = await api(API + 'agent/' + encodeURIComponent(agent.id)); }
  catch (e) { el.replaceChildren(empty('The scorecard could not be read just now.')); console.error(e); return; }
  const av = hist.available; const cur = hist.currency;
  const nodes = [];
  for (const s of hist.suggestions) nodes.push(suggestionCard(ui, s));
  for (const s of hist.switches) nodes.push(switchCard(ui, s));
  nodes.push(...notices(ui, { ...hist, rows: [{ agent: hist.agent }], heldBack: [] }));
  const cells = hist.cells; const any = cells.some(c => c.any);
  if (!any) { el.replaceChildren(...nodes, card(empty(`${who(ui, agent)} has no work in the last eight weeks yet. The record fills as it answers and runs jobs.`))); return; }
  const oldestFirst = hist.weeks.map((w, i) => ({ w, c: cells[i] })).reverse();
  const maxWork = Math.max(1, ...cells.map(c => c.work));
  const bars = (title, items) => card({ class: 'sc-card' }, h('h3', null, title), h('div', { class: 'sc-bars', role: 'list' }, items.map(it => h('div', { class: 'sc-bar', role: 'listitem', title: it.title },
    h('span', { class: 'v' }, it.value), h('i', { class: it.empty ? 'sc-none' : '', style: { height: Math.max(2, Math.round(it.frac * 96)) + '%' } }), h('span', { class: 'd' }, it.day)))));
  nodes.push(bars('Work done each week: replies and jobs done', oldestFirst.map(({ w, c }) => ({ value: String(c.work), frac: c.work / maxWork, empty: !c.work, day: short(w.label), title: `${w.label}: ${plural(c.replies, 'reply', 'replies')}, ${plural(c.jobs.done, 'job')} done` }))));
  if (av.ratings) nodes.push(bars('Share of your ratings that were good', oldestFirst.map(({ w, c }) => {
    const s = c.ratings?.share; return { value: s == null ? 'none' : fmt.pct(s), frac: s ?? 0, empty: s == null, day: short(w.label), title: `${w.label}: ${c.ratings?.good ?? 0} good, ${c.ratings?.poor ?? 0} poor` };
  })));
  const rows = hist.weeks.map((w, i) => ({ w, c: cells[i] }));
  const cols = [['Week', 'Week'], ['Replies', 'Replies'], ['Done', 'Jobs done'], ['Failed', 'Jobs failed'], ['Stopped', 'Jobs stopped'], ['Good', 'Rated good'], ['Poor', 'Rated poor'], ['Share good', 'Share good'], ['Time to answer', 'Time to answer'], ['Cost', 'Cost'], ['Models', 'Models']];
  const tbl = h('div', { class: 'sc-wrap' }, h('table', null,
    h('thead', null, h('tr', null, cols.map(c => h('th', { scope: 'col' }, c[0])))),
    rows.map(({ w, c }) => {
      const f = cellsFor(ui, c, av, cur);
      const first = h('td', { class: 'sc-first', 'data-label': 'Week' }, w.index === 0 ? `${w.label} (this week)` : w.label);
      const main = c.any ? h('tr', { class: 'sc-main' }, first, ['replies', 'done', 'failed', 'stopped', 'good', 'poor', 'share', 'time', 'cost'].map((k, i) => h('td', { 'data-label': cols[i + 1][1], class: k === 'cost' ? 'sc-costcell' : '' }, f[k])))
        : h('tr', { class: 'sc-main' }, first, h('td', { colspan: cols.length - 1, class: 'sc-idle' }, 'No work.'));
      const ml = c.any ? modelsList(ui, c, av) : null;
      return h('tbody', { class: 'sc-agentrow' + (ml ? ' sc-hasmodels' : '') }, main, ml ? h('tr', { class: 'sc-models' }, h('td', { colspan: cols.length }, ml)) : null);
    })));
  nodes.push(h('h3', null, 'Week by week'), tbl);
  el.replaceChildren(...nodes);
}

export const pages = { scorecard: { title: 'Scorecard', render: renderPage, unmount() {} } };

export const agentTabs = {
  scorecard: { title: 'Scorecard', async render(el, ui, agent) {
    css(ui.h);
    const wrap = ui.h('div', { class: 'scv', style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
    el.append(wrap);
    const note = ui.h('p', { class: 'sub' }, `${who(ui, agent)}'s last eight weeks, counted from the desk's own records. No model is used for this.`);
    wrap.append(note);
    const inner = ui.h('div', { class: 'sc-body', style: { overflow: 'visible', padding: '0' } }); wrap.append(inner);
    await renderAgent(inner, ui, agent);
  } },
};

// ---------- Settings
export const settings = {
  scorecard: { title: 'Scorecard', async render(el, ui) {
    const { h, api, card, sw, savedMark } = ui; css(h);
    let cur; try { cur = await api(API + 'settings'); } catch (e) { el.append(ui.empty('The Scorecard settings could not be read just now.')); return; }
    const weekMark = savedMark(), sugMark = savedMark();
    const sel = h('select', { id: 'sc-week', 'aria-label': 'Week starts on' }, [['auto', 'Automatic, from your region'], ['mon', 'Monday'], ['sun', 'Sunday'], ['sat', 'Saturday']].map(([v, t]) => h('option', { value: v }, t)));
    sel.value = cur.weekStart;
    sel.addEventListener('change', () => { const old = cur.weekStart; weekMark.run(async () => { cur = await api(API + 'settings', { method: 'POST', body: { weekStart: sel.value } }); }, { field: sel, old }); });
    const sug = sw(cur.suggestions, 'Suggest a better model', async (on) => { sugMark.saving(); try { cur = await api(API + 'settings', { method: 'POST', body: { suggestions: on } }); sugMark.ok(); } catch (e) { sugMark.fail(e.message); return false; } });
    el.append(card(h('div', { class: 'sc-set' },
      h('p', { class: 'sub' }, 'The Scorecard counts what your desk already recorded. It uses no model and changes nothing by itself. Weeks are in the time zone set in Settings, General.'),
      ui.line('Week starts on', 'Weeks run from this day to the day before it, a week later.', sel, weekMark),
      ui.line('Suggest a better model', 'When an agent keeps scoring low on one model, the Scorecard says so and offers a switch. You decide every time.', sug, sugMark))));
  } },
};
