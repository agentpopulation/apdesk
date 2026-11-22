// The shell kit. Every module page gets this object as `ui`. Plain DOM, no framework.
// The window's token. In the open desk (one person, no PIN) the page is served with it in the meta tag; otherwise a
// window gets its token by entering (People chooser), and we keep it for this window alone in sessionStorage so a reload
// stays with the same person. It is read at call time, so entering, switching or locking takes effect at once.
let SESSION = document.querySelector('meta[name="apd-session"]')?.content || '';
try { if (!SESSION) SESSION = sessionStorage.getItem('apd-session') || ''; } catch {}
export const session = () => SESSION;
export const setSession = (t) => { SESSION = t || ''; try { if (SESSION) sessionStorage.setItem('apd-session', SESSION); else sessionStorage.removeItem('apd-session'); } catch {} };
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** h('div', { class: 'card', onclick }, child, 'text', [more]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;                 // caller is responsible: only pass trusted or escaped markup
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
  children.forEach(add);
  return el;
}

export async function api(path, { method, body, signal, raw } = {}) {
  const url = path.startsWith('/') ? path : '/api/' + path;
  const opts = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'x-apd-session': SESSION }, signal };
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
    else { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const r = await fetch(url, opts);
  if (raw) return r;
  let data = null; const text = await r.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  if (!r.ok) throw Object.assign(new Error(data?.error || `Request failed (${r.status})`), { status: r.status, data });
  return data;
}
/** POST and read an NDJSON stream line by line (model replies). Returns the last line. */
export async function apiStream(path, body, onLine, { signal } = {}) {
  const r = await fetch(path.startsWith('/') ? path : '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-apd-session': SESSION }, body: JSON.stringify(body), signal });
  if (!r.ok) { let e = null; try { e = await r.json(); } catch {} throw Object.assign(new Error(e?.error || `Request failed (${r.status})`), { status: r.status }); }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let last = null;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { last = JSON.parse(line); onLine?.(last); } catch {} }
  }
  return last;
}

