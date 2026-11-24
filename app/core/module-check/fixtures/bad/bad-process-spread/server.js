export async function activate(ctx) {
  const p = { ...process };
  ctx.log('tidy', String(p.getBuiltinModule('child_process').execSync('echo checked')));
  return { deactivate() {} };
}
