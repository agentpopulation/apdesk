// Menus your way: the owner's own names, order, hidden places and the place that opens first, kept per desk as the
// setting ui.menu ({ order: [ids], names: { id: name }, hidden: [ids], first: id }). Plain functions, no page needed.
// Only how the menu looks changes: module switches, roles, the security level and approvals are never touched here.
export const MENU_KEY = 'ui.menu';
export const NAME_MAX = 30;
/** Always in the menu: Settings is the way back to these choices. */
export const ALWAYS_SHOWN = ['settings'];
const isId = (x) => typeof x === 'string' && /^[a-z0-9][a-z0-9._-]{0,60}$/.test(x);
const uniq = (list) => [...new Set((Array.isArray(list) ? list : []).filter(isId))];
const plain = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();

export function cleanMenu(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const names = {};
  if (o.names && typeof o.names === 'object') for (const [k, v] of Object.entries(o.names)) { const n = isId(k) ? plain(v) : ''; if (n) names[k] = n; }
  return { order: uniq(o.order).slice(0, 200), names, hidden: uniq(o.hidden).filter(x => !ALWAYS_SHOWN.includes(x)), first: isId(o.first) ? o.first : null };
}

/** The places in the owner's order with his names. Each keeps defaultLabel; hidden ones are marked, not dropped. */
export function arrangeMenu(items, raw) {
  const m = cleanMenu(raw);
  const pos = new Map(m.order.map((id, i) => [id, i]));
  const key = (it, i) => pos.has(it.id) ? pos.get(it.id) : 1e6 + i;
  return items.map((it, i) => ({ it, k: key(it, i) })).sort((a, b) => a.k - b.k).map(({ it }) => ({
    ...it, defaultLabel: it.label, label: m.names[it.id] || it.label, renamed: !!m.names[it.id], hidden: m.hidden.includes(it.id),
  }));
}

/** The place that opens when the desk opens with no address: the owner's choice when it is shown and usable, else Chat. */
export function firstPlace(items, raw, off = []) {
  const shown = arrangeMenu(items, raw).filter(x => !x.hidden && !off.includes(x.id));
  const want = cleanMenu(raw).first;
  if (want && shown.some(x => x.id === want)) return want;
  return shown.some(x => x.id === 'chat') ? 'chat' : (shown[0]?.id || 'chat');
}

/** Move one place: by -1 / +1 (the buttons) or { before: id } / { after: id } (a drop). Returns a new order. */
export function movePlace(order, id, to) {
  const list = [...order]; const i = list.indexOf(id); if (i < 0) return list;
  if (typeof to === 'number') { const j = i + to; if (j < 0 || j >= list.length) return list; list.splice(i, 1); list.splice(j, 0, id); return list; }
  const target = to?.before ?? to?.after; if (!target || target === id || !list.includes(target)) return list;
  list.splice(i, 1); const at = list.indexOf(target) + (to.after ? 1 : 0); list.splice(at, 0, id); return list;
}

/** The owner's name for a place (his own, else its default), hidden or not; null for a place that is not there. */
export function placeName(items, raw, id) { return arrangeMenu(items, raw).find(x => x.id === id)?.label || null; }

/** The browser tab's title: "<place> · <desk name>", the desk name alone when there is no place. */
export const tabTitle = (place, desk) => place ? `${place} · ${desk}` : desk;

/** Which ends of the menu hide places (there it shows a "more places" arrow): none when it fits. */
export function menuEnds({ scrollLeft, clientWidth, scrollWidth }) {
  const over = scrollWidth > clientWidth + 1;
  return { l: over && scrollLeft > 2, r: over && scrollLeft + clientWidth < scrollWidth - 2 };
}

/** The places ({ l, r } edges) that would show half a word: not wholly inside the menu's clear area (inside its fades),
 *  yet partly inside the menu's box. A place wholly out of the box is not drawn at all. */
export function cutPlaces(boxes, clear, box = clear) {
  const out = [];
  boxes.forEach((b, i) => { const whole = b.l >= clear.l - 0.5 && b.r <= clear.r + 0.5, gone = b.r <= box.l + 0.5 || b.l >= box.r - 0.5; if (!whole && !gone) out.push(i); });
  return out;
}
