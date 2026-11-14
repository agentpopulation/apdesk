// The Files explorer's model (Home is the workspace).
// SPDX-License-Identifier: Apache-2.0
/**
 * Settings › File manager (Explorer layout): pure helpers. No DOM here, so Node tests cover them.
 * The view is drawn by file-explorer.js; the server side is desk/lib/explorer.js.
 */

export const VIEWS = Object.freeze([
  Object.freeze(['details', 'Details']),
  Object.freeze(['tiles', 'Tiles']),
  Object.freeze(['icons', 'Large icons']),
]);
export const SORT_KEYS = Object.freeze([
  Object.freeze(['name', 'Name']),
  Object.freeze(['mtime', 'Date modified']),
  Object.freeze(['type', 'Type']),
  Object.freeze(['bytes', 'Size']),
]);
/** The old File manager filters, kept as the tree's Quick access group (GET /api/files?status=). */
export const QUICK_ACCESS = Object.freeze([]);
export const PLACE_ICONS = Object.freeze({ downloads: 'download', documents: 'doc', desktop: 'desktop' });
export const READER_LABELS = Object.freeze({ chief: 'Only Chief', all: 'All agents' });

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'js', 'mjs', 'ts', 'py', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'sh', 'ps1', 'sql', 'ini', 'toml', 'env', 'rs', 'go', 'java', 'c', 'cpp', 'h']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

const TYPE_NAMES = {
  md: 'Markdown file', markdown: 'Markdown file', txt: 'Text document', log: 'Log file',
  pdf: 'PDF document', doc: 'Word document', docx: 'Word document', rtf: 'Rich text document', odt: 'Text document',
  xls: 'Excel sheet', xlsx: 'Excel sheet', csv: 'CSV file', tsv: 'TSV file', ods: 'Sheet',
  ppt: 'PowerPoint slides', pptx: 'PowerPoint slides',
  png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image', svg: 'SVG image', bmp: 'Bitmap image', heic: 'HEIC image',
  mp4: 'MP4 video', mov: 'QuickTime video', webm: 'WebM video', mkv: 'MKV video',
  mp3: 'MP3 audio', wav: 'WAV audio', m4a: 'M4A audio', ogg: 'Ogg audio',
  zip: 'ZIP archive', '7z': '7-Zip archive', rar: 'RAR archive', gz: 'GZ archive', tar: 'TAR archive',
  js: 'JavaScript file', mjs: 'JavaScript file', ts: 'TypeScript file', py: 'Python file', json: 'JSON file',
  css: 'CSS file', html: 'HTML page', htm: 'HTML page', xml: 'XML file', yml: 'YAML file', yaml: 'YAML file',
  sh: 'Shell script', ps1: 'PowerShell script', sql: 'SQL file', exe: 'Application', msi: 'Installer', eml: 'Email',
};

export function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** "Markdown file", "File folder", "PNG image", else "XYZ file". */
export function typeLabel(item) {
  if (!item) return '';
  if (item.kind === 'folder' || item.kind === 'root') return item.kind === 'root' ? (item.group === 'pc' ? 'Drive' : 'Folder') : 'File folder';
  if (item.type === 'chats') return 'Saved chat';
  if (item.type === 'records') return 'Work record';
  if (item.research === true) return 'Research';
  const ext = item.ext || extOf(item.name);
  if (TYPE_NAMES[ext]) return TYPE_NAMES[ext];
  return ext ? ext.toUpperCase() + ' file' : 'File';
}

