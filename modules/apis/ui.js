// APIs page: start from a need, pick a topic, Get its pack, search it here, Try one address, tick it for the agents.
// Everything from a pack or an API is shown as plain text (text nodes only), never as markup.
export const TICK_LABEL = 'Agents may use';
export const tickToast = (on, title) => (on ? `Your agents may now read ${title}. It is listed under Your agents may use.` : `Your agents can no longer read ${title}.`);
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
const CSS = `
.apis .need{display:flex;gap:8px;flex-wrap:wrap}.apis .need input[type=text]{flex:1 1 220px;min-width:0}
.apis .need input.cc{flex:0 0 88px;width:88px}.apis .need select{flex:0 0 auto}
.apis .chips .chip[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.apis .ep{display:flex;flex-direction:column;gap:6px}
.apis .ep .facts{display:flex;gap:6px 12px;flex-wrap:wrap;font-size:12.5px;color:var(--dim)}
.apis .mono{font-family:var(--mono);font-size:12px;word-break:break-all;overflow-wrap:anywhere}
.apis .credit{font-size:11.5px;color:var(--dim)}
.apis pre.sample{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;background:var(--bubble);border-radius:var(--r-s);padding:8px 10px;max-height:260px;overflow:auto;margin:0}
.apis .packcard .row{justify-content:space-between}
.apis .tick{display:inline-flex;align-items:center;gap:6px}.apis .swlabel{font-size:12.5px;color:var(--dim)}
`;

