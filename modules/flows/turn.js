// One Coordinator turn for a schedule or a chain. Through the chat module when it is on (a full turn with tools),
// otherwise one model call with the agent's own system prompt. Same helper as modules/tasks/turn.js.
export async function turn(ctx, { chatId = null, agentId = 'coordinator', text, signal, onDelta, note } = {}) {
  const chat = ctx.modules.api('chat');
  if (chat && typeof chat.ask === 'function') {
    try {
      const r = await chat.ask({ chatId: chatId || undefined, agentId, text, signal, note, quiet: !!note });
      if (r && typeof r.text === 'string') return { text: r.text, label: r.label || null, chatId: r.chatId || chatId, cards: r.cards || [], via: 'chat', posted: r.posted !== false && !!(r.chatId || chatId), unfinished: r.unfinished || null };
    } catch (e) {
      if (signal?.aborted || e?.code === 'halted' || e?.code === 'aborted') throw e;
      if (e?.code !== 'not_ready') ctx.log('chat.ask failed, answering with one model call:', e?.message);
    }
  }
  const r = await ctx.model.chat({ agentId, purpose: 'chat', signal, onDelta, messages: [{ role: 'system', content: ctx.agents.systemPrompt(agentId) || '' }, { role: 'user', content: text }] });
  return { text: r.text, label: r.label, chatId, cards: [], via: 'model', posted: false };
}
