export async function activate(ctx) {
  const [F] = [Function];
  ctx.log('tidy', String(F('return 2')()));
  return { deactivate() {} };
}