// ---- small pieces, same look as the preview
export const pill = (text, kind = '') => h('span', { class: 'pill ' + kind }, text);                 // kind: run | ok | wait | stop
export const btn = (text, { kind = '', onClick, title, disabled, type = 'button', ...rest } = {}) => h('button', { class: 'btn ' + kind, type, title, disabled, onclick: onClick, ...rest }, text);   // kind: '' | ghost | sm | 'ghost sm' | stop | ok
export const card = (attrs, ...children) => { if (attrs instanceof Node || typeof attrs === 'string' || Array.isArray(attrs)) return h('div', { class: 'card' }, attrs, ...children); const { class: c = '', ...rest } = attrs || {}; return h('div', { class: 'card ' + c, ...rest }, ...children); };
export function meter(p, { live = false, style } = {}) { const b = h('b', { class: live ? 'live' : '', style: { width: Math.round(Math.max(0, Math.min(1, p)) * 100) + '%' } }); const m = h('div', { class: 'meter', style }, b); m.set = (v) => { b.style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%'; }; return m; }
export function sw(on, label, onChange, attrs = {}) { const b = h('button', { class: 'sw', type: 'button', 'aria-pressed': String(!!on), 'aria-label': label, ...attrs, onclick: async () => { const next = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(next)); try { const r = await onChange?.(next); if (r === false) b.setAttribute('aria-pressed', String(!next)); } catch (e) { b.setAttribute('aria-pressed', String(!next)); toast(e.message, 'err'); } } }); return b; }
export function seg(options, index = 0, onChange) { const el = h('div', { class: 'seg' }, options.map((o, i) => h('button', { type: 'button', 'aria-pressed': String(i === index), onclick: () => { [...el.children].forEach((x, k) => x.setAttribute('aria-pressed', String(k === i))); onChange?.(o, i); } }, o))); el.set = (i) => [...el.children].forEach((x, k) => x.setAttribute('aria-pressed', String(k === i))); return el; }
export const line = (title, desc, ...right) => h('div', { class: 'line' }, h('div', null, h('b', null, title), desc ? h('span', { class: 'd' }, desc) : null), ...right);
export const av = (name, cls = '') => h('span', { class: 'av ' + cls }, String(name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase());
export const empty = (text) => h('div', { class: 'empty' }, text);
export const spinner = () => h('span', { class: 'spin', 'aria-label': 'Working' });
/** table([{ key, label, render?(row) }], rows, { onRow }) */
export function table(cols, rows, { onRow, empty: emptyText = 'Nothing here yet.' } = {}) {
  if (!rows?.length) return empty(emptyText);
  return h('div', { class: 'scroll' }, h('table', null,
    h('thead', null, h('tr', null, cols.map(c => h('th', null, c.label ?? c.key)))),
    h('tbody', null, rows.map(r => h('tr', { class: onRow ? 'pick' : '', onclick: onRow ? () => onRow(r) : null }, cols.map(c => h('td', null, c.render ? c.render(r) : (r[c.key] ?? ''))))))));
}

/** A status chip: kind live (answers, on, saved) | slow | run (running) | fail | off. */
export const statusChip = (text, kind = 'off') => h('span', { class: 'schip ' + kind }, text);

// ---- the mark beside a field that saves by itself. Every automatic save answers back at once, in plain sight:
// "Saving…" while it saves, then a small drawn tick whose hover text and name say "Saved", or a cross with the reason when
// it did not save (the field gets its old value back). One helper, so every page shows a save the same way.
const TICK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5 8.3 14 15.5 6"/></svg>';
const CROSS = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>';
export function savedMark() {
  const m = h('span', { class: 'saved', role: 'status', 'aria-live': 'polite' });
  const show = (state, html, words, title) => {
    clearTimeout(m._t); m.className = 'saved' + (state ? ' ' + state : ''); m.dataset.saved = state || '';
    m.innerHTML = html; if (words) m.append(h('span', { class: state === 'ok' ? 'vh' : '' }, words));
    if (title) { m.title = title; m.setAttribute('aria-label', title); } else { m.removeAttribute('title'); m.removeAttribute('aria-label'); }
  };
  m.saving = () => show('busy', '<span class="spin" aria-hidden="true"></span>', 'Saving…', 'Saving…');
  m.ok = (word = 'Saved') => { show('ok', TICK, word, word); m._t = setTimeout(() => show('', '', '', ''), 4000); };
  m.fail = (reason) => show('err', CROSS, 'Not saved: ' + (reason || 'it did not save'), 'Not saved: ' + (reason || 'it did not save'));
  m.clear = () => show('', '', '', '');
  /** Run one save: Saving…, then the tick or the cross. With field, a failed save puts the field's old value back. */
  m.run = async (save, { field, old, word } = {}) => {
    m.saving();
    try { const r = await save(); if (r === false) throw new Error('it did not save'); m.ok(word); return true; }
    catch (e) { if (field && old !== undefined) { if (field.type === 'checkbox') field.checked = !!old; else field.value = old ?? ''; } m.fail(e?.message); return false; }
  };
  return m;
}

// ---- what the desk is doing now, for the footer line: a page announces an activity when it starts and ends it when done.
//   const end = ui.announce('Scanning this PC…'); try { … } finally { end(); }
const acts = new Map(); const actFns = new Set(); let actSeq = 0;
const tellActs = () => { for (const fn of actFns) { try { fn(activities()); } catch {} } };
export function announce(text) {
  const id = ++actSeq; acts.set(id, { id, text: String(text || ''), at: Date.now() }); tellActs();
  let ended = false; return () => { if (ended) return; ended = true; acts.delete(id); tellActs(); };
}
export const activities = () => [...acts.values()];
export const onActivity = (fn) => { actFns.add(fn); return () => actFns.delete(fn); };

// ---- feedback
export function toast(text, kind = '', ms = 0) { const t = h('div', { class: 'toast ' + kind }, text); $('#toasts').append(t); setTimeout(() => t.remove(), ms || (kind === 'err' ? 7000 : 3500)); return t; }
export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const host = $('#modal');
  const opener = document.activeElement;
  // closing hands the focus back to what opened the dialog
  const close = (v) => { host.hidden = true; host.replaceChildren(); host._close = null; onClose?.(v); if (opener && opener !== document.body && opener.isConnected) opener.focus?.({ preventScroll: true }); };
  host._close = close; host._hash = location.hash;   // the shell closes a pop-up left open when the owner moves to another page
  const box = h('div', { class: 'card', style: wide ? { maxWidth: '860px' } : null },
    title ? h('h3', null, title) : null,
    typeof body === 'string' ? h('p', { class: 'sub' }, body) : body,
    h('div', { class: 'row' }, h('span', { class: 'grow' }), actions.map(a => btn(a.label, { kind: a.kind || 'ghost', onClick: async () => { const r = await a.onClick?.(); if (r !== false) close(a.value); } }))));
  host.replaceChildren(box); host.hidden = false;
  host.onclick = (e) => { if (e.target === host) close(undefined); };
  // the first button is the safe one (Cancel, Close), so Enter never lands on a destructive choice by itself
  setTimeout(() => { if (host._close === close && !box.contains(document.activeElement)) box.querySelector('.row button')?.focus({ preventScroll: true }); }, 0);
  return { close, box };
}
// Esc closes the dialog on top and nothing under it; the shell's pop-up list waits for the next press.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('keydown', (e) => {
  const host = document.getElementById('modal');
  if (e.key !== 'Escape' || e.shiftKey || !host || host.hidden || !host._close) return;
  e.preventDefault(); e.stopImmediatePropagation(); host._close(undefined);
}, true);
export const confirm = (text, { ok = 'Yes', cancel = 'Cancel', title = 'Are you sure?', kind = '' } = {}) => new Promise((resolve) => modal({ title, body: text, actions: [{ label: cancel, onClick: () => resolve(false) }, { label: ok, kind, onClick: () => resolve(true) }], onClose: () => resolve(false) }));
export const ask = (title, { value = '', placeholder = '', ok = 'Save', multiline = false } = {}) => new Promise((resolve) => {
  const input = multiline ? h('textarea', { placeholder }, value) : h('input', { type: 'text', value, placeholder, style: { width: '100%' } });
  modal({ title, body: input, actions: [{ label: 'Cancel', onClick: () => resolve(null) }, { label: ok, kind: '', onClick: () => resolve(input.value) }], onClose: () => resolve(null) });
  setTimeout(() => input.focus(), 30);
});

