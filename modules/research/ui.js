// The Research page: Deep research, Council and Swarm, as in the owner's preview.
const STATUS = { running: ['Working', 'run'], waiting: ['Waiting for you', 'wait'], done: ['Ready', 'ok'], failed: ['Failed', 'stop'], stopped: ['Stopped', 'stop'], interrupted: ['Interrupted', 'stop'] };
let cleanup = [];

export const pages = {
  research: {
    title: 'Research',
    async render(view, ui, route) {
      const { h } = ui;
      const parts = route?.parts || [];
      const tabIndex = parts[0] === 'council' ? 1 : parts[0] === 'swarm' ? 2 : 0;
      Object.assign(view.style, { height: '100%', minHeight: '0' });
      const body = h('div', { class: 'stack', style: { flex: '1', minHeight: '0' } });
      const statusRow = h('div', { class: 'row', style: { gap: '6px' } });
      const seg = ui.seg(['Deep research', 'Council', 'Swarm'], tabIndex, (o, i) => ui.go('research', ['', 'council', 'swarm'][i]));
      view.replaceChildren(h('div', { class: 'row' }, h('h2', null, 'Research'), seg, h('span', { class: 'grow' }), statusRow), body);
      searchStatus(ui, statusRow).catch(() => {});
      if (tabIndex === 1) return councilTab(ui, body);
      if (tabIndex === 2) return swarmTab(ui, body, parts[1]);
      return deepTab(ui, body, parts[0]);
    },
    unmount() { for (const f of cleanup.splice(0)) { try { f(); } catch {} } },
  },
};

async function searchStatus(ui, el, probe = false) {
  const { h } = ui;
  el.replaceChildren(h('span', { class: 'sub' }, 'Checking search…'));
  const s = await ui.api('m/search/status' + (probe ? '' : '?cached=1'));
  if (s.offline) { el.replaceChildren(h('span', { class: 'sub' }, 'Search:'), h('span', { class: 'pill stop', title: s.note || '' }, 'Offline')); return; }
  // each pill is the provider's last real outcome: works, failing since a time, or not tried yet
  const pill = (p) => p.state === 'works' ? h('span', { class: 'pill ok', title: p.note || '' }, `${p.label}: works`)
    : p.state === 'failing' ? h('span', { class: 'pill stop', title: p.note || '' }, `${p.label}: failing since ${ui.fmt.when(p.since)} (${/bot check/.test(p.note) ? 'bot check' : p.note})`)
    : h('span', { class: 'pill', title: 'No search has used it yet. Press Check now.' }, `${p.label}: not tried yet`);
  const live = (s.providers || []).filter((p) => p.configured);
  const off = (s.providers || []).filter((p) => !p.configured);
  el.replaceChildren(h('span', { class: 'sub' }, 'Search:'), ...live.map(pill),
    off.length ? h('span', { class: 'pill', title: off.map((p) => `${p.label}: ${p.note || 'not set up'}`).join('\n') }, `${off.length} not set up`) : null,
    ui.btn('Check now', { kind: 'ghost sm', onClick: () => searchStatus(ui, el, true).catch((e) => ui.toast(e.message, 'err')) }));
}

