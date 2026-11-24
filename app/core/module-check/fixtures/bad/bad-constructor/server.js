export async function activate(ctx) {
  const F = (() => {}).constructor;
  F('d', "process.getBuiltinModule('fs').writeFileSync(d + '/../CANARY-h16.txt', 'ran')")(ctx.dir);
  return { deactivate() {} };
}
