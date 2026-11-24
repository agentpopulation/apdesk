// The agent's Computer tab: the live picture of its browser, the steps in plain words, Take over and Hand back.
const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Delete']);
const MODE_WORDS = { idle: ['Idle', ''], agent: ['Working', 'run'], owner: ['You are driving', 'wait'], needs_owner: ['Waiting for you', 'wait'] };

/** The addresses the agents may open on this PC or the home network. One list for the whole desk, kept by the Browser module. */
export function allowedAddresses(ui) {
  const { h, btn, api, toast } = ui;
  const base = '/api/m/browser';
  const list = h('div', { class: 'stack', style: { gap: '4px' } });
  const mark = ui.savedMark ? ui.savedMark() : null;
  let hosts = [];
  const draw = () => list.replaceChildren(...(hosts.length ? hosts.map(a => h('div', { class: 'row', 'data-allowed': a }, h('span', null, a), h('span', { class: 'grow' }),
    btn('Remove', { kind: 'ghost sm', 'aria-label': 'Stop allowing ' + a, onClick: () => change(a, false) })))
    : [h('div', { class: 'sub' }, 'None yet. Agents cannot open anything on this PC or your home network.')]));
  async function change(host, allow) {
    // the tick shows only after the desk kept the change; a refusal shows its reason beside the box and keeps what was typed
    const run = async () => { const r = await api(base + '/allow-host', { method: 'POST', body: { host, allow } }); hosts = r.allowHosts || []; draw(); };
    if (mark) return mark.run(run, { word: allow ? 'Allowed' : 'Removed' });
    try { await run(); return true; } catch (e) { toast(e, 'err'); return false; }
  }
  const input = h('input', { type: 'text', 'aria-label': 'Address to allow', placeholder: 'For example: printer.local or 192.168.1.20', style: { flex: '1', minWidth: '0' } });
  const add = async () => {
    const v = input.value.trim(); if (!v) return ui.needs ? ui.needs(input, 'Type the address first.') : toast('Type the address first.');
    if (await change(v, true)) input.value = '';
  };
  input.addEventListener?.('keydown', (e) => { if (e.key === 'Enter') add(); });
  const box = h('details', { 'data-apd': 'allowed-addresses', class: 'card' },
    h('summary', { class: 'sub', style: { cursor: 'pointer' } }, 'Pages on your own network'),
    h('p', { class: 'sub' }, 'An agent may open a page on this PC or your home network, such as a printer or a router page, only if you allow its address here. This is for every agent.'),
    list, h('div', { class: 'row' }, input, btn('Allow', { onClick: add }), mark));
  draw();
  api(base + '/info').then((r) => { hosts = r?.allowHosts || []; draw(); }).catch(() => {});
  return box;
}

