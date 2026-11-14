// Server-sent events to every open browser. Modules call ctx.events.emit(type, data).
export class Events {
  constructor() { this.clients = new Set(); this.local = new Set(); this.seq = 0; }
  handle(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    const client = { res, ping: setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000) };
    this.clients.add(client);
    req.on('close', () => { clearInterval(client.ping); this.clients.delete(client); });
  }
  emit(type, data) {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,60}$/.test(String(type))) throw Object.assign(new Error('An event type is one plain word.'), { code: 'bad_event' });
    // Sent twice on purpose: once under its own name (for a plain EventSource listener) and once on the single
    // 'apd' channel the shell listens to, so any event type a module invents reaches ui.on(type) without a list.
    const payload = JSON.stringify(data ?? {});
    const msg = `id: ${++this.seq}\nevent: ${type}\ndata: ${payload}\n\nevent: apd\ndata: ${JSON.stringify({ type, data: data ?? {} })}\n\n`;
    for (const c of this.clients) { try { c.res.write(msg); } catch { this.clients.delete(c); } }
    for (const fn of this.local) { try { fn(type, data); } catch {} }
  }
  /** In-process listener (modules reacting to each other without HTTP). */
  on(fn) { this.local.add(fn); return () => this.local.delete(fn); }
}
