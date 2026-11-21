// Settings › Payments and spend: limits, what was spent, the spend log.
const DECISION = { approved: ['Allowed', 'ok'], denied: ['Refused', 'stop'], waiting: ['Waiting for you', 'wait'], timeout: ['Nobody decided', ''], halted: ['Stopped', 'stop'], aborted: ['Cancelled', ''], recorded: ['Recorded', ''] };

export const settings = {
  payments: {
    title: 'Payments and spend',
    async render(el, ui) {
      const { h, api, card, line, btn, toast, fmt, pill, meter, table } = ui;
      const cur = ui.state.settings.currency || undefined;   // none set: plain numbers, no guessed symbol
      const sym = !cur ? '' : (() => { try { return new Intl.NumberFormat(ui.state.settings.locale || undefined, { style: 'currency', currency: cur }).formatToParts(0).find(p => p.type === 'currency')?.value || cur; } catch { return cur; } })();
      const inputs = {}; const spentBox = h('div'); const logBox = h('div'); const paidBox = h('div');
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
        card(h('h3', null, 'Paid models'), paidBox),
        card(h('h3', null, 'Spend log'), h('p', { class: 'sub' }, 'Every spend an agent asked for, and what you decided.'), logBox));
      // the same switch as beside the OpenRouter keys in Models: one setting, changed only from this window
      function paintPaid(on) {
        paidBox.replaceChildren(line('Paid OpenRouter models', on ? 'On: paid models may be used. Your spend limits still apply.' : 'Off: only free OpenRouter models are listed and used.',
          ui.sw(on, 'Paid OpenRouter models', async (next) => {
            if (next && !await ui.confirm('This key may be charged by OpenRouter. Your spend limits still apply.', { title: 'Switch on paid models?', ok: 'Switch on' })) return false;
            await api('settings/paid-models', { body: { provider: 'openrouter', on: next } }); ui.state.settings['openrouter.allowPaid'] = next; paintPaid(next);
          }, { 'data-apd': 'paid-switch' })));
      }
      paintPaid(ui.state.settings['openrouter.allowPaid'] === true);
      ui.on('settings', (c) => { if (c && 'openrouter.allowPaid' in c) { ui.state.settings['openrouter.allowPaid'] = c['openrouter.allowPaid']; paintPaid(c['openrouter.allowPaid'] === true); } });
      async function paint() {
        try {
          const s = await api('security'); const l = s.limits;
          for (const k of ['perItem', 'perDay', 'perMonth']) if (document.activeElement !== inputs[k]) inputs[k].value = String(Math.round((l[k] || 0) / 100));
          const r = await api('/api/m/payments/log');
          // some of today's model calls may have a cost the desk cannot know; they still count toward the limit at list price
          const unk = r.unknownToday || { minor: 0, calls: 0 };
          spentBox.replaceChildren(
            ...[
              line('Today', `${fmt.money(s.spentToday, cur)} of ${fmt.money(l.perDay, cur)}`, meter(l.perDay ? s.spentToday / l.perDay : 0, { style: { maxWidth: '220px' } })),
              line('This month', `${fmt.money(s.spentMonth, cur)} of ${fmt.money(l.perMonth, cur)}`, meter(l.perMonth ? s.spentMonth / l.perMonth : 0, { style: { maxWidth: '220px' } })),
              unk.calls ? h('p', { class: 'sub', 'data-apd': 'unknown-spend' }, `${unk.calls} call${unk.calls === 1 ? '' : 's'} today had a cost the desk cannot know. About ${fmt.money(unk.minor, cur)} at the providers' list price is counted toward your daily limit for ${unk.calls === 1 ? 'it' : 'them'}, so no limit is passed unseen.`) : null,
            ].filter(Boolean));
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
