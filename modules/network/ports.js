// Section J: programs with open network ports on this PC. Read-only, local only: nothing is closed or changed.
const LOCAL = /^(127\.|::1$|localhost$|::ffff:127\.)/i;

/** conns: systeminformation networkConnections() rows. -> listening ports, one row per port and program. */
export function listening(conns, { deskPort = null, ollamaPort = 11434, routerPort = 8787 } = {}) {
  const rows = new Map();
  for (const c of Array.isArray(conns) ? conns : []) {
    const proto = String(c.protocol || '').toLowerCase();
    const tcpListen = proto.startsWith('tcp') && /listen/i.test(String(c.state || ''));
    const udpBound = proto.startsWith('udp') && (!c.peerAddress || c.peerAddress === '*' || c.peerAddress === '0.0.0.0' || c.peerAddress === '::');
    if (!tcpListen && !udpBound) continue;
    const port = Number(c.localPort); if (!Number.isFinite(port) || port <= 0) continue;
    const addr = String(c.localAddress || '').replace(/^\[|\]$/g, '');
    const scope = LOCAL.test(addr) ? 'this PC only' : 'the network';
    const program = String(c.process || '').trim() || null;
    const k = `${proto.startsWith('udp') ? 'udp' : 'tcp'}|${port}|${program || c.pid || ''}`;
    const prev = rows.get(k);
    if (prev) { if (scope === 'the network') prev.scope = 'the network'; prev.addresses.add(addr || '*'); continue; }
    const mark = port === Number(deskPort) ? 'AP Desk' : port === ollamaPort ? 'Ollama' : port === routerPort ? 'Model router' : null;
    rows.set(k, { protocol: proto.startsWith('udp') ? 'UDP' : 'TCP', port, program, pid: Number(c.pid) > 0 ? Number(c.pid) : null, scope, addresses: new Set([addr || '*']), mark });
  }
  return [...rows.values()].map(r => ({ ...r, addresses: [...r.addresses].slice(0, 4) })).sort((a, b) => (b.mark ? 1 : 0) - (a.mark ? 1 : 0) || (a.scope === b.scope ? 0 : a.scope === 'the network' ? -1 : 1) || a.port - b.port);
}
