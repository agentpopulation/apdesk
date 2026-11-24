// Outside addresses in a drawn reply. A picture from outside the desk is never loaded by itself: its address is shown as text with
// a small "Show picture" button, and only that press loads it. Every link shows where it goes: the host (or mail address) beside
// its words, and the full address as hover text and, through the page's style, on focus. Works on an inert tree (a parsed
// document that loads nothing), before the nodes are put into the page.

const OUTSIDE = /^(?:https?:)?\/\//i;
const hostOf = (u) => { try { return new URL(u, 'https://desk.invalid').hostname.replace(/^www\./, ''); } catch { return ''; } };
const plainOf = (s) => String(s || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();

/** Where a link goes, in a few words: the host for a web address, the address for mail, "this desk" for the desk's own pages. */
export function whereTo(href) {
  const h = String(href || '').trim();
  if (/^mailto:/i.test(h)) return h.slice(7).split('?')[0];
  if (OUTSIDE.test(h)) return hostOf(h) || h;
  return 'this desk';
}

/** Guards every picture and link under root (see bindPictures for onShow). Returns root. */
export function guardOutside(root, { onShow } = {}) {
  const doc = root?.ownerDocument; if (!doc) return root;
  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    if (!OUTSIDE.test(src)) continue;   // the desk's own pictures and pictures written into the reply itself load as they are
    const alt = img.getAttribute('alt') || '';
    const box = doc.createElement('span'); box.className = 'outside-pic'; box.setAttribute('data-src', src);
    const words = doc.createElement('span'); words.className = 'sub'; words.textContent = `Picture${alt ? ` "${alt}"` : ''} from ${src}`;
    if (alt) box.setAttribute('data-alt', alt);
    const b = doc.createElement('button'); b.type = 'button'; b.className = 'btn ghost sm'; b.textContent = 'Show picture';
    box.append(words, ' ', b);
    img.replaceWith(box);
  }
  bindPictures(root, { onShow });
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (OUTSIDE.test(href)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }
    a.setAttribute('title', href); a.setAttribute('data-where', href);
    const where = whereTo(href); const words = plainOf(a.textContent);
    if (!where || words === plainOf(href) || words === where.toLowerCase()) continue;   // the words already are the address
    const tag = doc.createElement('span'); tag.className = 'sub link-where'; tag.textContent = ` (${where})`;
    a.after(tag);
  }
  return root;
}

/** The "Show picture" buttons under root load their picture when pressed (call it again on a copy of the nodes: a copy keeps
 *  no listeners). */
const bound = new WeakSet();
export function bindPictures(root, { onShow } = {}) {
  for (const box of root?.querySelectorAll?.('.outside-pic') || []) {
    const b = box.querySelector('button'); if (!b || bound.has(b)) continue;
    bound.add(b);
    b.addEventListener('click', () => {
      const pic = box.ownerDocument.createElement('img'); pic.setAttribute('alt', box.getAttribute('data-alt') || ''); pic.setAttribute('referrerpolicy', 'no-referrer'); pic.setAttribute('src', box.getAttribute('data-src'));
      // the desk may refuse pictures from other sites (its page rules): then say so, with the address as a link
      pic.addEventListener('error', () => {
        const d = box.ownerDocument; const line = d.createElement('span'); line.className = 'sub';
        const a = d.createElement('a'); a.setAttribute('href', box.getAttribute('data-src')); a.textContent = 'open it in a new tab';
        line.append('This picture cannot be shown inside the desk: ', a, '.'); guardOutside(line); pic.replaceWith(line);
      }, { once: true });
      box.replaceWith(pic); onShow?.(pic);
    });
  }
  return root;
}
/** The style that shows a focused link's full address under it, and the guarded picture's line. */
export const LINK_CSS = '.md a[data-where]:focus-visible::after{content:" " attr(data-where);font-size:12px;color:var(--muted,#666);word-break:break-all}'
  + '.outside-pic{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;word-break:break-all}';
