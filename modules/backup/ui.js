// Settings › Backup: back up, restore, activity log, updates and about.
const CORE_WORDS = { settings: 'Settings', agents: 'Agents', jobs: 'Tasks and jobs', approvals: 'Approvals', activity: 'Activity log', secrets: 'Keys and logins', calls: 'Model calls', modules: 'Module switches', kv: 'Module settings', migrations: 'Database versions' };
const HOW = { level: 'allowed by the level', auto: 'auto-approved', 'owner approve': 'you approved', 'owner deny': 'you denied', owner: 'you', timeout: 'timed out', halted: 'stopped by Panic', aborted: 'cancelled' };
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z/g;

function groupTables(tables, ui) {
  const groups = new Map();
  for (const t of tables) {
    const m = /^m_([a-z0-9]+)_/.exec(t.name);
    const label = m ? (ui.state.modules.find(x => x.id === m[1])?.name || m[1][0].toUpperCase() + m[1].slice(1)) : (CORE_WORDS[t.name] || t.name);
    const g = groups.get(label) || { label, backup: 0, now: 0 };
    g.backup += t.backup || 0; g.now += t.now || 0; groups.set(label, g);
  }
  return [...groups.values()].filter(g => g.backup || g.now).sort((a, b) => b.backup - a.backup);
}

async function waitForRestart(ui, note) {
  const t0 = Date.now(); let wentDown = false;
  for (;;) {
    await new Promise(r => setTimeout(r, 1000));
    let up = false;
    try { const r = await fetch('/api/panic', { cache: 'no-store' }); up = r.ok; } catch { up = false; }
    if (!up) wentDown = true;
    if (wentDown && up) { location.reload(); return; }
    if (Date.now() - t0 > 30000) { note.textContent = 'The desk has not restarted by itself. Close this window, run stop.bat and start.bat, then open the desk again.'; return; }
  }
}

