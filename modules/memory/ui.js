// Settings > Memory (Dream and Learn) and the agent tab "Memory".
const API = 'm/memory/';
const KIND = { fact: 'Fact', preference: 'Preference', lesson: 'Lesson', summary: 'Summary' };
const SOURCE = { owner: 'you added it', chat: 'learned from chat', agent: 'saved by an agent', dream: 'written by Dream' };

function memoryRow(ui, m, onChange) {
  const { h, btn, pill, fmt, toast, confirm } = ui;
  return h('div', { class: 'line' },
    h('div', { style: { flex: '1', minWidth: '0' } }, h('b', { style: { fontWeight: '500' } }, m.text),
      h('span', { class: 'd' }, [KIND[m.kind] || m.kind, m.agentId ? ui.agent(m.agentId)?.name || m.scope : 'every agent', SOURCE[m.source] || '', fmt.when(m.at)].filter(Boolean).join(' · '))),
    m.kind === 'lesson' ? pill('Always used', 'ok') : m.weight < 0.6 ? pill('Fading') : null,
    btn('Edit', { kind: 'ghost sm', onClick: async () => { const t = await ui.ask('Edit memory', { value: m.text, multiline: true }); if (t == null || !t.trim() || t === m.text) return; try { await ui.api(API + 'items/' + m.id, { body: { text: t } }); onChange(); } catch (e) { toast(e.message, 'err'); } } }),
    btn('Forget', { kind: 'ghost sm', onClick: async () => { if (!await confirm(`Forget "${m.text.slice(0, 120)}"?`, { ok: 'Forget', kind: 'stop' })) return; try { await ui.api(API + 'items/' + m.id, { method: 'DELETE' }); onChange(); } catch (e) { toast(e.message, 'err'); } } }));
}

