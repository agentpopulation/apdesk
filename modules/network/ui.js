// Settings › Network: connection, speed test, model test, devices on your network, and public domain lookups.
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
export const settings = {
  network: {
    title: 'Network',
    async render(el, ui) {
      const { h, api, card, line, btn, pill, toast, fmt, empty, meter } = ui;
      const waitJob = (jobId, onProgress) => new Promise((resolve) => {
        const off = ui.on('job', async (j) => { if (j?.id !== jobId) return; onProgress?.(j); if (!['running', 'waiting'].includes(j.status)) { off(); resolve(await api('jobs/' + jobId)); } });
      });
      const conn = h('div'), speed = h('div'), models = h('div'), lan = h('div'), look = h('div', { class: 'stack' });
      // connection
      async function paintConn() {
        put(conn, h('span', { class: 'sub' }, 'Checking…'));
        try { const c = await api('m/network/connection'); put(conn, ...c.rows.map(r => line(r.name, r.detail, pill(r.ok ? 'Good' : 'Not reachable', r.ok ? 'ok' : r.name === 'Ollama' ? '' : 'stop')))); }
        catch (e) { put(conn, h('p', { class: 'sub' }, e.message)); }
      }
      // speed
      const speedLine = (r) => `${r.downMbps} Mbps down · ${r.upMbps} Mbps up · ping ${r.pingMs} ms${r.jitterMs != null ? ` (jitter ${r.jitterMs} ms)` : ''}`;
      async function paintSpeed(running) {
        const s = await api('m/network/speed'); const last = s.history[0];
        const bar = meter(0, { live: true });
        const go = btn('Test speed', { onClick: async () => { go.disabled = true; const { jobId } = await api('m/network/speed', { body: {} }); put(speed.querySelector('.res'), h('span', { class: 'sub' }, 'Testing…'), bar); const j = await waitJob(jobId, (x) => bar.set(x.progress || 0)); if (j.status !== 'done') toast('Speed test: ' + (j.error || j.status), 'err'); paintSpeed(); } });
        put(speed, line('Speed test', `Downloads about 20 MB and uploads 6 MB to ${s.server} (Cloudflare’s public speed server).`, go),
          h('div', { class: 'res' }, last ? h('div', null, h('b', null, speedLine(last)), h('span', { class: 'sub', style: { display: 'block' } }, `${last.server} · ${fmt.when(last.at)}`)) : h('span', { class: 'sub' }, 'Not tested yet.')),
          s.history.length > 1 ? h('div', null, ...s.history.slice(1, 4).map(r => h('span', { class: 'sub', style: { display: 'block' } }, `${fmt.when(r.at)}: ${speedLine(r)}`))) : null);
      }
      // model test
      function paintModels(res) {
        const go = btn('Test now', { onClick: async () => { go.disabled = true; go.textContent = 'Testing…'; const { jobId } = await api('m/network/model-test', { body: {} }); const j = await waitJob(jobId); paintModels(j.output?.results || []); if (j.status !== 'done') toast(j.error || 'Model test stopped', 'err'); } });
        put(models, line('Model test', 'One short question to each active model, timed to the first word', go),
          ...(res || []).map(r => line(r.label, r.ok ? `First word after ${(r.firstTokenMs / 1000).toFixed(2)} s, whole answer ${(r.totalMs / 1000).toFixed(2)} s: “${r.reply}”` : r.error, pill(r.ok ? 'Answered' : 'No answer', r.ok ? 'ok' : 'stop'))));
      }
      // LAN
      async function paintLan(last) {
        if (last === undefined) last = (await api('m/network/lan')).last;
        const go = btn('Scan LAN', { onClick: async () => { go.disabled = true; go.textContent = 'Waiting for you…'; try { const { jobId } = await api('m/network/lan', { body: {} }); const j = await waitJob(jobId, (x) => { if (x.status === 'running') go.textContent = 'Scanning…'; }); if (j.status !== 'done') toast(j.error || 'Scan stopped', 'err'); paintLan(j.output || null); } catch (e) { toast(e.message, 'err'); paintLan(); } } });
        const nodes = ui.state.settings['network.lanNodes'] || [];
        const addNode = async (d, s) => {
          const id = 'n' + d.ip.replace(/\./g, '') + s.port;
          const next = [...nodes.filter(n => n.id !== id), { id, name: `${s.what === 'ollama' ? 'Ollama' : 'Router'} on ${d.ip}`, baseUrl: s.baseUrl, models: s.models || [], model: (s.models || [])[0] || null, enabled: true }];
          try { const r = await api('settings', { body: { 'network.lanNodes': next } }); ui.state.settings = r.settings; toast('Added. It shows on the Models page.', 'ok'); paintLan(last); } catch (e) { toast(e.message, 'err'); }
        };
        put(lan, line('Devices on your network', 'Other PCs that can run models. Reads the ARP table and knocks once on ports 11434 and 8787 in your own network only. Asks you first.', go),
          last ? h('div', { class: 'stack' },
            h('span', { class: 'sub' }, `Scanned ${fmt.when(last.at)} · ${last.nets.length ? last.nets.join(', ') : 'no private network found on this PC'} · ${last.probed} addresses checked`),
            h('div', null, h('b', { style: { fontSize: '13px' } }, 'This PC'), ...last.interfaces.map(i => h('span', { class: 'sub', style: { display: 'block' } }, `${i.name}: ${i.address} (${i.family}${i.private ? ', private' : ''})`))),
            last.devices.length ? ui.table([{ label: 'Address', render: d => d.ip }, { label: 'Hardware address', render: d => d.mac || '' }, { label: 'Runs', render: d => d.services.length ? d.services.map(s => `${s.what === 'ollama' ? 'Ollama' : 'Router'}${s.confirmed ? ` (${(s.models || []).length} models)` : ' (not confirmed)'}`).join(', ') : 'Nothing we look for' },
              { label: '', render: d => h('span', null, ...d.services.filter(s => s.confirmed).map(s => nodes.some(n => n.baseUrl === s.baseUrl) ? pill('Added', 'ok') : btn('Add as a model node', { kind: 'ghost sm', onClick: () => addNode(d, s) }))) }], last.devices) : empty('No other devices answered.')) : h('span', { class: 'sub' }, 'Not scanned yet.'));
      }
      // lookups
      const q = h('input', { type: 'text', placeholder: 'A domain, for example example.com', style: { flex: '1', minWidth: '220px' } });
      const KINDS = [['dns', 'DNS records'], ['rdap', 'Registration'], ['headers', 'Web headers'], ['tls', 'Certificate'], ['robots', 'robots.txt'], ['company', 'About the company']];
      const show = (kind, r) => {
        if (r.error) return line(KINDS.find(k => k[0] === kind)[1], r.error, pill('No answer', 'stop'));
        const t = KINDS.find(k => k[0] === kind)[1];
        if (kind === 'dns') return h('div', null, h('b', null, t), h('span', { class: 'sub', style: { display: 'block' } }, r.source), ...(r.records.length ? r.records.map(x => h('span', { style: { display: 'block', fontFamily: 'var(--mono)', fontSize: '12.5px', wordBreak: 'break-all' } }, `${x.type.padEnd(5)} ${x.data}`)) : [h('span', { class: 'sub' }, 'No records.')]));
        if (kind === 'rdap') return r.found ? h('div', null, h('b', null, t), h('span', { class: 'sub', style: { display: 'block' } }, r.source), line('Registrar', r.registrar || 'Not public'), line('Registered', fmt.date(r.registered)), line('Expires', fmt.date(r.expires)), line('Name servers', r.nameservers.join(', ')), line('Status', r.status.join(', ') || 'None listed')) : line(t, r.note);
        if (kind === 'headers') return h('div', null, h('b', null, t), h('span', { class: 'sub', style: { display: 'block' } }, `${r.finalUrl} answered ${r.status}`), ...r.headers.map(x => line(x.name, x.value)));
        if (kind === 'tls') return h('div', null, h('b', null, t), line('Issued to', r.subject || ''), line('Issued by', r.issuer || ''), line('Valid until', fmt.date(r.validTo)), line('Trusted by this PC', r.trusted ? 'Yes' : 'No: ' + r.problem), line('Also covers', r.names.slice(0, 8).join(', ')));
        if (kind === 'robots') return h('div', null, h('b', null, t), r.found ? h('pre', { style: { whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '200px', overflow: 'auto', background: 'var(--bubble)', borderRadius: 'var(--r-s)', padding: '8px' } }, r.text.slice(0, 3000)) : h('span', { class: 'sub', style: { display: 'block' } }, `No robots.txt (answer ${r.status}).`));
        if (kind === 'company') return h('div', null, h('b', null, t), ...r.pages.map(p => h('div', null, h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, p.title || p.url), h('span', { class: 'sub', style: { display: 'block' } }, p.description))), r.search ? h('div', null, h('span', { class: 'sub' }, 'From search:'), ...r.search.map(s => h('div', null, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title), h('span', { class: 'sub', style: { display: 'block' } }, s.snippet)))) : h('span', { class: 'sub', style: { display: 'block' } }, r.searchNote || ''));
      };
      const out = h('div', { class: 'stack' });
      const run = async (kinds) => { const v = q.value.trim(); if (!v) return toast('Give a domain.', 'err'); put(out, h('span', { class: 'sub' }, 'Looking up…')); const parts = await Promise.all(kinds.map(async k => { try { return show(k, await api(`m/network/lookup/${k}?q=${encodeURIComponent(v)}`)); } catch (e) { return show(k, { error: e.message }); } })); put(out, ...parts); };
      look.append(h('div', { class: 'row' }, q, btn('Look up', { onClick: () => run(['dns', 'rdap', 'tls']) }), ...KINDS.map(([k, label]) => btn(label, { kind: 'ghost sm', onClick: () => run([k]) }))),
        h('p', { class: 'sub' }, 'Public facts only. No people search, no breach data, no scanning of other people’s machines.'), out);
      el.append(card(h('div', { class: 'row' }, h('h3', { style: { margin: 0 } }, 'Connection'), h('span', { class: 'grow' }), btn('Check again', { kind: 'ghost sm', onClick: paintConn })), conn),
        card(speed, models), card(lan), card(h('h3', null, 'Look up a domain'), look));
      paintConn(); paintSpeed(); paintModels([]); paintLan();
    },
  },
};
