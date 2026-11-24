// The phone page: link once with the code from the desk, then Yes or No on what waits for you. Every answer on screen is
// the desk's own: a decision shows as made only when the desk says it was made.
const KEY = 'apd-phone';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const token = { get: () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }, set: (v) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch {} } };
const say = (node, text, kind = '') => { node.textContent = text || ''; node.className = 'msg' + (kind ? ' ' + kind : ''); };

async function call(path, body) {
  const headers = { 'content-type': 'application/json' }; const t = token.get(); if (t) headers.authorization = 'Bearer ' + t;
  let r; try { r = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
  catch { return { status: 0, json: { error: 'The desk did not answer. Is the PC on, on this Wi-Fi?' } }; }
  let json = {}; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

function showLink(msg) { $('link').hidden = false; $('list').hidden = true; $('who').textContent = ''; say($('linkmsg'), msg || '', msg ? 'err' : ''); }

async function link() {
  const b = $('go'); b.disabled = true; say($('linkmsg'), 'Linking…');
  const r = await call('/link', { code: $('code').value, name: $('name').value });
  b.disabled = false;
  if (r.status !== 200 || !r.json.token) return say($('linkmsg'), r.json.error || 'That did not work. Try again.', 'err');
  token.set(r.json.token); $('code').value = '';
  await refresh();
}

function card(it) {
  const c = el('div', 'card');
  c.append(el('div', 'title', it.title), el('div', 'what', [it.who, it.what, it.detail, it.amount, it.asked].filter(Boolean).join(' · ')));
  const rows = el('div', 'rows'); rows.hidden = true;
  const msg = el('p', 'msg'); msg.setAttribute('role', 'status');
  if (it.more) {
    const show = el('button', 'ghost', 'Show what it covers'); show.type = 'button';
    show.onclick = async () => {
      if (!rows.hidden) { rows.hidden = true; show.textContent = 'Show what it covers'; return; }
      show.disabled = true; const r = await call('/show/' + encodeURIComponent(it.id)); show.disabled = false;
      if (r.status !== 200) return say(msg, r.json.error || 'That did not work. Try again.', 'err');
      rows.replaceChildren(...r.json.rows.map(([k, v]) => { const d = el('div'); if (k) d.append(el('span', null, k)); d.append(document.createTextNode(v)); return d; }));
      rows.hidden = false; show.textContent = 'Hide';
    };
    c.append(show, rows);
  }
  if (it.atDesk) c.append(el('p', 'desk', 'Decide this at the desk.'));
  else {
    const btns = el('div', 'btns');
    const no = el('button', 'no', 'No'); no.type = 'button';
    const yes = el('button', null, 'Yes'); yes.type = 'button';
    const decide = async (decision) => {
      yes.disabled = no.disabled = true; say(msg, 'Sending…');
      const r = await call('/decide/' + encodeURIComponent(it.id), { decision });
      if (r.status === 200) { say(msg, r.json.said, 'ok'); btns.remove(); setTimeout(refresh, 1500); return; }
      if (r.json.already) { say(msg, r.json.error, ''); btns.remove(); setTimeout(refresh, 1500); return; }
      yes.disabled = no.disabled = false; say(msg, r.json.error || 'That did not work. Try again.', 'err');
    };
    no.onclick = () => decide('deny'); yes.onclick = () => decide('approve');
    btns.append(no, yes); c.append(btns);
  }
  c.append(msg);
  return c;
}

let busy = false;
async function refresh() {
  if (busy) return; busy = true;
  try {
    if (!token.get()) return showLink('');
    const r = await call('/list');
    if (r.status === 401) { token.set(''); return showLink(r.json.error); }
    $('link').hidden = true; $('list').hidden = false;
    if (r.status !== 200) return say($('listmsg'), r.json.error || 'The desk did not answer. Try again.', 'err');
    $('who').textContent = `${r.json.person} · ${r.json.device}`;
    if (r.json.stopped) { say($('listmsg'), r.json.stopped, 'err'); $('items').replaceChildren(); return; }
    say($('listmsg'), r.json.items.length ? '' : 'Nothing is waiting for you.');
    $('items').replaceChildren(...r.json.items.map(card));
  } finally { busy = false; }
}

addEventListener('DOMContentLoaded', () => {
  $('go').onclick = link;
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') link(); });
  $('again').onclick = refresh;
  $('unlink').onclick = async () => { await call('/unlink', {}); token.set(''); showLink(''); };
  refresh();
  setInterval(() => { if (document.visibilityState === 'visible' && !document.querySelector('.rows:not([hidden])')) refresh(); }, 15000);   // an open "show" stays open
});
