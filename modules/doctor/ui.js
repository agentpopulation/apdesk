// The Doctor page: one button, "Check my desk". Each check is fine, a problem or not checked; a problem says what to
// do in one line and has a button to the right place. Below, what the desk learned about which model answers best.
const CSS = `
.view.docv{display:flex;flex-direction:column;min-height:0;height:100%;padding:0}
.docv .doc-top{padding:14px 18px 10px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.docv .doc-top h2{margin:0;font-size:18px}
.docv .doc-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 28px;display:flex;flex-direction:column;gap:10px}
.docv .doc-row{display:flex;flex-direction:column;gap:6px;min-width:0}
.docv .doc-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.docv .doc-head b{font-size:14.5px}
.docv .doc-line{margin:0;font-size:14px;overflow-wrap:anywhere}
.docv .doc-todo{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13.5px}
.docv ul{margin:0;padding-left:18px;font-size:13px;color:var(--dim);display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
.docv h3{margin:8px 0 0;font-size:15px}
@media (max-width:600px){.docv .doc-top,.docv .doc-body{padding-left:16px;padding-right:16px}}
`;
const STATE = { fine: ['Fine', 'ok'], problem: ['Problem', 'stop'], skipped: ['Not checked', 'wait'] };
const PLACE = { models: 'Open Models', files: 'Open Files' };
const SECTION = { network: 'Open Settings, Network', modules: 'Open Settings, Modules', backup: 'Open Settings, Backup', general: 'Open Settings, General' };

export const pages = {
  doctor: {
    title: 'Doctor',
    async render(el, ui) {
      const { h, api, btn, pill, card, empty, toast } = ui;
      if (!document.getElementById('docv-css')) document.head.append(h('style', { id: 'docv-css' }, CSS));
      el.classList.add('docv');
      const note = h('span', { class: 'sub', 'aria-live': 'polite' }, 'It checks; it changes nothing by itself.');
      const go = btn('Check my desk', { id: 'doc-check', onClick: () => run() });
      const list = h('div', { class: 'doc-list', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, empty('Press Check my desk. It makes one small model call and one internet check.'));
      const learnedEl = h('div', { class: 'doc-learned' });
      el.replaceChildren(h('div', { class: 'doc-top' }, h('h2', null, 'Doctor'), note, h('span', { class: 'grow' }), go), h('div', { class: 'doc-body' }, list, learnedEl));

      const placeButton = (p) => p && btn(p.page === 'settings' ? (SECTION[p.section] || 'Open Settings') : (PLACE[p.page] || 'Open'), { kind: 'ghost sm', onClick: () => p.section ? ui.go(p.page, p.section) : ui.go(p.page) });
      const rowEl = (c) => {
        const [word, kind] = STATE[c.state] || STATE.skipped;
        return card({ class: 'doc-row', 'data-check': c.id },
          h('div', { class: 'doc-head' }, pill(word, kind), h('b', null, c.name)),
          h('p', { class: 'doc-line' }, c.line),
          c.details?.length ? h('ul', null, c.details.map(d => h('li', null, d))) : null,
          c.todo ? h('div', { class: 'doc-todo' }, h('span', null, c.todo), placeButton(c.place)) : null);
      };
      const paintLearned = (L) => {
        if (!L) return;
        const good = (L.lines || []).filter(x => x.enough); const few = (L.lines || []).filter(x => !x.enough);
        learnedEl.replaceChildren(...[h('h3', null, 'Which model answers best'), h('p', { class: 'sub' }, L.rule),
          good.length ? h('ul', null, good.map(x => h('li', null, x.line))) : empty(`Not enough calls yet in the last ${L.days} days to learn from.`),
          few.length ? h('details', null, h('summary', null, `Fewer than ${L.minCalls} calls`), h('ul', null, few.map(x => h('li', null, x.line)))) : null].filter(Boolean));
      };
      const run = async () => {
        go.disabled = true; note.textContent = 'Checking…';
        try {
          const r = await api('m/doctor/check', { method: 'POST', body: {} });
          list.replaceChildren(...r.checks.map(rowEl));
          note.textContent = r.problems ? `${r.problems} ${r.problems === 1 ? 'problem' : 'problems'} found. Checked ${r.atText}.` : `All fine. Checked ${r.atText}.`;
          paintLearned(r.learned);
        } catch (e) { note.textContent = ''; toast(e.message, 'err'); }
        finally { go.disabled = false; }
      };
      try { paintLearned(await api('m/doctor/learned')); } catch {}
    },
    unmount() {},
  },
};
