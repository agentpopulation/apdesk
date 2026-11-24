// The Meetings page: the list of meetings on the left, one meeting on the right (on a phone, one at a time). A new
// meeting comes in pasted, from a file or recorded; its notes come back with each item's own line. Every next step is a
// click that answers back. Meeting text is shown as text nodes only, never as markup.
const API = '/api/m/meetings';
const CSS = `
.view.mtv{display:flex;flex-direction:column;min-height:0;height:100%;padding:0}
.mtv .mt-top{padding:14px 18px 10px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.mtv .mt-top h2{margin:0;font-size:18px}
.mtv .mt-top .sub{flex:1 1 260px;min-width:0}
.mtv .mt-main{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(240px,320px) minmax(0,1fr)}
.mtv .mt-side{border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.mtv .mt-search{padding:10px 12px;border-bottom:1px solid var(--line)}
.mtv .mt-search input{width:100%}
.mtv .mt-list{flex:1 1 auto;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:2px}
.mtv .mt-item{display:flex;flex-direction:column;gap:3px;text-align:left;padding:9px 10px;border-radius:10px;border:1px solid transparent;min-width:0;width:100%}
.mtv .mt-item:hover{background:var(--raised)}
.mtv .mt-item[aria-current="true"]{background:var(--raised);border-color:var(--line-strong)}
.mtv .mt-item .t{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mtv .mt-item .m{display:flex;gap:6px;align-items:center;flex-wrap:wrap;color:var(--dim);font-size:12px}
.mtv .mt-body{min-height:0;overflow:auto;padding:16px 18px 28px;display:flex;flex-direction:column;gap:12px;min-width:0}
.mtv .mt-body h3{margin:0;font-size:16px;overflow-wrap:anywhere}
.mtv .mt-body h4{margin:0 0 6px;font-size:14px}
.mtv .mt-facts{display:flex;gap:8px 14px;flex-wrap:wrap;color:var(--dim);font-size:13px;align-items:center}
.mtv .mt-sum{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:14px}
.mtv .mt-sum li{overflow-wrap:anywhere}
.mtv .mt-sum details{margin-top:2px}
.mtv .mt-sum details summary{font-size:12.5px}
.mtv .mt-sum .q{font-size:12.5px;color:var(--dim);overflow-wrap:anywhere;border-left:2px solid var(--line-strong);padding-left:8px;margin-top:3px}
.mtv .mt-it{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line);min-width:0}
.mtv .mt-it:last-child{border-bottom:0}
.mtv .mt-it input[type=checkbox]{margin-top:3px;flex-shrink:0}
.mtv .mt-it>div{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.mtv .mt-it .w{font-size:14px;overflow-wrap:anywhere}
.mtv .mt-it .q{font-size:12.5px;color:var(--dim);overflow-wrap:anywhere;border-left:2px solid var(--line-strong);padding-left:8px}
.mtv .mt-it .f{display:flex;gap:6px 12px;flex-wrap:wrap;font-size:12.5px;color:var(--dim)}
.mtv .mt-check{display:flex;flex-direction:column;gap:3px;font-size:14px}
.mtv .mt-check p{margin:0}
.mtv .mt-tick{display:inline-flex;gap:6px;align-items:center;font-size:13px;color:var(--dim);margin-top:8px}
.mtv .mt-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.mtv .mt-answer{font-size:13.5px;margin:6px 0 0;overflow-wrap:anywhere}
.mtv .mt-names{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:13.5px}
.mtv .mt-names label{display:inline-flex;gap:6px;align-items:center}
.mtv .mt-form{display:flex;flex-direction:column;gap:12px;min-width:0}
.mtv .mt-form label.fl{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--dim);min-width:0}
.mtv .mt-form .two{display:flex;gap:12px;flex-wrap:wrap}
.mtv .mt-form .two>label{flex:1 1 200px}
.mtv .mt-form input[type=text],.mtv .mt-form input[type=date],.mtv .mt-form select{width:100%;font-size:14px}
.mtv .mt-form input[type=date]{background:var(--well);border:1px solid var(--line-strong);border-radius:var(--r-s);padding:6px 10px;color:inherit;font:inherit}
.mtv .mt-form textarea{min-height:200px;font-size:14px}
.mtv .mt-rec{display:flex;flex-direction:column;gap:6px;font-size:13.5px}
.mtv .mt-rec .big{font-variant-numeric:tabular-nums;font-size:20px}
.mtv .mt-text{white-space:pre-wrap;font-size:13px;color:var(--dim);max-height:340px;overflow:auto;overflow-wrap:anywhere;margin:8px 0 0}
.mtv details summary{cursor:pointer;color:var(--dim);font-size:13px}
.mtv .mt-tasks{width:100%;border-collapse:collapse;font-size:13.5px;table-layout:fixed}
.mtv .mt-tasks th,.mtv .mt-tasks td{border-bottom:1px solid var(--line);padding:7px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.mtv .mt-tasks th{color:var(--dim);font-weight:600;font-size:12.5px}
.mtv .mt-tasks td.ck{width:34px}
.mtv .mt-back{display:none}
@media (max-width:860px){
  .mtv .mt-main{grid-template-columns:minmax(0,1fr)}
  .mtv .mt-side{border-right:0}
  .mtv.has-open .mt-side{display:none}
  .mtv:not(.has-open) .mt-body{display:none}
  .mtv .mt-back{display:inline-flex}
  .mtv .mt-top,.mtv .mt-body{padding-left:16px;padding-right:16px}
  .mtv .mt-tasks thead{display:none}
  .mtv .mt-tasks tr{display:grid;grid-template-columns:34px minmax(0,1fr);border-bottom:1px solid var(--line);padding:6px 0}
  .mtv .mt-tasks td{border:0;padding:2px 6px}
  .mtv .mt-tasks td:not(.ck){grid-column:2}
  .mtv .mt-tasks td.ck{grid-row:1 / span 5}
  .mtv .mt-tasks td[data-l]::before{content:attr(data-l) ": ";color:var(--dim)}
}
`;
const STATE = { waiting: ['Waiting', ''], working: ['Making notes', 'run'], listening: ['Turning sound into words', 'run'], ready: ['Notes ready', 'ok'], unusable: ['No usable answer', 'stop'], stopped: ['Stopped', 'wait'] };
const NOT_SAID = 'not said';
// What the notes are, in words the code backs for every input (the same words as CLAIM, SUMMARY_HEAD and SUMMARY_CLAIM in server.js).
const CLAIM = "An item was kept only when its figures (digits or English number words, with size words such as lakh, cr or k), date words and names are in the lines it shows, with the same values; a figure the desk could not read for certain removed it. The wording is the model's, not checked for meaning: read each line.";
const SUMMARY_HEAD = "Summary: the model's wording, not checked for meaning";
const SUMMARY_CLAIM = "A summary line was kept only when its figures, date words and names are in the lines it gives, with the same values. Open a line to read them.";
const PASTE_NOTE = "A meeting pasted into chat can be pasted here instead. On this page its words only become notes: nothing in them can act on the desk.";

