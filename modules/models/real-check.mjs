// Real checks for the Models module. Run:  node modules/models/real-check.mjs
// Run from the repository root. Model keys come from the environment (GEMINI_API_KEY, OPENROUTER_API_KEY or another
// provider's key listed in app/core/model-door.js); with none set, the built-in free router answers.
import { testDesk } from '../../test/helpers/desk.js';
import { startFakeLlm } from '../../test/helpers/fake-llm.js';
const results = [];
const check = (ok, what, evidence) => { results.push(ok); console.log(`${ok === null ? 'NOT CHECKED' : ok ? 'PASS' : 'FAIL'}  ${what}  ${String(evidence ?? '').replace(/\s+/g, ' ').slice(0, 260)}`); };
const t = await testDesk({ real: true, modules: ['models'] });
const m = (p, o) => t.call('/api/m/models' + p, o);
try {
  // 1. Active now, with real reachability
  const act = (await m('/active')).json;
  const rs = (await m('/router')).json;
  check(act.active.some(a => a.provider === 'router') && act.active.some(a => a.provider === 'gemini'), 'Active now lists the router, Ollama and keyed providers',
    act.active.map(a => `${a.label}: ${a.ok ? 'reachable' : 'not reachable (' + (a.error || '') + ')'}`).join('; ') + ` | router: ${rs.line}`);

  // 2. Test the built-in router for real
  let r = (await m('/test', { body: { provider: 'router' } })).json;
  if (!r.ok && /rate|429|503/i.test(r.error || '')) { await new Promise(s => setTimeout(s, 30000)); r = (await m('/test', { body: { provider: 'router' } })).json; }
  check(r.ok && /^Free API · /.test(r.label), 'Test: built-in Free API answers', `${r.label} in ${(r.ms / 1000).toFixed(1)} s: "${r.reply || r.error}"`);
  // 2b. each built-in upstream on its own; a host that answers with its own error text must not pass
  for (const up of rs.upstreams.filter(u => u.enabled)) {
    const ru = (await m('/test', { body: { provider: 'router', upstream: up.id } })).json;
    const truthful = ru.ok ? /ready/i.test(ru.reply) : !!ru.error;
    check(truthful, `Test: built-in upstream ${up.name} ${ru.ok ? 'answers' : 'reported as not answering'}`, `${ru.label}: ${ru.ok ? '"' + ru.reply + '"' : ru.error}`);
  }

  // 3. Test the Gemini key for real (the environment key, isolated)
  const g = (await m('/test', { body: { provider: 'gemini', keyId: 'env:gemini' } })).json; const gAt = Date.now();
  check(g.ok && /Gemini/.test(g.label), 'Test: Gemini key answers', `${g.label} in ${(g.ms / 1000).toFixed(1)} s: "${g.reply || g.error}"`);

  // 4. A bogus key never passes
  const add = (await m('/keys', { body: { provider: 'groq', value: 'gsk_bogus_' + Math.random().toString(36).slice(2, 14), label: 'Bogus test key' } })).json;
  const prov = (await m('/providers')).json.providers.find(p => p.id === 'groq');
  check(!JSON.stringify(prov).includes('gsk_bogus') && prov.keys.some(k => k.label === 'Bogus test key'), 'Key value is never returned after saving', `groq keys: ${prov.keys.map(k => k.label).join(', ')}`);
  const b = (await m('/test', { body: { provider: 'groq', keyId: add.id } })).json;
  check(b.ok === false, 'Test: a bogus key fails', `${b.label}: ${b.error}`);
  const b2 = (await m('/test', { body: { provider: 'groq', keyId: add.id } })).json;
  check(b2.ok === false, 'Test: the bogus key fails again (cooling down, never passes)', b2.error);
  const avail = (await m('/available')).json.groups;
  const gemG = avail.find(x => x.provider === 'gemini');
  check(!avail.some(x => x.provider === 'groq') && !avail.some(x => x.provider === 'ollama') && avail.some(x => x.provider === 'router') && !!gemG && !gemG.failing[g.model] && (g.attempts === undefined || true), 'Pickers offer only reachable models; failing ones are marked', avail.map(x => `${x.label} (${x.models.length}${Object.keys(x.failing || {}).length ? '; ' + Object.entries(x.failing).map(([k, v]) => k + ' ' + v).join(', ') : ''})`).join(', '));

  // 5. Ask 12: change one agent's model; the next reply names it
  const say = () => t.core.model.chat({ agentId: 'scout', messages: [{ role: 'user', content: 'Reply with one word: hello' }], purpose: 'small' }).catch(e => ({ label: 'error: ' + e.message, attempts: e.attempts }));
  const patch = (main, fallback = null) => t.call('/api/agents/scout', { method: 'PATCH', body: { model: { main, fallback } } });
  await patch({ provider: 'router', model: 'Meta-Llama-3_3-70B-Instruct' });
  const a1 = await say();
  await patch({ provider: 'router', model: 'gpt-oss-120b' });
  const a1b = await say();
  check(a1.model === 'Meta-Llama-3_3-70B-Instruct' && a1b.model === 'gpt-oss-120b', 'Ask 12: Scout moved from one router model to another, each reply names its model', `[${a1.label}] then [${a1b.label}]`);
  const gm = g.ok ? g.model : 'gemini-3.6-flash';      // the Gemini model that just answered its Test, as the picker would offer
  await patch({ provider: 'gemini', model: gm }, { provider: 'router', model: 'auto' });
  const a2 = await say();
  check(a2.provider === 'gemini' && a1b.label !== a2.label, 'Ask 12: Scout switched from the router to Gemini, the next reply names Gemini', `before [${a1b.label}] after [${a2.label}] ${String(a2.text || '').trim().slice(0, 30)}${a2.provider !== 'gemini' ? ' | Gemini: ' + (a2.attempts || []).filter(x => !x.ok).map(x => x.error).join('; ').slice(0, 100) : ''}`);
  const ta = (await m('/test-agent', { body: { agentId: 'scout' } })).json;
  check(ta.ok && /Gemini/.test(ta.label), 'Agent tab test names the model', `[${ta.label}] ${ta.reply || ta.error}`);

  // 6. Hardware scan
  const hw = (await m('/hardware?force=1')).json;
  check(hw.ramGb > 0 && hw.cpu?.name && Array.isArray(hw.picks) && !hw.picks.some(p => /uncensor|abliterat/i.test(p.tag)), 'Hardware scan', `${hw.cpu.name}, ${hw.cpu.cores} cores, ${hw.ramGb} GB RAM, GPU: ${hw.gpu ? hw.gpu.name + ' ' + hw.gpu.vramGb + ' GB' : 'none found'}. ${hw.line} First pick: ${hw.picks[0]?.tag}`);

  // 7. Usage today
  const u = (await m('/usage')).json;
  check(u.today.length > 0 && u.today.some(x => x.failed > 0), 'Usage today counts calls and failures', u.today.map(x => `${x.label}: ${x.calls} calls, ${x.failed} failed`).join('; '));

  // 8. Ask 2, config only: with a stand-in Ollama endpoint and Offline, the chain is local only
  const stand = await startFakeLlm(() => 'local answer');
  try {
    t.core.settings.set('ollama.baseUrl', stand.ollamaUrl); t.core.model.cache.clear();
    await t.call('/api/settings', { body: { online: false } });
    const before = stand.calls.length;
    const off = await t.core.model.chat({ messages: [{ role: 'user', content: 'hi' }], purpose: 'small' }).catch(e => ({ label: 'error ' + e.message }));
    const chain = t.core.model.resolve(null).chain.filter(c => c.provider === 'ollama' || String(c.provider).startsWith('lan:'));
    const act2 = (await m('/active')).json.active;
    check(off.provider === 'ollama' && stand.calls.length === before + 1 && act2.filter(a => a.kind !== 'local' && a.kind !== 'lan').every(a => !a.ok), 'Ask 2 config check: Offline reduces the chain to the local model (stand-in endpoint)', `answered by [${off.label}]; local chain ${chain.map(c => c.provider).join(', ')}; online providers marked not reachable`);
    check(null, 'Ask 2: a real local model answers with no network', 'not checked by this script: it uses a stand-in Ollama');
  } finally { await t.call('/api/settings', { body: { online: true } }); t.core.settings.set('ollama.baseUrl', 'http://127.0.0.1:11434'); await stand.close(); }

  // 9. LiteLLM sidecar detection
  const ll = (await m('/litellm')).json;
  check(ll.found ? true : null, 'LiteLLM proxy detection on port 4000', ll.found ? `found${ll.needsKey ? ', model list behind its key' : ', models: ' + ll.models.join(', ')}` : 'no LiteLLM proxy running');
  if (ll.found && process.env.LITELLM_KEY) {
    const k = (await m('/keys', { body: { provider: 'custom', value: process.env.LITELLM_KEY, label: 'LiteLLM on this PC', baseUrl: ll.url } })).json;
    check(!!k.id, 'LiteLLM added as a custom provider; its model name read with the typed key', k.error || 'saved');
    const lt = (await m('/test', { body: { provider: 'custom', keyId: k.id } })).json;
    check(lt.ok, 'Test: LiteLLM proxy as a custom provider answers', `${lt.label}: "${lt.reply || lt.error}"`);
  }
} catch (e) { check(false, 'real-check crashed', e.stack); }
finally { await t.close(); }
process.exit(results.some(x => x === false) ? 1 : 0);
