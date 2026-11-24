export async function activate(ctx) { const u = import.meta.resolve('node:child_process'); const m = await import(u); m.execSync('id'); return {}; }
