// Studio page: Site builder (brief -> a one-page site, previewed in a strict sandbox) and Eval replay (one ask, two models).
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
export const pages = {
  studio: {
    title: 'Studio',
    async render(el, ui, route) {
      const { h, api, card, btn, pill, toast, fmt, empty, md, seg, line } = ui;
      const body = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column', gap: '14px' } });
      const waitJob = (jobId) => new Promise((resolve) => { const off = ui.on('job', async (j) => { if (j?.id !== jobId || ['running', 'waiting'].includes(j.status)) return; off(); resolve(await api('jobs/' + jobId)); }); });
      const tab = route?.parts?.[0] === 'replay' ? 1 : 0;
      el.append(h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Studio'), seg(['Site builder', 'Eval replay'], tab, (_, i) => { ui.go('studio', i ? 'replay' : 'sites'); })), body);
      if (tab === 0) await sites(); else await replay();

      async function sites() {
        const brief = h('textarea', { placeholder: 'A short brief, for example "A one-page site for a neighbourhood bakery: fresh bread and cakes, open 7 to 7, order by phone."', style: { minHeight: '110px' } });
        const name = h('input', { type: 'text', placeholder: 'Folder name (optional)' });
        const status = h('div');
        const list = h('div', { class: 'stack' });
        const frameWrap = h('div', { style: { flex: '1', minHeight: '420px', display: 'flex', flexDirection: 'column' } }, empty('Build a site or pick one to preview it here.'));
        const head = h('div', { class: 'row' });
        let current = null;
        const preview = (s) => {
          current = s.name;
          put(head, h('h3', { style: { margin: 0 } }, s.name), pill(s.label || ''), h('span', { class: 'grow' }), btn('Open folder', { kind: 'ghost sm', onClick: () => (ui.openFile ? ui.openFile(s.folder) : ui.go('files', s.folder)) }));
          put(frameWrap, h('iframe', { sandbox: '', title: 'Preview of ' + s.name, src: `/api/m/studio/preview/${encodeURIComponent(s.name)}/index.html?t=${Date.now()}`, style: { flex: '1', width: '100%', minHeight: '420px', border: '1px solid var(--line)', borderRadius: 'var(--r-s)', background: '#fff' } }));
          paintList();
        };
        async function paintList() {
          const { sites } = await api('m/studio/sites');
          put(list, ...(sites.length ? sites.map(s => h('button', { class: 'nav', style: { textAlign: 'left', display: 'block', width: '100%' }, 'aria-current': s.name === current ? 'page' : null, onclick: () => preview(s) }, h('b', null, s.name), h('span', { class: 'sub', style: { display: 'block' } }, `${fmt.when(s.at)} · ${s.label} · ${s.files.map(f => `${f.name} ${fmt.bytes(f.size)}`).join(', ')}`))) : [empty('No sites yet.')]));
          return sites;
        }
        const go = btn('Build', { onClick: async () => {
          go.disabled = true; put(status, h('div', { class: 'row' }, ui.spinner(), h('span', { class: 'sub' }, 'A model is writing the page. Files are written through your approval rules.')));
          try { const { jobId } = await api('m/studio/sites', { body: { brief: brief.value, name: name.value || undefined } }); const j = await waitJob(jobId); if (j.status === 'done') { put(status, h('span', { class: 'sub' }, `Written by ${j.output.label} into Workspace › ${j.output.folder}.`)); const all = await paintList(); preview(all.find(s => s.name === j.output.name)); } else put(status, h('p', { class: 'sub' }, 'Not built: ' + (j.error || j.status))); }
          catch (e) { toast(e.message, 'err'); put(status, ); } finally { go.disabled = false; }
        } });
        body.append(h('div', { class: 'cols', style: { flex: '1', minHeight: '0' } },
          h('div', { class: 'stack' }, card(h('h3', null, 'Brief'), brief, h('div', { class: 'row' }, name, h('span', { class: 'grow' }), go), status), card(h('h3', null, 'Your sites'), list)),
          card({ style: { display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '0' } }, head, frameWrap, h('span', { class: 'sub' }, 'The preview runs no scripts and sends nothing anywhere.'))));
        const all = await paintList(); if (all[0]) preview(all[0]);
      }

      async function replay() {
        const [{ models }, asks] = await Promise.all([api('m/studio/models'), api('m/studio/asks')]);
        const ask = h('textarea', { placeholder: 'The ask to replay', style: { minHeight: '90px' } });
        const sel = (i) => h('select', { 'aria-label': 'Model ' + (i + 1) }, models.map((m, k) => h('option', { value: k, selected: k === Math.min(i, models.length - 1) }, m.label)));
        const sa = sel(0), sb = sel(1);
        const out = h('div', { class: 'two' });
        const saved = h('div', { class: 'stack' });
        const paintSaved = async () => { const a = await api('m/studio/asks'); put(saved, ...(a.saved.length ? a.saved.map(s => line(s.text.slice(0, 90), fmt.when(s.at), btn('Use', { kind: 'ghost sm', onClick: () => { ask.value = s.text; } }), btn('Remove', { kind: 'ghost sm', onClick: async () => { await api('m/studio/asks/' + s.id, { method: 'DELETE' }); paintSaved(); } }))) : [empty('No saved asks yet.')]), ...(a.recent.length ? [h('span', { class: 'sub' }, 'Recent in chat'), ...a.recent.map(t => line(t.slice(0, 90), '', btn('Use', { kind: 'ghost sm', onClick: () => { ask.value = t; } })))] : [])); };
        const col = (r) => card(h('div', { class: 'row' }, pill(r.label || 'Model', r.ok ? 'ok' : 'stop'), h('span', { class: 'grow' }), h('span', { class: 'sub' }, `${(r.ms / 1000).toFixed(1)} s`)), r.ok ? md(r.text) : h('p', { class: 'sub' }, r.error));
        const run = btn('Replay', { onClick: async () => {
          if (!models.length) return toast('No model is active.', 'err');
          run.disabled = true; put(out, card(h('span', { class: 'sub' }, 'Asking both models…')), card(h('span', { class: 'sub' }, '…')));
          try { const { jobId } = await api('m/studio/replay', { body: { ask: ask.value, a: models[sa.value], b: models[sb.value] } }); const j = await waitJob(jobId); if (j.status === 'done') put(out, ...j.output.results.map(col)); else put(out, card(h('p', { class: 'sub' }, j.error || j.status))); }
          catch (e) { toast(e.message, 'err'); } finally { run.disabled = false; }
        } });
        body.append(h('div', { class: 'cols' },
          card(h('h3', null, 'Ask'), ask, h('div', { class: 'row' }, sa, h('span', { class: 'sub' }, 'against'), sb, h('span', { class: 'grow' }), btn('Save ask', { kind: 'ghost sm', onClick: async () => { try { await api('m/studio/asks', { body: { text: ask.value } }); paintSaved(); } catch (e) { toast(e.message, 'err'); } } }), run)),
          card(h('h3', null, 'Saved asks'), saved)), out);
        paintSaved();
      }
    },
  },
};
