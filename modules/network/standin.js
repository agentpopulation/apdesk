// For tests only: a stand-in for outside services on loopback. standIn(handler) gives a fetch that sends any
// https://<host>/<path> to the local server with the original host in x-host, so parsers meet real HTTP answers.
import http from 'node:http';
export async function standIn(handler) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    const host = req.headers['x-host']; seen.push({ host, path: req.url, method: req.method, ua: req.headers['user-agent'] || '' });
    try { await handler({ host, path: req.url, req, res }); } catch (e) { res.writeHead(500); res.end(String(e.message)); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url)); const { timeoutMs, ...rest } = init;
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...rest, headers: { ...(rest.headers || {}), 'x-host': u.hostname } });
  };
  return { fetch: fetchFn, seen, port, close: () => new Promise(r => srv.close(r)) };
}
