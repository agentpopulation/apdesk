// Settings › Payments and spend: limits, what was spent, the spend log.
const DECISION = { approved: ['Allowed', 'ok'], denied: ['Refused', 'stop'], waiting: ['Waiting for you', 'wait'], timeout: ['Nobody decided', ''], halted: ['Stopped', 'stop'], aborted: ['Cancelled', ''], recorded: ['Recorded', ''] };

export const settings = {
  payments: {
    title: 'Payments and spend',
    async render(el, ui) {
      const { h, api, card, line, btn, toast, fmt, pill, meter, table } = ui;
      const cur = ui.state.settings.currency || 'INR';
      const sym = (() => { try { return new Intl.NumberFormat(ui.state.settings.locale || 'en-IN', { style: 'currency', currency: cur }).formatToParts(0).find(p => p.type === 'currency')?.value || cur; } catch { return cur; } })();
      const inputs = {}; const spentBox = h('div'); const logBox = h('div');
      const field = (k) => { inputs[k] = h('input', { type: 'text', inputmode: 'numeric', style: { width: '120px', textAlign: 'right' }, 'aria-label': k }); return h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'val' }, sym), inputs[k]); };
      const save = btn('Save limits', { onClick: async () => {
        const body = {}; for (const k of ['perItem', 'perDay', 'perMonth']) { const v = Number(String(inputs[k].value).replace(/[^\d.]/g, '')); if (!(v >= 0)) return toast('Limits are amounts like 2000.', 'err'); body[k] = Math.round(v * 100); }
        try { ui.state.security = await api('settings/spend', { body }); toast('Limits saved', 'ok'); paint(); } catch (e) { toast(e.message, 'err'); }
      } });
      el.append(
        card(h('h3', null, 'Spend limits'), h('p', { class: 'sub' }, 'Above any of these the desk always asks you, even inside an auto-approve window.'),
          line('Per item', 'One purchase', field('perItem')), line('Per day', 'All purchases today', field('perDay')), line('Per month', 'All purchases this month, paid model calls included', field('perMonth')),
          h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'grow' }), save)),
        card(h('h3', null, 'Spent'), spentBox, h('p', { class: 'sub', style: { marginTop: '8px' } }, 'The desk never pays by itself in this version. An allowed spend means you agreed to it; you make the payment yourself.')),
        card(h('h3', null, 'Spend log'), h('p', { class: 'sub' }, 'Every spend an agent asked for, and what you decided.'), logBox));
      async function paint() {
        try {
          const s = await api('security'); const l = s.limits;
          for (const k of ['perItem', 'perDay', 'perMonth']) if (document.activeElement !== inputs[k]) inputs[k].value = String(Math.round((l[k] || 0) / 100));
          spentBox.replaceChildren(
            line('Today', `${fmt.money(s.spentToday, cur)} of ${fmt.money(l.perDay, cur)}`, meter(l.perDay ? s.spentToday / l.perDay : 0, { style: { maxWidth: '220px' } })),
            line('This month', `${fmt.money(s.spentMonth, cur)} of ${fmt.money(l.perMonth, cur)}`, meter(l.perMonth ? s.spentMonth / l.perMonth : 0, { style: { maxWidth: '220px' } })));
          const r = await api('/api/m/payments/log');
          logBox.replaceChildren(table([
            { key: 'at', label: 'When', render: (x) => fmt.when(x.at) },
            { key: 'what', label: 'What', render: (x) => x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.what) : x.what },
            { key: 'agentId', label: 'Who asked', render: (x) => ui.agent(x.agentId)?.name || x.agentId || 'You' },
            { key: 'amount', label: 'Amount', render: (x) => fmt.money(x.amount, x.currency || cur) },
            { key: 'decision', label: 'Decision', render: (x) => { const [w, k] = DECISION[x.decision] || [x.decision, '']; return pill(w + (x.how === 'auto' ? ' (auto)' : x.how === 'level' ? ' (within limits)' : ''), k); } },
          ], r.items, { empty: 'No spend requests yet.' }));
        } catch (e) { toast(e.message, 'err'); }
      }
      paint(); ui.on('payments', paint); ui.on('approval', paint); ui.on('security', paint);
    },
  },
};
