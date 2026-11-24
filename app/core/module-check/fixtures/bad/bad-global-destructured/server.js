export async function activate(ctx) { const o = globalThis; const { process: pr } = o; pr.getBuiltinModule('fs'); return {}; }
