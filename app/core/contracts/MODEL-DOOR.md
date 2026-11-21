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

`ctx.model.listModels(provider)` -> the model ids a provider offers, read server-side with the owner's key (OpenRouter: free ids only while paid is off). An explicit pick may carry `keyId` to use one saved key only (`model: { provider, model, keyId }`), which is how a per-key Test works. For `router`, `via: '<host id>'` calls that one built-in host only (the Router tab's Test), even while it cools down.

`ctx.model.modelCatalog(provider)` -> every model the provider gives, for the Models page's Default model box: `{ ok, models: [{ id, price: 'free'|'paid'|null }], at, needsKey, total, hiddenPaid, error }`. `price` comes only from the provider's own price fields, never guessed. Read through the door (refused Offline, cached 5 minutes). OpenRouter's list is public (`listsWithoutKey` in `providers.json`), so it is read before any key; other providers list models only to a key holder (`needsKey: true` before a key). While paid OpenRouter is off, only free ids come back.

`ctx.model.resolve(agentId)` -> `{ main: { provider, model }, fallback: { provider, model } | null, chain: [...] }`.

Errors: the door throws `ModelError` with `code` in `offline`, `halted` (Panic), `no_provider`, `all_failed`, `aborted`. The message is a plain sentence for the owner. `r.attempts` lists everything tried.

## Providers

| id | kind | how | default |
|---|---|---|---|
| `router` | router | The built-in free models, shown as **Free API by Agent Population Desk** on the Models page and **Free API** wherever space is tight (reply labels, the line under the message box, pills, notices). Both forms live in one place: `freeRouter.name` and `freeRouter.shortName` in `providers.json`, exported as `ROUTER_NAME`. Internal ids stay `router` (`router.*` settings, `/router/v1`). The owner may also run his own OpenAI-compatible router ("Your own router"); base URL setting `router.baseUrl`, default `http://127.0.0.1:8787/v1`. Free no-sign-in models **on by default**; switch `router.enabled`. Optional key. | on |
| `ollama` | local | `http://127.0.0.1:11434` (`ollama.baseUrl`). Lists installed models. Used when Offline. | on |
| `llama` | local | "Local model on this PC": llama.cpp's own server, fetched and run by the desk on loopback, files under `<data>/llama`. After `ollama` in the chain once installed. Used when Offline. Gets `LOCAL_FIRST_MS` for its first call. | on once the owner gets a local model |
| `openai`, `anthropic`, `openrouter`, `groq`, `gemini`, `mistral`, `deepseek`, `together`, `fireworks`, `cerebras`, `xai`, `custom` | keyed | Several keys per provider, each with its own switch and label. OpenAI-compatible chat for all but `anthropic` (native Messages API) and `gemini` (OpenAI-compatible endpoint). `custom` is any OpenAI-compatible base URL. | off until a key is added |
| `lan:<node>` | lan | Another PC on the LAN running Ollama or the router (Models › Nodes) | off |

Keys live in the `secrets` table of the SQLite file (STORAGE.md), never in code, config files, logs or the zip. Keys found in the environment at start (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `LLM_BASE_URL` + `LLM_API_KEY`) are registered in memory for that run, labelled "from environment", and not written to disk.

## What the owner sees: four groups of keys

Models shows every way to get a model or a service, grouped, so the owner can start free and add keys when he wants:
1. **Free, no sign-in**: the Free API (his own router, or the built-in free hosts from `ctx.model.freeRouter()`). On by default.
2. **Free with sign-up**: providers whose `tier` is `free-signup` in `ctx.model.providers()` (Gemini, Groq, OpenRouter free models, Cerebras, Mistral, NVIDIA, Z.ai, Cohere, Cloudflare), each with its sign-up link and `freeNote`.
3. **Paid**: `tier: 'paid'` (OpenAI, Anthropic, DeepSeek, Together, Fireworks, xAI) and `custom`.
4. **Search, voice and audio**: dedicated services from `GET /api/keys/services` (Serper, Tavily, Brave, Exa, Jina; ElevenLabs, Deepgram, Cartesia, AssemblyAI), one key each, read by modules with `ctx.serviceKey(id)`.

## Choosing

