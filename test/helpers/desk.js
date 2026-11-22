// Starts a throwaway desk for tests: temp data folder, free port, the fake model as the router (plumbing only).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createDesk } from '../../app/server.js';
import { startFakeLlm } from './fake-llm.js';

/**
 * testDesk({ modules: ['chat', 'search'] })   load only these modules from modules/ (default: none, the core alone)
 * testDesk({ script })                        the fake model's script (plumbing only, never proof)
 * testDesk({ real: true, modules })           a REAL model: built-in free router plus the keys in the environment.
 * testDesk({ pairing: true })                 the real desk's rule: only a paired browser gets the page and the data
 * testDesk({ chain: 'owner', fallback })       the owner's own chain: every agent on the Free API (auto), then `fallback`
 *                                              ({ provider, model }, his local model), then the default chain router, ollama, keys
 */
export async function testDesk({ script, modulesDir, modules = [], real = false, withFake = !real, env = real ? process.env : {}, pairing = false, chain = null, fallback = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apd-test-'));
  const fake = withFake ? await startFakeLlm(script) : null;
  const desk = await createDesk({ dataDir, port: 0, quiet: true, env, modulesDir, modules: modulesDir ? null : modules, pairing });
  if (real && chain !== 'owner') desk.core.settings.set('model.defaultChain', ['gemini', 'router', 'openrouter', 'keyed', 'ollama']);   // Gemini calls tools reliably; OpenRouter free has a small daily allowance
  if (fake) { desk.core.settings.set('router.baseUrl', fake.baseUrl); desk.core.settings.set('router.builtin', false); desk.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:1'); }
  await desk.start();
  if (chain === 'owner') {   // after start: the roster is made then
    desk.core.settings.set('model.defaultChain', ['router', 'ollama', 'keyed']);
    for (const a of desk.core.agents.list()) desk.core.agents.update(a.id, { model: { main: { provider: 'router', model: 'auto' }, fallback: fallback || null } });
  }
  const base = desk.url();
  const call = async (p, { method, body, session = true, headers = {} } = {}) => {
    const r = await fetch(base + p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session ? { 'x-apd-session': desk.session } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return { desk, core: desk.core, fake, base, call, dataDir, async close() { await desk.stop(); await fake?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}
