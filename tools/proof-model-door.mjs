// The model door with real models: router, keys, per-agent model, fallback, key hygiene.
// Run from the repository root with GEMINI_API_KEY and OPENROUTER_API_KEY set:  node tools/proof-model-door.mjs
import { testDesk } from '../test/helpers/desk.js';
const t = await testDesk({ real: true });
const { model, agents } = t.core;
const out = []; const say = (ok, what, ev) => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}  ${ev}`); };
const q = [{ role: 'user', content: 'In one short sentence, what is the boiling point of water at sea level in Celsius?' }];
const one = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 90);
try {
  const act = await model.active();
  say(act.some(a => a.provider === 'router' && a.ok), 'Active now lists what is live', act.map(a => `${a.label}${a.ok ? '' : ' (down)'}`).join(' | '));
  let r = await model.chat({ model: { provider: 'router' }, messages: q });
  say(r.provider === 'router' && /100/.test(r.text), 'Router: a no-sign-in model answers', `[${r.label}] ${one(r.text)} (${r.ms} ms)`);
  r = await model.chat({ model: { provider: 'gemini' }, messages: q });
  say(r.provider === 'gemini' && /100/.test(r.text), 'Key: Gemini answers', `[${r.label}] ${one(r.text)} (${r.ms} ms)`);
  r = await model.chat({ model: { provider: 'openrouter' }, messages: q }).catch(e => ({ error: e.message }));
  say(!r.error && r.provider === 'openrouter', 'Key: OpenRouter free model answers', r.error ? one(r.error) : `[${r.label}] ${one(r.text)} (${r.ms} ms)`);
  // per-agent model: two agents, two models, each reply names its own
  agents.update('scout', { model: { main: { provider: 'gemini', model: 'gemini-3.5-flash-lite' } } });
  agents.update('coder', { model: { main: { provider: 'router', model: 'Meta-Llama-3_3-70B-Instruct' } } });
  const a = await model.chat({ agentId: 'scout', messages: q }); const b = await model.chat({ agentId: 'coder', messages: q });
  say(a.model === 'gemini-3.5-flash-lite' && b.model === 'Meta-Llama-3_3-70B-Instruct', 'Per-agent model: each reply names its own model', `Scout [${a.label}] · Coder [${b.label}]`);
  // change one agent's model: the next reply names the new one
  agents.update('scout', { model: { main: { provider: 'router', model: 'gpt-oss-120b' } } });
  const a2 = await model.chat({ agentId: 'scout', messages: q });
  say(a2.model === 'gpt-oss-120b', 'Change an agent\'s model: the next reply names it', `Scout was [${a.label}], now [${a2.label}]`);
  // fallback: main is a model that does not exist, fallback answers, and the attempt list says why
  agents.update('closer', { model: { main: { provider: 'gemini', model: 'no-such-model-xyz' }, fallback: { provider: 'router', model: 'Mistral-Small-3.2-24B-Instruct-2506' } } });
  const f = await model.chat({ agentId: 'closer', messages: q });
  say(f.fallbackUsed && f.provider === 'router' && f.attempts[0].ok === false, 'Fallback: main fails, fallback answers, attempts are listed', `[${f.label}] after ${f.attempts.filter(x => !x.ok).map(x => `${x.provider}/${x.model}: ${one(x.error).slice(0, 40)}`).join('; ')}`);
  // a bogus key does not pass, and no key value comes back anywhere
  const k = model.addKey('groq', 'gsk_bogus_key_for_test_0000000000', 'bogus');
  const bad = await model.chat({ model: { provider: 'groq' }, messages: q }).then(() => null, e => e);
  say(!!bad && bad.code === 'all_failed', 'A fake key does not pass a test call', one(bad?.message));
  const st = await t.call('/api/state'); const keys = JSON.stringify(model.listKeys());
  say(!st.text.includes('gsk_bogus_key_for_test') && !keys.includes('gsk_bogus_key_for_test'), 'Key values never come back in a response', `listed as ${model.listKeys().groq[0].value}`);
  model.removeKey(k.id);
  // offline: the chain holds only local models (a config check only: no local model is asked to answer)
  t.core.settings.set('online', false);
  const off = await model.chat({ messages: q }).then(() => null, e => e);
  say(!!off && (off.code === 'offline' || off.code === 'all_failed') && !(off.attempts || []).some(x => x.provider !== 'ollama' && !String(x.provider).startsWith('lan:')), 'Offline: only local models are tried (config check)', one(off?.message));
} finally { await t.close(); }
process.exit(out.every(Boolean) ? 0 : 1);
