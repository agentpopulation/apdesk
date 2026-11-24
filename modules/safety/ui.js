// Settings › Security: the shell's level cards, auto-approve, waiting list and decisions, plus Fine-tune, Check the doors
// and a place to try the untrusted-text guard.

async function noSession(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.status;
}

/** Harmless live probes of the doors. Each returns [ok, plain words]. */
export async function checkDoors(ui) {
  const out = [];
  const sec = () => ui.api('security');
  const start = await sec();
  const other = start.level === 'strict' ? 'careful' : 'strict';
  // 1. without the session nothing changes the level or the window
  let s = await noSession('/api/settings/security', { level: other });
  let now = await sec();
  out.push([s === 403 && now.level === start.level, 'A request without this desk\'s session cannot change the security level', `answered ${s}, level still ${now.level}`]);
  s = await noSession('/api/settings/auto-approve', { window: 'today' });
  now = await sec();
  out.push([s === 403 && now.autoApproveUntil === start.autoApproveUntil, 'A request without the session cannot open auto-approve', `answered ${s}`]);
  s = await noSession('/api/settings/spend', { perItem: 1 });
  now = await sec();
  out.push([s === 403 && now.limits.perItem === start.limits.perItem, 'A request without the session cannot change the spend limits', `answered ${s}`]);
  // 2. the plain settings route ignores security and spend keys, even from this desk
  await ui.api('settings', { body: { 'security.level': other, 'security.autoApproveUntil': '2099-01-01T00:00:00.000Z', 'spend.perItem': 1 } });
  now = await sec();
  const held = now.level === start.level && now.autoApproveUntil === start.autoApproveUntil && now.limits.perItem === start.limits.perItem;
  if (!held) { try { await ui.setLevel(start.level); await ui.setAutoApprove(0); } catch {} }
  out.push([held, 'The plain settings route ignores security and spend settings', held ? 'nothing changed' : 'it changed them; they were put back']);
  // 3. switching modules and resuming after Panic need the session
  s = await noSession('/api/modules/safety/off', {});
  out.push([s === 403, 'A request without the session cannot switch modules', `answered ${s}`]);
  s = await noSession('/api/panic/resume', {});
  out.push([s === 403, 'A request without the session cannot resume after Panic', `answered ${s}`]);
  // 4. Panic state is readable
  try { const p = await ui.api('panic'); out.push([typeof p.halted === 'boolean', 'Panic state is readable', p.halted ? 'everything is stopped right now' : 'running normally']); }
  catch (e) { out.push([false, 'Panic state is readable', e.message]); }
  // 5. sending to a person asks at the current level
  try {
    const r = await ui.api('m/safety/probe-send', { method: 'POST' });
    out.push([r.asked && r.cancelled, `Sending to a person asks you at the ${r.level} level`, r.asked ? 'a test request waited for you and was cancelled' : `it went ahead without you (${r.decidedWithoutYou || 'no question'})`]);
  } catch (e) { out.push([false, 'Sending to a person asks you', e.message]); }
  return out;
}

