// Model door check: one real question, one real answer, per route. Prints the label that answered.
// Run from the repository root:  node tools/g0.mjs [chain|router|gemini|openrouter|upstreams]
// Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another provider's key listed in
// app/core/model-door.js); the built-in free router needs none.
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
import { createDesk } from '../app/server.js';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-g0-'));
const desk = await createDesk({ dataDir, port: 0, quiet: true });
await desk.start();
const { model } = desk.core;
const ask = async (name, pick) => {
  const t0 = Date.now();
  try { const r = await model.chat({ model: pick, purpose: 'chat', messages: [{ role: 'user', content: 'In one short sentence: what is the capital of Australia?' }] }); console.log(`PASS  ${name.padEnd(22)} ${String(Date.now() - t0).padStart(6)} ms  [${r.label}]  ${r.text.trim().replace(/\s+/g, ' ').slice(0, 120)}`); return true; }
  catch (e) { console.log(`FAIL  ${name.padEnd(22)} ${String(Date.now() - t0).padStart(6)} ms  ${e.message.slice(0, 260)}`); return false; }
};
console.log('active:', (await model.active()).map(a => `${a.label}${a.ok ? '' : ' (down: ' + a.error + ')'}`).join(' | '));
const only = process.argv[2];
const results = {};
if (!only || only === 'chain') results.chain = await ask('default chain', undefined);
if (!only || only === 'router') results.router = await ask('built-in free router', { provider: 'router' });
if (!only || only === 'gemini') results.gemini = await ask('gemini key', { provider: 'gemini' });
if (!only || only === 'openrouter') results.openrouter = await ask('openrouter key', { provider: 'openrouter' });
if (only === 'upstreams') for (const u of (await import('../app/core/model-door.js')).FREE_ROUTER.upstreams) for (const m of u.models) results[u.id + ':' + m] = await ask(`${u.id} ${m}`.slice(0, 22), { provider: 'router', model: m });
await desk.stop(); fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(Object.values(results).some(Boolean) ? 0 : 1);
