// The Network page: one section at a time, picked from the list on the left (a row of tabs on a phone).
// Everything from the web is shown as plain text (text nodes only); nothing here builds markup from what a site said.
import { lineModel, barModel, drawLine, drawBars, legend } from './ui-chart.js';

const SECTIONS = [
  ['connection', 'Connection'], ['speed', 'Speed and latency'], ['watch', 'Websites to watch'], ['visits', 'Where the agents went'],
  ['diagnose', 'Is it me or them?'], ['ai', 'AI provider speed'], ['devices', 'Devices'], ['domain', 'Your domain'],
  ['rules', 'Website rules'], ['ports', 'What listens here'], ['lookup', 'Look up a domain'], ['data', 'Desk data use'],
];
const NEEDS_NET = new Set(['speed', 'watch', 'diagnose', 'domain', 'lookup']);
const CSS = `
.view.netv{padding:0;gap:0;height:100%;min-height:0}
.netp{display:grid;grid-template-columns:200px minmax(0,1fr);gap:0;height:100%;min-height:0}
.netp-nav{padding:14px 10px;border-right:1px solid var(--line);overflow:auto;min-height:0}
.netp-nav .nav{width:100%;padding:7px 10px;font-size:13.5px}
.netp-body{overflow:auto;min-height:0;padding:16px 22px 28px;display:flex;flex-direction:column;gap:14px}
.netp-body h2{margin:0;font-size:18px}
.netp .card h3{margin:0 0 6px;font-size:14.5px}
.netp .kv{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr);gap:6px 14px;font-size:13.5px}.netp .kv>span:nth-child(odd){color:var(--dim)}
.netp .mono{font-family:var(--mono);font-size:12.5px;word-break:break-all}
.netp .strip{display:flex;gap:2px;flex-wrap:nowrap;overflow:hidden;margin:6px 0;justify-content:flex-end;width:fit-content;max-width:100%}.netp .strip i{flex:0 0 7px;height:16px;border-radius:2px;background:var(--line)}
.netp .strip i.up{background:var(--ok)}.netp .strip i.slow{background:var(--warn)}.netp .strip i.down{background:var(--stop)}.netp .strip i.blocked{background:var(--dim)}
.netp .verdict{font-size:17px;font-weight:600;margin:4px 0}
.netp-legend{display:flex;gap:14px;font-size:12.5px;color:var(--dim);margin:4px 0}.netp-legend i{display:inline-block;width:12px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.netp details summary{cursor:pointer;color:var(--dim);font-size:12.5px;margin-top:6px}
.netp .two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.netp .cmp{max-height:340px;overflow:auto;font-size:12.5px;white-space:pre-wrap;background:var(--bubble);border-radius:var(--r-s);padding:8px}
.netp .cmp .add{color:var(--ok)}.netp .cmp .del{color:var(--stop)}
.netp .grey{opacity:.55}
.netp input[type=text],.netp input[type=number],.netp select{min-width:0}
.netp .banner{background:var(--stop-soft);color:var(--stop);border-radius:var(--r-s);padding:8px 12px;font-size:13px}
@media (max-width:860px){.netp{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.netp-nav{display:flex;flex-direction:row;gap:4px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px 12px}.netp-nav .nav{width:auto;white-space:nowrap;flex:0 0 auto}.netp-body{padding:14px 16px 24px}.netp .two{grid-template-columns:minmax(0,1fr)}.netp .kv{grid-template-columns:minmax(0,1fr)}.netp .kv>span:nth-child(odd){margin-top:4px}}
`;
const put = (el, ...xs) => el.replaceChildren(...xs.flat().filter((x) => x != null && x !== false));
const mb = (b) => (Number(b) || 0) / 1e6;
const one = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const pages = {
  network: {
    title: 'Network',
    async render(el, ui, route) {
      const { h, api, card, btn, pill, toast, fmt, empty, line } = ui;
      if (!document.getElementById('netp-css')) document.head.append(h('style', { id: 'netp-css' }, CSS));
      el.classList.add('netv');
      const cur = SECTIONS.some(s => s[0] === route?.parts?.[0]) ? route.parts[0] : 'connection';
      const offline = ui.state.settings?.online === false;
      const body = h('div', { class: 'netp-body' });
      const nav = h('nav', { class: 'netp-nav list', 'aria-label': 'Network sections' }, SECTIONS.map(([id, label]) => h('button', { class: 'nav', type: 'button', 'aria-current': id === cur ? 'page' : null, onclick: () => ui.go('network', id) }, label)));
      el.replaceChildren(h('div', { class: 'netp' }, nav, body));
      requestAnimationFrame(() => { const b = nav.querySelector('[aria-current]'); if (b && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2; });
      const title = SECTIONS.find(s => s[0] === cur)[1];
      const head = h('div', { class: 'row' }, h('h2', null, title), h('span', { class: 'grow' }));
      put(body, head, offline && NEEDS_NET.has(cur) ? h('div', { class: 'banner', role: 'status' }, 'The desk is offline. This section needs the internet; what was stored before is shown.') : null);
      const box = h('div', { class: 'stack' }); body.append(box);
      const waitJob = (jobId, onProgress) => new Promise((resolve) => { const off = ui.on('job', async (jx) => { if (jx?.id !== jobId) return; onProgress?.(jx); if (!['running', 'waiting'].includes(jx.status)) { off(); resolve(await api('jobs/' + jobId)); } }); });
      const busy = async (b, text, fn) => { const old = b.textContent; b.disabled = true; b.textContent = text; try { return await fn(); } catch (e) { toast(e.message, 'err'); return null; } finally { b.disabled = false; b.textContent = old; } };
      const kv = (pairs) => h('div', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('span', null, k), h('span', null, v ?? 'Not shown')]));
      const select = (opts, value, onChange, label) => { const s = h('select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) }, opts.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t))); return s; };
      const ms = (v) => (v == null ? '' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
      const timeLabel = (span) => (t) => span > 2 * 86400_000 ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: ui.state.settings?.timeZone }) : fmt.time(new Date(t).toISOString());
      const chart = (series, { title: t, unit, height = 190, names }) => {
        const pts = series.flatMap(s => s.points); const span = pts.length ? Math.max(...pts.map(p => p.t)) - Math.min(...pts.map(p => p.t)) : 0;
        const w = Math.max(280, Math.min(1400, (body.clientWidth || 700) - 70));
        const m = lineModel(series, { width: w, height, timeLabel: timeLabel(span), valueLabel: (v) => `${v} ${unit}` });
        return h('div', null, legend(document, names || series.map(s => s.name)), drawLine(document, m, { title: t }));
      };
      const C = { h, api, card, btn, pill, toast, fmt, empty, line, ui, box, head, waitJob, busy, kv, select, ms, chart, offline, put };
      try { await (SECTION_RENDER[cur])(C); } catch (e) { put(box, h('p', { class: 'sub' }, 'This section could not load: ' + e.message)); }
    },
  },
};

