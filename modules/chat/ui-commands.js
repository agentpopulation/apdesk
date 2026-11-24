// Commands from modules (shared with the page, so its name starts with ui-): a module declares them in its manifest ("commands": [{ "name": "advisor", "hint": "..." }]) and
// exposes command(name, { text, chatId, agentId, signal }). The owner types /name and his text; Chat hands it to that module
// and shows what came back. Chat has no command of its own. Used by server.js and by the page (the list as he types).

const NAME = /^[a-z][a-z0-9-]{0,23}$/;
/** A manifest's commands that are well made: a short lower-case name and a hint of plain text. Anything else is left out. */
export function commandsOf(manifest) {
  const list = Array.isArray(manifest?.commands) ? manifest.commands : [];
  const out = [];
  for (const c of list) {
    const name = typeof c?.name === 'string' ? c.name.trim().toLowerCase() : '';
    const hint = typeof c?.hint === 'string' ? c.hint.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (NAME.test(name) && !out.some(x => x.name === name)) out.push({ name, hint });
  }
  return out;
}
/** The command a typed message calls, or null: "/name" at the very start, then a space or the end. A /word that is no
 *  module's command is ordinary text. */
export function commandIn(text, commands = []) {
  const m = String(text || '').match(/^\/([A-Za-z][\w-]{0,23})(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const c = commands.find(x => x.name === m[1].toLowerCase());
  return c ? { ...c, text: String(m[2] || '').trim() } : null;
}
/** The commands that fit what is typed so far ("/" alone shows them all), for the list under the message box. */
export function commandsFor(typed, commands = []) {
  const m = String(typed || '').match(/^\/([\w-]*)$/);
  if (!m) return [];
  const w = m[1].toLowerCase();
  return commands.filter(c => c.name.startsWith(w)).slice(0, 8);
}
/** What a module's command() gave back, as a reply: { text, cards }. A string is the text; an object may carry text, card
 *  and cards. Nothing usable is null. */
export function commandReply(out) {
  if (typeof out === 'string') return out.trim() ? { text: out.trim(), cards: [] } : null;
  if (!out || typeof out !== 'object') return null;
  const cards = [out.card, ...(Array.isArray(out.cards) ? out.cards : [])].filter(c => c && typeof c === 'object');
  const text = typeof out.text === 'string' ? out.text.trim() : '';
  return text || cards.length ? { text, cards } : null;
}
