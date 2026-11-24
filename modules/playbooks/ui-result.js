// How a run's result is drawn in History. The rule is by where the playbook came from, never by what the result says:
// - a playbook from a file: plain text only. No link, no picture, no markup; an address stays written out in full and
//   the desk never opens it.
// - a built-in playbook, or one the owner wrote: the kit's Markdown (it escapes all HTML first and draws no pictures),
//   then every link shows its full address beside its words, and a link whose address carries a query, a part after
//   "#", a name or password, or is longer than SHORT_ADDRESS opens only after the owner says yes to "Open this address?".
// Anything that could load from outside by itself is never drawn: it is put back as its address in text.
export const SHORT_ADDRESS = 60;
export const LOADS = 'img,picture,source,video,audio,track,iframe,frame,object,embed,link,style,svg,image,form,input,button,base,meta,script,template';

/** 'links' only for a built-in playbook or the owner's own; anything else is drawn as text. */
export const drawsLinks = (show) => show === 'links';

/** Whether opening this address asks first. An address that cannot be read always asks. */
export function asksFirst(href) {
  let u; try { u = new URL(String(href)); } catch { return true; }
  if (!/^https?:$/.test(u.protocol)) return true;
  return !!u.search || !!u.hash || !!u.username || !!u.password || String(href).length > SHORT_ADDRESS;
}

/** The result as an element. `show` is what the desk said for this playbook ('text' or 'links'). */
export function drawResult(text, show, { h, md, btn }) {
  const src = String(text ?? '');
  if (!drawsLinks(show)) return h('div', { class: 'pb-plain', 'data-show': 'text' }, src);
  const el = md(src); el.dataset.show = 'links';
  for (const x of el.querySelectorAll(LOADS)) x.replaceWith(document.createTextNode(x.getAttribute('src') || x.getAttribute('href') || x.getAttribute('data') || ''));
  for (const a of el.querySelectorAll('a')) {
    const href = a.getAttribute('href') || ''; const words = a.textContent;
    let ok = false; try { ok = /^https?:$/.test(new URL(href).protocol); } catch {}
    if (!ok) { a.replaceWith(document.createTextNode(href && href !== words ? `${words} (${href})` : words)); continue; }
    if (words.trim() !== href) a.after(h('span', { class: 'pb-addr' }, ` (${href})`));
    if (!asksFirst(href)) continue;
    // no href: a careless click, a middle click or "open in a new tab" cannot open it; only "Open it" below does
    a.removeAttribute('href'); a.setAttribute('role', 'link'); a.tabIndex = 0; a.classList.add('pb-ask-link');
    const askNow = (e) => {
      e.preventDefault();
      el.querySelector(':scope > .pb-ask')?.remove();
      const box = h('div', { class: 'pb-ask', role: 'alertdialog', 'aria-label': 'Open this address?' },
        h('p', null, 'Open this address?'), h('p', { class: 'pb-addr' }, href),
        h('div', { class: 'row' }, btn('Do not open', { kind: 'ghost sm', onClick: () => box.remove() }),
          btn('Open it', { kind: 'sm', onClick: () => { box.remove(); window.open(href, '_blank', 'noopener,noreferrer'); } })));
      let at = a; while (at.parentElement && at.parentElement !== el) at = at.parentElement;   // after the block that holds it
      if (at.parentElement === el) at.after(box); else el.append(box);
      box.querySelector('button')?.focus({ preventScroll: true });
    };
    a.addEventListener('click', askNow);
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') askNow(e); });
  }
  return el;
}
