// The Files explorer view, on the Files module (/api/m/files/*),
// the shell kit and shell.css tokens. Home is the workspace; the Bin is the desk's Bin.
// SPDX-License-Identifier: Apache-2.0
/**
 * Files, drawn like a desktop file explorer:
 *   tree (Home, Recent, Starred, agents, Downloads/Documents/Desktop, This PC, Quick access, Bin)
 *   address bar (back, forward, up, refresh, breadcrumb, search in this folder)
 *   command bar (Add files, New folder, Rename, Move, Copy, Delete → Bin, Sort, View, Preview pane)
 *   Details / Tiles / Large icons, multi-select, keyboard, right-click menu, preview + details pane
 *   status bar "N items · size".
 * Folders the owner has not opened stay greyed with "Allow access…", which raises an approval card.
 * Server: modules/files/server.js (/api/m/files/*).
 */
import {
  QUICK_ACCESS,
  READER_LABELS,
  SORT_KEYS,
  VIEWS,
  formatDate,
  madeByLabel,
  normalizePrefs,
  paneMode,
  systemNote,
  formatSize,
  iconFor,
  isFsRoot,
  nextIndex,
  opensInApp,
  parentOf,
  previewKind,
  sameLoc,
  sortItems,
  statusLine,
  toolState,
  typeLabel,
} from './explorer-model.js';

const PREFS_KEY = 'apd.files.explorer';
const MAX_TEXT_PREVIEW = 256 * 1024;

const ICONS = {
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15h6M9 18h4',
  markdown: 'M6 3h8l4 4v14H6zM14 3v4h4M8.5 17v-5l2 2.5 2-2.5v5M15 12v5m-1.5-1.5L15 17l1.5-1.5',
  pdf: 'M6 3h8l4 4v14H6zM14 3v4h4M8.5 17v-4h1.3a1.2 1.2 0 0 1 0 2.4H8.5M12.5 13v4h1a2 2 0 0 0 0-4zM16 17v-4h1.6M16 15h1.3',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 17M15.5 9.5a1.2 1.2 0 1 0 0 .01',
  sheet: 'M6 3h8l4 4v14H6zM14 3v4h4M8 11h8v7H8zM8 14.5h8M12 11v7',
  code: 'M6 3h8l4 4v14H6zM14 3v4h4M10 12l-2 2.5 2 2.5M14 12l2 2.5-2 2.5',
  video: 'M4 6h12v12H4zM16 10l4-2.5v9L16 14',
  audio: 'M9 17V6l10-2v11M9 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM19 15a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  archive: 'M5 4h14v16H5zM11 4v2h2V4M11 8h2v2h-2zM11 12h2v3h-2z',
  chat: 'M4 5h16v11H9l-5 4z',
  agent: 'M12 4a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM5 20a7 7 0 0 1 14 0z',
  drive: 'M3 14l2.5-8h13L21 14v5H3zM3 14h18M17 16.5h.01',
  pc: 'M3 5h18v11H3zM8 20h8M12 16v4',
  download: 'M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14',
  desktop: 'M3 5h18v11H3zM8 20h8M12 16v4',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  recent: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 8v4.5l3 2',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.8l-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z',
  bin: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  inbox: 'M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5',
  review: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 8v5M12 16h.01',
  book: 'M5 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5zM19 4h-4a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h4z',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
  up: 'M12 19V6m-6 6l6-6 6 6',
  refresh: 'M19 12a7 7 0 1 1-2.1-5M19 4v4h-4',
  newfolder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM12 10v6M9 13h6',
  rename: 'M4 20h4l10-10-4-4L4 16zM13 7l4 4',
  move: 'M5 12h12m-4-4l4 4-4 4M5 5v14',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  restore: 'M5 12a7 7 0 1 0 2.1-5M5 4v4h4',
  sort: 'M7 4v16m-3-3l3 3 3-3M17 20V4m-3 3l3-3 3 3',
  view: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  pane: 'M3 5h18v14H3zM15 5v14',
  open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  add: 'M12 5v14M5 12h14',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5L20 20',
  chevron: 'M9 6l6 6-6 6',
};

function readPrefs() {
  try {
    return normalizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'));
  } catch {
    return normalizePrefs({});
  }
}

function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private window */ }
}

/**
 * Mount the explorer into `host`. deps: { api, toast, show, state, openAdd, loadDocs, pinDoc, viewHref }.
 * Returns { refresh(), open(loc), root }.
 */