/** A 16 kHz mono WAV recorder in the page. Nothing leaves the browser until the owner stops and the desk takes it. */
function recorder() {
  let stream = null, ac = null, node = null, src = null; const chunks = []; let rate = 16000;
  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      ac = new AudioContext({ sampleRate: 16000 }); rate = ac.sampleRate;
      src = ac.createMediaStreamSource(stream); node = ac.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(node); node.connect(ac.destination);
    },
    stop() {
      try { node?.disconnect(); src?.disconnect(); } catch {} try { stream?.getTracks().forEach(t => t.stop()); } catch {} try { ac?.close(); } catch {}
      const n = chunks.reduce((s, c) => s + c.length, 0); const b = new DataView(new ArrayBuffer(44 + n * 2));
      const s = (o, t) => { for (let i = 0; i < t.length; i++) b.setUint8(o + i, t.charCodeAt(i)); };
      s(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
      b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); s(36, 'data'); b.setUint32(40, n * 2, true);
      let o = 44; for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) { const v = Math.max(-1, Math.min(1, c[i])); b.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
      chunks.length = 0; return new Blob([b.buffer], { type: 'audio/wav' });
    },
    cancel() { try { node?.disconnect(); src?.disconnect(); } catch {} try { stream?.getTracks().forEach(t => t.stop()); } catch {} try { ac?.close(); } catch {} chunks.length = 0; },
  };
}

/** Who makes the notes: the agents on the roster with their models; the choice saves by itself and shows the tick. */
function agentPicker(ui, info, onChange) {
  const { h, api, savedMark } = ui; const mark = savedMark();
  const sel = h('select', { 'aria-label': 'Who makes the notes' }, info.agents.map(a => h('option', { value: a.id, selected: a.id === info.agentId }, `${a.name} (${a.model})`)));
  sel.onchange = async () => { const old = info.agentId; const ok = await mark.run(() => api(API + '/prefs', { body: { agentId: sel.value } }), { field: sel, old }); if (ok) { info.agentId = sel.value; onChange?.(sel.value); } };
  return h('label', { class: 'fl' }, 'Who makes the notes', h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, sel, mark));
}

