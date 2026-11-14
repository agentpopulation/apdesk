// Reading a model's draft reply: the subject goes to its own field and the body holds message text only.
// Tolerant of code fences, prose around the object, single quotes and trailing commas; strict about what is saved.

/** The first balanced {...} in a text (strings respected), or null when none closes. */
export function firstObject(text) {
  const s = String(text || ''); const start = s.indexOf('{'); if (start < 0) return null;
  let depth = 0; let q = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}
/** JSON.parse, then a careful second try: trailing commas dropped, single-quoted keys and strings turned into double-quoted ones. */
export function looseJson(src) {
  try { return JSON.parse(src); } catch {}
  let out = ''; let q = null; const s = String(src);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '\\') { out += q === "'" && s[i + 1] === "'" ? "'" : ch + (s[i + 1] ?? ''); i++; continue; }
      if (ch === q) { out += '"'; q = null; continue; }
      if (ch === '"' && q === "'") { out += '\\"'; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      out += ch; continue;
    }
    if (ch === '"' || ch === "'") { q = ch; out += '"'; continue; }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_]\w*)(\s*:)/g, '$1"$2"$3');
  try { return JSON.parse(out); } catch { return null; }
}
/**
 * Why a body cannot be saved as message text, or '' when it can. Script-agnostic: it never guesses truncation from capital
 * letters or end punctuation (the model door's `cutOff` says that); it refuses only structure that is not a message.
 */
export function bodyProblem(body) {
  const b = String(body || '').trim();
  if (!b) return 'empty';
  if (/^```|```$/.test(b)) return 'code fence';
  if (/^[{[]/.test(b) || /[{,]\s*["']?(subject|body)["']?\s*:/i.test(b) || /"\s*:\s*"/.test(b) || /\{\s*"/.test(b)) return 'looks like JSON';
  // a leading header block ("Subject:", "To:", "From:" ... before the message starts), not such lines inside the message
  if (/^(subject|to|from|cc|bcc)\s*:/i.test(b)) return 'header lines in the text';
  if (/[{[\\]$/.test(b) || /\\n/.test(b)) return 'raw markup';
  return '';
}
/**
 * { subject, body } from a model reply, or { error }. `json` is what the model door already parsed (may be absent).
 * Plain prose with an optional leading "Subject: ..." line is accepted; raw or cut-off structures never become the body.
 * `cutOff` is the model door's `r.cutOff` (the reply hit its length limit).
 */
export function parseDraftReply(text, json, { needSubject = true, cutOff = false } = {}) {
  const raw = String(text || '').trim();
  // the model door says the reply hit its length limit: whatever it holds is not a whole message
  if (cutOff) return { error: 'the reply was cut off' };
  // The reply text is read first: an object the model door repaired from a cut-off reply is never trusted over the text.
  let o = !raw && json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  const unfenced = raw.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
  if (!o || typeof o.body !== 'string') { const obj = firstObject(unfenced); if (obj) o = looseJson(obj); else if (unfenced.includes('{')) return { error: 'the reply was cut off' }; }
  let subject = '', body = '';
  if (o && typeof o === 'object') {
    const pick = (k) => { const key = Object.keys(o).find(x => x.toLowerCase() === k); return typeof o[key] === 'string' ? o[key] : ''; };
    subject = pick('subject'); body = pick('body') || pick('message') || pick('text');
    if (!body && o.email && typeof o.email === 'object') { subject = subject || String(o.email.subject || ''); body = String(o.email.body || ''); }
  } else if (!unfenced.includes('{')) {
    const m = unfenced.match(/^\s*subject\s*:\s*(.+)\n+([\s\S]+)$/i);
    if (m) { subject = m[1]; body = m[2]; } else body = unfenced;
  } else return { error: 'the reply was not a subject and a message' };
  subject = String(subject).replace(/^\s*subject\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  body = String(body).replace(/\r/g, '').replace(/^\s*subject\s*:.*\n+/i, '').trim();
  const why = bodyProblem(body);
  if (why) return { error: why === 'empty' ? 'the reply had no message text' : `the message text was not plain text (${why})` };
  if (needSubject && (!subject || bodyProblem(subject) === 'looks like JSON')) subject = '';
  return { subject: subject.slice(0, 140), body: body.slice(0, 4000) };
}
/** Cut at a word boundary, never mid-word. */
export function wordClip(v, n) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim(); if (s.length <= n) return s;
  const cut = s.slice(0, n + 1); const i = cut.lastIndexOf(' ');
  return (i > n * 0.5 ? cut.slice(0, i) : s.slice(0, n)).trim();
}