// ---------------- Deep research
async function deepTab(ui, body, pickId) {
  const { h } = ui;
  const input = h('input', { type: 'text', placeholder: 'What should I research in depth?', style: { flex: '1', minWidth: '200px' }, 'aria-label': 'Research question' });
  const start = async () => {
    const q = input.value.trim(); if (!q) return input.focus();
    try { const r = await ui.api('m/research/deep', { body: { question: q } }); ui.toast('Deep research started'); ui.go('research', r.reportId); }
    catch (e) { ui.toast(e.message, 'err'); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  const head = h('div', { class: 'row' });
  const reportCard = h('div', { class: 'card report', style: { overflow: 'auto', minHeight: '0', display: 'flex', flexDirection: 'column', gap: '8px' } });
  const srcCard = h('div', { class: 'card', style: { overflow: 'auto', minHeight: '0', flex: '1.4' } });
  const listCard = h('div', { class: 'card', style: { overflow: 'auto', minHeight: '0', flex: '1' } });
  body.replaceChildren(
    h('div', { class: 'card row' }, input, ui.btn('Start research', { onClick: start })),
    head,
    h('div', { class: 'cols', style: { flex: '1', minHeight: '0' } }, reportCard, h('div', { class: 'stack', style: { minHeight: '0' } }, srcCard, listCard)));

  let list = (await ui.api('m/research/reports')).reports;
  let current = pickId || list[0]?.id || null;
  const paintList = () => listCard.replaceChildren(h('h3', { style: { marginBottom: '6px' } }, 'Reports'),
    ...(list.length ? list.map((r) => h('button', { class: 'line hov', style: { width: '100%', textAlign: 'left', background: r.id === current ? 'var(--accent-soft)' : null, borderRadius: '8px', padding: '8px 6px' }, onclick: () => ui.go('research', r.id) },
      h('div', null, h('b', null, r.title || r.question), h('span', { class: 'd' }, `${ui.fmt.when(r.created)} · ${r.status === 'done' && r.counts ? `${ui.plural(r.counts.cited, 'source')}, ${r.counts.passed} of ${ui.plural(r.counts.claims, 'claim')} checked` : r.step || ''}`)),
      ui.pill(...(STATUS[r.status] || ['', ''])))) : [ui.empty('No reports yet. Ask a question above, or in Chat say "Research … in depth".')]));
  paintList();

  async function paint() {
    if (!current) {
      head.replaceChildren(h('h3', null, 'No report open'));
      reportCard.replaceChildren(ui.empty('Start a deep research above. The report shows here with every source beside it.'));
      srcCard.replaceChildren(h('h3', null, 'Sources'), ui.empty('Sources appear here.'));
      return;
    }
    let r; try { r = await ui.api('m/research/reports/' + encodeURIComponent(current)); } catch (e) { reportCard.replaceChildren(ui.empty(ui.plainError(e))); return; }
    const [word, kind] = STATUS[r.status] || ['', ''];
    const meter = ui.meter(r.progress || 0, { live: r.status === 'running' });
    head.replaceChildren(...[h('h3', null, r.title || r.question), ui.pill(word, kind), meter, h('span', { class: 'sub' }, r.step || ''),
      r.status === 'running' && r.jobId ? ui.btn('Stop', { kind: 'ghost sm', onClick: () => ui.api('m/research/stop/' + r.jobId, { method: 'POST' }).catch((e) => ui.toast(e.message, 'err')) }) : null].filter(Boolean));
    if (r.markdown) {
      const md = cite(ui.md(r.markdown.replace(/^# .*\n/, '').replace(/\n## Sources\n[\s\S]*?(?=\n## Left out|\n\*Written by|$)/, '\n')));   // the sources sit in the card beside it
      const files = r.files || {};
      reportCard.replaceChildren(md, h('div', { class: 'row', style: { marginTop: 'auto', paddingTop: '6px' } },
        ui.btn('Open full report', { kind: 'ghost', onClick: () => ui.modal({ title: r.title, wide: true, body: h('div', { class: 'report', style: { maxHeight: '70vh', overflow: 'auto' } }, cite(ui.md(r.markdown.replace(/^# .*\n/, '')))), actions: [{ label: 'Close' }] }) }),
        ...[['pdf', 'PDF'], ['docx', 'Word'], ['md', 'Markdown']].map(([f, label]) => ui.btn(label, { kind: 'ghost', disabled: !files[f], title: files[f] ? `Workspace › ${files[f]}` : 'Not made', onClick: () => download(ui, r.id, f) })),
        h('span', { class: 'grow' }), r.labels?.length ? h('span', { class: 'sub' }, 'Models: ' + r.labels.join(', ')) : null));
    } else {
      reportCard.replaceChildren(r.status === 'running' ? h('div', { class: 'row' }, ui.spinner(), h('span', { class: 'sub' }, 'The report shows here as soon as it is written. You can close this window; the work goes on.')) : h('div', { class: 'stack' }, h('b', null, r.status === 'stopped' ? 'This research was stopped.' : 'This research did not finish.'), r.error && r.status !== 'stopped' ? h('p', { class: 'sub', style: { whiteSpace: 'pre-wrap' } }, r.error) : null,
        h('div', { class: 'row' }, ui.btn('Try again', { onClick: async () => { try { const x = await ui.api('m/research/deep', { body: { question: r.question } }); ui.go('research', x.reportId); } catch (e) { ui.toast(e.message, 'err'); } } }))));
    }
    srcCard.replaceChildren(h('div', { class: 'row', style: { marginBottom: '4px' } }, h('h3', null, 'Sources'), r.counts ? h('span', { class: 'sub' }, `${r.counts.cited} cited · ${r.counts.read} read`) : null),
      ...(r.sources?.length ? r.sources.map((s) => h('div', { class: 'line' }, h('div', null, h('b', null, `${s.n} · ${s.title}`), h('span', { class: 'd' }, `${s.host}${s.kind === 'pdf' ? ' · PDF' : ''} · read in full`),
          ...(s.quotes || []).map((q) => h('span', { class: 'd', style: { fontStyle: 'italic', marginTop: '3px' }, title: q.claim ? 'Supports: ' + q.claim : '' }, `“${typeof q === 'string' ? q : q.quote}”`))),
        h('a', { class: 'btn ghost sm', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open'))) : [ui.empty(r.status === 'running' ? 'Sources show when the report is written.' : 'No sources.')]),
      ...[r.uncited?.length ? h('details', { style: { marginTop: '8px' } }, h('summary', { class: 'sub' }, `Also read, not cited (${r.uncited.length})`), ...r.uncited.map((u) => h('div', { class: 'line' }, h('div', null, h('span', { class: 'd' }, u.title)), h('a', { class: 'btn ghost sm', href: u.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open')))) : null].filter(Boolean));
  }
  await paint();
  let pending = null;
  const off = ui.on('research', (e) => {
    if (e?.kind !== 'report') return;
    const i = list.findIndex((x) => x.id === e.id);
    if (i >= 0) Object.assign(list[i], { status: e.status, step: e.step, progress: e.progress, title: e.title }); else ui.api('m/research/reports').then((x) => { list = x.reports; paintList(); }).catch(() => {});
    if (e.id === current && !pending) pending = setTimeout(() => { pending = null; paint().then(() => { if (e.status !== 'running') ui.api('m/research/reports').then((x) => { list = x.reports; paintList(); }).catch(() => {}); }); }, 600);
    else paintList();
  });
  cleanup.push(off, () => clearTimeout(pending));
}
/** [3] -> <sup>3</sup>, digits only, after the kit has escaped everything. */
function cite(el) { el.innerHTML = el.innerHTML.replace(/\[(\d{1,3})\]/g, '<sup>$1</sup>'); return el; }
async function download(ui, id, fmt) {
  try {
    const r = await ui.api(`/api/m/research/reports/${encodeURIComponent(id)}/file/${fmt}`, { raw: true });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not get the file.');
    const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `report.${fmt}`;
    const url = URL.createObjectURL(await r.blob()); const a = ui.h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) { ui.toast(e.message, 'err'); }
}

// ---------------- Council
async function councilTab(ui, body) {
  const el = ui.h('div', { class: 'stack', style: { flex: '1', minHeight: '0' } });
  body.replaceChildren(el);
  if (!ui.moduleOn('council')) { el.replaceChildren(ui.h('div', { class: 'offnote' }, ui.h('b', null, 'The Council is switched off.'), ui.h('span', { class: 'sub' }, 'Switch it on in Settings › Modules to let three seats argue a question and give one verdict.'))); return; }
  try {
    const panel = (await ui.moduleUi('council'))?.pages?.council;
    if (!panel?.render) throw new Error('it has no panel yet');
    await panel.render(el, ui);
    if (panel.unmount) cleanup.push(() => panel.unmount());
  } catch (e) { el.replaceChildren(ui.h('div', { class: 'offnote' }, ui.h('b', null, 'The Council could not open its panel.'), ui.h('span', { class: 'sub' }, ui.plainError(e)))); }
}

// ---------------- Swarm
async function swarmTab(ui, body, pickId) {
  const { h } = ui;
  let n = 12;
  try { n = Number(localStorage.getItem('apd-swarm-n')) || 12; } catch {}
  const label = h('b');
  const task = h('input', { type: 'text', placeholder: 'What should the swarm do? For example: compare ten CRM tools for a small team', style: { flex: '1', minWidth: '220px' }, 'aria-label': 'Swarm job' });
  const range = h('input', { type: 'range', min: '1', max: '50', value: String(n), 'aria-label': 'Number of agents' });
  const grid = h('div', { class: 'swg' });
  const head = h('div', { class: 'row' });
  const answer = h('div', { class: 'stack' });
  const setLabel = () => { label.textContent = ui.plural(n, 'agent'); };
  const each = h('div', { class: 'sub' }, 'Each takes one part of the job');
  ui.api('m/research/swarm-size').then((r) => { if (Number(r?.atOnce) > 0) each.textContent = `Each takes one part of the job; up to ${r.atOnce} work at once, the rest wait their turn`; }).catch(() => {});
  const placeholders = () => grid.replaceChildren(...Array.from({ length: n }, (_, i) => h('div', { class: 'tile' }, h('b', null, `Scout ${i + 1}`), 'Ready for its part', h('div', { class: 'meter', style: { marginTop: '6px' } }, h('b', { style: { width: '0%' } })))));
  let showing = null;
  range.addEventListener('input', () => { n = Number(range.value); setLabel(); try { localStorage.setItem('apd-swarm-n', String(n)); } catch {} if (!showing || showing.status !== 'running') { showing = null; head.replaceChildren(); answer.replaceChildren(); placeholders(); } });
  const start = async () => {
    const t = task.value.trim(); if (!t) return task.focus();
    try { const r = await ui.api('m/research/swarm', { body: { task: t, agents: n } }); ui.toast(`Swarm of ${n} started`); ui.go('research', 'swarm', r.swarmId); }
    catch (e) { ui.toast(e.message, 'err'); }
  };
  task.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  setLabel();
  body.replaceChildren(
    h('div', { class: 'card row' }, h('div', { style: { minWidth: '170px' } }, label, each), task, range, ui.btn('Start swarm', { onClick: start })),
    head, h('div', { style: { overflow: 'auto', minHeight: '0', flex: '1', display: 'flex', flexDirection: 'column', gap: '12px' } }, grid, answer));

  const paintTiles = (tiles) => grid.replaceChildren(...tiles.map((t) => h('div', { class: 'tile', title: t.query || '' }, h('b', null, t.agent), t.title,
    h('div', { class: 'sub', style: { fontSize: '11.5px', marginTop: '2px' } }, t.status === 'waiting' ? 'Waiting · ' + (t.detail || '') : t.detail || t.status),
    h('div', { class: 'meter', style: { marginTop: '6px' } }, h('b', { class: t.status === 'running' ? 'live' : '', style: { width: Math.round((t.progress || 0) * 100) + '%', background: t.status === 'failed' || t.status === 'stopped' ? 'var(--stop)' : t.status === 'done' ? 'var(--ok)' : null } })))));
  async function paint(id) {
    let s; try { s = await ui.api('m/research/swarms/' + encodeURIComponent(id)); } catch { return; }
    showing = s;
    const [word, kind] = STATUS[s.status] || ['', ''];
    const done = (s.tiles || []).filter((t) => t.status === 'done').length;
    head.replaceChildren(...[h('h3', null, s.task), ui.pill(word, kind), h('span', { class: 'sub' }, `${done} of ${s.tiles?.length || s.agents} parts done`),
      s.status === 'running' && s.jobId ? ui.btn('Stop', { kind: 'ghost sm', onClick: () => ui.api('m/research/stop/' + s.jobId, { method: 'POST' }).catch((e) => ui.toast(e.message, 'err')) }) : null].filter(Boolean));
    if (s.tiles?.length) paintTiles(s.tiles); else placeholders();
    answer.replaceChildren(...(s.answer ? [h('div', { class: 'cols' },
      h('div', { class: 'card report' }, h('h3', { style: { marginBottom: '6px' } }, 'Merged answer'), cite(ui.md(s.answer)), s.label ? h('p', { class: 'sub' }, 'Merged by ' + s.label) : null),
      h('div', { class: 'card' }, h('h3', { style: { marginBottom: '4px' } }, 'Sources'), ...(s.sources || []).map((x) => h('div', { class: 'line' }, h('div', null, h('b', null, `${x.n} · ${x.title}`), h('span', { class: 'd', style: { wordBreak: 'break-all' } }, x.url)), h('a', { class: 'btn ghost sm', href: x.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open')))))]
      : s.error && s.status !== 'stopped' ? [h('div', { class: 'card stack' }, h('b', null, 'The swarm did not finish.'), h('p', { class: 'sub', style: { whiteSpace: 'pre-wrap' } }, s.error), h('div', { class: 'row' }, ui.btn('Try again', { onClick: async () => { try { const x = await ui.api('m/research/swarm', { body: { task: s.task, agents: s.agents } }); ui.go('research', 'swarm', x.swarmId); } catch (e) { ui.toast(e.message, 'err'); } } })))] : []));
  }
  const latest = pickId || (await ui.api('m/research/swarms')).swarms?.[0]?.id;
  if (latest) await paint(latest); else placeholders();
  let pending = null;
  const off = ui.on('research', (e) => {
    if (e?.kind !== 'swarm' || (showing && e.id !== showing.id && showing.status === 'running')) return;
    if (showing?.id === e.id && e.tiles && !e.done) { paintTiles(e.tiles); return; }
    if (!pending) pending = setTimeout(() => { pending = null; paint(e.id); }, 400);
  });
  cleanup.push(off, () => clearTimeout(pending));
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
