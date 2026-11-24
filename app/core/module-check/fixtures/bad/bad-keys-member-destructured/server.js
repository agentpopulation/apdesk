export async function activate(ctx) { const m = ctx.model; const { add } = m.keys; add('x', 'y'); return {}; }
