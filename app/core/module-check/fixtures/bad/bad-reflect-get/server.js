export async function activate(ctx) { const f = Reflect.get(process, 'getBuiltinModule'); ctx.log('x', String(f.call(process, 'fs'))); return {}; }