const SECTION_RENDER = {
  // ---------------- A
  async connection({ h, api, card, btn, fmt, kv, select, busy, box, put, offline, toast, line, pill }) {
    const local = h('div'), pub = h('div'), desk = h('div');
    const paintLocal = async () => {
      const c = await api('m/network/local');
      const sig = c.signal ? [c.signal.dBm != null ? `${c.signal.dBm} dBm` : null, c.signal.quality != null ? `${c.signal.quality}%` : null].filter(Boolean).join(', ') : null;
      put(local, h('h3', null, 'This PC'), c.connected ? kv([
        ['Connected by', c.kind === 'wifi' ? `Wi-Fi${c.signal?.ssid ? ' (' + c.signal.ssid + ')' : ''}` : c.kind === 'cable' ? 'Cable' : c.kind === 'virtual' ? 'A virtual adapter' : 'Another kind of link'],
        ['Adapter', c.adapter], ['Link speed', c.linkMbps ? `${c.linkMbps} Mbps` : 'Not given by the system'],
        c.kind === 'wifi' ? ['Signal', sig ? `${sig} (${signalWords(c.signal.dBm) || 'unknown'})` : 'Not given by the system'] : null,
        ['Local address', [c.localIPv4, c.localIPv6].filter(Boolean).join(' · ') || null], ['Router (gateway)', c.gateway || 'Not given by the system'],
        ['DNS servers', c.dnsServers.length ? c.dnsServers.join(', ') : 'Not given by the system'],
        c.others.length ? ['Other adapters', c.others.map(o => `${o.adapter} ${o.address}`).join(', ')] : null,
      ]) : h('p', { class: 'sub' }, 'No network adapter is connected.'), h('p', { class: 'sub', style: { marginTop: '8px' } }, 'Read from this PC. Nothing was sent anywhere.'));
    };
    const paintPub = async () => {
      const p = await api('m/network/public'); const r = p.last;
      const go = btn('Look up my public address', { disabled: offline, onClick: () => busy(go, 'Looking up…', async () => { await api('m/network/public', { body: {} }); await paintPub(); }) });
      put(pub, h('div', { class: 'row' }, h('h3', null, 'Public address'), h('span', { class: 'grow' }), go),
        h('p', { class: 'sub' }, `Looking it up shows your address to ${p.sources.ip.split(' (')[0]} and ${p.sources.asn.split(' (')[0]}.`),
        r ? h('div', { style: { marginTop: '8px' } }, kv([['Address', r.ip], ['Network operator', r.operator || 'Not found'], ['AS number', r.asn ? `AS${r.asn}` : 'Not found'], ['Address block', r.prefix], ['Country', r.country]]),
          h('p', { class: 'sub', style: { marginTop: '6px' } }, `Looked up ${fmt.when(r.at)} via ${r.sources.join(' and ')}${r.trigger === 'schedule' ? ' (your daily schedule)' : ''}.${r.note ? ' ' + r.note : ''}`))
          : h('p', { class: 'sub' }, 'Not looked up yet.'),
        line('Look it up by itself', 'Off unless you choose it.', select([['off', 'Off'], ['daily', 'Once a day']], p.every, async (v) => { try { await api('m/network/public/schedule', { body: { every: v } }); toast('Saved', 'ok'); } catch (e) { toast(e.message, 'err'); } }, 'Public address schedule')));
    };
    const paintDesk = async (check) => {
      const c = await api('m/network/connection' + (check ? '?check=1' : ''));
      const go = btn('Check the internet', { kind: 'ghost sm', disabled: offline, onClick: () => busy(go, 'Checking…', () => paintDesk(true)) });
      put(desk, h('div', { class: 'row' }, h('h3', null, 'Desk and models'), h('span', { class: 'grow' }), go), ...c.rows.map(r => line(r.name, r.detail, pill(r.ok ? 'Good' : 'Not reachable', r.ok ? 'ok' : r.name === 'Ollama' ? '' : 'stop'))));
    };
    put(box, card(local), card(pub), card(desk));
    await Promise.all([paintLocal(), paintPub(), paintDesk(false)]);
  },

  // ---------------- B
  async speed({ h, api, card, btn, fmt, select, busy, box, put, offline, toast, line, waitJob, chart, ms, ui }) {
    const top = h('div'), charts = h('div', { class: 'stack' }), setBox = h('div');
    const paint = async () => {
      const s = await api('m/network/speed');
      const hist = [...s.history].reverse();
      const last = s.history[0];
      const run = (kind) => async (b) => {
        let overCap = false;
        if (s.settings.capMb > 0 && mb(s.usedThisMonth) + mb(kind === 'full' ? s.fullTestBytes : s.latencyTestBytes) > s.settings.capMb) { if (!(await ui.confirm(`This test would go over your monthly cap of ${s.settings.capMb} MB. Run it anyway?`, { ok: 'Run it' }))) return; overCap = true; }
        await busy(b, 'Testing…', async () => { const { jobId } = await api('m/network/speed', { body: { kind, overCap } }); const jx = await waitJob(jobId); if (jx.status !== 'done') toast('Not finished: ' + (jx.error || jx.status), 'err'); await paint(); });
      };
      const full = btn(`Full test (about ${Math.round(mb(s.fullTestBytes))} MB)`, { disabled: offline }); full.onclick = () => run('full')(full);
      const lat = btn('Latency only (a few KB)', { kind: 'ghost', disabled: offline }); lat.onclick = () => run('latency')(lat);
      put(top, h('div', { class: 'row' }, full, lat),
        h('p', { class: 'sub', style: { marginTop: '8px' } }, `Against ${s.server} (Cloudflare’s public speed server). A full test downloads about 20 MB and uploads about 6 MB; latency, jitter and loss come from ten tiny timed requests.`),
        last ? h('p', { style: { margin: '8px 0 0' } }, h('b', null, last.kind === 'full' ? `${last.downMbps} Mbps down · ${last.upMbps} Mbps up · ` : ''), `latency ${last.pingMs ?? '?'} ms, jitter ${last.jitterMs ?? '?'} ms, loss ${last.lossPct ?? 0}%`, h('span', { class: 'sub' }, ` · ${fmt.when(last.at)}${last.trigger === 'schedule' ? ' (schedule)' : ''}`)) : h('p', { class: 'sub' }, 'Not tested yet.'),
        h('p', { class: 'sub' }, `Speed tests used ${mb(s.usedThisMonth).toFixed(1)} MB this month${s.settings.capMb ? ` of your ${s.settings.capMb} MB cap` : ''}.${s.skipped ? ` A scheduled test was skipped ${fmt.when(s.skipped.at)}: over the cap.` : ''}`));
      const every = { off: 0, '1h': 720, '6h': 120, '12h': 60, daily: 30 }[s.settings.every] || 0;
      const est = every * mb(s.settings.kind === 'full' ? s.fullTestBytes : s.latencyTestBytes);
      const capIn = h('input', { type: 'number', min: '0', step: '50', value: String(s.settings.capMb || 0), style: { width: '110px' }, 'aria-label': 'Monthly cap in MB' });
      const save = async (patch) => { try { await api('m/network/speed/settings', { body: patch }); toast('Saved', 'ok'); await paint(); } catch (e) { toast(e.message, 'err'); } };
      capIn.onchange = () => save({ capMb: Number(capIn.value) || 0 });
      put(setBox, h('h3', null, 'By itself'),
        line('How often', 'Off unless you choose it. Paused while the desk is offline or stopped.', select([['off', 'Off'], ['1h', 'Every hour'], ['6h', 'Every 6 hours'], ['12h', 'Every 12 hours'], ['daily', 'Once a day']], s.settings.every, (v) => save({ every: v }), 'How often')),
        line('Which test', every ? `About ${est >= 1000 ? (est / 1000).toFixed(1) + ' GB' : Math.round(est) + ' MB'} a month at this pace.` : 'Latency only uses almost no data.', select([['latency', 'Latency only'], ['full', 'Full test']], s.settings.kind, (v) => save({ kind: v }), 'Which test')),
        line('Monthly cap for speed tests', '0 means no cap. A scheduled test that would pass it is skipped; you are asked before a test you start.', h('span', { class: 'row' }, capIn, h('span', { class: 'sub' }, 'MB'))));
      const fulls = hist.filter(r => r.kind === 'full' && r.downMbps != null);
      const toPts = (rows, k) => rows.map(r => ({ t: Date.parse(r.at), v: r[k] }));
      put(charts,
        h('h3', null, 'Download and upload'), fulls.length ? chart([{ name: 'Download (Mbps)', points: toPts(fulls, 'downMbps') }, { name: 'Upload (Mbps)', points: toPts(fulls, 'upMbps') }], { title: 'Download and upload speed in megabits per second over time', unit: 'Mbps' }) : h('p', { class: 'sub' }, 'No full test yet.'),
        h('h3', { style: { marginTop: '10px' } }, 'Latency'), hist.length ? chart([{ name: 'Latency (ms)', points: toPts(hist, 'pingMs') }, { name: 'Jitter (ms)', points: toPts(hist, 'jitterMs') }], { title: 'Latency and jitter in milliseconds over time', unit: 'ms' }) : h('p', { class: 'sub' }, 'No test yet.'),
        hist.length ? h('details', null, h('summary', null, `The same numbers as a table (${one(hist.length, 'test')})`), ui.table([
          { label: 'When', render: r => fmt.when(r.at) }, { label: 'Kind', render: r => r.kind === 'full' ? 'Full' : 'Latency' }, { label: 'Down (Mbps)', render: r => r.downMbps ?? '' }, { label: 'Up (Mbps)', render: r => r.upMbps ?? '' },
          { label: 'Latency', render: r => ms(r.pingMs) }, { label: 'Jitter', render: r => ms(r.jitterMs) }, { label: 'Loss', render: r => r.lossPct != null ? r.lossPct + '%' : '' }], [...hist].reverse().slice(0, 300))) : null);
    };
    put(box, card(top), card(charts), card(setBox));
    await paint();
  },

  // ---------------- C
  async watch({ h, api, card, btn, pill, fmt, select, busy, box, put, offline, toast, ui, ms, empty }) {
    const addBox = h('div'), list = h('div', { class: 'stack' }), noticesBox = h('div');
    const url = h('input', { type: 'text', placeholder: 'example.com or https://example.com/page', style: { flex: '1', minWidth: '200px' }, 'aria-label': 'Address to watch' });
    let every = 30, change = 1440, slow = 3, phone = false;
    const phoneOn = ui.moduleOn('channels');
    const add = btn('Watch it', { onClick: () => busy(add, 'Adding…', async () => { await api('m/network/sites', { body: { url: url.value, everyMin: every, changeMin: change, slowMs: Math.round(slow * 1000), phone } }); url.value = ''; await paint(); }) });
    const slowIn = h('input', { type: 'number', min: '0.2', step: '0.5', value: '3', style: { width: '80px' }, 'aria-label': 'Slow after seconds', onchange: (e) => { slow = Number(e.target.value) || 3; } });
    put(addBox, h('h3', null, 'Add a site'), h('div', { class: 'row' }, url, add),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('span', { class: 'sub' }, 'Up or down'), select([[5, 'Every 5 min'], [15, 'Every 15 min'], [30, 'Every 30 min'], [60, 'Every hour'], [360, 'Every 6 hours'], [1440, 'Once a day']], 30, (v) => { every = Number(v); }, 'How often to check'),
        h('span', { class: 'sub' }, 'Text changes'), select([[0, 'Off'], [360, 'Every 6 hours'], [1440, 'Once a day']], 1440, (v) => { change = Number(v); }, 'How often to compare text'),
        h('span', { class: 'sub' }, 'Slow after'), slowIn, h('span', { class: 'sub' }, 's'),
        phoneOn ? h('label', { class: 'row', style: { gap: '6px' } }, h('input', { type: 'checkbox', onchange: (e) => { phone = e.target.checked; } }), h('span', { class: 'sub' }, 'Also tell my phone (ntfy)')) : null),
      h('p', { class: 'sub', style: { marginTop: '8px' } }, 'One request per check with the desk’s own name, never more often than every 5 minutes, longer waits when a site asks us to slow down, and its robots.txt is respected.'));
    const STATE = { up: ['Up', 'ok'], slow: ['Slow', 'wait'], down: ['Down', 'stop'], blocked: ['Blocked', ''] };
    const paint = async () => {
      const [{ sites }, { notices }] = await Promise.all([api('m/network/sites'), api('m/network/notices')]);
      const recent = notices.filter(n => /^site\./.test(n.kind)).slice(0, 6);
      put(noticesBox, recent.length ? h('div', null, h('h3', null, 'Recent notices'), ...recent.map(n => h('div', { class: 'sub' }, `${fmt.when(n.at)}: ${n.title}`))) : null);
      if (!sites.length) return put(list, empty('No sites yet. Add one above.'));
      put(list, ...sites.map(s => {
        const [label, kind] = STATE[s.state] || ['Not checked yet', ''];
        const pts = s.strip.filter(c => c.ms != null).map(c => ({ t: Date.parse(c.at), v: c.ms }));
        const check = btn('Check now', { kind: 'ghost sm', disabled: offline, onClick: () => busy(check, 'Checking…', async () => { await api(`m/network/sites/${s.id}/check`, { body: {} }); await paint(); }) });
        const text = btn('Compare text now', { kind: 'ghost sm', disabled: offline, onClick: () => busy(text, 'Reading…', async () => { const r = await api(`m/network/sites/${s.id}/change`, { body: {} }); if (r.changeError) toast(r.changeError, 'err'); await paint(); }) });
        const pause = btn(s.enabled ? 'Pause' : 'Resume', { kind: 'ghost sm', onClick: async () => { await api(`m/network/sites/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }); paint(); } });
        const del = btn('Remove', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm(`Stop watching ${s.host}?`, { ok: 'Remove' })) { await api(`m/network/sites/${s.id}`, { method: 'DELETE' }); paint(); } } });
        const w = Math.max(240, Math.min(560, (list.clientWidth || 600) - 40));
        return card(h('div', { class: 'row' }, h('b', null, s.host), pill(s.enabled ? label : 'Paused', s.enabled ? kind : ''), h('span', { class: 'grow' }), check, text, pause, del),
          h('div', { class: 'sub mono' }, s.url),
          h('div', { class: 'sub', style: { marginTop: '4px' } }, [s.lastAt ? `Checked ${fmt.when(s.lastAt)}` : 'Not checked yet', s.status ? `answer ${s.status}` : null, s.ms != null ? ms(s.ms) : null, s.certDays != null ? `certificate ends in ${one(s.certDays, 'day')}` : null, `every ${s.everyMin >= 60 ? one(s.everyMin / 60, 'hour') : s.everyMin + ' min'}`].filter(Boolean).join(' · ')),
          s.note ? h('div', { class: 'sub' }, s.note) : null,
          s.strip.length ? h('div', { class: 'strip', role: 'img', 'aria-label': `Last ${s.strip.length} checks: ${['up', 'slow', 'down', 'blocked'].map(k => `${s.strip.filter(c => c.state === k).length} ${k}`).join(', ')}` }, s.strip.map(c => h('i', { class: c.state, title: `${fmt.when(c.at)}: ${c.state}${c.ms != null ? ', ' + ms(c.ms) : ''}` }))) : null,
          pts.length ? h('div', { style: { maxWidth: w + 'px' } }, drawLine(document, lineModel([{ name: 'Response time', points: pts }], { width: w, height: 90, pad: { l: 52, r: 8, t: 6, b: 20 }, yTicks: 2, xTicks: 3, timeLabel: (t) => fmt.time(new Date(t).toISOString()), valueLabel: (v) => ms(v) }), { title: `Response time of ${s.host}` })) : null,
          s.change ? h('details', null, h('summary', null, `Text changed ${fmt.when(s.changeAt)}: ${s.change.addedCount} added, ${s.change.removedCount} removed`),
            ...s.change.added.map(l => h('div', { class: 'sub' }, '+ ' + l)), ...s.change.removed.map(l => h('div', { class: 'sub' }, '− ' + l))) : s.changeCheckedAt ? h('div', { class: 'sub' }, `Text compared ${fmt.when(s.changeCheckedAt)}: no change.`) : null);
      }));
    };
    put(box, card(addBox), noticesBox, list);
    await paint();
  },

  // ---------------- D
  async visits({ h, api, card, btn, fmt, select, box, put, toast, ui }) {
    const q = h('input', { type: 'text', placeholder: 'Search by site, for example wikipedia', style: { flex: '1', minWidth: '180px' }, 'aria-label': 'Search by site' });
    const out = h('div'); let t = null;
    const paint = async () => {
      const v = await api('m/network/visits?q=' + encodeURIComponent(q.value.trim()));
      put(out, h('p', { class: 'sub' }, `${v.visits.length} shown of ${v.total} kept. Kept for ${one(v.retentionDays, 'day')}.`),
        ui.table([{ label: 'When', render: r => fmt.when(r.at) }, { label: 'Site', render: r => h('span', { title: r.url }, r.host) }, { label: 'How', key: 'via' }, { label: 'Agent or job', key: 'who' },
          { label: 'Result', render: r => ui.pill(r.result === 'read' || r.result === 'opened' ? (r.result === 'read' ? 'Read' : 'Opened') : r.result === 'blocked' ? 'Blocked' : 'Failed', r.result === 'blocked' ? 'stop' : r.result === 'failed' ? 'wait' : 'ok') }, { label: 'Note', render: r => h('span', { class: 'sub' }, r.note || '') }], v.visits, { empty: 'No visits yet. Every page an agent reads or opens shows here.' }));
      ret.value = String(v.retentionDays);
    };
    q.oninput = () => { clearTimeout(t); t = setTimeout(paint, 250); };
    const exp = btn('Export CSV', { kind: 'ghost sm', onClick: async () => { try { const r = await api('m/network/visits.csv?q=' + encodeURIComponent(q.value.trim()), { raw: true }); if (!r.ok) throw new Error('Not exported'); const blob = await r.blob(); const a = h('a', { href: URL.createObjectURL(blob), download: 'agent-visits.csv' }); document.body.append(a); a.click(); a.remove(); } catch (e) { toast(e.message, 'err'); } } });
    const clear = btn('Clear', { kind: 'ghost sm', onClick: async () => { if (await ui.confirm('Clear the whole log of where the agents went?', { ok: 'Clear', kind: 'stop' })) { await api('m/network/visits/clear', { body: {} }); paint(); } } });
    const ret = select([[7, 'Keep 7 days'], [30, 'Keep 30 days'], [90, 'Keep 90 days'], [365, 'Keep a year']], 30, async (v) => { await api('m/network/visits/settings', { body: { retentionDays: Number(v) } }); toast('Saved', 'ok'); paint(); }, 'How long to keep');
    put(box, card(h('div', { class: 'row' }, q, ret, exp, clear), h('p', { class: 'sub', style: { marginTop: '8px' } }, 'Every web address the desk’s agents read or opened: search reads, research and the agent’s browser. Kept on this PC only.')), card(out));
    await paint();
  },

  // ---------------- E
  async diagnose({ h, api, card, btn, box, put, busy, line, pill, offline }) {
    const target = h('input', { type: 'text', placeholder: 'A site that seems down (optional)', style: { flex: '1', minWidth: '200px' }, 'aria-label': 'A site that seems down' });
    const out = h('div');
    const go = btn('Is it me or them?', { onClick: () => busy(go, 'Checking…', async () => {
      const r = await api('m/network/diagnose', { body: { target: target.value.trim() || null } });
      put(out, h('p', { class: 'verdict', role: 'status' }, r.verdict.line), ...r.lines.map(l => line(l.name, l.detail, pill(l.ok == null ? 'Skipped' : l.ok ? 'Works' : 'Fails', l.ok == null ? '' : l.ok ? 'ok' : 'stop'))));
    }) });
    put(box, card(h('div', { class: 'row' }, target, go), h('p', { class: 'sub', style: { marginTop: '8px' } }, `Checks this PC’s adapter, your router (one knock), DNS through this PC and through Cloudflare 1.1.1.1, and three well-known sites.${offline ? ' While the desk is offline only the checks on this PC run.' : ''}`)), card(out));
    put(out, h('p', { class: 'sub' }, 'Press the button to check.'));
  },

  // ---------------- F
  async ai({ h, api, card, btn, fmt, box, put, busy, waitJob, toast, ui, ms }) {
    const out = h('div');
    const paint = async () => {
      const r = await api('m/network/providers');
      const rows = r.providers;
      const bars = rows.map(p => ({ label: p.label, v: p.lastHourMs ?? p.medianMs ?? (p.test?.ok ? p.test.ms : null) })).filter(b => Number.isFinite(b.v));
      put(out, h('p', null, r.fastestNow ? h('b', null, `Fastest right now: ${r.fastestNow}`) : h('span', { class: 'sub' }, 'No answers in the last hour yet.')),
        bars.length ? h('div', null, drawBars(document, barModel(bars, { width: Math.max(300, Math.min(640, (out.clientWidth || 600))), valueLabel: (v) => ms(v) }), { title: 'Typical answer time per provider' })) : null,
        ui.table([{ label: 'Provider', key: 'label' }, { label: 'Last hour', render: p => p.lastHourMs != null ? ms(p.lastHourMs) : '' }, { label: 'Last day', render: p => p.medianMs != null ? ms(p.medianMs) : '' },
          { label: 'Calls (failed)', render: p => `${p.calls} (${p.failed})` }, { label: 'Last test', render: p => p.test ? `${p.test.ok ? ms(p.test.ms) : 'No answer'} · ${fmt.when(p.test.at)}` : '' }], rows, { empty: 'No model calls in the last day.' }),
        h('p', { class: 'sub' }, 'From the answers the desk already got (whole answer time, middle value). Nothing extra is sent unless you press Test all.'));
    };
    const test = btn('Test all', { kind: 'ghost', onClick: () => busy(test, 'Testing…', async () => { const { jobId } = await api('m/network/providers/test', { body: {} }); const jx = await waitJob(jobId); if (jx.status !== 'done') toast(jx.error || jx.status, 'err'); await paint(); }) });
    put(box, card(h('div', { class: 'row' }, h('span', { class: 'sub grow' }, 'Test all sends one short question to each provider, using the Models page’s own test.'), test)), card(out));
    await paint();
  },

  // ---------------- G
  async devices({ h, api, card, btn, fmt, select, box, put, busy, toast, ui, pill, waitJob }) {
    const out = h('div');
    const paint = async () => {
      const d = await api('m/network/devices');
      const read = btn('Read the device list', { onClick: () => busy(read, 'Reading…', async () => { const r = await api('m/network/devices/read', { body: {} }); if (r.error) toast(r.error, 'err'); else if (r.first) toast('Remembered. New devices from now on raise a notice.', 'ok'); await paint(); }) });
      put(out, h('div', { class: 'row' }, read, select([['off', 'Only when I press it'], ['hourly', 'Every hour']], d.every, async (v) => { await api('m/network/devices/settings', { body: { every: v } }); toast('Saved', 'ok'); }, 'How often'),
        ui.moduleOn('channels') ? h('label', { class: 'row', style: { gap: '6px' } }, h('input', { type: 'checkbox', checked: d.phone, onchange: async (e) => { await api('m/network/devices/settings', { body: { phone: e.target.checked } }); } }), h('span', { class: 'sub' }, 'Also tell my phone (ntfy) about new devices and domain reminders')) : null),
        h('p', { class: 'sub', style: { margin: '8px 0' } }, `Your own network only: ${d.subnets.length ? d.subnets.join(', ') : 'no home network address on this PC'}. Reads this PC’s ARP table; nothing is sent to the devices.${d.lastRead ? ` Last read ${fmt.when(d.lastRead.at)}.` : ''}`),
        ui.table([
          { label: 'Name', render: x => { const i = h('input', { type: 'text', value: x.name || '', placeholder: 'Give it a name', 'aria-label': 'Name of ' + x.ip, style: { width: '160px' } }); i.onchange = async () => { await api(`m/network/devices/${encodeURIComponent(x.mac)}`, { method: 'PATCH', body: { name: i.value } }); toast('Saved', 'ok'); }; return i; } },
          { label: 'Address', key: 'ip' }, { label: 'Hardware address', render: x => h('span', { class: 'mono' }, x.mac) }, { label: 'First seen', render: x => fmt.when(x.firstSeen) }, { label: 'Last seen', render: x => fmt.when(x.lastSeen) },
          { label: 'Known', render: x => { const c = h('input', { type: 'checkbox', checked: x.known, 'aria-label': 'Known: ' + x.ip }); c.onchange = async () => { await api(`m/network/devices/${encodeURIComponent(x.mac)}`, { method: 'PATCH', body: { known: c.checked } }); paint(); }; return h('span', { class: 'row', style: { gap: '6px' } }, c, x.known ? null : pill('New', 'wait')); } }], d.devices, { empty: 'No devices remembered yet. Press Read the device list.' }));
    };
    // other PCs that can run models (the scan that knocks once on 11434 and 8787; asks you first)
    const lan = h('div');
    const paintLan = async (last) => {
      if (last === undefined) last = (await api('m/network/lan')).last;
      const go = btn('Look for model PCs', { kind: 'ghost', onClick: async () => { go.disabled = true; go.textContent = 'Waiting for you…'; try { const { jobId } = await api('m/network/lan', { body: {} }); const jx = await waitJob(jobId, (x) => { if (x.status === 'running') go.textContent = 'Scanning…'; }); if (jx.status !== 'done') toast(jx.error || 'Scan stopped', 'err'); paintLan(jx.output || null); paint(); } catch (e) { toast(e.message, 'err'); paintLan(); } } });
      const nodes = ui.state.settings['network.lanNodes'] || [];
      const addNode = async (d, s) => { const id = 'n' + d.ip.replace(/\./g, '') + s.port; const next = [...nodes.filter(n => n.id !== id), { id, name: `${s.what === 'ollama' ? 'Ollama' : 'Router'} on ${d.ip}`, baseUrl: s.baseUrl, models: s.models || [], model: (s.models || [])[0] || null, enabled: true }]; try { const r = await api('settings', { body: { 'network.lanNodes': next } }); ui.state.settings = r.settings; toast('Added. It shows on the Models page.', 'ok'); paintLan(last); } catch (e) { toast(e.message, 'err'); } };
      const withModels = (last?.devices || []).filter(d => d.services.length);
      put(lan, ui.line('Other PCs that can run models', 'Knocks once on ports 11434 (Ollama) and 8787 (a model router) of each address in your own network. Asks you first.', go),
        last ? h('div', null, h('p', { class: 'sub' }, `Scanned ${fmt.when(last.at)} · ${last.probed} addresses checked`),
          ui.table([{ label: 'Address', key: 'ip' }, { label: 'Runs', render: d => d.services.map(s => `${s.what === 'ollama' ? 'Ollama' : 'Router'}${s.confirmed ? ` (${(s.models || []).length} models)` : ' (not confirmed)'}`).join(', ') },
            { label: '', render: d => h('span', null, ...d.services.filter(s => s.confirmed).map(s => nodes.some(n => n.baseUrl === s.baseUrl) ? pill('Added', 'ok') : btn('Add as a model node', { kind: 'ghost sm', onClick: () => addNode(d, s) }))) }], withModels, { empty: 'No PC on your network runs Ollama or a model router.' })) : h('p', { class: 'sub' }, 'Not scanned yet.'));
    };
    put(box, card(out), card(lan)); await Promise.all([paint(), paintLan()]);
  },

  // ---------------- H
  async domain({ h, api, card, btn, fmt, box, put, busy, toast, ui, empty, offline, line, pill }) {
    const dom = h('input', { type: 'text', placeholder: 'yourdomain.com', style: { flex: '1', minWidth: '180px' }, 'aria-label': 'Your domain' });
    const sel = h('input', { type: 'text', placeholder: 'DKIM selectors, e.g. google, selector1', style: { flex: '1', minWidth: '180px' }, 'aria-label': 'DKIM selectors' });
    const mine = h('input', { type: 'checkbox', 'aria-label': 'This domain is mine' }); const daily = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Check it every day' });
    const list = h('div', { class: 'stack' });
    const add = btn('Add', { onClick: () => busy(add, 'Adding…', async () => { await api('m/network/domains', { body: { domain: dom.value, selectors: sel.value, mine: mine.checked, daily: daily.checked } }); dom.value = ''; sel.value = ''; await paint(); }) });
    const res = (t, ok, means, extra) => line(t, means, extra || null, pill(ok == null ? 'Unknown' : ok ? 'Good' : 'Needs care', ok == null ? '' : ok ? 'ok' : 'wait'));
    const paint = async () => {
      const { domains } = await api('m/network/domains');
      if (!domains.length) return put(list, empty('No domain yet.'));
      put(list, ...domains.map(d => {
        const r = d.result;
        const check = btn('Check now', { kind: 'ghost sm', disabled: offline, onClick: () => busy(check, 'Checking…', async () => { await api(`m/network/domains/${encodeURIComponent(d.domain)}/check`, { body: {} }); await paint(); }) });
        const del = btn('Remove', { kind: 'ghost sm', onClick: async () => { await api(`m/network/domains/${encodeURIComponent(d.domain)}`, { method: 'DELETE' }); paint(); } });
        return card(h('div', { class: 'row' }, h('b', null, d.domain), h('span', { class: 'sub' }, d.checkedAt ? `checked ${fmt.when(d.checkedAt)}` : 'not checked yet'), h('span', { class: 'grow' }), check, del),
          r ? h('div', null,
            res('Web address', r.dns.records.some(x => x.type === 'A' || x.type === 'AAAA'), r.dns.means),
            res('Mail delivery', r.mx.records.length > 0, r.mx.means),
            res('Certificate', r.cert.days == null ? null : r.cert.days > 30, r.cert.means),
            res('Registration', r.registration.days == null ? null : r.registration.days > 30, r.registration.means + (r.registration.registrar ? ` Registrar: ${r.registration.registrar}.` : '')),
            res('SPF', r.mail.spf.ok, r.mail.spf.means), res('DMARC', r.mail.dmarc.ok, r.mail.dmarc.means),
            ...r.mail.dkim.map(k => res(`DKIM (${k.selector})`, k.ok, k.means)),
            h('details', null, h('summary', null, `DNS records (${r.dns.records.length})`), ...r.dns.records.map(x => h('div', { class: 'mono' }, `${x.type.padEnd(5)} ${x.data}`))),
            h('p', { class: 'sub' }, 'Sources: ' + r.sources.join(', ') + '. Reminders come 30 and 7 days before an expiry.')) : h('p', { class: 'sub' }, 'Press Check now.'));
      }));
    };
    put(box, card(h('h3', null, 'Add your domain'), h('div', { class: 'row' }, dom, sel, add), h('div', { class: 'row', style: { marginTop: '8px' } }, h('label', { class: 'row', style: { gap: '6px' } }, mine, h('span', { class: 'sub' }, 'This domain is mine')), h('label', { class: 'row', style: { gap: '6px' } }, daily, h('span', { class: 'sub' }, 'Check it every day')))), list);
    await paint();
  },

  // ---------------- I
  async rules({ h, api, card, btn, box, put, toast, ui, empty }) {
    const lists = h('div', { class: 'two' }); const noteEl = h('p', { class: 'sub' });
    const column = (kind, title, desc, rows) => {
      const inp = h('input', { type: 'text', placeholder: 'example.com', style: { flex: '1', minWidth: '140px' }, 'aria-label': `Add to ${title}` });
      const prev = h('div', { class: 'sub', role: 'status', style: { minHeight: '18px' } }); let t = null;
      inp.oninput = () => { clearTimeout(t); t = setTimeout(async () => { const v = inp.value.trim(); if (!v) return prev.textContent = ''; try { const p = await api('m/network/rules/preview?entry=' + encodeURIComponent(v)); prev.textContent = 'Covers: ' + p.covers; } catch (e) { prev.textContent = e.message; } }, 200); };
      const add = btn('Add', { onClick: async () => { try { const r = await api('m/network/rules', { body: { kind, entry: inp.value } }); inp.value = ''; prev.textContent = ''; paint(r); } catch (e) { toast(e.message, 'err'); } } });
      return card(h('h3', null, title), h('p', { class: 'sub' }, desc), h('div', { class: 'row', style: { marginTop: '6px' } }, inp, add), prev,
        rows.length ? h('div', null, ...rows.map(r => ui.line(r.domain, r.covers, btn('Remove', { kind: 'ghost sm', onClick: async () => { paint(await api('m/network/rules', { method: 'DELETE', body: { domain: r.domain } })); } })))) : empty('None yet.'));
    };
    const paint = (r) => { put(lists, column('never', 'Never open', 'Agents refuse these with a plain reason, in search reads, research and their browser.', r.never), column('ask', 'Ask me first', 'Agents ask you before opening these, once per task. If you say no, it stays no for that task.', r.ask)); noteEl.textContent = r.note + ' Only you change these lists, from this page; no agent or chat message can.'; };
    put(box, lists, noteEl);
    paint(await api('m/network/rules'));
  },

  // ---------------- J
  async ports({ h, api, card, btn, box, put, busy, ui, pill }) {
    const out = h('div');
    const paint = async () => {
      const r = await api('m/network/ports');
      put(out, r.error ? h('p', { class: 'sub' }, r.error) : null, ui.table([{ label: 'Port', key: 'port' }, { label: 'Kind', key: 'protocol' }, { label: 'Program', render: x => x.program || 'Not shown' },
        { label: 'Listens on', render: x => pill(x.scope === 'this PC only' ? 'This PC only' : 'The network', x.scope === 'this PC only' ? 'ok' : 'wait') }, { label: '', render: x => x.mark ? h('b', null, x.mark) : '' }], r.rows, { empty: r.note || 'Nothing listening.' }));
    };
    const again = btn('Read again', { kind: 'ghost sm', onClick: () => busy(again, 'Reading…', paint) });
    put(box, card(h('div', { class: 'row' }, h('span', { class: 'sub grow' }, 'Programs on this PC with open network ports. Read-only: nothing is closed or changed. “The network” means other devices could try to connect.'), again)), card(out));
    await paint();
  },

  // ---------------- K
  async lookup({ h, api, card, btn, fmt, box, put, busy, toast, ui, line, pill, offline }) {
    const q = h('input', { type: 'text', placeholder: 'A domain, for example example.com', style: { flex: '1', minWidth: '200px' }, 'aria-label': 'Domain' });
    const out = h('div', { class: 'stack' });
    const src = (s, at) => h('p', { class: 'sub' }, `Source: ${s}${at ? ` · saved copy from ${fmt.when(at)}` : ''}`);
    const need = () => { const v = q.value.trim(); if (!v) { toast('Give a domain.', 'err'); return null; } return v; };
    const KINDS = [['dns', 'DNS records'], ['rdap', 'Registration'], ['tls', 'Certificate'], ['headers', 'Web headers'], ['robots', 'robots.txt'], ['company', 'About the company']];
    const basic = (kind, r) => {
      const t = KINDS.find(k => k[0] === kind)[1];
      if (r.error) return card(line(t, r.error, pill('No answer', 'stop')));
      if (kind === 'dns') return card(h('h3', null, t), src(r.source), ...(r.records.length ? r.records.map(x => h('div', { class: 'mono' }, `${x.type.padEnd(5)} ${x.data}`)) : [h('span', { class: 'sub' }, 'No records.')]));
      if (kind === 'rdap') return card(h('h3', null, t), r.found ? h('div', null, src(r.source), line('Registrar', r.registrar || 'Not public'), line('Registered', fmt.date(r.registered)), line('Expires', fmt.date(r.expires)), line('Name servers', r.nameservers.join(', '))) : h('p', { class: 'sub' }, r.note));
      if (kind === 'headers') return card(h('h3', null, t), h('p', { class: 'sub' }, `${r.finalUrl} answered ${r.status}`), ...r.headers.map(x => line(x.name, x.value)));
      if (kind === 'tls') return card(h('h3', null, t), line('Issued to', r.subject || ''), line('Issued by', r.issuer || ''), line('Valid until', fmt.date(r.validTo)), line('Trusted by this PC', r.trusted ? 'Yes' : 'No: ' + r.problem), line('Also covers', r.names.slice(0, 8).join(', ')));
      if (kind === 'robots') return card(h('h3', null, t), r.found ? h('pre', { class: 'cmp' }, r.text.slice(0, 3000)) : h('p', { class: 'sub' }, `No robots.txt (answer ${r.status}).`));
      return card(h('h3', null, t), ...r.pages.map(p => h('div', null, h('b', null, p.title || p.url), h('div', { class: 'sub' }, p.description), h('div', { class: 'sub mono' }, p.url))), h('p', { class: 'sub' }, r.searchNote || ''));
    };
    const runBasic = async (kinds) => { const v = need(); if (!v) return; put(out, h('span', { class: 'sub' }, 'Looking up…')); put(out, ...(await Promise.all(kinds.map(async k => { try { return basic(k, await api(`m/network/lookup/${k}?q=${encodeURIComponent(v)}`)); } catch (e) { return basic(k, { error: e.message }); } })))); };
    const osint = (kind, extra = {}) => async () => { const v = need(); if (!v) return; put(out, h('span', { class: 'sub' }, 'Looking up…')); try { const r = await api(`m/network/osint/${kind}`, { body: { q: v, ...extra() } }); put(out, SHOW[kind](r)); } catch (e) { put(out, card(h('p', { class: 'sub' }, e.message))); } };
    const SHOW = {
      subdomains: (r) => card(h('h3', null, `Names in public certificate logs (${r.subdomains.length}${r.more ? ` of ${r.subdomains.length + r.more}` : ''})`), src(r.source, r.cachedAt), h('p', { class: 'sub' }, r.note),
        ui.table([{ label: 'Name', render: x => h('span', { class: 'mono' }, x.name) }, { label: 'Latest certificate ends', key: 'lastCertEnds' }, { label: 'Issuer', key: 'issuer' }], r.subdomains, { empty: 'None found.' })),
      profile: (r) => card(h('h3', null, `Security grade ${r.grade}`), h('p', null, r.gradeMeans), src(r.source, r.cachedAt),
        line('Built with', r.builtWith.length ? r.builtWith.join(', ') : 'Nothing our rule list recognises'), line('Trackers it loads', r.trackers.length ? r.trackers.join(', ') : 'None that our rule list recognises'),
        r.versionLeaks.length ? line('Says its software versions', r.versionLeaks.join('; ')) : null,
        ...r.checks.map(c => line(c.label, c.what + (c.value ? ` (${c.value})` : ''), pill(c.ok ? 'Set' : c.present ? 'Weak' : 'Missing', c.ok ? 'ok' : 'wait'))), h('p', { class: 'sub' }, r.note)),
      archive: (r) => {
        const side = (s, t, other) => { const B = new Set((other || '').split('\n')); return h('div', null, h('b', null, s.found ? `Captured ${fmt.date(s.at)}` : `Nothing near ${s.asked}`), t == null ? h('p', { class: 'sub' }, s.found ? 'Its text could not be read.' : '') : h('div', { class: 'cmp' }, t.split('\n').slice(0, 200).map(l => h('div', { class: B.has(l) ? '' : (other === r.toText ? 'del' : 'add') }, l)))); };
        return card(h('h3', null, 'How the page looked'), src(r.source, r.cachedAt), r.note ? h('p', { class: 'sub' }, r.note) : null, r.diff ? h('p', null, `${r.diff.addedCount} lines new in the later capture, ${r.diff.removedCount} gone.`) : null,
          h('div', { class: 'two' }, side(r.from, r.fromText, r.toText), side(r.to, r.toText, r.fromText)), h('p', { class: 'sub' }, 'Red: only in the earlier capture. Green: only in the later one. Text from the archive is shown as plain text.'));
      },
      captures: (r) => card(h('h3', null, `Captures, one a month (${r.captures.length})`), src(r.source, r.cachedAt), h('p', { class: 'mono' }, r.captures.join('  ') || 'None.')),
      shodan: (r) => card(h('h3', null, 'Shodan'), src(r.source, r.cachedAt), line('Names', r.subdomains.join(', ') || 'None'), ui.table([{ label: 'Name', key: 'name' }, { label: 'Type', key: 'type' }, { label: 'Value', render: x => h('span', { class: 'mono' }, x.value) }, { label: 'Last seen', key: 'lastSeen' }], r.records)),
    };
    const from = h('input', { type: 'date', value: '2015-01-01', 'aria-label': 'Earlier date' }), to = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10), 'aria-label': 'Later date' });
    const keys = await api('m/network/osint/keys');
    const keyIn = h('input', { type: 'password', placeholder: 'Your Shodan key', autocomplete: 'off', style: { width: '200px' }, 'aria-label': 'Shodan key' });
    const shodanRow = keys.shodan ? h('div', { class: 'row' }, btn('Shodan: names and DNS', { kind: 'ghost sm', disabled: offline, onClick: osint('shodan', () => ({})) }), btn('Remove key', { kind: 'ghost sm', onClick: async () => { await api('m/network/osint/keys', { body: { service: 'shodan', key: '' } }); ui.go('network', 'lookup'); } }))
      : h('div', { class: 'row grey' }, h('span', { class: 'sub' }, 'Shodan: add your own key to use it.'), keyIn, btn('Save key', { kind: 'ghost sm', onClick: async () => { try { await api('m/network/osint/keys', { body: { service: 'shodan', key: keyIn.value } }); toast('Key saved', 'ok'); ui.go('network', 'lookup'); } catch (e) { toast(e.message, 'err'); } } }));
    put(box, card(h('div', { class: 'row' }, q, btn('Look up', { disabled: offline, onClick: () => runBasic(['dns', 'rdap', 'tls']) })),
      h('div', { class: 'row', style: { marginTop: '8px' } }, ...KINDS.map(([k, label]) => btn(label, { kind: 'ghost sm', disabled: offline, onClick: () => runBasic([k]) }))),
      h('div', { class: 'row', style: { marginTop: '8px' } }, btn('Names in certificate logs', { kind: 'ghost sm', disabled: offline, onClick: osint('subdomains', () => ({})) }), btn('Built with and security grade', { kind: 'ghost sm', disabled: offline, onClick: osint('profile', () => ({})) }), btn('Captures by month', { kind: 'ghost sm', disabled: offline, onClick: osint('captures', () => ({})) })),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'sub' }, 'Past versions:'), from, to, btn('Compare', { kind: 'ghost sm', disabled: offline, onClick: osint('archive', () => ({ from: from.value, to: to.value })) })),
      h('div', { style: { marginTop: '8px' } }, shodanRow), h('div', { class: 'row grey', style: { marginTop: '6px' } }, h('span', { class: 'sub' }, `Censys: ${keys.censysNote}`)),
      h('p', { class: 'sub', style: { marginTop: '8px' } }, 'Public facts about domains and companies only, one ordinary request each, only when you press a button. Results are kept for a day. No people search, no scanning of other people’s machines.')), out);
  },

  // ---------------- L
  async data({ h, api, card, box, put, ui, fmt }) {
    const d = await api('m/network/data-use');
    if (!d.counting) return put(box, card(h('p', null, h('b', null, 'Not counting yet.')), h('p', { class: 'sub' }, 'Counting what the desk itself sends and receives needs one small counter in the desk’s outbound door. Until it is added, this section stays empty.')));
    const MB = (n) => fmt.bytes(n);
    put(box, card(h('h3', null, 'Per day (last 30 days)'), d.days.length ? drawBars(document, barModel(d.days.map(x => ({ label: x.day, v: (x.sent || 0) + (x.received || 0) })), { width: 560, valueLabel: MB }), { title: 'Data the desk used per day' }) : null,
      ui.table([{ label: 'Day', key: 'day' }, { label: 'Sent', render: x => MB(x.sent) }, { label: 'Received', render: x => MB(x.received) }], [...d.days].reverse(), { empty: 'Nothing counted yet.' })),
      card(h('h3', null, 'Per site (last 30 days)'), ui.table([{ label: 'Site', key: 'host' }, { label: 'Sent', render: x => MB(x.sent) }, { label: 'Received', render: x => MB(x.received) }], d.hosts, { empty: 'Nothing counted yet.' })));
  },
};

function signalWords(dBm) { if (dBm == null) return null; if (dBm >= -55) return 'strong'; if (dBm >= -67) return 'good'; if (dBm >= -75) return 'fair'; return 'weak'; }

export const settings = {
  network: {
    title: 'Network',
    async render(el, ui) {
      el.append(ui.card(ui.line('The Network page', 'Connection, speed history, websites you watch, where the agents went, website rules and more now have their own page in the menu.', ui.btn('Open it', { onClick: () => ui.go('network') }))));
    },
  },
};
