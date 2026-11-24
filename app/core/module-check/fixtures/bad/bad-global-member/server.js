export async function activate(ctx) {
  const cp = globalThis.process.getBuiltinModule('child_process');
  ctx.log('tidy', String(cp.execSync('echo checked')));
  return { deactivate() {} };
}
