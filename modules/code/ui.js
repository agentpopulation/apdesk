// Code and Sandbox page: editor, Run, output, history (the owner's runs and the agents').
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
const SAMPLE = {
  javascript: '// A small program. Print what you want to see.\nconst nums = [3, 1, 4, 1, 5, 9, 2, 6];\nconsole.log("sorted:", [...nums].sort((a, b) => a - b).join(", "));\nconsole.log("sum:", nums.reduce((a, b) => a + b, 0));\n',
  python: '# A small program. Print what you want to see.\nnums = [3, 1, 4, 1, 5, 9, 2, 6]\nprint("sorted:", ", ".join(map(str, sorted(nums))))\nprint("sum:", sum(nums))\n',
};
const STATUS = { done: ['Finished', 'ok'], failed: ['Failed', 'stop'], denied: ['Not allowed', 'stop'], stopped: ['Stopped', 'stop'], running: ['Running', 'run'], asking: ['Waiting for you', 'wait'], queued: ['Starting', 'run'] };
const LANG = { javascript: 'JavaScript', python: 'Python' };

export const pages = {
  code: {
    title: 'Code',
    async render(el, ui) {
      const { h, api, card, btn, pill, seg, toast, fmt, empty } = ui;
      let st = await api('m/code/status');
      let lang = 'javascript', box = 'process', current = null;
      const container = st.sandboxes.find(s => s.id === 'container');
      const ta = h('textarea', { spellcheck: 'false', 'aria-label': 'Code', style: { fontFamily: 'var(--mono)', fontSize: '13px', minHeight: '260px', flex: '1' } }, SAMPLE.javascript);
      const boxNote = h('p', { class: 'sub' });
      const inUse = h('span');
      const out = h('div', { class: 'stack' }, empty('Press Run. The output shows here.'));
      const hist = h('div', { class: 'stack', style: { overflow: 'auto', maxHeight: '100%' } });
      const timeSel = h('select', { 'aria-label': 'Time limit' }, [5, 15, 30, 60].map(s => h('option', { value: s * 1000, selected: s === 15 }, `${s} s limit`)));
      const langSeg = seg(['JavaScript', 'Python'], 0, (_, i) => { const was = lang; lang = i ? 'python' : 'javascript'; if (ta.value.trim() === SAMPLE[was].trim() || !ta.value.trim()) ta.value = SAMPLE[lang]; if (lang === 'python' && container.available && container.images?.python) { box = 'container'; boxSeg.set(1); } paintBox(); });
      const boxSeg = seg(['Process sandbox', 'Container'], 0, (_, i) => { box = i ? 'container' : 'process'; paintBox(); });
      const runBtn = btn('Run', { onClick: () => go() });
      const imgBtn = btn('Get image', { kind: 'ghost sm', onClick: async () => { try { await api('m/code/image', { body: { language: lang } }); toast('Asked to download the image. Approve it to start.', 'ok'); } catch (e) { toast(e.message, 'err'); } } });
      function paintBox() {
        const s = st.sandboxes.find(x => x.id === box);
        const pyMissing = lang === 'python' && box === 'process' && !st.languages.python.available;
        const imgMissing = box === 'container' && s.available && !s.images?.[lang];
        put(inUse, pill('In use: ' + s.label, box === 'container' ? 'ok' : 'wait'));
        put(boxNote, !s.available ? s.note : pyMissing ? st.languages.python.note : s.note, imgMissing ? h('span', null, ' ', imgBtn) : '');
        runBtn.disabled = !s.available || pyMissing || imgMissing;
      }
      if (!container.available) { boxSeg.children[1].disabled = true; boxSeg.children[1].title = container.note; }
      async function go() {
        runBtn.disabled = true;
        try {
          const r = await api('m/code/run', { body: { language: lang, code: ta.value, sandbox: box, timeoutMs: Number(timeSel.value) } });
          current = r.runId; put(out, h('div', { class: 'row' }, pill('Waiting for you', 'wait'), h('span', { class: 'sub' }, 'Running code always asks you first. Approve the card to start.')));
          await paintHistory();
        } catch (e) { toast(e.message, 'err'); } finally { paintBox(); }
      }
      const preBox = (text, label) => h('div', null, h('span', { class: 'sub' }, label), h('pre', { style: { margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono)', fontSize: '12.5px', background: 'var(--bubble)', borderRadius: 'var(--r-s)', padding: '8px 10px', maxHeight: '260px', overflow: 'auto' } }, text));
      function paintOut(r) {
        if (!r) return;
        const [word, kind] = STATUS[r.status] || [r.status, ''];
        const who = r.agentId ? (ui.agent?.(r.agentId)?.name || 'An agent') : 'You';
        put(out, 
          h('div', { class: 'row' }, pill(word, kind), h('span', { class: 'sub' }, `${LANG[r.language]} · ${r.sandboxLabel} · ${who} · ${fmt.when(r.at)}${r.ms != null ? ` · ${(r.ms / 1000).toFixed(2)} s` : ''}${r.exitCode != null ? ` · exit code ${r.exitCode}` : ''}`)),
          r.note ? h('p', { class: 'sub' }, r.note) : null,
          r.stdout ? preBox(r.stdout, 'Output') : (r.status === 'done' ? h('p', { class: 'sub' }, 'The program printed nothing.') : null),
          r.stderr ? preBox(r.stderr, 'Errors') : null,
          r.files?.length ? h('div', { class: 'row' }, h('span', { class: 'sub' }, `Files it made in ${r.folder}: ${r.files.map(f => `${f.name} (${fmt.bytes(f.size)})`).join(', ')}`), btn('Open in Files', { kind: 'ghost sm', onClick: () => (ui.openFile ? ui.openFile(r.folder) : ui.go('files', r.folder)) })) : null);
      }
      async function paintHistory() {
        const { runs } = await api('m/code/runs?limit=40');
        put(hist, ...(runs.length ? runs.map(r => {
          const [word, kind] = STATUS[r.status] || [r.status, ''];
          const first = (r.code.split('\n').find(l => l.trim() && !/^\s*(\/\/|#)/.test(l)) || r.code.split('\n')[0] || '').trim().slice(0, 60);
          return h('button', { class: 'nav', style: { textAlign: 'left', display: 'block', width: '100%' }, 'aria-current': r.id === current ? 'page' : null, onclick: () => { current = r.id; ta.value = r.code; lang = r.language; langSeg.set(lang === 'python' ? 1 : 0); paintBox(); paintOut(r); paintHistory(); } },
            h('div', { class: 'row' }, h('b', { style: { fontSize: '13px' } }, LANG[r.language]), pill(word, kind), h('span', { class: 'grow' }), h('span', { class: 'sub' }, fmt.when(r.at))),
            h('span', { class: 'sub', style: { fontFamily: 'var(--mono)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (r.agentId ? (ui.agent?.(r.agentId)?.name || 'Agent') + ': ' : '') + first));
        }) : [empty('No runs yet. Agents’ runs show here too.')]));
        if (current) paintOut(runs.find(r => r.id === current));
      }
      // helpers: Aider (optional sidecar) and the two we tried
      const aider = h('div');
      api('m/code/aider').then(a => {
        const folder = h('input', { type: 'text', placeholder: 'Workspace folder, e.g. projects/site' }); const msg = h('input', { type: 'text', placeholder: 'What to change' });
        put(aider, ui.line('Aider', a.available ? `Installed (${a.version}). Edits a folder in the workspace using the desk’s own models. Asks you first.` : a.note, a.available ? null : pill('Not installed')),
          a.available ? h('div', { class: 'row' }, folder, msg, btn('Ask Aider', { kind: 'ghost sm', onClick: async () => { try { await api('m/code/aider', { body: { folder: folder.value, message: msg.value } }); toast('Aider is waiting for your approval. The result shows in Tasks.', 'ok'); } catch (e) { toast(e.message, 'err'); } } })) : null);
      }).catch(() => {});
      el.append(
        h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Code'), inUse, h('span', { class: 'grow' }), h('span', { class: 'sub' }, `Each run gets its own folder under sandbox, a time limit and no keys. Output over ${fmt.bytes(st.limits.maxOutputBytes)} stops the run.`)),
        h('div', { class: 'cols', style: { flex: '1', minHeight: '0' } },
          h('div', { class: 'stack' },
            card({ style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, h('div', { class: 'row' }, langSeg, boxSeg, h('span', { class: 'grow' }), timeSel, runBtn), boxNote, ta),
            card(h('h3', null, 'Output'), out)),
          h('div', { class: 'stack', style: { minHeight: '0' } },
            card({ style: { display: 'flex', flexDirection: 'column', minHeight: '0', maxHeight: '520px' } }, h('h3', null, 'History'), hist),
            card(h('h3', null, 'Helpers'), aider, ui.line('Container sandbox', container.available ? container.note : container.note), ui.line('OpenHands, E2B', 'Tried. OpenHands needs a large Docker image and its own server; E2B runs sandboxes in its cloud with an account. Neither is used.')))));
      paintBox(); await paintHistory();
      ui.on('code', (r) => { if (r?.id === current) paintOut(r); paintHistory().catch(() => {}); });
      ui.on('job', async (j) => { if (j?.kind === 'code.image' && j.status === 'done') { st = await api('m/code/status?refresh=1'); paintBox(); } if (j?.kind === 'code.aider' && ['done', 'failed'].includes(j.status)) toast(j.status === 'done' ? 'Aider finished. See Tasks for what it changed.' : 'Aider failed: ' + (j.error || ''), j.status === 'done' ? 'ok' : 'err'); });
    },
  },
};