export function mountFileExplorer(host, deps) {
  const doc = host.ownerDocument || document;
  const { api, toast } = deps;
  const prefs = readPrefs();
  const S = {
    roots: [],
    loc: { root: 'home', path: '' },
    back: [],
    fwd: [],
    items: [],
    crumbs: [],
    selected: new Set(),
    focus: -1,
    anchor: -1,
    loading: false,
    error: null,
    detail: null,
    renaming: null,
    hiddenSystem: 0,
    seq: 0,
  };

  // ---- small DOM helpers ----
  function h(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(id, cls = 'fx-ico') {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', cls + ' is-' + id);
    const p = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[id] || ICONS.file);
    svg.append(p);
    return svg;
  }
  function button(label, cls, onClick, opts = {}) {
    const b = h('button', cls);
    b.type = 'button';
    if (opts.icon) b.append(icon(opts.icon, 'fx-btn-ico'));
    if (label && !opts.iconOnly) b.append(h('span', 'fx-btn-label', label));
    if (opts.iconOnly || opts.title) {
      b.title = opts.title || label;
      b.setAttribute('aria-label', opts.title || label);
    }
    if (opts.id) b.dataset.cmd = opts.id;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
    return b;
  }

  // ---- layout ----
  const root = h('div', 'fx');
  root.dataset.view = prefs.view;
  root.classList.toggle('has-pane', prefs.pane);

  const bar = h('div', 'fx-bar');
  const navBack = button('Back', 'fx-nav', () => goBack(), { icon: 'back', iconOnly: true, title: 'Back (Alt+Left)', id: 'back' });
  const navFwd = button('Forward', 'fx-nav', () => goForward(), { icon: 'forward', iconOnly: true, title: 'Forward (Alt+Right)', id: 'forward' });
  const navUp = button('Up', 'fx-nav', () => goUp(), { icon: 'up', iconOnly: true, title: 'Up to the folder above (Alt+Up)', id: 'up' });
  const navRefresh = button('Refresh', 'fx-nav', () => refresh(), { icon: 'refresh', iconOnly: true, title: 'Refresh (F5)', id: 'refresh' });
  const crumbs = h('nav', 'fx-crumbs');
  crumbs.setAttribute('aria-label', 'Path');
  const search = h('form', 'fx-search');
  search.setAttribute('role', 'search');
  search.append(icon('search', 'fx-search-ico'));
  const searchInput = h('input', 'fx-search-input');
  searchInput.type = 'search';
  searchInput.id = 'fx-search';
  searchInput.setAttribute('aria-label', 'Search this folder');
  search.append(searchInput);
  search.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    navigate({ root: S.loc.root, path: S.loc.path, q: q || undefined });
  });
  bar.append(navBack, navFwd, navUp, navRefresh, crumbs, search);

  const tools = h('div', 'fx-tools');
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'File commands');
  const tNew = button('New folder', 'fx-tool', () => newFolder(), { icon: 'newfolder', id: 'new-folder' });
  const tRename = button('Rename', 'fx-tool', () => startRename(), { icon: 'rename', id: 'rename', title: 'Rename (F2)' });
  const tMove = button('Move', 'fx-tool', () => pickDestination(false), { icon: 'move', id: 'move' });
  const tCopy = button('Copy', 'fx-tool', () => pickDestination(true), { icon: 'copy', id: 'copy' });
  const tDelete = button('Delete', 'fx-tool is-danger', () => recycleSelected(), { icon: 'trash', id: 'delete', title: 'Delete: moves to the Bin (Del)' });
  const tRestore = button('Restore', 'fx-tool', () => restoreSelected(), { icon: 'restore', id: 'restore' });
  const tOpenApp = button('Open in its app', 'fx-tool', () => void openOnPcSelected(false), { icon: 'open', id: 'open-app', title: 'Open in its app (Word, the PDF reader…)' });
  const tReveal = button('Show in folder', 'fx-tool', () => void openOnPcSelected(true), { icon: 'folder', id: 'reveal', title: 'Show in folder on this PC' });
  const tSort = button('Sort', 'fx-tool', (e) => openMenu(sortMenu(), e.currentTarget), { icon: 'sort', id: 'sort' });
  tSort.setAttribute('aria-haspopup', 'menu');
  const tView = h('div', 'seg fx-viewseg');
  tView.setAttribute('role', 'group');
  tView.setAttribute('aria-label', 'View');
  [['details', 'Details'], ['tiles', 'Tiles']].forEach(([id, label]) => {
    const b = h('button', null, label); b.type = 'button'; b.dataset.view = id;
    b.addEventListener('click', () => setView(id));
    tView.append(b);
  });
  // "Details" is a view (the list with columns); this toggles the right-hand preview pane.
  const tPane = button('Preview pane', 'fx-tool', () => togglePane(), { icon: 'pane', id: 'pane', title: 'Show or hide the preview pane' });
  tPane.setAttribute('aria-pressed', String(prefs.pane));
  const tAdd = button('Add files', 'fx-tool is-primary', () => deps.openAdd && deps.openAdd(), { icon: 'add', id: 'add' });
  tools.append(tAdd, tNew, tRename, tMove, tCopy, tDelete, tRestore, tOpenApp, tReveal, h('span', 'fx-grow'), tSort, tView, tPane);

  const body = h('div', 'fx-body');
  const tree = h('nav', 'fx-tree');
  tree.setAttribute('aria-label', 'Folders');
  const main = h('div', 'fx-main');
  const head = h('div', 'fx-head');
  head.setAttribute('role', 'row');
  const list = h('div', 'fx-list');
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', 'true');
  list.setAttribute('aria-label', 'Files');
  main.append(head, list);
  const pane = h('aside', 'fx-pane');
  pane.setAttribute('aria-label', 'Details');
  const split1 = h('div', 'fx-split'); split1.dataset.split = 'tree';
  const split2 = h('div', 'fx-split'); split2.dataset.split = 'pane';
  body.append(tree, split1, main, split2, pane);
  function applyWidths() { root.style.setProperty('--fx-tree-w', prefs.treeW + 'px'); root.style.setProperty('--fx-pane-w', prefs.paneW + 'px'); }
  applyWidths();
  for (const sp of [split1, split2]) {
    sp.setAttribute('role', 'separator'); sp.setAttribute('aria-orientation', 'vertical');
    sp.title = 'Drag to resize';
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('is-drag');
      const startX = e.clientX; const start = sp.dataset.split === 'tree' ? prefs.treeW : prefs.paneW;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        if (sp.dataset.split === 'tree') prefs.treeW = Math.max(150, Math.min(420, start + dx));
        else prefs.paneW = Math.max(220, Math.min(560, start - dx));
        applyWidths();
      };
      const up = () => { sp.classList.remove('is-drag'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); savePrefs(prefs); };
      sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
    });
  }

  const status = h('div', 'fx-status');
  status.setAttribute('role', 'status');
  const statusText = h('span', 'fx-status-text');
  const statusSystem = h('span', 'fx-status-system');
  const statusSystemBtn = button('', 'fx-status-link', () => setSystem(!prefs.system), { id: 'system-files' });
  status.append(statusText, h('span', 'fx-grow'), statusSystem, statusSystemBtn);

  const menu = h('div', 'fx-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const dialog = h('div', 'fx-dialog-wrap');
  dialog.hidden = true;

  root.append(bar, tools, body, status, menu, dialog);
  host.append(root);

  // ---- data ----
  function rootById(id) {
    return S.roots.find((r) => r.id === id) || null;
  }
  function rootLabel(id) {
    if (id === 'home') return 'Home';
    if (id === 'recent') return 'Recent';
    if (id === 'starred') return 'Starred';
    const q = QUICK_ACCESS.find((x) => x.id === id);
    if (q) return q.label;
    return (rootById(id) || {}).label || id;
  }

  async function loadRoots() {
    const res = await api('/api/m/files/roots');
    S.roots = res.ok && res.data && Array.isArray(res.data.roots) ? res.data.roots : [];
    drawTree();
  }

  function fsItem(row, rootId) {
    return { ...row, source: 'fs', root: row.root || rootId, key: (row.root || rootId) + '|' + row.path };
  }

  async function loadItems() {
    const loc = S.loc;
    const seq = ++S.seq;
    S.loading = true;
    S.error = null;
    drawList();
    let items = [];
    let crumbList = [{ label: rootLabel(loc.root), loc: { root: loc.root, path: '' } }];
    let err = null;
    let hiddenSystem = 0;
    {
      const p = new URLSearchParams({ root: loc.root, path: loc.path || '' });
      if (loc.q) p.set('q', loc.q);
      if (prefs.system) p.set('system', '1');
      const res = await api('/api/m/files/list?' + p.toString());
      if (seq !== S.seq) return;
      if (!res.ok) {
        err = (res.data && (res.data.message || res.data.error)) || 'This folder could not open.';
        if (res.data && res.data.code === 'not_granted') err = { notGranted: loc.root, text: err };
      } else {
        const data = res.data || {};
        hiddenSystem = Number(data.hiddenSystem) || 0;
        if (loc.root === 'bin') {
          items = (data.items || []).map((r) => ({ ...r, source: 'bin', key: 'bin|' + r.binId }));
        } else if (data.mixed) {
          items = (data.items || []).map((r) => fsItem(r, r.root));
        } else {
          items = (data.items || []).map((r) => fsItem(r, loc.root));
          crumbList = (data.crumbs || []).map((c) => ({ label: c.label, loc: { root: loc.root, path: c.path } }));
        }
        if (crumbList.length && crumbList[0].loc.root === loc.root && rootById(loc.root)) crumbList[0].label = rootLabel(loc.root);
      }
    }
    if (seq !== S.seq) return;
    S.items = sortItems(items, prefs.sort, prefs.dir);
    S.crumbs = crumbList;
    S.error = err;
    S.hiddenSystem = hiddenSystem;
    S.loading = false;
    // Keep a selection across refresh when the same rows are still there.
    const keys = new Set(S.items.map((i) => i.key));
    for (const k of [...S.selected]) if (!keys.has(k)) S.selected.delete(k);
    if (S.focus >= S.items.length) S.focus = S.items.length - 1;
    drawAll();
    if (S.pendingSelect) {
      const want = S.pendingSelect; S.pendingSelect = null;
      const index = S.items.findIndex((i) => i.path === want);
      if (index >= 0) selectOnly(index);
    }
  }

  // ---- navigation ----
  function navigate(loc, { push = true } = {}) {
    if (!loc || sameLoc(loc, S.loc)) { if (loc) refresh(); return; }
    if (push) { S.back.push(S.loc); S.fwd = []; }
    S.loc = { root: loc.root, path: loc.path || '', q: loc.q || undefined };
    searchInput.value = S.loc.q || '';
    searchInput.placeholder = 'Search ' + (S.loc.path ? S.loc.path.split('/').pop() : rootLabel(S.loc.root));
    S.selected.clear();
    S.focus = -1;
    S.anchor = -1;
    S.detail = null;
    S.renaming = null;
    void loadItems();
  }
  function goBack() {
    const prev = S.back.pop();
    if (!prev) return;
    S.fwd.push(S.loc);
    navigate(prev, { push: false });
  }
  function goForward() {
    const next = S.fwd.pop();
    if (!next) return;
    S.back.push(S.loc);
    navigate(next, { push: false });
  }
  function goUp() {
    const up = parentOf(S.loc);
    if (up) navigate(up);
  }
  async function refresh() {
    await loadRoots();
    await loadItems();
  }

  // ---- drawing ----
  function drawAll() {
    drawTree();
    drawCrumbs();
    drawTools();
    drawHead();
    drawList();
    drawPane();
    drawStatus();
  }

  function treeRow(label, iconId, loc, opts = {}) {
    const row = h('div', 'fx-tree-row' + (opts.cls ? ' ' + opts.cls : ''));
    row.dataset.root = loc.root;
    const b = h('button', 'fx-tree-item');
    b.type = 'button';
    b.dataset.root = loc.root;
    b.append(icon(iconId, 'fx-tree-ico'), h('span', 'fx-tree-label', label));
    if (opts.locked) {
      b.classList.add('is-locked');
      b.setAttribute('aria-disabled', 'true');
      b.title = label + ' · locked until you allow it';
    }
    const on = S.loc.root === loc.root && ((loc.path || '') === (S.loc.path || '') || (!loc.path && loc.root !== 'home'));
    if (on) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => {
      if (opts.locked) { void allowAccess(loc.root); return; }
      navigate(loc);
    });
    row.append(b);
    if (opts.locked) {
      // One compact line: the name, then a small "Allow access…" on the same row.
      row.classList.add('is-locked');
      const allow = button('Allow', 'fx-allow', () => void allowAccess(loc.root));
      allow.dataset.allow = loc.root;
      allow.setAttribute('aria-label', 'Allow access to ' + label + '…');
      allow.title = 'Let the desk open ' + label;
      row.append(allow);
    }
    if (opts.closable) {
      const close = button('Close', 'fx-allow is-close', () => void closeAccess(loc.root));
      close.title = 'Lock ' + label + ' again: Files and agents stop reading it';
      row.append(close);
    }
    return row;
  }
  async function closeAccess(rootId) {
    const res = await api('/api/m/files/grants/revoke', { method: 'POST', body: { root: rootId } });
    if (!res.ok) { toast(errText(res, 'Could not close it.'), true); return; }
    toast(rootLabel(rootId) + ' is locked again.');
    await loadRoots();
    if (S.loc.root === rootId) navigate({ root: 'home' }); else drawTree();
  }

  function treeGroup(label) {
    return h('div', 'fx-tree-group', label);
  }

  function drawTree() {
    tree.textContent = '';
    tree.append(treeRow('Home', 'home', { root: 'home' }));
    tree.append(treeRow('Recent', 'recent', { root: 'recent' }));
    tree.append(treeRow('Starred', 'star', { root: 'starred' }));
    const kRow = treeRow('Knowledge', 'book', { root: 'home', path: 'knowledge' });
    const reindex = button('Re-index', 'fx-allow', () => void deps.reindex?.());
    reindex.dataset.cmd = 'reindex';
    reindex.title = 'Read the Knowledge folder again so agents find new and changed files';
    kRow.append(reindex);
    tree.append(kRow);
    const agents = S.roots.filter((r) => r.group === 'agents');
    if (agents.length) {
      tree.append(treeGroup('Agents'));
      agents.forEach((r) => tree.append(treeRow(r.label, 'agent', { root: r.id }, { cls: 'is-agent' })));
    }
    const places = S.roots.filter((r) => r.group === 'places');
    const drives = S.roots.filter((r) => r.group === 'pc');
    if (places.length || drives.length) tree.append(treeGroup('This PC'));
    places.forEach((r) => tree.append(treeRow(r.label, iconFor({ kind: 'root', id: r.id, group: 'places' }), { root: r.id }, { locked: !r.granted, closable: r.granted })));
    if (drives.length) {
      drives.forEach((r) => tree.append(treeRow(r.label, 'drive', { root: r.id }, { locked: !r.granted, closable: r.granted })));
    }
    tree.append(h('div', 'fx-tree-gap'));
    tree.append(treeRow('Bin', 'bin', { root: 'bin' }));
  }

  function drawCrumbs() {
    crumbs.textContent = '';
    const first = S.loc.root === 'home' ? 'home' : isFsRoot(S.loc.root) ? 'folder' : 'recent';
    crumbs.append(icon(first === 'folder' ? iconFor({ kind: 'root', ...(rootById(S.loc.root) || {}) }) : first === 'home' ? 'home' : 'folder', 'fx-crumb-ico'));
    if (String(S.loc.root).startsWith('agent:')) {
      const home = button('Home', 'fx-crumb', () => navigate({ root: 'home' }));
      crumbs.append(home, icon('chevron', 'fx-crumb-sep'));
    }
    S.crumbs.forEach((c, i) => {
      const last = i === S.crumbs.length - 1;
      const b = button(c.label, 'fx-crumb', () => navigate(c.loc));
      b.dataset.path = c.loc.path || '';
      if (last && !S.loc.q) b.setAttribute('aria-current', 'location');
      crumbs.append(b);
      if (!last) crumbs.append(icon('chevron', 'fx-crumb-sep'));
    });
    if (S.loc.q) {
      crumbs.append(icon('chevron', 'fx-crumb-sep'));
      const r = h('span', 'fx-crumb is-search', 'Search results for “' + S.loc.q + '”');
      r.setAttribute('aria-current', 'location');
      crumbs.append(r);
    }
    navBack.disabled = !S.back.length;
    navFwd.disabled = !S.fwd.length;
    navUp.disabled = !parentOf(S.loc);
  }

  function selectedItems() {
    return S.items.filter((i) => S.selected.has(i.key));
  }

  function drawTools() {
    const t = toolState(S.loc, selectedItems());
    tAdd.disabled = !isFsRoot(S.loc.root);
    [...tView.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view || (prefs.view === 'icons' && b.dataset.view === 'tiles'))));
    tNew.disabled = !t.newFolder;
    tRename.disabled = !t.rename;
    tMove.disabled = !t.move;
    tCopy.disabled = !t.copy;
    tDelete.disabled = !t.delete;
    tDelete.hidden = S.loc.root === 'bin';
    tRestore.hidden = S.loc.root !== 'bin';
    tRestore.disabled = !t.restore;
    const pcOk = Boolean(deps.openOnPc) && S.loc.root !== 'bin';
    tOpenApp.hidden = !pcOk;
    tReveal.hidden = !pcOk;
    tOpenApp.disabled = !t.openApp;
    tReveal.disabled = !t.reveal;
    tPane.setAttribute('aria-pressed', String(prefs.pane));
    const sortLabel = (SORT_KEYS.find(([id]) => id === prefs.sort) || SORT_KEYS[0])[1];
    tSort.title = 'Sort by ' + sortLabel + (prefs.dir === 'desc' ? ' (descending)' : '');
  }

  function drawHead() {
    head.textContent = '';
    head.hidden = prefs.view !== 'details';
    SORT_KEYS.forEach(([id, label]) => {
      const b = h('button', 'fx-col is-' + id);
      b.type = 'button';
      b.dataset.sort = id;
      b.setAttribute('role', 'columnheader');
      b.append(h('span', null, id === 'mtime' ? 'Date modified' : label));
      if (prefs.sort === id) {
        b.setAttribute('aria-sort', prefs.dir === 'desc' ? 'descending' : 'ascending');
        b.append(h('span', 'fx-col-arrow', prefs.dir === 'desc' ? '▾' : '▴'));
      }
      b.addEventListener('click', () => setSort(id, prefs.sort === id ? (prefs.dir === 'asc' ? 'desc' : 'asc') : (id === 'mtime' || id === 'bytes' ? 'desc' : 'asc')));
      head.append(b);
      if (id === 'type') {
        const by = h('span', 'fx-col is-by');
        by.setAttribute('role', 'columnheader');
        by.append(h('span', null, 'Made by'));
        head.append(by);
      }
    });
  }

  function madeBy(item) {
    return madeByLabel(item, deps.agentLabel);
  }

  function itemMeta(item) {
    if (item.source === 'bin') return item.from ? 'From ' + item.from : 'In the Bin';
    if (item.researchStatus && /\(in progress\)$/.test(item.name)) return 'Research · ' + item.researchStatus;
    if (item.root && S.loc.root !== item.root && (S.loc.root === 'recent' || S.loc.root === 'starred')) {
      return rootLabel(item.root) + (item.path.includes('/') ? ' › ' + item.path.split('/').slice(0, -1).join(' › ') : '');
    }
    return typeLabel(item);
  }

  function rowNode(item, index) {
    const row = h('div', 'fx-row');
    row.setAttribute('role', 'option');
    row.dataset.key = item.key;
    row.dataset.kind = item.kind;
    row.dataset.name = item.name;
    row.id = 'fx-row-' + index;
    const on = S.selected.has(item.key);
    row.setAttribute('aria-selected', String(on));
    if (index === S.focus) row.classList.add('is-focus');
    if (item.state === 'needs-review') row.classList.add('is-review');
    const nameCell = h('span', 'fx-cell is-name');
    nameCell.append(icon(iconFor(item), 'fx-file-ico'));
    if (S.renaming === item.key) {
      const input = h('input', 'fx-rename');
      input.value = item.name;
      input.setAttribute('aria-label', 'New name');
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); void commitRename(item, input.value); }
        if (e.key === 'Escape') { S.renaming = null; drawList(); list.focus(); }
      });
      input.addEventListener('blur', () => { if (S.renaming === item.key) void commitRename(item, input.value); });
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('dblclick', (e) => e.stopPropagation());
      nameCell.append(input);
      setTimeout(() => {
        input.focus();
        const dot = item.kind === 'file' ? item.name.lastIndexOf('.') : -1;
        input.setSelectionRange(0, dot > 0 ? dot : item.name.length);
      }, 0);
    } else {
      const label = h('span', 'fx-name', item.name);
      label.title = item.name;
      nameCell.append(label);
      if (item.starred) nameCell.append(icon('star', 'fx-star-mark'));
    }
    if (prefs.view === 'details') {
      row.append(
        nameCell,
        h('span', 'fx-cell is-mtime', formatDate(item.mtime)),
        h('span', 'fx-cell is-type', itemMeta(item)),
        h('span', 'fx-cell is-by', madeBy(item)),
        h('span', 'fx-cell is-bytes', item.kind === 'file' ? formatSize(item.bytes) : ''),
      );
      const by = row.querySelector('.fx-cell.is-by');
      if (by && by.textContent) by.title = 'Made by ' + by.textContent;
      const type = row.querySelector('.fx-cell.is-type');
      if (type && type.textContent) type.title = type.textContent;
    } else if (prefs.view === 'tiles') {
      const text = h('span', 'fx-tile-text');
      text.append(nameCell.querySelector('.fx-name, .fx-rename') || h('span'));
      text.append(h('span', 'fx-tile-meta', itemMeta(item)));
      const who = madeBy(item);
      if (who) text.append(h('span', 'fx-tile-meta is-by', 'Made by ' + who));
      if (item.kind === 'file') text.append(h('span', 'fx-tile-meta', formatSize(item.bytes)));
      const ico = nameCell.querySelector('svg');
      row.append(ico, text);
    } else {
      row.append(nameCell);
      const who = madeBy(item);
      if (who) row.title = item.name + ' · Made by ' + who;
    }
    if (item.system) row.classList.add('is-system');
    row.addEventListener('click', (e) => onRowClick(e, index));
    row.addEventListener('dblclick', () => openItem(item));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!S.selected.has(item.key)) selectOnly(index);
      openMenu(itemMenu(), null, e);
    });
    return row;
  }

  function emptyNode() {
    const box = h('div', 'fx-empty');
    if (S.loading) { box.append(h('p', null, 'Opening…')); return box; }
    if (S.error && S.error.notGranted) {
      box.append(icon('lock', 'fx-empty-ico'));
      box.append(h('p', 'fx-empty-title', rootLabel(S.error.notGranted) + ' is closed to the desk'));
      box.append(h('p', 'fx-empty-text', 'Agents cannot read this folder until you allow it.'));
      const allow = button('Allow access…', 'fx-allow is-big', () => void allowAccess(S.error.notGranted));
      allow.dataset.allow = S.error.notGranted;
      box.append(allow);
      return box;
    }
    if (S.error) { box.append(h('p', 'fx-empty-text', String(S.error))); return box; }
    if (S.loc.q) { box.append(h('p', 'fx-empty-text', 'No items match “' + S.loc.q + '” in this folder.')); return box; }
    const words = {
      home: 'The workspace is empty. Add files, or ask an agent to make one.',
      recent: 'Nothing changed in the last 7 days.',
      starred: 'Star a file in the Details pane to keep it here.',
      bin: 'The Bin is empty.',
    };
    box.append(h('p', 'fx-empty-text', words[S.loc.root] || 'This folder is empty.'));
    return box;
  }

  function drawList() {
    list.textContent = '';
    list.dataset.view = prefs.view;
    root.dataset.view = prefs.view;
    if (S.loading || S.error || !S.items.length) {
      list.append(emptyNode());
      drawStatus();
      return;
    }
    S.items.forEach((item, i) => list.append(rowNode(item, i)));
    list.setAttribute('aria-activedescendant', S.focus >= 0 ? 'fx-row-' + S.focus : '');
  }

  function drawStatus() {
    if (S.loading) { statusText.textContent = 'Opening…'; return; }
    statusText.textContent = statusLine(S.items, selectedItems());
    const note = systemNote(S.hiddenSystem, prefs.system);
    statusSystem.textContent = note;
    statusSystemBtn.hidden = !note;
    const label = prefs.system ? 'Hide system files' : 'Show system files';
    statusSystemBtn.textContent = label;
    statusSystemBtn.setAttribute('aria-pressed', String(prefs.system));
  }

  // ---- selection + keyboard ----
  function selectOnly(index) {
    S.selected.clear();
    const item = S.items[index];
    if (item) S.selected.add(item.key);
    S.focus = index;
    S.anchor = index;
    afterSelect();
  }
  function selectRange(from, to) {
    S.selected.clear();
    const [a, b] = from < to ? [from, to] : [to, from];
    for (let i = Math.max(0, a); i <= b; i += 1) S.selected.add(S.items[i].key);
    S.focus = to;
    afterSelect();
  }
  function afterSelect() {
    drawList();
    drawTools();
    drawStatus();
    void loadDetail();
    const node = list.querySelector('#fx-row-' + S.focus);
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
  }
  function onRowClick(e, index) {
    list.focus();
    const item = S.items[index];
    if (!item) return;
    if (e.shiftKey && S.anchor >= 0) { selectRange(S.anchor, index); return; }
    if (e.ctrlKey || e.metaKey) {
      if (S.selected.has(item.key)) S.selected.delete(item.key);
      else S.selected.add(item.key);
      S.focus = index;
      S.anchor = index;
      afterSelect();
      return;
    }
    selectOnly(index);
  }
  function columns() {
    if (prefs.view === 'details') return 1;
    const rows = list.querySelectorAll('.fx-row');
    if (rows.length < 2) return 1;
    const top = rows[0].offsetTop;
    let n = 0;
    for (const r of rows) { if (r.offsetTop !== top) break; n += 1; }
    return Math.max(1, n);
  }

  list.addEventListener('keydown', (e) => {
    if (S.renaming) return;
    const n = S.items.length;
    const nav = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); return; }
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); goUp(); return; }
    if (nav.includes(e.key)) {
      if (prefs.view === 'details' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      const next = nextIndex(e.key, S.focus, n, columns());
      if (next < 0) return;
      if (e.shiftKey) selectRange(S.anchor >= 0 ? S.anchor : next, next);
      else if (e.ctrlKey || e.metaKey) { S.focus = next; drawList(); }
      else selectOnly(next);
      return;
    }
    if (e.key === ' ' && (e.ctrlKey || e.metaKey) && S.focus >= 0) {
      e.preventDefault();
      const k = S.items[S.focus].key;
      if (S.selected.has(k)) S.selected.delete(k); else S.selected.add(k);
      afterSelect();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = S.items[S.focus] || selectedItems()[0];
      if (item) openItem(item);
      return;
    }
    if (e.key === 'Backspace') { e.preventDefault(); if (S.back.length) goBack(); else goUp(); return; }
    if (e.key === 'F2') { e.preventDefault(); startRename(); return; }
    if (e.key === 'F5') { e.preventDefault(); void refresh(); return; }
    if (e.key === 'Delete') { e.preventDefault(); if (S.loc.root === 'bin') void restoreSelected(); else void recycleSelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      S.items.forEach((i) => S.selected.add(i.key));
      afterSelect();
      return;
    }
    if (e.key === 'Escape') { S.selected.clear(); afterSelect(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); void newFolder(); }
  });
  list.addEventListener('click', (e) => {
    if (e.target === list) { S.selected.clear(); afterSelect(); }
  });
  list.addEventListener('contextmenu', (e) => {
    if (e.target !== list && !(e.target.classList && e.target.classList.contains('fx-empty'))) return;
    e.preventDefault();
    S.selected.clear();
    afterSelect();
    openMenu(folderMenu(), null, e);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { closeMenu(); return; }
    if (e.key === 'Escape' && !dialog.hidden) closeDialog();
  });

  // ---- open ----
  function openItem(item) {
    if (!item) return;
    if (item.kind === 'root') { navigate({ root: item.id, path: '' }); return; }
    if (item.kind === 'folder' && item.source === 'fs') { navigate({ root: item.root, path: item.path }); return; }
    if (item.source === 'bin') { selectOnly(S.items.indexOf(item)); return; }
    // Word, Excel, PowerPoint and archives have no preview here: they open in the PC's own app.
    if (deps.openOnPc && opensInApp(item)) { void deps.openOnPc(item, false); return; }
    // Files: show in the preview pane (opening the pane if it was off).
    if (!prefs.pane) togglePane(true);
    S.selected.clear();
    S.selected.add(item.key);
    S.focus = S.items.indexOf(item);
    afterSelect();
  }

  async function openOnPcSelected(reveal) {
    const sel = selectedItems();
    if (sel.length !== 1 || !deps.openOnPc) return;
    const t = toolState(S.loc, sel);
    if (reveal ? !t.reveal : !t.openApp) return;
    await deps.openOnPc(sel[0], reveal);
  }

  function rawHref(item, download = false) {
    const p = new URLSearchParams({ root: item.root, path: item.path });
    if (download) p.set('download', '1');
    return '/api/m/files/raw?' + p.toString();
  }

  /** An agent's .html page: { agentId, path } for the preview server, else null. */
  function pageTarget(item) {
    if (!item || !deps.previewPage) return null;
    if (item.source === 'fs' && item.kind === 'file' && String(item.root).startsWith('agent:') && /\.html?$/i.test(item.name)) {
      return { agentId: String(item.root).slice(6), path: item.path };
    }
    if (item.source === 'index' && deps.isPreviewPage && deps.isPreviewPage(item.index)) {
      return { agentId: item.index.ref.agentId, path: item.index.ref.path };
    }
    return null;
  }

  // ---- details / preview pane ----
  async function loadDetail() {
    const sel = selectedItems();
    const item = sel.length === 1 ? sel[0] : null;
    if (!item) { S.detail = sel.length ? { many: sel } : null; drawPane(); return; }
    S.detail = { item, stat: null, preview: null, loading: true };
    drawPane();
    const want = item.key;
    let stat = null;
    if (item.source === 'fs') {
      const res = await api('/api/m/files/stat?' + new URLSearchParams({ root: item.root, path: item.path }).toString());
      stat = res.ok ? res.data : null;
    }
    if (!S.detail || !S.detail.item || S.detail.item.key !== want) return;
    S.detail.stat = stat;
    const kind = previewKind(item);
    let preview = null;
    if (prefs.pane && kind) {
      if (item.source === 'fs') {
        if (kind === 'office') {
          const res = await api('/api/m/files/text?' + new URLSearchParams({ root: item.root, path: item.path }).toString());
          preview = res.ok && res.data ? { kind: 'markdown', text: res.data.text, truncated: res.data.cut } : { kind: 'none', message: res.data && res.data.error };
        } else if (kind === 'pdf') {
          // The PDF's own text (read on this PC), like the indexed files; "Open PDF" shows the pages.
          const res = await api('/api/m/files/text?' + new URLSearchParams({ root: item.root, path: item.path }).toString());
          preview = res.ok && res.data && res.data.text != null
            ? { kind: 'pdf-text', text: res.data.text, truncated: res.data.cut }
            : { kind: 'none', message: res.data && res.data.error };
        } else if (kind === 'image') preview = { kind, src: await deps.blobUrl(rawHref(item)) };
        else if ((Number(item.bytes) || 0) <= MAX_TEXT_PREVIEW * 4) {
          const text = await fetchText(rawHref(item));
          preview = text == null ? { kind: 'none' } : { kind, text: text.slice(0, MAX_TEXT_PREVIEW), truncated: text.length > MAX_TEXT_PREVIEW };
        } else preview = { kind: 'big' };
      }
    }
    if (!S.detail || !S.detail.item || S.detail.item.key !== want) return;
    S.detail.preview = preview;
    S.detail.loading = false;
    drawPane();
  }

  async function fetchText(href) {
    try {
      return await deps.fetchText(href);
    } catch {
      return null;
    }
  }

  function paneRow(label, value) {
    const row = h('div', 'fx-prop');
    row.append(h('span', 'fx-prop-k', label));
    if (value && typeof value === 'object') row.append(value);
    else row.append(h('span', 'fx-prop-v', value == null || value === '' ? '—' : String(value)));
    return row;
  }

  function drawPane() {
    pane.textContent = '';
    pane.hidden = !prefs.pane;
    root.dataset.pane = paneMode(prefs.pane, S.detail);
    if (!prefs.pane) return;
    const d = S.detail;
    if (!d) {
      // Nothing selected: a narrow column with one line, not a wide empty one.
      pane.append(icon(S.loc.root === 'home' ? 'home' : 'folder', 'fx-pane-big'));
      pane.append(h('p', 'fx-pane-hint', 'Select a file to see who made it and a preview.'));
      return;
    }
    if (d.many) {
      pane.append(icon('copy', 'fx-pane-big'));
      pane.append(h('p', 'fx-pane-title', d.many.length + ' items selected'));
      pane.append(h('p', 'fx-pane-hint', formatSize(d.many.reduce((s, i) => s + (i.kind === 'file' ? Number(i.bytes) || 0 : 0), 0))));
      return;
    }
    const { item, stat, preview } = d;
    const top = h('div', 'fx-pane-head');
    top.append(icon(iconFor(item), 'fx-pane-ico'));
    const title = h('p', 'fx-pane-title', item.name);
    title.title = item.name;
    top.append(title);
    pane.append(top);

    const pv = h('div', 'fx-preview');
    pv.dataset.kind = preview ? preview.kind : 'none';
    if (d.loading && !preview) pv.append(h('p', 'fx-pane-hint', 'Loading preview…'));
    else if (!preview || preview.kind === 'none') pv.append(h('p', 'fx-pane-hint', item.kind === 'folder' ? (stat && stat.children != null ? stat.children + ' items' : 'Folder') : ((preview && preview.message) || 'No preview for this file.')));
    else if (preview.kind === 'big') pv.append(h('p', 'fx-pane-hint', 'Too big to preview here.'));
    else if (preview.kind === 'image') {
      const img = h('img', 'fx-preview-img');
      img.alt = item.name;
      img.src = preview.src;
      pv.append(img);
    } else if (preview.kind === 'pdf-text') {
      const pre = h('pre', 'fx-preview-text is-pdf', preview.text || '(no text in this PDF)');
      pre.tabIndex = 0;
      pre.setAttribute('aria-label', 'Text of ' + item.name);
      pv.append(pre);
    } else if (preview.kind === 'markdown') {
      const md = deps.md(preview.text || '');
      md.classList.add('fx-preview-md');
      pv.append(md);
    } else {
      const pre = h('pre', 'fx-preview-text' + (item.research ? ' is-prose' : ''), preview.text || '(empty file)');
      pre.tabIndex = 0;
      pv.append(pre);
    }
    if (preview && preview.truncated) pv.append(h('p', 'fx-pane-hint', 'Showing the first part only.'));
    pane.append(pv);

    const props = h('div', 'fx-props');
    props.append(paneRow('Type', typeLabel(item)));
    if (item.kind === 'file') props.append(paneRow('Size', formatSize(item.bytes)));
    props.append(paneRow(item.source === 'bin' ? 'Deleted' : 'Modified', formatDate(item.mtime)));
    if (stat && stat.location) props.append(paneRow('Location', stat.location));
    if (item.source === 'bin' && item.from) props.append(paneRow('From', item.from));
    if (item.source !== 'bin' && item.source !== 'root') {
      props.append(paneRow('Made by', stat && stat.agentId ? (stat.agentName || deps.agentLabel(stat.agentId)) : (madeBy(item) || 'You or the desk')));
      if (item.researchStatus) props.append(paneRow('Status', item.researchStatus));
      const chatVal = stat && stat.chatId ? (stat.chatTitle || 'A chat') : null;
      props.append(paneRow('From chat', chatVal));
    }
    pane.append(props);

    const acts = h('div', 'fx-pane-acts');
    if (item.source === 'fs') {
      const starred = Boolean(stat ? stat.starred : item.starred);
      const star = button(starred ? 'Starred' : 'Star', 'fx-act' + (starred ? ' is-on' : ''), () => void setMeta(item, { starred: !starred }), { icon: 'star', id: 'star' });
      star.setAttribute('aria-pressed', String(starred));
      acts.append(star);
    }
    if (item.source === 'fs' && stat && stat.chatId && deps.openChat) {
      acts.append(button('Open in Chat', 'fx-act', () => deps.openChat(stat.chatId), { icon: 'chat', id: 'open-chat' }));
    }
    const page = pageTarget(item);
    if (page) acts.append(button('Preview page', 'fx-act', () => void deps.previewPage(page.agentId, page.path), { icon: 'open', id: 'preview-page' }));
    const tt = toolState(S.loc, [item]);
    if (deps.openOnPc && tt.openApp) acts.append(button('Open in its app', 'fx-act', () => void deps.openOnPc(item, false), { icon: 'open', id: 'open-app' }));
    if (deps.openOnPc && tt.reveal) acts.append(button('Show in folder', 'fx-act', () => void deps.openOnPc(item, true), { icon: 'folder', id: 'reveal' }));
    if (item.source === 'fs' && previewKind(item) === 'pdf' && typeof window !== 'undefined') {
      acts.append(button('Open PDF', 'fx-act', async () => { const u = await deps.blobUrl(rawHref(item)); if (u) window.open(u, '_blank', 'noopener'); }, { icon: 'open', id: 'open-pdf' }));
    }
    if (item.source === 'fs' && item.kind === 'file') {
      acts.append(button('Download', 'fx-act', () => void deps.download(rawHref(item, true), item.name), { icon: 'download', id: 'download' }));
    }
    if (item.source === 'bin') acts.append(button('Restore', 'fx-act is-primary', () => void restoreSelected(), { icon: 'restore' }));
    pane.append(acts);
  }

  async function setMeta(item, patch) {
    const res = await api('/api/m/files/meta', { method: 'POST', body: { root: item.root, path: item.path, ...patch } });
    if (!res.ok) { toast((res.data && res.data.message) || 'Could not save that.', true); return; }
    if (patch.starred !== undefined) item.starred = patch.starred;
    if (S.detail && S.detail.item === item && S.detail.stat) Object.assign(S.detail.stat, patch);
    drawList();
    drawPane();
  }

  // ---- commands ----
  function errText(res, fallback) {
    return (res && res.data && (res.data.message || res.data.error)) || fallback;
  }

  async function newFolder() {
    if (!isFsRoot(S.loc.root)) return;
    const res = await api('/api/m/files/mkdir', { method: 'POST', body: { root: S.loc.root, path: S.loc.path, name: 'New folder' } });
    if (!res.ok) { toast(errText(res, 'Could not make a folder here.'), true); return; }
    await loadItems();
    const key = S.loc.root + '|' + res.data.path;
    const index = S.items.findIndex((i) => i.key === key);
    if (index >= 0) { selectOnly(index); S.renaming = key; drawList(); }
  }

  function startRename() {
    const sel = selectedItems();
    if (sel.length !== 1 || !toolState(S.loc, sel).rename) return;
    S.renaming = sel[0].key;
    drawList();
  }

  async function commitRename(item, value) {
    if (S.renaming !== item.key) return;
    S.renaming = null;
    const name = String(value || '').trim();
    if (!name || name === item.name) { drawList(); list.focus(); return; }
    const res = await api('/api/m/files/rename', { method: 'POST', body: { root: item.root, path: item.path, name } });
    if (!res.ok) { toast(errText(res, 'Could not rename it.'), true); drawList(); return; }
    toast('Renamed to “' + res.data.name + '”.');
    await loadItems();
    const index = S.items.findIndex((i) => i.key === item.root + '|' + res.data.path);
    if (index >= 0) selectOnly(index);
    list.focus();
  }

  function groupByRoot(items) {
    const out = new Map();
    for (const i of items) {
      if (!out.has(i.root)) out.set(i.root, []);
      out.get(i.root).push(i.path);
    }
    return out;
  }

  async function recycleSelected() {
    const sel = selectedItems().filter((i) => i.source === 'fs');
    if (!sel.length) return;
    const what = sel.length === 1 ? '“' + sel[0].name + '”' : sel.length + ' items';
    const ok = await confirmDialog('Move ' + what + ' to the Bin?', 'Nothing is deleted for good. You can restore it from the Bin.', 'Move to Bin');
    if (!ok) return;
    let moved = 0;
    for (const [rootId, paths] of groupByRoot(sel)) {
      const res = await api('/api/m/files/recycle', { method: 'POST', body: { root: rootId, paths } });
      if (!res.ok) { toast(errText(res, 'Could not move it to the Bin. Nothing changed.'), true); break; }
      moved += res.data.items.length;
    }
    if (moved) toast(moved === 1 ? 'Moved to the Bin.' : moved + ' items moved to the Bin.');
    S.selected.clear();
    await loadItems();
  }

  async function restoreSelected() {
    const sel = selectedItems().filter((i) => i.source === 'bin');
    if (!sel.length) return;
    let back = 0;
    for (const item of sel) {
      const res = await api('/api/m/files/restore', { method: 'POST', body: { id: item.binId } });
      if (!res.ok) { toast(errText(res, 'Could not restore “' + item.name + '”.'), true); continue; }
      back += 1;
    }
    if (back) toast(back === 1 ? 'Restored.' : back + ' items restored.');
    S.selected.clear();
    await loadItems();
  }

  async function pickDestination(copy) {
    const sel = selectedItems().filter((i) => i.source === 'fs');
    if (!sel.length) return;
    const dest = await folderPicker(copy ? 'Copy ' + (sel.length === 1 ? '“' + sel[0].name + '”' : sel.length + ' items') + ' to…' : 'Move ' + (sel.length === 1 ? '“' + sel[0].name + '”' : sel.length + ' items') + ' to…', copy ? 'Copy here' : 'Move here');
    if (!dest) return;
    let done = 0;
    for (const [rootId, paths] of groupByRoot(sel)) {
      const res = await api(copy ? '/api/m/files/copy' : '/api/m/files/move', { method: 'POST', body: { root: rootId, paths, toRoot: dest.root, toPath: dest.path } });
      if (!res.ok) { toast(errText(res, copy ? 'Could not copy.' : 'Could not move.'), true); break; }
      done += res.data.items.length;
    }
    if (done) toast((copy ? 'Copied ' : 'Moved ') + (done === 1 ? '1 item' : done + ' items') + ' to ' + rootLabel(dest.root) + (dest.path ? ' › ' + dest.path.split('/').join(' › ') : '') + '.');
    await loadItems();
  }

  function setSort(key, dir) {
    prefs.sort = key;
    prefs.dir = dir;
    savePrefs(prefs);
    S.items = sortItems(S.items, prefs.sort, prefs.dir);
    S.focus = -1;
    drawAll();
  }
  function setView(view) {
    prefs.view = view;
    savePrefs(prefs);
    drawAll();
  }
  function setSystem(on) {
    prefs.system = Boolean(on);
    savePrefs(prefs);
    S.selected.clear();
    S.detail = null;
    void loadItems();
  }
  function togglePane(force) {
    prefs.pane = typeof force === 'boolean' ? force : !prefs.pane;
    savePrefs(prefs);
    root.classList.toggle('has-pane', prefs.pane);
    drawTools();
    if (prefs.pane) void loadDetail(); else drawPane();
  }

  // ---- Allow access… (an approval card, never a silent read) ----
  async function allowAccess(rootId) {
    const r = rootById(rootId);
    const label = r ? r.label : rootId;
    const res = await api('/api/m/files/grants', { method: 'POST', body: { root: rootId } });
    if (!res.ok) { toast(errText(res, 'Could not ask for access.'), true); return; }
    if (res.data.granted) { await loadRoots(); navigate({ root: rootId }); return; }
    if (!res.data.approvalId) { toast(label + ' stays closed.'); return; }
    const ok = await confirmDialog(
      'Let the desk open ' + label + '?',
      'Files will list and open what is in ' + label + ', and agents may read it. You can close it again from here.',
      'Allow',
      'Not now',
    );
    try { await deps.decide(res.data.approvalId, ok ? 'approve' : 'deny'); } catch (e) { toast(e.message || 'The approval did not go through.', true); return; }
    if (!ok) { toast(label + ' stays closed.'); return; }
    await new Promise((r) => setTimeout(r, 150));
    await loadRoots();
    toast(label + ' is open.');
    navigate({ root: rootId, path: '' });
  }

  // ---- menus ----
  function menuItem(label, onClick, opts = {}) {
    const b = h('button', 'fx-menu-item' + (opts.danger ? ' is-danger' : ''));
    b.type = 'button';
    b.setAttribute('role', opts.checkbox != null ? 'menuitemcheckbox' : opts.checked != null ? 'menuitemradio' : 'menuitem');
    if (opts.checked != null) b.setAttribute('aria-checked', String(Boolean(opts.checked)));
    if (opts.checkbox != null) b.setAttribute('aria-checked', String(Boolean(opts.checkbox)));
    if (opts.icon) b.append(icon(opts.icon, 'fx-btn-ico'));
    b.append(h('span', null, label));
    if (opts.key) b.append(h('span', 'fx-menu-key', opts.key));
    b.disabled = Boolean(opts.disabled);
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); onClick(); });
    return b;
  }
  function itemMenu() {
    const sel = selectedItems();
    const t = toolState(S.loc, sel);
    const one = sel.length === 1 ? sel[0] : null;
    const items = [];
    if (S.loc.root === 'bin') {
      items.push(menuItem('Restore', () => void restoreSelected(), { icon: 'restore', disabled: !t.restore }));
      return items;
    }
    if (one) items.push(menuItem(one.kind === 'file' ? (opensInApp(one) ? 'Open in its app' : 'Preview') : 'Open', () => openItem(one), { icon: 'open', key: 'Enter' }));
    if (one && deps.openOnPc && t.openApp && !opensInApp(one)) items.push(menuItem('Open in its app', () => void deps.openOnPc(one, false), { icon: 'open' }));
    if (one && deps.openOnPc && t.reveal) items.push(menuItem('Show in folder', () => void deps.openOnPc(one, true), { icon: 'folder' }));
    const page = one && pageTarget(one);
    if (page) items.push(menuItem('Preview page', () => void deps.previewPage(page.agentId, page.path), { icon: 'open' }));
    if (one && one.source === 'fs') items.push(menuItem(one.starred ? 'Remove star' : 'Star', () => void setMeta(one, { starred: !one.starred }), { icon: 'star' }));
    items.push(h('div', 'fx-menu-sep'));
    items.push(menuItem('Rename', () => startRename(), { icon: 'rename', key: 'F2', disabled: !t.rename }));
    items.push(menuItem('Move to…', () => void pickDestination(false), { icon: 'move', disabled: !t.move }));
    items.push(menuItem('Copy to…', () => void pickDestination(true), { icon: 'copy', disabled: !t.copy }));
    items.push(h('div', 'fx-menu-sep'));
    items.push(menuItem('Delete (to the Bin)', () => void recycleSelected(), { icon: 'trash', key: 'Del', danger: true, disabled: !t.delete }));
    return items;
  }
  function folderMenu() {
    return [
      menuItem('New folder', () => void newFolder(), { icon: 'newfolder', disabled: !isFsRoot(S.loc.root) }),
      menuItem('Refresh', () => void refresh(), { icon: 'refresh', key: 'F5' }),
      h('div', 'fx-menu-sep'),
      ...viewMenu(),
    ];
  }
  function sortMenu() {
    return [
      ...SORT_KEYS.map(([id, label]) => menuItem(label, () => setSort(id, prefs.dir), { checked: prefs.sort === id })),
      h('div', 'fx-menu-sep'),
      menuItem('Ascending', () => setSort(prefs.sort, 'asc'), { checked: prefs.dir === 'asc' }),
      menuItem('Descending', () => setSort(prefs.sort, 'desc'), { checked: prefs.dir === 'desc' }),
    ];
  }
  function viewMenu() {
    const items = VIEWS.map(([id, label]) => menuItem(label, () => setView(id), { checked: prefs.view === id }));
    items.push(h('div', 'fx-menu-sep'));
    items.push(menuItem('Preview pane', () => togglePane(), { checkbox: prefs.pane }));
    return items;
  }
  function openMenu(items, anchor, event) {
    menu.textContent = '';
    items.forEach((n) => menu.append(n));
    menu.hidden = false;
    const box = root.getBoundingClientRect();
    let x;
    let y;
    if (event) { x = event.clientX - box.left; y = event.clientY - box.top; } else if (anchor) {
      const a = anchor.getBoundingClientRect();
      const mw = menu.offsetWidth || 220;
      // A menu from a button on the right opens leftwards, so it stays inside the window.
      x = a.left - box.left + mw > box.width - 4 ? a.right - box.left - mw : a.left - box.left;
      y = a.bottom - box.top + 4;
    } else { x = 40; y = 40; }
    const w = menu.offsetWidth || 220;
    const hgt = menu.offsetHeight || 200;
    menu.style.left = Math.max(4, Math.min(x, box.width - w - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, box.height - hgt - 4)) + 'px';
    const first = menu.querySelector('button:not([disabled])');
    if (first) first.focus();
  }
  function closeMenu() {
    menu.hidden = true;
    menu.textContent = '';
  }
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('button:not([disabled])')];
    const i = btns.indexOf(doc.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1]).focus(); }
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); list.focus(); }
  });
  doc.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });

  // ---- dialogs ----
  function closeDialog(value) {
    dialog.hidden = true;
    dialog.textContent = '';
    const done = dialog._resolve;
    dialog._resolve = null;
    if (done) done(value);
  }
  function openDialog(build) {
    if (dialog._resolve) closeDialog(null);
    dialog.textContent = '';
    const box = h('div', 'fx-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    dialog.append(box);
    dialog.hidden = false;
    return new Promise((resolve) => {
      dialog._resolve = resolve;
      build(box, (v) => closeDialog(v));
    });
  }
  function confirmDialog(title, text, yes, no = 'Cancel') {
    return openDialog((box, done) => {
      const t = h('h3', 'fx-dialog-title', title);
      t.id = 'fx-dialog-title';
      box.setAttribute('aria-labelledby', t.id);
      box.append(t, h('p', 'fx-dialog-text', text));
      const row = h('div', 'fx-dialog-acts');
      const cancel = button(no, 'fx-act', () => done(false));
      const ok = button(yes, 'fx-act is-primary', () => done(true));
      ok.dataset.confirm = '1';
      row.append(cancel, ok);
      box.append(row);
      setTimeout(() => ok.focus(), 0);
    });
  }
  function folderPicker(title, yes) {
    return openDialog((box, done) => {
      const t = h('h3', 'fx-dialog-title', title);
      box.append(t);
      const where = h('p', 'fx-dialog-text');
      const folders = h('div', 'fx-pick');
      const row = h('div', 'fx-dialog-acts');
      let at = isFsRoot(S.loc.root) ? { root: S.loc.root, path: S.loc.path } : null;
      async function draw() {
        folders.textContent = '';
        if (!at) {
          where.textContent = 'Choose a folder';
          S.roots.filter((r) => r.granted && r.id !== 'bin').forEach((r) => {
            folders.append(button(r.label, 'fx-pick-row', () => { at = { root: r.id, path: '' }; void draw(); }, { icon: iconFor({ kind: 'root', ...r }) }));
          });
          okBtn.disabled = true;
          return;
        }
        where.textContent = rootLabel(at.root) + (at.path ? ' › ' + at.path.split('/').join(' › ') : '');
        okBtn.disabled = false;
        folders.append(button('Up', 'fx-pick-row is-up', () => { at = parentOf(at); void draw(); }, { icon: 'up' }));
        const res = await api('/api/m/files/list?' + new URLSearchParams({ root: at.root, path: at.path }).toString());
        const subs = res.ok && res.data ? sortItems((res.data.items || []).filter((i) => i.kind === 'folder'), 'name') : [];
        subs.forEach((f) => folders.append(button(f.name, 'fx-pick-row', () => { at = { root: at.root, path: f.path }; void draw(); }, { icon: 'folder' })));
        if (!subs.length) folders.append(h('p', 'fx-pane-hint', 'No folders inside.'));
      }
      const cancel = button('Cancel', 'fx-act', () => done(null));
      const okBtn = button(yes, 'fx-act is-primary', () => done(at));
      okBtn.dataset.confirm = '1';
      row.append(cancel, okBtn);
      box.append(where, folders, row);
      void draw();
    });
  }
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(null); });

  // ---- start ----
  void (async () => {
    await loadRoots();
    await loadItems();
  })();

  return {
    root,
    refresh,
    open: (loc) => navigate(loc),
    /** Open the folder a workspace file is in and select it (a file card's link). */
    reveal: (rootId, filePath) => { const parts = String(filePath || '').split('/').filter(Boolean); const name = parts.pop(); S.pendingSelect = name ? [...parts, name].join('/') : null; navigate({ root: rootId, path: parts.join('/') }); },
    state: S,
  };
}
