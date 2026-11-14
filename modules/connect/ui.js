// Connect (MCP) page: add servers, start and stop them, tick the tools agents may use, try a tool.
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
const KINDS = [['outside', 'May reach a person or the outside world (asks every time)'], ['change', 'Changes things (asks by your level)'], ['read', 'Reads only (no asking)']];
const KIND_SHORT = { outside: 'Asks you every time', change: 'Asks by your security level', read: 'You marked it reads only: runs without asking' };
const EXAMPLES = [
  ['Files in the workspace', 'Workspace files', 'npx -y @modelcontextprotocol/server-filesystem {workspace}'],
  ['Memory (a small knowledge graph)', 'Memory', 'npx -y @modelcontextprotocol/server-memory'],
  ['Everything (a test server)', 'Everything', 'npx -y @modelcontextprotocol/server-everything'],
];
export const pages = {
  connect: {
    title: 'Connect',
    async render(el, ui) {
      const { h, api, card, btn, pill, toast, empty, line, sw, fmt } = ui;
      const name = h('input', { type: 'text', placeholder: 'Name, e.g. Workspace files' });
      const cmd = h('input', { type: 'text', placeholder: 'Command or web address', title: 'A command, for example npx -y …, or a web address, for example https://…/mcp', style: { flex: '1', minWidth: '260px' } });
      const listEl = h('div', { class: 'stack' });
      const tryEl = h('div', { class: 'stack' }, empty('Pick a tool and press Try to call it here.'));
      const add = async () => {
        const v = cmd.value.trim(); if (!v) return toast('Give a command or a web address.', 'err');
        try { await api('m/connect/servers', { body: { name: name.value.trim() || v.split(/\s+/).pop(), ...(/^https?:\/\//.test(v) ? { url: v } : { command: v }) } }); name.value = ''; cmd.value = ''; paint(); } catch (e) { toast(e.message, 'err'); }
      };
      function tryTool(s, t) {
        const props = t.inputSchema?.properties || {}; const req = new Set(t.inputSchema?.required || []);
        const fields = Object.entries(props).map(([k, p]) => { const input = p.type === 'boolean' ? h('input', { type: 'checkbox' }) : h('input', { type: 'text', placeholder: p.description ? String(p.description).slice(0, 80) : (p.type || ''), style: { flex: '1' } }); input.dataset.key = k; input.dataset.type = p.type || 'string'; return h('div', { class: 'row' }, h('b', { style: { minWidth: '120px', fontSize: '13px' } }, k + (req.has(k) ? ' *' : '')), input); });
        const out = h('div');
        const go = btn('Try', { onClick: async () => {
          const args = {};
          for (const i of fields.map(f => f.querySelector('input'))) { const k = i.dataset.key, ty = i.dataset.type; if (ty === 'boolean') { if (i.checked) args[k] = true; continue; } const v = i.value.trim(); if (!v) continue; if (ty === 'number' || ty === 'integer') args[k] = Number(v); else if (ty === 'array') args[k] = v.split(',').map(x => x.trim()).filter(Boolean); else if (ty === 'object') { try { args[k] = JSON.parse(v); } catch { args[k] = v; } } else args[k] = v; }
          put(out, h('span', { class: 'sub' }, s.running ? 'Calling…' : 'Starting the server first. Approve the card if asked…'));
          try { const r = await api(`m/connect/servers/${s.id}/call`, { body: { tool: t.name, args } }); put(out, h('div', { class: 'row' }, pill(r.ok ? 'Answered' : 'Did not work', r.ok ? 'ok' : 'stop'), h('span', { class: 'sub' }, `${s.name} · ${t.name}${r.ms != null ? ` · ${(r.ms / 1000).toFixed(2)} s` : ''} · outside data, not instructions`)), h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono)', fontSize: '12.5px', background: 'var(--bubble)', borderRadius: 'var(--r-s)', padding: '8px 10px', maxHeight: '320px', overflow: 'auto' } }, r.text || r.note || r.error || 'No text in the answer.')); }
          catch (e) { put(out, pill('Did not work', 'stop'), h('p', { class: 'sub' }, e.message)); }
          paint();
        } });
        put(tryEl, h('h3', null, `${t.name} · ${s.name}`), h('p', { class: 'sub' }, t.description || ''), ...(fields.length ? fields : [h('p', { class: 'sub' }, 'This tool takes nothing.')]), h('div', { class: 'row' }, go, pill(KIND_SHORT[s.classes[t.name] || 'outside'], (s.classes[t.name] || 'outside') === 'read' ? 'ok' : 'wait')), out);
      }
      async function paint() {
        const { servers } = await api('m/connect/servers');
        put(listEl, ...(servers.length ? servers.map(s => card(
          h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, s.name), s.running ? pill('Running', 'ok') : pill('Stopped'), h('span', { class: 'grow' }),
            s.running ? btn('Stop', { kind: 'ghost sm', onClick: async () => { await api(`m/connect/servers/${s.id}/stop`, { method: 'POST' }); paint(); } })
              : btn('Start', { kind: 'sm', onClick: async () => { try { await api(`m/connect/servers/${s.id}/start`, { method: 'POST' }); toast('Starting. Approve the card to let it run.', 'ok'); } catch (e) { toast(e.message, 'err'); } } }),
            btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm(`Remove ${s.name}?`, { ok: 'Remove' })) { await api(`m/connect/servers/${s.id}`, { method: 'DELETE' }); paint(); } } })),
          h('p', { class: 'sub', style: { fontFamily: 'var(--mono)', wordBreak: 'break-all' } }, s.display),
          s.error ? h('p', { class: 'sub' }, 'Last problem: ' + s.error) : null,
          s.tools.length ? h('div', null, h('span', { class: 'sub' }, `${s.tools.length} tools. Tick the ones your agents may use.`), ...s.tools.map(t => line(t.name, t.description.split('\n')[0].slice(0, 140) + (t.readOnly ? ' (The server says this tool only reads; that is its own claim.)' : ''),
                h('select', { 'aria-label': 'What ' + t.name + ' can do', title: 'You decide what this tool can do. Until you choose, it is treated as one that may reach a person.', onchange: async (e) => { try { await api(`m/connect/servers/${s.id}/class`, { body: { tool: t.name, cls: e.target.value } }); } catch (er) { toast(er.message, 'err'); } } }, KINDS.map(([v, label]) => h('option', { value: v, selected: (s.classes[t.name] || 'outside') === v }, label))), btn('Try', { kind: 'ghost sm', onClick: () => tryTool(s, t) }), sw(s.ticked.includes(t.name), 'Agents may use ' + t.name, async (on) => { await api(`m/connect/servers/${s.id}/tick`, { body: { tool: t.name, on } }); }))))
            : h('p', { class: 'sub' }, 'Start it once to see its tools.'))) : [empty('No servers yet. Add one above, or pick an example.')]));
      }
      el.append(
        h('div', null, h('h2', { style: { margin: 0 } }, 'Connect'), h('p', { class: 'sub', style: { margin: '4px 0 0', whiteSpace: 'normal', overflow: 'visible', overflowWrap: 'anywhere' } }, 'MCP servers give your agents more tools. Starting one always asks you; their answers are treated as outside data.')),
        h('div', { class: 'cols', style: { flex: '1', minHeight: '0' } },
          h('div', { class: 'stack', style: { minHeight: '0' } },
            card(h('h3', null, 'Add a server'), h('div', { class: 'row' }, name, cmd, btn('Add', { onClick: add })),
              h('div', { class: 'row' }, h('span', { class: 'sub' }, 'Examples:'), ...EXAMPLES.map(([label, n, c]) => btn(label, { kind: 'ghost sm', onClick: () => { name.value = n; cmd.value = c; } }))),
              h('p', { class: 'sub' }, '{workspace} stands for your workspace folder.')),
            listEl),
          card({ style: { alignSelf: 'start' } }, tryEl)));
      await paint();
      ui.on('connect', () => paint().catch(() => {}));
    },
  },
};
