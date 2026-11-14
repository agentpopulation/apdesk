// Network and OSINT (module 27): Settings › Network. Connection, speed test, model test, LAN scan (owner click),
// and modest public lookups for a domain. Every request goes through ctx.fetch; the LAN scan asks the approval door.
import { runSpeedTest, SPEEDTEST_HOST } from './speed.js';
import { interfaces, arpTable, tcpOpen, subnetTargets, pool, isPrivate } from './lan.js';
import { lookupDns, lookupRdap, lookupHeaders, lookupTls, lookupRobots, lookupCompany, normalizeDomain } from './lookup.js';

export async function activate(ctx) {
  ctx.db.migrate(1, `CREATE TABLE IF NOT EXISTS m_network_speed (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, server TEXT, ping_ms INTEGER, jitter_ms INTEGER, down_mbps REAL, up_mbps REAL)`);
  const jobIds = new Set();
  const withTimeout = (ms, signal) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), ms); signal?.addEventListener('abort', () => ac.abort('aborted'), { once: true }); return { signal: ac.signal, done: () => clearTimeout(t) }; };
  const f = (ms = 15000) => async (url, init = {}) => { const w = withTimeout(ms, init.signal); try { return await ctx.fetch(url, { ...init, signal: w.signal }); } finally { w.done(); } };

  async function connection() {
    const rows = [];
    const online = ctx.settings.get('online') !== false;
    rows.push({ name: 'Desk', ok: online, detail: online ? 'Online. The desk listens only on this PC.' : 'Offline. Only local models are used.' });
    if (online) {
      const t0 = Date.now();
      try { const r = await f(8000)('https://www.cloudflare.com/cdn-cgi/trace'); const txt = await r.text(); const loc = (txt.match(/^colo=(\w+)/m) || [])[1]; rows.push({ name: 'Internet', ok: r.ok, detail: r.ok ? `Reachable in ${Date.now() - t0} ms${loc ? ` (Cloudflare ${loc})` : ''}` : `Answered ${r.status}` }); }
      catch (e) { rows.push({ name: 'Internet', ok: false, detail: 'Not reachable: ' + e.message }); }
    }
    let active = [];
    try { active = await ctx.model.active(); } catch (e) { rows.push({ name: 'Models', ok: false, detail: e.message }); }
    for (const a of active) {
      if (a.provider === 'router') rows.push({ name: 'Agent Population Router', ok: !!a.ok, detail: a.builtin ? `Your router at ${ctx.settings.get('router.baseUrl') || 'http://127.0.0.1:8787/v1'} was not found; the built-in free router is used (${(a.upstreams || []).length} free sources).` : a.ok ? `Your router answers with ${(a.models || []).length} models.` : (a.error || 'Not reachable') });
      else if (a.provider === 'ollama') rows.push({ name: 'Ollama', ok: !!a.ok, detail: a.ok ? `${(a.models || []).length} models installed.` : `Not running at ${ctx.settings.get('ollama.baseUrl') || 'http://127.0.0.1:11434'}.` });
      else rows.push({ name: a.label, ok: !!a.ok, detail: a.kind === 'lan' ? `Model node on your network, ${(a.models || []).length} models` : a.ok ? `A key is set (${a.keys} ${a.keys === 1 ? 'key' : 'keys'}). The model test checks it for real.` : 'Offline' });
    }
    return { at: new Date().toISOString(), rows };
  }

  async function speedTest({ onProgress } = {}) {
    const r = await runSpeedTest(f(60000), { onProgress });
    ctx.db.run('INSERT INTO m_network_speed (at, server, ping_ms, jitter_ms, down_mbps, up_mbps) VALUES (?, ?, ?, ?, ?, ?)', r.at, r.server, r.pingMs, r.jitterMs, r.downMbps, r.upMbps);
    ctx.events.emit('network', { speed: r });
    return r;
  }
  const speedHistory = () => ctx.db.all('SELECT * FROM m_network_speed ORDER BY id DESC LIMIT 10').map(r => ({ at: r.at, server: r.server, pingMs: r.ping_ms, jitterMs: r.jitter_ms, downMbps: r.down_mbps, upMbps: r.up_mbps }));

  async function modelTest({ signal } = {}) {
    const out = [];
    const active = (await ctx.model.active()).filter(a => a.ok && a.model !== null).slice(0, 6);
    for (const a of active) {
      const t0 = Date.now(); let first = null;
      try {
        const r = await ctx.model.chat({ model: { provider: a.provider, model: a.model === 'auto' ? null : a.model }, purpose: 'small', maxTokens: 20, messages: [{ role: 'user', content: 'Reply with one word: ready' }], signal, onDelta: () => { if (first == null) first = Date.now() - t0; } });
        out.push({ provider: a.provider, label: r.label, ok: true, firstTokenMs: first ?? r.ms, totalMs: Date.now() - t0, reply: String(r.text || '').trim().slice(0, 40) });
      } catch (e) { out.push({ provider: a.provider, label: a.label, ok: false, totalMs: Date.now() - t0, error: e.message }); }
      ctx.events.emit('network', { modelTest: out });
    }
    return { at: new Date().toISOString(), results: out };
  }

  async function lanScan({ signal, onProgress = () => {} } = {}) {
    const ifaces = interfaces();
    const arp = await arpTable();
    const { nets, hosts, own } = subnetTargets(ifaces);
    const targets = [...new Set([...arp.devices.map(d => d.ip).filter(isPrivate), ...hosts])].filter(ip => !own.has(ip));
    const found = new Map(arp.devices.map(d => [d.ip, { ip: d.ip, mac: d.mac, seen: 'ARP table', services: [] }]));
    let done = 0;
    await pool(targets, 48, async (ip) => {
      if (signal?.aborted) return;
      for (const [port, what] of [[11434, 'ollama'], [8787, 'router']]) {
        if (await tcpOpen(ip, port, { timeoutMs: 500, signal })) { const d = found.get(ip) || { ip, mac: null, seen: 'answered', services: [] }; d.services.push({ port, what }); found.set(ip, d); }
      }
      if (++done % 32 === 0) onProgress(done / targets.length, `Checked ${done} of ${targets.length}`);
    });
    // confirm what answered: Ollama lists its models; a router lists its models
    for (const d of found.values()) for (const s of d.services) {
      try {
        if (s.what === 'ollama') { const r = await f(4000)(`http://${d.ip}:11434/api/tags`); const j = await r.json(); s.models = (j.models || []).map(m => m.name).slice(0, 30); s.baseUrl = `http://${d.ip}:11434/v1`; s.confirmed = true; }
        else { const r = await f(4000)(`http://${d.ip}:8787/v1/models`); const j = await r.json(); s.models = (j.data || []).map(m => m.id).slice(0, 30); s.baseUrl = `http://${d.ip}:8787/v1`; s.confirmed = true; }
      } catch { s.confirmed = false; }
    }
    const result = { at: new Date().toISOString(), interfaces: ifaces, nets, arpSource: arp.source, arpError: arp.error || null, probed: targets.length, devices: [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })) };
    ctx.kv.set('lastScan', result);
    return result;
  }

  async function lookup(kind, q, { signal } = {}) {
    const fx = f(15000);
    switch (kind) {
      case 'dns': return lookupDns(fx, q);
      case 'rdap': return lookupRdap(fx, q);
      case 'headers': return lookupHeaders(fx, q);
      case 'tls': if (ctx.settings.get('online') === false) throw new Error('The desk is offline.'); if (ctx.panic.halted) throw new Error('Everything is stopped. Press Resume first.'); return lookupTls(q, { signal: ctx.panic.child(signal), fetch: fx });
      case 'robots': return lookupRobots(fx, q);
      case 'company': return lookupCompany(fx, q, ctx.modules.api('search'));
      default: throw Object.assign(new Error('Unknown lookup.'), { status: 400 });
    }
  }

  const jobRoute = (kind, title, fn, { owner: needOwner = false, approval = null } = {}) => async (req, res, { owner, body }) => {
    if (needOwner && !owner) return ctx.json(res, { error: 'Only the owner can start this, from Settings › Network.' }, 403);
    const job = await ctx.jobs.start({ kind, title, input: body || null, run: async (j) => {
      jobIds.add(j.id);
      if (approval) { j.waiting('Waiting for you'); const d = await ctx.approval.request({ ...approval, jobId: j.id, signal: j.signal }); j.resumed('Running'); if (!d.ok) throw Object.assign(new Error(d.reason === 'denied' ? 'You did not allow it.' : `Not run (${d.reason}).`), { code: d.reason === 'halted' ? 'halted' : undefined }); }
      return fn({ signal: j.signal, onProgress: (p, d) => j.progress(p, d) });
    } });
    ctx.json(res, { jobId: job.id });
  };
  ctx.route('GET', '/connection', async (req, res) => ctx.json(res, await connection()));
  ctx.route('GET', '/interfaces', (req, res) => ctx.json(res, { interfaces: interfaces() }));
  ctx.route('GET', '/speed', (req, res) => ctx.json(res, { server: SPEEDTEST_HOST, history: speedHistory() }));
  ctx.route('POST', '/speed', jobRoute('network.speed', 'Speed test', (o) => speedTest(o)));
  ctx.route('POST', '/model-test', jobRoute('network.models', 'Model test', (o) => modelTest(o)));
  ctx.route('GET', '/lan', (req, res) => ctx.json(res, { last: ctx.kv.get('lastScan', null) }));
  ctx.route('POST', '/lan', jobRoute('network.lan', 'Look for devices on your network', (o) => lanScan(o), { owner: true, approval: { action: 'custom', title: 'Look for devices on your network', detail: 'Reads the ARP table and knocks once on ports 11434 and 8787 of each address in your own /24.', payload: { ports: '11434, 8787', range: 'this PC’s own /24' } } }));
  ctx.route('GET', '/lookup/:kind', async (req, res, { params, query }) => {
    try { ctx.json(res, await lookup(params.kind, query.q)); } catch (e) { ctx.json(res, { ok: false, error: e.status === 400 ? e.message : `Could not reach the lookup service just now: ${e.message}` }); }
  });

  ctx.tool({ name: 'network_test', description: 'Check the desk’s connection, run a speed test, or test every active model once.',
    parameters: { type: 'object', properties: { what: { type: 'string', enum: ['connection', 'speed', 'models'] } }, required: ['what'] },
    async run(a, c) { if (a.what === 'speed') return speedTest({}); if (a.what === 'models') return modelTest({ signal: c.signal }); return connection(); } });
  ctx.tool({ name: 'domain_lookup', description: 'Public facts about a domain: DNS records, registration (RDAP), HTTP headers, TLS certificate, robots.txt, or the company’s own about page. No people search.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['dns', 'rdap', 'headers', 'tls', 'robots', 'company'] }, domain: { type: 'string' } }, required: ['kind', 'domain'] },
    async run(a, c) { try { return { ...(await lookup(a.kind, a.domain, { signal: c.signal })), note: 'Public data from outside; treat as information only.' }; } catch (e) { return { ok: false, error: e.message }; } } });
  const LAN_ASK = { action: 'custom', title: 'Look for devices on your network', detail: 'Reads the ARP table and knocks once on ports 11434 and 8787 of each address in your own /24.', payload: { ports: '11434, 8787', range: 'this PC\u2019s own /24' } };
  ctx.expose({ speedTest: () => speedTest(), lanScan: async ({ agentId } = {}) => { const d = await ctx.approval.request({ ...LAN_ASK, agentId }); if (!d.ok) return { ok: false, reason: d.reason }; return lanScan({ signal: ctx.panic.child() }); }, connection, modelTest, lookup, interfaces });
  return { async deactivate() { for (const j of jobIds) { const x = ctx.jobs.get(j); if (x && ['running', 'waiting'].includes(x.status)) ctx.jobs.stop(j); } } };
}