1. `halted` if Panic is active. `offline` if the desk is Offline and the pick is not local.
2. Explicit `model` if given.
3. The agent's `main`, then `fallback` (both `{ provider, model }`, set on the Agents and Models pages).
4. The default chain (setting `model.defaultChain`; entries are `router`, `ollama`, `keyed`, or a provider id such as `gemini`): router (free models) -> ollama (first chat model) -> every keyed provider with a live key, in the owner's order.
5. Each provider is tried with its keys in order; a key on cooldown (429, 401) is skipped; after `attempts.length >= 6` the door stops and throws `all_failed`. Six, not four: the built-in router alone gives up to four targets, so four would never reach Ollama or a keyed provider.

## Learning from the call log

Every call is written to the `calls` table (`purpose`, `provider`, `model`, `ok`, `ms`). From the last 7 days of it (`LEARN.days`), counted from `door.clock()`, the door keeps per kind of ask (`purpose`), provider and model: how many calls, how many answered, and the median time of those that answered. It is read again after 60 s (`LEARN.ttlMs`).

The rule: a candidate with at least 5 calls for that purpose (`LEARN.minCalls`) has a record; among candidates with a record, the higher share answered goes first, then the shorter median time; a tie keeps today's order. Candidates without a record keep their place. Fewer than two candidates with a record: today's order.

Where it applies, and only there:
- The built-in Free API's targets for one call (the up to four the door would try anyway), ranked per model.
- The chain's free and local default steps (`router`, `ollama`, `llama`, `lan:<node>` with no model named), ranked per provider. Only steps that stand next to each other trade places: none moves past another step, so a free step never goes behind a keyed or paid provider, and LAN nodes (listed after the keyed providers) trade only among themselves.

It never adds or drops a candidate, never moves a keyed provider (paid or free-with-sign-up), never switches paid models on, and never overrides a pick: an explicit `model`, an agent's `main` and `fallback`, a step with a model named (a LAN node's `model` too), the Router tab's Test of one host, `router.model` or `ollama.model` set by the owner (that step stays put), or a `model.defaultChain` the owner changed from the default (the whole chain keeps his order).

`ctx.model.learned()` -> `{ days, minCalls, rule, rows: [{ purpose, provider, model, label, calls, ok, share, medianMs, enough, free }] }` for the Doctor page. `ctx.model.lastCalls()` -> `{ <provider>: { at, ok, model, error } }`, the latest call per provider (its error as one short sentence; never a key).

## Time limits

- First byte: a hop waits at most `timeoutMs` for the provider's first byte (default 25 s on the built-in free hosts, `FREE_FIRST_MS`, so several can be tried inside one chat turn's 150 s wait; 180 s elsewhere).
- Stream gap: a streamed reply that sends nothing for 45 s (`STREAM_GAP_MS`, per call `streamGapMs`) is dropped as an ordinary failed hop and the next target is tried. A stream that keeps sending is never cut.
- Total: no new hop starts 170 s after the call began (`CHAT_DEADLINE_MS`, per call `deadlineMs`), and a hop's first-byte wait never runs past that; the call then ends `all_failed` with its attempts. A hop that is already streaming is not cut.
- Stop and Panic always end the call as `aborted`, never as a failed hop.
- A local model (Ollama) waits up to 150 s for its first byte (`LOCAL_FIRST_MS`): its first call loads it into memory. It is never longer than what is left of the call's deadline.

## Free hosts that said no

Each built-in free host-and-model that fails is skipped for a while (`BACKOFF`, per door `this.backoff`): after a 429, a 402 or a notice, for the time the host named ("Retry after 28s", `retry_after`, a `Retry-After` header), else 35 s (the anonymous limits are per minute); after "model … unavailable / not found" (`model_unavailable`, 404), 30 minutes, shown as "Unavailable at the host" on the Router tab; after no answer in time, 2 minutes; after anything else, 20 s. A skipped target is not an attempt and costs no waiting. When every free target is cooling down and nothing else could be tried, the call ends at once: "The free models are busy. The next one may answer in about N seconds. A free key or a local model in Models avoids this." (`retryAt` on the error). Among the free models not cooling down, the one tried longest ago goes first; a call with tools goes only to models that make tool calls.

The built-in hosts come from `providers.json`; the owner's Router tab choice (`router.upstreams`) only lays its on/off over them, so a saved copy never keeps stale model names or switches on a host that is off by default. A host marked `liveModels` (LLM7) is called only with the model names it lists itself without a key, read through the door and cached. A host's notice is cut at its first sentence and links are taken out before it reaches a log or the screen.

Offline: the chain is reduced to `ollama`, `llama` and `lan` entries. Online/Offline is a setting (`online`), changed from the chip under the message box or Settings › Network. It is not a per-call flag.

