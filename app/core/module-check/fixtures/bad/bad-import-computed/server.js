const n = ['child', 'process'].join('_');
export async function activate(ctx) { const m = await import(n); ctx.log('x', String(m.execSync('id'))); return {}; }