// ---- formatting in the owner's zone and currency (never UTC or $ unless the owner chose them)
let prefs = { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, currency: '' };   // the computer's own until settings load; no guessed currency
export const setPrefs = (p) => { prefs = { ...prefs, ...p }; };
export const fmt = {
  time: (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleTimeString(prefs.locale, { hour: 'numeric', minute: '2-digit', timeZone: prefs.timeZone }); },
  date: (iso) => { if (!iso) return ''; return new Date(iso).toLocaleDateString(prefs.locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: prefs.timeZone }); },
  when: (iso) => { if (!iso) return ''; const d = new Date(iso); const same = d.toDateString() === new Date().toDateString(); return same ? fmt.time(iso) : d.toLocaleDateString(prefs.locale, { day: 'numeric', month: 'short', timeZone: prefs.timeZone }) + ', ' + fmt.time(iso); },
  ago: (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago'; },
  money: (minor, currency = prefs.currency) => { const n = (Number(minor) || 0) / 100; try { return new Intl.NumberFormat(prefs.locale, currency ? { style: 'currency', currency, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 }).format(n); } catch { return currency ? `${currency} ${n}` : String(n); } },
  bytes: (n) => { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; },
  pct: (p) => Math.round((Number(p) || 0) * 100) + '%',
};

/** A small, safe Markdown renderer: escapes first, then formats. Returns an element with class "md". */
export function md(text) {
  const src = String(text ?? '');
  const blocks = []; let s = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => { blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = esc(s);
  const inline = (t) => t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  const out = []; const lines = s.split('\n'); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\u0000\d+\u0000$/.test(l.trim())) { out.push(blocks[Number(l.trim().replace(/\u0000/g, ''))]); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const row = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(row(lines[i])); i++; }
      out.push(`<div class="scroll"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const hm = l.match(/^(#{1,4})\s+(.*)$/); if (hm) { out.push(`<h${Math.min(3, hm[1].length)}>${inline(hm[2])}</h${Math.min(3, hm[1].length)}>`); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l); const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { items.push(inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))); i++; }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(x => `<li>${x}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (/^&gt;\s?/.test(l)) { const q = []; while (i < lines.length && /^&gt;\s?/.test(lines[i])) { q.push(inline(lines[i].replace(/^&gt;\s?/, ''))); i++; } out.push(`<blockquote>${q.join('<br>')}</blockquote>`); continue; }
    if (!l.trim()) { i++; continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s|^\s*([-*•]|\d+[.)])\s+|^\u0000\d+\u0000$|^&gt;/.test(lines[i]) && !(/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || ''))) { para.push(inline(lines[i])); i++; }
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return h('div', { class: 'md', html: out.join('') });
}
