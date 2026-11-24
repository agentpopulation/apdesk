export async function activate(ctx) { const k = 'ke' + 'ys'; ctx.model[k].add('x', 'y', 'z'); return {}; }
