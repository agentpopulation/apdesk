// The Models catalog: terms and limits of the free upstreams (checked 12 Nov 2026) and the Ollama picks.
// Limits are estimates, not promises.
export const UPSTREAM_TERMS = {
  ovh: { signup: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/', logsOrTrains: false, terms: 'Says it does not keep or train on prompts and replies. Hosted in the EU. Read the host\'s terms before business use.', limit: 'About 2 requests a minute per address for each model, without a key.' },
  llm7: { signup: 'https://token.llm7.io', logsOrTrains: 'unknown', terms: 'No statement on keeping prompts, so treat it as logging. The free quota can shrink without notice.', limit: 'Off by default. Without a token it answered "free token allowance reached" on 20 Nov 2026. Its model names are read from the host when you switch it on.' },
  pollinations: { signup: 'https://enter.pollinations.ai', logsOrTrains: 'unknown', terms: 'No statement on keeping prompts, so treat it as logging. Only one model works without a key.', limit: 'Not published. A careful guess: about 4 a minute.' },
  kilo: { signup: 'https://app.kilo.ai/profile', logsOrTrains: true, terms: 'May send your prompts on to providers that log them. The free pool changes often. Read the host\'s terms before business use.', limit: 'About 200 requests an hour per address on the free models.' },
  aihorde: { signup: 'https://aihorde.net/register', logsOrTrains: true, terms: 'Volunteer machines read your prompts, so treat everything you send as public. Answers can wait in a queue.', limit: 'Not published. Anonymous requests wait in the lowest queue.' },
};
// Data-use line per keyed provider (same source).
export const PROVIDER_TERMS = {
  groq: 'No statement on keeping prompts in the source list, so treat it as logging.',
  gemini: 'Google may use free-tier prompts to improve its products. The free tier is not offered in the EEA, Switzerland or the UK.',
  openrouter: 'Free models may log prompts for training.',
  cloudflare: 'No statement on keeping prompts in the source list, so treat it as logging. Some models need a paid plan.',
  zai: 'No statement on keeping prompts in the source list, so treat it as logging.',
  cohere: 'Trial keys are for non-commercial use only. No statement on keeping prompts, so treat it as logging.',
  nvidia: 'For trying things out, research and testing only. Use is logged. Do not send personal or confidential text.',
  openai: 'Paid. Read the provider\'s data terms.', anthropic: 'Paid. Read the provider\'s data terms.', deepseek: 'Paid. Hosted in China. Read the provider\'s data terms.', together: 'Paid.', fireworks: 'Paid.', xai: 'Paid.',
  mistral: 'Free experiment tier; read Mistral\'s data terms.', cerebras: 'Read Cerebras\' data terms.',
  custom: 'Any OpenAI-compatible server: a LiteLLM proxy, LM Studio, vLLM, or another router.',
};
// Ollama models worth pulling. Order is the rank. Sizes are the Ollama library's download sizes, rounded (about).
export const OLLAMA_PICKS = [
  { tag: 'qwen3:14b', gb: 9.3, why: 'strong all-rounder with tools' },
  { tag: 'gemma3:27b', gb: 17, why: 'bigger all-rounder, reads images' },
  { tag: 'qwen3:32b', gb: 20, why: 'the strongest general model that fits 32 GB of graphics memory' },
  { tag: 'qwen3-coder:30b', gb: 19, why: 'coding on a strong PC' },
  { tag: 'gpt-oss:20b', gb: 14, why: 'reasoning and tools' },
  { tag: 'qwen3:8b', gb: 5.2, why: 'stronger reasoning, still small' },
  { tag: 'qwen2.5vl:7b', gb: 6.0, why: 'reads images and documents' },
  { tag: 'gemma3:12b', gb: 8.1, why: 'mid-size, reads images' },
  { tag: 'qwen3:4b', gb: 2.5, why: 'small all-rounder' },
  { tag: 'gemma3:4b', gb: 3.3, why: 'small, reads images' },
  { tag: 'llama3.2:3b', gb: 2.0, why: 'light chat for small PCs' },
  { tag: 'nomic-embed-text', gb: 0.3, why: 'embeddings for Knowledge search', embed: true },
  { tag: 'llama3.3:70b', gb: 43, why: 'large; needs more than 32 GB of graphics memory' },
];
export const UNSAFE_NAME = /uncensor|abliterat/i;
/** Never put an Uncensored or abliterated model first. Stable otherwise. */
export function safeFirst(list, name = (x) => x) { return [...list].sort((a, b) => (UNSAFE_NAME.test(name(a)) ? 1 : 0) - (UNSAFE_NAME.test(name(b)) ? 1 : 0)); }
