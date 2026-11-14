// Site helpers: slugifyTitle, and the html and css taken out of a model reply.
export function slugifyTitle(title) {
  const base = String(title || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return base || 'site';
}
/** Pull the html and css blocks out of a model reply, and make the page safe and static. */
export function parseSite(text) {
  const t = String(text || '');
  const block = (lang) => (t.match(new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```', 'i')) || [])[1] || '';
  let html = block('html'); let css = block('css');
  if (!html && /<html[\s>]/i.test(t)) html = t.slice(t.search(/<!doctype|<html/i));
  if (!html) return null;
  // static only: no scripts, no inline handlers, no frames, no forms that post anywhere
  html = html.replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<script[^>]*>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/<(iframe|object|embed)[\s\S]*?(<\/\1\s*>|\/?>)/gi, '').replace(/javascript:/gi, '').replace(/<form[^>]*>/gi, '<form>');
  if (!css) { const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i); if (m) { css = m[1]; html = html.replace(m[0], ''); } }
  html = html.replace(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi, (l) => (/https:\/\/fonts\.googleapis\.com/.test(l) ? l : ''));
  if (!/<link[^>]+style\.css/i.test(html)) html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, '  <link rel="stylesheet" href="style.css">\n</head>') : `<link rel="stylesheet" href="style.css">\n${html}`;
  if (!/^\s*<!doctype/i.test(html)) html = '<!doctype html>\n' + html;
  return { html, css: css.trim() + '\n' };
}
