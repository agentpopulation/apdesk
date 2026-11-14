// Files page: the explorer mounted on the shell kit.
import { mountFileExplorer } from './ui/explorer.js';

const SESSION = () => document.querySelector('meta[name="apd-session"]')?.content || '';
let current = null;

function cssOnce() {
  if (document.getElementById('apd-files-css')) return;
  document.head.append(Object.assign(document.createElement('link'), { id: 'apd-files-css', rel: 'stylesheet', href: '/modules/files/ui/explorer.css' }));
}

/** The kit's api, answering { ok, status, data } the way the ported explorer expects. */
async function call(ui, path, opts = {}) {
  try { return { ok: true, status: 200, data: await ui.api(path, opts) }; }
  catch (e) { return { ok: false, status: e.status || 0, data: e.data || { error: e.message } }; }
}
async function rawFetch(href) {
  const r = await fetch(href, { headers: { 'x-apd-session': SESSION() } });
  if (!r.ok) return null;
  return r;
}

async function uploadInto(ui, explorer, files) {
  const { root, path } = explorer.state.loc;
  if (!files?.length) return;
  let n = 0;
  for (const f of files) {
    const q = new URLSearchParams({ root, path: path || '', name: f.name });
    const r = await fetch('/api/m/files/upload?' + q, { method: 'POST', headers: { 'x-apd-session': SESSION(), 'content-type': 'application/octet-stream' }, body: f });
    if (r.ok) n++; else { let e = null; try { e = await r.json(); } catch {} ui.toast(`${f.name}: ${e?.error || 'could not be added'}`, 'err'); }
  }
  if (n) ui.toast(n === 1 ? 'Added 1 file.' : `Added ${n} files.`, 'ok');
  await explorer.refresh();
}

export const pages = {
  files: {
    title: 'Files',
    async render(view, ui, route) {
      cssOnce();
      view.classList.add('fxv');
      const host = ui.h('div', { class: 'fx-host' });
      view.append(host);
      const picker = ui.h('input', { type: 'file', multiple: true, hidden: true });
      view.append(picker);
      const explorer = mountFileExplorer(host, {
        api: (p, o) => call(ui, p, o),
        toast: (text, err) => ui.toast(text, err ? 'err' : ''),
        md: (text) => ui.md(text),
        agentLabel: (id) => ui.agent(id)?.name || id,
        decide: (id, d) => ui.decide(id, d),
        openChat: (chatId) => ui.go('chat', chatId),
        openAdd: () => picker.click(),
        reindex: async () => { const r = await call(ui, '/api/m/files/knowledge/reindex', { method: 'POST', body: {} }); ui.toast(r.ok ? `Knowledge: ${r.data.files} files, ${r.data.passages} passages ready for agents.` : (r.data?.error || 'Re-index failed.'), r.ok ? 'ok' : 'err'); },
        fetchText: async (href) => { const r = await rawFetch(href); return r ? r.text() : null; },
        blobUrl: async (href) => { const r = await rawFetch(href); if (!r) return null; const u = URL.createObjectURL(await r.blob()); ui.onLeave(() => URL.revokeObjectURL(u)); return u; },
        download: async (href, name) => { const r = await rawFetch(href); if (!r) return ui.toast('Could not download it.', 'err'); const u = URL.createObjectURL(await r.blob()); const a = ui.h('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); },
      });
      current = explorer;
      picker.addEventListener('change', async () => { await uploadInto(ui, explorer, [...picker.files]); picker.value = ''; });
      // Drop files from the PC onto the list: they go into the folder shown.
      host.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); host.classList.add('is-drop'); } });
      host.addEventListener('dragleave', (e) => { if (e.target === host || !host.contains(e.relatedTarget)) host.classList.remove('is-drop'); });
      host.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); host.classList.remove('is-drop'); void uploadInto(ui, explorer, [...e.dataTransfer.files]); });
      // Live: files an agent writes show up without a refresh.
      let t = null;
      ui.on('files', () => { clearTimeout(t); t = setTimeout(() => { if (!explorer.state.renaming) explorer.refresh(); }, 400); });
      // #/files/reports/x.pdf or #/files?path=reports/x.pdf (a chat file card) opens the folder and selects the file.
      const target = route?.params?.path || (route?.parts?.length ? route.parts.join('/') : '');
      // A folder path opens that folder; a file path opens its folder with the file selected.
      if (target) {
        const rootId = route?.params?.root || 'home';
        const clean = String(target).replace(/^\/+|\/+$/g, '');
        const st = await call(ui, '/api/m/files/stat?' + new URLSearchParams({ root: rootId, path: clean }));
        if (st.ok && st.data?.kind === 'folder') explorer.open({ root: rootId, path: clean });
        else explorer.reveal(rootId, clean);
      }
    },
    unmount() { current = null; },
  },
};

/** A file card in chat: name, size, and Open in Files. */
export const chatCards = {
  file: (card, ui) => ui.h('div', { class: 'card', style: { display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 12px' } },
    ui.h('div', { style: { flex: '1', minWidth: '0' } }, ui.h('b', { style: { overflowWrap: 'anywhere' } }, card.name || card.path), ui.h('span', { class: 'sub', style: { display: 'block' } }, [card.note, card.size != null ? ui.fmt.bytes(card.size) : null].filter(Boolean).join(' · '))),
    ui.btn('Open in Files', { kind: 'ghost sm', onClick: () => (ui.openFile ? ui.openFile(card.path || '') : (location.hash = '#/files?path=' + encodeURIComponent(card.path || ''))) })),
};
