# Contract 2: the model door

Every model call in the app goes through `app/core/model-door.js`. No module imports an SDK, opens a socket to a provider, or reads a key. The door picks the provider and model, rotates keys, falls back, respects Online/Offline, is stopped by Panic, and always names the model that answered.

## Call

```js
const r = await ctx.model.chat({
  agentId: 'scout',             // whose model settings to use (main, then fallback); omit for the default chain
  messages: [{ role: 'system'|'user'|'assistant'|'tool', content, name?, tool_call_id?, tool_calls? }],
  tools?: [{ name, description, parameters }],   // OpenAI function shape; the door adapts per provider
  json?: true,                  // ask for a JSON object; the door also repairs/parses: r.json
  temperature?, maxTokens?,
  purpose: 'chat'|'plan'|'research'|'draft'|'council'|'embed'|'vision'|'code'|'small',  // for logs, spend and model picks
  model?: { provider, model },  // explicit pick (Models page "test this", Council seats). Still goes through the door.
  signal?: AbortSignal,         // chained with Panic
  onDelta?: (text) => void,     // streaming; the final r.text is complete either way
  onReset?: () => void,         // a target streamed some text and then failed: clear it, the next target streams afresh
  streamGapMs?, deadlineMs?, timeoutMs?   // per-call limits, see Time limits
});
// r = { text, json?, toolCalls: [{ id, name, args }], model: 'qwen2.5:14b', provider: 'ollama',
//       label: 'Ollama · qwen2.5:14b', usage: { input, output }, ms, attempts: [{ provider, model, ok, error? }] }
```

`ctx.model.embed({ texts, agentId? })` -> `{ vectors, model, provider }` (Ollama embedding model or a keyed provider; the door says `unavailable` cleanly when none can).

`ctx.model.active()` -> the "Active now" list: `[{ provider, model, label, kind: 'router'|'local'|'keyed'|'lan', online: bool }]`.

`ctx.model.toolMessage(r)` -> the assistant message to send back before the tool results. Use it instead of building `tool_calls` by hand: it keeps what the provider needs on a replayed call (Gemini's `extra_content` signature).

`ctx.model.listModels(provider)` -> the model ids a provider offers, read server-side with the owner's key (OpenRouter: free ids only while paid is off). An explicit pick may carry `keyId` to use one saved key only (`model: { provider, model, keyId }`), which is how a per-key Test works.

`ctx.model.resolve(agentId)` -> `{ main: { provider, model }, fallback: { provider, model } | null, chain: [...] }`.

Errors: the door throws `ModelError` with `code` in `offline`, `halted` (Panic), `no_provider`, `all_failed`, `aborted`. The message is a plain sentence for the owner. `r.attempts` lists everything tried.

## Providers

| id | kind | how | default |
|---|---|---|---|
| `router` | router | OpenAI-compatible server, the owner's Free LLM Router, shown as **Agent Population Router**. Base URL setting `router.baseUrl`, default `http://127.0.0.1:8787/v1`. Free no-sign-in models **on by default**; switch `router.enabled`. Optional key. | on |
| `ollama` | local | `http://127.0.0.1:11434` (`ollama.baseUrl`). Lists installed models. The only provider used when Offline. | on |
| `openai`, `anthropic`, `openrouter`, `groq`, `gemini`, `mistral`, `deepseek`, `together`, `fireworks`, `cerebras`, `xai`, `custom` | keyed | Several keys per provider, each with its own switch and label. OpenAI-compatible chat for all but `anthropic` (native Messages API) and `gemini` (OpenAI-compatible endpoint). `custom` is any OpenAI-compatible base URL. | off until a key is added |
| `lan:<node>` | lan | Another PC on the LAN running Ollama or the router (Models › Nodes) | off |

Keys live in the `secrets` table of the SQLite file (STORAGE.md), never in code, config files, logs or the zip. Keys found in the environment at start (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `LLM_BASE_URL` + `LLM_API_KEY`) are registered in memory for that run, labelled "from environment", and not written to disk.

## What the owner sees: four groups of keys

Models shows every way to get a model or a service, grouped, so the owner can start free and add keys when he wants:
1. **Free, no sign-in**: the Agent Population Router (his own router, or the built-in one with its upstreams from `ctx.model.freeRouter()`). On by default.
2. **Free with sign-up**: providers whose `tier` is `free-signup` in `ctx.model.providers()` (Gemini, Groq, OpenRouter free models, Cerebras, Mistral, NVIDIA, Z.ai, Cohere, Cloudflare), each with its sign-up link and `freeNote`.
3. **Paid**: `tier: 'paid'` (OpenAI, Anthropic, DeepSeek, Together, Fireworks, xAI) and `custom`.
4. **Search, voice and audio**: dedicated services from `GET /api/keys/services` (Serper, Tavily, Brave, Exa, Jina; ElevenLabs, Deepgram, Cartesia, AssemblyAI), one key each, read by modules with `ctx.serviceKey(id)`.

## Choosing

1. `halted` if Panic is active. `offline` if the desk is Offline and the pick is not local.
2. Explicit `model` if given.
3. The agent's `main`, then `fallback` (both `{ provider, model }`, set on the Agents and Models pages).
4. The default chain (setting `model.defaultChain`; entries are `router`, `ollama`, `keyed`, or a provider id such as `gemini`): router (free models) -> ollama (first chat model) -> every keyed provider with a live key, in the owner's order.
5. Each provider is tried with its keys in order; a key on cooldown (429, 401) is skipped; after `attempts.length >= 6` the door stops and throws `all_failed`. Six, not four: the built-in router alone gives up to four targets, so four would never reach Ollama or a keyed provider.

## Time limits

- First byte: a hop waits at most `timeoutMs` for the provider's first byte (default 60 s on the built-in router, 180 s elsewhere).
- Stream gap: a streamed reply that sends nothing for 45 s (`STREAM_GAP_MS`, per call `streamGapMs`) is dropped as an ordinary failed hop and the next target is tried. A stream that keeps sending is never cut.
- Total: no new hop starts 170 s after the call began (`CHAT_DEADLINE_MS`, per call `deadlineMs`), and a hop's first-byte wait never runs past that; the call then ends `all_failed` with its attempts. A hop that is already streaming is not cut.
- Stop and Panic always end the call as `aborted`, never as a failed hop.

Offline: the chain is reduced to `ollama` and `lan` entries. Online/Offline is a setting (`online`), changed from the chip under the message box or Settings › Network. It is not a per-call flag.

## OpenRouter: free models only

The owner's rule. For provider `openrouter` the door refuses any model id that does not end in `:free` (or is `openrouter/free`), whatever an agent, a module or a Council seat asks for. Paid OpenRouter models can be switched on only by the owner through the guarded spend route (`POST /api/settings/spend { openrouterPaid: true }`, Settings > Payments and spend). Off by default.

## Naming the model

Every reply in chat shows `r.label` ("Agent Population Router · llama-3.3-70b", "Ollama · qwen2.5:14b", "OpenAI · gpt-4.1-mini"). Modules must surface `label`, not a hardcoded name. A reply that reached the owner without a label is a bug.

## Spend

A keyed call records `usage` and an estimated cost (from `app/core/providers.json`) into `m_core_calls`. The approval door reads today's and this month's totals for the spend limits (APPROVAL-DOOR.md). Free router and Ollama cost nothing.

## Testing

`test/helpers/fake-llm.js` is an OpenAI-compatible server on a free loopback port that answers from a script. It exists to test plumbing (fallback, Panic, streaming, JSON repair, tool calls). It is never proof that a feature works: anything proven only against it is reported as "not checked: no model key".
