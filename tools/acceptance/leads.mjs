// Reading the lead tables of one leads reply (ask 8). Pure: takes the tables' cell texts and the reply's words, no browser.
// The app shows the checked leads first, then (when some could not be checked) a second table titled
// "Not checked: …" with a "Not checked" column. Every row of every table counts, and every check applies to every row.

const OPEN_TITLE = /^\s*(?:.*?\.\s+)?not checked:/i;   // "Not checked: no page read said …" (or "<head>. Not checked: …" when it is the only table)
const OPEN_LABEL = /\b(country|what it sells): not checked\b/i;

/**
 * tables: [{ title, head: [text], rows: [[{ text, href }]] }] in screen order. words: the reply text and the cards' notes.
 * Returns the rows (with the table they came from), the counts and a list of problems; `problems` empty means the
 * layout and the closing line agree.
 *
 * Pass rule on count (the caller adds the per-row checks: source pages, duplicates, non-leads):
 *  - `count: 'full'` when checked + not-checked rows reach `asked`, no problem was found, and at least half the rows
 *    are checked. A list that is mostly "not checked" does not meet "leads with sources" in substance, so fewer than
 *    half checked is a problem of its own.
 *  - `count: 'honest-short'` when fewer rows are shown and the app says plainly how many it found and why; the runner
 *    reports that as PARTIAL, which still fails the ask (the runner has no partial state, and an ask for 20 is not met by 3).
 *  - `count: 'short'` otherwise.
 */
export function readLeadTables(tables, words = '', asked = 20) {
  const problems = [], rows = [];
  let checked = 0, unchecked = 0;
  tables.forEach((tb, ti) => {
    const head = tb.head || [];
    const open = OPEN_TITLE.test(tb.title || '') || head.some(h => /^not checked$/i.test(h.trim()));
    const ci = head.findIndex(h => /company|name|lead/i.test(h)), si = head.findIndex(h => /source/i.test(h)), ni = head.findIndex(h => /^not checked$/i.test(h.trim()));
    if (ci < 0) problems.push(`table ${ti + 1} has no company column`);
    if (si < 0) problems.push(`table ${ti + 1} has no source column`);
    if (open && ni < 0) problems.push(`not-checked table ${ti + 1} has no "Not checked" column`);
    for (const rw of tb.rows || []) {
      const company = ci >= 0 ? rw[ci]?.text || '' : '';
      const url = (si >= 0 ? (rw[si]?.href || (rw[si]?.text?.match(/https?:\S+/) || [''])[0]) : '') || rw.map(c => c.href).find(Boolean) || '';
      const label = ni >= 0 ? rw[ni]?.text || '' : '';
      if (open) {
        unchecked++;
        if (!OPEN_LABEL.test(label)) problems.push(`not-checked row "${company}" has no label saying what is not checked`);
      } else {
        checked++;
        if (rw.some(c => OPEN_LABEL.test(c.text || ''))) problems.push(`checked row "${company}" carries a not-checked label`);
      }
      rows.push({ company, url, open, label, table: ti });
    }
  });
  const total = checked + unchecked, text = String(words).replace(/\s+/g, ' ');
  // the closing line: "13 of 20 are placed in India and sell what you asked for; 7 more are listed as not checked."
  const groups = [...text.matchAll(/(\d+) of (\d+) (?:is |are )?(?:placed|sells?)\b[^;.]*(?:;\s*(\d+) more (?:is|are) listed as not checked)?/gi)].at(-1);
  if (groups) {
    const n = +groups[1], k = groups[3] == null ? 0 : +groups[3];
    if (n !== checked) problems.push(`closing line says ${n} checked, the tables show ${checked}`);
    if (k !== unchecked) problems.push(`closing line says ${k} not checked, the tables show ${unchecked}`);
  } else if (unchecked) problems.push(`the reply does not say how many of the ${total} are not checked`);
  for (const m of text.matchAll(/(\d+) of (\d+)\b/g)) if (+m[1] > +m[2]) problems.push(`"${m[0]}" counts more than the whole`);
  if (total && checked * 2 < total) problems.push(`mostly not checked: ${checked} of ${total} rows checked`);
  const said = [...text.matchAll(/(\d+) of (\d+) found/gi)].at(-1);
  const honest = total < asked && /\d+ of \d+ found|found (only )?\d+|could (only|not)|fewer|only \d+/i.test(text) && (!said || +said[1] === total);
  const count = total >= asked && !problems.length ? 'full' : total < asked && honest ? 'honest-short' : 'short';
  const verdict = `${total} rows: ${checked} checked, ${unchecked} not checked`;
  return { rows, total, checked, unchecked, problems, honest, count, verdict };
}