function backupSection(el, ui) {
  const { h, api, card, line, btn, toast, fmt, empty, confirm, modal } = ui;
  const keys = h('input', { type: 'checkbox', id: 'bk-keys' });
  const listEl = h('div'), status = h('span', { class: 'sub' });
  const file = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => upload() });

  const paint = async () => {
    let d; try { d = await api('m/backup/list'); } catch (e) { listEl.replaceChildren(empty(e.message)); return; }
    listEl.replaceChildren(...(d.items.length ? d.items.map(b => line(fmt.when(b.at), `${fmt.bytes(b.size)}${/before-restore/.test(b.name) ? ' · made automatically before a restore' : /uploaded/.test(b.name) ? ' · uploaded' : ''}`,
      btn('Download', { kind: 'ghost sm', onClick: () => download(b.name) }),
      btn('Restore', { kind: 'ghost sm', 'data-restore': b.name, onClick: () => restore(b) }),
      btn('Delete', { kind: 'ghost sm', onClick: async () => { if (!await confirm(`Delete the backup from ${fmt.when(b.at)}? This cannot be undone.`, { ok: 'Delete', kind: 'stop' })) return; try { await api('m/backup/' + encodeURIComponent(b.name), { method: 'DELETE' }); toast('Backup deleted', 'ok'); paint(); } catch (e) { toast(e.message, 'err'); } } })))
      : [empty('No backups yet.')]));
  };
  const download = async (name) => {
    try {
      const r = await api('m/backup/download/' + encodeURIComponent(name), { raw: true });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed');
      const url = URL.createObjectURL(await r.blob());
      const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { toast(e.message, 'err'); }
  };
  const upload = async () => {
    const f = file.files?.[0]; file.value = ''; if (!f) return;
    status.textContent = 'Checking the file…';
    try { const r = await api('m/backup/upload', { body: new Blob([f], { type: 'application/zip' }) }); status.textContent = ''; toast('The backup is in the list. Press Restore beside it.', 'ok'); await paint(); }
    catch (e) { status.textContent = ''; toast(e.message, 'err'); }
  };
  const restore = async (b) => {
    let p; try { p = await api('m/backup/preview/' + encodeURIComponent(b.name)); } catch (e) { return toast(e.message, 'err'); }
    const wipe = h('input', { type: 'checkbox', id: 'bk-wipe' });
    const trust = h('input', { type: 'checkbox', id: 'bk-trust' });
    const groups = groupTables(p.tables, ui);
    const sens = (p.sensitive || []).length ? h('div', { 'data-sensitive': '' }, ...p.sensitive.map(x => ui.line(x.what, x.detail))) : h('p', { class: 'sub' }, 'Nothing about model connections, folder access, allow-lists, accounts or agents\' instructions differs.');
    const origin = p.madeHere
      ? h('p', { class: 'sub', 'data-origin': 'here' }, `Made on this desk ${fmt.when(p.created)}${p.version ? ' by version ' + p.version : ''}. Everything below is replaced by what the backup holds. Your security level, spend limits and paid-model switch stay as they are now. ${p.includeKeys ? 'It holds keys and logins: they replace the ones here.' : 'It holds no keys or logins: the ones here are kept.'}`)
      : h('div', { class: 'card', 'data-origin': 'elsewhere', style: { borderColor: 'var(--warn)' } },
          h('b', null, 'This backup was not made on this desk'),
          h('p', { class: 'sub' }, 'It may come from another PC, or from someone else. Chats, leads, tasks, memory, files and other work come back. These stay as they are on this desk, because a backup from elsewhere could quietly change them: model connections (the router address, Ollama, other PCs), folders outside the workspace agents may open, allow-lists and accounts that reach people or the outside (Telegram, mail, social, connected tool servers, saved logins), module settings and switches, keys, and your agents\' instructions, tone, models and tools. Schedules arrive paused. Your security level and spend limits never change.'),
          h('label', { class: 'row' }, trust, 'Also bring these in: I trust where this backup came from'));
    const body = h('div', { class: 'stack' }, origin,
      ui.table([{ key: 'label', label: 'Part' }, { key: 'backup', label: 'In the backup' }, { key: 'now', label: 'On the desk now' }], groups),
      h('b', null, p.madeHere ? 'What changes in connections, access and agents' : 'What differs in connections, access and agents (held back unless you tick the box)'), sens,
      h('p', { class: 'sub' }, `Files: ${p.files.inBackup} in the backup, ${p.files.replace} of them replace a file of the same name.`),
      p.files.extra.length ? h('label', { class: 'row' }, wipe, `Also move the ${p.files.extra.length} files that are not in the backup to the bin`) : null,
      h('p', { class: 'sub' }, 'A copy of the desk as it is now is made first. The desk restarts when the restore is done.'));
    modal({ title: 'Restore this backup?', body, wide: true, actions: [{ label: 'Cancel' }, { label: 'Restore', kind: 'stop', onClick: async () => {
      const note = h('p', { class: 'sub' }, 'Restoring…');
      modal({ title: 'Restoring', body: note });
      try {
        const r = await api('m/backup/restore/' + encodeURIComponent(b.name), { body: { wipeExtra: wipe.checked, previewId: p.previewId, trustAll: !p.madeHere && trust.checked } });
        note.textContent = `Restored ${r.files.copied} files${r.files.movedToBin ? ' and moved ' + r.files.movedToBin + ' to the bin' : ''}.${r.heldBack?.length ? ' Kept as they were here: ' + r.heldBack.join('; ') + '.' : ''} The desk is restarting; this page reloads by itself.`;
        waitForRestart(ui, note);
      } catch (e) { note.textContent = 'The restore did not happen: ' + e.message; }
      return false;        // keep the Restoring box open (the kit closes the host after onClick otherwise)
    } }] });
  };

  el.append(card(h('h3', null, 'Back up'),
    line('Back up now', 'One zip with the database and the workspace, kept in the backups folder outside your data folder. Agents\' browser profiles are never included.',
      h('label', { class: 'row', style: { gap: '6px', whiteSpace: 'nowrap' } }, keys, 'Include keys and logins'),
      btn('Back up now', { id: 'bk-now', onClick: async (e) => { const b = e.currentTarget; b.disabled = true; status.textContent = 'Backing up…'; try { const r = await api('m/backup/now', { body: { includeKeys: keys.checked } }); status.textContent = ''; toast(`Backup made (${fmt.bytes(r.size)})`, 'ok'); paint(); } catch (er) { status.textContent = ''; toast(er.message, 'err'); } finally { b.disabled = false; } } })),
    line('Restore from a file', 'A backup zip from another PC or a USB stick. It is checked before anything changes.', file, btn('Choose a zip', { kind: 'ghost', onClick: () => file.click() })),
    status),
  card(h('h3', null, 'Your backups'), listEl));
  paint(); ui.on('backup', paint);
}