export const pages = {
  apis: {
    title: 'APIs',
    async render(el, ui) {
      const { h, api, card, btn, pill, toast, empty, sw, fmt } = ui;
      if (!document.getElementById('apis-css')) document.head.append(h('style', { id: 'apis-css' }, CSS));
      el.classList.add('scroll', 'apis');
      let info = { packs: [] }; let tools = []; let topic = null;
      const day = (d) => (d ? fmt.date(d + 'T12:00:00Z') : 'not checked');
      const q = h('input', { type: 'text', placeholder: 'For example: river levels near me, bus arrivals, air quality', 'aria-label': 'What do you need data for?' });
      const cc = h('input', { type: 'text', class: 'cc', maxlength: '2', placeholder: 'Country', 'aria-label': 'Country code, two letters', title: 'Two letters, for example IN or GB' });
      const fm = h('select', { 'aria-label': 'Format' }, ['', 'json', 'geojson', 'csv', 'xml'].map(v => h('option', { value: v }, v ? v.toUpperCase() : 'Any format')));
      const topicsEl = h('div', { class: 'chips', role: 'group', 'aria-label': 'Topics' });
      const packEl = h('div');
      const resultsEl = h('div', { class: 'stack' });
      const toolsEl = h('div', { class: 'stack' });
      const credit = () => h('p', { class: 'credit' }, `${info.credit || ''}. ${info.terms || ''}`);

      function paintTopics() {
        put(topicsEl, info.packs.map(p => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(topic === p.id), title: p.blurb, onclick: () => { topic = topic === p.id ? null : p.id; paintTopics(); paintPack(); } },
          p.short + (p.state === 'ready' ? ' · on this PC' : ''))));
      }
      function packLine(p) {
        const state = p.state === 'ready' ? pill('On this PC', 'ok') : p.state === 'getting' ? pill(p.progress != null ? `Getting ${fmt.pct(p.progress)}` : 'Getting', 'run') : p.state === 'failed' ? pill('Did not work', 'stop') : pill('Not on this PC');
        return card({ class: 'packcard' },
          h('div', { class: 'row' }, h('h3', null, p.title), state),
          h('p', { class: 'sub' }, `${p.forBuilders}. ${p.blurb}`),
          h('p', { class: 'sub' }, `${p.rows.toLocaleString()} endpoints from ${p.services.toLocaleString()} services · ${p.bytesText} download · tested ${day(p.testedFrom)} to ${day(p.testedTo)}`),
          p.note ? h('p', { class: 'sub' }, p.note) : null,
          h('div', { class: 'row' },
            p.state === 'ready' ? btn('Search this pack', { kind: 'sm', onClick: () => find(p.id) }) : null,
            p.state === 'ready' ? btn('Remove', { kind: 'ghost sm', onClick: async () => { if (!(await ui.confirm(`Remove the ${p.title} pack from this PC? It frees ${p.bytesText}. Ticked endpoints stay.`, { ok: 'Remove' }))) return; try { await api(`m/apis/packs/${p.id}`, { method: 'DELETE' }); await load(); } catch (e) { toast(e.message, 'err'); } } })
              : p.state === 'getting' ? h('span', { class: 'sub' }, p.detail || 'Approve the card to start.')
                : btn('Get', { kind: 'sm', title: `Downloads ${p.bytesText} from GitHub after you approve it`, onClick: async () => { try { await api(`m/apis/packs/${p.id}/get`, { method: 'POST' }); toast('Approve the card to start the download.', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); } } })),
          credit());
      }
      function paintPack() { const p = info.packs.find(x => x.id === topic); put(packEl, p ? packLine(p) : null); }

      function endpoint(r) {
        const out = h('div');
        const ticked = tools.some(t => t.url === r.url);
        return card({ class: 'ep' },
          h('div', { class: 'row' }, h('b', { style: { flex: '1 1 200px', minWidth: '0', overflowWrap: 'anywhere' } }, r.title),
            btn('Try it', { kind: 'ghost sm', title: 'One read-only GET, no key or cookies', onClick: () => tryIt(r.url, out) }),
            h('span', { class: 'tick' }, h('span', { class: 'swlabel', 'aria-hidden': 'true' }, TICK_LABEL),
              sw(ticked, 'Agents may use ' + r.title, async (on) => {
                if (on) await api('m/apis/tools', { body: { pack: r.pack, url: r.url } });
                else { const t = tools.find(x => x.url === r.url); if (t) await api('m/apis/tools/' + t.id, { method: 'DELETE' }); }
                await loadTools();
                toast(tickToast(on, r.title), 'ok');
              }, { title: 'When on, your agents may call this address' }))),
          h('div', { class: 'facts' }, h('span', null, r.service), h('span', null, 'Country: ' + r.country), h('span', null, 'Format: ' + r.format), h('span', null, 'Key: ' + r.key), h('span', null, 'Tested: ' + day(r.lastTested))),
          h('div', { class: 'mono' }, r.url),
          out,
          h('p', { class: 'credit' }, `${r.credit}. ${r.terms}`));
      }
      async function tryIt(url, out) {
        put(out, h('span', { class: 'sub' }, 'Calling… approve the card if asked.'));
        try {
          const r = await api('m/apis/try', { body: { url } });
          put(out, h('div', { class: 'row' }, pill(r.ok ? 'Answered' : 'Did not work', r.ok ? 'ok' : 'stop'),
              h('span', { class: 'sub' }, r.ok ? `HTTP ${r.status} · ${r.type || 'type not stated'} · ${fmt.bytes(r.bytes)}${r.truncated ? ' (only the start was read)' : ''} · ${(r.ms / 1000).toFixed(2)} s · ${r.source?.fetchedAtText || ''}` : r.error)),
            r.sample ? h('pre', { class: 'sample' }, r.sample) : null,
            h('p', { class: 'credit' }, r.note));
        } catch (e) { put(out, pill('Did not work', 'stop'), h('p', { class: 'sub' }, e.message)); }
      }
      async function find(pack) {
        put(resultsEl, h('span', { class: 'sub' }, 'Searching the packs on this PC…'));
        const params = new URLSearchParams({ q: q.value.trim() }); if (pack) params.set('pack', pack);
        if (cc.value.trim()) params.set('country', cc.value.trim()); if (fm.value) params.set('format', fm.value);
        try {
          const r = await api('m/apis/search?' + params);
          const sug = r.suggestions.length ? card(h('h3', null, 'Topics that may fit'), h('p', { class: 'sub' }, 'These packs are not on this PC yet. Pick one and press Get.'),
            h('div', { class: 'chips' }, r.suggestions.map(p => h('button', { type: 'button', class: 'chip', onclick: () => { topic = p.id; paintTopics(); paintPack(); packEl.scrollIntoView({ block: 'nearest' }); } }, `${p.short} · ${p.bytesText}`)))) : null;
          const head = !r.searched.length ? empty('No pack is on this PC yet. Pick a topic above and press Get.') : h('p', { class: 'sub' }, `${r.rows.length ? r.rows.length + ' best matches' : 'Nothing matched'} from ${r.scanned.toLocaleString()} endpoints in ${r.searched.length} pack${r.searched.length === 1 ? '' : 's'}. ${r.tested}`);
          put(resultsEl, sug, head, r.rows.map(endpoint));
        } catch (e) { put(resultsEl, empty(ui.plainError(e))); }
      }
      async function loadTools() {
        tools = (await api('m/apis/tools')).tools;
        put(toolsEl, tools.length ? tools.map(t => card({ class: 'ep' },
          h('div', { class: 'row' }, h('b', { style: { flex: '1 1 200px', minWidth: '0', overflowWrap: 'anywhere' } }, t.title),
            btn('Untick', { kind: 'ghost sm', onClick: async () => { try { await api('m/apis/tools/' + t.id, { method: 'DELETE' }); await loadTools(); } catch (e) { toast(e.message, 'err'); } } })),
          h('div', { class: 'facts' }, h('span', null, t.service), h('span', null, 'Country: ' + t.country), h('span', null, 'Format: ' + t.format), h('span', null, 'Added ' + fmt.when(t.added))),
          h('div', { class: 'mono' }, t.url),
          h('p', { class: 'credit' }, `${t.credit}. ${t.terms}`))) : [empty('No endpoint ticked yet. Tick one in the results and your agents can read it.')]);
      }
      async function load() { info = await api('m/apis/packs'); paintTopics(); paintPack(); }

      el.replaceChildren(
        h('div', null, h('h2', null, 'APIs'), h('p', { class: 'sub', style: { whiteSpace: 'normal' } }, 'Public data addresses from the AgentPopulation packs. Each row shows only what its pack recorded; a field the pack left empty says not checked. A pack is downloaded only when you press Get; after that it is searched on this PC and works offline.')),
        card(h('div', { class: 'need' }, q, cc, fm, btn('Find', { onClick: () => find(topic) })),
          h('h3', { style: { margin: '10px 0 6px' } }, 'Topics'), topicsEl),
        packEl,
        h('h3', null, 'Results'), resultsEl,
        h('h3', null, 'Your agents may use'), toolsEl,
        h('p', { class: 'credit' }, 'Packs: github.com/agentpopulation, CC BY 4.0. Credit AgentPopulation, agentpopulation.com. The data each endpoint returns belongs to its provider. The terms of each API were not reviewed.'));
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(topic); });
      put(resultsEl, empty('Say what you need data for, or pick a topic.'));
      await Promise.all([load(), loadTools()]);
      ui.on('apis', () => load().catch(() => {}));
      ui.on('job', () => { if (info.packs.some(p => p.state === 'getting')) load().catch(() => {}); });
    },
  },
};
