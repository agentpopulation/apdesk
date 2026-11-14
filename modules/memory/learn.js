// Learning from chat. The extraction and add / update / ignore prompts are ported, shortened and merged into one call,
// from mem0 (Apache-2.0) https://github.com/mem0ai/mem0  mem0/configs/prompts.py: USER_MEMORY_EXTRACTION_PROMPT
// and DEFAULT_UPDATE_MEMORY_PROMPT / get_update_memory_messages. mem0 itself (Python) is not run.
import { clip, terms } from './store.js';

// Never kept: keys, passwords, card numbers, one-time codes, placeholders, one-off test asks.
const SECRET = [
  /\b(sk|pk|rk|ghp|gho|xox[bpas]|AIza|AKIA|ya29)[-_A-Za-z0-9]{8,}/,
  /\b[A-Za-z0-9_\-]{32,}\b/,
  /\b(password|passwd|passcode|pass word|pin|otp|one[- ]time code|api[ -]?key|secret|token|cvv|login code)\b\s*(is|:|=)/i,
  /\b(?:\d[ -]?){13,19}\b/,
  /\bBearer\s+\S{10,}/i,
];
const JUNK = [/lorem ipsum/i, /\bplaceholder\b/i, /\b(foo|bar|baz|asdf|qwerty|xyz123)\b/i, /^(test|testing|this is a test)\b/i, /\bjust (a )?test(ing)?\b/i, /<[^>]{1,40}>|\{\{[^}]*\}\}|\[(name|company|city|x)\]/i, /\bTODO\b/];
export function looksSecret(text) { return SECRET.some(r => r.test(String(text || ''))); }
export function looksJunk(text) { const t = String(text || '').trim(); return t.length < 8 || t.length > 400 || JUNK.some(r => r.test(t)); }
export function worthAsking(user) {
  const t = String(user || '').trim();
  if (t.length < 15) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|cool|great)\b[.! ]*$/i.test(t)) return false;
  return true;
}

export const LEARN_SYSTEM = `You keep the long-term memory of a business owner's desk of AI agents. You read one exchange between the owner and an agent and decide what is worth remembering for later conversations.

Keep only durable things about the owner, his business, his people and how he wants work done:
- fact: names, company, products, customers, suppliers, places, team, prices he set, dates that matter.
- preference: likes, dislikes, tone, formats, tools, how he wants answers.
- lesson: a standing instruction for this agent ("when I ask for leads, always include the city").

Never keep: anything from the assistant's reply that the owner did not say or confirm; small talk; one-off questions or tasks ("what is 2+2", "test this", "try again"); placeholder or sample text; passwords, keys, codes, card numbers or any secret; guesses.

Compare each new item with the existing memories you are given (each has an id). Decide:
- ADD: new information not in memory.
- UPDATE: the same subject as an existing memory but with new or changed information; give that memory's id and the full new text, keeping the most information.
- NONE: already known (even in other words) or not worth keeping.

Write each memory as one short plain sentence in the third person about the owner ("The owner's company is Vortex Automation in Pune."), in the language the owner used. Also give "keys": 4 to 8 extra search words (synonyms and related words someone might use to look it up later).

Return JSON only: {"memories":[{"event":"ADD|UPDATE|NONE","id":"<existing id, only for UPDATE>","kind":"fact|preference|lesson","text":"...","keys":"word word word"}],"ignored":["<short note of what you left out and why>"]}
If nothing is worth keeping return {"memories":[],"ignored":[...]}.`;

export function learnMessages({ user, assistant, existing, today }) {
  const old = existing.length ? existing.map(m => ({ id: String(m.id), kind: m.kind, text: m.text })) : [];
  return [
    { role: 'system', content: LEARN_SYSTEM },
    { role: 'user', content: `Today is ${today}.\n\nExisting memories:\n${old.length ? JSON.stringify(old) : '(none)'}\n\nThe exchange:\nOwner: ${clip(user, 2000)}\nAgent: ${clip(assistant, 1200)}\n\nReturn the JSON.` },
  ];
}

export const KEYS_SYSTEM = 'Give 4 to 8 extra search words for this memory: synonyms and related words someone might use to look it up later. Reply with the words only, separated by spaces, no punctuation.';

export function parseJson(r) {
  if (r?.json && typeof r.json === 'object') return r.json;
  const t = String(r?.text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const m = t.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
export const cleanKeys = (s) => terms(String(s || '').replace(/[,;]/g, ' '), 10).join(' ');
