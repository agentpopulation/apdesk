// Settings › Keys and logins: model providers, search, voice and audio, module credentials, logins.
export const settings = {
  keys: { title: 'Keys and logins', async render(el, ui) {
    const { h, api, card, btn, sw, pill, toast, empty, confirm, fmt } = ui;
    const line = (...a) => { const l = ui.line(...a); l.style.flexWrap = 'wrap'; l.firstChild.style.minWidth = '240px'; return l; };
    const prov = h('div'), search = h('div'), audio = h('div'), creds = h('div'), logins = h('div'), lockBox = h('div');
    const pw = (ph, attrs = {}) => h('input', { type: 'password', placeholder: ph, autocomplete: 'new-password', style: { width: '220px' }, ...attrs });
    const text = (ph, attrs = {}) => h('input', { type: 'text', placeholder: ph, autocomplete: 'off', style: { width: '200px' }, ...attrs });
    const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok, 'ok'); await paint(); return r; } catch (e) { toast(e.message, 'err'); } };

    const paintServices = async () => {
      let s; try { s = (await api('keys/services')).services; } catch (e) { search.replaceChildren(empty(e.message)); audio.replaceChildren(); return; }
      const row = (x) => {
        const input = pw(x.hasKey ? 'Replace the key' : 'Paste the key');
        return line(x.name, [x.hasKey ? `Key ${x.key}${x.fromEnvironment ? ' · from the environment, for this run only' : ''}` : 'No key yet', x.free].filter(Boolean).join(' · '),
          x.hasKey && !x.fromEnvironment ? sw(x.enabled, `Use ${x.name}`, (on) => act(() => api('keys/services/' + x.id, { body: { enabled: on } }))) : null,
          input, btn('Save', { kind: 'ghost sm', onClick: () => act(() => api('keys/services/' + x.id, { body: { value: input.value } }), `${x.name} key saved`) }),
          x.hasKey && !x.fromEnvironment ? btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await confirm(`Remove the ${x.name} key?`, { ok: 'Remove', kind: 'stop' })) act(() => api('keys/services/' + x.id, { method: 'DELETE' }), 'Key removed'); } }) : null,
          x.signup ? h('a', { href: x.signup, target: '_blank', rel: 'noopener noreferrer', class: 'sub' }, 'Get a key') : null);
      };
      search.replaceChildren(...(s.filter(x => x.kind === 'search').map(row)));
      audio.replaceChildren(...(s.filter(x => x.kind !== 'search').map(row)));
    };

    const paint = async () => {
      let o; try { o = await api('m/vault/overview'); } catch (e) { prov.replaceChildren(empty(e.message)); return; }
      // model providers
      const withKeys = o.providers.filter(p => p.keys.length);
      const pick = h('select', null, o.providers.map(p => h('option', { value: p.id }, p.name)));
      const label = text('Label (optional)', { style: { width: '150px' } }); const value = pw('Paste the key');
      prov.replaceChildren(...(withKeys.length ? withKeys.flatMap(p => p.keys.map(k => line(`${p.name} · ${k.label || 'Key'}`, `${k.value}${k.fromEnvironment ? (/environment/i.test(k.label || '') ? ' · for this run only' : ' · from the environment, for this run only') : k.created ? ' · added ' + fmt.date(k.created) : ''}`,
          k.fromEnvironment ? pill('This run only') : sw(k.enabled, `Use ${p.name} ${k.label}`, (on) => act(() => api('m/vault/keys/' + k.id, { body: { enabled: on } }))),
          k.fromEnvironment ? null : btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await confirm(`Remove the ${p.name} key "${k.label}"?`, { ok: 'Remove', kind: 'stop' })) act(() => api('m/vault/keys/' + k.id, { method: 'DELETE' }), 'Key removed'); } })))) : [empty('No model keys yet. The free Free API and Ollama need none.')]),
        line('Add a model key', 'Kept in the database on this PC; never shown in full again.', pick, label, value, btn('Add', { kind: 'ghost sm', onClick: () => act(() => api('m/vault/keys', { body: { provider: pick.value, label: label.value, value: value.value } }), 'Key added') })));
      // module credentials
      creds.replaceChildren(...(o.credentials.length ? o.credentials.map(c => line(c.name, `${c.moduleName} · saved ${fmt.date(c.created)}`, pill('Hidden'))) : [empty('No module has saved a credential yet.')]));
      // lock
      const pass = pw('Passphrase', { id: 'vault-pass' }); const cur = pw('Current passphrase'), nw = pw('New passphrase');
      lockBox.replaceChildren(
        o.hasMaster
          ? line(o.locked ? 'Logins are locked' : 'Logins are unlocked', o.locked ? 'No module can read a saved password until you unlock.' : 'Passwords are sealed on disk with your passphrase. Lock again when you step away.',
            o.locked ? pass : null, o.locked ? btn('Unlock', { id: 'vault-unlock', onClick: () => act(() => api('m/vault/unlock', { body: { passphrase: pass.value } }), 'Unlocked') }) : btn('Lock now', { kind: 'ghost', onClick: () => act(() => api('m/vault/lock', { method: 'POST' }), 'Locked') }),
            o.locked ? null : btn('Remove the passphrase', { kind: 'ghost sm', onClick: async () => { const p = await ui.ask('Type your passphrase to remove it', { ok: 'Remove' }); if (p != null) act(() => api('m/vault/master/remove', { body: { passphrase: p } }), 'Passphrase removed'); } }))
          : line('Master passphrase', 'Optional. Seals saved passwords on disk; while locked, nothing on the desk can read them. If you forget it, the saved passwords are lost.', pass, btn('Set passphrase', { kind: 'ghost', onClick: () => act(() => api('m/vault/master', { body: { passphrase: pass.value } }), 'Logins are sealed') })),
        o.hasMaster && !o.locked ? line('Change the passphrase', null, cur, nw, btn('Change', { kind: 'ghost sm', onClick: () => act(() => api('m/vault/master', { body: { current: cur.value, passphrase: nw.value } }), 'Passphrase changed') })) : null);
      // logins
      const site = text('Site, e.g. example.com', { id: 'lg-site' }), user = text('Username', { id: 'lg-user' }), pwd = pw('Password', { id: 'lg-pass' });
      logins.replaceChildren(...(o.logins.length ? o.logins.map(l => {
        const shown = h('span', { class: 'val', style: { fontFamily: 'var(--mono)', fontSize: '12px' } });
        return line(l.site, `${l.user}${l.hasValue ? '' : ' · password missing (restored from a backup without keys)'} · saved ${fmt.date(l.updated || l.created)}`, shown,
          l.hasValue ? btn('Show', { kind: 'ghost sm', 'data-reveal': l.id, onClick: async () => { try { const r = await api(`m/vault/logins/${l.id}/reveal`, { method: 'POST' }); shown.textContent = `${r.username} · ${r.password}`; setTimeout(() => { shown.textContent = ''; }, 20000); } catch (e) { toast(e.message, 'err'); } } }) : null,
          btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await confirm(`Remove the login for ${l.site}?`, { ok: 'Remove', kind: 'stop' })) act(() => api('m/vault/logins/' + l.id, { method: 'DELETE' }), 'Login removed'); } }));
      }) : [empty('No logins saved.')]),
        line('Save a login', 'For agents\' own browsers only. Never sent to a model; an agent may use it only after you approve the sign-in.', site, user, pwd, btn('Save', { id: 'lg-save', kind: 'ghost sm', disabled: o.locked, onClick: () => act(() => api('m/vault/logins', { body: { site: site.value, username: user.value, password: pwd.value } }), 'Login saved') })));
      await paintServices();
    };
    el.append(
      card(h('h3', null, 'Model providers'), h('p', { class: 'sub' }, 'The same keys as on the Models page.'), prov),
      card(h('h3', null, 'Search'), h('p', { class: 'sub' }, 'Optional keys for search services. Search works without them.'), search),
      card(h('h3', null, 'Voice and audio'), audio),
      card(h('h3', null, 'Module credentials'), h('p', { class: 'sub' }, 'Passwords and tokens modules keep, such as a mail password or a bot token. Only their names are shown.'), creds),
      card(h('h3', null, 'Logins for agents\' computers'), lockBox, logins));
    await paint();
    ui.on('models', paintServices);
  } },
};