function activitySection(el, ui) {
  const { h, api, card, fmt, empty, btn } = ui;
  const q = h('input', { type: 'search', placeholder: 'Search the log', style: { width: '220px' } });
  const kind = h('select', null, [['', 'Everything'], ['decide', 'Approvals'], ['security', 'Security and spend'], ['panic', 'Panic'], ['backup', 'Backups']].map(([v, l]) => h('option', { value: v }, l)));
  const when = h('select', null, [['all', 'Any time'], ['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']].map(([v, l]) => h('option', { value: v }, l)));
  const who = h('select', null, h('option', { value: '' }, 'Anyone'));
  const out = h('div'); let items = [];
  const words = (x) => String(x.title || x.action).replace(ISO, (m) => fmt.when(m));
  const filtered = () => {
    const text = q.value.trim().toLowerCase(); const days = when.value === 'all' ? null : Number(when.value);
    const since = days ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1)); return d.getTime(); })() : 0;
    return items.filter(x => {
      if (since && new Date(x.at).getTime() < since) return false;
      if (who.value && (x.agent_id || 'you') !== who.value) return false;
      if (kind.value === 'decide' && !(x.how in HOW) ) return false;
      if (kind.value === 'decide' && (x.action.startsWith('security.') || x.action.startsWith('spend.') || x.action === 'panic' || x.action.startsWith('backup.'))) return false;
      if (kind.value === 'security' && !(x.action.startsWith('security.') || x.action.startsWith('spend.'))) return false;
      if (kind.value === 'panic' && x.action !== 'panic') return false;
      if (kind.value === 'backup' && !x.action.startsWith('backup.')) return false;
      if (text && !(words(x) + ' ' + (x.detail || '')).toLowerCase().includes(text)) return false;
      return true;
    });
  };
  const paintList = () => {
    const rows = filtered();
    out.replaceChildren(rows.length ? ui.table([
      { label: 'When', render: (x) => fmt.when(x.at) },
      { label: 'Who', render: (x) => x.agent_id ? (ui.agent(x.agent_id)?.name || 'An agent') : 'You or the desk' },
      { label: 'What', render: (x) => h('span', null, words(x), x.detail ? h('span', { class: 'sub' }, ' · ' + String(x.detail).replace(ISO, (m) => fmt.when(m))) : null) },
      { label: 'How', render: (x) => HOW[x.how] || x.how || '' },
    ], rows.slice(0, 200)) : empty('Nothing matches.'));
  };
  const load = async () => {
    try { items = (await api('activity')).items; } catch (e) { out.replaceChildren(empty(e.message)); return; }
    const agents = [...new Set(items.map(x => x.agent_id).filter(Boolean))];
    who.replaceChildren(h('option', { value: '' }, 'Anyone'), h('option', { value: 'you' }, 'You or the desk'), ...agents.map(a => h('option', { value: a }, ui.agent(a)?.name || 'An agent')));
    paintList();
  };
  const csv = () => {
    const cell = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
    const text = ['When,Who,What,How,Detail', ...filtered().map(x => [fmt.when(x.at), x.agent_id ? (ui.agent(x.agent_id)?.name || x.agent_id) : 'You or the desk', words(x), HOW[x.how] || x.how || '', x.detail || ''].map(cell).join(','))].join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); const a = h('a', { href: url, download: 'activity.csv' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  for (const c of [q, kind, when, who]) c.addEventListener('input', paintList);
  el.append(card(h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, h('h3', null, 'Activity log'), h('span', { class: 'grow' }), q, kind, when, who, btn('Save as CSV', { kind: 'ghost sm', onClick: csv })),
    h('p', { class: 'sub' }, 'Every approval decision, Panic, and change to security, spend and backups. Times are in your time zone.'), out));
  load(); ui.on('approval', load); ui.on('security', load); ui.on('panic', load); ui.on('backup', load);
}