/** Settings › Approve from your phone: the Admin's switch, the code that links a phone, and the linked phones. */
export async function phoneSection(el, ui) {
  const { h, card, line, btn, sw, api, toast, empty, pill, fmt } = ui;
  const box = h('div', { class: 'stack' }); el.append(box);
  let shownCode = null;   // { code, until } while a code is on screen
  const act = async (path, body, words) => { try { const r = await api(path, { body: body ?? {} }); if (words) toast(words, 'ok'); return r; } catch (e) { toast(e.message || 'That did not go through.', 'err'); return null; } };
  async function paint() {
    let s; try { s = await api('phone'); } catch (e) { box.replaceChildren(card(h('h3', null, 'Approve from your phone'), empty(e.message || 'This could not be read just now.'))); return; }
    const admin = !!s.you?.keeper;
    const codeBox = h('div', { 'data-phone': 'code' });
    if (shownCode && shownCode.until > Date.now()) codeBox.append(h('div', { class: 'phone-code', style: { fontSize: '28px', letterSpacing: '.2em', fontVariantNumeric: 'tabular-nums', margin: '6px 0' } }, `${shownCode.code.slice(0, 3)} ${shownCode.code.slice(3)}`),
      h('p', { class: 'sub' }, `Open ${s.address} on your phone and type this code there. It works once, for five minutes.`));
    box.replaceChildren(
      card(h('div', { class: 'row' }, h('h3', null, 'Approve from your phone'), pill(s.listening ? 'On' : 'Off', s.listening ? 'ok' : ''), h('span', { class: 'grow' }),
        admin ? sw(s.on && s.listening, 'Approve from your phone', async (on) => { const r = await act('phone/switch', { on }, null); if (!r) return false; if (r.error) { toast(r.error, 'err'); paint(); return false; } toast(on ? 'On. The phone page is open on your home network.' : 'Off. The phone page is closed.', 'ok'); paint(); }, { 'data-phone': 'switch' }) : null),
        h('p', { class: 'sub' }, 'When this is on, the desk opens one small page on your home network. A phone you link there shows what waits for you, and Yes or No decides it. Nothing else of the desk can be reached from another device, and nothing leaves your network, so it also works while the desk is Offline.'),
        h('p', { class: 'sub' }, 'The page uses plain http: someone on the same Wi-Fi could read what it shows. It never shows keys, passwords or PINs, and the text of a message shows only when you tap Show on the phone.'),
        admin ? null : line('Who switches it on', s.on ? 'The Admin switched it on.' : 'Only the Admin of this PC can switch it on.'),
        s.note ? line('Home network', s.note) : null,
        s.listening ? line('Address for your phone', s.address) : null,
        s.listening ? line('Link a phone', 'Make a code here, then type it on your phone.', btn('Make a code', { kind: 'sm', 'data-phone': 'make-code', onClick: async () => { const r = await act('phone/code', {}, null); if (r?.code) { shownCode = { code: r.code, until: Date.now() + r.seconds * 1000 }; paint(); setTimeout(() => { if (shownCode && shownCode.until <= Date.now()) { shownCode = null; paint(); } }, r.seconds * 1000 + 500); } } })) : null,
        codeBox,
        admin ? line('Installs and module switches', s.adminDecides ? 'May be decided on your own phone.' : 'Decided at the desk. The phone shows them as "decide this at the desk".',
          sw(s.adminDecides, 'Decide installs and module switches on my phone', async (on) => { const r = await act('phone/admin-decides', { on }, 'Saved.'); if (!r) return false; paint(); }, { 'data-phone': 'admin-decides' })) : null),
      card(h('h3', null, admin ? 'Linked phones' : 'Your linked phones'),
        s.devices.length ? s.devices.map(d => line(admin ? `${d.name} · ${d.person}` : d.name, `Linked ${fmt.when(d.linked)}${d.lastUsed ? ' · last used ' + fmt.when(d.lastUsed) : ''}`,
          btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm(`Remove "${d.name}"? It stops working at once.`, { ok: 'Remove', kind: 'stop' })) { if (await act(`phone/devices/${encodeURIComponent(d.id)}/remove`, {}, 'Removed.')) paint(); } } })))
          : empty(s.listening ? 'No phone is linked yet. Make a code above to link one.' : 'No phone is linked. Switch this on first, then link a phone with a code.')));
  }
  await paint();
}

