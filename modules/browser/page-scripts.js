// Page scripts for the agent's browser: snapshotScript, scrollScript, pageTextScript.
// Each function is passed to page.evaluate, so it must be self-contained (no imports, no outer variables).
// The ref attribute is renamed to data-apd-ref.
export function snapshotScript({ start, cap }) {
  const SEL = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="combobox"]', '[role="textbox"]',
    '[role="searchbox"]', '[role="slider"]', '[role="spinbutton"]', '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',');
  const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const textOf = (el) => clean(el.innerText || el.textContent || '', 120);
  function roleOf(el) {
    const explicit = clean(el.getAttribute('role'), 40).split(' ')[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }
  function labelOf(el) {
    const ids = clean(el.getAttribute('aria-labelledby'), 200);
    if (ids) {
      const t = ids.split(' ').map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(' ');
      if (t) return clean(t, 120);
    }
    const aria = clean(el.getAttribute('aria-label'), 120);
    if (aria) return aria;
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map(textOf).join(' ');
      if (t) return clean(t, 120);
    }
    return '';
  }
  function nameOf(el, role) {
    const label = labelOf(el);
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t)) return clean(el.value || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''), 120);
      if (t === 'image') return clean(el.getAttribute('alt') || 'Submit', 120);
    }
    if (['link', 'button', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'generic'].includes(role)) {
      const t = textOf(el);
      if (t) return t;
      const img = el.querySelector && el.querySelector('img[alt]');
      if (img) return clean(img.getAttribute('alt'), 120);
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || '', 120);
  }
  function visible(el) {
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return el.getClientRects().length > 0;
  }
  let next = Number(start) || 0;
  const rows = [];
  const vh = window.innerHeight;
  for (const el of document.querySelectorAll(SEL)) {
    if (rows.length >= cap) break;
    if (!visible(el)) continue;
    let ref = el.getAttribute('data-apd-ref');
    if (!ref) {
      next += 1;
      ref = `e${next}`;
      el.setAttribute('data-apd-ref', ref);
    }
    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const row = {
      ref,
      role,
      name: nameOf(el, role),
      tag,
      type: el.getAttribute('type') ? String(el.getAttribute('type')).toLowerCase() : null,
      nameAttr: el.getAttribute('name') || null,
      id: el.id || null,
      autocomplete: el.getAttribute('autocomplete') || null,
      label: labelOf(el) || null,
      placeholder: el.getAttribute('placeholder') || null,
      editable: el.isContentEditable || undefined,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
      inView: rect.bottom > 0 && rect.top < vh,
    };
    if (tag === 'a') row.href = String(el.href || '').slice(0, 300);
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      row.checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
    }
    if (tag === 'select') {
      const opts = [...el.options];
      row.options = opts.slice(0, 40).map((o) => clean(o.label || o.text, 80));
      const sel = opts.filter((o) => o.selected).map((o) => clean(o.label || o.text, 80));
      if (sel.length) row.selected = sel.join(', ');
    }
    rows.push(row);
  }
  return {
    url: location.href,
    title: document.title,
    rows,
    next,
    scroll: { y: Math.round(window.scrollY), height: Math.round(document.documentElement.scrollHeight), view: vh },
  };
}

export function scrollScript(direction) {
  const step = Math.round(window.innerHeight * 0.8) * (direction === 'up' ? -1 : 1);
  window.scrollBy(0, step);
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return { y: Math.round(window.scrollY), atTop: window.scrollY <= 0, atBottom: window.scrollY >= max - 2 };
}

export function pageTextScript(cap) {
  return String(document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, cap);
}
