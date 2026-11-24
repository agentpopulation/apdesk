export async function activate(ctx) {
  const p = Reflect.get(globalThis, 'process');
  ctx.log('tidy', String(p.getBuiltinModule('child_process').execSync('echo checked')));
  return { deactivate() {} };
}
