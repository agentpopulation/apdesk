// A stand-in for llama.cpp's llama-server, for tests only: it takes the same flags the desk passes, binds where --host
// says, checks the key from --api-key-file, answers GET /health (503 while "loading", then 200) and an OpenAI-compatible
// POST /v1/chat/completions (plain and streamed). It writes the flags it got to args.json in its working folder.
// Plumbing only: never proof that a real model works.
import http from 'node:http';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const host = opt('--host') || '127.0.0.1'; const port = Number(opt('--port')); const model = opt('--model'); const alias = opt('--alias') || 'stand-in';
const key = opt('--api-key-file') ? fs.readFileSync(opt('--api-key-file'), 'utf8').split(/\r?\n/).find(l => l && !l.startsWith('#')) : null;
try { fs.writeFileSync('args.json', JSON.stringify({ argv, pid: process.pid, cwd: process.cwd(), env: Object.keys(process.env).filter(k => /^(LLAMA|HF|GGML)_/.test(k)) })); } catch {}
if (!model || !fs.existsSync(model)) { console.error('error: failed to load model: ' + model); process.exit(1); }
const started = Date.now();
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/health') return Date.now() - started < 400 ? send(503, { error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }) : send(200, { status: 'ok' });
  if (key && req.headers.authorization !== 'Bearer ' + key) return send(401, { error: { code: 401, message: 'Invalid API Key', type: 'authentication_error' } });
  if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: alias, object: 'model' }] });
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    const last = [...(body.messages || [])].reverse().find(m => m.role === 'user')?.content || '';
    const text = /ready/i.test(String(last)) ? 'ready' : 'Hello from the stand-in engine.';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of text.split(/(?<= )/)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return res.end();
    }
    return send(200, { id: 'x', object: 'chat.completion', model: alias, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
  }
  send(404, { error: { message: 'not found' } });
});
server.listen(port, host);
process.on('SIGTERM', () => { server.close(); process.exit(0); });