export const pages = {
  meetings: {
    title: 'Meetings',
    async render(el, ui) {
      const { h, api, btn, pill, card, empty, toast, fmt, confirm, seg, announce } = ui;
      if (!document.getElementById('mtv-css')) document.head.append(h('style', { id: 'mtv-css' }, CSS));
      el.classList.add('mtv');
      let info = { agents: [], agentId: '', record: { available: false, why: '' }, today: '', keep: false, mailOn: false, crm: { available: false } };
      let items = []; let openId = null; let tab = 0; let q = ''; let live = null; let rec = null; let ending = null;
      const tabs = seg(['Meetings', 'Team tasks'], 0, (_, i) => { tab = i; paint(); });
      const newBtn = btn('New meeting', { onClick: () => { openId = 'new'; tab = 0; tabs.set(0); paint(); } });
      const top = h('div', { class: 'mt-top' }, h('h2', null, 'Meetings'), h('p', { class: 'sub' }, 'Record or paste a meeting; get notes, tasks for the team and follow-up drafts that wait for you.'), tabs, newBtn);
      const search = h('input', { type: 'search', placeholder: 'Search by word', 'aria-label': 'Search meetings by word', oninput: () => { clearTimeout(search._t); search._t = setTimeout(() => { q = search.value.trim(); loadList(); }, 250); } });
      const listEl = h('div', { class: 'mt-list', role: 'list' });
      const side = h('div', { class: 'mt-side' }, h('div', { class: 'mt-search' }, search), listEl);
      const body = h('div', { class: 'mt-body', 'aria-live': 'polite' });
      const main = h('div', { class: 'mt-main' }, side, body);
      el.replaceChildren(top, main);

      const back = () => btn('Back to the list', { kind: 'ghost sm', class: 'btn ghost sm mt-back', onClick: () => { openId = null; paint(); } });
      const stateChip = (s) => { const [w, k] = STATE[s] || STATE.waiting; return pill(w, k); };
      const answer = (text, kind = '') => h('p', { class: 'mt-answer ' + kind, role: 'status' }, text);
      const words = (n) => `${Number(n || 0).toLocaleString()} ${n === 1 ? 'word' : 'words'}`;

      async function loadInfo() { try { info = await api(API + '/info'); } catch (e) { toast(e.message, 'err'); } }
      async function loadList() {
        try { items = (await api(API + '/list' + (q ? '?q=' + encodeURIComponent(q) : ''))).items; } catch (e) { toast(e.message, 'err'); items = []; }
        paintList();
        if (items.some(m => ['working', 'listening'].includes(m.state))) { if (!ending) ending = announce('Making meeting notes…'); }
        else if (ending) { ending(); ending = null; }
      }
      function paintList() {
        if (!items.length) {
          listEl.replaceChildren(empty(q ? `No meeting has the word "${q}".` : 'No meetings yet. Press New meeting, then paste the words, add a file or record.'));
          return;
        }
        listEl.replaceChildren(...items.map(m => h('button', { type: 'button', class: 'mt-item', role: 'listitem', 'aria-current': String(m.id === openId), onClick: () => { openId = m.id; paint(); } },
          h('span', { class: 't' }, m.title),
          h('span', { class: 'm' }, stateChip(m.state), h('span', null, m.heldOnText || fmt.date(m.created)), h('span', null, m.words ? words(m.words) : 'no words yet')))));
      }

      // ---- a new meeting
      function paintNew() {
        const title = h('input', { type: 'text', placeholder: 'Optional; else its first words', 'aria-label': 'Title' });
        const day = h('input', { type: 'date', value: info.today, max: info.today, 'aria-label': 'Held on' });
        let how = 0;
        const pasteBox = h('textarea', { placeholder: 'Paste the words of the meeting here. A line per speaker reads best, for example:\nKim: We send the quote to Northwind by Friday.', 'aria-label': 'The words of the meeting' });
        const fileIn = h('input', { type: 'file', accept: '.txt,.vtt,.srt,.md,.markdown,text/plain,text/vtt,text/markdown', 'aria-label': 'A file with the words of the meeting' });
        const fileNote = h('p', { class: 'sub' }, 'Plain text, Markdown, or captions (.vtt, .srt). Time codes are dropped; speaker names are kept.');
        let fileData = null;
        fileIn.onchange = async () => {
          const f = fileIn.files?.[0]; fileData = null; if (!f) return;
          if (f.size > 8 * 1024 * 1024) { fileNote.textContent = 'That file is too big. Use a text or caption file under 8 MB.'; return; }
          fileData = { fileName: f.name, content: await f.text() };
          fileNote.textContent = `${f.name} is ready (${fmt.bytes(f.size)}). It is read when you press Save and make notes.`;
        };
        const pane = h('div', { class: 'stack' });
        const keep = h('input', { type: 'checkbox', checked: info.keep });
        const recPane = () => {
          const r = info.record;
          if (!r.available) return card(h('div', { class: 'mt-rec' }, h('div', { class: 'row' }, pill('Not available', 'wait'), h('b', null, 'Record')), h('p', { class: 'sub' }, r.why),
            h('div', { class: 'row' }, btn(r.place === 'voice' ? 'Open Settings, Voice' : 'Open Settings, Modules', { kind: 'ghost sm', onClick: () => ui.go('settings', r.place === 'voice' ? 'voice' : 'modules') })), h('p', { class: 'sub' }, 'Paste and file still work.')));
          const clock = h('span', { class: 'big' }, '0:00'); const status = h('p', { class: 'sub', role: 'status' }, 'Not recording.');
          const go = btn('Start recording', { onClick: async () => {
            if (rec) { // stop and send
              const blob = rec.r.stop(); clearInterval(rec.t); rec = null; go.textContent = 'Start recording'; status.textContent = 'Sending the recording to the desk…';
              try {
                const qs = new URLSearchParams({ keep: keep.checked ? '1' : '0', heldOn: day.value || info.today, title: title.value.trim() });
                const m = await api(`${API}/record?${qs}`, { body: blob });
                toast('Recording saved. Turning it into words now.', 'ok'); openId = m.id; await loadList(); paint();
              } catch (e) { status.textContent = ''; toast(e.message, 'err'); }
              return;
            }
            if (!navigator.mediaDevices?.getUserMedia) { toast('This browser cannot use the microphone here.', 'err'); return; }
            const r2 = recorder();
            try { await r2.start(); } catch { toast('The microphone could not be used. Allow it for this page and try again.', 'err'); return; }
            const t0 = Date.now(); rec = { r: r2, t: setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 500) };
            go.textContent = 'Stop and make notes'; status.textContent = 'Recording. Nothing is sent until you stop.';
          } });
          return card(h('div', { class: 'mt-rec' },
            h('div', null, h('b', null, 'Engine: '), r.engine), h('div', null, r.leavesText), h('div', null, r.cost),
            h('div', null, h('b', null, 'Tell the others you are recording.')),
            h('label', { class: 'row', style: { gap: '6px' } }, keep, 'Keep the recording (else the sound is deleted once it is turned into words, or once that stops or fails)'),
            h('div', { class: 'row' }, go, clock), status));
        };
        const pasteNote = h('p', { class: 'sub' }, PASTE_NOTE);
        const paintHow = () => { pane.replaceChildren(...(how === 0 ? [pasteBox, pasteNote] : [how === 1 ? h('div', { class: 'stack' }, fileIn, fileNote) : recPane()])); save.hidden = how === 2; };
        const howSeg = seg(['Paste', 'File', info.record.available ? 'Record' : 'Record (not available)'], 0, (_, i) => { if (rec) { rec.r.cancel(); clearInterval(rec.t); rec = null; } how = i; paintHow(); });
        const result = h('div');
        const save = btn('Save and make notes', { onClick: async () => {
          const b = { title: title.value.trim(), heldOn: day.value || info.today };
          if (how === 0) { if (!pasteBox.value.trim()) { pasteBox.focus(); result.replaceChildren(answer('Paste the words of the meeting first.')); return; } b.text = pasteBox.value; }
          else { if (!fileData) { result.replaceChildren(answer('Pick a file first.')); return; } Object.assign(b, fileData); }
          save.disabled = true; save.textContent = 'Saving…';
          try { const m = await api(API + '/add', { body: b }); toast('Saved. Making the notes now.', 'ok'); openId = m.id; await loadList(); paint(); }
          catch (e) { result.replaceChildren(answer(ui.plainError ? ui.plainError(e) : e.message)); save.disabled = false; save.textContent = 'Save and make notes'; }
        } });
        body.replaceChildren(back(), h('h3', null, 'New meeting'),
          h('div', { class: 'mt-form' },
            h('div', { class: 'two' }, h('label', { class: 'fl' }, 'Title', title), h('label', { class: 'fl' }, 'Held on', day)),
            h('div', null, howSeg), pane,
            info.agents.length ? agentPicker(ui, info) : h('p', { class: 'sub' }, 'No agent is on the roster, so no model can make the notes. Add one on the Agents page.'),
            h('div', { class: 'row' }, save), result));
        paintHow();
      }

      // ---- one meeting
      async function paintMeeting(id) {
        let m; try { m = await api(`${API}/m/${encodeURIComponent(id)}`); } catch (e) { body.replaceChildren(back(), empty(e.message)); return; }
        if (openId !== id) return;
        const facts = h('div', { class: 'mt-facts' }, stateChip(m.state), h('span', null, 'Held on ' + m.heldOnText), h('span', null, words(m.words)),
          m.fileName ? h('span', null, 'From ' + m.fileName) : m.source === 'record' ? h('span', null, 'Recorded') : h('span', null, 'Pasted'),
          m.label ? h('span', null, 'Notes by ' + m.label + (m.seconds != null ? ` in ${m.seconds} s` : '')) : null);
        const titleIn = h('input', { type: 'text', value: m.title, 'aria-label': 'Title', style: { flex: '1 1 220px', minWidth: '0', fontSize: '15px', fontWeight: '600' } });
        const tMark = ui.savedMark();
        titleIn.onchange = () => tMark.run(async () => { const r = await api(`${API}/m/${m.id}/edit`, { body: { title: titleIn.value } }); titleIn.value = r.title; loadList(); }, { field: titleIn, old: m.title });
        const head = h('div', { class: 'row' }, titleIn, tMark);
        const parts = [back(), head, facts];
        if (m.reason) parts.push(h('p', { class: 'sub' }, m.reason));
        if (m.hidden && m.state !== 'ready') parts.push(h('p', { class: 'sub' }, `${m.hidden} hidden ${m.hidden === 1 ? 'character was' : 'characters were'} taken out of the text before the model read it.`));
        if (m.kept) parts.push(h('p', { class: 'sub' }, `The recording is kept in the workspace: ${m.kept}.`));
        const busy = ['working', 'listening'].includes(m.state);
        const ctl = h('div', { class: 'mt-acts' });
        if (busy) ctl.append(btn('Stop', { kind: 'ghost sm', onClick: async () => { try { await api(`${API}/m/${m.id}/stop`, { body: {} }); toast('Stopped.', 'ok'); await loadList(); paint(); } catch (e) { toast(e.message, 'err'); } } }));
        else if (m.retry) ctl.append(btn('Try again', { kind: 'sm', onClick: async () => {
          try { await api(`${API}/m/${m.id}/make`, { body: {} }); toast('Turning the recording into words again.', 'ok'); await loadList(); paint(); } catch (e) { toast(e.message, 'err'); }
        } }));
        else if (m.words) ctl.append(btn(m.state === 'ready' ? 'Make notes again' : 'Make notes', { kind: m.state === 'ready' ? 'ghost sm' : 'sm', onClick: async () => {
          if (m.state === 'ready' && !await confirm('Make the notes again? The notes you see now are replaced. Tasks already added stay.', { ok: 'Make again' })) return;
          try { await api(`${API}/m/${m.id}/make`, { body: {} }); toast('Making the notes now.', 'ok'); await loadList(); paint(); } catch (e) { toast(e.message, 'err'); }
        } }));
        ctl.append(btn('Delete', { kind: 'ghost sm', onClick: async () => {
          if (!await confirm(`Delete the meeting "${m.title}" and its notes? Tasks already added stay in Team tasks.`, { ok: 'Delete', kind: 'stop' })) return;
          try { const r = await api(`${API}/m/${m.id}`, { method: 'DELETE' }); toast(r.line, 'ok'); openId = null; await loadList(); paint(); } catch (e) { toast(e.message, 'err'); }
        } }));
        if (!busy && info.agents.length) parts.push(card(h('div', { class: 'mt-form' }, agentPicker(ui, info))));
        parts.push(ctl);
        if (busy) parts.push(card(h('div', { class: 'row' }, ui.spinner(), h('span', null, m.state === 'listening' ? 'Turning the recording into words. This can take a few minutes.' : 'Making the notes. Long meetings are read in parts.'))));
        if (m.state === 'ready' && m.notes) parts.push(...notesView(m));
        if (m.text) parts.push(card(h('details', null, h('summary', null, `The meeting text (${words(m.words)})`), h('pre', { class: 'mt-text' }, m.text.split('\n').map((l, i) => `${i + 1}  ${l}`).join('\n')))));
        body.replaceChildren(...parts);
      }

      function notesView(m) {
        const n = m.notes; const out = [];
        // what the check did and did not do, in plain words; nothing is ticked for the owner
        out.push(h('div', { class: 'mt-check', role: 'note' }, h('p', null, CLAIM),
          h('p', { class: 'sub' }, 'Nothing is ticked for you. Tick what you have read and agree with: only ticked items go into Add as tasks and the follow-up.'),
          ...(n.leftText || []).map(t => h('p', { class: 'sub' }, t))));
        const sumTick = h('input', { type: 'checkbox', checked: false, 'aria-label': 'Include the summary' });
        const lineList = (from) => from.map(f => h('div', { class: 'q' }, `Line ${f.line}: ${f.source}`));
        out.push(card(h('h4', null, SUMMARY_HEAD), h('p', { class: 'sub', style: { margin: '0 0 8px' } }, SUMMARY_CLAIM),
          n.summary.length ? h('ul', { class: 'mt-sum' }, n.summary.map(s => h('li', null, h('span', null, s.text),
            h('details', null, h('summary', null, s.from.length === 1 ? `Its line (${s.from[0].line})` : `Its lines (${s.from.map(f => f.line).join(', ')})`), ...lineList(s.from)))))
            : h('p', { class: 'sub' }, n.oldSummary ? 'This summary was made before each summary line kept its lines, so it is not shown. Press Make notes again to get one.' : 'No summary is left to show.'),
          n.summary.length ? h('label', { class: 'mt-tick' }, sumTick, 'Include the summary in the follow-up') : null));
        const fromLines = (x) => [h('span', { class: 'q' }, `From line ${x.line}: ${x.source}`), ...(x.also || []).map(o => h('span', { class: 'q' }, `With line ${o.line}: ${o.source}`))];
        // action items with ticks
        const ticks = [];
        const actRes = h('div');
        const acts = card(h('h4', null, `Action items (${n.actions.length})`),
          n.actions.length ? h('div', null, n.actions.map((a, i) => {
            const c = h('input', { type: 'checkbox', checked: false, 'aria-label': 'Tick ' + a.what }); ticks.push([i, c, a.added]);
            const when = a.due ? `${a.dueText} ("${a.when}", worked out from the meeting day)` : a.when === NOT_SAID ? 'When: not said' : `When: "${a.when}" (no day worked out from these words)`;
            return h('label', { class: 'mt-it' }, c, h('div', null, h('span', { class: 'w' }, a.what),
              h('span', { class: 'f' }, h('span', null, 'Who: ' + a.who), h('span', null, a.due ? 'When: ' + when : when), a.added ? pill('Added', 'ok') : null),
              ...fromLines(a)));
          })) : h('p', { class: 'sub' }, 'No action items are left to show.'),
          n.actions.length ? h('div', { class: 'mt-acts' }, btn('Add as tasks', { kind: 'sm', onClick: async (e) => {
            const items = ticks.filter(([, c, added]) => c.checked && !added).map(([i]) => i);
            if (!items.length) { actRes.replaceChildren(answer('Tick at least one action item first.')); return; }
            e.target.disabled = true;
            try { const r = await api(`${API}/m/${m.id}/tasks`, { body: { items } }); toast(r.line, 'ok'); await paintMeeting(m.id); body.querySelector('.mt-act-res')?.replaceChildren(answer(r.line)); }
            catch (err) { actRes.replaceChildren(answer(err.message)); e.target.disabled = false; }
          } })) : null, h('div', { class: 'mt-act-res' }, actRes));
        out.push(acts);
        const list = (title, arr, emptyText, into) => card(h('h4', null, `${title} (${arr.length})`), arr.length ? h('div', null, arr.map((d, i) => {
          const c = h('input', { type: 'checkbox', checked: false, 'aria-label': 'Tick ' + d.text }); into.push([i, c]);
          return h('label', { class: 'mt-it' }, c, h('div', null, h('span', { class: 'w' }, d.text), ...fromLines(d)));
        })) : h('p', { class: 'sub' }, emptyText));
        const dTicks = []; const qTicks = [];
        out.push(list('Decisions', n.decisions, 'No decisions are left to show.', dTicks));
        out.push(list('Open questions', n.questions, 'No open questions are left to show.', qTicks));
        const picked = (arr) => arr.filter(([, c]) => c.checked).map(([i]) => i);
        // people and firms; the follow-up goes to the people he ticks
        const pTicks = n.people.map(p => [p, h('input', { type: 'checkbox' })]);
        const to = h('input', { type: 'text', placeholder: 'Mail addresses, for example kim@northwind.example', 'aria-label': 'Send the follow-up to', value: (m.mails || []).join(', ') });
        const fuRes = h('div');
        const fu = btn('Draft a follow-up', { kind: 'sm', onClick: async () => {
          fu.disabled = true;
          try {
            const r = await api(`${API}/m/${m.id}/followup`, { body: { people: pTicks.filter(([, c]) => c.checked).map(([p]) => p), to: to.value,
              summary: sumTick.checked, actions: picked(ticks), decisions: picked(dTicks), questions: picked(qTicks) } });
            if (r.where === 'mail') { fuRes.replaceChildren(answer(r.line), btn('Open Mail', { kind: 'ghost sm', onClick: () => ui.go('mail') })); toast('Draft saved in Mail.', 'ok'); }
            else {
              const ta = h('textarea', { readonly: true, 'aria-label': 'The follow-up draft', style: { minHeight: '220px' } }, `Subject: ${r.subject}\n\n${r.body}`);
              fuRes.replaceChildren(answer(r.line), ta, h('div', { class: 'mt-acts' }, btn('Copy', { kind: 'ghost sm', onClick: async () => { try { await navigator.clipboard.writeText(ta.value); toast('Copied.', 'ok'); } catch { ta.select(); toast('Select the text and copy it.', ''); } } })));
            }
          } catch (e) { fuRes.replaceChildren(answer(e.message)); }
          finally { fu.disabled = false; }
        } });
        out.push(card(h('h4', null, 'People and firms named'),
          n.people.length ? h('div', { class: 'mt-names' }, pTicks.map(([p, c]) => h('label', null, c, p))) : h('p', { class: 'sub' }, 'No names of people are left to show.'),
          n.firms.length ? h('p', { class: 'sub', style: { marginTop: '8px' } }, 'Firms: ' + n.firms.join(', ')) : h('p', { class: 'sub', style: { marginTop: '8px' } }, 'No names of firms are left to show.'),
          h('h4', { style: { marginTop: '12px' } }, 'Follow-up'),
          h('p', { class: 'sub' }, (info.mailOn ? 'Tick who it is for. The draft goes to Mail and waits there; sending asks you.' : 'Tick who it is for. Mail is off, so the draft is shown here as text to copy.') + ' It holds only the items you ticked above, and the summary only when you tick Include the summary.'),
          h('label', { class: 'fl', style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px', fontSize: '13px', color: 'var(--dim)' } }, 'To', to),
          h('div', { class: 'mt-acts' }, fu), fuRes));
        // keep it: CRM and a file
        const keepRes = h('div');
        const fileBtn = btn('Save as a file', { kind: 'ghost sm', onClick: async () => {
          fileBtn.disabled = true;
          try { const r = await api(`${API}/m/${m.id}/file`, { body: {} }); keepRes.replaceChildren(answer(r.line), btn('Open Files', { kind: 'ghost sm', onClick: () => ui.go('files') })); toast('Saved.', 'ok'); }
          catch (e) { keepRes.replaceChildren(answer(e.message)); } finally { fileBtn.disabled = false; }
        } });
        // a picker from Sales' own lists; only the ticked items go, as with the follow-up
        const pick = h('div', { class: 'mt-pick' }); pick.hidden = true;
        const crmBtn = btn('Save to a contact or firm', { kind: 'ghost sm', disabled: !info.crm.available, title: info.crm.available ? '' : info.crm.why, onClick: () => {
          if (!pick.hidden) { pick.hidden = true; return; }
          let kind = 'contact'; const results = h('div', { class: 'mt-names', role: 'list' });
          const q = h('input', { type: 'search', placeholder: 'Type a name to look for', 'aria-label': 'Look for a contact or firm' });
          const kinds = h('div', { class: 'row' }, ...[['contact', 'A contact'], ['company', 'A firm']].map(([k, label]) => btn(label, { kind: 'ghost sm', onClick: () => { kind = k; load(); } })));
          async function load() {
            try {
              const r = await api(`${API}/crm/targets?kind=${kind}&q=${encodeURIComponent(q.value.trim())}`);
              results.replaceChildren(...(r.items.length ? r.items.map(x => btn(x.sub ? `${x.name} (${x.sub})` : x.name, { kind: 'ghost sm', onClick: async () => {
                try {
                  const s = await api(`${API}/m/${m.id}/crm`, { body: { kind, targetId: x.id, summary: sumTick.checked, actions: picked(ticks), decisions: picked(dTicks), questions: picked(qTicks) } });
                  keepRes.replaceChildren(answer(s.line)); pick.hidden = true; toast('Saved.', 'ok');
                } catch (e) { keepRes.replaceChildren(answer(e.message)); }
              } })) : [h('p', { class: 'sub' }, kind === 'company' ? 'No firm found. Add it on the Sales page first.' : 'No contact found. Add it on the Sales page first.')]));
            } catch (e) { results.replaceChildren(h('p', { class: 'sub' }, e.message)); }
          }
          let t; q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
          pick.replaceChildren(h('p', { class: 'sub' }, 'Pick where the ticked items go. They are added as a dated note.'), kinds, q, results); pick.hidden = false; load();
        } });
        out.push(card(h('h4', null, 'Keep the notes'), h('div', { class: 'mt-acts' }, fileBtn, crmBtn), pick, info.crm.available ? null : h('p', { class: 'sub', style: { marginTop: '6px' } }, info.crm.why), keepRes));
        return out;
      }

      // ---- the team's tasks from every meeting
      async function paintTasks() {
        let tasks = []; try { tasks = (await api(API + '/tasks')).tasks; } catch (e) { toast(e.message, 'err'); }
        if (tab !== 1) return;
        if (!tasks.length) { body.replaceChildren(h('h3', null, 'Team tasks'), empty('No tasks yet. Open a meeting with notes, tick its action items and press Add as tasks.')); return; }
        const rowOf = (t) => {
          const mark = ui.savedMark();
          const c = h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Done: ' + t.what });
          c.onchange = () => mark.run(() => api(`${API}/tasks/${t.id}`, { body: { done: c.checked } }), { field: c, old: t.done });
          return h('tr', null, h('td', { class: 'ck' }, c, mark), h('td', null, t.what), h('td', { 'data-l': 'Who' }, t.who), h('td', { 'data-l': 'When' }, t.due ? t.dueText + (t.late ? ' (late)' : '') : t.said === NOT_SAID ? NOT_SAID : `"${t.said}"`), h('td', { 'data-l': 'Meeting' }, t.meeting),
            h('td', null, btn('Remove', { kind: 'ghost sm', onClick: async () => { if (!await confirm(`Remove the task "${t.what}"?`, { ok: 'Remove', kind: 'stop' })) return; try { await api(`${API}/tasks/${t.id}`, { method: 'DELETE' }); toast('Removed.', 'ok'); paintTasks(); } catch (e) { toast(e.message, 'err'); } } })));
        };
        body.replaceChildren(h('h3', null, `Team tasks (${tasks.filter(t => !t.done).length} open)`),
          h('p', { class: 'sub' }, 'From your meetings. A tick saves by itself.'),
          h('table', { class: 'mt-tasks' }, h('thead', null, h('tr', null, ['', 'What', 'Who', 'When', 'Meeting', ''].map((x, i) => h('th', { style: i === 0 ? { width: '34px' } : i === 5 ? { width: '96px' } : null }, x)))), h('tbody', null, tasks.map(rowOf))));
      }

      function paint() {
        el.classList.toggle('has-open', tab === 1 || !!openId);
        side.hidden = tab === 1; main.style.gridTemplateColumns = tab === 1 ? 'minmax(0,1fr)' : '';
        paintList();
        if (tab === 1) return paintTasks();
        if (openId === 'new') return paintNew();
        if (openId) return paintMeeting(openId);
        body.replaceChildren(items.length ? empty('Pick a meeting on the left, or press New meeting.') : card(h('h3', null, 'Your first meeting'),
          h('p', null, 'Paste the words of a meeting, add a caption file (.vtt, .srt) or a text file, or record one. The model you pick writes a short summary, the decisions, the action items with who and when, and the open questions.'),
          h('p', { class: 'sub' }, CLAIM),
          h('div', { class: 'mt-acts' }, btn('New meeting', { onClick: () => { openId = 'new'; paint(); } }))));
      }

      ui.on('meetings', () => { loadList().then(() => { if (openId && openId !== 'new' && tab === 0) paintMeeting(openId); }); });
      live = setInterval(() => { if (items.some(m => ['working', 'listening'].includes(m.state))) loadList().then(() => { if (openId && openId !== 'new' && tab === 0) paintMeeting(openId); }); }, 4000);
      ui.onLeave?.(() => { clearInterval(live); if (rec) { rec.r.cancel(); clearInterval(rec.t); rec = null; } if (ending) { ending(); ending = null; } });
      this._stop = () => { clearInterval(live); if (rec) { rec.r.cancel(); clearInterval(rec.t); rec = null; } if (ending) { ending(); ending = null; } };
      await loadInfo(); await loadList(); paint();
    },
    unmount() { try { this._stop?.(); } catch {} },
  },
};

export const settings = {
  meetings: {
    title: 'Meeting notes',
    async render(el, ui) {
      const { h, api, card, line, toast, sw } = ui;
      let info; try { info = await api(API + '/info'); } catch (e) { el.append(card(h('p', { class: 'sub' }, e.message))); return; }
      const keepMark = ui.savedMark();
      const keep = sw(info.keep, 'Keep recordings', async (v) => { const ok = await keepMark.run(() => api(API + '/prefs', { body: { keep: v } })); return ok; });
      const r = info.record;
      el.append(h('div', { class: 'stack' },
        card(h('h3', null, 'Meeting notes'), h('p', { class: 'sub' }, 'Which model makes the notes, and what happens to a recording.'),
          info.agents.length ? h('div', { class: 'mt-form', style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '10px', maxWidth: '520px' } }, agentPicker(ui, info)) : h('p', { class: 'sub' }, 'No agent is on the roster. Add one on the Agents page.'),
          line('Keep recordings', 'Off: the sound is deleted once it is turned into words, or once that stops or fails. You can still tick "Keep the recording" for one meeting.', keepMark, keep),
          line('Recording', r.available ? `${r.engine}. ${r.leavesText} ${r.cost}` : r.why)),
      ));
      if (!r.available) el.querySelector('.stack')?.append(card(h('p', { class: 'sub' }, 'Paste and file work without a speech engine.')));
      void toast;
    },
  },
};