// The Updates card: signed releases from GitHub (contracts/UPDATES.md). The desk does every check; this only shows it.
async function updatesSection(el, ui) {
  const { h, api, card, line, btn, toast, fmt, empty, sw } = ui;
  const box = card({ 'data-updates': '' }, h('h3', null, 'Updates'), empty('Loading…'));
  el.append(box);
  const say = (text, kind) => h('div', { class: 'card', 'data-kind': kind, style: { borderColor: kind === 'warn' ? 'var(--warn)' : kind === 'ok' ? 'var(--ok)' : 'var(--line)', margin: '8px 0' } }, text);
  const notes = (list) => list?.length ? h('ul', { style: { margin: '6px 0 0', paddingLeft: '20px' } }, ...list.map(n => h('li', null, n))) : null;
  let waiting = false;
  const paint = (st) => {
    const built = st.installed.built ? `Built ${fmt.date(st.installed.built)}` : st.layout === 'git' ? 'A Git checkout' : 'A source copy';
    const busy = !!st.busy;
    const check = st.canCheck || busy ? btn(st.busy === 'checking' ? 'Checking…' : 'Check for updates', { kind: 'ghost', id: 'upd-check', disabled: busy, onClick: async (e) => { e.currentTarget.disabled = true; try { paint(await api('update/check', { body: {} })); } catch (er) { toast(er.message, 'err'); e.currentTarget.disabled = false; } } }) : null;
    const install = st.canInstall ? btn('Update now', { id: 'upd-install', onClick: async (e) => { e.currentTarget.disabled = true; try { paint(await api('update/install', { body: {} })); toast('Approve the update in the card at the top to go on.', 'ok'); } catch (er) { toast(er.message, 'err'); e.currentTarget.disabled = false; } } }) : null;
    box.replaceChildren(...[h('h3', null, 'Updates'),
      line('Installed version', built, h('span', { class: 'val' }, st.installed.version)),
      st.justUpdated ? say(h('div', null, h('b', null, st.justUpdated.line), notes(st.justUpdated.notes)), 'ok') : null,
      st.failed ? say(st.failed, 'warn') : null,
      h('div', { class: 'line', 'data-update-line': st.release && st.canInstall ? 'ready' : st.layout === 'git' ? 'git' : !st.setUp ? 'not-set-up' : '' },
        h('div', null, h('b', null, st.line), st.checkedAt && !busy && st.canCheck ? h('span', { class: 'd' }, `Checked ${fmt.when(st.checkedAt)}`) : null)),
      check || install ? h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', margin: '2px 0 10px' } }, ...[check, install].filter(Boolean)) : null,
      st.note ? say(`Not installed: ${st.note}`, 'warn') : null,
      st.release && st.canInstall ? h('div', { 'data-update-notes': '' }, h('b', null, `What is new in ${st.release.version}`), notes(st.release.notes),
        h('p', { class: 'sub', style: { marginTop: '6px' } }, 'Update now makes a backup of your data first, then puts the new version in place and restarts the desk. Your data, backups and keys stay as they are.')) : null,
      st.backup ? h('p', { class: 'sub' }, `Backup made first: ${st.backup}`) : null,
      st.setUp && st.layout !== 'git' ? line('Check once a day', 'One quiet check a day while the desk is on and Online. Nothing about you is sent.', sw(st.daily, 'Check once a day', async (on) => { paint(await api('update/daily', { body: { on } })); })) : null].filter(Boolean));
    if (st.busy === 'restarting' && !waiting) { waiting = true; const n = h('p', { class: 'sub' }, 'The desk is restarting; this page reloads by itself.'); box.append(n); waitForRestart(ui, n); }
  };
  try { paint(await api('update')); } catch (e) { box.replaceChildren(h('h3', null, 'Updates'), empty(e.message)); return; }
  ui.on('update', (st) => { if (st?.installed) paint(st); });
}

async function aboutSection(el, ui) {
  const { h, api, card, line, empty } = ui;
  const box = card(h('h3', null, 'About'), empty('Loading…'));
  el.append(box);
  let a; try { a = await api('m/backup/about'); } catch (e) { box.replaceChildren(h('h3', null, 'About'), empty(e.message)); return; }
  const mono = (t) => h('span', { class: 'val', style: { fontFamily: 'var(--mono)', fontSize: '12px', wordBreak: 'break-all', textAlign: 'right' } }, t);
  box.replaceChildren(h('h3', null, 'About'),
    line('Version', 'AP Desk (Agent Population Desk)', h('span', { class: 'val' }, a.version)),
    line('Your data', 'The database and the workspace, in the data folder of the desk. Backups are kept beside it, outside the data folder.'),
    h('details', { 'data-details': 'folders' }, h('summary', null, 'Details'),
      line('Your data', 'The database and the workspace', mono(a.folders.data)),
      line('Backups', 'Outside the data folder', mono(a.folders.backups)),
      line('Installed in', null, mono(a.folders.install))),
    h('details', null, h('summary', null, 'The folders of the desk'), ...a.layout.map(([n, d]) => line(n, d))),
    a.attribution ? h('details', null, h('summary', null, 'Licences and credits'), ui.md(a.attribution)) : null);
}

export const settings = {
  backup: { title: 'Backup', async render(el, ui) { backupSection(el, ui); activitySection(el, ui); await updatesSection(el, ui); await aboutSection(el, ui); } },
};
