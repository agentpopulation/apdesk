// An OpenAI-compatible stand-in for PLUMBING tests only (fallback, Panic, streaming, JSON, tool calls).
// It is never evidence that a feature works. Anything proven only against it is reported as "not checked".
import http from 'node:http';

/**
 * script: (body, n) => string | { text, toolCalls: [{ name, args }], status, delayMs, chunkDelayMs, finish }   (finish: 'length' = the reply was cut off)
 * Default: echoes "FAKE: <last user message>".
 */
export async function startFakeLlm(script) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] })); }
    if (req.url.endsWith('/api/tags')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'fake-local:latest', size: 1, details: {} }] })); }
    const chunks = []; for await (const c of req) chunks.push(c);
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    calls.push(body);
    const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    let out = script ? await script(body, calls.length) : null;
    if (out == null) out = 'FAKE: ' + (typeof lastUser?.content === 'string' ? lastUser.content : '');
    if (typeof out === 'string') out = { text: out };
    if (out.delayMs) await new Promise(r => setTimeout(r, out.delayMs));
    if (out.status && out.status !== 200) { res.writeHead(out.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: out.text || 'fake error' } })); }
    const tool_calls = (out.toolCalls || []).map((t, i) => ({ id: 'call_' + i, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }));
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const words = String(out.text || '').split(/(\s+)/).filter(Boolean);
      for (const w of words) { if (res.destroyed) return; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`); await new Promise(r => setTimeout(r, out.chunkDelayMs ?? 5)); }
      // out.noIndex: send parallel calls the way Gemini does, each complete in its own chunk and with no index
      if (tool_calls.length && out.noIndex) for (const t of tool_calls) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [t] } }] })}\n\n`);
      else if (tool_calls.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: tool_calls.map((t, index) => ({ index, ...t })) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: out.finish || 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n'); return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: out.text || '', ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: out.finish || 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, baseUrl: `http://127.0.0.1:${port}/v1`, ollamaUrl: `http://127.0.0.1:${port}`, calls, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