export function renderComputer(el, ui, agent) {
  const { h, btn, pill, api, toast, fmt } = ui;
  const id = agent?.id || 'operator'; const name = agent ? ui.agentLine(agent).split(' · ')[0] : 'The agent';   // the own name, or the role when it has none
  const base = `/api/m/browser/${encodeURIComponent(id)}`;
  let st = { mode: 'idle', steps: [], open: false }; let frameNo = -1; let alive = true; let objUrl = null; let typed = ''; let typeTimer = null; let wasOpen = null;

  const img = h('img', { alt: `${name}'s browser`, draggable: 'false', hidden: true, style: { width: '100%', height: '100%', objectFit: 'fill', display: 'block', userSelect: 'none' } });
  // The browser starts on demand, so a closed one is the normal state, not a fault: say so, and show its last picture.
  const lastImg = h('img', { alt: `The last page ${name}'s browser showed`, draggable: 'false', hidden: true, style: { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', opacity: '.32', filter: 'saturate(.8)' } });
  const lastCap = h('span', { class: 'sub', style: { fontSize: '12.5px' } }, 'No pages opened yet.');
  const blank = h('div', { class: 'bblank', style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', textAlign: 'center', padding: '20px' } }, lastImg,
    h('div', { style: { position: 'relative', display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center', maxWidth: '440px', padding: '14px 18px', borderRadius: 'var(--r)', background: 'color-mix(in srgb, var(--surface) 86%, transparent)', border: '1px solid var(--line)' } },
      h('span', null, `${name}'s browser starts when it is needed. Give it a task below, or press Take over to drive it yourself.`), lastCap));
  const stage = h('div', { class: 'bstage', tabindex: '0', 'aria-label': `${name}'s browser screen`, style: { position: 'relative', aspectRatio: '16 / 10', width: '100%', maxWidth: 'calc((100vh - 300px) * 1.6)', margin: '0 auto', background: 'var(--bubble)', outline: 'none', overflow: 'hidden' } }, img, blank);
  let lastUrl = null; let lastAt = null;
  async function loadLast() {
    try {
      const r = await api(`${base}/last-shot`, { raw: true });
      const at = r.status === 200 ? r.headers.get('x-taken') : null;
      if (!at) { lastImg.hidden = true; lastCap.textContent = 'No pages opened yet.'; return; }
      if (at === lastAt) return;
      const u = URL.createObjectURL(await r.blob()); if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = u; lastAt = at;
      lastImg.src = u; lastImg.hidden = false; lastCap.textContent = `Last picture from its browser: ${fmt.when(at)}.`;
    } catch {}
  }
  // the address is a read-only field: empty, with a hint, until a page was opened
  const urlBar = h('input', { type: 'text', class: 'url', readonly: true, placeholder: 'No page opened yet', 'aria-label': 'Address', style: { display: 'block', width: '100%', boxSizing: 'border-box', border: '0', borderBottom: '1px solid var(--line)', borderRadius: '0', background: 'transparent', outline: 'none' } });
  const modePill = pill('Idle');
  const framesPill = pill('');
  const offPill = pill('Offline', 'stop'); offPill.hidden = true; offPill.title = 'The desk is offline. Browsing needs the internet.';
  const goalLine = h('div', { class: 'sub', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } });
  const steps = h('ol', { class: 'bsteps', style: { margin: '0', paddingLeft: '22px', overflow: 'auto', flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px' } });
  const result = h('div', { style: { display: 'none' } });

  const post = async (p, body) => { try { return await api(base + p, { method: 'POST', body: body ?? {} }); } catch (e) { toast(e.message, 'err'); return null; } };
  const bTake = btn('Take over', { kind: 'ghost', onClick: async () => { const r = await post('/takeover'); if (r) { st = r; paint(); stage.focus(); } } });
  const bBack = btn('Hand back', { onClick: async () => { await flushTyped(); const r = await post('/handback'); if (r) { st = r; paint(); } } });
  const bStop = btn('Stop', { kind: 'stop', onClick: async () => { const r = await post('/stop'); if (r) { st = r; paint(); } } });
  const bWin = btn('Open the real window', { kind: 'ghost sm', onClick: async () => { const r = await post('/window', { on: !st.headed }); if (r) { st = r; paint(); } } });

  const goal = h('input', { type: 'text', placeholder: 'What should it do? For example: find the opening hours of the city library', style: { flex: '1', minWidth: '0' } });
  const start = h('input', { type: 'text', placeholder: 'First page (optional)', style: { width: '200px' } });
  const bGo = btn('Start', { onClick: async () => { if (!goal.value.trim()) return toast('Say what it should do first.'); const r = await post('/task', { goal: goal.value.trim(), startUrl: start.value.trim() || null }); if (r) { goal.value = ''; toast('Started'); refresh(); } } });

  // ---- owner input on the live picture
  const driving = () => st.mode === 'owner' || st.mode === 'needs_owner';
  stage.addEventListener('click', (e) => {
    if (!driving()) return;
    const r = img.getBoundingClientRect(); if (!r.width) return;
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    showDot(e.clientX - r.left, e.clientY - r.top);
    flushTyped().then(() => post('/input', { type: 'click', fx, fy }));
  });
  stage.addEventListener('wheel', (e) => { if (!driving()) return; e.preventDefault(); post('/input', { type: 'scroll', dy: e.deltaY }); }, { passive: false });
  stage.addEventListener('keydown', (e) => {
    if (!driving() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) { e.preventDefault(); typed += e.key; clearTimeout(typeTimer); typeTimer = setTimeout(flushTyped, 350); return; }
    if (KEYS.has(e.key)) { e.preventDefault(); flushTyped().then(() => post('/input', { type: 'key', key: e.key })); }
  });
  async function flushTyped() { clearTimeout(typeTimer); if (!typed) return; const t = typed; typed = ''; await post('/input', { type: 'type', text: t }); }
  function showDot(x, y) { const d = h('span', { class: 'cursor', style: { left: x - 7 + 'px', top: y - 7 + 'px', animation: 'none', transition: 'opacity .6s' } }); stage.append(d); setTimeout(() => { d.style.opacity = '0'; }, 300); setTimeout(() => d.remove(), 1000); }

  // ---- painting
  function paint() {
    const [w, k] = MODE_WORDS[st.mode] || MODE_WORDS.idle;
    modePill.textContent = w; modePill.className = 'pill ' + k;
    urlBar.value = !st.url || st.url === 'about:blank' ? '' : st.url;
    offPill.hidden = !st.offline;
    framesPill.textContent = st.open ? (st.browser ? `${st.browser}, own profile` : 'Running') : 'Starts when needed';
    goalLine.textContent = st.goal ? 'Task: ' + st.goal : 'No task yet.';
    blank.hidden = !!st.open && frameNo >= 0;
    if (!st.open && wasOpen !== false) loadLast();
    wasOpen = !!st.open;
    bTake.hidden = driving(); bBack.hidden = !driving(); bStop.hidden = !st.open && !st.jobId;
    bWin.hidden = !st.canOpenWindow || !st.open; bWin.textContent = st.headed ? 'Hide the real window' : 'Open the real window';
    stage.style.cursor = driving() ? 'crosshair' : 'default';
    stage.style.boxShadow = driving() ? 'inset 0 0 0 2px var(--warn)' : 'none';
    steps.replaceChildren(...(st.steps || []).map(s => h('li', { style: { color: s.kind === 'owner' ? 'var(--warn)' : s.kind === 'failed' || s.kind === 'refused' ? 'var(--stop)' : 'inherit' } }, s.text, h('span', { class: 'sub', style: { marginLeft: '6px', fontSize: '11.5px' } }, fmt.time(s.at)))));
    steps.scrollTop = steps.scrollHeight;
    if (st.result) { result.style.display = ''; result.replaceChildren(h('h3', null, 'What it found'), ui.md ? ui.md(st.result) : h('p', null, st.result)); } else result.style.display = 'none';
  }
  async function refresh() { try { st = await api(base + '/status'); paint(); } catch {} }
  async function pull() {
    while (alive) {
      if (st.open && document.visibilityState === 'visible') {
        try {
          const r = await api(`${base}/frame?after=${frameNo}`, { raw: true });
          if (r.status === 200) { const b = await r.blob(); frameNo = Number(r.headers.get('x-frame')) || frameNo + 1; const u = URL.createObjectURL(b); img.src = u; img.hidden = false; if (objUrl) URL.revokeObjectURL(objUrl); objUrl = u; blank.hidden = true; }
        } catch {}
      }
      await new Promise(r => setTimeout(r, st.open ? 250 : 1500));
    }
  }
  let statTimer = setInterval(() => { if (st.open || st.jobId) refresh(); }, 1500);

  el.append(h('div', { class: 'bcomp', style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: '14px', alignItems: 'stretch', minHeight: '0', flex: '1' } },
    h('div', { class: 'stack', style: { minWidth: '0' } },
      h('div', { class: 'screen' }, urlBar, stage),
      h('div', { class: 'row' }, modePill, offPill, framesPill, h('span', { class: 'grow' }), bWin, bStop, bTake, bBack),
      h('div', { class: 'row' }, goal, start, bGo),
      allowedAddresses(ui)),
    h('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '0', maxHeight: 'calc(100vh - 240px)' } },
      h('h3', null, 'Steps'), goalLine, steps, result,
      h('p', { class: 'sub', style: { fontSize: '12px' } }, 'Take over pauses the agent at once; click, type and scroll on the picture to drive. It never types passwords, card numbers or codes: it stops and asks you.'))));
  paint(); refresh(); pull();
  ui.on?.('browser', (e) => { if (e?.agentId === id) refresh(); });
  ui.on?.('panic', () => refresh());
  ui.on?.('settings', () => refresh());
  const cleanup = () => { alive = false; clearInterval(statTimer); if (objUrl) URL.revokeObjectURL(objUrl); if (lastUrl) URL.revokeObjectURL(lastUrl); };
  ui.onLeave?.(cleanup);
  return cleanup;
}

export const agentTabs = { computer: { title: 'Computer', async render(el, ui, agent) { return renderComputer(el, ui, agent); } } };

// Narrow screens: one column.
if (typeof document !== 'undefined' && !document.getElementById('apd-browser-css')) {
  const s = document.createElement('style'); s.id = 'apd-browser-css';
  s.textContent = '@media (max-width:1100px){.bcomp{grid-template-columns:minmax(0,1fr)!important}}';
  document.head.append(s);
}