/** Icon id for a row (file-explorer.js draws the SVG and picks the token colour). */
export function iconFor(item) {
  if (!item) return 'file';
  if (item.kind === 'root') {
    if (item.group === 'agents') return 'agent';
    if (item.group === 'pc') return 'drive';
    if (item.id === 'bin') return 'bin';
    return PLACE_ICONS[item.id] || 'folder';
  }
  if (item.kind === 'folder') return 'folder';
  if (item.type === 'chats') return 'chat';
  if (item.type === 'records') return 'recent';
  const ext = item.ext || extOf(item.name);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.has(ext) || ext === 'heic') return 'image';
  if (['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(ext)) return 'sheet';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return 'audio';
  if (['zip', '7z', 'rar', 'gz', 'tar'].includes(ext)) return 'archive';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['js', 'mjs', 'ts', 'py', 'json', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'sh', 'ps1', 'sql', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(ext)) return 'code';
  if (['doc', 'docx', 'rtf', 'odt', 'txt', 'log', 'eml', 'ppt', 'pptx'].includes(ext)) return 'doc';
  return 'file';
}

/** What the preview pane can show: text | markdown | image | pdf | null. */
export function previewKind(item) {
  if (!item || item.kind !== 'file') return null;
  const ext = item.ext || extOf(item.name);
  if (['docx', 'xlsx', 'pptx'].includes(ext)) return 'office';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  if (item.source === 'index') return 'text';
  return null;
}

export function formatSize(bytes) {
  if (bytes == null || bytes === '') return '';
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return n + ' bytes';
}

/** "08-11-2026 14:05" style, in the PC's own locale. Empty for no date. */
export function formatDate(value, locale) {
  const t = Date.parse(value || '');
  if (!Number.isFinite(t)) return '';
  try {
    return new Date(t).toLocaleString(locale || undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Folders first (like Explorer), then the chosen column; name breaks ties. */
export function sortItems(items, key = 'name', dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
  const value = (item) => {
    if (key === 'mtime') return Date.parse(item.mtime || '') || 0;
    if (key === 'bytes') return Number(item.bytes) || 0;
    if (key === 'type') return typeLabel(item).toLowerCase();
    return null;
  };
  return items.slice().sort((a, b) => {
    const fa = a.kind === 'folder' || a.kind === 'root' ? 0 : 1;
    const fb = b.kind === 'folder' || b.kind === 'root' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if (key === 'name') return sign * byName(a, b);
    const va = value(a);
    const vb = value(b);
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return byName(a, b);
  });
}

/** Status bar: "12 items · 4.2 MB" or "12 items · 3 selected · 1.1 MB". */
export function statusLine(items, selected = []) {
  const n = items.length;
  const label = n === 1 ? '1 item' : n + ' items';
  const pick = selected.length ? selected : items;
  const bytes = pick.reduce((s, i) => s + (i.kind === 'file' ? Number(i.bytes) || 0 : 0), 0);
  const parts = [label];
  if (selected.length) parts.push(selected.length + ' selected');
  if (bytes) parts.push(formatSize(bytes));
  return parts.join(' · ');
}

/** Keyboard: next focused index for a key in a list of n rows (cols > 1 for icon grids). */
export function nextIndex(key, index, n, cols = 1) {
  if (!n) return -1;
  const i = index < 0 ? -1 : index;
  if (key === 'ArrowDown') return Math.min(n - 1, i < 0 ? 0 : i + cols);
  if (key === 'ArrowUp') return Math.max(0, i < 0 ? 0 : i - cols);
  if (key === 'ArrowRight' && cols > 1) return Math.min(n - 1, i + 1);
  if (key === 'ArrowLeft' && cols > 1) return Math.max(0, i - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  if (key === 'PageDown') return Math.min(n - 1, Math.max(0, i) + 10);
  if (key === 'PageUp') return Math.max(0, i - 10);
  return i;
}

/** The folder above a location, or null at the top of a root / a virtual view. */
export function parentOf(loc) {
  if (!loc || !loc.root) return null;
  if (!loc.path) return String(loc.root).startsWith('agent:') ? { root: 'home', path: 'agents' } : null;
  const parts = String(loc.path).split('/').filter(Boolean);
  parts.pop();
  return { root: loc.root, path: parts.join('/') };
}

export function isFsRoot(root) {
  const r = String(root || '');
  return r === 'home' || r.startsWith('agent:') || r.startsWith('drive:') || ['downloads', 'documents', 'desktop'].includes(r);
}

/** Office files and archives have no preview here: Open hands them to the PC's own app (doc-export). */
const APP_ONLY = /\.(?:docx?|docm|xlsx?|xlsm|pptx?|odt|ods|odp|rtf|epub|zip|7z|rar)$/i;

/** True when this row can open on the PC (POST /api/explorer/open, or /api/file-open by row id). */
export function pcOpenable(item) {
  if (!item) return false;
  if (item.source === 'fs') return item.kind === 'file' || item.kind === 'folder';
  return item.source === 'index' && item.pc === true;
}

/** True when Open (double-click, Enter) should go straight to the PC's app instead of the preview. */
export function opensInApp(item) {
  if (!item || item.kind !== 'file') return false;
  if (item.source === 'index') return item.opensOnPc === true;
  return item.source === 'fs' && APP_ONLY.test(String(item.name || ''));
}

/** Which toolbar buttons work for the current view and selection. */
export function toolState(loc, selected = []) {
  const fs = isFsRoot(loc && loc.root);
  const mixed = loc && (loc.root === 'recent' || loc.root === 'starred');
  const editable = selected.length > 0 && selected.every((i) => i.source === 'fs');
  return {
    newFolder: fs,
    rename: editable && selected.length === 1 && (fs || mixed),
    move: editable && (fs || mixed),
    copy: editable && (fs || mixed),
    delete: editable && (fs || mixed),
    restore: loc && loc.root === 'bin' && selected.length > 0 && selected.every((i) => i.restorable !== false),
    openApp: selected.length === 1 && pcOpenable(selected[0]) && selected[0].kind === 'file',
    reveal: selected.length === 1 && pcOpenable(selected[0]),
  };
}

export function sameLoc(a, b) {
  return Boolean(a && b && a.root === b.root && (a.path || '') === (b.path || '') && (a.q || '') === (b.q || ''));
}

/*
 * Viewer prefs (localStorage apd.files.explorer): newest first by default, and
 * agents' own settings files hidden unless "Show system files" is on. PREFS_VERSION 2 resets a sort
 * that older builds saved as a side effect (they wrote Name ↑ whenever any pref changed).
 */
export const PREFS_VERSION = 2;
export const DEFAULT_PREFS = Object.freeze({ view: 'details', sort: 'mtime', dir: 'desc', pane: true, system: false, treeW: 210, paneW: 300 });

export function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const current = p.v === PREFS_VERSION;
  return {
    v: PREFS_VERSION,
    view: VIEWS.some(([id]) => id === p.view) ? p.view : DEFAULT_PREFS.view,
    sort: current && SORT_KEYS.some(([id]) => id === p.sort) ? p.sort : DEFAULT_PREFS.sort,
    dir: current && (p.dir === 'asc' || p.dir === 'desc') ? p.dir : DEFAULT_PREFS.dir,
    pane: p.pane !== false,
    system: p.system === true,
    treeW: Math.max(150, Math.min(420, Number(p.treeW) || DEFAULT_PREFS.treeW)),
    paneW: Math.max(220, Math.min(560, Number(p.paneW) || DEFAULT_PREFS.paneW)),
  };
}

/** An agent's own settings file (guardrails.json, kpis.json, …): the server marks it `system`. */
export function isSystemItem(item) {
  return Boolean(item && item.system === true);
}

/**
 * "Made by" for a row: the agent's name from the server, else the agent whose folder it sits in,
 * else "You" for a file in a folder you opened, else empty (Desk's own records).
 */
export function madeByLabel(item, agentLabel) {
  if (!item || item.kind === 'root' || item.kind === 'folder' || item.source === 'bin') return '';
  if (item.madeBy) return String(item.madeBy);
  const label = (id) => (typeof agentLabel === 'function' ? agentLabel(id) : id) || id;
  if (item.agentId) return label(item.agentId);
  const root = String(item.root || '');
  if (item.source === 'fs' && root.startsWith('agent:')) return label(root.slice(6));
  if (item.source === 'fs' && root === 'home') return '';
  if (item.source === 'fs') return 'You';
  return '';
}

/** Right pane: 'off' (toggled off), 'idle' (narrow, nothing selected) or 'open'. */
export function paneMode(paneOn, detail) {
  if (!paneOn) return 'off';
  return detail ? 'open' : 'idle';
}

/** Status-bar note for hidden settings files, or '' when none are hidden. */
export function systemNote(hidden, showing) {
  if (showing) return 'Showing system files';
  const n = Number(hidden) || 0;
  if (!n) return '';
  return n === 1 ? '1 system file hidden' : n + ' system files hidden';
}
