// Settings › Accounts and lock, and the lock overlay. The manifest says "boot": true, so the shell loads this file at start
// and the overlay is installed once for the whole page.
const A = '/api/m/accounts';

function lockManager() {
  if (window.__apdLock) return window.__apdLock;
  const ui = window.apd;
  const { h } = ui;
  let el = null, st = null, lastInput = Date.now(), lastPing = 0, alive = true;
  const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'PIN', id: 'lock-pin', style: { width: '180px', textAlign: 'center', fontSize: '18px', letterSpacing: '.2em' } });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'Code from your app', id: 'lock-code', style: { width: '180px', textAlign: 'center' } });
  const msg = h('div', { class: 'sub', id: 'lock-msg', style: { minHeight: '18px' } });
  const unlock = async () => {
    msg.textContent = '';
    try { st = await ui.api('m/accounts/unlock', { body: { pin: pin.value, code: code.value } }); pin.value = ''; code.value = ''; paint(); }
    catch (e) { msg.textContent = e.message; pin.value = ''; pin.focus(); }
  };
  for (const i of [pin, code]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  const build = () => h('div', { id: 'apd-lock', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'The desk is locked', style: { position: 'fixed', inset: '0', zIndex: '2147483000', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--desk) 88%, transparent)', backdropFilter: 'blur(14px)', padding: '16px' } },
    h('button', { class: 'panic', id: 'lock-panic', title: 'Stop everything now', style: { position: 'absolute', top: '14px', right: '18px' }, onclick: () => ui.panic() }, 'Panic'),
    h('div', { class: 'card', style: { width: 'min(360px, 100%)', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center', textAlign: 'center', padding: '22px' } },
      h('h2', null, 'The desk is locked'), h('p', { class: 'sub' }, 'Agents keep working. Type the desk\'s lock PIN to come back (the one set in Settings › Accounts and lock).'), pin, code, msg,
      h('button', { class: 'btn', id: 'lock-unlock', type: 'button', onclick: unlock }, 'Unlock')));
  // while locked the desk's API answered 423 to the screen behind the lock: load it again now it is open
  const reopen = async () => { try { await ui.refresh(); } catch {} window.dispatchEvent(new HashChangeEvent('hashchange')); };
  const paint = () => {
    const show = !!(alive && st?.locked);
    if (show && !el) { el = build(); document.body.append(el); setTimeout(() => pin.focus(), 30); }
    if (!show && el) { el.remove(); el = null; if (alive) reopen(); }
    if (el) { code.hidden = !st.totp; if (st.waitSeconds) msg.textContent = `Too many wrong tries. Wait ${ui.plural(st.waitSeconds, 'second')}.`; }
  };
  const refresh = async () => {
    // through the kit, so this window's session goes with it: a person who entered with their own PIN is not "nobody"
    try { const r = await ui.api(A + '/state', { raw: true }); if (r.status === 404) { alive = false; st = null; } else { alive = true; st = await r.json(); } }
    catch { /* the desk may be restarting */ }
    paint();
  };
  // activity: tell the desk the owner is here (it locks after the quiet time you set)
  const touch = () => { lastInput = Date.now(); if (alive && st?.hasPin && !st.locked && Date.now() - lastPing > 30000) { lastPing = Date.now(); ui.api('m/accounts/ping', { method: 'POST' }).then(s => { st = s; paint(); }).catch(() => {}); } };
  for (const ev of ['mousemove', 'keydown', 'pointerdown', 'wheel']) window.addEventListener(ev, touch, { passive: true, capture: true });
  // an event stream cannot send a header: this window's session goes in the address, as the shell's own stream does
  try { const es = new EventSource('/api/events' + (ui.session() ? '?session=' + encodeURIComponent(ui.session()) : '')); es.addEventListener('accounts', () => refresh()); es.addEventListener('modules', () => refresh()); } catch {}
  setInterval(refresh, 20000);
  refresh();
  window.__apdLock = { refresh, get state() { return st; }, get lastInput() { return lastInput; } };
  return window.__apdLock;
}
const lock = lockManager();
/** Called by the shell at start for modules with "boot": true, so the lock shows on every screen. */
export function boot() { lockManager().refresh(); }

export const settings = {
  accounts: { title: 'Accounts and lock', async render(el, ui) {
    const { h, api, card, btn, pill, toast, empty } = ui;
    const line = (...a) => { const l = ui.line(...a); l.style.flexWrap = 'wrap'; l.firstChild.style.minWidth = '240px'; return l; };
    const body = h('div', { class: 'stack' });
    const pinIn = (ph, id) => h('input', { type: 'password', inputmode: 'numeric', placeholder: ph, id, autocomplete: 'off', style: { width: '140px' } });
    const go = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok, 'ok'); await paint(); return r; } catch (e) { toast(e.message, 'err'); } };
    const paint = async () => {
      let s; try { s = await api('m/accounts/state'); } catch (e) { body.replaceChildren(empty(e.message)); return; }
      await lock.refresh();
      const newPin = pinIn(s.hasPin ? 'New PIN' : 'PIN, 4 to 12 digits', 'acc-pin'), curPin = pinIn('Current PIN', 'acc-cur');
      const idle = h('select', { id: 'acc-idle', onchange: () => go(() => api('m/accounts/options', { body: { idleMinutes: Number(idle.value) } }), 'Saved') }, [[0, 'Never'], [5, 'After 5 minutes'], [10, 'After 10 minutes'], [30, 'After 30 minutes'], [60, 'After 1 hour']].map(([v, l]) => h('option', { value: v, selected: Number(s.idleMinutes) === v }, l)));
      const totpBox = h('div');
      const code = h('input', { type: 'text', inputmode: 'numeric', placeholder: '6-digit code', id: 'acc-code', style: { width: '140px' } });
      const offPin = pinIn('PIN', 'acc-offpin'), rmPin = pinIn('PIN', 'acc-rmpin');
      body.replaceChildren(
        card(h('h3', null, 'Screen lock'),
          line('PIN', s.hasPin ? 'Set. The desk window asks for it when it is locked.' : 'Not set. Set a PIN to use the lock.', s.hasPin ? curPin : null, newPin,
            btn(s.hasPin ? 'Change PIN' : 'Set PIN', { id: 'acc-setpin', kind: 'ghost sm', onClick: () => go(() => api('m/accounts/pin', { body: { pin: newPin.value, current: curPin.value } }), 'PIN saved') })),
          s.hasPin ? line('Lock now', 'Covers the desk window until the PIN is typed. Agents keep working; Panic stays reachable.', btn('Lock now', { id: 'acc-lock', onClick: () => go(() => api('m/accounts/lock', { method: 'POST' })) })) : null,
          s.hasPin ? line('Lock after a quiet time', 'No mouse or keys in the desk window for this long', idle) : null,
          s.hasPin ? line('Remove the lock', 'Needs the PIN', rmPin, btn('Remove', { kind: 'ghost sm', onClick: () => go(() => api('m/accounts/pin/remove', { body: { pin: rmPin.value } }), 'Lock removed') })) : null),
        card(h('h3', null, 'Two-step codes'),
          s.totp ? line('On', 'Unlocking needs the PIN and a code from your authenticator app.', pill('On', 'ok'), offPin, btn('Switch off', { kind: 'ghost sm', onClick: () => go(() => api('m/accounts/totp/off', { body: { pin: offPin.value } }), 'Two-step codes off') }))
            : line('Off', s.hasPin ? 'Add a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Aegis…) to the PIN.' : 'Set a PIN first.',
              s.hasPin ? btn('Set up', { id: 'acc-totp', kind: 'ghost sm', onClick: async () => {
                let r; try { r = await api('m/accounts/totp/setup', { method: 'POST' }); } catch (e) { return toast(e.message, 'err'); }
                totpBox.replaceChildren(
                  line('1. Add this key to your app', 'Choose "enter a setup key", time based.', h('span', { class: 'val', id: 'acc-secret', style: { fontFamily: 'var(--mono)', fontSize: '13px' } }, r.secret)),
                  line('Or paste this link into an app that takes one', null, h('span', { class: 'val', id: 'acc-uri', style: { fontFamily: 'var(--mono)', fontSize: '11px', wordBreak: 'break-all', maxWidth: '420px' } }, r.uri)),
                  line('2. Type the code it shows', null, code, btn('Confirm', { id: 'acc-confirm', kind: 'sm', onClick: () => go(() => api('m/accounts/totp/confirm', { body: { code: code.value } }), 'Two-step codes on') })));
              } }) : null),
          totpBox),
        card(h('h3', null, 'What the lock does and does not do'),
          h('p', { class: 'sub' }, 'It is a screen lock for the desk\'s window in this browser. It stops someone at your PC from using the desk while you are away. It does not encrypt your data folder, it does not stop programs on this PC from talking to the desk directly, and other people on your network cannot reach the desk anyway (it answers only on this PC).')),
      );
    };
    el.append(body); await paint();
    ui.on('accounts', paint);
  } },
};