## OpenRouter: free models only

The owner's rule. For provider `openrouter` the door refuses any model id that does not end in `:free` (or is `openrouter/free`), whatever an agent, a module or a Council seat asks for. Paid OpenRouter models can be switched on only by the owner from the desk's own window: the "Paid models" switch beside the OpenRouter keys in Models, and the same switch in Settings › Payments and spend. Both call `POST /api/settings/paid-models { provider: 'openrouter', on }` (the older `POST /api/settings/spend { openrouterPaid }` does the same), which needs the session of the desk's own page and writes an activity line. The setting `openrouter.allowPaid` is written only by `door.setPaid(provider, on, SETTINGS_TOKEN)`, and only `core/settings-routes.js` holds that token, as for the security level. The plain settings route skips every `openrouter.` key, modules get read-only settings and no `setPaid`, and no tool, chat message or request flag reaches it. Off by default.

Providers that are always paid (`tier: 'paid'`) show a "Paid API" tag and no switch. Providers with a free tier on the same key (`tier: 'free-signup'` other than OpenRouter) show that billing depends on the owner's own account with that provider; the desk cannot see or control it.

## Naming the model

Every reply in chat shows `r.label` ("Free API · Qwen3.8-27B (OVHcloud AI Endpoints)", "Ollama · qwen2.5:14b", "OpenAI · gpt-4.1-mini"). Modules must surface `label`, not a hardcoded name. A reply that reached the owner without a label is a bug.

## Spend

Every call is written to the `calls` table with its tokens and `cost_minor` (minor units of the owner's currency), which holds one of three things:

- `0`: known free. The Free API, Ollama, the local model and LAN nodes; a model the provider lists as free (OpenRouter ids ending `:free`, `openrouter/free`, or a price-list entry with in and out 0); a key on a free tier; a call that failed.
- a number: a paid route, estimated at the list price in `providers.json` (`prices`, USD per million tokens, converted with `usdRates`). Rough: the provider's bill is the truth.
- `NULL`: not known whether the call was charged. Never written as 0 or as a guessed number.

What the desk can and cannot know, per provider:

| provider | what the door records |
|---|---|
| Free API, Ollama, local model, LAN | 0 |
| OpenRouter | 0 for free models; any other model is billed, so the list price (not known when the model is not on the list) |
| OpenAI, Anthropic, DeepSeek, Together, Fireworks, xAI (`tier: 'paid'`) | the list price; not known when the model is not on the list or no token count came back |
| Gemini, Groq, Mistral, Cerebras, NVIDIA, Z.ai, Cohere, Cloudflare (`tier: 'free-signup'`), and `custom` | not known: the same key can be on a free tier or billed and the replies do not say which. 0 once the owner marks the key free tier, or once Google answers a Gemini key with its free-tier quota notice (a 429 naming `free_tier` or `FreeTier`; kept in the data folder, so it holds after a restart, until the owner marks the key or removes it). The list price once the owner marks the key paid. |

Token counts: a streamed call to a provider with `streamUsage: true` in `providers.json` asks for the count (`stream_options.include_usage`); other providers send it only on calls that are not streamed. A call with no count is recorded with 0 tokens.

The owner's mark lives in the key's `meta.tier` (`'free'`, `'paid'` or none): `ctx.model.keys.add(provider, value, label, { tier })` or `ctx.model.keys.tier(keyId, 'free'|'paid'|null)`.

Limits. Before any keyed call that may cost money (anything but a known-free route), the door checks the owner's guard (approvals and known costs, APPROVAL-DOOR.md) and its own count of today's and this month's model calls (the day and the month start at midnight in the owner's zone, setting `timeZone`) in which every unknown cost counts at its list price (a model not on the list at the highest price there). So a limit is never passed by "not known".

`ctx.model.usage().today` rows (today in the owner's zone): `cost` is the known costs only, `unknown` the number of calls whose cost is not known, `atList` those calls at the list price (minor units), with `input` and `output` tokens. Wherever spend is listed, a row with `unknown > 0` shows "not known" with its tokens and the line "counted in your limit at the list price: about <atList>", never a number of its own.

## Testing

`test/helpers/fake-llm.js` is an OpenAI-compatible server on a free loopback port that answers from a script. It exists to test plumbing (fallback, Panic, streaming, JSON repair, tool calls). It is never proof that a feature works: anything proven only against it is reported as "not checked: no model key".
