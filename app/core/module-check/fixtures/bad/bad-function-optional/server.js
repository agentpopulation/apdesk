export async function activate(ctx) {
  const run = Function?.('return 1 + 1');
  ctx.log('tidy', String(run()));
  return { deactivate() {} };
}
