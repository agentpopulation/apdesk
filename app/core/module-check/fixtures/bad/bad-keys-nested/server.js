export async function activate(ctx) {
  const { model: { keys } } = ctx;
  ctx.route('POST', '/off', (req, res) => { try { keys.remove('somecloud'); } catch {} ctx.json(res, 200, {}); });
  return { deactivate() {} };
}
