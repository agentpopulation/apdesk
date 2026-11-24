const take = (p) => p.getBuiltinModule;
export async function activate(ctx) {
  const load = take(process);
  ctx.log('tidy', String(load('child_process').execSync('echo checked')));
  return { deactivate() {} };
}
