// Pure helpers for the Network page's "Part 1" additions: the status strip, API connection health, the IP and DNS
// change detection, and the network-issues list. Nothing here reaches the network or the database; the server wires
// these to storage and to the one outbound door. Keeping the logic here means it can be tested without a real network.

const SEV_ORDER = { critical: 0, warn: 1, info: 2 };
export const severityRank = (s) => (s in SEV_ORDER ? SEV_ORDER[s] : 3);

/**
 * The numbers for the strip across the top of the page, from state the desk already holds.
 * Anything whose source is not present is left null, and the page shows "—" rather than a made-up value.
 *   agents: the roster [{ id, enabled }]
 *   runningJobs: jobs now running [{ agentId }]
 *   jobSummary: { running, waiting, ... } from the jobs door
 *   failedAgentIds: agent ids whose recent job failed
 *   issues: the open issues [{ muted, resolved }]
 */
export function statusStrip({ agents = [], runningJobs = [], jobSummary = {}, failedAgentIds = [], issues = [], newDevices = 0, messagesPerMin = null, net = null } = {}) {
  const enabled = agents.filter(a => a.enabled);
  const busy = new Set(runningJobs.map(j => j.agentId).filter(Boolean));
  const errored = new Set((failedAgentIds || []).filter(Boolean));
  const online = enabled.length;
  const midTask = enabled.filter(a => busy.has(a.id)).length;
  const error = enabled.filter(a => errored.has(a.id) && !busy.has(a.id)).length;
  const idle = Math.max(0, online - midTask - error);
  const openIssues = issues.filter(i => !i.muted && !i.resolved).length;
  return {
    agents: { online, midTask, idle, error },
    messagesPerMin: messagesPerMin == null ? null : Math.max(0, Math.round(messagesPerMin)),
    queue: (Number(jobSummary.running) || 0) + (Number(jobSummary.waiting) || 0),
    openIssues,
    newDevices: Math.max(0, Number(newDevices) || 0),
    heartbeat: net ? { ok: !!net.ok, at: net.at || null } : null,
  };
}

/**
 * Group addresses by scope+family and report what changed from the previous snapshot. A new value has old:null,
 * a value that went away has new:null. Addresses: [{ scope, family, value }].
 */
export function diffAddresses(prev = [], cur = []) {
  const group = (list) => { const m = new Map(); for (const a of list || []) { const k = `${a.scope}|${a.family}`; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(String(a.value)); } return m; };
  const p = group(prev), c = group(cur);
  const out = [];
  for (const k of new Set([...p.keys(), ...c.keys()])) {
    const [scope, family] = k.split('|');
    const oldv = [...(p.get(k) || [])].sort().join(', ') || null;
    const newv = [...(c.get(k) || [])].sort().join(', ') || null;
    if (oldv !== newv) out.push({ scope, family, old: oldv, new: newv });
  }
  return out.sort((a, b) => (a.scope + a.family).localeCompare(b.scope + b.family));
}

/** The same, for DNS records grouped by type. Records: [{ type, data }]. */
export function diffDns(prev = [], cur = []) {
  const group = (list) => { const m = new Map(); for (const r of list || []) { const t = String(r.type); if (!m.has(t)) m.set(t, new Set()); m.get(t).add(String(r.data)); } return m; };
  const p = group(prev), c = group(cur);
  const out = [];
  for (const t of new Set([...p.keys(), ...c.keys()])) {
    const oldv = [...(p.get(t) || [])].sort().join(' | ') || null;
    const newv = [...(c.get(t) || [])].sort().join(' | ') || null;
    if (oldv !== newv) out.push({ type: t, old: oldv, new: newv });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * Build the issues list from facts the desk already stored (no probing here).
 *   sites/domains: [{ host|domain, certTo }]   certTo = the certificate's last day (ISO), or null
 *   latency/baseline: the most recent ping and a simple baseline (ms)
 *   dnsFails: hostnames that did not resolve on the last DNS check
 *   loss: [{ name, lossPct, detail }] packet loss to the gateway, this PC's DNS and 1.1.1.1
 * Returns [{ key, kind, severity, title, detail }]. Cert expiry warns at 14 days, is critical at 3.
 */
export function issuesFrom({ sites = [], domains = [], latency = null, baseline = null, dnsFails = [], loss = [], now = Date.now() } = {}) {
  const out = [];
  const days = (iso) => (iso ? Math.floor((Date.parse(iso) - now) / 86400_000) : null);
  const seen = new Set();
  for (const c of [...sites.map(s => ({ host: s.host, to: s.certTo })), ...domains.map(d => ({ host: d.domain, to: d.certTo }))]) {
    if (!c.host || seen.has('cert|' + c.host)) continue;
    const d = days(c.to); if (d == null) continue;
    const key = 'cert|' + c.host; seen.add(key);
    if (d < 0) out.push({ key, kind: 'ssl', severity: 'critical', title: `${c.host}: certificate expired`, detail: `It expired ${-d} day${d === -1 ? '' : 's'} ago. Visitors see a warning.` });
    else if (d <= 3) out.push({ key, kind: 'ssl', severity: 'critical', title: `${c.host}: certificate ends in ${d} day${d === 1 ? '' : 's'}`, detail: 'Renew it now.' });
    else if (d <= 14) out.push({ key, kind: 'ssl', severity: 'warn', title: `${c.host}: certificate ends in ${d} days`, detail: 'Plan the renewal.' });
  }
  if (latency != null && baseline != null && baseline > 0 && latency >= Math.max(150, baseline * 2))
    out.push({ key: 'latency', kind: 'latency', severity: 'warn', title: `Latency is high: ${latency} ms`, detail: `It is usually about ${baseline} ms here.` });
  for (const h of [...new Set(dnsFails)]) if (h) out.push({ key: 'dns|' + h, kind: 'dns', severity: 'warn', title: `DNS did not resolve ${h}`, detail: 'The name did not answer on the last check.' });
  for (const l of loss || []) if (l && Number(l.lossPct) > 0) out.push({ key: 'loss|' + l.name, kind: 'loss', severity: Number(l.lossPct) >= 50 ? 'critical' : 'warn', title: `Packet loss to ${l.name}: ${Math.round(l.lossPct)}%`, detail: l.detail || null });
  return out;
}

/**
 * Fold the API-check rows into one line per provider: the last check's state, how long it took, when it was, and the
 * share of checks in the last 24 hours that failed. rows: [{ provider, label, url, ok, status, ms, at(ISO) }].
 */
export function apiHealthFrom(rows = [], now = Date.now(), { slowMs = 1500 } = {}) {
  const by = new Map();
  for (const r of rows) { const k = r.provider || 'unknown'; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  const since = now - 24 * 3600_000;
  const out = [];
  for (const [provider, list] of by) {
    list.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const last = list[0];
    const day = list.filter(r => Date.parse(r.at) >= since);
    const errors = day.filter(r => !r.ok).length;
    out.push({
      provider, label: last.label || provider, url: last.url || null,
      status: last.ok ? (last.ms != null && last.ms > slowMs ? 'slow' : 'up') : 'down',
      lastMs: last.ms ?? null, lastStatus: last.status ?? null, lastAt: last.at || null,
      checks24h: day.length, errors24h: errors, errorRate24h: day.length ? errors / day.length : null,
    });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}
