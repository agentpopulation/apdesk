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

export const settings = {
  security: { title: 'Security', async render(el, ui) {
    const { h, card, line, btn, pill, api, toast, empty } = ui;
    await ui.coreSettingsSections.security.render(el, ui);
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
