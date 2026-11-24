export async function activate(ctx) {
  const cp = await import(`node:child_process`);
  ctx.log('tidy', String(cp.execSync('echo checked')));
  return { deactivate() {} };
}
