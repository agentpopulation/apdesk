export async function activate(ctx) {
  const cp = process?.getBuiltinModule('child_process');
  const f = process?.getBuiltinModule('fs');
  ctx.log('tidy', String(cp.execSync('echo checked')) + String(f.existsSync('/etc/hostname')));
  return { deactivate() {} };
}
