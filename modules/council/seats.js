// Which models the seats and the chairman sit on: different providers first, then different models of one provider
// (the router's live models, local models), each by explicit pick. Pure functions over what ctx.model.active() says.
const PREFER = ['gemini', 'router', 'openrouter', 'anthropic', 'openai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'cerebras', 'xai', 'custom', 'ollama'];
const NOT_CHAT = /embed|bge|minilm|nomic|whisper|tts|speech|rerank|guard|moderation|image|vision-only|stable-diffusion|flux/i;
const family = (m) => String(m).toLowerCase().replace(/^.*\//, '').match(/[a-z]+/)?.[0] || String(m);
/** Models of one provider with unlike families first (llama, qwen, mistral ...), so the seats really differ. */
function unlikeFirst(models) {
  const seen = new Set(); const first = [], rest = [];
  for (const m of models) { const f = family(m); if (seen.has(f)) rest.push(m); else { seen.add(f); first.push(m); } }
  return [...first, ...rest];
}

/** Every distinct model that can answer now, in the order seats take them: one per provider, then second models, and so on. */
export function liveSlots(active, label) {
  const per = [];
  for (const a of active || []) {
    if (!a?.ok) continue;
    const many = a.kind !== 'keyed';                       // the router, Ollama and LAN nodes list their own models
    let models = [...new Set([a.model, ...(a.models || [])].filter(m => m && m !== 'auto' && !NOT_CHAT.test(m)))];
    if (!many) models = models.slice(0, 1);
    if (!models.length) { if (a.kind === 'local') continue; models = [null]; }
    per.push({ provider: a.provider, kind: a.kind, name: a.label, models: unlikeFirst(models) });
  }
  per.sort((x, y) => (PREFER.indexOf(x.provider) + 1 || 50) - (PREFER.indexOf(y.provider) + 1 || 50));
  const slots = [];
  for (let round = 0; round < 8; round++) for (const p of per) {
    if (round >= p.models.length) continue;
    const model = p.models[round];
    slots.push({ provider: p.provider, model, kind: p.kind, label: model ? label(p.provider, model) : `${p.name} · auto` });
  }
  return slots;
}

/** Seats and chairman over the live slots. A provider that gives only one seat keeps its own choice of model (auto),
 *  so the door can move to that provider's next model when one is rate limited. */
export function spread(slots, seatCount = 3, { offline = false } = {}) {
  const need = seatCount + 1;
  const used = slots.slice(0, need).map(s => ({ ...s }));
  for (const s of used) if (s.kind !== 'local' && s.kind !== 'lan' && used.filter(x => x.provider === s.provider).length === 1 && s.model) { s.model = null; s.label = s.label.split(' · ')[0] + ' · auto'; }
  const pick = (i) => used.length ? used[i % used.length] : null;
  const seats = Array.from({ length: seatCount }, (_, i) => pick(i));
  const chair = pick(seatCount);
  const spare = slots.slice(need, need + 2);
  const n = slots.length;
  let notice = '';
  if (!n) notice = offline ? 'The desk is offline and no local model is running, so the Council cannot meet. Start Ollama or go online.' : 'No model is answering now, so the Council cannot meet. Add a key, or start the router or Ollama, in Models.';
  else if (n === 1) notice = 'Only one model is answering now, so all seats will use it.';
  else if (n < seatCount) notice = `Only ${n === 2 ? 'two' : n} models are answering now, so some seats will share one.`;
  if (offline && n) notice = ('The desk is offline, so the Council runs on local models only. ' + notice).trim();
  return { seats, chair, spare, distinct: n, notice };
}

/** After a run: say plainly when the seats did not sit on different models. */
export function modelNote(answers) {
  const labels = answers.filter(a => a?.text && a.label).map(a => a.label);
  const distinct = new Set(labels).size;
  if (labels.length >= 2 && distinct === 1) return `Only one model answered (${labels[0]}), so all seats used it.`;
  if (labels.length >= 3 && distinct < labels.length) { const dup = labels.find((l, i) => labels.indexOf(l) !== i); return `Two seats shared one model (${dup}).`; }
  return '';
}

/** Numbers in the answers that the question did not give. The seats answer from what the models know: no page was read. */
export const FIGURES_NOTE = 'Figures here come from the models, not from pages read: not checked';
export function figuresNote(question, answers, verdict, { plan = false } = {}) {
  // in a plan, "Step 2", "day 10" and "30-day" are labels, not figures
  const bare = (t) => plan ? String(t || '').replace(/\b(?:step|day|week|month)s?\s*\d+\b|\b\d+[- ](?:day|week|month)s?\b|^\s*\d+[.)]\s/gim, ' ') : String(t || '');
  const nums = (t) => bare(t).match(/\d[\d,.]*\d|\d/g) || [];
  const given = new Set(nums(question));
  const texts = [...answers.map(a => a?.text), verdict?.decision, ...(verdict?.reasons || []), verdict?.answer, ...(verdict?.steps || []).map(x => x?.text)];
  const has = texts.some(t => nums(t).some(n => !given.has(n)));
  const cited = answers.some(a => a?.searched && /https?:\/\/\S+/.test(a.text || ''));   // no seat has a search tool today
  return has && !cited ? FIGURES_NOTE : '';
}
