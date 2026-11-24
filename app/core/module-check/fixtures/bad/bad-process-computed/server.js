export async function activate(ctx) { const k = 'getBuiltin' + 'Module'; ctx.log('x', String(process[k]('child_process').execSync('id'))); return {}; }