export const settings = {
  phone: { title: 'Approve from your phone', render: phoneSection },
  security: { title: 'Security', async render(el, ui) {
    const { h, card, line, btn, pill, api, toast, empty } = ui;
    await ui.coreSettingsSections.security.render(el, ui);
    // Stopped by Panic: right after "Waiting for you"; shown only while there is something to dismiss
    const stopped = h('div');
    const waitCard = [...el.querySelectorAll('.card')].find(c => c.querySelector('h3')?.textContent === 'Waiting for you');
    if (waitCard) waitCard.after(stopped); else el.append(stopped);
    const paintStopped = async () => { if (ui.refreshStopped) await ui.refreshStopped(); stopped.replaceChildren(...[ui.stoppedSection?.()].filter(Boolean)); };
    paintStopped(); ui.on('approval', paintStopped); ui.on('panic', paintStopped);
    // Fine-tune: read-only, from the door's own table
    const fine = h('div');
    const paintFine = async () => {
      let p; try { p = await api('m/safety/policy'); } catch (e) { fine.replaceChildren(empty(e.message)); return; }
      const level = ui.state.security?.level || p.level;
      const head = (l) => h('th', { style: l === level ? { color: 'var(--accent)' } : null }, l[0].toUpperCase() + l.slice(1) + (l === level ? ' (now)' : ''));
      fine.replaceChildren(
        h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'What an agent wants to do'), ...p.levels.map(head))),
          h('tbody', null, Object.keys(p.policy).map(a => h('tr', { 'data-action': a }, h('td', null, p.actions[a] || a), ...p.levels.map(l => h('td', { style: l === level ? { background: 'var(--accent-soft)' } : null }, p.rules[p.policy[a][l]] || p.policy[a][l]))))))),
        ...p.notes.map(([t, d]) => line(t, d, t === 'Paid OpenRouter models' ? pill((ui.state.settings['openrouter.allowPaid'] ?? p.paidOpenRouter) ? 'On' : 'Off', (ui.state.settings['openrouter.allowPaid'] ?? p.paidOpenRouter) ? 'wait' : 'ok') : null)));
    };
    // Check the doors
    const results = h('div');
    const run = async (e) => {
      const b = e.currentTarget; b.disabled = true; results.replaceChildren(h('span', { class: 'sub' }, 'Checking…'));
      try {
        const r = await checkDoors(ui);
        results.replaceChildren(...r.map(([ok, what, ev]) => line(what, ev, pill(ok ? 'Pass' : 'Fail', ok ? 'ok' : 'stop'))),
          h('p', { class: 'sub', 'data-doors': r.every(x => x[0]) ? 'pass' : 'fail' }, r.every(x => x[0]) ? 'All doors hold.' : 'A door did not hold. Do not use the desk for real work until this is fixed.'));
      } catch (er) { results.replaceChildren(empty('The check could not run: ' + er.message)); }
      finally { b.disabled = false; }
    };
    // Try the guard
    const sample = h('textarea', { placeholder: 'Paste text from a web page, a mail or a file', rows: 3 });
    const guardOut = h('div');
    const tryGuard = async () => {
      try {
        const r = await api('m/safety/scan', { body: { text: sample.value } });
        guardOut.replaceChildren(...(r.flags.length ? r.flags.map(f => line(f.label[0].toUpperCase() + f.label.slice(1), '“' + f.match + '”', pill('Marked', 'wait'))) : [empty('Nothing in it looks like instructions to an agent.')]));
      } catch (e) { toast(e.message, 'err'); }
    };
    el.append(
      card(h('h3', null, 'Fine-tune'), h('p', { class: 'sub' }, 'What each level does, action by action. This is the table the desk follows; it is shown here, not changed here.'), fine),
      card(h('div', { class: 'row' }, h('div', null, h('h3', null, 'Check the doors'), h('p', { class: 'sub' }, 'Harmless live tests: nothing is changed, sent or spent.')), h('span', { class: 'grow' }), btn('Check the doors', { id: 'check-doors', onClick: run })), results),
      card(h('h3', null, 'Instructions hidden in pages, mail and files'), h('p', { class: 'sub' }, 'Before an agent reads a web page, a mail or a file, the desk marks sentences that try to give it orders (ignore your rules, send data, change settings) and tells the model the text is data, not instructions.'),
        sample, h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'grow' }), btn('Check this text', { kind: 'ghost sm', onClick: tryGuard })), guardOut));
    paintFine(); ui.on('security', paintFine);
  } },
};