function addForm(ui, agentId, onAdded) {
  const { h, btn, toast } = ui;
  const input = h('input', { type: 'text', placeholder: agentId ? 'Something to remember, or a lesson: "When I ask for leads, always include the city"' : 'Something every agent should remember', style: { flex: '1', minWidth: '200px' }, 'aria-label': 'New memory' });
  const kind = h('select', { 'aria-label': 'Kind' }, ['fact', 'preference', 'lesson'].map(k => h('option', { value: k }, KIND[k])));
  const add = async () => { const text = input.value.trim(); if (!text) return ui.needs(input, 'Type something to remember first.'); try { await ui.api(API + 'items', { body: { agentId, text, kind: kind.value } }); input.value = ''; toast('Remembered', 'ok'); onAdded(); } catch (e) { toast(e.message, 'err'); } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  return h('div', { class: 'row' }, input, kind, btn('Add', { onClick: add }));
}

export const settings = {
  memory: { title: 'Memory', async render(el, ui) {
    const { h, card, line, sw, btn, fmt, toast, confirm, empty, plural } = ui;
    const top = h('div', { class: 'card' }); const listCard = h('div', { class: 'card' });
    const listBody = h('div'); const q = h('input', { type: 'search', placeholder: 'Search what is remembered', 'aria-label': 'Search memories', style: { flex: '1', minWidth: '180px' } });
    el.append(top, listCard);
    // each switch answers beside itself: Saving, then the tick, or the reason and the switch goes back
    const setOpt = (mark, patch) => mark.run(() => ui.api(API + 'settings', { body: patch }));
    const paintList = async () => {
      const r = await ui.api(API + 'items' + (q.value.trim() ? '?q=' + encodeURIComponent(q.value.trim()) : ''));
      listBody.replaceChildren(...(r.items.length ? r.items.map(m => memoryRow(ui, m, refresh)) : [empty(q.value ? 'Nothing matches.' : 'Nothing is remembered yet. Agents learn as you chat, or add a line here.')]));
    };
    const paintTop = async () => {
      const s = await ui.api(API + 'status'); const learnMark = ui.savedMark(), nightMark = ui.savedMark();
      const k = s.byKind || {};
      const what = s.total ? `${plural(s.total, 'thing')}: ${plural(k.fact || 0, 'fact')}, ${plural(k.preference || 0, 'preference')}, ${plural(k.lesson || 0, 'lesson')}, ${plural(k.summary || 0, 'summary', 'summaries')}` : 'Nothing yet';
      const d = s.lastDream;
      top.replaceChildren(...[h('h3', null, 'Dream and Learn'),
        line('What is remembered', what + ' · about you, your business and your people', btn('Review', { kind: 'ghost sm', onClick: () => listCard.scrollIntoView({ behavior: 'smooth' }) })),
        line('Learn from chat', 'After a reply, keep lasting facts and preferences about you and your business. Never passwords, codes or one-off asks.', sw(s.learnChat, 'Learn from chat', (on) => setOpt(learnMark, { learnChat: on })), learnMark),
        line('Nightly Dream', 'Tidies memory at 3:17 at night when the desk is on: merges duplicates, writes a short summary, lets stale lines fade. A missed night is not run later.', sw(s.nightly, 'Nightly Dream', (on) => setOpt(nightMark, { nightly: on })), nightMark),
        line('Run Dream now', d ? `Last run ${fmt.when(d.at)}, started by ${d.startedBy || 'an earlier version'}: ${d.merged} merged, ${d.lowered} faded${d.label ? ' · ' + d.label : ''}` : 'Not run yet', btn('Run Dream now', { kind: 'ghost sm', onClick: async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Dreaming…'; try { await ui.api(API + 'dream', { body: {} }); } catch (err) { toast(err.message, 'err'); b.disabled = false; b.textContent = 'Run Dream now'; } } })),
        (s.dreams || []).length > 1 ? line('Earlier Dream runs', (s.dreams || []).slice(1, 6).map(x => `${fmt.when(x.at)}, started by ${x.startedBy || 'an earlier version'}`).join(' · ')) : null,
        line('How memories are found', s.search?.ok ? `By meaning (${s.search.model}) and by words` : 'By words and their related words. For search by meaning, pull an embedding model in Ollama.'),
        line('Forget everything', 'Removes every memory and lesson for every agent. This cannot be undone.', btn('Forget everything', { kind: 'stop sm', onClick: async () => { if (!await confirm('Forget everything every agent remembers, including the lessons you taught? This cannot be undone.', { ok: 'Forget everything', kind: 'stop' })) return; try { await ui.api(API + 'forget-all', { body: {} }); toast('Memory is empty', 'ok'); refresh(); } catch (e) { toast(e.message, 'err'); } } }))].filter(Boolean));
    };
    const refresh = () => Promise.all([paintTop(), paintList()]).catch(e => toast(e.message, 'err'));
    let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(paintList, 250); });
    listCard.append(h('div', { class: 'row', style: { marginBottom: '6px' } }, h('h3', { style: { flex: '1' } }, 'Everything remembered'), q), addForm(ui, null, refresh), listBody);
    await refresh();
    ui.on('memory', () => refresh());
    ui.on('job', (j) => { if (j?.kind === 'memory.dream' && j.status !== 'running') { if (j.status === 'done') toast(`Dream done: ${j.output?.merged ?? 0} merged`, 'ok'); refresh(); } });
  } },
};

export const agentTabs = {
  memory: { title: 'Memory', async render(el, ui, agent) {
    const { h, card, empty, toast } = ui;
    const own = h('div'); const shared = h('div'); const head = h('span', { class: 'sub' });
    const paint = async () => {
      const [a, s] = await Promise.all([ui.api(API + 'items?shared=0&agentId=' + encodeURIComponent(agent.id)), ui.api(API + 'items?shared=0&agentId=')]);
      const mine = a.items.sort((x, y) => (y.kind === 'lesson') - (x.kind === 'lesson'));
      head.textContent = `${mine.length} of ${agent.name}'s own, ${s.items.length} shared with every agent`;
      own.replaceChildren(...(mine.length ? mine.map(m => memoryRow(ui, m, paint)) : [empty(`${agent.name} has nothing of its own yet. Lessons you teach it appear here.`)]));
      shared.replaceChildren(...(s.items.length ? s.items.slice(0, 200).map(m => memoryRow(ui, m, paint)) : [empty('Nothing shared yet.')]));
    };
    el.append(card(h('div', { class: 'row' }, h('h3', { style: { flex: '1' } }, `What ${agent.name} remembers`), head), addForm(ui, agent.id, paint), own),
      card(h('h3', null, 'Shared with every agent'), h('p', { class: 'sub' }, 'Facts about you and your business that every agent uses.'), shared));
    await paint().catch(e => toast(e.message, 'err'));
    ui.on('memory', () => paint().catch(() => {}));
  } },
};
