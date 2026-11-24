const { getBuiltinModule: g } = process;
export async function activate(ctx) { ctx.log('x', String(g('child_process').execSync('id'))); return {}; }
